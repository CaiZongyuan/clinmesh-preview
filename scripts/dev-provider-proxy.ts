import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { pipeline } from 'node:stream/promises'
import { EnvHttpProxyAgent, request, WebSocket as ProviderSocket } from 'undici'
import { WebSocket, WebSocketServer } from 'ws'
import { getProxyForUrl } from 'proxy-from-env'
import { resolveLlmConfig, type LlmEnv } from '../src/worker/llm/config'
import { bailianVoiceEndpoint } from '../src/shared/voice'

export async function startDevProviderProxy(env: LlmEnv, voiceUrl = bailianVoiceEndpoint(env).url) {
  const destinations = new Map<string, string>([['/voice', voiceUrl]])
  for (const kind of ['patient', 'copilot'] as const) {
    const config = resolveLlmConfig(env, kind)
    if (config.baseUrl && config.provider === 'openai-compatible') {
      destinations.set(`/${kind}/chat/completions`, `${config.baseUrl}/chat/completions`)
    }
  }
  if (![...destinations.values()].some((url) => getProxyForUrl(url))) return

  const dispatcher = new EnvHttpProxyAgent()
  const { workspace } = bailianVoiceEndpoint(env)
  const voiceServer = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const voiceEndpoint = new URL(voiceUrl)
  voiceEndpoint.protocol = voiceEndpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  const server = createServer(async (req, res) => {
    const target = destinations.get(req.url ?? '')
    const authorization = req.headers.authorization
    if (!target || req.url === '/voice' || req.method !== 'POST' || !authorization) {
      res.writeHead(404).end()
      return
    }
    const controller = new AbortController()
    res.once('close', () => { if (!res.writableFinished) controller.abort() })
    try {
      const upstream = await request(target, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: req, dispatcher, signal: controller.signal,
      })
      const type = upstream.headers['content-type']
      res.writeHead(upstream.statusCode, { 'content-type': typeof type === 'string' ? type : 'application/json' })
      await pipeline(upstream.body, res)
    } catch {
      if (res.headersSent) res.destroy()
      else if (!res.destroyed) res.writeHead(502).end('Model provider connection failed')
    }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/voice' || !req.headers.authorization) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = new ProviderSocket(voiceEndpoint, {
      headers: { Authorization: req.headers.authorization, ...(workspace && { 'X-DashScope-WorkSpace': workspace }) }, dispatcher,
    })
    socket.once('error', () => socket.destroy())
    const closeUpstream = () => {
      if (upstream.readyState < ProviderSocket.CLOSING) upstream.close()
    }
    socket.once('close', closeUpstream)
    let downstream: WebSocket | undefined
    upstream.binaryType = 'arraybuffer'
    upstream.addEventListener('error', () => socket.destroy())
    upstream.addEventListener('close', ({ wasClean }) => {
      if (downstream?.readyState === WebSocket.OPEN) downstream.close(wasClean ? 1000 : 1011)
      else socket.destroy()
    })
    upstream.addEventListener('open', () => {
      if (socket.destroyed) return closeUpstream()
      voiceServer.handleUpgrade(req, socket, head, (client) => {
        downstream = client
        client.on('error', closeUpstream)
        client.on('close', closeUpstream)
        client.on('message', (data, binary) => {
          if (upstream.readyState !== ProviderSocket.OPEN) return
          const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
          upstream.send(binary ? bytes : bytes.toString('utf8'))
        })
        upstream.addEventListener('message', ({ data }) => {
          if (client.readyState === WebSocket.OPEN) client.send(data)
        })
      })
    }, { once: true })
  })
  const connections = new Set<Socket>()
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing provider proxy address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      server.close()
      voiceServer.close()
      for (const connection of connections) connection.destroy()
      void dispatcher.destroy()
    },
  }
}
