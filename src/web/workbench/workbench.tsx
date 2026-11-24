import type { EncounterView } from '../../shared/encounter'
import type { GoldenCaseQueueEntry } from '../../shared/golden-case-queue'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { CaseWorkspace } from './case-workspace'
import { CLINIC_DEPARTMENT, QueueRail } from './queue-rail'
import { WorkbenchColumns } from './workbench-columns'

export type CaseFocus =
  | { kind: 'none' }
  | { kind: 'registration'; entry: GoldenCaseQueueEntry }
  | { kind: 'encounter'; encounter: EncounterView; examinations: PhysicalExaminationView[] }

export function Workbench({ queue, focus }: { queue: GoldenCaseQueueEntry[]; focus: CaseFocus }) {
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
      </header>
      <div className="flex min-h-0 flex-1 gap-2 py-3 pr-4 pl-3">
        <QueueRail queue={queue} focusedCaseId={focusedCaseId} />
        <WorkbenchColumns
          caseWorkspace={<CaseWorkspace focus={focus} />}
          encounter={focus.kind === 'encounter' ? focus : undefined}
        />
      </div>
    </div>
  )
}
