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
import { CATEGORY_LABEL, type CatalogItemView, type InvestigationCategory } from '../../../shared/investigation'
import { badge, iconButton } from '../pane-styles'
import { ClinicalConfirmation } from '../clinical-confirmation'
import { InvestigationCard } from './investigation-card'
import type { Investigations } from './use-investigations'

type CategoryFilter = InvestigationCategory | 'all'

const FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  ...(Object.entries(CATEGORY_LABEL) as [InvestigationCategory, string][]).map(([value, label]) => ({ value, label })),
]

const card = 'flex flex-col gap-3 rounded-lg border bg-card p-3'

const matches = (item: CatalogItemView, query: string) =>
  !query || item.name.toLowerCase().includes(query) || item.pinyinInitials.some((initials) => initials.startsWith(query))

export function InvestigationsTab({ state, writable }: { state: Investigations; writable: boolean }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const { catalog, investigations, pending } = state

  const q = query.trim().toLowerCase()
  const shown = catalog.filter((item) => (category === 'all' || item.category === category) && matches(item, q))
  const issued = new Set(investigations.map((i) => i.catalogItemId))
  const pendingItems = pending.flatMap((id) => catalog.filter((item) => item.id === id))

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
                      onClick={() => state.add(item.id)}
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
      <section aria-labelledby="issued-heading" className={card}>
        <div className="flex items-center justify-between gap-2">
          <h3 id="issued-heading" className="m-0 text-sm font-semibold">
            已开立与报告 <span className="font-mono text-xs text-muted-foreground">{investigations.length}</span>
          </h3>
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox checked={abnormalOnly} onCheckedChange={(checked) => setAbnormalOnly(checked === true)}>
              <CheckboxIndicator>
                <CheckIcon aria-hidden="true" size={12} />
              </CheckboxIndicator>
            </Checkbox>
            仅看异常
          </label>
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
              onReleaseNow={() => state.releaseNow(investigation.investigationId)}
              onAcknowledge={(reportId) => state.acknowledge([reportId])}
            />
          ))
        )}
      </section>
    </div>
  )
}
