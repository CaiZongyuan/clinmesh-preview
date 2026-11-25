import { exports } from 'cloudflare:workers'
import { expect, vi } from 'vitest'
import type { ServerMessage } from '../../../src/shared/agent-wire'
import type { AskPatientResponse, ConsultationResponse, ConsultationTurn } from '../../../src/shared/consultation'
import type { EncounterResponse } from '../../../src/shared/encounter'

export const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)

export const send = (method: string, path: string, body?: unknown) =>
  api(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export async function startEncounter(caseId = 'golden-case-01'): Promise<string> {
  const response = await send('POST', '/api/encounters', { caseId })
  expect(response.status).toBe(201)
  return ((await response.json()) as EncounterResponse).encounter.encounterId
}

let clientTurns = 0
export const ask = (encounterId: string, text: string, clientTurnId = `client-${++clientTurns}`) =>
  send('POST', `/api/encounters/${encounterId}/consultation/doctor-turns`, { clientTurnId, text })

export async function asked(encounterId: string, text: string): Promise<AskPatientResponse> {
  const response = await ask(encounterId, text)
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json()) as AskPatientResponse
}

export const retry = (encounterId: string, turnId: string) =>
  send('POST', `/api/encounters/${encounterId}/consultation/patient-turns/${turnId}/retry`)

export async function transcript(encounterId: string): Promise<ConsultationTurn[]> {
  const response = await api(`/api/encounters/${encounterId}/consultation`)
  expect(response.status).toBe(200)
  return ((await response.json()) as ConsultationResponse).turns
}

// Waits until the patient turn leaves `pending`, polling the workspace as the browser would after a socket event.
export async function settled(encounterId: string, patientTurnId: string, timeout = 4000): Promise<ConsultationTurn> {
  return vi.waitFor(
    async () => {
      const turn = (await transcript(encounterId)).find((t) => t.turnId === patientTurnId)
      expect(turn?.status).not.toBe('pending')
      return turn!
    },
    { timeout, interval: 20 },
  )
}

export interface PatientSocket {
  messages: ServerMessage[]
  raw: string[]
  waitFor(predicate: (messages: ServerMessage[]) => boolean, timeout?: number): Promise<void>
  close(): void
}

export async function openPatientSocket(encounterId: string, afterSeq = 0): Promise<PatientSocket> {
  const response = await api(`/api/encounters/${encounterId}/patient/socket`, { headers: { upgrade: 'websocket' } })
  expect(response.status).toBe(101)
  const ws = response.webSocket!
  const raw: string[] = []
  const messages: ServerMessage[] = []
  ws.addEventListener('message', (event) => {
    raw.push(String(event.data))
    messages.push(JSON.parse(String(event.data)) as ServerMessage)
  })
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', afterSeq }))
  const socket: PatientSocket = {
    messages,
    raw,
    waitFor: (predicate, timeout = 4000) =>
      vi.waitFor(() => expect(predicate(messages), JSON.stringify(messages)).toBe(true), { timeout, interval: 10 }),
    close: () => ws.close(),
  }
  await socket.waitFor((m) => m.some((x) => x.type === 'replay.done' || x.type === 'resync'))
  return socket
}

export const eventsOf = (messages: ServerMessage[]) =>
  messages.flatMap((m) => (m.type === 'event' ? [{ seq: m.seq, ...m.event }] : []))

// The Clinical Copilot's socket speaks the same wire protocol as the patient's.
export async function openCopilotSocket(encounterId: string, afterSeq = 0): Promise<PatientSocket> {
  const response = await api(`/api/encounters/${encounterId}/copilot/socket`, { headers: { upgrade: 'websocket' } })
  expect(response.status).toBe(101)
  const ws = response.webSocket!
  const raw: string[] = []
  const messages: ServerMessage[] = []
  ws.addEventListener('message', (event) => {
    raw.push(String(event.data))
    messages.push(JSON.parse(String(event.data)) as ServerMessage)
  })
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', afterSeq }))
  const socket: PatientSocket = {
    messages,
    raw,
    waitFor: (predicate, timeout = 4000) =>
      vi.waitFor(() => expect(predicate(messages), JSON.stringify(messages)).toBe(true), { timeout, interval: 10 }),
    close: () => ws.close(),
  }
  await socket.waitFor((m) => m.some((x) => x.type === 'replay.done' || x.type === 'resync'))
  return socket
}

import type { CopilotSnapshot, CopilotTurn } from '../../../src/shared/copilot-turn'

export const promptCopilot = (
  encounterId: string,
  clientPromptId: string,
  text: string,
  mode: 'queue' | 'steer' = 'queue',
  mentions: unknown[] = [],
) => send('POST', `/api/encounters/${encounterId}/copilot/prompts`, { clientPromptId, text, mentions, mode })

export async function copilotSnapshot(encounterId: string): Promise<CopilotSnapshot> {
  const response = await api(`/api/encounters/${encounterId}/copilot`)
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { snapshot: CopilotSnapshot }).snapshot
}

// Waits until no Copilot turn is running or queued, as the browser does after socket events.
export async function copilotSettled(encounterId: string, timeout = 6000): Promise<CopilotSnapshot> {
  return vi.waitFor(
    async () => {
      const snapshot = await copilotSnapshot(encounterId)
      expect(snapshot.turns.every((t: CopilotTurn) => t.status !== 'running')).toBe(true)
      expect(snapshot.queued).toEqual([])
      return snapshot
    },
    { timeout, interval: 20 },
  )
}

export async function promptAndSettle(
  encounterId: string,
  clientPromptId: string,
  text: string,
  mode: 'queue' | 'steer' = 'queue',
): Promise<{ response: Response; snapshot: CopilotSnapshot }> {
  const response = await promptCopilot(encounterId, clientPromptId, text, mode)
  if (!response.ok) return { response, snapshot: await copilotSnapshot(encounterId) }
  return { response, snapshot: await copilotSettled(encounterId) }
}
