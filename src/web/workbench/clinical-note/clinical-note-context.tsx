import { Toast, ToastAction, ToastRegion, ToastTitle, createToaster } from '@ui-sdk/react/toast'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { MAX_NOTE_SECTION_LENGTH, NOTE_SECTION_NAME, type NoteSection } from '../../../shared/clinical-note'
import type { EncounterView } from '../../../shared/encounter'
import { useClinicalNote, type ClinicalNote } from './use-clinical-note'

interface ClinicalNoteContextValue {
  note: ClinicalNote
  writable: boolean
  // Quotes words from the Consultation into a section, with a toast that offers undo.
  quote(section: NoteSection, text: string): void
}

const ClinicalNoteContext = createContext<ClinicalNoteContextValue | null>(null)

export const useClinicalNoteContext = () => useContext(ClinicalNoteContext)

// The Clinical Note lives above the workbench columns: the case workspace edits it and the Consultation quotes into it.
export function ClinicalNoteProvider({ encounter, children }: { encounter: EncounterView | null; children: ReactNode }) {
  const note = useClinicalNote(encounter)
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

  const value = { note, writable: encounter?.status === 'active' && note.loaded, quote }
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
