import { Button } from '@ui-sdk/react/button'
import { CheckIcon, ClockIcon, CopyIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { EncounterStatus, EncounterView, VitalSign, VitalSignKind } from '../../shared/encounter'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { formatClock, formatDuration, SEX_LABEL, VISIT_KIND_LABEL } from './format'
import { HealthRecordPopover } from './health-record'
import { badge, iconButton } from './pane-styles'
import { ActionTooltip } from './ui-tooltip'

const STATUS_LABEL: Record<EncounterStatus, string> = { active: '就诊中', abandoned: '已放弃', completed: '已完诊 · 只读' }

const FLAG_MARK = { high: { mark: '↑', name: '偏高' }, low: { mark: '↓', name: '偏低' } } as const

const VITAL_LABEL: Record<VitalSignKind, { short: string; name: string }> = {
  temperature: { short: 'T', name: '体温' },
  pulse: { short: 'P', name: '脉搏' },
  'respiratory-rate': { short: 'R', name: '呼吸' },
  'blood-pressure': { short: 'BP', name: '血压' },
  spo2: { short: 'SpO₂', name: '血氧饱和度' },
}

export function PatientBanner({
  encounter,
  examinedVitals,
  completion,
}: {
  encounter: EncounterView
  examinedVitals?: PhysicalExaminationView
  completion?: ReactNode
}) {
  const { patient, triage, visibleSourceHistory: history } = encounter
  const hasClinicalFlags = history.allergies.length > 0 || history.chronicConditions.length > 0
  return (
    <section aria-label="患者信息" className="patient-banner">
      <div className="patient-banner-top">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <h2 className="m-0 text-[15.5px] font-semibold tracking-tight">{patient.name}</h2>
          <span className="text-xs text-muted-foreground">
            {SEX_LABEL[patient.sex]} · {patient.age} 岁
          </span>
          <span className={`${badge} border`}>{VISIT_KIND_LABEL[patient.visitKind]}</span>
          <span className={`${badge} bg-warning/15 text-warning`}>分诊 {triage.level} 级</span>
          <span className={`${badge} bg-secondary text-secondary-foreground`}>{STATUS_LABEL[encounter.status]}</span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <EncounterTimer startedAt={encounter.startedAt} endedAt={encounter.endedAt} />
          <HealthRecordPopover history={history} />
        </div>
      </div>
      {hasClinicalFlags && (
        <div className="flex flex-wrap items-center gap-1.5">
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
            <span key={condition.code} className={`${badge} border border-warning/45 bg-warning/5 text-warning`}>
              慢病：{condition.display}
            </span>
          ))}
        </div>
      )}
      <div className="patient-banner-meta">
        <OutpatientNumber value={patient.outpatientNumber} />
        <span>
          挂号 <time dateTime={patient.registeredAt}>{formatClock(patient.registeredAt)}</time>
        </span>
        <span>{patient.department}</span>
        <span>{patient.insurance}</span>
        <span className="basis-full text-[12px] leading-snug">
          主诉：<span className="font-medium text-foreground">{patient.chiefComplaint}</span>
        </span>
      </div>
      <div className="patient-banner-vitals">
        {examinedVitals?.vitals ? (
          <VitalSignTiles source="查体" measuredAt={examinedVitals.examinedAt} vitals={examinedVitals.vitals} />
        ) : (
          <VitalSignTiles source="分诊" measuredAt={triage.measuredAt} vitals={triage.vitals} />
        )}
        {completion && <div className="ml-auto flex-none">{completion}</div>}
      </div>
    </section>
  )
}

// The latest reading wins the tiles: triage until the vitals Physical Examination, which leaves triage on record.
function VitalSignTiles({ source, measuredAt, vitals }: { source: '分诊' | '查体'; measuredAt: string; vitals: VitalSign[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <ul aria-label={`${source}生命体征`} className="m-0 flex list-none flex-wrap gap-1 p-0">
        {vitals.map((vital) => {
          const label = VITAL_LABEL[vital.kind]
          return (
            <li
              key={vital.kind}
              data-flag={vital.flag ?? undefined}
              className="patient-vital-tile"
            >
              <span aria-hidden="true" className="text-muted-foreground">
                {label.short}
              </span>
              <span className="sr-only">{label.name}</span>
              <span className={`text-[12px] font-semibold tabular-nums ${vital.flag ? 'text-warning' : 'text-foreground'}`}>
                {vital.value}
              </span>
              <span className="text-[10.5px] text-muted-foreground">{vital.unit}</span>
              {vital.flag && (
                <>
                  <span aria-hidden="true" className="font-semibold text-warning">
                    {FLAG_MARK[vital.flag].mark}
                  </span>
                  <span className="sr-only">{FLAG_MARK[vital.flag].name}</span>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <span className="ml-0.5 text-[11px] text-muted-foreground">
        {source} <time dateTime={measuredAt}>{formatClock(measuredAt)}</time>
      </span>
    </div>
  )
}

function EncounterTimer({ startedAt, endedAt }: { startedAt: string; endedAt: string | null }) {
  const now = useNow(endedAt === null)
  const elapsed = (endedAt === null ? now : Date.parse(endedAt)) - Date.parse(startedAt)
  return (
    <span title="本次就诊时长" className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
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
    <span className="inline-flex items-center gap-1">
      门诊号 <span className="font-mono text-foreground">{value}</span>
      <ActionTooltip
        label={copyState === 'copied' ? '已复制' : '复制门诊号'}
        closeOnPress={false}
        side="bottom"
      >
        <Button aria-label="复制门诊号" className={`${iconButton} size-5.5`} onClick={copy}>
          {copyState === 'copied'
            ? <CheckIcon aria-hidden="true" size={12} className="text-success" />
            : <CopyIcon aria-hidden="true" size={12} />}
        </Button>
      </ActionTooltip>
      <span role="status" aria-label="复制状态" className="sr-only">
        {copyState === 'copied' ? '已复制门诊号' : copyState === 'failed' ? '无法访问剪贴板，请手动复制' : ''}
      </span>
    </span>
  )
}
