// At-least-once delivery of a run's outcome to another Durable Object. The entry is written in the same
// transaction that closes the run, so a crash between closing and delivering only delays delivery.
export interface OutboxEntry {
  id: number
  runId: string
  payload: unknown
  attempts: number
}

type OutboxRow = { id: number; run_id: string; payload_json: string; attempts: number }

const MAX_ATTEMPTS = 10
const MAX_BACKOFF_MS = 30_000

export class Outbox {
  constructor(private readonly sql: SqlStorage) {}

  enqueue(runId: string, payload: unknown, now: number): void {
    this.sql.exec(
      'INSERT INTO agent_outbox (run_id, payload_json, next_attempt_at) VALUES (?, ?, ?)',
      runId, JSON.stringify(payload), now,
    )
  }

  due(now: number): OutboxEntry[] {
    return this.sql
      .exec<OutboxRow>(
        'SELECT id, run_id, payload_json, attempts FROM agent_outbox WHERE done_at IS NULL AND next_attempt_at <= ? ORDER BY id',
        now,
      )
      .toArray()
      .map((row) => ({ id: row.id, runId: row.run_id, payload: JSON.parse(row.payload_json), attempts: row.attempts }))
  }

  nextAttemptAt(): number | null {
    return this.sql.exec<{ at: number | null }>('SELECT min(next_attempt_at) AS at FROM agent_outbox WHERE done_at IS NULL').one().at
  }

  delivered(id: number, now: number): void {
    this.sql.exec('UPDATE agent_outbox SET done_at = ?, attempts = attempts + 1 WHERE id = ?', now, id)
  }

  // Backs off exponentially; after the last attempt the entry is closed with its error kept for diagnosis.
  failed(entry: OutboxEntry, now: number, error: string): void {
    const attempts = entry.attempts + 1
    const giveUp = attempts >= MAX_ATTEMPTS
    this.sql.exec(
      'UPDATE agent_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, done_at = ? WHERE id = ?',
      attempts, now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1)), error, giveUp ? now : null, entry.id,
    )
  }
}
