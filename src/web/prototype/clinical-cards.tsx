import {
  CalendarCheck2Icon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  FileTextIcon,
  FlaskConicalIcon,
  PlayIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
  Volume2Icon,
} from 'lucide-react'
import { useState } from 'react'
import type { MessagePart, PublishedResource } from './connected-clinic-store'

export function AudioVoiceBubble({
  part,
  playing,
  onTogglePlay,
  isSelf = false,
}: {
  part: Extract<MessagePart, { type: 'audio' }>
  playing: boolean
  onTogglePlay: () => void
  isSelf?: boolean
}) {
  const [showTranscript, setShowTranscript] = useState(true)

  return (
    <div
      className={`max-w-[440px] rounded-2xl px-3.5 py-2.5 transition-all ${
        isSelf
          ? 'bg-foreground text-background shadow-sm'
          : 'cc-surface-subtle'
      }`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={playing ? '停止语音播放' : '播放语音消息'}
          onClick={onTogglePlay}
          className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 cursor-pointer ${
            isSelf
              ? 'bg-background/18 text-background hover:bg-background/25'
              : 'bg-foreground text-background shadow-xs hover:opacity-90'
          }`}
        >
          {playing ? <SquareIcon size={10} fill="currentColor" /> : <PlayIcon size={11} fill="currentColor" className="ml-0.5" />}
        </button>

        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="cc-wave" data-playing={playing}>
              <span style={{ height: 5 }} />
              <span style={{ height: 12 }} />
              <span style={{ height: 8 }} />
              <span style={{ height: 15 }} />
              <span style={{ height: 10 }} />
              <span style={{ height: 6 }} />
              <span style={{ height: 13 }} />
              <span style={{ height: 9 }} />
              <span style={{ height: 14 }} />
              <span style={{ height: 7 }} />
            </div>
            <span className="font-mono text-[11.5px] font-medium tabular-nums opacity-85">
              0:{String(part.durationSec).padStart(2, '0')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {part.transcript && (
            <button
              type="button"
              onClick={() => setShowTranscript((v) => !v)}
              className={`rounded-md px-2 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer ${
                isSelf
                  ? 'bg-background/15 text-background/90 hover:bg-background/25'
                  : 'bg-card text-muted-foreground shadow-2xs hover:text-foreground'
              }`}
            >
              {showTranscript ? '收起转写' : '转文字'}
            </button>
          )}
        </div>
      </div>

      {part.transcript && showTranscript && (
        <div
          className={`mt-2.5 flex items-start gap-1.5 border-t pt-2 text-[12px] leading-relaxed ${
            isSelf
              ? 'border-background/15 text-background/85'
              : 'border-border/60 text-foreground/80'
          }`}
        >
          <Volume2Icon size={12} className="mt-0.5 shrink-0 opacity-60" />
          <span>{part.transcript}</span>
        </div>
      )}
    </div>
  )
}

export function ClinicalRichCard({
  part,
  resource,
  onAction,
}: {
  part: Extract<MessagePart, { type: 'card' }>
  resource?: PublishedResource
  onAction?: () => void
}) {
  const isReport = part.component === 'ReportCard'
  const isFollowup = part.component === 'FollowupFormCard'
  const isAppointment = part.component === 'AppointmentCard'

  const accentBar = isReport
    ? 'bg-emerald-500'
    : isFollowup
      ? 'bg-blue-500'
      : isAppointment
        ? 'bg-indigo-500'
        : 'bg-foreground'

  const Icon = isReport
    ? FlaskConicalIcon
    : isFollowup
      ? ClipboardListIcon
      : isAppointment
        ? CalendarCheck2Icon
        : FileTextIcon

  return (
    <div className="cc-surface group relative w-full max-w-[430px] overflow-hidden transition-shadow hover:shadow-md">
      <div className={`absolute inset-y-0 left-0 w-[3px] ${accentBar}`} aria-hidden="true" />
      <div className="p-3.5 pl-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex size-5 items-center justify-center rounded-md bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]">
              <Icon size={12} />
            </span>
            <span className="text-[11px] font-semibold tracking-tight text-muted-foreground">
              {part.component}
            </span>
          </div>
          {part.statusTag && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--cc-emerald-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--cc-emerald)]">
              <ShieldCheckIcon size={10} />
              {part.statusTag}
            </span>
          )}
        </div>

        <div className="mt-2 text-[13.5px] font-semibold tracking-tight text-foreground">
          {part.title}
        </div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{part.subtitle}</div>

        {/* Rich structured clinical preview inside ReportCard */}
        {isReport && resource && (
          <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-xl bg-[var(--cc-surface-subtle)] p-2.5">
            {resource.details.slice(0, 4).map((item) => (
              <div key={item.label} className="flex flex-col">
                <span className="truncate text-[10px] text-muted-foreground">{item.label}</span>
                <span
                  className={`font-mono text-[12px] font-semibold tabular-nums ${
                    item.flag === 'high' ? 'text-[var(--cc-crimson)]' : 'text-foreground'
                  }`}
                >
                  {item.value}
                  {item.flag === 'high' && ' ↑'}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Structured checklist preview inside FollowupFormCard */}
        {isFollowup && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {['自测体温', '咳嗽症状评分', '用药依从性', '补充体征'].map((field) => (
              <span
                key={field}
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--cc-surface-subtle)] px-2 py-1 text-[11px] text-foreground/80"
              >
                <CheckCircle2Icon size={11} className="text-[var(--cc-ai)]" />
                {field}
              </span>
            ))}
          </div>
        )}

        {/* Footer metadata & action */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--cc-hairline)] pt-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
            {part.meta.slice(0, 2).map((m) => (
              <span key={m} className="rounded bg-[var(--cc-surface-subtle)] px-1.5 py-0.5">
                {m}
              </span>
            ))}
          </div>
          {onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--cc-ai)] hover:underline cursor-pointer"
            >
              {part.actionLabel}
              <ChevronRightIcon size={12} />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <SparklesIcon size={11} className="text-[var(--cc-ai)]" />
              授权核验投影
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
