import { describe, expect, it } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { CaseDebrief } from '../../src/shared/completion'
import type { EncounterResponse } from '../../src/shared/encounter'
import type { GoldenCaseQueueResponse } from '../../src/shared/golden-case-queue'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import type { PrescriptionsResponse } from '../../src/shared/medication'
import { goldenCase4Chart, goldenCase4Findings, goldenCase4QueueEntry } from '../fixtures/golden-case-4'
import { expectNoCaseTruth } from './case-truth'
import { api, asked, settled, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const goldenCase = casePack.cases.find((c) => c.id === 'golden-case-04')!
const debriefReference = goldenCase.debriefReference

const send = (method: string, path: string, body?: unknown) =>
  api(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function ok(method: string, path: string, body?: unknown) {
  const response = await send(method, path, body)
  expect(response.ok, `${method} ${path}: ${await response.clone().text()}`).toBe(true)
  return response
}

// Doctor lines and Simulated Patient replies stay diagnosis-neutral; the denylist would flag Case Truth
// in the transcript and in the Simulated Patient's LLM requests otherwise.
const Q1 = '您哪里不舒服？'
const Q2 = '发烧了吗？有没有胸闷气短？'
const Q3 = '这几天吃过什么药吗？身边有人有类似症状吗？'
const R1 = '医生，我这三天一直鼻塞流鼻涕，嗓子疼得厉害。'
const R2 = '自己量体温，三十七度多一点。不喘，咳嗽也很少。'
const R3 = '没吃药，就是多喝水多休息。办公室好几个同事都一样。'

const note = {
  'chief-complaint': '鼻塞、流涕、咽痛 3 天。',
  'present-illness': '三天前着凉后起病，鼻塞流清涕，咽痛，低热，无胸闷气短。',
  'past-history': '否认慢性病及药物过敏史。',
  findings: '咽部充血，双肺呼吸音清。',
  assessment: '急性上呼吸道感染，病毒性可能大，病程自限。',
  plan: '休息、多饮水；症状加重或迁延超过 10 天复诊。',
}

describe('Golden Case 4 journey: viral URI completed with No Medication', () => {
  it('lists the case at queue number 10 and serves a diagnosis-neutral chart', async () => {
    const queue = ((await (await api('/api/golden-cases')).json()) as GoldenCaseQueueResponse).goldenCases
    expect(queue.map((entry) => entry.caseId)).toContain('golden-case-04')
    expect(queue).toContainEqual(goldenCase4QueueEntry)

    const { encounter } = (await (await ok('POST', '/api/encounters', { caseId: 'golden-case-04' })).json()) as EncounterResponse
    expect(encounter).toEqual({ ...goldenCase4Chart, encounterId: expect.any(String), status: 'active', startedAt: expect.any(String), endedAt: null })

    // The debrief stays locked while the Encounter is active.
    expect((await api(`/api/encounters/${encounter.encounterId}/debrief`)).status).toBe(409)
    await ok('POST', `/api/encounters/${encounter.encounterId}/abandonment`)
  })

  it('runs a full Encounter to No Medication without any Prescription, and unlocks the Debrief only at completion', async () => {
    const patient = installScripted('patient').reply(R1).reply(R2).reply(R3)
    const revealed: unknown[] = []
    const encounterId = await startEncounter('golden-case-04')

    // The Consultation elicits the self-limiting picture; neither the transcript nor the Simulated
    // Patient's LLM requests may carry Case Truth, and the persona is the only patient input.
    await settled(encounterId, (await asked(encounterId, Q1)).patientTurn.turnId)
    await settled(encounterId, (await asked(encounterId, Q2)).patientTurn.turnId)
    await settled(encounterId, (await asked(encounterId, Q3)).patientTurn.turnId)
    for (const request of patient.requests) {
      expectNoCaseTruth('Simulated Patient LLM request', JSON.stringify(request))
      // The persona is the patient's only knowledge source; assert on its content, not just its shape.
      expect(JSON.stringify(request)).toContain('这三天鼻子堵、流清鼻涕，嗓子也疼。')
    }
    for (const [question, reply] of [[Q1, R1], [Q2, R2], [Q3, R3]] as const) {
      expectNoCaseTruth('Consultation transcript', JSON.stringify({ question, reply }), revealed)
    }

    // Objective findings come only from the Physical Examination.
    for (const system of ['vitals', 'pharynx', 'lungs', 'heart', 'abdomen'] as const) {
      const response = await ok('POST', `/api/encounters/${encounterId}/physical-examinations`, { system })
      const { examination } = (await response.json()) as { examination: { system: string; finding: string; vitals: unknown } }
      revealed.push(examination.finding, examination.vitals)
      expect(examination).toMatchObject({ system, ...goldenCase4Findings[system] })
    }
    expectNoCaseTruth('Physical Examination findings', JSON.stringify(revealed), revealed)

    // One normal CBC exercises the Reports gate; the result resolves from the catalog baseline.
    const issued = await ok('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc'] })
    const cbc = ((await issued.json()) as InvestigationsResponse).investigations[0]
    const released = await ok('POST', `/api/encounters/${encounterId}/investigations/${cbc.investigationId}/instant-release`)
    const investigation = ((await released.json()) as InvestigationsResponse).investigations[0]
    const report = investigation.reports.at(-1)!
    // The released Report and its catalog baseline values are now legitimately visible.
    revealed.push(investigation.reports.map((r) => r.body))
    await ok('POST', `/api/encounters/${encounterId}/report-acknowledgements`, { reportIds: [report.reportId] })

    await ok('POST', `/api/encounters/${encounterId}/diagnosis/revisions`, { entries: [{ code: 'J06.9', primary: true, source: 'doctor' }] })
    await ok('POST', `/api/encounters/${encounterId}/no-medication`)
    await ok('POST', `/api/encounters/${encounterId}/clinical-note/revisions`, { sections: note })
    await ok('POST', `/api/encounters/${encounterId}/completion`)

    // The Debrief is the only place the indications are stated, beside a completed Encounter with
    // No Medication, no Prescription line, and every CBC Report acknowledged.
    const { debrief } = (await (await api(`/api/encounters/${encounterId}/debrief`)).json()) as { debrief: CaseDebrief }
    revealed.push(debrief.reference)
    expect(debrief.reference).toEqual(debriefReference)
    // The debrief is where the no-antibacterial indication is stated, in the pack's own wording.
    expect(debrief.reference.medicationConclusion).toContain('抗菌药物无益')
    expect(debrief.reference.medicationConclusion).toContain('未开具任何处方')
    expect(debrief.prescriptions.noMedication).not.toBeNull()
    expect(debrief.prescriptions.lines).toEqual([])
    expect(debrief.diagnoses).toEqual([expect.objectContaining({ code: 'J06.9', primary: true, source: 'doctor' })])
    expectNoCaseTruth('Case Debrief', JSON.stringify(debrief), revealed)

    const prescriptions = (await (await api(`/api/encounters/${encounterId}/prescriptions`)).json()) as PrescriptionsResponse
    expect(prescriptions.prescriptions.noMedication).not.toBeNull()
    expect(prescriptions.prescriptions.lines).toEqual([])
  })

  it('keeps No Medication and any Prescription mutually exclusive for this case', async () => {
    const encounterId = await startEncounter('golden-case-04')
    await ok('POST', `/api/encounters/${encounterId}/diagnosis/revisions`, { entries: [{ code: 'J06.9', primary: true, source: 'doctor' }] })
    await ok('POST', `/api/encounters/${encounterId}/no-medication`)
    const response = await send('POST', `/api/encounters/${encounterId}/prescriptions`, {
      lines: [{ drugId: 'doxycycline', dose: 1, route: '口服', frequency: 'BID', days: 7 }],
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'no-medication-conflict' } })
  })
})
