import type { PublishPatientReleaseRequest } from '../../shared/appointment'
import type { PatientReleasePayload, PatientReleaseResourceType, PatientReleaseView, Principal } from '../../shared/auth'
import type { EncounterError } from '../../shared/encounter'
import type { AuthRepository } from '../auth/auth-repository'
import type { ClinicalNoteRepository } from '../clinical-note-repository'
import type { EncounterRepository } from '../encounter-repository'
import type { InvestigationRepository } from '../investigation-repository'
import type { PrescriptionRepository } from '../prescription-repository'

type Refusal = { ok: false; error: EncounterError }
const refuse = (error: EncounterError): Refusal => ({ ok: false, error })

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

function toView(row: ReleaseRow): PatientReleaseView {
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

export class PatientReleaseRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: AuthRepository,
    private readonly encounters: EncounterRepository,
    private readonly clinicalNote: ClinicalNoteRepository,
    private readonly investigations: InvestigationRepository,
    private readonly prescriptions: PrescriptionRepository,
  ) {}

  publish(
    principal: Principal,
    input: PublishPatientReleaseRequest,
    now: Date,
  ): { ok: true; item: PatientReleaseView; created: boolean } | Refusal {
    const nowIso = now.toISOString()
    if (!principal.staffId || principal.role !== 'doctor') {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'release.publish',
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? input.encounterId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅授权医生可向患者发布正式临床资料。' })
    }
    const verified = this.auth.verifyActiveStaff(principal.staffId, true)
    if (!verified.ok) return verified

    const found = this.encounters.get(input.encounterId)
    if (!found.ok) return found
    const encounter = found.encounter
    if (!encounter.patientId) {
      return refuse({ code: 'release-source-not-ready', message: '该就诊未关联 Connected Clinic 患者档案，无法发布患者投影。' })
    }
    if (encounter.status === 'abandoned') {
      return refuse({ code: 'encounter-not-active', message: '已放弃的就诊不能向患者发布临床资料。' })
    }
    if (encounter.practitionerId !== verified.staffId && !this.hasCareRelationship(encounter.patientId, verified.staffId)) {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'release.publish',
        resourceType: input.resourceType,
        resourceId: encounter.encounterId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅负责该就诊或具授权诊疗关系的医生可发布患者资料。' })
    }

    const built = this.buildProjection(encounter, input, now.getTime())
    if (!built.ok) return built

    const existing = this.sql
      .exec<ReleaseRow>(
        `SELECT r.release_id, r.patient_id, r.encounter_id, r.resource_type, r.resource_id, r.version,
                r.title, r.summary, r.payload_json, r.published_by, a.display_name AS published_by_name,
                r.published_at, r.retracted_at
         FROM patient_release r
         JOIN actor a ON a.actor_id = r.published_by
         WHERE r.resource_type = ? AND r.resource_id = ? AND r.version = ?`,
        input.resourceType,
        built.resourceId,
        built.version,
      )
      .toArray()[0]

    if (existing && existing.retracted_at === null) {
      return { ok: true, item: toView(existing), created: false }
    }

    const releaseId = existing?.release_id ?? `rel_${input.resourceType}_${crypto.randomUUID().slice(0, 12)}`
    if (existing) {
      this.sql.exec(
        `UPDATE patient_release
         SET title = ?, summary = ?, payload_json = ?, published_by = ?, published_at = ?, retracted_at = NULL
         WHERE release_id = ?`,
        built.title,
        built.summary,
        JSON.stringify(built.payload),
        principal.actorId,
        nowIso,
        releaseId,
      )
    } else {
      this.sql.exec(
        `INSERT INTO patient_release (
           release_id, patient_id, encounter_id, resource_type, resource_id, version,
           title, summary, payload_json, published_by, published_at, retracted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        releaseId,
        encounter.patientId,
        encounter.encounterId,
        input.resourceType,
        built.resourceId,
        built.version,
        built.title,
        built.summary,
        JSON.stringify(built.payload),
        principal.actorId,
        nowIso,
      )
    }

    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'release.publish',
      resourceType: input.resourceType,
      resourceId: releaseId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    return { ok: true, item: this.findById(releaseId)!, created: true }
  }

  retract(principal: Principal, releaseId: string, nowIso: string): { ok: true; releaseId: string } | Refusal {
    if (!principal.staffId || principal.role !== 'doctor') {
      return refuse({ code: 'forbidden', message: '仅授权医生可撤回已发布资料。' })
    }
    const verified = this.auth.verifyActiveStaff(principal.staffId, true)
    if (!verified.ok) return verified
    const raw = this.sql
      .exec<{ release_id: string; patient_id: string; published_by: string; resource_type: PatientReleaseResourceType }>(
        'SELECT release_id, patient_id, published_by, resource_type FROM patient_release WHERE release_id = ?',
        releaseId,
      )
      .toArray()[0]
    if (!raw) {
      return refuse({ code: 'release-not-found', message: `找不到已发布资料 ${releaseId}` })
    }
    if (raw.published_by !== principal.actorId && !this.hasCareRelationship(raw.patient_id, verified.staffId)) {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'release.retract',
        resourceType: raw.resource_type,
        resourceId: releaseId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅发布医生或该患者授权医生可撤回已发布资料。' })
    }
    this.sql.exec('UPDATE patient_release SET retracted_at = ? WHERE release_id = ?', nowIso, releaseId)
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'release.retract',
      resourceType: raw.resource_type,
      resourceId: releaseId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, releaseId }
  }

  private hasCareRelationship(patientId: string, staffId: string): boolean {
    return (
      this.sql
        .exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM care_relationship WHERE patient_id = ? AND staff_id = ?',
          patientId,
          staffId,
        )
        .one().count > 0
    )
  }

  listForEncounter(principal: Principal, encounterId: string): { ok: true; items: PatientReleaseView[] } | Refusal {
    if (!principal.staffId) {
      return refuse({ code: 'forbidden', message: '仅医护人员可查看就诊发布记录。' })
    }
    const rows = this.sql
      .exec<ReleaseRow>(
        `SELECT r.release_id, r.patient_id, r.encounter_id, r.resource_type, r.resource_id, r.version,
                r.title, r.summary, r.payload_json, r.published_by, a.display_name AS published_by_name,
                r.published_at, r.retracted_at
         FROM patient_release r
         JOIN actor a ON a.actor_id = r.published_by
         WHERE r.encounter_id = ? AND r.retracted_at IS NULL
         ORDER BY r.published_at DESC`,
        encounterId,
      )
      .toArray()
    return { ok: true, items: rows.map(toView) }
  }

  private findById(releaseId: string): PatientReleaseView | null {
    const row = this.sql
      .exec<ReleaseRow>(
        `SELECT r.release_id, r.patient_id, r.encounter_id, r.resource_type, r.resource_id, r.version,
                r.title, r.summary, r.payload_json, r.published_by, a.display_name AS published_by_name,
                r.published_at, r.retracted_at
         FROM patient_release r
         JOIN actor a ON a.actor_id = r.published_by
         WHERE r.release_id = ?`,
        releaseId,
      )
      .toArray()[0]
    return row ? toView(row) : null
  }

  private buildProjection(
    encounter: import('../../shared/encounter').EncounterView,
    input: PublishPatientReleaseRequest,
    nowMs: number,
  ):
    | { ok: true; resourceId: string; version: number; title: string; summary: string; payload: PatientReleasePayload }
    | Refusal {
    const visitedDate = encounter.startedAt.slice(0, 10)
    if (input.resourceType === 'clinical_note') {
      const note = this.clinicalNote.view(encounter.encounterId)
      if (!note.ok) return note
      const latest = note.note.revisions.at(-1)
      if (!latest) {
        return refuse({ code: 'release-source-not-ready', message: '门诊病历尚未签署，草稿不能发布给患者。' })
      }
      return {
        ok: true,
        resourceId: `note_${encounter.encounterId}`,
        version: latest.version,
        title: input.title?.trim() || `${encounter.patient.department}门诊病历（${visitedDate}）`,
        summary: input.summary?.trim() || latest.sections.assessment || latest.sections.plan || latest.sections['chief-complaint'],
        payload: {
          department: encounter.patient.department,
          visitedDate,
          chiefComplaint: latest.sections['chief-complaint'],
          plan: latest.sections.plan,
        },
      }
    }

    if (input.resourceType === 'report') {
      const atMs = encounter.endedAt ? Date.parse(encounter.endedAt) : nowMs
      const list = this.investigations.list(encounter, atMs)
      const candidates = list.filter((inv) => inv.cancellation === null && inv.reports.length > 0)
      const target = input.resourceId
        ? candidates.find(
            (inv) =>
              inv.investigationId === input.resourceId ||
              inv.reports.some((rep) => rep.reportId === input.resourceId),
          )
        : candidates.at(-1)
      if (!target) {
        return refuse({ code: 'release-source-not-ready', message: '未找到已正式签发的检查检验报告，不能提前发布。' })
      }
      const latestReport = target.reports.at(-1)!
      const conclusion =
        latestReport.body.kind === 'narrative'
          ? latestReport.body.impression
          : latestReport.body.results
              .map((row) => `${row.name}: ${row.value} ${row.unit}${row.flag ? ` (${row.flag})` : ''}`)
              .join('；')
      return {
        ok: true,
        resourceId: target.investigationId,
        version: latestReport.version,
        title: input.title?.trim() || `${target.name}报告（${visitedDate}）`,
        summary: input.summary?.trim() || conclusion.slice(0, 160),
        payload: {
          category: target.category,
          conclusion,
        },
      }
    }

    const rx = this.prescriptions.view(encounter.encounterId)
    if (!rx.ok) return rx
    if (rx.prescriptions.lines.length === 0 && !rx.prescriptions.noMedication) {
      return refuse({ code: 'release-source-not-ready', message: '尚未签发正式处方或无需用药结论，草稿不能发布给患者。' })
    }
    const items = rx.prescriptions.lines.map((line) => ({
      drugName: line.name,
      dosage: `${line.dose}${line.doseUnit}`,
      frequency: line.frequency,
      route: line.route,
      days: line.days,
    }))
    const rxResourceId = `rx_${encounter.encounterId}`
    const prevVersion =
      this.sql
        .exec<{ v: number | null }>(
          `SELECT MAX(version) AS v FROM patient_release WHERE resource_type = 'prescription' AND resource_id = ?`,
          rxResourceId,
        )
        .one().v ?? 0
    const nextVersion = prevVersion === 0 ? 1 : prevVersion + 1
    return {
      ok: true,
      resourceId: rxResourceId,
      version: nextVersion,
      title: input.title?.trim() || `${encounter.patient.department}正式处方（${visitedDate}）`,
      summary:
        input.summary?.trim() ||
        (rx.prescriptions.noMedication
          ? '经医生评估本次就诊无需药物治疗，请遵医嘱观察随访。'
          : items.map((i) => `${i.drugName} ${i.dosage} ${i.frequency}`).join('；')),
      payload: { items },
    }
  }
}
