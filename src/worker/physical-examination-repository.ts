import type { EncounterError, VitalSign } from '../shared/encounter'
import { BODY_SYSTEM_NAME, type BodySystem, type PhysicalExaminationView } from '../shared/physical-examination'
import type { EncounterRepository } from './encounter-repository'
import { caseTruth, physicalExaminationFinding } from './golden-case-pack'

type PhysicalExaminationRow = {
  body_system: BodySystem
  finding: string
  vitals: string | null
  practitioner_id: string
  examined_at: string
}

export type PhysicalExaminationResult =
  | { ok: true; examination: PhysicalExaminationView }
  | { ok: false; error: EncounterError }

export type PhysicalExaminationsResult =
  | { ok: true; examinations: PhysicalExaminationView[] }
  | { ok: false; error: EncounterError }

// Callers run each command inside one storage transaction, so a refused or failed command writes nothing.
export class PhysicalExaminationRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly encounters: EncounterRepository,
  ) {}

  perform(encounterId: string, system: BodySystem, practitionerId: string, now: string): PhysicalExaminationResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    if (this.find(encounterId, system)) {
      return {
        ok: false,
        error: { code: 'body-system-already-examined', message: `本次就诊已查过${BODY_SYSTEM_NAME[system]}，每个部位只查一次。` },
      }
    }
    const truth = caseTruth(active.encounter.caseId, active.encounter.caseVersion)
    if (!truth.ok) return truth
    const { finding, vitals } = physicalExaminationFinding(truth.caseTruth, system)
    this.sql.exec(
      `INSERT INTO physical_examination (encounter_id, body_system, finding, vitals, practitioner_id, examined_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      encounterId, system, finding, vitals && JSON.stringify(vitals), practitionerId, now,
    )
    this.encounters.audit(encounterId, 'physical-examination-performed', practitionerId, now, system)
    return { ok: true, examination: this.find(encounterId, system)! }
  }

  list(encounterId: string): PhysicalExaminationsResult {
    const found = this.encounters.get(encounterId)
    if (!found.ok) return found
    const rows = this.sql
      .exec<PhysicalExaminationRow>(
        'SELECT * FROM physical_examination WHERE encounter_id = ? ORDER BY examined_at, rowid',
        encounterId,
      )
      .toArray()
    return { ok: true, examinations: rows.map(toView) }
  }

  private find(encounterId: string, system: BodySystem): PhysicalExaminationView | undefined {
    const row = this.sql
      .exec<PhysicalExaminationRow>(
        'SELECT * FROM physical_examination WHERE encounter_id = ? AND body_system = ?',
        encounterId, system,
      )
      .toArray()[0]
    return row && toView(row)
  }
}

function toView(row: PhysicalExaminationRow): PhysicalExaminationView {
  return {
    system: row.body_system,
    finding: row.finding,
    vitals: row.vitals === null ? null : (JSON.parse(row.vitals) as VitalSign[]),
    practitionerId: row.practitioner_id,
    examinedAt: row.examined_at,
  }
}
