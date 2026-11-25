import { Toast, ToastAction, ToastRegion, ToastTitle, createToaster } from '@ui-sdk/react/toast'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { MAX_NOTE_SECTION_LENGTH, NOTE_SECTION_NAME, type NoteSection } from '../../../shared/clinical-note'
import type { EncounterView } from '../../../shared/encounter'
import { useNoteBridge } from '../../copilot/use-note-bridge'
import type { NoteSuggestion } from './note-suggestions'
import { useClinicalNote, type ClinicalNote } from './use-clinical-note'

interface ClinicalNoteContextValue {
  note: ClinicalNote
  writable: boolean
  suggestions: NoteSuggestion[]
  suggest(section: NoteSection, text: string): void
  acceptSuggestion(suggestion: NoteSuggestion): void
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
  const [suggestions, setSuggestions] = useState<NoteSuggestion[]>([])
  const recordSuggestion = useNoteBridge(writable ? encounter.encounterId : null)
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

  const dismissSuggestion = (id: string) => setSuggestions((list) => list.filter((item) => item.id !== id))
  const suggest = (section: NoteSection, text: string) => {
    const id = crypto.randomUUID()
    setSuggestions((list) => [...list, { id, section, text }])
    recordSuggestion(id)
  }
  const acceptSuggestion = (suggestion: NoteSuggestion) => {
    if (!writable) return
    const { id, section, text } = suggestion
    const before = note.contentOf(section)
    note.edit(section, text)
    dismissSuggestion(id)
    toaster.dismiss()
    toaster(`已采纳「${NOTE_SECTION_NAME[section]}」建议`, { action: {
      label: '撤销采纳',
      onAction: () => {
        if (note.contentOf(section) !== text) return
        note.edit(section, before)
        setSuggestions((list) => [...list, suggestion])
      },
    } })
  }
  const value = { note, writable, quote, suggestions, suggest, dismissSuggestion, acceptSuggestion }
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
