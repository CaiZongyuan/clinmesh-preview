import type { CaseDebrief, ClinicalDrafts } from '../shared/completion'
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
import type { VoiceConfigResponse } from '../shared/voice'
import type { VoiceCapture } from '../shared/consultation'

import type { ClinicalNoteResponse, ClinicalNoteView, NoteSections, SaveNoteDraftRequest } from '../shared/clinical-note'
import type { DiagnosisDraftEntry, DiagnosisResponse, DiagnosisView } from '../shared/diagnosis'
import type {
  IssuePrescriptionRequest,
  MedicationCatalogResponse,
  MedicationCatalogItemView,
  PrescriptionsResponse,
  PrescriptionsView,
} from '../shared/medication'

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

export async function completeEncounter(encounterId: string): Promise<EncounterView> {
  return (await request<EncounterResponse>(`${encounterPath(encounterId)}/completion`, post())).encounter
}

export async function fetchCaseDebrief(encounterId: string): Promise<CaseDebrief> {
  return (await request<{ debrief: CaseDebrief }>(`${encounterPath(encounterId)}/debrief`)).debrief
}

export async function fetchClinicalDrafts(encounterId: string): Promise<ClinicalDrafts> {
  return (await request<{ drafts: ClinicalDrafts }>(`${encounterPath(encounterId)}/clinical-drafts`)).drafts
}

export async function saveClinicalDraft<K extends keyof ClinicalDrafts>(
  encounterId: string, kind: K, entries: ClinicalDrafts[K],
): Promise<void> {
  await request(`${encounterPath(encounterId)}/${kind}/draft`, { ...post({ entries }), method: 'PUT', keepalive: true })
}


export async function fetchConsultation(encounterId: string): Promise<ConsultationTurn[]> {
  return (await request<ConsultationResponse>(`${encounterPath(encounterId)}/consultation`)).turns
}

export async function askPatient(
  encounterId: string,
  clientTurnId: string,
  text: string,
  voice?: VoiceCapture,
): Promise<AskPatientResponse> {
  return request<AskPatientResponse>(
    `${encounterPath(encounterId)}/consultation/doctor-turns`,
    post({ clientTurnId, text, ...(voice ? { voice } : {}) }),
  )
}

// Which recognizer turns the doctor's speech into questions: the Worker's Paraformer or the browser's Web Speech.
export async function fetchVoiceConfig(): Promise<VoiceConfigResponse> {
  return request<VoiceConfigResponse>('/api/voice')
}

export function openVoiceSocket(encounterId: string): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${scheme}//${location.host}${encounterPath(encounterId)}/voice`)
}

export async function retryPatientTurn(encounterId: string, turnId: string): Promise<ConsultationTurn> {
  const path = `${encounterPath(encounterId)}/consultation/patient-turns/${encodeURIComponent(turnId)}/retry`
  return (await request<RetryPatientTurnResponse>(path, post())).patientTurn
}

// The repaired WAV for one patient reply chunk, spoken by Sambert. Aborting the fetch tears down the upstream
// synthesis task, so a cancelled playback or a navigation does not leave a late job running.
export async function synthesizePatientSpeech(encounterId: string, turnId: string, text: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const path = `${encounterPath(encounterId)}/consultation/patient-turns/${encodeURIComponent(turnId)}/speech`
  const response = await fetch(path, { ...post({ text }), signal })
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as ErrorResponse | null)?.error.message ?? '语音合成失败')
  return response.arrayBuffer()
}

const clinicalNotePath = (encounterId: string) => `${encounterPath(encounterId)}/clinical-note`

export async function fetchClinicalNote(encounterId: string): Promise<ClinicalNoteView> {
  return (await request<ClinicalNoteResponse>(clinicalNotePath(encounterId))).note
}

// keepalive lets the last autosave finish while the page unloads.
export async function saveClinicalNoteDraft(
  encounterId: string, sections: Partial<NoteSections>, authors?: SaveNoteDraftRequest['authors'],
): Promise<ClinicalNoteView> {
  const init: RequestInit = { ...post({ sections, authors }), method: 'PATCH', keepalive: true }
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

export async function fetchMedicationCatalog(): Promise<MedicationCatalogItemView[]> {
  return (await request<MedicationCatalogResponse>('/api/medication-catalog')).items
}

const prescriptionsPath = (encounterId: string) => `${encounterPath(encounterId)}/prescriptions`

export async function fetchPrescriptions(encounterId: string): Promise<PrescriptionsView> {
  return (await request<PrescriptionsResponse>(prescriptionsPath(encounterId))).prescriptions
}

export async function issuePrescription(encounterId: string, lines: IssuePrescriptionRequest['lines']): Promise<PrescriptionsView> {
  return (await request<PrescriptionsResponse>(prescriptionsPath(encounterId), post({ lines }))).prescriptions
}

export async function recordNoMedication(encounterId: string): Promise<PrescriptionsView> {
  return (await request<PrescriptionsResponse>(`${encounterPath(encounterId)}/no-medication`, post())).prescriptions
}

export function openPatientSocket(encounterId: string): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${scheme}//${location.host}${encounterPath(encounterId)}/patient/socket`)
}

// The Clinical Copilot: commands go over HTTP, its events stream over its socket.
import type { CopilotCompactResponse, CopilotContextView } from '../shared/copilot-context'
import type {
  CopilotConfigRequest,
  CopilotFeedback,
  CopilotModelSetting,
  CopilotMention,
  CopilotPromptMode,
  CopilotPromptResponse,
  CopilotResendRequest,
  CopilotSnapshot,
  CopilotStopResponse,
} from '../shared/copilot-turn'

export async function fetchCopilotSnapshot(encounterId: string): Promise<CopilotSnapshot> {
  return (await request<{ snapshot: CopilotSnapshot }>(`${encounterPath(encounterId)}/copilot`)).snapshot
}

export function promptCopilot(
  encounterId: string,
  clientPromptId: string,
  text: string,
  mentions: CopilotMention[],
  mode: CopilotPromptMode,
): Promise<CopilotPromptResponse> {
  return request<CopilotPromptResponse>(`${encounterPath(encounterId)}/copilot/prompts`, post({ clientPromptId, text, mentions, mode }))
}

export function resendCopilotPrompt(
  encounterId: string,
  turnId: string,
  clientPromptId: string,
  text: string,
  mentions: CopilotMention[],
): Promise<CopilotPromptResponse> {
  const path = `${encounterPath(encounterId)}/copilot/turns/${encodeURIComponent(turnId)}/resend`
  return request<CopilotPromptResponse>(path, post({ clientPromptId, text, mentions } satisfies CopilotResendRequest))
}

export function stopCopilot(encounterId: string): Promise<CopilotStopResponse> {
  return request<CopilotStopResponse>(`${encounterPath(encounterId)}/copilot/stop`, post())
}

export function setCopilotFeedback(encounterId: string, turnId: string, value: CopilotFeedback | null): Promise<null> {
  const path = `${encounterPath(encounterId)}/copilot/turns/${encodeURIComponent(turnId)}/feedback`
  return request<null>(path, post({ value }))
}

export function configureCopilot(encounterId: string, config: CopilotConfigRequest): Promise<CopilotModelSetting> {
  return request<CopilotModelSetting>(`${encounterPath(encounterId)}/copilot/config`, post(config))
}

export async function fetchCopilotContext(encounterId: string): Promise<CopilotContextView> {
  return (await request<{ context: CopilotContextView }>(`${encounterPath(encounterId)}/copilot/context`)).context
}

export function compactCopilot(encounterId: string): Promise<CopilotCompactResponse> {
  return request<CopilotCompactResponse>(`${encounterPath(encounterId)}/copilot/compact`, post())
}

export function openCopilotSocket(encounterId: string, channel: 'socket' | 'bridge' = 'socket'): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${scheme}//${location.host}${encounterPath(encounterId)}/copilot/${channel}`)
}

export function flushCopilotCountdown(encounterId: string, ref: string) {
  return request(`${encounterPath(encounterId)}/copilot/triggers/${encodeURIComponent(ref)}/flush`, post())
}

export function skipCopilotCountdown(encounterId: string, ref: string) {
  return request(`${encounterPath(encounterId)}/copilot/triggers/${encodeURIComponent(ref)}`, { method: 'DELETE' })
}
