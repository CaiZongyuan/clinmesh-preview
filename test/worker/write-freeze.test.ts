import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ClinicalNoteResponse } from '../../src/shared/clinical-note'
import type { DiagnosisResponse } from '../../src/shared/diagnosis'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import type { PrescriptionsResponse } from '../../src/shared/medication'
import type { PhysicalExaminationsResponse } from '../../src/shared/physical-examination'
import { app } from '../../src/worker/app'
import { asked, settled, transcript } from './support/clinic'

const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)
const send = (method: string, path: string, body?: unknown) =>
  api(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const SIGNABLE_NOTE = {
  'chief-complaint': '发热、咳嗽 3 天。',
  'present-illness': '三天前起病。',
  'past-history': '',
  findings: '',
  assessment: '',
  plan: '注意休息。',
}

interface FrozenEncounter {
  encounterId: string
  pendingInvestigationId: string
  releasedReportId: string
  failedPatientTurnId: string
  copilotTurnId: string
}

// Every command that writes to one Encounter, each with a request that would succeed on an active Encounter.
// A new write route under /api/encounters/:encounterId fails the first test until it is listed here.
const writeProbes: Record<string, (frozen: FrozenEncounter) => Promise<Response>> = {
  'POST /api/encounters/:encounterId/draft-assistance': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/draft-assistance`, {
      command: 'propose', id: 'probe', runId: null, protect: true, action: { module: 'investigations', itemId: 'pct' },
    }),
  'POST /api/encounters/:encounterId/completion': ({ encounterId }) => send('POST', `/api/encounters/${encounterId}/completion`),
  'PUT /api/encounters/:encounterId/investigations/draft': ({ encounterId }) =>
    send('PUT', `/api/encounters/${encounterId}/investigations/draft`, { entries: ['pct'] }),
  'PUT /api/encounters/:encounterId/prescriptions/draft': ({ encounterId }) =>
    send('PUT', `/api/encounters/${encounterId}/prescriptions/draft`, {
      entries: [{ drugId: 'doxycycline', dose: 1, route: '口服', frequency: 'BID', days: 7 }],
    }),
  'POST /api/encounters/:encounterId/abandonment': ({ encounterId }) => send('POST', `/api/encounters/${encounterId}/abandonment`),
  'POST /api/encounters/:encounterId/physical-examinations': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' }),
  'POST /api/encounters/:encounterId/investigations': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['pct'] }),
  'POST /api/encounters/:encounterId/investigations/:investigationId/instant-release': ({ encounterId, pendingInvestigationId }) =>
    send('POST', `/api/encounters/${encounterId}/investigations/${pendingInvestigationId}/instant-release`),
  'POST /api/encounters/:encounterId/investigations/:investigationId/cancellation': ({ encounterId, pendingInvestigationId }) =>
    send('POST', `/api/encounters/${encounterId}/investigations/${pendingInvestigationId}/cancellation`),
  'POST /api/encounters/:encounterId/report-acknowledgements': ({ encounterId, releasedReportId }) =>
    send('POST', `/api/encounters/${encounterId}/report-acknowledgements`, { reportIds: [releasedReportId] }),
  'POST /api/encounters/:encounterId/consultation/doctor-turns': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/consultation/doctor-turns`, { clientTurnId: 'frozen', text: '还有哪里不舒服？' }),
  'POST /api/encounters/:encounterId/consultation/patient-turns/:turnId/retry': ({ encounterId, failedPatientTurnId }) =>
    send('POST', `/api/encounters/${encounterId}/consultation/patient-turns/${failedPatientTurnId}/retry`),
  'POST /api/encounters/:encounterId/consultation/patient-turns/:turnId/speech': ({ encounterId, failedPatientTurnId }) =>
    send('POST', `/api/encounters/${encounterId}/consultation/patient-turns/${failedPatientTurnId}/speech`, { text: '您好。' }),
  'PATCH /api/encounters/:encounterId/clinical-note/draft': ({ encounterId }) =>
    send('PATCH', `/api/encounters/${encounterId}/clinical-note/draft`, { sections: { plan: '72 小时复诊。' } }),
  'POST /api/encounters/:encounterId/clinical-note/revisions': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/clinical-note/revisions`, { sections: SIGNABLE_NOTE }),
  'PUT /api/encounters/:encounterId/diagnosis/draft': ({ encounterId }) =>
    send('PUT', `/api/encounters/${encounterId}/diagnosis/draft`, { entries: [{ code: 'I10', primary: true, source: 'doctor' }] }),
  'POST /api/encounters/:encounterId/diagnosis/revisions': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/diagnosis/revisions`, { entries: [{ code: 'I10', primary: true, source: 'doctor' }] }),
  'POST /api/encounters/:encounterId/diagnosis/reopen': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/diagnosis/reopen`),
  'POST /api/encounters/:encounterId/prescriptions': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/prescriptions`, {
      lines: [{ drugId: 'doxycycline', dose: 1, route: '口服', frequency: 'BID', days: 7 }],
    }),
  'POST /api/encounters/:encounterId/no-medication': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/no-medication`),
  'POST /api/encounters/:encounterId/copilot/prompts': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/copilot/prompts`, { clientPromptId: 'frozen', text: '总结一下', mentions: [], mode: 'queue' }),
  'POST /api/encounters/:encounterId/copilot/turns/:turnId/resend': ({ encounterId, copilotTurnId }) =>
    send('POST', `/api/encounters/${encounterId}/copilot/turns/${copilotTurnId}/resend`, { clientPromptId: 'frozen-resend', text: '再总结一次', mentions: [] }),
  'POST /api/encounters/:encounterId/copilot/stop': ({ encounterId }) => send('POST', `/api/encounters/${encounterId}/copilot/stop`),
  'POST /api/encounters/:encounterId/copilot/turns/:turnId/feedback': ({ encounterId, copilotTurnId }) =>
    send('POST', `/api/encounters/${encounterId}/copilot/turns/${copilotTurnId}/feedback`, { value: 'up' }),
  'POST /api/encounters/:encounterId/copilot/config': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/copilot/config`, { model: 'glm-5.3-flash', effort: 'low' }),
  'POST /api/encounters/:encounterId/copilot/compact': ({ encounterId }) => send('POST', `/api/encounters/${encounterId}/copilot/compact`),
  'POST /api/encounters/:encounterId/copilot/triggers/:ref/flush': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/copilot/triggers/consultation:frozen/flush`),
  'PUT /api/encounters/:encounterId/copilot/automatic-analysis': ({ encounterId }) =>
    send('PUT', `/api/encounters/${encounterId}/copilot/automatic-analysis`, { enabled: false }),
  'POST /api/encounters/:encounterId/copilot/pending-analysis/run': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/copilot/pending-analysis/run`),
  'DELETE /api/encounters/:encounterId/copilot/triggers/:ref': ({ encounterId }) =>
    send('DELETE', `/api/encounters/${encounterId}/copilot/triggers/consultation:frozen`),
}

// An Encounter with one released, unacknowledged Report, one pending Investigation, one failed patient reply
// (no model is configured, so it fails, and a failed reply is what a retry is asked of) and a signed Clinical Note
// with a later Draft edit, then abandoned.
async function frozenEncounter(status: 'abandoned' | 'completed'): Promise<FrozenEncounter> {
  const started = await send('POST', '/api/encounters', { caseId: 'golden-case-01' })
  const { encounterId } = ((await started.json()) as EncounterResponse).encounter
  const issued = await send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc', 'crp'] })
  const [cbc, crp] = ((await issued.json()) as InvestigationsResponse).investigations
  const released = await send('POST', `/api/encounters/${encounterId}/investigations/${cbc.investigationId}/instant-release`)
  const [cbcReleased] = ((await released.json()) as InvestigationsResponse).investigations
  const failed = await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
  await send('POST', `/api/encounters/${encounterId}/clinical-note/revisions`, { sections: SIGNABLE_NOTE })
  await send('PATCH', `/api/encounters/${encounterId}/clinical-note/draft`, { sections: { assessment: '待查。' } })
  await send('POST', `/api/encounters/${encounterId}/diagnosis/revisions`, {
    entries: [
      { code: 'I10', primary: true, source: 'doctor' },
      { code: 'E78.5', primary: false, source: 'doctor' },
    ],
  })
  await send('POST', `/api/encounters/${encounterId}/diagnosis/reopen`)
  const prompted = await send('POST', `/api/encounters/${encounterId}/copilot/prompts`, {
    clientPromptId: 'frozen-setup', text: '总结一下', mentions: [], mode: 'queue',
  })
  const copilotTurnId = prompted.ok ? ((await prompted.json()) as { turnId: string }).turnId : 'missing'
  if (status === 'completed') {
    await send('POST', `/api/encounters/${encounterId}/investigations/${crp.investigationId}/cancellation`)
    await send('POST', `/api/encounters/${encounterId}/report-acknowledgements`, { reportIds: [cbcReleased.reports[0].reportId] })
    await send('PUT', `/api/encounters/${encounterId}/diagnosis/draft`, { entries: [] })
    await send('POST', `/api/encounters/${encounterId}/no-medication`)
    await send('POST', `/api/encounters/${encounterId}/clinical-note/revisions`, { sections: SIGNABLE_NOTE })
    expect((await send('POST', `/api/encounters/${encounterId}/completion`)).status).toBe(200)
  } else {
    expect((await send('POST', `/api/encounters/${encounterId}/abandonment`)).status).toBe(200)
  }
  return {
    encounterId,
    pendingInvestigationId: crp.investigationId,
    releasedReportId: cbcReleased.reports[0].reportId,
    failedPatientTurnId: failed.turnId,
    copilotTurnId,
  }
}

const isEncounterWrite = (route: { method: string; path: string }) =>
  route.method !== 'GET' && route.method !== 'ALL' && route.path.startsWith('/api/encounters/:encounterId')

describe('frozen Encounters', () => {
  it('has a probe for every write route on an Encounter', () => {
    const writes = app.routes.filter(isEncounterWrite).map((route) => `${route.method} ${route.path}`)
    expect(new Set(writes)).toEqual(new Set(Object.keys(writeProbes)))
  })

  it.each(['abandoned', 'completed'] as const)('refuses every write command once the Encounter is %s, changing nothing', async (status) => {
    const frozenIds = await frozenEncounter(status)
    const { encounterId } = frozenIds

    const read = async () => ({
      encounter: ((await (await api(`/api/encounters/${encounterId}`)).json()) as EncounterResponse).encounter,
      audit: ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents,
      examinations: ((await (await api(`/api/encounters/${encounterId}/physical-examinations`)).json()) as PhysicalExaminationsResponse)
        .examinations,
      investigations: ((await (await api(`/api/encounters/${encounterId}/investigations`)).json()) as InvestigationsResponse)
        .investigations,
      consultation: await transcript(encounterId),
      drafts: await (await api(`/api/encounters/${encounterId}/clinical-drafts`)).json(),
      note: ((await (await api(`/api/encounters/${encounterId}/clinical-note`)).json()) as ClinicalNoteResponse).note,
      diagnosis: ((await (await api(`/api/encounters/${encounterId}/diagnosis`)).json()) as DiagnosisResponse).diagnosis,
      prescriptions: ((await (await api(`/api/encounters/${encounterId}/prescriptions`)).json()) as PrescriptionsResponse)
        .prescriptions,
    })
    const frozen = await read()
    expect(frozen.encounter.status).toBe(status)
    expect(frozen.investigations.map((i) => i.reports.length)).toEqual([1, 0])
    expect(frozen.note.revisions).toHaveLength(status === 'completed' ? 2 : 1)
    expect(frozen.diagnosis.draft).toHaveLength(status === 'completed' ? 0 : 2)
    expect(frozen.diagnosis.revisions).toHaveLength(1)

    for (const [route, probe] of Object.entries(writeProbes)) {
      const response = await probe(frozenIds)
      expect(response.status, route).toBe(409)
      expect(((await response.json()) as ErrorResponse).error.code, route).toBe('encounter-not-active')
    }
    expect(await read()).toEqual(frozen)
  })
})
