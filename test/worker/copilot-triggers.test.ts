import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import { asked, copilotSettled, copilotSnapshot, send, settled, startEncounter } from './support/clinic'
import { serveBridge, snapshotWithConfirm } from './support/bridge'
import { installScripted } from './support/scripted-llm'

const copilotPath = (id: string) => `/api/encounters/${id}/copilot`
const investigationsPath = (id: string) => `/api/encounters/${id}/investigations`
const auto = (id: string, enabled: boolean) => send('PUT', `${copilotPath(id)}/automatic-analysis`, { enabled })
const batch = (id: string) => send('POST', `${copilotPath(id)}/pending-analysis/run`)
const workspace = () => env.CLINIC_WORKSPACE.getByName('default')

it('keeps waiting events across eviction and schedules one manual batch', async () => {
  const id = await startEncounter()
  expect((await auto(id, false)).status).toBe(200)
  installScripted('patient').reply('我咳嗽三天了。')
  await settled(id, (await asked(id, '咳嗽多久了？')).patientTurn.turnId)
  expect((await send('POST', `/api/encounters/${id}/physical-examinations`, { system: 'vitals' })).status).toBe(201)
  await vi.waitFor(async () => {
    expect((await copilotSnapshot(id)).pendingAnalysis).toHaveLength(2)
  })
  await evictDurableObject(env.CLINICAL_COPILOT.getByName(id))
  expect(await copilotSnapshot(id)).toMatchObject({ autoAnalysis: false, countdown: null, turns: [], queued: [] })

  expect((await batch(id)).status).toBe(409)
  expect((await copilotSnapshot(id)).pendingAnalysis).toHaveLength(2)
  const llm = installScripted('copilot').reply('已完成本批分析。')
  const bridge = await serveBridge(id, () => ({ ok: true, result: snapshotWithConfirm() }))
  try {
    const run = await batch(id)
    expect(run.status).toBe(201)
    expect((await batch(id)).status).toBe(200)
    const snapshot = await copilotSettled(id)
    expect(snapshot.pendingAnalysis).toEqual([])
    expect(snapshot.turns).toHaveLength(1)
    expect(snapshot.turns[0].reply).toBe('已完成本批分析。')
    expect(llm.requests[0].messages.some(({ content }) => content.includes('咳嗽多久了？') && content.includes('查体完成'))).toBe(true)
  } finally {
    bridge.close()
  }
})

it('runs examination, report release, and amendment automatically and once per version', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const id = await startEncounter()
    const llm = installScripted('copilot').reply('已分析查体。').reply('已分析报告。').reply('已分析更正。')
    const bridge = await serveBridge(id, () => ({ ok: true, result: snapshotWithConfirm() }))
    try {
      expect((await send('POST', `/api/encounters/${id}/physical-examinations`, { system: 'vitals' })).status).toBe(201)
      await vi.waitFor(async () => expect((await copilotSnapshot(id)).turns[0]?.reply).toBe('已分析查体。'))
      const issued = await send('POST', investigationsPath(id), { catalogItemIds: ['cbc'] })
      const { investigations: [cbc] } = (await issued.json()) as InvestigationsResponse
      const releaseAt = Date.parse(cbc.expectedReportAt)
      vi.setSystemTime(releaseAt + 1)
      expect(await runDurableObjectAlarm(workspace())).toBe(true)
      await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(id))
      await vi.waitFor(async () => expect((await copilotSnapshot(id)).turns[1]?.reply).toBe('已分析报告。'))
      expect((await copilotSnapshot(id)).turns).toHaveLength(2)

      vi.setSystemTime(releaseAt + 120_001)
      expect(await runDurableObjectAlarm(workspace())).toBe(true)
      await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(id))
      await vi.waitFor(async () => expect((await copilotSnapshot(id)).turns[2]?.reply).toBe('已分析更正。'))
      await send('GET', investigationsPath(id))
      const snapshot = await copilotSettled(id)
      expect(snapshot.turns.map(({ trigger }) => trigger.text)).toEqual([
        expect.stringContaining('查体完成'),
        expect.stringContaining('报告发布'),
        expect.stringContaining('报告更正'),
      ])
      expect(snapshot.pendingAnalysis).toEqual([])
      expect(llm.requests).toHaveLength(3)
    } finally {
      bridge.close()
    }
  } finally {
    vi.useRealTimers()
  }
})
