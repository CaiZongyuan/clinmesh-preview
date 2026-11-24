// Append-only, recorded under component `runtime` in `agent_schema_migration`. Times are epoch milliseconds.
export const AGENT_RUNTIME_MIGRATIONS: readonly string[] = [
  // One session per agent Durable Object; its binding (e.g. the Patient Persona) is immutable once bound.
  // Messages are the agent's durable context. A reply that another Durable Object must accept stays `unsettled`
  // until it does, and becomes `void` if it is refused.
  // The partial unique index serializes runs: at most one is running at a time.
  `CREATE TABLE agent_session (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     agent_kind TEXT NOT NULL,
     binding_ref TEXT NOT NULL,
     binding_json TEXT NOT NULL,
     config_json TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE agent_message (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
     content_json TEXT NOT NULL,
     origin_ref TEXT UNIQUE,
     state TEXT NOT NULL CHECK (state IN ('unsettled', 'active', 'void', 'compacted')),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE agent_run (
     run_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     trigger_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'stopped')),
     queue_order INTEGER NOT NULL,
     external_ref TEXT UNIQUE,
     deadline_at INTEGER,
     stop_requested_at INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     usage_json TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE UNIQUE INDEX agent_run_one_running ON agent_run (status) WHERE status = 'running';
   CREATE TABLE agent_event (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT,
     type TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX agent_event_by_run ON agent_event (run_id, type);
   CREATE TABLE agent_outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     done_at INTEGER,
     last_error TEXT
   );`,
]
