import { parseClientAction } from './agent-stream-reducer'

export type ConversationType =
  | 'patient_assistant'
  | 'patient_doctor'
  | 'staff_direct'
  | 'staff_group'
  | 'followup_group'

export type ConversationStatus = 'provisioning' | 'active' | 'read_only' | 'archived'
export type ConversationMemberRole = 'owner' | 'member' | 'agent'
export type ConversationMemberStatus = 'pending' | 'active' | 'removed'
export type SenderKind = 'human' | 'agent' | 'system'
export type SendCommandStatus = 'pending' | 'sending' | 'sent' | 'failed'

export type AttachmentKind = 'audio' | 'image'
export type AttachmentStatus = 'pending' | 'uploaded' | 'ready' | 'rejected'
export type TranscriptStatus = 'none' | 'pending' | 'ready' | 'failed' | 'unavailable'

export type CommunicationErrorCode =
  | 'conversation-not-found'
  | 'conversation-read-only'
  | 'conversation-member-forbidden'
  | 'conversation-member-invalid'
  | 'invalid-message-payload'
  | 'im-delivery-failed'
  | 'attachment-not-found'
  | 'attachment-not-ready'
  | 'attachment-invalid'
  | 'attachment-expired'

export type BusinessCardComponent =
  | 'MedicalRecordCard'
  | 'ReportCard'
  | 'AppointmentCard'
  | 'FollowupFormCard'
  | 'TaskCard'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonPrimitive[]
export type JsonRecord = { [key: string]: JsonValue }

export interface UIAction {
  name: string
  args: JsonRecord
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'audio'; attachmentId: string; durationMs: number; transcript?: string | null }
  | { type: 'image'; attachmentId: string }
  | {
      type: 'card'
      component: BusinessCardComponent
      version: 1
      resourceRef: { kind: string; id: string }
      safeProps: JsonRecord
      actions: UIAction[]
    }

export interface ChatMessage {
  schemaVersion: 1
  messageId: string
  clientMessageId: string
  conversationId: string
  senderActorId: string
  senderName: string
  senderKind: SenderKind
  sequence: number
  createdAt: string
  parts: MessagePart[]
  mentions: string[]
  replyTo?: string
  agentRunId?: string
}

export interface ConversationMemberView {
  actorId: string
  displayName: string
  kind: 'human' | 'agent' | 'system'
  actorRole: string
  imUid: string
  role: ConversationMemberRole
  status: ConversationMemberStatus
  joinedAt: string
  removedAt: string | null
  lastReadSeq: number
}

export interface ConversationView {
  conversationId: string
  type: ConversationType
  title: string
  imChannelId: string
  imChannelType: number
  patientId: string | null
  encounterId: string | null
  followupPlanId: string | null
  departmentId: string | null
  status: ConversationStatus
  membershipVersion: number
  lastSequence: number
  lastReadSeq: number
  unreadCount: number
  lastMessagePreview: string | null
  lastMessageAt: string | null
  createdAt: string
  members: ConversationMemberView[]
}

export interface ImCredentialsResponse {
  uid: string
  token: string
  wsUrl: string
  mode: 'live' | 'fake'
}

export interface CreateConversationRequest {
  type: ConversationType
  title?: string
  memberActorIds: string[]
  patientId?: string
  encounterId?: string
  departmentId?: string
}

export interface SendMessageRequest {
  clientMessageId: string
  parts: MessagePart[]
  mentions?: string[]
  replyTo?: string
}

export interface SendMessageResponse {
  commandId: string
  status: SendCommandStatus
  message: ChatMessage | null
  triggeredAgentRuns: Array<{ agentActorId: string; runId: string; conversationId: string }>
}

export interface MessagesPageResponse {
  messages: ChatMessage[]
  nextCursor: number | null
  hasMore: boolean
}

export interface AttachmentView {
  attachmentId: string
  ownerActorId: string
  conversationId: string
  kind: AttachmentKind
  mime: string
  size: number
  durationMs: number | null
  status: AttachmentStatus
  hash: string | null
  transcriptStatus: TranscriptStatus
  transcriptText: string | null
  createdAt: string
}

export interface InitAttachmentRequest {
  conversationId: string
  kind: AttachmentKind
  mime: string
  size: number
  durationMs?: number
}

export interface InitAttachmentResponse {
  attachment: AttachmentView
  uploadUrl: string
  maxBytes: number
  maxDurationMs: number
}

export interface AttachmentAccessResponse {
  attachment: AttachmentView
  url: string
  expiresAt: string
}

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_AUDIO_DURATION_MS = 60_000
export const MAX_TEXT_PART_LENGTH = 4000
export const MAX_MESSAGE_PARTS = 8

const ALLOWED_CARD_COMPONENTS: readonly BusinessCardComponent[] = [
  'MedicalRecordCard',
  'ReportCard',
  'AppointmentCard',
  'FollowupFormCard',
  'TaskCard',
]

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,100}$/
const DISALLOWED_HTML_OR_JS = /<\s*script|javascript:|data:text\/html|onerror\s*=|onload\s*=/i

export function validateMessageParts(raw: unknown): MessagePart[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGE_PARTS) return null
  const parts: MessagePart[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const part = item as Record<string, unknown>
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || !part.text.trim() || part.text.length > MAX_TEXT_PART_LENGTH) return null
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'audio') {
      if (
        typeof part.attachmentId !== 'string' ||
        !SAFE_ID.test(part.attachmentId) ||
        typeof part.durationMs !== 'number' ||
        !Number.isFinite(part.durationMs) ||
        part.durationMs <= 0 ||
        part.durationMs > MAX_AUDIO_DURATION_MS
      ) {
        return null
      }
      parts.push({
        type: 'audio',
        attachmentId: part.attachmentId,
        durationMs: Math.round(part.durationMs),
        ...(typeof part.transcript === 'string' ? { transcript: part.transcript } : {}),
      })
    } else if (part.type === 'image') {
      if (typeof part.attachmentId !== 'string' || !SAFE_ID.test(part.attachmentId)) return null
      parts.push({ type: 'image', attachmentId: part.attachmentId })
    } else if (part.type === 'card') {
      if (
        typeof part.component !== 'string' ||
        !ALLOWED_CARD_COMPONENTS.includes(part.component as BusinessCardComponent) ||
        part.version !== 1 ||
        !part.resourceRef ||
        typeof part.resourceRef !== 'object' ||
        Array.isArray(part.resourceRef)
      ) {
        return null
      }
      const ref = part.resourceRef as Record<string, unknown>
      if (typeof ref.kind !== 'string' || !SAFE_ID.test(ref.kind) || typeof ref.id !== 'string' || !SAFE_ID.test(ref.id)) {
        return null
      }
      if (!part.safeProps || typeof part.safeProps !== 'object' || Array.isArray(part.safeProps)) return null
      const serialized = JSON.stringify(part.safeProps)
      if (serialized.length > 8000 || DISALLOWED_HTML_OR_JS.test(serialized)) return null
      if (!Array.isArray(part.actions) || part.actions.length > 6) return null
      const actions: UIAction[] = []
      for (const act of part.actions) {
        const parsedAction = parseClientAction(act)
        if (!parsedAction) return null
        actions.push({ name: parsedAction.name, args: parsedAction.args as JsonRecord })
      }
      parts.push({
        type: 'card',
        component: part.component as BusinessCardComponent,
        version: 1,
        resourceRef: { kind: ref.kind, id: ref.id },
        safeProps: part.safeProps as JsonRecord,
        actions,
      })
    } else {
      return null
    }
  }
  return parts
}
