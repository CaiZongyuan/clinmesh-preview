import { describe, expect, it, vi } from 'vitest'
import type { AskPatientResponse } from '../../src/shared/consultation'
import type { VoiceServerMessage } from '../../src/shared/voice'
import { expectNoCaseTruth } from './case-truth'
import { api, ask, settled, startEncounter, transcript } from './support/clinic'
import { installFakeParaformer, pcm, type FakeParaformerScript } from './support/fake-paraformer'
import { installScripted } from './support/scripted-llm'

const upgrade = (encounterId: string) => api(`/api/encounters/${encounterId}/voice`, { headers: { upgrade: 'websocket' } })

interface VoiceSocket {
  messages: VoiceServerMessage[]
  send(message: object): void
  audio(ms: number): void
  waitFor(predicate: (messages: VoiceServerMessage[]) => boolean, timeout?: number): Promise<void>
  close(): void
}

async function openVoiceSocket(encounterId: string): Promise<VoiceSocket> {
  const response = await upgrade(encounterId)
  expect(response.status).toBe(101)
  const ws = response.webSocket!
  const messages: VoiceServerMessage[] = []
  ws.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data)) as VoiceServerMessage))
  ws.accept()
  const socket: VoiceSocket = {
    messages,
    send: (message) => ws.send(JSON.stringify(message)),
    audio: (ms) => ws.send(pcm(ms)),
    waitFor: (predicate, timeout = 8000) =>
      vi.waitFor(() => expect(predicate(messages), JSON.stringify(messages)).toBe(true), { timeout, interval: 10 }),
    close: () => ws.close(),
  }
  await socket.waitFor((m) => m.some((x) => (x as { type: string }).type === 'welcome'))
  return socket
}

// The doctor speaks one scripted sentence; the fake Paraformer finalizes it once that much audio has arrived.
function speak(script: FakeParaformerScript) {
  return installFakeParaformer(script)
}

const voiceTurn = (m: VoiceServerMessage[]) =>
  m.find((x): x is Extract<VoiceServerMessage, { type: 'clinmesh.voice-turn' }> => x.type === 'clinmesh.voice-turn')!

describe('voice capture (ADR-0003: the doctor speaks, the pipeline asks the Simulated Patient)', () => {
  it('offers Paraformer when the Worker has a Bailian token, and never the token itself', async () => {
    const response = await api('/api/voice')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ recognizer: 'paraformer-realtime-v2' })
    expect(body).not.toContain('test-bailian-token')
  })

  it('refuses the voice socket without a WebSocket upgrade, and for an unknown Encounter', async () => {
    const encounterId = await startEncounter()
    const plain = await api(`/api/encounters/${encounterId}/voice`)
    expect(plain.status).toBe(426)
    const missing = await upgrade('no-such-encounter')
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('encounter-not-found')
  })

  it('turns a spoken sentence into a doctor turn and the Simulated Patient reply, with recognition metadata', async () => {
    installScripted('patient').reply('医生，我这三天一直发烧，咳嗽得厉害。')
    const { tasks } = speak({ sentences: [{ atMs: 300, text: '您哪里不舒服？', partials: ['您哪里'] }] })
    const encounterId = await startEncounter()
    const socket = await openVoiceSocket(encounterId)

    socket.send({ type: 'clinmesh.capture', mode: 'continuous' })
    socket.send({ type: 'start_call' })
    socket.audio(400)
    await socket.waitFor((m) => m.some((x) => x.type === 'clinmesh.voice-turn'))
    socket.close()

    const turn = voiceTurn(socket.messages)
    expect(turn.ok).toBe(true)
    if (turn.ok) {
      expect(turn.doctorTurn).toMatchObject({
        seq: 1,
        speaker: 'doctor',
        source: 'voice',
        attribution: 'workbench-microphone',
        text: '您哪里不舒服？',
        voice: { recognizer: 'paraformer-realtime-v2', durationMs: 300, confidence: null },
        status: 'final',
      })
      expect(turn.latencyMs).toBeTypeOf('number')
    }
    await socket.waitFor((m) => m.some((x) => x.type === 'transcript_interim' && x.text === '您哪里'))
    expect(socket.messages.some((x) => x.type === 'transcript' && x.role === 'user' && x.text === '您哪里不舒服？')).toBe(true)

    // The reply settles on the Simulated Patient's own socket, exactly like a typed question.
    const turns = await vi.waitFor(
      async () => {
        const turns = await transcript(encounterId)
        expect(turns.map((t) => t.status)).toEqual(['final', 'final'])
        return turns
      },
      { timeout: 4000, interval: 20 },
    )
    expect(turns).toMatchObject([
      { speaker: 'doctor', source: 'voice', text: '您哪里不舒服？' },
      { speaker: 'patient', source: 'simulated', text: '医生，我这三天一直发烧，咳嗽得厉害。' },
    ])
    expectNoCaseTruth('voice socket', JSON.stringify(socket.messages), [])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].actions.map((a) => a.header.action)).toEqual(['run-task', 'finish-task'])
  })

  it('records one push-to-talk capture released after speaking as a single doctor turn', async () => {
    installScripted('patient').reply('黄痰，今天早上有点铁锈色。')
    speak({
      sentences: [
        { atMs: 300, text: '咳嗽有痰吗？' },
        { atMs: 900, text: '什么颜色？' },
      ],
    })
    const encounterId = await startEncounter()
    const socket = await openVoiceSocket(encounterId)
    socket.send({ type: 'clinmesh.capture', mode: 'hold' })
    socket.send({ type: 'start_call' })
    socket.audio(500)
    socket.audio(500)
    await socket.waitFor((m) => m.some((x) => x.type === 'transcript_interim'))
    socket.send({ type: 'clinmesh.commit' })
    await socket.waitFor((m) => m.some((x) => x.type === 'clinmesh.voice-turn'))
    socket.close()

    const turn = voiceTurn(socket.messages)
    expect(turn.ok).toBe(true)
    if (turn.ok) expect(turn.doctorTurn.text).toBe('咳嗽有痰吗？什么颜色？')
    expect(await transcript(encounterId)).toHaveLength(2)
  })

  it('reports a committed capture in which nothing was recognized, without recording a turn', async () => {
    installScripted('patient')
    speak({ sentences: [] })
    const encounterId = await startEncounter()
    const socket = await openVoiceSocket(encounterId)
    socket.send({ type: 'clinmesh.capture', mode: 'hold' })
    socket.send({ type: 'start_call' })
    socket.audio(100)
    await socket.waitFor((m) => m.some((x) => x.type === 'status' && x.status === 'listening'))
    socket.send({ type: 'clinmesh.commit' })
    await socket.waitFor((m) => m.some((x) => x.type === 'clinmesh.capture-empty'))
    socket.close()
    expect(await transcript(encounterId)).toEqual([])
  })

  it('keeps a sentence the workspace refused while a reply was pending, and records it on resubmit', async () => {
    speak({ sentences: [{ atMs: 200, text: '有没有对什么药过敏？' }] })
    const encounterId = await startEncounter()
    // The first reply is held mid-stream, so the pending turn refuses the spoken sentence; the resubmit
    // gets the scripted reply after it.
    const llm = installScripted('patient')
    const held = llm.gate('医生，我这三天一直', '发烧。')
    llm.reply('青霉素过敏。')
    const pending = (await (await ask(encounterId, '您哪里不舒服？')).json()) as AskPatientResponse
    await held.reached
    const socket = await openVoiceSocket(encounterId)
    socket.send({ type: 'clinmesh.capture', mode: 'continuous' })
    socket.send({ type: 'start_call' })
    socket.audio(300)
    await socket.waitFor((m) => m.some((x) => x.type === 'clinmesh.voice-turn' && !x.ok))
    const refused = voiceTurn(socket.messages)
    expect(refused.ok).toBe(false)
    const clientTurnId = !refused.ok ? refused.clientTurnId : ''
    expect(!refused.ok && refused.error.code).toBe('patient-turn-pending')

    // Once the held reply settles, asking again with the same id records the spoken sentence.
    held.release()
    await settled(encounterId, pending.patientTurn.turnId)
    socket.send({ type: 'clinmesh.resubmit', clientTurnId })
    await socket.waitFor((m) => m.some((x) => x.type === 'clinmesh.voice-turn' && x.ok))
    socket.close()
    // The resubmit's reply settles like any other patient turn.
    await vi.waitFor(
      async () => expect((await transcript(encounterId)).map((t) => t.status)).toEqual(['final', 'final', 'final', 'final']),
      { timeout: 4000, interval: 20 },
    )
    const turns = await transcript(encounterId)
    expect(turns.map((t) => t.text)).toEqual([
      '您哪里不舒服？',
      '医生，我这三天一直发烧。',
      '有没有对什么药过敏？',
      '青霉素过敏。',
    ])
    expect(turns[2]).toMatchObject({ speaker: 'doctor', source: 'voice', text: '有没有对什么药过敏？' })
  })

  it('stops capturing on an abandoned Encounter: the upgrade is refused before any audio flows', async () => {
    installScripted('patient')
    const encounterId = await startEncounter()
    await api(`/api/encounters/${encounterId}/abandonment`, { method: 'POST' })
    const response = await upgrade(encounterId)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('encounter-not-active')
  })
})
