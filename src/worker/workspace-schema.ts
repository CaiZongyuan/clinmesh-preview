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
]

export function migrateWorkspaceSchema(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY)')
  const applied = sql.exec<{ version: number | null }>('SELECT max(version) AS version FROM schema_migration').one().version ?? 0
  MIGRATIONS.slice(applied).forEach((migration, index) => {
    sql.exec(migration)
    sql.exec('INSERT INTO schema_migration (version) VALUES (?)', applied + index + 1)
  })
}
