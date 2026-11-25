import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaseDebrief, CompletionGateId } from '../../src/shared/completion'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import { WORKSPACE_NAME } from '../../src/worker/workspace-name'
import { api, asked, copilotSettled, copilotSnapshot, promptCopilot, send, settled, startEncounter, transcript } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const note = {
  'chief-complaint': '发热、咳嗽 3 天。',
  'present-illness': '患者说三天前起病。',
  'past-history': '',
  findings: '',
  assessment: '全身状态稳定。',
  plan: '三天复诊。',
}
const diagnosis = [{ code: 'I10', primary: true, source: 'doctor' }]
const line = { drugId: 'doxycycline', dose: 1, route: '口服', frequency: 'BID', days: 7 }
const path = (encounterId: string) => `/api/encounters/${encounterId}`

async function write(id: string, suffix: string, body?: unknown, method = 'POST') {
  const response = await send(method, `${path(id)}${suffix}`, body)
  expect(response.ok, await response.clone().text()).toBe(true)
  return response
}

async function ready(id: string) {
  await write(id, '/diagnosis/revisions', { entries: diagnosis })
  await write(id, '/no-medication')
  await write(id, '/clinical-note/revisions', { sections: note })
}

async function refuses(id: string, ...gates: CompletionGateId[]) {
  const response = await send('POST', `${path(id)}/completion`)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: { code: 'completion-gates-unmet', failedGates: gates },
  })
  expect(await (await api(path(id))).json()).toMatchObject({ encounter: { status: 'active', endedAt: null } })
  expect((await api(`${path(id)}/debrief`)).status).toBe(409)
}

afterEach(() => vi.useRealTimers())

describe('Complete Encounter', () => {
  it('names each unmet Completion Gate and leaves the Encounter active on refusal', async () => {
    await refuses(await startEncounter(), 'primary-diagnosis', 'medication', 'signed-note')
  })

  it('rechecks the primary Diagnosis even if a medication conclusion already exists', async () => {
    const id = await startEncounter()
    await ready(id)
    // Formal medication requires confirmed Diagnosis. Seed just the impossible public combination to isolate Gate 1.
    await runInDurableObject(env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME), (_, state) => {
      state.storage.sql.exec('DROP TRIGGER diagnosis_revision_no_delete')
      state.storage.sql.exec('DELETE FROM diagnosis_revision WHERE encounter_id = ?', id)
    })
    await refuses(id, 'primary-diagnosis')
  })

  it('rechecks the latest released Report and accepts re-acknowledgement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.now()
    vi.setSystemTime(now)
    const id = await startEncounter()
    await ready(id)
    const issued = await write(id, '/investigations', { catalogItemIds: ['cbc', 'crp'] })
    const [cbc, crp] = ((await issued.json()) as InvestigationsResponse).investigations
    await write(id, `/investigations/${crp.investigationId}/cancellation`)
    await refuses(id, 'reports')
    const first = await write(id, `/investigations/${cbc.investigationId}/instant-release`)
    const firstReport = ((await first.json()) as InvestigationsResponse).investigations[0].reports[0]
    await write(id, '/report-acknowledgements', { reportIds: [firstReport.reportId] })
    vi.setSystemTime(now + 120_000)
    await refuses(id, 'reports')
    const current = await api(`${path(id)}/investigations`)
    const newest = ((await current.json()) as InvestigationsResponse).investigations[0].reports.at(-1)!
    expect(newest.version).toBe(2)
    await write(id, '/report-acknowledgements', { reportIds: [newest.reportId] })
    await write(id, '/completion')
  })

  it('requires a medication conclusion and accepts a formal Prescription', async () => {
    const id = await startEncounter()
    await write(id, '/diagnosis/revisions', { entries: diagnosis })
    await write(id, '/clinical-note/revisions', { sections: note })
    await refuses(id, 'medication')
    await write(id, '/prescriptions', { lines: [line] })
    await write(id, '/completion')
  })

  it('requires an additional signed Clinical Note after a new Diagnosis revision', async () => {
    const id = await startEncounter()
    await ready(id)
    await write(id, '/diagnosis/revisions', { entries: diagnosis })
    await refuses(id, 'signed-note')
    await write(id, '/clinical-note/revisions', { sections: note })
    await write(id, '/completion')
  })

  it.each([
    ['/investigations/draft', ['cbc']],
    ['/diagnosis/draft', diagnosis],
    ['/prescriptions/draft', [line]],
  ])('refuses even one saved high-risk draft at %s', async (draftPath, entries) => {
    const id = await startEncounter()
    await ready(id)
    await write(id, draftPath, { entries }, 'PUT')
    await refuses(id, 'drafts')
    await write(id, draftPath, { entries: [] }, 'PUT')
    await write(id, '/completion')
  })

  it('preserves unsubmitted draft items and consumes the ones issued formally', async () => {
    const id = await startEncounter()
    await write(id, '/diagnosis/revisions', { entries: diagnosis })
    await write(id, '/investigations/draft', { entries: ['cbc', 'crp'] }, 'PUT')
    await write(id, '/prescriptions/draft', { entries: [line] }, 'PUT')
    await write(id, '/investigations', { catalogItemIds: ['cbc'] })
    await write(id, '/prescriptions', { lines: [line] })
    expect(await (await api(`${path(id)}/clinical-drafts`)).json()).toEqual({
      drafts: { investigations: ['crp'], prescriptions: [] },
    })
  })

  it('stops running and queued Copilot turns when the Encounter completes', async () => {
    const id = await startEncounter()
    await ready(id)
    const llm = installScripted('copilot')
    const gate = llm.gate('正在分析', '不应在完诊后发布')
    try {
      expect((await promptCopilot(id, 'running', '小结')).status).toBe(201)
      await gate.reached
      expect((await promptCopilot(id, 'queued', '另一条问题')).status).toBe(201)
      expect((await copilotSnapshot(id)).queued).toHaveLength(1)
      await write(id, '/completion')
      const snapshot = await copilotSettled(id, 650)
      expect(snapshot.turns.map((turn) => turn.status)).toEqual(['stopped'])
      expect(snapshot.queued).toEqual([])
      expect(snapshot.turns.every((turn) => !turn.reply.includes('不应在完诊后发布'))).toBe(true)
      expect(llm.requests).toHaveLength(1)
    } finally {
      gate.release()
    }
  })

  it('completes atomically, unlocks a read-only debrief and starts an independent replay', async () => {
    const id = await startEncounter()
    await ready(id)
    await write(id, '/physical-examinations', { system: 'lungs' })
    installScripted('patient').reply('医生，我昨天就咳嗽了。')
    const turn = (await asked(id, '您何时开始咳嗽？')).patientTurn
    await settled(id, turn.turnId)
    expect(await (await api(`${path(id)}/debrief`)).json()).toMatchObject({ error: { code: 'debrief-locked' } })
    const responses = await Promise.all([send('POST', `${path(id)}/completion`), send('POST', `${path(id)}/completion`)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const completed = responses.find((response) => response.ok)!
    expect(await completed.json()).toMatchObject({ encounter: { status: 'completed', endedAt: expect.any(String) } })
    const audit = await (await api(`${path(id)}/audit-events`)).json() as { auditEvents: { eventType: string }[] }
    expect(audit.auditEvents.filter((event) => event.eventType === 'encounter-completed')).toEqual([
      expect.objectContaining({ eventType: 'encounter-completed', practitionerId: 'demo-practitioner', subject: id }),
    ])
    const result = await (await api(`${path(id)}/debrief`)).json() as { debrief: CaseDebrief }
    expect(result.debrief).toMatchObject({
      diagnoses: [expect.objectContaining({ code: 'I10' })],
      examinations: [expect.objectContaining({ system: 'lungs' })],
      prescriptions: { noMedication: expect.any(Object) },
      signedNote: { sections: note },
      questions: [expect.objectContaining({ text: '您何时开始咳嗽？' })],
      reference: { primaryDiagnosis: expect.stringContaining('社区获得性肺炎'), disposition: '门诊治疗，72 小时复诊' },
    })
    expect(await (await api('/api/golden-cases')).json()).toMatchObject({
      goldenCases: expect.arrayContaining([expect.objectContaining({ queueStatus: 'completed', completedEncounterId: id })]),
    })
    const replay = await startEncounter()
    expect(replay).not.toBe(id)
    expect(await transcript(replay)).toEqual([])
    expect((await api(`${path(replay)}/debrief`)).status).toBe(409)
    expect(await (await api(`${path(id)}/debrief`)).json()).toEqual(result)
  })
})
