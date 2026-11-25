import { abortAllDurableObjects, env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { CopilotContextView } from '../../src/shared/copilot-context'
import { expectNoCaseTruth } from './case-truth'
import { asked, copilotSettled, copilotSnapshot, promptAndSettle, promptCopilot, send, settled, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

const contextOf = async (encounterId: string): Promise<CopilotContextView> => {
  const response = await send('GET', `/api/encounters/${encounterId}/copilot/context`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { context: CopilotContextView }).context
}

const compact = async (encounterId: string) => send('POST', `/api/encounters/${encounterId}/copilot/compact`)

describe('Copilot context accounting', () => {
  it('itemizes every outbound request by category and reconciles estimates with the provider usage', async () => {
    const llm = installScripted('copilot').toolCall('read_encounter_state', {}).reply('根据就诊状态，……')
    const encounterId = await startEncounter()
    await promptAndSettle(encounterId, 't1', '总结一下目前的情况')

    // One breakdown per LLM call, in request order.
    expect(llm.requests).toHaveLength(2)
    const view = await contextOf(encounterId)
    expect(view.requests).toHaveLength(2)

    // The recorded items are what the raw outbound request carried: the system sections, the doctor prompt
    // and the tool result, plus the tool definitions.
    for (const [i, request] of view.requests.entries()) {
      const outbound = llm.requests[i]
      expect(outbound.messages[0]?.role).toBe('system')
      expect(request.items.map((item) => item.category)).toEqual(
        expect.arrayContaining(['system', 'his_state_ui', 'consultation', 'replies_thinking', 'tools']),
      )
      expect(request.estimatedInput).toBe(request.items.reduce((sum, item) => sum + item.tokens, 0))
    }
    // The tool step reported its own usage (input 50); the final step's share is the run's reported input
    // (150) minus the tool steps'. Both are reconciled: the scaled categories sum exactly to the provider input.
    expect(view.requests[0].providerInput).toBe(50)
    expect(view.requests[1].providerInput).toBe(100)
    for (const request of view.requests) {
      expect(request.reconciled).not.toBeNull()
      expect(request.reconciled!.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(request.providerInput!)
    }

    // The window/reserve arithmetic is consistent, and the Case Truth row is always present and zero.
    expect(view.modelWindow).toBe(128000)
    expect(view.usable).toBe(view.modelWindow - view.reserve)
    expect(view.caseTruth).toEqual({ tokens: 0, isolated: true })
    expect(view.estimatedInput).toBe(view.items.reduce((sum, item) => sum + item.tokens, 0))
    expectNoCaseTruth('Copilot context view', JSON.stringify(view))
  })

  it('carries the raw outbound context: system prompt, re-injected consultation and durable messages', async () => {
    installScripted('patient').reply('医生，我发烧三天了。')
    const llm = installScripted('copilot').reply('好的。').reply('还在。')
    const encounterId = await startEncounter()
    await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
    await promptAndSettle(encounterId, 't1', '总结')
    await promptAndSettle(encounterId, 't2', '还在吗')

    const second = llm.requests[1]
    expect(second.messages[0].role).toBe('system')
    expect(second.messages[0].content).toContain('Clinical Copilot')
    expect(second.messages[0].content).toContain('我发烧三天了')
    expect(second.messages.at(-1)?.content).toContain('还在吗')
    // The first turn's reply stays in the durable context; the re-injected consultation is there too.
    expect(second.messages.some((m) => m.role === 'assistant' && m.content.includes('好的。'))).toBe(true)
    expectNoCaseTruth('raw Copilot requests', JSON.stringify(llm.requests))
  })

  it('manual compaction summarizes replies into one persisted message and keeps consultation and HIS state', async () => {
    installScripted('patient').reply('医生，我发烧三天了。')
    const compactor = installScripted('copilot')
      .reply('回复一：根据问诊记录，患者三天前出现发热，无明显咳嗽咳痰，目前考虑急性上呼吸道感染可能，建议休息、多饮水，必要时查血常规进一步评估。')
      .reply('回复二：已读取就诊状态与既往资料，未见过敏史记录，目前资料仍不足以明确诊断，建议继续观察体温变化并完善检查。')
    // The third script is the compaction's own summarization call.
    compactor.reply('摘要：发热三天，已答两次')
    const encounterId = await startEncounter()
    await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
    await promptAndSettle(encounterId, 't1', '总结')
    await promptAndSettle(encounterId, 't2', '再来一次')

    const response = await compact(encounterId)
    expect(response.status).toBe(201)
    const marker = (await response.json()) as { markerId: number; summarizedMessages: number; tokensBefore: number; tokensAfter: number }

    expect(marker.summarizedMessages).toBeGreaterThanOrEqual(4)
    expect(marker.tokensAfter).toBeLessThan(marker.tokensBefore)

    // The marker lives in the session and in the context view.
    const snapshot = await copilotSnapshot(encounterId)
    expect(snapshot.compactions).toHaveLength(1)
    const view = await contextOf(encounterId)
    expect(view.compactions).toHaveLength(1)
    // The rolling messages are gone from the current context; the summary is there instead.
    const current = JSON.stringify(view.items)
    expect(current).not.toContain('回复一。')
    expect(current).toContain('摘要：发热三天')

    // Future prompts carry the summary plus the re-injected live clinic and consultation data.
    installScripted('patient').reply('好些了。')
    const llm = installScripted('copilot').reply('收到。')
    await settled(encounterId, (await asked(encounterId, '现在好些了吗？')).patientTurn.turnId)
    await promptAndSettle(encounterId, 't3', '谢谢')
    const outbound = llm.requests.at(-1)!
    const system = outbound.messages[0]
    expect(system.role).toBe('system')
    expect(system.content.includes('好些了'), `system: ${system.content}`).toBe(true)
    expect(system.content.includes('现在好些了吗'), `system: ${system.content}`).toBe(true)
    expect(outbound.messages.some((m) => m.role === 'assistant' && m.content.includes('摘要：发热三天'))).toBe(true)
    expect(outbound.messages.some((m) => m.role === 'assistant' && m.content.includes('回复一。'))).toBe(false)
    expectNoCaseTruth('post-compaction requests', JSON.stringify(outbound))
    // The summarizer saw exactly the rolling conversation (the two replies, not the system context).
    const summarizer = compactor.requests.at(-1)!
    expect(summarizer.messages.some((m) => m.role === 'user' && m.content.includes('回复一'))).toBe(true)
    expect(summarizer.messages.some((m) => m.content.includes('当前就诊概况'))).toBe(false)
  })

  it('refuses compaction while a turn runs, and twice in a row when there is nothing left to summarize', async () => {
    installScripted('copilot').reply('回复：根据问诊记录，患者三天前出现发热，目前考虑急性上呼吸道感染，建议休息、多饮水，必要时查血常规进一步评估。')
    const encounterId = await startEncounter()

    // Nothing to compact on a fresh session.
    const empty = await compact(encounterId)
    if (empty.status !== 409) console.log('EMPTY-BODY', await empty.text())
    expect(empty.status).toBe(409)

    await promptCopilot(encounterId, 't1', '总结')
    await copilotSettled(encounterId)
    installScripted('copilot').reply('摘要')
    expect((await compact(encounterId)).status).toBe(201)

    // Everything rolling is already one summary; compacting again finds nothing.
    const again = await compact(encounterId)
    expect(again.status).toBe(409)
  })

  it('refuses compaction while a run is running, even one waiting on a gate', async () => {
    const llm = installScripted('copilot').gate('分析中', '完成')
    const encounterId = await startEncounter()
    await promptCopilot(encounterId, 't1', '慢慢总结')
    await llm.reached
    const busy = await compact(encounterId)
    expect(busy.status).toBe(409)
    llm.release()
    await copilotSettled(encounterId)
  })

  it('records the accounting on recovery too: a run resumed from its checkpoint keeps its breakdown', async () => {
    const llm = installScripted('copilot').gate('部分', '完成')
    const encounterId = await startEncounter()
    await promptCopilot(encounterId, 't1', '总结')
    await llm.reached
    await abortAllDurableObjects()
    await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(encounterId))
    await copilotSettled(encounterId)
    const view = await contextOf(encounterId)
    expect(view.requests.length).toBeGreaterThanOrEqual(1)
    for (const request of view.requests) {
      expect(request.estimatedInput).toBeGreaterThan(0)
      expect(request.items.length).toBeGreaterThan(0)
    }
  })
})
