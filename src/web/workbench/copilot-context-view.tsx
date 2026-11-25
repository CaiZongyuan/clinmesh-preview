import { Button } from '@ui-sdk/react/button'
import { useEffect, useState } from 'react'
import { FoldVerticalIcon, Loader2Icon } from 'lucide-react'
import { CONTEXT_CATEGORY_LABEL, type ContextCategory } from '../../shared/agent-context'
import type { CopilotContextItem, CopilotContextView } from '../../shared/copilot-context'
import { compactCopilot, fetchCopilotContext } from '../api'
import { formatClockSeconds } from './format'

// The 上下文 view (#13): exactly what the Clinical Copilot sees — a usage ring against the model window with
// the compaction/output reserve, a category breakdown with per-request deltas, a per-request timeline
// reconciled with the provider's usage, an itemized browser, the always-zero Case Truth row, and manual
// compaction that never touches the live clinic or consultation context.
const CATEGORY_COLOR: Record<ContextCategory, string> = {
  system: 'bg-primary',
  tools: 'bg-info',
  patient_visible: 'bg-success',
  consultation: 'bg-warning',
  his_state_ui: 'bg-cyan-500',
  replies_thinking: 'bg-fuchsia-500',
  tool_results: 'bg-muted-foreground',
}

const compact = (n: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(n)

function UsageRing({ view }: { view: CopilotContextView }) {
  const ratio = view.usable > 0 ? Math.min(1, view.estimatedInput / view.usable) : 0
  const radius = 15.9155 // circumference 100, so the dash array is the percentage directly
  const over = view.estimatedInput > view.usable
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90" role="img" aria-label={`上下文占用 ${Math.round(ratio * 100)}%`}>
        <circle cx="18" cy="18" r={radius} fill="none" className="stroke-muted" strokeWidth="3.5" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(ratio * 100).toFixed(1)} 100`}
          className={over ? 'stroke-destructive' : 'stroke-info'}
        />
      </svg>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">预计输入</dt>
        <dd className="m-0 font-medium">{view.estimatedInput.toLocaleString()} tokens</dd>
        <dt className="text-muted-foreground">模型窗口</dt>
        <dd className="m-0">{view.modelWindow.toLocaleString()}</dd>
        <dt className="text-muted-foreground">预留（压缩与输出）</dt>
        <dd className="m-0">{view.reserve.toLocaleString()}</dd>
        <dt className="text-muted-foreground">可用</dt>
        <dd className="m-0">{view.usable.toLocaleString()}</dd>
      </dl>
    </div>
  )
}

function CategoryBar({ items }: { items: CopilotContextItem[] }) {
  const byCategory = new Map<ContextCategory, number>()
  for (const item of items) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.tokens)
  const total = [...byCategory.values()].reduce((sum, n) => sum + n, 0) || 1
  const categories = [...byCategory.entries()].filter(([, tokens]) => tokens > 0)
  return (
    <>
      <div className="flex h-2.5 w-full overflow-hidden rounded" role="img" aria-label="上下文分类占比">
        {categories.map(([category, tokens]) => (
          <div key={category} className={CATEGORY_COLOR[category]} style={{ width: `${(tokens / total) * 100}%` }} />
        ))}
      </div>
      <table className="w-full text-xs">
        <caption className="sr-only">上下文分类明细</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="font-normal">分类</th>
            <th scope="col" className="font-normal">tokens</th>
            <th scope="col" className="font-normal">占比</th>
          </tr>
        </thead>
        <tbody>
          {categories.map(([category, tokens]) => (
            <tr key={category}>
              <td className="py-0.5">
                <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${CATEGORY_COLOR[category]}`} aria-hidden="true" />
                {CONTEXT_CATEGORY_LABEL[category]}
              </td>
              <td className="tabular-nums">{tokens.toLocaleString()}</td>
              <td className="text-muted-foreground tabular-nums">{Math.round((tokens / total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function RequestTimeline({ view }: { view: CopilotContextView }) {
  if (view.requests.length === 0) return <p className="m-0 text-xs text-muted-foreground">还没有发出过大模型请求。</p>
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">逐请求上下文时间线</caption>
      <thead>
        <tr className="text-left text-muted-foreground">
          <th scope="col" className="font-normal">时间</th>
          <th scope="col" className="font-normal">请求</th>
          <th scope="col" className="font-normal">预计</th>
          <th scope="col" className="font-normal">实测（服务商）</th>
          <th scope="col" className="font-normal">Δ实测</th>
        </tr>
      </thead>
      <tbody>
        {view.requests.map((request, i) => {
          const previous = i > 0 ? view.requests[i - 1].providerInput : null
          const delta = request.providerInput !== null && previous !== null ? request.providerInput - previous : null
          return (
            <tr key={`${request.runId}-${request.step}`}>
              <td className="text-muted-foreground">{formatClockSeconds(request.at)}</td>
              <td>#{i + 1}</td>
              <td className="tabular-nums">{request.estimatedInput.toLocaleString()}</td>
              <td className="tabular-nums">{request.providerInput === null ? '…' : request.providerInput.toLocaleString()}</td>
              <td className="tabular-nums text-muted-foreground">
                {delta === null ? '' : `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ItemizedBrowser({ items }: { items: CopilotContextItem[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
      {items.map((item) => (
        <li key={item.id} className="text-xs">
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${CATEGORY_COLOR[item.category]}`} aria-hidden="true" />
              <span>{item.label}</span>
              <span className="text-muted-foreground tabular-nums">{item.tokens.toLocaleString()} tokens</span>
            </summary>
            {item.text !== undefined && (
              <pre className="copilot-args m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">{item.text}</pre>
            )}
          </details>
        </li>
      ))}
    </ol>
  )
}

export function CopilotContextDialog({ encounterId, modelLabel }: { encounterId: string; modelLabel: string | null }) {
  const [view, setView] = useState<CopilotContextView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [compacted, setCompacted] = useState<string | null>(null)

  const reload = () => void fetchCopilotContext(encounterId).then(setView).catch((e: Error) => setError(e.message))

  const compactNow = async () => {
    setCompacting(true)
    setError(null)
    setCompacted(null)
    try {
      const result = await compactCopilot(encounterId)
      setCompacted(`已压缩 ${result.summarizedMessages} 条，${compact(Math.max(0, result.tokensBefore - result.tokensAfter))} tokens 转为摘要。`)
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCompacting(false)
    }
  }

  // The dialog content mounts fresh on every open, so the view reflects the turns finished since.
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {compacted && (
        <p className="m-0 text-xs text-success" role="status">
          {compacted}
        </p>
      )}
      {view === null ? (
        <p className="m-0 text-xs text-muted-foreground" aria-busy="true">
          正在读取上下文…
        </p>
      ) : (
        <>
          <UsageRing view={view} />
          <p className="m-0 flex items-center gap-1 text-xs">
            <span className="inline-block h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
            <span className="font-medium">Case Truth</span>
            <span className="text-muted-foreground">0 tokens · 隔离（不在助手上下文中）</span>
          </p>
          <CategoryBar items={view.items} />
          <section className="flex flex-col gap-1">
            <h4 className="m-0 text-xs font-semibold">逐请求时间线</h4>
            <RequestTimeline view={view} />
          </section>
          <section className="flex flex-col gap-1">
            <h4 className="m-0 text-xs font-semibold">逐项浏览（当前上下文）</h4>
            <ItemizedBrowser items={view.items} />
          </section>
          <section className="flex flex-col gap-1">
            <h4 className="m-0 flex items-center gap-2 text-xs font-semibold">
              <FoldVerticalIcon aria-hidden="true" size={13} />
              压缩
            </h4>
            {view.compactions.length > 0 && (
              <ol className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-muted-foreground">
                {view.compactions.map((marker) => (
                  <li key={marker.markerId}>
                    {formatClockSeconds(marker.at)} · 已压缩 {marker.summarizedMessages} 条为摘要（
                    {marker.tokensBefore} → {marker.tokensAfter} tokens）
                  </li>
                ))}
              </ol>
            )}
            <p className="m-0 text-[11px] text-muted-foreground">
              压缩会把更早的回复与工具结果合并为一条摘要；就诊概况与问诊记录每次请求重新注入，不会丢失。
            </p>
            <div>
              <Button aria-label="压缩上下文" className="h-7 gap-1 px-2 text-xs" disabled={compacting} onClick={() => void compactNow()}>
                {compacting ? <Loader2Icon aria-hidden="true" size={13} className="animate-spin" /> : <FoldVerticalIcon aria-hidden="true" size={13} />}
                压缩上下文
              </Button>
            </div>
          </section>
        </>
      )}
      <p className="m-0 text-[11px] text-muted-foreground">模型 {modelLabel ?? '默认'} · 分类估算与逐请求用量已对齐（对账）</p>
    </div>
  )
}

