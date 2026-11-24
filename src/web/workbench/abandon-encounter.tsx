import { useRouter } from '@tanstack/react-router'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog'
import { useState } from 'react'
import type { EncounterView } from '../../shared/encounter'
import { abandonEncounter } from '../api'

// Encounter Abandonment is a Clinical Confirmation: the confirming button is marked so the agent bridge cannot press it.
export function AbandonEncounter({ encounter }: { encounter: EncounterView }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const abandon = async () => {
    try {
      await abandonEncounter(encounter.encounterId)
    } catch (e) {
      setError(e instanceof Error ? e.message : '放弃就诊失败')
      throw e
    }
    await router.invalidate()
  }

  return (
    <AlertDialog onOpenChange={(open) => open && setError(null)}>
      <AlertDialogTrigger
        disabled={encounter.status !== 'active'}
        className="h-7 border-transparent bg-transparent px-2.5 text-xs text-destructive hover:bg-destructive/10"
      >
        放弃就诊
      </AlertDialogTrigger>
      <AlertDialogBackdrop />
      <AlertDialogContent className="max-w-[420px]">
        <div data-slot="stack">
          <p className="m-0 text-[11px] tracking-wide text-muted-foreground">CLINICAL CONFIRMATION · 医生本人确认</p>
          <AlertDialogTitle className="m-0 text-base">放弃{encounter.patient.name}的本次就诊？</AlertDialogTitle>
          <AlertDialogDescription className="m-0 text-[13px]">
            就诊冻结写入，不解锁病例真值与病例复盘，也不视为完诊。放弃后可为该患者开始新的就诊。
          </AlertDialogDescription>
          <p className="m-0 text-xs text-muted-foreground">
            由服务端原子校验并记录执行医生（practitionerId）；临床助手无法代为确认。
          </p>
          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <div data-slot="row" className="mt-4 flex justify-end gap-2">
          <AlertDialogClose>返回</AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            data-variant="solid"
            data-agent-confirm={`放弃${encounter.patient.name}的本次就诊：冻结写入，不解锁病例真值，不视为完诊`}
            action={abandon}
            className="border-destructive bg-destructive text-destructive-foreground"
          >
            确认放弃
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
