import { useRouter } from '@tanstack/react-router'
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { CheckIcon, CircleIcon } from 'lucide-react'
import { COMPLETION_GATE_LABELS, type CompletionGate } from '../../shared/completion'
import type { EncounterView } from '../../shared/encounter'
import { completeEncounter } from '../api'
import { ClinicalConfirmation } from './clinical-confirmation'

export type ClinicalTab = 'note' | 'investigations' | 'diagnosis' | 'prescription' | 'debrief'

const GATE_LINK: Partial<Record<CompletionGate['id'], { tab: ClinicalTab; name: string }>> = {
  'primary-diagnosis': { tab: 'diagnosis', name: '诊断' },
  reports: { tab: 'investigations', name: '检验检查' },
  medication: { tab: 'prescription', name: '处方' },
  'signed-note': { tab: 'note', name: '病历记录' },
}

export function CompletionChecklist({
  location, gates, draftTabs, onSelect,
}: {
  location: 'banner' | 'footer'
  gates: CompletionGate[]
  draftTabs: { tab: ClinicalTab; name: string }[]
  onSelect: (tab: ClinicalTab) => void
}) {
  const count = gates.filter((gate) => gate.met).length
  const label = location === 'banner' ? '患者完诊清单' : '完诊清单'
  return (
    <Popover>
      <PopoverTrigger aria-label={`${label} ${count}/${gates.length}`} className="h-7 px-2 text-xs">
        完诊 <b className="ml-1 font-mono tabular-nums">{count}/{gates.length}</b>
      </PopoverTrigger>
      <PopoverContent side={location === 'banner' ? 'bottom' : 'top'} align="start" className="max-w-[320px] p-3">
        <PopoverTitle className="m-0 text-sm font-semibold">{label}</PopoverTitle>
        <ul className="m-0 mt-2 grid list-none gap-2 p-0 text-xs">
          {gates.map((gate) => {
            const link = GATE_LINK[gate.id]
            const links = gate.id === 'drafts' ? draftTabs : link ? [link] : []
            const Mark = gate.met ? CheckIcon : CircleIcon
            return (
              <li key={gate.id} className="flex items-start gap-2">
                <Mark aria-hidden="true" size={14} className={gate.met ? 'text-success' : 'text-muted-foreground'} />
                <div className="flex-1">
                  <span className="sr-only">{gate.met ? '已满足' : '未满足'} </span>
                  <strong>{COMPLETION_GATE_LABELS[gate.id]}</strong>
                  <div className="text-muted-foreground">{gate.detail}</div>
                  {!gate.met && links.map(({ tab, name }) => (
                    <PopoverClose key={tab} className="mt-1 mr-1 h-6 px-1.5 text-[11px]" onClick={() => onSelect(tab)}>
                      前往{name}
                    </PopoverClose>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

export function CompleteEncounter({
  encounter, ready, saving, flush, onCompleted,
}: {
  encounter: EncounterView
  ready: boolean
  saving: boolean
  flush: () => Promise<void>
  onCompleted: () => void
}) {
  const router = useRouter()
  return (
    <ClinicalConfirmation
      trigger="确认完诊"
      triggerClassName={ready
        ? 'h-7 border-primary bg-primary px-2.5 text-xs text-primary-foreground'
        : 'h-7 border-dashed px-2.5 text-xs text-muted-foreground'}
      disabled={saving}
      title={`确认${encounter.patient.name}的本次就诊完诊？`}
      intent={`完诊并冻结${encounter.patient.name}的本次就诊`}
      confirmLabel="办理完诊"
      onConfirm={async () => {
        await flush()
        await completeEncounter(encounter.encounterId)
        onCompleted()
        await router.invalidate()
      }}
    >
      服务端将重新检查五项完诊条件。完诊后临床记录冻结，并开放病例复盘。
    </ClinicalConfirmation>
  )
}
