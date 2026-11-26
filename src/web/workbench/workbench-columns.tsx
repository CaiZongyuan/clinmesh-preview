import {
  createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
  type ResizableLayoutCommitDetails,
} from '@ui-sdk/react/resizable'
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { CopilotMention } from '../../shared/copilot-turn'
import { useConsultation } from '../consultation/use-consultation'
import type { CopilotSession } from '../copilot/use-copilot'
import { ConsultationPane, type EncounterContext } from './consultation-column'
import { CopilotPanel } from './copilot-panel'

const WORKBENCH_LAYOUT_KEY = 'clinmesh.workbench.pixel-widths'
const OVERLAY = '(max-width: 1180px)'

const CONSULTATION = { id: 'consultation', width: 340, minSize: '260px', maxSize: '560px', collapsedSize: '48px' } as const
const COPILOT = { id: 'clinical-copilot', width: 420, minSize: '340px', maxSize: '680px' } as const
const px = (width: number): `${number}px` => `${width}px`
const isOverlay = () => window.matchMedia?.(OVERLAY).matches === true

interface SavedWidths {
  consultation: number
  copilot: number
  collapsed: boolean
}

const defaults: SavedWidths = { consultation: CONSULTATION.width, copilot: COPILOT.width, collapsed: false }

function storedWidths(): SavedWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKBENCH_LAYOUT_KEY) ?? 'null') as Partial<SavedWidths> | null
    const width = (value: number | undefined, fallback: number, min: number, max: number) =>
      typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
    return {
      consultation: width(stored?.consultation, defaults.consultation, 260, 560),
      copilot: width(stored?.copilot, defaults.copilot, 340, 680),
      collapsed: stored?.collapsed === true,
    }
  } catch {
    return defaults
  }
}

export function WorkbenchColumns({
  caseWorkspace,
  encounter,
  copilot,
  copilotHidden,
  examinations,
  onHideCopilot,
}: {
  caseWorkspace: ReactNode
  encounter: EncounterContext
  copilot: CopilotSession
  copilotHidden: boolean
  examinations: EncounterContext['examinations']
  onHideCopilot: () => void
}) {
  const [draft, setDraft] = useState('')
  const [mentions, setMentions] = useState<CopilotMention[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [columns] = useState(createResizableController)
  const [widths, setWidths] = useState(storedWidths)
  const widthsRef = useRef(widths)
  const group = useRef<HTMLDivElement>(null)

  const persistWidths = (next: SavedWidths) => {
    widthsRef.current = next
    setWidths(next)
    try {
      localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(next))
    } catch {}
  }

  useLayoutEffect(() => {
    if (!group.current) return
    const synchronize = () => {
      const wanted = widthsRef.current
      if (!isOverlay()) {
        if (!wanted.collapsed) columns.resize(CONSULTATION.id, px(wanted.consultation))
        if (!copilotHidden) columns.resize(COPILOT.id, px(wanted.copilot))
      }
      if (wanted.collapsed) columns.collapse(CONSULTATION.id)
    }
    synchronize()
    const observer = new ResizeObserver(synchronize)
    observer.observe(group.current)
    return () => observer.disconnect()
  }, [columns, copilotHidden])

  const saveLayout = (layout: number[], details: ResizableLayoutCommitDetails) => {
    if (isOverlay() || details.reason === 'resize' || details.reason === 'imperative') return
    const panels = group.current?.querySelectorAll<HTMLElement>(':scope > [data-slot="resizable-panel"]')
    if (!panels) return
    const total = Array.from(panels).reduce((sum, panel) => sum + (panel.offsetWidth || panel.getBoundingClientRect().width), 0)
    if (total <= 0) return
    const collapsed = columns.isCollapsed(CONSULTATION.id)
    const measured = (index: number, min: number, max: number, fallback: number) => {
      const percent = layout[index]
      return percent === undefined ? fallback : Math.round(Math.max(min, Math.min(max, total * percent / 100)))
    }
    persistWidths({
      consultation: collapsed ? widthsRef.current.consultation : measured(0, 260, 560, widthsRef.current.consultation),
      copilot: measured(2, 340, 680, widthsRef.current.copilot),
      collapsed,
    })
  }

  const setConsultationCollapsed = (collapsed: boolean) => {
    if (collapsed ? columns.collapse(CONSULTATION.id) : columns.expand(CONSULTATION.id)) {
      persistWidths({ ...widthsRef.current, collapsed })
    }
  }
  // Lives above the column so the collapsed strip still knows when the patient is answering.
  const consultation = useConsultation(encounter?.encounter.encounterId ?? null, encounter?.encounter.status)

  const resetConsultation = (event: MouseEvent) => {
    event.preventDefault()
    columns.expand(CONSULTATION.id)
    columns.resize(CONSULTATION.id, px(CONSULTATION.width))
    persistWidths({ ...widthsRef.current, consultation: CONSULTATION.width, collapsed: false })
  }
  const resetCopilot = (event: MouseEvent) => {
    event.preventDefault()
    columns.resize(COPILOT.id, px(COPILOT.width))
    persistWidths({ ...widthsRef.current, copilot: COPILOT.width })
  }

  return (
    <Resizable
      aria-label="工作台分栏"
      className="workbench-columns min-w-0 flex-1"
      controller={columns}
      ref={group}
      onLayoutCommit={saveLayout}
      style={{ '--consultation-width': px(widths.consultation) } as CSSProperties}
    >
      <ResizablePanel
        id={CONSULTATION.id}
        defaultSize={widths.collapsed ? CONSULTATION.collapsedSize : px(widths.consultation)}
        minSize={CONSULTATION.minSize}
        maxSize={CONSULTATION.maxSize}
        collapsible
        collapsedSize={CONSULTATION.collapsedSize}
      >
        {({ collapsed }) => (
          <ConsultationPane
            encounter={encounter}
            consultation={consultation}
            collapsed={collapsed}
            onToggle={() => setConsultationCollapsed(!collapsed)}
          />
        )}
      </ResizablePanel>
      <ResizableHandle
        aria-label="调整问诊记录宽度"
        title="调整问诊记录宽度（拖动或方向键调整，双击复位，Enter 收起）"
        onDoubleClick={resetConsultation}
      />
      <ResizablePanel id="case-workspace" minSize="440px">
        {caseWorkspace}
      </ResizablePanel>
      {!copilotHidden && (
        <>
          <ResizableHandle
            aria-label="调整病例工作区宽度"
            data-copilot-separator
            title="调整病例工作区宽度（拖动或方向键调整，双击复位右侧分栏）"
            onDoubleClick={resetCopilot}
          />
          <ResizablePanel id={COPILOT.id} defaultSize={px(widths.copilot)} minSize={COPILOT.minSize} maxSize={COPILOT.maxSize}>
            <CopilotPanel copilot={copilot} encounter={encounter.encounter} examinations={examinations} onHide={onHideCopilot}
              draft={draft} setDraft={setDraft} mentions={mentions} setMentions={setMentions} editing={editing} setEditing={setEditing} />
          </ResizablePanel>
        </>
      )}
    </Resizable>
  )
}
