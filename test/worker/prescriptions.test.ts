import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import { allergyTagFor, type MedicationCatalogResponse, type PrescriptionsResponse } from '../../src/shared/medication'
import rawCatalog from '../../data/clinic-catalog/medication-catalog.json'

const T0 = Date.parse('2026-11-25T01:00:00.000Z')

const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)
const post = (path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const line = (drugId: string, overrides: Record<string, unknown> = {}) => ({
  drugId,
  dose: 1,
  route: '口服',
  frequency: 'BID',
  days: 7,
  ...overrides,
})

async function startEncounter(): Promise<string> {
  const response = await post('/api/encounters', { caseId: 'golden-case-01' })
  expect(response.status).toBe(201)
  return ((await response.json()) as EncounterResponse).encounter.encounterId
}

async function confirmDiagnosis(encounterId: string) {
  const response = await post(`/api/encounters/${encounterId}/diagnosis/revisions`, {
    entries: [
      { code: 'J06.9', primary: true, source: 'doctor' },
      { code: 'R50.9', primary: false, source: 'doctor' },
    ],
  })
  expect(response.status).toBe(201)
}

async function prescriptions(encounterId: string): Promise<PrescriptionsResponse['prescriptions']> {
  const response = await api(`/api/encounters/${encounterId}/prescriptions`)
  expect(response.status).toBe(200)
  return ((await response.json()) as PrescriptionsResponse).prescriptions
}

async function audit(encounterId: string): Promise<AuditEventsResponse['auditEvents']> {
  const response = await api(`/api/encounters/${encounterId}/audit-events`)
  return ((await response.json()) as AuditEventsResponse).auditEvents
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorResponse).error.code
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('medication catalog', () => {
  it('lists the formulary with the prototype content, its package and insert summary', async () => {
    const response = await api('/api/medication-catalog')
    expect(response.status).toBe(200)
    const body = (await response.json()) as MedicationCatalogResponse
    expect(body.catalogVersion).toBe(rawCatalog.version)
    expect(body.items.map((item) => item.id)).toEqual(rawCatalog.items.map((item) => (item as { id: string }).id))
    const amoxicillin = body.items.find((item) => item.id === 'amoxicillin')!
    expect(amoxicillin.name).toBe('阿莫西林胶囊')
    expect(amoxicillin.drugClassName).toBe('青霉素类')
    expect(amoxicillin.defaults).toEqual({ dose: 2, route: '口服', frequency: 'TID', days: 7 })
    expect(amoxicillin.insert).toEqual({
      indications: '敏感菌所致呼吸道、泌尿道感染等。',
      contraindications: '青霉素类药物过敏史或青霉素皮肤试验阳性患者禁用。',
      notes: '用药前须询问过敏史并按规定做皮试。',
      source: '药品说明书摘要（合成）',
    })
  })

  it('tags drugs by drug class, independent of drug codes', () => {
    const classes = ['penicillin']
    expect(allergyTagFor({ drugClass: 'penicillin' }, classes)).toBe('conflict')
    expect(allergyTagFor({ drugClass: 'cephalosporin' }, classes)).toBe('cross-allergy')
    expect(allergyTagFor({ drugClass: 'quinolone' }, classes)).toBeNull()
    expect(allergyTagFor({ drugClass: 'penicillin' }, [])).toBeNull()
  })
})

describe('issuing prescriptions', () => {
  it('refuses any prescription before a Diagnosis is confirmed and writes nothing', async () => {
    const encounterId = await startEncounter()
    const response = await post(`/api/encounters/${encounterId}/prescriptions`, { lines: [line('doxycycline')] })
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('diagnosis-not-confirmed')
    expect((await prescriptions(encounterId)).lines).toEqual([])
  })

  it('hard-refuses the whole prescription for a penicillin-class line, with no override path and nothing written', async () => {
    const encounterId = await startEncounter()
    await confirmDiagnosis(encounterId)
    for (const body of [
      { lines: [line('amoxicillin')] },
      // Even a mixed prescription is refused whole: the red line is not per-line.
      { lines: [line('doxycycline'), line('amoxiclav')] },
      { lines: [line('amoxicillin', { override: { reason: '患者知情同意', note: '已充分告知' } })] },
    ]) {
      const response = await post(`/api/encounters/${encounterId}/prescriptions`, body)
      expect(response.status).toBe(409)
      const error = (await response.json()) as ErrorResponse
      expect(error.error.code).toBe('MEDICATION_ALLERGY_CONFLICT')
      expect(error.error.message).toContain('药事安全红线拦截（不可越权）')
    }
    expect((await prescriptions(encounterId)).lines).toEqual([])
    expect((await audit(encounterId)).map((e) => e.eventType)).not.toContain('prescription-issued')
  })

  it('issues a cephalosporin only with a reason from the fixed list and a note of at least four characters', async () => {
    const encounterId = await startEncounter()
    await confirmDiagnosis(encounterId)
    const refused: unknown[] = [
      { lines: [line('cefuroxime')] },
      { lines: [line('cefuroxime', { override: { reason: '自己觉得可以', note: '已充分告知患者' } })] },
      { lines: [line('cefuroxime', { override: { reason: '患者知情同意', note: '已知' } })] },
    ]
    for (const body of refused) {
      const response = await post(`/api/encounters/${encounterId}/prescriptions`, body)
      expect(response.status).toBe(422)
      expect(await errorCode(response)).toBe('medication-override-required')
    }
    expect((await prescriptions(encounterId)).lines).toEqual([])

    const accepted = await post(`/api/encounters/${encounterId}/prescriptions`, {
      lines: [line('cefuroxime', { override: { reason: '已完成皮试或过敏评估', note: '青霉素皮试阴性' } })],
    })
    expect(accepted.status).toBe(201)
    const [issued] = (await prescriptions(encounterId)).lines
    expect(issued).toMatchObject({
      drugId: 'cefuroxime',
      name: '头孢呋辛酯片',
      dose: 1,
      doseUnit: '片',
      route: '口服',
      frequency: 'BID',
      days: 7,
      totalQuantity: '14 片',
      drugClassName: '头孢菌素类',
      overrideReason: '已完成皮试或过敏评估',
      overrideNote: '青霉素皮试阴性',
    })
    const events = await audit(encounterId)
    const prescriptionAudit = events.filter((e) => e.eventType === 'prescription-issued')
    expect(prescriptionAudit).toHaveLength(1)
    expect(prescriptionAudit[0].subject).toContain('已完成皮试或过敏评估')
    expect(prescriptionAudit[0].subject).toContain('青霉素皮试阴性')
  })

  it('issues a safe drug with the server-computed total quantity, in whole packages when units differ', async () => {
    const encounterId = await startEncounter()
    await confirmDiagnosis(encounterId)
    const response = await post(`/api/encounters/${encounterId}/prescriptions`, {
      lines: [
        line('doxycycline'),
        line('ambroxol', { dose: 10, frequency: 'TID', days: 5 }),
        line('acetaminophen', { frequency: 'PRN', days: 3 }),
      ],
    })
    expect(response.status).toBe(201)
    const lines = (await prescriptions(encounterId)).lines
    expect(Object.fromEntries(lines.map((l) => [l.drugId, l.totalQuantity]))).toEqual({
      doxycycline: '14 片',
      ambroxol: '2 瓶',
      acetaminophen: '9 片',
    })
    expect(lines.every((l) => l.practitionerId === 'demo-practitioner')).toBe(true)
  })

  it('refuses malformed lines and unknown drugs', async () => {
    const encounterId = await startEncounter()
    await confirmDiagnosis(encounterId)
    for (const body of [
      { lines: [] },
      { lines: [line('doxycycline'), line('doxycycline')] },
      { lines: [line('doxycycline', { dose: 0 })] },
      { lines: [line('doxycycline', { days: 31 })] },
      { lines: [line('drug-not-in-formulary')] },
    ]) {
      const response = await post(`/api/encounters/${encounterId}/prescriptions`, body)
      expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
      expect((await prescriptions(encounterId)).lines).toEqual([])
    }
  })

  it('makes No Medication and prescriptions mutually exclusive in both directions', async () => {
    const first = await startEncounter()
    await confirmDiagnosis(first)
    expect((await post(`/api/encounters/${first}/no-medication`)).status).toBe(201)
    expect(await errorCode(await post(`/api/encounters/${first}/prescriptions`, { lines: [line('doxycycline')] }))).toBe(
      'no-medication-conflict',
    )
    expect((await prescriptions(first)).lines).toEqual([])
    expect((await audit(first)).map((e) => e.eventType)).toContain('no-medication-recorded')

    // A fresh Encounter (the first is abandoned): prescriptions refuse No Medication the other way.
    await post(`/api/encounters/${first}/abandonment`)
    const second = await startEncounter()
    await confirmDiagnosis(second)
    expect((await post(`/api/encounters/${second}/prescriptions`, { lines: [line('doxycycline')] })).status).toBe(201)
    expect(await errorCode(await post(`/api/encounters/${second}/no-medication`))).toBe('no-medication-conflict')
  })

  it('refuses No Medication before a Diagnosis is confirmed', async () => {
    const encounterId = await startEncounter()
    const response = await post(`/api/encounters/${encounterId}/no-medication`)
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('diagnosis-not-confirmed')
    expect((await prescriptions(encounterId)).noMedication).toBeNull()
  })

  it('refuses every prescription command on a frozen Encounter', async () => {
    const encounterId = await startEncounter()
    await confirmDiagnosis(encounterId)
    expect((await post(`/api/encounters/${encounterId}/prescriptions`, { lines: [line('doxycycline')] })).status).toBe(201)
    await post(`/api/encounters/${encounterId}/abandonment`)
    const frozen = await prescriptions(encounterId)
    for (const path of ['/prescriptions', '/no-medication']) {
      const response = await post(`/api/encounters/${encounterId}${path}`, { lines: [line('doxycycline')] })
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('encounter-not-active')
    }
    expect(await prescriptions(encounterId)).toEqual(frozen)
  })
})

describe('Diagnosis revision interplay', () => {
  it('keeps issued lines valid when the Diagnosis is reopened, and records issuance in the audit trail', async () => {
    const encounterId = await startEncounter()
    await confirmDiagnosis(encounterId)
    expect((await post(`/api/encounters/${encounterId}/prescriptions`, { lines: [line('doxycycline')] })).status).toBe(201)
    await post(`/api/encounters/${encounterId}/diagnosis/reopen`)
    expect((await prescriptions(encounterId)).lines).toHaveLength(1)
    const events = await audit(encounterId)
    expect(events.find((e) => e.eventType === 'prescription-issued')?.subject).toBe('doxycycline')
  })
})
