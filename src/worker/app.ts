import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type {
  ActiveEncounterResponse,
  AuditEventsResponse,
  EncounterError,
  EncounterErrorCode,
  EncounterResponse,
  ErrorResponse,
} from '../shared/encounter'
import type { GoldenCaseQueueResponse } from '../shared/golden-case-queue'
import {
  BODY_SYSTEMS,
  isBodySystem,
  type PhysicalExaminationResponse,
  type PhysicalExaminationsResponse,
} from '../shared/physical-examination'
import type { InvestigationCatalogResponse, InvestigationsResponse } from '../shared/investigation'
import type { InvestigationsResult } from './investigation-repository'

const WORKSPACE_NAME = 'default'

const ERROR_STATUS: Record<EncounterErrorCode, ContentfulStatusCode> = {
  'invalid-request': 400,
  'golden-case-not-found': 404,
  'encounter-not-found': 404,
  'active-encounter-exists': 409,
  'encounter-not-active': 409,
  'body-system-already-examined': 409,
  'case-version-retired': 409,
  'catalog-item-not-found': 404,
  'investigation-already-issued': 409,
  'investigation-not-found': 404,
  'report-not-found': 404,
  'report-superseded': 409,
  'report-already-acknowledged': 409,
}

type AppContext = Context<{ Bindings: Env }>

const workspace = (c: AppContext) => c.env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME)
const refuse = (c: AppContext, error: EncounterError) => c.json<ErrorResponse>({ error }, ERROR_STATUS[error.code])
const investigationsOr = (c: AppContext, result: InvestigationsResult, status: ContentfulStatusCode = 200) =>
  result.ok ? c.json<InvestigationsResponse>({ investigations: result.investigations }, status) : refuse(c, result.error)

// A non-empty list of distinct ids under `key`, or null.
async function idList(c: AppContext, key: string): Promise<string[] | null> {
  const body: unknown = await c.req.json().catch(() => null)
  const ids = (body as Record<string, unknown> | null)?.[key]
  const valid = Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length
  return valid ? (ids as string[]) : null
}

export const app = new Hono<{ Bindings: Env }>().basePath('/api')

app.get('/golden-cases', async (c) => {
  const goldenCases = await workspace(c).listGoldenCaseQueue()
  return c.json<GoldenCaseQueueResponse>({ goldenCases })
})

app.post('/encounters', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  const caseId = (body as { caseId?: unknown } | null)?.caseId
  if (typeof caseId !== 'string') {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "caseId": string }' })
  }
  const result = await workspace(c).startEncounter(caseId)
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }, 201) : refuse(c, result.error)
})

app.get('/encounters/active', async (c) => {
  const encounter = await workspace(c).getActiveEncounter()
  return c.json<ActiveEncounterResponse>({ encounter })
})

app.get('/encounters/:encounterId', async (c) => {
  const result = await workspace(c).getEncounter(c.req.param('encounterId'))
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/audit-events', async (c) => {
  const result = await workspace(c).listAuditEvents(c.req.param('encounterId'))
  return result.ok ? c.json<AuditEventsResponse>({ auditEvents: result.auditEvents }) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/abandonment', async (c) => {
  const result = await workspace(c).abandonEncounter(c.req.param('encounterId'))
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/physical-examinations', async (c) => {
  const result = await workspace(c).listPhysicalExaminations(c.req.param('encounterId'))
  return result.ok
    ? c.json<PhysicalExaminationsResponse>({ examinations: result.examinations })
    : refuse(c, result.error)
})

app.post('/encounters/:encounterId/physical-examinations', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  const system = (body as { system?: unknown } | null)?.system
  if (!isBodySystem(system)) {
    return refuse(c, { code: 'invalid-request', message: `请求体须为 { "system": ${BODY_SYSTEMS.map((s) => `"${s}"`).join(' | ')} }` })
  }
  const result = await workspace(c).performPhysicalExamination(c.req.param('encounterId'), system)
  return result.ok
    ? c.json<PhysicalExaminationResponse>({ examination: result.examination }, 201)
    : refuse(c, result.error)
})

app.get('/investigation-catalog', async (c) => c.json<InvestigationCatalogResponse>(await workspace(c).investigationCatalog()))

app.get('/encounters/:encounterId/investigations', async (c) =>
  investigationsOr(c, await workspace(c).listInvestigations(c.req.param('encounterId'))),
)

app.post('/encounters/:encounterId/investigations', async (c) => {
  const catalogItemIds = await idList(c, 'catalogItemIds')
  if (!catalogItemIds) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "catalogItemIds": string[] }，且不重复、不为空' })
  }
  return investigationsOr(c, await workspace(c).issueInvestigations(c.req.param('encounterId'), catalogItemIds), 201)
})

app.post('/encounters/:encounterId/investigations/:investigationId/instant-release', async (c) =>
  investigationsOr(c, await workspace(c).releaseInvestigationNow(c.req.param('encounterId'), c.req.param('investigationId'))),
)

app.post('/encounters/:encounterId/report-acknowledgements', async (c) => {
  const reportIds = await idList(c, 'reportIds')
  if (!reportIds) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "reportIds": string[] }，且不重复、不为空' })
  }
  return investigationsOr(c, await workspace(c).acknowledgeReports(c.req.param('encounterId'), reportIds))
})
