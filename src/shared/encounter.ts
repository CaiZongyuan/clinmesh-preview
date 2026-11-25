import type { Sex, VisitKind } from './golden-case-queue'

export type EncounterStatus = 'active' | 'abandoned' | 'completed'

export type VitalSignKind = 'temperature' | 'pulse' | 'respiratory-rate' | 'blood-pressure' | 'spo2'

// Which side of the reference range a reading falls on; null when it is within range.
export type VitalSignFlag = 'high' | 'low' | null

export interface VitalSign {
  kind: VitalSignKind
  value: string
  unit: string
  flag: VitalSignFlag
}

export interface BannerPatient {
  name: string
  sex: Sex
  age: number
  visitKind: VisitKind
  outpatientNumber: string
  registeredAt: string
  department: string
  insurance: string
  chiefComplaint: string
}

export interface Triage {
  level: number
  measuredAt: string
  vitals: VitalSign[]
}

export interface CodedCondition {
  code: string
  display: string
}

export interface PriorMedication {
  display: string
  dosageText: string
}

export interface PriorVisit {
  visitedAt: string
  department: string
  reason: string
  diagnoses: CodedCondition[]
  medications: PriorMedication[]
}

export interface RecordedAllergy {
  agent: string
  // The drug class the recorded allergy is to, when the clinic recorded it; class-level allergy rules
  // match on this, never on a drug code.
  drugClass?: string
  reaction: string
  onset: string
  source: string
}

export interface ChronicCondition extends CodedCondition {
  onset: string
  status: string
}

// What the clinic knew before this Encounter started; never Case Truth.
export interface VisibleSourceHistory {
  priorVisits: PriorVisit[]
  allergies: RecordedAllergy[]
  chronicConditions: ChronicCondition[]
  priorMedications: PriorMedication[]
}

export interface EncounterView {
  encounterId: string
  caseId: string
  caseVersion: string
  personaVersion: string
  status: EncounterStatus
  practitionerId: string
  startedAt: string
  endedAt: string | null
  patient: BannerPatient
  triage: Triage
  visibleSourceHistory: VisibleSourceHistory
}

export interface StartEncounterRequest {
  caseId: string
}

export interface EncounterResponse {
  encounter: EncounterView
}

export interface ActiveEncounterResponse {
  encounter: EncounterView | null
}

export type AuditEventType =
  | 'encounter-started'
  | 'encounter-abandoned'
  | 'physical-examination-performed'
  | 'investigation-issued'
  | 'investigation-released-instantly'
  | 'investigation-cancelled'
  | 'report-acknowledged'
  | 'consultation-question-asked'
  | 'patient-reply-retried'
  | 'clinical-note-signed'
  | 'diagnosis-confirmed'
  | 'prescription-issued'
  | 'no-medication-recorded'

export interface AuditEvent {
  eventType: AuditEventType
  practitionerId: string
  occurredAt: string
  // What the event acted on, such as a catalog item, Report or body system; absent for the Encounter itself.
  subject?: string
}

export interface AuditEventsResponse {
  auditEvents: AuditEvent[]
}

export type EncounterErrorCode =
  | 'invalid-request'
  | 'golden-case-not-found'
  | 'encounter-not-found'
  | 'active-encounter-exists'
  | 'encounter-not-active'
  | 'body-system-already-examined'
  | 'case-version-retired'
  | 'catalog-item-not-found'
  | 'investigation-already-issued'
  | 'investigation-not-found'
  | 'investigation-cancelled'
  | 'investigation-already-reported'
  | 'report-not-found'
  | 'report-superseded'
  | 'report-already-acknowledged'
  | 'consultation-turn-not-found'
  | 'patient-turn-pending'
  | 'patient-turn-not-retryable'
  | 'clinical-note-incomplete'
  | 'diagnosis-needs-primary'
  | 'diagnosis-not-confirmed'
  // The hard allergy red line: the whole prescription is refused and there is no override path.
  // The code is spelled exactly as the acceptance criterion pins it.
  | 'MEDICATION_ALLERGY_CONFLICT'
  | 'medication-override-required'
  | 'no-medication-conflict'

export interface EncounterError {
  code: EncounterErrorCode
  message: string
}

export interface ErrorResponse {
  error: EncounterError
}
