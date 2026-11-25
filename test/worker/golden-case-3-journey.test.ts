import { describe, expect, it } from 'vitest'
import type { CaseDebrief } from '../../src/shared/completion'
import type { DiagnosisResponse } from '../../src/shared/diagnosis'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import type { PrescriptionsResponse } from '../../src/shared/medication'
import { expectNoCaseTruth } from './case-truth'
import { api, asked, send, settled, startEncounter, transcript } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const path = (encounterId: string) => `/api/encounters/${encounterId}`

async function write(encounterId: string, suffix: string, body?: unknown, method = 'POST') {
  const response = await send(method, `${path(encounterId)}${suffix}`, body)
  expect(response.ok, await response.clone().text()).toBe(true)
  return response
}

const row = (name: string, value: number | string, unit: string, range: string, flag: string | null) => ({
  name, value, unit, referenceRange: range, flag,
})

// Golden Case 3: the full clinical path runs a primary T2DM + secondary UTI diagnosis and a two-drug
// Prescription through the five shared gates; the debrief then compares both diagnoses and both drugs.
describe('Golden Case 3 journey', () => {
  it('resolves glucose, HbA1c and urinalysis from Case Truth with the catalog reference ranges', async () => {
    const encounterId = await startEncounter('golden-case-03')
    const issued = ((await (await write(encounterId, '/investigations', { catalogItemIds: ['glu', 'hba1c', 'urinalysis'] })).json()) as InvestigationsResponse).investigations
    expect(issued).toHaveLength(3)
    for (const investigation of issued) await write(encounterId, `/investigations/${investigation.investigationId}/instant-release`)

    const list = ((await (await api(`${path(encounterId)}/investigations`)).json()) as InvestigationsResponse).investigations
    const body = (itemId: string) => {
      const report = list.find((item) => item.catalogItemId === itemId)!.reports[0].body
      if (report.kind !== 'results') throw new Error('expected a results report')
      return report.results
    }
    expect(body('glu')).toEqual([{ ...row('随机血糖 GLU', 13.8, 'mmol/L', '3.9–11.1', 'high'), analyteId: 'glu', decimals: 1 }])
    expect(body('hba1c')).toEqual([{ ...row('糖化血红蛋白 HbA1c', 9.8, '%', '4.0–6.0', 'high'), analyteId: 'hba1c', decimals: 1 }])
    expect(body('urinalysis')).toEqual(expect.arrayContaining([
      { ...row('白细胞酯酶 LEU', '阳性', '', '阴性', 'abnormal'), analyteId: 'ua-leu', decimals: 0 },
      { ...row('亚硝酸盐 NIT', '阳性', '', '阴性', 'abnormal'), analyteId: 'ua-nit', decimals: 0 },
      { ...row('尿糖 GLU', '阳性', '', '阴性', 'abnormal'), analyteId: 'ua-glu', decimals: 0 },
      { ...row('尿比重 SG', 1.018, '', '1.003–1.030', null), analyteId: 'ua-sg', decimals: 3 },
    ]))
  })

  it('completes through the shared gates with a primary and a secondary Diagnosis and a two-drug Prescription, and the Case Debrief compares both', async () => {
    installScripted('patient')
      .reply('医生，我最近总觉得口干，喝了很多水，尿也多，小便的时候还有点刺痛。')
      .reply('没有发烧，腰也不疼，就是容易累，人瘦了些。')
    const encounterId = await startEncounter('golden-case-03')
    const started = await api(`${path(encounterId)}`)
    expect(started.status).toBe(200)
    expectNoCaseTruth('start', await started.text())

    for (const question of ['您哪里不舒服？', '有发烧或腰疼吗？']) {
      const turn = (await asked(encounterId, question)).patientTurn
      await settled(encounterId, turn.turnId)
    }
    await write(encounterId, '/physical-examinations', { system: 'abdomen' })

    const issued = await write(encounterId, '/investigations', { catalogItemIds: ['glu', 'hba1c', 'urinalysis'] })
    // Catalog identity (item names) is visible before release; only the results are Case Truth.
    expectNoCaseTruth('issue', await issued.clone().text(), ['随机血糖', '糖化血红蛋白', '尿常规'])
    const investigations = ((await issued.json()) as InvestigationsResponse).investigations
    for (const investigation of investigations) {
      const released = await write(encounterId, `/investigations/${investigation.investigationId}/instant-release`)
      // The released values are Case Truth the doctor has legitimately uncovered.
      expectNoCaseTruth('released', await released.text(), [13.8, 9.8, '阳性', '随机血糖', '糖化血红蛋白', '尿常规'])
    }
    const reports = ((await (await api(`${path(encounterId)}/investigations`)).json()) as InvestigationsResponse).investigations
      .flatMap((item) => item.reports)
    expect(reports).toHaveLength(3)
    await write(encounterId, '/report-acknowledgements', { reportIds: reports.map((report) => report.reportId) })

    const confirmed = await write(encounterId, '/diagnosis/revisions', {
      entries: [
        { code: 'E11.9', primary: true, source: 'doctor' },
        { code: 'N39.0', primary: false, source: 'doctor' },
      ],
    })
    const confirmedEntries = ((await confirmed.json()) as DiagnosisResponse).diagnosis.revisions.at(-1)!.entries
    expect(confirmedEntries).toEqual([
      expect.objectContaining({ code: 'E11.9', primary: true }),
      expect.objectContaining({ code: 'N39.0', primary: false }),
    ])

    const issuedPrescription = await write(encounterId, '/prescriptions', {
      lines: [
        { drugId: 'metformin', dose: 1, route: '口服', frequency: 'BID', days: 14 },
        { drugId: 'nitrofurantoin', dose: 1, route: '口服', frequency: 'TID', days: 7 },
      ],
    })
    const lines = ((await issuedPrescription.json()) as PrescriptionsResponse).prescriptions.lines
    expect([...lines].map((line) => line.drugId).sort()).toEqual(['metformin', 'nitrofurantoin'])

    await write(encounterId, '/clinical-note/revisions', {
      sections: {
        'chief-complaint': '多饮、多尿伴尿频、尿急 2 周。',
        'present-illness': '患者诉口干多饮多尿，尿频尿急伴排尿刺痛，无发热腰痛。',
        'past-history': '无药物过敏史。',
        findings: '下腹轻压痛，双肾区无叩击痛；随机血糖、糖化血红蛋白升高；尿白细胞酯酶及亚硝酸盐阳性。',
        assessment: '新诊断2型糖尿病伴急性尿路感染。',
        plan: '二甲双胍联合呋喃妥因口服，两周后复诊复查血糖与尿常规。',
      },
    })

    expect(await (await api(`${path(encounterId)}/debrief`)).json()).toMatchObject({ error: { code: 'debrief-locked' } })
    const completed = await send('POST', `${path(encounterId)}/completion`)
    expect(completed.status, await completed.clone().text()).toBe(200)
    expect(await completed.json()).toMatchObject({ encounter: { status: 'completed' } })

    const { debrief } = (await (await api(`${path(encounterId)}/debrief`)).json()) as { debrief: CaseDebrief }
    expect(debrief.diagnoses.map((entry) => [entry.code, entry.primary])).toEqual([['E11.9', true], ['N39.0', false]])
    expect([...debrief.prescriptions.lines].map((line) => line.drugId).sort()).toEqual(['metformin', 'nitrofurantoin'])
    expect(debrief.reference).toEqual({
      primaryDiagnosis: 'E11.9 2型糖尿病（新诊断）',
      secondaryDiagnoses: 'N39.0 尿路感染（急性单纯性下尿路感染）',
      keyInvestigations: '尿检、血糖、糖化血红蛋白检测',
      keyExamination: '下腹轻压痛，双肾区无叩击痛',
      medicationConclusion: '二甲双胍控制血糖，联合抗尿路感染药物（如呋喃妥因）',
      keyHistoryQuestions: '两周口干多饮多尿；尿频尿急伴排尿刺痛；无发热腰痛；无药物过敏史',
      severityAssessment: '无发热与肾区叩痛，属单纯性下尿路感染；血糖显著升高但无酮症',
      disposition: '门诊口服药物治疗，两周后复诊复查血糖与尿常规',
    })
    // Both sides of each comparison show together: the golden reference names the same diagnoses and drugs the doctor issued.
    expect(debrief.reference.primaryDiagnosis).toContain('E11.9')
    expect(debrief.reference.secondaryDiagnoses).toContain('N39.0')
    expect(debrief.reference.medicationConclusion).toContain('二甲双胍')
    expect(debrief.reference.medicationConclusion).toContain('呋喃妥因')
    expect(await transcript(encounterId).then((turns) => turns.filter((turn) => turn.speaker === 'patient'))).toHaveLength(2)
  })

  // The five gates are shared, so a differently-reasoned encounter on the same case still completes:
  // the case content never becomes a hidden completion gate, and Case Truth stays out of the refusal path.
  it('still completes on a different doctor-entered path: the case adds no completion gate of its own', async () => {
    const encounterId = await startEncounter('golden-case-03')
    await write(encounterId, '/diagnosis/revisions', { entries: [{ code: 'R50.9', primary: true, source: 'doctor' }] })
    await write(encounterId, '/no-medication')
    await write(encounterId, '/clinical-note/revisions', {
      sections: {
        'chief-complaint': '多饮、多尿伴尿频、尿急 2 周。',
        'present-illness': '症状待查。',
        'past-history': '',
        findings: '',
        assessment: '待进一步检查。',
        plan: '建议专科就诊。',
      },
    })
    const completed = await send('POST', `${path(encounterId)}/completion`)
    expect(completed.status, await completed.clone().text()).toBe(200)
    const { debrief } = (await (await api(`${path(encounterId)}/debrief`)).json()) as { debrief: CaseDebrief }
    expect(debrief.diagnoses.map((entry) => entry.code)).toEqual(['R50.9'])
    expect(debrief.prescriptions.noMedication).toBeTruthy()
  })
})
