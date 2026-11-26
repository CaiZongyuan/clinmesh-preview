import type {
  AppointmentResponse,
  AppointmentsResponse,
  AppointmentSlotView,
  AppointmentSlotsResponse,
  AppointmentStatus,
  AppointmentView,
  PublishPatientReleaseRequest,
  StaffPatientsResponse,
  StaffPatientView,
  StartAppointmentEncounterResponse,
} from '../../shared/appointment'
import type {
  AuthSessionResponse,
  ContactView,
  DemoResetResponse,
  DepartmentView,
  DoctorView,
  MeResponse,
  PatientReleaseDetailResponse,
  PatientReleasesResponse,
  PatientReleaseView,
  Principal,
} from '../../shared/auth'
import type {
  AttachmentAccessResponse,
  ConversationView,
  CreateConversationRequest,
  ImCredentialsResponse,
  InitAttachmentRequest,
  InitAttachmentResponse,
  MessagesPageResponse,
  SendMessageRequest,
  SendMessageResponse,
} from '../../shared/communication'
import type { ErrorResponse } from '../../shared/encounter'
import type {
  AgentRunSnapshot,
  CreateFollowupPlanRequest,
  FollowupPlanView,
  FollowupSummaryView,
  ReviewFollowupSummaryRequest,
} from '../../shared/followup'
import { getStaffToken, setStaffToken } from '../api'

async function clinicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStaffToken()
  const headers = new Headers(init?.headers)
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }
  const response = await fetch(path, { ...init, headers })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((body as Partial<ErrorResponse> | null)?.error?.message ?? `请求失败（HTTP ${response.status}）`)
  }
  return body as T
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export async function loginStaffAccount(username: string, password: string): Promise<AuthSessionResponse> {
  const res = await clinicFetch<AuthSessionResponse>('/api/auth/staff', jsonInit('POST', { username, password }))
  setStaffToken(res.token)
  return res
}

export async function fetchCurrentPrincipal(): Promise<Principal | null> {
  if (!getStaffToken()) return null
  try {
    return (await clinicFetch<MeResponse>('/api/me')).principal
  } catch {
    setStaffToken(null)
    return null
  }
}

export async function logoutStaffAccount(): Promise<void> {
  try {
    await clinicFetch('/api/auth/logout', { method: 'POST' })
  } finally {
    setStaffToken(null)
  }
}

export async function fetchClinicDirectory(): Promise<{ departments: DepartmentView[]; doctors: DoctorView[]; contacts: ContactView[] }> {
  const [depts, docs, contacts] = await Promise.all([
    clinicFetch<{ departments: DepartmentView[] }>('/api/clinic/departments'),
    clinicFetch<{ doctors: DoctorView[] }>('/api/clinic/doctors'),
    clinicFetch<{ contacts: ContactView[] }>('/api/contacts'),
  ])
  return { departments: depts.departments, doctors: docs.doctors, contacts: contacts.contacts }
}

export async function fetchSlots(params?: { departmentId?: string; doctorId?: string; date?: string }): Promise<AppointmentSlotView[]> {
  const qs = new URLSearchParams()
  if (params?.departmentId) qs.set('departmentId', params.departmentId)
  if (params?.doctorId) qs.set('doctorId', params.doctorId)
  if (params?.date) qs.set('date', params.date)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return (await clinicFetch<AppointmentSlotsResponse>(`/api/appointments/slots${suffix}`)).slots
}

export async function fetchStaffAppointments(params?: { doctorId?: string; status?: AppointmentStatus }): Promise<AppointmentView[]> {
  const qs = new URLSearchParams()
  if (params?.doctorId) qs.set('doctorId', params.doctorId)
  if (params?.status) qs.set('status', params.status)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return (await clinicFetch<AppointmentsResponse>(`/api/staff/appointments${suffix}`)).appointments
}

export async function checkInStaffAppointment(appointmentId: string): Promise<AppointmentView> {
  return (await clinicFetch<AppointmentResponse>(`/api/appointments/${encodeURIComponent(appointmentId)}/check-in`, { method: 'POST' })).appointment
}

export async function startStaffAppointmentEncounter(
  appointmentId: string,
  caseId?: string,
): Promise<StartAppointmentEncounterResponse> {
  return clinicFetch<StartAppointmentEncounterResponse>(
    `/api/appointments/${encodeURIComponent(appointmentId)}/start-encounter`,
    jsonInit('POST', caseId ? { caseId } : {}),
  )
}

export async function fetchStaffPatients(): Promise<StaffPatientView[]> {
  return (await clinicFetch<StaffPatientsResponse>('/api/staff/patients')).patients
}

export async function publishPatientRelease(input: PublishPatientReleaseRequest): Promise<PatientReleaseView> {
  return (await clinicFetch<PatientReleaseDetailResponse>('/api/staff/releases', jsonInit('POST', input))).item
}

export async function fetchEncounterReleases(encounterId: string): Promise<PatientReleaseView[]> {
  return (await clinicFetch<PatientReleasesResponse>(`/api/staff/encounters/${encodeURIComponent(encounterId)}/releases`)).items
}

export async function fetchImCredentials(): Promise<ImCredentialsResponse> {
  return clinicFetch<ImCredentialsResponse>('/api/im/credentials')
}

export async function fetchConversations(): Promise<ConversationView[]> {
  return (await clinicFetch<{ conversations: ConversationView[] }>('/api/conversations')).conversations
}

export async function createConversation(input: CreateConversationRequest): Promise<ConversationView> {
  return (await clinicFetch<{ conversation: ConversationView }>('/api/conversations', jsonInit('POST', input))).conversation
}

export async function inviteConversationMember(conversationId: string, actorId: string): Promise<ConversationView> {
  return (
    await clinicFetch<{ conversation: ConversationView }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/members`,
      jsonInit('POST', { actorId }),
    )
  ).conversation
}

export async function removeConversationMember(conversationId: string, actorId: string): Promise<ConversationView> {
  return (
    await clinicFetch<{ conversation: ConversationView }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(actorId)}`,
      { method: 'DELETE' },
    )
  ).conversation
}

export async function fetchConversationMessages(conversationId: string, cursor?: number): Promise<MessagesPageResponse> {
  const suffix = cursor ? `?cursor=${cursor}` : ''
  return clinicFetch<MessagesPageResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`)
}

export async function sendConversationMessage(conversationId: string, input: SendMessageRequest): Promise<SendMessageResponse> {
  return clinicFetch<SendMessageResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    jsonInit('POST', input),
  )
}

export async function markConversationRead(conversationId: string, lastReadSeq: number): Promise<void> {
  await clinicFetch(`/api/conversations/${encodeURIComponent(conversationId)}/read`, jsonInit('POST', { lastReadSeq }))
}

export async function uploadLocalAttachment(
  input: InitAttachmentRequest,
  blob: Blob,
): Promise<AttachmentAccessResponse['attachment']> {
  const init = await clinicFetch<InitAttachmentResponse>('/api/attachments/init', jsonInit('POST', input))
  const token = getStaffToken()
  const uploadRes = await fetch(init.uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': input.mime,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: await blob.arrayBuffer(),
  })
  if (!uploadRes.ok) throw new Error('附件上传失败，请重试。')
  const completed = await clinicFetch<{ attachment: AttachmentAccessResponse['attachment'] }>(
    `/api/attachments/${encodeURIComponent(init.attachment.attachmentId)}/complete`,
    jsonInit('POST', { requestAsr: input.kind === 'audio' }),
  )
  return completed.attachment
}

export async function fetchAttachmentAccess(attachmentId: string): Promise<AttachmentAccessResponse> {
  return clinicFetch<AttachmentAccessResponse>(`/api/attachments/${encodeURIComponent(attachmentId)}/access`)
}

export async function fetchFollowupPlans(): Promise<FollowupPlanView[]> {
  return (await clinicFetch<{ plans: FollowupPlanView[] }>('/api/followup/plans')).plans
}

export async function createFollowupPlan(input: CreateFollowupPlanRequest): Promise<FollowupPlanView> {
  return (await clinicFetch<{ plan: FollowupPlanView }>('/api/followup/plans', jsonInit('POST', input))).plan
}

export async function reviewFollowupSummary(summaryId: string, input: ReviewFollowupSummaryRequest): Promise<FollowupSummaryView> {
  return (
    await clinicFetch<{ summary: FollowupSummaryView }>(
      `/api/followup/summaries/${encodeURIComponent(summaryId)}/review`,
      jsonInit('POST', input),
    )
  ).summary
}

export async function closeFollowupPlan(planId: string): Promise<FollowupPlanView> {
  return (await clinicFetch<{ plan: FollowupPlanView }>(`/api/followup/plans/${encodeURIComponent(planId)}/close`, { method: 'POST' })).plan
}

export async function fetchAgentRun(runId: string): Promise<AgentRunSnapshot> {
  return (await clinicFetch<{ run: AgentRunSnapshot }>(`/api/agent/runs/${encodeURIComponent(runId)}`)).run
}

export async function stopAgentRun(runId: string): Promise<void> {
  await clinicFetch(`/api/agent/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' })
}

export async function resetDemoClinicData(): Promise<DemoResetResponse> {
  return clinicFetch<DemoResetResponse>('/api/demo/reset', { method: 'POST' })
}
