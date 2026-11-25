import { describe, expect, it, vi } from 'vitest'
import { api } from './support/clinic'
import { installScripted } from './support/scripted-llm'
import { asked, settled, startEncounter } from './support/clinic'
import { installScriptedSambert } from '../../src/worker/voice/voice-config'

// The DashScope end of one Sambert task for route tests: reacts to the run-task the provider sends, streams a
// sentinel-length WAV and finishes by itself (no finish-task arrives, and none would be legal).
function installFakeSambert(): { tasks: { taskId: string; text: string; finishTasks: number }[] } {
  const tasks: { taskId: string; text: string; finishTasks: number }[] = []
  installScriptedSambert(async () => {
    const [client, service] = Object.values(new WebSocketPair())
    const record = { taskId: '', text: '', finishTasks: 0 }
    tasks.push(record)
    service.accept()
    service.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const action = JSON.parse(event.data) as { header: { action: string; task_id: string }; payload?: { input?: { text?: string } } }
      if (action.header.action === 'finish-task') record.finishTasks++
      if (action.header.action !== 'run-task') return
      record.taskId = action.header.task_id
      record.text = action.payload?.input?.text ?? ''
      setTimeout(() => {
        service.send(JSON.stringify({ header: { event: 'task-started', task_id: record.taskId } }))
        // A 44-byte canonical header plus 8 bytes of payload, carrying DashScope's streamed sentinels.
        const bytes = new Uint8Array(52)
        const view = new DataView(bytes.buffer)
        'RIFF'.split('').forEach((s, i) => (bytes[i] = s.charCodeAt(0)))
        view.setUint32(4, 0x7fffffbf, true)
        'WAVEfmt '.split('').forEach((s, i) => (bytes[8 + i] = s.charCodeAt(0)))
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, 1, true)
        view.setUint32(24, 16_000, true)
        view.setUint32(28, 32_000, true)
        view.setUint16(32, 2, true)
        view.setUint16(34, 16, true)
        'data'.split('').forEach((s, i) => (bytes[36 + i] = s.charCodeAt(0)))
        view.setUint32(40, 0x7fffff9b, true)
        bytes.fill(9, 44)
        service.send(bytes.buffer)
        service.send(JSON.stringify({ header: { event: 'task-finished', task_id: record.taskId } }))
      }, 10)
    })
    client.accept()
    return client
  })
  return { tasks }
}

const speech = (encounterId: string, turnId: string, body?: unknown) =>
  api(`/api/encounters/${encounterId}/consultation/patient-turns/${turnId}/speech`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('patient speech (Sambert through the workbench route)', () => {
  it('synthesizes a settled patient reply into repaired WAV bytes', async () => {
    const fake = installFakeSambert()
    installScripted('patient').reply('您最近有发烧吗？')
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, '您哪里不舒服？')
    const turn = await settled(encounterId, patientTurn.turnId)

    const response = await speech(encounterId, turn.turnId, { text: turn.text })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    const wav = await response.arrayBuffer()
    expect(wav.byteLength).toBe(52)
    const view = new DataView(wav)
    // Sentinel lengths were repaired before the bytes reached the browser.
    expect(view.getUint32(4, true)).toBe(44)
    expect(view.getUint32(40, true)).toBe(8)
    expect(fake.tasks).toEqual([{ taskId: expect.any(String), text: turn.text, finishTasks: 0 }])
  })

  it('refuses a pending or unknown turn, and an oversized text', async () => {
    installFakeSambert()
    installScripted('patient').reply('您最近有发烧吗？')
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, '您哪里不舒服？')

    const pending = await speech(encounterId, patientTurn.turnId, { text: '正在回答' })
    expect(pending.status).toBe(400)
    const unknown = await speech(encounterId, 'no-such-turn', { text: '正在回答' })
    expect(unknown.status).toBe(400)
    const oversized = await speech(encounterId, patientTurn.turnId, { text: '长'.repeat(1001) })
    expect(oversized.status).toBe(400)
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('invalid-request')
  })

  it('refuses speech on a frozen Encounter, so stale playback jobs stop at the source', async () => {
    installFakeSambert()
    installScripted('patient').reply('您最近有发烧吗？')
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, '您哪里不舒服？')
    const turn = await settled(encounterId, patientTurn.turnId)
    await api(`/api/encounters/${encounterId}/abandonment`, { method: 'POST' })

    const response = await speech(encounterId, turn.turnId, { text: turn.text })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('encounter-not-active')
  })
})
