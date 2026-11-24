import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { Sex, VisitKind } from '../shared/golden-case-queue'

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
