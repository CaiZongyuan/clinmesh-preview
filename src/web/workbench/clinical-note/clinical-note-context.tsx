import { Toast, ToastAction, ToastRegion, ToastTitle, createToaster } from '@ui-sdk/react/toast'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_NOTE_SECTION_LENGTH, NOTE_SECTION_NAME, type NoteSection } from '../../../shared/clinical-note'
import type { EncounterView } from '../../../shared/encounter'
import { useNoteBridge } from '../../copilot/use-note-bridge'
import {
  DRAFT_MODULE_LABEL, EMPTY_DRAFT_ASSISTANCE, type DraftAction, type DraftAssistance,
  type DraftAssistanceCommand, type DraftChange, type DraftSuggestion,
} from '../../../shared/draft-assistance'
import { fetchDraftAssistance, updateDraftAssistance } from '../../api'
import { useClinicalNote, type ClinicalNote } from './use-clinical-note'

interface ClinicalNoteContextValue {
  note: ClinicalNote
  writable: boolean
  assistance: DraftAssistance
  changes: Partial<Record<DraftAction['module'], DraftChange>>
  pending: boolean
  assistanceLoaded: boolean
  refreshAssistance(): Promise<void>
  propose(action: DraftAction, protect?: boolean): void
  acceptSuggestion(suggestion: DraftSuggestion): void
  dismissSuggestion(id: string): void
  // Quotes words from the Consultation into a section, with a toast that offers undo.
  quote(section: NoteSection, text: string): void
}

const ClinicalNoteContext = createContext<ClinicalNoteContextValue | null>(null)

export const useClinicalNoteContext = () => useContext(ClinicalNoteContext)

// The Clinical Note lives above the workbench columns: the case workspace edits it and the Consultation quotes into it.
export function ClinicalNoteProvider({ encounter, children }: { encounter: EncounterView | null; children: ReactNode }) {
  const note = useClinicalNote(encounter)
  const writable = encounter?.status === 'active' && note.loaded
  const [assistance, setAssistance] = useState(EMPTY_DRAFT_ASSISTANCE)
  const [changes, setChanges] = useState<Partial<Record<DraftAction['module'], DraftChange>>>({})
  const [assistanceLoaded, setAssistanceLoaded] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const mutations = useRef(Promise.resolve<unknown>(undefined))
  const recordProposal = useNoteBridge(writable && assistanceLoaded ? encounter.encounterId : null)
  useEffect(() => {
    if (!encounter?.encounterId) return
    let active = true
    fetchDraftAssistance(encounter.encounterId).then((result) => {
      if (!active) return
      setAssistance(result)
      setAssistanceLoaded(true)
    }).catch(() => {
      if (active) setAssistanceLoaded(true)
    })
    return () => { active = false }
  }, [encounter?.encounterId])
  const [toaster] = useState(() => createToaster())
  useEffect(() => () => void toaster.dismiss(), [toaster])

  const quote = (section: NoteSection, text: string) => {
    toaster.dismiss()
    const undo = note.append(section, text)
    if (!undo) {
      toaster.error(`「${NOTE_SECTION_NAME[section]}」引用后将超过 ${MAX_NOTE_SECTION_LENGTH} 字，未引用`)
      return
    }
    toaster(`已引用到「${NOTE_SECTION_NAME[section]}」`, { action: { label: '撤销引用', onAction: undo } })
  }

  const mutate = (command: DraftAssistanceCommand, action?: DraftAction, signal?: AbortSignal) => {
    const section = action?.module === 'note' ? action.section : undefined
    const original = section ? note.contentOf(section) : undefined
    setPendingCount((count) => count + 1)
    const current = mutations.current.then(async () => {
      if (!encounter || encounter.status !== 'active') throw new Error('该就诊已结束。')
      signal?.throwIfAborted()
      const response = await updateDraftAssistance(encounter.encounterId, command)
      setAssistance(response.assistance)
      const change = response.change
      if (change?.module === 'note' && section && original === note.contentOf(section)) {
        note.receiveDraft(section, change.note)
      } else if (change && change.module !== 'note') {
        setChanges((previous) => ({ ...previous, [change.module]: change }))
      }
      return response
    })
    mutations.current = current.catch(() => {})
    return current.finally(() => setPendingCount((count) => count - 1))
  }

  const refreshAssistance = () => {
    if (!encounter) return Promise.resolve()
    const refreshed = mutations.current.then(async () => {
      setAssistance(await fetchDraftAssistance(encounter.encounterId))
    })
    mutations.current = refreshed.catch(() => {})
    return refreshed
  }

  const propose = (action: DraftAction, protect = false) => {
    const focusedModule = document.activeElement?.closest('[data-draft-module]')?.getAttribute('data-draft-module')
    const id = crypto.randomUUID()
    void recordProposal(async (runId, signal) => ({
      id,
      response: await mutate({ command: 'propose', id, runId, action, protect: protect || focusedModule === action.module }, action, signal),
    })).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) toaster.error(error instanceof Error ? error.message : '草稿建议保存失败。')
    })
  }

  const dismissSuggestion = (id: string) => {
    void mutate({ command: 'dismiss', id }).catch(() => toaster.error('建议处理失败。'))
  }

  const acceptSuggestion = (suggestion: DraftSuggestion) => {
    if (!writable) return
    const { id, action } = suggestion
    const name = action.module === 'note' ? NOTE_SECTION_NAME[action.section] : DRAFT_MODULE_LABEL[action.module]
    const accept = async () => {
      if (action.module === 'note' && !(await note.flushDraft())) throw new Error('先保存医生的病历草稿。')
      await mutate({ command: 'accept', id }, action)
    }
    void accept().then(() => {
      toaster.dismiss()
      toaster(`已采纳「${name}」建议`, { action: {
        label: '撤销采纳',
        onAction: () => void mutate({ command: 'undo', id }, action).catch(() => toaster.error('草稿后来已修改，无法撤销。')),
      } })
    }).catch((error: unknown) => toaster.error(error instanceof Error ? error.message : '建议处理失败。'))
  }
  const value = { note, writable, quote, assistance, changes, pending: pendingCount > 0, assistanceLoaded, refreshAssistance, propose, dismissSuggestion, acceptSuggestion }
  return (
    <ClinicalNoteContext.Provider value={value}>
      {children}
      <ToastRegion toaster={toaster} side="top" align="center" aria-label="通知">
        {() => (
          <Toast className="flex items-center gap-3 text-[13px] data-[type=error]:text-destructive">
            <ToastTitle />
            <ToastAction className="h-7 px-2.5 text-xs" />
          </Toast>
        )}
      </ToastRegion>
    </ClinicalNoteContext.Provider>
  )
}
