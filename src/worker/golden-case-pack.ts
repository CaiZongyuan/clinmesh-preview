import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { EncounterError, EncounterView, PriorMedication } from '../shared/encounter'
import type { Sex, VisitKind } from '../shared/golden-case-queue'
import type { BodySystem, PhysicalExaminationView } from '../shared/physical-examination'
import { vitalSigns, vitalSignsSentence } from './vital-signs'

export interface GoldenCaseRegistration {
  caseId: string
  queueNumber: number
  patientName: string
  sex: Sex
  birthDate: string
  chiefComplaint: string
  registeredAt: string
  visitKind: VisitKind
}

// The browser-visible part of a Golden Case that an Encounter is bound to when it starts.
export type EncounterChart = Pick<EncounterView, 'caseVersion' | 'personaVersion' | 'patient' | 'triage' | 'visibleSourceHistory'>

// Only registration-level fields leave the pinned snapshot here; Case Truth stays in the file.
export function goldenCaseRegistrations(): GoldenCaseRegistration[] {
  return casePack.cases.map((goldenCase) => ({
    caseId: goldenCase.id,
    queueNumber: goldenCase.registration.queueNumber,
    patientName: goldenCase.patient.name,
    sex: goldenCase.patient.gender as Sex,
    birthDate: goldenCase.patient.birthDate,
    chiefComplaint: goldenCase.chiefComplaint,
    registeredAt: goldenCase.registration.registeredAt,
    visitKind: goldenCase.registration.visitKind as VisitKind,
  }))
}

// The patient banner, triage and Visible Source History only; Case Truth stays in the file.
export function encounterChart(caseId: string): EncounterChart | undefined {
  const goldenCase = casePack.cases.find((c) => c.id === caseId)
  if (!goldenCase) return undefined
  const { patient, registration, triage } = goldenCase
  const medication = (m: { display: string; dosageText: string }): PriorMedication => ({ display: m.display, dosageText: m.dosageText })
  // Visits run newest first, so each medication keeps its most recent entry.
  const medications = goldenCase.visibleHistory.flatMap((visit) => visit.medications)
  return {
    caseVersion: casePack.version,
    personaVersion: goldenCase.persona.version,
    patient: {
      name: patient.name,
      sex: patient.gender as Sex,
      age: ageOn(patient.birthDate, registration.registeredAt),
      visitKind: registration.visitKind as VisitKind,
      outpatientNumber: registration.outpatientNumber,
      registeredAt: registration.registeredAt,
      department: registration.department,
      insurance: registration.insurance,
      chiefComplaint: goldenCase.chiefComplaint,
    },
    triage: { level: triage.level, measuredAt: triage.measuredAt, vitals: vitalSigns(triage.vitals) },
    visibleSourceHistory: {
      priorVisits: goldenCase.visibleHistory.map((visit) => ({
        visitedAt: visit.encounterDateTime,
        department: visit.department,
        reason: visit.reasonText,
        diagnoses: visit.conditions.map((c) => ({ code: c.code, display: c.display })),
        medications: visit.medications.map(medication),
      })),
      allergies: goldenCase.allergies.map((a) => ({ agent: a.agent, reaction: a.reaction, onset: a.onset, source: a.source })),
      chronicConditions: goldenCase.chronicConditions.map((c) => ({ code: c.code, display: c.display, onset: c.onset, status: c.status })),
      priorMedications: medications.filter((m, i) => medications.findIndex((o) => o.id === m.id) === i).map(medication),
    },
  }
}

type GoldenCase = (typeof casePack.cases)[number]

export type CaseTruth = Pick<
  GoldenCase,
  'indexConditions' | 'physicalExamination' | 'laboratories' | 'textResults' | 'reportAmendments' | 'debriefReference'
>

export type CaseTruthResult = { ok: true; caseTruth: CaseTruth } | { ok: false; error: EncounterError }

// The one way to read Case Truth. An Encounter reads the pack version it started with or nothing,
// so a newer pack never silently changes what its examinations and results reveal.
export function caseTruth(caseId: string, caseVersion: string): CaseTruthResult {
  const goldenCase = casePack.cases.find((c) => c.id === caseId)
  if (!goldenCase || caseVersion !== casePack.version) {
    const message = goldenCase
      ? `本次就诊绑定病例包版本 ${caseVersion}，当前为 ${casePack.version}。该版本已停用，无法继续揭示病例真值；请放弃本次就诊后重新开始。`
      : `Golden Case ${caseId} 已不在当前病例包中，无法继续揭示病例真值；请放弃本次就诊。`
    return { ok: false, error: { code: 'case-version-retired', message } }
  }
  const { indexConditions, physicalExamination, laboratories, textResults, reportAmendments, debriefReference } = goldenCase
  return {
    ok: true,
    caseTruth: { indexConditions, physicalExamination, laboratories, textResults, reportAmendments, debriefReference },
  }
}

export type PhysicalExaminationFinding = Pick<PhysicalExaminationView, 'finding' | 'vitals'>

// Reveals one body system's finding, and nothing else of Case Truth.
export function physicalExaminationFinding({ physicalExamination }: CaseTruth, system: BodySystem): PhysicalExaminationFinding {
  if (system !== 'vitals') return { finding: physicalExamination[system], vitals: null }
  const { spo2Condition, ...readings } = physicalExamination.vitals
  const vitals = vitalSigns(readings)
  return { finding: vitalSignsSentence(vitals, spo2Condition), vitals }
}

// Both inputs carry the clinic-local calendar date in their first ten characters.
export function ageOn(birthDate: string, at: string): number {
  const [by, bm, bd] = birthDate.slice(0, 10).split('-').map(Number)
  const [y, m, d] = at.slice(0, 10).split('-').map(Number)
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0)
}
