import { NOTE_SECTION_NAME, type DraftAuthor } from '../shared/clinical-note'
import { ICD_CATALOG, MAX_DIAGNOSIS_ENTRIES } from '../shared/diagnosis'
import type {
  DraftAction, DraftAssistance, DraftAssistanceCommand, DraftAssistanceResponse,
  DraftChange, DraftModule, DraftSuggestion,
} from '../shared/draft-assistance'
import type { EncounterError, EncounterView } from '../shared/encounter'
import { allergyTagFor } from '../shared/medication'
import type { ClinicalNoteRepository } from './clinical-note-repository'
import type { DiagnosisRepository } from './diagnosis-repository'
import type { EncounterCompletionRepository } from './encounter-completion-repository'
import { catalogItem } from './investigation-catalog'
import { medication } from './medication-catalog'
import type { PrescriptionRepository } from './prescription-repository'

type Status = 'pending' | 'applied' | 'accepted' | 'dismissed'
type ProposalRow = { id: string; run_id: string | null; action_json: string; label: string; status: Status; undo_json: string | null; assistant_attribution: number }
type Undo = { note: string } | { entry: string }
type Refusal = { ok: false; error: EncounterError }
export type DraftAssistanceResult = { ok: true; result: DraftAssistanceResponse } | Refusal

const unavailable = (): Refusal => ({ ok: false, error: { code: 'invalid-request', message: '此草稿项目现已不可用。' } })

export class DraftAssistanceRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly drafts: EncounterCompletionRepository,
    private readonly diagnosis: DiagnosisRepository,
    private readonly note: ClinicalNoteRepository,
    private readonly prescriptions: PrescriptionRepository,
  ) {}

  pendingCount(encounterId: string): number {
    return this.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM copilot_draft_proposal WHERE encounter_id = ? AND status = 'pending'", encounterId,
    ).one().count
  }

  appliedCounts(encounterId: string): Record<string, number> {
    const rows = this.sql.exec<{ run_id: string; count: number }>(
      "SELECT run_id, count(*) AS count FROM copilot_draft_proposal WHERE encounter_id = ? AND run_id IS NOT NULL AND status = 'applied' GROUP BY run_id",
      encounterId,
    ).toArray()
    return Object.fromEntries(rows.map((row) => [row.run_id, row.count]))
  }

  stopRun(encounterId: string, runId: string): void {
    this.sql.exec('INSERT OR IGNORE INTO copilot_draft_stop (encounter_id, run_id) VALUES (?, ?)', encounterId, runId)
  }

  removeAttribution(encounterId: string, module: DraftModule, itemIds: string[]): void {
    if (!itemIds.length) return
    this.sql.exec(
      `UPDATE copilot_draft_proposal SET assistant_attribution = 0 WHERE encounter_id = ? AND assistant_attribution = 1
       AND json_extract(action_json, '$.module') = ? AND json_extract(action_json, '$.itemId') IN (SELECT value FROM json_each(?))`,
      encounterId, module, JSON.stringify(itemIds),
    )
  }

  touch(encounterId: string, module: DraftModule): void {
    this.sql.exec('INSERT OR IGNORE INTO doctor_draft_touch (encounter_id, module) VALUES (?, ?)', encounterId, module)
  }

  view(encounterId: string): DraftAssistance {
    const rows = this.sql.exec<ProposalRow>(
      "SELECT id, run_id, action_json, label, status, undo_json, assistant_attribution FROM copilot_draft_proposal WHERE encounter_id = ? AND (status = 'pending' OR assistant_attribution = 1) ORDER BY rowid",
      encounterId,
    ).toArray()
    const suggestions: DraftSuggestion[] = []
    const assistantItems: DraftAssistance['assistantItems'] = { investigations: [], diagnosis: [], prescriptions: [] }
    for (const row of rows) {
      const action = JSON.parse(row.action_json) as DraftAction
      if (row.status === 'pending') suggestions.push({ id: row.id, runId: row.run_id, action, label: row.label })
      else if (row.assistant_attribution && action.module !== 'note' && !assistantItems[action.module].includes(action.itemId)) assistantItems[action.module].push(action.itemId)
    }
    const touched = this.sql.exec<{ module: DraftModule }>('SELECT module FROM doctor_draft_touch WHERE encounter_id = ?', encounterId)
      .toArray().map((row) => row.module)
    return { suggestions, touched, assistantItems }
  }

  // Called inside the workspace transaction after requireActive.
  command(encounter: EncounterView, command: DraftAssistanceCommand): DraftAssistanceResult {
    const encounterId = encounter.encounterId
    const row = this.find(encounterId, command.id)
    if (command.command === 'propose') {
      if (command.runId !== null && this.sql.exec(
        'SELECT 1 FROM copilot_draft_stop WHERE encounter_id = ? AND run_id = ?', encounterId, command.runId,
      ).toArray().length) {
        return { ok: false, error: { code: 'copilot-run-stopped', message: '该轮临床助手已停止，未继续写入草稿。' } }
      }
      if (row) return this.response(encounterId, row.status === 'pending' ? 'suggestion' : 'unchanged')
      const { action } = command
      const label = this.label(action)
      if (!label) return unavailable()
      const protectedDraft = action.module === 'note'
        ? this.currentNote(encounterId, action.section)?.lastEditedBy === 'doctor'
        : this.doctorTouched(encounterId, action.module)
      if (command.protect || protectedDraft) {
        this.insert(encounterId, command, label, 'pending')
        return this.response(encounterId, 'suggestion')
      }
      const applied = this.apply(encounter, action, 'assistant')
      if ('error' in applied) return applied
      this.insert(encounterId, command, label, applied.change ? 'applied' : 'dismissed')
      return this.response(encounterId, applied.change ? 'applied' : 'unchanged', applied.change)
    }
    if (!row) return unavailable()
    const action = JSON.parse(row.action_json) as DraftAction
    if (command.command === 'undo') {
      if (row.status !== 'accepted') return this.response(encounterId, 'unchanged')
      const change = row.undo_json ? this.undo(encounterId, action, JSON.parse(row.undo_json) as Undo) : undefined
      if (row.undo_json && !change) return unavailable()
      this.setStatus(encounterId, row.id, 'pending')
      return this.response(encounterId, 'suggestion', change)
    }
    if (row.status !== 'pending') return this.response(encounterId, 'unchanged')
    if (command.command === 'dismiss') {
      this.setStatus(encounterId, row.id, 'dismissed')
      return this.response(encounterId, 'unchanged')
    }
    const applied = this.apply(encounter, action, 'doctor')
    if ('error' in applied) return applied
    if (action.module !== 'note') this.touch(encounterId, action.module)
    this.setStatus(encounterId, row.id, 'accepted', applied.undo)
    return this.response(encounterId, applied.change ? 'applied' : 'unchanged', applied.change)
  }

  private label(action: DraftAction): string | undefined {
    switch (action.module) {
      case 'note': return NOTE_SECTION_NAME[action.section]
      case 'investigations': return catalogItem(action.itemId)?.name
      case 'diagnosis': return ICD_CATALOG.find((item) => item.code === action.itemId)?.name
      case 'prescriptions': return medication(action.itemId)?.name
    }
  }

  private doctorTouched(encounterId: string, module: DraftModule): boolean {
    const assistance = this.view(encounterId)
    if (assistance.touched.includes(module)) return true
    if (module === 'diagnosis') {
      const view = this.diagnosis.view(encounterId)
      return view.ok && view.diagnosis.draft.some((entry) => entry.source === 'doctor')
    }
    const ids = module === 'investigations'
      ? this.drafts.draft(encounterId, module)
      : this.drafts.draft(encounterId, module).map((entry) => entry.drugId)
    return ids.some((id) => !assistance.assistantItems[module].includes(id))
  }

  private currentNote(encounterId: string, section: Extract<DraftAction, { module: 'note' }>['section']) {
    const result = this.note.view(encounterId)
    return result.ok ? result.note.draft.find((item) => item.section === section) : undefined
  }

  private apply(encounter: EncounterView, action: DraftAction, author: DraftAuthor): { change?: DraftChange; undo?: Undo } | Refusal {
    const id = encounter.encounterId
    const now = new Date().toISOString()
    if (action.module === 'note') {
      const previous = this.currentNote(id, action.section)?.content ?? ''
      if (previous === action.text) return {}
      const result = this.note.saveDraft(id, { [action.section]: action.text }, { [action.section]: author }, now)
      if (!result.ok) return result
      return { change: { module: 'note', note: result.note }, undo: { note: previous } }
    }
    if (action.module === 'diagnosis') {
      const result = this.diagnosis.view(id)
      if (!result.ok) return result
      const entries = result.diagnosis.draft
      if (entries.some((entry) => entry.code === action.itemId)) return {}
      if (entries.length >= MAX_DIAGNOSIS_ENTRIES) return unavailable()
      const entry = { code: action.itemId, primary: entries.length === 0, source: author }
      const saved = this.diagnosis.saveDraft(id, [...entries, entry], now)
      return saved.ok ? { change: { module: 'diagnosis', diagnosis: saved.diagnosis }, undo: { entry: JSON.stringify(entry) } } : saved
    }
    if (action.module === 'investigations') {
      const entries = this.drafts.draft(id, action.module)
      if (entries.includes(action.itemId)) return {}
      this.drafts.saveDraft(id, action.module, [...entries, action.itemId])
      return { change: { module: action.module, drafts: this.drafts.drafts(id) }, undo: { entry: action.itemId } }
    }
    const drug = medication(action.itemId)
    const prescription = this.prescriptions.view(id)
    if (!prescription.ok) return prescription
    const allergies = encounter.visibleSourceHistory.allergies.flatMap((allergy) => allergy.drugClass ? [allergy.drugClass] : [])
    if (!drug || prescription.prescriptions.noMedication || allergyTagFor(drug, allergies) === 'conflict') return unavailable()
    if (prescription.prescriptions.lines.some((line) => line.drugId === drug.id)) return {}
    const entries = this.drafts.draft(id, action.module)
    if (entries.some((entry) => entry.drugId === drug.id)) return {}
    const entry = { drugId: drug.id, ...drug.defaults }
    this.drafts.saveDraft(id, action.module, [...entries, entry])
    return { change: { module: action.module, drafts: this.drafts.drafts(id) }, undo: { entry: JSON.stringify(entry) } }
  }

  private undo(id: string, action: DraftAction, previous: Undo): DraftChange | undefined {
    const now = new Date().toISOString()
    if (action.module === 'note' && 'note' in previous) {
      if (this.currentNote(id, action.section)?.content !== action.text) return undefined
      const result = this.note.saveDraft(id, { [action.section]: previous.note }, {}, now)
      return result.ok ? { module: 'note', note: result.note } : undefined
    }
    if (!('entry' in previous) || action.module === 'note') return undefined
    if (action.module === 'diagnosis') {
      const result = this.diagnosis.view(id)
      if (!result.ok || !result.diagnosis.draft.some((entry) => JSON.stringify(entry) === previous.entry)) return undefined
      const remaining = result.diagnosis.draft.filter((entry) => entry.code !== action.itemId)
      const primary = remaining.find((entry) => entry.primary)?.code ?? remaining[0]?.code
      const saved = this.diagnosis.saveDraft(id, remaining.map((entry) => ({ ...entry, primary: entry.code === primary })), now)
      return saved.ok ? { module: 'diagnosis', diagnosis: saved.diagnosis } : undefined
    }
    if (action.module === 'investigations') {
      const entries = this.drafts.draft(id, action.module)
      if (!entries.includes(previous.entry)) return undefined
      this.drafts.saveDraft(id, action.module, entries.filter((entry) => entry !== previous.entry))
    } else {
      const entries = this.drafts.draft(id, action.module)
      if (!entries.some((entry) => JSON.stringify(entry) === previous.entry)) return undefined
      this.drafts.saveDraft(id, action.module, entries.filter((entry) => entry.drugId !== action.itemId))
    }
    return { module: action.module, drafts: this.drafts.drafts(id) }
  }

  private find(encounterId: string, id: string): ProposalRow | undefined {
    return this.sql.exec<ProposalRow>(
      'SELECT id, run_id, action_json, label, status, undo_json, assistant_attribution FROM copilot_draft_proposal WHERE encounter_id = ? AND id = ?',
      encounterId, id,
    ).toArray()[0]
  }

  private setStatus(encounterId: string, id: string, status: Status, undo?: Undo) {
    this.sql.exec('UPDATE copilot_draft_proposal SET status = ?, undo_json = ? WHERE encounter_id = ? AND id = ?',
      status, undo ? JSON.stringify(undo) : null, encounterId, id)
  }

  private insert(encounterId: string, c: Extract<DraftAssistanceCommand, { command: 'propose' }>, label: string, status: Status) {
    this.sql.exec(
      'INSERT INTO copilot_draft_proposal (encounter_id, id, run_id, action_json, label, status, assistant_attribution) VALUES (?, ?, ?, ?, ?, ?, ?)',
      encounterId, c.id, c.runId, JSON.stringify(c.action), label, status, status === 'applied' && c.action.module !== 'note' ? 1 : 0,
    )
  }

  private response(encounterId: string, outcome: DraftAssistanceResponse['outcome'], change?: DraftChange): DraftAssistanceResult {
    return { ok: true, result: { assistance: this.view(encounterId), outcome, change } }
  }
}
