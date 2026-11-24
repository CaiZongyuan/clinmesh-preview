import {
  createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
  type ResizableStorage,
} from '@ui-sdk/react/resizable'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { useConsultation } from '../consultation/use-consultation'
import { ConsultationColumn, ConsultationStrip, type EncounterContext } from './consultation-column'
import { CopilotPanel } from './copilot-panel'

const WORKBENCH_LAYOUT_KEY = 'clinmesh.workbench.columns'

const CONSULTATION = { id: 'consultation', defaultSize: '340px', minSize: '260px', maxSize: '560px', collapsedSize: '48px' } as const
const COPILOT = { id: 'clinical-copilot', defaultSize: '420px', minSize: '340px', maxSize: '680px' } as const

// Private browsing and blocked site data make localStorage throw; the layout then just isn't remembered.
const browserLayoutStorage: ResizableStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },
}

export function WorkbenchColumns({ caseWorkspace, encounter }: { caseWorkspace: ReactNode; encounter?: EncounterContext }) {
  const [columns] = useState(createResizableController)
  // Lives above the column so the collapsed strip still knows when the patient is answering.
  const consultation = useConsultation(encounter?.encounter.encounterId ?? null)

  const resetConsultation = (event: MouseEvent) => {
    event.preventDefault()
    columns.expand(CONSULTATION.id)
    columns.resize(CONSULTATION.id, CONSULTATION.defaultSize)
  }
  const resetCopilot = (event: MouseEvent) => {
    event.preventDefault()
    columns.resize(COPILOT.id, COPILOT.defaultSize)
  }

  return (
    <Resizable
      aria-label="工作台分栏"
      className="workbench-columns min-w-0 flex-1"
      controller={columns}
      autoSaveId={WORKBENCH_LAYOUT_KEY}
      storage={browserLayoutStorage}
    >
      <ResizablePanel
        id={CONSULTATION.id}
        defaultSize={CONSULTATION.defaultSize}
        minSize={CONSULTATION.minSize}
        maxSize={CONSULTATION.maxSize}
        collapsible
        collapsedSize={CONSULTATION.collapsedSize}
      >
        {({ collapsed }) =>
          collapsed ? (
            <ConsultationStrip consultation={consultation} onExpand={() => columns.expand(CONSULTATION.id)} />
          ) : (
            <ConsultationColumn
              encounter={encounter}
              consultation={consultation}
              onCollapse={() => columns.collapse(CONSULTATION.id)}
            />
          )
        }
      </ResizablePanel>
      <ResizableHandle
        aria-label="调整问诊记录宽度"
        title="调整问诊记录宽度（拖动或方向键调整，双击复位，Enter 收起）"
        onDoubleClick={resetConsultation}
      />
      <ResizablePanel id="case-workspace" minSize="440px">
        {caseWorkspace}
      </ResizablePanel>
      <ResizableHandle
        aria-label="调整临床助手宽度"
        title="调整临床助手宽度（拖动或方向键调整，双击复位）"
        onDoubleClick={resetCopilot}
      />
      <ResizablePanel id={COPILOT.id} defaultSize={COPILOT.defaultSize} minSize={COPILOT.minSize} maxSize={COPILOT.maxSize}>
        <CopilotPanel />
      </ResizablePanel>
    </Resizable>
  )
}
