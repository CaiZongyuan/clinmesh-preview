import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type {
  AuthSessionResponse,
  ContactView,
  DemoResetResponse,
  DepartmentView,
  DoctorView,
  MeResponse,
  PatientReleaseDetailResponse,
  PatientReleasesResponse,
} from '../shared/auth'
import {
  isNoteSection,
  MAX_NOTE_SECTION_LENGTH,
  NOTE_SECTIONS,
  type ClinicalNoteResponse,
  type DraftAuthor,
  type NoteSection,
  type NoteSections,
} from '../shared/clinical-note'
import { isVoiceCapture, type AskPatientResponse, type ConsultationResponse, type RetryPatientTurnResponse } from '../shared/consultation'
import type { CopilotCompactResponse, CopilotContextView } from '../shared/copilot-context'
import {
  MAX_MENTIONS,
  MAX_PROMPT_LENGTH,
  type CopilotConfigRequest,
  type CopilotFeedback,
  type CopilotMention,
  type CopilotModelSetting,
  type CopilotPromptRequest,
  type CopilotPromptResponse,
  type CopilotResendRequest,
  type CopilotSnapshot,
} from '../shared/copilot-turn'
import type { DiagnosisResponse } from '../shared/diagnosis'
import { parseDraftAssistanceCommand } from '../shared/draft-assistance'
import type {
  ActiveEncounterResponse,
  AuditEventsResponse,
  EncounterError,
  EncounterErrorCode,
  EncounterResponse,
  ErrorResponse,
} from '../shared/encounter'
import type { GoldenCaseQueueResponse } from '../shared/golden-case-queue'
import type { InvestigationCatalogResponse, InvestigationsResponse } from '../shared/investigation'
import type {
  MedicationCatalogResponse,
  PrescriptionLineRequest,
  PrescriptionsResponse,
} from '../shared/medication'
import {
  BODY_SYSTEMS,
  isBodySystem,
  type PhysicalExaminationResponse,
  type PhysicalExaminationsResponse,
} from '../shared/physical-examination'
import { SAMBERT_MAX_TEXT, type PatientSpeechRequest, type VoiceConfigResponse } from '../shared/voice'
import { resolveWeChatOpenId, type WeChatAuthEnv } from './auth/wechat'
import type { ClinicalNoteResult } from './clinical-note-repository'
import { registerConnectedClinicRoutes } from './connected-clinic-routes'
import { diagnosisEntries, type DiagnosisResult } from './diagnosis-repository'
import type { InvestigationsResult } from './investigation-repository'
import { medicationCatalog } from './medication-catalog'
import { prescriptionLines, type PrescriptionsResult } from './prescription-repository'
import { SambertTTSProvider } from './voice/sambert-tts-provider'
import { recognizerFor, sambertUpstream } from './voice/voice-config'
import { clinicMode, workspaceName, type WorkspaceModeEnv } from './workspace-name'

const ERROR_STATUS: Record<EncounterErrorCode, ContentfulStatusCode> = {
  'invalid-request': 400,
  'golden-case-not-found': 404,
  'encounter-not-found': 404,
  'active-encounter-exists': 409,
  'encounter-not-active': 409,
  'completion-gates-unmet': 409,
  'debrief-locked': 409,
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
  'copilot-nothing-to-compact': 409,
  'copilot-llm-unavailable': 503,
  'copilot-bridge-required': 409,
  'copilot-run-stopped': 409,
  unauthorized: 401,
  forbidden: 403,
  'invalid-credentials': 401,
  'invite-code-required': 403,
  'invite-code-invalid': 403,
  'invite-code-expired': 403,
  'patient-already-bound': 409,
  'wechat-auth-failed': 401,
  'wechat-not-configured': 503,
  'resource-not-found': 404,
  'demo-reset-disabled': 403,
  'slot-not-found': 404,
  'slot-closed': 409,
  'slot-full': 409,
  'duplicate-appointment': 409,
  'appointment-not-found': 404,
  'appointment-invalid-transition': 409,
  'release-source-not-ready': 409,
  'release-not-found': 404,
  'conversation-not-found': 404,
  'conversation-read-only': 409,
  'conversation-member-forbidden': 403,
  'conversation-member-invalid': 400,
  'invalid-message-payload': 400,
  'im-delivery-failed': 502,
  'attachment-not-found': 404,
  'attachment-not-ready': 409,
  'attachment-invalid': 400,
  'attachment-expired': 403,
  'followup-plan-not-found': 404,
  'followup-plan-closed': 409,
  'followup-task-not-found': 404,
  'followup-task-already-submitted': 409,
  'followup-summary-not-found': 404,
  'followup-summary-immutable': 409,
  'agent-run-not-found': 404,
  'agent-action-invalid': 400,
}

type AppContext = Context<{ Bindings: Env }>
type RuntimeFlags = WorkspaceModeEnv & WeChatAuthEnv & { DEMO_RESET_ENABLED?: string }

const runtimeEnv = (c: AppContext) => c.env as unknown as RuntimeFlags
const currentWorkspaceName = (c: AppContext) => workspaceName(runtimeEnv(c))
const workspace = (c: AppContext) => c.env.CLINIC_WORKSPACE.getByName(currentWorkspaceName(c))
const refuse = (c: AppContext, error: EncounterError) => c.json<ErrorResponse>({ error }, ERROR_STATUS[error.code])
const investigationsOr = (c: AppContext, result: InvestigationsResult, status: ContentfulStatusCode = 200) =>
  result.ok ? c.json<InvestigationsResponse>({ investigations: result.investigations }, status) : refuse(c, result.error)

// Parses `Authorization: Bearer <token>`. Returns null when no Authorization header was sent; empty string when malformed.
function extractBearer(c: AppContext): string | null {
  const header = c.req.header('authorization')
  if (header === undefined) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : ''
}

async function requireBearer(c: AppContext): Promise<{ ok: true; token: string } | { ok: false; response: Response }> {
  const token = extractBearer(c)
  if (!token) {
    return { ok: false, response: refuse(c, { code: 'unauthorized', message: '缺少有效的 Bearer 认证凭据。' }) }
  }
  return { ok: true, token }
}

type ClinicalStaffGate = { ok: true; practitionerId?: string } | { ok: false; response: Response }

// Guards every clinical HIS HTTP & WS endpoint:
// - If a Bearer token is present, authenticates it and strictly blocks patients (403) and non-doctors on doctorOnly commands (403).
// - In `connected` mode, unauthenticated requests are strictly refused (401).
// - In `simulation` mode (default Phase 1), unauthenticated requests continue to run as the demo practitioner.
async function requireClinicalStaff(c: AppContext, doctorOnly: boolean): Promise<ClinicalStaffGate> {
  const token = extractBearer(c)
  if (token === null) {
    if (clinicMode(runtimeEnv(c)) === 'connected') {
      return { ok: false, response: refuse(c, { code: 'unauthorized', message: '请先登录医护账号。' }) }
    }
    return { ok: true }
  }
  if (!token) {
    return { ok: false, response: refuse(c, { code: 'unauthorized', message: '认证凭据格式无效。' }) }
  }
  const auth = await workspace(c).authenticateBearer(token)
  if (!auth.ok) {
    return { ok: false, response: refuse(c, auth.error) }
  }
  const { principal } = auth
  if (principal.role === 'patient' || !principal.staffId) {
    await workspace(c).recordAccessDenial(principal.actorId, principal.role, `${c.req.method} ${c.req.path}`, 'clinical_route', c.req.path)
    return { ok: false, response: refuse(c, { code: 'forbidden', message: '患者账号无权访问医护临床接口。' }) }
  }
  if (doctorOnly && principal.role !== 'doctor') {
    await workspace(c).recordAccessDenial(principal.actorId, principal.role, `${c.req.method} ${c.req.path}`, 'clinical_route', c.req.path)
    return { ok: false, response: refuse(c, { code: 'forbidden', message: '仅授权医生可执行正式临床诊疗操作。' }) }
  }
  return { ok: true, practitionerId: principal.staffId }
}

// A non-empty list of distinct ids under `key`, or null.
async function idList(c: AppContext, key: string, allowEmpty = false): Promise<string[] | null> {
  const body: unknown = await c.req.json().catch(() => null)
  const ids = (body as Record<string, unknown> | null)?.[key]
  const valid = Array.isArray(ids) && (allowEmpty || ids.length > 0) && ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length
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

// --- Connected Clinic S1: Auth, Identity, Clinic Directory, Contacts & Patient Portal ---

app.post('/auth/wechat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; inviteCode?: unknown } | null
  if (typeof body?.code !== 'string' || !body.code.trim()) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "code": string, "inviteCode"?: string }' })
  }
  if (body.inviteCode !== undefined && typeof body.inviteCode !== 'string') {
    return refuse(c, { code: 'invalid-request', message: '邀请码须为字符串。' })
  }
  const resolved = await resolveWeChatOpenId(body.code, runtimeEnv(c))
  if (!resolved.ok) {
    return refuse(c, { code: resolved.code, message: resolved.message })
  }
  const result = await workspace(c).loginWeChat(resolved.openid, body.inviteCode)
  return result.ok ? c.json<AuthSessionResponse>({ token: result.token, principal: result.principal }, 200) : refuse(c, result.error)
})

app.post('/auth/staff', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null
  if (typeof body?.username !== 'string' || !body.username.trim() || typeof body.password !== 'string' || !body.password) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "username": string, "password": string }' })
  }
  const result = await workspace(c).loginStaff(body.username, body.password)
  return result.ok ? c.json<AuthSessionResponse>({ token: result.token, principal: result.principal }, 200) : refuse(c, result.error)
})

app.get('/me', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).authenticateBearer(bearer.token)
  return result.ok ? c.json<MeResponse>({ principal: result.principal }) : refuse(c, result.error)
})

app.post('/auth/logout', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).logoutBearer(bearer.token)
  return result.ok ? c.json({ ok: true }) : refuse(c, result.error)
})

app.get('/clinic/departments', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).listDepartments(bearer.token)
  return result.ok ? c.json<{ departments: DepartmentView[] }>({ departments: result.departments }) : refuse(c, result.error)
})

app.get('/clinic/doctors', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).listDoctors(bearer.token)
  return result.ok ? c.json<{ doctors: DoctorView[] }>({ doctors: result.doctors }) : refuse(c, result.error)
})

app.get('/contacts', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).listContacts(bearer.token)
  return result.ok ? c.json<{ contacts: ContactView[] }>({ contacts: result.contacts }) : refuse(c, result.error)
})

app.get('/patient/records', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).listPatientReleases(bearer.token, 'clinical_note')
  return result.ok ? c.json<PatientReleasesResponse>({ items: result.items }) : refuse(c, result.error)
})

app.get('/patient/records/:id', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).getPatientRelease(bearer.token, 'clinical_note', c.req.param('id'))
  return result.ok ? c.json<PatientReleaseDetailResponse>({ item: result.item }) : refuse(c, result.error)
})

app.get('/patient/reports', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).listPatientReleases(bearer.token, 'report')
  return result.ok ? c.json<PatientReleasesResponse>({ items: result.items }) : refuse(c, result.error)
})

app.get('/patient/reports/:id', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).getPatientRelease(bearer.token, 'report', c.req.param('id'))
  return result.ok ? c.json<PatientReleaseDetailResponse>({ item: result.item }) : refuse(c, result.error)
})

app.get('/patient/prescriptions', async (c) => {
  const bearer = await requireBearer(c)
  if (!bearer.ok) return bearer.response
  const result = await workspace(c).listPatientReleases(bearer.token, 'prescription')
  return result.ok ? c.json<PatientReleasesResponse>({ items: result.items }) : refuse(c, result.error)
})

// Dev/test-only reset endpoint; disabled unless DEMO_RESET_ENABLED='true'.
app.post('/demo/reset', async (c) => {
  if (runtimeEnv(c).DEMO_RESET_ENABLED !== 'true') {
    return refuse(c, { code: 'demo-reset-disabled', message: '当前部署未开放演示数据重置入口。' })
  }
  const summary = await workspace(c).resetDemoClinic(currentWorkspaceName(c))
  return c.json<DemoResetResponse>(summary)
})

registerConnectedClinicRoutes(app, {
  workspace,
  currentWorkspaceName,
  requireBearer,
  refuse,
})

// --- Clinical HIS Routes (Phase 1 Outpatient MVP + Connected Clinic RBAC) ---

app.get('/golden-cases', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const goldenCases = await workspace(c).listGoldenCaseQueue()
  return c.json<GoldenCaseQueueResponse>({ goldenCases })
})

app.post('/encounters', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body: unknown = await c.req.json().catch(() => null)
  const caseId = (body as { caseId?: unknown } | null)?.caseId
  if (typeof caseId !== 'string') {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "caseId": string }' })
  }
  const result = await workspace(c).startEncounter(caseId, gate.practitionerId)
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }, 201) : refuse(c, result.error)
})

app.get('/encounters/active', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const encounter = await workspace(c).getActiveEncounter()
  return c.json<ActiveEncounterResponse>({ encounter })
})

app.get('/encounters/:encounterId', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const result = await workspace(c).getEncounter(c.req.param('encounterId'))
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/audit-events', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const result = await workspace(c).listAuditEvents(c.req.param('encounterId'))
  return result.ok ? c.json<AuditEventsResponse>({ auditEvents: result.auditEvents }) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/abandonment', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const result = await workspace(c).abandonEncounter(c.req.param('encounterId'), gate.practitionerId)
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/completion', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const result = await workspace(c).completeEncounter(c.req.param('encounterId'), gate.practitionerId)
  return result.ok ? c.json<EncounterResponse>({ encounter: result.encounter }) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/debrief', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const result = await workspace(c).getCaseDebrief(c.req.param('encounterId'))
  return result.ok ? c.json({ debrief: result.debrief }) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/draft-assistance', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const result = await workspace(c).getDraftAssistance(c.req.param('encounterId'))
  return result.ok ? c.json({ assistance: result.assistance }) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/draft-assistance', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const command = parseDraftAssistanceCommand(await c.req.json().catch(() => null))
  if (!command) return refuse(c, { code: 'invalid-request', message: '草稿建议操作参数无效。' })
  const result = await workspace(c).updateDraftAssistance(c.req.param('encounterId'), command, gate.practitionerId)
  return result.ok ? c.json(result.result) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/clinical-drafts', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const result = await workspace(c).getClinicalDrafts(c.req.param('encounterId'))
  return result.ok ? c.json({ drafts: result.drafts }) : refuse(c, result.error)
})

app.put('/encounters/:encounterId/investigations/draft', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const entries = await idList(c, 'entries', true)
  if (!entries) return refuse(c, { code: 'invalid-request', message: '检查草稿须为 { "entries": string[] }，且不重复' })
  const result = await workspace(c).saveInvestigationDraft(c.req.param('encounterId'), entries, gate.practitionerId)
  return result.ok ? c.json({ drafts: result.drafts }) : refuse(c, result.error)
})

app.put('/encounters/:encounterId/prescriptions/draft', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body: unknown = await c.req.json().catch(() => null)
  const entries = (body as { entries?: unknown } | null)?.entries
  const parsed = Array.isArray(entries) && entries.length === 0 ? [] : prescriptionLines(entries, { draft: true })
  if (!parsed) return refuse(c, { code: 'invalid-request', message: '处方草稿须包含有效且不重复的药品条目' })
  const lines = parsed.map(({ drugId, dose, route, frequency, days }) => ({ drugId, dose, route, frequency, days }))
  const result = await workspace(c).savePrescriptionDraft(c.req.param('encounterId'), lines, gate.practitionerId)
  return result.ok ? c.json({ drafts: result.drafts }) : refuse(c, result.error)
})

app.get('/encounters/:encounterId/physical-examinations', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const result = await workspace(c).listPhysicalExaminations(c.req.param('encounterId'))
  return result.ok
    ? c.json<PhysicalExaminationsResponse>({ examinations: result.examinations })
    : refuse(c, result.error)
})

app.post('/encounters/:encounterId/physical-examinations', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body: unknown = await c.req.json().catch(() => null)
  const system = (body as { system?: unknown } | null)?.system
  if (!isBodySystem(system)) {
    return refuse(c, { code: 'invalid-request', message: `请求体须为 { "system": ${BODY_SYSTEMS.map((s) => `"${s}"`).join(' | ')} }` })
  }
  const result = await workspace(c).performPhysicalExamination(c.req.param('encounterId'), system, gate.practitionerId)
  return result.ok
    ? c.json<PhysicalExaminationResponse>({ examination: result.examination }, 201)
    : refuse(c, result.error)
})

app.get('/investigation-catalog', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return c.json<InvestigationCatalogResponse>(await workspace(c).investigationCatalog())
})

app.get('/encounters/:encounterId/investigations', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return investigationsOr(c, await workspace(c).listInvestigations(c.req.param('encounterId')))
})

app.post('/encounters/:encounterId/investigations', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const catalogItemIds = await idList(c, 'catalogItemIds')
  if (!catalogItemIds) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "catalogItemIds": string[] }，且不重复、不为空' })
  }
  return investigationsOr(c, await workspace(c).issueInvestigations(c.req.param('encounterId'), catalogItemIds, gate.practitionerId), 201)
})

app.post('/encounters/:encounterId/investigations/:investigationId/instant-release', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  return investigationsOr(c, await workspace(c).releaseInvestigationNow(c.req.param('encounterId'), c.req.param('investigationId'), gate.practitionerId))
})

app.post('/encounters/:encounterId/investigations/:investigationId/cancellation', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  return investigationsOr(c, await workspace(c).cancelInvestigation(c.req.param('encounterId'), c.req.param('investigationId'), gate.practitionerId))
})

app.post('/encounters/:encounterId/report-acknowledgements', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const reportIds = await idList(c, 'reportIds')
  if (!reportIds) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "reportIds": string[] }，且不重复、不为空' })
  }
  return investigationsOr(c, await workspace(c).acknowledgeReports(c.req.param('encounterId'), reportIds, gate.practitionerId))
})

app.get('/encounters/:encounterId/clinical-note', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return noteOr(c, await workspace(c).getClinicalNote(c.req.param('encounterId')))
})

app.patch('/encounters/:encounterId/clinical-note/draft', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const sections = await noteSections(c, false)
  if (!sections) return refuse(c, { code: 'invalid-request', message: noteShape('至少一个') })
  const body = await c.req.json<{ authors?: unknown }>()
  const authors = body.authors ?? {}
  if (typeof authors !== 'object' || Array.isArray(authors) || !Object.entries(authors).every(([section, author]) =>
    isNoteSection(section) && Object.hasOwn(sections, section) && (author === 'doctor' || author === 'assistant'),
  )) {
    return refuse(c, { code: 'invalid-request', message: '草稿作者须为 doctor 或 assistant。' })
  }
  return noteOr(c, await workspace(c).saveClinicalNoteDraft(
    c.req.param('encounterId'), sections, authors as Partial<Record<NoteSection, DraftAuthor>>, gate.practitionerId,
  ))
})

app.post('/encounters/:encounterId/clinical-note/revisions', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const sections = await noteSections(c, true)
  if (!sections) return refuse(c, { code: 'invalid-request', message: noteShape('全部六个') })
  return noteOr(c, await workspace(c).signClinicalNote(c.req.param('encounterId'), sections as NoteSections, gate.practitionerId), 201)
})

app.get('/encounters/:encounterId/diagnosis', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return diagnosisOr(c, await workspace(c).getDiagnosis(c.req.param('encounterId')))
})

app.put('/encounters/:encounterId/diagnosis/draft', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const entries = await diagnosisDraftEntries(c)
  if (!entries) return refuse(c, { code: 'invalid-request', message: '请求体须为 { "entries": [{ code, primary, source }] }，诊断编码须在目录中且不重复，最多 8 项' })
  return diagnosisOr(c, await workspace(c).saveDiagnosisDraft(c.req.param('encounterId'), entries, gate.practitionerId))
})

app.post('/encounters/:encounterId/diagnosis/revisions', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const entries = await diagnosisDraftEntries(c)
  if (!entries) return refuse(c, { code: 'invalid-request', message: '请求体须为 { "entries": [{ code, primary, source }] }，诊断编码须在目录中且不重复，最多 8 项' })
  return diagnosisOr(c, await workspace(c).confirmDiagnosis(c.req.param('encounterId'), entries, gate.practitionerId), 201)
})

app.post('/encounters/:encounterId/diagnosis/reopen', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  return diagnosisOr(c, await workspace(c).reopenDiagnosis(c.req.param('encounterId'), gate.practitionerId))
})

app.get('/medication-catalog', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return c.json<MedicationCatalogResponse>(medicationCatalog())
})

app.get('/encounters/:encounterId/prescriptions', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return prescriptionsOr(c, await workspace(c).getPrescriptions(c.req.param('encounterId')))
})

app.post('/encounters/:encounterId/prescriptions', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const lines = await prescriptionRequest(c)
  if (!lines) {
    return refuse(c, {
      code: 'invalid-request',
      message: '请求体须为 { "lines": [{ drugId, dose, route, frequency, days }] }，药品不重复、单次剂量大于 0、天数 1–30',
    })
  }
  return prescriptionsOr(c, await workspace(c).issuePrescription(c.req.param('encounterId'), lines, gate.practitionerId), 201)
})

app.post('/encounters/:encounterId/no-medication', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  return prescriptionsOr(c, await workspace(c).recordNoMedication(c.req.param('encounterId'), gate.practitionerId), 201)
})

app.get('/encounters/:encounterId/consultation', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const result = await workspace(c).getConsultation(c.req.param('encounterId'))
  return result.ok ? c.json<ConsultationResponse>({ turns: result.turns }) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/consultation/doctor-turns', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body = (await c.req.json().catch(() => null)) as { clientTurnId?: unknown; text?: unknown; voice?: unknown } | null
  if (typeof body?.clientTurnId !== 'string' || typeof body.text !== 'string') {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "clientTurnId": string, "text": string }' })
  }
  // Only the browser's own recognizer reports speech here; Paraformer turns come from the voice socket.
  const voice = body.voice as { recognizer?: unknown } | undefined
  if (voice !== undefined && (!isVoiceCapture(voice) || voice.recognizer !== 'web-speech')) {
    return refuse(c, { code: 'invalid-request', message: '语音识别信息须为 { "recognizer": "web-speech", "durationMs": number, "confidence": number | null }' })
  }
  const result = await workspace(c).askPatient(c.req.param('encounterId'), {
    clientTurnId: body.clientTurnId,
    text: body.text,
    ...(voice === undefined ? {} : { voice }),
  }, gate.practitionerId)
  if (!result.ok) return refuse(c, result.error)
  return c.json<AskPatientResponse>({ doctorTurn: result.doctorTurn, patientTurn: result.patientTurn }, 201)
})

app.post('/encounters/:encounterId/consultation/patient-turns/:turnId/retry', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const result = await workspace(c).retryPatientTurn(c.req.param('encounterId'), c.req.param('turnId'), gate.practitionerId)
  return result.ok ? c.json<RetryPatientTurnResponse>({ patientTurn: result.patientTurn }, 201) : refuse(c, result.error)
})

app.post('/encounters/:encounterId/consultation/patient-turns/:turnId/speech', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const encounterId = c.req.param('encounterId')
  const found = await workspace(c).getEncounter(encounterId)
  if (!found.ok) return refuse(c, found.error)
  if (found.encounter.status !== 'active') {
    return refuse(c, { code: 'encounter-not-active', message: '该就诊已结束，不再合成语音。' })
  }
  const body = (await c.req.json().catch(() => null)) as PatientSpeechRequest | null
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > SAMBERT_MAX_TEXT) {
    return refuse(c, { code: 'invalid-request', message: `请求体须为 { "text": string }，1–${SAMBERT_MAX_TEXT} 字` })
  }
  const consultation = await workspace(c).getConsultation(encounterId)
  if (!consultation.ok) return refuse(c, consultation.error)
  const turn = consultation.turns.find((candidate) => candidate.turnId === c.req.param('turnId'))
  if (turn?.speaker !== 'patient' || turn.status === 'failed') {
    return refuse(c, { code: 'invalid-request', message: '只能合成患者的回复。' })
  }
  const available = turn.status === 'pending'
    ? await c.env.SIMULATED_PATIENT.getByName(encounterId).replyText(turn.turnId)
    : turn.text
  if (!available.includes(body.text)) {
    return refuse(c, { code: 'invalid-request', message: '语音内容须来自患者已经显示的回复。' })
  }
  const upstream = sambertUpstream(c.env as unknown as Record<string, unknown>)
  if (!upstream) return refuse(c, { code: 'invalid-request', message: '未配置语音合成（BAILIAN_TOKEN）。' })
  const wav = await new SambertTTSProvider(upstream).synthesize(body.text, c.req.raw.signal)
  if (!wav) return refuse(c, { code: 'invalid-request', message: '语音合成失败，请重试。' })
  return new Response(wav, { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } })
})

// Streams the Simulated Patient's replies for one Encounter (see src/shared/agent-wire.ts).
app.get('/encounters/:encounterId/patient/socket', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
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
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const found = await workspace(c).getEncounter(c.req.param('encounterId'))
  if (!found.ok) return refuse(c, found.error)
  const snapshot = await copilot(c).snapshot(c.req.param('encounterId'))
  return c.json<{ snapshot: CopilotSnapshot }>({ snapshot })
})

app.post('/encounters/:encounterId/copilot/prompts', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
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
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), listed, gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const response: CopilotPromptResponse = await copilot(c).prompt(c.req.param('encounterId'), request, allowed)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-prompted', body.text.slice(0, 80), gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json<CopilotPromptResponse>(response, 201)
})

app.post('/encounters/:encounterId/copilot/turns/:turnId/resend', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body = (await c.req.json().catch(() => null)) as Partial<CopilotPromptRequest> | null
  const listed = mentions(body?.mentions)
  if (
    typeof body?.clientPromptId !== 'string' || body.clientPromptId.length === 0 ||
    typeof body.text !== 'string' || body.text.length === 0 || body.text.length > MAX_PROMPT_LENGTH || !listed
  ) {
    return refuse(c, { code: 'invalid-request', message: `请求体须为 { clientPromptId, text（1-${MAX_PROMPT_LENGTH} 字）, mentions }` })
  }
  const request: CopilotResendRequest = { clientPromptId: body.clientPromptId, text: body.text, mentions: listed }
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), listed, gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).resend(c.req.param('encounterId'), c.req.param('turnId'), request, allowed)
  if (!result.ok) return refuse(c, result.error)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-prompt-resent', body.text.slice(0, 80), gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json<CopilotPromptResponse>(result.value, 201)
})

app.post('/encounters/:encounterId/copilot/stop', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const stopped = await copilot(c).stop(c.req.param('encounterId'))
  // A stop that actually stopped a turn must return success only with its audit; losing the audit to a freeze
  // means the freeze won the race and the response reports it instead of success.
  if (stopped.stoppedTurnId !== null) {
    const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-stopped', stopped.stoppedTurnId, gate.practitionerId)
    if (!audited.ok) return refuse(c, audited.error)
  }
  return c.json(stopped)
})

app.post('/encounters/:encounterId/copilot/turns/:turnId/feedback', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null
  if (body?.value !== 'up' && body?.value !== 'down' && body?.value !== null) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { "value": "up" | "down" | null }' })
  }
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).setFeedback(c.req.param('encounterId'), c.req.param('turnId'), body.value as CopilotFeedback | null)
  if (!result.ok) return refuse(c, result.error)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-feedback-given', c.req.param('turnId'), gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json(result)
})

app.post('/encounters/:encounterId/copilot/config', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body = (await c.req.json().catch(() => null)) as Partial<CopilotConfigRequest> | null
  if (typeof body?.model !== 'string' || !['off', 'low', 'medium', 'high'].includes(body.effort as string)) {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { model: string, effort: "off" | "low" | "medium" | "high" }' })
  }
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).configure(c.req.param('encounterId'), body as CopilotConfigRequest)
  if (!result.ok) return refuse(c, result.error)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-model-changed', `${result.value.model}/${result.value.effort}`, gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json<CopilotModelSetting>(result.value)
})

// The 上下文 view (#13): read-only, available while the Encounter is frozen like the session snapshot.
app.get('/encounters/:encounterId/copilot/context', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  const found = await workspace(c).getEncounter(c.req.param('encounterId'))
  if (!found.ok) return refuse(c, found.error)
  return c.json<{ context: CopilotContextView }>({ context: await copilot(c).contextView(c.req.param('encounterId')) })
})

// Manual compaction (#13): authorized and audited like every Copilot command, since it rewrites its context.
// The compaction is a serialized run: the response names the queued run and the marker lands when it completes.
app.post('/encounters/:encounterId/copilot/compact', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).compact(c.req.param('encounterId'))
  if (!result.ok) return refuse(c, result.error)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-compacted', result.value.turnId, gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json<CopilotCompactResponse>(result.value, 202)
})

// Streams the Clinical Copilot's events for one Encounter.
app.get('/encounters/:encounterId/copilot/socket', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const found = await workspace(c).getEncounter(c.req.param('encounterId'))
  if (!found.ok) return refuse(c, found.error)
  return copilot(c).fetch(c.req.raw)
})

// Which recognizer the workbench uses: Paraformer through the voice socket, or the browser's Web Speech API.
app.get('/voice', async (c) => {
  const gate = await requireClinicalStaff(c, false)
  if (!gate.ok) return gate.response
  return c.json<VoiceConfigResponse>({ recognizer: recognizerFor(c.env as unknown as Record<string, unknown>) })
})

// The doctor's voice capture for one active Encounter: the `agents/voice` protocol (see src/shared/voice.ts).
app.get('/encounters/:encounterId/voice', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json<ErrorResponse>({ error: { code: 'invalid-request', message: '需要 WebSocket 升级请求' } }, 426)
  }
  const encounterId = c.req.param('encounterId')
  const found = await workspace(c).getEncounter(encounterId)
  if (!found.ok) return refuse(c, found.error)
  if (found.encounter.status !== 'active') {
    return refuse(c, { code: 'encounter-not-active', message: '该就诊已结束，不再收音。' })
  }
  const headers = new Headers(c.req.raw.headers)
  headers.delete('x-clinmesh-practitioner-id')
  if (gate.practitionerId) headers.set('x-clinmesh-practitioner-id', gate.practitionerId)
  return c.env.CONSULTATION_VOICE.getByName(encounterId).fetch(new Request(c.req.raw, { headers }))
})

// The ui-sdk bridge socket: the browser answers the Copilot's ui_snapshot / ui_act calls here. Same fetch
// path; SocketHub tells the two roles apart by the `/bridge` suffix.
app.get('/encounters/:encounterId/copilot/bridge', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json<ErrorResponse>({ error: { code: 'invalid-request', message: '需要 WebSocket 升级请求' } }, 426)
  }
  const encounterId = c.req.param('encounterId')
  const found = await workspace(c).getEncounter(encounterId)
  if (!found.ok) return refuse(c, found.error)
  return copilot(c).fetch(c.req.raw)
})

// 立即 / 跳过 on the ambient countdown; both are doctor commands, so authorized and audited.
app.post('/encounters/:encounterId/copilot/triggers/:ref/flush', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const flushed = await copilot(c).flushCountdown(c.req.param('encounterId'), c.req.param('ref'))
  if (!flushed.ok) return refuse(c, flushed.error)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-trigger-flushed', c.req.param('ref'), gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json<CopilotPromptResponse>(flushed.value, 201)
})

app.put('/encounters/:encounterId/copilot/automatic-analysis', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
  if (typeof body?.enabled !== 'boolean') {
    return refuse(c, { code: 'invalid-request', message: '请求体须为 { enabled: boolean }' })
  }
  const encounterId = c.req.param('encounterId')
  const allowed = await workspace(c).authorizeCopilotCommand(encounterId, [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const result = await copilot(c).setAutomaticAnalysis(encounterId, body.enabled)
  if (!result.ok) return refuse(c, result.error)
  const audited = await workspace(c).auditCopilotCommand(encounterId, 'copilot-automatic-analysis-changed', body.enabled ? 'on' : 'off', gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json(result.value)
})

app.post('/encounters/:encounterId/copilot/pending-analysis/run', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const encounterId = c.req.param('encounterId')
  const allowed = await workspace(c).authorizeCopilotCommand(encounterId, [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const run = await copilot(c).runPendingAnalysis(encounterId)
  if (!run.ok) return refuse(c, run.error)
  if (!run.value) return c.json(null)
  const audited = await workspace(c).auditCopilotCommand(encounterId, 'copilot-pending-analysis-run', run.value.turnId, gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.json(run.value, 201)
})

app.delete('/encounters/:encounterId/copilot/triggers/:ref', async (c) => {
  const gate = await requireClinicalStaff(c, true)
  if (!gate.ok) return gate.response
  const allowed = await workspace(c).authorizeCopilotCommand(c.req.param('encounterId'), [], gate.practitionerId)
  if (!allowed.ok) return refuse(c, allowed.error)
  const skipped = await copilot(c).skipCountdown(c.req.param('encounterId'), c.req.param('ref'))
  if (!skipped.ok) return refuse(c, skipped.error)
  const audited = await workspace(c).auditCopilotCommand(c.req.param('encounterId'), 'copilot-trigger-skipped', c.req.param('ref'), gate.practitionerId)
  if (!audited.ok) return refuse(c, audited.error)
  return c.body(null, 204)
})
