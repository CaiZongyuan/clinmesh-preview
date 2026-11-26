import seedManifest from '../../../data/demo-clinic/seed-manifest.json'
import type {
  ActorKind,
  ActorRole,
  ContactView,
  DemoResetResponse,
  DepartmentView,
  DoctorView,
  PatientReleasePayload,
  PatientReleaseResourceType,
  PatientReleaseView,
  Principal,
  StaffRole,
} from '../../shared/auth'
import type { EncounterError } from '../../shared/encounter'
import { hashSecret, timingSafeEqual } from './crypto'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface PreparedSeedHashes {
  staffPasswords: Record<string, string>
  inviteCodes: Record<string, string>
}

let cachedSeedHashes: Promise<PreparedSeedHashes> | null = null

export function prepareSeedHashes(): Promise<PreparedSeedHashes> {
  if (!cachedSeedHashes) {
    cachedSeedHashes = (async () => {
      const staffPasswords: Record<string, string> = {}
      for (const staff of seedManifest.staff) {
        staffPasswords[staff.staffId] = await hashSecret(`staff:${staff.username}`, staff.demoPassword)
      }
      const inviteCodes: Record<string, string> = {}
      for (const patient of seedManifest.patients) {
        inviteCodes[patient.patientId] = await hashSecret('invite', normalizeInviteCode(patient.inviteCode))
      }
      return { staffPasswords, inviteCodes }
    })()
  }
  return cachedSeedHashes
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase()
}

type Refusal = { ok: false; error: EncounterError }
export type PrincipalResult = { ok: true; principal: Principal } | Refusal
export type PatientReleasesResult = { ok: true; items: PatientReleaseView[] } | Refusal
export type PatientReleaseDetailResult = { ok: true; item: PatientReleaseView } | Refusal

type PrincipalJoinRow = {
  session_id: string
  account_id: string
  actor_id: string
  clinic_id: string
  kind: ActorKind
  role: ActorRole
  display_name: string
  im_uid: string
  actor_status: string
  account_status: string
  expires_at: string
  revoked_at: string | null
  patient_id: string | null
  staff_id: string | null
  staff_department_id: string | null
  patient_department_id: string | null
}

type StaffLookupRow = {
  staff_id: string
  actor_id: string
  account_id: string
  role: StaffRole
  username: string
  password_hash: string
  actor_status: string
  account_status: string
}

type PatientInviteRow = {
  patient_id: string
  actor_id: string
  invite_code_expires_at: string | null
  bound_at: string | null
}

type ReleaseRow = {
  release_id: string
  patient_id: string
  encounter_id: string | null
  resource_type: PatientReleaseResourceType
  resource_id: string
  version: number
  title: string
  summary: string
  payload_json: string
  published_by: string
  published_by_name: string
  published_at: string
  retracted_at: string | null
}

export interface ClinicAuditEntry {
  actorId: string
  actorRole: string
  action: string
  resourceType: string
  resourceId: string
  requestId?: string | null
  runId?: string | null
  outcome: 'allowed' | 'denied' | 'error'
  occurredAt: string
}

const refuse = (error: EncounterError): Refusal => ({ ok: false, error })

export class AuthRepository {
  constructor(private readonly sql: SqlStorage) {}

  isSeeded(): boolean {
    const row = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM clinic_department').one()
    return row.count > 0
  }

  ensureSeeded(hashes: PreparedSeedHashes, nowIso: string): void {
    if (this.isSeeded()) return
    this.seed(hashes, nowIso)
  }

  resetDemo(workspace: string, hashes: PreparedSeedHashes, nowIso: string): DemoResetResponse {
    // Wipe all Connected Clinic tables atomically so old sessions, bindings, and releases never leak across resets.
    for (const table of [
      'clinic_audit_event',
      'auth_session',
      'account',
      'patient_release',
      'appointment_slot',
      'care_relationship',
      'patient_profile',
      'staff_profile',
      'actor',
      'clinic_department',
    ]) {
      this.sql.exec(`DELETE FROM ${table}`)
    }
    this.seed(hashes, nowIso)
    return {
      workspace,
      seedVersion: seedManifest.seedVersion,
      departments: seedManifest.departments.length,
      staff: seedManifest.staff.length,
      patients: seedManifest.patients.length,
      slots: seedManifest.slots.length,
      releases: seedManifest.patientReleases.length,
      resetAt: nowIso,
    }
  }

  private seed(hashes: PreparedSeedHashes, nowIso: string): void {
    const clinicId = seedManifest.clinicId
    for (const dept of seedManifest.departments) {
      this.sql.exec(
        'INSERT INTO clinic_department (department_id, name) VALUES (?, ?)',
        dept.departmentId,
        dept.name,
      )
    }

    for (const staff of seedManifest.staff) {
      this.sql.exec(
        `INSERT INTO actor (actor_id, clinic_id, kind, role, display_name, im_uid, status)
         VALUES (?, ?, 'human', ?, ?, ?, 'active')`,
        staff.actorId,
        clinicId,
        staff.role,
        staff.displayName,
        staff.imUid,
      )
      this.sql.exec(
        `INSERT INTO staff_profile (staff_id, actor_id, role, title, department_id, username, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        staff.staffId,
        staff.actorId,
        staff.role,
        staff.title,
        staff.departmentId,
        staff.username,
        hashes.staffPasswords[staff.staffId],
      )
      this.sql.exec(
        `INSERT INTO account (account_id, provider, provider_subject, actor_id, status, created_at)
         VALUES (?, 'staff', ?, ?, 'active', ?)`,
        `acct_${staff.staffId}`,
        staff.username,
        staff.actorId,
        nowIso,
      )
    }

    for (const agent of seedManifest.agents) {
      this.sql.exec(
        `INSERT INTO actor (actor_id, clinic_id, kind, role, display_name, im_uid, status)
         VALUES (?, ?, 'agent', 'agent', ?, ?, 'active')`,
        agent.actorId,
        clinicId,
        agent.displayName,
        agent.imUid,
      )
    }

    for (const patient of seedManifest.patients) {
      this.sql.exec(
        `INSERT INTO actor (actor_id, clinic_id, kind, role, display_name, im_uid, status)
         VALUES (?, ?, 'human', 'patient', ?, ?, 'active')`,
        patient.actorId,
        clinicId,
        patient.displayName,
        patient.imUid,
      )
      this.sql.exec(
        `INSERT INTO patient_profile (
           patient_id, actor_id, display_name, sex, birth_date, outpatient_number,
           primary_doctor_id, department_id, allergies_json, chronic_conditions_json,
           invite_code_hash, invite_code_expires_at, bound_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        patient.patientId,
        patient.actorId,
        patient.displayName,
        patient.sex,
        patient.birthDate,
        patient.outpatientNumber,
        patient.primaryDoctorId,
        patient.departmentId,
        JSON.stringify(patient.allergies),
        JSON.stringify(patient.chronicConditions),
        hashes.inviteCodes[patient.patientId],
        patient.inviteCodeExpiresAt,
      )
    }

    for (const rel of seedManifest.careRelationships) {
      this.sql.exec(
        `INSERT INTO care_relationship (patient_id, staff_id, relation_kind, created_at)
         VALUES (?, ?, ?, ?)`,
        rel.patientId,
        rel.staffId,
        rel.relationKind,
        nowIso,
      )
    }

    for (const slot of seedManifest.slots) {
      this.sql.exec(
        `INSERT INTO appointment_slot (slot_id, doctor_id, department_id, starts_at, ends_at, capacity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        slot.slotId,
        slot.doctorId,
        slot.departmentId,
        slot.startsAt,
        slot.endsAt,
        slot.capacity,
        slot.status,
      )
    }

    for (const rel of seedManifest.patientReleases) {
      this.sql.exec(
        `INSERT INTO patient_release (
           release_id, patient_id, encounter_id, resource_type, resource_id, version,
           title, summary, payload_json, published_by, published_at, retracted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rel.releaseId,
        rel.patientId,
        rel.encounterId,
        rel.resourceType,
        rel.resourceId,
        rel.version,
        rel.title,
        rel.summary,
        JSON.stringify(rel.payload),
        rel.publishedBy,
        rel.publishedAt,
        rel.retractedAt,
      )
    }
  }

  loginStaff(username: string, passwordHash: string, tokenHash: string, now: Date): PrincipalResult {
    const nowIso = now.toISOString()
    const row = this.sql
      .exec<StaffLookupRow>(
        `SELECT s.staff_id, s.actor_id, acct.account_id, s.role, s.username, s.password_hash,
                a.status AS actor_status, acct.status AS account_status
         FROM staff_profile s
         JOIN actor a ON a.actor_id = s.actor_id
         JOIN account acct ON acct.actor_id = s.actor_id AND acct.provider = 'staff'
         WHERE s.username = ?`,
        username,
      )
      .toArray()[0]

    if (!row || row.actor_status !== 'active' || row.account_status !== 'active' || !timingSafeEqual(row.password_hash, passwordHash)) {
      this.audit({
        actorId: row?.actor_id ?? 'anonymous',
        actorRole: row?.role ?? 'anonymous',
        action: 'auth.staff.login',
        resourceType: 'account',
        resourceId: username,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'invalid-credentials', message: '账号或密码错误。' })
    }

    const principal = this.createSession(row.account_id, row.actor_id, tokenHash, now)
    this.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'auth.staff.login',
      resourceType: 'session',
      resourceId: principal.sessionId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, principal }
  }

  loginWeChat(openid: string, inviteCodeHash: string | null, tokenHash: string, now: Date): PrincipalResult {
    const nowIso = now.toISOString()
    const existing = this.sql
      .exec<{ account_id: string; actor_id: string; account_status: string; actor_status: string }>(
        `SELECT acct.account_id, acct.actor_id, acct.status AS account_status, a.status AS actor_status
         FROM account acct
         JOIN actor a ON a.actor_id = acct.actor_id
         WHERE acct.provider = 'wechat' AND acct.provider_subject = ?`,
        openid,
      )
      .toArray()[0]

    if (existing) {
      if (existing.account_status !== 'active' || existing.actor_status !== 'active') {
        return refuse({ code: 'forbidden', message: '该微信演示账号已停用。' })
      }
      // Once bound to a patient identity, repeat login always returns that same patient and cannot hijack another invite code.
      const principal = this.createSession(existing.account_id, existing.actor_id, tokenHash, now)
      this.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'auth.wechat.login',
        resourceType: 'session',
        resourceId: principal.sessionId,
        outcome: 'allowed',
        occurredAt: nowIso,
      })
      return { ok: true, principal }
    }

    if (!inviteCodeHash) {
      this.audit({
        actorId: 'anonymous',
        actorRole: 'anonymous',
        action: 'auth.wechat.bind',
        resourceType: 'patient_profile',
        resourceId: 'missing-invite',
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'invite-code-required', message: '首次微信登录需输入演示邀请码以绑定演示患者身份。' })
    }

    const patient = this.sql
      .exec<PatientInviteRow>(
        `SELECT patient_id, actor_id, invite_code_expires_at, bound_at
         FROM patient_profile
         WHERE invite_code_hash = ?`,
        inviteCodeHash,
      )
      .toArray()[0]

    if (!patient) {
      this.audit({
        actorId: 'anonymous',
        actorRole: 'anonymous',
        action: 'auth.wechat.bind',
        resourceType: 'patient_profile',
        resourceId: 'invalid-invite',
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'invite-code-invalid', message: '演示邀请码无效，请核对后重试。' })
    }

    if (patient.invite_code_expires_at && Date.parse(patient.invite_code_expires_at) <= now.getTime()) {
      this.audit({
        actorId: patient.actor_id,
        actorRole: 'patient',
        action: 'auth.wechat.bind',
        resourceType: 'patient_profile',
        resourceId: patient.patient_id,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'invite-code-expired', message: '该演示邀请码已过期。' })
    }

    if (patient.bound_at !== null) {
      this.audit({
        actorId: patient.actor_id,
        actorRole: 'patient',
        action: 'auth.wechat.bind',
        resourceType: 'patient_profile',
        resourceId: patient.patient_id,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'patient-already-bound', message: '该演示患者身份已被其他微信账号绑定。' })
    }

    const accountId = `acct_wx_${crypto.randomUUID()}`
    this.sql.exec(
      `INSERT INTO account (account_id, provider, provider_subject, actor_id, status, created_at)
       VALUES (?, 'wechat', ?, ?, 'active', ?)`,
      accountId,
      openid,
      patient.actor_id,
      nowIso,
    )
    this.sql.exec('UPDATE patient_profile SET bound_at = ? WHERE patient_id = ?', nowIso, patient.patient_id)
    const principal = this.createSession(accountId, patient.actor_id, tokenHash, now)
    this.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'auth.wechat.bind',
      resourceType: 'patient_profile',
      resourceId: patient.patient_id,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, principal }
  }

  private createSession(accountId: string, actorId: string, tokenHash: string, now: Date): Principal {
    const sessionId = `sess_${crypto.randomUUID()}`
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    this.sql.exec(
      `INSERT INTO auth_session (session_id, token_hash, account_id, actor_id, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      sessionId,
      tokenHash,
      accountId,
      actorId,
      createdAt,
      expiresAt,
    )
    return this.lookupSession(tokenHash, now)!
  }

  authenticateSession(tokenHash: string, now: Date): PrincipalResult {
    const principal = this.lookupSession(tokenHash, now)
    if (!principal) {
      return refuse({ code: 'unauthorized', message: '未登录或会话已失效，请重新登录。' })
    }
    return { ok: true, principal }
  }

  revokeSession(tokenHash: string, now: Date): PrincipalResult {
    const principal = this.lookupSession(tokenHash, now)
    if (!principal) {
      return refuse({ code: 'unauthorized', message: '未登录或会话已失效。' })
    }
    const nowIso = now.toISOString()
    this.sql.exec('UPDATE auth_session SET revoked_at = ? WHERE session_id = ?', nowIso, principal.sessionId)
    this.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: principal.sessionId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, principal }
  }

  // Transactional check for clinical commands: verifies staffId belongs to an active doctor/staff row.
  verifyActiveStaff(staffId: string, doctorOnly: boolean): { ok: true; staffId: string; actorId: string; role: StaffRole } | Refusal {
    const row = this.sql
      .exec<{ staff_id: string; actor_id: string; role: StaffRole; status: string }>(
        `SELECT s.staff_id, s.actor_id, s.role, a.status
         FROM staff_profile s
         JOIN actor a ON a.actor_id = s.actor_id
         WHERE s.staff_id = ?`,
        staffId,
      )
      .toArray()[0]

    if (!row || row.status !== 'active') {
      return refuse({ code: 'forbidden', message: '当前医护身份无效或已停用。' })
    }
    if (doctorOnly && row.role !== 'doctor') {
      return refuse({ code: 'forbidden', message: '仅授权医生可执行正式临床诊疗操作。' })
    }
    return { ok: true, staffId: row.staff_id, actorId: row.actor_id, role: row.role }
  }

  listDepartments(): DepartmentView[] {
    return this.sql
      .exec<{ department_id: string; name: string }>('SELECT department_id, name FROM clinic_department ORDER BY department_id')
      .toArray()
      .map((row) => ({ departmentId: row.department_id, name: row.name }))
  }

  listDoctors(): DoctorView[] {
    return this.sql
      .exec<{
        staff_id: string
        actor_id: string
        display_name: string
        title: string
        department_id: string
        department_name: string
      }>(
        `SELECT s.staff_id, s.actor_id, a.display_name, s.title, s.department_id, d.name AS department_name
         FROM staff_profile s
         JOIN actor a ON a.actor_id = s.actor_id
         JOIN clinic_department d ON d.department_id = s.department_id
         WHERE s.role = 'doctor' AND a.status = 'active'
         ORDER BY s.staff_id`,
      )
      .toArray()
      .map((row) => ({
        staffId: row.staff_id,
        actorId: row.actor_id,
        displayName: row.display_name,
        title: row.title,
        departmentId: row.department_id,
        departmentName: row.department_name,
      }))
  }

  listContacts(principal: Principal): ContactView[] {
    if (principal.role === 'patient' && principal.patientId) {
      // Patients see ONLY their authorized care team + Patient Service Agent; never other patients.
      const careTeam = this.sql
        .exec<{
          actor_id: string
          kind: ActorKind
          role: ActorRole
          display_name: string
          im_uid: string
          relation_kind: string
          department_id: string | null
          staff_id: string
        }>(
          `SELECT a.actor_id, a.kind, a.role, a.display_name, a.im_uid, r.relation_kind, s.department_id, s.staff_id
           FROM care_relationship r
           JOIN staff_profile s ON s.staff_id = r.staff_id
           JOIN actor a ON a.actor_id = s.actor_id
           WHERE r.patient_id = ? AND a.status = 'active'
           ORDER BY s.staff_id`,
          principal.patientId,
        )
        .toArray()
        .map<ContactView>((row) => ({
          actorId: row.actor_id,
          kind: row.kind,
          role: row.role,
          displayName: row.display_name,
          imUid: row.im_uid,
          relation: row.relation_kind,
          departmentId: row.department_id,
          staffId: row.staff_id,
          patientId: null,
        }))

      const serviceAgent = this.sql
        .exec<{ actor_id: string; kind: ActorKind; role: ActorRole; display_name: string; im_uid: string }>(
          `SELECT actor_id, kind, role, display_name, im_uid FROM actor
           WHERE actor_id = 'actor_agent_patient_svc' AND status = 'active'`,
        )
        .toArray()
        .map<ContactView>((row) => ({
          actorId: row.actor_id,
          kind: row.kind,
          role: row.role,
          displayName: row.display_name,
          imUid: row.im_uid,
          relation: 'assistant',
          departmentId: null,
          staffId: null,
          patientId: null,
        }))

      return [...serviceAgent, ...careTeam]
    }

    if (principal.role === 'doctor' || principal.role === 'nurse' || principal.role === 'admin') {
      const colleagues = this.sql
        .exec<{
          actor_id: string
          kind: ActorKind
          role: ActorRole
          display_name: string
          im_uid: string
          department_id: string | null
          staff_id: string
        }>(
          `SELECT a.actor_id, a.kind, a.role, a.display_name, a.im_uid, s.department_id, s.staff_id
           FROM staff_profile s
           JOIN actor a ON a.actor_id = s.actor_id
           WHERE a.status = 'active' AND a.actor_id != ?
           ORDER BY s.staff_id`,
          principal.actorId,
        )
        .toArray()
        .map<ContactView>((row) => ({
          actorId: row.actor_id,
          kind: row.kind,
          role: row.role,
          displayName: row.display_name,
          imUid: row.im_uid,
          relation: 'colleague',
          departmentId: row.department_id,
          staffId: row.staff_id,
          patientId: null,
        }))

      const patients = this.sql
        .exec<{
          actor_id: string
          kind: ActorKind
          role: ActorRole
          display_name: string
          im_uid: string
          relation_kind: string
          department_id: string | null
          patient_id: string
        }>(
          `SELECT a.actor_id, a.kind, a.role, a.display_name, a.im_uid, r.relation_kind, p.department_id, p.patient_id
           FROM care_relationship r
           JOIN patient_profile p ON p.patient_id = r.patient_id
           JOIN actor a ON a.actor_id = p.actor_id
           WHERE r.staff_id = ? AND a.status = 'active'
           ORDER BY p.patient_id`,
          principal.staffId ?? '',
        )
        .toArray()
        .map<ContactView>((row) => ({
          actorId: row.actor_id,
          kind: row.kind,
          role: row.role,
          displayName: row.display_name,
          imUid: row.im_uid,
          relation: row.relation_kind,
          departmentId: row.department_id,
          staffId: null,
          patientId: row.patient_id,
        }))

      const agents = this.sql
        .exec<{ actor_id: string; kind: ActorKind; role: ActorRole; display_name: string; im_uid: string }>(
          `SELECT actor_id, kind, role, display_name, im_uid FROM actor
           WHERE kind = 'agent' AND status = 'active'
           ORDER BY actor_id`,
        )
        .toArray()
        .map<ContactView>((row) => ({
          actorId: row.actor_id,
          kind: row.kind,
          role: row.role,
          displayName: row.display_name,
          imUid: row.im_uid,
          relation: 'agent',
          departmentId: null,
          staffId: null,
          patientId: null,
        }))

      return [...colleagues, ...patients, ...agents]
    }

    return []
  }

  listPatientReleases(principal: Principal, resourceType: PatientReleaseResourceType, nowIso: string): PatientReleasesResult {
    if (principal.role !== 'patient' || !principal.patientId) {
      this.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: `patient.${resourceType}.list`,
        resourceType,
        resourceId: '*',
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅患者本人可访问患者门户资料。' })
    }

    const rows = this.sql
      .exec<ReleaseRow>(
        `SELECT r.release_id, r.patient_id, r.encounter_id, r.resource_type, r.resource_id, r.version,
                r.title, r.summary, r.payload_json, r.published_by, a.display_name AS published_by_name,
                r.published_at, r.retracted_at
         FROM patient_release r
         JOIN actor a ON a.actor_id = r.published_by
         WHERE r.patient_id = ? AND r.resource_type = ? AND r.retracted_at IS NULL
         ORDER BY r.published_at DESC, r.version DESC`,
        principal.patientId,
        resourceType,
      )
      .toArray()

    return { ok: true, items: rows.map(toReleaseView) }
  }

  getPatientRelease(
    principal: Principal,
    resourceType: PatientReleaseResourceType,
    releaseOrResourceId: string,
    nowIso: string,
  ): PatientReleaseDetailResult {
    if (principal.role !== 'patient' || !principal.patientId) {
      this.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: `patient.${resourceType}.get`,
        resourceType,
        resourceId: releaseOrResourceId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅患者本人可访问患者门户资料。' })
    }

    const row = this.sql
      .exec<ReleaseRow>(
        `SELECT r.release_id, r.patient_id, r.encounter_id, r.resource_type, r.resource_id, r.version,
                r.title, r.summary, r.payload_json, r.published_by, a.display_name AS published_by_name,
                r.published_at, r.retracted_at
         FROM patient_release r
         JOIN actor a ON a.actor_id = r.published_by
         WHERE r.patient_id = ? AND r.resource_type = ?
           AND (r.release_id = ? OR r.resource_id = ?)
           AND r.retracted_at IS NULL
         ORDER BY r.version DESC
         LIMIT 1`,
        principal.patientId,
        resourceType,
        releaseOrResourceId,
        releaseOrResourceId,
      )
      .toArray()[0]

    if (!row) {
      this.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: `patient.${resourceType}.get`,
        resourceType,
        resourceId: releaseOrResourceId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'resource-not-found', message: '未找到该已发布资料或无权访问。' })
    }

    return { ok: true, item: toReleaseView(row) }
  }

  audit(entry: ClinicAuditEntry): void {
    this.sql.exec(
      `INSERT INTO clinic_audit_event (
         actor_id, actor_role, action, resource_type, resource_id, request_id, run_id, outcome, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.actorId,
      entry.actorRole,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.requestId ?? null,
      entry.runId ?? null,
      entry.outcome,
      entry.occurredAt,
    )
  }

  private lookupSession(tokenHash: string, now: Date): Principal | null {
    const row = this.sql
      .exec<PrincipalJoinRow>(
        `SELECT s.session_id, s.account_id, s.actor_id, a.clinic_id, a.kind, a.role, a.display_name, a.im_uid,
                a.status AS actor_status, acct.status AS account_status, s.expires_at, s.revoked_at,
                p.patient_id, st.staff_id, st.department_id AS staff_department_id, p.department_id AS patient_department_id
         FROM auth_session s
         JOIN account acct ON acct.account_id = s.account_id
         JOIN actor a ON a.actor_id = s.actor_id
         LEFT JOIN patient_profile p ON p.actor_id = a.actor_id
         LEFT JOIN staff_profile st ON st.actor_id = a.actor_id
         WHERE s.token_hash = ?`,
        tokenHash,
      )
      .toArray()[0]

    if (!row) return null
    if (row.revoked_at !== null) return null
    if (row.actor_status !== 'active' || row.account_status !== 'active') return null
    if (Date.parse(row.expires_at) <= now.getTime()) return null

    return {
      sessionId: row.session_id,
      accountId: row.account_id,
      actorId: row.actor_id,
      clinicId: row.clinic_id,
      kind: row.kind,
      role: row.role,
      displayName: row.display_name,
      imUid: row.im_uid,
      patientId: row.patient_id,
      staffId: row.staff_id,
      departmentId: row.staff_department_id ?? row.patient_department_id,
      expiresAt: row.expires_at,
    }
  }
}

function toReleaseView(row: ReleaseRow): PatientReleaseView {
  return {
    releaseId: row.release_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    version: row.version,
    encounterId: row.encounter_id,
    title: row.title,
    summary: row.summary,
    payload: JSON.parse(row.payload_json) as PatientReleasePayload,
    publishedBy: row.published_by,
    publishedByName: row.published_by_name,
    publishedAt: row.published_at,
  }
}
