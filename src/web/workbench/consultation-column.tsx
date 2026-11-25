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
import { ArrowDownIcon, CheckIcon, CopyIcon, KeyboardIcon, MicIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, RefreshCwIcon, RotateCcwIcon, Volume2Icon, VolumeXIcon } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { MAX_QUESTION_LENGTH, type ConsultationTurn, type PatientTurnFailure, type Recognizer } from '../../shared/consultation'
import type { EncounterView } from '../../shared/encounter'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import type { Consultation } from '../consultation/use-consultation'
import { QuoteMenu, quotedTurn } from './clinical-note/quote-menu'
import { formatClockSeconds } from './format'
import { badge, iconButton, pane, paneHeader } from './pane-styles'
import { PhysicalExaminationPanel, PhysicalExaminationRow } from './physical-examination'
import { useVoiceCapture } from '../voice/use-voice-capture'
import { usePatientSpeech } from '../voice/use-patient-speech'
import { VoiceBar } from './voice-bar'

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

interface ColumnProps {
  encounter?: EncounterContext
  consultation: Consultation
  onCollapse: () => void
}

export function ConsultationColumn({ encounter: context, consultation, onCollapse }: ColumnProps) {
  const [filter, setFilter] = useState<TranscriptFilter>('all')
  const encounter = context?.encounter
  const voice = useVoiceCapture(encounter?.encounterId ?? null, consultation.accept)
  // The patient's spoken replies; the doctor starting to capture — 持续收音 toggle-on or a hold press — barge-ins.
  const speech = usePatientSpeech(encounter ?? null, consultation, voice.capturing)
  const visible = transcriptOf(consultation.turns, context?.examinations ?? []).filter(
    (entry) => filter === 'all' || entry.channel === filter,
  )
  const latestSeq = consultation.turns.at(-1)?.seq
  return (
    <section aria-label="问诊记录" className={pane}>
      <div className={paneHeader}>
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">问诊记录</h2>
          <p className="m-0 truncate text-[11px] text-muted-foreground">
            {encounter ? `模拟患者 · ${encounter.patient.name} · ` : ''}只按版本固定的 Patient Persona 应答
          </p>
        </div>
        <Button aria-label="收起问诊记录" className={iconButton} onClick={onCollapse}>
          <PanelLeftCloseIcon aria-hidden="true" size={16} />
        </Button>
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
                <SegmentedControlItem key={f.value} value={f.value} className="px-2">
                  {f.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <StreamStatus consultation={consultation} />
          </div>
          <div className="flex flex-none justify-end border-b px-3.5 py-1">
            <Button
              aria-label={speech.muted ? '取消患者语音静音' : '静音患者语音'}
              title={speech.muted ? '取消静音' : '静音'}
              className={iconButton}
              onClick={speech.toggleMute}
            >
              {speech.muted ? <VolumeXIcon aria-hidden="true" size={15} /> : <Volume2Icon aria-hidden="true" size={15} />}
            </Button>
          </div>
          <ScrollArea stickToEnd className="relative min-h-0 flex-1">
            <ScrollAreaViewport role="log" aria-label="问诊实时记录" className="h-full">
              <ScrollAreaContent>
                {visible.length === 0 ? (
                  <p className="m-0 p-4 text-[13px] text-muted-foreground">{FILTERS.find((f) => f.value === filter)!.empty}</p>
                ) : (
                  <ol aria-label="问诊转写" className="m-0 flex list-none flex-col gap-3 px-3.5 pt-3 pb-4">
                    {visible.map((entry) =>
                      entry.channel === 'examination' ? (
                        <PhysicalExaminationRow key={entry.examination.system} examination={entry.examination} />
                      ) : (
                        <TurnRow
                          key={entry.turn.turnId}
                          turn={entry.turn}
                          patientName={encounter.patient.name}
                          streamed={consultation.streamed[entry.turn.turnId]}
                          speech={
                            entry.turn.speaker === 'patient'
                              ? {
                                  interrupted: speech.interrupted.has(entry.turn.turnId),
                                  playing: speech.playingTurnId === entry.turn.turnId,
                                  progress: speech.playingTurnId === entry.turn.turnId ? speech.progress : null,
                                  replay:
                                    entry.turn.status === 'final' && entry.turn.text.trim()
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
            <VoiceBar encounter={encounter} voice={voice} />
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
  playing: boolean
  progress: number | null
  replay?: () => void
}

interface TurnRowProps {
  turn: ConsultationTurn
  patientName: string
  streamed: string | undefined
  speech?: TurnSpeech | null
  retry?: () => void
}

function TurnRow({ turn, patientName, streamed, speech, retry }: TurnRowProps) {
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
            <p className="m-0">{FAILURE_TEXT[turn.failure ?? 'llm-error']}</p>
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
            {speech?.playing && speech.progress !== null && (
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
        )}
      </div>
      {turn.status === 'final' && (
        <div className="absolute top-0 right-0 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-open]]:opacity-100">
          <CopyTurn turn={turn} />
          {speech?.replay && (
            <Button aria-label={`重播第 ${turn.seq} 条回答`} title="重播" className={`${iconButton} size-6 bg-card`} onClick={speech.replay}>
              <RotateCcwIcon aria-hidden="true" size={12} />
            </Button>
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
      <Button aria-label={`复制第 ${turn.seq} 条`} title="复制" className={`${iconButton} size-6 bg-card`} onClick={copy}>
        {state === 'copied' ? <CheckIcon aria-hidden="true" size={12} /> : <CopyIcon aria-hidden="true" size={12} />}
      </Button>
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

export function ConsultationStrip({ consultation, onExpand }: { consultation: Consultation; onExpand: () => void }) {
  const questions = consultation.turns.filter((turn) => turn.speaker === 'doctor').length
  return (
    <section aria-label="问诊记录（已收起）" className={`${pane} items-center gap-2.5 py-2`}>
      <Button aria-label="展开问诊记录" className={iconButton} onClick={onExpand}>
        <PanelLeftOpenIcon aria-hidden="true" size={16} />
      </Button>
      <span aria-hidden="true" className="text-[13px] tracking-[2px] text-muted-foreground [writing-mode:vertical-rl]">
        问诊记录{questions > 0 ? ` · ${questions} 问` : ''}
      </span>
      {consultation.pending && (
        <span role="status" aria-label="等待患者回答" title="等待患者回答" className="text-muted-foreground">
          <TypingDots />
        </span>
      )}
    </section>
  )
}
