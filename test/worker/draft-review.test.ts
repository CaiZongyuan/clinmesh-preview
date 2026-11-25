import { expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { DraftAction, DraftAssistanceResponse } from '../../src/shared/draft-assistance'
import { copilotSettled, promptCopilot, send, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const path = (id: string) => `/api/encounters/${id}`
const propose = (id: string, proposal: string, action: DraftAction, runId: string | null = null) =>
  send('POST', `${path(id)}/draft-assistance`, { command: 'propose', id: proposal, runId, action, protect: false })

it('rejects a draft action that reaches the workspace after Stop', async () => {
  const id = await startEncounter()
  const gate = installScripted('copilot').gate('读取资料', '已停止')
  const response = await promptCopilot(id, 'review-stop', '分析就诊')
  const { turnId } = await response.json<{ turnId: string }>()
  try {
    await gate.reached
    expect((await propose(id, 'early', { module: 'investigations', itemId: 'cbc' }, turnId)).ok).toBe(true)
    expect((await send('POST', `${path(id)}/copilot/stop`)).ok).toBe(true)
    expect((await copilotSettled(id)).turns[0]).toMatchObject({ status: 'stopped', keptDrafts: 1 })
    const delayed = await propose(id, 'delayed', { module: 'diagnosis', itemId: 'I10' }, turnId)
    expect(delayed.status).toBe(409)
    expect(await delayed.json()).toMatchObject({ error: { code: 'copilot-run-stopped' } })
    expect((await copilotSettled(id)).turns[0]).toMatchObject({ status: 'stopped', keptDrafts: 1 })
    expect(await (await send('GET', `${path(id)}/diagnosis`)).json()).toMatchObject({ diagnosis: { draft: [] } })
  } finally {
    gate.release()
  }
})

it('clears assistant attribution when the doctor edits a proposed prescription', async () => {
  const id = await startEncounter()
  const applied = await (await propose(id, 'med', { module: 'prescriptions', itemId: 'doxycycline' })).json<DraftAssistanceResponse>()
  expect(applied.assistance.assistantItems.prescriptions).toEqual(['doxycycline'])
  expect(applied.change?.module).toBe('prescriptions')
  if (applied.change?.module !== 'prescriptions') throw new Error('missing prescription change')
  const [entry] = applied.change.drafts.prescriptions
  const save = await send('PUT', `${path(id)}/prescriptions/draft`, { entries: [{ ...entry, days: entry.days + 1 }] })
  expect(save.ok).toBe(true)
  const state = await send('GET', `${path(id)}/draft-assistance`)
  expect(await state.json()).toMatchObject({ assistance: { assistantItems: { prescriptions: [] } } })
})

it('protects a doctor draft persisted before the module-touch migration', async () => {
  const id = await startEncounter()
  expect((await send('PUT', `${path(id)}/investigations/draft`, { entries: ['cbc'] })).ok).toBe(true)
  await runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
    state.storage.sql.exec('DELETE FROM doctor_draft_touch WHERE encounter_id = ?', id)
  })
  const response = await propose(id, 'upgrade-review', { module: 'investigations', itemId: 'cxr' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ outcome: 'suggestion', assistance: { suggestions: [{ id: 'upgrade-review' }] } })
})
