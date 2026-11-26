import type { ActorKind, Principal } from '../../shared/auth'
import type {
  ChatMessage,
  ConversationMemberRole,
  ConversationMemberStatus,
  ConversationMemberView,
  ConversationStatus,
  ConversationType,
  ConversationView,
  CreateConversationRequest,
  MessagePart,
  SendCommandStatus,
  SenderKind,
  SendMessageRequest,
} from '../../shared/communication'
import type { EncounterError } from '../../shared/encounter'
import type { AuthRepository } from '../auth/auth-repository'

type Refusal = { ok: false; error: EncounterError }
const refuse = (error: EncounterError): Refusal => ({ ok: false, error })

type ActorInfoRow = {
  actor_id: string
  kind: ActorKind
  role: string
  display_name: string
  im_uid: string
  status: string
  patient_id: string | null
  staff_id: string | null
}

type ConversationRow = {
  conversation_id: string
  type: ConversationType
  title: string
  im_channel_id: string
  im_channel_type: number
  patient_id: string | null
  encounter_id: string | null
  followup_plan_id: string | null
  department_id: string | null
  status: ConversationStatus
  membership_version: number
  created_by: string
  created_at: string
  updated_at: string
}

type MemberRow = {
  conversation_id: string
  actor_id: string
  display_name: string
  kind: ActorKind
  actor_role: string
  im_uid: string
  role: ConversationMemberRole
  status: ConversationMemberStatus
  joined_at: string
  removed_at: string | null
  last_read_seq: number
}

type MessageMirrorRow = {
  message_id: string
  client_message_id: string
  conversation_id: string
  sequence: number
  sender_actor_id: string
  sender_name: string
  sender_kind: SenderKind
  payload_json: string
  agent_run_id: string | null
  created_at: string
}

export interface PreparedSendCommand {
  mode: 'already_sent' | 'dispatch' | 'reconcile'
  commandId: string
  conversationId: string
  imChannelId: string
  imChannelType: number
  senderActorId: string
  senderImUid: string
  senderName: string
  senderKind: SenderKind
  clientMessageId: string
  payloadJson: string
  existingMessage?: ChatMessage
  activeMemberImUids: string[]
  conversationType: ConversationType
  mentions: string[]
  agentRunId?: string
}

const CHANNEL_TYPE_GROUP = 2

export class CommunicationRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: AuthRepository,
  ) {}

  ensureDemoConversationsSeeded(nowIso: string): void {
    const count = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversation').one().count
    if (count > 0) return

    // Seed baseline conversations covering patient_assistant, patient_doctor, staff_direct, and staff_group (Spec §10).
    this.createSeededConversation(
      'conv_pat01_assistant',
      'patient_assistant',
      'AI 就医助手',
      'direct:patient_assistant:actor_agent_patient_svc:actor_pat_01',
      'pat_01',
      null,
      null,
      null,
      'actor_pat_01',
      [
        { actorId: 'actor_pat_01', role: 'owner' },
        { actorId: 'actor_agent_patient_svc', role: 'agent' },
      ],
      nowIso,
    )
    this.createSeededConversation(
      'conv_pat01_doctor_a',
      'patient_doctor',
      '王明医生',
      'direct:patient_doctor:actor_doctor_a:actor_pat_01',
      'pat_01',
      null,
      null,
      'dept_general',
      'actor_pat_01',
      [
        { actorId: 'actor_pat_01', role: 'owner' },
        { actorId: 'actor_doctor_a', role: 'member' },
      ],
      nowIso,
    )
    this.createSeededConversation(
      'conv_staff_wang_zhou',
      'staff_direct',
      '王明 / 周岚',
      'direct:staff_direct:actor_doctor_a:actor_nurse_n',
      null,
      null,
      null,
      'dept_general',
      'actor_doctor_a',
      [
        { actorId: 'actor_doctor_a', role: 'owner' },
        { actorId: 'actor_nurse_n', role: 'member' },
      ],
      nowIso,
    )
    this.createSeededConversation(
      'conv_dept_general_group',
      'staff_group',
      '全科医护协作群',
      null,
      null,
      null,
      null,
      'dept_general',
      'actor_doctor_a',
      [
        { actorId: 'actor_doctor_a', role: 'owner' },
        { actorId: 'actor_doctor_b', role: 'member' },
        { actorId: 'actor_nurse_n', role: 'member' },
      ],
      nowIso,
    )
  }

  private createSeededConversation(
    conversationId: string,
    type: ConversationType,
    title: string,
    directKey: string | null,
    patientId: string | null,
    encounterId: string | null,
    followupPlanId: string | null,
    departmentId: string | null,
    createdBy: string,
    members: Array<{ actorId: string; role: ConversationMemberRole }>,
    nowIso: string,
  ): void {
    const channelId = `cm_${conversationId}`
    this.sql.exec(
      `INSERT INTO conversation (
         conversation_id, type, title, im_channel_id, im_channel_type, direct_key,
         patient_id, encounter_id, followup_plan_id, department_id, status, membership_version,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      conversationId,
      type,
      title,
      channelId,
      CHANNEL_TYPE_GROUP,
      directKey,
      patientId,
      encounterId,
      followupPlanId,
      departmentId,
      createdBy,
      nowIso,
      nowIso,
    )
    for (const m of members) {
      this.sql.exec(
        `INSERT INTO conversation_member (conversation_id, actor_id, role, status, joined_at, removed_at, last_read_seq)
         VALUES (?, ?, ?, 'active', ?, NULL, 0)`,
        conversationId,
        m.actorId,
        m.role,
        nowIso,
      )
    }
  }

  getOrIssueImToken(actorId: string, imUid: string, newToken: string, nowIso: string): { token: string; created: boolean } {
    const row = this.sql.exec<{ token: string }>('SELECT token FROM im_user_token WHERE actor_id = ?', actorId).toArray()[0]
    if (row) return { token: row.token, created: false }
    this.sql.exec(
      `INSERT INTO im_user_token (actor_id, im_uid, token, version, updated_at) VALUES (?, ?, ?, 1, ?)`,
      actorId,
      imUid,
      newToken,
      nowIso,
    )
    return { token: newToken, created: true }
  }

  rotateImToken(actorId: string, imUid: string, newToken: string, nowIso: string): void {
    this.sql.exec(
      `INSERT INTO im_user_token (actor_id, im_uid, token, version, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (actor_id) DO UPDATE SET token = excluded.token, version = version + 1, updated_at = excluded.updated_at`,
      actorId,
      imUid,
      newToken,
      nowIso,
    )
  }

  createConversation(
    principal: Principal,
    input: CreateConversationRequest,
    nowIso: string,
    opts?: { followupPlanId?: string; conversationId?: string },
  ): { ok: true; conversation: ConversationView; created: boolean; subscriberImUids: string[] } | Refusal {
    const memberIds = Array.from(new Set([principal.actorId, ...input.memberActorIds]))
    const actors = this.loadActors(memberIds)
    if (actors.length !== memberIds.length) {
      return refuse({ code: 'conversation-member-invalid', message: '会话成员包含不存在或已停用的账号。' })
    }

    const others = actors.filter((a) => a.actor_id !== principal.actorId)

    // Authorization checks per conversation type (Spec §7.1).
    if (input.type === 'patient_assistant') {
      if (principal.role !== 'patient' || !principal.patientId) {
        return refuse({ code: 'forbidden', message: '仅患者本人可创建或访问患者专属 AI 就医助手会话。' })
      }
      if (others.length !== 1 || others[0].actor_id !== 'actor_agent_patient_svc') {
        return refuse({ code: 'conversation-member-forbidden', message: '患者助手会话仅允许患者本人与 AI 就医助手参与。' })
      }
    } else if (input.type === 'patient_doctor') {
      if (others.length !== 1) {
        return refuse({ code: 'invalid-request', message: '医患私聊须为 1 对 1 会话。' })
      }
      const other = others[0]
      const patientActor = principal.role === 'patient' ? this.loadActors([principal.actorId])[0] : other
      const staffActor = principal.role === 'patient' ? other : this.loadActors([principal.actorId])[0]
      if (!patientActor?.patient_id || !staffActor?.staff_id) {
        return refuse({ code: 'conversation-member-forbidden', message: '医患私聊仅允许患者与其服务关系内的医护人员建立。' })
      }
      if (!this.hasCareRelationship(patientActor.patient_id, staffActor.staff_id)) {
        return refuse({ code: 'conversation-member-forbidden', message: '双方未建立授权医疗服务关系，无法发起会话。' })
      }
    } else if (input.type === 'staff_direct') {
      if (!principal.staffId || others.length !== 1 || !others[0].staff_id) {
        return refuse({ code: 'conversation-member-forbidden', message: '医护私聊仅允许本院医护人员之间建立。' })
      }
    } else if (input.type === 'staff_group') {
      if (!principal.staffId) {
        return refuse({ code: 'conversation-member-forbidden', message: '仅医护人员可创建科室或内部协作群。' })
      }
      if (actors.some((a) => a.role === 'patient')) {
        return refuse({ code: 'conversation-member-forbidden', message: '医护内部群不可直接添加患者，请使用随访群。' })
      }
    } else if (input.type === 'followup_group') {
      if (!principal.staffId) {
        return refuse({ code: 'conversation-member-forbidden', message: '仅授权医护人员可创建随访群。' })
      }
      const patientMembers = actors.filter((a) => a.role === 'patient')
      if (patientMembers.length !== 1 || !patientMembers[0].patient_id) {
        return refuse({ code: 'conversation-member-invalid', message: '随访群须绑定且仅绑定一名患者。' })
      }
      if (!this.hasCareRelationship(patientMembers[0].patient_id, principal.staffId)) {
        return refuse({ code: 'conversation-member-forbidden', message: '未与该患者建立授权医疗服务关系，无法创建随访群。' })
      }
    }

    const isDirect =
      input.type === 'patient_assistant' || input.type === 'patient_doctor' || input.type === 'staff_direct'
    const directKey = isDirect ? `direct:${input.type}:${[...memberIds].sort().join(':')}` : null

    if (directKey) {
      const existing = this.sql
        .exec<{ conversation_id: string }>('SELECT conversation_id FROM conversation WHERE direct_key = ?', directKey)
        .toArray()[0]
      if (existing) {
        const view = this.loadConversationView(existing.conversation_id, principal.actorId)!
        return {
          ok: true,
          conversation: view,
          created: false,
          subscriberImUids: view.members.filter((m) => m.status === 'active').map((m) => m.imUid),
        }
      }
    }

    const conversationId = opts?.conversationId ?? `conv_${crypto.randomUUID().slice(0, 12)}`
    const imChannelId = `cm_${conversationId}`
    const patientMember = actors.find((a) => a.patient_id !== null)
    const resolvedPatientId = input.patientId ?? patientMember?.patient_id ?? null
    const defaultTitle =
      input.title?.trim() ||
      (input.type === 'patient_assistant'
        ? 'AI 就医助手'
        : isDirect
          ? others[0].display_name
          : input.type === 'followup_group'
            ? `${patientMember?.display_name ?? '患者'}随访群`
            : '医护协作群')

    this.sql.exec(
      `INSERT INTO conversation (
         conversation_id, type, title, im_channel_id, im_channel_type, direct_key,
         patient_id, encounter_id, followup_plan_id, department_id, status, membership_version,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', 1, ?, ?, ?)`,
      conversationId,
      input.type,
      defaultTitle,
      imChannelId,
      CHANNEL_TYPE_GROUP,
      directKey,
      resolvedPatientId,
      input.encounterId ?? null,
      opts?.followupPlanId ?? null,
      input.departmentId ?? principal.departmentId ?? null,
      principal.actorId,
      nowIso,
      nowIso,
    )

    for (const actor of actors) {
      const role: ConversationMemberRole =
        actor.kind === 'agent' ? 'agent' : actor.actor_id === principal.actorId ? 'owner' : 'member'
      this.sql.exec(
        `INSERT INTO conversation_member (conversation_id, actor_id, role, status, joined_at, removed_at, last_read_seq)
         VALUES (?, ?, ?, 'pending', ?, NULL, 0)`,
        conversationId,
        actor.actor_id,
        role,
        nowIso,
      )
    }

    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'conversation.create',
      resourceType: 'conversation',
      resourceId: conversationId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    const view = this.loadConversationView(conversationId, principal.actorId)!
    return {
      ok: true,
      conversation: view,
      created: true,
      subscriberImUids: actors.map((a) => a.im_uid),
    }
  }

  activateProvisionedConversation(conversationId: string, nowIso: string): ConversationView | null {
    this.sql.exec(
      `UPDATE conversation SET status = 'active', updated_at = ? WHERE conversation_id = ? AND status = 'provisioning'`,
      nowIso,
      conversationId,
    )
    this.sql.exec(
      `UPDATE conversation_member SET status = 'active' WHERE conversation_id = ? AND status = 'pending'`,
      conversationId,
    )
    const row = this.sql
      .exec<{ created_by: string }>('SELECT created_by FROM conversation WHERE conversation_id = ?', conversationId)
      .toArray()[0]
    return row ? this.loadConversationView(conversationId, row.created_by) : null
  }

  listConversations(principal: Principal): ConversationView[] {
    const rows = this.sql
      .exec<{ conversation_id: string }>(
        `SELECT c.conversation_id
         FROM conversation c
         JOIN conversation_member m ON m.conversation_id = c.conversation_id
         WHERE m.actor_id = ? AND m.status = 'active'
         ORDER BY c.updated_at DESC, c.conversation_id ASC`,
        principal.actorId,
      )
      .toArray()
    return rows.map((r) => this.loadConversationView(r.conversation_id, principal.actorId)!).filter(Boolean)
  }

  getConversation(principal: Principal, conversationId: string): { ok: true; conversation: ConversationView } | Refusal {
    if (!this.isActiveMember(conversationId, principal.actorId)) {
      return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权访问。' })
    }
    const view = this.loadConversationView(conversationId, principal.actorId)
    if (!view) return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权访问。' })
    return { ok: true, conversation: view }
  }

  addMember(
    principal: Principal,
    conversationId: string,
    targetActorId: string,
    nowIso: string,
  ): { ok: true; conversation: ConversationView; targetImUid: string; imChannelId: string; imChannelType: number } | Refusal {
    const conv = this.findConversationRow(conversationId)
    if (!conv || !this.isActiveMember(conversationId, principal.actorId)) {
      return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权管理成员。' })
    }
    if (!principal.staffId) {
      return refuse({ code: 'conversation-member-forbidden', message: '患者无权邀请成员加入会话。' })
    }
    if (conv.status !== 'active') {
      return refuse({ code: 'conversation-read-only', message: '当前会话为只读或归档状态，不能调整成员。' })
    }
    if (conv.type !== 'staff_group' && conv.type !== 'followup_group') {
      return refuse({ code: 'conversation-member-forbidden', message: '私聊会话不支持邀请新成员。' })
    }
    const target = this.loadActors([targetActorId])[0]
    if (!target) {
      return refuse({ code: 'conversation-member-invalid', message: `找不到有效成员 ${targetActorId}` })
    }
    if (conv.type === 'staff_group' && target.role === 'patient') {
      return refuse({ code: 'conversation-member-forbidden', message: '医护内部群不可邀请患者。' })
    }
    if (conv.type === 'followup_group' && target.role === 'patient' && target.patient_id !== conv.patient_id) {
      return refuse({ code: 'conversation-member-forbidden', message: '随访群不可加入其他患者。' })
    }
    if (target.kind === 'agent' && target.actor_id !== 'actor_agent_followup') {
      return refuse({ code: 'conversation-member-forbidden', message: '该群仅允许邀请授权的随访助手 Agent。' })
    }

    const memberRole: ConversationMemberRole = target.kind === 'agent' ? 'agent' : 'member'
    this.sql.exec(
      `INSERT INTO conversation_member (conversation_id, actor_id, role, status, joined_at, removed_at, last_read_seq)
       VALUES (?, ?, ?, 'active', ?, NULL, 0)
       ON CONFLICT (conversation_id, actor_id) DO UPDATE SET role = excluded.role, status = 'active', removed_at = NULL`,
      conversationId,
      targetActorId,
      memberRole,
      nowIso,
    )
    this.sql.exec(
      `UPDATE conversation SET membership_version = membership_version + 1, updated_at = ? WHERE conversation_id = ?`,
      nowIso,
      conversationId,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'conversation.member.add',
      resourceType: 'conversation',
      resourceId: `${conversationId}:${targetActorId}`,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    return {
      ok: true,
      conversation: this.loadConversationView(conversationId, principal.actorId)!,
      targetImUid: target.im_uid,
      imChannelId: conv.im_channel_id,
      imChannelType: conv.im_channel_type,
    }
  }

  removeMember(
    principal: Principal,
    conversationId: string,
    targetActorId: string,
    nowIso: string,
  ): { ok: true; conversation: ConversationView; targetImUid: string; imChannelId: string; imChannelType: number } | Refusal {
    const conv = this.findConversationRow(conversationId)
    if (!conv || !this.isActiveMember(conversationId, principal.actorId)) {
      return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权管理成员。' })
    }
    if (!principal.staffId) {
      return refuse({ code: 'conversation-member-forbidden', message: '患者无权移除会话成员。' })
    }
    const target = this.loadActors([targetActorId])[0]
    if (!target) {
      return refuse({ code: 'conversation-member-invalid', message: `找不到成员 ${targetActorId}` })
    }
    // Fail-closed: revoke HIS membership first before projecting removal to WuKongIM.
    this.sql.exec(
      `UPDATE conversation_member SET status = 'removed', removed_at = ? WHERE conversation_id = ? AND actor_id = ?`,
      nowIso,
      conversationId,
      targetActorId,
    )
    this.sql.exec(
      `UPDATE conversation SET membership_version = membership_version + 1, updated_at = ? WHERE conversation_id = ?`,
      nowIso,
      conversationId,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'conversation.member.remove',
      resourceType: 'conversation',
      resourceId: `${conversationId}:${targetActorId}`,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return {
      ok: true,
      conversation: this.loadConversationView(conversationId, principal.actorId)!,
      targetImUid: target.im_uid,
      imChannelId: conv.im_channel_id,
      imChannelType: conv.im_channel_type,
    }
  }

  setConversationStatus(conversationId: string, status: ConversationStatus, nowIso: string): void {
    this.sql.exec(
      'UPDATE conversation SET status = ?, updated_at = ? WHERE conversation_id = ?',
      status,
      nowIso,
      conversationId,
    )
  }

  prepareSendCommand(
    senderActorId: string,
    senderKind: SenderKind,
    conversationId: string,
    input: SendMessageRequest,
    nowIso: string,
    opts?: { agentRunId?: string; allowReadOnlySystem?: boolean },
  ): { ok: true; prepared: PreparedSendCommand } | Refusal {
    const conv = this.findConversationRow(conversationId)
    if (!conv) {
      return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权访问。' })
    }
    if (senderKind !== 'system' && !this.isActiveMember(conversationId, senderActorId)) {
      return refuse({ code: 'conversation-member-forbidden', message: '您不是该会话的有效成员，无法发送消息。' })
    }
    if (conv.status !== 'active' && !opts?.allowReadOnlySystem) {
      return refuse({ code: 'conversation-read-only', message: '该会话已设为只读或已归档，无法继续发送消息。' })
    }

    // Verify all referenced attachments are ready and belong to this conversation.
    for (const part of input.parts) {
      if (part.type === 'audio' || part.type === 'image') {
        const att = this.sql
          .exec<{ status: string; conversation_id: string; kind: string }>(
            'SELECT status, conversation_id, kind FROM attachment WHERE attachment_id = ?',
            part.attachmentId,
          )
          .toArray()[0]
        if (!att || att.conversation_id !== conversationId || att.kind !== part.type) {
          return refuse({ code: 'attachment-not-found', message: `附件 ${part.attachmentId} 不存在或不属于当前会话。` })
        }
        if (att.status !== 'ready') {
          return refuse({ code: 'attachment-not-ready', message: `附件 ${part.attachmentId} 尚未上传完成，不能发送。` })
        }
      }
    }

    const sender = this.loadActors([senderActorId])[0]
    if (!sender) {
      return refuse({ code: 'forbidden', message: '发送者身份无效。' })
    }

    const activeMembers = this.loadMembers(conversationId).filter((m) => m.status === 'active')
    const activeMemberImUids = activeMembers.map((m) => m.imUid)

    const existing = this.sql
      .exec<{
        command_id: string
        status: SendCommandStatus
        payload_json: string
        external_message_id: string | null
        sequence: number | null
      }>(
        'SELECT command_id, status, payload_json, external_message_id, sequence FROM send_command WHERE conversation_id = ? AND client_message_id = ?',
        conversationId,
        input.clientMessageId,
      )
      .toArray()[0]

    const mentions = Array.from(new Set(input.mentions ?? []))

    if (existing) {
      if (existing.status === 'sent' && existing.external_message_id) {
        const mirrored = this.findMessageByClientId(conversationId, input.clientMessageId)
        if (mirrored) {
          return {
            ok: true,
            prepared: {
              mode: 'already_sent',
              commandId: existing.command_id,
              conversationId,
              imChannelId: conv.im_channel_id,
              imChannelType: conv.im_channel_type,
              senderActorId,
              senderImUid: sender.im_uid,
              senderName: sender.display_name,
              senderKind,
              clientMessageId: input.clientMessageId,
              payloadJson: existing.payload_json,
              existingMessage: mirrored,
              activeMemberImUids,
              conversationType: conv.type,
              mentions,
              agentRunId: opts?.agentRunId,
            },
          }
        }
      }
      // Uncertain (`sending`) or previously `failed`: reconcile against IM messagesync before any retry (ADR-0004).
      this.sql.exec(
        `UPDATE send_command SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE command_id = ?`,
        nowIso,
        existing.command_id,
      )
      return {
        ok: true,
        prepared: {
          mode: 'reconcile',
          commandId: existing.command_id,
          conversationId,
          imChannelId: conv.im_channel_id,
          imChannelType: conv.im_channel_type,
          senderActorId,
          senderImUid: sender.im_uid,
          senderName: sender.display_name,
          senderKind,
          clientMessageId: input.clientMessageId,
          payloadJson: existing.payload_json,
          activeMemberImUids,
          conversationType: conv.type,
          mentions,
          agentRunId: opts?.agentRunId,
        },
      }
    }

    const commandId = `cmd_${crypto.randomUUID().slice(0, 12)}`
    const envelopePayload = JSON.stringify({
      schemaVersion: 1,
      clientMessageId: input.clientMessageId,
      senderActorId,
      senderName: sender.display_name,
      senderKind,
      parts: input.parts,
      mentions,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(opts?.agentRunId ? { agentRunId: opts.agentRunId } : {}),
    })

    this.sql.exec(
      `INSERT INTO send_command (
         command_id, conversation_id, client_message_id, actor_id, payload_json,
         status, attempts, external_message_id, sequence, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'sending', 1, NULL, NULL, NULL, ?, ?)`,
      commandId,
      conversationId,
      input.clientMessageId,
      senderActorId,
      envelopePayload,
      nowIso,
      nowIso,
    )

    return {
      ok: true,
      prepared: {
        mode: 'dispatch',
        commandId,
        conversationId,
        imChannelId: conv.im_channel_id,
        imChannelType: conv.im_channel_type,
        senderActorId,
        senderImUid: sender.im_uid,
        senderName: sender.display_name,
        senderKind,
        clientMessageId: input.clientMessageId,
        payloadJson: envelopePayload,
        activeMemberImUids,
        conversationType: conv.type,
        mentions,
        agentRunId: opts?.agentRunId,
      },
    }
  }

  settleSendCommandSuccess(
    prepared: PreparedSendCommand,
    externalMessageId: string,
    sequence: number,
    nowIso: string,
  ): { message: ChatMessage; triggerAgents: Array<{ agentActorId: string; conversationType: ConversationType }> } {
    this.sql.exec(
      `UPDATE send_command
       SET status = 'sent', external_message_id = ?, sequence = ?, last_error = NULL, updated_at = ?
       WHERE command_id = ?`,
      externalMessageId,
      sequence,
      nowIso,
      prepared.commandId,
    )
    this.sql.exec(
      `INSERT OR IGNORE INTO im_message_mirror (
         message_id, client_message_id, conversation_id, sequence, sender_actor_id, sender_kind, payload_json, agent_run_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      externalMessageId,
      prepared.clientMessageId,
      prepared.conversationId,
      sequence,
      prepared.senderActorId,
      prepared.senderKind,
      prepared.payloadJson,
      prepared.agentRunId ?? null,
      nowIso,
    )
    this.sql.exec('UPDATE conversation SET updated_at = ? WHERE conversation_id = ?', nowIso, prepared.conversationId)
    this.sql.exec(
      `UPDATE conversation_member
       SET last_read_seq = MAX(last_read_seq, ?)
       WHERE conversation_id = ? AND actor_id = ? AND status = 'active'`,
      sequence,
      prepared.conversationId,
      prepared.senderActorId,
    )

    const message = this.findMessageByClientId(prepared.conversationId, prepared.clientMessageId)!

    // Prevent agent-to-agent infinite loops: only human messages auto-trigger agents.
    const triggerAgents: Array<{ agentActorId: string; conversationType: ConversationType }> = []
    if (prepared.senderKind === 'human') {
      const activeAgents = this.loadMembers(prepared.conversationId).filter(
        (m) => m.status === 'active' && m.kind === 'agent',
      )
      if (prepared.conversationType === 'patient_assistant') {
        for (const a of activeAgents) {
          if (a.actorId === 'actor_agent_patient_svc') {
            triggerAgents.push({ agentActorId: a.actorId, conversationType: prepared.conversationType })
          }
        }
      } else {
        for (const a of activeAgents) {
          if (
            prepared.mentions.includes(a.actorId) ||
            prepared.mentions.includes(a.imUid) ||
            prepared.mentions.includes(a.displayName)
          ) {
            triggerAgents.push({ agentActorId: a.actorId, conversationType: prepared.conversationType })
          }
        }
      }
    }

    return { message, triggerAgents }
  }

  settleSendCommandFailure(commandId: string, errorMessage: string, nowIso: string): void {
    this.sql.exec(
      `UPDATE send_command SET status = 'failed', last_error = ?, updated_at = ? WHERE command_id = ? AND status != 'sent'`,
      errorMessage.slice(0, 400),
      nowIso,
      commandId,
    )
  }

  listMessages(
    principal: Principal,
    conversationId: string,
    options: { cursor?: number; limit?: number } = {},
  ): { ok: true; messages: ChatMessage[]; nextCursor: number | null; hasMore: boolean } | Refusal {
    if (!this.isActiveMember(conversationId, principal.actorId)) {
      return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权查看消息历史。' })
    }
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100)
    const rows =
      options.cursor && options.cursor > 0
        ? this.sql
            .exec<MessageMirrorRow>(
              `SELECT m.message_id, m.client_message_id, m.conversation_id, m.sequence,
                      m.sender_actor_id, a.display_name AS sender_name, m.sender_kind,
                      m.payload_json, m.agent_run_id, m.created_at
               FROM im_message_mirror m
               JOIN actor a ON a.actor_id = m.sender_actor_id
               WHERE m.conversation_id = ? AND m.sequence < ?
               ORDER BY m.sequence DESC
               LIMIT ?`,
              conversationId,
              options.cursor,
              limit + 1,
            )
            .toArray()
        : this.sql
            .exec<MessageMirrorRow>(
              `SELECT m.message_id, m.client_message_id, m.conversation_id, m.sequence,
                      m.sender_actor_id, a.display_name AS sender_name, m.sender_kind,
                      m.payload_json, m.agent_run_id, m.created_at
               FROM im_message_mirror m
               JOIN actor a ON a.actor_id = m.sender_actor_id
               WHERE m.conversation_id = ?
               ORDER BY m.sequence DESC
               LIMIT ?`,
              conversationId,
              limit + 1,
            )
            .toArray()

    const hasMore = rows.length > limit
    const pageDesc = hasMore ? rows.slice(0, limit) : rows
    const messages = pageDesc.reverse().map(toChatMessage)
    const nextCursor = hasMore && messages.length > 0 ? messages[0].sequence : null
    return { ok: true, messages, nextCursor, hasMore }
  }

  listRecentMessagesForAgent(conversationId: string, limit = 12): ChatMessage[] {
    const rows = this.sql
      .exec<MessageMirrorRow>(
        `SELECT m.message_id, m.client_message_id, m.conversation_id, m.sequence,
                m.sender_actor_id, a.display_name AS sender_name, m.sender_kind,
                m.payload_json, m.agent_run_id, m.created_at
         FROM im_message_mirror m
         JOIN actor a ON a.actor_id = m.sender_actor_id
         WHERE m.conversation_id = ?
         ORDER BY m.sequence DESC
         LIMIT ?`,
        conversationId,
        limit,
      )
      .toArray()
    return rows.reverse().map(toChatMessage)
  }

  markRead(
    principal: Principal,
    conversationId: string,
    seq: number,
  ): { ok: true; lastReadSeq: number; unreadCount: number } | Refusal {
    if (!this.isActiveMember(conversationId, principal.actorId)) {
      return refuse({ code: 'conversation-not-found', message: '找不到该会话或无权更新已读位置。' })
    }
    const maxSeq = this.lastSequence(conversationId)
    const clamped = Math.min(Math.max(0, Math.floor(seq)), maxSeq)
    this.sql.exec(
      `UPDATE conversation_member
       SET last_read_seq = MAX(last_read_seq, ?)
       WHERE conversation_id = ? AND actor_id = ? AND status = 'active'`,
      clamped,
      conversationId,
      principal.actorId,
    )
    const updated = this.sql
      .exec<{ last_read_seq: number }>(
        'SELECT last_read_seq FROM conversation_member WHERE conversation_id = ? AND actor_id = ?',
        conversationId,
        principal.actorId,
      )
      .one().last_read_seq
    return { ok: true, lastReadSeq: updated, unreadCount: Math.max(0, maxSeq - updated) }
  }

  isActiveMember(conversationId: string, actorId: string): boolean {
    const row = this.sql
      .exec<{ status: string }>(
        'SELECT status FROM conversation_member WHERE conversation_id = ? AND actor_id = ?',
        conversationId,
        actorId,
      )
      .toArray()[0]
    return row?.status === 'active'
  }

  getConversationContextForAgent(conversationId: string) {
    const conv = this.findConversationRow(conversationId)
    if (!conv) return null
    return {
      conversationId: conv.conversation_id,
      type: conv.type,
      status: conv.status,
      patientId: conv.patient_id,
      followupPlanId: conv.followup_plan_id,
      membershipVersion: conv.membership_version,
      members: this.loadMembers(conversationId),
    }
  }

  private findConversationRow(conversationId: string): ConversationRow | null {
    return (
      this.sql
        .exec<ConversationRow>('SELECT * FROM conversation WHERE conversation_id = ?', conversationId)
        .toArray()[0] ?? null
    )
  }

  private loadConversationView(conversationId: string, viewerActorId: string): ConversationView | null {
    const conv = this.findConversationRow(conversationId)
    if (!conv) return null
    const members = this.loadMembers(conversationId)
    const lastSeq = this.lastSequence(conversationId)
    const viewer = members.find((m) => m.actorId === viewerActorId)
    const lastReadSeq = viewer?.lastReadSeq ?? 0
    const latest = this.sql
      .exec<{ payload_json: string; created_at: string }>(
        'SELECT payload_json, created_at FROM im_message_mirror WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1',
        conversationId,
      )
      .toArray()[0]

    return {
      conversationId: conv.conversation_id,
      type: conv.type,
      title: conv.title,
      imChannelId: conv.im_channel_id,
      imChannelType: conv.im_channel_type,
      patientId: conv.patient_id,
      encounterId: conv.encounter_id,
      followupPlanId: conv.followup_plan_id,
      departmentId: conv.department_id,
      status: conv.status,
      membershipVersion: conv.membership_version,
      lastSequence: lastSeq,
      lastReadSeq,
      unreadCount: Math.max(0, lastSeq - lastReadSeq),
      lastMessagePreview: latest ? previewOfPayload(latest.payload_json) : null,
      lastMessageAt: latest?.created_at ?? null,
      createdAt: conv.created_at,
      members,
    }
  }

  private loadMembers(conversationId: string): ConversationMemberView[] {
    return this.sql
      .exec<MemberRow>(
        `SELECT m.conversation_id, m.actor_id, a.display_name, a.kind, a.role AS actor_role, a.im_uid,
                m.role, m.status, m.joined_at, m.removed_at, m.last_read_seq
         FROM conversation_member m
         JOIN actor a ON a.actor_id = m.actor_id
         WHERE m.conversation_id = ?
         ORDER BY m.joined_at ASC, m.actor_id ASC`,
        conversationId,
      )
      .toArray()
      .map((row) => ({
        actorId: row.actor_id,
        displayName: row.display_name,
        kind: row.kind,
        actorRole: row.actor_role,
        imUid: row.im_uid,
        role: row.role,
        status: row.status,
        joinedAt: row.joined_at,
        removedAt: row.removed_at,
        lastReadSeq: row.last_read_seq,
      }))
  }

  private loadActors(actorIds: string[]): ActorInfoRow[] {
    if (actorIds.length === 0) return []
    const placeholders = actorIds.map(() => '?').join(', ')
    return this.sql
      .exec<ActorInfoRow>(
        `SELECT a.actor_id, a.kind, a.role, a.display_name, a.im_uid, a.status,
                p.patient_id, st.staff_id
         FROM actor a
         LEFT JOIN patient_profile p ON p.actor_id = a.actor_id
         LEFT JOIN staff_profile st ON st.actor_id = a.actor_id
         WHERE a.status = 'active' AND a.actor_id IN (${placeholders})`,
        ...actorIds,
      )
      .toArray()
  }

  private hasCareRelationship(patientId: string, staffId: string): boolean {
    const row = this.sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM care_relationship WHERE patient_id = ? AND staff_id = ?',
        patientId,
        staffId,
      )
      .one()
    return row.count > 0
  }

  private lastSequence(conversationId: string): number {
    return (
      this.sql
        .exec<{ seq: number | null }>('SELECT MAX(sequence) AS seq FROM im_message_mirror WHERE conversation_id = ?', conversationId)
        .one().seq ?? 0
    )
  }

  private findMessageByClientId(conversationId: string, clientMessageId: string): ChatMessage | null {
    const row = this.sql
      .exec<MessageMirrorRow>(
        `SELECT m.message_id, m.client_message_id, m.conversation_id, m.sequence,
                m.sender_actor_id, a.display_name AS sender_name, m.sender_kind,
                m.payload_json, m.agent_run_id, m.created_at
         FROM im_message_mirror m
         JOIN actor a ON a.actor_id = m.sender_actor_id
         WHERE m.conversation_id = ? AND m.client_message_id = ?`,
        conversationId,
        clientMessageId,
      )
      .toArray()[0]
    return row ? toChatMessage(row) : null
  }
}

function toChatMessage(row: MessageMirrorRow): ChatMessage {
  const payload = JSON.parse(row.payload_json) as {
    parts?: MessagePart[]
    mentions?: string[]
    replyTo?: string
    agentRunId?: string
  }
  return {
    schemaVersion: 1,
    messageId: row.message_id,
    clientMessageId: row.client_message_id,
    conversationId: row.conversation_id,
    senderActorId: row.sender_actor_id,
    senderName: row.sender_name,
    senderKind: row.sender_kind,
    sequence: row.sequence,
    createdAt: row.created_at,
    parts: payload.parts ?? [],
    mentions: payload.mentions ?? [],
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    ...(row.agent_run_id ?? payload.agentRunId ? { agentRunId: row.agent_run_id ?? payload.agentRunId } : {}),
  }
}

function previewOfPayload(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { parts?: MessagePart[] }
    const first = parsed.parts?.[0]
    if (!first) return ''
    if (first.type === 'text') return first.text.slice(0, 60)
    if (first.type === 'audio') return `[语音 ${Math.max(1, Math.round(first.durationMs / 1000))}"]`
    if (first.type === 'image') return '[图片]'
    if (first.type === 'card') return `[卡片] ${String(first.safeProps.title ?? first.component)}`
    return ''
  } catch {
    return ''
  }
}
