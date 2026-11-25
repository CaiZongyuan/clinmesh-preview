import { afterEach, describe, expect, it, vi } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { CaseDebrief } from '../../src/shared/completion'
import type { GoldenCaseQueueResponse } from '../../src/shared/golden-case-queue'
import type { EncounterView } from '../../src/shared/encounter'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import { expectNoCaseTruth } from './case-truth'
import { goldenCase2QueueEntry } from '../fixtures/golden-case-2'
import { api, asked, send, settled, startEncounter, transcript } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const goldenCase = casePack.cases.find((c) => c.id === 'golden-case-02')!
const path = (encounterId: string) => `/api/encounters/${encounterId}`

async function write(id: string, suffix: string, body?: unknown) {
  const response = await send('POST', `${path(id)}${suffix}`, body)
  expect(response.ok, await response.clone().text()).toBe(true)
  return response
}

async function investigationsOf(id: string) {
  return ((await (await api(`${path(id)}/investigations`)).json()) as InvestigationsResponse).investigations
}

// Confirms every Completion Gate except the ones a test is isolating.
async function ready(id: string, plan: string) {
  await write(id, '/diagnosis/revisions', { entries: [{ code: 'I21.4', primary: true, source: 'doctor' }] })
  await write(id, '/no-medication')
  await write(id, '/clinical-note/revisions', { sections: note(plan) })
}

const note = (plan: string) => ({
  'chief-complaint': '间断胸骨后闷痛 6 小时，伴出汗、气促。',
  'present-illness': '患者六小时前起病，闷痛反复发作。',
  'past-history': '高血压 8 年、血脂异常；无药物过敏。',
  findings: '双肺呼吸音清，心律齐。',
  assessment: '胸痛待查，高危。',
  plan,
})

const T0 = Date.parse('2026-11-24T00:55:00.000Z')

afterEach(() => vi.useRealTimers())

describe('Golden Case 2: acute chest pain', () => {
  it('sits in the queue at number 8 with a diagnosis-neutral banner', async () => {
    const queue = (await (await api('/api/golden-cases')).json()) as GoldenCaseQueueResponse
    expect(queue.goldenCases).toEqual(expect.arrayContaining([expect.objectContaining(goldenCase2QueueEntry)]))
    const encounterId = await startEncounter('golden-case-02')
    const { encounter } = (await (await api(path(encounterId))).json()) as { encounter: EncounterView }
    expect(encounter).toMatchObject({
      patient: { name: '陈志远', age: 67, chiefComplaint: '间断胸骨后闷痛 6 小时，伴出汗、气促', outpatientNumber: '20261124-0008' },
      visibleSourceHistory: {
        allergies: [],
        chronicConditions: [
          { code: 'I10', display: '原发性高血压' },
          { code: 'E78.5', display: '血脂异常' },
        ],
        priorMedications: [{ display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' }],
      },
    })
    expectNoCaseTruth('start', JSON.stringify(encounter))
  })

  it('gives the Patient Persona a chest-pain history that names no diagnosis', async () => {
    const llm = installScripted('patient')
      .reply('医生，我今天凌晨起胸口一阵阵发闷、发紧，还冒汗。')
      .reply('疼了六个小时了，左肩膀和后背隐隐跟着酸。')
      .reply('高血压八年，血脂偏高；没有药物过敏。')
    const encounterId = await startEncounter('golden-case-02')
    for (const question of ['您哪里不舒服？', '疼了多长时间？什么感觉？', '以前有什么病史？对什么药过敏吗？']) {
      await settled(encounterId, (await asked(encounterId, question)).patientTurn.turnId)
    }
    // The persona the Simulated Patient answers from is the patient's own experience only.
    expect(llm.requests.length).toBe(3)
    for (const request of llm.requests) {
      const system = String(request.messages[0].content)
      expect(system).toContain('压榨样闷痛')
      expect(system).toContain('高血压八年')
      expect(system).not.toMatch(/心肌梗死|梗死|NSTEMI|缺血|ST 段|肌钙蛋白|0\.68|1\.45/)
    }
    expectNoCaseTruth('Simulated Patient requests', JSON.stringify(llm.requests))
    expectNoCaseTruth('transcript', JSON.stringify(await transcript(encounterId)))
  })

  it('publishes the scripted troponin amendment as version 2 that must be acknowledged again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const encounterId = await startEncounter('golden-case-02')
    await ready(encounterId, '急转上级医院胸痛中心住院。')
    const issued = await write(encounterId, '/investigations', { catalogItemIds: ['ecg', 'hs-ctni'] })
    const [ecg, hsCtni] = ((await issued.json()) as InvestigationsResponse).investigations
    const released = await write(encounterId, `/investigations/${hsCtni.investigationId}/instant-release`)
    await write(encounterId, `/investigations/${ecg.investigationId}/instant-release`)
    const v1 = ((await released.json()) as InvestigationsResponse).investigations.find((i) => i.catalogItemId === 'hs-ctni')!
    expect(v1.reports[0]).toMatchObject({ version: 1, acknowledgement: null })
    expect(v1.reports[0].body).toMatchObject({ kind: 'results', results: [{ value: 0.68, flag: 'high' }] })
    await write(encounterId, '/report-acknowledgements', {
      reportIds: (await investigationsOf(encounterId)).flatMap((i) => i.reports.map((r) => r.reportId)),
    })
    expect((await investigationsOf(encounterId)).flatMap((i) => i.reports.map((r) => r.acknowledgement !== null))).toEqual([true, true])

    vi.setSystemTime(T0 + 120_000)
    // Completion re-checks the latest released Report version, so the stale acknowledgement refuses it.
    const refused = await send('POST', `${path(encounterId)}/completion`)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'completion-gates-unmet', failedGates: ['reports'] } })

    const amended = (await investigationsOf(encounterId)).find((i) => i.catalogItemId === 'hs-ctni')!
    expect(amended.reports.map((report) => [report.version, report.acknowledgement !== null])).toEqual([[1, true], [2, false]])
    expect(amended.reports[1]).toMatchObject({
      correctionReason: goldenCase.reportAmendments[0].reason,
      acknowledgement: null,
      body: { kind: 'results', results: [{ value: 1.45, flag: 'high' }] },
    })

    await write(encounterId, '/report-acknowledgements', { reportIds: [amended.reports[1].reportId] })
    expect((await investigationsOf(encounterId)).find((i) => i.catalogItemId === 'hs-ctni')!.reports[1].acknowledgement)
      .toEqual(expect.objectContaining({ practitionerId: 'demo-practitioner' }))
    await write(encounterId, '/completion')
  })

  it('checks in the Case Debrief whether the signed plan recorded a disposition', async () => {
    const withoutPlan = await startEncounter('golden-case-02')
    await ready(withoutPlan, '按时服药，不适随诊。')
    await write(withoutPlan, '/completion')
    const first = (await (await api(`${path(withoutPlan)}/debrief`)).json()) as { debrief: CaseDebrief }
    expect(first.debrief.dispositionRecorded).toBe(false)

    const withPlan = await startEncounter('golden-case-02')
    await ready(withPlan, '急转上级医院胸痛中心住院。')
    await write(withPlan, '/completion')
    const second = (await (await api(`${path(withPlan)}/debrief`)).json()) as { debrief: CaseDebrief }
    expect(second.debrief.dispositionRecorded).toBe(true)
  })

  it('completes the whole case end to end and compares the record with the golden reference in the Debrief', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    // Case Truth the doctor has legitimately uncovered; later responses may repeat it.
    const revealed: unknown[] = []
    const noLeak = async (label: string, response: Response) => {
      expectNoCaseTruth(label, await response.clone().text(), revealed)
      return response
    }

    const encounterId = await startEncounter('golden-case-02')

    installScripted('patient')
      .reply('医生，我今天凌晨起胸口一阵阵发闷、发紧，还冒汗。')
      .reply('疼了六个小时了，左肩膀和后背隐隐跟着酸，歇一会儿能轻一点。')
    await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
    await settled(encounterId, (await asked(encounterId, '疼了多长时间？放射到哪里吗？')).patientTurn.turnId)

    const heart = await write(encounterId, '/physical-examinations', { system: 'heart' })
    const finding = ((await heart.json()) as { examination: { finding: string } }).examination.finding
    expect(finding).toBe(goldenCase.physicalExamination.heart)
    const lungs = await write(encounterId, '/physical-examinations', { system: 'lungs' })
    revealed.push(
      finding,
      ((await lungs.json()) as { examination: { finding: string } }).examination.finding,
      Object.values(goldenCase.physicalExamination.vitals),
    )

    const issued = await noLeak('issued', await write(encounterId, '/investigations', { catalogItemIds: ['ecg', 'hs-ctni'] }))
    const [ecg, hsCtni] = ((await issued.json()) as InvestigationsResponse).investigations
    const ecgRelease = await write(encounterId, `/investigations/${ecg.investigationId}/instant-release`)
    revealed.push(goldenCase.textResults[0].findings, goldenCase.textResults[0].impression)
    await noLeak('ecg released', ecgRelease)
    const hsRelease = await write(encounterId, `/investigations/${hsCtni.investigationId}/instant-release`)
    revealed.push(goldenCase.laboratories[0].value, goldenCase.laboratories[0].referenceRange.text)
    const hsBody = await (await noLeak('hs-ctni released', hsRelease)).text()
    expect(hsBody).toContain('0.68')
    const acknowledged = await noLeak('acknowledged', await write(encounterId, '/report-acknowledgements', {
      reportIds: ((JSON.parse(hsBody) as InvestigationsResponse).investigations.flatMap((i) => i.reports.map((r) => r.reportId))),
    }))
    expect(((await acknowledged.json()) as InvestigationsResponse).investigations.flatMap((i) => i.reports.map((r) => r.acknowledgement !== null)))
      .toEqual([true, true])

    vi.setSystemTime(T0 + 150_000)
    const amendedList = await investigationsOf(encounterId)
    const amendedBody = JSON.stringify(amendedList)
    expect(amendedBody).toContain(goldenCase.reportAmendments[0].reason)
    expect(amendedBody).toContain('1.45')
    revealed.push(goldenCase.reportAmendments[0].reason, 1.45)
    // Completion re-checks the latest released version, so the stale acknowledgements refuse it.
    const refused = await send('POST', `${path(encounterId)}/completion`)
    expect(refused.status).toBe(409)
    await noLeak('re-acknowledged', await write(encounterId, '/report-acknowledgements', {
      reportIds: amendedList.flatMap((i) => i.reports.filter((r) => !r.acknowledgement).map((r) => r.reportId)),
    }))

    await ready(encounterId, '急转上级医院胸痛中心住院，收住 CCU 评估冠脉造影。')
    const completed = await noLeak('completion', await write(encounterId, '/completion'))
    expect(await completed.json()).toMatchObject({ encounter: { status: 'completed' } })

    const debrief = ((await (await api(`${path(encounterId)}/debrief`)).json()) as { debrief: CaseDebrief }).debrief
    expect(debrief.reference).toEqual(goldenCase.debriefReference)
    expect(debrief.diagnoses).toEqual([expect.objectContaining({ code: 'I21.4', primary: true })])
    const hsCtniReport = debrief.investigations.find((i) => i.catalogItemId === 'hs-ctni')!.reports.at(-1)!
    expect(hsCtniReport).toMatchObject({ version: 2, acknowledgement: { practitionerId: 'demo-practitioner' } })
    expect(debrief.signedNote.sections.plan).toContain('收住 CCU')
    expect(debrief.dispositionRecorded).toBe(true)
    expect(debrief.questions.map((q) => q.text)).toEqual(['您哪里不舒服？', '疼了多长时间？放射到哪里吗？'])
  })
})
