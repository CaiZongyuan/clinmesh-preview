import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import type { InvestigationsResponse } from '../../src/shared/investigation'
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

interface FrozenEncounter {
  encounterId: string
  pendingInvestigationId: string
  releasedReportId: string
  failedPatientTurnId: string
}

// Every command that writes to one Encounter, each with a request that would succeed on an active Encounter.
// A new write route under /api/encounters/:encounterId fails the first test until it is listed here.
const writeProbes: Record<string, (frozen: FrozenEncounter) => Promise<Response>> = {
  'POST /api/encounters/:encounterId/abandonment': ({ encounterId }) => send('POST', `/api/encounters/${encounterId}/abandonment`),
  'POST /api/encounters/:encounterId/physical-examinations': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' }),
  'POST /api/encounters/:encounterId/investigations': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['pct'] }),
  'POST /api/encounters/:encounterId/investigations/:investigationId/instant-release': ({ encounterId, pendingInvestigationId }) =>
    send('POST', `/api/encounters/${encounterId}/investigations/${pendingInvestigationId}/instant-release`),
  'POST /api/encounters/:encounterId/report-acknowledgements': ({ encounterId, releasedReportId }) =>
    send('POST', `/api/encounters/${encounterId}/report-acknowledgements`, { reportIds: [releasedReportId] }),
  'POST /api/encounters/:encounterId/consultation/doctor-turns': ({ encounterId }) =>
    send('POST', `/api/encounters/${encounterId}/consultation/doctor-turns`, { clientTurnId: 'frozen', text: '还有哪里不舒服？' }),
  'POST /api/encounters/:encounterId/consultation/patient-turns/:turnId/retry': ({ encounterId, failedPatientTurnId }) =>
    send('POST', `/api/encounters/${encounterId}/consultation/patient-turns/${failedPatientTurnId}/retry`),
}

// An Encounter with one released, unacknowledged Report, one pending Investigation and one failed patient reply
// (no model is configured, so it fails, and a failed reply is what a retry is asked of), then abandoned.
async function frozenEncounter(): Promise<FrozenEncounter> {
  const started = await send('POST', '/api/encounters', { caseId: 'golden-case-01' })
  const { encounterId } = ((await started.json()) as EncounterResponse).encounter
  const issued = await send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc', 'crp'] })
  const [cbc, crp] = ((await issued.json()) as InvestigationsResponse).investigations
  const released = await send('POST', `/api/encounters/${encounterId}/investigations/${cbc.investigationId}/instant-release`)
  const [cbcReleased] = ((await released.json()) as InvestigationsResponse).investigations
  const failed = await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
  await send('POST', `/api/encounters/${encounterId}/abandonment`)
  return {
    encounterId,
    pendingInvestigationId: crp.investigationId,
    releasedReportId: cbcReleased.reports[0].reportId,
    failedPatientTurnId: failed.turnId,
  }
}

const isEncounterWrite = (route: { method: string; path: string }) =>
  route.method !== 'GET' && route.method !== 'ALL' && route.path.startsWith('/api/encounters/:encounterId')

describe('frozen Encounters', () => {
  it('has a probe for every write route on an Encounter', () => {
    const writes = app.routes.filter(isEncounterWrite).map((route) => `${route.method} ${route.path}`)
    expect(new Set(writes)).toEqual(new Set(Object.keys(writeProbes)))
  })

  it('refuses every write command once the Encounter is abandoned, changing nothing', async () => {
    const frozenIds = await frozenEncounter()
    const { encounterId } = frozenIds

    const read = async () => ({
      encounter: ((await (await api(`/api/encounters/${encounterId}`)).json()) as EncounterResponse).encounter,
      audit: ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents,
      examinations: ((await (await api(`/api/encounters/${encounterId}/physical-examinations`)).json()) as PhysicalExaminationsResponse)
        .examinations,
      investigations: ((await (await api(`/api/encounters/${encounterId}/investigations`)).json()) as InvestigationsResponse)
        .investigations,
      consultation: await transcript(encounterId),
    })
    const frozen = await read()
    expect(frozen.encounter.status).toBe('abandoned')
    expect(frozen.investigations.map((i) => i.reports.length)).toEqual([1, 0])

    for (const [route, probe] of Object.entries(writeProbes)) {
      const response = await probe(frozenIds)
      expect(response.status, route).toBe(409)
      expect(((await response.json()) as ErrorResponse).error.code, route).toBe('encounter-not-active')
    }
    expect(await read()).toEqual(frozen)
  })
})
