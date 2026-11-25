import { describe, expect, it, vi } from 'vitest'
import { SambertTTSProvider, repairFinishedWav } from '../../src/worker/voice/sambert-tts-provider'
import type { RunTask } from './support/fake-paraformer'

// `wireBytes` over a WebSocketPair inside one isolate: binary frames arrive as a Blob, so the byte count lives in `size`.
const wireBytes = (data: unknown) => (typeof data === 'string' ? 0 : ((data as Blob).size ?? 0))

// A WAV with DashScope's streamed sentinel lengths (RIFF 0x7fffffbf, data 0x7fffff9b) and `payload` bytes of audio.
const sentinelWav = (payloadBytes = 8): ArrayBuffer => {
  const bytes = new Uint8Array(44 + payloadBytes)
  const view = new DataView(bytes.buffer)
  'RIFF'.split('').forEach((s, i) => (bytes[i] = s.charCodeAt(0)))
  view.setUint32(4, 0x7fffffbf, true)
  'WAVEfmt '.split('').forEach((s, i) => (bytes[8 + i] = s.charCodeAt(0)))
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  'data'.split('').forEach((s, i) => (bytes[36 + i] = s.charCodeAt(0)))
  view.setUint32(40, 0x7fffff9b, true)
  bytes.fill(7, 44)
  return bytes.buffer
}

interface FakeService {
  client: WebSocket
  actions(): RunTask[]
  audio(): number[]
  finished: boolean
  clientClosed: boolean
  taskId(): string
  send(event: string): void
  sendAudio(buffer: ArrayBuffer): void
  fail(code: string, message: string): void
}

// The DashScope end of one synthesis task, driven step by step by the test.
function fakeService(): FakeService {
  const [client, service] = Object.values(new WebSocketPair())
  const received: (RunTask | number)[] = []
  let finished = false
  let clientClosed = false
  client.addEventListener('close', () => { clientClosed = true })
  service.accept()
  service.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      received.push(wireBytes(event.data))
      return
    }
    const action = JSON.parse(event.data) as RunTask
    if (action.header.action === 'finish-task') finished = true
    received.push(action)
  })
  client.accept()
  const actions = () => received.filter((r): r is RunTask => typeof r !== 'number')
  const taskId = () => actions()[0].header.task_id
  return {
    client,
    actions,
    audio: () => received.filter((r): r is number => typeof r === 'number'),
    get finished() {
      return finished
    },
    get clientClosed() {
      return clientClosed
    },
    taskId,
    send: (event) => service.send(JSON.stringify({ header: { event, task_id: taskId() } })),
    sendAudio: (buffer) => service.send(buffer),
    fail: (code, message) =>
      service.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId(), error_code: code, error_message: message } })),
  }
}

function open() {
  const service = fakeService()
  const tokens: string[] = []
  const provider = new SambertTTSProvider({
    token: 'test-bailian-token',
    connect: async (token) => {
      tokens.push(token)
      return service.client
    },
  })
  return { service, tokens, provider }
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 5 })

describe('SambertTTSProvider (sambert over the DashScope one-way streaming WebSocket)', () => {
  it('sends one-shot run-task with the whole text, never finish-task, and returns the repaired WAV on task-finished', async () => {
    const { service, tokens, provider } = open()
    const pending = provider.synthesize('您最近有发烧吗？')

    await until(() => expect(service.actions()).toHaveLength(1))
    expect(tokens).toEqual(['test-bailian-token'])
    expect(service.actions()[0]).toEqual({
      header: { action: 'run-task', task_id: expect.stringMatching(/^[0-9a-f]{32}$/), streaming: 'out' },
      payload: {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: 'sambert-zhida-v1',
        parameters: {
          text_type: 'PlainText',
          format: 'wav',
          sample_rate: 16_000,
          volume: 50,
          rate: 1,
          pitch: 1,
        },
        input: { text: '您最近有发烧吗？' },
      },
    })

    service.send('task-started')
    service.sendAudio(sentinelWav(8))
    service.send('task-finished')

    const wav = await pending
    expect(wav).not.toBeNull()
    // The sentinel lengths are rewritten to the real total lengths, so players can read the file.
    const view = new DataView(wav!)
    expect(view.getUint32(4, true)).toBe(wav!.byteLength - 8)
    expect(view.getUint32(40, true)).toBe(wav!.byteLength - 44)
    expect(new TextDecoder().decode(new Uint8Array(wav!, 36, 4))).toBe('data')
    // Sambert rejects finish-task: one action only, ever.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.actions()).toHaveLength(1)
    expect(service.finished).toBe(false)
  })

  it('repairs the streamed sentinels in repairFinishedWav', () => {
    const wav = repairFinishedWav(sentinelWav(12))
    const view = new DataView(wav!)
    expect(view.getUint32(4, true)).toBe(wav!.byteLength - 8)
    expect(view.getUint32(40, true)).toBe(wav!.byteLength - 44)
  })

  it('resolves null on task-failed and closes the socket', async () => {
    const { service, provider } = open()
    const pending = provider.synthesize('您最近有发烧吗？')
    await until(() => expect(service.actions()).toHaveLength(1))
    service.send('task-started')
    service.fail('InvalidApiKey', 'bad token')
    await expect(pending).resolves.toBeNull()
    await until(() => expect(service.clientClosed).toBe(true))
  })

  it('returns on cancellation while the handshake is pending and discards any late socket', async () => {
    const service = fakeService()
    let connected!: (socket: WebSocket) => void
    const provider = new SambertTTSProvider({
      token: 'test-bailian-token',
      connect: () => new Promise<WebSocket>((resolve) => { connected = resolve }),
    })
    const controller = new AbortController()
    const task = provider.synthesize('您最近有发烧吗？', controller.signal)
    controller.abort()

    try {
      const state = await Promise.race([task, Promise.resolve().then(() => Promise.resolve('pending'))])
      expect(state).toBeNull()
    } finally {
      connected(service.client)
      if (!service.clientClosed) service.client.close()
    }
    await expect(task).resolves.toBeNull()
    expect(service.actions()).toHaveLength(0)
  })

  it('supports AbortSignal cancellation: aborting drops the task, sends nothing further and resolves null', async () => {
    const { service, provider } = open()
    const controller = new AbortController()
    const pending = provider.synthesize('您最近有发烧吗？', controller.signal)
    await until(() => expect(service.actions()).toHaveLength(1))
    controller.abort()
    await expect(pending).resolves.toBeNull()
    await until(() => expect(service.clientClosed).toBe(true))
    // Aborting mid-task sends no finish-task either; the task is simply dropped.
    expect(service.actions()).toHaveLength(1)
  })
})
