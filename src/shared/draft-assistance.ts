import { isNoteSection, MAX_NOTE_SECTION_LENGTH, type ClinicalNoteView, type NoteSection } from './clinical-note'
import type { ClinicalDrafts } from './completion'
import type { DiagnosisView } from './diagnosis'

export const DRAFT_MODULES = ['investigations', 'diagnosis', 'prescriptions'] as const
export type DraftModule = typeof DRAFT_MODULES[number]

export const DRAFT_MODULE_LABEL: Record<DraftModule, string> = {
  investigations: '检验检查',
  diagnosis: '诊断',
  prescriptions: '处方',
}

export type DraftAction =
  | { module: 'note'; section: NoteSection; text: string }
  | { module: DraftModule; itemId: string }

export interface DraftSuggestion {
  id: string
  runId: string | null
  action: DraftAction
  label: string
}

export interface DraftAssistance {
  suggestions: DraftSuggestion[]
  touched: DraftModule[]
  assistantItems: Record<DraftModule, string[]>
}

export const EMPTY_DRAFT_ASSISTANCE: DraftAssistance = {
  suggestions: [],
  touched: [],
  assistantItems: { investigations: [], diagnosis: [], prescriptions: [] },
}

export type DraftAssistanceCommand =
  | { command: 'propose'; id: string; runId: string | null; protect: boolean; action: DraftAction }
  | { command: 'accept' | 'dismiss' | 'undo'; id: string }

export type DraftChange =
  | { module: 'note'; note: ClinicalNoteView }
  | { module: 'diagnosis'; diagnosis: DiagnosisView }
  | { module: 'investigations' | 'prescriptions'; drafts: ClinicalDrafts }

export interface DraftAssistanceResponse {
  assistance: DraftAssistance
  outcome: 'applied' | 'suggestion' | 'unchanged'
  change?: DraftChange
}

export function parseDraftAssistanceCommand(body: unknown): DraftAssistanceCommand | null {
  if (!body || typeof body !== 'object') return null
  const { command, id, runId, protect, action } = body as Record<string, unknown>
  if (typeof id !== 'string' || !id || id.length > 100) return null
  if (command === 'accept' || command === 'dismiss' || command === 'undo') return { command, id }
  if (command !== 'propose' || (runId !== null && (typeof runId !== 'string' || !runId || runId.length > 100)) ||
      typeof protect !== 'boolean' || !action || typeof action !== 'object') return null
  const { module, section, text, itemId } = action as Record<string, unknown>
  if (module === 'note' && isNoteSection(section) && typeof text === 'string' && text.length <= MAX_NOTE_SECTION_LENGTH) {
    return { command, id, runId, protect, action: { module, section, text } }
  }
  if (module === 'investigations' || module === 'diagnosis' || module === 'prescriptions') {
    if (typeof itemId === 'string' && itemId.length > 0 && itemId.length <= 100) {
      return { command, id, runId, protect, action: { module, itemId } }
    }
  }
  return null
}
