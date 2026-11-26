import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from 'agents/voice'
import { DASHSCOPE_INFERENCE_URL, type CaptureMode } from '../../shared/voice'

export { DASHSCOPE_INFERENCE_URL }
export const PARAFORMER_MODEL = 'paraformer-realtime-v2'

const SAMPLE_RATE = 16_000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
const START_TIMEOUT_MS = 10_000
const FINISH_TIMEOUT_MS = 3_000
const MAX_TIMELINE = 3_000

// Opens the duplex DashScope inference WebSocket, already accepted.
export type ConnectUpstream = (token: string) => Promise<WebSocket>

export async function connectDashScope(token: string, url = DASHSCOPE_INFERENCE_URL, workspace?: string): Promise<WebSocket> {
  const headers = new Headers({ Upgrade: 'websocket', Authorization: `Bearer ${token}` })
  if (workspace) headers.set('X-DashScope-WorkSpace', workspace)
  const response = await fetch(url, { headers })
  const socket = response.webSocket
  if (!socket) throw new Error(`DashScope refused the speech recognition socket (HTTP ${response.status})`)
  socket.accept()
  return socket
}

// A finalized sentence (or, for push-to-talk, everything said while holding) with its timing.
export interface RecognizedSpeech {
  text: string
  // From the recognizer's word timestamps: how long the doctor spoke.
  durationMs: number
  // From the moment the recognizer had the sentence's last audio until it finalized it; for push-to-talk, from release.
  latencyMs: number | null
}

export interface ParaformerOptions {
  token: string
  connect: ConnectUpstream
  mode: CaptureMode
  // Called with each recognized utterance's timing just before the session reports it through `onUtterance`.
  onRecognized?: (speech: RecognizedSpeech) => void
  // A committed push-to-talk capture in which nothing was recognized.
  onEmpty?: () => void
  onFailure?: (code: string, taskId: string) => void
}

interface Sentence {
  text: string
  begin_time?: number | null
  end_time?: number | null
  sentence_end?: boolean
  heartbeat?: boolean
}

interface ServiceEvent {
  header?: { event?: string; task_id?: string; error_code?: string; error_message?: string }
  payload?: { output?: { sentence?: Sentence } }
}

// The `agents/voice` Transcriber for Bailian Paraformer realtime (ADR-0003): one DashScope task per call. It sends
// `run-task`, holds audio until `task-started`, streams 16 kHz mono PCM16, reports partial results as interim
// captions and each `sentence_end` result as an utterance, and ends the task with `finish-task`.
// In push-to-talk (`hold`) mode, sentences accumulate until `commit()`; the utterance is everything said, reported
// once the service has finished the task.
export class ParaformerTranscriber implements Transcriber {
  private session: ParaformerSession | null = null

  constructor(private readonly options: ParaformerOptions) {}

  createSession(callbacks: TranscriberSessionOptions = {}): TranscriberSession {
    this.session = new ParaformerSession(this.options, callbacks)
    return this.session
  }

  commit(): void {
    this.session?.commit()
  }
}

type TaskState = 'connecting' | 'started' | 'finishing' | 'finished' | 'failed'

class ParaformerSession implements TranscriberSession {
  private socket: WebSocket | null = null
  private state: TaskState = 'connecting'
  private readonly taskId = crypto.randomUUID().replaceAll('-', '')
  private readonly ready: Promise<void>
  private settleReady!: (error?: Error) => void
  private readySettled = false
  private unsent: ArrayBuffer[] = []
  // Which wall-clock moment each stretch of audio reached the session, to time the recognizer's latency.
  private timeline: { endMs: number; at: number }[] = []
  private fedBytes = 0
  private speaking = false
  private held: Sentence[] = []
  private committedAt: number | null = null
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: ParaformerOptions,
    private readonly callbacks: TranscriberSessionOptions,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = (error) => {
        if (this.readySettled) return
        this.readySettled = true
        if (error) reject(error)
        else resolve()
      }
    })
    this.ready.catch(() => {})
    this.timer = setTimeout(() => this.fail(new Error('Paraformer did not start the task in time'), 'StartTimeout'), START_TIMEOUT_MS)
    void this.open()
  }

  waitUntilReady(): Promise<void> {
    return this.ready
  }

  feed(chunk: ArrayBuffer): void {
    if (this.closed || this.committedAt !== null || this.state === 'failed' || this.state === 'finished') return
    this.fedBytes += chunk.byteLength
    this.timeline.push({ endMs: this.fedBytes / BYTES_PER_MS, at: Date.now() })
    if (this.timeline.length > MAX_TIMELINE) this.timeline.shift()
    if (this.state === 'started') this.socket!.send(chunk)
    else this.unsent.push(chunk)
  }

  commit(): void {
    if (this.options.mode !== 'hold' || this.committedAt !== null || this.closed) return
    this.committedAt = Date.now()
    if (this.state === 'started') this.finishTask()
  }

  // Ends the task with `finish-task` and stops reporting; the socket closes once the service says the task finished.
  // While still connecting, `started()` finishes the task once the service accepts it.
  close(): void {
    if (this.closed) return
    this.closed = true
    this.settleReady(new Error('The speech recognition session was closed'))
    if (this.state === 'started') this.finishTask()
  }

  private async open() {
    let socket: WebSocket
    try {
      socket = await this.options.connect(this.options.token)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.socket = socket
    if (this.closed || this.state === 'failed') return this.disconnect()
    socket.addEventListener('message', (event) => this.receive(event.data))
    socket.addEventListener('close', () => this.lost())
    socket.addEventListener('error', () => this.lost())
    socket.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: PARAFORMER_MODEL,
          parameters: { format: 'pcm', sample_rate: SAMPLE_RATE, language_hints: ['zh', 'en'] },
          input: {},
        },
      }),
    )
  }

  private receive(data: unknown) {
    if (typeof data !== 'string') return
    let message: ServiceEvent
    try {
      message = JSON.parse(data) as ServiceEvent
    } catch {
      return
    }
    const header = message.header ?? {}
    if (header.task_id && header.task_id !== this.taskId) return
    switch (header.event) {
      case 'task-started':
        return this.started()
      case 'result-generated':
        return this.result(message.payload?.output?.sentence)
      case 'task-finished':
        return this.finished()
      case 'task-failed':
        return this.fail(new Error(`${header.error_code ?? 'TaskFailed'}: ${header.error_message ?? 'speech recognition failed'}`), header.error_code ?? 'TaskFailed')
    }
  }

  private started() {
    if (this.state !== 'connecting' || !this.socket) return
    clearTimeout(this.timer)
    this.state = 'started'
    for (const chunk of this.unsent) this.socket!.send(chunk)
    this.unsent = []
    this.settleReady()
    if (this.committedAt !== null || this.closed) this.finishTask()
  }

  private result(sentence: Sentence | undefined) {
    if (!sentence || sentence.heartbeat || this.closed) return
    const text = sentence.text ?? ''
    const hold = this.options.mode === 'hold'
    if (!sentence.sentence_end) {
      if (!this.speaking) {
        this.speaking = true
        this.callbacks.onSpeechStart?.()
      }
      this.callbacks.onInterim?.(hold ? this.heldText() + text : text)
      return
    }
    this.speaking = false
    if (hold) {
      this.held.push(sentence)
      this.callbacks.onInterim?.(this.heldText())
      return
    }
    const latencyMs = this.latencyAt(sentence.end_time)
    if (text.trim()) this.utter([sentence], latencyMs)
  }

  private finished() {
    clearTimeout(this.timer)
    this.state = 'finished'
    if (!this.closed && this.committedAt !== null) {
      const latencyMs = Date.now() - this.committedAt
      if (this.heldText().trim()) this.utter(this.held, latencyMs)
      else this.options.onEmpty?.()
    }
    this.disconnect()
  }

  private utter(sentences: Sentence[], latencyMs: number | null) {
    const text = sentences.map((s) => s.text).join('')
    const begin = sentences[0].begin_time ?? 0
    const end = sentences.at(-1)!.end_time ?? begin
    this.options.onRecognized?.({ text, durationMs: Math.max(0, end - begin), latencyMs })
    this.callbacks.onUtterance?.(text)
  }

  private finishTask() {
    this.state = 'finishing'
    this.socket!.send(JSON.stringify({ header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' }, payload: { input: {} } }))
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.disconnect(), FINISH_TIMEOUT_MS)
  }

  private fail(error: Error, code = 'ConnectionFailed') {
    if (this.state === 'failed' || this.state === 'finished') return
    clearTimeout(this.timer)
    this.state = 'failed'
    const safeCode = /^[\w.-]{1,80}$/.test(code) ? code : 'TaskFailed'
    if (!this.closed) this.options.onFailure?.(safeCode, this.taskId)
    this.disconnect()
    if (!this.readySettled) this.settleReady(error)
    else if (!this.closed) this.callbacks.onFatalError?.(error)
  }

  // The service went away without finishing the task.
  private lost() {
    if (this.state === 'finished' || this.state === 'failed') return
    if (this.closed && this.state !== 'started') return
    this.fail(new Error('The speech recognition connection closed unexpectedly'), 'ConnectionClosed')
  }

  private disconnect() {
    clearTimeout(this.timer)
    const socket = this.socket
    if (!socket) return
    this.socket = null
    try {
      socket.close(1000, 'done')
    } catch {}
  }

  private heldText() {
    return this.held.map((s) => s.text).join('')
  }

  // The time since the session received the audio the sentence ends with.
  private latencyAt(endMs: number | null | undefined): number | null {
    if (typeof endMs !== 'number') return null
    const reached = this.timeline.find((entry) => entry.endMs >= endMs)
    this.timeline = this.timeline.filter((entry) => entry.endMs >= endMs)
    return reached ? Date.now() - reached.at : null
  }
}
