export type AppointmentStatus = 'booked' | 'checked_in' | 'in_encounter' | 'completed' | 'cancelled'

export type AppointmentErrorCode =
  | 'slot-not-found'
  | 'slot-closed'
  | 'slot-full'
  | 'duplicate-appointment'
  | 'appointment-not-found'
  | 'appointment-invalid-transition'
  | 'release-source-not-ready'
  | 'release-not-found'

export interface AppointmentSlotView {
  slotId: string
  doctorId: string
  doctorName: string
  doctorTitle: string
  departmentId: string
  departmentName: string
  startsAt: string
  endsAt: string
  capacity: number
  bookedCount: number
  remaining: number
  status: 'open' | 'closed'
}

export interface AppointmentView {
  appointmentId: string
  patientId: string
  patientName: string
  outpatientNumber: string
  slotId: string
  doctorId: string
  doctorName: string
  departmentId: string
  departmentName: string
  startsAt: string
  endsAt: string
  status: AppointmentStatus
  clientRequestId: string
  encounterId: string | null
  chiefComplaint: string | null
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
}

export interface BookAppointmentRequest {
  slotId: string
  clientRequestId: string
  chiefComplaint?: string
}

export interface StartAppointmentEncounterRequest {
  caseId?: string
}

export interface PublishPatientReleaseRequest {
  encounterId: string
  resourceType: 'clinical_note' | 'report' | 'prescription'
  resourceId?: string
  title?: string
  summary?: string
}

export interface StaffPatientView {
  patientId: string
  actorId: string
  displayName: string
  sex: 'male' | 'female'
  birthDate: string
  outpatientNumber: string
  departmentId: string
  departmentName: string
  primaryDoctorId: string | null
  primaryDoctorName: string | null
  allergies: Array<{ agent: string; reaction: string }>
  chronicConditions: Array<{ code: string; display: string }>
  relation: string
  releaseCount: number
  appointmentCount: number
}

export interface AppointmentSlotsResponse {
  slots: AppointmentSlotView[]
}

export interface AppointmentsResponse {
  appointments: AppointmentView[]
}

export interface AppointmentResponse {
  appointment: AppointmentView
}

export interface StartAppointmentEncounterResponse {
  appointment: AppointmentView
  encounter: import('./encounter').EncounterView
}

export interface StaffPatientsResponse {
  patients: StaffPatientView[]
}
