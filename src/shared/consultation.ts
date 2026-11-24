export type Speaker = 'doctor' | 'patient'

// How the words entered the Consultation. Spoken doctor turns arrive with voice capture.
export type TurnSource = 'typed' | 'simulated'

// How the system knows who spoke. Phase 1 knows by construction: the doctor types at the workbench and the
// Simulated Patient's replies come from its agent. Phase 2 adds attribution for two human speakers (voiceprint).
export type SpeakerAttribution = 'workbench-input' | 'simulated-patient'

// Doctor turns are always final. A patient turn is one reply attempt: pending until the Simulated Patient settles it.
export type TurnStatus = 'final' | 'pending' | 'failed'

export type PatientTurnFailure =
  | 'timeout'
  | 'llm-not-configured'
  | 'llm-error'
  | 'patient-unavailable'
  | 'encounter-ended'

export interface ConsultationTurn {
  turnId: string
  seq: number
  speaker: Speaker
  source: TurnSource
  attribution: SpeakerAttribution
  text: string
  status: TurnStatus
  // A patient turn's doctor turn, and which attempt at answering it this is.
  replyTo: string | null
  attempt: number
  createdAt: string
  settledAt: string | null
  // When a pending patient turn is due; past it, the turn fails and the lock releases.
  deadlineAt: string | null
  failure: PatientTurnFailure | null
}

export interface ConsultationResponse {
  turns: ConsultationTurn[]
}

export interface AskPatientRequest {
  // Chosen by the browser, so resending the same question after a dropped response records it once.
  clientTurnId: string
  text: string
}

export interface AskPatientResponse {
  doctorTurn: ConsultationTurn
  patientTurn: ConsultationTurn
}

export interface RetryPatientTurnResponse {
  patientTurn: ConsultationTurn
}

export const MAX_QUESTION_LENGTH = 500
