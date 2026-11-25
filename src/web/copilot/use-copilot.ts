import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerMessage } from '../../shared/agent-wire'
import type {
  CopilotFeedback,
  CopilotMention,
  CopilotModelSetting,
  CopilotPromptMode,
  CopilotQueuedItem,
  CopilotSnapshot,
  CopilotTurn,
} from '../../shared/copilot-turn'
import {
  configureCopilot,
  fetchCopilotSnapshot,
  openCopilotSocket,
  promptCopilot,
  resendCopilotPrompt,
  setCopilotFeedback,
  stopCopilot,
} from '../api'

export type CopilotStreamState = 'connecting' | 'live' | 'reconnecting'

export interface CopilotSession {
  turns: CopilotTurn[]
  queued: CopilotQueuedItem[]
  model: CopilotModelSetting | null
  stream: CopilotStreamState
  // Turns that finished, or steps that changed, while the panel was hidden.
  unread: number
  // Any Copilot turn is running or queued.
  busy: boolean
  prompt(text: string, mentions: CopilotMention[], mode: CopilotPromptMode): Promise<boolean>
  resend(turnId: string, text: string, mentions: CopilotMention[]): Promise<boolean>
  stop(): Promise<void>
  setFeedback(turnId: string, value: CopilotFeedback | null): Promise<void>
  configure(model: string, effort: CopilotModelSetting['effort']): Promise<void>
  clearUnread(): void
}

const MIN_RECONNECT_MS = 500
const MAX_RECONNECT_MS = 8_000
// Structural events change the durable projection; deltas arrive between snapshots.
const REFRESH_DEBOUNCE_MS = 60

const newPromptId = () => `prompt-${crypto.randomUUID()}`

// The Clinical Copilot session of one Encounter: the projection from the workspace over HTTP, and the
// run's steps and streamed text as they happen over its socket. Every structural event refreshes the
// snapshot, so the panel always reflects the durable state; the socket replays what was missed.
export function useCopilot(encounterId: string | null, encounterStatus?: string, hidden = false): CopilotSession {
  const [snapshot, setSnapshot] = useState<CopilotSnapshot | null>(null)
  const [stream, setStream] = useState<CopilotStreamState>('connecting')
  const [unread, setUnread] = useState(0)
  const current = useRef(encounterId)
  current.current = encounterId

  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const refresh = useCallback(async () => {
    if (!encounterId) return
    const latest = await fetchCopilotSnapshot(encounterId).catch(() => null)
    if (!latest || current.current !== encounterId) return
    setSnapshot(latest)
    if (hiddenRef.current) setUnread((n) => n + 1)
  }, [encounterId])

  useEffect(() => {
    setSnapshot(null)
    setUnread(0)
    setStream('connecting')
  }, [encounterId])

  useEffect(() => {
    void refresh()
  }, [refresh, encounterStatus])

  useEffect(() => {
    if (!encounterId) return
    let socket: WebSocket | null = null
    let disposed = false
    let delay = MIN_RECONNECT_MS
    let lastSeq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let queuedRefresh: ReturnType<typeof setTimeout> | undefined

    const receive = (incoming: ServerMessage) => {
      if (incoming.type === 'event') {
        if (incoming.seq <= lastSeq) return
        lastSeq = incoming.seq
        // Deltas between snapshots are cosmetic; the debounced refresh folds them in with the next
        // structural event anyway, and a steady stream keeps the panel within one debounce of live.
        clearTimeout(queuedRefresh)
        queuedRefresh = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
      } else if (incoming.type === 'replay.done') {
        delay = MIN_RECONNECT_MS
        lastSeq = Math.max(lastSeq, incoming.seq)
        setStream('live')
        void refresh()
      } else {
        lastSeq = 0
        socket?.close()
      }
    }

    const connect = () => {
      const ws = openCopilotSocket(encounterId)
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

    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(queuedRefresh)
      socket?.close()
    }
  }, [encounterId, refresh])

  const apply = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (!encounterId) return false
    try {
      await action()
      await refresh()
      return true
    } catch {
      await refresh()
      return false
    }
  }

  return {
    turns: snapshot?.turns ?? [],
    queued: snapshot?.queued ?? [],
    model: snapshot?.model ?? null,
    stream: encounterId ? stream : 'connecting',
    unread,
    busy: (snapshot?.turns ?? []).some((turn) => turn.status === 'running') || (snapshot?.queued.length ?? 0) > 0,
    prompt: (text, mentions, mode) => {
      // A steer with nothing running is the same head-of-queue run on the server.
      return apply(() => promptCopilot(encounterId!, newPromptId(), text, mentions, mode))
    },
    resend: (turnId, text, mentions) =>
      apply(() => resendCopilotPrompt(encounterId!, turnId, newPromptId(), text, mentions)),
    stop: async () => {
      await apply(() => stopCopilot(encounterId!))
    },
    setFeedback: async (turnId, value) => {
      await apply(() => setCopilotFeedback(encounterId!, turnId, value))
    },
    configure: async (model, effort) => {
      await apply(() => configureCopilot(encounterId!, { model, effort }))
    },
    clearUnread: () => setUnread(0),
  }
}
