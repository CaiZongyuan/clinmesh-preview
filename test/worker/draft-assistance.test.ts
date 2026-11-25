import { expect, it } from 'vitest'
import type { DraftAction, DraftAssistanceResponse } from '../../src/shared/draft-assistance'
import { api, copilotSettled, promptCopilot, send, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const path = (id: string) => `/api/encounters/${id}`
const propose = (id: string, proposal: string, action: DraftAction, runId: string | null = null) =>
  send('POST', `${path(id)}/draft-assistance`, { command: 'propose', id: proposal, runId, action, protect: false })
const resolve = (id: string, proposal: string, command: 'accept' | 'dismiss' | 'undo') =>
  send('POST', `${path(id)}/draft-assistance`, { command, id: proposal })

it.each([
  ['investigations', 'cbc'],
  ['diagnosis', 'I10'],
  ['prescriptions', 'doxycycline'],
] as const)('applies a safe %s draft and saves later proposals after the doctor edits it', async (module, itemId) => {
  const id = await startEncounter()
  const first = await propose(id, 'first', { module, itemId })
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ outcome: 'applied', change: { module } })
  expect((await send('PUT', `${path(id)}/${module}/draft`, { entries: [] })).ok).toBe(true)

  const suggested = await propose(id, 'second', { module, itemId })
  expect(await suggested.json()).toMatchObject({
    outcome: 'suggestion', assistance: { suggestions: [{ id: 'second', action: { module, itemId } }] },
  })
  const read = await api(`${path(id)}/draft-assistance`)
  expect(await read.json()).toMatchObject({ assistance: { touched: [module], suggestions: [{ id: 'second' }] } })
  const accepted = await resolve(id, 'second', 'accept')
  expect(await accepted.json()).toMatchObject({ outcome: 'applied', assistance: { suggestions: [] }, change: { module } })
  const undone = await resolve(id, 'second', 'undo')
  expect(await undone.json()).toMatchObject({ assistance: { suggestions: [{ id: 'second' }] } })
})

it('refuses completion atomically while any Suggestion remains and allows it after dismissal', async () => {
  const id = await startEncounter()
  await send('POST', `${path(id)}/diagnosis/revisions`, { entries: [{ code: 'I10', primary: true, source: 'doctor' }] })
  await send('POST', `${path(id)}/no-medication`)
  await send('POST', `${path(id)}/clinical-note/revisions`, { sections: {
    'chief-complaint': '发热。', 'present-illness': '发热三天。', 'past-history': '', findings: '', assessment: '', plan: '',
  } })
  await send('POST', `${path(id)}/draft-assistance`, {
    command: 'propose', id: 'focused-plan', runId: null, action: { module: 'note', section: 'plan', text: '适时复诊。' }, protect: true,
  })
  const [a, b] = await Promise.all([send('POST', `${path(id)}/completion`), send('POST', `${path(id)}/completion`)])
  for (const result of [a, b]) {
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: { code: 'completion-gates-unmet', failedGates: ['drafts'] } })
  }
  expect((await resolve(id, 'focused-plan', 'dismiss')).ok).toBe(true)
  expect((await send('POST', `${path(id)}/completion`)).ok).toBe(true)
  expect((await propose(id, 'late', { module: 'diagnosis', itemId: 'I10' })).status).toBe(409)
})

it('counts the distinct drafts already committed for a stopped turn', async () => {
  const id = await startEncounter()
  const llm = installScripted('copilot')
  const gate = llm.gate('读取资料', '不会继续。')
  try {
    const prompted = await promptCopilot(id, 'stop-count', '分析就诊')
    const { turnId } = await prompted.json() as { turnId: string }
    await gate.reached
    const first = await propose(id, 'a', { module: 'investigations', itemId: 'cbc' }, turnId)
    expect((await first.json() as DraftAssistanceResponse).outcome).toBe('applied')
    await propose(id, 'a', { module: 'investigations', itemId: 'cbc' }, turnId)
    await propose(id, 'b', { module: 'diagnosis', itemId: 'I10' }, turnId)
    expect((await send('POST', `${path(id)}/copilot/stop`)).ok).toBe(true)
    expect((await copilotSettled(id)).turns).toContainEqual(expect.objectContaining({ keptDrafts: 2, status: 'stopped' }))
    const drafts = await api(`${path(id)}/clinical-drafts`)
    expect(await drafts.json()).toMatchObject({ drafts: { investigations: ['cbc'] } })
  } finally {
    gate.release()
  }
})
