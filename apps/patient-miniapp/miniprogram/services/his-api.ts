import type {
  AppointmentResponse,
  AppointmentSlotView,
  AppointmentSlotsResponse,
  AppointmentsResponse,
  AppointmentView,
  BookAppointmentRequest,
} from '../../../../src/shared/appointment'
import type {
  ContactView,
  DepartmentView,
  DoctorView,
  MeResponse,
  PatientReleaseDetailResponse,
  PatientReleasesResponse,
  PatientReleaseView,
  Principal,
} from '../../../../src/shared/auth'
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
} from '../../../../src/shared/communication'
import type { AgentRunSnapshot, FollowupPlanView, FollowupResponseView } from '../../../../src/shared/followup'
import { clearLocalAuthCache, getStoredToken } from './auth'
import { getApiBaseUrl } from './config'

function request<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  data?: unknown,
): Promise<T> {
  const token = getStoredToken()
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getApiBaseUrl()}${path}`,
      method,
      header: {
        ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: data as WechatMiniprogram.IAnyObject | string | ArrayBuffer | undefined,
      success: (res) => {
        if (res.statusCode === 401) {
          clearLocalAuthCache()
          reject(new Error('登录状态已失效，请重新登录'))
          return
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T)
          return
        }
        const errBody = res.data as { error?: { message?: string } } | undefined
        reject(new Error(errBody?.error?.message || `请求失败 (${res.statusCode})`))
      },
      fail: (err) => reject(new Error(err.errMsg || '网络异常，请检查服务是否启动')),
    })
  })
}

export const hisApi = {
  getMe: async (): Promise<Principal> => (await request<MeResponse>('/api/me')).principal,
  getDepartments: async (): Promise<DepartmentView[]> => (await request<{ departments: DepartmentView[] }>('/api/clinic/departments')).departments,
  getDoctors: async (): Promise<DoctorView[]> => (await request<{ doctors: DoctorView[] }>('/api/clinic/doctors')).doctors,
  getContacts: async (): Promise<ContactView[]> => (await request<{ contacts: ContactView[] }>('/api/contacts')).contacts,
  getSlots: async (params?: { departmentId?: string; doctorId?: string; date?: string }): Promise<AppointmentSlotView[]> => {
    const query: string[] = []
    if (params?.departmentId) query.push(`departmentId=${encodeURIComponent(params.departmentId)}`)
    if (params?.doctorId) query.push(`doctorId=${encodeURIComponent(params.doctorId)}`)
    if (params?.date) query.push(`date=${encodeURIComponent(params.date)}`)
    const suffix = query.length ? `?${query.join('&')}` : ''
    return (await request<AppointmentSlotsResponse>(`/api/appointments/slots${suffix}`)).slots
  },
  bookAppointment: async (body: BookAppointmentRequest): Promise<AppointmentView> =>
    (await request<AppointmentResponse>('/api/appointments', 'POST', body)).appointment,
  getMyAppointments: async (): Promise<AppointmentView[]> =>
    (await request<AppointmentsResponse>('/api/patient/appointments')).appointments,
  cancelAppointment: async (id: string): Promise<AppointmentView> =>
    (await request<AppointmentResponse>(`/api/appointments/${encodeURIComponent(id)}/cancel`, 'POST')).appointment,
  getMyRecords: async (): Promise<PatientReleaseView[]> =>
    (await request<PatientReleasesResponse>('/api/patient/records')).items,
  getMyRecordDetail: async (id: string): Promise<PatientReleaseView> =>
    (await request<PatientReleaseDetailResponse>(`/api/patient/records/${encodeURIComponent(id)}`)).item,
  getMyReports: async (): Promise<PatientReleaseView[]> =>
    (await request<PatientReleasesResponse>('/api/patient/reports')).items,
  getMyReportDetail: async (id: string): Promise<PatientReleaseView> =>
    (await request<PatientReleaseDetailResponse>(`/api/patient/reports/${encodeURIComponent(id)}`)).item,
  getMyPrescriptions: async (): Promise<PatientReleaseView[]> =>
    (await request<PatientReleasesResponse>('/api/patient/prescriptions')).items,
  getImCredentials: (): Promise<ImCredentialsResponse> => request<ImCredentialsResponse>('/api/im/credentials'),
  getConversations: async (): Promise<ConversationView[]> =>
    (await request<{ conversations: ConversationView[] }>('/api/conversations')).conversations,
  createConversation: async (body: CreateConversationRequest): Promise<ConversationView> =>
    (await request<{ conversation: ConversationView }>('/api/conversations', 'POST', body)).conversation,
  getConversation: async (id: string): Promise<ConversationView> =>
    (await request<{ conversation: ConversationView }>(`/api/conversations/${encodeURIComponent(id)}`)).conversation,
  getMessages: (id: string, cursor?: number): Promise<MessagesPageResponse> =>
    request<MessagesPageResponse>(`/api/conversations/${encodeURIComponent(id)}/messages${cursor ? `?cursor=${cursor}` : ''}`),
  sendMessage: (id: string, body: SendMessageRequest): Promise<SendMessageResponse> =>
    request<SendMessageResponse>(`/api/conversations/${encodeURIComponent(id)}/messages`, 'POST', body),
  markRead: (id: string, lastReadSeq: number): Promise<void> =>
    request(`/api/conversations/${encodeURIComponent(id)}/read`, 'POST', { lastReadSeq }),
  initAttachment: (body: InitAttachmentRequest): Promise<InitAttachmentResponse> =>
    request<InitAttachmentResponse>('/api/attachments/init', 'POST', body),
  uploadAttachmentBuffer: (uploadUrl: string, mime: string, buffer: ArrayBuffer): Promise<void> => {
    const token = getStoredToken()
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${getApiBaseUrl()}${uploadUrl}`,
        method: 'PUT',
        header: {
          'content-type': mime,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        data: buffer,
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve()
          else reject(new Error(`附件上传失败 (${res.statusCode})`))
        },
        fail: (err) => reject(new Error(err.errMsg || '附件上传网络失败')),
      })
    })
  },
  completeAttachment: (id: string, requestAsr = false): Promise<{ attachment: AttachmentAccessResponse['attachment'] }> =>
    request(`/api/attachments/${encodeURIComponent(id)}/complete`, 'POST', { requestAsr }),
  getAttachmentAccess: (id: string): Promise<AttachmentAccessResponse> =>
    request<AttachmentAccessResponse>(`/api/attachments/${encodeURIComponent(id)}/access`),
  getFollowupPlans: async (): Promise<FollowupPlanView[]> =>
    (await request<{ plans: FollowupPlanView[] }>('/api/followup/plans')).plans,
  getFollowupPlan: async (id: string): Promise<FollowupPlanView> =>
    (await request<{ plan: FollowupPlanView }>(`/api/followup/plans/${encodeURIComponent(id)}`)).plan,
  submitFollowupResponse: async (
    taskId: string,
    answers: Record<string, string | number>,
    idempotencyKey: string,
  ): Promise<FollowupResponseView> =>
    (
      await request<{ response: FollowupResponseView }>(
        `/api/followup/tasks/${encodeURIComponent(taskId)}/responses`,
        'POST',
        { answers, idempotencyKey },
      )
    ).response,
  getAgentRun: async (runId: string): Promise<AgentRunSnapshot> =>
    (await request<{ run: AgentRunSnapshot }>(`/api/agent/runs/${encodeURIComponent(runId)}`)).run,
  stopAgentRun: (runId: string): Promise<void> =>
    request(`/api/agent/runs/${encodeURIComponent(runId)}/stop`, 'POST'),
  submitAgentActionResult: (
    runId: string,
    callId: string,
    status: 'dispatched' | 'rejected' | 'unavailable',
    detail?: unknown,
  ): Promise<void> =>
    request(`/api/agent/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(callId)}/result`, 'POST', {
      status,
      detail,
    }),
}
