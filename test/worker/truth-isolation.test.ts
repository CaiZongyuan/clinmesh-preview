import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { EncounterResponse } from '../../src/shared/encounter'
import { app } from '../../src/worker/app'

type GoldenCase = (typeof casePack.cases)[number]

const CASE_TRUTH_FIELDS = [
  'title',
  'titleEn',
  'indexConditions',
  'physicalExamination',
  'laboratories',
  'textResults',
  'reportAmendments',
  'debriefReference',
] as const satisfies readonly (keyof GoldenCase)[]

// Which catalog item a result belongs to is not Case Truth; the result is.
const CATALOG_IDENTITY_KEYS = new Set(['id', 'catalogItem', 'codings', 'system', 'version', 'unit', 'unitDisplay', 'referenceRange'])

function leaves(value: unknown, skipKeys = new Set<string>()): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, skipKeys))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => (skipKeys.has(key) ? [] : leaves(item, skipKeys)))
  }
  return [value]
}

// The denylist is the snapshot's Case Truth minus anything the snapshot also shows the doctor.
function caseTruthDenylist(goldenCase: GoldenCase) {
  const truth = leaves(CASE_TRUTH_FIELDS.map((field) => goldenCase[field]), CATALOG_IDENTITY_KEYS)
  const visibleFields = Object.keys(goldenCase).filter((field) => !(CASE_TRUTH_FIELDS as readonly string[]).includes(field))
  const visible = new Set(leaves(visibleFields.map((field) => goldenCase[field as keyof GoldenCase])))
  return {
    terms: truth.filter((v): v is string => typeof v === 'string' && v.length >= 2 && !visible.has(v)),
    numbers: truth.filter((v): v is number => typeof v === 'number' && !visible.has(v)),
  }
}

const denylist = casePack.cases.map(caseTruthDenylist)
const truthTerms = [...new Set(denylist.flatMap((d) => d.terms))]
const truthNumbers = new Set(denylist.flatMap((d) => d.numbers))

function expectNoCaseTruth(route: string, body: string) {
  for (const term of truthTerms) {
    expect(body, `${route} exposes Case Truth "${term}"`).not.toContain(term)
  }
  expect(body, `${route} exposes a diagnosis-revealing id`).not.toMatch(/(^|[^a-z])cap([^a-z]|$)/i)
  const numbers = leaves(JSON.parse(body)).filter((v) => typeof v === 'number')
  for (const n of numbers) {
    expect(truthNumbers.has(n as number), `${route} exposes the hidden result value ${n}`).toBe(false)
  }
}

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
// WebSocket routes join this table when they exist. The Encounter Abandonment probe stays last
// because it is what ends the active Encounter.
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

describe('Case Truth isolation over HTTP', () => {
  it('has a probe for every route the Worker serves', () => {
    const served = app.routes.filter((route) => route.method !== 'ALL').map((route) => `${route.method} ${route.path}`)
    expect(new Set(served)).toEqual(new Set(Object.keys(probes)))
  })

  it('builds a non-trivial denylist from the snapshot', () => {
    expect(truthTerms).toEqual(expect.arrayContaining(['J18.9', '社区获得性肺炎', '右下叶；CURB-65 0 分（尿素未测），可门诊治疗。']))
    expect(truthTerms).toContain(casePack.cases[0].debriefReference.disposition)
    expect(truthTerms).toContain(casePack.cases[0].physicalExamination.lungs)
    expect(truthTerms).toContain(casePack.cases[0].textResults[0].impression)
    expect(truthNumbers).toContain(14.2)
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
