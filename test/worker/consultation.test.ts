import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { AuditEventsResponse, ErrorResponse } from '../../src/shared/encounter'
import { personaFor } from '../../src/worker/golden-case-pack'
import { personaPrompt } from '../../src/worker/simulated-patient/patient-context'
import { expectNoCaseTruth } from './case-truth'
import { api, ask, asked, eventsOf, openPatientSocket, retry, send, settled, startEncounter, transcript } from './support/clinic'
import { installScripted } from './support/scripted-llm'

// Doctor lines avoid diagnosis words: the Case Truth denylist would flag them in the transcript otherwise.
const Q1 = '您哪里不舒服？'
const Q2 = '有没有对什么药过敏？'
const Q3 = '平时抽烟吗？'
const R1 = '医生，我这三天一直发烧，咳嗽得厉害，晚上都睡不好。'
const R2 = '青霉素过敏，以前打针休克过一次。'
const R3 = '抽了三十年了，一天差不多一包。'

const persona = personaFor('golden-case-01', casePack.cases[0].persona.version)
if (!persona.ok) throw new Error(persona.error.message)
const PERSONA_PROMPT = personaPrompt(persona.persona)
const patient = (encounterId: string) => env.SIMULATED_PATIENT.getByName(encounterId)

describe('typed Consultation', () => {
  it('records the doctor question and the Simulated Patient reply in order, with speaker, time, source and attribution', async () => {
    const llm = installScripted('patient').reply(R1)
    const encounterId = await startEncounter()
    const before = Date.now()

    const { doctorTurn, patientTurn } = await asked(encounterId, Q1)
    expect(doctorTurn).toMatchObject({
      seq: 1,
      speaker: 'doctor',
      source: 'typed',
      attribution: 'workbench-input',
      text: Q1,
      status: 'final',
      replyTo: null,
    })
    expect(Date.parse(doctorTurn.createdAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(patientTurn).toMatchObject({
      seq: 2,
      speaker: 'patient',
      source: 'simulated',
      attribution: 'simulated-patient',
      replyTo: doctorTurn.turnId,
      attempt: 1,
    })

    const reply = await settled(encounterId, patientTurn.turnId)
    expect(reply).toMatchObject({ status: 'final', text: R1, failure: null, deadlineAt: null, settledAt: expect.any(String) })
    expect((await transcript(encounterId)).map((t) => [t.speaker, t.text])).toEqual([
      ['doctor', Q1],
      ['patient', R1],
    ])
    expect(llm.requests).toHaveLength(1)

    const audit = (await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse
    expect(audit.auditEvents.map((e) => [e.eventType, e.practitionerId])).toEqual([
      ['encounter-started', 'demo-practitioner'],
      ['consultation-question-asked', 'demo-practitioner'],
    ])
  })

  it('gives the Simulated Patient only its Patient Persona, the doctor utterances and its own settled replies', async () => {
    const llm = installScripted('patient').reply(R1).hang('我想想').reply(R2).reply(R3)
    const encounterId = await startEncounter()

    await settled(encounterId, (await asked(encounterId, Q1)).patientTurn.turnId)
    const failed = await settled(encounterId, (await asked(encounterId, Q2)).patientTurn.turnId)
    expect(failed).toMatchObject({ status: 'failed', failure: 'timeout', text: '我想想' })
    const retried = await retry(encounterId, failed.turnId)
    expect(retried.status).toBe(201)
    const { patientTurn: second } = (await retried.json()) as { patientTurn: { turnId: string } }
    await settled(encounterId, second.turnId)
    await settled(encounterId, (await asked(encounterId, Q3)).patientTurn.turnId)

    const system = { role: 'system', content: PERSONA_PROMPT }
    expect(llm.requests.map((r) => r.messages)).toEqual([
      [system, { role: 'user', content: Q1 }],
      [system, { role: 'user', content: Q1 }, { role: 'assistant', content: R1 }, { role: 'user', content: Q2 }],
      [system, { role: 'user', content: Q1 }, { role: 'assistant', content: R1 }, { role: 'user', content: Q2 }],
      [
        system,
        { role: 'user', content: Q1 },
        { role: 'assistant', content: R1 },
        { role: 'user', content: Q2 },
        { role: 'assistant', content: R2 },
        { role: 'user', content: Q3 },
      ],
    ])
    expect(llm.requests.every((r) => r.tools.length === 0)).toBe(true)
    expect(llm.requests[0]).toMatchObject({ model: 'glm-5.3-flash', effort: 'low' })
    expectNoCaseTruth('Simulated Patient requests', JSON.stringify(llm.requests))
    expectNoCaseTruth('transcript', JSON.stringify(await transcript(encounterId)))
  })

  it('refuses a new doctor turn while the previous one is pending, and accepts it once the reply settles', async () => {
    const llm = installScripted('patient')
    const gate = llm.gate('我', '这三天一直发烧。')
    llm.reply(R2)
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, Q1)
    await gate.reached

    const refused = await ask(encounterId, Q2)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as ErrorResponse).error.code).toBe('patient-turn-pending')
    const [simultaneousA, simultaneousB] = await Promise.all([ask(encounterId, Q2), ask(encounterId, Q3)])
    expect([simultaneousA.status, simultaneousB.status]).toEqual([409, 409])
    expect(await transcript(encounterId)).toHaveLength(2)

    gate.release()
    expect(await settled(encounterId, patientTurn.turnId)).toMatchObject({ status: 'final', text: '我这三天一直发烧。' })
    const next = await asked(encounterId, Q2)
    expect(next.doctorTurn.seq).toBe(3)
  })

  it('records a resent question once', async () => {
    installScripted('patient').reply(R1)
    const encounterId = await startEncounter()
    const first = await ask(encounterId, Q1, 'same-client-turn')
    const again = await ask(encounterId, Q1, 'same-client-turn')
    expect(first.status).toBe(201)
    expect(again.status).toBe(201)
    expect(((await again.json()) as { doctorTurn: { turnId: string } }).doctorTurn.turnId).toBe(
      ((await first.json()) as { doctorTurn: { turnId: string } }).doctorTurn.turnId,
    )
    expect((await transcript(encounterId)).filter((t) => t.speaker === 'doctor')).toHaveLength(1)
  })

  it('refuses empty, oversized and malformed questions', async () => {
    const encounterId = await startEncounter()
    for (const body of [{ clientTurnId: 'a', text: '   ' }, { clientTurnId: 'b', text: '问'.repeat(501) }, { text: Q1 }, null]) {
      const response = await send('POST', `/api/encounters/${encounterId}/consultation/doctor-turns`, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(((await response.json()) as ErrorResponse).error.code).toBe('invalid-request')
    }
    expect(await transcript(encounterId)).toEqual([])
  })
})

describe('failed patient turns', () => {
  it('marks a reply that runs past the deadline failed, releases the lock, keeps it, and retries it in one step', async () => {
    const llm = installScripted('patient').hang().reply(R1)
    const encounterId = await startEncounter()
    const { doctorTurn, patientTurn } = await asked(encounterId, Q1)
    expect(Date.parse(patientTurn.deadlineAt!) - Date.parse(patientTurn.createdAt)).toBe(1500)

    const failed = await settled(encounterId, patientTurn.turnId)
    expect(failed).toMatchObject({ status: 'failed', failure: 'timeout', deadlineAt: null })

    const response = await retry(encounterId, failed.turnId)
    expect(response.status).toBe(201)
    const { patientTurn: attempt2 } = (await response.json()) as { patientTurn: { turnId: string; attempt: number; replyTo: string } }
    expect(attempt2).toMatchObject({ attempt: 2, replyTo: doctorTurn.turnId })
    await settled(encounterId, attempt2.turnId)

    expect((await transcript(encounterId)).map((t) => [t.speaker, t.status, t.attempt, t.failure])).toEqual([
      ['doctor', 'final', 1, null],
      ['patient', 'failed', 1, 'timeout'],
      ['patient', 'final', 2, null],
    ])
    expect(llm.requests).toHaveLength(2)
    const audit = (await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse
    expect(audit.auditEvents.map((e) => e.eventType)).toContain('patient-reply-retried')
  })

  it('fails visibly with llm-not-configured when no model is configured, never hanging, and retries once one is', async () => {
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, Q1)
    expect(await settled(encounterId, patientTurn.turnId, 1000)).toMatchObject({ status: 'failed', failure: 'llm-not-configured' })

    installScripted('patient').reply(R1)
    const response = await retry(encounterId, patientTurn.turnId)
    const { patientTurn: attempt2 } = (await response.json()) as { patientTurn: { turnId: string } }
    expect(await settled(encounterId, attempt2.turnId)).toMatchObject({ status: 'final', text: R1 })
  })

  it('marks a model error failed', async () => {
    installScripted('patient').fail(503)
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, Q1)
    expect(await settled(encounterId, patientTurn.turnId)).toMatchObject({ status: 'failed', failure: 'llm-error' })
  })

  it('retries only the latest failed reply', async () => {
    installScripted('patient').reply(R1).fail(500)
    const encounterId = await startEncounter()
    const answered = await settled(encounterId, (await asked(encounterId, Q1)).patientTurn.turnId)
    const notRetryable = await retry(encounterId, answered.turnId)
    expect(notRetryable.status).toBe(409)
    expect(((await notRetryable.json()) as ErrorResponse).error.code).toBe('patient-turn-not-retryable')

    const failed = await settled(encounterId, (await asked(encounterId, Q2)).patientTurn.turnId)
    const doctorTurnId = (await transcript(encounterId))[0].turnId
    expect((await retry(encounterId, doctorTurnId)).status).toBe(409)
    expect((await retry(encounterId, 'no-such-turn')).status).toBe(404)
    expect(failed.status).toBe('failed')
  })

  it('refuses a late settlement once the workspace has expired the turn', async () => {
    installScripted('patient').hang()
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, Q1)
    await settled(encounterId, patientTurn.turnId)

    const late = await env.CLINIC_WORKSPACE.getByName('default').settlePatientTurn({
      encounterId,
      patientTurnId: patientTurn.turnId,
      outcome: { status: 'final', text: R1 },
    })
    expect(late.accepted).toBe(false)
    expect((await transcript(encounterId))[1]).toMatchObject({ status: 'failed', failure: 'timeout', text: '' })
  })

  it('fails the pending reply when the Encounter is abandoned, and the patient forgets the refused reply', async () => {
    const llm = installScripted('patient')
    const gate = llm.gate('嗯', '发烧三天了。')
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, Q1)
    await gate.reached
    expect((await send('POST', `/api/encounters/${encounterId}/abandonment`)).status).toBe(200)
    expect((await transcript(encounterId))[1]).toMatchObject({ status: 'failed', failure: 'encounter-ended' })

    gate.release()
    await runInDurableObjectUntil(encounterId, (sql) =>
      sql.exec<{ state: string }>(`SELECT state FROM agent_message WHERE role = 'assistant'`).toArray()[0]?.state === 'void',
    )
    expect((await transcript(encounterId)).find((t) => t.turnId === patientTurn.turnId)?.status).toBe('failed')
  })
})

describe('streaming over WebSocket', () => {
  it('streams reply deltas to the patient socket, then the settled event', async () => {
    installScripted('patient').reply(R1, { chunkSize: 3 })
    const encounterId = await startEncounter()
    const socket = await openPatientSocket(encounterId)
    const { patientTurn } = await asked(encounterId, Q1)

    await socket.waitFor((m) => eventsOf(m).some((e) => e.type === 'run.finished'))
    const events = eventsOf(socket.messages)
    expect(events[0]).toMatchObject({ type: 'run.started', ref: patientTurn.turnId })
    const deltas = events.filter((e) => e.type === 'text.delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.map((e) => ('text' in e ? e.text : '')).join('')).toBe(R1)
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', ref: patientTurn.turnId, status: 'done', error: null })
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b))
    for (const frame of socket.raw) expectNoCaseTruth('patient socket frame', frame)
    expect(await settled(encounterId, patientTurn.turnId)).toMatchObject({ status: 'final', text: R1 })
    socket.close()
  })

  it('replays a live reply to a socket that reconnects, from the sequence number it last saw', async () => {
    const llm = installScripted('patient')
    const gate = llm.gate('我这三天', '一直发烧。')
    const encounterId = await startEncounter()
    const first = await openPatientSocket(encounterId)
    await asked(encounterId, Q1)
    await gate.reached
    await first.waitFor((m) => eventsOf(m).some((e) => e.type === 'text.delta'))
    const seen = eventsOf(first.messages)
    first.close()

    const fresh = await openPatientSocket(encounterId)
    expect(eventsOf(fresh.messages).map((e) => e.type)).toEqual(['run.started', 'text.delta'])
    const resumed = await openPatientSocket(encounterId, seen.at(-1)!.seq)
    expect(eventsOf(resumed.messages)).toEqual([])
    expect(resumed.messages.at(-1)).toEqual({ type: 'replay.done', seq: seen.at(-1)!.seq })

    gate.release()
    await resumed.waitFor((m) => eventsOf(m).some((e) => e.type === 'run.finished'))
    expect(eventsOf(resumed.messages).map((e) => e.type)).toEqual(['text.delta', 'run.finished'])

    const ahead = await openPatientSocket(encounterId, 10_000)
    expect(ahead.messages).toEqual([{ type: 'resync' }])
    for (const s of [fresh, resumed, ahead]) s.close()
  })

  it('refuses a socket without an upgrade, and for an unknown Encounter', async () => {
    const encounterId = await startEncounter()
    expect((await api(`/api/encounters/${encounterId}/patient/socket`)).status).toBe(426)
    expect((await api('/api/encounters/nope/patient/socket', { headers: { upgrade: 'websocket' } })).status).toBe(404)
  })
})

describe('durability', () => {
  it('keeps the transcript and the patient session across restarts of both Durable Objects', async () => {
    const llm = installScripted('patient').reply(R1).reply(R2)
    const encounterId = await startEncounter()
    await settled(encounterId, (await asked(encounterId, Q1)).patientTurn.turnId)

    await evictDurableObject(env.CLINIC_WORKSPACE.getByName('default'))
    await evictDurableObject(patient(encounterId))
    expect((await transcript(encounterId)).map((t) => t.text)).toEqual([Q1, R1])

    await settled(encounterId, (await asked(encounterId, Q2)).patientTurn.turnId)
    expect(llm.requests[1].messages.slice(1)).toEqual([
      { role: 'user', content: Q1 },
      { role: 'assistant', content: R1 },
      { role: 'user', content: Q2 },
    ])
  })

  it('recovers a reply whose Simulated Patient crashed mid-stream, restarting it from its last checkpoint', async () => {
    const llm = installScripted('patient')
    const gate = llm.gate('我', '（不会说完）')
    llm.reply(R1)
    const encounterId = await startEncounter()
    const socket = await openPatientSocket(encounterId)
    const { patientTurn } = await asked(encounterId, Q1)
    await gate.reached

    // Eviction waits for the in-flight alarm to drain, so a crash is simulated by aborting the instances instead.
    await abortAllDurableObjects()
    expect(await runDurableObjectAlarm(patient(encounterId))).toBe(true)

    expect(await settled(encounterId, patientTurn.turnId)).toMatchObject({ status: 'final', text: R1 })
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1].messages).toEqual(llm.requests[0].messages)
    const replay = await openPatientSocket(encounterId)
    expect(eventsOf(replay.messages).map((e) => e.type)).toEqual(['run.started', 'run.reset', 'run.finished'])
    socket.close()
    replay.close()
  })

  it('fails a crashed reply whose deadline passed while the Simulated Patient was down', async () => {
    const llm = installScripted('patient')
    const gate = llm.gate('我', '（不会说完）')
    const encounterId = await startEncounter()
    const { patientTurn } = await asked(encounterId, Q1)
    await gate.reached
    await abortAllDurableObjects()

    // Nothing wakes the patient but the watchdog alarm the run armed at its deadline.
    expect(await settled(encounterId, patientTurn.turnId)).toMatchObject({ status: 'failed', failure: 'timeout' })
    await runInDurableObjectUntil(encounterId, (sql) => {
      const run = sql.exec<{ status: string; error: string | null }>('SELECT status, error FROM agent_run').one()
      return run.status === 'failed' && run.error === 'timeout'
    })
    expect(llm.requests).toHaveLength(1)
  })
})

async function runInDurableObjectUntil(encounterId: string, check: (sql: SqlStorage) => boolean) {
  await vi.waitFor(
    async () => expect(await runInDurableObject(patient(encounterId), (_instance, state) => check(state.storage.sql))).toBe(true),
    { timeout: 3000, interval: 20 },
  )
}
