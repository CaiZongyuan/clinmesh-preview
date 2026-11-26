import { installScriptedParaformer } from '../../../src/worker/voice/voice-config'

export const BYTES_PER_MS = 32

// `ms` of 16 kHz mono PCM16 silence.
export const pcm = (ms: number) => new Uint8Array(ms * BYTES_PER_MS).buffer

// Over a WebSocketPair inside one isolate, binary frames arrive as a Blob, so the byte count lives in `size`.
export const wireBytes = (data: unknown) => (typeof data === 'string' ? 0 : ((data as Blob).size ?? 0))

export interface ServiceEvent {
  header: { event: string; task_id?: string; error_code?: string; error_message?: string; attributes?: object }
  payload?: { output?: { sentence: Record<string, unknown> } }
}

export const serviceEvent = (taskId: string, event: string, sentence?: Record<string, unknown>): ServiceEvent => ({
  header: { event, task_id: taskId, attributes: {} },
  ...(sentence ? { payload: { output: { sentence } } } : {}),
})

export const sentence = (text: string, sentenceEnd: boolean, beginTime = 0, endTime: number | null = null) => ({
  begin_time: beginTime,
  end_time: endTime,
  text,
  sentence_end: sentenceEnd,
  words: [],
})

// A DashScope client event the fake service received.
export interface RunTask {
  header: { action: string; task_id: string; streaming: string }
  payload: { task_group: string; task: string; function: string; model: string; parameters: Record<string, unknown>; input: object }
}

// What one recognition task saw: the client events, how much audio arrived before and after `task-started`,
// and whether the client finished the task.
export interface TaskRecord {
  token: string
  actions: RunTask[]
  audioBeforeStart: number
  audioBytes: number
  audioAfterFinish: number
  finished: boolean
}

// A sentence the fake service recognizes once it has received `atMs` of audio; it streams `partials` first.
export interface ScriptedSentence {
  atMs: number
  text: string
  partials?: string[]
  beginMs?: number
}

export interface FakeParaformerScript {
  sentences?: ScriptedSentence[]
  startDelayMs?: number
  // Fail every task with this error instead of starting it.
  failStart?: string
  failAfterStart?: string
}

// The Bailian Paraformer realtime service for Worker-seam tests, installed behind the ParaformerTranscriber. It runs
// inside the voice agent's Durable Object and reacts to what the client sends (a test can't drive a socket that
// belongs to another request), so each task follows the script. Tests read `tasks`, polling.
export function installFakeParaformer(script: FakeParaformerScript = {}): { tasks: TaskRecord[] } {
  const tasks: TaskRecord[] = []
  installScriptedParaformer(async (token) => {
    const [client, service] = Object.values(new WebSocketPair())
    const record: TaskRecord = { token, actions: [], audioBeforeStart: 0, audioBytes: 0, audioAfterFinish: 0, finished: false }
    tasks.push(record)
    const pending = [...(script.sentences ?? [])]
    let taskId = ''
    let started = false
    const emit = (event: string, s?: Record<string, unknown>) => service.send(JSON.stringify(serviceEvent(taskId, event, s)))

    service.accept()
    service.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        const bytes = wireBytes(event.data)
        if (record.finished) record.audioAfterFinish += bytes
        else if (!started) record.audioBeforeStart += bytes
        record.audioBytes += bytes
        while (pending.length && record.audioBytes >= pending[0].atMs * BYTES_PER_MS) {
          const next = pending.shift()!
          const begin = next.beginMs ?? 0
          for (const partial of next.partials ?? []) emit('result-generated', sentence(partial, false, begin))
          emit('result-generated', { heartbeat: true, text: '' })
          emit('result-generated', sentence(next.text, true, begin, next.atMs))
        }
        return
      }
      const action = JSON.parse(event.data) as RunTask
      record.actions.push(action)
      if (action.header.action === 'run-task') {
        taskId = action.header.task_id
        setTimeout(() => {
          if (script.failStart) {
            service.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId, error_code: 'InvalidApiKey', error_message: script.failStart } }))
            return
          }
          started = true
          emit('task-started')
          if (script.failAfterStart) setTimeout(() => service.send(JSON.stringify({
            header: { event: 'task-failed', task_id: taskId, error_code: script.failAfterStart, error_message: 'Provider detail' },
          })), 10)
        }, script.startDelayMs ?? 30)
      } else if (action.header.action === 'finish-task') {
        record.finished = true
        setTimeout(() => emit('task-finished'), 10)
      }
    })
    client.accept()
    return client
  })
  return { tasks }
}
