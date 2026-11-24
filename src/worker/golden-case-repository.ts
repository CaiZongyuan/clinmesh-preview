import type { GoldenCaseQueueEntry, Sex, VisitKind } from '../shared/golden-case-queue'
import { ageOn, type GoldenCaseRegistration } from './golden-case-pack'

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

type QueueRow = GoldenCaseRow & { in_encounter: number }

export class GoldenCaseRepository {
  constructor(private readonly sql: SqlStorage) {}

  // Makes the table match the pinned case pack exactly. Callers run it inside one storage transaction.
  reconcile(registrations: readonly GoldenCaseRegistration[]): void {
    const ids = registrations.map((r) => r.caseId)
    this.sql.exec(`DELETE FROM golden_case WHERE case_id NOT IN (${ids.map(() => '?').join(', ')})`, ...ids)
    for (const r of registrations) {
      this.sql.exec(
        `INSERT INTO golden_case (case_id, queue_number, patient_name, sex, birth_date, chief_complaint, registered_at, visit_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (case_id) DO UPDATE SET
           queue_number = excluded.queue_number,
           patient_name = excluded.patient_name,
           sex = excluded.sex,
           birth_date = excluded.birth_date,
           chief_complaint = excluded.chief_complaint,
           registered_at = excluded.registered_at,
           visit_kind = excluded.visit_kind`,
        r.caseId, r.queueNumber, r.patientName, r.sex, r.birthDate, r.chiefComplaint, r.registeredAt, r.visitKind,
      )
    }
  }

  listQueue(): GoldenCaseQueueEntry[] {
    const rows = this.sql
      .exec<QueueRow>(
        `SELECT case_id, queue_number, patient_name, sex, birth_date, chief_complaint, registered_at, visit_kind,
           EXISTS (SELECT 1 FROM encounter WHERE encounter.case_id = golden_case.case_id AND status = 'active') AS in_encounter
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
      // An abandoned Encounter is not a completed one, so its Golden Case waits to be started afresh.
      queueStatus: row.in_encounter ? 'in-encounter' : 'waiting',
    }))
  }
}
