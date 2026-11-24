import { Button } from '@ui-sdk/react/button'
import { CheckIcon, ClockIcon, CopyIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EncounterStatus, EncounterView, Triage, VitalSignKind } from '../../shared/encounter'
import { formatClock, formatDuration, SEX_LABEL, VISIT_KIND_LABEL } from './format'
import { HealthRecordPopover } from './health-record'
import { badge, iconButton } from './pane-styles'

const STATUS_LABEL: Record<EncounterStatus, string> = { active: '就诊中', abandoned: '已放弃', completed: '已完诊 · 只读' }

const VITAL_LABEL: Record<VitalSignKind, { short: string; name: string }> = {
  temperature: { short: 'T', name: '体温' },
  pulse: { short: 'P', name: '脉搏' },
  'respiratory-rate': { short: 'R', name: '呼吸' },
  'blood-pressure': { short: 'BP', name: '血压' },
  spo2: { short: 'SpO₂', name: '血氧饱和度' },
}

export function PatientBanner({ encounter }: { encounter: EncounterView }) {
  const { patient, triage, visibleSourceHistory: history } = encounter
  return (
    <section aria-label="患者信息" className="flex max-h-[45%] flex-none flex-col gap-2 overflow-y-auto border-b px-4 pt-3 pb-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h2 className="m-0 text-base font-semibold">{patient.name}</h2>
          <span className="text-xs text-muted-foreground">
            {SEX_LABEL[patient.sex]} · {patient.age} 岁
          </span>
          <span className={`${badge} border`}>{VISIT_KIND_LABEL[patient.visitKind]}</span>
          <span className={`${badge} bg-warning/15 text-warning`}>分诊 {triage.level} 级</span>
          {history.allergies.map((allergy) => (
            <span
              key={allergy.agent}
              title={`${allergy.onset} ${allergy.reaction}（${allergy.source}）`}
              className={`${badge} bg-destructive text-destructive-foreground`}
            >
              <TriangleAlertIcon aria-hidden="true" size={12} />
              过敏：{allergy.agent}（{allergy.reaction}）
            </span>
          ))}
          {history.chronicConditions.map((condition) => (
            <span key={condition.code} className={`${badge} border border-warning/60 text-warning`}>
              慢病：{condition.display}
            </span>
          ))}
          <span className={`${badge} bg-secondary text-secondary-foreground`}>{STATUS_LABEL[encounter.status]}</span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <EncounterTimer startedAt={encounter.startedAt} endedAt={encounter.endedAt} />
          <HealthRecordPopover history={history} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        <OutpatientNumber value={patient.outpatientNumber} />
        <span>
          挂号 <time dateTime={patient.registeredAt}>{formatClock(patient.registeredAt)}</time>
        </span>
        <span>{patient.department}</span>
        <span>{patient.insurance}</span>
        <span>
          主诉：<span className="text-foreground">{patient.chiefComplaint}</span>
        </span>
      </div>
      <TriageVitals triage={triage} />
    </section>
  )
}

function TriageVitals({ triage }: { triage: Triage }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ul aria-label="分诊生命体征" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {triage.vitals.map((vital) => {
          const label = VITAL_LABEL[vital.kind]
          return (
            <li
              key={vital.kind}
              data-abnormal={vital.abnormal || undefined}
              className="flex items-baseline gap-1 rounded-md bg-muted px-2 py-0.5 text-xs shadow-[inset_0_0_0_1px_var(--border)] data-abnormal:shadow-[inset_0_0_0_1px_var(--warning)]"
            >
              <span aria-hidden="true" className="text-muted-foreground">
                {label.short}
              </span>
              <span className="sr-only">{label.name}</span>
              <span className={`text-[13.5px] font-semibold tabular-nums ${vital.abnormal ? 'text-warning' : ''}`}>
                {vital.value}
              </span>
              <span className="text-[11px] text-muted-foreground">{vital.unit}</span>
              {vital.abnormal && <span className="sr-only">异常</span>}
            </li>
          )
        })}
      </ul>
      <span className="text-[11px] text-muted-foreground">分诊测量</span>
    </div>
  )
}

function EncounterTimer({ startedAt, endedAt }: { startedAt: string; endedAt: string | null }) {
  const now = useNow(endedAt === null)
  const elapsed = (endedAt === null ? now : Date.parse(endedAt)) - Date.parse(startedAt)
  return (
    <span title="本次就诊时长" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
      <ClockIcon aria-hidden="true" size={13} />
      <span className="sr-only">就诊时长</span>
      {formatDuration(elapsed)}
    </span>
  )
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

function OutpatientNumber({ value }: { value: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    setTimeout(() => setCopyState('idle'), 1500)
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      门诊号 <span className="font-mono text-foreground">{value}</span>
      <Button aria-label="复制门诊号" title="复制门诊号" className={`${iconButton} size-6`} onClick={copy}>
        {copyState === 'copied' ? <CheckIcon aria-hidden="true" size={12} /> : <CopyIcon aria-hidden="true" size={12} />}
      </Button>
      <span role="status" className="sr-only">
        {copyState === 'copied' ? '已复制门诊号' : copyState === 'failed' ? '无法访问剪贴板，请手动复制' : ''}
      </span>
    </span>
  )
}
