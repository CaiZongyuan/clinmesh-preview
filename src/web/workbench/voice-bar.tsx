import { Button } from '@ui-sdk/react/button'
import { MicIcon, MicOffIcon, HandIcon, CircleStopIcon } from 'lucide-react'
import { useEffect, useRef, type Ref, type RefObject } from 'react'
import type { EncounterView } from '../../shared/encounter'
import type { VoiceCaptureController } from '../voice/use-voice-capture'
import { badge } from './pane-styles'
import { ActionTooltip } from './ui-tooltip'
import { workbenchOwnsShortcut } from './workbench-shortcuts'

const ASR_LABEL: Record<VoiceCaptureController['asr'], string> = {
  off: '待机 · 麦克风未开启',
  microphone: '等待麦克风音频…',
  connecting: '识别服务连接中…',
  ready: '识别服务已连接',
  error: '识别服务出错',
}

// Pointer tracking for the hold button, kept across its remounts.
interface HoldControls {
  down(clientY: number): void
  move(clientY: number): void
  up(): void
  cancel(): void
}

function useHoldControls(voice: VoiceCaptureController, active: boolean): HoldControls {
  const startY = useRef<number | null>(null)
  useEffect(() => {
    if (!voice.holding) startY.current = null
  }, [voice.holding])
  useEffect(() => {
    if (!active) startY.current = null
  }, [active])
  return {
    down: (clientY) => {
      startY.current = clientY
      voice.press()
    },
    move: (clientY) => {
      if (startY.current !== null) voice.slide(clientY - startY.current)
    },
    up: () => {
      if (startY.current === null) return
      startY.current = null
      voice.release()
    },
    // A hold the browser interrupts (pointercancel, lost capture, window blur) is discarded:
    // nothing is committed and the mic closes.
    cancel: () => {
      startY.current = null
      voice.cancel()
    },
  }
}

// The pointer stream of a hold is captured on the bar container, which persists across the hold
// button's remounts (capturing on the button itself is released when it is replaced). The capture
// keeps the drag-outside gesture working: move updates the cancel arm and the pointerup is
// delivered wherever it happens. A hold the browser interrupts (pointercancel, lost capture) or
// that loses the window (blur) is discarded: nothing is committed and the mic closes.
function usePointerCapture(voice: VoiceCaptureController, active: boolean, hold: HoldControls) {
  const ref = useRef(voice)
  ref.current = voice
  const activeRef = useRef(active)
  activeRef.current = active
  const pointerActive = useRef(false)
  const handlers = {
    onPointerDown: (event: React.PointerEvent) => {
      const holdButton = (event.target as HTMLElement).closest('[data-hold-button]')
      if (!holdButton || !activeRef.current || ref.current.capturing) return
      event.preventDefault()
      pointerActive.current = true
      const container = event.currentTarget
      try {
        container.setPointerCapture(event.pointerId)
      } catch {} // jsdom and older browsers have no pointer capture; the blur/cancel paths cover those.
      hold.down(event.clientY)
    },
    onPointerMove: (event: React.PointerEvent) => hold.move(event.clientY),
    onPointerUp: () => {
      pointerActive.current = false
      hold.up()
    },
    onPointerCancel: () => {
      pointerActive.current = false
      hold.cancel()
    },
    // The pointer was taken away without an up (element replaced, device gone): discard.
    onLostPointerCapture: () => {
      if (!pointerActive.current) return
      pointerActive.current = false
      hold.cancel()
    },
  }
  useEffect(() => {
    const lost = () => {
      if (!pointerActive.current) return
      pointerActive.current = false
      hold.cancel()
    }
    window.addEventListener('blur', lost)
    return () => window.removeEventListener('blur', lost)
  }, [hold])
  return handlers
}

// A hold must never outlive its gesture. The button captures its pointer so a drag outside still
// delivers the move/up, and the window losing focus cancels whatever hold is open.
function useBlurCancel(voice: VoiceCaptureController, active: boolean) {
  const ref = useRef(voice)
  ref.current = voice
  useEffect(() => {
    if (!active) return
    const blur = () => {
      if (ref.current.holding) ref.current.cancel()
    }
    window.addEventListener('blur', blur)
    return () => window.removeEventListener('blur', blur)
  }, [active])
}

// The doctor's voice capture bar: hands-free listening, push-to-talk, and the pause that guarantees privacy.
// Hands-free is toggled (or M); push-to-talk is held with the pointer or Space, and sliding up while holding
// cancels. While paused a persistent banner says nothing is being heard or transcribed.
export function VoiceBar({ encounter, voice, holdButton }: {
  encounter: EncounterView
  voice: VoiceCaptureController
  holdButton: RefObject<HTMLButtonElement | null>
}) {
  const active = encounter.status === 'active'
  useBlurCancel(voice, active)
  const hold = useHoldControls(voice, active)
  const pointer = usePointerCapture(voice, active, hold)
  return (
    <div className="flex flex-col gap-1.5" {...pointer}>
      {voice.paused && (
        <p role="status" aria-label="麦克风已暂停" className={`${badge} h-auto w-fit bg-warning/15 px-2 py-1 text-warning`}>
          <MicOffIcon aria-hidden="true" size={12} />
          麦克风已暂停：暂停期间不会收音，也不会转写任何内容。
        </p>
      )}
      {voice.error && (
        <p role="alert" className="m-0 text-xs text-destructive">
          {voice.error}
        </p>
      )}
      {voice.notice && !voice.error && (
        <p role="status" className="m-0 text-xs text-muted-foreground">
          {voice.notice}
        </p>
      )}
      {voice.refused && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-2 text-xs text-destructive">
          语音提问未被记录（{voice.refused.message}）
          <Button className="h-6 gap-1 px-2 text-xs" onClick={voice.resubmit}>
            重新提交这句
          </Button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2" data-testid="voice-bar">
        {active && !voice.paused ? (
          voice.holding ? (
            <HoldButton voice={voice} buttonRef={holdButton} />
          ) : (
            <>
              <Button
                aria-pressed={voice.capturing}
                aria-label={voice.capturing ? '停止持续收音' : '开始持续收音'}
                data-variant={voice.capturing ? 'solid' : undefined}
                className="h-[30px] gap-1.5 px-2.5 text-xs"
                onClick={voice.toggle}
              >
                <MicIcon aria-hidden="true" size={13} />
                {voice.capturing ? '停止收音' : '持续收音'}
              </Button>
              <HoldButton voice={voice} buttonRef={holdButton} />
              <ActionTooltip label="暂停收音（快捷键 M）" side="top">
                <Button aria-keyshortcuts="M" aria-label="暂停收音" aria-pressed={false} className="h-[30px] gap-1.5 px-2.5 text-xs" onClick={voice.togglePause}>
                  <MicOffIcon aria-hidden="true" size={13} />
                  暂停
                </Button>
              </ActionTooltip>
            </>
          )
        ) : (
          <Button aria-keyshortcuts="M" aria-label="恢复收音" data-variant="solid" className="h-[30px] gap-1.5 px-3 text-xs" onClick={voice.togglePause} disabled={!voice.paused}>
            <MicIcon aria-hidden="true" size={13} />
            恢复收音
          </Button>
        )}
        {voice.capturing && !voice.holding && !voice.paused && (
          <span aria-label="正在收音" className="flex items-center gap-1 text-xs text-destructive">
            <LevelDot level={voice.level} />
            正在收音{voice.interim !== null && voice.interim !== '' ? ` · ${voice.interim}` : ''}
          </span>
        )}
        <VoiceStatus voice={voice} />
        {voice.devices.length > 1 && (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            麦克风
            <select
              aria-label="选择麦克风"
              value={voice.devices.find((d) => d.label === voice.deviceLabel)?.deviceId ?? ''}
              onChange={(event) => voice.selectDevice(event.target.value)}
              className="h-6 max-w-40 rounded border bg-card px-1 text-[11px]"
            >
              {voice.devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || '默认麦克风'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  )
}

// Hold-to-talk: press and hold (pointer or Space), with the elapsed time and a live level meter. Sliding up
// arms cancellation; releasing under 600 ms discards the tap. The press and release are the browser's only
// signals in this mode, so both arrive through the same button.
export function useVoiceKeys(voice: VoiceCaptureController, active: boolean, holdButton: RefObject<HTMLButtonElement | null>) {
  const ref = useRef(voice)
  ref.current = voice
  useEffect(() => {
    if (!active) return
    let holdsSpace = false
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
    const down = (event: KeyboardEvent) => {
      const capture = ref.current
      if (event.code === 'Space' && holdsSpace) {
        event.preventDefault()
        return
      }
      if (!workbenchOwnsShortcut(event) || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.code === 'KeyM' && !typing(event.target) && !capture.holding) {
        event.preventDefault()
        capture.togglePause()
        return
      }
      if (capture.paused) return
      const isHoldTarget = event.target === holdButton.current ||
        event.target === document.body || event.target === document
      if (event.code !== 'Space' || !isHoldTarget || capture.capturing) return
      event.preventDefault()
      holdsSpace = true
      capture.press()
    }
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !holdsSpace) return
      event.preventDefault()
      holdsSpace = false
      ref.current.release()
    }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    return () => {
      document.removeEventListener('keydown', down)
      document.removeEventListener('keyup', up)
    }
  }, [active, holdButton])
}

function HoldButton({ voice, buttonRef }: { voice: VoiceCaptureController; buttonRef: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-hold-button
      aria-keyshortcuts="Space"
      aria-label={voice.holding ? (voice.cancelArmed ? '松开以取消' : '正在录音，松开结束') : '按住说话'}
      data-holding={voice.holding || undefined}
      data-cancel={voice.cancelArmed || undefined}
      className="hold-talk-btn"
    >
      {voice.holding ? <CircleStopIcon aria-hidden="true" size={13} /> : <HandIcon aria-hidden="true" size={13} />}
      {voice.holding ? (
        voice.cancelArmed ? (
          '松开取消'
        ) : (
          <>
            {formatHoldMs(voice.elapsedMs)}
            <span aria-hidden="true" className="flex items-end gap-[1px]">
              {[0.2, 0.5, 0.8, 0.5, 0.2].map((threshold, i) => (
                <i
                  key={i}
                  className="w-[3px] rounded-sm bg-current transition-[height] duration-75"
                  style={{ height: `${3 + Math.round(voice.level > threshold ? 9 * voice.level : 0)}px` }}
                />
              ))}
            </span>
          </>
        )
      ) : (
        <>
          按住说话
          <kbd className="hold-talk-kbd">Space</kbd>
        </>
      )}
    </button>
  )
}

const formatHoldMs = (ms: number) => `${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}s`

function LevelDot({ level }: { level: number }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 rounded-full"
      style={{ opacity: 0.4 + 0.6 * level, backgroundColor: level > 0.05 ? 'var(--color-destructive)' : 'var(--color-muted-foreground)' }}
    />
  )
}

function VoiceStatus({ voice }: { voice: VoiceCaptureController }) {
  const recognizerLabel = voice.recognizer === 'paraformer-realtime-v2' ? 'Bailian Paraformer' : voice.recognizer === 'web-speech' ? '网页语音识别' : '正在读取语音配置'
  const status = voice.error ? 'error' : voice.asr
  const latency = voice.latencyMs !== null ? `延迟 ${voice.latencyMs}ms` : null
  return (
    <span role="status" aria-label="语音识别状态" className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        aria-hidden="true"
        className={`size-1.5 flex-none rounded-full ${status === 'ready' ? 'bg-success' : status === 'error' ? 'bg-destructive' : status === 'connecting' ? 'bg-warning' : 'bg-muted-foreground/70'}`}
      />
      <span className="truncate">
        {voice.paused ? '已暂停收音' : ASR_LABEL[status]} · {recognizerLabel}
        {latency && ` · ${latency}`}
        {voice.deviceLabel && ` · ${voice.deviceLabel}`}
      </span>
    </span>
  )
}
