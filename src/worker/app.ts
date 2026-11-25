import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  MAX_MENTIONS,
  MAX_PROMPT_LENGTH,
  type CopilotConfigRequest,
  type CopilotFeedback,
  type CopilotModelSetting,
  type CopilotMention,
  type CopilotPromptRequest,
  type CopilotPromptResponse,
  type CopilotResendRequest,
  type CopilotSnapshot,
} from '../shared/copilot-turn'
import type { AskPatientResponse, ConsultationResponse, RetryPatientTurnResponse } from '../shared/consultation'
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
import {
  isNoteSection,
  MAX_NOTE_SECTION_LENGTH,
  NOTE_SECTIONS,
  type ClinicalNoteResponse,
  type NoteSections,
} from '../shared/clinical-note'
import type { ClinicalNoteResult } from './clinical-note-repository'
import { diagnosisEntries, type DiagnosisResult } from './diagnosis-repository'
import type { DiagnosisResponse } from '../shared/diagnosis'
import type {
  MedicationCatalogResponse,
  PrescriptionsResponse,
  PrescriptionLineRequest,
} from '../shared/medication'
import { prescriptionLines, type PrescriptionsResult } from './prescription-repository'
import { medicationCatalog } from './medication-catalog'

import { WORKSPACE_NAME } from './workspace-name'

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
  'investigation-cancelled': 409,
  'investigation-already-reported': 409,
  'report-not-found': 404,
  'report-superseded': 409,
  'report-already-acknowledged': 409,
  'consultation-turn-not-found': 404,
  'patient-turn-pending': 409,
  'patient-turn-not-retryable': 409,
  'clinical-note-incomplete': 422,
  'diagnosis-needs-primary': 422,
  'diagnosis-not-confirmed': 409,
  MEDICATION_ALLERGY_CONFLICT: 409,
  'medication-override-required': 422,
  'no-medication-conflict': 409,
  'copilot-busy': 409,
  'copilot-turn-not-found': 404,
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

const noteOr = (c: AppContext, result: ClinicalNoteResult, status: ContentfulStatusCode = 200) =>
  result.ok ? c.json<ClinicalNoteResponse>({ note: result.note }, status) : refuse(c, result.error)

// Section texts under `sections`: every section when `all`, otherwise at least one; null when malformed.
async function noteSections(c: AppContext, all: boolean): Promise<Partial<NoteSections> | null> {
  const body: unknown = await c.req.json().catch(() => null)
  const sections = (body as Record<string, unknown> | null)?.sections
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) return null
  const entries = Object.entries(sections)
  const valid =
    entries.length > 0 &&
    (!all || entries.length === NOTE_SECTIONS.length) &&
    entries.every(([section, text]) => isNoteSection(section) && typeof text === 'string' && text.length <= MAX_NOTE_SECTION_LENGTH)
  return valid ? (sections as Partial<NoteSections>) : null
}

const noteShape = (which: string) =>
  `请求体须为 { "sections": { [section]: string } }，含${which}段落（${NOTE_SECTIONS.join('、')}），每段不超过 ${MAX_NOTE_SECTION_LENGTH} 字`

const diagnosisOr = (c: AppContext, result: DiagnosisResult, status: ContentfulStatusCode = 200) =>
  result.ok ? c.json<DiagnosisResponse>({ diagnosis: result.diagnosis }, status) : refuse(c, result.error)

const prescriptionsOr = (c: AppContext, result: PrescriptionsResult, status: ContentfulStatusCode = 200) =>
  result.ok ? c.json<PrescriptionsResponse>({ prescriptions: result.prescriptions }, status) : refuse(c, result.error)

// Line list under `lines` in the body, or null when malformed.
async function prescriptionRequest(c: AppContext): Promise<PrescriptionLineRequest[] | null> {
  const body: unknown = await c.req.json().catch(() => null)
  const lines = (body as Record<string, unknown> | null)?.lines
  return lines === undefined ? null : prescriptionLines(lines)
}

// Entry list under `entries` in the body, or null when malformed.
async function diagnosisDraftEntries(c: AppContext): Promise<ReturnType<typeof diagnosisEntries> | null> {
  const body: unknown = await c.req.json().catch(() => null)
  const entries = (body as Record<string, unknown> | null)?.entries
  return entries === undefined ? null : diagnosisEntries(entries)
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

app.post('/encounters/:encounterId/investigations/:investigationId/cancellation', async (c) =>
  investigationsOr(c, await workspace(c).cancelInvestigation(c.req.param('encounterId'), c.req.param('investigationId'))),
)

app.post('/encounters/:encounterId/report-acknowledgements', async (c) => {
  const reportIds = await idList(c, 'reportIds')
  if (!reportIds) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "reportIds": string[] }，且不重复、不为空' })
  }
  return investigationsOr(c, await workspace(c).acknowledgeReports(c.req.param('encounterId'), reportIds))
})

app.get('/encounters/:encounterId/clinical-note', async (c) => noteOr(c, await workspace(c).getClinicalNote(c.req.param('encounterId'))))

app.patch('/encounters/:encounterId/clinical-note/draft', async (c) => {
  const sections = await noteSections(c, false)
  if (!sections) return refuse(c, { code: 'invalid-request', message: noteShape('至少一个') })
  return noteOr(c, await workspace(c).saveClinicalNoteDraft(c.req.param('encounterId'), sections))
})

app.post('/encounters/:encounterId/clinical-note/revisions', async (c) => {
  const sections = await noteSections(c, true)
  if (!sections) return refuse(c, { code: 'invalid-request', message: noteShape('全部六个') })
  return noteOr(c, await workspace(c).signClinicalNote(c.req.param('encounterId'), sections as NoteSections), 201)
})

app.get('/encounters/:encounterId/diagnosis', async (c) => diagnosisOr(c, await workspace(c).getDiagnosis(c.req.param('encounterId'))))

app.put('/encounters/:encounterId/diagnosis/draft', async (c) => {
  const entries = await diagnosisDraftEntries(c)
  if (!entries) return refuse(c, { code: 'invalid-request', message: '请求体须为 { "entries": [{ code, primary, source }] }，诊断编码须在目录中且不重复，最多 8 项' })
  return diagnosisOr(c, await workspace(c).saveDiagnosisDraft(c.req.param('encounterId'), entries))
})

app.post('/encounters/:encounterId/diagnosis/revisions', async (c) => {
  const entries = await diagnosisDraftEntries(c)
  if (!entries) return refuse(c, { code: 'invalid-request', message: '请求体须为 { "entries": [{ code, primary, source }] }，诊断编码须在目录中且不重复，最多 8 项' })
  return diagnosisOr(c, await workspace(c).confirmDiagnosis(c.req.param('encounterId'), entries), 201)
})

app.post('/encounters/:encounterId/diagnosis/reopen', async (c) =>
  diagnosisOr(c, await workspace(c).reopenDiagnosis(c.req.param('encounterId'))),
)

app.get('/medication-catalog', (c) => c.json<MedicationCatalogResponse>(medicationCatalog()))

app.get('/encounters/:encounterId/prescriptions', async (c) =>
  prescriptionsOr(c, await workspace(c).getPrescriptions(c.req.param('encounterId'))),
)

app.post('/encounters/:encounterId/prescriptions', async (c) => {
  const lines = await prescriptionRequest(c)
  if (!lines) {
    return refuse(c, {
      code: 'invalid-request',
      message: '请求体须为 { "lines": [{ drugId, dose, route, frequency, days }] }，药品不重复、单次剂量大于 0、天数 1–30',
    })
  }
  return prescriptionsOr(c, await workspace(c).issuePrescription(c.req.param('encounterId'), lines), 201)
})

app.post('/encounters/:encounterId/no-medication', async (c) =>
  prescriptionsOr(c, await workspace(c).recordNoMedication(c.req.param('encounterId')), 201),
)

app.get('/encounters/:encounterId/consultation', async (c) => {
  const result = await workspace(c).getConsultation(c.req.param('encounterId'))
  return result.ok ? c.json<ConsultationResponse>({ turns: result.turns }) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/consultation/doctor-turns', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { clientTurnId?: unknown; text?: unknown } | null
  if (typeof body?.clientTurnId !== 'string' || typeof body.text !== 'string') {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "clientTurnId": string, "text": string }' })
  }
  const result = await workspace(c).askPatient(c.req.param('encounterId'), {
    clientTurnId: body.clientTurnId,
    text: body.text,
  })
  if (!result.ok) return refuse(c, result.error)
  return c.json<AskPatientResponse>({ doctorTurn: result.doctorTurn, patientTurn: result.patientTurn }, 201)
})

app.post('/encounters/:encounterId/consultation/patient-turns/:turnId/retry', async (c) => {
  const result = await workspace(c).retryPatientTurn(c.req.param('encounterId'), c.req.param('turnId'))
  return result.ok ? c.json<RetryPatientTurnResponse>({ patientTurn: result.patientTurn }, 201) : refuse(c, result.error)
})

// Streams the Simulated Patient's replies for one Encounter (see src/shared/agent-wire.ts).
app.get('/encounters/:encounterId/patient/socket', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json<ErrorResponse>({ error: { code: 'invalid-request', message: '需要 WebSocket 升级请求' } }, 426)
  }
  const encounterId = c.req.param('encounterId')
  const found = await workspace(c).getEncounter(encounterId)
  if (!found.ok) return refuse(c, found.error)
  return c.env.SIMULATED_PATIENT.getByName(encounterId).fetch(c.req.raw)
})

// The Clinical Copilot for one Encounter. Every command is authorized (the Encounter must be active) and
// audited once done; reads and its socket need the Encounter to exist but work while it is frozen, so the
// doctor can still read what the Copilot found after completion.
const copilot = (c: AppContext) => c.env.CLINICAL_COPILOT.getByName(c.req.param('encounterId')!)

const mentions = (value: unknown): CopilotMention[] | null => {
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) return null
  return value.every(
    (m): m is CopilotMention =>
      typeof m === 'object' && m !== null && ['report', 'examination', 'note-section', 'draft'].includes((m as CopilotMention).kind) &&
      typeof (m as CopilotMention).id === 'string' && typeof (m as CopilotMention).label === 'string',
  )
    ? value
    : null
}

app.get('/encounters/:encounterId/copilot', async (c) => {
  const found = await workspace(c).getEncounter(c.req.param('encounterId'))
  if (!found.ok) return refuse(c, found.error)
  const snapshot = await copilot(c).snapshot(c.req.param('encounterId'))
  return c.json<{ snapshot: CopilotSnapshot }>({ snapshot })
})

app.post('/encounters/:encounterId/copilot/prompts', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<CopilotPromptRequest> | null
  const listed = mentions(body?.mentions)
  if (
    typeof body?.clientPromptId !== 'string' ||
    body.clientPromptId.length === 0 ||
    typeof body.text !== 'string' ||
    body.text.length === 0 ||
    body.text.length > MAX_PROMPT_LENGTH ||
    !listed ||
    (body.mode !== 'queue' && body.mode !== 'steer')
  ) {
    return refuse(c, { code: 'invalid-request', message: `请求体须为 { clientPromptId, text（1-${MAX_PROMPT_LENGTH} 字）, mentions, mode: "queue" | "steer" }` })
  }
  const request: CopilotPromptRequest = {
    clientPromptId: body.clientPromptId, text: body.text, mentions: listed, mode: body.mode,
  } satisfies CopilotPromptRequest
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'))
  if (!allowed.ok) return refuse(c, allowed.error)
  const response: CopilotPromptResponse = await copilot(c).prompt(c.req.param('encounterId'), request, { practitionerId: allowed.practitionerId })
  workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-prompted', body.text.slice(0, 80))
  return c.json<CopilotPromptResponse>(response, 201)
})

app.post('/encounters/:encounterId/copilot/turns/:turnId/resend', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<CopilotPromptRequest> | null
  const listed = mentions(body?.mentions)
  if (
    typeof body?.clientPromptId !== 'string' || body.clientPromptId.length === 0 ||
    typeof body.text !== 'string' || body.text.length === 0 || body.text.length > MAX_PROMPT_LENGTH || !listed
  ) {
    return refuse(c, { code: 'invalid-request', message: `请求体须为 { clientPromptId, text（1-${MAX_PROMPT_LENGTH} 字）, mentions }` })
  }
  const request: CopilotResendRequest = { clientPromptId: body.clientPromptId, text: body.text, mentions: listed }
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'))
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).resend(c.req.param('encounterId'), c.req.param('turnId'), request, { practitionerId: allowed.practitionerId })
  if (!result.ok) return refuse(c, result.error)
  workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-prompt-resent', body.text.slice(0, 80))
  return c.json<CopilotPromptResponse>(result.value, 201)
})

app.post('/encounters/:encounterId/copilot/stop', async (c) => {
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'))
  if (!allowed.ok) return refuse(c, allowed.error)
  const stopped = await copilot(c).stop(c.req.param('encounterId'))
  if (stopped.stoppedTurnId !== null) workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-stopped', stopped.stoppedTurnId)
  return c.json(stopped)
})

app.post('/encounters/:encounterId/copilot/turns/:turnId/feedback', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null
  if (body?.value !== 'up' && body?.value !== 'down' && body?.value !== null) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "value": "up" | "down" | null }' })
  }
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'))
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).setFeedback(c.req.param('encounterId'), c.req.param('turnId'), body.value as CopilotFeedback | null)
  if (!result.ok) return refuse(c, result.error)
  workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-feedback-given', c.req.param('turnId'))
  return c.json(result)
})

app.post('/encounters/:encounterId/copilot/config', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<CopilotConfigRequest> | null
  if (typeof body?.model !== 'string' || !['off', 'low', 'medium', 'high'].includes(body.effort as string)) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { model: string, effort: "off" | "low" | "medium" | "high" }' })
  }
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'))
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).configure(c.req.param('encounterId'), body as CopilotConfigRequest)
  if (!result.ok) return refuse(c, result.error)
  workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-model-changed', `${result.value.model}/${result.value.effort}`)
  return c.json<CopilotModelSetting>(result.value)
})

// Streams the Clinical Copilot's events for one Encounter.
app.get('/encounters/:encounterId/copilot/socket', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json<ErrorResponse>({ error: { code: 'invalid-request', message: '需要 WebSocket 升级请求' } }, 426)
  }
  const encounterId = c.req.param('encounterId')
  const found = await workspace(c).getEncounter(encounterId)
  if (!found.ok) return refuse(c, found.error)
  return copilot(c).fetch(c.req.raw)
})
