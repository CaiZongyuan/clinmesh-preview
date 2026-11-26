import { PlusIcon, ClipboardListIcon, MessagesSquareIcon, SparklesIcon } from 'lucide-react'
import { Button } from '@ui-sdk/react/button'
import { Preferences } from '@ui-sdk/react/preferences'
import { useEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import type { CaseDebrief } from '../../shared/completion'
import type { EncounterView } from '../../shared/encounter'
import type { GoldenCaseQueueEntry } from '../../shared/golden-case-queue'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { useCopilot, type CopilotSession } from '../copilot/use-copilot'
import { EncounterWorkspace, WaitingRoom } from './case-workspace'
import { ClinicalNoteProvider, useClinicalNoteContext } from './clinical-note/clinical-note-context'
import { CLINIC_DEPARTMENT, QueueRail } from './queue-rail'
import { WorkbenchColumns } from './workbench-columns'
import { WorkbenchAppearance, workbenchPreferences } from './workbench-preferences'
import { WorkbenchShortcuts, workbenchOwnsShortcut } from './workbench-shortcuts'
import { ActionTooltip } from './ui-tooltip'

export type CaseFocus =
  | { kind: 'none' }
  | { kind: 'registration'; entry: GoldenCaseQueueEntry }
  | { kind: 'encounter'; encounter: EncounterView; examinations: PhysicalExaminationView[]; debrief?: CaseDebrief }

const HIDDEN_KEY = 'clinmesh.copilot.hidden'

const overlayMedia = '(max-width: 1180px)'
const isNarrow = () => window.matchMedia?.(overlayMedia).matches ?? false
function subscribeWidth(update: () => void) {
  const media = window.matchMedia?.(overlayMedia)
  media?.addEventListener('change', update)
  return () => media?.removeEventListener('change', update)
}

export function Workbench({ queue, focus }: { queue: GoldenCaseQueueEntry[]; focus: CaseFocus }) {
  const copilotButton = useRef<HTMLButtonElement>(null)
  const focusAfterOpening = useRef(false)
  const encounter = focus.kind === 'encounter' ? focus.encounter : undefined
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow, () => false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [mobilePane, setMobilePane] = useState('consultation')
  const [desktopHidden, setDesktopHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      if (desktopHidden) localStorage.setItem(HIDDEN_KEY, '1')
      else localStorage.removeItem(HIDDEN_KEY)
    } catch {}
  }, [desktopHidden])
  const copilotHidden = narrow ? !overlayOpen : desktopHidden
  const copilot = useCopilot(encounter?.encounterId ?? null, encounter?.status, copilotHidden)
  const showCopilot = () => {
    if (narrow) setOverlayOpen(true)
    else setDesktopHidden(false)
  }
  const hideCopilot = () => {
    if (narrow) setOverlayOpen(false)
    else setDesktopHidden(true)
    copilotButton.current?.focus()
  }
  const { busy, stop } = copilot
  const activeEncounter = encounter?.status === 'active'
  useEffect(() => {
    if (copilotHidden || !focusAfterOpening.current) return
    focusAfterOpening.current = false
    document.querySelector<HTMLElement>('[data-copilot-composer]')?.focus()
  }, [copilotHidden])

  useEffect(() => {
    if (!activeEncounter) return
    const onKey = (event: KeyboardEvent) => {
      if (!workbenchOwnsShortcut(event)) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '/') {
        event.preventDefault()
        if (copilotHidden) {
          focusAfterOpening.current = true
          if (narrow) setOverlayOpen(true)
          else setDesktopHidden(false)
        } else {
          document.querySelector<HTMLElement>('[data-copilot-composer]')?.focus()
        }
      } else if (event.key === 'Escape' && busy) {
        event.preventDefault()
        void stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeEncounter, busy, copilotHidden, narrow, stop])
  return (
    <ClinicalNoteProvider key={encounter?.encounterId ?? 'registration'} encounter={encounter ?? null}>
      <Preferences preferences={workbenchPreferences}>
        <div className="workbench-shell flex h-full flex-col">
          <header className="masthead">
            <span className="brand-mark" aria-hidden="true"><PlusIcon size={15} strokeWidth={3} /></span>
            <h1>门诊医生工作台</h1>
            <span className="department">{CLINIC_DEPARTMENT}</span>
            <div className="masthead-tools">
              {encounter && <CopilotTopBar copilot={copilot} active={activeEncounter} hidden={copilotHidden} buttonRef={copilotButton} onShow={showCopilot} />}
              <WorkbenchShortcuts />
              <WorkbenchAppearance />
            </div>
          </header>
          {focus.kind === 'encounter' ? (
            <>
              <div className="workbench-body" data-phone-pane={copilotHidden ? mobilePane : 'copilot'}>
                <div className="phone-patient">
                  <strong>{focus.encounter.patient.name}</strong><span>{focus.encounter.patient.chiefComplaint}</span>
                  {focus.encounter.visibleSourceHistory.allergies.map((allergy) => <span className="phone-allergy" key={allergy.agent}>过敏：{allergy.agent}</span>)}
                </div>
                <QueueRail queue={queue} focusedCaseId={focus.encounter.caseId} />
                <WorkbenchColumns
                  caseWorkspace={<EncounterWorkspace encounter={focus.encounter} examinations={focus.examinations} debrief={focus.debrief} />}
                  encounter={focus} copilot={copilot} copilotHidden={copilotHidden} examinations={focus.examinations} onHideCopilot={hideCopilot}
                />
              </div>
              <nav aria-label="接诊视图" className="phone-navigation">
                <Button aria-pressed={copilotHidden && mobilePane === 'consultation'} onClick={() => { setOverlayOpen(false); setMobilePane('consultation') }}>
                  <MessagesSquareIcon size={17} />问诊
                </Button>
                <Button aria-pressed={copilotHidden && mobilePane === 'case'} onClick={() => { setOverlayOpen(false); setMobilePane('case') }}>
                  <ClipboardListIcon size={17} />病例
                </Button>
                <Button aria-pressed={!copilotHidden} onClick={showCopilot}><SparklesIcon size={17} />助手</Button>
              </nav>
            </>
          ) : <WaitingRoom queue={queue} selected={focus.kind === 'registration' ? focus.entry : undefined} />}
        </div>
      </Preferences>
    </ClinicalNoteProvider>
  )
}

function CopilotTopBar({ copilot, active, hidden, buttonRef, onShow }: {
  copilot: CopilotSession; active: boolean; hidden: boolean; buttonRef: Ref<HTMLButtonElement>; onShow: () => void
}) {
  const note = useClinicalNoteContext()
  const pending = note?.writable ? note.assistance.suggestions.length : 0
  const running = copilot.turns.find((turn) => turn.status === 'running')
  const currentTool = running?.steps.find((step) => step.kind === 'tool' && step.state === 'running')
  const activity = currentTool?.kind === 'tool' ? currentTool.subject : running?.trigger.text
  const connection = !active ? '未接诊' : copilot.stream === 'live' ? '就绪' :
    copilot.stream === 'reconnecting' ? '重连中' : '连接中'
  return (
    <ActionTooltip label={hidden ? '打开临床助手' : '聚焦临床助手'} shortcut="mod+/" side="bottom">
      <button
        ref={buttonRef}
        type="button"
        className="copilot-status"
        onClick={() => onShow()}
      >
        <SparklesIcon aria-hidden="true" size={14} />
        <span aria-live="polite" className="truncate">
          临床助手 · {connection}
          {copilot.busy && (activity ? ` · 运行中：${activity}` : ' · 运行中')}
          {copilot.countdown && ' · 倒计时'}
          {copilot.pendingAnalysis.length > 0 && ` · ${copilot.pendingAnalysis.length} 个事件待分析`}
          {pending > 0 && ` · ${pending} 项待确认`}
        </span>
        {hidden && copilot.unread > 0 && (
          <span className="inline-flex size-4 items-center justify-center rounded-full bg-info text-[10px] font-semibold text-info-foreground">
            {copilot.unread > 99 ? '99+' : copilot.unread}
          </span>
        )}
        <span className="sr-only">{hidden ? '显示临床助手面板' : '临床助手面板已显示'}</span>
      </button>
    </ActionTooltip>
  )
}
