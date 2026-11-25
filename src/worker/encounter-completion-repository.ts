import type { CaseDebriefReference, ClinicalDrafts, PrescriptionDraftLine } from '../shared/completion'
import type { PrescriptionLineRequest } from '../shared/medication'

type DraftKind = keyof ClinicalDrafts

export class EncounterCompletionRepository {
  constructor(private readonly sql: SqlStorage) {}

  drafts(encounterId: string): ClinicalDrafts {
    return {
      investigations: this.draft(encounterId, 'investigations'),
      prescriptions: this.draft(encounterId, 'prescriptions'),
    }
  }

  draft<K extends DraftKind>(encounterId: string, kind: K): ClinicalDrafts[K] {
    const row = this.sql.exec<{ entries: string }>(
      'SELECT entries FROM encounter_draft WHERE encounter_id = ? AND kind = ?', encounterId, kind,
    ).toArray()[0]
    return row ? JSON.parse(row.entries) as ClinicalDrafts[K] : []
  }

  saveDraft<K extends DraftKind>(encounterId: string, kind: K, entries: ClinicalDrafts[K]): void {
    if (entries.length === 0) {
      this.sql.exec('DELETE FROM encounter_draft WHERE encounter_id = ? AND kind = ?', encounterId, kind)
      return
    }
    this.sql.exec(
      `INSERT INTO encounter_draft (encounter_id, kind, entries) VALUES (?, ?, ?)
       ON CONFLICT (encounter_id, kind) DO UPDATE SET entries = excluded.entries`,
      encounterId, kind, JSON.stringify(entries),
    )
  }

  issuedInvestigations(encounterId: string, catalogItemIds: string[]): void {
    const pending = this.draft(encounterId, 'investigations')
    if (pending.length) this.saveDraft(encounterId, 'investigations', pending.filter((id) => !catalogItemIds.includes(id)))
  }

  issuedPrescriptions(encounterId: string, lines: PrescriptionLineRequest[]): void {
    const pending = this.draft(encounterId, 'prescriptions')
    if (pending.length) this.saveDraft(encounterId, 'prescriptions', pending.filter((draft) => !lines.some((line) => sameLine(draft, line))))
  }

  recordDebrief(encounterId: string, reference: CaseDebriefReference): void {
    this.sql.exec('INSERT INTO case_debrief_reference (encounter_id, reference) VALUES (?, ?)', encounterId, JSON.stringify(reference))
  }

  reference(encounterId: string): CaseDebriefReference | undefined {
    const row = this.sql.exec<{ reference: string }>(
      'SELECT reference FROM case_debrief_reference WHERE encounter_id = ?', encounterId,
    ).toArray()[0]
    return row && JSON.parse(row.reference) as CaseDebriefReference
  }
}

function sameLine(a: PrescriptionDraftLine, b: PrescriptionLineRequest) {
  return a.drugId === b.drugId && a.dose === b.dose && a.route === b.route && a.frequency === b.frequency && a.days === b.days
}
