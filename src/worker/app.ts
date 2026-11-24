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

const WORKSPACE_NAME = 'default'

const ERROR_STATUS: Record<EncounterErrorCode, ContentfulStatusCode> = {
  'invalid-request': 400,
  'golden-case-not-found': 404,
  'encounter-not-found': 404,
  'active-encounter-exists': 409,
  'encounter-not-active': 409,
  'body-system-already-examined': 409,
}

type AppContext = Context<{ Bindings: Env }>

const workspace = (c: AppContext) => c.env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME)
const refuse = (c: AppContext, error: EncounterError) => c.json<ErrorResponse>({ error }, ERROR_STATUS[error.code])

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
