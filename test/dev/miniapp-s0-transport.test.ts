import { describe, expect, it, vi } from 'vitest'
import { dispatchWhitelistedAction } from '../../apps/patient-miniapp/miniprogram/actions/registry'
import {
  NativeAgentStreamTransport,
  type MiniProgramSocketTask,
} from '../../apps/patient-miniapp/miniprogram/services/agent-transport'

function fakeSocketFactory() {
  const sent: string[] = []
  let openCb: (() => void) | null = null
  let msgCb: ((res: { data: string | ArrayBuffer }) => void) | null = null
  let closeCb: (() => void) | null = null
  let closed = false

  const connectSocket = vi.fn(({ url, header }: { url: string; header: Record<string, string> }): MiniProgramSocketTask => {
    closed = false
    expect(url).toContain('/api/agent/runs/')
    expect(header.Authorization).toBe('Bearer test-session-token')
    return {
      send: ({ data }) => sent.push(data),
      close: () => {
        closed = true
        closeCb?.()
      },
      onOpen: (cb) => { openCb = cb },
      onMessage: (cb) => { msgCb = cb },
      onClose: (cb) => { closeCb = cb },
      onError: () => {},
    }
  })

  return {
    connectSocket,
    sent,
    triggerOpen: () => openCb?.(),
    triggerMessage: (payload: unknown) => msgCb?.({ data: JSON.stringify(payload) }),
    isClosed: () => closed,
  }
}

describe('S0 native MiniProgram agent transport & action registry', () => {
  it('reconnects from lastSeq, streams path patches, and handles resync cleanly', () => {
    const fake = fakeSocketFactory()
    const patchesLog: Record<string, unknown>[] = []
    const resynced = vi.fn()

    const transport = new NativeAgentStreamTransport({
      url: 'wss://clinic.example/api/agent/runs/run_1/socket',
      token: 'test-session-token',
      connectSocket: fake.connectSocket,
      onPatches: (patches) => patchesLog.push(patches),
      onResyncRequired: resynced,
    })

    transport.connect()
    fake.triggerOpen()
    expect(JSON.parse(fake.sent[0])).toEqual({ type: 'hello', afterSeq: 0 })

    fake.triggerMessage({ type: 'event', seq: 1, event: { type: 'run.started', runId: 'run_1', ref: 'm1' } })
    fake.triggerMessage({ type: 'event', seq: 2, event: { type: 'text.delta', runId: 'run_1', text: '您好' } })
    fake.triggerMessage({ type: 'replay.done', seq: 2 })

    // Simulate onShow reconnect: must ask for afterSeq: 2
    transport.reconnect()
    fake.triggerOpen()
    expect(JSON.parse(fake.sent[1])).toEqual({ type: 'hello', afterSeq: 2 })

    // Duplicate seq 2 is ignored; seq 3 appends cleanly
    fake.triggerMessage({ type: 'event', seq: 2, event: { type: 'text.delta', runId: 'run_1', text: '您好' } })
    fake.triggerMessage({ type: 'event', seq: 3, event: { type: 'text.delta', runId: 'run_1', text: '，已查到号源。' } })
    expect(transport.getState().runs.run_1.text).toBe('您好，已查到号源。')
    expect(patchesLog.at(-1)).toEqual({
      'stream.runs.run_1.text': '您好，已查到号源。',
      'stream.lastSeq': 3,
    })

    // Server reset triggers resync -> hello afterSeq: 0
    fake.triggerMessage({ type: 'resync' })
    expect(resynced).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fake.sent[2])).toEqual({ type: 'hello', afterSeq: 0 })
    expect(transport.getState().lastSeq).toBe(0)

    transport.disconnect()
    expect(fake.isClosed()).toBe(true)
  })

  it('dispatches whitelisted MiniProgram routes only when foregrounded and rejects unsafe actions', async () => {
    const navigateTo = vi.fn()
    const ok = await dispatchWhitelistedAction(
      { name: 'medical.record.open', args: { recordId: 'rec_demo_01' } },
      { navigateTo, isForeground: () => true },
    )
    expect(ok).toEqual({
      ok: true,
      code: 'dispatched',
      route: '/pages/records/detail/index?id=rec_demo_01',
    })
    expect(navigateTo).toHaveBeenCalledWith({ url: '/pages/records/detail/index?id=rec_demo_01' })

    const bg = await dispatchWhitelistedAction(
      { name: 'appointment.open', args: { slotId: 'slot_01' } },
      { navigateTo, isForeground: () => false },
    )
    expect(bg.ok).toBe(false)
    expect(bg.code).toBe('unavailable')

    const bad = await dispatchWhitelistedAction(
      { name: 'webview.open', args: { url: 'https://malicious.invalid' } },
      { navigateTo, isForeground: () => true },
    )
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('rejected')
  })
})
