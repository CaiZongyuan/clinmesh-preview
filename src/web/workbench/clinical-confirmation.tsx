import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog'
import { useState, type ReactNode } from 'react'

interface ClinicalConfirmationProps {
  trigger: ReactNode
  triggerLabel?: string
  triggerClassName?: string
  disabled?: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  confirmClassName?: string
  // What the doctor approves; the confirming button carries it in data-agent-confirm so the agent bridge cannot press it.
  intent: string
  onConfirm: () => Promise<void>
}

export function ClinicalConfirmation(props: ClinicalConfirmationProps) {
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    try {
      await props.onConfirm()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
      throw e
    }
  }
  return (
    <AlertDialog onOpenChange={(open) => open && setError(null)}>
      <AlertDialogTrigger disabled={props.disabled} aria-label={props.triggerLabel} className={props.triggerClassName}>
        {props.trigger}
      </AlertDialogTrigger>
      <AlertDialogBackdrop />
      <AlertDialogContent className="max-w-[440px]">
        <div data-slot="stack">
          <p className="m-0 text-[11px] tracking-wide text-muted-foreground">CLINICAL CONFIRMATION · 医生本人确认</p>
          <AlertDialogTitle className="m-0 text-base">{props.title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="m-0 text-[13px]">
            {props.children}
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
            data-agent-confirm={props.intent}
            action={confirm}
            className={props.confirmClassName}
          >
            {props.confirmLabel}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
