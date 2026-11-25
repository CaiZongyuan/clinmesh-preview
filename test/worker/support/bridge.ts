import { expect } from 'vitest'
import type { ServerMessage } from '../../../src/shared/agent-wire'
import { eventsOf, openCopilotBridgeSocket, send, type PatientSocket } from './clinic'

// A ui_snapshot listing one note field and one Clinical Confirmation button.
export const snapshotWithConfirm = (confirmLabel = '确认签署'): string =>
  JSON.stringify([
    { ref: 'c1', component: 'input', label: '主诉', value: '', actions: ['setValue'] },
    { ref: 'c2', component: 'button', label: confirmLabel, confirm: `签署病历（${confirmLabel}）`, actions: ['press'] },
  ])

export interface BridgeServer {
  bridge: PatientSocket
  calls: { callId: string; tool: string; args: unknown }[]
  respond(tool: string, args: unknown): { ok: boolean; result: string; outcome?: 'suggestion' | 'denied' }
  waitForCall(timeout?: number): Promise<void>
  close(): void
}

// Answers every bridge.call with `respond`, recording the calls so a test can assert what reached the browser.
export async function serveBridge(
  encounterId: string,
  respond: (tool: string, args: unknown) => { ok: boolean; result: string; outcome?: 'suggestion' | 'denied' },
): Promise<BridgeServer> {
  const bridge = await openCopilotBridgeSocket(encounterId)
  const server: BridgeServer = {
    bridge,
    calls: [],
    respond,
    waitForCall: (timeout = 4000) =>
      vi_waitFor(() => expect(server.calls.length, JSON.stringify(server.calls)).toBeGreaterThan(0), timeout),
    close: () => bridge.close(),
  }
  bridge.ws.addEventListener('message', (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as { type: string; callId?: string; tool?: string; args?: unknown }
    if (message.type !== 'bridge.call' || typeof message.callId !== 'string') return
    server.calls.push({ callId: message.callId, tool: message.tool!, args: message.args })
    bridge.ws.send(JSON.stringify({ type: 'bridge.result', callId: message.callId, ...respond(message.tool!, message.args) }))
  })
  return server
}

const vi_waitFor = (fn: () => void, timeout: number) =>
  import('vitest').then((v) => v.vi.waitFor(fn, { timeout, interval: 10 }))

export const events = eventsOf
export type { ServerMessage }
export const prompt = (encounterId: string, clientPromptId: string, text: string) =>
  send('POST', `/api/encounters/${encounterId}/copilot/prompts`, { clientPromptId, text, mentions: [], mode: 'queue' })
