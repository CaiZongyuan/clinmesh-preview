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
  private readonly pending = new Map<string, { resolve: (result: BridgeResult) => void; timer: ReturnType<typeof setTimeout> }>()

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
    this.ctx.acceptWebSocket(server, [bridge ? BRIDGE : VIEWER])
    server.serializeAttachment({ ready: !bridge } satisfies ViewerAttachment)
    if (bridge) this.onBridgeConnected()
    return new Response(null, { status: 101, webSocket: client })
  }

  // Whether a bridge is connected: a ui tool without one answers at once instead of holding the run.
  bridgeConnected(): boolean {
    return this.ctx.getWebSockets(BRIDGE).length > 0
  }

  // Sends one ui tool call to the bridge and waits for its `bridge.result`; a missing or silent bridge fails
  // the call within the timeout so the run never hangs on the browser.
  callBridge(tool: 'ui_snapshot' | 'ui_act', args: unknown, signal: AbortSignal): Promise<BridgeResult> {
    if (!this.bridgeConnected()) {
      return Promise.resolve({ ok: false, result: '助手界面未连接，请稍后重试或直接给出文字回答。' })
    }
    const callId = crypto.randomUUID()
    return new Promise<BridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        resolve({ ok: false, result: '助手界面未在时限内响应（结果未知），请重新读取界面快照后再试。' })
      }, Math.min(BRIDGE_CALL_TIMEOUT_MS, 9_500))
      if (signal.aborted) {
        clearTimeout(timer)
        resolve({ ok: false, result: '未执行：本轮已结束。' })
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(callId)
        resolve({ ok: false, result: '未执行：本轮已结束。' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(callId, {
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          resolve(result)
        },
        timer,
      })
      for (const ws of this.ctx.getWebSockets(BRIDGE)) {
        send(ws, { type: 'bridge.call', callId, tool, args } satisfies ServerMessage)
      }
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
      if (typeof message.callId !== 'string') return
      this.pending.get(message.callId)?.resolve({ ok: message.ok, result: message.result, outcome: message.outcome })
      this.pending.delete(message.callId)
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
