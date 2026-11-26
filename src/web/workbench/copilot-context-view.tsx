import { Button } from '@ui-sdk/react/button'
import { Input } from '@ui-sdk/react/input'
import { createTooltipController, Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip'
import { ChartNoAxesColumnIncreasingIcon, ChevronDownIcon, DatabaseIcon, FoldVerticalIcon, LayersIcon, LockKeyholeIcon, RefreshCwIcon, SearchIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CONTEXT_CATEGORY_LABEL, type ContextCategory } from '../../shared/agent-context'
import type { CopilotContextItem, CopilotContextView, CopilotRequestBreakdown } from '../../shared/copilot-context'
import { compactCopilot, fetchCopilotContext } from '../api'
import { formatClockSeconds } from './format'
import { ActionTooltip, TOOLTIP_CLOSE_DELAY, TOOLTIP_OPEN_DELAY } from './ui-tooltip'

const categories = Object.keys(CONTEXT_CATEGORY_LABEL) as ContextCategory[]
const number = (value: number) => value.toLocaleString('en-US')
const signed = (value: number) => `${value >= 0 ? '+' : ''}${number(value)}`

function totals(items: { category: ContextCategory; tokens: number }[]) {
  const counts = new Map<ContextCategory, number>()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + item.tokens)
  return counts
}

function WindowUsage({ view }: { view: CopilotContextView }) {
  const percent = view.modelWindow > 0 ? Math.round(view.estimatedInput / view.modelWindow * 100) : 0
  const reserved = view.modelWindow > 0 ? Math.min(100, view.reserve / view.modelWindow * 100) : 0
  const used = Math.min(100, Math.max(0, percent))
  return (
    <section className="context-card window-usage">
      <div className="window-ring" role="img" aria-label={`上下文占用 ${percent}%`}>
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="20" pathLength="100" className="ring-track" />
          <circle cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${reserved} 100`} strokeDashoffset={reserved - 100} className="ring-reserve" />
          <circle cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${used} 100`} className="ring-used" />
        </svg>
        <strong>{percent}<small>%</small></strong>
      </div>
      <div><h3>预计输入</h3><b className="usage-value">{number(view.estimatedInput)}</b> <small>tokens</small>
        <p>模型窗口 {number(view.modelWindow)}</p></div>
      <dl><div><dt>预留（压缩与输出）</dt><dd>{number(view.reserve)}</dd></div>
        <div><dt>可用预算</dt><dd>{number(view.usable)}</dd></div></dl>
    </section>
  )
}

function Composition({ view, category, select }: { view: CopilotContextView; category: ContextCategory | null; select: (value: ContextCategory | null) => void }) {
  const counts = totals(view.items)
  return (
    <section className="context-card">
      <h3><LayersIcon />上下文组成</h3>
      <div className="composition-bar" role="img" aria-label="上下文分类占比">
        {categories.map((key) => <span key={key} data-category={key} style={{ flexGrow: counts.get(key) ?? 0 }} />)}
      </div>
      <table className="composition-table">
        <caption className="sr-only">上下文分类明细</caption>
        <thead><tr><th>分类</th><th>tokens</th><th>占比</th></tr></thead>
        <tbody>{categories.map((key) => {
          const value = counts.get(key) ?? 0
          return <tr key={key} data-selected={category === key || undefined}>
            <th scope="row"><Button className="category-filter" aria-label={`筛选${CONTEXT_CATEGORY_LABEL[key]}`}
              aria-pressed={category === key} onClick={() => select(category === key ? null : key)}>
              <i data-category={key} />{CONTEXT_CATEGORY_LABEL[key]}</Button></th>
            <td>{number(value)}</td><td>{view.estimatedInput ? Math.round(value / view.estimatedInput * 100) : 0}%</td>
          </tr>
        })}</tbody>
      </table>
      <div className="truth-row"><LockKeyholeIcon size={13} /><strong>Case Truth</strong><span>{view.caseTruth.tokens} tokens · 隔离</span></div>
    </section>
  )
}

const requestKey = (request: CopilotRequestBreakdown) => `${request.runId}-${request.step}`

function RequestTimeline({ requests }: { requests: CopilotRequestBreakdown[] }) {
  const [selection, setSelection] = useState<string | null>(null)
  const [barTip] = useState(() => createTooltipController<string>())
  const index = selection === null ? -1 : requests.findIndex((request) => requestKey(request) === selection)
  const selected = index < 0 ? requests.length - 1 : index
  const current = requests[selected]
  const previous = requests[selected - 1]
  const peak = requests.reduce((max, item) => Math.max(max, item.providerInput ?? item.estimatedInput), 1)
  const comparable = current?.reconciled && previous?.reconciled
  const before = totals(previous?.reconciled ?? [])
  const selectedCounts = totals(current?.reconciled ?? current?.items ?? [])
  return (
    <section className="context-card">
      <h3><ChartNoAxesColumnIncreasingIcon />逐请求时间线 <small>{requests.length} 次请求</small></h3>
      {current ? <>
        <div className="request-plot" aria-label="各次请求的输入 tokens">
          {requests.map((request, i) => {
            const value = request.providerInput ?? request.estimatedInput
            const breakdown = totals(request.reconciled ?? request.items)
            const tip = `#${i + 1} · ${number(value)} tokens${request.providerInput === null ? '（估算）' : ''}`
            return (
              <TooltipTrigger
                key={requestKey(request)}
                controller={barTip}
                payload={tip}
                render={
                  <Button
                    aria-label={`查看第 ${i + 1} 次请求`}
                    aria-pressed={i === selected}
                    onClick={() => setSelection(requestKey(request))}
                  />
                }
              >
                <span className="request-bars"><span className="request-bar" style={{ height: `${Math.max(4, value / peak * 100)}%` }}>
                  {categories.map((key) => <i key={key} data-category={key} style={{ flexGrow: breakdown.get(key) ?? 0 }} />)}
                </span></span>
                <small>{i + 1}</small>
              </TooltipTrigger>
            )
          })}
          <Tooltip controller={barTip} delay={TOOLTIP_OPEN_DELAY} closeDelay={TOOLTIP_CLOSE_DELAY} type="description">
            <TooltipContent<string> side="top" sideOffset={6} className="cm-tooltip">
              {({ payload }) => payload}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="request-caption"><strong>请求 #{selected + 1}</strong><time>{formatClockSeconds(current.at)}</time></div>
        <dl className="request-stats"><div><dt>预计输入</dt><dd>{number(current.estimatedInput)}</dd></div>
          <div><dt>服务商实测</dt><dd>{current.providerInput === null ? '未报告' : number(current.providerInput)}</dd></div>
          <div><dt>较上次实测</dt><dd>{previous?.providerInput != null && current.providerInput !== null ? signed(current.providerInput - previous.providerInput) : '—'}</dd></div></dl>
        <details className="request-details" key={requestKey(current)}><summary>请求明细 <ChevronDownIcon size={13} /></summary>
          <p>{current.reconciled ? '分类对账（按实测输入分摊）' : '分类估算'}</p>
          {categories.map((key) => {
            const value = selectedCounts.get(key) ?? 0
            return <div key={key}><span><i data-category={key} />{CONTEXT_CATEGORY_LABEL[key]}</span><b>{number(value)}</b>
              {comparable && <small>Δ {signed(value - (before.get(key) ?? 0))}</small>}</div>
          })}
          <p>逐项计数</p>
          {current.items.map((item) => <div key={item.id}><span>{item.label}</span><b>{number(item.tokens)}</b></div>)}
        </details>
      </> : <p className="context-empty">还没有发出过大模型请求。</p>}
    </section>
  )
}

function ItemBrowser({ items, category, clear }: { items: CopilotContextItem[]; category: ContextCategory | null; clear: () => void }) {
  const [query, setQuery] = useState('')
  const term = query.trim().toLocaleLowerCase()
  const visible = items.filter((item) => (!category || item.category === category)
    && (!term || `${item.label} ${item.text ?? ''}`.toLocaleLowerCase().includes(term)))
  return (
    <section className="context-card item-browser">
      <h3><DatabaseIcon />逐项浏览 <small>{visible.length} / {items.length} 项</small></h3>
      <label className="context-search"><SearchIcon size={14} /><Input aria-label="搜索上下文条目" placeholder="搜索名称或内容" value={query} onValueChange={setQuery} /></label>
      {category && <Button className="filter-chip" onClick={clear} aria-label="清除分类筛选">{CONTEXT_CATEGORY_LABEL[category]} ×</Button>}
      {visible.length === 0 && <p className="context-empty">没有匹配的条目</p>}
      <ol>{visible.map((item) => <li key={item.id}><details>
        <summary><i data-category={item.category} /><span>{item.label}</span><small>{number(item.tokens)} tokens</small><ChevronDownIcon size={12} /></summary>
        <pre>{item.text}</pre>
      </details></li>)}</ol>
    </section>
  )
}

export function CopilotContextViewPanel({ encounterId, modelLabel, revision, writable }: {
  encounterId: string; modelLabel: string | null; revision: string; writable: boolean
}) {
  const [view, setView] = useState<CopilotContextView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [category, setCategory] = useState<ContextCategory | null>(null)
  useEffect(() => {
    let active = true
    fetchCopilotContext(encounterId).then((next) => {
      if (active) { setView(next); setError('') }
    }).catch((e: Error) => { if (active) setError(e.message) })
    return () => { active = false }
  }, [encounterId, revision, modelLabel, refresh])
  const compact = async () => {
    setSubmitting(true)
    setNotice('')
    try {
      await compactCopilot(encounterId)
      setNotice('已加入压缩队列')
      setRefresh((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="context-dashboard">
      <div className="context-toolbar"><span>当前模型 <b>{modelLabel ?? '默认'}</b></span>
        <ActionTooltip label="刷新上下文" side="left">
          <Button aria-label="刷新上下文" onClick={() => setRefresh((n) => n + 1)}><RefreshCwIcon aria-hidden="true" size={14} /></Button>
        </ActionTooltip></div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {view ? <>
        <WindowUsage view={view} />
        <Composition view={view} category={category} select={setCategory} />
        <RequestTimeline requests={view.requests} />
        <ItemBrowser items={view.items} category={category} clear={() => setCategory(null)} />
        <section className="context-card compaction-card">
          <h3><FoldVerticalIcon />压缩记录 <small>{view.compactions.length} 条</small></h3>
          <p>将较早的回复和工具结果整理为摘要，保留本次就诊和问诊记录。</p>
          {view.compactions.map((marker) => <details key={marker.markerId}><summary>
            {formatClockSeconds(marker.at)} · 已压缩 {marker.summarizedMessages} 条（{number(marker.tokensBefore)} → {number(marker.tokensAfter)} tokens）
          </summary><p>{marker.summary}</p></details>)}
          {writable && <Button aria-label="压缩上下文" disabled={submitting} onClick={() => void compact()}><FoldVerticalIcon size={14} />压缩上下文</Button>}
          {notice && <p role="status">{notice}</p>}
        </section>
      </> : !error && <p aria-busy="true">正在读取上下文…</p>}
    </div>
  )
}
