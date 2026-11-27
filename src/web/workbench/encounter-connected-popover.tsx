import { useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { CalendarHeartIcon, FileCheck2Icon, FlaskConicalIcon, MessageSquareTextIcon, PillIcon, Share2Icon } from 'lucide-react'
import { useState } from 'react'
import type { EncounterView } from '../../shared/encounter'
import { createConversation, fetchStaffPatients, publishPatientRelease } from '../clinic/clinic-api'

export function EncounterConnectedPopover({ encounter }: { encounter: EncounterView }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function handlePublish(resourceType: 'clinical_note' | 'report' | 'prescription') {
    setBusy(true)
    setFeedback(null)
    try {
      const item = await publishPatientRelease({ encounterId: encounter.encounterId, resourceType })
      setFeedback({ kind: 'ok', text: `已发布给患者：${item.title}（v${item.version}）` })
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : '发布失败' })
    } finally {
      setBusy(false)
    }
  }

  async function handleMessagePatient() {
    setBusy(true)
    setFeedback(null)
    try {
      const patients = await fetchStaffPatients()
      const matched =
        patients.find((p) => p.outpatientNumber === encounter.patient.outpatientNumber) ??
        patients.find((p) => p.displayName === encounter.patient.name)
      if (!matched) {
        setFeedback({ kind: 'err', text: '当前模拟病例未关联互联患者账号，可在预约队列或患者档案中发起会话。' })
        return
      }
      await createConversation({ type: 'patient_doctor', memberActorIds: [matched.actorId] })
      await navigate({ to: '/clinic', search: { tab: 'messages' } })
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : '打开患者消息失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger className="h-7 gap-1 px-2 text-xs">
        <Share2Icon aria-hidden="true" size={13} />
        互联协同
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-[300px] max-w-[calc(100vw-32px)] p-3">
        <PopoverTitle className="m-0 pb-2 text-xs font-semibold">互联门诊协同 · {encounter.patient.name}</PopoverTitle>
        <div className="flex flex-col gap-2">
          <div className="text-[11px] text-muted-foreground">向患者小程序显式发布正式记录</div>
          <div className="grid grid-cols-3 gap-1.5">
            <Button className="h-7 px-2 text-xs" disabled={busy} onClick={() => void handlePublish('clinical_note')}>
              <FileCheck2Icon aria-hidden="true" size={12} />
              发病历
            </Button>
            <Button className="h-7 px-2 text-xs" disabled={busy} onClick={() => void handlePublish('report')}>
              <FlaskConicalIcon aria-hidden="true" size={12} />
              发报告
            </Button>
            <Button className="h-7 px-2 text-xs" disabled={busy} onClick={() => void handlePublish('prescription')}>
              <PillIcon aria-hidden="true" size={12} />
              发处方
            </Button>
          </div>

          <div className="border-t pt-2 text-[11px] text-muted-foreground">院内外沟通与随访</div>
          <div className="grid grid-cols-2 gap-1.5">
            <Button className="h-7 px-2 text-xs" disabled={busy} onClick={() => void handleMessagePatient()}>
              <MessageSquareTextIcon aria-hidden="true" size={12} />
              联系患者
            </Button>
            <Button
              className="h-7 px-2 text-xs"
              disabled={busy}
              onClick={() => void navigate({ to: '/clinic', search: { tab: 'followup' } })}
            >
              <CalendarHeartIcon aria-hidden="true" size={12} />
              随访管理
            </Button>
          </div>

          {feedback ? (
            <p
              role={feedback.kind === 'err' ? 'alert' : 'status'}
              className={`m-0 rounded border px-2 py-1.5 text-xs ${
                feedback.kind === 'err'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-success/30 bg-success/10 text-foreground'
              }`}
            >
              {feedback.text}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
