import { NOTE_SECTION_NAME, type ClinicalNoteView } from '../../src/shared/clinical-note'
import type { ClinicalDrafts } from '../../src/shared/completion'
import { ICD_CATALOG, type DiagnosisView } from '../../src/shared/diagnosis'
import { EMPTY_DRAFT_ASSISTANCE, parseDraftAssistanceCommand } from '../../src/shared/draft-assistance'
import type {
  DraftAction, DraftAssistance, DraftAssistanceResponse, DraftChange, DraftModule, DraftSuggestion,
} from '../../src/shared/draft-assistance'
import type { EncounterView } from '../../src/shared/encounter'
import { fakeCatalog } from './fake-investigations'
import { fakeMedicationCatalog } from './fake-prescriptions'

interface FakeDrafts {
  note(id: string): ClinicalNoteView
  diagnosis(id: string): DiagnosisView
  drafts(id: string): ClinicalDrafts
  saveDrafts(id: string, drafts: ClinicalDrafts): void
}

export function createFakeDraftAssistance(workspace: FakeDrafts) {
  const states = new Map<string, DraftAssistance>()
  const undo = new Map<string, { suggestion: DraftSuggestion; priorNote: string | null }>()
  const view = (id: string) => states.get(id) ?? states.set(id, structuredClone(EMPTY_DRAFT_ASSISTANCE)).get(id)!
  const touch = (id: string, module: DraftModule) => {
    const state = view(id)
    if (!state.touched.includes(module)) state.touched.push(module)
  }

  function apply(id: string, action: DraftAction, source: 'doctor' | 'assistant', inverse?: { priorNote: string | null }): DraftChange {
    if (action.module === 'note') {
      const note = workspace.note(id)
      const field = note.draft.find((item) => item.section === action.section)!
      field.content = inverse ? inverse.priorNote ?? '' : action.text
      field.lastEditedBy = source
      return { module: 'note', note }
    }
    if (action.module === 'diagnosis') {
      const diagnosis = workspace.diagnosis(id)
      diagnosis.draft = inverse
        ? diagnosis.draft.filter((item) => item.code !== action.itemId)
        : [...diagnosis.draft, { code: action.itemId, source, primary: diagnosis.draft.length === 0 }]
      return { module: 'diagnosis', diagnosis }
    }
    const drafts = workspace.drafts(id)
    if (action.module === 'investigations') {
      drafts.investigations = inverse ? drafts.investigations.filter((item) => item !== action.itemId) : [...drafts.investigations, action.itemId]
    } else {
      const drug = fakeMedicationCatalog.find((item) => item.id === action.itemId)!
      drafts.prescriptions = inverse
        ? drafts.prescriptions.filter((item) => item.drugId !== action.itemId)
        : [...drafts.prescriptions, { drugId: action.itemId, ...drug.defaults }]
    }
    workspace.saveDrafts(id, drafts)
    return { module: action.module, drafts }
  }

  function handle(method: string, encounter: EncounterView, body: unknown): Response {
    const id = encounter.encounterId
    const assistance = view(id)
    if (method === 'GET') return Response.json({ assistance })
    const reply = (outcome: DraftAssistanceResponse['outcome'], change?: DraftChange) => Response.json({ assistance, outcome, change })
    const command = parseDraftAssistanceCommand(body)
    if (!command || encounter.status !== 'active') return new Response(null, { status: 409 })
    if (command.command === 'propose') {
      const { action } = command
      let label: string | undefined
      if (action.module === 'note') label = NOTE_SECTION_NAME[action.section]
      else if (action.module === 'diagnosis') label = ICD_CATALOG.find((item) => item.code === action.itemId)?.name
      else if (action.module === 'investigations') label = fakeCatalog.find((item) => item.id === action.itemId)?.name
      else label = fakeMedicationCatalog.find((item) => item.id === action.itemId)?.name
      if (!label) return new Response(null, { status: 400 })
      const protectedDraft = action.module === 'note'
        ? workspace.note(id).draft.find((item) => item.section === action.section)?.lastEditedBy === 'doctor'
        : assistance.touched.includes(action.module)
      if (command.protect || protectedDraft) {
        assistance.suggestions.push({ id: command.id, action, label, runId: command.runId })
        return reply('suggestion')
      }
      if (action.module !== 'note') assistance.assistantItems[action.module].push(action.itemId)
      return reply('applied', apply(id, action, 'assistant'))
    }
    const key = `${id}:${command.id}`
    if (command.command === 'undo') {
      const saved = undo.get(key)
      if (!saved) return new Response(null, { status: 404 })
      assistance.suggestions.push(saved.suggestion)
      return reply('suggestion', apply(id, saved.suggestion.action, 'doctor', { priorNote: saved.priorNote }))
    }
    const suggestion = assistance.suggestions.find((record) => record.id === command.id)
    if (!suggestion) return reply('unchanged')
    assistance.suggestions = assistance.suggestions.filter((record) => record.id !== command.id)
    if (command.command === 'dismiss') return reply('unchanged')
    const action = suggestion.action
    const priorNote = action.module === 'note' ? workspace.note(id).draft.find((item) => item.section === action.section)?.content ?? '' : null
    undo.set(key, { suggestion, priorNote })
    return reply('applied', apply(id, action, 'doctor'))
  }

  return { handle, view, touch }
}
