import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from '@ui-sdk/react/menu'
import { QuoteIcon } from 'lucide-react'
import { NOTE_SECTION_NAME, NOTE_SECTIONS, isNoteSection } from '../../../shared/clinical-note'
import { iconButton } from '../pane-styles'
import { useClinicalNoteContext } from './clinical-note-context'

// Quotes one Consultation entry into a Clinical Note section the doctor picks. Hidden once the note can't be edited.
export function QuoteMenu({ label, text }: { label: string; text: string }) {
  const context = useClinicalNoteContext()
  if (!context?.writable) return null
  return (
    <Menu onAction={(section) => isNoteSection(section) && context.quote(section, text)}>
      <MenuTrigger aria-label={label} title="引用到病历" className={`${iconButton} size-6 bg-card`}>
        <QuoteIcon aria-hidden="true" size={12} />
      </MenuTrigger>
      <MenuContent className="min-w-40 text-[13px]">
        <MenuGroup>
          <MenuGroupLabel className="px-2 py-1 text-[11px] text-muted-foreground">引用原话到病历</MenuGroupLabel>
          {NOTE_SECTIONS.map((section) => (
            <MenuItem key={section} value={section}>
              {NOTE_SECTION_NAME[section]}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  )
}

export const quotedTurn = (speaker: 'doctor' | 'patient', text: string) =>
  speaker === 'patient' ? `患者述：“${text}”` : `医生问：“${text}”`
