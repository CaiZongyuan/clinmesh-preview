import type { ClientMessage, ServerMessage } from '../../shared/agent-wire'
import type { EventLog, LoggedEvent } from './event-log'

const VIEWER = 'viewer'

// Survives hibernation with the socket: a viewer gets live events only after its replay.
interface ViewerAttachment {
  ready: boolean
}

// Hibernatable WebSockets for an agent's viewers: `hello { afterSeq }` replays the event log, then live events follow.
export class SocketHub {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly events: EventLog,
  ) {}

  accept(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [VIEWER])
    server.serializeAttachment({ ready: false } satisfies ViewerAttachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  onMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    let message: Partial<ClientMessage> | null
    try {
      message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as Partial<ClientMessage> | null
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null || message.type !== 'hello' || typeof message.afterSeq !== 'number') return
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
