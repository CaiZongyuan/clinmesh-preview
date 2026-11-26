export type ClinicMode = 'simulation' | 'connected'

export type ActorKind = 'human' | 'agent' | 'system'
export type ActorRole = 'patient' | 'doctor' | 'nurse' | 'admin' | 'agent'
export type StaffRole = 'doctor' | 'nurse' | 'admin'
export type PatientReleaseResourceType = 'clinical_note' | 'report' | 'prescription'

export type AuthErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid-credentials'
  | 'invite-code-required'
  | 'invite-code-invalid'
  | 'invite-code-expired'
  | 'patient-already-bound'
  | 'wechat-auth-failed'
  | 'wechat-not-configured'
  | 'resource-not-found'
  | 'demo-reset-disabled'

export interface Principal {
  sessionId: string
  accountId: string
  actorId: string
  clinicId: string
  kind: ActorKind
  role: ActorRole
  displayName: string
  imUid: string
  patientId: string | null
  staffId: string | null
  departmentId: string | null
  expiresAt: string
}

export interface WeChatLoginRequest {
  code: string
  inviteCode?: string
}

export interface StaffLoginRequest {
  username: string
  password: string
}

export interface AuthSessionResponse {
  token: string
  principal: Principal
}

export interface MeResponse {
  principal: Principal
}

export interface DepartmentView {
  departmentId: string
  name: string
}

export interface DoctorView {
  staffId: string
  actorId: string
  displayName: string
  title: string
  departmentId: string
  departmentName: string
}

export interface ContactView {
  actorId: string
  kind: ActorKind
  role: ActorRole
  displayName: string
  imUid: string
  relation: string
  departmentId: string | null
  staffId: string | null
  patientId: string | null
}

export interface PatientReleaseMedicationItem {
  drugName: string
  dosage: string
  frequency: string
  route: string
  days: number
}

export interface PatientReleasePayload {
  department?: string
  visitedDate?: string
  chiefComplaint?: string
  plan?: string
  category?: string
  conclusion?: string
  items?: PatientReleaseMedicationItem[]
}

export interface PatientReleaseView {
  releaseId: string
  resourceType: PatientReleaseResourceType
  resourceId: string
  version: number
  encounterId: string | null
  title: string
  summary: string
  payload: PatientReleasePayload
  publishedBy: string
  publishedByName: string
  publishedAt: string
}

export interface PatientReleasesResponse {
  items: PatientReleaseView[]
}

export interface PatientReleaseDetailResponse {
  item: PatientReleaseView
}

export interface DemoResetResponse {
  workspace: string
  seedVersion: string
  departments: number
  staff: number
  patients: number
  slots: number
  releases: number
  resetAt: string
}
