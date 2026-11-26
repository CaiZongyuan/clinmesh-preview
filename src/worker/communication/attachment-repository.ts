import type { Principal } from '../../shared/auth'
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MAX_IMAGE_BYTES,
  type AttachmentKind,
  type AttachmentStatus,
  type AttachmentView,
  type InitAttachmentRequest,
  type TranscriptStatus,
} from '../../shared/communication'
import type { EncounterError } from '../../shared/encounter'
import type { AuthRepository } from '../auth/auth-repository'
import { sha256Hex, timingSafeEqual } from '../auth/crypto'
import type { CommunicationRepository } from './communication-repository'

type Refusal = { ok: false; error: EncounterError }
const refuse = (error: EncounterError): Refusal => ({ ok: false, error })

const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/pcm',
])
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

type AttachmentRow = {
  attachment_id: string
  owner_actor_id: string
  conversation_id: string
  kind: AttachmentKind
  mime: string
  size: number
  duration_ms: number | null
  status: AttachmentStatus
  hash: string | null
  transcript_status: TranscriptStatus
  transcript_text: string | null
  created_at: string
  updated_at: string
}

function toView(row: AttachmentRow): AttachmentView {
  return {
    attachmentId: row.attachment_id,
    ownerActorId: row.owner_actor_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    durationMs: row.duration_ms,
    status: row.status,
    hash: row.hash,
    transcriptStatus: row.transcript_status,
    transcriptText: row.transcript_text,
    createdAt: row.created_at,
  }
}

export async function signAttachmentAccess(secret: string, attachmentId: string, expMs: number): Promise<string> {
  return sha256Hex(`att:${secret}:${attachmentId}:${expMs}`)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// Local development attachment store backed by DO SQLite (`attachment_blob`), keeping the exact
// init -> upload -> complete -> short-lived signed access URL contract so swapping to R2/S3 later is isolated here.
export class AttachmentRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: AuthRepository,
    private readonly comm: CommunicationRepository,
  ) {}

  init(principal: Principal, input: InitAttachmentRequest, nowIso: string): { ok: true; attachment: AttachmentView } | Refusal {
    if (!this.comm.isActiveMember(input.conversationId, principal.actorId)) {
      return refuse({ code: 'conversation-member-forbidden', message: '您不是该会话的有效成员，不能上传附件。' })
    }
    const mime = input.mime.trim().toLowerCase().split(';')[0]
    const maxBytes = input.kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES
    if (!Number.isFinite(input.size) || input.size <= 0 || input.size > maxBytes) {
      return refuse({ code: 'attachment-invalid', message: `附件大小须在 1 字节至 ${Math.round(maxBytes / 1024 / 1024)} MiB 之间。` })
    }
    if (input.kind === 'audio') {
      if (!ALLOWED_AUDIO_MIMES.has(mime)) {
        return refuse({ code: 'attachment-invalid', message: `不支持的音频格式：${mime}` })
      }
      if (
        input.durationMs === undefined ||
        !Number.isFinite(input.durationMs) ||
        input.durationMs <= 0 ||
        input.durationMs > MAX_AUDIO_DURATION_MS
      ) {
        return refuse({ code: 'attachment-invalid', message: '语音时长须在 1–60 秒之间。' })
      }
    } else if (!ALLOWED_IMAGE_MIMES.has(mime)) {
      return refuse({ code: 'attachment-invalid', message: `不支持的图片格式：${mime}` })
    }

    const attachmentId = `att_${crypto.randomUUID().slice(0, 12)}`
    this.sql.exec(
      `INSERT INTO attachment (
         attachment_id, owner_actor_id, conversation_id, kind, mime, size, duration_ms,
         status, hash, transcript_status, transcript_text, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, ?)`,
      attachmentId,
      principal.actorId,
      input.conversationId,
      input.kind,
      mime,
      Math.round(input.size),
      input.kind === 'audio' ? Math.round(input.durationMs!) : null,
      input.kind === 'audio' ? 'none' : 'none',
      nowIso,
      nowIso,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'attachment.init',
      resourceType: 'attachment',
      resourceId: attachmentId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, attachment: this.findById(attachmentId)! }
  }

  upload(
    principal: Principal,
    attachmentId: string,
    dataBase64: string,
    byteLength: number,
    hashHex: string,
    nowIso: string,
  ): { ok: true; attachment: AttachmentView } | Refusal {
    const row = this.findRow(attachmentId)
    if (!row || row.owner_actor_id !== principal.actorId) {
      return refuse({ code: 'attachment-not-found', message: `找不到附件 ${attachmentId}` })
    }
    if (row.status !== 'pending' && row.status !== 'uploaded') {
      return refuse({ code: 'attachment-invalid', message: '该附件当前状态不允许重新上传。' })
    }
    const maxBytes = row.kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES
    if (byteLength <= 0 || byteLength > maxBytes) {
      this.sql.exec(`UPDATE attachment SET status = 'rejected', updated_at = ? WHERE attachment_id = ?`, nowIso, attachmentId)
      return refuse({ code: 'attachment-invalid', message: '附件字节大小超出允许范围。' })
    }
    this.sql.exec(
      'INSERT OR REPLACE INTO attachment_blob (attachment_id, data_base64) VALUES (?, ?)',
      attachmentId,
      dataBase64,
    )
    this.sql.exec(
      `UPDATE attachment SET status = 'uploaded', size = ?, hash = ?, updated_at = ? WHERE attachment_id = ?`,
      byteLength,
      hashHex,
      nowIso,
      attachmentId,
    )
    return { ok: true, attachment: this.findById(attachmentId)! }
  }

  complete(
    principal: Principal,
    attachmentId: string,
    transcript: { status: TranscriptStatus; text: string | null },
    nowIso: string,
  ): { ok: true; attachment: AttachmentView } | Refusal {
    const row = this.findRow(attachmentId)
    if (!row || row.owner_actor_id !== principal.actorId) {
      return refuse({ code: 'attachment-not-found', message: `找不到附件 ${attachmentId}` })
    }
    if (row.status === 'ready') {
      return { ok: true, attachment: toView(row) }
    }
    const blob = this.sql
      .exec<{ attachment_id: string }>('SELECT attachment_id FROM attachment_blob WHERE attachment_id = ?', attachmentId)
      .toArray()[0]
    if (row.status !== 'uploaded' || !blob) {
      return refuse({ code: 'attachment-not-ready', message: '附件尚未完成文件上传，请先上传后再确认完成。' })
    }
    this.sql.exec(
      `UPDATE attachment SET status = 'ready', transcript_status = ?, transcript_text = ?, updated_at = ? WHERE attachment_id = ?`,
      row.kind === 'audio' ? transcript.status : 'none',
      row.kind === 'audio' ? transcript.text : null,
      nowIso,
      attachmentId,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'attachment.complete',
      resourceType: 'attachment',
      resourceId: attachmentId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, attachment: this.findById(attachmentId)! }
  }

  authorizeAccess(principal: Principal, attachmentId: string, nowIso: string): { ok: true; attachment: AttachmentView } | Refusal {
    const row = this.findRow(attachmentId)
    if (!row) {
      return refuse({ code: 'attachment-not-found', message: `找不到附件 ${attachmentId}` })
    }
    if (!this.comm.isActiveMember(row.conversation_id, principal.actorId)) {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'attachment.access',
        resourceType: 'attachment',
        resourceId: attachmentId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'attachment-not-found', message: '无权访问该附件。' })
    }
    if (row.status !== 'ready') {
      return refuse({ code: 'attachment-not-ready', message: '该附件尚未就绪。' })
    }
    return { ok: true, attachment: toView(row) }
  }

  async readSignedContent(
    attachmentId: string,
    expMs: number,
    sig: string,
    secret: string,
    nowMs: number,
  ): Promise<{ ok: true; mime: string; dataBase64: string } | Refusal> {
    if (!Number.isFinite(expMs) || expMs <= nowMs) {
      return refuse({ code: 'attachment-expired', message: '附件访问链接已过期，请重新获取授权。' })
    }
    const expected = await signAttachmentAccess(secret, attachmentId, expMs)
    if (!timingSafeEqual(expected, sig)) {
      return refuse({ code: 'forbidden', message: '附件签名无效。' })
    }
    const row = this.findRow(attachmentId)
    if (!row || row.status !== 'ready') {
      return refuse({ code: 'attachment-not-found', message: '找不到附件内容。' })
    }
    const blob = this.sql
      .exec<{ data_base64: string }>('SELECT data_base64 FROM attachment_blob WHERE attachment_id = ?', attachmentId)
      .toArray()[0]
    if (!blob) {
      return refuse({ code: 'attachment-not-found', message: '找不到附件内容。' })
    }
    return { ok: true, mime: row.mime, dataBase64: blob.data_base64 }
  }

  private findRow(attachmentId: string): AttachmentRow | null {
    return this.sql.exec<AttachmentRow>('SELECT * FROM attachment WHERE attachment_id = ?', attachmentId).toArray()[0] ?? null
  }

  private findById(attachmentId: string): AttachmentView | null {
    const row = this.findRow(attachmentId)
    return row ? toView(row) : null
  }
}
