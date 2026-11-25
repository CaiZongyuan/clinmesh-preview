import { Button } from '@ui-sdk/react/button'
import type { NoteSection } from '../../../shared/clinical-note'
import { DRAFT_MODULE_LABEL, type DraftModule } from '../../../shared/draft-assistance'
import { useClinicalNoteContext } from './clinical-note-context'

export function NoteSuggestions({ section, module, runId }: { section?: NoteSection; module?: DraftModule; runId?: string }) {
  const context = useClinicalNoteContext()
  if (!context?.writable) return null
  const suggestions = context.assistance.suggestions.filter(({ action, runId: origin }) => {
    if (section !== undefined) return action.module === 'note' && action.section === section
    if (module !== undefined) return action.module === module
    return (origin ?? undefined) === runId
  })
  return suggestions.map((suggestion) => {
    const place = section || module ? '字段' : '会话'
    const number = context.assistance.suggestions.indexOf(suggestion) + 1
    const label = `${place}建议 ${number} · ${suggestion.label}`
    return (
      <section
        key={suggestion.id}
        aria-label={`${section || module ? '字段' : '会话'}建议：${suggestion.label}`}
        className="grid gap-1.5 rounded-md border border-dashed border-info/55 bg-info/5 p-2 text-xs"
      >
        <strong className="text-info">
          {section ? '临床助手建议' : `待确认 · ${suggestion.action.module === 'note' ? suggestion.label : DRAFT_MODULE_LABEL[suggestion.action.module]}`}
        </strong>
        <p className="m-0 break-words whitespace-pre-wrap">{suggestion.action.module === 'note' ? suggestion.action.text : suggestion.label}</p>
        <div className="flex justify-end gap-1.5">
          <Button aria-label={`不采用${label}`} className="h-7 px-2 text-xs" onClick={() => context.dismissSuggestion(suggestion.id)}>不采用</Button>
          <Button aria-label={`采纳${label}`} data-variant="solid" className="h-7 px-2 text-xs" onClick={() => context.acceptSuggestion(suggestion)}>采纳</Button>
        </div>
      </section>
    )
  })
}
