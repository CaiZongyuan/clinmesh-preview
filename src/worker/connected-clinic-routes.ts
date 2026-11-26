import type { Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type {
  AppointmentResponse,
  AppointmentSlotsResponse,
  AppointmentsResponse,
  AppointmentStatus,
  StaffPatientsResponse,
  StartAppointmentEncounterResponse,
} from '../shared/appointment'
import type { PatientReleaseDetailResponse, PatientReleasesResponse } from '../shared/auth'
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MAX_IMAGE_BYTES,
  validateMessageParts,
  type AttachmentAccessResponse,
  type AttachmentKind,
  type ConversationType,
  type ConversationView,
  type ImCredentialsResponse,
  type InitAttachmentResponse,
  type MessagesPageResponse,
  type SendMessageResponse,
  type TranscriptStatus,
} from '../shared/communication'
import type { EncounterError, ErrorResponse } from '../shared/encounter'
import type { AgentRunSnapshot, FollowupPlanView, FollowupResponseView, FollowupSummaryView, QuestionnaireQuestion } from '../shared/followup'
import { sha256Hex } from './auth/crypto'
import { base64ToBytes, bytesToBase64 } from './communication/attachment-repository'

type AppContext = Context<{ Bindings: Env }>

export interface RouteHelpers {
  workspace(c: AppContext): DurableObjectStub<import('./clinic-workspace-do').ClinicWorkspaceDO>
  currentWorkspaceName(c: AppContext): string
  requireBearer(c: AppContext): Promise<{ ok: true; token: string } | { ok: false; response: Response }>
  refuse(c: AppContext, error: EncounterError): Response
}

const VALID_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ['booked', 'checked_in', 'in_encounter', 'completed', 'cancelled']
const VALID_CONVERSATION_TYPES: readonly ConversationType[] = [
  'patient_assistant',
  'patient_doctor',
  'staff_direct',
  'staff_group',
  'followup_group',
]

export function registerConnectedClinicRoutes(app: Hono<{ Bindings: Env }>, h: RouteHelpers): void {
  app.get('/appointments/slots', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).listAppointmentSlots(bearer.token, {
      departmentId: c.req.query('departmentId') || undefined,
      doctorId: c.req.query('doctorId') || undefined,
      date: c.req.query('date') || undefined,
    })
    return result.ok ? c.json<AppointmentSlotsResponse>({ slots: result.slots }) : h.refuse(c, result.error)
  })

  app.post('/appointments', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      slotId?: unknown
      clientRequestId?: unknown
      chiefComplaint?: unknown
    } | null
    const idempotencyHeader = c.req.header('idempotency-key')
    const clientRequestId =
      typeof body?.clientRequestId === 'string' && body.clientRequestId.trim()
        ? body.clientRequestId.trim()
        : idempotencyHeader?.trim() || ''
    if (typeof body?.slotId !== 'string' || !body.slotId.trim() || !clientRequestId) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "slotId": string, "clientRequestId": string }' })
    }
    const result = await h.workspace(c).bookAppointment(bearer.token, {
      slotId: body.slotId.trim(),
      clientRequestId,
      ...(typeof body.chiefComplaint === 'string' ? { chiefComplaint: body.chiefComplaint } : {}),
    })
    return result.ok
      ? c.json<AppointmentResponse>({ appointment: result.appointment }, (result.created ? 201 : 200) as ContentfulStatusCode)
      : h.refuse(c, result.error)
  })

  app.get('/patient/appointments', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const rawStatus = c.req.query('status')
    const status = rawStatus && VALID_APPOINTMENT_STATUSES.includes(rawStatus as AppointmentStatus)
      ? (rawStatus as AppointmentStatus)
      : undefined
    const result = await h.workspace(c).listPatientAppointments(bearer.token, status)
    return result.ok ? c.json<AppointmentsResponse>({ appointments: result.appointments }) : h.refuse(c, result.error)
  })

  app.post('/appointments/:id/cancel', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).cancelAppointment(bearer.token, c.req.param('id'))
    return result.ok ? c.json<AppointmentResponse>({ appointment: result.appointment }) : h.refuse(c, result.error)
  })

  app.get('/staff/appointments', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const rawStatus = c.req.query('status')
    const status = rawStatus && VALID_APPOINTMENT_STATUSES.includes(rawStatus as AppointmentStatus)
      ? (rawStatus as AppointmentStatus)
      : undefined
    const result = await h.workspace(c).listStaffAppointments(bearer.token, {
      doctorId: c.req.query('doctorId') || undefined,
      status,
    })
    return result.ok ? c.json<AppointmentsResponse>({ appointments: result.appointments }) : h.refuse(c, result.error)
  })

  app.post('/appointments/:id/check-in', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).checkInAppointment(bearer.token, c.req.param('id'))
    return result.ok ? c.json<AppointmentResponse>({ appointment: result.appointment }) : h.refuse(c, result.error)
  })

  app.post('/appointments/:id/start-encounter', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as { caseId?: unknown } | null
    const caseId = typeof body?.caseId === 'string' && body.caseId.trim() ? body.caseId.trim() : undefined
    const result = await h.workspace(c).startAppointmentEncounter(bearer.token, c.req.param('id'), caseId)
    return result.ok
      ? c.json<StartAppointmentEncounterResponse>({ appointment: result.appointment, encounter: result.encounter }, 201)
      : h.refuse(c, result.error)
  })

  app.get('/staff/patients', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).listStaffPatients(bearer.token)
    return result.ok ? c.json<StaffPatientsResponse>({ patients: result.patients }) : h.refuse(c, result.error)
  })

  app.post('/staff/releases', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      encounterId?: unknown
      resourceType?: unknown
      resourceId?: unknown
      title?: unknown
      summary?: unknown
    } | null
    if (
      typeof body?.encounterId !== 'string' ||
      !body.encounterId.trim() ||
      (body.resourceType !== 'clinical_note' && body.resourceType !== 'report' && body.resourceType !== 'prescription')
    ) {
      return h.refuse(c, {
        code: 'invalid-request',
        message: '请求体须为 { "encounterId": string, "resourceType": "clinical_note" | "report" | "prescription" }',
      })
    }
    const result = await h.workspace(c).publishStaffRelease(bearer.token, {
      encounterId: body.encounterId.trim(),
      resourceType: body.resourceType,
      ...(typeof body.resourceId === 'string' ? { resourceId: body.resourceId } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
    })
    return result.ok
      ? c.json<PatientReleaseDetailResponse>({ item: result.item }, (result.created ? 201 : 200) as ContentfulStatusCode)
      : h.refuse(c, result.error)
  })

  app.post('/staff/releases/:id/retract', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).retractStaffRelease(bearer.token, c.req.param('id'))
    return result.ok ? c.json({ ok: true, releaseId: result.releaseId }) : h.refuse(c, result.error)
  })

  app.get('/staff/encounters/:encounterId/releases', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).listEncounterReleases(bearer.token, c.req.param('encounterId'))
    return result.ok ? c.json<PatientReleasesResponse>({ items: result.items }) : h.refuse(c, result.error)
  })

  app.get('/im/credentials', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).issueImCredentials(bearer.token)
    return result.ok ? c.json<ImCredentialsResponse>(result.credentials) : h.refuse(c, result.error)
  })

  app.get('/conversations', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).listConversations(bearer.token)
    return result.ok ? c.json<{ conversations: ConversationView[] }>({ conversations: result.conversations }) : h.refuse(c, result.error)
  })

  app.post('/conversations', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      type?: unknown
      title?: unknown
      memberActorIds?: unknown
      patientId?: unknown
      encounterId?: unknown
      departmentId?: unknown
    } | null
    if (
      typeof body?.type !== 'string' ||
      !VALID_CONVERSATION_TYPES.includes(body.type as ConversationType) ||
      !Array.isArray(body.memberActorIds) ||
      !body.memberActorIds.every((id) => typeof id === 'string' && id.trim().length > 0)
    ) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "type": ConversationType, "memberActorIds": string[] }' })
    }
    const result = await h.workspace(c).createConversation(bearer.token, {
      type: body.type as ConversationType,
      memberActorIds: body.memberActorIds as string[],
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.patientId === 'string' ? { patientId: body.patientId } : {}),
      ...(typeof body.encounterId === 'string' ? { encounterId: body.encounterId } : {}),
      ...(typeof body.departmentId === 'string' ? { departmentId: body.departmentId } : {}),
    })
    return result.ok
      ? c.json<{ conversation: ConversationView }>({ conversation: result.conversation }, (result.created ? 201 : 200) as ContentfulStatusCode)
      : h.refuse(c, result.error)
  })

  app.get('/conversations/:id', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).getConversation(bearer.token, c.req.param('id'))
    return result.ok ? c.json<{ conversation: ConversationView }>({ conversation: result.conversation }) : h.refuse(c, result.error)
  })

  app.get('/conversations/:id/members', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).getConversation(bearer.token, c.req.param('id'))
    return result.ok ? c.json({ members: result.conversation.members }) : h.refuse(c, result.error)
  })

  app.post('/conversations/:id/members', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as { actorId?: unknown } | null
    if (typeof body?.actorId !== 'string' || !body.actorId.trim()) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "actorId": string }' })
    }
    const result = await h.workspace(c).addConversationMember(bearer.token, c.req.param('id'), body.actorId.trim())
    return result.ok ? c.json<{ conversation: ConversationView }>({ conversation: result.conversation }) : h.refuse(c, result.error)
  })

  app.delete('/conversations/:id/members/:actorId', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).removeConversationMember(bearer.token, c.req.param('id'), c.req.param('actorId'))
    return result.ok ? c.json<{ conversation: ConversationView }>({ conversation: result.conversation }) : h.refuse(c, result.error)
  })

  app.post('/conversations/:id/messages', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      clientMessageId?: unknown
      parts?: unknown
      mentions?: unknown
      replyTo?: unknown
    } | null
    const idempotencyHeader = c.req.header('idempotency-key')
    const clientMessageId =
      typeof body?.clientMessageId === 'string' && body.clientMessageId.trim()
        ? body.clientMessageId.trim()
        : idempotencyHeader?.trim() || ''
    const parts = validateMessageParts(body?.parts)
    if (!clientMessageId || !parts) {
      return h.refuse(c, { code: 'invalid-message-payload', message: '消息格式无效，须包含 clientMessageId 与合法的 parts。' })
    }
    const mentions = Array.isArray(body?.mentions) ? body.mentions.filter((m): m is string => typeof m === 'string') : []
    const result = await h.workspace(c).sendConversationMessage(bearer.token, h.currentWorkspaceName(c), c.req.param('id'), {
      clientMessageId,
      parts,
      mentions,
      ...(typeof body?.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
    })
    return result.ok ? c.json<SendMessageResponse>(result.result, 201) : h.refuse(c, result.error)
  })

  app.get('/conversations/:id/messages', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const cursorRaw = Number(c.req.query('cursor'))
    const limitRaw = Number(c.req.query('limit'))
    const result = await h.workspace(c).listConversationMessages(
      bearer.token,
      c.req.param('id'),
      Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : undefined,
      Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    )
    return result.ok
      ? c.json<MessagesPageResponse>({ messages: result.messages, nextCursor: result.nextCursor, hasMore: result.hasMore })
      : h.refuse(c, result.error)
  })

  app.post('/conversations/:id/read', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as { lastReadSeq?: unknown; seq?: unknown } | null
    const seq = typeof body?.lastReadSeq === 'number' ? body.lastReadSeq : typeof body?.seq === 'number' ? body.seq : -1
    if (!Number.isFinite(seq) || seq < 0) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "lastReadSeq": number }' })
    }
    const result = await h.workspace(c).markConversationRead(bearer.token, c.req.param('id'), seq)
    return result.ok ? c.json({ lastReadSeq: result.lastReadSeq, unreadCount: result.unreadCount }) : h.refuse(c, result.error)
  })

  app.post('/attachments/init', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      conversationId?: unknown
      kind?: unknown
      mime?: unknown
      size?: unknown
      durationMs?: unknown
    } | null
    if (
      typeof body?.conversationId !== 'string' ||
      (body.kind !== 'audio' && body.kind !== 'image') ||
      typeof body.mime !== 'string' ||
      typeof body.size !== 'number'
    ) {
      return h.refuse(c, { code: 'attachment-invalid', message: '请求体须包含 conversationId、kind (audio|image)、mime、size。' })
    }
    const kind = body.kind as AttachmentKind
    const result = await h.workspace(c).initAttachment(bearer.token, {
      conversationId: body.conversationId,
      kind,
      mime: body.mime,
      size: body.size,
      ...(typeof body.durationMs === 'number' ? { durationMs: body.durationMs } : {}),
    })
    if (!result.ok) return h.refuse(c, result.error)
    return c.json<InitAttachmentResponse>(
      {
        attachment: result.attachment,
        uploadUrl: `/api/attachments/${encodeURIComponent(result.attachment.attachmentId)}/upload`,
        maxBytes: kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES,
        maxDurationMs: MAX_AUDIO_DURATION_MS,
      },
      201,
    )
  })

  app.put('/attachments/:id/upload', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const buf = await c.req.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const dataBase64 = bytesToBase64(bytes)
    const hashHex = await sha256Hex(dataBase64)
    const result = await h.workspace(c).uploadAttachmentBytes(bearer.token, c.req.param('id'), dataBase64, bytes.byteLength, hashHex)
    return result.ok ? c.json({ attachment: result.attachment }) : h.refuse(c, result.error)
  })

  app.post('/attachments/:id/complete', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as { requestAsr?: unknown } | null
    const transcript: { status: TranscriptStatus; text: string | null } =
      body?.requestAsr === true ? { status: 'unavailable', text: null } : { status: 'none', text: null }
    const result = await h.workspace(c).completeAttachment(bearer.token, c.req.param('id'), transcript)
    return result.ok ? c.json({ attachment: result.attachment }) : h.refuse(c, result.error)
  })

  app.get('/attachments/:id/access', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const ttlParam = Number(c.req.query('ttlMs'))
    const ttlMs = Number.isFinite(ttlParam) && ttlParam > 0 ? Math.min(ttlParam, 900_000) : 300_000
    const result = await h.workspace(c).authorizeAttachmentAccess(bearer.token, c.req.param('id'), ttlMs)
    if (!result.ok) return h.refuse(c, result.error)
    const url =
      `/api/attachments/${encodeURIComponent(result.attachment.attachmentId)}/content` +
      `?actor=${encodeURIComponent(result.actorId)}&exp=${result.exp}&sig=${encodeURIComponent(result.sig)}`
    return c.json<AttachmentAccessResponse>({ attachment: result.attachment, url, expiresAt: result.expiresAt })
  })

  app.get('/attachments/:id/content', async (c) => {
    const actor = c.req.query('actor') ?? ''
    const exp = Number(c.req.query('exp'))
    const sig = c.req.query('sig') ?? ''
    if (!sig || !actor) return h.refuse(c, { code: 'forbidden', message: '缺少附件访问签名。' })
    const result = await h.workspace(c).readSignedAttachmentContent(c.req.param('id'), actor, exp, sig)
    if (!result.ok) return h.refuse(c, result.error)
    const bytes = base64ToBytes(result.dataBase64)
    return new Response(bytes as unknown as BodyInit, {
      headers: { 'content-type': result.mime, 'cache-control': 'private, no-store' },
    })
  })

  app.post('/agent/conversations/:id/runs', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      text?: unknown
      clientRequestId?: unknown
      agentActorId?: unknown
    } | null
    const clientRequestId =
      typeof body?.clientRequestId === 'string' && body.clientRequestId.trim()
        ? body.clientRequestId.trim()
        : c.req.header('idempotency-key')?.trim() || crypto.randomUUID()
    if (typeof body?.text !== 'string' || !body.text.trim()) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "text": string, "clientRequestId"?: string }' })
    }
    const result = await h.workspace(c).startAgentRunForConversation(bearer.token, h.currentWorkspaceName(c), c.req.param('id'), {
      text: body.text.trim(),
      clientRequestId,
      ...(typeof body.agentActorId === 'string' ? { agentActorId: body.agentActorId } : {}),
    })
    return result.ok ? c.json({ runId: result.runId, agentKind: result.agentKind }, 201) : h.refuse(c, result.error)
  })

  app.get('/agent/runs/:id', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const resolved = await h.workspace(c).resolveAuthorizedAgentRun(bearer.token, c.req.param('id'))
    if (!resolved.ok) return h.refuse(c, resolved.error)
    const snapshot: AgentRunSnapshot | null =
      resolved.agentKind === 'patient_service'
        ? await c.env.PATIENT_SERVICE_AGENT.getByName(resolved.doName).getRunSnapshot(c.req.param('id'))
        : await c.env.FOLLOWUP_AGENT.getByName(resolved.doName).getRunSnapshot(c.req.param('id'))
    if (!snapshot) return h.refuse(c, { code: 'agent-run-not-found', message: '找不到该 Agent 运行快照。' })
    return c.json<{ run: AgentRunSnapshot }>({ run: snapshot })
  })

  app.get('/agent/runs/:id/socket', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json<ErrorResponse>({ error: { code: 'invalid-request', message: '需要 WebSocket 升级请求' } }, 426)
    }
    const resolved = await h.workspace(c).resolveAuthorizedAgentRun(bearer.token, c.req.param('id'))
    if (!resolved.ok) return h.refuse(c, resolved.error)
    return resolved.agentKind === 'patient_service'
      ? c.env.PATIENT_SERVICE_AGENT.getByName(resolved.doName).fetch(c.req.raw)
      : c.env.FOLLOWUP_AGENT.getByName(resolved.doName).fetch(c.req.raw)
  })

  app.post('/agent/runs/:id/stop', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const runId = c.req.param('id')
    const resolved = await h.workspace(c).resolveAuthorizedAgentRun(bearer.token, runId)
    if (!resolved.ok) return h.refuse(c, resolved.error)
    if (resolved.principal.actorId !== resolved.triggerActorId && !resolved.principal.staffId) {
      return h.refuse(c, { code: 'forbidden', message: '仅运行发起人或授权医护可停止该 Agent 运行。' })
    }
    const stopped =
      resolved.agentKind === 'patient_service'
        ? await c.env.PATIENT_SERVICE_AGENT.getByName(resolved.doName).stopRun(runId)
        : await c.env.FOLLOWUP_AGENT.getByName(resolved.doName).stopRun(runId)
    return c.json(stopped)
  })

  app.post('/agent/runs/:id/actions/:callId/result', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const resolved = await h.workspace(c).resolveAuthorizedAgentRun(bearer.token, c.req.param('id'))
    if (!resolved.ok) return h.refuse(c, resolved.error)
    if (resolved.agentKind !== 'patient_service') {
      return h.refuse(c, { code: 'forbidden', message: '群聊随访 Agent 不允许下发客户端导航动作。' })
    }
    const body = (await c.req.json().catch(() => null)) as { status?: unknown; detail?: unknown } | null
    if (body?.status !== 'dispatched' && body?.status !== 'rejected' && body?.status !== 'unavailable') {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "status": "dispatched" | "rejected" | "unavailable" }' })
    }
    const outcome = await c.env.PATIENT_SERVICE_AGENT.getByName(resolved.doName).submitActionResult(
      c.req.param('id'),
      c.req.param('callId'),
      resolved.principal.actorId,
      resolved.principal.sessionId,
      { status: body.status, detail: body.detail },
    )
    return outcome.ok ? c.json({ ok: true }) : h.refuse(c, { code: outcome.code, message: outcome.message })
  })

  app.post('/followup/plans', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as {
      patientId?: unknown
      encounterId?: unknown
      title?: unknown
      nurseStaffId?: unknown
      dueAt?: unknown
      taskTitle?: unknown
      questions?: unknown
    } | null
    if (typeof body?.patientId !== 'string' || !body.patientId.trim() || typeof body.title !== 'string' || !body.title.trim()) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "patientId": string, "title": string }' })
    }
    const result = await h.workspace(c).createFollowupPlan(bearer.token, {
      patientId: body.patientId.trim(),
      title: body.title.trim(),
      ...(typeof body.encounterId === 'string' ? { encounterId: body.encounterId } : {}),
      ...(typeof body.nurseStaffId === 'string' ? { nurseStaffId: body.nurseStaffId } : {}),
      ...(typeof body.dueAt === 'string' ? { dueAt: body.dueAt } : {}),
      ...(typeof body.taskTitle === 'string' ? { taskTitle: body.taskTitle } : {}),
      ...(Array.isArray(body.questions) ? { questions: body.questions as QuestionnaireQuestion[] } : {}),
    })
    return result.ok ? c.json<{ plan: FollowupPlanView }>({ plan: result.plan }, 201) : h.refuse(c, result.error)
  })

  app.get('/followup/plans', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).listFollowupPlans(bearer.token)
    return result.ok ? c.json<{ plans: FollowupPlanView[] }>({ plans: result.plans }) : h.refuse(c, result.error)
  })

  app.get('/followup/plans/:id', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).getFollowupPlan(bearer.token, c.req.param('id'))
    return result.ok ? c.json<{ plan: FollowupPlanView }>({ plan: result.plan }) : h.refuse(c, result.error)
  })

  app.post('/followup/tasks/:id/responses', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as { answers?: unknown; idempotencyKey?: unknown } | null
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : c.req.header('idempotency-key')?.trim() || ''
    if (!body?.answers || typeof body.answers !== 'object' || Array.isArray(body.answers) || !idempotencyKey) {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "answers": Record<string, string|number>, "idempotencyKey": string }' })
    }
    const result = await h.workspace(c).submitFollowupResponse(bearer.token, c.req.param('id'), {
      answers: body.answers as Record<string, string | number>,
      idempotencyKey,
    })
    return result.ok
      ? c.json<{ response: FollowupResponseView }>({ response: result.response }, (result.created ? 201 : 200) as ContentfulStatusCode)
      : h.refuse(c, result.error)
  })

  app.post('/followup/summaries/:id/review', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const body = (await c.req.json().catch(() => null)) as { decision?: unknown; note?: unknown } | null
    if (body?.decision !== 'approved' && body?.decision !== 'rejected') {
      return h.refuse(c, { code: 'invalid-request', message: '请求体须为 { "decision": "approved" | "rejected", "note"?: string }' })
    }
    const result = await h.workspace(c).reviewFollowupSummary(bearer.token, c.req.param('id'), {
      decision: body.decision,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
    })
    return result.ok ? c.json<{ summary: FollowupSummaryView }>({ summary: result.summary }) : h.refuse(c, result.error)
  })

  app.post('/followup/plans/:id/close', async (c) => {
    const bearer = await h.requireBearer(c)
    if (!bearer.ok) return bearer.response
    const result = await h.workspace(c).closeFollowupPlan(bearer.token, c.req.param('id'))
    return result.ok ? c.json<{ plan: FollowupPlanView }>({ plan: result.plan }) : h.refuse(c, result.error)
  })
}
