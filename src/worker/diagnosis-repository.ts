import {
  MAX_DIAGNOSIS_ENTRIES,
  type DiagnosisDraftEntry,
  type DiagnosisEntry,
  type DiagnosisView,
  icdName,
  isIcdCode,
} from '../shared/diagnosis'
import type { EncounterError } from '../shared/encounter'
import type { EncounterRepository } from './encounter-repository'

type DraftRow = { entries: string; updated_at: string }
type RevisionRow = {
  revision_id: string
  version: number
  seq: number
  entries: string
  practitioner_id: string
  confirmed_at: string
}

export type DiagnosisResult = { ok: true; diagnosis: DiagnosisView } | { ok: false; error: EncounterError }

const refuse = (error: EncounterError) => ({ ok: false, error }) as const

const isSource = (value: unknown): value is DiagnosisDraftEntry['source'] =>
  value === 'doctor' || value === 'assistant'

// Entry list from a request body: valid codes, at most eight, no duplicates. Null when malformed.
export function diagnosisEntries(list: unknown): DiagnosisDraftEntry[] | null {
  if (!Array.isArray(list)) return null
  const entries: DiagnosisDraftEntry[] = []
  for (const item of list) {
    const { code, primary, source } = (item ?? {}) as Record<string, unknown>
    if (typeof code !== 'string' || typeof primary !== 'boolean' || !isSource(source)) return null
    entries.push({ code, primary, source })
  }
  if (entries.length > MAX_DIAGNOSIS_ENTRIES) return null
  if (entries.some((entry) => !isIcdCode(entry.code))) return null
  if (new Set(entries.map((entry) => entry.code)).size !== entries.length) return null
  return entries
}

// Callers run each command inside one storage transaction, so a refused command writes nothing.
export class DiagnosisRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly encounters: EncounterRepository,
  ) {}

  view(encounterId: string): DiagnosisResult {
    const found = this.encounters.get(encounterId)
    return found.ok ? { ok: true, diagnosis: this.read(encounterId) } : found
  }

  // Replaces the whole Draft: the table is small and the doctor edits it as one set.
  saveDraft(encounterId: string, entries: DiagnosisDraftEntry[], now: string): DiagnosisResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    if (entries.length > 0) {
      this.sql.exec(
        `INSERT INTO diagnosis_draft (encounter_id, entries, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (encounter_id) DO UPDATE SET entries = excluded.entries, updated_at = excluded.updated_at`,
        encounterId, JSON.stringify(entries), now,
      )
    } else {
      this.sql.exec('DELETE FROM diagnosis_draft WHERE encounter_id = ?', encounterId)
    }
    return { ok: true, diagnosis: this.read(encounterId) }
  }

  // Records exactly the entry set the doctor confirmed as the next immutable revision.
  confirm(encounterId: string, entries: DiagnosisDraftEntry[], practitionerId: string, now: string): DiagnosisResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    if (entries.length === 0 || entries.filter((entry) => entry.primary).length !== 1) {
      return refuse({
        code: 'diagnosis-needs-primary',
        message: `每次确认须恰有一项主诊断（当前 ${entries.filter((entry) => entry.primary).length} 项）。`,
      })
    }
    const revisionId = crypto.randomUUID()
    const version =
      this.sql.exec<{ version: number }>('SELECT count(*) AS version FROM diagnosis_revision WHERE encounter_id = ?', encounterId).one()
        .version + 1
    const named: DiagnosisEntry[] = entries.map((entry) => ({ ...entry, name: icdName(entry.code)! }))
    this.sql.exec(
      `INSERT INTO diagnosis_revision (revision_id, encounter_id, version, seq, entries, practitioner_id, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      revisionId, encounterId, version, this.encounters.nextRevisionSeq(encounterId), JSON.stringify(named), practitionerId, now,
    )
    // Confirming replaces the Draft: the confirmed set is now the formal Diagnosis, not a candidate list.
    this.sql.exec('DELETE FROM diagnosis_draft WHERE encounter_id = ?', encounterId)
    this.encounters.audit(encounterId, 'diagnosis-confirmed', practitionerId, now, revisionId)
    return { ok: true, diagnosis: this.read(encounterId) }
  }

  // Reopens a Draft from the latest revision, so the doctor edits what is actually on record.
  reopen(encounterId: string, now: string): DiagnosisResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const latest = this.revisionRows(encounterId).at(-1)
    if (!latest) {
      return refuse({ code: 'diagnosis-not-confirmed', message: '尚未确认诊断，没有可修改的已确认版本。' })
    }
    const entries: DiagnosisDraftEntry[] = (JSON.parse(latest.entries) as DiagnosisEntry[]).map(
      ({ code, primary, source }) => ({ code, primary, source }),
    )
    return this.saveDraft(encounterId, entries, now)
  }

  private read(encounterId: string): DiagnosisView {
    const draft = this.sql.exec<DraftRow>('SELECT entries, updated_at FROM diagnosis_draft WHERE encounter_id = ?', encounterId).toArray()[0]
    return {
      draft: draft ? (JSON.parse(draft.entries) as DiagnosisDraftEntry[]) : [],
      revisions: this.revisionRows(encounterId).map((row) => ({
        revisionId: row.revision_id,
        version: row.version,
        seq: row.seq,
        entries: JSON.parse(row.entries) as DiagnosisEntry[],
        practitionerId: row.practitioner_id,
        confirmedAt: row.confirmed_at,
      })),
    }
  }

  private revisionRows(encounterId: string): RevisionRow[] {
    return this.sql
      .exec<RevisionRow>(
        `SELECT revision_id, version, seq, entries, practitioner_id, confirmed_at
         FROM diagnosis_revision WHERE encounter_id = ? ORDER BY version`,
        encounterId,
      )
      .toArray()
  }
}
