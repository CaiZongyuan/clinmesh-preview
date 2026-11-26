import { CheckIcon } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentStream } from './connected-clinic-store'

export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`cc-spinner ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}

export function useDelayedFlag(active: boolean, delayMs = 300, minVisibleMs = 500) {
  const [shown, setShown] = useState(false)
  const shownAt = useRef(0)
  useEffect(() => {
    if (active && !shown) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now()
        setShown(true)
      }, delayMs)
      return () => clearTimeout(timer)
    }
    if (!active && shown) {
      const timer = setTimeout(() => setShown(false), Math.max(0, minVisibleMs - (Date.now() - shownAt.current)))
      return () => clearTimeout(timer)
    }
  }, [active, shown, delayMs, minVisibleMs])
  return shown
}

export function SkeletonLine({ width, height = 12, className = '' }: { width: string | number; height?: number; className?: string }) {
  return <span className={`cc-skel ${className}`} style={{ width, height }} />
}

export function ChatSkeleton() {
  const rows: { side: 'in' | 'out'; widths: string[] }[] = [
    { side: 'in', widths: ['72%', '54%'] },
    { side: 'out', widths: ['46%'] },
    { side: 'in', widths: ['80%', '66%', '38%'] },
    { side: 'out', widths: ['58%', '30%'] },
  ]
  return (
    <div className="cc-skel-group flex flex-col gap-5 px-4 py-5" aria-hidden="true">
      {rows.map((row, index) => (
        <div key={index} className={`flex gap-2.5 ${row.side === 'out' ? 'flex-row-reverse' : ''}`}>
          {row.side === 'in' && <span className="cc-skel size-8 shrink-0 rounded-full" />}
          <div className={`flex w-[78%] flex-col gap-2 ${row.side === 'out' ? 'items-end' : ''}`}>
            {row.widths.map((width) => (
              <SkeletonLine key={width} width={width} height={12} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="cc-skel-group flex flex-col gap-2.5" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="cc-m-card flex flex-col gap-2.5 p-4">
          <div className="flex items-center justify-between">
            <SkeletonLine width={index % 2 ? '52%' : '64%'} height={13} />
            <SkeletonLine width={44} height={16} className="!rounded-full" />
          </div>
          <SkeletonLine width="40%" height={10} />
          <SkeletonLine width="92%" height={10} />
          <SkeletonLine width={index % 2 ? '70%' : '78%'} height={10} />
        </div>
      ))}
    </div>
  )
}

function useStreamClock(stream: AgentStream | undefined) {
  const [mountedAt] = useState(() => Date.now())
  if (!stream) return 0
  return mountedAt - stream.startedAt
}

export function chunkText(text: string) {
  const chunks: string[] = []
  let current = ''
  for (const char of Array.from(text)) {
    current += char
    const latin = /[A-Za-z0-9.]/.test(char)
    if ((!latin && current.length >= 2) || char === ' ' || /[，。；：！？、）]/.test(char)) {
      chunks.push(current)
      current = ''
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function streamTextDuration(stream: AgentStream, text: string) {
  return stream.textStartsAfterMs + chunkText(text).length * stream.chunkMs
}

export function StreamingText({ text, stream }: { text: string; stream?: AgentStream }) {
  const elapsedAtMount = useStreamClock(stream)
  if (!stream || stream.status !== 'streaming') return <>{text}</>
  const chunks = chunkText(text)
  const start = stream.textStartsAfterMs - elapsedAtMount
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {chunks.map((chunk, index) => (
          <span key={index} className="cc-stream-chunk" style={{ animationDelay: `${start + index * stream.chunkMs}ms` }}>
            {chunk}
          </span>
        ))}
        <span
          className="cc-stream-caret"
          style={{ '--caret-in': `${start}ms`, '--caret-out': `${start + chunks.length * stream.chunkMs}ms` } as CSSProperties}
        />
      </span>
    </>
  )
}

export function RevealAfter({ stream, afterMs, children }: { stream?: AgentStream; afterMs: number; children: ReactNode }) {
  const elapsedAtMount = useStreamClock(stream)
  if (!stream || stream.status !== 'streaming') return <>{children}</>
  return (
    <div className="cc-reveal" style={{ animationDelay: `${afterMs - elapsedAtMount}ms` }}>
      {children}
    </div>
  )
}

export function AgentSteps({ stream }: { stream: AgentStream }) {
  const elapsedAtMount = useStreamClock(stream)
  const live = stream.status === 'streaming'
  return (
    <ol className="cc-agent-steps" aria-label="助手执行步骤">
      {stream.steps.map((step, index) => {
        const doneDelay = step.doneAfterMs - elapsedAtMount
        const enterDelay = (index === 0 ? 0 : stream.steps[index - 1].doneAfterMs) - elapsedAtMount
        return (
          <li
            key={step.label}
            className="cc-agent-step"
            data-live={live || undefined}
            style={{ '--step-in': `${enterDelay}ms`, '--step-done': `${doneDelay}ms` } as CSSProperties}
          >
            <span className="cc-agent-step-icon">
              {live && <Spinner size={13} className="cc-step-spin" />}
              <CheckIcon size={11} strokeWidth={3} className="cc-step-check" />
            </span>
            <span>{step.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

const AURORA = {
  light: [
    [110, 150, 255],
    [180, 130, 255],
    [255, 130, 190],
    [255, 180, 120],
  ],
  dark: [
    [80, 140, 255],
    [160, 110, 255],
    [255, 110, 180],
    [255, 190, 140],
  ],
} as const

export interface ShockwavePulse {
  id: number
  x: number
  y: number
}

function isDarkSurface(element: HTMLElement) {
  const match = getComputedStyle(element).backgroundColor.match(/\d+(\.\d+)?/g)
  if (!match) return false
  const [r, g, b] = match.map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110
}

export function Shockwave({ pulse }: { pulse: ShockwavePulse | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lensRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const lens = lensRef.current
    const surface = canvas?.parentElement
    if (!pulse || !canvas || !lens || !surface) return
    const context = canvas.getContext('2d')
    if (!context) return

    const width = surface.clientWidth
    const height = surface.clientHeight
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = width * ratio
    canvas.height = height * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)

    const dark = isDarkSurface(surface)
    const palette = dark ? AURORA.dark : AURORA.light
    canvas.dataset.dark = dark ? 'true' : 'false'
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ringWidth = Math.max(40, width * 0.13)
    const centerX = pulse.x
    const centerY = height + width * 0.66
    const startRadius = centerY - pulse.y
    const growth = pulse.y + ringWidth * 2
    const duration = reduced ? 600 : 1000
    const delay = reduced ? 0 : 40
    const begin = performance.now() + delay
    let frame = 0

    const draw = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - begin) / duration))
      const radius = reduced ? startRadius + growth * 0.5 : startRadius + (growth * (1 - 2 ** (-9 * t))) / (1 - 2 ** -9)
      const strength = reduced ? 0.5 * Math.sin(Math.PI * t) : Math.min(1, t / 0.03) * (1 - t ** 2.2)

      context.clearRect(0, 0, width, height)
      const inner = Math.max(0, radius - 3.5 * ringWidth)
      const outer = radius + 3.5 * ringWidth
      const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, outer)
      const samples = 40
      for (let i = 0; i < samples; i++) {
        const distance = inner + ((outer - inner) * i) / (samples - 1)
        const x = (distance - radius) / ringWidth
        let weight = 0
        const color = [0, 0, 0]
        palette.forEach((ring, ringIndex) => {
          const w = Math.exp(-(((x - (ringIndex - 1.5)) / 0.8) ** 2))
          weight += w
          color[0] += ring[0] * w
          color[1] += ring[1] * w
          color[2] += ring[2] * w
        })
        const alpha = strength * Math.exp(-1.1 * (x / 2) ** 2) * (dark ? 0.5 : 0.34)
        const [r, g, b] = color.map((channel) => Math.round(channel / (weight || 1)))
        gradient.addColorStop(distance / outer, `rgb(${r} ${g} ${b} / ${alpha.toFixed(3)})`)
      }
      if (inner > 0) gradient.addColorStop(0, 'rgb(0 0 0 / 0)')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)

      lens.style.setProperty('--sw-x', `${centerX}px`)
      lens.style.setProperty('--sw-y', `${centerY}px`)
      lens.style.setProperty('--sw-r', `${radius}px`)
      lens.style.setProperty('--sw-w', `${ringWidth * 0.9}px`)
      lens.style.opacity = reduced ? '0' : String(strength)

      if (t < 1) frame = requestAnimationFrame(draw)
      else {
        context.clearRect(0, 0, width, height)
        lens.style.opacity = '0'
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [pulse])

  return (
    <>
      <div ref={lensRef} className="cc-shockwave-lens" aria-hidden="true" />
      <canvas ref={canvasRef} className="cc-shockwave" aria-hidden="true" />
    </>
  )
}
