// Append-only migration lists: each entry runs once per Durable Object, in order, recorded in a ledger table.
// Callers run this inside one storage transaction, together with anything that depends on the schema.
// A ledger shared by several components (the agent runtime and the agent built on it) keys versions by component.
export function applyMigrations(sql: SqlStorage, ledger: string, migrations: readonly string[], component?: string): void {
  if (component === undefined) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${ledger} (version INTEGER PRIMARY KEY)`)
  } else {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ledger} (component TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (component, version))`,
    )
  }
  const where = component === undefined ? '' : ' WHERE component = ?'
  const bindings = component === undefined ? [] : [component]
  const applied = sql.exec<{ version: number | null }>(`SELECT max(version) AS version FROM ${ledger}${where}`, ...bindings).one().version ?? 0
  migrations.slice(applied).forEach((migration, index) => {
    sql.exec(migration)
    const version = applied + index + 1
    if (component === undefined) sql.exec(`INSERT INTO ${ledger} (version) VALUES (?)`, version)
    else sql.exec(`INSERT INTO ${ledger} (component, version) VALUES (?, ?)`, component, version)
  })
}
