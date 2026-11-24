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
  // Case Truth the probes have legitimately uncovered so far, which later responses may repeat.
  revealed: unknown[]
}

const request = (method: string, path: string, body?: unknown) =>
  exports.default.fetch(`http://clinmesh.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// One probe per route of the Hono app; a route without a probe fails the first test below.
// WebSocket upgrades must also be routed through the Hono app so they show up in `app.routes`
// and get a probe here. A probe that uncovers Case Truth through a compliant action records it in `revealed`.
// The Encounter Abandonment probe stays last because it ends the active Encounter.
const probes: Record<string, (ctx: ProbeContext) => Promise<Response>> = {
  'GET /api/golden-cases': () => request('GET', '/api/golden-cases'),
  'POST /api/encounters': ({ caseId }) => request('POST', '/api/encounters', { caseId }),
  'GET /api/encounters/active': () => request('GET', '/api/encounters/active'),
  'GET /api/encounters/:encounterId': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}`),
  'GET /api/encounters/:encounterId/audit-events': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/audit-events`),
  'POST /api/encounters/:encounterId/physical-examinations': async ({ encounterId, revealed }) => {
    const response = await request('POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' })
    if (response.ok) revealed.push(casePack.cases[0].physicalExamination.vitals)
    return response
  },
  'GET /api/encounters/:encounterId/physical-examinations': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/physical-examinations`),
  'POST /api/encounters/:encounterId/abandonment': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/abandonment`),
}

async function probeEveryRoute(ctx: ProbeContext, phase: string) {
  for (const [route, probe] of Object.entries(probes)) {
    const response = await probe(ctx)
    expect(response.status, `${phase}: ${route}`).toBeLessThan(500)
    expectNoCaseTruth(`${phase}: ${route}`, await response.text(), ctx.revealed)
  }
}

const caughtLeak = (body: string, revealed: unknown[] = []) => {
  try {
    expectNoCaseTruth('mutation', body, revealed)
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
      '{"spo2":94}',
      '{"value":"94"}',
      '{"followUpHours":72}',
      '{"value":" 72 "}',
    ]) {
      expect(caughtLeak(leak), leak).toBe(true)
    }
  })

  it('lets everything the doctor may see through, including ids and timestamps that contain the same digits', () => {
    expect(caughtLeak(JSON.stringify({ ...goldenCase1Chart, encounterId: 'a142c0de-8614-4236-9102-3814c2a86f00' }))).toBe(false)
    expect(caughtLeak('{"startedAt":"2026-11-24T08:14:02.142Z","path":"/api/encounters/86-14.2x"}')).toBe(false)
    expect(caughtLeak('{"error":"患者超过 30 秒未回答，请重试"}')).toBe(false)
    expect(caughtLeak('{"queueNumber":7,"age":58,"note":"72 小时内请勿重复提交"}')).toBe(false)
  })

  it('skips numbers under structural keys such as sequence, usage, durations and age, and only those', () => {
    for (const body of ['{"usage":{"in":30,"out":72}}', '{"seq":22}', '{"turn":{"index":94,"durationMs":84}}', '{"age":58,"version":"94"}']) {
      expect(caughtLeak(body), body).toBe(false)
    }
    for (const body of ['{"spo2":94}', '{"usage":{"in":30},"reading":"94"}', '{"seq":1,"text":"SpO₂ 94"}']) {
      expect(caughtLeak(body), body).toBe(true)
    }
  })

  it('lets through Case Truth the doctor has revealed, and only that', () => {
    const { lungs, heart } = casePack.cases[0].physicalExamination
    expect(caughtLeak(JSON.stringify({ finding: lungs }), [lungs])).toBe(false)
    expect(caughtLeak(JSON.stringify({ finding: lungs }))).toBe(true)
    expect(caughtLeak(JSON.stringify({ finding: heart }), [lungs])).toBe(true)
    expect(caughtLeak(JSON.stringify({ finding: lungs, extra: 'WBC 14.2' }), [lungs])).toBe(true)
  })
})

describe('Golden Case snapshot', () => {
  // Readings a case may legitimately share between triage and the vitals Physical Examination.
  const SAME_AT_TRIAGE_AND_EXAMINATION: Record<string, readonly string[]> = {
    'golden-case-01': [],
  }

  // Triage is measured before the doctor examines the patient; reusing an examination reading would show
  // Case Truth in the banner, and the denylist cannot see it because it drops values the snapshot shows anyway.
  it('records triage vitals that differ, reading by reading, from the vitals the Physical Examination reveals', () => {
    for (const goldenCase of casePack.cases) {
      const triage: Record<string, number> = goldenCase.triage.vitals
      const examination: Record<string, number | string> = goldenCase.physicalExamination.vitals
      const same = Object.keys(triage).filter((reading) => triage[reading] === examination[reading])
      expect(Object.keys(triage).every((reading) => reading in examination), goldenCase.id).toBe(true)
      expect(same, goldenCase.id).toEqual(SAME_AT_TRIAGE_AND_EXAMINATION[goldenCase.id] ?? [])
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

    const ctx: ProbeContext = { caseId, encounterId, revealed: [] }
    await probeEveryRoute(ctx, 'active Encounter')
    expect(ctx.revealed, 'the Physical Examination probe examined the vitals').toHaveLength(1)

    const after = (await (await request('GET', `/api/encounters/${encounterId}`)).json()) as EncounterResponse
    expect(after.encounter.status).toBe('abandoned')
    await probeEveryRoute(ctx, 'abandoned Encounter')
  })
})
