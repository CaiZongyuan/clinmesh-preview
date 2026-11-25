import { Preferences } from '@ui-sdk/react/preferences'
import { useEffect, useRef, useState, type Ref } from 'react'
import type { CaseDebrief } from '../../shared/completion'
import type { EncounterView } from '../../shared/encounter'
import type { GoldenCaseQueueEntry } from '../../shared/golden-case-queue'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { useCopilot, type CopilotSession } from '../copilot/use-copilot'
import { CaseWorkspace } from './case-workspace'
import { ClinicalNoteProvider, useClinicalNoteContext } from './clinical-note/clinical-note-context'
import { CLINIC_DEPARTMENT, QueueRail } from './queue-rail'
import { WorkbenchColumns } from './workbench-columns'
import { WorkbenchAppearance, workbenchPreferences } from './workbench-preferences'

export type CaseFocus =
  | { kind: 'none' }
  | { kind: 'registration'; entry: GoldenCaseQueueEntry }
  | { kind: 'encounter'; encounter: EncounterView; examinations: PhysicalExaminationView[]; debrief?: CaseDebrief }

const HIDDEN_KEY = 'clinmesh.copilot.hidden'

// One screen of the workbench: it owns the Copilot session (per Encounter) and whether the panel is
// hidden. Hiding is remembered in localStorage; private browsing that blocks storage just forgets it.
export function Workbench({ queue, focus }: { queue: GoldenCaseQueueEntry[]; focus: CaseFocus }) {
  const copilotButton = useRef<HTMLButtonElement>(null)
  const encounter = focus.kind === 'encounter' ? focus.encounter : undefined
  const [copilotHidden, setCopilotHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      if (copilotHidden) localStorage.setItem(HIDDEN_KEY, '1')
      else localStorage.removeItem(HIDDEN_KEY)
    } catch {}
  }, [copilotHidden])
  const copilot = useCopilot(encounter?.encounterId ?? null, encounter?.status, copilotHidden)
  const focusedCaseId =
    focus.kind === 'encounter' ? focus.encounter.caseId : focus.kind === 'registration' ? focus.entry.caseId : undefined
  return (
    <ClinicalNoteProvider key={encounter?.encounterId ?? 'registration'} encounter={encounter ?? null}>
      <Preferences preferences={workbenchPreferences}>
        <div className="workbench-shell flex h-full flex-col">
          <header className="flex h-12 flex-none items-center gap-3 bg-card px-4 shadow-[inset_0_-1px_0_var(--border)]">
            <span
              aria-hidden="true"
              className="grid size-[22px] place-items-center rounded-[5px] bg-primary text-[15px] font-bold text-primary-foreground"
            >
              C
            </span>
            <h1 className="m-0 text-[15px] font-semibold whitespace-nowrap">ClinMesh 门诊工作台</h1>
            <span className="truncate text-xs text-muted-foreground">{CLINIC_DEPARTMENT}</span>
            <CopilotTopBar copilot={copilot} hidden={copilotHidden} buttonRef={copilotButton} onShow={() => setCopilotHidden(false)} />
            <WorkbenchAppearance />
          </header>
          <div className="workbench-body flex min-h-0 flex-1 gap-2 py-3 pr-4 pl-3">
            <QueueRail queue={queue} focusedCaseId={focusedCaseId} />
              <WorkbenchColumns
                caseWorkspace={<CaseWorkspace focus={focus} />}
                encounter={focus.kind === 'encounter' ? focus : undefined}
                copilot={copilot}
                copilotHidden={copilotHidden}
                examinations={focus.kind === 'encounter' ? focus.examinations : []}
                onHideCopilot={() => {
                  setCopilotHidden(true)
                  copilotButton.current?.focus()
                }}
              />
          </div>
        </div>
      </Preferences>
    </ClinicalNoteProvider>
  )
}

function CopilotTopBar({ copilot, hidden, buttonRef, onShow }: {
  copilot: CopilotSession; hidden: boolean; buttonRef: Ref<HTMLButtonElement>; onShow: () => void
}) {
  const note = useClinicalNoteContext()
  const pending = note?.writable ? note.assistance.suggestions.length : 0
  return (
        <button
          ref={buttonRef}
          type="button"
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          onClick={() => onShow()}
        >
          <span aria-hidden="true">✦</span>
          <span>临床助手{copilot.busy ? ' · 运行中' : ''}{copilot.countdown ? ' · 倒计时' : ''}{pending ? ` · ${pending} 项待确认` : ''}</span>
          {hidden && copilot.unread > 0 && (
            <span className="inline-flex size-4 items-center justify-center rounded-full bg-info text-[10px] font-semibold text-info-foreground">
              {copilot.unread > 99 ? '99+' : copilot.unread}
            </span>
          )}
          <span className="sr-only">{hidden ? '显示临床助手面板' : '临床助手面板已显示'}</span>
        </button>
  )
}
