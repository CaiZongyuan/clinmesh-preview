import { completionGates, type CaseDebrief } from '../../shared/completion'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { useEffect, useRef, useState } from 'react'
import { ArrowRightIcon, ClipboardListIcon, FileTextIcon, FlaskConicalIcon, PillIcon, StethoscopeIcon, TicketIcon, UsersIcon } from 'lucide-react'
import { CLINIC_DEPARTMENT, QueueList } from './queue-rail'
import type { EncounterView } from '../../shared/encounter'
import type { GoldenCaseQueueEntry } from '../../shared/golden-case-queue'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { startEncounter } from '../api'
import { CaseDebriefPanel } from './case-debrief'
import { useClinicalNoteContext } from './clinical-note/clinical-note-context'
import { CompleteEncounter, CompletionChecklist, type ClinicalTab } from './encounter-completion'
import { useClinicalDrafts } from './use-clinical-drafts'
import { AbandonEncounter } from './abandon-encounter'
import { ClinicalNoteTab } from './clinical-note/clinical-note-tab'
import { DiagnosisTab } from './diagnosis/diagnosis-tab'
import { useDiagnosis } from './diagnosis/use-diagnosis'
import { formatClock, SEX_LABEL, VISIT_KIND_LABEL } from './format'
import { InvestigationsTab } from './investigations/investigations-tab'
import { useInvestigations } from './investigations/use-investigations'
import { PrescriptionTab } from './prescription/prescription-tab'
import { usePrescriptions } from './prescription/use-prescriptions'
import { badge, pane, paneBody, paneFooter } from './pane-styles'
import { PatientBanner } from './patient-banner'
import { workbenchOwnsShortcut } from './workbench-shortcuts'

export function WaitingRoom({ queue, selected }: { queue: GoldenCaseQueueEntry[]; selected?: GoldenCaseQueueEntry }) {
  const { start, error } = useStartEncounter()
  const firstWaiting = queue.find((entry) => entry.queueStatus === 'waiting')
  const entry = selected ?? firstWaiting
  return (
    <main className="waiting-room" aria-label="门诊候诊">
      <header className="waiting-heading">
        <div><p><StethoscopeIcon size={15} />{CLINIC_DEPARTMENT}</p><h2>门诊候诊</h2></div>
        <div className="waiting-total"><UsersIcon size={18} /><strong>{queue.length}</strong> 位挂号患者</div>
      </header>
      <div className="waiting-grid">
        <nav aria-label="候诊队列" className="roster-card">
          <h3><UsersIcon size={18} />候诊队列</h3>
          <QueueList key={selected?.queueStatus} queue={queue} selected={entry} />
        </nav>
        {entry ? (
          <section className="registration-card" aria-label="挂号信息" key={entry.caseId}>
            <header><TicketIcon size={18} /> 挂号信息 <span>{entry.queueNumber} 号</span></header>
            <div className="registration-body">
              <div className="registration-avatar" aria-hidden="true">{entry.patientName[0]}</div>
              <h3>{entry.patientName}</h3>
              <p>{SEX_LABEL[entry.sex]} · {entry.age} 岁 · {VISIT_KIND_LABEL[entry.visitKind]}</p>
              <dl><div><dt>主诉<span className="sr-only">：</span></dt><dd>{entry.chiefComplaint}</dd></div>
                <div><dt>挂号时间</dt><dd><time dateTime={entry.registeredAt}>{formatClock(entry.registeredAt)}</time></dd></div>
                <div><dt>就诊科室</dt><dd>{CLINIC_DEPARTMENT}</dd></div></dl>
              <Button data-variant="solid" onClick={() => start(entry.caseId)}>开始接诊<ArrowRightIcon size={15} /></Button>
              {error && <p role="alert" className="text-destructive">{error}</p>}
            </div>
          </section>
        ) : <section className="registration-card queue-empty"><ClipboardListIcon size={26} /><p>暂无待接诊患者</p></section>}
      </div>
    </main>
  )
}

const primaryTabs = ['note', 'investigations', 'diagnosis', 'prescription'] as const

export function EncounterWorkspace({
  encounter, examinations, debrief,
}: { encounter: EncounterView; examinations: PhysicalExaminationView[]; debrief?: CaseDebrief }) {
  const drafts = useClinicalDrafts(encounter.encounterId)
  const investigations = useInvestigations(encounter, drafts)
  const diagnosis = useDiagnosis(encounter)
  const prescriptions = usePrescriptions(encounter, drafts)
  const assistance = useClinicalNoteContext()
  const note = assistance?.note
  const suggestions = assistance?.assistance.suggestions ?? []
  const assistantItems = assistance?.assistance.assistantItems
  const assistantInvestigations = drafts.drafts.investigations.filter((id) => assistantItems?.investigations.includes(id)).length
  const assistantDiagnoses = diagnosis.view.draft.filter((entry) => entry.source === 'assistant').length
  const assistantPrescriptions = drafts.drafts.prescriptions.filter((entry) => assistantItems?.prescriptions.includes(entry.drugId)).length
  const assistantSections = Object.values(note?.authors ?? {}).filter((author) => author === 'assistant').length
  const [selectedTab, selectTab] = useState<ClinicalTab>(debrief ? 'debrief' : 'note')
  const tabList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !workbenchOwnsShortcut(event)) return
      const digit = /^[1-4]$/.test(event.key) ? event.key : /^Digit([1-4])$/.exec(event.code)?.[1]
      if (!digit) return
      event.preventDefault()
      selectTab(primaryTabs[Number(digit) - 1])
      tabList.current?.querySelector<HTMLElement>(`[aria-keyshortcuts="Alt+${digit}"]`)?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const gates = completionGates(
    diagnosis.view, investigations.investigations, prescriptions.view, note?.revisions.at(-1), drafts.drafts, suggestions.length,
  )
  const draftTabs = [
    { tab: 'note', name: '病历记录', count: suggestions.filter(({ action }) => action.module === 'note').length },
    { tab: 'investigations', name: '检验检查', count: drafts.drafts.investigations.length + suggestions.filter(({ action }) => action.module === 'investigations').length },
    { tab: 'diagnosis', name: '诊断', count: diagnosis.view.draft.length + suggestions.filter(({ action }) => action.module === 'diagnosis').length },
    { tab: 'prescription', name: '处方', count: drafts.drafts.prescriptions.length + suggestions.filter(({ action }) => action.module === 'prescriptions').length },
  ] as const
  const checklist = { gates, draftTabs: draftTabs.filter(({ count }) => count > 0), onSelect: selectTab }
  const active = encounter.status === 'active'
  return (
    <main aria-label="病例工作区" className={pane}>
      <PatientBanner
        encounter={encounter}
        examinedVitals={examinations.find((e) => e.system === 'vitals')}
        completion={active && <CompletionChecklist location="banner" {...checklist} />}
      />
      {encounter.status === 'abandoned' && <ReplayNotice caseId={encounter.caseId} abandoned />}
      {debrief && <ReplayNotice caseId={encounter.caseId} />}
      {active && drafts.error && (
        <p role="alert" className="m-0 px-4 py-2 text-xs text-destructive">
          {drafts.error} {drafts.loaded && <Button onClick={drafts.retry} className="h-7 text-xs">重试保存草稿</Button>}
        </p>
      )}
      <Tabs value={selectedTab === 'debrief' && !debrief ? 'note' : selectedTab} onValueChange={(value) => selectTab(value as ClinicalTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList ref={tabList} aria-label="病例页签" className="section-tabs record-tabs">
          <TabsTab aria-keyshortcuts="Alt+1" value="note" data-agent-note-updated={assistantSections > 0 || undefined}>
            <FileTextIcon aria-hidden="true" size={14} />病历记录
            {assistantSections > 0 && <span className={`${badge} bg-info/10 text-info`}>助手 {assistantSections}</span>}
          </TabsTab>
          <TabsTab aria-keyshortcuts="Alt+2" value="investigations" data-agent-note-updated={assistantInvestigations > 0 || undefined}>
            <FlaskConicalIcon aria-hidden="true" size={14} />检验检查
            <PendingCount count={investigations.pendingCount} />
            <AssistantCount count={assistantInvestigations} />
          </TabsTab>
          <TabsTab aria-keyshortcuts="Alt+3" value="diagnosis" data-agent-note-updated={assistantDiagnoses > 0 || undefined}>
            <StethoscopeIcon aria-hidden="true" size={14} />诊断
            <AssistantCount count={assistantDiagnoses} />
          </TabsTab>
          <TabsTab aria-keyshortcuts="Alt+4" value="prescription" data-agent-note-updated={assistantPrescriptions > 0 || undefined}>
            <PillIcon aria-hidden="true" size={14} />处方
            <AssistantCount count={assistantPrescriptions} />
          </TabsTab>
          {debrief && <TabsTab value="debrief">病例复盘</TabsTab>}
        </TabsList>
        <TabsPanel value="note" className={paneBody}>
          <ClinicalNoteTab encounter={encounter} diagnosisSeq={diagnosis.view.revisions.at(-1)?.seq} />
        </TabsPanel>
        <TabsPanel value="investigations" data-draft-module="investigations" className={paneBody}>
          <InvestigationsTab state={investigations} writable={active && drafts.loaded} />
        </TabsPanel>
        <TabsPanel value="diagnosis" data-draft-module="diagnosis" className={paneBody}>
          <DiagnosisTab encounter={encounter} state={diagnosis} />
        </TabsPanel>
        <TabsPanel value="prescription" data-draft-module="prescriptions" className={paneBody}>
          <PrescriptionTab encounter={encounter} state={prescriptions} />
        </TabsPanel>
        {debrief && <TabsPanel value="debrief" className={paneBody}><CaseDebriefPanel debrief={debrief} /></TabsPanel>}
      </Tabs>
      {encounter.status === 'abandoned' && <div className={paneFooter}><AbandonEncounter encounter={encounter} /></div>}
      {active && (
        <div className={paneFooter}>
          <CompletionChecklist location="footer" {...checklist} />
          <span className="flex-1" />
          <AbandonEncounter encounter={encounter} />
          <CompleteEncounter
            encounter={encounter}
            ready={gates.every((gate) => gate.met)}
            saving={drafts.saving || !drafts.loaded || Boolean(drafts.error) || Boolean(assistance?.pending)}
            flush={drafts.flush}
            onCompleted={() => selectTab('debrief')}
          />
        </div>
      )}
    </main>
  )
}

function AssistantCount({ count }: { count: number }) {
  return count > 0 ? <span className={`${badge} bg-info/10 text-info`}>助手 {count}</span> : null
}

// Yellow count of what waits on the doctor in a tab: pending items to issue and Reports not yet acknowledged.
function PendingCount({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className={`${badge} bg-warning/15 text-warning`}>
      <span className="sr-only">待处理 </span>
      {count}
    </span>
  )
}


function ReplayNotice({ caseId, abandoned = false }: { caseId: string; abandoned?: boolean }) {
  const { start, error } = useStartEncounter()
  return (
    <div className="flex flex-none flex-wrap items-center justify-center gap-2 border-b bg-muted px-4 py-2 text-[13px]">
      <span>{abandoned ? '本次就诊已放弃：写入冻结，病例真值未解锁。' : '本次就诊已完诊，记录只读。'}</span>
      <Button className="h-7 px-2.5 text-xs" onClick={() => start(caseId)}>
        开始新的就诊
      </Button>
      {error && (
        <p role="alert" className="m-0 w-full text-center text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function useStartEncounter() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const start = async (caseId: string) => {
    setError(null)
    try {
      const encounter = await startEncounter(caseId)
      await navigate({ to: '/encounters/$encounterId', params: { encounterId: encounter.encounterId } })
    } catch (e) {
      setError(e instanceof Error ? e.message : '开始接诊失败')
    }
  }
  return { start, error }
}
