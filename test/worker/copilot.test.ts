import { abortAllDurableObjects, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import { describe, expect, it, vi } from 'vitest'
import type { ClinicalNoteResponse } from '../../src/shared/clinical-note'
import type { AuditEventsResponse, EncounterResponse } from '../../src/shared/encounter'
import { ClinicWorkspaceDO } from '../../src/worker/clinic-workspace-do'
import type { CopilotRead } from '../../src/worker/clinical-copilot/copilot-reads'
import { copilotTools } from '../../src/worker/clinical-copilot/copilot-tools'
import type { CopilotSnapshot } from '../../src/shared/copilot-turn'
import { expectNoCaseTruth } from './case-truth'
import {
  asked,
  copilotSettled,
  copilotSnapshot,
  eventsOf,
  openCopilotSocket,
  promptAndSettle,
  promptCopilot,
  send,
  settled,
  startEncounter,
} from './support/clinic'
import { installScripted } from './support/scripted-llm'

const prompt = (encounterId: string, clientPromptId: string, text: string, mode: 'queue' | 'steer' = 'queue', mentions: unknown[] = []) =>
  promptCopilot(encounterId, clientPromptId, text, mode, mentions)

const audits = async (encounterId: string) =>
  ((await (await send('GET', `/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents

const toolsOf = (snapshot: CopilotSnapshot) => snapshot.turns.flatMap((turn) => turn.steps.filter((s) => s.kind === 'tool'))

function gateWorkspaceRead(encounterId: string, kind: CopilotRead['kind']) {
  const original = ClinicWorkspaceDO.prototype.readForCopilot
  let entered = false
  let released = false
  Object.defineProperty(ClinicWorkspaceDO.prototype, 'readForCopilot', {
    async value(this: ClinicWorkspaceDO, id: string, read: CopilotRead) {
      if (id === encounterId && read.kind === kind && !entered) {
        entered = true
        while (!released) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return original.call(this, id, read)
    },
  })
  return {
    reached: () => vi.waitFor(() => expect(entered).toBe(true)),
    release() {
      released = true
      Object.defineProperty(ClinicWorkspaceDO.prototype, 'readForCopilot', { value: original })
    },
  }
}

describe('Copilot tools', () => {
  it('exposes exactly the read-only allowlist', () => {
    expect(new Set(Object.keys(copilotTools(() => Promise.resolve({ ok: false, error: { code: 'invalid-request', message: '' } }))))).toEqual(
      new Set(['read_encounter_state', 'read_visible_source_history', 'read_examination_findings', 'read_released_reports', 'search_clinic_catalog']),
    )
  })

  it('leaves the workspace state unchanged when a turn reads every tool', async () => {
    installScripted('patient').reply('医生，我发烧三天了。')
    installScripted('copilot')
      .toolCall('read_encounter_state', {})
      .toolCall('read_visible_source_history', {})
      .toolCall('read_examination_findings', { system: 'vitals' })
      .toolCall('read_released_reports', {})
      .toolCall('search_clinic_catalog', { query: '血常规' })
      .reply('根据资料，建议……', { thinking: '先看看已有的资料。' })

    const encounterId = await startEncounter()
    await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
    expect((await send('POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' })).status).toBe(201)
    const issued = await send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc'] })
    const cbc = ((await issued.json()) as { investigations: { investigationId: string }[] }).investigations[0]
    expect((await send('POST', `/api/encounters/${encounterId}/investigations/${cbc.investigationId}/instant-release`)).status).toBe(200)

    const read = async () =>
      JSON.stringify({
        encounter: ((await (await send('GET', `/api/encounters/${encounterId}`)).json()) as EncounterResponse).encounter,
        examinations: (await (await send('GET', `/api/encounters/${encounterId}/physical-examinations`)).text()),
        investigations: await (await send('GET', `/api/encounters/${encounterId}/investigations`)).text(),
        consultation: await (await send('GET', `/api/encounters/${encounterId}/consultation`)).text(),
      })
    const before = await read()

    const { snapshot } = await promptAndSettle(encounterId, 't1', '总结一下目前的情况')
    expect(snapshot.turns).toHaveLength(1)
    expect(snapshot.turns[0].status).toBe('done')
    expect(toolsOf(snapshot).map((tool) => tool.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(await read()).toEqual(before)
  })

  it('audits prompts, stops, feedback and model changes with the practitioner', async () => {
    installScripted('copilot').reply('好的。')
    const encounterId = await startEncounter()
    await prompt(encounterId, 'a1', '帮我看看')
    await copilotSettled(encounterId)
    await send('POST', `/api/encounters/${encounterId}/copilot/config`, { model: 'glm-5.3-flash', effort: 'high' })
    const snapshot = await copilotSnapshot(encounterId)
    await send('POST', `/api/encounters/${encounterId}/copilot/turns/${snapshot.turns[0].turnId}/feedback`, { value: 'up' })
    const types = (await audits(encounterId)).map((a) => a.eventType)
    expect(types).toContain('copilot-prompted')
    expect(types).toContain('copilot-model-changed')
    expect(types).toContain('copilot-feedback-given')
  })
})

describe('what the Copilot is asked', () => {
  it('expands slash commands and lists @-mentions for the model', async () => {
    const llm = installScripted('copilot').reply('鉴别诊断如下……').reply('已阅该报告。')
    const encounterId = await startEncounter()
    await prompt(encounterId, 'c1', '/鉴别诊断')
    await prompt(encounterId, 'c2', '这份报告怎么看？', 'queue', [{ kind: 'report', id: 'r-1', label: '血常规 第1版' }])
    await copilotSettled(encounterId)
    expect(llm.requests[0].messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('列出鉴别诊断') })
    expect(llm.requests[1].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('报告「血常规 第1版」'),
    })
  })

  it('includes only the selected visible signed section and current Draft in the outbound request', async () => {
    const llm = installScripted('copilot').reply('已核对两个段落。')
    const encounterId = await startEncounter()
    const path = `/api/encounters/${encounterId}/clinical-note`
    const sections = {
      'chief-complaint': '首次签署主诉文本',
      'present-illness': '未引用的签署段落',
      'past-history': '',
      findings: '',
      assessment: '',
      plan: '',
    }
    const first = await send('POST', `${path}/revisions`, { sections })
    expect(first.status).toBe(201)
    const { note } = (await first.json()) as ClinicalNoteResponse
    expect((await send('POST', `${path}/revisions`, {
      sections: { ...sections, 'chief-complaint': '后来签署的主诉文本' },
    })).status).toBe(201)
    expect((await send('PATCH', `${path}/draft`, {
      sections: { 'chief-complaint': '当前尚未签署的主诉草稿', plan: '未引用的草稿段落' },
    })).status).toBe(200)

    const references = [
      { kind: 'note-section', id: `${note.revisions[0].revisionId}:chief-complaint`, label: '主诉（已签署）' },
      { kind: 'draft', id: 'chief-complaint', label: '主诉（草稿）' },
      { kind: 'note-section', id: 'another-encounter:chief-complaint', label: '不存在的修订' },
    ]
    expect((await prompt(encounterId, 'note-refs', '请对照两段内容。', 'queue', references)).status).toBe(201)
    await copilotSettled(encounterId)
    expect(llm.requests).toHaveLength(1)
    const outbound = JSON.stringify(llm.requests[0].messages)
    expect(outbound).toContain('首次签署主诉文本')
    expect(outbound).toContain('当前尚未签署的主诉草稿')
    expect(outbound).not.toContain('后来签署的主诉文本')
    expect(outbound).not.toContain('未引用的签署段落')
    expect(outbound).not.toContain('未引用的草稿段落')
    expectNoCaseTruth('Copilot note references', outbound)
  })

  it('rebuilds the HIS state in the system prompt every step, never the Case Truth', async () => {
    installScripted('patient').reply('我咳嗽。')
    const llm = installScripted('copilot').toolCall('read_released_reports', {}).reply('没有已发布报告。')
    const encounterId = await startEncounter()
    await settled(encounterId, (await asked(encounterId, '哪里不舒服？')).patientTurn.turnId)
    expect((await send('POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' })).status).toBe(201)
    // Issued, not released: the Copilot must not see its result anywhere.
    expect((await send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc'] })).status).toBe(201)
    await prompt(encounterId, 'd1', '患者查了什么？')
    const snapshot = await copilotSettled(encounterId)
    expect(toolsOf(snapshot)[0].result).not.toContain('cbc'.toUpperCase())
    expectNoCaseTruth('Copilot LLM requests', JSON.stringify(llm.requests))
  })
})

describe('Case Truth isolation for the Copilot session', () => {
  it('shows only released report versions while an amendment is pending, in turns and LLM requests', async () => {
    const T0 = Date.parse('2026-11-24T00:40:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    try {
      installScripted('patient').reply('我发烧咳嗽三天了。')
      const llm = installScripted('copilot')
        .toolCall('read_released_reports', {})
        .reply('已发布报告见上。')
        .toolCall('read_released_reports', {})
        .reply('最新报告也见上。')
      const encounterId = await startEncounter()
      await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
      const issued = await send('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc', 'cxr'] })
      const [cbc, cxr] = ((await issued.json()) as { investigations: { investigationId: string }[] }).investigations
      await send('POST', `/api/encounters/${encounterId}/investigations/${cbc.investigationId}/instant-release`)
      await send('POST', `/api/encounters/${encounterId}/investigations/${cxr.investigationId}/instant-release`)
      const released = [
        casePack.cases[0].laboratories.filter((l) => ['cbc', 'cxr'].includes(l.catalogItem)),
        casePack.cases[0].textResults.filter((t) => ['cbc', 'cxr'].includes(t.catalogItem)),
      ]
      const { snapshot } = await promptAndSettle(encounterId, 'e1', '报告结果如何？')
      expect(toolsOf(snapshot)).toHaveLength(1)
      expectNoCaseTruth('Copilot snapshot', JSON.stringify(snapshot), released)
      expectNoCaseTruth('Copilot LLM requests', JSON.stringify(llm.requests), released)

      // The CBC amendment publishes 120 s after v1; the chest X-ray one must stay hidden.
      vi.setSystemTime(T0 + 150_000)
      const amendment = casePack.cases[0].reportAmendments.filter((a) => a.catalogItem === 'cbc')
      const second = await promptAndSettle(encounterId, 'e2', '最新报告如何？')
      const secondResults = JSON.stringify(toolsOf(second.snapshot))
      expect(secondResults).toContain(amendment[0].reason)
      expect(secondResults).not.toContain(casePack.cases[0].reportAmendments.find((a) => a.catalogItem === 'cxr')!.reason!)
      const revealed = [...released, amendment]
      expectNoCaseTruth('amended snapshot', JSON.stringify(second.snapshot), revealed)
      expectNoCaseTruth('amended requests', JSON.stringify(llm.requests.slice(2)), revealed)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('turn lifecycle', () => {
  it('queues prompts behind a running turn, and the second turn sees the first turn reply', async () => {
    const llm = installScripted('copilot')
    const gate = llm.gate('先看看', '（第一轮回答）')
    llm.reply('（第二轮回答）')
    const encounterId = await startEncounter()
    await prompt(encounterId, 'q1', '第一问')
    await gate.reached
    const queued = await prompt(encounterId, 'q2', '第二问')
    expect(queued.status).toBe(201)
    const snapshot = await copilotSnapshot(encounterId)
    expect(snapshot.queued.map((item) => item.text)).toEqual(['第二问'])
    gate.release()
    const done = await copilotSettled(encounterId)
    expect(done.turns.map((turn) => [turn.status, turn.trigger.text])).toEqual([
      ['done', '第一问'],
      ['done', '第二问'],
    ])
    expect(llm.requests[1].messages).toContainEqual({ role: 'user', content: '第一问' })
    expect(llm.requests[1].messages).toContainEqual({ role: 'assistant', content: '先看看（第一轮回答）' })
  })

  it('delivers a steer to the running turn before its next step, and marks it read', async () => {
    const llm = installScripted('copilot')
      .toolCall('read_released_reports', {})
      .reply('好，我已经注意到补充的信息。')
      .reply('我来回答排队的问题。')
    const encounterId = await startEncounter()
    const gate = gateWorkspaceRead(encounterId, 'released-reports')
    try {
      expect((await prompt(encounterId, 's1', '分析一下')).status).toBe(201)
      await gate.reached()
      expect((await prompt(encounterId, 's2', '排队的问题')).status).toBe(201)
      expect((await prompt(encounterId, 's3', '重点看过敏史', 'steer')).status).toBe(201)
    } finally {
      gate.release()
    }

    const snapshot = await copilotSettled(encounterId)
    expect(snapshot.turns.map((turn) => [turn.status, turn.trigger.text])).toEqual([
      ['done', '分析一下'],
      ['done', '排队的问题'],
    ])
    expect(snapshot.turns[0].steers).toEqual([{ text: '重点看过敏史', sentAt: expect.any(String), read: true }])
    const usersOf = (request: (typeof llm.requests)[number]) =>
      request.messages.filter((message) => message.role === 'user').map((message) => message.content)
    expect(usersOf(llm.requests[1])).toEqual(['分析一下', '重点看过敏史'])
    expect(usersOf(llm.requests[2])).toEqual(['分析一下', '重点看过敏史', '排队的问题'])
  })

  it('runs an unread steer separately when the first turn has already produced its final reply', async () => {
    const llm = installScripted('copilot')
    const gate = llm.gate('', '')
    llm.reply('好，我已经注意到补充的信息。')
    const encounterId = await startEncounter()
    await prompt(encounterId, 's1', '分析一下')
    await gate.reached
    const steered = await prompt(encounterId, 's2', '重点看过敏史', 'steer')
    expect(steered.status).toBe(201)
    gate.release()
    const snapshot = await copilotSettled(encounterId)
    // The run ended before it could read the steer, so it became a turn of its own, ahead of anything queued.
    expect(snapshot.turns[0].steers).toEqual([{ text: '重点看过敏史', sentAt: expect.any(String), read: false }])
    expect(snapshot.turns[0].status).toBe('done')
    expect(snapshot.turns[1]).toMatchObject({ status: 'done', trigger: { kind: 'doctor', text: '重点看过敏史' } })
    expect(llm.requests.at(-1)?.messages).toContainEqual({ role: 'user', content: '重点看过敏史' })
  })

  it('stops the running turn but lets queued turns continue', async () => {
    const llm = installScripted('copilot')
    const gate = llm.gate('部分', '（不会说完）')
    llm.reply('（排队轮的回答）')
    const encounterId = await startEncounter()
    const running = await prompt(encounterId, 'p1', '慢慢分析')
    expect(running.status).toBe(201)
    await gate.reached
    await prompt(encounterId, 'p2', '之后再来一轮')
    const stopped = await send('POST', `/api/encounters/${encounterId}/copilot/stop`)
    expect(await stopped.json()).toMatchObject({ stoppedTurnId: expect.any(String) })
    gate.release()
    const snapshot = await copilotSettled(encounterId)
    expect(snapshot.turns.map((turn) => [turn.status, turn.stopReason])).toEqual([
      ['stopped', 'stop-requested'],
      ['done', null],
    ])
    expect((await audits(encounterId)).map((a) => a.eventType)).toContain('copilot-stopped')
  })

  it.each([
    ['encounter-state', 'stop'],
    ['released-reports', 'stall'],
  ] as const)('continues the queue after %s hangs until %s', async (kind, finish) => {
    const llm = installScripted('copilot')
    if (kind === 'released-reports') llm.toolCall('read_released_reports', {})
    llm.reply('下一轮已回答')
    const encounterId = await startEncounter()
    const gate = gateWorkspaceRead(encounterId, kind)
    try {
      const first = await prompt(encounterId, 'hang-first', '等待工作区')
      expect(first.status).toBe(201)
      const { turnId } = (await first.json()) as { turnId: string }
      await gate.reached()
      expect((await prompt(encounterId, 'hang-next', '下一问')).status).toBe(201)
      if (finish === 'stop') {
        const stopped = await send('POST', `/api/encounters/${encounterId}/copilot/stop`)
        expect(await stopped.json()).toMatchObject({ stoppedTurnId: turnId })
      }
      const snapshot = await copilotSettled(encounterId, 3000)
      expect(snapshot.turns).toHaveLength(2)
      expect(snapshot.turns[0]).toMatchObject(finish === 'stop'
        ? { turnId, status: 'stopped', stopReason: 'stop-requested' }
        : { turnId, status: 'failed', failure: 'stalled' })
      expect(snapshot.turns[1]).toMatchObject({ status: 'done', reply: '下一轮已回答' })
    } finally {
      gate.release()
    }
  }, 8000)

  it('refuses a resend while running, and otherwise supersedes the old turn with a new one', async () => {
    const llm = installScripted('copilot')
    const gate = llm.gate('a', 'b')
    llm.reply('（重发的回答）')
    const encounterId = await startEncounter()
    await prompt(encounterId, 'r0', '第一版问题')
    await copilotSettled(encounterId)
    const original = (await copilotSnapshot(encounterId)).turns[0]
    expect(original.superseded).toBe(false)

    await prompt(encounterId, 'r1', '正在跑的一轮')
    await gate.reached
    const busy = await send('POST', `/api/encounters/${encounterId}/copilot/turns/${original.turnId}/resend`, {
      clientPromptId: 'r1-edit', text: '编辑后的问题', mentions: [],
    })
    expect(busy.status).toBe(409)
    gate.release()
    await copilotSettled(encounterId)

    const resent = await send('POST', `/api/encounters/${encounterId}/copilot/turns/${original.turnId}/resend`, {
      clientPromptId: 'r2-edit', text: '编辑后的问题', mentions: [],
    })
    expect(resent.status).toBe(201)
    await copilotSettled(encounterId)
    const turns = (await copilotSnapshot(encounterId)).turns
    expect(turns.find((t) => t.turnId === original.turnId)?.superseded).toBe(true)
    expect(turns.some((t) => t.trigger.text === '编辑后的问题')).toBe(true)
    // The edit-and-resend re-answers the same resent command once, even if the browser retries the request.
    const again = await send('POST', `/api/encounters/${encounterId}/copilot/turns/${original.turnId}/resend`, {
      clientPromptId: 'r2-edit', text: '编辑后的问题', mentions: [],
    })
    expect(again.status).toBe(201)
    expect((await copilotSnapshot(encounterId)).turns.filter((t) => t.trigger.text === '编辑后的问题')).toHaveLength(1)
    expect(llm.requests.at(-1)?.messages).not.toContainEqual(expect.objectContaining({ content: '第一版问题' }))
  })

  it('records helpful / not helpful, replaces it, and refuses unknown turns', async () => {
    installScripted('copilot').reply('回答。')
    const encounterId = await startEncounter()
    await prompt(encounterId, 'f1', '问一句')
    const { turns } = await copilotSettled(encounterId)
    const turnId = turns[0].turnId
    const path = `/api/encounters/${encounterId}/copilot/turns/${turnId}/feedback`
    expect((await send('POST', path, { value: 'down' })).status).toBe(200)
    expect((await copilotSnapshot(encounterId)).turns[0].feedback).toBe('down')
    expect((await send('POST', path, { value: null })).status).toBe(200)
    expect((await copilotSnapshot(encounterId)).turns[0].feedback).toBeNull()
    expect((await send('POST', path, { value: 'maybe' })).status).toBe(400)
    expect(
      (await send('POST', `/api/encounters/${encounterId}/copilot/turns/other/feedback`, { value: 'up' })).status,
    ).toBe(404)
  })

  it('changes model and effort for the session, refuses unknown models, and keeps the default in the snapshot', async () => {
    const llm = installScripted('copilot').reply('a').reply('b')
    const encounterId = await startEncounter()
    expect((await copilotSnapshot(encounterId)).model).toMatchObject({ model: 'glm-5.3-flash', effort: 'low' })
    expect((await send('POST', `/api/encounters/${encounterId}/copilot/config`, { model: 'gpt-9', effort: 'low' })).status).toBe(400)
    expect(
      (await send('POST', `/api/encounters/${encounterId}/copilot/config`, { model: 'glm-5.3', effort: 'high' })).status,
    ).toBe(200)
    expect((await copilotSnapshot(encounterId)).model).toMatchObject({
      model: 'glm-5.3', effort: 'high', defaultModel: 'glm-5.3-flash',
    })
    await prompt(encounterId, 'm1', '换个模型答一次')
    await copilotSettled(encounterId)
    expect(llm.requests.at(-1)).toMatchObject({ model: 'glm-5.3', effort: 'high' })
  })

  it('fails visibly with llm-not-configured when no model is configured, never hanging', async () => {
    // No copilot provider installed: the prompt still records, the turn fails with a visible reason.
    const encounterId = await startEncounter()
    const started = await prompt(encounterId, 'n1', '没人配置模型')
    expect(started.status).toBe(201)
    const snapshot = await copilotSettled(encounterId)
    expect(snapshot.turns[0]).toMatchObject({ status: 'failed', failure: 'llm-not-configured' })
  })

  it('fails a turn whose provider streams nothing for the stall timeout', async () => {
    installScripted('copilot').hang('开头')
    const encounterId = await startEncounter()
    await prompt(encounterId, 'st1', '卡住的提问')
    const snapshot = await copilotSettled(encounterId, 8000)
    expect(snapshot.turns[0]).toMatchObject({ status: 'failed', failure: 'stalled' })
  })

  it('recovers a crashed turn from its last checkpoint, with a resume notice on the socket', async () => {
    const llm = installScripted('copilot')
    const gate = llm.gate('先', '（不会说完）')
    llm.reply('恢复后的回答', { thinking: '恢复的思考' })
    const encounterId = await startEncounter()
    const socket = await openCopilotSocket(encounterId)
    await prompt(encounterId, 'rc1', '崩溃前的提问')
    await gate.reached
    await abortAllDurableObjects()
    expect(await runDurableObjectAlarm(env.CLINICAL_COPILOT.getByName(encounterId))).toBe(true)
    const snapshot = await copilotSettled(encounterId)
    expect(snapshot.turns[0]).toMatchObject({ status: 'done', reply: '恢复后的回答' })
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1].messages).toEqual(llm.requests[0].messages)
    const replay = await openCopilotSocket(encounterId)
    expect(eventsOf(replay.messages).map((e) => e.type)).toEqual([
      'run.queued', 'run.started', 'step.started', 'run.reset', 'step.started', 'step.finished', 'run.finished',
    ])
    socket.close()
    replay.close()
  })

  it('closes running steps and preserves unread steers when a turn fails to close', async () => {
    const llm = installScripted('copilot')
    const gate = llm.gate('开始分析', '分析结束')
    llm.reply('回答引导').reply('回答排队问题')
    const encounterId = await startEncounter()
    await runInDurableObject(env.CLINICAL_COPILOT.getByName(encounterId), (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER refuse_first_run_close BEFORE UPDATE OF status ON agent_run
        WHEN OLD.external_ref = 'failed-close' AND NEW.status = 'done'
        BEGIN SELECT RAISE(ABORT, 'deliberate close failure'); END
      `)
    })

    try {
      expect((await prompt(encounterId, 'failed-close', '第一问')).status).toBe(201)
      await gate.reached
      expect((await prompt(encounterId, 'queued-after-close', '排队的问题')).status).toBe(201)
      expect((await prompt(encounterId, 'unread-at-close', '看过敏史', 'steer')).status).toBe(201)
    } finally {
      gate.release()
    }

    const snapshot = await copilotSettled(encounterId)
    expect(snapshot.turns[0]).toMatchObject({ status: 'failed', failure: 'crashed-repeatedly' })
    expect(snapshot.turns[0].steps.every((step) => step.state !== 'running')).toBe(true)
    expect(snapshot.turns.slice(1).map((turn) => [turn.trigger.text, turn.reply])).toEqual([
      ['看过敏史', '回答引导'],
      ['排队的问题', '回答排队问题'],
    ])
  })

  it('streams the session over the socket: thinking, tool steps and deltas end when the turn does', async () => {
    installScripted('copilot').toolCall('search_clinic_catalog', { query: '血常规' }, { thinking: '先查目录。' }).reply('目录里有血常规。')
    const encounterId = await startEncounter()
    const socket = await openCopilotSocket(encounterId)
    await prompt(encounterId, 'ws1', '帮我查查目录')
    await socket.waitFor((messages) => eventsOf(messages).some((e) => e.type === 'run.finished'))
    const events = eventsOf(socket.messages)
    expect(events.some((e) => e.type === 'thinking.delta')).toBe(true)
    expect(events.map((e) => e.type)).toContain('tool.started')
    expect(events.map((e) => e.type)).toContain('tool.finished')
    socket.close()
    // After the run finished, the deltas are pruned from the replay buffer.
    const replay = await openCopilotSocket(encounterId)
    expect(eventsOf(replay.messages).some((e) => e.type === 'text.delta')).toBe(false)
    replay.close()
  })

  it('refuses a socket without an upgrade, and prompts without a valid body', async () => {
    const encounterId = await startEncounter()
    expect((await send('GET', `/api/encounters/${encounterId}/copilot/socket`)).status).toBe(426)
    expect((await prompt(encounterId, '', 'x')).status).toBe(400)
    expect((await prompt(encounterId, 'x', '')).status).toBe(400)
    expect((await prompt(encounterId, 'x', '字', 'steer', [{ kind: 'report' }])).status).toBe(400)
  })
})
