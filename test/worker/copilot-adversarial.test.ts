import { abortAllDurableObjects, env, runDurableObjectAlarm } from 'cloudflare:test'
import { expect, it } from 'vitest'
import type { AuditEventsResponse } from '../../src/shared/encounter'
import { ClinicalCopilotDO } from '../../src/worker/clinical-copilot/clinical-copilot-do'
import { copilotSettled, promptCopilot, send, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

it('retains usage from completed tool steps across recovery', async () => {
  const llm = installScripted('copilot').toolCall('read_released_reports', {})
  const gate = llm.gate('临时片段', '崩溃前')
  llm.reply('恢复后的回答')
  const encounterId = await startEncounter()
  expect((await promptCopilot(encounterId, 'adversarial-usage', '总结报告')).status).toBe(201)
  await gate.reached
  await abortAllDurableObjects()
  expect(await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(encounterId))).toBe(true)
  const snapshot = await copilotSettled(encounterId)
  expect(llm.requests).toHaveLength(3)
  expect(llm.requests[2].messages.find(({ role }) => role === 'tool')).toBeDefined()
  expect(snapshot.turns[0]).toMatchObject({ status: 'done', reply: '恢复后的回答', usage: { in: 150, out: 16 } })
})

it('does not finish running analysis after abandonment', async () => {
  const llm = installScripted('copilot')
  const gate = llm.gate('未完待续', '仍会继续')
  const encounterId = await startEncounter()
  try {
    expect((await promptCopilot(encounterId, 'adversarial-freeze', '总结报告')).status).toBe(201)
    await gate.reached
    expect((await send('POST', `/api/encounters/${encounterId}/abandonment`)).status).toBe(200)
  } finally {
    gate.release()
  }
  const snapshot = await copilotSettled(encounterId)
  expect(snapshot.turns[0]).toMatchObject({ status: 'stopped', stopReason: 'encounter-ended' })
})

it('never returns a successful unaudited prompt when abandonment crosses a Copilot RPC', async () => {
  installScripted('copilot').reply('回答')
  const encounterId = await startEncounter()
  const original = ClinicalCopilotDO.prototype.prompt
  let entered = false
  let released = false
  Object.defineProperty(ClinicalCopilotDO.prototype, 'prompt', {
    async value(this: ClinicalCopilotDO, ...args: Parameters<typeof original>) {
      if (args[0] === encounterId) {
        entered = true
        while (!released) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return original.apply(this, args)
    },
  })
  const prompting = promptCopilot(encounterId, 'adversarial-audit', '总结报告')
  try {
    for (let polls = 0; !entered && polls < 100; polls++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(entered).toBe(true)
    expect((await send('POST', `/api/encounters/${encounterId}/abandonment`)).status).toBe(200)
  } finally {
    released = true
    Object.defineProperty(ClinicalCopilotDO.prototype, 'prompt', { value: original })
  }
  const response = await prompting
  const audits = await (await send('GET', `/api/encounters/${encounterId}/audit-events`)).json<AuditEventsResponse>()
  expect(response.status !== 201 || audits.auditEvents.some(({ eventType }) => eventType === 'copilot-prompted')).toBe(true)
})
