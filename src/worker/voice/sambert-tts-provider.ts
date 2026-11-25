import type { TTSProvider } from 'agents/voice'
import { connectDashScope, type ConnectUpstream } from './paraformer-transcriber'

export const SAMBERT_MODEL = 'sambert-zhida-v1'
const TASK_TIMEOUT_MS = 25_000

export class SambertTTSProvider implements TTSProvider {
  constructor(private readonly options: { token: string; connect?: ConnectUpstream }) {}

  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise((resolve) => {
      let socket: WebSocket | undefined
      let finished = false
      const chunks: ArrayBuffer[] = []
      const taskId = crypto.randomUUID().replaceAll('-', '')
      const timeout = setTimeout(() => finish(null), TASK_TIMEOUT_MS)
      const abort = () => finish(null)
      const finish = (wav: ArrayBuffer | null) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        socket?.close()
        resolve(wav)
      }
      signal?.addEventListener('abort', abort, { once: true })

      const connect = this.options.connect ?? connectDashScope
      void connect(this.options.token).then((connected) => {
        if (finished) {
          connected.close()
          return
        }
        socket = connected
        connected.binaryType = 'arraybuffer'
        connected.addEventListener('close', abort)
        connected.addEventListener('error', abort)
        connected.addEventListener('message', (event) => {
          if (finished) return
          if (event.data instanceof ArrayBuffer) {
            chunks.push(event.data)
            return
          }
          if (typeof event.data !== 'string') return
          let header: { event?: string; task_id?: string } | undefined
          try {
            header = (JSON.parse(event.data) as { header?: typeof header }).header
          } catch {
            return
          }
          if (header?.task_id !== taskId) return
          if (header.event === 'task-finished') finish(repairFinishedWav(concat(chunks)))
          else if (header.event === 'task-failed') finish(null)
        })
        // Sambert accepts one run-task with the complete text. It rejects finish-task.
        connected.send(JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'out' },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: SAMBERT_MODEL,
            parameters: { text_type: 'PlainText', format: 'wav', sample_rate: 16_000, volume: 50, rate: 1, pitch: 1 },
            input: { text },
          },
        }))
      }).catch(abort)
    })
  }
}

// DashScope's streamed RIFF and data sizes are placeholders until task-finished.
export function repairFinishedWav(buffer: ArrayBuffer): ArrayBuffer | null {
  if (buffer.byteLength <= 44) return null
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  const view = new DataView(buffer)
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    if (tag(offset) === 'data') {
      view.setUint32(4, buffer.byteLength - 8, true)
      view.setUint32(offset + 4, buffer.byteLength - offset - 8, true)
      return buffer
    }
    const size = view.getUint32(offset + 4, true)
    offset += 8 + size + (size % 2)
  }
  return null
}

function concat(chunks: ArrayBuffer[]): ArrayBuffer {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }
  return out.buffer
}
