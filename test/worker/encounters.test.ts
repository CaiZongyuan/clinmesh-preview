import { evictDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type {
  ActiveEncounterResponse,
  AuditEventsResponse,
  EncounterResponse,
  EncounterView,
  ErrorResponse,
} from '../../src/shared/encounter'
import type { GoldenCaseQueueResponse } from '../../src/shared/golden-case-queue'
import { goldenCase1Chart } from '../fixtures/golden-case-1'

const CASE_ID = 'golden-case-01'
const PRACTITIONER_ID = goldenCase1Chart.practitionerId

const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)
const post = (path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const startEncounter = (caseId = CASE_ID) => post('/api/encounters', { caseId })
const abandonEncounter = (encounterId: string) => post(`/api/encounters/${encounterId}/abandonment`)

async function startedEncounter(): Promise<EncounterView> {
  const response = await startEncounter()
  expect(response.status).toBe(201)
  return ((await response.json()) as EncounterResponse).encounter
}

const activeEncounter = async () => ((await (await api('/api/encounters/active')).json()) as ActiveEncounterResponse).encounter
const queueStatus = async () =>
  ((await (await api('/api/golden-cases')).json()) as GoldenCaseQueueResponse).goldenCases.map((entry) => entry.queueStatus)
const auditEvents = async (encounterId: string) =>
  ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents

describe('starting an Encounter', () => {
  it('creates it server-side, bound to the Golden Case and Patient Persona versions, with only the banner and Visible Source History', async () => {
    const before = Date.now()
    const response = await startEncounter()
    expect(response.status).toBe(201)
    const { encounter } = (await response.json()) as EncounterResponse
    expect(encounter).toEqual({
      ...goldenCase1Chart,
      encounterId: expect.any(String),
      status: 'active',
      startedAt: expect.any(String),
      endedAt: null,
    })
    expect(Date.parse(encounter.startedAt)).toBeGreaterThanOrEqual(before - 1000)

    const read = await api(`/api/encounters/${encounter.encounterId}`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ encounter })
    expect(await activeEncounter()).toEqual(encounter)
    expect(await queueStatus()).toEqual(['in-encounter'])
    expect(await auditEvents(encounter.encounterId)).toEqual([
      { eventType: 'encounter-started', practitionerId: PRACTITIONER_ID, occurredAt: encounter.startedAt },
    ])
  })

  it('keeps the active Encounter when the workspace restarts', async () => {
    const encounter = await startedEncounter()
    await evictDurableObject(env.CLINIC_WORKSPACE.getByName('default'))
    expect(await activeEncounter()).toEqual(encounter)
    expect(await queueStatus()).toEqual(['in-encounter'])
  })

  it('reports no active Encounter in a fresh workspace', async () => {
    expect(await activeEncounter()).toBeNull()
    expect(await queueStatus()).toEqual(['waiting'])
  })

  it('refuses an unknown Golden Case and a malformed request', async () => {
    const unknown = await startEncounter('golden-case-99')
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as ErrorResponse).error.code).toBe('golden-case-not-found')

    for (const body of [undefined, {}, { caseId: 7 }]) {
      const malformed = await post('/api/encounters', body)
      expect(malformed.status).toBe(400)
      expect(((await malformed.json()) as ErrorResponse).error.code).toBe('invalid-request')
    }
    expect(await activeEncounter()).toBeNull()
  })
})

describe('single active Encounter per workspace', () => {
  it('refuses to start a second Encounter while one is active', async () => {
    const first = await startedEncounter()
    const second = await startEncounter()
    expect(second.status).toBe(409)
    const { error } = (await second.json()) as ErrorResponse
    expect(error.code).toBe('active-encounter-exists')
    expect(error.message).toContain('李建国')
    expect(await activeEncounter()).toEqual(first)
  })

  it('lets exactly one of two simultaneous starts win', async () => {
    const responses = await Promise.all([startEncounter(), startEncounter(), startEncounter()])
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409])
    const winner = ((await responses.find((r) => r.status === 201)!.json()) as EncounterResponse).encounter
    expect((await activeEncounter())?.encounterId).toBe(winner.encounterId)
  })
})

describe('Encounter Abandonment', () => {
  it('freezes the Encounter, records the practitioner, and refuses later commands on it', async () => {
    const encounter = await startedEncounter()
    const response = await abandonEncounter(encounter.encounterId)
    expect(response.status).toBe(200)
    const { encounter: abandoned } = (await response.json()) as EncounterResponse
    expect(abandoned).toEqual({ ...encounter, status: 'abandoned', endedAt: expect.any(String) })
    expect(Date.parse(abandoned.endedAt!)).toBeGreaterThanOrEqual(Date.parse(encounter.startedAt))

    const again = await abandonEncounter(encounter.encounterId)
    expect(again.status).toBe(409)
    expect(((await again.json()) as ErrorResponse).error.code).toBe('encounter-not-active')

    expect(await (await api(`/api/encounters/${encounter.encounterId}`)).json()).toEqual({ encounter: abandoned })
    expect(await activeEncounter()).toBeNull()
    expect(await queueStatus()).toEqual(['waiting'])
    expect(await auditEvents(encounter.encounterId)).toEqual([
      { eventType: 'encounter-started', practitionerId: PRACTITIONER_ID, occurredAt: encounter.startedAt },
      { eventType: 'encounter-abandoned', practitionerId: PRACTITIONER_ID, occurredAt: abandoned.endedAt },
    ])
  })

  it('lets the doctor start a fresh, independent Encounter for the same Golden Case afterwards', async () => {
    const first = await startedEncounter()
    await abandonEncounter(first.encounterId)
    const second = await startedEncounter()

    expect(second.encounterId).not.toBe(first.encounterId)
    expect(second.status).toBe('active')
    const firstNow = ((await (await api(`/api/encounters/${first.encounterId}`)).json()) as EncounterResponse).encounter
    expect(firstNow.status).toBe('abandoned')
    expect(await auditEvents(second.encounterId)).toEqual([
      { eventType: 'encounter-started', practitionerId: PRACTITIONER_ID, occurredAt: second.startedAt },
    ])
  })

  it('answers 404 for an Encounter that does not exist', async () => {
    for (const response of [
      await api('/api/encounters/no-such-encounter'),
      await api('/api/encounters/no-such-encounter/audit-events'),
      await abandonEncounter('no-such-encounter'),
    ]) {
      expect(response.status).toBe(404)
      expect(((await response.json()) as ErrorResponse).error.code).toBe('encounter-not-found')
    }
  })
})
