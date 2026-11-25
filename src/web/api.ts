import type {
  AskPatientResponse,
  ConsultationResponse,
  ConsultationTurn,
  RetryPatientTurnResponse,
} from '../shared/consultation'
import type { ActiveEncounterResponse, EncounterResponse, EncounterView, ErrorResponse } from '../shared/encounter'
import type { GoldenCaseQueueEntry, GoldenCaseQueueResponse } from '../shared/golden-case-queue'
import type {
  BodySystem,
  PhysicalExaminationResponse,
  PhysicalExaminationsResponse,
  PhysicalExaminationView,
} from '../shared/physical-examination'
import type {
  CatalogItemView,
  InvestigationCatalogResponse,
  InvestigationsResponse,
  InvestigationView,
} from '../shared/investigation'

import type { ClinicalNoteResponse, ClinicalNoteView, NoteSections } from '../shared/clinical-note'
import type { DiagnosisDraftEntry, DiagnosisResponse, DiagnosisView } from '../shared/diagnosis'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((body as Partial<ErrorResponse> | null)?.error?.message ?? `请求失败（HTTP ${response.status}）`)
  }
  return body as T
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export async function fetchGoldenCaseQueue(): Promise<GoldenCaseQueueEntry[]> {
  return (await request<GoldenCaseQueueResponse>('/api/golden-cases')).goldenCases
}

export async function fetchActiveEncounter(): Promise<EncounterView | null> {
  return (await request<ActiveEncounterResponse>('/api/encounters/active')).encounter
}

export async function fetchEncounter(encounterId: string): Promise<EncounterView> {
  return (await request<EncounterResponse>(`/api/encounters/${encodeURIComponent(encounterId)}`)).encounter
}

export async function startEncounter(caseId: string): Promise<EncounterView> {
  return (await request<EncounterResponse>('/api/encounters', post({ caseId }))).encounter
}

export async function abandonEncounter(encounterId: string): Promise<EncounterView> {
  const path = `/api/encounters/${encodeURIComponent(encounterId)}/abandonment`
  return (await request<EncounterResponse>(path, post())).encounter
}

const physicalExaminationsPath = (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}/physical-examinations`

export async function fetchPhysicalExaminations(encounterId: string): Promise<PhysicalExaminationView[]> {
  return (await request<PhysicalExaminationsResponse>(physicalExaminationsPath(encounterId))).examinations
}

export async function performPhysicalExamination(encounterId: string, system: BodySystem): Promise<PhysicalExaminationView> {
  return (await request<PhysicalExaminationResponse>(physicalExaminationsPath(encounterId), post({ system }))).examination
}

export async function fetchInvestigationCatalog(): Promise<CatalogItemView[]> {
  return (await request<InvestigationCatalogResponse>('/api/investigation-catalog')).items
}

const investigationsPath = (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}/investigations`

export async function fetchInvestigations(encounterId: string): Promise<InvestigationView[]> {
  return (await request<InvestigationsResponse>(investigationsPath(encounterId))).investigations
}

export async function issueInvestigations(encounterId: string, catalogItemIds: string[]): Promise<InvestigationView[]> {
  return (await request<InvestigationsResponse>(investigationsPath(encounterId), post({ catalogItemIds }))).investigations
}

export async function releaseInvestigationNow(encounterId: string, investigationId: string): Promise<InvestigationView[]> {
  const path = `${investigationsPath(encounterId)}/${encodeURIComponent(investigationId)}/instant-release`
  return (await request<InvestigationsResponse>(path, post())).investigations
}

export async function cancelInvestigation(encounterId: string, investigationId: string): Promise<InvestigationView[]> {
  const path = `${investigationsPath(encounterId)}/${encodeURIComponent(investigationId)}/cancellation`
  return (await request<InvestigationsResponse>(path, post())).investigations
}

export async function acknowledgeReports(encounterId: string, reportIds: string[]): Promise<InvestigationView[]> {
  const path = `/api/encounters/${encodeURIComponent(encounterId)}/report-acknowledgements`
  return (await request<InvestigationsResponse>(path, post({ reportIds }))).investigations
}

const encounterPath = (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}`

export async function fetchConsultation(encounterId: string): Promise<ConsultationTurn[]> {
  return (await request<ConsultationResponse>(`${encounterPath(encounterId)}/consultation`)).turns
}

export async function askPatient(encounterId: string, clientTurnId: string, text: string): Promise<AskPatientResponse> {
  return request<AskPatientResponse>(`${encounterPath(encounterId)}/consultation/doctor-turns`, post({ clientTurnId, text }))
}

export async function retryPatientTurn(encounterId: string, turnId: string): Promise<ConsultationTurn> {
  const path = `${encounterPath(encounterId)}/consultation/patient-turns/${encodeURIComponent(turnId)}/retry`
  return (await request<RetryPatientTurnResponse>(path, post())).patientTurn
}

const clinicalNotePath = (encounterId: string) => `${encounterPath(encounterId)}/clinical-note`

export async function fetchClinicalNote(encounterId: string): Promise<ClinicalNoteView> {
  return (await request<ClinicalNoteResponse>(clinicalNotePath(encounterId))).note
}

// keepalive lets the last autosave finish while the page unloads.
export async function saveClinicalNoteDraft(encounterId: string, sections: Partial<NoteSections>): Promise<ClinicalNoteView> {
  const init: RequestInit = { ...post({ sections }), method: 'PATCH', keepalive: true }
  return (await request<ClinicalNoteResponse>(`${clinicalNotePath(encounterId)}/draft`, init)).note
}

export async function signClinicalNote(encounterId: string, sections: NoteSections): Promise<ClinicalNoteView> {
  return (await request<ClinicalNoteResponse>(`${clinicalNotePath(encounterId)}/revisions`, post({ sections }))).note
}

const diagnosisPath = (encounterId: string) => `${encounterPath(encounterId)}/diagnosis`

export async function fetchDiagnosis(encounterId: string): Promise<DiagnosisView> {
  return (await request<DiagnosisResponse>(diagnosisPath(encounterId))).diagnosis
}

export async function saveDiagnosisDraft(encounterId: string, entries: DiagnosisDraftEntry[]): Promise<DiagnosisView> {
  return (await request<DiagnosisResponse>(`${diagnosisPath(encounterId)}/draft`, { ...post({ entries }), method: 'PUT' })).diagnosis
}

export async function confirmDiagnosis(encounterId: string, entries: DiagnosisDraftEntry[]): Promise<DiagnosisView> {
  return (await request<DiagnosisResponse>(`${diagnosisPath(encounterId)}/revisions`, post({ entries }))).diagnosis
}

export async function reopenDiagnosis(encounterId: string): Promise<DiagnosisView> {
  return (await request<DiagnosisResponse>(`${diagnosisPath(encounterId)}/reopen`, post())).diagnosis
}

export function openPatientSocket(encounterId: string): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${scheme}//${location.host}${encounterPath(encounterId)}/patient/socket`)
}
