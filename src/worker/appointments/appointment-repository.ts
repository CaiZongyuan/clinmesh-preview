import type {
  AppointmentSlotView,
  AppointmentStatus,
  AppointmentView,
  BookAppointmentRequest,
  StaffPatientView,
} from '../../shared/appointment'
import type { Principal } from '../../shared/auth'
import type { EncounterError, EncounterView } from '../../shared/encounter'
import type { AuthRepository } from '../auth/auth-repository'
import type { EncounterRepository } from '../encounter-repository'
import { encounterChart } from '../golden-case-pack'

type Refusal = { ok: false; error: EncounterError }
const refuse = (error: EncounterError): Refusal => ({ ok: false, error })

type SlotRow = {
  slot_id: string
  doctor_id: string
  doctor_name: string
  doctor_title: string
  department_id: string
  department_name: string
  starts_at: string
  ends_at: string
  capacity: number
  booked_count: number
  status: 'open' | 'closed'
}

type AppointmentRow = {
  appointment_id: string
  patient_id: string
  patient_name: string
  outpatient_number: string
  slot_id: string
  doctor_id: string
  doctor_name: string
  department_id: string
  department_name: string
  starts_at: string
  ends_at: string
  status: AppointmentStatus
  client_request_id: string
  encounter_id: string | null
  chief_complaint: string | null
  created_at: string
  updated_at: string
  cancelled_at: string | null
}

// Deterministic synthetic Golden Case mapping for Connected Clinic demo patients when caseId is not explicit.
const PATIENT_DEFAULT_CASE: Readonly<Record<string, string>> = {
  pat_01: 'golden-case-01',
  pat_02: 'golden-case-02',
  pat_03: 'golden-case-03',
  pat_04_expired: 'golden-case-04',
}

function shanghaiDate(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso.slice(0, 10)
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export class AppointmentRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: AuthRepository,
    private readonly encounters: EncounterRepository,
  ) {}

  listSlots(filters: { departmentId?: string; doctorId?: string; date?: string } = {}): AppointmentSlotView[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filters.departmentId) {
      clauses.push('sl.department_id = ?')
      params.push(filters.departmentId)
    }
    if (filters.doctorId) {
      clauses.push('sl.doctor_id = ?')
      params.push(filters.doctorId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.sql
      .exec<SlotRow>(
        `SELECT sl.slot_id, sl.doctor_id, a.display_name AS doctor_name, st.title AS doctor_title,
                sl.department_id, d.name AS department_name, sl.starts_at, sl.ends_at, sl.capacity, sl.status,
                (SELECT COUNT(*) FROM appointment ap
                 WHERE ap.slot_id = sl.slot_id AND ap.status IN ('booked', 'checked_in', 'in_encounter')) AS booked_count
         FROM appointment_slot sl
         JOIN staff_profile st ON st.staff_id = sl.doctor_id
         JOIN actor a ON a.actor_id = st.actor_id
         JOIN clinic_department d ON d.department_id = sl.department_id
         ${where}
         ORDER BY sl.starts_at ASC, sl.slot_id ASC`,
        ...params,
      )
      .toArray()

    return rows
      .filter((row) => !filters.date || shanghaiDate(row.starts_at) === filters.date)
      .map((row) => ({
        slotId: row.slot_id,
        doctorId: row.doctor_id,
        doctorName: row.doctor_name,
        doctorTitle: row.doctor_title,
        departmentId: row.department_id,
        departmentName: row.department_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        capacity: row.capacity,
        bookedCount: row.booked_count,
        remaining: Math.max(0, row.capacity - row.booked_count),
        status: row.status,
      }))
  }

  book(
    principal: Principal,
    input: BookAppointmentRequest,
    nowIso: string,
  ): { ok: true; appointment: AppointmentView; created: boolean } | Refusal {
    if (principal.role !== 'patient' || !principal.patientId) {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'appointment.book',
        resourceType: 'appointment_slot',
        resourceId: input.slotId,
        requestId: input.clientRequestId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅已登录患者本人可提交门诊预约。' })
    }

    const existing = this.findByRequestId(principal.patientId, input.clientRequestId)
    if (existing) {
      return { ok: true, appointment: existing, created: false }
    }

    const slot = this.sql
      .exec<{ slot_id: string; doctor_id: string; department_id: string; capacity: number; status: 'open' | 'closed' }>(
        'SELECT slot_id, doctor_id, department_id, capacity, status FROM appointment_slot WHERE slot_id = ?',
        input.slotId,
      )
      .toArray()[0]

    if (!slot) {
      return refuse({ code: 'slot-not-found', message: `找不到号源 ${input.slotId}` })
    }
    if (slot.status !== 'open') {
      return refuse({ code: 'slot-closed', message: '该号源已停止预约，请选择其他时段。' })
    }

    const sameSlot = this.sql
      .exec<{ appointment_id: string }>(
        `SELECT appointment_id FROM appointment
         WHERE patient_id = ? AND slot_id = ? AND status IN ('booked', 'checked_in', 'in_encounter')`,
        principal.patientId,
        input.slotId,
      )
      .toArray()[0]
    if (sameSlot) {
      return refuse({ code: 'duplicate-appointment', message: '您已预约过该时段，请勿重复预约。' })
    }

    const bookedCount = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM appointment
         WHERE slot_id = ? AND status IN ('booked', 'checked_in', 'in_encounter')`,
        input.slotId,
      )
      .one().count

    if (bookedCount >= slot.capacity) {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'appointment.book',
        resourceType: 'appointment_slot',
        resourceId: input.slotId,
        requestId: input.clientRequestId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'slot-full', message: '该号源已约满，请重新选择可用时段。' })
    }

    const appointmentId = `appt_${crypto.randomUUID()}`
    const complaint = input.chiefComplaint?.trim() || null
    this.sql.exec(
      `INSERT INTO appointment (
         appointment_id, patient_id, slot_id, doctor_id, department_id, status,
         client_request_id, encounter_id, chief_complaint, created_at, updated_at, cancelled_at
       ) VALUES (?, ?, ?, ?, ?, 'booked', ?, NULL, ?, ?, ?, NULL)`,
      appointmentId,
      principal.patientId,
      slot.slot_id,
      slot.doctor_id,
      slot.department_id,
      input.clientRequestId,
      complaint,
      nowIso,
      nowIso,
    )

    // Ensure care relationship exists with the booked doctor so patient can coordinate with them.
    this.sql.exec(
      `INSERT OR IGNORE INTO care_relationship (patient_id, staff_id, relation_kind, created_at)
       VALUES (?, ?, 'department', ?)`,
      principal.patientId,
      slot.doctor_id,
      nowIso,
    )

    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'appointment.book',
      resourceType: 'appointment',
      resourceId: appointmentId,
      requestId: input.clientRequestId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    return { ok: true, appointment: this.findById(appointmentId)!, created: true }
  }

  listForPatient(principal: Principal, status?: AppointmentStatus): { ok: true; appointments: AppointmentView[] } | Refusal {
    if (principal.role !== 'patient' || !principal.patientId) {
      return refuse({ code: 'forbidden', message: '仅患者本人可查看个人预约列表。' })
    }
    const clauses = ['ap.patient_id = ?']
    const params: unknown[] = [principal.patientId]
    if (status) {
      clauses.push('ap.status = ?')
      params.push(status)
    }
    return { ok: true, appointments: this.queryAppointments(clauses, params) }
  }

  cancel(principal: Principal, appointmentId: string, nowIso: string): { ok: true; appointment: AppointmentView } | Refusal {
    const appt = this.findById(appointmentId)
    if (!appt) {
      return refuse({ code: 'appointment-not-found', message: `找不到预约记录 ${appointmentId}` })
    }
    if (principal.role === 'patient') {
      if (appt.patientId !== principal.patientId) {
        this.auth.audit({
          actorId: principal.actorId,
          actorRole: principal.role,
          action: 'appointment.cancel',
          resourceType: 'appointment',
          resourceId: appointmentId,
          outcome: 'denied',
          occurredAt: nowIso,
        })
        return refuse({ code: 'appointment-not-found', message: `找不到预约记录 ${appointmentId}` })
      }
    } else if (principal.role !== 'doctor' && principal.role !== 'nurse' && principal.role !== 'admin') {
      return refuse({ code: 'forbidden', message: '无权取消该预约。' })
    }

    if (appt.status === 'cancelled') {
      return { ok: true, appointment: appt }
    }
    if (appt.status !== 'booked' && appt.status !== 'checked_in') {
      return refuse({ code: 'appointment-invalid-transition', message: '已接诊或已完诊的预约不能取消。' })
    }

    this.sql.exec(
      `UPDATE appointment SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE appointment_id = ?`,
      nowIso,
      nowIso,
      appointmentId,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'appointment.cancel',
      resourceType: 'appointment',
      resourceId: appointmentId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, appointment: this.findById(appointmentId)! }
  }

  listForStaff(
    principal: Principal,
    filters: { doctorId?: string; status?: AppointmentStatus } = {},
  ): { ok: true; appointments: AppointmentView[] } | Refusal {
    if (!principal.staffId) {
      return refuse({ code: 'forbidden', message: '仅医护人员可查看预约队列。' })
    }
    const clauses: string[] = []
    const params: unknown[] = []
    if (filters.doctorId) {
      clauses.push('ap.doctor_id = ?')
      params.push(filters.doctorId)
    }
    if (filters.status) {
      clauses.push('ap.status = ?')
      params.push(filters.status)
    }
    return { ok: true, appointments: this.queryAppointments(clauses, params) }
  }

  checkIn(principal: Principal, appointmentId: string, nowIso: string): { ok: true; appointment: AppointmentView } | Refusal {
    if (!principal.staffId) {
      return refuse({ code: 'forbidden', message: '仅医护人员可办理预约签到。' })
    }
    const appt = this.findById(appointmentId)
    if (!appt) {
      return refuse({ code: 'appointment-not-found', message: `找不到预约记录 ${appointmentId}` })
    }
    if (appt.status === 'checked_in') {
      return { ok: true, appointment: appt }
    }
    if (appt.status !== 'booked') {
      return refuse({ code: 'appointment-invalid-transition', message: '仅已预约状态的号源可办理签到。' })
    }
    this.sql.exec(
      `UPDATE appointment SET status = 'checked_in', updated_at = ? WHERE appointment_id = ?`,
      nowIso,
      appointmentId,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'appointment.check_in',
      resourceType: 'appointment',
      resourceId: appointmentId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, appointment: this.findById(appointmentId)! }
  }

  startEncounter(
    principal: Principal,
    appointmentId: string,
    explicitCaseId: string | undefined,
    nowIso: string,
  ): { ok: true; appointment: AppointmentView; encounter: EncounterView } | Refusal {
    if (!principal.staffId || principal.role !== 'doctor') {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'appointment.start_encounter',
        resourceType: 'appointment',
        resourceId: appointmentId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅授权医生可发起门诊接诊。' })
    }
    const verified = this.auth.verifyActiveStaff(principal.staffId, true)
    if (!verified.ok) return verified

    const appt = this.findById(appointmentId)
    if (!appt) {
      return refuse({ code: 'appointment-not-found', message: `找不到预约记录 ${appointmentId}` })
    }
    if (appt.status !== 'booked' && appt.status !== 'checked_in') {
      return refuse({ code: 'appointment-invalid-transition', message: '当前预约状态不允许发起接诊。' })
    }

    const caseId = explicitCaseId?.trim() || PATIENT_DEFAULT_CASE[appt.patientId] || 'golden-case-01'
    const chart = encounterChart(caseId)
    if (!chart) {
      return refuse({ code: 'golden-case-not-found', message: `找不到 Golden Case ${caseId}` })
    }

    // Any start failure (e.g. active-encounter-exists) returns before touching the appointment row.
    const started = this.encounters.start(caseId, chart, verified.staffId, nowIso, {
      patientId: appt.patientId,
      appointmentId: appt.appointmentId,
    })
    if (!started.ok) {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'appointment.start_encounter',
        resourceType: 'appointment',
        resourceId: appointmentId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return started
    }

    this.sql.exec(
      `UPDATE appointment SET status = 'in_encounter', encounter_id = ?, updated_at = ? WHERE appointment_id = ?`,
      started.encounter.encounterId,
      nowIso,
      appointmentId,
    )
    this.sql.exec(
      `INSERT OR IGNORE INTO care_relationship (patient_id, staff_id, relation_kind, created_at)
       VALUES (?, ?, 'primary', ?)`,
      appt.patientId,
      verified.staffId,
      nowIso,
    )
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'appointment.start_encounter',
      resourceType: 'appointment',
      resourceId: appointmentId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    return { ok: true, appointment: this.findById(appointmentId)!, encounter: started.encounter }
  }

  markCompletedByEncounter(encounterId: string, nowIso: string): void {
    this.sql.exec(
      `UPDATE appointment SET status = 'completed', updated_at = ? WHERE encounter_id = ? AND status = 'in_encounter'`,
      nowIso,
      encounterId,
    )
  }

  listAuthorizedPatients(principal: Principal): { ok: true; patients: StaffPatientView[] } | Refusal {
    if (!principal.staffId) {
      return refuse({ code: 'forbidden', message: '仅医护人员可查阅授权患者档案。' })
    }
    const rows = this.sql
      .exec<{
        patient_id: string
        actor_id: string
        display_name: string
        sex: 'male' | 'female'
        birth_date: string
        outpatient_number: string
        department_id: string
        department_name: string
        primary_doctor_id: string | null
        primary_doctor_name: string | null
        allergies_json: string
        chronic_conditions_json: string
        relation_kind: string
        release_count: number
        appointment_count: number
      }>(
        `SELECT p.patient_id, p.actor_id, p.display_name, p.sex, p.birth_date, p.outpatient_number,
                p.department_id, d.name AS department_name, p.primary_doctor_id,
                da.display_name AS primary_doctor_name, p.allergies_json, p.chronic_conditions_json,
                MIN(r.relation_kind) AS relation_kind,
                (SELECT COUNT(*) FROM patient_release pr WHERE pr.patient_id = p.patient_id AND pr.retracted_at IS NULL) AS release_count,
                (SELECT COUNT(*) FROM appointment ap WHERE ap.patient_id = p.patient_id) AS appointment_count
         FROM care_relationship r
         JOIN patient_profile p ON p.patient_id = r.patient_id
         JOIN clinic_department d ON d.department_id = p.department_id
         LEFT JOIN staff_profile ds ON ds.staff_id = p.primary_doctor_id
         LEFT JOIN actor da ON da.actor_id = ds.actor_id
         WHERE r.staff_id = ?
         GROUP BY p.patient_id
         ORDER BY p.patient_id ASC`,
        principal.staffId,
      )
      .toArray()

    return {
      ok: true,
      patients: rows.map((row) => ({
        patientId: row.patient_id,
        actorId: row.actor_id,
        displayName: row.display_name,
        sex: row.sex,
        birthDate: row.birth_date,
        outpatientNumber: row.outpatient_number,
        departmentId: row.department_id,
        departmentName: row.department_name,
        primaryDoctorId: row.primary_doctor_id,
        primaryDoctorName: row.primary_doctor_name,
        allergies: JSON.parse(row.allergies_json) as Array<{ agent: string; reaction: string }>,
        chronicConditions: JSON.parse(row.chronic_conditions_json) as Array<{ code: string; display: string }>,
        relation: row.relation_kind,
        releaseCount: row.release_count,
        appointmentCount: row.appointment_count,
      })),
    }
  }

  findById(appointmentId: string): AppointmentView | null {
    return this.queryAppointments(['ap.appointment_id = ?'], [appointmentId])[0] ?? null
  }

  private findByRequestId(patientId: string, clientRequestId: string): AppointmentView | null {
    return this.queryAppointments(['ap.patient_id = ?', 'ap.client_request_id = ?'], [patientId, clientRequestId])[0] ?? null
  }

  private queryAppointments(clauses: string[], params: unknown[]): AppointmentView[] {
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.sql
      .exec<AppointmentRow>(
        `SELECT ap.appointment_id, ap.patient_id, p.display_name AS patient_name, p.outpatient_number,
                ap.slot_id, ap.doctor_id, da.display_name AS doctor_name, ap.department_id, d.name AS department_name,
                sl.starts_at, sl.ends_at, ap.status, ap.client_request_id, ap.encounter_id,
                ap.chief_complaint, ap.created_at, ap.updated_at, ap.cancelled_at
         FROM appointment ap
         JOIN patient_profile p ON p.patient_id = ap.patient_id
         JOIN appointment_slot sl ON sl.slot_id = ap.slot_id
         JOIN staff_profile ds ON ds.staff_id = ap.doctor_id
         JOIN actor da ON da.actor_id = ds.actor_id
         JOIN clinic_department d ON d.department_id = ap.department_id
         ${where}
         ORDER BY sl.starts_at ASC, ap.created_at DESC`,
        ...params,
      )
      .toArray()
      .map((row) => ({
        appointmentId: row.appointment_id,
        patientId: row.patient_id,
        patientName: row.patient_name,
        outpatientNumber: row.outpatient_number,
        slotId: row.slot_id,
        doctorId: row.doctor_id,
        doctorName: row.doctor_name,
        departmentId: row.department_id,
        departmentName: row.department_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
        clientRequestId: row.client_request_id,
        encounterId: row.encounter_id,
        chiefComplaint: row.chief_complaint,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cancelledAt: row.cancelled_at,
      }))
  }
}
