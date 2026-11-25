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
  // Runs that read (the Clinical Copilot): each LLM step and each tool call is a durable checkpoint, and a doctor can
  // steer a running run (read before its next step). A run's inputs join the context only once it starts, so a
  // queued prompt never lands between a running step's tool calls and their results. `subject` names what a run
  // answers (e.g. a doctor turn), so a newer run for the same subject supersedes it. `superseded_by` marks runs an
  // edited or regenerated prompt replaced: their messages are void.
  `ALTER TABLE agent_run ADD COLUMN subject TEXT;
   ALTER TABLE agent_run ADD COLUMN input_json TEXT;
   ALTER TABLE agent_run ADD COLUMN stop_reason TEXT;
   ALTER TABLE agent_run ADD COLUMN superseded_by TEXT;
   CREATE INDEX agent_run_by_subject ON agent_run (subject);
   CREATE TABLE agent_step (
     run_id TEXT NOT NULL,
     step INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running', 'done', 'stopped', 'failed')),
     thinking TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     usage_json TEXT,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     PRIMARY KEY (run_id, step)
   );
   CREATE TABLE agent_tool_call (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL,
     step INTEGER NOT NULL,
     call_id TEXT NOT NULL,
     name TEXT NOT NULL,
     arguments_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('dispatched', 'ok', 'error', 'cancelled')),
     subject TEXT,
     result TEXT,
     dispatched_at INTEGER NOT NULL,
     completed_at INTEGER,
     UNIQUE (run_id, step, call_id)
   );
   CREATE TABLE agent_steer (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL,
     client_ref TEXT NOT NULL UNIQUE,
     content TEXT NOT NULL,
     trigger_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     consumed_at INTEGER,
     requeued_as TEXT
   );`,
]
