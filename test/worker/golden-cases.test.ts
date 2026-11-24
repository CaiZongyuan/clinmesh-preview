import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { GoldenCaseQueueResponse } from '../../src/shared/golden-case-queue'

const getGoldenCases = () => exports.default.fetch('http://clinmesh.test/api/golden-cases')

describe('GET /api/golden-cases', () => {
  it('serves Golden Case 1 from the workspace Durable Object SQLite store, seeding it once', async () => {
    const first = await getGoldenCases()
    expect(first.status).toBe(200)
    const body = await first.json<GoldenCaseQueueResponse>()
    expect(body.goldenCases).toEqual([
      {
        caseId: 'outpatient-cap-penicillin-anaphylaxis-v1',
        queueNumber: 7,
        patientName: '李建国',
        sex: 'male',
        age: 58,
        chiefComplaint: '发热、咳嗽 3 天',
        registeredAt: '2026-11-24T08:31:00+08:00',
        visitKind: 'first',
        queueStatus: 'waiting',
      },
    ])

    const again = await (await getGoldenCases()).json<GoldenCaseQueueResponse>()
    expect(again).toEqual(body)

    const workspace = env.CLINIC_WORKSPACE.getByName('default')
    const storedRows = await runInDurableObject(workspace, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM golden_case').one().n,
    )
    expect(storedRows).toBe(1)
  })

  it('does not expose Case Truth through the queue', async () => {
    const text = await (await getGoldenCases()).text()
    expect(text).not.toMatch(/J18\.9|肺炎|physicalExamination|laboratories/)
  })
})
