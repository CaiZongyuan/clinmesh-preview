import {
  NOTE_SECTION_NAME,
  NOTE_SECTIONS,
  REQUIRED_NOTE_SECTIONS,
  type ClinicalNoteView,
  type DraftAuthor,
  type NoteSection,
  type NoteSections,
} from '../shared/clinical-note'
import type { EncounterError } from '../shared/encounter'
import type { EncounterRepository } from './encounter-repository'

type SectionRow = {
  section: NoteSection
  content: string
  last_edited_by: DraftAuthor
  updated_at: string
}

type RevisionRow = {
  revision_id: string
  version: number
  seq: number
  content: string
  practitioner_id: string
  signed_at: string
}

export type ClinicalNoteResult = { ok: true; note: ClinicalNoteView } | { ok: false; error: EncounterError }

// Callers run each command inside one storage transaction, so a refused command writes nothing.
export class ClinicalNoteRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly encounters: EncounterRepository,
  ) {}

  view(encounterId: string): ClinicalNoteResult {
    const found = this.encounters.get(encounterId)
    return found.ok ? { ok: true, note: this.read(encounterId) } : found
  }

  // Writes only the sections whose text changed, so each section keeps who last actually changed it.
  saveDraft(encounterId: string, sections: Partial<NoteSections>, author: DraftAuthor, now: string): ClinicalNoteResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const current = new Map(this.sectionRows(encounterId).map((row) => [row.section, row.content]))
    for (const section of NOTE_SECTIONS) {
      const content = sections[section]
      if (content === undefined || content === (current.get(section) ?? '')) continue
      this.sql.exec(
        `INSERT INTO clinical_note_section (encounter_id, section, content, last_edited_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (encounter_id, section) DO UPDATE
         SET content = excluded.content, last_edited_by = excluded.last_edited_by, updated_at = excluded.updated_at`,
        encounterId, section, content, author, now,
      )
    }
    return { ok: true, note: this.read(encounterId) }
  }

  // Records exactly the content the doctor confirmed as the next immutable revision.
  sign(encounterId: string, sections: NoteSections, practitionerId: string, now: string): ClinicalNoteResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const blank = REQUIRED_NOTE_SECTIONS.filter((section) => !sections[section].trim())
    if (blank.length > 0) {
      return {
        ok: false,
        error: {
          code: 'clinical-note-incomplete',
          message: `签署前请填写必填项：${blank.map((section) => NOTE_SECTION_NAME[section]).join('、')}。`,
        },
      }
    }
    const revisionId = crypto.randomUUID()
    const version =
      this.sql.exec<{ version: number }>('SELECT count(*) AS version FROM clinical_note_revision WHERE encounter_id = ?', encounterId).one()
        .version + 1
    const content = Object.fromEntries(NOTE_SECTIONS.map((section) => [section, sections[section]]))
    this.sql.exec(
      `INSERT INTO clinical_note_revision (revision_id, encounter_id, version, seq, content, practitioner_id, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      revisionId, encounterId, version, this.encounters.nextRevisionSeq(encounterId), JSON.stringify(content), practitionerId, now,
    )
    this.encounters.audit(encounterId, 'clinical-note-signed', practitionerId, now, revisionId)
    return { ok: true, note: this.read(encounterId) }
  }

  private read(encounterId: string): ClinicalNoteView {
    const rows = new Map(this.sectionRows(encounterId).map((row) => [row.section, row]))
    const revisions = this.sql
      .exec<RevisionRow>(
        `SELECT revision_id, version, seq, content, practitioner_id, signed_at
         FROM clinical_note_revision WHERE encounter_id = ? ORDER BY version`,
        encounterId,
      )
      .toArray()
    return {
      draft: NOTE_SECTIONS.map((section) => {
        const row = rows.get(section)
        return {
          section,
          content: row?.content ?? '',
          lastEditedBy: row?.last_edited_by ?? null,
          updatedAt: row?.updated_at ?? null,
        }
      }),
      revisions: revisions.map((row) => ({
        revisionId: row.revision_id,
        version: row.version,
        seq: row.seq,
        sections: JSON.parse(row.content) as NoteSections,
        practitionerId: row.practitioner_id,
        signedAt: row.signed_at,
      })),
    }
  }

  private sectionRows(encounterId: string): SectionRow[] {
    return this.sql
      .exec<SectionRow>('SELECT section, content, last_edited_by, updated_at FROM clinical_note_section WHERE encounter_id = ?', encounterId)
      .toArray()
  }
}
