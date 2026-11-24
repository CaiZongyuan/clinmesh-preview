import { useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { useState, type ReactNode } from 'react'
import type { EncounterView } from '../../shared/encounter'
import type { GoldenCaseQueueEntry } from '../../shared/golden-case-queue'
import { startEncounter } from '../api'
import { AbandonEncounter } from './abandon-encounter'
import { formatClock, SEX_LABEL, VISIT_KIND_LABEL } from './format'
import { badge, pane, paneBody, paneFooter, paneHeader } from './pane-styles'
import { PatientBanner } from './patient-banner'
import type { CaseFocus } from './workbench'

export function CaseWorkspace({ focus }: { focus: CaseFocus }) {
  if (focus.kind === 'encounter') return <EncounterWorkspace encounter={focus.encounter} />
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
      <CompletionFooter />
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

function EncounterWorkspace({ encounter }: { encounter: EncounterView }) {
  return (
    <main aria-label="病例工作区" className={pane}>
      <PatientBanner encounter={encounter} />
      {encounter.status === 'abandoned' && <AbandonedNotice caseId={encounter.caseId} />}
      <div className={`${paneBody} grid place-items-center`}>
        <p className="m-0 p-6 text-center text-[13px] text-muted-foreground">
          病历记录、检验检查、诊断与处方将在这里展开。病例真值在完诊前不可见。
        </p>
      </div>
      <CompletionFooter>
        <AbandonEncounter encounter={encounter} />
      </CompletionFooter>
    </main>
  )
}

function AbandonedNotice({ caseId }: { caseId: string }) {
  const { start, error } = useStartEncounter()
  return (
    <div className="flex flex-none flex-wrap items-center justify-center gap-2 border-b bg-muted px-4 py-2 text-[13px]">
      <span>本次就诊已放弃：写入冻结，病例真值未解锁。</span>
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

function CompletionFooter({ children }: { children?: ReactNode }) {
  return (
    <div className={paneFooter}>
      <span className="flex-1">
        完诊 <b className="font-mono text-foreground">0/5</b>
      </span>
      {children}
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
