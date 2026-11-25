import { useEffect, useState } from 'react'
import type { CaseDebrief } from '../../shared/completion'
import type { EncounterView } from '../../shared/encounter'
import type { GoldenCaseQueueEntry } from '../../shared/golden-case-queue'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { useCopilot } from '../copilot/use-copilot'
import { CaseWorkspace } from './case-workspace'
import { ClinicalNoteProvider } from './clinical-note/clinical-note-context'
import { CLINIC_DEPARTMENT, QueueRail } from './queue-rail'
import { WorkbenchColumns } from './workbench-columns'

export type CaseFocus =
  | { kind: 'none' }
  | { kind: 'registration'; entry: GoldenCaseQueueEntry }
  | { kind: 'encounter'; encounter: EncounterView; examinations: PhysicalExaminationView[]; debrief?: CaseDebrief }

const HIDDEN_KEY = 'clinmesh.copilot.hidden'

// One screen of the workbench: it owns the Copilot session (per Encounter) and whether the panel is
// hidden. Hiding is remembered in localStorage; private browsing that blocks storage just forgets it.
export function Workbench({ queue, focus }: { queue: GoldenCaseQueueEntry[]; focus: CaseFocus }) {
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
    <div className="flex h-full flex-col">
      <header className="flex h-12 flex-none items-center gap-3 bg-card px-4 shadow-[inset_0_-1px_0_var(--border)]">
        <span
          aria-hidden="true"
          className="grid size-[22px] place-items-center rounded-[5px] bg-primary text-[15px] font-bold text-primary-foreground"
        >
          C
        </span>
        <h1 className="m-0 text-[15px] font-semibold whitespace-nowrap">ClinMesh 门诊工作台</h1>
        <span className="truncate text-xs text-muted-foreground">{CLINIC_DEPARTMENT}</span>
        <button
          type="button"
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          onClick={() => setCopilotHidden(false)}
        >
          <span aria-hidden="true">✦</span>
          <span>临床助手{copilot.busy ? ' · 运行中' : ''}</span>
          {copilotHidden && copilot.unread > 0 && (
            <span className="inline-flex size-4 items-center justify-center rounded-full bg-info text-[10px] font-semibold text-info-foreground">
              {copilot.unread > 99 ? '99+' : copilot.unread}
            </span>
          )}
          <span className="sr-only">{copilotHidden ? '显示临床助手面板' : '临床助手面板已显示'}</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 gap-2 py-3 pr-4 pl-3">
        <QueueRail queue={queue} focusedCaseId={focusedCaseId} />
        <ClinicalNoteProvider key={focus.kind === 'encounter' ? focus.encounter.encounterId : 'registration'} encounter={focus.kind === 'encounter' ? focus.encounter : null}>
          <WorkbenchColumns
            caseWorkspace={<CaseWorkspace focus={focus} />}
            encounter={focus.kind === 'encounter' ? focus : undefined}
            copilot={copilot}
            copilotHidden={copilotHidden}
            examinations={focus.kind === 'encounter' ? focus.examinations : []}
            onHideCopilot={() => setCopilotHidden(true)}
          />
        </ClinicalNoteProvider>
      </div>
    </div>
  )
}
