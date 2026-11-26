import { Button } from '@ui-sdk/react/button'
import { Radio, RadioGroup } from '@ui-sdk/react/radio'
import { Textarea } from '@ui-sdk/react/textarea'
import {
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuEmpty,
  TriggerMenuItem,
  TriggerMenuList,
  TriggerMenuInput,
  type TriggerMenuContentState,
  type TriggerMenuDataItem,
} from '@ui-sdk/react/trigger-menu'
import {
  ArrowUpIcon,
  AtSignIcon,
  CalendarCheck2Icon,
  CalendarPlusIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClipboardListIcon,
  CopyIcon,
  FileTextIcon,
  FlaskConicalIcon,
  ImageIcon,
  KeyboardIcon,
  LockIcon,
  MicIcon,
  PauseIcon,
  PillIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareIcon,
  StethoscopeIcon,
  UsersIcon,
  WandSparklesIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { ClinicFeedback } from './clinic-feedback'
import { AgentSteps, ChatSkeleton, RevealAfter, Spinner, StreamingText, streamTextDuration, useDelayedFlag } from './clinic-motion'
import {
  PATIENTS,
  STAFF_ACTORS,
  type ChatMessage,
  type ClinicActions,
  type ClinicConversation,
  type ConnectedClinicState,
  type MessagePart,
  type StaffRole,
} from './connected-clinic-store'
import { ASSISTANT_PROMPTS, PRIMARY_DOCTOR } from './patient-agent-script'

export type CardPart = Extract<MessagePart, { type: 'card' }>
export type ChatVariant = 'assistant' | 'doctor' | 'group'

export type ChatIntent =
  | { kind: 'book'; slotId?: string; fromAgent: boolean }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'followup'; planId: string }
  | { kind: 'doctor'; draft?: string }
  | { kind: 'assistant'; prompt?: string; origin?: HTMLElement }
  | { kind: 'members' }

const VOICE_SCRIPTS: Record<ChatVariant, string[]> = {
  doctor: [
    '王医生，我今天体温 37.2 度，咳嗽比昨天轻一些，就是晚上还会咳醒，需要加药吗？',
    '医生您好，药已经吃了两天了，想问下周还要不要再来复查。',
  ],
  group: ['周护士好，今天按时吃药了，体温 37.1 度，痰也少了。', '刚量了体温 36.9 度，精神好多了。'],
  assistant: ['帮我看看血常规结果', '药怎么吃'],
}

export function variantOf(conversation: ClinicConversation): ChatVariant {
  if (conversation.type === 'patient_assistant') return 'assistant'
  if (conversation.type === 'followup_group') return 'group'
  return 'doctor'
}

function staffOf(conversation: ClinicConversation) {
  const member = conversation.members.find((m) => m.id in STAFF_ACTORS)
  return member ? STAFF_ACTORS[member.id as StaffRole] : null
}

export function conversationTitle(conversation: ClinicConversation) {
  const variant = variantOf(conversation)
  if (variant === 'assistant') return 'AI 就医助手'
  if (variant === 'doctor') return `${staffOf(conversation)?.name ?? ''} 医生`
  return conversation.title.split('·')[1]?.trim() ?? conversation.title
}

function senderTone(message: ChatMessage): 'agent' | 'nurse' | 'doctor' | 'system' {
  if (message.senderKind === 'agent') return 'agent'
  if (message.senderKind === 'system') return 'system'
  return message.senderId === 'nurse_n' ? 'nurse' : 'doctor'
}

export function Avatar({
  tone,
  label,
  size,
  live,
  presence,
}: {
  tone: 'agent' | 'nurse' | 'doctor' | 'patient' | 'system'
  label: string
  size?: 'xs' | 'sm' | 'lg'
  live?: boolean
  presence?: boolean
}) {
  return (
    <span className="cc-m-avatar" data-tone={tone === 'doctor' ? undefined : tone} data-size={size} data-live={live || undefined} aria-hidden="true">
      {tone === 'agent' ? <SparklesIcon size={size === 'xs' ? 12 : size === 'sm' ? 15 : 18} /> : label}
      {presence && <span className="cc-m-presence" />}
    </span>
  )
}

export function ConversationAvatar({ conversation, live, size }: { conversation: ClinicConversation; live?: boolean; size?: 'sm' }) {
  const variant = variantOf(conversation)
  if (variant === 'assistant') return <Avatar tone="agent" label="AI" live={live} size={size} />
  if (variant === 'doctor') {
    const staff = staffOf(conversation)
    return <Avatar tone="doctor" label={staff?.avatar ?? '医'} presence size={size} />
  }
  const second = conversation.members.filter((m) => m.status === 'active' && !(m.id in PATIENTS))[1]
  return (
    <span className="cc-m-stack" aria-hidden="true" style={size ? { width: 34, height: 34 } : undefined}>
      <Avatar tone="doctor" label={staffOf(conversation)?.avatar ?? '医'} size={size ? 'xs' : 'sm'} />
      {second && <Avatar tone={second.id === 'nurse_n' ? 'nurse' : second.kind === 'agent' ? 'agent' : 'doctor'} label={second.avatar} size="xs" />}
    </span>
  )
}

function barsFor(seed: string, count: number) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return Array.from({ length: count }, (_, i) => {
    hash = (hash * 1103515245 + 12345) >>> 0
    const wave = Math.sin((i / count) * Math.PI) * 0.6 + 0.4
    return Math.round(5 + ((hash % 100) / 100) * 15 * wave)
  })
}

function VoiceBubble({ part, self }: { part: Extract<MessagePart, { type: 'audio' }>; self: boolean }) {
  const [playing, setPlaying] = useState(false)
  const [showText, setShowText] = useState(true)
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bars = barsFor(part.attachmentId, Math.min(22, 9 + part.durationSec))
  const toggle = () => {
    clearTimeout(stopTimer.current)
    if (playing) {
      setPlaying(false)
      return
    }
    setPlaying(true)
    stopTimer.current = setTimeout(() => setPlaying(false), part.durationSec * 1000)
  }
  return (
    <div className="cc-m-bubble" data-tail="" style={{ minWidth: Math.min(260, 150 + part.durationSec * 6) }}>
      <div className="cc-m-voice">
        <Button className="cc-m-voice-play" aria-label={playing ? '暂停语音' : `播放 ${part.durationSec} 秒语音`} onClick={toggle}>
          {playing ? <PauseIcon size={14} fill="currentColor" /> : <PlayIcon size={14} fill="currentColor" className="ml-0.5" />}
        </Button>
        <span key={String(playing)} className="cc-m-bars" data-playing={playing || undefined} style={{ ['--dur' as string]: `${part.durationSec}s` }} aria-hidden="true">
          {bars.map((height, index) => (
            <span key={index} style={{ height, ['--k' as string]: index / bars.length }} />
          ))}
        </span>
        <span className="text-[13px] tabular-nums opacity-80">{part.durationSec}″</span>
      </div>
      {part.asrStatus === 'pending' ? (
        <div className="cc-m-asr-pending">
          <Spinner size={12} />
          转文字中…
        </div>
      ) : part.transcript && showText ? (
        <div className="cc-m-transcript cc-m-fade">{part.transcript}</div>
      ) : null}
      {part.asrStatus === 'ready' && part.transcript && (
        <Button
          onClick={() => setShowText(!showText)}
          className={`mt-1 border-0 bg-transparent p-0 text-[12px] underline-offset-2 hover:underline ${self ? 'text-white/75' : 'text-[var(--m-text-3)]'}`}
        >
          {showText ? '收起文字' : '转文字'}
        </Button>
      )}
    </div>
  )
}

function cardIcon(component: CardPart['component']) {
  switch (component) {
    case 'AppointmentCard':
      return { icon: <CalendarPlusIcon size={19} />, tone: 'human' as const }
    case 'ReportCard':
      return { icon: <FlaskConicalIcon size={19} />, tone: 'warn' as const }
    case 'PrescriptionCard':
      return { icon: <PillIcon size={19} />, tone: 'violet' as const }
    case 'FollowupFormCard':
      return { icon: <ClipboardListIcon size={19} />, tone: undefined }
    case 'HandoffCard':
      return { icon: <StethoscopeIcon size={19} />, tone: 'human' as const }
    case 'TaskCard':
      return { icon: <CheckIcon size={19} strokeWidth={2.6} />, tone: 'human' as const }
    default:
      return { icon: <FileTextIcon size={19} />, tone: undefined }
  }
}

function SlotPicker({ part, state, onBook }: { part: CardPart; state: ConnectedClinicState; onBook: (slotId: string) => void }) {
  const slots = state.slots.filter((s) => part.slotIds?.includes(s.id))
  const [selected, setSelected] = useState(part.resourceId)
  return (
    <>
      <div className="cc-m-chatcard-body">
        <RadioGroup aria-label="选择就诊时段" value={selected} onValueChange={(value) => value && setSelected(String(value))} className="cc-m-slotgroup">
          {slots.map((slot) => {
            const left = slot.capacity - slot.booked
            return (
              <label key={slot.id} className="cc-m-slot">
                <Radio value={slot.id} disabled={left <= 0} />
                <span className="cc-m-slot-time">{slot.timeRange.split(' ')[0]}</span>
                <span className="cc-m-slot-left">{left > 0 ? `余 ${left}` : '已满'}</span>
              </label>
            )
          })}
        </RadioGroup>
      </div>
      <div className="cc-m-chatcard-foot">
        <Button className="cc-m-btn" data-variant="brand" data-size="sm" style={{ flex: 1 }} onClick={() => onBook(selected)}>
          {part.actionLabel}
        </Button>
      </div>
    </>
  )
}

function ChatCard({
  part,
  message,
  state,
  actions,
  onIntent,
}: {
  part: CardPart
  message: ChatMessage
  state: ConnectedClinicState
  actions: ClinicActions
  onIntent: (intent: ChatIntent) => void
}) {
  const { icon, tone } = cardIcon(part.component)
  const plan = part.component === 'FollowupFormCard' ? state.followupPlans.find((p) => p.id === part.resourceId) : undefined
  const planDone = plan && (plan.taskStatus !== 'pending' || plan.status !== 'active')
  const statusTag = plan ? (plan.status !== 'active' ? '已结束' : planDone ? '已提交' : '待填写') : part.statusTag

  return (
    <div className="cc-m-chatcard">
      <div className="cc-m-chatcard-head">
        <span className="cc-m-tile" data-tone={tone}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="cc-m-chatcard-title">{part.title}</div>
            {statusTag && (
              <span className="cc-m-chip" data-tone={statusTag === '待填写' ? 'warn' : statusTag.startsWith('已') ? 'human' : undefined}>
                {statusTag}
              </span>
            )}
          </div>
          <div className="cc-m-chatcard-sub">{part.subtitle}</div>
        </div>
      </div>

      {part.component === 'AppointmentCard' && part.slotIds?.length ? (
        <SlotPicker part={part} state={state} onBook={(slotId) => onIntent({ kind: 'book', slotId, fromAgent: message.senderKind === 'agent' })} />
      ) : part.component === 'HandoffCard' && part.handoff ? (
        <>
          <div className="cc-m-chatcard-body">
            <blockquote className="cc-m-quote">{part.handoff.draft}</blockquote>
            <div className="cc-m-caption mt-2">{part.meta.join(' · ')}</div>
          </div>
          <div className="cc-m-chatcard-foot">
            {part.handoff.sentAt ? (
              <>
                <span className="cc-m-chip" data-tone="human">
                  <CheckIcon size={12} strokeWidth={3} /> 已发送 · {part.handoff.sentAt}
                </span>
                <Button className="cc-m-link ml-auto" onClick={() => onIntent({ kind: 'doctor' })}>
                  查看对话
                </Button>
              </>
            ) : (
              <>
                <Button className="cc-m-btn" data-variant="soft" data-size="sm" onClick={() => onIntent({ kind: 'doctor', draft: part.handoff?.draft })}>
                  改一改
                </Button>
                <Button
                  className="cc-m-btn"
                  data-variant="brand"
                  data-size="sm"
                  style={{ flex: 1 }}
                  onClick={() => {
                    actions.sendHandoff(message.id)
                    onIntent({ kind: 'doctor' })
                  }}
                >
                  {part.actionLabel}
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {part.meta.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5">
              {part.meta.map((item) => (
                <span key={item} className="cc-m-chip">
                  {item}
                </span>
              ))}
            </div>
          )}
          {part.actionName !== 'none' && (
            <div className="cc-m-chatcard-foot pt-3">
              <Button
                className="cc-m-btn"
                data-variant={planDone ? 'soft' : 'ai'}
                data-size="sm"
                style={{ flex: 1 }}
                disabled={plan?.status === 'completed'}
                onClick={() => {
                  if (part.actionName === 'followup.submit') onIntent({ kind: 'followup', planId: part.resourceId })
                  else if (part.actionName === 'appointment.open') onIntent({ kind: 'book', slotId: part.resourceId, fromAgent: true })
                  else onIntent({ kind: 'resource', resourceId: part.resourceId })
                }}
              >
                {planDone ? '查看我的反馈' : part.actionLabel}
              </Button>
            </div>
          )}
          {part.actionName === 'none' && <div className="h-3.5" />}
        </>
      )}
    </div>
  )
}

function AgentMessage({
  message,
  state,
  actions,
  onIntent,
  isLast,
  onRetry,
}: {
  message: ChatMessage
  state: ConnectedClinicState
  actions: ClinicActions
  onIntent: (intent: ChatIntent) => void
  isLast: boolean
  onRetry?: () => void
}) {
  const stream = message.stream
  const live = stream?.status === 'streaming'
  const text = message.parts.find((p) => p.type === 'text')
  const cards = message.parts.filter((p): p is CardPart => p.type === 'card')
  const textEnd = stream && text?.type === 'text' ? streamTextDuration(stream, text.text) : 0
  const urgent = text?.type === 'text' && /拨打 120/.test(text.text)
  const [copied, setCopied] = useState(false)

  return (
    <div className="cc-m-msg-col" aria-busy={live || undefined}>
      {stream && stream.steps.length > 0 && <AgentSteps stream={stream} />}
      {text?.type === 'text' && text.text && (
        <RevealAfter stream={stream} afterMs={stream ? stream.textStartsAfterMs - 120 : 0}>
          <div className="cc-m-bubble" data-agent="" data-tail="" data-urgent={urgent || undefined}>
            {urgent && <ShieldAlertIcon size={15} className="mr-1 inline -translate-y-px text-[var(--m-danger)]" />}
            <StreamingText text={text.text} stream={stream} />
          </div>
        </RevealAfter>
      )}
      {stream?.status === 'stopped' && <span className="cc-m-caption px-1">已停止生成</span>}
      {cards.map((part) => (
        <RevealAfter key={part.resourceId + part.component} stream={stream} afterMs={textEnd + 80}>
          <ChatCard part={part} message={message} state={state} actions={actions} onIntent={onIntent} />
        </RevealAfter>
      ))}
      {!live && message.senderId === 'agent_patient_svc' && text?.type === 'text' && text.text && (
        <div className="cc-m-agent-tools">
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(text.text).catch(() => undefined)
              setCopied(true)
            }}
          >
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            {copied ? '已复制' : '复制'}
          </Button>
          {isLast && onRetry && (
            <Button onClick={onRetry}>
              <RotateCcwIcon size={13} />
              重新回答
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function DeliveryState({ delivery }: { delivery: ChatMessage['delivery'] }) {
  if (!delivery) return null
  return (
    <span className="cc-m-delivery" data-state={delivery} aria-live="polite">
      {delivery === 'sending' ? (
        <>
          <Spinner size={11} /> 发送中
        </>
      ) : delivery === 'sent' ? (
        <>
          <CheckIcon size={12} strokeWidth={2.6} /> 已送达
        </>
      ) : (
        <>
          <CheckCheckIcon size={13} strokeWidth={2.4} /> 已读
        </>
      )}
    </span>
  )
}

function Thread({
  conversation,
  state,
  actions,
  onIntent,
  intro,
  typingLabel,
  onRetry,
}: {
  conversation: ClinicConversation
  state: ConnectedClinicState
  actions: ClinicActions
  onIntent: (intent: ChatIntent) => void
  intro: ReactNode
  typingLabel: string | null
  onRetry: (messageId: string) => void
}) {
  const selfId = state.currentPatient
  const [mountedSeq] = useState(() => conversation.messages.at(-1)?.sequence ?? 0)
  const messages = conversation.messages
  const lastSelfIndex = messages.findLastIndex((m) => m.senderId === selfId)
  const lastAgentIndex = messages.findLastIndex((m) => m.senderKind === 'agent')

  return (
    <div className="cc-m-thread">
      <div className="cc-m-thread-inner" role="log" aria-label={`${conversationTitle(conversation)} 消息记录`}>
        {intro}
        <div className="cc-m-day">今天</div>
        {messages.map((message, index) => {
          const fresh = message.sequence > mountedSeq ? 'cc-m-msg-enter' : ''
          if (message.senderKind === 'system') {
            const text = message.parts[0]
            return (
              <div key={message.id} className={`cc-m-sys ${fresh}`}>
                {text?.type === 'text' ? text.text : ''}
              </div>
            )
          }
          const self = message.senderId === selfId
          const previous = messages[index - 1]
          const next = messages[index + 1]
          const first = !previous || previous.senderId !== message.senderId || previous.senderKind === 'system'
          const lastInRun = !next || next.senderId !== message.senderId
          const tone = senderTone(message)
          const wide = message.parts.some((p) => p.type === 'card') || message.senderKind === 'agent'

          return (
            <div
              key={message.id}
              className={`cc-m-msg ${fresh}`}
              data-self={self || undefined}
              data-first={first || undefined}
              data-wide={wide || undefined}
              data-pending={message.delivery === 'sending' || undefined}
            >
              {!self && (
                <div className="cc-m-msg-gutter">
                  {first && (
                    <Avatar
                      tone={tone === 'system' ? 'system' : tone}
                      label={message.senderName.slice(0, 1)}
                      size="sm"
                      live={message.stream?.status === 'streaming'}
                    />
                  )}
                </div>
              )}
              {message.senderKind === 'agent' ? (
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {first && (
                    <div className="cc-m-sender">
                      <strong>{message.senderName}</strong>
                      <span className="cc-m-role" data-tone="agent">
                        AI
                      </span>
                      <span>{message.createdAt}</span>
                    </div>
                  )}
                  <AgentMessage
                    message={message}
                    state={state}
                    actions={actions}
                    onIntent={onIntent}
                    isLast={index === lastAgentIndex}
                    onRetry={conversation.type === 'patient_assistant' ? () => onRetry(message.id) : undefined}
                  />
                </div>
              ) : (
                <div className="cc-m-msg-col">
                  {!self && first && (
                    <div className="cc-m-sender">
                      <strong>{message.senderName.replace(/\s*(医生|护士)$/, '')}</strong>
                      <span className="cc-m-role" data-tone={tone === 'nurse' ? 'nurse' : undefined}>
                        {tone === 'nurse' ? '护士' : '医生'}
                      </span>
                      <span>{message.createdAt}</span>
                    </div>
                  )}
                  {message.parts.map((part, partIndex) =>
                    part.type === 'text' ? (
                      <div key={partIndex} className="cc-m-bubble" data-tail={lastInRun || undefined}>
                        {part.text}
                      </div>
                    ) : part.type === 'audio' ? (
                      <VoiceBubble key={part.attachmentId} part={part} self={self} />
                    ) : (
                      <ChatCard key={part.resourceId} part={part} message={message} state={state} actions={actions} onIntent={onIntent} />
                    ),
                  )}
                  {self && index === lastSelfIndex && conversation.type !== 'patient_assistant' && <DeliveryState delivery={message.delivery} />}
                </div>
              )}
            </div>
          )
        })}
        {typingLabel && (
          <div className="cc-m-msg cc-m-msg-enter" data-first="">
            <div className="cc-m-msg-gutter" />
            <div className="cc-m-msg-col">
              <div className="cc-m-sender">{typingLabel}</div>
              <div className="cc-m-bubble" data-tail="" aria-label={typingLabel}>
                <span className="cc-m-typing">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type MentionItem = TriggerMenuDataItem<string> & { value: string; label: string; description?: string }

function Composer({
  variant,
  conversation,
  draft,
  onDraftChange,
  onSend,
  onVoice,
  streamingMessageId,
  onStop,
  suggestions,
  onSuggestion,
  onIntent,
  recording,
  setRecording,
  inTab,
  onTyping,
}: {
  variant: ChatVariant
  conversation: ClinicConversation
  draft: string
  onDraftChange: (text: string) => void
  onSend: (text: string) => void
  onVoice: (seconds: number) => void
  streamingMessageId: string | null
  onStop: () => void
  suggestions: string[]
  onSuggestion: (prompt: string) => void
  onIntent: (intent: ChatIntent) => void
  recording: RecordingState | null
  setRecording: (next: RecordingState | null) => void
  inTab: boolean
  onTyping: (typing: boolean) => void
}) {
  const [voiceMode, setVoiceMode] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    onDraftChange('')
    onTyping(false)
    setTrayOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey && !menuOpen) {
      event.preventDefault()
      submit()
    }
  }

  const change = (text: string) => {
    onDraftChange(text)
    onTyping(text.trim().length > 0)
  }

  const finishRecording = (cancel: boolean) => {
    if (!recording) return
    const ms = Date.now() - recording.startedAt
    setRecording(null)
    if (cancel || recording.cancel) return
    if (ms < 700) {
      onVoice(0)
      return
    }
    onVoice(Math.max(1, Math.round(ms / 1000)))
  }

  const holdHandlers = {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      setRecording({ startedAt: Date.now(), startY: event.clientY, cancel: false })
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      if (!recording) return
      const cancel = recording.startY - event.clientY > 70
      if (cancel !== recording.cancel) setRecording({ ...recording, cancel })
    },
    onPointerUp: () => finishRecording(false),
    onPointerCancel: () => finishRecording(true),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
        event.preventDefault()
        if (recording) finishRecording(false)
        else setRecording({ startedAt: Date.now(), startY: 0, cancel: false })
      }
      if (event.key === 'Escape' && recording) finishRecording(true)
    },
  }

  const mentionItems: MentionItem[] = conversation.members
    .filter((m) => m.status === 'active' && !(m.id in PATIENTS))
    .map((m) => ({ value: m.id, label: m.name, description: m.kind === 'agent' ? '调出问卷、打卡提醒' : m.roleLabel }))

  const commandItems: MentionItem[] = [
    { value: '帮我预约明天的门诊', label: '预约', description: '查询号源并预填预约' },
    { value: '打开最近一次病历', label: '病历', description: '医生已发布的病历' },
    { value: '查看已发布的报告', label: '报告', description: '检验检查结果' },
    { value: '药怎么吃', label: '处方', description: '按处方说明用法' },
    { value: '想问问医生', label: '找医生', description: '整理问题转给医生' },
  ]

  const field =
    variant === 'doctor' ? (
      <Textarea
        ref={inputRef}
        aria-label="发消息给医生"
        rows={1}
        value={draft}
        placeholder="发消息给医生…"
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setTrayOpen(false)}
      />
    ) : (
      <TriggerMenu
        triggers={
          variant === 'group'
            ? [{ char: '@', items: mentionItems, insert: (item: { label: string }) => `@${item.label} ` }]
            : [{ char: '/', items: commandItems }]
        }
        onOpenChange={setMenuOpen}
        onSelect={(value, details) => {
          if (details.trigger === '/') {
            details.preventDefault()
            onDraftChange('')
            onSend(String(value))
          }
        }}
      >
        <TriggerMenuInput
          aria-label={variant === 'group' ? '在随访群发消息' : '问 AI 就医助手'}
          rows={1}
          value={draft}
          placeholder={variant === 'group' ? '发消息，@随访助手 调出问卷…' : '问号源、报告、用药…'}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setTrayOpen(false)}
        />
        <TriggerMenuContent className="cc-m-menu" side="top" sideOffset={10}>
          <TriggerMenuEmpty>没有匹配项</TriggerMenuEmpty>
          <TriggerMenuList>
            {(menu: TriggerMenuContentState) =>
              menu.items.map((entry) => {
                const item = entry as MentionItem
                return (
                  <TriggerMenuItem key={item.value} value={item.value} label={item.label} className="cc-m-menu-item">
                    {variant === 'group' ? (
                      item.value.startsWith('agent') ? (
                        <Avatar tone="agent" label="AI" size="xs" />
                      ) : (
                        <Avatar tone={item.value === 'nurse_n' ? 'nurse' : 'doctor'} label={item.label.slice(0, 1)} size="xs" />
                      )
                    ) : (
                      <span className="cc-m-menu-slash">/</span>
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[14px] font-medium">{item.label}</span>
                      {item.description && <span className="text-[12px] text-[var(--m-text-3)]">{item.description}</span>}
                    </span>
                  </TriggerMenuItem>
                )
              })
            }
          </TriggerMenuList>
        </TriggerMenuContent>
      </TriggerMenu>
    )

  const trayItems: { label: string; icon: ReactNode; run?: () => void }[] =
    variant === 'assistant'
      ? [
          { label: '拍化验单', icon: <ImageIcon size={22} /> },
          { label: '预约挂号', icon: <CalendarPlusIcon size={22} />, run: () => onIntent({ kind: 'book', fromAgent: false }) },
          { label: '我的报告', icon: <FlaskConicalIcon size={22} />, run: () => onSuggestion('查看已发布的报告') },
          { label: '找医生', icon: <StethoscopeIcon size={22} />, run: () => onIntent({ kind: 'doctor' }) },
        ]
      : variant === 'group'
        ? [
            { label: '照片', icon: <ImageIcon size={22} /> },
            { label: '随访问卷', icon: <ClipboardListIcon size={22} />, run: () => conversation.followupPlanId && onIntent({ kind: 'followup', planId: conversation.followupPlanId }) },
            {
              label: '@随访助手',
              icon: <AtSignIcon size={22} />,
              run: () => {
                onDraftChange(`${draft}@随访助手 `)
                setTrayOpen(false)
                inputRef.current?.focus()
              },
            },
            { label: '预约复诊', icon: <CalendarCheck2Icon size={22} />, run: () => onIntent({ kind: 'book', fromAgent: false }) },
          ]
        : [
            { label: '照片', icon: <ImageIcon size={22} /> },
            { label: 'AI 帮我整理', icon: <WandSparklesIcon size={22} />, run: () => onIntent({ kind: 'assistant', prompt: '想问问医生' }) },
            { label: '我的报告', icon: <FlaskConicalIcon size={22} />, run: () => onIntent({ kind: 'assistant', prompt: '查看已发布的报告' }) },
            { label: '预约复诊', icon: <CalendarCheck2Icon size={22} />, run: () => onIntent({ kind: 'book', fromAgent: false }) },
          ]

  return (
    <div className="cc-m-composer" data-in-tab={inTab || undefined}>
      {suggestions.length > 0 && !draft && !streamingMessageId && (
        <div className="cc-m-suggest" aria-label="常用问题">
          {suggestions.map((prompt) => (
            <Button key={prompt} onClick={() => onSuggestion(prompt)}>
              {prompt}
            </Button>
          ))}
        </div>
      )}
      <div className="cc-m-composer-row">
        <Button
          className="cc-m-iconbtn"
          aria-label={voiceMode ? '切换到键盘输入' : '切换到语音输入'}
          onClick={() => {
            setVoiceMode(!voiceMode)
            setTrayOpen(false)
          }}
        >
          {voiceMode ? <KeyboardIcon size={22} /> : <MicIcon size={22} />}
        </Button>
        {voiceMode ? (
          <Button className="cc-m-holdtalk" data-active={recording ? '' : undefined} aria-label="按住说话，松开发送" {...holdHandlers}>
            {recording ? (recording.cancel ? '松开 取消' : '松开 发送') : '按住 说话'}
          </Button>
        ) : (
          <div className="cc-m-field">{field}</div>
        )}
        {streamingMessageId ? (
          <Button className="cc-m-send" data-stop="" aria-label="停止生成" onClick={onStop}>
            <SquareIcon size={13} fill="currentColor" />
          </Button>
        ) : draft.trim() && !voiceMode ? (
          <Button className="cc-m-send" aria-label="发送" onClick={submit}>
            <ArrowUpIcon size={20} strokeWidth={2.4} />
          </Button>
        ) : (
          <Button
            className="cc-m-iconbtn"
            aria-label={trayOpen ? '收起更多功能' : '更多功能'}
            aria-expanded={trayOpen}
            onClick={() => setTrayOpen(!trayOpen)}
          >
            <PlusIcon size={24} style={{ transform: trayOpen ? 'rotate(45deg)' : undefined, transition: 'transform 200ms ease' }} />
          </Button>
        )}
      </div>
      {trayOpen && (
        <div className="cc-m-tray">
          {trayItems.map((item) => (
            <Button key={item.label} className="cc-m-tray-item" disabled={!item.run} onClick={item.run} title={item.run ? undefined : '演示版暂不支持'}>
              <span className="cc-m-tile">{item.icon}</span>
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

interface RecordingState {
  startedAt: number
  startY: number
  cancel: boolean
}

function RecordingOverlay({ recording }: { recording: RecordingState }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - recording.startedAt) / 1000))
  return (
    <div className="cc-m-rec" data-cancel={recording.cancel || undefined} role="status" aria-live="polite">
      <div className="cc-m-rec-bubble">
        <span className="cc-m-rec-bars" aria-hidden="true">
          {Array.from({ length: 14 }, (_, k) => (
            <span key={k} style={{ ['--k' as string]: k }} />
          ))}
        </span>
        <span className="text-[15px] font-semibold tabular-nums">
          0:{String(seconds).padStart(2, '0')}
        </span>
      </div>
      <span className="cc-m-rec-hint">{recording.cancel ? '松开手指，取消发送' : '松开发送 · 上滑取消'}</span>
    </div>
  )
}

export function ChatView({
  conversation,
  state,
  actions,
  feedback,
  onBack,
  onIntent,
  draft,
  onDraftChange,
  loading,
  inTab = false,
}: {
  conversation: ClinicConversation
  state: ConnectedClinicState
  actions: ClinicActions
  feedback: ClinicFeedback
  onBack?: () => void
  onIntent: (intent: ChatIntent) => void
  draft: string
  onDraftChange: (text: string) => void
  loading: boolean
  inTab?: boolean
}) {
  const variant = variantOf(conversation)
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const showSkeleton = useDelayedFlag(loading)
  const staff = staffOf(conversation)
  const streaming = conversation.messages.findLast((m) => m.stream?.status === 'streaming')
  const staffTyping = state.typing.staff === conversation.id
  const typingLabel = staffTyping ? `${STAFF_ACTORS[state.currentStaff].name} 正在输入…` : null
  const activeMembers = conversation.members.filter((m) => m.status === 'active')
  const readOnly = conversation.status === 'read_only'
  const doctorName = STAFF_ACTORS[PRIMARY_DOCTOR[state.currentPatient]].name

  const subtitle =
    variant === 'assistant'
      ? streaming
        ? '正在查询你的资料…'
        : '仅能查看你本人授权的资料'
      : variant === 'doctor'
        ? staffTyping
          ? '对方正在输入…'
          : `${staff?.department ?? ''} · 今日出诊`
        : staffTyping
          ? typingLabel
          : `${activeMembers.length} 位成员 · 含随访助手`

  const send = (text: string) => {
    if (variant === 'assistant') actions.askPatientAgent(text)
    else actions.sendMessage(conversation.id, 'patient', text)
  }

  const sendVoice = (seconds: number) => {
    if (seconds === 0) {
      feedback.toast.patient.error('说话时间太短')
      return
    }
    const scripts = VOICE_SCRIPTS[variant]
    const transcript = scripts[conversation.messages.length % scripts.length]
    if (variant === 'assistant') {
      const id = feedback.toast.patient.loading('正在识别语音…')
      setTimeout(() => {
        feedback.toast.patient.dismiss(id)
        actions.askPatientAgent(transcript)
      }, 700)
      return
    }
    actions.sendVoiceMessage(conversation.id, 'patient', transcript, seconds)
  }

  const retry = (messageId: string) => {
    const index = conversation.messages.findIndex((m) => m.id === messageId)
    const prompt = conversation.messages
      .slice(0, index)
      .findLast((m) => m.senderKind === 'human')
      ?.parts.find((p) => p.type === 'text')
    if (prompt?.type === 'text') actions.askPatientAgent(prompt.text)
  }

  const intro =
    variant === 'assistant' ? (
      <div className="cc-m-banner my-2" data-tone="ai">
        <SparklesIcon size={16} className="mt-0.5 shrink-0" />
        <span>
          我可以帮你预约挂号、查看医生已发布的病历和报告、解释处方用法，或把问题整理好转给医生。<strong>我不做诊断，也不开药。</strong>
        </span>
      </div>
    ) : variant === 'doctor' ? (
      <div className="cc-m-banner my-2" data-tone="human">
        <StethoscopeIcon size={16} className="mt-0.5 shrink-0" />
        <span>
          这里是你和{staff?.name}医生的私信，医生出诊时回复可能稍慢。不急的问题可以
          <Button className="cc-m-link px-1" onClick={() => onIntent({ kind: 'assistant' })}>
            先问 AI 助手
          </Button>
          ；紧急情况请拨打 120。
        </span>
      </div>
    ) : (
      <div className="cc-m-banner my-2">
        <UsersIcon size={16} className="mt-0.5 shrink-0" />
        <span>
          随访群成员：{activeMembers.map((m) => m.name).join('、')}。群里 <strong>@随访助手</strong> 可以调出问卷、提醒打卡。
        </span>
      </div>
    )

  return (
    <div className="cc-m-view">
      <header className="cc-m-header" data-bordered="">
        {onBack && (
          <Button className="cc-m-iconbtn" aria-label="返回" onClick={onBack}>
            <ChevronLeftIcon size={26} />
          </Button>
        )}
        <div className="cc-m-header-main" style={onBack ? undefined : { paddingLeft: 8 }}>
          <ConversationAvatar conversation={conversation} live={Boolean(streaming)} size="sm" />
          <div className="min-w-0">
            <div className="cc-m-header-title">{conversationTitle(conversation)}</div>
            <div className="cc-m-header-sub">
              {variant === 'doctor' && !staffTyping && <span className="size-1.5 rounded-full bg-[#22c55e]" />}
              {subtitle}
            </div>
          </div>
        </div>
        {variant === 'assistant' ? (
          <Button className="cc-m-btn" data-variant="soft" data-size="xs" onClick={() => onIntent({ kind: 'doctor' })}>
            <StethoscopeIcon size={14} />
            找{doctorName}医生
          </Button>
        ) : variant === 'doctor' ? (
          <Button className="cc-m-btn" data-variant="ai" data-size="xs" onClick={(event) => onIntent({ kind: 'assistant', origin: event.currentTarget })}>
            <SparklesIcon size={14} />问 AI
          </Button>
        ) : (
          <Button className="cc-m-iconbtn" aria-label="群成员" onClick={() => onIntent({ kind: 'members' })}>
            <UsersIcon size={21} />
          </Button>
        )}
      </header>

      {loading || showSkeleton ? (
        <div className="cc-m-scroll" aria-busy="true" aria-label="正在加载历史消息">
          {showSkeleton && <ChatSkeleton />}
        </div>
      ) : (
        <Thread
          conversation={conversation}
          state={state}
          actions={actions}
          onIntent={onIntent}
          intro={intro}
          typingLabel={variant === 'group' ? null : typingLabel}
          onRetry={retry}
        />
      )}

      {readOnly ? (
        <div className="cc-m-archived">
          <LockIcon size={14} />
          随访计划已结束，群聊已归档为只读
        </div>
      ) : (
        <Composer
          variant={variant}
          conversation={conversation}
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={send}
          onVoice={sendVoice}
          streamingMessageId={streaming?.id ?? null}
          onStop={() => streaming && actions.stopAgentRun(streaming.id)}
          suggestions={variant === 'assistant' ? ASSISTANT_PROMPTS[state.currentPatient] : []}
          onSuggestion={send}
          onIntent={onIntent}
          recording={recording}
          setRecording={setRecording}
          inTab={inTab}
          onTyping={(typing) => actions.setTyping('patient', typing ? conversation.id : null)}
        />
      )}
      {recording && <RecordingOverlay recording={recording} />}
    </div>
  )
}
