import type { AgentEvent } from '../../shared/agent-wire'

export interface LoggedEvent {
  seq: number
  event: AgentEvent
}

type EventRow = { seq: number; payload_json: string }

const DELTA_TYPES = ['text.delta', 'thinking.delta'] as const

// The replay buffer behind every socket: events are appended in order and replayed by sequence number.
export class EventLog {
  constructor(private readonly sql: SqlStorage) {}

  append(event: AgentEvent): LoggedEvent {
    const { seq } = this.sql
      .exec<{ seq: number }>(
        'INSERT INTO agent_event (run_id, type, payload_json, at) VALUES (?, ?, ?, ?) RETURNING seq',
        event.runId, event.type, JSON.stringify(event), Date.now(),
      )
      .one()
    return { seq, event }
  }

  after(afterSeq: number): LoggedEvent[] {
    return this.sql
      .exec<EventRow>('SELECT seq, payload_json FROM agent_event WHERE seq > ? ORDER BY seq', afterSeq)
      .toArray()
      .map((row) => ({ seq: row.seq, event: JSON.parse(row.payload_json) as AgentEvent }))
  }

  latestSeq(): number {
    return this.sql.exec<{ seq: number | null }>('SELECT max(seq) AS seq FROM agent_event').one().seq ?? 0
  }

  // Once a run has finished or restarted, its streamed text is no longer worth replaying.
  dropDeltas(runId: string): void {
    this.sql.exec(`DELETE FROM agent_event WHERE run_id = ? AND type IN (${DELTA_TYPES.map(() => '?').join(', ')})`, runId, ...DELTA_TYPES)
  }
}

// Coalesces stream deltas into event rows of a reasonable size, so a long reply isn't a row per token.
export class DeltaBuffer {
  private pending: { type: (typeof DELTA_TYPES)[number]; text: string } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly runId: string,
    private readonly emit: (event: AgentEvent) => void,
    private readonly maxChars = 64,
    private readonly maxDelayMs = 100,
  ) {}

  push(type: (typeof DELTA_TYPES)[number], text: string): void {
    if (this.pending && this.pending.type !== type) this.flush()
    this.pending = { type, text: (this.pending?.text ?? '') + text }
    if (this.pending.text.length >= this.maxChars) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), this.maxDelayMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending) return
    const { type, text } = this.pending
    this.pending = null
    this.emit({ type, runId: this.runId, text })
  }

  discard(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }
}
