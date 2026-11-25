import { COMPLETION_GATE_LABELS, completionGates, dispositionRecorded, type CaseDebriefReference, type ClinicalDrafts } from '../../src/shared/completion'
import type { AgentEvent, ClientMessage, ServerMessage } from '../../src/shared/agent-wire'
import type { ConsultationTurn, PatientTurnFailure } from '../../src/shared/consultation'
import type { EncounterError, EncounterView } from '../../src/shared/encounter'
import type { GoldenCaseQueueEntry } from '../../src/shared/golden-case-queue'
import type { CopilotCompactionEntry } from '../../src/shared/copilot-context'
import type { CopilotSnapshot, CopilotTurn } from '../../src/shared/copilot-turn'
import { BODY_SYSTEM_NAME, isBodySystem, type PhysicalExaminationView } from '../../src/shared/physical-examination'
import { goldenCase1Chart, goldenCase1Findings, goldenCase1QueueEntry } from '../fixtures/golden-case-1'
import type { ClinicalNoteView } from '../../src/shared/clinical-note'
import type { DiagnosisView } from '../../src/shared/diagnosis'
import { createFakeClinicalNotes } from './fake-clinical-note'
import { createFakeDiagnoses } from './fake-diagnosis'
import { createFakeInvestigations, fakeCatalog } from './fake-investigations'
import { createFakePrescriptions, fakeMedicationCatalog } from './fake-prescriptions'

// A tiny canonical 44-byte-header WAV the speech endpoint answers with.
const SPEECH_WAV = (() => {
  const bytes = new Uint8Array(48)
  const view = new DataView(bytes.buffer)
  'RIFF'.split('').forEach((s, i) => (bytes[i] = s.charCodeAt(0)))
  view.setUint32(4, bytes.byteLength - 8, true)
  'WAVEfmt '.split('').forEach((s, i) => (bytes[8 + i] = s.charCodeAt(0)))
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  'data'.split('').forEach((s, i) => (bytes[36 + i] = s.charCodeAt(0)))
  view.setUint32(40, 4, true)
  return bytes.buffer
})()

const STATUS: Record<EncounterError['code'], number> = {
  'catalog-item-not-found': 404,
  'investigation-already-issued': 409,
  'investigation-not-found': 404,
  'investigation-cancelled': 409,
  'investigation-already-reported': 409,
  'report-not-found': 404,
  'report-superseded': 409,
  'report-already-acknowledged': 409,
  'invalid-request': 400,
  'golden-case-not-found': 404,
  'encounter-not-found': 404,
  'active-encounter-exists': 409,
  'encounter-not-active': 409,
  'completion-gates-unmet': 409,
  'debrief-locked': 409,
  'body-system-already-examined': 409,
  'case-version-retired': 409,
  'consultation-turn-not-found': 404,
  'patient-turn-pending': 409,
  'patient-turn-not-retryable': 409,
  'clinical-note-incomplete': 422,
  'diagnosis-needs-primary': 422,
  'diagnosis-not-confirmed': 409,
  MEDICATION_ALLERGY_CONFLICT: 409,
  'medication-override-required': 422,
  'no-medication-conflict': 409,
  'copilot-busy': 409,
  'copilot-turn-not-found': 404,
  'copilot-nothing-to-compact': 409,
  'copilot-llm-unavailable': 503,
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
    voice: null,
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
  notes = {} as Record<string, ClinicalNoteView>,
  diagnoses = {} as Record<string, DiagnosisView>,
  recognizer = 'web-speech' as 'web-speech' | 'paraformer-realtime-v2',
  patientSpeech = false,
  debriefReference = undefined as CaseDebriefReference | undefined,
} = {}) {
  const state = { encounters: [...encounters], examinations: structuredClone(examinations), started: 0, runs: 0 }
  // The Clinical Copilot's session per Encounter, with its own event log for its socket.
  const copilotSessions = new Map<string, { turns: CopilotTurn[]; queued: { turnId: string; kind: 'doctor'; text: string }[]; seq: number; model: CopilotSnapshot['model']; events: { seq: number; event: AgentEvent }[]; compactions?: CopilotCompactionEntry[] }>()
  const copilotOf = (encounterId: string) =>
    copilotSessions.get(encounterId) ??
    copilotSessions
      .set(encounterId, {
        turns: [],
        queued: [],
        seq: 0,
        model: { model: 'glm-5.3-flash', effort: 'low', defaultModel: 'glm-5.3-flash', defaultEffort: 'low', options: ['glm-5.3-flash', 'glm-5.3'] },
        events: [],
      })
      .get(encounterId)!
  const copilotSockets = new Set<FakeCopilotSocket>()
  let copilotPromptCount = 0
  const turns = new Map(Object.entries(consultations).map(([id, list]) => [id, [...list]]))
  // Patient speech requests the workbench made to the Sambert endpoint.
  const speechRequests: { encounterId: string; turnId: string; text: string }[] = []
  const log: { encounterId: string; seq: number; event: AgentEvent }[] = []
  const runOf = new Map<string, string>()
  const sockets = new Set<FakePatientSocket>()
  const voiceSockets = new Set<FakeVoiceSocket>()
  const active = () => state.encounters.find((e) => e.status === 'active') ?? null
  const investigations = createFakeInvestigations(refuse)
  const clinicalNotes = createFakeClinicalNotes(refuse, notes)
  const fakeDiagnoses = createFakeDiagnoses(refuse, diagnoses)
  const fakePrescriptions = createFakePrescriptions(refuse, (encounterId) => fakeDiagnoses.diagnosis(encounterId).revisions.length > 0)
  const turnsOf = (encounterId: string) => turns.get(encounterId) ?? turns.set(encounterId, []).get(encounterId)!
  const pendingOf = (encounterId: string) => turnsOf(encounterId).find((t) => t.status === 'pending')

  const draftsByEncounter = new Map<string, ClinicalDrafts>()
  const draftsOf = (id: string) => draftsByEncounter.get(id) ?? { investigations: [], prescriptions: [] }
  const queue = (): GoldenCaseQueueEntry[] => {
    const completed = state.encounters.findLast((e) => e.status === 'completed')
    return [{
      ...goldenCase1QueueEntry,
      queueStatus: active() ? 'in-encounter' : completed ? 'completed' : 'waiting',
      ...(completed && { completedEncounterId: completed.encounterId }),
    }]
  }

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

  function askPatient(encounter: EncounterView, body: { clientTurnId: string; text: string; voice?: ConsultationTurn['voice'] }) {
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    if (pendingOf(encounter.encounterId)) return refuse('patient-turn-pending', '患者还在回答上一个问题，请稍候再问。')
    const list = turnsOf(encounter.encounterId)
    const doctorTurn = turnFor({
      seq: list.length + 1,
      speaker: 'doctor',
      text: body.text.trim(),
      createdAt: new Date().toISOString(),
      source: body.voice ? 'voice' : 'typed',
      attribution: body.voice ? 'workbench-microphone' : 'workbench-input',
      voice: body.voice ?? null,
    })
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
    if (method === 'GET' && path === '/api/voice') return Response.json({ recognizer })
    if (method === 'GET' && path === '/api/investigation-catalog') {
      return Response.json({ catalogVersion: 'fake', items: fakeCatalog })
    }
    if (method === 'GET' && path === '/api/medication-catalog') {
      return Response.json({ catalogVersion: 'fake', items: fakeMedicationCatalog })
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
    const drafts = draftsOf(encounterId)
    if (method === 'GET' && action === 'clinical-drafts') return Response.json({ drafts })
    if (method === 'PUT' && (action === 'investigations/draft' || action === 'prescriptions/draft')) {
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      const next = { ...drafts, [action.split('/')[0]]: (body as { entries: unknown }).entries }
      draftsByEncounter.set(encounterId, next)
      return Response.json({ drafts: next })
    }
    const debriefRecord = () => ({
      signedNote: clinicalNotes.note(encounterId).revisions.at(-1),
      diagnoses: fakeDiagnoses.diagnosis(encounterId).revisions.at(-1)?.entries ?? [],
      investigations: investigations.list(encounterId),
      examinations: state.examinations[encounterId] ?? [],
      prescriptions: fakePrescriptions.view(encounterId),
      questions: turnsOf(encounterId).filter((turn) => turn.speaker === 'doctor'),
      dispositionRecorded: dispositionRecorded(clinicalNotes.note(encounterId).revisions.at(-1)?.sections.plan ?? ''),
    })
    if (method === 'POST' && action === 'completion') {
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      const record = debriefRecord()
      const gates = completionGates(fakeDiagnoses.diagnosis(encounterId), record.investigations, record.prescriptions, record.signedNote, drafts)
      const failed = gates.filter((gate) => !gate.met)
      if (failed.length) return refuse('completion-gates-unmet', `未满足完诊条件：${failed.map((gate) => COMPLETION_GATE_LABELS[gate.id]).join('、')}`)
      Object.assign(encounter, { status: 'completed', endedAt: new Date().toISOString() })
      return Response.json({ encounter })
    }
    if (method === 'GET' && action === 'debrief') {
      if (encounter.status !== 'completed' || !debriefReference) return refuse('debrief-locked', '完诊后才能查看病例复盘。')
      return Response.json({ debrief: { ...debriefRecord(), reference: debriefReference } })
    }
    const answered =
      action &&
      (investigations.handle(method, encounter, action, body) ??
        clinicalNotes.handle(method, encounter, action, body) ??
        fakeDiagnoses.handle(method, encounter, action, body) ??
        fakePrescriptions.handle(method, encounter, action, body))
    if (answered) {
      if (answered.ok && method === 'POST' && (action === 'investigations' || action === 'prescriptions')) {
        draftsByEncounter.set(encounterId, { ...drafts, [action]: [] })
      }
      return answered
    }
    if (method === 'GET' && action === 'consultation') return Response.json({ turns: turnsOf(encounter.encounterId) })
    if (method === 'POST' && action === 'consultation/doctor-turns') return askPatient(encounter, JSON.parse(String(init?.body)))
    const retried = action?.match(/^consultation\/patient-turns\/([^/]+)\/retry$/)
    if (method === 'POST' && retried) return retry(encounter, retried[1])
    const speech = action?.match(/^consultation\/patient-turns\/([^/]+)\/speech$/)
    if (method === 'POST' && speech) {
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，不再合成语音。')
      if (!patientSpeech) return refuse('invalid-request', '未配置语音合成（BAILIAN_TOKEN）。')
      const requested = body as { text?: string }
      if (typeof requested?.text !== 'string' || !requested.text.trim()) return refuse('invalid-request', '请求体须为 { "text": string }')
      speechRequests.push({ encounterId: encounter.encounterId, turnId: speech[1], text: requested.text })
      return new Response(SPEECH_WAV.slice(0), { headers: { 'content-type': 'audio/wav' } })
    }
    if (action === 'copilot/context') {
      const session = copilotOf(encounter.encounterId)
      const items = [
        { id: 'ctx-1', category: 'system', label: '系统提示词', tokens: 214, text: '你是门诊临床助手（Clinical Copilot）…' },
        { id: 'ctx-2', category: 'his_state_ui', label: 'HIS 状态（就诊概况）', tokens: 96, text: '## 当前就诊概况' },
        { id: 'ctx-3', category: 'consultation', label: '问诊记录（已定稿）', tokens: 88, text: '## 问诊记录' },
        { id: 'ctx-4', category: 'tools', label: '工具定义', tokens: 310, text: '[…]' },
      ]
      const requests = session.turns.map((turn, i) => ({
        runId: turn.turnId,
        step: 0,
        at: turn.startedAt,
        items: items.map(({ id, category, label, tokens }) => ({ id, category, label, tokens })),
        estimatedInput: 708 + i * 40,
        providerInput: 720 + i * 36,
        reconciled: [
          { category: 'system' as const, tokens: 220 },
          { category: 'tools' as const, tokens: 318 },
          { category: 'consultation' as const, tokens: 90 },
          { category: 'his_state_ui' as const, tokens: 92 },
        ],
      }))
      const context = {
        modelWindow: 128000,
        reserve: 32000,
        usable: 96000,
        estimatedInput: 708 + Math.max(0, session.turns.length - 1) * 40,
        items,
        caseTruth: { tokens: 0, isolated: true },
        requests,
        compactions: structuredClone(session.compactions ?? []),
      }
      return Response.json({ context })
    }
    if (method === 'POST' && action === 'copilot/compact') {
      const session = copilotOf(encounter.encounterId)
      const markerId = (session.compactions?.at(-1)?.markerId ?? 0) + 1
      const marker: CopilotCompactionEntry = {
        markerId,
        runId: `compaction-run-${markerId}`,
        at: new Date().toISOString(),
        summarizedMessages: Math.max(1, session.turns.length),
        tokensBefore: 640,
        tokensAfter: 120,
        summary: '要点摘要：……',
      }
      session.compactions = [...(session.compactions ?? []), marker]
      emitCopilot(encounter.encounterId, { type: 'session.updated', runId: null })
      return Response.json({ turnId: `compaction-${marker.markerId}` }, { status: 202 })
    }
    if (action === 'copilot' || (method === 'POST' && action === 'copilot/prompts')) {
      const session = copilotOf(encounter.encounterId)
      if (method === 'GET') return Response.json({ snapshot: copilotSnapshotOf(encounter.encounterId) })
      if (method === 'POST') {
        const kind = (body as { mode?: string })?.mode
        if (kind !== 'queue' && kind !== 'steer') throw new Error('fake copilot prompts need mode')
        const text = (body as { text: string }).text
        if (session.turns.some((t) => t.status === 'running')) {
          if (kind === 'steer') {
            const running = session.turns.find((t) => t.status === 'running')!
            running.steers.push({ text, sentAt: new Date().toISOString(), read: false })
            emitCopilot(encounter.encounterId, { type: 'steer.added', runId: running.turnId })
            return Response.json({ kind: 'steer', turnId: running.turnId }, { status: 201 })
          }
          const queuedId = `copilot-turn-${++copilotPromptCount}`
          session.queued.push({ turnId: queuedId, kind: 'doctor', text })
          emitCopilot(encounter.encounterId, { type: 'run.queued', runId: queuedId, ref: null })
          return Response.json({ kind: 'run', turnId: queuedId }, { status: 201 })
        }
        const turnId = `copilot-turn-${++copilotPromptCount}`
        session.turns.push({
          turnId,
          trigger: { kind: 'doctor', text, mentions: ((body as { mentions?: CopilotTurn['trigger']['mentions'] })?.mentions ?? []) },
          status: 'running',
          failure: null,
          stopReason: null,
          steps: [{ kind: 'think', text: '', state: 'running' }],
          steers: [],
          reply: '',
          usage: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          feedback: null,
          superseded: false,
        })
        emitCopilot(encounter.encounterId, { type: 'run.started', runId: turnId, ref: null })
        emitCopilot(encounter.encounterId, { type: 'step.started', runId: turnId, step: 0 })
        return Response.json({ kind: 'run', turnId }, { status: 201 })
      }
    }
    const stopped = action === 'copilot/stop'
    if (stopped) {
      const session = copilotOf(encounter.encounterId)
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      const running = session.turns.find((t) => t.status === 'running')
      if (!running) return Response.json({ stoppedTurnId: null })
      finishCopilotTurn(encounter.encounterId, running.turnId, 'stopped')
      return Response.json({ stoppedTurnId: running.turnId })
    }
    const resend = action?.match(/^copilot\/turns\/([^/]+)\/resend$/)
    if (method === 'POST' && resend) {
      const session = copilotOf(encounter.encounterId)
      const original = session.turns.find((t) => t.turnId === resend[1])
      if (!original) return refuse('copilot-turn-not-found', `找不到临床助手轮 ${resend[1]}`)
      const text = (body as { text: string }).text
      const turnId = `copilot-turn-${++copilotPromptCount}`
      original.superseded = true
      session.turns.push({ ...structuredClone(original), turnId, trigger: { ...original.trigger, text }, status: 'running', reply: '', startedAt: new Date().toISOString(), steers: [] })
      emitCopilot(encounter.encounterId, { type: 'run.started', runId: turnId, ref: null })
      return Response.json({ kind: 'run', turnId }, { status: 201 })
    }
    const feedback = action?.match(/^copilot\/turns\/([^/]+)\/feedback$/)
    if (method === 'POST' && feedback) {
      const session = copilotOf(encounter.encounterId)
      const turn = session.turns.find((t) => t.turnId === feedback[1])
      if (!turn) return refuse('copilot-turn-not-found', `找不到临床助手轮 ${feedback[1]}`)
      turn.feedback = (body as { value: CopilotTurn['feedback'] }).value
      emitCopilot(encounter.encounterId, { type: 'session.updated', runId: null })
      return Response.json({ ok: null })
    }
    if (method === 'POST' && action === 'copilot/config') {
      const session = copilotOf(encounter.encounterId)
      const { model, effort } = body as { model: string; effort: CopilotSnapshot['model']['effort'] }
      if (!session.model.options.includes(model)) return refuse('invalid-request', `模型 ${model} 不在可选列表中`)
      session.model = { ...session.model, model, effort }
      emitCopilot(encounter.encounterId, { type: 'session.updated', runId: null })
      return Response.json(session.model)
    }
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

  function copilotSnapshotOf(encounterId: string): CopilotSnapshot {
    const session = copilotOf(encounterId)
    return {
      seq: session.events.at(-1)?.seq ?? 0,
      checkpoint: 0,
      model: session.model,
      turns: structuredClone(session.turns),
      queued: structuredClone(session.queued),
      compactions: structuredClone(session.compactions ?? []),
      countdown: null,
    }
  }

  function emitCopilot(encounterId: string, event: AgentEvent) {
    const session = copilotOf(encounterId)
    const entry = { seq: ++session.seq, event }
    session.events.push(entry)
    for (const socket of copilotSockets) if (socket.encounterId === encounterId) socket.deliver(entry)
  }

  function finishCopilotTurn(encounterId: string, turnId: string, status: 'done' | 'stopped', reply = '', steps: CopilotTurn['steps'] = []) {
    const session = copilotOf(encounterId)
    const turn = session.turns.find((t) => t.turnId === turnId)!
    Object.assign(turn, {
      status,
      reply,
      steps: steps.length > 0 ? steps : turn.steps.map((step) => ({ ...step, state: status === 'done' ? ('done' as const) : ('stopped' as const) })),
      usage: status === 'done' ? { in: 320, out: 96 } : null,
      finishedAt: new Date().toISOString(),
      stopReason: status === 'stopped' ? ('stop-requested' as const) : null,
    })
    emitCopilot(encounterId, { type: 'step.finished', runId: turnId, step: 0 })
    emitCopilot(encounterId, { type: 'run.finished', runId: turnId, ref: null, status, error: null })
    const next = session.queued.shift()
    if (next) {
      session.turns.push({
        turnId: next.turnId,
        trigger: { kind: next.kind, text: next.text, mentions: [] },
        status: 'running',
        failure: null,
        stopReason: null,
        steps: [{ kind: 'think', text: '', state: 'running' }],
        steers: [],
        reply: '',
        usage: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        feedback: null,
        superseded: false,
      })
      emitCopilot(encounterId, { type: 'run.started', runId: next.turnId, ref: null })
    }
  }

  class FakeCopilotSocket {
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    readonly encounterId: string
    private ready = false
    private closed = false

    constructor(url: string) {
      this.encounterId = decodeURIComponent(url.match(/\/api\/encounters\/([^/]+)\/copilot\/socket$/)![1])
      copilotSockets.add(this)
      setTimeout(() => !this.closed && this.onopen?.(), 0)
    }

    send(data: string) {
      const message = JSON.parse(data) as ClientMessage
      if (message.type !== 'hello') return
      const session = copilotOf(this.encounterId)
      for (const entry of session.events) if (entry.seq > message.afterSeq) this.push({ type: 'event', seq: entry.seq, event: entry.event })
      this.push({ type: 'replay.done', seq: session.events.at(-1)?.seq ?? 0 })
      this.ready = true
    }

    deliver(entry: { seq: number; event: AgentEvent }) {
      if (this.ready) this.push({ type: 'event', seq: entry.seq, event: entry.event })
    }

    close() {
      if (this.closed) return
      this.closed = true
      copilotSockets.delete(this)
      setTimeout(() => this.onclose?.(), 0)
    }

    private push(message: ServerMessage) {
      setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(message) }), 0)
    }
  }

  // One constructor dispatches to the transport selected by the browser.
  class FakeSocket {
    private readonly inner: FakePatientSocket | FakeCopilotSocket | FakeVoiceSocket
    constructor(url: string) {
      if (url.endsWith('/voice')) this.inner = new FakeVoiceSocket(url)
      else if (url.endsWith('/copilot/socket')) this.inner = new FakeCopilotSocket(url)
      else this.inner = new FakePatientSocket(url)
    }
    get onopen() { return this.inner.onopen }
    set onopen(value) { this.inner.onopen = value }
    get onmessage() { return this.inner.onmessage }
    set onmessage(value) { this.inner.onmessage = value }
    get onclose() { return this.inner.onclose }
    set onclose(value) { this.inner.onclose = value }
    send(data: string) { this.inner.send(data) }
    close() { this.inner.close() }
  }


  // The voice socket (the agents/voice protocol subset the workbench uses), driven by the test like the Worker
  // would be: the test calls interim()/voiceTurn(), the bar's messages land in `sent`/`frames`.
  class FakeVoiceSocket {
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    readonly encounterId: string
    readonly sent: { type: string; mode?: string; clientTurnId?: string }[] = []
    frames = 0
    private closed = false

    constructor(url: string) {
      this.encounterId = decodeURIComponent(url.match(/\/api\/encounters\/([^/]+)\/voice$/)![1])
      voiceSockets.add(this)
      setTimeout(() => !this.closed && this.onopen?.(), 0)
    }

    close() {
      if (this.closed) return
      this.closed = true
      voiceSockets.delete(this)
      setTimeout(() => this.onclose?.(), 0)
    }

    send(data: string | ArrayBuffer) {
      if (typeof data === 'string') {
        const message = JSON.parse(data) as { type: string; mode?: string; clientTurnId?: string }
        this.sent.push(message)
        if (message.type === 'start_call') this.push({ type: 'status', status: 'listening' })
        if (message.type === 'clinmesh.resubmit') this.resubmitIds.push(message.clientTurnId!)
      } else {
        this.frames++
      }
    }

    readonly resubmitIds: string[] = []

    private push(message: Record<string, unknown>) {
      setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(message) }), 0)
    }

    interim(text: string) {
      this.push({ type: 'transcript_interim', text })
    }

    empty() {
      this.push({ type: 'clinmesh.capture-empty' })
    }

    error(code: string, message: string) {
      this.push({ type: 'error', code, message })
    }

    voiceTurn(doctorTurn: ConsultationTurn, patientTurn: ConsultationTurn, latencyMs = 120) {
      this.push({ type: 'clinmesh.voice-turn', ok: true, doctorTurn, patientTurn, latencyMs })
    }

    refused(doctorText: string, code = 'patient-turn-pending') {
      this.push({ type: 'clinmesh.voice-turn', ok: false, clientTurnId: 'refused-1', text: doctorText, error: { code, message: '患者还在回答上一个问题。' }, latencyMs: 90 })
    }
  }

  // A spoken doctor turn for the socket's voice-turn messages; the workspace keeps the record.
  function spokenTurn(seq: number, text: string): ConsultationTurn {
    return turnFor({
      seq,
      speaker: 'doctor',
      source: 'voice',
      attribution: 'workbench-microphone',
      text,
      createdAt: new Date().toISOString(),
      voice: { recognizer, durationMs: 1400, confidence: null },
    })
  }
  return {
    handle,
    speechRequests: () => [...speechRequests],
    VoiceSocket: FakeVoiceSocket,
    voiceSockets: () => [...voiceSockets],
    spokenTurn,
    WebSocket: FakeSocket as unknown as typeof FakePatientSocket,
    encounters: () => state.encounters,
    investigations: investigations.list,
    note: clinicalNotes.note,
    diagnosis: fakeDiagnoses.diagnosis,
    prescriptions: fakePrescriptions.view,
    turns: (encounterId: string) => turnsOf(encounterId),
    amendReport: investigations.amend,
    // Another browser tab starting an Encounter behind this one's back.
    startElsewhere: (caseId: string) => startEncounter(caseId),
    openSockets: () => [...sockets],
    copilot: {
      snapshot: copilotSnapshotOf,
      // The assistant answers the running turn: a think step, a tool read, then the reply.
      answer: (encounterId: string, text: string) => {
        const session = copilotOf(encounterId)
        const running = session.turns.find((t) => t.status === 'running')
        if (!running) throw new Error('No copilot turn is running')
        const steps = [
          { kind: 'think' as const, text: '先看问诊记录。', state: 'done' as const, dur: 0.4 },
          { kind: 'tool' as const, callId: 'call-1', name: 'read_encounter_state', subject: '就诊状态', args: {}, result: '{}', state: 'ok' as const, dur: 0.2 },
        ]
        emitCopilot(encounterId, { type: 'text.delta', runId: running.turnId, text })
        finishCopilotTurn(encounterId, running.turnId, 'done', text, steps)
      },
      stream: (encounterId: string, text: string) => {
        const running = copilotOf(encounterId).turns.find((turn) => turn.status === 'running')
        if (!running) throw new Error('No running Copilot turn')
        running.reply += text
        emitCopilot(encounterId, { type: 'text.delta', runId: running.turnId, text })
      },
      stop: (encounterId: string) => {
        const running = copilotOf(encounterId).turns.find((t) => t.status === 'running')
        if (!running) throw new Error('No copilot turn is running')
        finishCopilotTurn(encounterId, running.turnId, 'stopped')
      },
      // A network drop: every socket closes, and the page has to reconnect.
      dropConnections: () => [...copilotSockets].forEach((socket) => socket.close()),
    },
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
