import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import {
  BODY_SYSTEMS,
  type PhysicalExaminationResponse,
  type PhysicalExaminationsResponse,
} from '../../src/shared/physical-examination'
import { goldenCase1Chart, goldenCase1Findings } from '../fixtures/golden-case-1'
import { expectNoCaseTruth } from './case-truth'

const PRACTITIONER_ID = goldenCase1Chart.practitionerId
const caseTruthExamination = casePack.cases[0].physicalExamination

const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)
const post = (path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function startEncounter() {
  const response = await post('/api/encounters', { caseId: 'golden-case-01' })
  expect(response.status).toBe(201)
  return ((await response.json()) as EncounterResponse).encounter
}

const examine = (encounterId: string, system: unknown) =>
  post(`/api/encounters/${encounterId}/physical-examinations`, { system })
const examinations = async (encounterId: string) =>
  ((await (await api(`/api/encounters/${encounterId}/physical-examinations`)).json()) as PhysicalExaminationsResponse)
    .examinations

describe('Physical Examination', () => {
  it('reveals only the requested body system’s finding, deterministically from Case Truth', async () => {
    const findingsPerEncounter = []
    for (let round = 0; round < 2; round++) {
      const encounter = await startEncounter()
      expect(await examinations(encounter.encounterId)).toEqual([])
      for (const system of BODY_SYSTEMS) {
        const before = Date.now()
        const response = await examine(encounter.encounterId, system)
        expect(response.status, system).toBe(201)
        const body = await response.text()
        expectNoCaseTruth(`examining ${system}`, body, [caseTruthExamination[system]])

        const { examination } = JSON.parse(body) as PhysicalExaminationResponse
        expect(examination, system).toEqual({
          system,
          ...goldenCase1Findings[system],
          practitionerId: PRACTITIONER_ID,
          examinedAt: expect.any(String),
        })
        expect(Date.parse(examination.examinedAt)).toBeGreaterThanOrEqual(before - 1000)
      }
      findingsPerEncounter.push((await examinations(encounter.encounterId)).map(({ system, finding, vitals }) => ({ system, finding, vitals })))
      await post(`/api/encounters/${encounter.encounterId}/abandonment`)
    }
    expect(findingsPerEncounter[0].map((e) => e.system)).toEqual([...BODY_SYSTEMS])
    expect(findingsPerEncounter[1]).toEqual(findingsPerEncounter[0])
  })

  it('lists what has been examined in time order, records the practitioner, and survives a workspace restart', async () => {
    const encounter = await startEncounter()
    const lungs = ((await (await examine(encounter.encounterId, 'lungs')).json()) as PhysicalExaminationResponse).examination
    const vitals = ((await (await examine(encounter.encounterId, 'vitals')).json()) as PhysicalExaminationResponse).examination

    const listResponse = await api(`/api/encounters/${encounter.encounterId}/physical-examinations`)
    const listBody = await listResponse.text()
    expectNoCaseTruth('examinations', listBody, [caseTruthExamination.lungs, caseTruthExamination.vitals])
    expect(JSON.parse(listBody)).toEqual({ examinations: [lungs, vitals] })

    await evictDurableObject(env.CLINIC_WORKSPACE.getByName('default'))
    expect(await examinations(encounter.encounterId)).toEqual([lungs, vitals])

    const { auditEvents } = (await (await api(`/api/encounters/${encounter.encounterId}/audit-events`)).json()) as AuditEventsResponse
    expect(auditEvents.slice(1)).toEqual([
      { eventType: 'physical-examination-performed', practitionerId: PRACTITIONER_ID, occurredAt: lungs.examinedAt },
      { eventType: 'physical-examination-performed', practitionerId: PRACTITIONER_ID, occurredAt: vitals.examinedAt },
    ])
  })

  it('examines each body system once per Encounter, even when two requests race', async () => {
    const encounter = await startEncounter()
    const [first, second] = await Promise.all([examine(encounter.encounterId, 'heart'), examine(encounter.encounterId, 'heart')])
    expect([first.status, second.status].sort()).toEqual([201, 409])
    const listed = await examinations(encounter.encounterId)

    const again = await examine(encounter.encounterId, 'heart')
    expect(again.status).toBe(409)
    const { error } = (await again.json()) as ErrorResponse
    expect(error).toEqual({ code: 'body-system-already-examined', message: '本次就诊已查过心脏，每个部位只查一次。' })
    expect(await examinations(encounter.encounterId)).toEqual(listed)
    expect(listed).toHaveLength(1)
  })

  it('keeps the triage reading on the Encounter after the vitals examination', async () => {
    const encounter = await startEncounter()
    await examine(encounter.encounterId, 'vitals')
    const after = ((await (await api(`/api/encounters/${encounter.encounterId}`)).json()) as EncounterResponse).encounter
    expect(after).toEqual(encounter)
    expect(after.triage).toEqual(goldenCase1Chart.triage)
  })

  it('refuses an unknown body system and an unknown Encounter', async () => {
    const encounter = await startEncounter()
    for (const system of [undefined, 'liver', 7]) {
      const response = await examine(encounter.encounterId, system)
      expect(response.status).toBe(400)
      expect(((await response.json()) as ErrorResponse).error.code).toBe('invalid-request')
    }
    for (const response of [await examine('no-such-encounter', 'vitals'), await api('/api/encounters/no-such-encounter/physical-examinations')]) {
      expect(response.status).toBe(404)
      expect(((await response.json()) as ErrorResponse).error.code).toBe('encounter-not-found')
    }
    expect(await examinations(encounter.encounterId)).toEqual([])
  })

  it('refuses with case-version-retired, writing nothing, when the Encounter’s Golden Case version is no longer in the pack', async () => {
    for (const [column, value] of [
      ['case_version', '2026-01-01.0'],
      ['case_id', 'golden-case-retired'],
    ] as const) {
      const encounter = await startEncounter()
      await runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
        state.storage.sql.exec(`UPDATE encounter SET ${column} = ? WHERE encounter_id = ?`, value, encounter.encounterId)
      })

      const response = await examine(encounter.encounterId, 'vitals')
      expect(response.status, column).toBe(409)
      const body = await response.text()
      expectNoCaseTruth(`retired ${column}`, body)
      const { error } = JSON.parse(body) as ErrorResponse
      expect(error.code, column).toBe('case-version-retired')
      expect(error.message, column).toContain('无法继续揭示病例真值')

      expect(await examinations(encounter.encounterId)).toEqual([])
      const { auditEvents } = (await (await api(`/api/encounters/${encounter.encounterId}/audit-events`)).json()) as AuditEventsResponse
      expect(auditEvents.map((e) => e.eventType)).toEqual(['encounter-started'])
      await post(`/api/encounters/${encounter.encounterId}/abandonment`)
    }
  })

  it('rejects a second row for the same body system in storage even if a command skipped the check', async () => {
    const encounter = await startEncounter()
    await examine(encounter.encounterId, 'general')
    await runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
      const insertAgain = () =>
        state.storage.sql.exec(
          `INSERT INTO physical_examination (encounter_id, body_system, finding, practitioner_id, examined_at)
           VALUES (?, 'general', 'x', 'demo-practitioner', '2026-11-24T00:00:00Z')`,
          encounter.encounterId,
        )
      expect(insertAgain).toThrow(/UNIQUE|PRIMARY/)
    })
  })
})
