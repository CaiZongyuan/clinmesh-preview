import { useRouter } from '@tanstack/react-router'
import type { EncounterView } from '../../shared/encounter'
import { abandonEncounter } from '../api'
import { ClinicalConfirmation } from './clinical-confirmation'

// Encounter Abandonment is a Clinical Confirmation: the confirming button is marked so the agent bridge cannot press it.
export function AbandonEncounter({ encounter }: { encounter: EncounterView }) {
  const router = useRouter()
  const name = encounter.patient.name
  return (
    <ClinicalConfirmation
      trigger="放弃就诊"
      triggerClassName="h-7 border-transparent bg-transparent px-2.5 text-xs text-destructive hover:bg-destructive/10"
      disabled={encounter.status !== 'active'}
      title={`放弃${name}的本次就诊？`}
      confirmLabel="确认放弃"
      confirmClassName="border-destructive bg-destructive text-destructive-foreground"
      intent={`放弃${name}的本次就诊：冻结写入，不解锁病例真值，不视为完诊`}
      onConfirm={async () => {
        await abandonEncounter(encounter.encounterId)
        await router.invalidate()
      }}
    >
      就诊冻结写入，不解锁病例真值与病例复盘，也不视为完诊。放弃后可为该患者开始新的就诊。
    </ClinicalConfirmation>
  )
}
