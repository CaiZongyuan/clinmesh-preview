import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { UsersIcon } from 'lucide-react'
import type { GoldenCaseQueueEntry, QueueStatus } from '../../shared/golden-case-queue'

export const CLINIC_DEPARTMENT = '全科医学科门诊'

const QUEUE_GROUPS: ReadonlyArray<{ status: QueueStatus; label: string }> = [
  { status: 'in-consultation', label: '在诊' },
  { status: 'waiting', label: '待诊' },
  { status: 'completed', label: '完诊' },
]

const SEX_LABEL = { male: '男', female: '女' } as const
const VISIT_KIND_LABEL = { first: '初诊', return: '复诊' } as const
const STATUS_LABEL = Object.fromEntries(QUEUE_GROUPS.map((g) => [g.status, g.label])) as Record<QueueStatus, string>

const registrationClock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
})

export function QueueRail({ queue }: { queue: GoldenCaseQueueEntry[] }) {
  const initialGroup = queue.some((e) => e.queueStatus === 'in-consultation') ? 'in-consultation' : 'waiting'
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
          <div className="flex items-center justify-between px-1 pb-1.5">
            <PopoverTitle className="m-0 text-xs font-semibold">候诊队列 · {CLINIC_DEPARTMENT}</PopoverTitle>
          </div>
          <Tabs defaultValue={initialGroup}>
            <TabsList aria-label="候诊分组" className="grid w-full grid-cols-3">
              {QUEUE_GROUPS.map((group) => (
                <TabsTab key={group.status} value={group.status}>
                  {group.label} {queue.filter((e) => e.queueStatus === group.status).length}
                </TabsTab>
              ))}
            </TabsList>
            {QUEUE_GROUPS.map((group) => {
              const entries = queue.filter((e) => e.queueStatus === group.status)
              return (
                <TabsPanel key={group.status} value={group.status} className="pt-1">
                  {entries.length === 0 ? (
                    <p className="m-0 p-3 text-center text-xs text-muted-foreground">暂无</p>
                  ) : (
                    <ol aria-label={`${group.label}患者`} className="m-0 flex list-none flex-col gap-1 p-0">
                      {entries.map((entry) => (
                        <QueueEntryRow key={entry.caseId} entry={entry} />
                      ))}
                    </ol>
                  )}
                </TabsPanel>
              )
            })}
          </Tabs>
          <p className="m-0 border-t px-1 pt-2 text-[11px] text-muted-foreground">
            叫号、过号与转诊不在 Phase 1 范围内；一次只能有一个进行中的就诊。
          </p>
        </PopoverContent>
      </Popover>
      <span aria-hidden="true" className="h-px w-6 bg-border" />
      <ol aria-label="候诊患者" className="m-0 flex list-none flex-col items-center gap-2 p-0">
        {queue.map((entry) => (
          <li
            key={entry.caseId}
            title={`${entry.queueNumber} 号 ${entry.patientName} · ${entry.chiefComplaint}`}
            aria-label={`${entry.queueNumber} 号 ${entry.patientName} · ${STATUS_LABEL[entry.queueStatus]}`}
            className="relative grid size-9 place-items-center rounded-[9px] border bg-card text-sm"
          >
            <span aria-hidden="true">{entry.patientName[0]}</span>
            <span
              aria-hidden="true"
              className="absolute -right-1 -bottom-1 rounded bg-secondary px-[3px] font-mono text-[10px] text-muted-foreground"
            >
              {entry.queueNumber}
            </span>
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
          挂号 <time dateTime={entry.registeredAt}>{registrationClock.format(new Date(entry.registeredAt))}</time>
        </div>
      </div>
    </li>
  )
}
