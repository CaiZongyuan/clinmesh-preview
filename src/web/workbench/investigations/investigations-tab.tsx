import { useClinicalNoteContext } from '../clinical-note/clinical-note-context'
import { NoteSuggestions } from '../clinical-note/note-suggestions'
import { Button } from '@ui-sdk/react/button'
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox'
import { Input } from '@ui-sdk/react/input'
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '@ui-sdk/react/segmented-control'
import { CheckIcon, SearchIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import {
  CATEGORY_LABEL,
  type CatalogItemView,
  type InvestigationCategory,
  type InvestigationView,
  type ReportView,
} from '../../../shared/investigation'
import { formatClock } from '../format'
import { badge, iconButton } from '../pane-styles'
import { ClinicalConfirmation } from '../clinical-confirmation'
import { InvestigationCard, type BatchSelection } from './investigation-card'
import { awaitingAcknowledgement, latestReport, type Investigations } from './use-investigations'

type CategoryFilter = InvestigationCategory | 'all'

const FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: 'all', label: '全部检查' },
  ...(Object.entries(CATEGORY_LABEL) as [InvestigationCategory, string][]).map(([value, label]) => ({ value, label })),
]

const card = 'flex flex-col gap-3 rounded-lg border bg-card p-3'

const matches = (item: CatalogItemView, query: string) =>
  !query || item.name.toLowerCase().includes(query) || item.pinyinInitials.some((initials) => initials.startsWith(query))

export function InvestigationsTab({ state, writable }: { state: Investigations; writable: boolean }) {
  const proposal = useClinicalNoteContext()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const { catalog, investigations, pending } = state

  const q = query.trim().toLowerCase()
  const shown = catalog.filter((item) => (category === 'all' || item.category === category) && matches(item, q))
  const issued = new Set(investigations.filter((i) => !i.cancellation).map((i) => i.catalogItemId))
  const pendingItems = pending.flatMap((id) => catalog.filter((item) => item.id === id))
  // Several Reports awaiting acknowledgement can be selected and acknowledged together. Selection is by Report
  // version, so a version superseded by an amendment drops out of it.
  const awaiting = investigations.filter(awaitingAcknowledgement).map((i) => ({ name: i.name, report: latestReport(i)! }))
  const batch = awaiting.length > 1 ? awaiting.filter(({ report }) => selected.includes(report.reportId)) : []
  const selectionFor = (investigation: InvestigationView): BatchSelection | null => {
    const report = latestReport(investigation)
    if (awaiting.length < 2 || !report || report.acknowledgement) return null
    const { reportId } = report
    return {
      selected: selected.includes(reportId),
      onSelectedChange: (on) => setSelected((ids) => (on ? [...ids, reportId] : ids.filter((id) => id !== reportId))),
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {state.error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {state.error}
        </p>
      )}
      <section aria-labelledby="order-heading" className={card}>
        <h3 id="order-heading" className="m-0 text-sm font-semibold">
          开立检查
        </h3>
        <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="relative">
              <SearchIcon aria-hidden="true" size={14} className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="搜索检查项目"
                placeholder="搜索项目名称或拼音首字母，如 xcg"
                value={query}
                onValueChange={(value) => setQuery(value)}
                className="w-full pl-7"
              />
            </div>
            <SegmentedControl
              aria-label="检查类别"
              value={category}
              onValueChange={(value) => setCategory(value as CategoryFilter)}
              className="self-start"
            >
              <SegmentedControlIndicator />
              {FILTERS.map((filter) => (
                <SegmentedControlItem key={filter.value} value={filter.value} className="h-7 px-3 text-xs">
                  {filter.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <ul aria-label="检查目录" className="m-0 flex max-h-72 list-none flex-col overflow-y-auto rounded-md border p-0">
              {shown.map((item) => (
                <li key={item.id} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px]">
                      {item.name}
                      <span className={`${badge} border text-muted-foreground`}>{CATEGORY_LABEL[item.category]}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {item.specimenOrSite} · {item.department} · 预计 {item.expectedTurnaround}
                    </div>
                  </div>
                  {issued.has(item.id) ? (
                    <span className="text-xs text-muted-foreground">已开立</span>
                  ) : pending.includes(item.id) ? (
                    <span className="text-xs text-muted-foreground">已在待开立</span>
                  ) : (
                    <Button
                      className="h-7 px-2.5 text-xs"
                      disabled={!writable}
                      aria-label={`加入待开立：${item.name}`}
                      onClick={(_event, details) => {
                        if (details.source === 'agent') proposal?.propose({ module: 'investigations', itemId: item.id })
                        else state.add(item.id)
                      }}
                    >
                      加入
                    </Button>
                  )}
                </li>
              ))}
              {shown.length === 0 && <li className="px-2.5 py-3 text-xs text-muted-foreground">无匹配项目</li>}
            </ul>
          </div>
          <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted p-2.5">
            <div className="flex items-center justify-between">
              <h4 className="m-0 text-xs font-semibold">待开立 {pendingItems.length}</h4>
              {pendingItems.length > 0 && (
                <Button className="h-6 border-transparent bg-transparent px-1.5 text-xs" onClick={state.clear}>
                  清空待开立
                </Button>
              )}
            </div>
            {pendingItems.length === 0 ? (
              <p className="m-0 py-3 text-center text-xs text-muted-foreground">从目录加入检查项目</p>
            ) : (
              <ul aria-label="待开立检查" className="m-0 flex list-none flex-col gap-1 p-0">
                {pendingItems.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 rounded-md bg-card px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold">{item.name}</div>
                      <div className="text-[11.5px] text-muted-foreground">
                        {item.specimenOrSite} · {item.department}
                      </div>
                    </div>
                    <Button className={iconButton} aria-label={`移除：${item.name}`} onClick={() => state.remove(item.id)}>
                      <XIcon aria-hidden="true" size={13} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <ClinicalConfirmation
              trigger={pendingItems.length ? `开立 ${pendingItems.length} 项` : '开立'}
              triggerClassName="mt-auto h-8 w-full border-primary bg-primary text-xs text-primary-foreground"
              disabled={!writable || pendingItems.length === 0}
              title={`开立 ${pendingItems.length} 项检查？`}
              confirmLabel="确认开立"
              intent={`为本次就诊开立 ${pendingItems.map((item) => item.name).join('、')}`}
              onConfirm={state.issue}
            >
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {pendingItems.map((item) => (
                  <li key={item.id}>
                    {item.name}
                    <span className="text-muted-foreground">
                      {' '}
                      · {item.specimenOrSite} · {item.department}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-2 text-muted-foreground">签发后进入执行流程，报告按检查科室流程返回。</p>
            </ClinicalConfirmation>
          </div>
        </div>
      </section>
      <NoteSuggestions module="investigations" />
      <section aria-labelledby="issued-heading" className={card}>
        <div className="flex items-center justify-between gap-2">
          <h3 id="issued-heading" className="m-0 text-sm font-semibold">
            已开立与报告 <span className="font-mono text-xs text-muted-foreground">{investigations.length}</span>
          </h3>
          <div className="flex items-center gap-2.5">
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={abnormalOnly} onCheckedChange={(checked) => setAbnormalOnly(checked === true)}>
                <CheckboxIndicator>
                  <CheckIcon aria-hidden="true" size={12} />
                </CheckboxIndicator>
              </Checkbox>
              仅看异常
            </label>
            {awaiting.length > 1 && (
              <BatchAcknowledgement
                batch={batch}
                writable={writable}
                onConfirm={async () => {
                  await state.acknowledge(batch.map(({ report }) => report.reportId))
                  setSelected([])
                }}
              />
            )}
          </div>
        </div>
        {investigations.length === 0 ? (
          <p className="m-0 py-3 text-center text-xs text-muted-foreground">尚未开立检查</p>
        ) : (
          investigations.map((investigation) => (
            <InvestigationCard
              key={investigation.investigationId}
              investigation={investigation}
              abnormalOnly={abnormalOnly}
              writable={writable}
              selection={selectionFor(investigation)}
              onReleaseNow={() => state.releaseNow(investigation.investigationId)}
              onCancel={() => state.cancel(investigation.investigationId)}
              onAcknowledge={(reportId) => state.acknowledge([reportId])}
            />
          ))
        )}
      </section>
    </div>
  )
}

interface BatchAcknowledgementProps {
  batch: { name: string; report: ReportView }[]
  writable: boolean
  onConfirm: () => Promise<void>
}

function BatchAcknowledgement({ batch, writable, onConfirm }: BatchAcknowledgementProps) {
  return (
    <ClinicalConfirmation
      trigger={batch.length ? `确认所选已阅（${batch.length}）` : '确认所选已阅'}
      triggerClassName="h-7 border-primary bg-primary px-2.5 text-xs text-primary-foreground"
      disabled={!writable || batch.length === 0}
      title={`确认 ${batch.length} 份报告已阅？`}
      confirmLabel={`确认 ${batch.length} 份已阅`}
      intent={`确认已阅 ${batch.map(({ name, report }) => `${name}第 ${report.version} 版报告`).join('、')}`}
      onConfirm={onConfirm}
    >
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {batch.map(({ name, report }) => (
          <li key={report.reportId}>
            {name} · 第 {report.version} 版（当前）
            <span className="text-muted-foreground"> · 报告时间 {formatClock(report.releasedAt)}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-2 text-muted-foreground">确认您已查看以上各份报告的当前版本。仅打开查看不构成已阅确认。</p>
    </ClinicalConfirmation>
  )
}
