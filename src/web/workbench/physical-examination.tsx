import { useRouter } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible'
import { CheckIcon, ChevronRightIcon, StethoscopeIcon } from 'lucide-react'
import { useState } from 'react'
import type { EncounterView } from '../../shared/encounter'
import { BODY_SYSTEM_NAME, BODY_SYSTEMS, type BodySystem, type PhysicalExaminationView } from '../../shared/physical-examination'
import { performPhysicalExamination } from '../api'
import { QuoteMenu } from './clinical-note/quote-menu'
import { formatClock } from './format'
import { badge } from './pane-styles'
import { ActionTooltip } from './ui-tooltip'

// An objective finding in the Consultation transcript, set apart from what the doctor and patient said.
export function PhysicalExaminationRow({ examination }: { examination: PhysicalExaminationView }) {
  return (
    <li
      data-kind="examination"
      className="flex items-start gap-2 rounded-md bg-success/5 px-2 py-1.5 text-[12.5px] shadow-[inset_2px_0_0_color-mix(in_srgb,var(--success)_60%,transparent)]"
    >
      <span className={`${badge} flex-none bg-success/15 text-success`}>
        <StethoscopeIcon aria-hidden="true" size={11} />
        查体
      </span>
      <span className="min-w-0 flex-1">
        {BODY_SYSTEM_NAME[examination.system]}：{examination.finding}
      </span>
      <time dateTime={examination.examinedAt} className="flex-none font-mono text-[11px] text-muted-foreground">
        {formatClock(examination.examinedAt)}
      </time>
      <QuoteMenu
        label={`引用查体：${BODY_SYSTEM_NAME[examination.system]}到病历`}
        text={`查体·${BODY_SYSTEM_NAME[examination.system]}：${examination.finding}`}
      />
    </li>
  )
}

// Findings come back at once and need no acknowledgement; each body system can be examined once.
// Examining uncovers Case Truth as the doctor's own act, so the agent bridge needs the doctor's approval to press it.
export function PhysicalExaminationPanel({
  encounter,
  examinations,
}: {
  encounter: EncounterView
  examinations: PhysicalExaminationView[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const examined = new Map(examinations.map((e) => [e.system, e]))

  const examine = async (system: BodySystem) => {
    setError(null)
    try {
      await performPhysicalExamination(encounter.encounterId, system)
    } catch (e) {
      setError(e instanceof Error ? e.message : '查体失败')
    }
    await router.invalidate()
  }

  return (
    <Collapsible defaultOpen className="flex flex-col gap-1.5">
      <CollapsibleTrigger className="group inline-flex h-6 items-center gap-1.5 self-start border-0 bg-transparent p-0 text-xs text-muted-foreground">
        <ChevronRightIcon aria-hidden="true" size={13} className="transition-transform group-data-open:rotate-90" />
        <StethoscopeIcon aria-hidden="true" size={13} />
        体格检查 <span className="font-mono">{examined.size}/{BODY_SYSTEMS.length}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="flex flex-wrap gap-1.5">
        {BODY_SYSTEMS.map((system) => {
          const done = examined.get(system)
          const disabled = Boolean(done) || encounter.status !== 'active'
          const button = (
            <Button
              key={system}
              aria-label={`查体：${BODY_SYSTEM_NAME[system]}`}
              title={done ? done.finding : undefined}
              data-examined={done ? '' : undefined}
              data-agent-confirm={`为${encounter.patient.name}执行${BODY_SYSTEM_NAME[system]}查体：揭示该部位的客观发现并记入本次就诊`}
              disabled={disabled}
              onClick={() => examine(system)}
              className="exam-chip"
            >
              {done && <CheckIcon aria-hidden="true" size={12} />}
              {/* web.css squares an aria-labelled button whose only element child is an icon; text nodes don't count. */}
              <span>{BODY_SYSTEM_NAME[system]}</span>
            </Button>
          )
          return disabled ? button : (
            <ActionTooltip key={system} label={`执行${BODY_SYSTEM_NAME[system]}查体`} side="top">
              {button}
            </ActionTooltip>
          )
        })}
        {error && (
          <p role="alert" className="m-0 w-full text-xs text-destructive">
            {error}
          </p>
        )}
      </CollapsiblePanel>
    </Collapsible>
  )
}
