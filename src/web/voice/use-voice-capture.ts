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

export type AsrState = 'off' | 'connecting' | 'ready' | 'error'

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

  const holding = session?.mode === 'hold'
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
    if (!encounterId || !session) return
    const ws = openVoiceSocket(encounterId)
    socketRef.current = ws
    setAsr('connecting')
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'clinmesh.capture', mode: session.mode } satisfies VoiceClientMessage))
      ws.send(JSON.stringify({ type: 'start_call' }))
    }
    ws.onmessage = (event) => {
      let message: VoiceServerMessage
      try {
        message = JSON.parse(String(event.data)) as VoiceServerMessage
      } catch {
        return
      }
      if (message.type === 'transcript_interim') setInterim(message.text || null)
      else if (message.type === 'status' && message.status === 'listening') setAsr('ready')
      else if (message.type === 'error') {
        setError(message.message)
        endSession()
      } else if (message.type === 'clinmesh.capture-empty') endSession('这段没有听清，没有记录。')
      else if (message.type === 'clinmesh.voice-turn') onVoiceTurn(message)
    }
    ws.onclose = () => {
      if (socketRef.current === ws) closeSocket()
    }
    return () => {
      if (socketRef.current === ws) {
        ws.close()
        socketRef.current = null
        setAsr('off')
      }
    }
  }, [encounterId, session, onVoiceTurn, endSession, closeSocket])

  // The microphone streams while a capture is open (continuous keeps it between sentences).
  useEffect(() => {
    if (!session || micRef.current) return
    const mic = new MicStream((frame) => {
      if (socketRef.current?.readyState === WebSocket.OPEN && !pausedRef.current) socketRef.current.send(frame)
    }, deviceId, { onReady: setDeviceLabel, onDevices: setDevices, onLevel: setLevel })
    micRef.current = mic
    void mic.start((message) => {
      setError(message)
      endSession()
    })
    return () => {
      void micRef.current?.stop()
      micRef.current = null
      setLevel(0)
    }
  }, [session, deviceId, endSession])

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
    if (recognizer === 'web-speech') webSpeechRef.current?.start()
    beginSession('continuous')
  }, [beginSession, endSession, recognizer])

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
    else send({ type: 'clinmesh.commit' })
  }, [endSession])

  const togglePause = useCallback(() => {
    setPaused((was) => {
      if (!was) webSpeechRef.current?.stop()
      else if (sessionRef.current && recognizer === 'web-speech') webSpeechRef.current?.start()
      return !was
    })
  }, [recognizer])

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
    if (recognizer !== 'web-speech' || !encounterId) return
    const speech = new WebSpeechSession({
      onFinal: (text, durationMs, confidence) => {
        setInterim(null)
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
      onError: (message) => setError(message),
    })
    webSpeechRef.current = speech
    return () => speech.dispose()
  }, [recognizer, encounterId, onTurn])

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
    togglePause,
    selectDevice,
    resubmit,
  }
}

// A held-open microphone that meters the input level and downsamples to 16 kHz mono PCM16.
class MicStream {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null

  constructor(
    private readonly onFrame: (frame: ArrayBuffer) => void,
    private readonly deviceId: string | null,
    private readonly hooks: {
      onReady(label: string | null): void
      onDevices(devices: MediaDeviceInfo[]): void
      onLevel(level: number): void
    },
  ) {}

  async start(onFailure: (message: string) => void) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.deviceId ? { deviceId: { exact: this.deviceId } } : true,
      })
    } catch {
      onFailure('无法访问麦克风，请检查浏览器权限。')
      return
    }
    const ctx = new AudioContext()
    this.ctx = ctx
    const source = ctx.createMediaStreamSource(this.stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = METER_POINTS
    source.connect(analyser)
    const meter = new Uint8Array(METER_POINTS)
    // ScriptProcessorNode is deprecated but works everywhere without a separate worklet module; the preview
    // pipeline is mono voice at 16 kHz, which it handles fine.
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => {
      analyser.getByteTimeDomainData(meter)
      let sum = 0
      for (const value of meter) sum += (value - 128) ** 2
      this.hooks.onLevel(Math.min(1, Math.sqrt(sum / meter.length) / 64))
      const input = event.inputBuffer.getChannelData(0)
      const ratio = Math.max(1, ctx.sampleRate / TARGET_RATE)
      const out = new Int16Array(Math.floor(input.length / ratio))
      for (let i = 0; i < out.length; i++) {
        const v = input[Math.floor(i * ratio)] ?? 0
        out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
      }
      if (out.length > 0) this.onFrame(out.buffer)
    }
    source.connect(processor)
    processor.connect(ctx.destination)
    this.hooks.onReady(this.stream.getAudioTracks()[0]?.label ?? null)
    this.hooks.onDevices(await navigator.mediaDevices.enumerateDevices().catch(() => []))
  }

  async stop() {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    await this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}

// The browser's SpeechRecognition (Chromium), used when the Worker has no BAILIAN_TOKEN. Each final result is
// one question; the session keeps listening until stopped.
class WebSpeechSession {
  private recognition: SpeechRecognitionLike | null = null
  private startedAt = 0

  constructor(
    private readonly hooks: {
      onFinal(text: string, durationMs: number, confidence: number | null): void
      onInterim(text: string | null): void
      onError(message: string): void
    },
  ) {}

  start() {
    const Ctor =
      (globalThis as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
      (globalThis as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'zh-CN'
    recognition.onresult = (event) => {
      let interim: string | null = null
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const alternative = result[0]
        if (result.isFinal) {
          const text = alternative.transcript.trim()
          if (text) this.hooks.onFinal(text, Date.now() - this.startedAt, alternative.confidence >= 0 ? alternative.confidence : null)
        } else {
          interim = alternative.transcript
        }
      }
      this.hooks.onInterim(interim)
    }
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') this.hooks.onError('网页语音识别出错，请重试。')
    }
    this.recognition = recognition
    this.startedAt = Date.now()
    recognition.start()
  }

  stop() {
    this.recognition?.stop()
    this.hooks.onInterim(null)
  }

  dispose() {
    this.recognition?.abort()
    this.recognition = null
  }
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: SpeechResultListLike }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechResultListLike extends ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> {}
