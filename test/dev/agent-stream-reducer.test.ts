import { describe, expect, it } from 'vitest'
import {
  createAgentStreamState,
  parseClientAction,
  reduceAgentServerMessage,
} from '../../src/shared/agent-stream-reducer'

describe('agent-stream-reducer (S0 native MiniProgram wire reducer)', () => {
  it('emits path-based text patches, drops hidden thinking, resets on run.reset, and deduplicates afterSeq', () => {
    let state = createAgentStreamState()

    let res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 1,
      event: { type: 'run.started', runId: 'run_1', ref: 'msg_1' },
    })
    state = res.state
    expect(state.activeRunId).toBe('run_1')
    expect(res.patches['stream.activeRunId']).toBe('run_1')

    // Hidden reasoning must never enter patient UI state or patches.
    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 2,
      event: { type: 'thinking.delta', runId: 'run_1', text: 'secret chain of thought' },
    })
    state = res.state
    expect(state.runs.run_1.text).toBe('')
    expect(Object.keys(res.patches)).toEqual(['stream.lastSeq'])

    // Streaming delta updates only the single text field path (not full message arrays).
    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 3,
      event: { type: 'text.delta', runId: 'run_1', text: '正在为您' },
    })
    state = res.state
    expect(res.patches).toEqual({
      'stream.runs.run_1.text': '正在为您',
      'stream.lastSeq': 3,
    })

    // Duplicate sequence on reconnect is ignored.
    const dup = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 3,
      event: { type: 'text.delta', runId: 'run_1', text: '重复片段' },
    })
    expect(dup.state.runs.run_1.text).toBe('正在为您')
    expect(dup.patches).toEqual({})

    // Crash recovery resets streamed text and tool state.
    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 4,
      event: { type: 'run.reset', runId: 'run_1' },
    })
    state = res.state
    expect(state.runs.run_1.text).toBe('')
    expect(res.patches['stream.runs.run_1.text']).toBe('')

    // Tool lifecycle updates only the specific tool slot.
    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 5,
      event: { type: 'tool.started', runId: 'run_1', callId: 'call_1', name: 'list_available_slots' },
    })
    state = res.state
    expect(res.patches['stream.runs.run_1.tools[0]']).toEqual({
      callId: 'call_1',
      name: 'list_available_slots',
      status: 'running',
    })

    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 6,
      event: { type: 'tool.finished', runId: 'run_1', callId: 'call_1', status: 'ok' },
    })
    state = res.state
    expect(res.patches['stream.runs.run_1.tools[0].status']).toBe('ok')

    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 7,
      event: { type: 'text.delta', runId: 'run_1', text: '王医生明天上午有号。' },
    })
    state = res.state

    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 8,
      event: { type: 'run.finished', runId: 'run_1', ref: 'msg_1', status: 'done', error: null },
    })
    state = res.state
    expect(state.activeRunId).toBeNull()
    expect(state.runs.run_1.status).toBe('done')

    res = reduceAgentServerMessage(state, {
      type: 'event',
      seq: 9,
      event: { type: 'run.settled', runId: 'run_1', ref: 'msg_1', accepted: true },
    })
    state = res.state
    expect(state.runs.run_1.settled).toBe(true)
    expect(state.runs.run_1.settledAccepted).toBe(true)

    res = reduceAgentServerMessage(state, { type: 'replay.done', seq: 9 })
    state = res.state
    expect(state.replaying).toBe(false)
    expect(state.lastSeq).toBe(9)

    // Resync wipes stale local cursor and state.
    res = reduceAgentServerMessage(state, { type: 'resync' })
    expect(res.state.lastSeq).toBe(0)
    expect(res.state.needsResync).toBe(true)
    expect(res.state.runs).toEqual({})
  })

  it('whitelists only safe client UI actions and rejects arbitrary URLs or traversal ids', () => {
    expect(parseClientAction({ name: 'medical.record.open', args: { recordId: 'rec_001' } })).toEqual({
      name: 'medical.record.open',
      args: { recordId: 'rec_001' },
    })
    expect(parseClientAction({ name: 'appointment.open', args: { slotId: 'slot_wang_0900' } })).toEqual({
      name: 'appointment.open',
      args: { slotId: 'slot_wang_0900' },
    })
    expect(parseClientAction({ name: 'open_url', args: { url: 'https://evil.example' } })).toBeNull()
    expect(parseClientAction({ name: 'medical.record.open', args: { recordId: '../other' } })).toBeNull()
    expect(parseClientAction({ name: 'followup.open', args: { planId: 'plan_1', taskId: 'bad/id' } })).toBeNull()
  })
})
