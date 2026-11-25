import { abortAllDurableObjects, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
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

// Compaction is a serialized run: the route queues it, and the marker lands when it completes.
// A compaction whose provider fails: the queued run closes failed and no marker ever lands.
const compactAndSettleFail = async (encounterId: string): Promise<void> => {
  const response = await compact(encounterId)
  expect(response.status).toBe(202)
  // Drive the alarm so the queued compaction claims and its provider call fails.
  expect(await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(encounterId))).toBe(true)
  expect((await contextOf(encounterId)).compactions).toHaveLength(0)
}

const compactAndSettle = async (encounterId: string): Promise<void> => {
  const before = (await contextOf(encounterId)).compactions.length
  const response = await compact(encounterId)
  if (response.status !== 202) console.log('COMPACT-BODY', await response.text())
  expect(response.status).toBe(202)
  await vi.waitFor(async () => {
    expect((await contextOf(encounterId)).compactions.length).toBeGreaterThan(before)
  })
  await copilotSettled(encounterId)
}

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

    // The current context is assembled on the same path as an outbound request: the itemized system
    // sections reconstruct the outbound system message exactly, and every required category is counted.
    const outboundSystem = llm.requests.at(-1)!.messages[0]
    expect(outboundSystem.role).toBe('system')
    const systemItems = view.items.filter((item) => ['system', 'patient_visible', 'his_state_ui', 'consultation'].includes(item.category))
    expect(systemItems.map((item) => item.text).join('\n\n')).toBe(outboundSystem.content)
    const categories = new Set(view.items.map((item) => item.category))
    for (const category of ['system', 'patient_visible', 'his_state_ui', 'consultation', 'replies_thinking', 'tools', 'tool_results']) {
      expect(categories.has(category as (typeof view.items)[number]['category']), `missing category ${category}`).toBe(true)
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

    await compactAndSettle(encounterId)
    const view = await contextOf(encounterId)
    const marker = view.compactions[0]
    expect(marker.summarizedMessages).toBeGreaterThanOrEqual(4)
    expect(marker.tokensAfter).toBeLessThan(marker.tokensBefore)

    // The marker lives in the session too, and the compaction's own provider call is on the timeline.
    const snapshot = await copilotSnapshot(encounterId)
    expect(snapshot.compactions).toHaveLength(1)
    expect(view.requests.some((request) => request.runId === marker.runId)).toBe(true)
    expect(view.requests.some((request) => request.items.some((item) => item.label === '压缩指令'))).toBe(true)
    // The rolling messages are gone from the current context; the summary is there instead.
    const current = JSON.stringify(view.items)
    expect(current).not.toContain('回复一')
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
    expect(outbound.messages.some((m) => m.role === 'assistant' && m.content.includes('回复一'))).toBe(false)
    expectNoCaseTruth('post-compaction requests', JSON.stringify(outbound))
    // The summarizer saw exactly the rolling conversation (the two replies, not the system context).
    const summarizer = compactor.requests.at(-1)!
    expect(summarizer.messages.some((m) => m.role === 'user' && m.content.includes('回复一'))).toBe(true)
    expect(summarizer.messages.some((m) => m.content.includes('患者与分诊'))).toBe(false)
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
    await compactAndSettle(encounterId)

    // Everything rolling is already one summary; compacting again finds nothing.
    const again = await compact(encounterId)
    expect(again.status).toBe(409)
  })

  it('serializes compaction with ordinary turns: a prompt enqueued during compaction runs after it', async () => {
    installScripted('copilot').reply('回复：患者三天前出现发热，建议先休息、多饮水并观察体温，必要时复诊评估。')
    const encounterId = await startEncounter()
    await promptCopilot(encounterId, 't1', '总结')
    await copilotSettled(encounterId)
    // Gate the compaction's summarization; a prompt enqueued meanwhile must wait behind it.
    const compaction = installScripted('copilot').gate('摘要中', '摘要：发热三天')
    const response = await compact(encounterId)
    expect(response.status).toBe(202)
    const queued = await promptCopilot(encounterId, 't2', '压缩完再总结', 'queue')
    expect(queued.status).toBe(201)
    compaction.release()
    // The compaction run is invisible to the session (only its marker shows), so wait on the marker,
    // then on the prompt that was queued behind it.
    await vi.waitFor(async () => {
      expect((await contextOf(encounterId)).compactions).toHaveLength(1)
    })
    await copilotSettled(encounterId)
    const view = await contextOf(encounterId)
    expect(view.compactions).toHaveLength(1)
    // The compaction ran before the prompt: its request precedes the prompt's on the timeline, and the
    // prompt was built from the compacted context (no raw transcript request afterwards).
    const compactionRequest = view.requests.find((request) => request.runId === view.compactions[0].runId)!
    const promptRequest = view.requests.filter((request) => request.runId !== view.compactions[0].runId).at(-1)!
    expect(compactionRequest.at <= promptRequest.at).toBe(true)
    expect(promptRequest.items.some((item) => item.label === '待压缩对话历史')).toBe(false)
  })

  it('abandonment cancels an in-flight compaction: no marker, no rewritten context, and later compaction is refused', async () => {
    installScripted('copilot').reply('回复：患者三天前出现发热，伴咳嗽，查体未见明显异常，建议观察并必要时复查血常规进一步评估。')
    const encounterId = await startEncounter()
    await promptCopilot(encounterId, 't1', '总结')
    await copilotSettled(encounterId)
    const compaction = installScripted('copilot').gate('摘要中', '摘要：发热三天')
    expect((await compact(encounterId)).status).toBe(202)
    await compaction.reached
    await send('POST', `/api/encounters/${encounterId}/abandonment`)
    compaction.release()
    // Wait until the compaction run has closed (stopped), deterministically, before asserting nothing settled.
    await vi.waitFor(async () => {
      await runInDurableObject(env.CLINICAL_COPILOT.getByName(encounterId), (_i, state) => {
        const statuses = state.storage.sql
          .exec<{ status: string }>("SELECT status FROM agent_run WHERE kind = 'compaction'")
          .toArray()
        expect(statuses.every((row) => row.status !== 'running' && row.status !== 'queued')).toBe(true)
      })
    })
    const view = await contextOf(encounterId)
    // The frozen Encounter kept its context: no marker, rolling history still active.
    expect(view.compactions).toHaveLength(0)
    expect(JSON.stringify(view.items)).toContain('三天前')
    // A frozen Encounter takes no new compaction.
    installScripted('copilot').reply('摘要')
    expect((await compact(encounterId)).status).toBe(409)
  })

  it('edit-and-resend after compaction leaves no stale facts: the superseded summary leaves the context', async () => {
    installScripted('patient').reply('医生，我发烧三天了。')
    const llm = installScripted('copilot').reply('回复：已记录患者三天前出现发热。')
    const encounterId = await startEncounter()
    await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
    await promptCopilot(encounterId, 't1', '请记住资料甲：三天前起病')
    await copilotSettled(encounterId)
    installScripted('copilot').reply('摘要：资料甲（三天前起病）已记录')
    await compactAndSettle(encounterId)

    // Edit-and-resend t1 with replacement facts: the compaction run and its summary are superseded with it.
    installScripted('patient').reply('好的。')
    const snapshot = await copilotSnapshot(encounterId)
    const resent = await send('POST', `/api/encounters/${encounterId}/copilot/turns/${snapshot.turns[0].turnId}/resend`, {
      clientPromptId: 'resend-1',
      text: '请记住资料乙：今天起病',
      mentions: [],
    })
    expect(resent.status).toBe(201)
    installScripted('copilot').reply('回复：已改为记录资料乙。')
    await copilotSettled(encounterId)
    const replacement = llm.requests.at(-1)!
    void replacement
    const view = await contextOf(encounterId)
    const current = JSON.stringify(view.items)
    // Neither the compacted originals nor the derived summary may resurrect the superseded fact.
    expect(current).not.toContain('资料甲')
    expect(current).toContain('资料乙')
  })

  it('a failing provider leaves the rolling inputs untouched: retry stays possible and no marker lands', async () => {
    installScripted('copilot').reply('回复：患者三天前出现发热，建议观察体温变化，必要时复诊。')
    const encounterId = await startEncounter()
    await promptCopilot(encounterId, 't1', '总结')
    await copilotSettled(encounterId)
    installScripted('copilot').fail(500)
    await compactAndSettleFail(encounterId)
    const view = await contextOf(encounterId)
    expect(view.compactions).toHaveLength(0)
    // The inputs are still active, so a retried compaction has the same material to summarize.
    installScripted('copilot').reply('摘要：发热三天')
    await compactAndSettle(encounterId)
    expect((await contextOf(encounterId)).compactions).toHaveLength(1)
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
