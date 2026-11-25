import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { GoldenCaseQueueResponse } from '../../src/shared/golden-case-queue'
import { goldenCase1QueueEntry } from '../fixtures/golden-case-1'
import { goldenCase2QueueEntry } from '../fixtures/golden-case-2'
import { goldenCase4QueueEntry } from '../fixtures/golden-case-4'

const goldenCaseQueue: GoldenCaseQueueResponse = {
  goldenCases: [goldenCase1QueueEntry, goldenCase2QueueEntry, goldenCase4QueueEntry],
}

const getGoldenCases = () => exports.default.fetch('http://clinmesh.test/api/golden-cases')
const workspace = () => env.CLINIC_WORKSPACE.getByName('default')

// Evicting the workspace makes the next request construct it again, re-running the case-pack load.
async function reloadWorkspace() {
  await evictDurableObject(workspace())
}

const storedCaseIds = () =>
  runInDurableObject(workspace(), (_instance, state) =>
    state.storage.sql
      .exec<{ case_id: string }>('SELECT case_id FROM golden_case ORDER BY queue_number')
      .toArray()
      .map((row) => row.case_id),
  )

describe('GET /api/golden-cases', () => {
  it('serves Golden Case 1 from the workspace Durable Object SQLite store, loading the case pack idempotently', async () => {
    const first = await getGoldenCases()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual(goldenCaseQueue)

    await reloadWorkspace()
    const again = await getGoldenCases()
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(goldenCaseQueue)
    expect(await storedCaseIds()).toEqual(['golden-case-01', 'golden-case-02', 'golden-case-04'])
  })

  it('reconciles a workspace holding stale Golden Case rows back to the pinned case pack', async () => {
    await getGoldenCases()
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql
      sql.exec("UPDATE golden_case SET queue_number = 13, patient_name = '旧患者' WHERE case_id = 'golden-case-01'")
      sql.exec("UPDATE golden_case SET queue_number = 14, patient_name = '旧患者' WHERE case_id = 'golden-case-02'")
      sql.exec("UPDATE golden_case SET queue_number = 15, patient_name = '旧患者' WHERE case_id = 'golden-case-04'")
      const insert = `INSERT INTO golden_case (case_id, queue_number, patient_name, sex, birth_date, chief_complaint, registered_at, visit_kind)
                      VALUES (?, ?, ?, 'female', '1960-01-01', '旧主诉', '2026-11-24T08:46:00+08:00', 'return')`
      sql.exec(insert, 'outpatient-cap-penicillin-anaphylaxis-v1', 11, '改名前的病例')
      sql.exec(insert, 'retired-case', 12, '已移除患者')
    })

    await reloadWorkspace()
    const response = await getGoldenCases()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(goldenCaseQueue)
    expect(await storedCaseIds()).toEqual(['golden-case-01', 'golden-case-02', 'golden-case-04'])
  })

  it('upgrades a workspace created before schema migrations were tracked', async () => {
    await getGoldenCases()
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql
      const tables = sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`)
        .toArray()
      for (const { name } of tables) sql.exec(`DROP TABLE ${name}`)
      sql.exec(`CREATE TABLE golden_case (
        case_id TEXT PRIMARY KEY, case_pack_version TEXT NOT NULL, queue_number INTEGER NOT NULL UNIQUE,
        patient_name TEXT NOT NULL, sex TEXT NOT NULL, birth_date TEXT NOT NULL, chief_complaint TEXT NOT NULL,
        registered_at TEXT NOT NULL, visit_kind TEXT NOT NULL)`)
      sql.exec(`INSERT INTO golden_case VALUES ('outpatient-cap-penicillin-anaphylaxis-v1', '2026-11-24.1', 7, '李建国', 'male',
        '1968-05-16', '发热、咳嗽 3 天', '2026-11-24T08:31:00+08:00', 'first')`)
    })

    await reloadWorkspace()
    const response = await getGoldenCases()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(goldenCaseQueue)
  })
})
