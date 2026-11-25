import { expect, it, vi } from 'vitest'
import type { CopilotContextView } from '../../src/shared/copilot-context'
import { asked, copilotSettled, copilotSnapshot, promptAndSettle, promptCopilot, send, settled, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const contextOf = async (encounterId: string): Promise<CopilotContextView> => {
  const response = await send('GET', `/api/encounters/${encounterId}/copilot/context`)
  expect(response.status).toBe(200)
  return (await response.json<{ context: CopilotContextView }>()).context
}

it('shows precisely the next request context including visible patient data and consultation', async () => {
  installScripted('patient').reply('今天比昨天好些')
  const llm = installScripted('copilot').reply('知道了')
  const encounterId = await startEncounter()
  await settled(encounterId, (await asked(encounterId, '最近好些了吗？')).patientTurn.turnId)
  const before = await contextOf(encounterId)
  await promptAndSettle(encounterId, 'context-review', '总结')
  expect(llm.requests[0].messages[0].content).toContain('今天比昨天好些')
  expect(before.items.map(({ category }) => category)).toEqual(expect.arrayContaining(['system', 'patient_visible', 'consultation', 'his_state_ui', 'tools']))
  expect(before.items.find(({ category }) => category === 'consultation')?.text).toContain('今天比昨天好些')
})

it('leaves no compaction marker or context write once the encounter is abandoned', async () => {
  const llm = installScripted('copilot').reply('原始回复')
  const gate = llm.gate('摘要', '结束')
  const encounterId = await startEncounter()
  await promptAndSettle(encounterId, 'before-compaction-review', '总结')
  expect((await send('POST', `/api/encounters/${encounterId}/copilot/compact`)).status).toBe(202)
  try {
    await gate.reached
    expect((await send('POST', `/api/encounters/${encounterId}/abandonment`)).status).toBe(200)
  } finally {
    gate.release()
  }
  await vi.waitFor(async () => {
    expect((await copilotSnapshot(encounterId)).checkpoint).toBeGreaterThan(1)
  })
  expect((await copilotSnapshot(encounterId)).compactions).toEqual([])
})

it('does not carry material from a superseded turn through a compaction summary', async () => {
  const llm = installScripted('copilot')
    .reply('旧回答：先前资料甲')
    .reply('摘要保留了先前资料甲')
    .reply('这是修改后的回答')
  const encounterId = await startEncounter()
  const { snapshot } = await promptAndSettle(encounterId, 'context-old', '按先前资料甲总结')
  const original = snapshot.turns[0].turnId
  await compactAndWait(encounterId)
  expect((await send('POST', `/api/encounters/${encounterId}/copilot/turns/${original}/resend`, {
    clientPromptId: 'context-replacement', text: '用新资料乙总结', mentions: [],
  })).status).toBe(201)
  await copilotSettled(encounterId)
  expect(llm.requests).toHaveLength(3)
  expect(JSON.stringify(llm.requests[2].messages)).not.toContain('先前资料甲')
})

it('serializes the compaction LLM call with the regular Copilot prompt queue', async () => {
  const llm = installScripted('copilot').reply('原始回复')
  const gate = llm.gate('摘要', '结束')
  llm.reply('普通回复')
  const encounterId = await startEncounter()
  await promptAndSettle(encounterId, 'initial-context', '总结')
  expect((await send('POST', `/api/encounters/${encounterId}/copilot/compact`)).status).toBe(202)
  try {
    await gate.reached
    expect((await promptCopilot(encounterId, 'parallel-context', '下一步')).status).toBe(201)
    expect((await copilotSnapshot(encounterId)).queued).toHaveLength(1)
    expect(llm.requests).toHaveLength(2)
  } finally {
    gate.release()
  }
  await copilotSettled(encounterId)
  expect(llm.requests).toHaveLength(3)
})

async function compactAndWait(encounterId: string) {
  expect((await send('POST', `/api/encounters/${encounterId}/copilot/compact`)).status).toBe(202)
  await vi.waitFor(async () => expect((await copilotSnapshot(encounterId)).compactions).toHaveLength(1))
}

it('retains valid material older than a re-sent turn after compaction', async () => {
  const llm = installScripted('copilot')
    .reply('第一轮：仍有效资料甲')
    .reply('第二轮：旧资料乙')
    .reply('摘要：仍有效资料甲与旧资料乙')
    .reply('修改后的回复')
  const encounterId = await startEncounter()
  await promptAndSettle(encounterId, 'prior-valid', '仍有效资料甲')
  const { snapshot } = await promptAndSettle(encounterId, 'prior-replaced', '旧资料乙')
  const target = snapshot.turns[1].turnId
  await compactAndWait(encounterId)
  expect((await send('POST', `/api/encounters/${encounterId}/copilot/turns/${target}/resend`, {
    clientPromptId: 'new-replacement', text: '用新资料丙总结', mentions: [],
  })).status).toBe(201)
  await copilotSettled(encounterId)
  expect(llm.requests).toHaveLength(4)
  const corrected = JSON.stringify(llm.requests[3].messages)
  expect(corrected).not.toContain('旧资料乙')
  expect(corrected).toContain('仍有效资料甲')
})
