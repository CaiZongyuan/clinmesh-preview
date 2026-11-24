// Append-only: each entry runs once per workspace, in order, recorded in schema_migration.
const MIGRATIONS: readonly string[] = [
  // Tables made before migrations were tracked held only case-pack data, which reconcile restores, so rebuild.
  `DROP TABLE IF EXISTS golden_case;
   CREATE TABLE golden_case (
     case_id TEXT PRIMARY KEY,
     queue_number INTEGER NOT NULL UNIQUE,
     patient_name TEXT NOT NULL,
     sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
     birth_date TEXT NOT NULL,
     chief_complaint TEXT NOT NULL,
     registered_at TEXT NOT NULL,
     visit_kind TEXT NOT NULL CHECK (visit_kind IN ('first', 'return'))
   );`,
  // Encounters keep the browser-visible chart they started with, so later case-pack edits don't rewrite them.
  // The partial unique index makes "one active Encounter per workspace" a storage invariant too.
  `CREATE TABLE encounter (
     encounter_id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL,
     case_version TEXT NOT NULL,
     persona_version TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'abandoned', 'completed')),
     started_at TEXT NOT NULL,
     ended_at TEXT,
     visible_chart TEXT NOT NULL
   );
   CREATE UNIQUE INDEX encounter_single_active ON encounter (status) WHERE status = 'active';
   CREATE TABLE audit_event (
     audit_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     event_type TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL
   );
   CREATE INDEX audit_event_by_encounter ON audit_event (encounter_id, audit_event_id);`,
]

export function migrateWorkspaceSchema(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY)')
  const applied = sql.exec<{ version: number | null }>('SELECT max(version) AS version FROM schema_migration').one().version ?? 0
  MIGRATIONS.slice(applied).forEach((migration, index) => {
    sql.exec(migration)
    sql.exec('INSERT INTO schema_migration (version) VALUES (?)', applied + index + 1)
  })
}
