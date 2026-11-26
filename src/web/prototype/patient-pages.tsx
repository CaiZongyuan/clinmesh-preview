import { Button } from '@ui-sdk/react/button'
import { Field, FieldLabel } from '@ui-sdk/react/field'
import { Radio, RadioGroup, RadioIndicator } from '@ui-sdk/react/radio'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from '@ui-sdk/react/slider'
import { Textarea } from '@ui-sdk/react/textarea'
import {
  BellIcon,
  CalendarPlusIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FileTextIcon,
  FlaskConicalIcon,
  LockIcon,
  MapPinIcon,
  PillIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StethoscopeIcon,
  XIcon,
} from 'lucide-react'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { ListSkeleton, Spinner, useDelayedFlag } from './clinic-motion'
import {
  PATIENTS,
  STAFF_ACTORS,
  type ClinicActions,
  type ClinicConversation,
  type ConnectedClinicState,
  type PatientKey,
  type PublishedResource,
} from './connected-clinic-store'
import { PRIMARY_DOCTOR } from './patient-agent-script'
import { Avatar, ConversationAvatar, conversationTitle, variantOf, type ChatIntent } from './patient-chat'

export type ResourceKind = PublishedResource['kind']

const KIND_META: Record<ResourceKind, { label: string; icon: ReactNode; tone?: 'warn' | 'violet' }> = {
  record: { label: '病历', icon: <FileTextIcon size={19} /> },
  report: { label: '报告', icon: <FlaskConicalIcon size={19} />, tone: 'warn' },
  prescription: { label: '处方', icon: <PillIcon size={19} />, tone: 'violet' },
}

export function PageHeader({ title, onBack, right, sub }: { title: string; onBack?: () => void; right?: ReactNode; sub?: string }) {
  return (
    <header className="cc-m-header" data-bordered="">
      {onBack && (
        <Button className="cc-m-iconbtn" aria-label="返回" onClick={onBack}>
          <ChevronLeftIcon size={26} />
        </Button>
      )}
      <div className="cc-m-header-main" style={onBack ? undefined : { paddingLeft: 10 }}>
        <div className="min-w-0">
          <h1 className="cc-m-header-title m-0">{title}</h1>
          {sub && <div className="cc-m-header-sub">{sub}</div>}
        </div>
      </div>
      {right ?? (onBack ? <span className="w-10" /> : null)}
    </header>
  )
}

export function IsolationBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="cc-m-banner mx-4 mt-3" data-tone="danger" role="alert">
      <ShieldAlertIcon size={17} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <strong className="block">无权访问</strong>
        {message}
      </div>
      <Button className="cc-m-iconbtn -m-2 size-8" aria-label="关闭提示" onClick={onDismiss}>
        <XIcon size={16} />
      </Button>
    </div>
  )
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

const VISIT_STEPS = ['已预约', '已签到', '就诊中', '已完成'] as const
const STEP_INDEX: Record<string, number> = { booked: 0, checked_in: 1, in_encounter: 2, completed: 3 }

export function HomePage({
  state,
  onIntent,
  onOpenList,
  onOpenConversation,
  unreadTotal,
}: {
  state: ConnectedClinicState
  onIntent: (intent: ChatIntent) => void
  onOpenList: (kind: ResourceKind) => void
  onOpenConversation: (conversationId: string) => void
  unreadTotal: number
}) {
  const patient = PATIENTS[state.currentPatient]
  const appointments = state.appointments.filter((a) => a.patientKey === state.currentPatient && a.status !== 'cancelled')
  const current = appointments.find((a) => a.status === 'in_encounter' || a.status === 'checked_in') ?? appointments.find((a) => a.status === 'booked') ?? appointments[0]
  const upcoming = appointments.filter((a) => a !== current && a.status === 'booked')
  const published = state.resources.filter((r) => r.patientKey === state.currentPatient && r.published)
  const count = (kind: ResourceKind) => published.filter((r) => r.kind === kind).length
  const plans = state.followupPlans.filter((p) => p.patientKey === state.currentPatient)
  const doctor = STAFF_ACTORS[PRIMARY_DOCTOR[state.currentPatient]]
  const doctorConversation = state.conversations.find((c) => c.type === 'patient_doctor' && c.patientKey === state.currentPatient)
  const stepIndex = current ? STEP_INDEX[current.status] ?? 0 : -1

  return (
    <div className="cc-m-scroll">
      <div className="cc-m-largetitle flex items-start justify-between">
        <div>
          <div className="cc-m-caption">11 月 26 日 · 周四</div>
          <h1>
            {greeting()}，{patient.name.slice(0, 1)}
            {patient.sex === '男' ? '先生' : '女士'}
          </h1>
        </div>
        <Button className="cc-m-iconbtn relative mt-2" data-filled="" aria-label={unreadTotal ? `${unreadTotal} 条未读消息` : '消息'} onClick={() => doctorConversation && onOpenConversation(doctorConversation.id)}>
          <BellIcon size={19} />
          {unreadTotal > 0 && <span className="cc-m-badge absolute -top-1 -right-1">{unreadTotal}</span>}
        </Button>
      </div>

      <div className="cc-m-pad">
        {current ? (
          <section className="cc-m-hero" aria-label="当前就诊">
            <div className="flex items-start gap-3">
              <Avatar tone="doctor" label={current.doctorName.slice(0, 1)} size="lg" presence={current.status === 'in_encounter'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[17px] font-semibold">{current.doctorName}</span>
                  <span className="cc-m-chip" data-tone={current.status === 'in_encounter' ? 'human' : current.status === 'checked_in' ? 'warn' : 'brand'}>
                    {current.status === 'in_encounter' ? '就诊中' : current.status === 'checked_in' ? '候诊中' : current.status === 'completed' ? '已完成' : '已预约'}
                  </span>
                </div>
                <div className="cc-m-muted text-[13.5px]">
                  {current.department} · {current.dateLabel} {current.timeRange}
                </div>
                <div className="cc-m-caption mt-1 flex items-center gap-1">
                  <MapPinIcon size={12} /> 门诊楼 3 层 · {current.department.slice(0, 2)} 2 诊室
                </div>
              </div>
            </div>
            <div className="cc-m-steps" aria-label={`就诊进度：${VISIT_STEPS[stepIndex]}`}>
              {VISIT_STEPS.map((label, index) => (
                <span key={label} className="cc-m-step" data-state={index < stepIndex || stepIndex === 3 ? 'done' : index === stepIndex ? 'current' : undefined}>
                  {label}
                </span>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              {doctorConversation && (
                <Button className="cc-m-btn" data-variant="soft" data-size="sm" style={{ flex: 1 }} onClick={() => onOpenConversation(doctorConversation.id)}>
                  <StethoscopeIcon size={15} />
                  联系医生
                </Button>
              )}
              <Button className="cc-m-btn" data-variant="soft" data-size="sm" style={{ flex: 1 }} onClick={() => onIntent({ kind: 'book', fromAgent: false })}>
                <CalendarPlusIcon size={15} />
                预约复诊
              </Button>
            </div>
          </section>
        ) : (
          <section className="cc-m-hero">
            <div className="text-[17px] font-semibold">暂无就诊安排</div>
            <p className="cc-m-muted m-0 mt-1 text-[14px]">需要看医生时，可以直接预约，或让 AI 帮你找合适的号源。</p>
          </section>
        )}

        <Button className="cc-m-askpill" onClick={(event) => onIntent({ kind: 'assistant', origin: event.currentTarget })}>
          <SparklesIcon size={18} className="shrink-0 text-[#8b7bff]" />
          <span className="truncate">问 AI：预约、查报告、用药、找医生…</span>
          <span className="cc-m-askpill-go" aria-hidden="true">
            <SparklesIcon size={16} />
          </span>
        </Button>

        <div className="cc-m-card cc-m-services mt-3">
          <Button className="cc-m-service cc-m-pressable" onClick={() => onIntent({ kind: 'book', fromAgent: false })}>
            <span className="cc-m-tile" data-tone="human">
              <CalendarPlusIcon size={21} />
            </span>
            预约挂号
          </Button>
          {(['record', 'report', 'prescription'] as const).map((kind) => (
            <Button key={kind} className="cc-m-service cc-m-pressable" onClick={() => onOpenList(kind)}>
              <span className="cc-m-tile" data-tone={KIND_META[kind].tone}>
                {KIND_META[kind].icon}
                {count(kind) > 0 && <span className="cc-m-badge" style={{ background: 'var(--m-text)', color: 'var(--m-card)' }}>{count(kind)}</span>}
              </span>
              我的{KIND_META[kind].label}
            </Button>
          ))}
        </div>

        {plans.length > 0 && (
          <>
            <div className="cc-m-section">
              <h2>随访待办</h2>
            </div>
            {plans.map((plan) => {
              const pending = plan.status === 'active' && plan.taskStatus === 'pending'
              return (
                <div key={plan.id} className="cc-m-card mb-2.5 p-4">
                  <div className="flex items-start gap-3">
                    <span className="cc-m-tile" data-tone={pending ? 'warn' : 'human'}>
                      {pending ? <ClipboardListIcon size={19} /> : <CheckIcon size={19} strokeWidth={2.6} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold leading-snug">{plan.taskTitle.replace(/^第 \d+ 次：/, '')}</div>
                      <div className="cc-m-caption mt-0.5">
                        {plan.title} · {plan.status !== 'active' ? '已结束' : pending ? plan.dueLabel : plan.taskStatus === 'submitted' ? '已提交，等待医生审核' : '医生已审核'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button className="cc-m-btn" data-variant={pending ? 'brand' : 'soft'} data-size="sm" style={{ flex: 1 }} onClick={() => onIntent({ kind: 'followup', planId: plan.id })}>
                      {pending ? '去填写 · 约 30 秒' : '查看我的反馈'}
                    </Button>
                    <Button className="cc-m-btn" data-variant="soft" data-size="sm" onClick={() => onOpenConversation(plan.conversationId)}>
                      随访群
                    </Button>
                  </div>
                </div>
              )
            })}
          </>
        )}

        {upcoming.length > 0 && (
          <>
            <div className="cc-m-section">
              <h2>接下来</h2>
            </div>
            <div className="cc-m-list !mx-0">
              {upcoming.map((apt) => (
                <div key={apt.id} className="cc-m-row cursor-default">
                  <span className="cc-m-tile" data-tone="human">
                    <CalendarPlusIcon size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="cc-m-row-title">{apt.doctorName}</div>
                    <div className="cc-m-row-preview">
                      {apt.dateLabel} {apt.timeRange} · {apt.department}
                    </div>
                  </div>
                  {apt.source === 'agent_assisted' && (
                    <span className="cc-m-chip" data-tone="brand">
                      <SparklesIcon size={11} />
                      AI 协助
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="cc-m-section">
          <h2>我的医护团队</h2>
        </div>
        <div className="cc-m-list !mx-0">
          {doctorConversation && (
            <Button className="cc-m-row" onClick={() => onOpenConversation(doctorConversation.id)}>
              <Avatar tone="doctor" label={doctor.avatar} presence />
              <div className="min-w-0 flex-1">
                <div className="cc-m-row-title">
                  {doctor.name} 医生 <span className="cc-m-chip">{doctor.title.split(' · ')[0]}</span>
                </div>
                <div className="cc-m-row-preview">{doctor.department} · 主管医生</div>
              </div>
              <ChevronRightIcon size={18} className="text-[var(--m-text-3)]" />
            </Button>
          )}
          <Button className="cc-m-row" onClick={(event) => onIntent({ kind: 'assistant', origin: event.currentTarget })}>
            <Avatar tone="agent" label="AI" />
            <div className="min-w-0 flex-1">
              <div className="cc-m-row-title">
                AI 就医助手 <span className="cc-m-chip" data-tone="ai">AI</span>
              </div>
              <div className="cc-m-row-preview">24 小时在线 · 不做诊断</div>
            </div>
            <ChevronRightIcon size={18} className="text-[var(--m-text-3)]" />
          </Button>
        </div>
        <p className="cc-m-caption mt-6 text-center">演示环境 · 全部为合成数据 · 紧急情况请拨打 120</p>
      </div>
    </div>
  )
}

function lastPreview(conversation: ClinicConversation, selfId: string) {
  const last = conversation.messages.at(-1)
  if (!last) return ''
  const first = last.parts[0]
  const body = !first ? '' : first.type === 'text' ? first.text : first.type === 'audio' ? `[语音] ${first.transcript ?? ''}` : `[${first.title}]`
  if (last.senderKind === 'system') return body
  if (last.senderId === selfId) return `我：${body}`
  if (conversation.type === 'followup_group') return `${last.senderName.split(' ')[0]}：${body}`
  return body
}

export function InboxPage({
  state,
  onOpenConversation,
  onOpenAssistant,
}: {
  state: ConnectedClinicState
  onOpenConversation: (conversationId: string) => void
  onOpenAssistant: (origin: HTMLElement) => void
}) {
  const [query, setQuery] = useState('')
  const selfId = state.currentPatient
  const assistant = state.conversations.find((c) => c.type === 'patient_assistant' && c.patientKey === selfId)
  const care = state.conversations
    .filter((c) => c.patientKey === selfId && c.type !== 'patient_assistant')
    .filter((c) => !query || conversationTitle(c).includes(query) || lastPreview(c, selfId).includes(query))
  const assistantLast = assistant?.messages.findLast((m) => m.senderKind === 'agent')
  const assistantText = assistantLast?.parts.find((p) => p.type === 'text')

  return (
    <div className="cc-m-scroll">
      <div className="cc-m-largetitle">
        <h1>消息</h1>
      </div>
      <label className="cc-m-search">
        <SearchIcon size={16} />
        <input aria-label="搜索会话" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>

      {assistant && !query && (
        <Button className="cc-m-row cc-m-ai-row !w-[calc(100%-32px)]" onClick={(event) => onOpenAssistant(event.currentTarget)}>
          <Avatar tone="agent" label="AI" live={assistantLast?.stream?.status === 'streaming'} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="cc-m-row-title">
                AI 就医助手 <span className="cc-m-chip" data-tone="ai">AI</span>
              </span>
              <span className="cc-m-row-time">{assistantLast?.createdAt}</span>
            </div>
            <div className="cc-m-row-preview">{assistantText?.type === 'text' ? assistantText.text : '预约、查报告、用药问题都可以问我'}</div>
          </div>
        </Button>
      )}

      <div className="cc-m-section !mx-5 !mt-1">
        <span className="cc-m-caption font-semibold uppercase tracking-wide">医护团队</span>
      </div>
      {care.length === 0 ? (
        <p className="cc-m-muted px-6 py-10 text-center text-[14px]">{query ? '没有匹配的会话' : '还没有和医护团队的会话'}</p>
      ) : (
        <div className="cc-m-list">
          {care.map((conversation) => {
            const last = conversation.messages.at(-1)
            const typing = state.typing.staff === conversation.id
            return (
              <Button key={conversation.id} className="cc-m-row" onClick={() => onOpenConversation(conversation.id)}>
                <ConversationAvatar conversation={conversation} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="cc-m-row-title">
                      <span className="truncate">{conversationTitle(conversation)}</span>
                      {variantOf(conversation) === 'group' && <span className="cc-m-chip">群 · {conversation.members.filter((m) => m.status === 'active').length}</span>}
                      {conversation.status === 'read_only' && <LockIcon size={13} className="text-[var(--m-text-3)]" />}
                    </span>
                    <span className="cc-m-row-time">{last?.createdAt}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="cc-m-row-preview flex-1" style={typing ? { color: 'var(--m-human)' } : undefined}>
                      {typing ? '对方正在输入…' : lastPreview(conversation, selfId)}
                    </span>
                    {conversation.unreadPatient > 0 && <span className="cc-m-badge">{conversation.unreadPatient}</span>}
                  </div>
                </div>
              </Button>
            )
          })}
        </div>
      )}
      <p className="cc-m-caption px-8 py-6 text-center">医生出诊时回复可能稍慢。身体不适加重或出现胸痛、呼吸困难时，请直接拨打 120。</p>
    </div>
  )
}

export function BookingPage({
  state,
  actions,
  prefilledSlotId,
  fromAgent,
  onBack,
  onDone,
}: {
  state: ConnectedClinicState
  actions: ClinicActions
  prefilledSlotId?: string
  fromAgent: boolean
  onBack: () => void
  onDone: (intent: ChatIntent | null) => void
}) {
  const initialSlot = state.slots.find((s) => s.id === prefilledSlotId)
  const doctors = Array.from(new Set(state.slots.map((s) => s.doctorId)))
  const [doctorId, setDoctorId] = useState(initialSlot?.doctorId ?? PRIMARY_DOCTOR[state.currentPatient])
  const doctorSlots = state.slots.filter((s) => s.doctorId === doctorId)
  const [slotId, setSlotId] = useState<string>(initialSlot?.id ?? doctorSlots.find((s) => s.booked < s.capacity)?.id ?? '')
  const [complaint, setComplaint] = useState(PATIENTS[state.currentPatient].chiefComplaint ? `复诊：${PATIENTS[state.currentPatient].chiefComplaint}` : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [booked, setBooked] = useState<string | null>(null)
  const slot = state.slots.find((s) => s.id === slotId)

  const submit = () => {
    if (!slot) return
    setSubmitting(true)
    setError(null)
    setTimeout(() => {
      const result = actions.bookAppointment(slot.id, fromAgent ? 'agent_assisted' : 'manual', complaint)
      setSubmitting(false)
      if (result.ok) setBooked(result.message)
      else setError(result.message)
    }, 750)
  }

  if (booked && slot) {
    return (
      <div className="cc-m-view">
        <PageHeader title="预约成功" onBack={() => onDone(null)} />
        <div className="cc-m-scroll">
          <div className="flex flex-col items-center px-6 pt-10 pb-6 text-center">
            <span className="cc-m-success-mark">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <h2 className="m-0 mt-6 text-[22px] font-bold">已为你预约</h2>
            <p className="cc-m-muted m-0 mt-1 text-[14.5px]">医生端队列已同步，就诊前一天会提醒你</p>
          </div>
          <div className="cc-m-pad">
            <dl className="cc-m-card m-0 px-4 py-1">
              <div className="cc-m-kv">
                <dt>医生</dt>
                <dd>
                  {slot.doctorName} · {slot.department}
                </dd>
              </div>
              <div className="cc-m-kv">
                <dt>时间</dt>
                <dd>
                  {slot.dateLabel} {slot.timeRange}
                </dd>
              </div>
              <div className="cc-m-kv">
                <dt>就诊说明</dt>
                <dd>{complaint || '—'}</dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="cc-m-bottombar flex gap-2">
          <Button className="cc-m-btn" data-variant="soft" style={{ flex: 1 }} onClick={() => onDone({ kind: 'assistant', prompt: '复诊前需要准备什么' })}>
            <SparklesIcon size={16} />
            就诊须知
          </Button>
          <Button className="cc-m-btn" style={{ flex: 1 }} onClick={() => onDone(null)}>
            完成
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="cc-m-view">
      <PageHeader title="预约挂号" onBack={onBack} />
      <div className="cc-m-scroll">
        <div className="cc-m-pad flex flex-col gap-3 pt-3">
          {fromAgent && (
            <div className="cc-m-banner" data-tone="ai">
              <SparklesIcon size={16} className="mt-0.5 shrink-0" />
              <span>AI 已帮你预填号源，请核对后由你本人确认。确认前不会占号。</span>
            </div>
          )}

          <section className="cc-m-card p-4">
            <div className="cc-m-form-label">选择医生</div>
            <SegmentedControl
              aria-label="选择医生"
              className="cc-m-segmented"
              value={doctorId}
              onValueChange={(value) => {
                if (!value) return
                const next = value as typeof doctorId
                setDoctorId(next)
                setSlotId(state.slots.find((s) => s.doctorId === next && s.booked < s.capacity)?.id ?? '')
                setError(null)
              }}
            >
              <SegmentedControlIndicator />
              {doctors.map((id) => (
                <SegmentedControlItem key={id} value={id}>
                  {STAFF_ACTORS[id].name} · {STAFF_ACTORS[id].department.replace('医学科', '')}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </section>

          <section className="cc-m-card p-4">
            <div className="cc-m-form-label">
              <span>明天 11 月 27 日</span>
              <span className="cc-m-caption font-normal">实时余号</span>
            </div>
            <RadioGroup
              aria-label="选择就诊时段"
              value={slotId}
              onValueChange={(value) => {
                setSlotId(String(value ?? ''))
                setError(null)
              }}
              className="cc-m-slotgroup"
            >
              {doctorSlots.map((s) => {
                const left = s.capacity - s.booked
                return (
                  <label key={s.id} className="cc-m-slot">
                    <Radio value={s.id} disabled={left <= 0} />
                    <span className="cc-m-slot-time">{s.timeRange.split(' ')[0]}</span>
                    <span className="cc-m-slot-left">{left > 0 ? `余 ${left} 号` : '已满'}</span>
                  </label>
                )
              })}
            </RadioGroup>
            {error && (
              <p className="cc-m-banner m-0 mt-3" data-tone="danger" role="alert">
                {error}
              </p>
            )}
          </section>

          <section className="cc-m-card p-4">
            <Field>
              <FieldLabel className="cc-m-form-label">这次想看什么？</FieldLabel>
              <Textarea className="cc-m-textarea" rows={2} value={complaint} onChange={(event) => setComplaint(event.target.value)} placeholder="例如：咳嗽一周，想复查" />
            </Field>
            <p className="cc-m-caption m-0 mt-2">会同步给医生，帮助医生提前了解情况。</p>
          </section>
        </div>
      </div>
      <div className="cc-m-bottombar">
        <div className="mb-2 flex items-center justify-between text-[13.5px]">
          <span className="cc-m-muted">{slot ? `${slot.doctorName} · ${slot.timeRange.split(' ')[0]}` : '请选择时段'}</span>
          <span className="font-semibold">挂号费 ¥0 · 演示</span>
        </div>
        <Button className="cc-m-btn w-full" data-variant="brand" data-busy={submitting || undefined} aria-busy={submitting || undefined} disabled={!slot} onClick={submit}>
          {submitting ? <Spinner size={16} /> : <CheckIcon size={17} strokeWidth={2.6} />}
          本人确认预约
        </Button>
      </div>
    </div>
  )
}

export function RecordsPage({
  state,
  kind,
  loading,
  onKindChange,
  onBack,
  onOpen,
}: {
  state: ConnectedClinicState
  kind: ResourceKind
  loading: boolean
  onKindChange: (kind: ResourceKind) => void
  onBack: () => void
  onOpen: (resourceId: string) => void
}) {
  const showSkeleton = useDelayedFlag(loading)
  const list = state.resources.filter((r) => r.patientKey === state.currentPatient && r.published && r.kind === kind)
  return (
    <div className="cc-m-view">
      <PageHeader title="我的就诊资料" onBack={onBack} />
      <div className="px-4 pt-3 pb-1">
        <SegmentedControl aria-label="资料类型" className="cc-m-segmented" value={kind} onValueChange={(value) => value && onKindChange(value as ResourceKind)}>
          <SegmentedControlIndicator />
          <SegmentedControlItem value="record">病历</SegmentedControlItem>
          <SegmentedControlItem value="report">报告</SegmentedControlItem>
          <SegmentedControlItem value="prescription">处方</SegmentedControlItem>
        </SegmentedControl>
      </div>
      <div className="cc-m-scroll" aria-busy={loading || showSkeleton || undefined}>
        <div className="cc-m-pad pt-3">
          <p className="cc-m-caption m-0 mb-3 flex items-center gap-1.5 px-1">
            <ShieldCheckIcon size={13} /> 只显示医生签署并发布给你的资料
          </p>
          {showSkeleton ? (
            <ListSkeleton rows={2} />
          ) : loading ? null : list.length === 0 ? (
            <div className="cc-m-card flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="cc-m-tile">{KIND_META[kind].icon}</span>
              <div className="text-[15px] font-semibold">暂无{KIND_META[kind].label}</div>
              <p className="cc-m-muted m-0 text-[13.5px]">医生发布后会第一时间通知你</p>
            </div>
          ) : (
            <div className="cc-stagger flex flex-col gap-2.5">
              {list.map((res, index) => (
                <Button key={res.id} className="cc-m-card cc-m-pressable flex flex-col gap-2 p-4" style={{ '--i': index } as CSSProperties} onClick={() => onOpen(res.id)}>
                  <div className="flex items-start gap-3">
                    <span className="cc-m-tile" data-tone={KIND_META[res.kind].tone}>
                      {KIND_META[res.kind].icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold leading-snug">{res.title}</div>
                      <div className="cc-m-caption mt-0.5">
                        {res.department} · {res.doctorName} · {res.publishedAt} 发布
                      </div>
                    </div>
                    {res.version > 1 && <span className="cc-m-chip" data-tone="warn">已更正 v{res.version}</span>}
                  </div>
                  <p className="cc-m-muted m-0 line-clamp-2 text-[13.5px] leading-relaxed">{res.summary}</p>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ResourcePage({
  resource,
  onBack,
  onIntent,
}: {
  resource: PublishedResource
  onBack: () => void
  onIntent: (intent: ChatIntent) => void
}) {
  const meta = KIND_META[resource.kind]
  return (
    <div className="cc-m-view">
      <PageHeader title={`${meta.label}详情`} onBack={onBack} />
      <div className="cc-m-scroll">
        <div className="cc-m-pad flex flex-col gap-3 pt-3">
          <section className="cc-m-card p-4">
            <div className="flex items-center gap-2">
              <span className="cc-m-chip" data-tone="human">
                <ShieldCheckIcon size={12} /> 本人资料
              </span>
              <span className="cc-m-chip">v{resource.version}</span>
              <span className="cc-m-caption ml-auto">{resource.publishedAt} 发布</span>
            </div>
            <h2 className="m-0 mt-3 text-[19px] font-bold leading-snug">{resource.title}</h2>
            <p className="cc-m-muted m-0 mt-1 text-[13.5px]">
              {resource.department} · {resource.doctorName}
            </p>
            <p className="m-0 mt-3 rounded-2xl bg-[var(--m-card-2)] p-3.5 text-[14.5px] leading-relaxed">{resource.summary}</p>
          </section>
          <dl className="cc-m-card m-0 px-4 py-1">
            {resource.details.map((row) => (
              <div key={row.label} className="cc-m-kv">
                <dt>{row.label}</dt>
                <dd>
                  {row.value}
                  {(row.flag === 'high' || row.flag === 'low') && (
                    <span className="cc-m-flag" data-flag={row.flag}>
                      {row.flag === 'high' ? '偏高 ↑' : '偏低 ↓'}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="cc-m-caption m-0 px-1">资料解读以医生意见为准。AI 只能帮你查找和说明，不做诊断。</p>
        </div>
      </div>
      <div className="cc-m-bottombar flex gap-2">
        <Button
          className="cc-m-btn"
          data-variant="ai"
          style={{ flex: 1 }}
          onClick={(event) =>
            onIntent({ kind: 'assistant', origin: event.currentTarget, prompt: resource.kind === 'prescription' ? '药怎么吃' : resource.kind === 'report' ? '血常规结果怎么样' : '打开最近一次病历' })
          }
        >
          <SparklesIcon size={16} />问 AI
        </Button>
        <Button className="cc-m-btn" style={{ flex: 1 }} onClick={() => onIntent({ kind: 'doctor', draft: `医生您好，关于「${resource.title}」我想请教一下：` })}>
          <StethoscopeIcon size={16} />
          问医生
        </Button>
      </div>
    </div>
  )
}

const ADHERENCE = ['按时服药，没有不适', '偶尔漏服', '有不适，已停药'] as const

export function FollowupPage({
  state,
  actions,
  planId,
  onBack,
  onSubmitted,
}: {
  state: ConnectedClinicState
  actions: ClinicActions
  planId: string
  onBack: () => void
  onSubmitted: (conversationId: string) => void
}) {
  const plan = state.followupPlans.find((p) => p.id === planId)
  const [temperature, setTemperature] = useState(37.1)
  const [cough, setCough] = useState(2)
  const [adherence, setAdherence] = useState<string>(ADHERENCE[0])
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  if (!plan) return null
  const response = plan.responses[0]
  const editable = plan.status === 'active' && plan.taskStatus === 'pending'
  const tempTone = temperature >= 38.5 ? 'var(--m-danger)' : temperature >= 37.3 ? 'var(--m-warn)' : 'var(--m-human)'

  const submit = () => {
    setSubmitting(true)
    setTimeout(() => {
      actions.submitFollowupQuestionnaire(plan.id, {
        temperature: `${temperature.toFixed(1)}°C`,
        symptomScore: `咳嗽 ${cough}/10`,
        adherence,
        note: note.trim(),
      })
      setSubmitting(false)
      onSubmitted(plan.conversationId)
    }, 650)
  }

  return (
    <div className="cc-m-view">
      <PageHeader title="随访问卷" sub={plan.title} onBack={onBack} />
      <div className="cc-m-scroll">
        <div className="cc-m-pad flex flex-col gap-3 pt-3">
          <section className="cc-m-banner" data-tone={editable ? 'ai' : 'human'}>
            {editable ? <ClipboardListIcon size={17} className="mt-0.5 shrink-0" /> : <CheckIcon size={17} className="mt-0.5 shrink-0" />}
            <span>
              <strong className="block">{plan.taskTitle}</strong>
              {editable ? `${plan.dueLabel}完成 · 提交后同步给王医生和周护士` : response ? `已于${response.submittedAt}提交` : '本次随访已结束'}
            </span>
          </section>

          {editable ? (
            <>
              <section className="cc-m-card p-4">
                <div className="cc-m-form-label">
                  <span>今天的体温</span>
                  <span className="cc-m-bigvalue" style={{ color: tempTone }}>
                    {temperature.toFixed(1)}°C
                  </span>
                </div>
                <Slider className="cc-m-slider" value={temperature} min={35.5} max={40.5} step={0.1} format={{ maximumFractionDigits: 1 }} onValueChange={(value) => setTemperature(value as number)} style={{ '--slider-fill': tempTone } as CSSProperties}>
                  <SliderControl>
                    <SliderTrack>
                      <SliderIndicator />
                      <SliderThumb aria-label="体温（摄氏度）" />
                    </SliderTrack>
                  </SliderControl>
                </Slider>
                <div className="cc-m-scale">
                  <span>35.5</span>
                  <span>37.3 低热</span>
                  <span>38.5 高热</span>
                  <span>40.5</span>
                </div>
              </section>

              <section className="cc-m-card p-4">
                <div className="cc-m-form-label">
                  <span>咳嗽程度</span>
                  <span className="cc-m-bigvalue">
                    {cough}
                    <span className="cc-m-caption font-normal"> / 10</span>
                  </span>
                </div>
                <Slider className="cc-m-slider" value={cough} min={0} max={10} step={1} onValueChange={(value) => setCough(value as number)}>
                  <SliderControl>
                    <SliderTrack>
                      <SliderIndicator />
                      <SliderThumb aria-label="咳嗽程度，0 为不咳，10 为最严重" />
                    </SliderTrack>
                  </SliderControl>
                </Slider>
                <div className="cc-m-scale">
                  <span>不咳</span>
                  <span>偶尔</span>
                  <span>影响睡眠</span>
                  <span>最严重</span>
                </div>
              </section>

              <section className="cc-m-card p-4">
                <Field>
                  <FieldLabel className="cc-m-form-label">吃药情况</FieldLabel>
                  <RadioGroup value={adherence} onValueChange={(value) => value && setAdherence(String(value))} className="cc-m-options">
                    {ADHERENCE.map((option) => (
                      <label key={option} className="cc-m-option">
                        <Radio value={option}>
                          <RadioIndicator />
                        </Radio>
                        {option}
                      </label>
                    ))}
                  </RadioGroup>
                </Field>
              </section>

              <section className="cc-m-card p-4">
                <Field>
                  <FieldLabel className="cc-m-form-label">还有想告诉医生的吗？</FieldLabel>
                  <Textarea className="cc-m-textarea" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="选填，例如：晚上还会咳醒" />
                </Field>
              </section>
              {temperature >= 38.5 && (
                <div className="cc-m-banner" data-tone="danger" role="alert">
                  <ShieldAlertIcon size={16} className="mt-0.5 shrink-0" />
                  体温超过 38.5°C。提交后医护会尽快查看；若伴有胸闷气促，请立即就医。
                </div>
              )}
            </>
          ) : response ? (
            <dl className="cc-m-card m-0 px-4 py-1">
              <div className="cc-m-kv">
                <dt>体温</dt>
                <dd>{response.temperature}</dd>
              </div>
              <div className="cc-m-kv">
                <dt>症状</dt>
                <dd>{response.symptomScore}</dd>
              </div>
              <div className="cc-m-kv">
                <dt>吃药情况</dt>
                <dd>{response.adherence}</dd>
              </div>
              {response.note && (
                <div className="cc-m-kv">
                  <dt>补充</dt>
                  <dd>{response.note}</dd>
                </div>
              )}
            </dl>
          ) : null}
        </div>
      </div>
      {editable && (
        <div className="cc-m-bottombar">
          <Button className="cc-m-btn w-full" data-variant="brand" data-busy={submitting || undefined} aria-busy={submitting || undefined} onClick={submit}>
            {submitting ? <Spinner size={16} /> : <CheckIcon size={17} strokeWidth={2.6} />}
            提交给医护团队
          </Button>
        </div>
      )}
    </div>
  )
}

export function MembersPage({ conversation, onBack }: { conversation: ClinicConversation; onBack: () => void }) {
  return (
    <div className="cc-m-view">
      <PageHeader title="群成员" sub={conversationTitle(conversation)} onBack={onBack} />
      <div className="cc-m-scroll">
        <div className="cc-m-pad pt-3">
          <div className="cc-m-list !mx-0">
            {conversation.members.map((member) => {
              const tone = member.kind === 'agent' ? 'agent' : member.id in PATIENTS ? 'patient' : member.id === 'nurse_n' ? 'nurse' : 'doctor'
              return (
                <div key={member.id} className="cc-m-row cursor-default" style={member.status === 'removed' ? { opacity: 0.45 } : undefined}>
                  <Avatar tone={tone} label={member.avatar} />
                  <div className="min-w-0 flex-1">
                    <div className="cc-m-row-title">
                      {member.name}
                      {member.kind === 'agent' && <span className="cc-m-chip" data-tone="ai">AI</span>}
                    </div>
                    <div className="cc-m-row-preview">{member.status === 'removed' ? '已移出群聊' : member.roleLabel}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="cc-m-caption mt-4 px-2">群成员由医院统一管理。随访助手只在群里协助发送问卷和提醒，不做诊断。</p>
        </div>
      </div>
    </div>
  )
}

export function ProfilePage({
  state,
  actions,
  showDemoControls,
  onOpenList,
}: {
  state: ConnectedClinicState
  actions: ClinicActions
  showDemoControls: boolean
  onOpenList: (kind: ResourceKind) => void
}) {
  const patient = PATIENTS[state.currentPatient]
  return (
    <div className="cc-m-scroll">
      <div className="cc-m-largetitle">
        <h1>我的</h1>
      </div>
      <div className="cc-m-pad flex flex-col gap-3">
        <section className="cc-m-card flex items-center gap-3.5 p-4">
          <Avatar tone="patient" label={patient.avatar} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[18px] font-bold">{patient.name}</div>
            <div className="cc-m-muted text-[13.5px]">
              {patient.sex} · {patient.age} 岁 · 就诊卡 {patient.patientId.replace(/_.*$/, '').toUpperCase()}••••
            </div>
          </div>
          <span className="cc-m-chip" data-tone="human">
            <CheckIcon size={11} strokeWidth={3} />
            已绑定微信
          </span>
        </section>

        <section className="cc-m-card p-4">
          <div className="cc-m-form-label !mb-2">健康档案</div>
          <div className="flex flex-wrap gap-1.5">
            {patient.allergies.map((allergy) => (
              <span key={allergy} className="cc-m-chip" data-tone="danger">
                过敏：{allergy}
              </span>
            ))}
            {patient.chronicConditions.map((condition) => (
              <span key={condition} className="cc-m-chip">
                {condition}
              </span>
            ))}
          </div>
        </section>

        <div className="cc-m-list cc-m-settings !mx-0">
          {(['record', 'report', 'prescription'] as const).map((kind) => (
            <Button key={kind} className="cc-m-row" onClick={() => onOpenList(kind)}>
              <span className="cc-m-tile !size-8 !rounded-[10px]" data-tone={KIND_META[kind].tone}>
                {KIND_META[kind].icon}
              </span>
              <span className="flex-1 text-[15px]">我的{KIND_META[kind].label}</span>
              <ChevronRightIcon size={18} className="text-[var(--m-text-3)]" />
            </Button>
          ))}
        </div>

        <div className="cc-m-list cc-m-settings !mx-0">
          <div className="cc-m-row cursor-default">
            <span className="cc-m-tile !size-8 !rounded-[10px]" data-tone="human">
              <ShieldCheckIcon size={17} />
            </span>
            <span className="flex-1 text-[15px]">隐私与授权</span>
            <span className="cc-m-caption">仅本人可见</span>
          </div>
          <div className="cc-m-row cursor-default">
            <span className="cc-m-tile !size-8 !rounded-[10px]">
              <BellIcon size={17} />
            </span>
            <span className="flex-1 text-[15px]">消息通知</span>
            <span className="cc-m-caption">已开启</span>
          </div>
        </div>

        {showDemoControls && (
          <section className="cc-m-card p-4">
            <div className="cc-m-form-label">演示控制</div>
            <SegmentedControl aria-label="切换演示患者" className="cc-m-segmented" value={state.currentPatient} onValueChange={(value) => value && actions.setPatient(value as PatientKey)}>
              <SegmentedControlIndicator />
              {(Object.keys(PATIENTS) as PatientKey[]).map((key) => (
                <SegmentedControlItem key={key} value={key}>
                  {PATIENTS[key].name}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <div className="mt-3 flex gap-2">
              <Button className="cc-m-btn" data-variant="soft" data-size="sm" style={{ flex: 1 }} onClick={() => actions.testCrossPatientIsolation()}>
                <ShieldAlertIcon size={14} />
                越权访问测试
              </Button>
              <Button className="cc-m-btn" data-variant="soft" data-size="sm" style={{ flex: 1 }} onClick={() => actions.resetDemo()}>
                <RefreshCwIcon size={14} />
                重置演示
              </Button>
            </div>
            <p className="cc-m-caption m-0 mt-3">医生工作台需要在更宽的屏幕上打开（≥ 768px）。</p>
          </section>
        )}
        <p className="cc-m-caption mt-2 text-center">ClinMesh 互联门诊 · 演示版 · 全部为合成数据</p>
      </div>
    </div>
  )
}
