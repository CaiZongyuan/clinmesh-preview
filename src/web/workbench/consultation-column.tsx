import { Button } from '@ui-sdk/react/button'
import { Input } from '@ui-sdk/react/input'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaScrollToEnd,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@ui-sdk/react/scroll-area'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { MessagesSquareIcon, ArrowDownIcon, CheckIcon, CopyIcon, KeyboardIcon, MicIcon, MicOffIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, RefreshCwIcon, RotateCcwIcon, Volume2Icon, VolumeXIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { MAX_QUESTION_LENGTH, type ConsultationTurn, type PatientTurnFailure, type Recognizer } from '../../shared/consultation'
import type { EncounterView } from '../../shared/encounter'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import type { Consultation } from '../consultation/use-consultation'
import { QuoteMenu, quotedTurn } from './clinical-note/quote-menu'
import { formatClockSeconds } from './format'
import { badge, iconButton, pane, paneHeader } from './pane-styles'
import { PhysicalExaminationPanel, PhysicalExaminationRow } from './physical-examination'
import { useVoiceCapture, type VoiceCaptureController } from '../voice/use-voice-capture'
import { usePatientSpeech } from '../voice/use-patient-speech'
import { ActionTooltip } from './ui-tooltip'
import { useVoiceKeys, VoiceBar } from './voice-bar'

export interface EncounterContext {
  encounter: EncounterView
  examinations: PhysicalExaminationView[]
}

type TranscriptFilter = 'all' | 'doctor' | 'patient' | 'examination'

// What the doctor and patient said, and the objective findings the doctor examined, in the order they happened.
type TranscriptEntry =
  | { channel: 'doctor' | 'patient'; at: string | null; order: number; turn: ConsultationTurn }
  | { channel: 'examination'; at: string; order: number; examination: PhysicalExaminationView }

// A turn happened when it was said: a question when asked, a reply when the patient gave it. A reply still
// pending sorts last, after anything examined while the patient was thinking.
const spokenAt = (turn: ConsultationTurn) =>
  turn.speaker === 'doctor' ? turn.createdAt : (turn.settledAt ?? (turn.status === 'pending' ? null : turn.createdAt))

function transcriptOf(turns: ConsultationTurn[], examinations: PhysicalExaminationView[]): TranscriptEntry[] {
  const time = (at: string | null) => (at === null ? Number.POSITIVE_INFINITY : Date.parse(at))
  return [
    ...turns.map((turn): TranscriptEntry => ({ channel: turn.speaker, at: spokenAt(turn), order: turn.seq, turn })),
    ...examinations.map((examination): TranscriptEntry => ({ channel: 'examination', at: examination.examinedAt, order: 0, examination })),
  ].sort((a, b) => time(a.at) - time(b.at) || a.order - b.order)
}

const FILTERS: readonly { value: TranscriptFilter; label: string; empty: string }[] = [
  { value: 'all', label: '全部', empty: '还没有问诊记录。' },
  { value: 'doctor', label: '医生', empty: '还没有医生提问。' },
  { value: 'patient', label: '患者', empty: '还没有患者回答。' },
  { value: 'examination', label: '查体', empty: '还没有查体记录。' },
]

const FAILURE_TEXT: Record<PatientTurnFailure, string> = {
  timeout: '模拟患者回答超时，本轮已标记失败，提问锁已释放。',
  'llm-not-configured': '未配置大模型接口（LLM_API_KEY），模拟患者无法回答。',
  'llm-error': '模型调用出错，本轮已标记失败。',
  'patient-unavailable': '模拟患者暂时不可用，本轮已标记失败。',
  'encounter-ended': '就诊已结束，本轮未作答。',
}

const RECOGNIZER_LABEL: Record<Recognizer, string> = {
  'paraformer-realtime-v2': 'Paraformer',
  'web-speech': '网页识别',
}

interface ConsultationPaneProps {
  encounter?: EncounterContext
  consultation: Consultation
  collapsed: boolean
  onToggle: () => void
}

export function ConsultationPane({ encounter, consultation, collapsed, onToggle }: ConsultationPaneProps) {
  const active = encounter?.encounter.status === 'active'
  const liveEncounterId = active ? encounter.encounter.encounterId : null
  const speech = usePatientSpeech(liveEncounterId, consultation)
  const voice = useVoiceCapture(liveEncounterId, consultation.accept, speech.interrupt)
  const holdButton = useRef<HTMLButtonElement>(null)
  const toggleButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useVoiceKeys(voice, active, holdButton)

  const toggle = () => {
    restoreFocus.current = true
    onToggle()
  }

  useEffect(() => {
    if (!restoreFocus.current) return
    restoreFocus.current = false
    toggleButton.current?.focus()
  }, [collapsed])

  if (collapsed) {
    return <ConsultationStrip consultation={consultation} voice={voice} toggleButton={toggleButton} onExpand={toggle} />
  }
  return (
    <ConsultationColumn
      encounter={encounter}
      consultation={consultation}
      voice={voice}
      speech={speech}
      holdButton={holdButton}
      toggleButton={toggleButton}
      onCollapse={toggle}
    />
  )
}

interface ColumnProps {
  encounter?: EncounterContext
  consultation: Consultation
  voice: VoiceCaptureController
  speech: ReturnType<typeof usePatientSpeech>
  holdButton: RefObject<HTMLButtonElement | null>
  toggleButton: RefObject<HTMLButtonElement | null>
  onCollapse: () => void
}

function ConsultationColumn({ encounter: context, consultation, voice, speech, holdButton, toggleButton, onCollapse }: ColumnProps) {
  const [filter, setFilter] = useState<TranscriptFilter>('all')
  const encounter = context?.encounter
  const liveEncounterId = encounter?.status === 'active' ? encounter.encounterId : null
  const attempts = new Map<string, ConsultationTurn[]>()
  for (const turn of consultation.turns) {
    if (!turn.replyTo) continue
    const list = attempts.get(turn.replyTo) ?? []
    list.push(turn)
    attempts.set(turn.replyTo, list)
  }
  const visible = transcriptOf(consultation.turns, context?.examinations ?? []).filter(
    (entry) => (filter === 'all' || entry.channel === filter) &&
      !(entry.channel === 'patient' && entry.turn.status === 'failed' && entry.turn.replyTo &&
        attempts.get(entry.turn.replyTo)?.at(-1)?.turnId !== entry.turn.turnId),
  )
  const latestSeq = consultation.turns.at(-1)?.seq
  return (
    <section aria-label="问诊记录" className={pane}>
      <div className={paneHeader}>
        <div><h2>问诊记录</h2><p>{encounter ? `模拟患者 · ${encounter.patient.name}` : '模拟患者'}</p></div>
        <ActionTooltip label="收起问诊记录" side="bottom">
          <Button ref={toggleButton} aria-label="收起问诊记录" className={iconButton} onClick={onCollapse}>
            <PanelLeftCloseIcon aria-hidden="true" size={16} />
          </Button>
        </ActionTooltip>
      </div>
      {!context || !encounter ? (
        <div className="min-h-0 flex-1">
          <p className="m-0 p-4 text-[13px] text-muted-foreground">接诊开始后，医患对话会实时转写在这里。</p>
        </div>
      ) : (
        <>
          <div className="flex flex-none items-center justify-between gap-2 border-b px-3.5 py-1.5">
            <SegmentedControl
              aria-label="筛选问诊记录"
              value={filter}
              onValueChange={(value) => value && setFilter(value as TranscriptFilter)}
              className="h-7 text-xs"
            >
              <SegmentedControlIndicator />
              {FILTERS.map((f) => (
                <SegmentedControlItem key={f.value} value={f.value} className="h-[22px] px-2">
                  {f.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <div className="flex items-center gap-1">
              <StreamStatus consultation={consultation} />
              {liveEncounterId && (
                <ActionTooltip label={speech.muted ? '取消静音' : '静音患者语音'} side="bottom">
                  <Button
                    aria-label={speech.muted ? '取消患者语音静音' : '静音患者语音'}
                    className={iconButton}
                    onClick={speech.toggleMute}
                  >
                    {speech.muted ? <VolumeXIcon aria-hidden="true" size={15} /> : <Volume2Icon aria-hidden="true" size={15} />}
                  </Button>
                </ActionTooltip>
              )}
            </div>
          </div>
          <ScrollArea stickToEnd className="consultation-scroll relative min-h-0 flex-1">
            <ScrollAreaViewport role="log" aria-label="问诊实时记录" className="h-full">
              <ScrollAreaContent>
                {visible.length === 0 ? (
                  <div className="conversation-empty"><span className="section-icon"><MessagesSquareIcon size={21} /></span>
                    <strong>{FILTERS.find((f) => f.value === filter)!.empty}</strong>
                    {filter === 'all' && encounter.status === 'active' && <p>键入问题或按住说话，开始问诊。</p>}</div>
                ) : (
                  <ol aria-label="问诊转写" className="transcript m-0 flex list-none flex-col gap-3 px-3.5 pt-3 pb-4">
                    {visible.map((entry) =>
                      entry.channel === 'examination' ? (
                        <PhysicalExaminationRow key={entry.examination.system} examination={entry.examination} />
                      ) : (
                        <TurnRow
                          key={entry.turn.turnId}
                          turn={entry.turn}
                          previousFailures={entry.turn.replyTo ? attempts.get(entry.turn.replyTo)?.filter((t) => t.turnId !== entry.turn.turnId && t.status === 'failed') : undefined}
                          patientName={encounter.patient.name}
                          streamed={consultation.streamed[entry.turn.turnId]}
                          speech={
                            entry.turn.speaker === 'patient'
                              ? {
                                  interrupted: speech.interrupted.has(entry.turn.turnId),
                                  progress: speech.playingTurnId === entry.turn.turnId ? speech.progress : null,
                                  replay:
                                    liveEncounterId && entry.turn.status === 'final' && entry.turn.text.trim()
                                      ? () => speech.replay(entry.turn)
                                      : undefined,
                                }
                              : null
                          }
                          retry={
                            entry.turn.status === 'failed' && entry.turn.seq === latestSeq && encounter.status === 'active'
                              ? () => void consultation.retry(entry.turn.turnId)
                              : undefined
                          }
                        />
                      ),
                    )}
                  </ol>
                )}
              </ScrollAreaContent>
            </ScrollAreaViewport>
            <ScrollAreaScrollbar>
              <ScrollAreaThumb />
            </ScrollAreaScrollbar>
            <ScrollAreaScrollToEnd className="consultation-jump">
              <ArrowDownIcon aria-hidden="true" size={13} />
              回到最新
            </ScrollAreaScrollToEnd>
          </ScrollArea>
          <div className="flex flex-none flex-col gap-2 border-t px-3.5 py-2">
            <PhysicalExaminationPanel encounter={encounter} examinations={context.examinations} />
            <VoiceBar encounter={encounter} voice={voice} holdButton={holdButton} />
            <QuestionComposer encounter={encounter} consultation={consultation} />
          </div>
        </>
      )}
    </section>
  )
}

function StreamStatus({ consultation }: { consultation: Consultation }) {
  const label = { connecting: '连接中', live: '实时', reconnecting: '连接中断，重连中…' }[consultation.stream]
  return (
    <span
      role="status"
      aria-label="模拟患者连接"
      className={`flex items-center gap-1 text-[11px] ${consultation.stream === 'reconnecting' ? 'text-warning' : 'text-muted-foreground'}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${consultation.stream === 'live' ? 'bg-success' : 'bg-warning'}`}
      />
      {label}
    </span>
  )
}

interface TurnSpeech {
  interrupted: boolean
  progress: number | null
  replay?: () => void
}

interface TurnRowProps {
  previousFailures?: ConsultationTurn[]
  turn: ConsultationTurn
  patientName: string
  streamed: string | undefined
  speech?: TurnSpeech | null
  retry?: () => void
}

function TurnRow({ turn, patientName, streamed, speech, retry, previousFailures }: TurnRowProps) {
  const dismissalKey = `clinmesh.dismissed-reply.${turn.turnId}`
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissalKey) === '1' } catch { return false }
  })
  const toggleFailure = () => {
    setDismissed(!dismissed)
    try {
      if (dismissed) localStorage.removeItem(dismissalKey)
      else localStorage.setItem(dismissalKey, '1')
    } catch {}
  }
  const doctor = turn.speaker === 'doctor'
  const failed = turn.status === 'failed'
  return (
    <li
      aria-label={`第 ${turn.seq} 条 · ${doctor ? '医生' : '患者'}`}
      data-speaker={turn.speaker}
      data-status={turn.status}
      className="group relative grid grid-cols-[26px_minmax(0,1fr)] gap-2"
    >
      <span
        aria-hidden="true"
        className={`grid size-[26px] place-items-center rounded-[7px] text-xs font-semibold ${doctor ? 'bg-accent text-accent-foreground' : 'bg-secondary'}`}
      >
        {doctor ? '医' : '患'}
      </span>
      <div className="min-w-0">
        <div className="flex min-h-[18px] flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <b className="font-medium text-foreground">{doctor ? '接诊医生' : patientName}</b>
          {spokenAt(turn) && (
            <time dateTime={spokenAt(turn)!} className="font-mono">
              {formatClockSeconds(spokenAt(turn)!)}
            </time>
          )}
          {turn.source === 'typed' ? (
            <span className={`${badge} h-[18px] bg-muted px-[5px] text-[11px] font-normal`}>
              <KeyboardIcon aria-hidden="true" size={11} />
              键入
            </span>
          ) : turn.source === 'voice' ? (
            <span className={`${badge} h-[18px] bg-muted px-[5px] text-[11px] font-normal`}>
              <MicIcon aria-hidden="true" size={11} />
              语音
              {turn.voice && ` · ${(turn.voice.durationMs / 1000).toFixed(1)}s · ${RECOGNIZER_LABEL[turn.voice.recognizer]}`}
              {turn.voice?.confidence != null && ` · ${(turn.voice.confidence * 100).toFixed(0)}%`}
            </span>
          ) : (
            <span className={`${badge} h-[18px] bg-muted px-[5px] text-[11px] font-normal`}>模拟患者</span>
          )}
          {turn.attempt > 1 && <span className="text-[11px]">第 {turn.attempt} 次作答</span>}
          {speech?.interrupted && (
            <span className={`${badge} h-[18px] bg-warning px-[5px] text-[11px] font-normal text-warning-foreground`}>
              播放已打断
            </span>
          )}
        </div>
        {turn.status === 'pending' ? (
          <PendingReply since={turn.createdAt} streamed={streamed} />
        ) : failed ? (
          <div className="text-[13px] leading-relaxed text-destructive">
            {turn.text && <p className="m-0 text-muted-foreground line-through">{turn.text}</p>}
            {!dismissed && <p className="m-0">{FAILURE_TEXT[turn.failure ?? 'llm-error']}</p>}
            <Button className="failure-toggle" aria-expanded={!dismissed} onClick={toggleFailure}>
              {dismissed ? '查看失败原因' : '收起提示'}
            </Button>
            {retry && (
              <Button className="mt-1 h-7 gap-1 px-2.5 text-xs" onClick={retry}>
                <RefreshCwIcon aria-hidden="true" size={12} />
                重试这一问
              </Button>
            )}
          </div>
        ) : (
          <div>
            <p className="m-0 text-sm leading-relaxed [overflow-wrap:anywhere]">{turn.text}</p>
          </div>
        )}
        {previousFailures && previousFailures.length > 0 && (
          <details className="attempt-history">
            <summary>历史尝试（{previousFailures.length}）</summary>
            <ul>{previousFailures.map((attempt) => <li key={attempt.turnId}>
              第 {attempt.attempt} 次 · {formatClockSeconds(attempt.settledAt ?? attempt.createdAt)} · {FAILURE_TEXT[attempt.failure ?? 'llm-error']}
            </li>)}</ul>
          </details>
        )}
        {speech && speech.progress !== null && (
          <div
            role="progressbar"
            aria-label={`第 ${turn.seq} 条语音播放进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(speech.progress * 100)}
            className="mt-1 h-1 w-40 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${speech.progress * 100}%` }} />
          </div>
        )}
      </div>
      {turn.status === 'final' && (
        <div className="transcript-actions">
          <CopyTurn turn={turn} />
          {speech?.replay && (
            <ActionTooltip label="重播回答" side="top">
              <Button aria-label={`重播第 ${turn.seq} 条回答`} className={`${iconButton} size-6`} onClick={speech.replay}>
                <RotateCcwIcon aria-hidden="true" size={12} />
              </Button>
            </ActionTooltip>
          )}
          <QuoteMenu label={`引用第 ${turn.seq} 条到病历`} text={quotedTurn(turn.speaker, turn.text)} />
        </div>
      )}
    </li>
  )
}

function PendingReply({ since, streamed }: { since: string; streamed: string | undefined }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="text-sm leading-relaxed">
      {streamed && <p className="m-0 [overflow-wrap:anywhere]">{streamed}</p>}
      <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
        <TypingDots />
        模拟患者正在组织语言 · {Math.max(0, Math.floor((now - Date.parse(since)) / 1000))}s
      </p>
    </div>
  )
}

function TypingDots() {
  return (
    <span aria-hidden="true" className="typing-dots">
      <i />
      <i />
      <i />
    </span>
  )
}

function CopyTurn({ turn }: { turn: ConsultationTurn }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.text)
      setState('copied')
    } catch {
      setState('failed')
    }
    setTimeout(() => setState('idle'), 1500)
  }
  return (
    <>
      <ActionTooltip label={state === 'copied' ? '已复制' : '复制'} closeOnPress={false} side="top">
        <Button aria-label={`复制第 ${turn.seq} 条`} className={`${iconButton} size-6`} onClick={copy}>
          {state === 'copied'
            ? <CheckIcon aria-hidden="true" size={12} className="text-success" />
            : <CopyIcon aria-hidden="true" size={12} />}
        </Button>
      </ActionTooltip>
      <span role="status" aria-label={`第 ${turn.seq} 条复制状态`} className="sr-only">
        {state === 'copied' ? '已复制' : state === 'failed' ? '无法访问剪贴板，请手动选择文本' : ''}
      </span>
    </>
  )
}

function QuestionComposer({ encounter, consultation }: { encounter: EncounterView; consultation: Consultation }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const active = encounter.status === 'active'
  const waiting = consultation.pending !== undefined
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const question = text.trim()
    if (!question || waiting || sending) return
    setSending(true)
    if (await consultation.ask(question)) setText('')
    setSending(false)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label="键入向患者的提问"
          value={text}
          onValueChange={setText}
          maxLength={MAX_QUESTION_LENGTH}
          disabled={!active}
          placeholder={!active ? '就诊已结束' : waiting ? '等待患者回答…' : '键入问题（不经过语音）'}
          className="h-8 min-w-0 flex-1 text-[13px]"
        />
        <Button type="submit" data-variant="solid" disabled={!active || waiting || sending || !text.trim()} className="h-8 px-3 text-xs">
          发送
        </Button>
      </div>
      {consultation.error && (
        <p role="alert" className="m-0 text-xs text-destructive">
          {consultation.error}
        </p>
      )}
    </form>
  )
}

function ConsultationStrip({ consultation, voice, toggleButton, onExpand }: {
  consultation: Consultation
  voice: VoiceCaptureController
  toggleButton: RefObject<HTMLButtonElement | null>
  onExpand: () => void
}) {
  const questions = consultation.turns.filter((turn) => turn.speaker === 'doctor').length
  return (
    <section aria-label="问诊记录（已收起）" className={`${pane} items-center gap-2.5 py-2`}>
      <ActionTooltip label="展开问诊记录" side="right">
        <Button ref={toggleButton} aria-label="展开问诊记录" className={iconButton} onClick={onExpand}>
          <PanelLeftOpenIcon aria-hidden="true" size={16} />
        </Button>
      </ActionTooltip>
      <span aria-hidden="true" className="text-[13px] tracking-[2px] text-muted-foreground [writing-mode:vertical-rl]">
        问诊记录{questions > 0 ? ` · ${questions} 问` : ''}
      </span>
      {voice.capturing && !voice.paused && (
        <span role="status" aria-label="问诊正在录音" title="问诊正在录音" className="text-destructive">
          <MicIcon aria-hidden="true" size={15} />
        </span>
      )}
      {voice.paused && (
        <span role="status" aria-label="问诊麦克风已暂停" title="问诊麦克风已暂停" className="text-warning">
          <MicOffIcon aria-hidden="true" size={15} />
        </span>
      )}
      {consultation.pending && (
        <span role="status" aria-label="等待患者回答" title="等待患者回答" className="text-muted-foreground">
          <TypingDots />
        </span>
      )}
    </section>
  )
}
