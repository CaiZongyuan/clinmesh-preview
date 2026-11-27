// Mirrors src/shared/agent-stream-reducer.ts inside miniprogramRoot because WeChat DevTools only bundles runtime modules under miniprogram/.
import type { AgentEvent, RunStatus, ServerMessage, ToolCallStatus } from '../../../../src/shared/agent-wire'

export interface StreamToolState {
  callId: string
  name: string
  status: 'running' | ToolCallStatus
}

export interface StreamingRunView {
  runId: string
  ref: string | null
  status: 'running' | RunStatus
  text: string
  tools: StreamToolState[]
  error: string | null
  settled: boolean
  settledAccepted: boolean | null
}

export interface AgentStreamState {
  lastSeq: number
  replaying: boolean
  needsResync: boolean
  activeRunId: string | null
  runs: Record<string, StreamingRunView>
}

export type StreamPatchMap = Record<string, unknown>

export interface ReduceResult {
  state: AgentStreamState
  patches: StreamPatchMap
}

export function createAgentStreamState(initialSeq = 0): AgentStreamState {
  return {
    lastSeq: initialSeq,
    replaying: true,
    needsResync: false,
    activeRunId: null,
    runs: {},
  }
}

export function reduceAgentServerMessage(
  state: AgentStreamState,
  message: ServerMessage,
  prefix = 'stream',
): ReduceResult {
  if (message.type === 'resync') {
    const next: AgentStreamState = {
      lastSeq: 0,
      replaying: true,
      needsResync: true,
      activeRunId: null,
      runs: {},
    }
    return {
      state: next,
      patches: {
        [`${prefix}.lastSeq`]: 0,
        [`${prefix}.replaying`]: true,
        [`${prefix}.needsResync`]: true,
        [`${prefix}.activeRunId`]: null,
        [`${prefix}.runs`]: {},
      },
    }
  }

  if (message.type === 'replay.done') {
    const lastSeq = Math.max(state.lastSeq, message.seq)
    const next: AgentStreamState = {
      ...state,
      lastSeq,
      replaying: false,
      needsResync: false,
    }
    return {
      state: next,
      patches: {
        [`${prefix}.lastSeq`]: lastSeq,
        [`${prefix}.replaying`]: false,
        [`${prefix}.needsResync`]: false,
      },
    }
  }

  if (message.type !== 'event') {
    return { state, patches: {} }
  }

  if (message.seq <= state.lastSeq) {
    return { state, patches: {} }
  }

  const applied = applyAgentEvent(state, message.event, prefix)
  const next: AgentStreamState = {
    ...applied.state,
    lastSeq: message.seq,
    needsResync: false,
  }
  return {
    state: next,
    patches: {
      ...applied.patches,
      [`${prefix}.lastSeq`]: message.seq,
    },
  }
}

function ensureRun(state: AgentStreamState, runId: string, ref: string | null = null): StreamingRunView {
  const existing = state.runs[runId]
  if (existing) return existing
  return {
    runId,
    ref,
    status: 'running',
    text: '',
    tools: [],
    error: null,
    settled: false,
    settledAccepted: null,
  }
}

function applyAgentEvent(state: AgentStreamState, event: AgentEvent, prefix: string): ReduceResult {
  if (event.type === 'thinking.delta' || event.type === 'session.updated') {
    return { state, patches: {} }
  }

  switch (event.type) {
    case 'run.started': {
      const run: StreamingRunView = {
        ...ensureRun(state, event.runId, event.ref),
        ref: event.ref,
        status: 'running',
        error: null,
      }
      return {
        state: {
          ...state,
          activeRunId: event.runId,
          runs: { ...state.runs, [event.runId]: run },
        },
        patches: {
          [`${prefix}.activeRunId`]: event.runId,
          [`${prefix}.runs.${event.runId}`]: run,
        },
      }
    }

    case 'text.delta': {
      const existing = state.runs[event.runId]
      const base = ensureRun(state, event.runId)
      const nextText = base.text + event.text
      const run: StreamingRunView = { ...base, text: nextText }
      const patches: StreamPatchMap = existing
        ? { [`${prefix}.runs.${event.runId}.text`]: nextText }
        : { [`${prefix}.runs.${event.runId}`]: run }
      return {
        state: { ...state, runs: { ...state.runs, [event.runId]: run } },
        patches,
      }
    }

    case 'run.reset': {
      const base = ensureRun(state, event.runId)
      const run: StreamingRunView = {
        ...base,
        status: 'running',
        text: '',
        tools: [],
        error: null,
      }
      return {
        state: { ...state, runs: { ...state.runs, [event.runId]: run } },
        patches: {
          [`${prefix}.runs.${event.runId}.text`]: '',
          [`${prefix}.runs.${event.runId}.tools`]: [],
          [`${prefix}.runs.${event.runId}.error`]: null,
        },
      }
    }

    case 'tool.started': {
      const existing = state.runs[event.runId]
      const base = ensureRun(state, event.runId)
      const idx = base.tools.findIndex((t) => t.callId === event.callId)
      const item: StreamToolState = { callId: event.callId, name: event.name, status: 'running' }
      const tools = idx === -1 ? [...base.tools, item] : base.tools.map((t, i) => (i === idx ? item : t))
      const run: StreamingRunView = { ...base, tools }
      const patches: StreamPatchMap = existing
        ? { [`${prefix}.runs.${event.runId}.tools[${idx === -1 ? base.tools.length : idx}]`]: item }
        : { [`${prefix}.runs.${event.runId}`]: run }
      return {
        state: { ...state, runs: { ...state.runs, [event.runId]: run } },
        patches,
      }
    }

    case 'tool.finished': {
      const base = ensureRun(state, event.runId)
      const idx = base.tools.findIndex((t) => t.callId === event.callId)
      if (idx === -1) return { state, patches: {} }
      const updated: StreamToolState = { ...base.tools[idx], status: event.status }
      const tools = base.tools.map((t, i) => (i === idx ? updated : t))
      const run: StreamingRunView = { ...base, tools }
      return {
        state: { ...state, runs: { ...state.runs, [event.runId]: run } },
        patches: {
          [`${prefix}.runs.${event.runId}.tools[${idx}].status`]: event.status,
        },
      }
    }

    case 'run.finished': {
      const base = ensureRun(state, event.runId, event.ref)
      const run: StreamingRunView = {
        ...base,
        ref: event.ref ?? base.ref,
        status: event.status,
        error: event.error,
      }
      const activeRunId = state.activeRunId === event.runId ? null : state.activeRunId
      return {
        state: {
          ...state,
          activeRunId,
          runs: { ...state.runs, [event.runId]: run },
        },
        patches: {
          [`${prefix}.activeRunId`]: activeRunId,
          [`${prefix}.runs.${event.runId}.status`]: event.status,
          [`${prefix}.runs.${event.runId}.error`]: event.error,
        },
      }
    }

    case 'run.settled': {
      const base = ensureRun(state, event.runId, event.ref)
      const run: StreamingRunView = {
        ...base,
        settled: true,
        settledAccepted: event.accepted,
      }
      return {
        state: { ...state, runs: { ...state.runs, [event.runId]: run } },
        patches: {
          [`${prefix}.runs.${event.runId}.settled`]: true,
          [`${prefix}.runs.${event.runId}.settledAccepted`]: event.accepted,
        },
      }
    }

    default:
      return { state, patches: {} }
  }
}

export type ClientActionSpec =
  | { name: 'medical.record.open'; args: { recordId: string } }
  | { name: 'report.open'; args: { reportId: string } }
  | { name: 'appointment.open'; args: { slotId?: string; doctorId?: string } }
  | { name: 'followup.open'; args: { planId: string; taskId?: string } }

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

export function parseClientAction(value: unknown): ClientActionSpec | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const { name, args } = value as { name?: unknown; args?: unknown }
  if (typeof name !== 'string' || args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const record = args as Record<string, unknown>

  switch (name) {
    case 'medical.record.open':
      return typeof record.recordId === 'string' && SAFE_ID.test(record.recordId)
        ? { name, args: { recordId: record.recordId } }
        : null
    case 'report.open':
      return typeof record.reportId === 'string' && SAFE_ID.test(record.reportId)
        ? { name, args: { reportId: record.reportId } }
        : null
    case 'appointment.open': {
      const slotId = record.slotId === undefined ? undefined : typeof record.slotId === 'string' && SAFE_ID.test(record.slotId) ? record.slotId : null
      const doctorId = record.doctorId === undefined ? undefined : typeof record.doctorId === 'string' && SAFE_ID.test(record.doctorId) ? record.doctorId : null
      if (slotId === null || doctorId === null) return null
      return { name, args: { ...(slotId ? { slotId } : {}), ...(doctorId ? { doctorId } : {}) } }
    }
    case 'followup.open': {
      if (typeof record.planId !== 'string' || !SAFE_ID.test(record.planId)) return null
      const taskId = record.taskId === undefined ? undefined : typeof record.taskId === 'string' && SAFE_ID.test(record.taskId) ? record.taskId : null
      if (taskId === null) return null
      return { name, args: { planId: record.planId, ...(taskId ? { taskId } : {}) } }
    }
    default:
      return null
  }
}
