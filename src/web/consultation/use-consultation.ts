import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, ServerMessage } from '../../shared/agent-wire'
import type { ConsultationTurn } from '../../shared/consultation'
import { askPatient, fetchConsultation, openPatientSocket, retryPatientTurn } from '../api'

export type StreamState = 'connecting' | 'live' | 'reconnecting'

export interface Consultation {
  turns: ConsultationTurn[]
  // What the Simulated Patient has streamed so far for each pending patient turn.
  streamed: Readonly<Record<string, string>>
  pending: ConsultationTurn | undefined
  stream: StreamState
  error: string | null
  ask(text: string): Promise<boolean>
  retry(turnId: string): Promise<void>
}

// Past a pending turn's deadline the workspace fails it within its grace period; look again a little after that.
const DEADLINE_SLACK_MS = 6_000
const MIN_RECHECK_MS = 2_000
const MAX_RECONNECT_MS = 8_000

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

// A turn never returns to pending, so a stale pending copy never replaces a settled one.
function merge(turns: ConsultationTurn[], incoming: ConsultationTurn[]): ConsultationTurn[] {
  const byId = new Map(turns.map((turn) => [turn.turnId, turn]))
  for (const turn of incoming) {
    const known = byId.get(turn.turnId)
    if (!known || known.status === 'pending' || turn.status !== 'pending') byId.set(turn.turnId, turn)
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

// The Consultation of one Encounter: the transcript from the workspace over HTTP, and the Simulated Patient's
// replies as they stream over its socket. The socket replays what was missed after a refresh or a dropped
// connection, and every reply the workspace has settled reloads the transcript, which stays the record.
// A change of Encounter status (e.g. abandonment, which fails a waiting reply) reloads it too.
export function useConsultation(encounterId: string | null, encounterStatus?: string): Consultation {
  const [turns, setTurns] = useState<ConsultationTurn[]>([])
  const [streamed, setStreamed] = useState<Record<string, string>>({})
  const [stream, setStream] = useState<StreamState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const current = useRef(encounterId)
  current.current = encounterId

  const refresh = useCallback(async () => {
    if (!encounterId) return
    try {
      const latest = await fetchConsultation(encounterId)
      if (current.current === encounterId) setTurns((known) => merge(known, latest))
    } catch (e) {
      if (current.current === encounterId) setError(message(e, '问诊记录加载失败'))
    }
  }, [encounterId])

  useEffect(() => {
    setTurns([])
    setStreamed({})
    setError(null)
  }, [encounterId])

  useEffect(() => {
    void refresh()
  }, [refresh, encounterStatus])

  useEffect(() => {
    if (!encounterId) return
    let socket: WebSocket | null = null
    let disposed = false
    let replaying = true
    let lastSeq = 0
    let delay = 500
    let timer: ReturnType<typeof setTimeout> | undefined
    const refs = new Map<string, string>()
    const setText = (runId: string, update: (text: string) => string) => {
      const ref = refs.get(runId)
      if (ref) setStreamed((all) => ({ ...all, [ref]: update(all[ref] ?? '') }))
    }

    const apply = (event: AgentEvent) => {
      if (event.type === 'run.started' && event.ref) {
        refs.set(event.runId, event.ref)
        setText(event.runId, () => '')
      } else if (event.type === 'text.delta') {
        setText(event.runId, (text) => text + event.text)
      } else if (event.type === 'run.reset') {
        setText(event.runId, () => '')
      } else if (event.type === 'run.settled') {
        if (!replaying) void refresh()
      }
    }

    const receive = (incoming: ServerMessage) => {
      if (incoming.type === 'event') {
        if (incoming.seq <= lastSeq) return
        lastSeq = incoming.seq
        apply(incoming.event)
      } else if (incoming.type === 'replay.done') {
        replaying = false
        delay = 500
        lastSeq = Math.max(lastSeq, incoming.seq)
        setStream('live')
        void refresh()
      } else {
        lastSeq = 0
        refs.clear()
        setStreamed({})
        socket?.close()
      }
    }

    const connect = () => {
      replaying = true
      const ws = openPatientSocket(encounterId)
      socket = ws
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', afterSeq: lastSeq }))
      ws.onmessage = (event: MessageEvent) => {
        try {
          receive(JSON.parse(String(event.data)) as ServerMessage)
        } catch {}
      }
      ws.onclose = () => {
        if (disposed || socket !== ws) return
        setStream('reconnecting')
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 2, MAX_RECONNECT_MS)
      }
    }

    setStream('connecting')
    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      socket?.close()
    }
  }, [encounterId, refresh])

  const pending = turns.find((turn) => turn.status === 'pending')

  // Never wait on a stuck reply: once its deadline has passed, ask the workspace, which fails it and releases the lock.
  useEffect(() => {
    if (!pending?.deadlineAt) return
    const wait = Math.max(MIN_RECHECK_MS, Date.parse(pending.deadlineAt) - Date.now() + DEADLINE_SLACK_MS)
    const timer = setTimeout(() => void refresh(), wait)
    return () => clearTimeout(timer)
  }, [pending, refresh])

  // Sending the same question again after a failed request reuses its id, so the workspace records it once.
  const unsent = useRef<{ text: string; clientTurnId: string } | null>(null)

  const ask = async (text: string) => {
    if (!encounterId) return false
    setError(null)
    if (unsent.current?.text !== text) unsent.current = { text, clientTurnId: crypto.randomUUID() }
    try {
      const { doctorTurn, patientTurn } = await askPatient(encounterId, unsent.current.clientTurnId, text)
      unsent.current = null
      setTurns((known) => merge(known, [doctorTurn, patientTurn]))
      return true
    } catch (e) {
      setError(message(e, '提问失败'))
      void refresh()
      return false
    }
  }

  const retry = async (turnId: string) => {
    if (!encounterId) return
    setError(null)
    try {
      const patientTurn = await retryPatientTurn(encounterId, turnId)
      setTurns((known) => merge(known, [patientTurn]))
    } catch (e) {
      setError(message(e, '重试失败'))
      void refresh()
    }
  }

  return { turns, streamed, pending, stream, error, ask, retry }
}
