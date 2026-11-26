import type { ServerMessage } from '../../src/shared/agent-wire'
import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { installScripted } from './support/scripted-llm'
import { asked, api, eventsOf, openCopilotBridgeSocket, send, settled, startEncounter } from './support/clinic'
import { expectNoCaseTruth } from './case-truth'
import { prompt, serveBridge, snapshotWithConfirm } from './support/bridge'

// The doctor's question that sets up a scripted exchange, finalized like every real consultation turn.
async function withConsultation(exchange: 'none' | 'one' = 'none'): Promise<string> {
  const encounterId = await startEncounter()
  if (exchange === 'one') {
    installScripted('patient').reply('我三天前开始发烧，一直咳嗽。')
    await finalized(encounterId, '您哪里不舒服？')
  }
  return encounterId
}

async function finalized(encounterId: string, question: string) {
  await settled(encounterId, (await asked(encounterId, question)).patientTurn.turnId)
  return vi.waitFor(async () => {
    const pending = (await snapshotOf(encounterId)).countdown
    expect(pending?.text).toBe(`问诊定稿：${question}`)
    return pending!
  }, { timeout: 3000, interval: 20 })
}

const flush = (encounterId: string, ref: string) => send('POST', `/api/encounters/${encounterId}/copilot/triggers/${encodeURIComponent(ref)}/flush`)
const skip = (encounterId: string, ref: string) => send('DELETE', `/api/encounters/${encounterId}/copilot/triggers/${encodeURIComponent(ref)}`)
// Waits until some turn in the session carries a tool step named `tool` (the session starts empty, so
// "no turn is running" alone is vacuously true before the run has begun).
const waitForTool = async (encounterId: string, tool: string, timeout = 12000) =>
  vi.waitFor(
    async () => {
      const snapshot = await snapshotOf(encounterId)
      const step = snapshot.turns.flatMap((t) => t.steps).find((s) => s.name === tool)
      expect(step, JSON.stringify(snapshot)).toBeDefined()
      return step!
    },
    { timeout, interval: 20 },
  )

const snapshotOf = async (encounterId: string) => {
  const response = await send('GET', `/api/encounters/${encounterId}/copilot`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { snapshot: { countdown: { ref: string; text: string; fireAt: string } | null; turns: { turnId: string; trigger: { kind: string; text: string }; steps: { name: string; state: string; subject: string; result: string }[]; status: string }[]; queued: { text: string }[] } }).snapshot
}

describe('ui-sdk bridge (#14)', () => {
  it('replays the patient viewer in sequence before delivering live events', async () => {
    const encounterId = await startEncounter()
    installScripted('patient').reply('我咳嗽三天了。')
    const response = await api(`/api/encounters/${encounterId}/patient/socket`, { headers: { upgrade: 'websocket' } })
    expect(response.status).toBe(101)
    const ws = response.webSocket!
    const received: ServerMessage[] = []
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)) as ServerMessage)
    })
    ws.accept()
    try {
      const turn = (await asked(encounterId, '咳了几天？')).patientTurn
      await settled(encounterId, turn.turnId)
      ws.send(JSON.stringify({ type: 'hello', afterSeq: 0 }))
      await vi.waitFor(() => expect(received.some((message) => message.type === 'replay.done')).toBe(true))
      const events = eventsOf(received)
      expect(events[0]).toMatchObject({ type: 'run.started', ref: turn.turnId })
      expect(events.map((event) => event.seq)).toEqual([...new Set(events.map((event) => event.seq))].sort((a, b) => a - b))
    } finally {
      ws.close()
    }
  })

  it.each(['/copilot/stop', '/abandonment'])('cancels a pending browser action on %s', async (path) => {
    const encounterId = await startEncounter()
    const llm = installScripted('copilot')
      .toolCall('ui_act', { steps: [{ ref: 'c1', action: 'setValue', args: ['晚到的草稿'] }] })
      .reply('不应继续运行。')
    const bridge = await openCopilotBridgeSocket(encounterId)
    bridge.ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; callId: string; tool?: string }
      if (frame.type === 'bridge.call' && frame.tool === 'ui_snapshot') {
        bridge.ws.send(JSON.stringify({ type: 'bridge.result', callId: frame.callId, ok: true, result: snapshotWithConfirm() }))
      }
    })
    try {
      expect((await prompt(encounterId, 'pending-browser-action', '请编辑草稿')).status).toBe(201)
      await bridge.waitFor((messages) => messages.some((frame) => frame.type === 'bridge.call' && frame.tool === 'ui_act'))
      const call = bridge.messages.find((frame) => frame.type === 'bridge.call' && frame.tool === 'ui_act')!
      expect((await send('POST', `/api/encounters/${encounterId}${path}`)).ok).toBe(true)
      await bridge.waitFor((messages) => messages.some((frame) => (frame as { type: string }).type === 'bridge.cancel'), 1000)
      expect(bridge.messages).toContainEqual({ type: 'bridge.cancel', callId: (call as { callId: string }).callId })
      expect(llm.requests).toHaveLength(1)
    } finally {
      bridge.close()
    }
  })


  it('a finalized consultation turn starts a ~1.2s countdown; 立即 flushes it into a run; 跳过 discards it', async () => {
    const encounterId = await withConsultation('one')
    const snapshot = await snapshotOf(encounterId)
    expect(snapshot.countdown).not.toBeNull()
    expect(snapshot.countdown!.ref).toMatch(/^consultation:/)
    expect(snapshot.countdown!.text).toContain('问诊定稿')
    const fireAt = Date.parse(snapshot.countdown!.fireAt)
    expect(fireAt - Date.now()).toBeGreaterThan(600)
    expect(fireAt - Date.now()).toBeLessThanOrEqual(1200)

    // 立即: the countdown becomes a run at once.
    const flushed = await flush(encounterId, snapshot.countdown!.ref)
    expect(flushed.status).toBe(201)
    expect((await snapshotOf(encounterId)).countdown).toBeNull()
    await vi.waitFor(async () => expect((await snapshotOf(encounterId)).queued).toEqual([]))
    expect((await snapshotOf(encounterId)).turns.at(-1)?.trigger.kind).toBe('event')

    // A second finalized turn: 跳过 discards the trigger without queueing a run.
    installScripted('patient').reply('还有点怕冷。')
    await finalized(encounterId, '怕冷吗？')
    const before = await snapshotOf(encounterId)
    const countdown = before.countdown
    expect(countdown).not.toBeNull()
    const skipped = await skip(encounterId, countdown!.ref)
    expect(skipped.status).toBe(204)
    const after = await snapshotOf(encounterId)
    expect(after.countdown).toBeNull()
    // No run was created for the skipped trigger.
    expect(after.turns.length).toBe(before.turns.length)
  }, 20000)

  it('a newer finalized turn flushes the pending countdown into the queue and replaces it', async () => {
    const encounterId = await withConsultation('one')
    const first = (await snapshotOf(encounterId)).countdown!
    installScripted('patient').reply('咳嗽有黄痰。')
    const second = await finalized(encounterId, '有痰吗？')
    expect(second.ref).not.toBe(first.ref)
    await vi.waitFor(async () => {
      const snapshot = await snapshotOf(encounterId)
      expect(snapshot.turns.some((turn) => turn.trigger.text === first.text) ||
        snapshot.queued.some((turn) => turn.text === first.text)).toBe(true)
    }, { timeout: 3000 })
  })

  it('automatically takes a UI snapshot before the ambient provider can request an action', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const encounterId = await withConsultation('none')
    const llm = installScripted('copilot')
      .toolCall('ui_act', { steps: [{ ref: 'c1', action: 'setValue', args: ['问诊三天。'] }] })
      .reply('已更新草稿。')
    const bridge = await serveBridge(encounterId, (tool) => ({
      ok: true, result: tool === 'ui_snapshot' ? snapshotWithConfirm() : '已更新草稿。',
    }))
    try {
      installScripted('patient').reply('从三天前开始。')
      const countdown = await finalized(encounterId, '何时开始的？')
      vi.setSystemTime(Date.parse(countdown.fireAt) + 1)
      expect(await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(encounterId))).toBe(true)
      await waitForTool(encounterId, 'ui_act')
      expect(bridge.calls.map((call) => call.tool)).toEqual(['ui_snapshot', 'ui_act'])
      expect(llm.requests[0].messages).toContainEqual(expect.objectContaining({
        role: 'tool', content: expect.stringContaining('确认签署'),
      }))
      expectNoCaseTruth('ambient context', JSON.stringify(llm.requests), [])
    } finally {
      bridge.close()
      vi.useRealTimers()
    }
  }, 8000)

  it('ui_snapshot reaches the browser over the bridge and its result is recorded as a tool step', async () => {
    const encounterId = await withConsultation('one')
    installScripted('copilot').reply('已读取界面。')
    const bridge = await serveBridge(encounterId, (tool) => {
      expect(tool).toBe('ui_snapshot')
      return { ok: true, result: snapshotWithConfirm() }
    })
    await prompt(encounterId, 'probe-snap', '读取界面')
    const step = await waitForTool(encounterId, 'ui_snapshot')
    expect(bridge.calls.map((c) => c.tool)).toEqual(['ui_snapshot'])
    expect(step.state).toBe('ok')
    expect(step.result).toContain('确认签署')
    bridge.close()
  }, 20000)

  it('ui_act on a data-agent-confirm control is refused server-side (被拦截) and never reaches the browser', async () => {
    const encounterId = await withConsultation('one')
    installScripted('copilot')
      .toolCall('ui_act', { steps: [{ ref: 'c2', action: 'press', args: [] }] })
      .reply('好的，我不按正式按钮。')
    const bridge = await serveBridge(encounterId, () => ({ ok: true, result: snapshotWithConfirm() }))
    await prompt(encounterId, 'probe-intercept', '签署病历')
    await waitForTool(encounterId, 'ui_act')
    // The snapshot call reached the browser once; the refused press never did.
    expect(bridge.calls.map((c) => c.tool)).toEqual(['ui_snapshot'])
    const step = (await snapshotOf(encounterId)).turns.at(-1)!.steps.find((s) => s.name === 'ui_act')!
    expect(step.state).toBe('denied')
    expect(step.subject).toContain('被拦截')
    expect(step.result).toContain('被拦截')
    bridge.close()
  }, 20000)

  it('ui_act on a focused or doctor-edited target becomes a Suggestion (approval) recorded in the session', async () => {
    const encounterId = await withConsultation('one')
    installScripted('copilot')
      .toolCall('ui_act', { steps: [{ ref: '主诉', action: 'setValue', args: ['发热、咳嗽 3 天。'] }] })
      .reply('已把内容保存为建议。')
    const bridge = await serveBridge(encounterId, (tool, args) => {
      void tool
      void args
      return { ok: true, result: JSON.stringify({ suggestions: [{ section: 'chief-complaint', text: '发热、咳嗽 3 天。' }] }), outcome: 'suggestion' }
    })
    await prompt(encounterId, 'probe-suggest', '更新主诉')
    await waitForTool(encounterId, 'ui_act')
    expect(bridge.calls.map((c) => c.tool)).toEqual(['ui_snapshot', 'ui_act'])
    const step = (await snapshotOf(encounterId)).turns.at(-1)!.steps.find((s) => s.name === 'ui_act')!
    expect(step.state).toBe('approval')
    bridge.close()
  }, 20000)

  it('without a bridge, ui tools fail fast and an ambient countdown waits instead of calling the provider', async () => {
    const encounterId = await withConsultation('one')
    const llm = installScripted('copilot').toolCall('ui_snapshot', {}).reply('无法读取界面，改为文字回答。')
    await prompt(encounterId, 'probe-nobridge', '读取界面')
    const step = await waitForTool(encounterId, 'ui_snapshot')
    expect(step.state).toBe('error')
    expect(step.result).toContain('未连接')
    void llm

    // An ambient trigger with no bridge connected keeps waiting: no run starts, so the scripted provider
    // (which would throw on an extra call) stays untouched.
    installScripted('patient').reply('好多了。')
    await settled(encounterId, (await asked(encounterId, '现在怎么样？')).patientTurn.turnId)
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const snapshot = await snapshotOf(encounterId)
    // The trigger is still only counting down: no run exists for the newest finalized turn.
    expect(snapshot.countdown).not.toBeNull()
    expect(snapshot.countdown!.text).toContain('现在怎么样？')
    expect(snapshot.turns.some((t) => t.trigger.text === '问诊定稿：现在怎么样？')).toBe(false)
  }, 20000)
})

it('rejects an automatic consultation action spanning a symptom and a treatment plan before either field is written', async () => {
  const id = await withConsultation()
  const llm = installScripted('copilot').toolCall('ui_act', { steps: [
    { ref: 'c1', action: 'setValue', args: ['咳嗽三天'] }, { ref: 'c3', action: 'setValue', args: ['安排检查'] },
  ] }).reply('继续问诊。')
  const bridge = await serveBridge(id, () => ({ ok: true, result: JSON.stringify([
    { ref: 'c1', component: 'textarea', label: '主诉' },
    { ref: 'c3', component: 'textarea', label: '处理意见与随访' },
  ]) }))
  try {
    installScripted('patient').reply('咳嗽三天了。')
    const event = await finalized(id, '您好，请问咳嗽多久了？')
    await flush(id, event.ref)
    await vi.waitFor(async () => {
      const action = (await snapshotOf(id)).turns.flatMap((turn) => turn.steps).find((step) => step.name === 'ui_act')
      expect(action?.state).toBe('denied')
    })
    expect(llm.requests.length).toBeGreaterThan(0)
    expect(bridge.calls.map((call) => call.tool)).toEqual(['ui_snapshot'])
  } finally { bridge.close() }
})
