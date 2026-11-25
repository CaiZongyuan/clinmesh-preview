import { completionGates, type CaseDebrief } from '../../shared/completion'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { useEffect, useRef, useState } from 'react'
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
import { badge, pane, paneBody, paneFooter, paneHeader } from './pane-styles'
import { PatientBanner } from './patient-banner'
import type { CaseFocus } from './workbench'
import { workbenchOwnsShortcut } from './workbench-shortcuts'

export function CaseWorkspace({ focus }: { focus: CaseFocus }) {
  if (focus.kind === 'encounter') return <EncounterWorkspace key={focus.encounter.encounterId} encounter={focus.encounter} examinations={focus.examinations} debrief={focus.debrief} />
  return (
    <main aria-label="病例工作区" className={pane}>
      <div className={paneHeader}>
        <h2 className="m-0 text-sm font-semibold">病例工作区</h2>
      </div>
      <div className={`${paneBody} grid place-items-center`}>
        {focus.kind === 'registration' ? (
          <Registration entry={focus.entry} />
        ) : (
          <p className="m-0 p-6 text-center text-[13px] text-muted-foreground">
            从候诊队列选择患者开始接诊后，这里显示患者信息、病历记录、检验检查、诊断与处方。
          </p>
        )}
      </div>
    </main>
  )
}

function Registration({ entry }: { entry: GoldenCaseQueueEntry }) {
  const { start, error } = useStartEncounter()
  return (
    <section aria-label="挂号信息" className="flex max-w-[360px] flex-col items-center gap-2 p-6 text-center">
      <span className="font-mono text-xs text-muted-foreground">{entry.queueNumber} 号</span>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <h3 className="m-0 text-base font-semibold">{entry.patientName}</h3>
        <span className="text-xs text-muted-foreground">
          {SEX_LABEL[entry.sex]} · {entry.age} 岁
        </span>
        <span className={`${badge} border`}>{VISIT_KIND_LABEL[entry.visitKind]}</span>
      </div>
      <p className="m-0 text-[13px]">主诉：{entry.chiefComplaint}</p>
      <p className="m-0 text-xs text-muted-foreground">
        挂号 <time dateTime={entry.registeredAt}>{formatClock(entry.registeredAt)}</time>
      </p>
      <Button data-variant="solid" className="mt-2" onClick={() => start(entry.caseId)}>
        开始接诊
      </Button>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

const tab =
  'h-9 gap-1.5 rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 text-[13px] data-[selected]:border-foreground data-[selected]:font-semibold'

const primaryTabs = ['note', 'investigations', 'diagnosis', 'prescription'] as const

function EncounterWorkspace({
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
        <TabsList ref={tabList} aria-label="病例页签" className="flex flex-none gap-1 border-b px-2">
          <TabsTab aria-keyshortcuts="Alt+1" value="note" className={tab} data-agent-note-updated={assistantSections > 0 || undefined}>
            病历记录
            {assistantSections > 0 && <span className={`${badge} bg-info/10 text-info`}>助手 {assistantSections}</span>}
          </TabsTab>
          <TabsTab aria-keyshortcuts="Alt+2" value="investigations" className={tab} data-agent-note-updated={assistantInvestigations > 0 || undefined}>
            检验检查
            <PendingCount count={investigations.pendingCount} />
            <AssistantCount count={assistantInvestigations} />
          </TabsTab>
          <TabsTab aria-keyshortcuts="Alt+3" value="diagnosis" className={tab} data-agent-note-updated={assistantDiagnoses > 0 || undefined}>
            诊断
            <AssistantCount count={assistantDiagnoses} />
          </TabsTab>
          <TabsTab aria-keyshortcuts="Alt+4" value="prescription" className={tab} data-agent-note-updated={assistantPrescriptions > 0 || undefined}>
            处方
            <AssistantCount count={assistantPrescriptions} />
          </TabsTab>
          {debrief && <TabsTab value="debrief" className={tab}>病例复盘</TabsTab>}
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
