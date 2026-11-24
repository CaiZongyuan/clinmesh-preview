import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import { app } from '../../src/worker/app'

const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)
const send = (method: string, path: string, body?: unknown) =>
  api(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// Every command that writes to one Encounter, each with a request that would succeed on an active Encounter.
// A new write route under /api/encounters/:encounterId fails the first test until it is listed here.
const writeProbes: Record<string, (encounterId: string) => Promise<Response>> = {
  'POST /api/encounters/:encounterId/abandonment': (id) => send('POST', `/api/encounters/${id}/abandonment`),
}

const isEncounterWrite = (route: { method: string; path: string }) =>
  route.method !== 'GET' && route.method !== 'ALL' && route.path.startsWith('/api/encounters/:encounterId')

describe('frozen Encounters', () => {
  it('has a probe for every write route on an Encounter', () => {
    const writes = app.routes.filter(isEncounterWrite).map((route) => `${route.method} ${route.path}`)
    expect(new Set(writes)).toEqual(new Set(Object.keys(writeProbes)))
  })

  it('refuses every write command once the Encounter is abandoned, changing nothing', async () => {
    const started = await send('POST', '/api/encounters', { caseId: 'golden-case-01' })
    const { encounterId } = ((await started.json()) as EncounterResponse).encounter
    await send('POST', `/api/encounters/${encounterId}/abandonment`)

    const read = async () => ({
      encounter: ((await (await api(`/api/encounters/${encounterId}`)).json()) as EncounterResponse).encounter,
      audit: ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents,
    })
    const frozen = await read()
    expect(frozen.encounter.status).toBe('abandoned')

    for (const [route, probe] of Object.entries(writeProbes)) {
      const response = await probe(encounterId)
      expect(response.status, route).toBe(409)
      expect(((await response.json()) as ErrorResponse).error.code, route).toBe('encounter-not-active')
    }
    expect(await read()).toEqual(frozen)
  })
})
