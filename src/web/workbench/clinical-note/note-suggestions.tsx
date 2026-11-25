import { Button } from '@ui-sdk/react/button'
import { NOTE_SECTION_NAME, type NoteSection } from '../../../shared/clinical-note'
import { useClinicalNoteContext } from './clinical-note-context'

export interface NoteSuggestion {
  id: string
  runId?: string
  section: NoteSection
  text: string
}

export function NoteSuggestions({ section, runId }: { section?: NoteSection; runId?: string }) {
  const context = useClinicalNoteContext()
  if (!context?.writable) return null
  const suggestions = context.suggestions.filter((suggestion) => section === undefined ? suggestion.runId === runId : suggestion.section === section)
  return suggestions.map((suggestion) => (
    <section key={suggestion.id} aria-label={`${section ? '字段' : '会话'}建议：${NOTE_SECTION_NAME[suggestion.section]}`}
      className="grid gap-1.5 rounded-md border border-dashed border-info/55 bg-info/5 p-2 text-xs">
      <strong className="text-info">{section ? '临床助手建议' : `待确认 · ${NOTE_SECTION_NAME[suggestion.section]}`}</strong>
      <p className="m-0 break-words whitespace-pre-wrap">{suggestion.text}</p>
      <div className="flex justify-end gap-1.5">
        <Button className="h-7 px-2 text-xs" onClick={() => context.dismissSuggestion(suggestion.id)}>不采用</Button>
        <Button data-variant="solid" className="h-7 px-2 text-xs" onClick={() => context.acceptSuggestion(suggestion)}>采纳</Button>
      </div>
    </section>
  ))
}
