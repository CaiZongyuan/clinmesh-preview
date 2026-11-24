import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { EncounterResponse } from '../../src/shared/encounter'
import { app } from '../../src/worker/app'
import { goldenCase1Chart } from '../fixtures/golden-case-1'
import { expectNoCaseTruth, goldenCaseDenylists } from './case-truth'

interface ProbeContext {
  caseId: string
  encounterId: string
}

const request = (method: string, path: string, body?: unknown) =>
  exports.default.fetch(`http://clinmesh.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// One probe per route of the Hono app; a route without a probe fails the first test below.
// WebSocket upgrades must also be routed through the Hono app so they show up in `app.routes`
// and get a probe here. The Encounter Abandonment probe stays last because it ends the active Encounter.
const probes: Record<string, (ctx: ProbeContext) => Promise<Response>> = {
  'GET /api/golden-cases': () => request('GET', '/api/golden-cases'),
  'POST /api/encounters': ({ caseId }) => request('POST', '/api/encounters', { caseId }),
  'GET /api/encounters/active': () => request('GET', '/api/encounters/active'),
  'GET /api/encounters/:encounterId': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}`),
  'GET /api/encounters/:encounterId/audit-events': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/audit-events`),
  'POST /api/encounters/:encounterId/abandonment': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/abandonment`),
}

async function probeEveryRoute(ctx: ProbeContext, phase: string) {
  for (const [route, probe] of Object.entries(probes)) {
    const response = await probe(ctx)
    expect(response.status, `${phase}: ${route}`).toBeLessThan(500)
    expectNoCaseTruth(`${phase}: ${route}`, await response.text())
  }
}

const caughtLeak = (body: string) => {
  try {
    expectNoCaseTruth('mutation', body)
    return false
  } catch {
    return true
  }
}

describe('Case Truth denylist', () => {
  const [goldenCase1] = goldenCaseDenylists

  it('is built from the snapshot and catches fragments, hidden values in text and diagnosis words', () => {
    expect(goldenCase1.fragments).toEqual(
      expect.arrayContaining(['社区获得性肺炎', '右下肺呼吸音减低', '门诊治疗，72 小时复诊', casePack.cases[0].textResults[0].impression]),
    )
    expect(goldenCase1.numbers).toEqual(expect.arrayContaining([14.2, 86, 38.6, 102, 138]))

    for (const leak of [
      '{"reply":"医生说右下肺呼吸音减低"}',
      '{"reply":"WBC 14.2，偏高"}',
      '{"reply":"疑似肺炎"}',
      '{"reply":"Looks like PNEUMONIA"}',
      '{"value":14.2}',
      '{"exam":"T 38.6℃"}',
    ]) {
      expect(caughtLeak(leak), leak).toBe(true)
    }
  })

  it('lets everything the doctor may see through, including ids and timestamps that contain the same digits', () => {
    expect(caughtLeak(JSON.stringify({ ...goldenCase1Chart, encounterId: 'a142c0de-8614-4236-9102-3814c2a86f00' }))).toBe(false)
    expect(caughtLeak('{"startedAt":"2026-11-24T08:14:02.142Z","path":"/api/encounters/86-14.2x"}')).toBe(false)
    expect(caughtLeak('{"error":"患者超过 30 秒未回答，请重试"}')).toBe(false)
  })
})

describe('Golden Case snapshot', () => {
  // Triage is measured before the doctor examines the patient; reusing the examination's readings would show
  // Case Truth in the banner, and the denylist cannot see it because it drops values the snapshot shows anyway.
  it('records triage vitals that differ from the vitals the Physical Examination reveals', () => {
    for (const goldenCase of casePack.cases) {
      const v = goldenCase.triage.vitals
      const triage = [v.temperatureCelsius, v.pulseBpm, v.respiratoryRatePerMin, v.systolicMmHg, v.diastolicMmHg, v.spo2Percent]
      const examination = [...goldenCase.physicalExamination.vitals.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
      expect(examination.slice(0, 6), goldenCase.id).not.toEqual(triage)
    }
  })
})

describe('Case Truth isolation over HTTP', () => {
  it('has a probe for every route the Worker serves', () => {
    const served = app.routes.filter((route) => route.method !== 'ALL').map((route) => `${route.method} ${route.path}`)
    expect(new Set(served)).toEqual(new Set(Object.keys(probes)))
  })

  it('exposes no Case Truth on any route while the Encounter is active, nor after Encounter Abandonment', async () => {
    const caseId = casePack.cases[0].id
    const started = await request('POST', '/api/encounters', { caseId })
    expect(started.status).toBe(201)
    const startedBody = await started.text()
    expectNoCaseTruth('start', startedBody)
    const { encounterId } = (JSON.parse(startedBody) as EncounterResponse).encounter

    await probeEveryRoute({ caseId, encounterId }, 'active Encounter')

    const after = (await (await request('GET', `/api/encounters/${encounterId}`)).json()) as EncounterResponse
    expect(after.encounter.status).toBe('abandoned')
    await probeEveryRoute({ caseId, encounterId }, 'abandoned Encounter')
  })
})
