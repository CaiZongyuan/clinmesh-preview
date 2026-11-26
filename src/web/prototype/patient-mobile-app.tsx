import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CalendarPlusIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  FlaskConicalIcon,
  HomeIcon,
  LockIcon,
  MessageCircleIcon,
  MicIcon,
  PillIcon,
  PlayIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
  UserIcon,
  WrenchIcon,
} from 'lucide-react'
import { useState } from 'react'
import {
  PATIENTS,
  type ClinicActions,
  type ClinicConversation,
  type ConnectedClinicState,
  type MessagePart,
  type PatientKey,
  type PublishedResource,
} from './connected-clinic-store'

export type MobileTab = 'home' | 'messages' | 'assistant' | 'profile'
export type MobileSubPage =
  | { kind: 'none' }
  | { kind: 'book'; prefilledSlotId?: string }
  | { kind: 'records' }
  | { kind: 'record_detail'; resourceId: string }
  | { kind: 'reports' }
  | { kind: 'prescriptions' }
  | { kind: 'chat'; conversationId: string }
  | { kind: 'followup'; planId: string }

interface PatientMobileAppProps {
  state: ConnectedClinicState
  actions: ClinicActions
  initialTab?: MobileTab
  compact?: boolean
  embedded?: boolean
}

const APPOINTMENT_STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  booked: { label: '已预约', tone: 'bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]' },
  checked_in: { label: '已签到候诊', tone: 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]' },
  in_encounter: { label: '诊室接诊中', tone: 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]' },
  completed: { label: '已完诊', tone: 'bg-muted text-muted-foreground' },
  cancelled: { label: '已取消', tone: 'bg-muted text-muted-foreground' },
}

export function PatientMobileApp({
  state,
  actions,
  initialTab = 'home',
  compact = false,
  embedded = false,
}: PatientMobileAppProps) {
  const [tab, setTab] = useState<MobileTab>(initialTab)
  const [subPage, setSubPage] = useState<MobileSubPage>({ kind: 'none' })
  const [chatDraft, setChatDraft] = useState('')
  const [assistantDraft, setAssistantDraft] = useState('')
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const [showTranscriptId, setShowTranscriptId] = useState<Record<string, boolean>>({})
  const [bookingComplaint, setBookingComplaint] = useState('复诊咨询 / 咳嗽评估')
  const [bookingFeedback, setBookingFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [selectedSlotId, setSelectedSlotId] = useState<string>(state.slots[0]?.id ?? '')

  const [fuTemp, setFuTemp] = useState('37.1°C')
  const [fuSymptom, setFuSymptom] = useState('咳嗽明显缓解（2/10），偶有少许白痰')
  const [fuAdherence, setFuAdherence] = useState('按时规律服药，无胃肠道不适')
  const [fuNote, setFuNote] = useState('昨晚睡眠良好，今早未再发热，精神较前好转。')

  const patient = PATIENTS[state.currentPatient]
  const myAppointments = state.appointments.filter((a) => a.patientKey === state.currentPatient)
  const myPublishedResources = state.resources.filter(
    (r) => r.patientKey === state.currentPatient && r.published,
  )
  const myRecords = myPublishedResources.filter((r) => r.kind === 'record')
  const myReports = myPublishedResources.filter((r) => r.kind === 'report')
  const myPrescriptions = myPublishedResources.filter((r) => r.kind === 'prescription')
  const myFollowups = state.followupPlans.filter((f) => f.patientKey === state.currentPatient)
  const myConversations = state.conversations.filter(
    (c) =>
      c.patientKey === state.currentPatient &&
      (c.type === 'patient_doctor' || c.type === 'followup_group'),
  )
  const assistantConv =
    state.conversations.find(
      (c) => c.type === 'patient_assistant' && c.patientKey === state.currentPatient,
    ) ?? state.conversations.find((c) => c.type === 'patient_assistant')

  const unreadMessages = myConversations.reduce((acc, c) => acc + c.unreadPatient, 0)

  const openResourceDetail = (resourceId: string) => {
    const target = state.resources.find((r) => r.id === resourceId)
    if (!target || target.patientKey !== state.currentPatient || !target.published) {
      actions.testCrossPatientIsolation()
      return
    }
    setSubPage({ kind: 'record_detail', resourceId })
  }

  const handleCardAction = (part: Extract<MessagePart, { type: 'card' }>) => {
    if (part.actionName === 'appointment.open') {
      const slotId = part.slotIds?.[0] ?? state.slots[0]?.id ?? ''
      setSelectedSlotId(slotId)
      setBookingFeedback(null)
      setSubPage({ kind: 'book', prefilledSlotId: slotId })
    } else if (part.actionName === 'medical.record.open' || part.actionName === 'report.open') {
      openResourceDetail(part.resourceId)
    } else if (part.actionName === 'followup.submit') {
      setSubPage({ kind: 'followup', planId: part.resourceId })
    }
  }

  const handleConfirmBooking = (source: 'manual' | 'agent_assisted') => {
    const result = actions.bookAppointment(selectedSlotId, source, bookingComplaint)
    setBookingFeedback({ ok: result.ok, text: result.message })
  }

  const sendAssistantPrompt = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    actions.triggerPatientAgentPrompt(trimmed)
    setAssistantDraft('')
  }

  const activeChatConv: ClinicConversation | undefined =
    subPage.kind === 'chat'
      ? state.conversations.find((c) => c.id === subPage.conversationId)
      : undefined

  const activeDetailResource: PublishedResource | undefined =
    subPage.kind === 'record_detail'
      ? state.resources.find((r) => r.id === subPage.resourceId)
      : undefined

  const activeFollowupPlan =
    subPage.kind === 'followup'
      ? state.followupPlans.find((p) => p.id === subPage.planId)
      : undefined

  const pageTitle = (() => {
    if (subPage.kind === 'book') return '门诊预约'
    if (subPage.kind === 'records') return '我的病历'
    if (subPage.kind === 'record_detail')
      return activeDetailResource?.kind === 'report' ? '检验检查报告' : '门诊病历详情'
    if (subPage.kind === 'reports') return '检验检查'
    if (subPage.kind === 'prescriptions') return '正式处方'
    if (subPage.kind === 'chat')
      return activeChatConv?.title.split('·')[1]?.trim() || activeChatConv?.title || '会话'
    if (subPage.kind === 'followup') return '随访问卷'
    if (tab === 'home') return 'ClinMesh'
    if (tab === 'messages') return '消息'
    if (tab === 'assistant') return 'AI 就医助手'
    return '我的'
  })()

  return (
    <div
      className={`cc-phone-frame ${
        embedded
          ? '!h-full !min-h-0 !w-full !rounded-[28px] !p-[6px]'
          : compact
            ? 'w-[340px] min-h-[540px]'
            : ''
      }`}
    >
      <div className={`cc-phone-screen ${embedded ? '!rounded-[22px]' : ''}`}>
        {/* Clean Native iOS Header */}
        <header className="cc-glass cc-divider-b flex-none px-4 pt-2.5 pb-2.5">
          <div className="mb-2 flex items-center justify-between text-[11px] font-semibold tracking-tight text-foreground/90">
            <span className="tabular-nums">09:41</span>
            <span className="cc-phone-island" aria-hidden="true" />
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>5G</span>
              <span className="inline-block h-2.5 w-4 rounded-[3px] border border-current p-[1px]">
                <span className="block h-full w-3/4 rounded-[1px] bg-current" />
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {subPage.kind !== 'none' && (
                <button
                  type="button"
                  aria-label="返回上一页"
                  onClick={() => setSubPage({ kind: 'none' })}
                  className="inline-flex size-6.5 items-center justify-center rounded-full hover:bg-muted cursor-pointer"
                >
                  <ArrowLeftIcon size={15} />
                </button>
              )}
              <span className="truncate text-[15px] font-semibold tracking-tight">{pageTitle}</span>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--cc-emerald-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-emerald)]">
              <span className="cc-live-dot text-[var(--cc-emerald)]" />
              已同步
            </span>
          </div>
        </header>

        {/* Patient Account Switcher Strip */}
        <div className="cc-divider-b flex flex-none items-center justify-between gap-2 bg-[var(--cc-surface-subtle)] px-3.5 py-1.5 text-[11px]">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="inline-flex size-4.5 items-center justify-center rounded-full bg-foreground text-[9.5px] font-semibold text-background">
              {patient.avatar}
            </span>
            <span className="truncate font-medium text-foreground">{patient.name}</span>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-[var(--cc-sheet)] p-0.5 shadow-[0_0_0_1px_var(--cc-hairline)]">
            {(['patient_a', 'patient_b', 'patient_c'] as PatientKey[]).map((key, idx) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  actions.setPatient(key)
                  setSubPage({ kind: 'none' })
                }}
                className={`h-5 rounded-md px-1.5 text-[10px] font-medium transition-all cursor-pointer ${
                  state.currentPatient === key
                    ? 'bg-foreground text-background shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {['患者A', '患者B', '患者C'][idx]}
              </button>
            ))}
          </div>
        </div>

        {/* Cross-Patient Isolation Banner */}
        {state.lastIsolationBlock && (
          <div className="flex flex-none items-start gap-2 border-b border-[var(--cc-crimson)]/20 bg-[var(--cc-crimson-soft)] px-3.5 py-2 text-[11px] text-[var(--cc-crimson)]">
            <ShieldAlertIcon size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 leading-snug">
              <strong className="font-semibold">403 越权访问已拒绝</strong>
              <p className="m-0 opacity-90">{state.lastIsolationBlock}</p>
            </div>
          </div>
        )}

        {/* Main Scrollable Viewport */}
        <div className="cc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* SUBPAGE: BOOKING */}
          {subPage.kind === 'book' && (
            <div className="flex min-h-full flex-col">
              <div className="flex flex-1 flex-col gap-2.5 p-3">
                {subPage.prefilledSlotId && (
                  <div className="cc-ai-card flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--cc-ai)]">
                    <SparklesIcon size={13} className="shrink-0" />
                    <span>已由 AI 助手预填号源，请核对时段后本人确认。</span>
                  </div>
                )}

                <div className="cc-surface p-3">
                  <div className="cc-kicker mb-2">选择可用号源 · 实时余量</div>
                  <div className="flex flex-col gap-1.5">
                    {state.slots.map((slot) => {
                      const remaining = slot.capacity - slot.booked
                      const full = remaining <= 0
                      const selected = selectedSlotId === slot.id
                      return (
                        <button
                          key={slot.id}
                          type="button"
                          onClick={() => setSelectedSlotId(slot.id)}
                          className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-left transition-all cursor-pointer ${
                            selected
                              ? 'bg-[var(--cc-ai-soft)] shadow-[0_0_0_1.5px_var(--cc-ai)]'
                              : 'bg-[var(--cc-surface-subtle)] hover:bg-[var(--cc-surface-hover)]'
                          }`}
                        >
                          <div>
                            <div className="text-[12.5px] font-semibold">
                              {slot.doctorName} · {slot.department}
                            </div>
                            <div className="mt-0.5 text-[10.5px] text-muted-foreground tabular-nums">
                              {slot.dateLabel} {slot.timeRange}
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
                              full
                                ? 'bg-[var(--cc-crimson-soft)] text-[var(--cc-crimson)]'
                                : 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                            }`}
                          >
                            {full ? '已满 (0)' : `余 ${remaining} 号`}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="cc-surface p-3">
                  <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
                    就诊简述（同步至医生端队列）
                  </label>
                  <input
                    value={bookingComplaint}
                    onChange={(e) => setBookingComplaint(e.target.value)}
                    className="h-8 w-full rounded-lg border border-border/80 bg-[var(--cc-surface-subtle)] px-2.5 text-[12px]"
                  />
                </div>

                {bookingFeedback && (
                  <div
                    className={`rounded-xl px-3 py-2 text-[11.5px] leading-snug ${
                      bookingFeedback.ok
                        ? 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                        : 'bg-[var(--cc-crimson-soft)] text-[var(--cc-crimson)]'
                    }`}
                  >
                    {bookingFeedback.text}
                  </div>
                )}
              </div>

              <div className="cc-glass cc-divider-t sticky bottom-0 p-3">
                <button
                  type="button"
                  onClick={() =>
                    handleConfirmBooking(subPage.prefilledSlotId ? 'agent_assisted' : 'manual')
                  }
                  className="cc-btn-primary h-10 w-full rounded-xl text-[13px]"
                >
                  <CheckCircle2Icon size={15} />
                  本人确认提交预约
                </button>
              </div>
            </div>
          )}

          {/* SUBPAGE: RECORDS / REPORTS / PRESCRIPTIONS LIST */}
          {(subPage.kind === 'records' ||
            subPage.kind === 'reports' ||
            subPage.kind === 'prescriptions') && (
            <div className="flex flex-col gap-2.5 p-3.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>仅展示医生已签署并显式发布的正式资料</span>
                <LockIcon size={11} />
              </div>
              {(() => {
                const list =
                  subPage.kind === 'records'
                    ? myRecords
                    : subPage.kind === 'reports'
                      ? myReports
                      : myPrescriptions
                if (list.length === 0) {
                  return (
                    <div className="cc-surface p-6 text-center text-[12px] text-muted-foreground">
                      暂无已发布资料（未发布结果不会提前展示）
                    </div>
                  )
                }
                return list.map((res) => (
                  <button
                    key={res.id}
                    type="button"
                    onClick={() => openResourceDetail(res.id)}
                    className="cc-surface flex flex-col gap-1.5 p-3.5 text-left transition-transform active:scale-[0.99] cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-foreground">{res.title}</span>
                      <span className="rounded-full bg-[var(--cc-emerald-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-emerald)]">
                        已发布 v{res.version}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">{res.subtitle}</div>
                    <p className="m-0 line-clamp-2 text-[11.5px] leading-relaxed text-foreground/80">
                      {res.summary}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-[10.5px] text-muted-foreground">
                      <span>{res.department} · {res.doctorName}</span>
                      <span className="inline-flex items-center gap-0.5 font-semibold text-[var(--cc-ai)]">
                        查看详情 <ChevronRightIcon size={12} />
                      </span>
                    </div>
                  </button>
                ))
              })()}
            </div>
          )}

          {/* SUBPAGE: RESOURCE DETAIL */}
          {subPage.kind === 'record_detail' && activeDetailResource && (
            <div className="flex flex-col gap-3 p-3.5">
              <div className="cc-surface p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--cc-emerald-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-emerald)]">
                    <ShieldCheckIcon size={10} /> 已核验本人归属
                  </span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    v{activeDetailResource.version} · {activeDetailResource.publishedAt}
                  </span>
                </div>
                <h3 className="mt-2 mb-1 text-[14.5px] font-semibold leading-snug">
                  {activeDetailResource.title}
                </h3>
                <p className="m-0 text-[11.5px] text-muted-foreground">
                  {activeDetailResource.department} · {activeDetailResource.doctorName}
                </p>
                <p className="mt-2.5 mb-0 rounded-xl bg-[var(--cc-surface-subtle)] p-3 text-[12px] leading-relaxed">
                  {activeDetailResource.summary}
                </p>
              </div>

              <div className="cc-surface p-3.5">
                <div className="cc-kicker mb-2">结构化临床详情（只读）</div>
                <dl className="m-0 flex flex-col divide-y divide-[var(--cc-hairline)]">
                  {activeDetailResource.details.map((row) => (
                    <div key={row.label} className="flex items-start justify-between gap-3 py-2 text-[12px]">
                      <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
                      <dd
                        className={`m-0 text-right font-medium ${
                          row.flag === 'high'
                            ? 'text-[var(--cc-crimson)]'
                            : row.flag === 'low'
                              ? 'text-[var(--cc-amber)]'
                              : 'text-foreground'
                        }`}
                      >
                        {row.value}
                        {row.flag === 'high' && ' ↑'}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}

          {/* SUBPAGE: FOLLOWUP QUESTIONNAIRE */}
          {subPage.kind === 'followup' && activeFollowupPlan && (
            <div className="flex flex-col gap-3 p-3.5">
              <div className="cc-ai-card p-3.5">
                <div className="text-[12.5px] font-semibold text-foreground">
                  {activeFollowupPlan.taskTitle}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  提交后实时同步至随访群与医生端工作台。
                </div>
              </div>

              <div className="cc-surface flex flex-col gap-2.5 p-3.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  今日自测体温
                  <input
                    value={fuTemp}
                    onChange={(e) => setFuTemp(e.target.value)}
                    className="mt-1 h-8 w-full rounded-lg border border-border/80 bg-[var(--cc-surface-subtle)] px-2.5 text-[12px] text-foreground"
                  />
                </label>
                <label className="text-[11px] font-medium text-muted-foreground">
                  症状变化自评
                  <input
                    value={fuSymptom}
                    onChange={(e) => setFuSymptom(e.target.value)}
                    className="mt-1 h-8 w-full rounded-lg border border-border/80 bg-[var(--cc-surface-subtle)] px-2.5 text-[12px] text-foreground"
                  />
                </label>
                <label className="text-[11px] font-medium text-muted-foreground">
                  用药依从性
                  <input
                    value={fuAdherence}
                    onChange={(e) => setFuAdherence(e.target.value)}
                    className="mt-1 h-8 w-full rounded-lg border border-border/80 bg-[var(--cc-surface-subtle)] px-2.5 text-[12px] text-foreground"
                  />
                </label>
                <label className="text-[11px] font-medium text-muted-foreground">
                  补充说明
                  <textarea
                    rows={3}
                    value={fuNote}
                    onChange={(e) => setFuNote(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border/80 bg-[var(--cc-surface-subtle)] p-2 text-[12px] text-foreground"
                  />
                </label>
              </div>

              <button
                type="button"
                disabled={activeFollowupPlan.status !== 'active'}
                onClick={() => {
                  actions.submitFollowupQuestionnaire(activeFollowupPlan.id, {
                    temperature: fuTemp,
                    symptomScore: fuSymptom,
                    adherence: fuAdherence,
                    note: fuNote,
                  })
                  setSubPage({ kind: 'chat', conversationId: activeFollowupPlan.conversationId })
                }}
                className="cc-btn-primary h-10 w-full rounded-xl text-[13px]"
              >
                <ClipboardCheckIcon size={15} />
                {activeFollowupPlan.status === 'active' ? '确认提交随访反馈' : '随访计划已关闭'}
              </button>
            </div>
          )}

          {/* SUBPAGE: CHAT ROOM */}
          {subPage.kind === 'chat' && activeChatConv && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="cc-divider-b flex items-center justify-between bg-[var(--cc-surface-subtle)] px-3.5 py-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">{activeChatConv.subtitle}</span>
                {activeChatConv.status === 'read_only' && (
                  <span className="rounded-full bg-[var(--cc-amber-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-amber)]">
                    只读归档
                  </span>
                )}
              </div>

              <div className="cc-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-3">
                {activeChatConv.messages.map((msg) => {
                  const isSelf = msg.senderId === state.currentPatient
                  if (msg.senderKind === 'system') {
                    return (
                      <div
                        key={msg.id}
                        className="mx-auto max-w-[92%] rounded-full bg-[var(--cc-sheet)] px-3 py-1 text-center text-[10px] text-muted-foreground shadow-[0_0_0_1px_var(--cc-hairline)]"
                      >
                        {msg.parts[0]?.type === 'text' ? msg.parts[0].text : ''}
                      </div>
                    )
                  }
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col gap-1 ${isSelf ? 'items-end' : 'items-start'}`}
                    >
                      <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-muted-foreground">
                        {msg.senderKind === 'agent' && (
                          <SparklesIcon size={10} className="text-[var(--cc-ai)]" />
                        )}
                        <span className="font-medium">{msg.senderName}</span>
                        <span className="tabular-nums">{msg.createdAt}</span>
                      </div>
                      <div className={`flex max-w-[88%] flex-col gap-1.5 ${isSelf ? 'items-end' : 'items-start'}`}>
                        {msg.parts.map((part, idx) => {
                          if (part.type === 'text') {
                            return (
                              <div
                                key={idx}
                                className={`rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed ${
                                  isSelf
                                    ? 'cc-mobile-bubble-self rounded-tr-sm'
                                    : msg.senderKind === 'agent'
                                      ? 'cc-ai-card rounded-tl-sm'
                                      : 'cc-surface rounded-tl-sm'
                                }`}
                              >
                                {part.text}
                              </div>
                            )
                          }
                          if (part.type === 'audio') {
                            const isPlaying = playingAudioId === part.attachmentId
                            const showTr = showTranscriptId[part.attachmentId] ?? true
                            return (
                              <div
                                key={idx}
                                className={`flex flex-col gap-1.5 rounded-2xl px-3 py-2 text-[12px] ${
                                  isSelf ? 'cc-mobile-bubble-self' : 'cc-surface'
                                }`}
                              >
                                <div className="flex items-center gap-2.5">
                                  <button
                                    type="button"
                                    aria-label={isPlaying ? '停止播放语音' : '播放语音'}
                                    onClick={() =>
                                      setPlayingAudioId(isPlaying ? null : part.attachmentId)
                                    }
                                    className="inline-flex size-6 items-center justify-center rounded-full bg-current/15 cursor-pointer"
                                  >
                                    {isPlaying ? <SquareIcon size={10} /> : <PlayIcon size={11} />}
                                  </button>
                                  <div className="cc-wave" data-playing={isPlaying}>
                                    <span style={{ height: 6 }} />
                                    <span style={{ height: 12 }} />
                                    <span style={{ height: 9 }} />
                                    <span style={{ height: 14 }} />
                                    <span style={{ height: 7 }} />
                                  </div>
                                  <span className="font-mono text-[11px] tabular-nums">
                                    {part.durationSec}″
                                  </span>
                                  {part.transcript && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowTranscriptId((prev) => ({
                                          ...prev,
                                          [part.attachmentId]: !showTr,
                                        }))
                                      }
                                      className="ml-1 text-[10px] underline opacity-75 cursor-pointer"
                                    >
                                      {showTr ? '收起' : '转文字'}
                                    </button>
                                  )}
                                </div>
                                {part.transcript && showTr && (
                                  <div className="border-t border-current/15 pt-1 text-[11px] leading-snug opacity-85">
                                    {part.transcript}
                                  </div>
                                )}
                              </div>
                            )
                          }
                          return (
                            <div key={idx} className="cc-surface w-full min-w-[232px] p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[var(--cc-ai)]">
                                  <SparklesIcon size={11} />
                                  {part.component}
                                </span>
                                {part.statusTag && (
                                  <span className="rounded-full bg-[var(--cc-surface-subtle)] px-2 py-0.5 text-[10px] text-muted-foreground">
                                    {part.statusTag}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 text-[12.5px] font-semibold text-foreground">
                                {part.title}
                              </div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">
                                {part.subtitle}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleCardAction(part)}
                                className="cc-btn-ai mt-2.5 h-7 w-full text-[11.5px]"
                              >
                                {part.actionLabel}
                                <ChevronRightIcon size={12} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {activeChatConv.status === 'read_only' ? (
                <div className="cc-divider-t bg-[var(--cc-surface-subtle)] px-3.5 py-2.5 text-center text-[11px] text-muted-foreground">
                  随访计划已关闭，本群已转为只读归档。
                </div>
              ) : (
                <div className="cc-divider-t flex items-center gap-1.5 bg-[var(--cc-sheet)] px-2.5 py-2">
                  <button
                    type="button"
                    title="模拟发送 8 秒语音消息"
                    onClick={() =>
                      actions.sendVoiceMessage(
                        activeChatConv.id,
                        'patient',
                        '医生您好，我今天体温降到 37.1 度了，咳嗽轻了很多。',
                        8,
                      )
                    }
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--cc-surface-subtle)] text-foreground hover:bg-muted cursor-pointer"
                  >
                    <MicIcon size={14} />
                  </button>
                  <input
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && chatDraft.trim()) {
                        actions.sendMessage(activeChatConv.id, 'patient', chatDraft.trim())
                        setChatDraft('')
                      }
                    }}
                    placeholder="发消息给医护团队…"
                    className="h-8 min-w-0 flex-1 rounded-full border border-border/70 bg-[var(--cc-surface-subtle)] px-3 text-[12px]"
                  />
                  <button
                    type="button"
                    aria-label="发送消息"
                    disabled={!chatDraft.trim()}
                    onClick={() => {
                      if (!chatDraft.trim()) return
                      actions.sendMessage(activeChatConv.id, 'patient', chatDraft.trim())
                      setChatDraft('')
                    }}
                    className="cc-btn-primary size-8 shrink-0 rounded-full p-0"
                  >
                    <ArrowUpIcon size={14} />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* MAIN TAB 1: HOME */}
          {subPage.kind === 'none' && tab === 'home' && (
            <div className="flex flex-col gap-3 p-3.5">
              {/* Apple Health × Linear Hero Card */}
              <div className="cc-surface cc-ambient-wash p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[11px] font-medium text-muted-foreground">您好，{patient.name}</div>
                    <h3 className="m-0 mt-0.5 text-[17px] font-semibold tracking-tight">
                      ClinMesh 智慧门诊
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTab('assistant')}
                    className="cc-btn-ai h-7 rounded-full px-2.5 text-[11px]"
                  >
                    <SparklesIcon size={12} />
                    问助手
                  </button>
                </div>

                {/* 4 Elevated Service Tiles */}
                <div className="mt-4 grid grid-cols-4 gap-2">
                  {[
                    {
                      label: '预约挂号',
                      icon: CalendarPlusIcon,
                      tone: 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]',
                      onClick: () => {
                        setBookingFeedback(null)
                        setSubPage({ kind: 'book' })
                      },
                    },
                    {
                      label: `病历 ${myRecords.length}`,
                      icon: FileTextIcon,
                      tone: 'bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]',
                      onClick: () => setSubPage({ kind: 'records' }),
                    },
                    {
                      label: `报告 ${myReports.length}`,
                      icon: FlaskConicalIcon,
                      tone: 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]',
                      onClick: () => setSubPage({ kind: 'reports' }),
                    },
                    {
                      label: `处方 ${myPrescriptions.length}`,
                      icon: PillIcon,
                      tone: 'bg-[var(--cc-surface-subtle)] text-foreground',
                      onClick: () => setSubPage({ kind: 'prescriptions' }),
                    },
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={item.onClick}
                      className="flex flex-col items-center gap-1.5 rounded-xl py-2 transition-colors hover:bg-[var(--cc-surface-subtle)] cursor-pointer"
                    >
                      <span className={`inline-flex size-10 items-center justify-center rounded-2xl ${item.tone}`}>
                        <item.icon size={17} />
                      </span>
                      <span className="text-[11px] font-medium text-foreground">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Active Followup Card */}
              {myFollowups.map((plan) => (
                <div key={plan.id} className="cc-ai-card p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cc-ai)]">
                      <SparklesIcon size={12} />
                      随访待办 · {plan.department}
                    </span>
                    <span className="rounded-full bg-[var(--cc-sheet)] px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-2xs">
                      {plan.status === 'completed'
                        ? '已结案'
                        : plan.taskStatus === 'pending'
                          ? '待填写问卷'
                          : plan.taskStatus === 'submitted'
                            ? '已提交待审'
                            : '医生已审核'}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[13.5px] font-semibold tracking-tight">{plan.title}</div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">{plan.taskTitle}</div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSubPage({ kind: 'followup', planId: plan.id })}
                      className="cc-btn-primary h-7.5 px-3 text-[11.5px]"
                    >
                      {plan.taskStatus === 'pending' ? '填写随访问卷' : '查看反馈'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSubPage({ kind: 'chat', conversationId: plan.conversationId })}
                      className="cc-btn-ghost h-7.5 px-2.5 text-[11.5px]"
                    >
                      进入随访群
                    </button>
                  </div>
                </div>
              ))}

              {/* Appointments */}
              <div className="cc-surface p-3.5">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[12.5px] font-semibold">近期预约与就诊</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {myAppointments.length} 条
                  </span>
                </div>
                {myAppointments.length === 0 ? (
                  <p className="m-0 py-3 text-center text-[11.5px] text-muted-foreground">
                    暂无预约，可点击上方「预约挂号」或由助手协助预约
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {myAppointments.map((apt) => {
                      const badge = APPOINTMENT_STATUS_TEXT[apt.status]
                      return (
                        <div
                          key={apt.id}
                          className="flex items-center justify-between rounded-xl bg-[var(--cc-surface-subtle)] p-2.5"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12.5px] font-semibold">{apt.doctorName}</span>
                              <span className="text-[11px] text-muted-foreground">{apt.department}</span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                              {apt.dateLabel} {apt.timeRange}
                            </div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.tone}`}>
                            {badge.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* MAIN TAB 2: MESSAGES */}
          {subPage.kind === 'none' && tab === 'messages' && (
            <div className="flex flex-col divide-y divide-[var(--cc-hairline)] bg-[var(--cc-sheet)]">
              {myConversations.length === 0 ? (
                <div className="p-8 text-center text-[12px] text-muted-foreground">
                  当前患者暂无已建立的医患会话
                </div>
              ) : (
                myConversations.map((conv) => {
                  const last = conv.messages.at(-1)
                  const preview =
                    last?.parts[0]?.type === 'text'
                      ? last.parts[0].text
                      : last?.parts[0]?.type === 'audio'
                        ? `[语音 ${last.parts[0].durationSec}″]`
                        : '[业务卡片]'
                  return (
                    <button
                      key={conv.id}
                      type="button"
                      onClick={() => setSubPage({ kind: 'chat', conversationId: conv.id })}
                      className="flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--cc-surface-subtle)] cursor-pointer"
                    >
                      <div
                        className={`relative flex size-10 shrink-0 items-center justify-center rounded-2xl text-[12.5px] font-semibold ${
                          conv.type === 'followup_group'
                            ? 'bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]'
                            : 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                        }`}
                      >
                        {conv.type === 'followup_group' ? '随访' : '王医'}
                        {conv.unreadPatient > 0 && (
                          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-[var(--cc-crimson)] text-[9.5px] font-bold text-white">
                            {conv.unreadPatient}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[13px] font-semibold">{conv.title}</span>
                          <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                            {last?.createdAt}
                          </span>
                        </div>
                        <p className="m-0 mt-0.5 truncate text-[11.5px] text-muted-foreground">
                          {conv.status === 'read_only' ? '[只读] ' : ''}
                          {preview}
                        </p>
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          )}

          {/* MAIN TAB 3: PATIENT SERVICE AGENT */}
          {subPage.kind === 'none' && tab === 'assistant' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="cc-divider-b flex items-center justify-between bg-[var(--cc-ai-soft)] px-3.5 py-2 text-[11px] text-[var(--cc-ai)]">
                <span className="flex items-center gap-1.5 font-semibold">
                  <SparklesIcon size={12} />
                  Patient Service Agent
                </span>
                <span className="font-mono text-[10px] opacity-80">仅本人投影 · WS</span>
              </div>

              <div className="cc-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-3">
                {(assistantConv?.messages ?? []).map((msg) => {
                  const isSelf = msg.senderKind === 'human'
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col gap-1.5 ${isSelf ? 'items-end' : 'items-start'}`}
                    >
                      {msg.agentRunId && (
                        <div className="inline-flex items-center gap-1 rounded-full bg-[var(--cc-sheet)] px-2 py-0.5 font-mono text-[10px] text-muted-foreground shadow-2xs">
                          <WrenchIcon size={10} className="text-[var(--cc-ai)]" />
                          <span>verified · {msg.agentRunId}</span>
                        </div>
                      )}
                      {msg.parts.map((part, idx) => {
                        if (part.type === 'text') {
                          return (
                            <div
                              key={idx}
                              className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-[12.5px] leading-relaxed ${
                                isSelf
                                  ? 'cc-mobile-bubble-self rounded-tr-sm'
                                  : 'cc-surface rounded-tl-sm'
                              }`}
                            >
                              {part.text}
                            </div>
                          )
                        }
                        if (part.type === 'card') {
                          return (
                            <div key={idx} className="cc-ai-card w-full p-3.5">
                              <div className="flex items-center justify-between">
                                <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[var(--cc-ai)]">
                                  <SparklesIcon size={11} />
                                  {part.component}
                                </span>
                                {part.statusTag && (
                                  <span className="rounded-full bg-[var(--cc-ai-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-ai)]">
                                    {part.statusTag}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1.5 text-[13px] font-semibold">{part.title}</div>
                              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                                {part.subtitle}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleCardAction(part)}
                                className="cc-btn-primary mt-3 h-8 w-full text-[12px]"
                              >
                                {part.actionLabel}
                                <ChevronRightIcon size={13} />
                              </button>
                            </div>
                          )
                        }
                        return null
                      })}
                    </div>
                  )
                })}
              </div>

              <div className="cc-divider-t flex flex-wrap gap-1.5 bg-[var(--cc-surface-subtle)] px-3 pt-2 pb-1.5">
                {[
                  '帮我预约王医生明天上午的门诊',
                  '打开最近一次病历',
                  '查看已发布的报告',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => sendAssistantPrompt(prompt)}
                    className="cc-btn-ai h-6.5 rounded-full px-2.5 text-[10.5px]"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              <div className="cc-divider-t flex items-center gap-1.5 bg-[var(--cc-sheet)] px-2.5 py-2">
                <input
                  value={assistantDraft}
                  onChange={(e) => setAssistantDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendAssistantPrompt(assistantDraft)
                  }}
                  placeholder="问号源、查病历或联系医生…"
                  className="h-8 min-w-0 flex-1 rounded-full border border-border/70 bg-[var(--cc-surface-subtle)] px-3 text-[12px]"
                />
                <button
                  type="button"
                  aria-label="发送给助手"
                  disabled={!assistantDraft.trim()}
                  onClick={() => sendAssistantPrompt(assistantDraft)}
                  className="cc-btn-primary size-8 shrink-0 rounded-full p-0"
                >
                  <ArrowUpIcon size={14} />
                </button>
              </div>
            </div>
          )}

          {/* MAIN TAB 4: PROFILE */}
          {subPage.kind === 'none' && tab === 'profile' && (
            <div className="flex flex-col gap-3 p-3.5">
              <div className="cc-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-foreground text-[17px] font-bold text-background">
                    {patient.avatar}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <strong className="text-[15px] font-semibold">{patient.name}</strong>
                      <span className="text-[11.5px] text-muted-foreground">
                        {patient.sex} · {patient.age} 岁
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                      {patient.patientId} · {patient.inviteCode}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                  {patient.allergies.map((a) => (
                    <span
                      key={a}
                      className="rounded-lg bg-[var(--cc-crimson-soft)] px-2 py-0.5 font-medium text-[var(--cc-crimson)]"
                    >
                      过敏：{a}
                    </span>
                  ))}
                  {patient.chronicConditions.map((c) => (
                    <span
                      key={c}
                      className="rounded-lg bg-[var(--cc-surface-subtle)] px-2 py-0.5 text-muted-foreground"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              <div className="cc-surface p-3.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <ShieldCheckIcon size={14} className="text-[var(--cc-ai)]" />
                  <span>跨患者隔离验证</span>
                </div>
                <p className="mt-1 mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
                  以患者 B（陈志远）身份尝试打开患者 A（李建国）的病历，服务端安全投影将直接拦截返回 403。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (state.currentPatient === 'patient_a') {
                      actions.setPatient('patient_b')
                    }
                    actions.testCrossPatientIsolation()
                  }}
                  className="flex h-8.5 w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--cc-crimson-soft)] text-[11.5px] font-semibold text-[var(--cc-crimson)] hover:opacity-90 cursor-pointer"
                >
                  <ShieldAlertIcon size={13} />
                  越权探针：患者 B 尝试访问患者 A 病历
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Clean 4-Tab Mobile Bottom Bar */}
        <nav
          aria-label="手机版底部导航"
          className="cc-glass cc-divider-t grid flex-none grid-cols-4 px-2 pt-1.5 pb-3"
        >
          {(
            [
              { id: 'home', label: '首页', icon: HomeIcon },
              { id: 'messages', label: '消息', icon: MessageCircleIcon, badge: unreadMessages },
              { id: 'assistant', label: '助手', icon: SparklesIcon },
              { id: 'profile', label: '我的', icon: UserIcon },
            ] as const
          ).map((item) => {
            const active = subPage.kind === 'none' && tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSubPage({ kind: 'none' })
                  setTab(item.id)
                }}
                className={`relative flex flex-col items-center gap-0.5 py-1 text-[10.5px] font-medium transition-colors cursor-pointer ${
                  active
                    ? item.id === 'assistant'
                      ? 'text-[var(--cc-ai)] font-semibold'
                      : 'text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className="relative">
                  <item.icon size={18} strokeWidth={active ? 2.2 : 1.75} />
                  {'badge' in item && item.badge > 0 && (
                    <span className="absolute -top-1 -right-2 flex size-3.5 items-center justify-center rounded-full bg-[var(--cc-crimson)] text-[9.5px] font-bold text-white">
                      {item.badge}
                    </span>
                  )}
                </span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
