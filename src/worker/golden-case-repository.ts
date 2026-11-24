import type { GoldenCaseQueueEntry, Sex, VisitKind } from '../shared/golden-case-queue'
import type { GoldenCaseRegistration } from './golden-case-pack'

type GoldenCaseRow = {
  case_id: string
  queue_number: number
  patient_name: string
  sex: Sex
  birth_date: string
  chief_complaint: string
  registered_at: string
  visit_kind: VisitKind
}

export class GoldenCaseRepository {
  constructor(private readonly sql: SqlStorage) {}

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS golden_case (
        case_id TEXT PRIMARY KEY,
        case_pack_version TEXT NOT NULL,
        queue_number INTEGER NOT NULL UNIQUE,
        patient_name TEXT NOT NULL,
        sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
        birth_date TEXT NOT NULL,
        chief_complaint TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        visit_kind TEXT NOT NULL CHECK (visit_kind IN ('first', 'return'))
      )
    `)
  }

  seed(registrations: readonly GoldenCaseRegistration[]): void {
    for (const r of registrations) {
      this.sql.exec(
        `INSERT INTO golden_case (case_id, case_pack_version, queue_number, patient_name, sex, birth_date, chief_complaint, registered_at, visit_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (case_id) DO NOTHING`,
        r.caseId, r.casePackVersion, r.queueNumber, r.patientName, r.sex, r.birthDate, r.chiefComplaint, r.registeredAt, r.visitKind,
      )
    }
  }

  listQueue(): GoldenCaseQueueEntry[] {
    const rows = this.sql
      .exec<GoldenCaseRow>(
        `SELECT case_id, queue_number, patient_name, sex, birth_date, chief_complaint, registered_at, visit_kind
         FROM golden_case ORDER BY queue_number`,
      )
      .toArray()
    return rows.map((row) => ({
      caseId: row.case_id,
      queueNumber: row.queue_number,
      patientName: row.patient_name,
      sex: row.sex,
      age: ageOn(row.birth_date, row.registered_at),
      chiefComplaint: row.chief_complaint,
      registeredAt: row.registered_at,
      visitKind: row.visit_kind,
      // No Encounter exists yet in this slice, so every Golden Case is waiting.
      queueStatus: 'waiting',
    }))
  }
}

// Both inputs carry the clinic-local calendar date in their first ten characters.
function ageOn(birthDate: string, at: string): number {
  const [by, bm, bd] = birthDate.slice(0, 10).split('-').map(Number)
  const [y, m, d] = at.slice(0, 10).split('-').map(Number)
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0)
}
