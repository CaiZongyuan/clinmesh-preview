import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { bailianVoiceEndpoint, DASHSCOPE_INFERENCE_URL } from '../../src/shared/voice'
import { startDevProviderProxy } from '../../scripts/dev-provider-proxy'

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  return address.port
}

afterEach(() => vi.unstubAllEnvs())

it('streams both agent endpoints and tunnels the DashScope upgrade and binary data through the host proxy', async () => {
  const requests: Array<[string | undefined, string | undefined]> = []
  let finishReply: (() => void) | undefined
  const upstream = createServer((req, res) => {
    requests.push([req.url, req.headers.authorization])
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: first\n\n')
    finishReply = () => res.end('data: [DONE]\n\n')
  })
  let forwardedWorkerHeader: string | string[] | undefined
  let workspaceHeader: string | string[] | undefined
  const voice = new WebSocketServer({ server: upstream })
  voice.on('connection', (socket, req) => {
    forwardedWorkerHeader = req.headers['cf-worker']
    workspaceHeader = req.headers['x-dashscope-workspace']
    requests.push([req.url, req.headers.authorization])
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
  })
  const providerPort = await listen(upstream)
  const gateway = createServer()
  const tunnels: string[] = []
  gateway.on('connect', (req, client, head) => {
    tunnels.push(req.url ?? '')
    const provider = connect(providerPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) provider.write(head)
      client.pipe(provider).pipe(client)
    })
    client.on('close', () => provider.destroy())
    provider.on('error', () => client.destroy())
  })
  const proxyPort = await listen(gateway)
  vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`)
  vi.stubEnv('no_proxy', 'localhost,127.0.0.1')
  const relay = await startDevProviderProxy({
    BAILIAN_WORKSPACE_ID: 'llm-test-space',
    LLM_BASE_URL: 'http://common.invalid/v1',
    COPILOT_LLM_BASE_URL: 'http://copilot.invalid/custom',
  }, 'http://voice.invalid/api-ws/v1/inference')
  try {
    if (!relay) throw new Error('Expected a local provider proxy')
    for (const kind of ['patient', 'copilot']) {
      const response = await fetch(`${relay.origin}/${kind}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${kind}-test` }, body: '{}',
      })
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      expect((await reader.read()).value).toBe('data: first\n\n')
      finishReply!()
      expect((await reader.read()).value).toBe('data: [DONE]\n\n')
    }

    const socket = new WebSocket(relay.origin.replace('http:', 'ws:') + '/voice', {
      headers: { Authorization: 'Bearer voice-test', 'cf-worker': 'local-clinic' },
    })
    await once(socket, 'open')
    const control = once(socket, 'message')
    socket.send('run-task')
    const [text, binary] = await control
    expect([text.toString(), binary]).toEqual(['run-task', false])
    const echoed = once(socket, 'message')
    const audio = Buffer.from([0, 1, 127, 128, 255])
    socket.send(audio)
    expect(await echoed).toEqual([audio, true])
    socket.close()
    expect(requests).toEqual([
      ['/v1/chat/completions', 'Bearer patient-test'], ['/custom/chat/completions', 'Bearer copilot-test'],
      ['/api-ws/v1/inference', 'Bearer voice-test'],
    ])
    expect(forwardedWorkerHeader).toBeUndefined()
    expect(workspaceHeader).toBe('llm-test-space')
    expect(tunnels).toEqual(['common.invalid:80', 'copilot.invalid:80', 'voice.invalid:80'])
  } finally {
    relay?.close()
    voice.close()
    gateway.close()
    upstream.close()
  }
})

it('uses the Beijing workspace inference host for a configured workspace and the public host otherwise', () => {
  expect(bailianVoiceEndpoint({ BAILIAN_WORKSPACE_ID: 'llm-test-space' })).toEqual({
    url: 'https://llm-test-space.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference', workspace: 'llm-test-space',
  })
  expect(bailianVoiceEndpoint({}).url).toBe(DASHSCOPE_INFERENCE_URL)
  expect(() => bailianVoiceEndpoint({ BAILIAN_WORKSPACE_ID: 'name.invalid/' })).toThrow('BAILIAN_WORKSPACE_ID')
})

it('keeps a direct connection when the configured providers match NO_PROXY', async () => {
  vi.stubEnv('http_proxy', 'http://127.0.0.1:1')
  vi.stubEnv('no_proxy', 'patient.invalid,voice.invalid')
  const relay = await startDevProviderProxy({ LLM_BASE_URL: 'http://patient.invalid' }, 'http://voice.invalid/inference')
  try { expect(relay).toBeUndefined() } finally { relay?.close() }
})
