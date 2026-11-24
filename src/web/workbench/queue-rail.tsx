import { useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { UsersIcon } from 'lucide-react'
import type { GoldenCaseQueueEntry, QueueStatus } from '../../shared/golden-case-queue'
import { formatClock, SEX_LABEL, VISIT_KIND_LABEL } from './format'

export const CLINIC_DEPARTMENT = '全科医学科门诊'

const QUEUE_GROUPS: readonly QueueStatus[] = ['in-encounter', 'waiting', 'completed']
const STATUS_LABEL: Record<QueueStatus, string> = { 'in-encounter': '在诊', waiting: '待诊', completed: '完诊' }

export function QueueRail({ queue, focusedCaseId }: { queue: GoldenCaseQueueEntry[]; focusedCaseId?: string }) {
  const navigate = useNavigate()
  // The workbench root opens the active Encounter by itself; a waiting patient opens their registration.
  const open = (entry: GoldenCaseQueueEntry) =>
    navigate({ to: '/', search: entry.queueStatus === 'in-encounter' ? {} : { case: entry.caseId } })
  const groups = QUEUE_GROUPS.map((status) => ({
    status,
    label: STATUS_LABEL[status],
    entries: queue.filter((e) => e.queueStatus === status),
  }))
  const initialGroup = queue.some((e) => e.queueStatus === 'in-encounter') ? 'in-encounter' : 'waiting'
  return (
    <nav aria-label="候诊队列" className="flex w-[52px] flex-none flex-col items-center gap-2 pr-2">
      <Popover>
        <PopoverTrigger
          aria-label="打开候诊队列"
          className="border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <UsersIcon aria-hidden="true" size={16} />
        </PopoverTrigger>
        <PopoverContent side="right" align="start" className="w-[300px] p-2">
          <PopoverTitle className="m-0 px-1 pb-1.5 text-xs font-semibold">候诊队列 · {CLINIC_DEPARTMENT}</PopoverTitle>
          <Tabs defaultValue={initialGroup}>
            <TabsList aria-label="候诊分组" className="grid w-full grid-cols-3">
              {groups.map((group) => (
                <TabsTab key={group.status} value={group.status}>
                  {group.label} {group.entries.length}
                </TabsTab>
              ))}
            </TabsList>
            {groups.map((group) => (
              <TabsPanel key={group.status} value={group.status} className="pt-1">
                {group.entries.length === 0 ? (
                  <p className="m-0 p-3 text-center text-xs text-muted-foreground">暂无</p>
                ) : (
                  <ol aria-label={`${group.label}患者`} className="m-0 flex list-none flex-col gap-1 p-0">
                    {group.entries.map((entry) => (
                      <QueueEntryRow key={entry.caseId} entry={entry} />
                    ))}
                  </ol>
                )}
              </TabsPanel>
            ))}
          </Tabs>
          <p className="m-0 border-t px-1 pt-2 text-[11px] text-muted-foreground">
            叫号、过号与转诊不在 Phase 1 范围内；一次只能有一个进行中的就诊。
          </p>
        </PopoverContent>
      </Popover>
      <span aria-hidden="true" className="h-px w-6 bg-border" />
      <ol aria-label="候诊患者" className="m-0 flex list-none flex-col items-center gap-2 p-0">
        {queue.map((entry) => (
          <li key={entry.caseId}>
            <Button
              title={`${entry.queueNumber} 号 ${entry.patientName} · ${entry.chiefComplaint}`}
              aria-label={`${entry.queueNumber} 号 ${entry.patientName} · ${STATUS_LABEL[entry.queueStatus]}`}
              aria-current={entry.caseId === focusedCaseId ? 'true' : undefined}
              onClick={() => open(entry)}
              className="relative grid size-9 place-items-center rounded-[9px] border bg-card p-0 text-sm aria-[current=true]:border-foreground aria-[current=true]:shadow-[inset_0_0_0_1px_var(--foreground)]"
            >
              <span aria-hidden="true">{entry.patientName[0]}</span>
              <span
                aria-hidden="true"
                className="absolute -right-1 -bottom-1 rounded bg-secondary px-[3px] font-mono text-[10px] text-muted-foreground"
              >
                {entry.queueNumber}
              </span>
              {entry.queueStatus === 'in-encounter' && (
                <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-success" />
              )}
            </Button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function QueueEntryRow({ entry }: { entry: GoldenCaseQueueEntry }) {
  return (
    <li className="flex items-start gap-2.5 rounded-md p-2 text-[13px]">
      <span className="w-[18px] pt-px font-mono text-muted-foreground">
        {entry.queueNumber}
        <span className="sr-only"> 号</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <b className="font-semibold">{entry.patientName}</b>
          <span className="text-xs text-muted-foreground">
            {SEX_LABEL[entry.sex]} {entry.age} 岁
          </span>
          <span className="inline-flex h-[18px] items-center rounded-md border px-[5px] text-[11px]">
            {VISIT_KIND_LABEL[entry.visitKind]}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">{entry.chiefComplaint}</div>
        <div className="text-[11px] text-muted-foreground">
          挂号 <time dateTime={entry.registeredAt}>{formatClock(entry.registeredAt)}</time>
        </div>
      </div>
    </li>
  )
}
