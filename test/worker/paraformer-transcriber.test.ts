import type { TranscriberSessionOptions } from 'agents/voice'
import { describe, expect, it, vi } from 'vitest'
import type { CaptureMode } from '../../src/shared/voice'
import { ParaformerTranscriber, type RecognizedSpeech } from '../../src/worker/voice/paraformer-transcriber'
import { pcm, sentence, serviceEvent, type RunTask } from './support/fake-paraformer'

// The DashScope end of one recognition task, driven step by step by the test.
function fakeService() {
  const [client, service] = Object.values(new WebSocketPair())
  const received: (RunTask | number)[] = []
  service.accept()
  service.addEventListener('message', (event) =>
    received.push(typeof event.data === 'string' ? (JSON.parse(event.data) as RunTask) : (event.data as ArrayBuffer).byteLength),
  )
  let clientClosed = false
  client.addEventListener('close', () => (clientClosed = true))
  client.accept()
  const actions = () => received.filter((r): r is RunTask => typeof r !== 'number')
  const taskId = () => actions()[0].header.task_id
  return {
    client,
    received,
    actions,
    audio: () => received.filter((r): r is number => typeof r === 'number'),
    taskId,
    send: (event: string, s?: Record<string, unknown>) => service.send(JSON.stringify(serviceEvent(taskId(), event, s))),
    fail: (code: string, message: string) =>
      service.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId(), error_code: code, error_message: message } })),
    hangUp: () => service.close(1011, 'gone'),
    get clientClosed() {
      return clientClosed
    },
  }
}

type Event = [string, unknown?]

function open(mode: CaptureMode = 'continuous') {
  const service = fakeService()
  const events: Event[] = []
  const tokens: string[] = []
  const transcriber = new ParaformerTranscriber({
    token: 'test-bailian-token',
    connect: async (token) => {
      tokens.push(token)
      return service.client
    },
    mode,
    onRecognized: (speech: RecognizedSpeech) => events.push(['recognized', speech]),
    onEmpty: () => events.push(['empty']),
  })
  const callbacks: TranscriberSessionOptions = {
    onInterim: (text) => events.push(['interim', text]),
    onSpeechStart: () => events.push(['speech-start']),
    onUtterance: (text) => events.push(['utterance', text]),
    onFatalError: (error) => events.push(['fatal', error.message]),
  }
  const session = transcriber.createSession(callbacks)
  return { service, events, tokens, transcriber, session }
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 5 })

describe('ParaformerTranscriber (paraformer-realtime-v2 over the DashScope duplex WebSocket)', () => {
  it('sends run-task, holds audio until task-started, streams 16 kHz mono PCM, reports interim captions and each sentence_end, and ends with finish-task', async () => {
    const { service, events, tokens, session } = open()
    session.feed(pcm(100))
    session.feed(pcm(100))
    let ready = false
    void session.waitUntilReady!().then(() => (ready = true))

    await until(() => expect(service.actions()).toHaveLength(1))
    expect(tokens).toEqual(['test-bailian-token'])
    expect(service.actions()[0]).toEqual({
      header: { action: 'run-task', task_id: expect.stringMatching(/^[0-9a-f]{32}$/), streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'paraformer-realtime-v2',
        parameters: { format: 'pcm', sample_rate: 16000, language_hints: ['zh', 'en'] },
        input: {},
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.audio()).toEqual([])
    expect(ready).toBe(false)

    service.send('task-started')
    await until(() => expect(service.audio()).toEqual([3200, 3200]))
    expect(ready).toBe(true)
    session.feed(pcm(100))
    await until(() => expect(service.audio()).toEqual([3200, 3200, 3200]))

    service.send('result-generated', sentence('您哪里', false, 120))
    service.send('result-generated', { heartbeat: true, text: '' })
    service.send('result-generated', sentence('您哪里不舒', false, 120))
    service.send('result-generated', sentence('您哪里不舒服？', true, 120, 280))
    service.send('result-generated', sentence('发烧', false, 600))
    await until(() => expect(events.filter(([e]) => e === 'interim')).toHaveLength(3))
    expect(events).toEqual([
      ['speech-start'],
      ['interim', '您哪里'],
      ['interim', '您哪里不舒'],
      ['recognized', { text: '您哪里不舒服？', durationMs: 160, latencyMs: expect.any(Number) }],
      ['utterance', '您哪里不舒服？'],
      ['speech-start'],
      ['interim', '发烧'],
    ])

    session.close()
    await until(() => expect(service.actions()).toHaveLength(2))
    expect(service.actions()[1]).toEqual({
      header: { action: 'finish-task', task_id: service.taskId(), streaming: 'duplex' },
      payload: { input: {} },
    })
    // Closed: nothing more goes out, and late results are not reported.
    session.feed(pcm(100))
    service.send('result-generated', sentence('发烧几天了？', true, 600, 900))
    service.send('task-finished')
    await until(() => expect(service.clientClosed).toBe(true))
    expect(service.audio()).toHaveLength(3)
    expect(events.at(-1)).toEqual(['interim', '发烧'])
  })

  it('times latency from when the session had the sentence’s last audio', async () => {
    const { service, events, session } = open()
    service.client.addEventListener('message', () => {})
    await until(() => expect(service.actions()).toHaveLength(1))
    service.send('task-started')
    await session.waitUntilReady!()
    session.feed(pcm(500))
    await new Promise((resolve) => setTimeout(resolve, 120))
    service.send('result-generated', sentence('咳嗽吗？', true, 100, 480))
    await until(() => expect(events.some(([e]) => e === 'recognized')).toBe(true))
    const [, recognized] = events.find(([e]) => e === 'recognized')!
    expect((recognized as RecognizedSpeech).latencyMs).toBeGreaterThanOrEqual(100)
    expect((recognized as RecognizedSpeech).durationMs).toBe(380)
  })

  describe('push-to-talk', () => {
    it('reports everything said while holding as one utterance once the service finishes the task after commit', async () => {
      const { service, events, transcriber, session } = open('hold')
      await until(() => expect(service.actions()).toHaveLength(1))
      service.send('task-started')
      session.feed(pcm(100))
      service.send('result-generated', sentence('咳嗽', false, 200))
      service.send('result-generated', sentence('咳嗽有痰吗？', true, 200, 1400))
      service.send('result-generated', sentence('什么颜色', false, 1700))
      await until(() => expect(events).toContainEqual(['interim', '咳嗽有痰吗？什么颜色']))
      expect(events.some(([e]) => e === 'utterance')).toBe(false)

      transcriber.commit()
      await until(() => expect(service.actions().map((a) => a.header.action)).toEqual(['run-task', 'finish-task']))
      session.feed(pcm(100))
      service.send('result-generated', sentence('什么颜色的？', true, 1700, 2600))
      service.send('task-finished')
      await until(() => expect(events.some(([e]) => e === 'utterance')).toBe(true))
      expect(events.slice(-2)).toEqual([
        ['recognized', { text: '咳嗽有痰吗？什么颜色的？', durationMs: 2400, latencyMs: expect.any(Number) }],
        ['utterance', '咳嗽有痰吗？什么颜色的？'],
      ])
      expect(service.audio()).toEqual([3200])
      await until(() => expect(service.clientClosed).toBe(true))
    })

    it('waits for task-started before finishing a capture committed early, and says when nothing was recognized', async () => {
      const { service, events, transcriber, session } = open('hold')
      session.feed(pcm(200))
      transcriber.commit()
      await until(() => expect(service.actions()).toHaveLength(1))
      service.send('task-started')
      await until(() => expect(service.actions().map((a) => a.header.action)).toEqual(['run-task', 'finish-task']))
      expect(service.audio()).toEqual([6400])
      service.send('task-finished')
      await until(() => expect(events).toEqual([['empty']]))
    })

    it('reports nothing for a capture closed without commit (cancelled or too short)', async () => {
      const { service, events, session } = open('hold')
      await until(() => expect(service.actions()).toHaveLength(1))
      service.send('task-started')
      service.send('result-generated', sentence('不用了', true, 0, 600))
      session.close()
      await until(() => expect(service.actions().map((a) => a.header.action)).toEqual(['run-task', 'finish-task']))
      service.send('task-finished')
      await until(() => expect(service.clientClosed).toBe(true))
      expect(events.filter(([e]) => e === 'utterance' || e === 'recognized' || e === 'empty')).toEqual([])
    })
  })

  describe('failures', () => {
    it('fails startup when the task fails before task-started', async () => {
      const { service, session } = open()
      await until(() => expect(service.actions()).toHaveLength(1))
      service.fail('InvalidApiKey', 'Invalid API-key provided.')
      await expect(session.waitUntilReady!()).rejects.toThrow('InvalidApiKey: Invalid API-key provided.')
    })

    it('fails startup when the service cannot be reached', async () => {
      const session = new ParaformerTranscriber({
        token: 't',
        connect: () => Promise.reject(new Error('DashScope refused the speech recognition socket (HTTP 401)')),
        mode: 'continuous',
      }).createSession()
      await expect(session.waitUntilReady!()).rejects.toThrow('HTTP 401')
    })

    it('reports a fatal error when the task fails or the connection drops mid-call', async () => {
      const failing = open()
      await until(() => expect(failing.service.actions()).toHaveLength(1))
      failing.service.send('task-started')
      await failing.session.waitUntilReady!()
      failing.service.fail('ResponseTimeout', 'no audio')
      await until(() => expect(failing.events).toEqual([['fatal', 'ResponseTimeout: no audio']]))

      const dropped = open()
      await until(() => expect(dropped.service.actions()).toHaveLength(1))
      dropped.service.send('task-started')
      await dropped.session.waitUntilReady!()
      dropped.service.hangUp()
      await until(() => expect(dropped.events).toEqual([['fatal', 'The speech recognition connection closed unexpectedly']]))
    })
  })
})
