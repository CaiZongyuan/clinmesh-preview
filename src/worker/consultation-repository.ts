import type { ConsultationTurn, PatientTurnFailure, Recognizer, SpeakerAttribution, TurnSource, TurnStatus, VoiceCapture } from '../shared/consultation'
import type { EncounterError } from '../shared/encounter'
import type { PatientReplyOutcome } from './simulated-patient/simulated-patient-do'

type TurnRow = {
  turn_id: string
  seq: number
  speaker: 'doctor' | 'patient'
  source: TurnSource
  attribution: SpeakerAttribution
  text: string
  status: TurnStatus
  reply_to: string | null
  attempt: number
  created_at: string
  settled_at: string | null
  deadline_at: string | null
  failure_reason: PatientTurnFailure | null
  settled_by: 'simulated-patient' | 'workspace' | null
  voice_recognizer: Recognizer | null
  voice_duration_ms: number | null
  voice_confidence: number | null
}

export interface Exchange {
  doctorTurn: ConsultationTurn
  patientTurn: ConsultationTurn
}

export type RetryResult = { ok: true; doctorTurn: ConsultationTurn; patientTurn: ConsultationTurn } | { ok: false; error: EncounterError }

const refuse = (error: EncounterError) => ({ ok: false, error }) as const

// The Consultation in the workspace store. Callers run each method inside one storage transaction and check
// that the Encounter is active before any doctor command.
export class ConsultationRepository {
  constructor(private readonly sql: SqlStorage) {}

  list(encounterId: string): ConsultationTurn[] {
    return this.sql
      .exec<TurnRow>('SELECT * FROM consultation_turn WHERE encounter_id = ? ORDER BY seq', encounterId)
      .toArray()
      .map(toTurn)
  }

  pending(encounterId: string): ConsultationTurn | undefined {
    const row = this.sql.exec<TurnRow>(`SELECT * FROM consultation_turn WHERE encounter_id = ? AND status = 'pending'`, encounterId).toArray()[0]
    return row && toTurn(row)
  }

  // The doctor turn a browser recorded under `clientTurnId`, with the latest reply attempt to it.
  exchangeFor(encounterId: string, clientTurnId: string): Exchange | undefined {
    const doctor = this.sql
      .exec<TurnRow>('SELECT * FROM consultation_turn WHERE encounter_id = ? AND client_turn_id = ?', encounterId, clientTurnId)
      .toArray()[0]
    return doctor && { doctorTurn: toTurn(doctor), patientTurn: this.latestReply(doctor.turn_id)! }
  }

  // A pending turn the Simulated Patient never settled fails once its deadline and a grace period have passed,
  // so the lock releases even if the patient agent is unreachable.
  expireOverdue(encounterId: string, now: Date, graceMs: number): void {
    const turn = this.pending(encounterId)
    if (turn?.deadlineAt && Date.parse(turn.deadlineAt) + graceMs <= now.getTime()) {
      this.fail(turn.turnId, 'timeout', now, 'workspace')
    }
  }

  ask(
    encounterId: string,
    question: { clientTurnId: string; text: string; practitionerId: string; voice?: VoiceCapture },
    now: Date,
    deadline: Date,
  ): Exchange {
    const doctorTurnId = crypto.randomUUID()
    const seq = this.nextSeq(encounterId)
    const { voice } = question
    this.sql.exec(
      `INSERT INTO consultation_turn (turn_id, encounter_id, seq, speaker, source, attribution, text, status, client_turn_id, practitioner_id, created_at, settled_at,
         voice_recognizer, voice_duration_ms, voice_confidence)
       VALUES (?, ?, ?, 'doctor', ?, ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?)`,
      doctorTurnId, encounterId, seq, voice ? 'voice' : 'typed', voice ? 'workbench-microphone' : 'workbench-input',
      question.text, question.clientTurnId, question.practitionerId, now.toISOString(), now.toISOString(),
      voice?.recognizer ?? null, voice ? Math.round(voice.durationMs) : null, voice?.confidence ?? null,
    )
    const patientTurn = this.insertReplyAttempt(encounterId, doctorTurnId, 1, now, deadline)
    return { doctorTurn: this.find(doctorTurnId)!, patientTurn }
  }

  // Only the latest turn, a failed reply, can be retried, so the Consultation keeps strict question/answer order.
  retry(encounterId: string, patientTurnId: string, now: Date, deadline: Date): RetryResult {
    const turn = this.find(patientTurnId)
    if (!turn || this.encounterOf(patientTurnId) !== encounterId) {
      return refuse({ code: 'consultation-turn-not-found', message: `找不到问诊记录 ${patientTurnId}` })
    }
    const latest = this.sql.exec<{ seq: number | null }>('SELECT max(seq) AS seq FROM consultation_turn WHERE encounter_id = ?', encounterId).one().seq
    if (turn.speaker !== 'patient' || turn.status !== 'failed' || turn.seq !== latest) {
      return refuse({ code: 'patient-turn-not-retryable', message: '只能重试最近一条未成功的患者回答。' })
    }
    return {
      ok: true,
      doctorTurn: this.find(turn.replyTo!)!,
      patientTurn: this.insertReplyAttempt(encounterId, turn.replyTo!, turn.attempt + 1, now, deadline),
    }
  }

  // First settlement wins. A patient turn the workspace already failed (expired, Encounter ended, patient
  // unreachable) refuses a late reply; one the Simulated Patient settled accepts the redelivery of that same
  // settlement (each patient turn is one run, settled once), so an outbox retry never voids an accepted reply.
  settle(encounterId: string, patientTurnId: string, outcome: PatientReplyOutcome, now: Date, graceMs: number): boolean {
    this.expireOverdue(encounterId, now, graceMs)
    const row = this.sql
      .exec<TurnRow>(`SELECT * FROM consultation_turn WHERE turn_id = ? AND encounter_id = ? AND speaker = 'patient'`, patientTurnId, encounterId)
      .toArray()[0]
    if (!row) return false
    if (row.status !== 'pending') return row.settled_by === 'simulated-patient' && sameOutcome(row, outcome)
    if (outcome.status === 'final') {
      this.sql.exec(
        `UPDATE consultation_turn SET status = 'final', text = ?, settled_at = ?, settled_by = 'simulated-patient' WHERE turn_id = ?`,
        outcome.text, now.toISOString(), patientTurnId,
      )
    } else {
      this.fail(patientTurnId, outcome.failure, now, 'simulated-patient', outcome.text)
    }
    return true
  }

  // The workspace fails a waiting reply itself because the Encounter ended.
  failPending(encounterId: string, failure: PatientTurnFailure, now: Date): void {
    const turn = this.pending(encounterId)
    if (turn) this.fail(turn.turnId, failure, now, 'workspace')
  }

  // The workspace fails one reply itself (the Simulated Patient could not be reached), only while it still waits:
  // by the time a dispatch error surfaces, that reply may have settled and another may be pending.
  failIfPending(patientTurnId: string, failure: PatientTurnFailure, now: Date): void {
    if (this.find(patientTurnId)?.status === 'pending') this.fail(patientTurnId, failure, now, 'workspace')
  }

  find(turnId: string): ConsultationTurn | undefined {
    const row = this.sql.exec<TurnRow>('SELECT * FROM consultation_turn WHERE turn_id = ?', turnId).toArray()[0]
    return row && toTurn(row)
  }

  // The doctor turn a patient reply answers, for the Copilot's ambient trigger.
  doctorTurnOf(patientTurnId: string): ConsultationTurn | undefined {
    const reply = this.find(patientTurnId)
    return reply?.replyTo ? this.find(reply.replyTo) : undefined
  }

  private insertReplyAttempt(encounterId: string, doctorTurnId: string, attempt: number, now: Date, deadline: Date): ConsultationTurn {
    const turnId = crypto.randomUUID()
    this.sql.exec(
      `INSERT INTO consultation_turn (turn_id, encounter_id, seq, speaker, source, attribution, text, status, reply_to, attempt, created_at, deadline_at)
       VALUES (?, ?, ?, 'patient', 'simulated', 'simulated-patient', '', 'pending', ?, ?, ?, ?)`,
      turnId, encounterId, this.nextSeq(encounterId), doctorTurnId, attempt, now.toISOString(), deadline.toISOString(),
    )
    return this.find(turnId)!
  }

  private fail(turnId: string, failure: PatientTurnFailure, now: Date, settledBy: TurnRow['settled_by'], partialText = ''): void {
    this.sql.exec(
      `UPDATE consultation_turn SET status = 'failed', failure_reason = ?, text = ?, settled_at = ?, settled_by = ? WHERE turn_id = ?`,
      failure, partialText, now.toISOString(), settledBy, turnId,
    )
  }

  private latestReply(doctorTurnId: string): ConsultationTurn | undefined {
    const row = this.sql
      .exec<TurnRow>('SELECT * FROM consultation_turn WHERE reply_to = ? ORDER BY attempt DESC LIMIT 1', doctorTurnId)
      .toArray()[0]
    return row && toTurn(row)
  }

  private encounterOf(turnId: string): string | undefined {
    return this.sql.exec<{ encounter_id: string }>('SELECT encounter_id FROM consultation_turn WHERE turn_id = ?', turnId).toArray()[0]
      ?.encounter_id
  }

  private nextSeq(encounterId: string): number {
    return (this.sql.exec<{ seq: number | null }>('SELECT max(seq) AS seq FROM consultation_turn WHERE encounter_id = ?', encounterId).one().seq ?? 0) + 1
  }
}

const sameOutcome = (row: TurnRow, outcome: PatientReplyOutcome) =>
  outcome.status === 'final' ? row.status === 'final' && row.text === outcome.text : row.failure_reason === outcome.failure

function toTurn(row: TurnRow): ConsultationTurn {
  return {
    turnId: row.turn_id,
    seq: row.seq,
    speaker: row.speaker,
    source: row.source,
    attribution: row.attribution,
    text: row.text,
    voice: row.voice_recognizer
      ? { recognizer: row.voice_recognizer, durationMs: row.voice_duration_ms ?? 0, confidence: row.voice_confidence }
      : null,
    status: row.status,
    replyTo: row.reply_to,
    attempt: row.attempt,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    deadlineAt: row.status === 'pending' ? row.deadline_at : null,
    failure: row.failure_reason,
  }
}
