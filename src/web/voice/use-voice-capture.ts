import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsultationTurn, Recognizer } from '../../shared/consultation'
import { askPatient, fetchVoiceConfig, openVoiceSocket } from '../api'
import {
  MIN_HOLD_MS,
  type CaptureMode,
  type VoiceClientMessage,
  type VoiceServerMessage,
} from '../../shared/voice'

// How far up the pointer must move while holding for the capture to be discarded on release.
export const CANCEL_SLIDE_PX = 48
// The VAD, sentence segmentation and interim captions are the Paraformer service's; the browser streams 16 kHz
// mono PCM16 frames and decides when a capture begins and ends (ADR-0003). Without a Worker BAILIAN_TOKEN the
// browser's own Web Speech API recognizes speech and each final result goes over HTTP.
const TARGET_RATE = 16_000
const METER_POINTS = 256
const SPEECH_LEVEL = 0.025

export type AsrState = 'off' | 'microphone' | 'connecting' | 'ready' | 'error'

export interface VoiceError {
  code: string
  message: string
  clientTurnId: string
  text: string
}

export interface VoiceCaptureController {
  recognizer: Recognizer | null
  asr: AsrState
  mode: CaptureMode
  paused: boolean
  // A capture is open: continuous listening is on, or the hold button is down.
  capturing: boolean
  holding: boolean
  cancelArmed: boolean
  interim: string | null
  elapsedMs: number
  level: number
  latencyMs: number | null
  deviceLabel: string | null
  devices: MediaDeviceInfo[]
  notice: string | null
  refused: VoiceError | null
  error: string | null
  toggle(): void
  press(): void
  slide(dy: number): void
  release(): void
  // Discard the active hold without recording (pointercancel, lost capture, window blur).
  cancel(): void
  togglePause(): void
  selectDevice(deviceId: string): void
  resubmit(): void
}

// One capture session: from toggle-on or press until its turn is recorded, or it is discarded or toggled off.
interface Session {
  mode: CaptureMode
  startedAt: number
  cancelled: boolean
}

type VoiceTurnMessage = Extract<VoiceServerMessage, { type: 'clinmesh.voice-turn' }>

// The doctor's microphone at the workbench. Continuous mode (持续收音) streams to the Paraformer service, whose
// VAD ends each sentence; push-to-talk (按住说话) streams while held and commits on release. Pausing silences
// everything: no audio leaves the browser, so nothing is transcribed.
export function useVoiceCapture(
  encounterId: string | null,
  onTurn: (doctorTurn: ConsultationTurn, patientTurn: ConsultationTurn) => void,
  onSpeechStart?: () => void,
): VoiceCaptureController {
  const [recognizer, setRecognizer] = useState<Recognizer | null>(null)
  const [asr, setAsr] = useState<AsrState>('off')
  const [session, setSession] = useState<Session | null>(null)
  const [paused, setPaused] = useState(false)
  const [interim, setInterim] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refused, setRefused] = useState<VoiceError | null>(null)
  const [error, setError] = useState<string | null>(null)

  const captureMode = session?.mode
  const holding = captureMode === 'hold'
  const capturing = session !== null
  const cancelArmed = session?.cancelled ?? false
  // While holding, a short interval re-renders so the elapsed timer advances.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!holding) return
    const timer = setInterval(() => setTick(Date.now()), 200)
    return () => clearInterval(timer)
  }, [holding])

  // Which recognizer the Worker offers, learned once per Encounter.
  useEffect(() => {
    if (!encounterId) return
    let stale = false
    void fetchVoiceConfig()
      .then((config) => !stale && setRecognizer(config.recognizer))
      .catch(() => !stale && setRecognizer('paraformer-realtime-v2'))
    return () => {
      stale = true
    }
  }, [encounterId])

  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const socketRef = useRef<WebSocket | null>(null)
  const micRef = useRef<MicStream | null>(null)
  const captureWire = useRef<{ feed(frame: ArrayBuffer): void; commit(): void } | null>(null)
  const webSpeechRef = useRef<WebSpeechSession | null>(null)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  const send = (message: VoiceClientMessage) => socketRef.current?.send(JSON.stringify(message))

  const closeSocket = useCallback(() => {
    socketRef.current?.close()
    socketRef.current = null
    setAsr('off')
    setInterim(null)
  }, [])

  const stopMic = useCallback(() => {
    void micRef.current?.stop()
    micRef.current = null
    setLevel(0)
  }, [])

  const endSession = useCallback(
    (why?: string) => {
      setSession(null)
      if (why) setNotice(why)
      closeSocket()
      stopMic()
      webSpeechRef.current?.dispose()
    },
    [closeSocket, stopMic],
  )

  const onVoiceTurn = useCallback(
    (turn: VoiceTurnMessage) => {
      setInterim(null)
      setLatencyMs(turn.latencyMs)
      if (turn.ok) {
        setRefused(null)
        onTurn(turn.doctorTurn, turn.patientTurn)
      } else {
        setRefused({ code: turn.error.code, message: turn.error.message, clientTurnId: turn.clientTurnId, text: turn.text })
      }
      if (sessionRef.current?.mode === 'hold') endSession()
    },
    [onTurn, endSession],
  )

  // The voice socket lives for exactly one capture session.
  useEffect(() => {
    if (recognizer !== 'paraformer-realtime-v2' || !encounterId || !captureMode || paused) return
    const ws = openVoiceSocket(encounterId)
    socketRef.current = ws
    setAsr('microphone')
    const waiting: ArrayBuffer[] = []
    let waitingBytes = 0
    let opened = false
    let started = false
    let listening = false
    let released = false
    const flush = () => {
      if (!opened || waiting.length === 0) return
      if (!started) {
        started = true
        setAsr('connecting')
        ws.send(JSON.stringify({ type: 'start_call' }))
      }
      for (const frame of waiting) ws.send(frame)
      waiting.length = 0
      waitingBytes = 0
    }
    captureWire.current = {
      feed(frame) {
        if (released || socketRef.current !== ws || pausedRef.current) return
        waiting.push(frame)
        waitingBytes += frame.byteLength
        if (waitingBytes > TARGET_RATE * 2 * 10) {
          setError('连接语音服务超时，请重新开始收音。')
          endSession()
          return
        }
        flush()
      },
      commit() {
        if (released) return
        released = true
        stopMic()
        if (!started && !waiting.length) endSession('麦克风还未采到音频，请再说一次。')
        else if (listening) ws.send(JSON.stringify({ type: 'clinmesh.commit' }))
      },
    }
    ws.onopen = () => {
      if (socketRef.current !== ws) return
      opened = true
      ws.send(JSON.stringify({ type: 'clinmesh.capture', mode: captureMode } satisfies VoiceClientMessage))
      flush()
    }
    ws.onmessage = (event) => {
      if (socketRef.current !== ws) return
      let message: VoiceServerMessage
      try {
        message = JSON.parse(String(event.data)) as VoiceServerMessage
      } catch {
        return
      }
      if (message.type === 'transcript_interim' && !pausedRef.current) setInterim(message.text || null)
      else if (message.type === 'status' && message.status === 'listening' && !listening) {
        listening = true
        setAsr('ready')
        if (released) ws.send(JSON.stringify({ type: 'clinmesh.commit' }))
      }
      else if (message.type === 'error') {
        const fallback: Record<string, string> = {
          'Speech recognition connection was lost': '识别连接已中断，可重新开始收音。',
          'Speech recognition failed to start': '语音识别服务启动失败，可重新开始收音。',
        }
        setError(fallback[message.message] ?? message.message)
        endSession()
      } else if (message.type === 'clinmesh.capture-empty') endSession('这段没有听清，没有记录。')
      else if (message.type === 'clinmesh.voice-turn') onVoiceTurn(message)
    }
    ws.onclose = () => {
      if (socketRef.current !== ws) return
      setError('语音识别连接已中断，可重新开始收音。')
      endSession()
    }
    return () => {
      captureWire.current = null
      if (socketRef.current === ws) {
        ws.close()
        socketRef.current = null
        setAsr('off')
      }
    }
  }, [recognizer, encounterId, captureMode, paused, onVoiceTurn, endSession, stopMic])

  // The microphone streams while a capture is open (continuous keeps it between sentences).
  useEffect(() => {
    if (recognizer !== 'paraformer-realtime-v2' || !encounterId || !captureMode || paused) return
    const mic = new MicStream((frame) => {
      captureWire.current?.feed(frame)
    }, deviceId, { onReady: setDeviceLabel, onDevices: setDevices, onLevel: setLevel, onSpeechStart })
    micRef.current = mic
    const failMic = (message: string) => {
      if (micRef.current !== mic) return
      setError(message)
      endSession()
    }
    void mic.start(failMic).catch(() => failMic('麦克风音频采集启动失败，请重新开始收音。'))
    return () => {
      stopMic()
    }
  }, [recognizer, encounterId, captureMode, paused, deviceId, endSession, stopMic, onSpeechStart])

  const beginSession = useCallback((mode: CaptureMode) => {
    setError(null)
    setNotice(null)
    setRefused(null)
    setLatencyMs(null)
    setInterim(null)
    setPaused(false)
    setSession({ mode, startedAt: Date.now(), cancelled: false })
  }, [])

  const toggle = useCallback(() => {
    if (sessionRef.current) {
      send({ type: 'end_call' })
      endSession()
      return
    }
    beginSession('continuous')
  }, [beginSession, endSession])

  const press = useCallback(() => {
    if (sessionRef.current) return
    beginSession('hold')
  }, [beginSession])

  const slide = useCallback(
    (dy: number) => setSession((held) => (held ? { ...held, cancelled: dy < -CANCEL_SLIDE_PX } : held)),
    [],
  )

  const release = useCallback(() => {
    const held = sessionRef.current
    if (held?.mode !== 'hold') return
    const duration = Date.now() - held.startedAt
    if (held.cancelled) endSession('已取消，这段话没有记录。')
    else if (duration < MIN_HOLD_MS) endSession('按得太短，没有记录。再说请按住说话。')
    else if (recognizer === 'web-speech') webSpeechRef.current?.commit(duration)
    else captureWire.current?.commit()
  }, [endSession, recognizer])

  // A hold the browser interrupts (pointercancel, lost capture, window blur) is discarded: nothing
  // is committed, and ending the session closes the mic.
  const cancel = useCallback(() => {
    const held = sessionRef.current
    if (held?.mode !== 'hold') return
    endSession('已取消，这段话没有记录。')
  }, [endSession])

  const togglePause = useCallback(() => {
    setPaused((was) => !was)
    setInterim(null)
  }, [])

  const selectDevice = useCallback((id: string) => setDeviceId(id), [])

  const resubmit = useCallback(() => {
    setRefused((lost) => {
      if (lost) send({ type: 'clinmesh.resubmit', clientTurnId: lost.clientTurnId })
      return null
    })
    setInterim(null)
  }, [])

  // The Web Speech fallback: the browser recognizes speech itself; each final result asks the patient over HTTP.
  useEffect(() => {
    if (recognizer !== 'web-speech' || !encounterId || !captureMode || paused) return
    const speech = new WebSpeechSession(captureMode, {
      onFinal: (text, durationMs, confidence) => {
        setInterim(null)
        if (captureMode === 'hold') endSession()
        void askPatient(encounterId, crypto.randomUUID(), text, {
          recognizer: 'web-speech',
          durationMs,
          confidence,
        }).then(
          ({ doctorTurn, patientTurn }) => onTurn(doctorTurn, patientTurn),
          (e) => setError(e instanceof Error ? e.message : '语音提问失败'),
        )
      },
      onInterim: setInterim,
      onSpeechStart,
      onError: (message) => {
        setError(message)
        endSession()
      },
      onEmpty: () => endSession('这段没有听清，没有记录。'),
      onEnd: endSession,
    })
    webSpeechRef.current = speech
    if (speech.start()) setAsr('ready')
    return () => {
      speech.dispose()
      webSpeechRef.current = null
      setAsr('off')
    }
  }, [recognizer, encounterId, captureMode, paused, onTurn, endSession, onSpeechStart])

  return {
    recognizer,
    asr,
    mode: session?.mode ?? 'continuous',
    paused,
    capturing,
    holding,
    cancelArmed,
    interim,
    elapsedMs: session ? Date.now() - session.startedAt : 0,
    level,
    latencyMs,
    deviceLabel,
    devices,
    notice,
    refused,
    error,
    toggle,
    press,
    slide,
    release,
    cancel,
    togglePause,
    selectDevice,
    resubmit,
  }
}

// A held-open microphone that meters the input level and downsamples to 16 kHz mono PCM16.
class MicStream {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private stopped = false

  constructor(
    private readonly onFrame: (frame: ArrayBuffer) => void,
    private readonly deviceId: string | null,
    private readonly hooks: {
      onReady(label: string | null): void
      onDevices(devices: MediaDeviceInfo[]): void
      onLevel(level: number): void
      onSpeechStart?: () => void
    },
  ) {}

  async start(onFailure: (message: string) => void) {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: this.deviceId ? { deviceId: { exact: this.deviceId } } : true,
      })
    } catch {
      if (!this.stopped) onFailure('无法访问麦克风，请检查浏览器权限。')
      return
    }
    if (this.stopped) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.stream = stream
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.stopped) return
    const source = ctx.createMediaStreamSource(this.stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = METER_POINTS
    source.connect(analyser)
    const meter = new Uint8Array(METER_POINTS)
    // ScriptProcessorNode is deprecated but works everywhere without a separate worklet module; the preview
    // pipeline is mono voice at 16 kHz, which it handles fine.
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => {
      if (this.stopped) return
      analyser.getByteTimeDomainData(meter)
      let sum = 0
      for (const value of meter) sum += (value - 128) ** 2
      this.hooks.onLevel(Math.min(1, Math.sqrt(sum / meter.length) / 64))
      const input = event.inputBuffer.getChannelData(0)
      const ratio = Math.max(1, ctx.sampleRate / TARGET_RATE)
      const out = new Int16Array(Math.floor(input.length / ratio))
      let energy = 0
      for (let i = 0; i < out.length; i++) {
        const v = input[Math.floor(i * ratio)] ?? 0
        energy += v * v
        out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
      }
      if (energy > SPEECH_LEVEL ** 2 * out.length) this.hooks.onSpeechStart?.()
      if (out.length > 0) this.onFrame(out.buffer)
    }
    source.connect(processor)
    processor.connect(ctx.destination)
    this.hooks.onReady(this.stream.getAudioTracks()[0]?.label ?? null)
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    if (!this.stopped) this.hooks.onDevices(devices.filter((device) => device.kind === 'audioinput'))
  }

  async stop() {
    this.stopped = true
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    await this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}

class WebSpeechSession {
  private recognition: SpeechRecognitionLike | null = null
  private startedAt = 0
  private ended = false
  private committedDuration: number | null = null
  private readonly phrases: string[] = []
  private confidence: number | null = null

  constructor(
    private readonly mode: CaptureMode,
    private readonly hooks: {
      onFinal(text: string, durationMs: number, confidence: number | null): void
      onInterim(text: string | null): void
      onSpeechStart?: () => void
      onError(message: string): void
      onEmpty(): void
      onEnd(): void
    },
  ) {}

  start() {
    const Ctor =
      (globalThis as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
      (globalThis as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition
    if (!Ctor) {
      this.hooks.onError('此浏览器不支持网页语音识别。')
      return false
    }
    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'zh-CN'
    recognition.onspeechstart = () => {
      if (this.recognition === recognition) this.hooks.onSpeechStart?.()
    }
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return
      let interim: string | null = null
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const alternative = result[0]
        if (result.isFinal) {
          const text = alternative.transcript.trim()
          if (!text) continue
          const confidence = alternative.confidence >= 0 ? alternative.confidence : null
          if (this.mode === 'continuous') {
            this.hooks.onFinal(text, Date.now() - this.startedAt, confidence)
          } else {
            this.phrases.push(text)
            if (confidence !== null) this.confidence = Math.min(confidence, this.confidence ?? confidence)
          }
        } else {
          interim = alternative.transcript
        }
      }
      this.hooks.onInterim(interim)
    }
    recognition.onerror = (event) => {
      if (this.recognition === recognition && event.error !== 'aborted') this.hooks.onError('网页语音识别出错，请重试。')
    }
    recognition.onend = () => {
      if (this.recognition !== recognition) return
      this.ended = true
      if (this.mode === 'continuous') this.hooks.onEnd()
      else if (this.committedDuration !== null) this.finish(this.committedDuration)
    }
    this.recognition = recognition
    this.startedAt = Date.now()
    try {
      recognition.start()
      return true
    } catch {
      this.ended = true
      this.hooks.onError('无法启动网页语音识别，请重试。')
      return false
    }
  }

  commit(durationMs: number) {
    if (!this.recognition || this.committedDuration !== null) return
    this.committedDuration = durationMs
    if (this.ended) this.finish(durationMs)
    else this.recognition.stop()
  }

  private finish(durationMs: number) {
    const text = this.phrases.join('')
    if (text) this.hooks.onFinal(text, durationMs, this.confidence)
    else this.hooks.onEmpty()
  }

  dispose() {
    const recognition = this.recognition
    this.recognition = null
    if (!this.ended) recognition?.abort()
  }
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onspeechstart: (() => void) | null
  onresult: ((event: { resultIndex: number; results: SpeechResultListLike }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechResultListLike extends ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> {}
