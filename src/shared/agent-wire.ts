// WebSocket protocol shared by every durable agent (Simulated Patient now, Clinical Copilot later).
// Commands go over HTTP; a socket only streams the agent's events, each with a per-agent sequence number.

export type RunStatus = 'done' | 'failed' | 'stopped'

export type AgentEvent =
  // `ref` is what the run answers, e.g. the patient turn it replies as.
  | { type: 'run.started'; runId: string; ref: string | null }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'thinking.delta'; runId: string; text: string }
  // The run restarted from its last checkpoint after a crash: drop what it streamed so far.
  | { type: 'run.reset'; runId: string }
  | { type: 'run.finished'; runId: string; ref: string | null; status: RunStatus; error: string | null }

export type ClientMessage = { type: 'hello'; afterSeq: number }

export type ServerMessage =
  | { type: 'event'; seq: number; event: AgentEvent }
  // Replay after `hello` is complete; live events follow.
  | { type: 'replay.done'; seq: number }
  // The client is ahead of the server's log (its state was reset): reload the snapshot and say hello from 0.
  | { type: 'resync' }
