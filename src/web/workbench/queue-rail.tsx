import { useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { createTooltipController, Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip'
import { ChevronRightIcon, UsersIcon } from 'lucide-react'
import { useState } from 'react'
import type { GoldenCaseQueueEntry, QueueStatus } from '../../shared/golden-case-queue'
import { formatClock, SEX_LABEL, VISIT_KIND_LABEL } from './format'
import { ActionTooltip, TOOLTIP_CLOSE_DELAY } from './ui-tooltip'

export const CLINIC_DEPARTMENT = '全科医学科门诊'

const GROUPS: readonly QueueStatus[] = ['in-encounter', 'waiting', 'completed']
const STATUS: Record<QueueStatus, string> = { 'in-encounter': '在诊', waiting: '待诊', completed: '完诊' }
const entryName = (entry: GoldenCaseQueueEntry) => `${entry.queueNumber} 号 ${entry.patientName} · ${STATUS[entry.queueStatus]}`

function useOpenCase() {
  const navigate = useNavigate()
  return (entry: GoldenCaseQueueEntry) =>
    entry.queueStatus === 'completed' && entry.completedEncounterId
      ? navigate({ to: '/encounters/$encounterId', params: { encounterId: entry.completedEncounterId } })
      : navigate({ to: '/', search: entry.queueStatus === 'in-encounter' ? {} : { case: entry.caseId } })
}

export function QueueList({ queue, selected, onSelect }: {
  queue: GoldenCaseQueueEntry[]
  selected?: GoldenCaseQueueEntry
  onSelect?: () => void
}) {
  const openCase = useOpenCase()
  const initial = selected?.queueStatus ?? GROUPS.find((status) => queue.some((entry) => entry.queueStatus === status)) ?? 'waiting'
  return (
    <Tabs defaultValue={initial} className="queue-list">
      <TabsList aria-label="候诊分组" className="section-tabs">
        {GROUPS.map((status) => (
          <TabsTab value={status} key={status}>{STATUS[status]} <span>{queue.filter((entry) => entry.queueStatus === status).length}</span></TabsTab>
        ))}
      </TabsList>
      {GROUPS.map((status) => {
        const entries = queue.filter((entry) => entry.queueStatus === status)
        return (
          <TabsPanel key={status} value={status}>
            {entries.length === 0 ? <p className="queue-empty">暂无{STATUS[status]}患者</p> : (
              <ol aria-label={`${STATUS[status]}患者`}>
                {entries.map((entry) => (
                  <li key={entry.caseId}>
                    <Button className="queue-row" aria-label={entryName(entry)} aria-current={entry.caseId === selected?.caseId || undefined}
                      onClick={() => { onSelect?.(); void openCase(entry) }}>
                      <span className="queue-ticket">{String(entry.queueNumber).padStart(2, '0')}<span className="sr-only"> 号</span></span>
                      <span className="queue-patient"><strong>{entry.patientName}</strong><small>{SEX_LABEL[entry.sex]} {entry.age} 岁 · {VISIT_KIND_LABEL[entry.visitKind]}</small></span>
                      <span className="queue-complaint">{entry.chiefComplaint}</span>
                      <time dateTime={entry.registeredAt}><span className="sr-only">挂号 </span>{formatClock(entry.registeredAt)}</time>
                      <ChevronRightIcon size={15} aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </TabsPanel>
        )
      })}
    </Tabs>
  )
}

export function QueueRail({ queue, focusedCaseId }: { queue: GoldenCaseQueueEntry[]; focusedCaseId?: string }) {
  const openCase = useOpenCase()
  const [open, setOpen] = useState(false)
  const [patientTip] = useState(() => createTooltipController<GoldenCaseQueueEntry>())
  return (
    <nav aria-label="候诊队列" className="queue-rail">
      <Popover open={open} onOpenChange={setOpen}>
        <ActionTooltip label="候诊队列" side="right" sideOffset={8}>
          <PopoverTrigger aria-label="打开候诊队列" className="rail-trigger">
            <UsersIcon aria-hidden="true" size={18} />
          </PopoverTrigger>
        </ActionTooltip>
        <PopoverContent side="right" align="start" sideOffset={8} className="queue-popover">
          <PopoverTitle>候诊队列</PopoverTitle>
          <QueueList queue={queue} selected={queue.find((entry) => entry.caseId === focusedCaseId)} onSelect={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      <ol aria-label="候诊患者">
        {queue.map((entry) => (
          <li key={entry.caseId}>
            <TooltipTrigger
              controller={patientTip}
              payload={entry}
              render={
                <Button
                  aria-label={entryName(entry)}
                  aria-current={entry.caseId === focusedCaseId || undefined}
                  className="rail-patient"
                  onClick={() => void openCase(entry)}
                />
              }
            >
              <strong>{entry.patientName[0]}</strong>
              <small>{String(entry.queueNumber).padStart(2, '0')}</small>
            </TooltipTrigger>
          </li>
        ))}
      </ol>
      <Tooltip controller={patientTip} delay={450} closeDelay={TOOLTIP_CLOSE_DELAY} type="description">
        <TooltipContent<GoldenCaseQueueEntry> side="right" sideOffset={10} className="cm-rail-tooltip">
          {({ payload }) => payload ? (
            <>
              <div className="rail-tooltip-head">
                <span className="rail-tooltip-num">#{String(payload.queueNumber).padStart(2, '0')}</span>
                <strong>{payload.patientName}</strong>
                <span className="rail-tooltip-status" data-status={payload.queueStatus}>
                  {STATUS[payload.queueStatus]}
                </span>
              </div>
              <div className="rail-tooltip-meta">
                {SEX_LABEL[payload.sex]} · {payload.age} 岁 · {VISIT_KIND_LABEL[payload.visitKind]} · 挂号 {formatClock(payload.registeredAt)}
              </div>
              <div className="rail-tooltip-complaint">{payload.chiefComplaint}</div>
            </>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </nav>
  )
}
