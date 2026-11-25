import type { ClientMessage, ServerMessage } from '../../shared/agent-wire'
import type { EventLog, LoggedEvent } from './event-log'

const VIEWER = 'viewer'
const BRIDGE = 'bridge'

// Survives hibernation with the socket: a viewer gets live events only after its replay.
interface ViewerAttachment {
  ready: boolean
}

// What a bridged ui tool call came back as: the plain tool result string, plus how the browser classified
// it (`suggestion` = became a Suggestion, `denied` = refused control).
export interface BridgeResult {
  ok: boolean
  result: string
  outcome?: 'suggestion' | 'denied'
}

const BRIDGE_CALL_TIMEOUT_MS = 10_000

// Hibernatable WebSockets for an agent: viewers replay the event log via `hello { afterSeq }` and then follow
// live; the single bridge socket (latest wins) answers `bridge.call` from the agent's ui tools.
export class SocketHub {
  private readonly pending = new Map<string, { socket: WebSocket; finish: (result: BridgeResult) => void }>()

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly events: EventLog,
    // Called when a bridge socket joins, so the host can wake work that was waiting for the bridge.
    private readonly onBridgeConnected: () => void = () => {},
  ) {}

  accept(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    const bridge = new URL(request.url).pathname.endsWith('/bridge')
    const { 0: client, 1: server } = new WebSocketPair()
    if (bridge) {
      for (const existing of this.ctx.getWebSockets(BRIDGE)) {
        this.onClose(existing, 1000, 'Bridge replaced')
      }
    }
    this.ctx.acceptWebSocket(server, [bridge ? BRIDGE : VIEWER])
    server.serializeAttachment({ ready: !bridge } satisfies ViewerAttachment)
    if (bridge) this.onBridgeConnected()
    return new Response(null, { status: 101, webSocket: client })
  }

  private bridge(): WebSocket | undefined {
    return this.ctx.getWebSockets(BRIDGE).find((socket) => socket.readyState === WebSocket.OPEN)
  }

  bridgeConnected(): boolean {
    return Boolean(this.bridge())
  }

  callBridge(tool: 'ui_snapshot' | 'ui_act', args: unknown, signal: AbortSignal): Promise<BridgeResult> {
    const socket = this.bridge()
    if (!socket) return Promise.resolve({ ok: false, result: '助手界面未连接，请稍后重试或直接给出文字回答。' })
    if (signal.aborted) return Promise.resolve({ ok: false, result: '未执行：本轮已结束。' })

    const callId = crypto.randomUUID()
    return new Promise<BridgeResult>((resolve) => {
      const finish = (result: BridgeResult) => {
        this.pending.delete(callId)
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = () => finish({ ok: false, result: '未执行：本轮已结束。' })
      const timer = setTimeout(() => finish({
        ok: false, result: '助手界面未在时限内响应（结果未知），请重新读取界面快照后再试。',
      }), BRIDGE_CALL_TIMEOUT_MS)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(callId, { socket, finish })
      send(socket, { type: 'bridge.call', callId, tool, args })
    })
  }

  onMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    let message: ClientMessage | null
    try {
      message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as ClientMessage
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    if (message.type === 'bridge.result') {
      if (typeof message.callId !== 'string' || typeof message.ok !== 'boolean' ||
        typeof message.result !== 'string' || message.result.length > 48_000 ||
        (message.outcome !== undefined && message.outcome !== 'suggestion' && message.outcome !== 'denied')) return
      const request = this.pending.get(message.callId)
      if (request?.socket === ws) request.finish({ ok: message.ok, result: message.result, outcome: message.outcome })
      return
    }
    if (message.type !== 'hello' || typeof message.afterSeq !== 'number') return
    const latest = this.events.latestSeq()
    if (message.afterSeq > latest) {
      send(ws, { type: 'resync' })
      return
    }
    for (const { seq, event } of this.events.after(message.afterSeq)) send(ws, { type: 'event', seq, event })
    send(ws, { type: 'replay.done', seq: latest })
    ws.serializeAttachment({ ready: true } satisfies ViewerAttachment)
  }

  onClose(ws: WebSocket, code: number, reason: string): void {
    for (const request of this.pending.values()) {
      if (request.socket === ws) request.finish({ ok: false, result: '助手界面连接已关闭，请重新读取快照。' })
    }
    try {
      ws.close(code, reason)
    } catch {}
  }

  broadcast({ seq, event }: LoggedEvent): void {
    for (const ws of this.ctx.getWebSockets(VIEWER)) {
      if ((ws.deserializeAttachment() as ViewerAttachment | null)?.ready) send(ws, { type: 'event', seq, event })
    }
  }
}

function send(ws: WebSocket, message: ServerMessage) {
  try {
    ws.send(JSON.stringify(message))
  } catch {}
}
