// WebSocket protocol shared by every durable agent (Simulated Patient now, Clinical Copilot later).
// Commands go over HTTP; a socket only streams the agent's events, each with a per-agent sequence number.

export type RunStatus = 'done' | 'failed' | 'stopped'

export type ToolCallStatus = 'ok' | 'error' | 'cancelled'

export type AgentEvent =
  // `ref` is what the run answers, e.g. the patient turn it replies as.
  | { type: 'run.started'; runId: string; ref: string | null }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'thinking.delta'; runId: string; text: string }
  // The run restarted from its last checkpoint after a crash: drop what it streamed so far.
  | { type: 'run.reset'; runId: string }
  | { type: 'run.finished'; runId: string; ref: string | null; status: RunStatus; error: string | null }
  // For an agent whose outcome another Durable Object must accept: delivered, and accepted or refused there.
  // The record (e.g. the Consultation) is up to date once this arrives.
  | { type: 'run.settled'; runId: string; ref: string | null; accepted: boolean }
  // Agents that trace their steps (the Clinical Copilot) also announce their structure; the deltas between a
  // `step.started` and its `step.finished` belong to that step. After any of these, the snapshot is up to date.
  | { type: 'run.queued'; runId: string; ref: string | null }
  | { type: 'step.started'; runId: string; step: number }
  | { type: 'step.finished'; runId: string; step: number }
  | { type: 'tool.started'; runId: string; callId: string; name: string }
  | { type: 'tool.finished'; runId: string; callId: string; status: ToolCallStatus }
  | { type: 'steer.added'; runId: string }
  | { type: 'steer.consumed'; runId: string }
  // Something about the session itself changed (e.g. its model, a reply's feedback, an edited prompt).
  | { type: 'session.updated'; runId: null }

// Commands go over HTTP; a socket streams the agent's events (viewer) or serves the ui-sdk bridge (bridge).
// A bridge socket receives `bridge.call` for the agent's ui_snapshot / ui_act tools and answers `bridge.result`.
export type ClientMessage = { type: 'hello'; afterSeq: number } | { type: 'bridge.result'; callId: string; ok: boolean; result: string; outcome?: 'suggestion' | 'denied' }

export type ServerMessage =
  | { type: 'event'; seq: number; event: AgentEvent }
  // Replay after `hello` is complete; live events follow.
  | { type: 'replay.done'; seq: number }
  // The client is ahead of the server's log (its state was reset): reload the snapshot and say hello from 0.
  | { type: 'resync' }
  | { type: 'bridge.call'; callId: string; tool: 'ui_snapshot' | 'ui_act'; args: unknown }
