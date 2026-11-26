import type { ClientMessage, ServerMessage } from '../../../../src/shared/agent-wire'
import {
  createAgentStreamState,
  reduceAgentServerMessage,
  type AgentStreamState,
  type StreamPatchMap,
} from '../../../../src/shared/agent-stream-reducer'

// Minimal WeChat MiniProgram SocketTask surface required for S0/S6 agent streaming.
export interface MiniProgramSocketTask {
  send(options: { data: string }): void
  close(options?: { code?: number; reason?: string }): void
  onOpen(callback: () => void): void
  onMessage(callback: (res: { data: string | ArrayBuffer }) => void): void
  onClose(callback: () => void): void
  onError(callback: (err: unknown) => void): void
}

export interface AgentTransportOptions {
  url: string
  token: string
  prefix?: string
  connectSocket: (options: { url: string; header: Record<string, string> }) => MiniProgramSocketTask
  onPatches: (patches: StreamPatchMap, state: AgentStreamState) => void
  onResyncRequired?: () => void
  onConnectionChange?: (connected: boolean) => void
}

// Native wx.connectSocket transport over ClinMesh's existing agent-wire protocol (replaces CloudBase AG-UI SDK).
export class NativeAgentStreamTransport {
  private state: AgentStreamState
  private socket: MiniProgramSocketTask | null = null
  private closed = false

  constructor(private readonly options: AgentTransportOptions, initialSeq = 0) {
    this.state = createAgentStreamState(initialSeq)
  }

  getState(): AgentStreamState {
    return this.state
  }

  connect(): void {
    this.closed = false
    this.disconnectSocket()
    const socket = this.options.connectSocket({
      url: this.options.url,
      header: { Authorization: `Bearer ${this.options.token}` },
    })
    this.socket = socket

    socket.onOpen(() => {
      this.options.onConnectionChange?.(true)
      const hello: ClientMessage = { type: 'hello', afterSeq: this.state.lastSeq }
      socket.send({ data: JSON.stringify(hello) })
    })

    socket.onMessage(({ data }) => {
      if (typeof data !== 'string') return
      let message: ServerMessage
      try {
        message = JSON.parse(data) as ServerMessage
      } catch {
        return
      }
      const reduced = reduceAgentServerMessage(this.state, message, this.options.prefix ?? 'stream')
      this.state = reduced.state
      if (Object.keys(reduced.patches).length > 0) {
        this.options.onPatches(reduced.patches, this.state)
      }
      if (message.type === 'resync') {
        this.options.onResyncRequired?.()
        const hello: ClientMessage = { type: 'hello', afterSeq: 0 }
        socket.send({ data: JSON.stringify(hello) })
      }
    })

    socket.onClose(() => {
      this.options.onConnectionChange?.(false)
    })

    socket.onError(() => {
      this.options.onConnectionChange?.(false)
    })
  }

  // Called from MiniProgram onShow to resume from lastSeq without duplicating already rendered deltas.
  reconnect(): void {
    if (this.closed) return
    this.connect()
  }

  disconnect(): void {
    this.closed = true
    this.disconnectSocket()
  }

  private disconnectSocket(): void {
    if (!this.socket) return
    try {
      this.socket.close({ code: 1000, reason: 'client-close' })
    } catch {}
    this.socket = null
  }
}
