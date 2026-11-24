import type { AgentEvent, ClientMessage, ServerMessage } from '../../src/shared/agent-wire'
import type { ConsultationTurn, PatientTurnFailure } from '../../src/shared/consultation'
import type { EncounterError, EncounterView } from '../../src/shared/encounter'
import type { GoldenCaseQueueEntry } from '../../src/shared/golden-case-queue'
import { BODY_SYSTEM_NAME, isBodySystem, type PhysicalExaminationView } from '../../src/shared/physical-examination'
import { goldenCase1Chart, goldenCase1Findings, goldenCase1QueueEntry } from '../fixtures/golden-case-1'
import { createFakeInvestigations, fakeCatalog } from './fake-investigations'

const STATUS: Record<EncounterError['code'], number> = {
  'catalog-item-not-found': 404,
  'investigation-already-issued': 409,
  'investigation-not-found': 404,
  'report-not-found': 404,
  'report-superseded': 409,
  'report-already-acknowledged': 409,
  'invalid-request': 400,
  'golden-case-not-found': 404,
  'encounter-not-found': 404,
  'active-encounter-exists': 409,
  'encounter-not-active': 409,
  'body-system-already-examined': 409,
  'case-version-retired': 409,
  'consultation-turn-not-found': 404,
  'patient-turn-pending': 409,
  'patient-turn-not-retryable': 409,
}

const refuse = (code: EncounterError['code'], message: string) => Response.json({ error: { code, message } }, { status: STATUS[code] })

export function encounterFor(overrides: Partial<EncounterView> = {}): EncounterView {
  return {
    ...goldenCase1Chart,
    encounterId: 'encounter-1',
    status: 'active',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    endedAt: null,
    ...overrides,
  }
}

export function examinationFor(system: keyof typeof goldenCase1Findings, examinedAt = new Date().toISOString()): PhysicalExaminationView {
  return { system, ...goldenCase1Findings[system], practitionerId: goldenCase1Chart.practitionerId, examinedAt }
}

let turnIds = 0
export function turnFor(overrides: Partial<ConsultationTurn> & Pick<ConsultationTurn, 'seq' | 'speaker'>): ConsultationTurn {
  const doctor = overrides.speaker === 'doctor'
  const createdAt = overrides.createdAt ?? '2026-11-24T00:41:05.000Z'
  return {
    turnId: `turn-${++turnIds}`,
    source: doctor ? 'typed' : 'simulated',
    attribution: doctor ? 'workbench-input' : 'simulated-patient',
    text: '',
    status: 'final',
    replyTo: null,
    attempt: 1,
    createdAt,
    settledAt: overrides.status === 'pending' ? null : createdAt,
    deadlineAt: null,
    failure: null,
    ...overrides,
  }
}

// A socket that never connects: the default for tests that don't exercise the patient stream.
export class SilentWebSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send() {}
  close() {}
}

// Stands in for the Worker at the fetch and WebSocket boundaries, following the HTTP and socket contracts the
// Worker seam tests pin down. `patient` plays the Simulated Patient.
export function createFakeClinicApi({
  encounters = [] as EncounterView[],
  examinations = {} as Record<string, PhysicalExaminationView[]>,
  consultations = {} as Record<string, ConsultationTurn[]>,
} = {}) {
  const state = { encounters: [...encounters], examinations: structuredClone(examinations), started: 0, runs: 0 }
  const turns = new Map(Object.entries(consultations).map(([id, list]) => [id, [...list]]))
  const log: { encounterId: string; seq: number; event: AgentEvent }[] = []
  const runOf = new Map<string, string>()
  const sockets = new Set<FakePatientSocket>()
  const active = () => state.encounters.find((e) => e.status === 'active') ?? null
  const investigations = createFakeInvestigations(refuse)
  const turnsOf = (encounterId: string) => turns.get(encounterId) ?? turns.set(encounterId, []).get(encounterId)!
  const pendingOf = (encounterId: string) => turnsOf(encounterId).find((t) => t.status === 'pending')

  const queue = (): GoldenCaseQueueEntry[] => [
    { ...goldenCase1QueueEntry, queueStatus: active()?.caseId === goldenCase1QueueEntry.caseId ? 'in-encounter' : 'waiting' },
  ]

  function emit(encounterId: string, event: AgentEvent) {
    const entry = { encounterId, seq: log.length + 1, event }
    log.push(entry)
    for (const socket of sockets) if (socket.encounterId === encounterId) socket.deliver(entry.seq, event)
  }

  function startEncounter(caseId: string) {
    if (caseId !== goldenCase1QueueEntry.caseId) return refuse('golden-case-not-found', `找不到 Golden Case ${caseId}`)
    if (active()) return refuse('active-encounter-exists', `已有进行中的就诊（${active()!.patient.name}），完诊或放弃该就诊后才能开始新的就诊。`)
    const encounter = encounterFor({ encounterId: `started-${++state.started}`, startedAt: new Date().toISOString() })
    state.encounters.push(encounter)
    return Response.json({ encounter }, { status: 201 })
  }

  function replyAttempt(encounterId: string, doctorTurnId: string, attempt: number): ConsultationTurn {
    const now = new Date()
    const list = turnsOf(encounterId)
    const turn = turnFor({
      seq: list.length + 1,
      speaker: 'patient',
      status: 'pending',
      replyTo: doctorTurnId,
      attempt,
      createdAt: now.toISOString(),
      settledAt: null,
      deadlineAt: new Date(now.getTime() + 30_000).toISOString(),
    })
    list.push(turn)
    const runId = `run-${++state.runs}`
    runOf.set(turn.turnId, runId)
    emit(encounterId, { type: 'run.started', runId, ref: turn.turnId })
    return turn
  }

  function askPatient(encounter: EncounterView, body: { clientTurnId: string; text: string }) {
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    if (pendingOf(encounter.encounterId)) return refuse('patient-turn-pending', '患者还在回答上一个问题，请稍候再问。')
    const list = turnsOf(encounter.encounterId)
    const doctorTurn = turnFor({ seq: list.length + 1, speaker: 'doctor', text: body.text.trim(), createdAt: new Date().toISOString() })
    list.push(doctorTurn)
    const patientTurn = replyAttempt(encounter.encounterId, doctorTurn.turnId, 1)
    return Response.json({ doctorTurn, patientTurn }, { status: 201 })
  }

  function retry(encounter: EncounterView, turnId: string) {
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    const list = turnsOf(encounter.encounterId)
    const turn = list.find((t) => t.turnId === turnId)
    if (!turn) return refuse('consultation-turn-not-found', `找不到问诊记录 ${turnId}`)
    if (turn.status !== 'failed' || turn !== list.at(-1)) return refuse('patient-turn-not-retryable', '只能重试最近一条未成功的患者回答。')
    return Response.json({ patientTurn: replyAttempt(encounter.encounterId, turn.replyTo!, turn.attempt + 1) }, { status: 201 })
  }

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/api/golden-cases') return Response.json({ goldenCases: queue() })
    if (method === 'GET' && path === '/api/encounters/active') return Response.json({ encounter: active() })
    if (method === 'POST' && path === '/api/encounters') return startEncounter(JSON.parse(String(init?.body)).caseId)
    if (method === 'GET' && path === '/api/investigation-catalog') {
      return Response.json({ catalogVersion: 'fake', items: fakeCatalog })
    }

    const [, encounterId, action] = path.match(/^\/api\/encounters\/([^/]+)(?:\/(.+))?$/) ?? []
    const encounter = state.encounters.find((e) => e.encounterId === encounterId)
    if (!encounter) return refuse('encounter-not-found', `找不到就诊记录 ${encounterId}`)
    if (method === 'GET' && action === undefined) return Response.json({ encounter })
    if (action === 'physical-examinations') {
      const performed = (state.examinations[encounter.encounterId] ??= [])
      if (method === 'GET') return Response.json({ examinations: performed })
      const { system } = JSON.parse(String(init?.body)) as { system: unknown }
      if (!isBodySystem(system)) return refuse('invalid-request', '请求体须为 { "system": BodySystem }')
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      if (performed.some((e) => e.system === system)) {
        return refuse('body-system-already-examined', `本次就诊已查过${BODY_SYSTEM_NAME[system]}，每个部位只查一次。`)
      }
      const examination = examinationFor(system)
      performed.push(examination)
      return Response.json({ examination }, { status: 201 })
    }
    if (method === 'POST' && action === 'abandonment') {
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      Object.assign(encounter, { status: 'abandoned', endedAt: new Date().toISOString() })
      const waiting = pendingOf(encounter.encounterId)
      if (waiting) Object.assign(waiting, { status: 'failed', failure: 'encounter-ended', deadlineAt: null, settledAt: new Date().toISOString() })
      return Response.json({ encounter })
    }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const answered = action && investigations.handle(method, encounter, action, body)
    if (answered) return answered
    if (method === 'GET' && action === 'consultation') return Response.json({ turns: turnsOf(encounter.encounterId) })
    if (method === 'POST' && action === 'consultation/doctor-turns') return askPatient(encounter, JSON.parse(String(init?.body)))
    const retried = action?.match(/^consultation\/patient-turns\/([^/]+)\/retry$/)
    if (method === 'POST' && retried) return retry(encounter, retried[1])
    throw new Error(`The fake clinic API has no route for ${method} ${path}`)
  }

  // The patient's run finishes first; the workspace has the outcome only once the settlement is delivered.
  function finish(encounterId: string, status: 'done' | 'failed', error: string | null) {
    const turn = pendingOf(encounterId)
    if (!turn) throw new Error('No patient turn is pending')
    emit(encounterId, { type: 'run.finished', runId: runOf.get(turn.turnId)!, ref: turn.turnId, status, error })
    return turn
  }

  function settle(encounterId: string, update: Partial<ConsultationTurn>, announce = true) {
    const turn = pendingOf(encounterId)
    if (!turn) throw new Error('No patient turn is pending')
    Object.assign(turn, { deadlineAt: null, settledAt: new Date().toISOString(), ...update })
    if (announce) emit(encounterId, { type: 'run.settled', runId: runOf.get(turn.turnId)!, ref: turn.turnId, accepted: true })
  }

  class FakePatientSocket {
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    readonly encounterId: string
    private ready = false
    private closed = false

    constructor(url: string) {
      this.encounterId = decodeURIComponent(url.match(/\/api\/encounters\/([^/]+)\/patient\/socket$/)![1])
      sockets.add(this)
      setTimeout(() => !this.closed && this.onopen?.(), 0)
    }

    send(data: string) {
      const message = JSON.parse(data) as ClientMessage
      if (message.type !== 'hello') return
      const mine = log.filter((entry) => entry.encounterId === this.encounterId)
      const latest = mine.at(-1)?.seq ?? 0
      for (const entry of mine) if (entry.seq > message.afterSeq) this.push({ type: 'event', seq: entry.seq, event: entry.event })
      this.push({ type: 'replay.done', seq: latest })
      this.ready = true
    }

    deliver(seq: number, event: AgentEvent) {
      if (this.ready) this.push({ type: 'event', seq, event })
    }

    close() {
      if (this.closed) return
      this.closed = true
      sockets.delete(this)
      setTimeout(() => this.onclose?.(), 0)
    }

    private push(message: ServerMessage) {
      setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(message) }), 0)
    }
  }

  const pendingRun = (encounterId: string) => runOf.get(pendingOf(encounterId)!.turnId)!

  return {
    handle,
    WebSocket: FakePatientSocket,
    encounters: () => state.encounters,
    investigations: investigations.list,
    turns: (encounterId: string) => turnsOf(encounterId),
    // Another browser tab starting an Encounter behind this one's back.
    startElsewhere: (caseId: string) => startEncounter(caseId),
    openSockets: () => [...sockets],
    patient: {
      stream: (encounterId: string, text: string) => emit(encounterId, { type: 'text.delta', runId: pendingRun(encounterId), text }),
      answer: (encounterId: string, text: string) => {
        finish(encounterId, 'done', null)
        settle(encounterId, { status: 'final', text })
      },
      fail: (encounterId: string, failure: PatientTurnFailure) => {
        finish(encounterId, 'failed', failure)
        settle(encounterId, { status: 'failed', failure })
      },
      // The run is done, but its settlement hasn't reached the workspace yet.
      finishOnly: (encounterId: string) => finish(encounterId, 'done', null),
      deliver: (encounterId: string, text: string) => settle(encounterId, { status: 'final', text }),
      // The workspace fails the reply by itself (e.g. past its deadline) and no event says so.
      expireSilently: (encounterId: string) => settle(encounterId, { status: 'failed', failure: 'timeout' }, false),
      // A network drop: every open socket closes, and the page has to reconnect.
      dropConnections: () => [...sockets].forEach((socket) => socket.close()),
    },
  }
}
