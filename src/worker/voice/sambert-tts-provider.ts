import type { TTSProvider } from 'agents/voice'
import { connectDashScope } from './paraformer-transcriber'

export const SAMBERT_MODEL = 'sambert'
export const SAMBERT_VOICE = 'zhitian'

// The `agents/voice` TTSProvider for Bailian Sambert (ADR-0003). One DashScope task per reply chunk: the whole
// text goes out in a single `run-task` with `streaming: "out"`, binary frames stream back, and the task ends by
// itself with `task-finished` — Sambert rejects `continue-task`/`finish-task`, so none is ever sent.
// DashScope streams the WAV with sentinel lengths in the header (RIFF 0x7fffffbf, data 0x7fffff9b); after
// `task-finished` they are rewritten to the real total lengths, otherwise players cannot read the file.
export class SambertTTSProvider implements TTSProvider {
  constructor(
    private readonly options: { token: string; connect?: typeof connectDashScope; sampleRate?: number },
  ) {}

  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    return new SambertTask(this.options, text, signal).run()
  }
}

type TaskState = 'connecting' | 'started' | 'finished' | 'failed'

const START_TIMEOUT_MS = 10_000

// Rewrites the WAV header's RIFF and `data` chunk sizes from the streamed sentinels to the real total length.
export function repairFinishedWav(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer)
  view.setUint32(4, buffer.byteLength - 8, true)
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(buffer, offset, 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      view.setUint32(offset + 4, buffer.byteLength - offset - 8, true)
      return buffer
    }
    offset += 8 + size + (size % 2)
  }
  return buffer
}

class SambertTask {
  private socket: WebSocket | null = null
  private state: TaskState = 'connecting'
  private readonly chunks: ArrayBuffer[] = []
  private readonly taskId = crypto.randomUUID().replaceAll('-', '')
  private timer: ReturnType<typeof setTimeout> | null = null
  private settle: ((wav: ArrayBuffer | null) => void) | null = null

  constructor(
    private readonly options: { token: string; connect?: typeof connectDashScope; sampleRate?: number },
    private readonly text: string,
    private readonly signal?: AbortSignal,
  ) {}

  async run(): Promise<ArrayBuffer | null> {
    const done = new Promise<ArrayBuffer | null>((resolve) => (this.settle = resolve))
    this.signal?.addEventListener('abort', () => this.finish(null), { once: true })
    try {
      this.socket = await (this.options.connect ?? connectDashScope)(this.options.token)
    } catch {
      this.finish(null)
      return done
    }
    this.timer = setTimeout(() => this.finish(null), START_TIMEOUT_MS)
    this.socket.addEventListener('message', (event: MessageEvent) => this.receive(event))
    this.socket.addEventListener('close', () => this.finish(null))
    this.socket.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: this.taskId, streaming: 'out' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: SAMBERT_MODEL,
          parameters: {
            text_type: 'PlainText',
            format: 'wav',
            sample_rate: this.options.sampleRate ?? 16_000,
            voice: SAMBERT_VOICE,
            volume: 50,
            rate: 1,
            pitch: 1,
          },
          input: { text: this.text },
        },
      }),
    )
    return done
  }

  private async receive(event: MessageEvent): Promise<void> {
    if (this.state === 'finished' || this.state === 'failed') return
    if (typeof event.data !== 'string') {
      // Over a WebSocketPair inside one isolate, binary frames arrive as Blobs.
      const bytes = event.data instanceof ArrayBuffer ? event.data : await (event.data as Blob).arrayBuffer()
      this.chunks.push(bytes)
      return
    }
    let header: { header?: { event?: string; error_message?: string } }
    try {
      header = JSON.parse(event.data) as typeof header
    } catch {
      return
    }
    if (header.header?.event === 'task-started') {
      this.state = 'started'
    } else if (header.header?.event === 'task-finished') {
      const wav = repairFinishedWav(concat(this.chunks))
      this.state = 'finished'
      this.finish(wav.byteLength > 44 ? wav : null)
    } else if (header.header?.event === 'task-failed') {
      this.state = 'failed'
      this.finish(null)
    }
  }

  private finish(wav: ArrayBuffer | null): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.socket && this.state !== 'finished') {
      // Aborted or failed mid-task: just drop the socket; Sambert ends unfinished tasks itself.
      try {
        this.socket.close()
      } catch {}
    }
    this.socket = null
    this.settle?.(wav)
  }
}

function concat(chunks: ArrayBuffer[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }
  return out.buffer
}
