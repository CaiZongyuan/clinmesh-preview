import type { ClinicFeedback, NotificationData } from './clinic-feedback'
import { showUndoToast } from './clinic-feedback'
import { chunkText, streamTextDuration } from './clinic-motion'
import {
  createInitialClinicState,
  nowClock,
  PATIENTS,
  STAFF_ACTORS,
  type AgentRunRecord,
  type AgentStream,
  type BookingResult,
  type ChatMessage,
  type ClinicActions,
  type ClinicConversation,
  type ClinicSide,
  type ConnectedClinicState,
  type MessagePart,
  type SyncEvent,
} from './connected-clinic-store'
import { planPatientAgentReply } from './patient-agent-script'

export interface ClinicStore {
  get: () => ConnectedClinicState
  update: (recipe: (prev: ConnectedClinicState) => ConnectedClinicState) => void
  subscribe: (listener: () => void) => () => void
}

export function createClinicStore(initial: ConnectedClinicState): ClinicStore {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    update(recipe) {
      const next = recipe(state)
      if (next === state) return
      state = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const SEND_SETTLE_MS = 650
const ASR_SETTLE_MS = 1300

let counter = 0
function uid(prefix: string) {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`
}

function withEvent(
  state: ConnectedClinicState,
  owner: SyncEvent['owner'],
  origin: SyncEvent['origin'],
  summary: string,
  tone: SyncEvent['tone'] = 'info',
): ConnectedClinicState {
  return {
    ...state,
    syncEvents: [{ id: uid('ev'), at: nowClock(), owner, origin, summary, tone }, ...state.syncEvents].slice(0, 30),
  }
}

function nextSequence(conversation: ClinicConversation) {
  return (conversation.messages.at(-1)?.sequence ?? 0) + 1
}

function patchConversation(
  state: ConnectedClinicState,
  conversationId: string,
  patch: (conversation: ClinicConversation) => ClinicConversation,
): ConnectedClinicState {
  return { ...state, conversations: state.conversations.map((c) => (c.id === conversationId ? patch(c) : c)) }
}

function patchMessage(
  state: ConnectedClinicState,
  conversationId: string,
  messageId: string,
  patch: (message: ChatMessage) => ChatMessage,
): ConnectedClinicState {
  return patchConversation(state, conversationId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? patch(m) : m)),
  }))
}

function findMessage(state: ConnectedClinicState, messageId: string) {
  for (const conversation of state.conversations) {
    const message = conversation.messages.find((m) => m.id === messageId)
    if (message) return { conversation, message }
  }
  return null
}

function previewOf(parts: MessagePart[]) {
  const first = parts[0]
  if (!first) return ''
  if (first.type === 'text') return first.text
  if (first.type === 'audio') return `[语音 ${first.durationSec}″] ${first.transcript ?? ''}`
  return `[${first.title}]`
}

export function createClinicActions(store: ClinicStore, feedback: ClinicFeedback): ClinicActions {
  const focus: Record<ClinicSide, string | null> = { staff: null, patient: null }
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const later = (key: string, ms: number, run: () => void) => {
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        run()
      }, ms),
    )
  }

  const notifyPatient = (
    conversation: ClinicConversation | undefined,
    title: string,
    description: string,
    data: Omit<NotificationData, 'at'>,
  ) => {
    const state = store.get()
    const patientKey = conversation?.patientKey
    if (!patientKey || patientKey !== state.currentPatient) return undefined
    if (conversation && focus.patient === conversation.id) return undefined
    return feedback.notify.patient({ title, description, data: { ...data, at: nowClock() } })
  }

  const notifyPatientOf = (patientKey: string, title: string, description: string, data: Omit<NotificationData, 'at'>) => {
    if (patientKey !== store.get().currentPatient) return undefined
    return feedback.notify.patient({ title, description, data: { ...data, at: nowClock() } })
  }

  const notifyStaff = (
    conversationId: string | null,
    title: string,
    description: string,
    data: Omit<NotificationData, 'at'>,
  ) => {
    if (conversationId && focus.staff === conversationId) return
    feedback.notify.staff({ title, description, data: { ...data, at: nowClock() } })
  }

  const settleDelivery = (conversationId: string, messageId: string, receiver: ClinicSide) => {
    later(`deliver:${messageId}`, SEND_SETTLE_MS, () => {
      store.update((s) =>
        patchMessage(s, conversationId, messageId, (m) => ({
          ...m,
          delivery: focus[receiver] === conversationId ? 'read' : 'sent',
        })),
      )
    })
  }

  const streamAgentMessage = (
    conversationId: string,
    message: Omit<ChatMessage, 'sequence' | 'conversationId'>,
    run: AgentRunRecord,
    onSettled?: () => void,
  ) => {
    const stream = message.stream!
    const text = message.parts.find((p) => p.type === 'text')
    const total = streamTextDuration(stream, text?.type === 'text' ? text.text : '') + 380
    store.update((s) => {
      const conversation = s.conversations.find((c) => c.id === conversationId)
      if (!conversation) return s
      return {
        ...patchConversation(s, conversationId, (c) => ({
          ...c,
          messages: [...c.messages, { ...message, conversationId, sequence: nextSequence(c) }],
        })),
        agentRuns: [run, ...s.agentRuns],
      }
    })
    later(`stream:${message.id}`, total, () => {
      store.update((s) => ({
        ...patchMessage(s, conversationId, message.id, (m) => ({
          ...m,
          stream: m.stream ? { ...m.stream, status: 'settled' } : undefined,
        })),
        agentRuns: s.agentRuns.map((r) => (r.id === run.id ? { ...r, status: 'settled', durationMs: total } : r)),
      }))
      onSettled?.()
    })
  }

  const setPublished = (resourceId: string, published: boolean) => {
    store.update((s) => {
      const res = s.resources.find((r) => r.id === resourceId)
      if (!res) return s
      const staff = STAFF_ACTORS[s.currentStaff]
      return withEvent(
        {
          ...s,
          resources: s.resources.map((r) =>
            r.id === resourceId ? { ...r, published, publishedAt: published ? nowClock() : undefined } : r,
          ),
        },
        'ClinicWorkspaceDO',
        '医生工作台',
        `${staff.name} ${published ? '显式发布' : '撤回发布'}「${res.title} v${res.version}」（${PATIENTS[res.patientKey].name} 手机版即时同步）`,
        published ? 'success' : 'warning',
      )
    })
  }

  const askFollowupAgentAsPatient = (conversationId: string, text: string) => {
    const s = store.get()
    const plan = s.followupPlans.find((p) => p.conversationId === conversationId)
    if (!plan) return
    const wantsForm = /问卷|打卡|填/.test(text) && plan.taskStatus === 'pending'
    streamAgentMessage(
      conversationId,
      {
        id: uid('msg_agent_fu'),
        senderId: 'agent_followup',
        senderName: '随访助手',
        senderKind: 'agent',
        senderRole: 'Follow-up Agent',
        createdAt: nowClock(),
        stream: {
          startedAt: Date.now(),
          steps: [{ label: '读取你的随访任务', doneAfterMs: 520 }],
          textStartsAfterMs: 680,
          chunkMs: 36,
          status: 'streaming',
        },
        parts: wantsForm
          ? [
              { type: 'text', text: '这是你今天的随访问卷，大约 30 秒就能填完：' },
              {
                type: 'card',
                component: 'FollowupFormCard',
                resourceId: plan.id,
                title: plan.taskTitle.replace(/^第 \d+ 次：/, ''),
                subtitle: plan.title,
                meta: [plan.dueLabel],
                actionLabel: '填写问卷',
                actionName: 'followup.submit',
                statusTag: '待填写',
              },
            ]
          : [{ type: 'text', text: '收到，我已记下并提醒医生和护士查看。涉及用药或症状判断的问题，请以医生回复为准。' }],
      },
      {
        id: `run_fu_${Math.floor(100 + Math.random() * 899)}`,
        agentName: 'Follow-up Agent',
        conversationId,
        triggerLabel: `患者 @随访助手：${text.replace('@随访助手', '').trim()}`,
        status: 'running',
        startedAt: `${nowClock()}:00`,
        durationMs: 0,
        tools: [{ name: 'get_followup_plan', scope: `plan:${plan.id}`, status: 'ok', summary: `任务 ${plan.taskStatus}` }],
        auditNote: '群内被 @ 调用；只回答非临床协作问题。',
      },
    )
  }

  const actions: ClinicActions = {
    setStaff(role) {
      store.update((s) =>
        withEvent(
          { ...s, currentStaff: role },
          'ClinicWorkspaceDO',
          '医生工作台',
          `切换医护会话身份 → ${STAFF_ACTORS[role].name} (${STAFF_ACTORS[role].title})`,
        ),
      )
    },

    setPatient(patientKey) {
      focus.patient = null
      feedback.notify.patient.dismiss()
      feedback.toast.patient.dismiss()
      store.update((s) =>
        withEvent(
          { ...s, currentPatient: patientKey, lastIsolationBlock: null, typing: { ...s.typing, patient: null } },
          'ClinicWorkspaceDO',
          '患者手机版',
          `切换患者身份 → ${PATIENTS[patientKey].name} (${PATIENTS[patientKey].patientId})，已清理旧本地缓存`,
        ),
      )
    },

    resetDemo() {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
      focus.patient = null
      focus.staff = null
      for (const toaster of [feedback.toast.patient, feedback.toast.staff, feedback.notify.patient, feedback.notify.staff]) {
        toaster.dismiss()
      }
      store.update(() => createInitialClinicState())
      feedback.toast.staff.info('演示数据已重置')
    },

    bookAppointment(slotId, source, complaint): BookingResult {
      const s = store.get()
      const slot = s.slots.find((x) => x.id === slotId)
      if (!slot) return { ok: false, message: '没有找到这个号源，请重新选择。' }
      const patient = PATIENTS[s.currentPatient]
      if (slot.booked >= slot.capacity) {
        store.update((prev) =>
          withEvent(prev, 'ClinicWorkspaceDO', '患者手机版', `预约被事务容量校验拒绝：${slot.timeRange} 已满 (${slot.booked}/${slot.capacity})`, 'warning'),
        )
        return { ok: false, message: `${slot.timeRange.split(' ')[0]} 刚刚约满了，请换一个时段。` }
      }
      const duplicate = s.appointments.find(
        (a) => a.patientKey === s.currentPatient && a.slotId === slotId && a.status !== 'cancelled',
      )
      if (duplicate) {
        return { ok: true, appointmentId: duplicate.id, message: '你已经约过这个时段了，没有重复扣号。' }
      }
      const appointmentId = `apt_${Math.floor(2000 + Math.random() * 7999)}`
      store.update((prev) =>
        withEvent(
          {
            ...prev,
            slots: prev.slots.map((x) => (x.id === slotId ? { ...x, booked: x.booked + 1 } : x)),
            appointments: [
              {
                id: appointmentId,
                patientKey: prev.currentPatient,
                slotId: slot.id,
                doctorId: slot.doctorId,
                doctorName: slot.doctorName,
                department: slot.department,
                dateLabel: slot.dateLabel,
                timeRange: slot.timeRange,
                chiefComplaint: complaint?.trim() || patient.chiefComplaint,
                status: 'booked',
                source,
                createdAt: nowClock(),
              },
              ...prev.appointments,
            ],
          },
          'ClinicWorkspaceDO',
          '患者手机版',
          `${patient.name} 确认预约 ${slot.doctorName} ${slot.dateLabel} ${slot.timeRange} (${appointmentId})`,
          'success',
        ),
      )
      feedback.toast.patient.success('预约成功', { description: `${slot.dateLabel} ${slot.timeRange.split(' ')[0]} · ${slot.doctorName}` })
      notifyStaff(null, `新预约 · ${patient.name}`, `${slot.dateLabel} ${slot.timeRange} · ${slot.doctorName}${source === 'agent_assisted' ? ' · AI 协助预填' : ''}`, {
        avatar: patient.avatar,
        tone: 'human',
        target: { kind: 'module', module: 'appointments' },
        actionLabel: '查看队列',
      })
      return { ok: true, appointmentId, message: `已预约 ${slot.doctorName} ${slot.dateLabel} ${slot.timeRange}` }
    },

    checkInAppointment(appointmentId) {
      const target = store.get().appointments.find((a) => a.id === appointmentId)
      if (!target) return
      store.update((s) =>
        withEvent(
          { ...s, appointments: s.appointments.map((a) => (a.id === appointmentId ? { ...a, status: 'checked_in' } : a)) },
          'ClinicWorkspaceDO',
          '医生工作台',
          `${PATIENTS[target.patientKey].name} 预约 ${appointmentId} 已签到候诊`,
        ),
      )
      feedback.toast.staff.success(`${PATIENTS[target.patientKey].name} 已签到`)
      notifyPatientOf(target.patientKey, '签到成功', `${target.doctorName} · ${target.timeRange}，请在候诊区等候叫号`, { avatar: '诊', tone: 'system' })
    },

    startEncounterFromAppointment(appointmentId) {
      const s = store.get()
      const active = s.encounters.find((e) => e.status === 'active')
      if (active) {
        store.update((prev) =>
          withEvent(prev, 'ClinicWorkspaceDO', '医生工作台', `拒绝并发接诊 ${appointmentId}：当前存在未完诊 ${active.outpatientNumber}`, 'warning'),
        )
        return {
          ok: false,
          message: `当前已有在诊患者（${PATIENTS[active.patientKey].name} · ${active.outpatientNumber}），完成后才能接诊下一位；这条预约保持不变。`,
        }
      }
      const apt = s.appointments.find((a) => a.id === appointmentId)
      if (!apt) return { ok: false, message: '没有找到这条预约' }
      const encounterId = `enc_${Math.floor(100 + Math.random() * 899)}`
      const outpatientNumber = `OP-20261126-0${s.encounters.length + 1}`
      store.update((prev) =>
        withEvent(
          {
            ...prev,
            encounters: [
              {
                id: encounterId,
                appointmentId: apt.id,
                patientKey: apt.patientKey,
                practitionerId: prev.currentStaff,
                status: 'active',
                outpatientNumber,
                chiefComplaint: apt.chiefComplaint,
                signedNote: true,
                diagnosisConfirmed: true,
                diagnosisText: '门诊初步评估完成（模拟病例）',
                reportsAcknowledged: true,
                prescriptionIssued: true,
                noPendingDrafts: true,
                releasedToPatient: false,
              },
              ...prev.encounters,
            ],
            appointments: prev.appointments.map((a) =>
              a.id === appointmentId ? { ...a, status: 'in_encounter', encounterId } : a,
            ),
          },
          'ClinicWorkspaceDO',
          '医生工作台',
          `${STAFF_ACTORS[prev.currentStaff].name} 接诊 ${PATIENTS[apt.patientKey].name} → ${outpatientNumber}`,
          'success',
        ),
      )
      feedback.toast.staff.success(`已接诊 ${PATIENTS[apt.patientKey].name}`, { description: outpatientNumber })
      notifyPatientOf(apt.patientKey, '轮到你就诊了', `${apt.doctorName} 已开始接诊，请进入诊室`, { avatar: '诊', tone: 'system' })
      return { ok: true, message: `已为 ${PATIENTS[apt.patientKey].name} 建立在诊 Encounter (${outpatientNumber})` }
    },

    completeActiveEncounter() {
      const active = store.get().encounters.find((e) => e.status === 'active')
      if (!active) return
      store.update((s) =>
        withEvent(
          {
            ...s,
            encounters: s.encounters.map((e) => (e.id === active.id ? { ...e, status: 'completed' } : e)),
            appointments: s.appointments.map((a) => (a.id === active.appointmentId ? { ...a, status: 'completed' } : a)),
          },
          'ClinicWorkspaceDO',
          '医生工作台',
          `${active.outpatientNumber} 通过五项 Completion Gates 正式完诊并冻结临床写入`,
          'success',
        ),
      )
      feedback.toast.staff.success('已完诊并冻结临床写入', { description: active.outpatientNumber })
      notifyPatientOf(active.patientKey, '本次就诊已完成', '医生发布病历和报告后，会在「我的病历」里看到', { avatar: '诊', tone: 'system' })
    },

    toggleResourcePublish(resourceId) {
      const res = store.get().resources.find((r) => r.id === resourceId)
      if (!res) return
      const publishing = !res.published
      setPublished(resourceId, publishing)
      if (!publishing) {
        feedback.toast.staff.info(`已撤回「${res.title}」`)
        return
      }
      const kindLabel = res.kind === 'report' ? '报告' : res.kind === 'prescription' ? '处方' : '病历'
      const notified = notifyPatientOf(res.patientKey, `新${kindLabel}已发布`, res.title, {
        avatar: '诊',
        tone: 'system',
        target: { kind: 'resource', resourceId },
        actionLabel: `查看${kindLabel}`,
      })
      showUndoToast(feedback.toast.staff, `已发布至 ${PATIENTS[res.patientKey].name} 手机端`, '撤回', () => {
        setPublished(resourceId, false)
        if (notified) feedback.notify.patient.dismiss(notified)
      })
    },

    sendMessage(conversationId, senderType, text) {
      const s = store.get()
      const conversation = s.conversations.find((c) => c.id === conversationId)
      if (!conversation || conversation.status === 'read_only' || !text.trim()) return
      const staff = STAFF_ACTORS[s.currentStaff]
      const patient = PATIENTS[s.currentPatient]
      const fromStaff = senderType === 'staff'
      const id = uid('msg')
      const message: ChatMessage = {
        id,
        conversationId,
        sequence: nextSequence(conversation),
        senderId: fromStaff ? staff.id : patient.id,
        senderName: fromStaff ? `${staff.name} ${staff.role === 'doctor' ? '医生' : '护士'}` : patient.name,
        senderKind: 'human',
        senderRole: fromStaff ? staff.title : '患者',
        createdAt: nowClock(),
        delivery: 'sending',
        parts: [{ type: 'text', text }],
      }
      store.update((prev) =>
        withEvent(
          {
            ...patchConversation(prev, conversationId, (c) => ({
              ...c,
              unreadPatient: fromStaff && focus.patient !== c.id ? c.unreadPatient + 1 : c.unreadPatient,
              unreadStaff: !fromStaff && focus.staff !== c.id ? c.unreadStaff + 1 : c.unreadStaff,
              messages: [...c.messages, message],
            })),
            typing: { ...prev.typing, [senderType]: null },
          },
          'WuKongIM',
          fromStaff ? '医生工作台' : '患者手机版',
          `${fromStaff ? staff.name : patient.name} 发送消息至「${conversation.title}」seq #${message.sequence}`,
        ),
      )
      settleDelivery(conversationId, id, fromStaff ? 'patient' : 'staff')
      if (fromStaff) {
        notifyPatient(conversation, message.senderName, text, {
          avatar: staff.avatar,
          tone: 'human',
          target: { kind: 'conversation', conversationId },
          actionLabel: '回复',
        })
      } else {
        notifyStaff(conversationId, `${patient.name} · ${conversation.type === 'followup_group' ? '随访群' : '私信'}`, text, {
          avatar: patient.avatar,
          tone: 'human',
          target: { kind: 'conversation', conversationId },
          actionLabel: '回复',
        })
        if (conversation.type === 'followup_group' && /@随访助手/.test(text)) {
          askFollowupAgentAsPatient(conversationId, text)
        }
      }
    },

    sendVoiceMessage(conversationId, senderType, transcript, durationSec = 8) {
      const s = store.get()
      const conversation = s.conversations.find((c) => c.id === conversationId)
      if (!conversation || conversation.status === 'read_only') return
      const staff = STAFF_ACTORS[s.currentStaff]
      const patient = PATIENTS[s.currentPatient]
      const fromStaff = senderType === 'staff'
      const id = uid('msg')
      const attachmentId = uid('att_voice')
      const toaster = fromStaff ? feedback.toast.staff : feedback.toast.patient
      const toastId = toaster.loading(`正在发送 ${durationSec}″ 语音`)
      store.update((prev) =>
        withEvent(
          patchConversation(prev, conversationId, (c) => ({
            ...c,
            unreadPatient: fromStaff && focus.patient !== c.id ? c.unreadPatient + 1 : c.unreadPatient,
            unreadStaff: !fromStaff && focus.staff !== c.id ? c.unreadStaff + 1 : c.unreadStaff,
            messages: [
              ...c.messages,
              {
                id,
                conversationId,
                sequence: nextSequence(c),
                senderId: fromStaff ? staff.id : patient.id,
                senderName: fromStaff ? `${staff.name} ${staff.role === 'doctor' ? '医生' : '护士'}` : patient.name,
                senderKind: 'human',
                senderRole: fromStaff ? staff.title : '患者',
                createdAt: nowClock(),
                delivery: 'sending',
                parts: [{ type: 'audio', attachmentId, durationSec, asrStatus: 'pending', transcript }],
              },
            ],
          })),
          'WuKongIM',
          fromStaff ? '医生工作台' : '患者手机版',
          `上传私有语音 ${durationSec}″ (${attachmentId})，ASR 转写排队中`,
        ),
      )
      settleDelivery(conversationId, id, fromStaff ? 'patient' : 'staff')
      later(`asr:${id}`, ASR_SETTLE_MS, () => {
        store.update((prev) =>
          withEvent(
            patchMessage(prev, conversationId, id, (m) => ({
              ...m,
              parts: m.parts.map((p) => (p.type === 'audio' ? { ...p, asrStatus: 'ready' } : p)),
            })),
            'WuKongIM',
            fromStaff ? '医生工作台' : '患者手机版',
            `语音 ${attachmentId} 转写完成`,
            'success',
          ),
        )
        toaster.update(toastId, { title: '语音已发送', description: '已转成文字', type: 'success', duration: 2600 })
      })
      if (fromStaff) {
        notifyPatient(conversation, `${staff.name} 发来语音`, transcript, {
          avatar: staff.avatar,
          tone: 'human',
          target: { kind: 'conversation', conversationId },
          actionLabel: '收听',
        })
      } else {
        notifyStaff(conversationId, `${patient.name} 发来 ${durationSec}″ 语音`, transcript, {
          avatar: patient.avatar,
          tone: 'human',
          target: { kind: 'conversation', conversationId },
          actionLabel: '收听',
        })
      }
    },

    shareResourceCard(conversationId, resourceId) {
      const s = store.get()
      const conversation = s.conversations.find((c) => c.id === conversationId)
      const res = s.resources.find((r) => r.id === resourceId)
      if (!conversation || !res || conversation.status === 'read_only') return
      const staff = STAFF_ACTORS[s.currentStaff]
      const id = uid('msg')
      store.update((prev) =>
        withEvent(
          patchConversation(prev, conversationId, (c) => ({
            ...c,
            unreadPatient: focus.patient !== c.id ? c.unreadPatient + 1 : c.unreadPatient,
            messages: [
              ...c.messages,
              {
                id,
                conversationId,
                sequence: nextSequence(c),
                senderId: staff.id,
                senderName: `${staff.name} ${staff.role === 'doctor' ? '医生' : '护士'}`,
                senderKind: 'human',
                senderRole: staff.title,
                createdAt: nowClock(),
                delivery: 'sending',
                parts: [
                  {
                    type: 'card',
                    component: res.kind === 'report' ? 'ReportCard' : res.kind === 'prescription' ? 'PrescriptionCard' : 'MedicalRecordCard',
                    resourceId: res.id,
                    title: res.title,
                    subtitle: res.subtitle,
                    meta: [res.department, `v${res.version}`, '打开时重新鉴权'],
                    actionLabel: res.kind === 'report' ? '查看报告' : res.kind === 'prescription' ? '查看处方' : '打开病历',
                    actionName: res.kind === 'record' ? 'medical.record.open' : 'report.open',
                    statusTag: '已发布',
                  },
                ],
              },
            ],
          })),
          'WuKongIM',
          '医生工作台',
          `${staff.name} 投递资源引用卡片「${res.title}」至「${conversation.title}」`,
          'success',
        ),
      )
      settleDelivery(conversationId, id, 'patient')
      feedback.toast.staff.success('卡片已发送', { description: res.title })
      notifyPatient(conversation, `${staff.name} 分享了资料`, res.title, {
        avatar: staff.avatar,
        tone: 'human',
        target: { kind: 'conversation', conversationId },
      })
    },

    toggleGroupMember(conversationId, memberId) {
      const conversation = store.get().conversations.find((c) => c.id === conversationId)
      const member = conversation?.members.find((m) => m.id === memberId)
      if (!conversation || !member) return
      const nextStatus = member.status === 'active' ? 'removed' : 'active'
      store.update((s) =>
        withEvent(
          patchConversation(s, conversationId, (c) => ({
            ...c,
            membershipVersion: c.membershipVersion + 1,
            members: c.members.map((m) => (m.id === memberId ? { ...m, status: nextStatus } : m)),
            messages: [
              ...c.messages,
              {
                id: uid('msg_sys'),
                conversationId,
                sequence: nextSequence(c),
                senderId: 'system',
                senderName: '系统',
                senderKind: 'system',
                senderRole: 'System',
                createdAt: nowClock(),
                parts: [
                  {
                    type: 'text',
                    text: nextStatus === 'removed' ? `「${member.name}」已被移出群聊` : `「${member.name}」重新加入了群聊`,
                  },
                ],
              },
            ],
          })),
          'SecurityGate',
          '医生工作台',
          `${nextStatus === 'removed' ? '撤销' : '恢复'}成员 ${member.name} 于「${conversation.title}」的访问权 (membership v${conversation.membershipVersion + 1})`,
          nextStatus === 'removed' ? 'warning' : 'info',
        ),
      )
      feedback.toast.staff.info(nextStatus === 'removed' ? `已移除 ${member.name}，访问权即时撤销` : `已重新邀请 ${member.name}`)
    },

    askPatientAgent(prompt) {
      const s = store.get()
      const patient = PATIENTS[s.currentPatient]
      const conversation = s.conversations.find((c) => c.type === 'patient_assistant' && c.patientKey === s.currentPatient)
      if (!conversation || !prompt.trim()) return
      const plan = planPatientAgentReply(s, s.currentPatient, prompt)
      const runId = `run_pa_${Math.floor(100 + Math.random() * 899)}`
      const lastStep = plan.steps.at(-1)?.doneAfterMs ?? 0
      const stream: AgentStream = {
        startedAt: Date.now(),
        steps: plan.steps,
        textStartsAfterMs: lastStep + 160,
        chunkMs: 38,
        status: 'streaming',
      }
      store.update((prev) =>
        patchConversation(prev, conversation.id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              id: uid('msg_u'),
              conversationId: c.id,
              sequence: nextSequence(c),
              senderId: patient.id,
              senderName: patient.name,
              senderKind: 'human',
              senderRole: '患者本人',
              createdAt: nowClock(),
              delivery: 'read',
              parts: [{ type: 'text', text: prompt }],
            },
          ],
        })),
      )
      streamAgentMessage(
        conversation.id,
        {
          id: uid('msg_a'),
          senderId: 'agent_patient_svc',
          senderName: 'AI 就医助手',
          senderKind: 'agent',
          senderRole: 'Patient Service Agent',
          createdAt: nowClock(),
          agentRunId: runId,
          stream,
          parts: [{ type: 'text', text: plan.text }, ...plan.cards],
        },
        {
          id: runId,
          agentName: 'Patient Service Agent',
          conversationId: conversation.id,
          triggerLabel: `患者 ${patient.name}：${prompt}`,
          status: 'running',
          startedAt: `${nowClock()}:${String(new Date().getSeconds()).padStart(2, '0')}`,
          durationMs: 0,
          tools: plan.tools,
          auditNote: `强绑定本人身份 ${patient.patientId}；所有业务变更须患者本人显式确认。`,
        },
        () =>
          store.update((prev) =>
            withEvent(prev, 'DurableAgent', 'Agent Runtime', `Patient Service Agent 完成 ${runId}（${plan.tools.map((t) => t.name).join(' → ')}）`),
          ),
      )
    },

    stopAgentRun(messageId) {
      const found = findMessage(store.get(), messageId)
      if (!found?.message.stream || found.message.stream.status !== 'streaming') return
      clearTimeout(timers.get(`stream:${messageId}`))
      timers.delete(`stream:${messageId}`)
      const { stream } = found.message
      const elapsed = Date.now() - stream.startedAt
      store.update((s) => ({
        ...patchMessage(s, found.conversation.id, messageId, (m) => {
          const text = m.parts.find((p) => p.type === 'text')
          const shown =
            elapsed <= stream.textStartsAfterMs || text?.type !== 'text'
              ? ''
              : chunkText(text.text)
                  .slice(0, Math.floor((elapsed - stream.textStartsAfterMs) / stream.chunkMs))
                  .join('')
          return {
            ...m,
            stream: { ...stream, status: 'stopped', steps: stream.steps.filter((step) => step.doneAfterMs <= elapsed) },
            parts: [{ type: 'text', text: shown }],
          }
        }),
        agentRuns: s.agentRuns.map((r) =>
          r.id === found.message.agentRunId ? { ...r, status: 'settled', durationMs: elapsed, triggerLabel: `${r.triggerLabel}（患者已停止）` } : r,
        ),
      }))
    },

    sendHandoff(messageId) {
      const found = findMessage(store.get(), messageId)
      const card = found?.message.parts.find((p) => p.type === 'card' && p.handoff)
      if (!found || card?.type !== 'card' || !card.handoff || card.handoff.sentAt) return
      const { handoff } = card
      actions.sendMessage(handoff.conversationId, 'patient', handoff.draft)
      store.update((s) =>
        patchMessage(s, found.conversation.id, messageId, (m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === 'card' && p.handoff ? { ...p, handoff: { ...p.handoff, sentAt: nowClock() } } : p,
          ),
        })),
      )
      feedback.toast.patient.success(`已发送给${handoff.recipient}`)
    },

    submitFollowupQuestionnaire(planId, payload) {
      const s = store.get()
      const plan = s.followupPlans.find((p) => p.id === planId)
      if (!plan || plan.status !== 'active') return
      const responseId = `resp_${planId}_${plan.responses.length + 1}`
      const patient = PATIENTS[plan.patientKey]
      store.update((prev) =>
        withEvent(
          {
            ...patchConversation(prev, plan.conversationId, (c) => ({
              ...c,
              unreadStaff: focus.staff !== c.id ? c.unreadStaff + 1 : c.unreadStaff,
              messages: [
                ...c.messages,
                {
                  id: uid('msg_fu'),
                  conversationId: c.id,
                  sequence: nextSequence(c),
                  senderId: patient.id,
                  senderName: patient.name,
                  senderKind: 'human',
                  senderRole: '患者',
                  createdAt: nowClock(),
                  delivery: 'sent',
                  parts: [
                    {
                      type: 'card',
                      component: 'TaskCard',
                      resourceId: responseId,
                      title: '随访问卷已提交',
                      subtitle: `体温 ${payload.temperature} · ${payload.symptomScore}`,
                      meta: [payload.adherence, payload.note].filter(Boolean),
                      actionLabel: '',
                      actionName: 'none',
                      statusTag: '已提交',
                    },
                  ],
                },
              ],
            })),
            followupPlans: prev.followupPlans.map((p) =>
              p.id === planId
                ? { ...p, taskStatus: 'submitted', responses: [{ id: responseId, submittedAt: `今日 ${nowClock()}`, ...payload }, ...p.responses] }
                : p,
            ),
          },
          'ClinicWorkspaceDO',
          '患者手机版',
          `${patient.name} 提交随访问卷反馈 ${responseId}（已同步至随访群与医生端）`,
          'success',
        ),
      )
      feedback.toast.patient.success('问卷已提交', { description: '医生和护士会在群里回复你' })
      notifyStaff(plan.conversationId, `${patient.name} 提交了随访问卷`, `体温 ${payload.temperature}，${payload.symptomScore}；${payload.adherence}`, {
        avatar: patient.avatar,
        tone: 'human',
        target: { kind: 'module', module: 'followup' },
        actionLabel: '查看反馈',
      })
    },

    triggerFollowupAgentSummary(planId) {
      const s = store.get()
      const plan = s.followupPlans.find((p) => p.id === planId)
      if (!plan || plan.status !== 'active') return
      const version = plan.summaries.length + 1
      const summaryId = `sum_${plan.id}_v${version}`
      const runId = `run_fu_${Math.floor(100 + Math.random() * 899)}`
      const latest = plan.responses[0]
      const sourceIds = plan.responses.map((r) => r.id)
      const content = latest
        ? `【待医生审核草稿】依据随访问卷反馈（${sourceIds.join(', ')}）：患者自测体温 ${latest.temperature}，${latest.symptomScore}，用药依从性：${latest.adherence}，自述「${latest.note}」。未报告呼吸困难或持续高热等警示信号，提请主管医生复核后固化为正式随访记录。`
        : `【待医生审核草稿】依据当前随访群沟通与计划 #${plan.id}：暂无新的问卷提交。建议提醒患者今日 20:00 前完成体温与咳嗽打卡。`
      const toastId = feedback.toast.staff.loading('随访助手正在生成摘要…')
      const stream: AgentStream = {
        startedAt: Date.now(),
        steps: [
          { label: `读取随访计划 #${plan.id.toUpperCase()}`, doneAfterMs: 480 },
          { label: `汇总 ${plan.responses.length} 条问卷反馈`, doneAfterMs: 1040 },
          { label: '生成待审核摘要草稿', doneAfterMs: 1600 },
        ],
        textStartsAfterMs: 1760,
        chunkMs: 34,
        status: 'streaming',
      }
      streamAgentMessage(
        plan.conversationId,
        {
          id: uid('msg_agent_sum'),
          senderId: 'agent_followup',
          senderName: '随访助手',
          senderKind: 'agent',
          senderRole: 'Follow-up Agent',
          createdAt: nowClock(),
          agentRunId: runId,
          stream,
          parts: [
            {
              type: 'text',
              text: `已生成随访摘要草稿 v${version}（依据：${sourceIds.join('、') || '群聊记录'}），等待医生审核，不会自动写入正式病历。`,
            },
          ],
        },
        {
          id: runId,
          agentName: 'Follow-up Agent',
          conversationId: plan.conversationId,
          triggerLabel: `@随访助手 生成随访摘要（${PATIENTS[plan.patientKey].name}）`,
          status: 'running',
          startedAt: `${nowClock()}:${String(new Date().getSeconds()).padStart(2, '0')}`,
          durationMs: 0,
          tools: [
            { name: 'get_followup_plan', scope: `plan:${plan.id}`, status: 'ok', summary: `读取 ${plan.responses.length} 条已提交反馈` },
            { name: 'draft_followup_summary', scope: `summary:${summaryId}`, status: 'ok', summary: '创建待审核草稿（禁止自动批准）' },
          ],
          auditNote: '仅限当前随访群授权上下文；不自主做临床诊断或处方调整。',
        },
        () => {
          store.update((prev) =>
            withEvent(
              {
                ...prev,
                followupPlans: prev.followupPlans.map((p) =>
                  p.id === planId
                    ? {
                        ...p,
                        summaries: [
                          { id: summaryId, version, status: 'draft', createdAt: `今日 ${nowClock()}`, sourceResponseIds: sourceIds, content },
                          ...p.summaries,
                        ],
                      }
                    : p,
                ),
              },
              'DurableAgent',
              'Agent Runtime',
              `Follow-up Agent 生成待审摘要 ${summaryId} (${runId} settled)`,
            ),
          )
          feedback.toast.staff.update(toastId, { title: `摘要草稿 v${version} 已生成`, description: '等待你审核', type: 'success', duration: 3200 })
        },
      )
    },

    reviewFollowupSummary(planId, summaryId, decision) {
      const s = store.get()
      const staff = STAFF_ACTORS[s.currentStaff]
      if (staff.role !== 'doctor') return
      store.update((prev) =>
        withEvent(
          {
            ...prev,
            followupPlans: prev.followupPlans.map((p) =>
              p.id === planId
                ? {
                    ...p,
                    taskStatus: decision === 'approved' ? 'reviewed' : p.taskStatus,
                    summaries: p.summaries.map((x) =>
                      x.id === summaryId ? { ...x, status: decision, reviewedBy: `${staff.name} 医生`, reviewedAt: nowClock() } : x,
                    ),
                  }
                : p,
            ),
          },
          'ClinicWorkspaceDO',
          '医生工作台',
          `${staff.name} 医生${decision === 'approved' ? '批准并固化' : '驳回'}随访摘要 ${summaryId}`,
          decision === 'approved' ? 'success' : 'warning',
        ),
      )
      if (decision === 'approved') feedback.toast.staff.success('摘要已批准，形成正式随访记录')
      else feedback.toast.staff.info('已驳回摘要草稿')
    },

    closeFollowupPlan(planId) {
      const s = store.get()
      const staff = STAFF_ACTORS[s.currentStaff]
      const plan = s.followupPlans.find((p) => p.id === planId)
      if (staff.role !== 'doctor' || !plan) return
      const conversation = s.conversations.find((c) => c.id === plan.conversationId)
      store.update((prev) =>
        withEvent(
          {
            ...patchConversation(prev, plan.conversationId, (c) => ({
              ...c,
              status: 'read_only',
              messages: [
                ...c.messages,
                {
                  id: uid('msg_close'),
                  conversationId: c.id,
                  sequence: nextSequence(c),
                  senderId: 'system',
                  senderName: '系统',
                  senderKind: 'system',
                  senderRole: 'System',
                  createdAt: nowClock(),
                  parts: [{ type: 'text', text: `${staff.name} 医生结束了随访计划，群聊已归档为只读` }],
                },
              ],
            })),
            followupPlans: prev.followupPlans.map((p) => (p.id === planId ? { ...p, status: 'completed' } : p)),
          },
          'ClinicWorkspaceDO',
          '医生工作台',
          `关闭随访计划 #${plan.id} → 关联随访群同步切换为 read_only 只读归档`,
          'warning',
        ),
      )
      feedback.toast.staff.success('随访计划已结案，群聊转为只读')
      notifyPatient(conversation, '随访计划已结束', `${plan.title}，群聊记录仍可查看`, { avatar: '诊', tone: 'system' })
    },

    testCrossPatientIsolation() {
      const actor = PATIENTS[store.get().currentPatient]
      store.update((s) =>
        withEvent(
          {
            ...s,
            lastIsolationBlock: `GET /api/patient/records/rec_lijg_20261126 → 403。当前登录身份是 ${actor.name}（${actor.patientId}），无权查看其他患者的病历、群聊或附件。`,
          },
          'SecurityGate',
          '患者手机版',
          `403 Forbidden · 拦截跨患者访问 (${actor.patientId} 尝试读取 pat_01_lijg 病历)`,
          'destructive',
        ),
      )
    },

    dismissIsolationBlock() {
      store.update((s) => ({ ...s, lastIsolationBlock: null }))
    },

    focusConversation(side, conversationId) {
      focus[side] = conversationId
      if (!conversationId) return
      const other: ClinicSide = side === 'staff' ? 'patient' : 'staff'
      store.update((s) => {
        const conversation = s.conversations.find((c) => c.id === conversationId)
        if (!conversation) return s
        const unreadKey = side === 'staff' ? 'unreadStaff' : 'unreadPatient'
        const hasUnread = conversation[unreadKey] > 0
        const otherIds = other === 'patient' ? new Set(Object.keys(PATIENTS)) : new Set(Object.keys(STAFF_ACTORS))
        const needsRead = conversation.messages.some((m) => m.delivery === 'sent' && otherIds.has(m.senderId))
        if (!hasUnread && !needsRead) return s
        return patchConversation(s, conversationId, (c) => ({
          ...c,
          [unreadKey]: 0,
          messages: c.messages.map((m) => (m.delivery === 'sent' && otherIds.has(m.senderId) ? { ...m, delivery: 'read' } : m)),
        }))
      })
    },

    setTyping(side, conversationId) {
      if (store.get().typing[side] === conversationId) return
      store.update((s) => ({ ...s, typing: { ...s.typing, [side]: conversationId } }))
    },
  }

  return actions
}

export { previewOf }
