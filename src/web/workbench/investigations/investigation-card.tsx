import { Button } from '@ui-sdk/react/button'
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible'
import { CheckIcon, ChevronRightIcon, TriangleAlertIcon } from 'lucide-react'
import {
  CATEGORY_LABEL,
  INVESTIGATION_STAGES,
  type InvestigationView,
  type ReportResultRow,
  type ReportView,
  type ResultFlag,
} from '../../../shared/investigation'
import { formatClock } from '../format'
import { badge } from '../pane-styles'
import { ClinicalConfirmation } from '../clinical-confirmation'
import { latestReport } from './use-investigations'

const FLAG: Record<Exclude<ResultFlag, null>, { mark: string; hint: string }> = {
  high: { mark: ' ↑', hint: '偏高' },
  low: { mark: ' ↓', hint: '偏低' },
  abnormal: { mark: '', hint: '异常' },
}

const resultText = (row: ReportResultRow) =>
  typeof row.value === 'number' ? row.value.toFixed(row.decimals) : row.value

// Offered when several Reports await acknowledgement, so they can be acknowledged together.
export interface BatchSelection {
  selected: boolean
  onSelectedChange: (selected: boolean) => void
}

interface InvestigationCardProps {
  investigation: InvestigationView
  abnormalOnly: boolean
  writable: boolean
  selection: BatchSelection | null
  onReleaseNow: () => Promise<void>
  onCancel: () => Promise<void>
  onAcknowledge: (reportId: string) => Promise<void>
}

export function InvestigationCard(props: InvestigationCardProps) {
  const { investigation, abnormalOnly, writable, selection, onReleaseNow, onCancel, onAcknowledge } = props
  const { name, category, stages, cancellation } = investigation
  const report = latestReport(investigation)
  const reached = new Map(stages.map((stage) => [stage.name, stage.at]))
  const label = cancellation ? `${name}（已取消）` : name
  const steps = cancellation
    ? [...stages, { name: '已取消', at: cancellation.cancelledAt }]
    : INVESTIGATION_STAGES[category].map((stage) => ({ name: stage, at: reached.get(stage) }))
  return (
    <article aria-label={label} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {selection && (
            <Checkbox
              aria-label={`选择待阅：${name}`}
              checked={selection.selected}
              disabled={!writable}
              onCheckedChange={(checked) => selection.onSelectedChange(checked === true)}
            >
              <CheckboxIndicator>
                <CheckIcon aria-hidden="true" size={12} />
              </CheckboxIndicator>
            </Checkbox>
          )}
          <h4 className="m-0 text-[13px] font-semibold">{name}</h4>
          <span className={`${badge} border`}>{CATEGORY_LABEL[category]}</span>
          {cancellation ? (
            <span className={`${badge} border text-muted-foreground`}>已取消</span>
          ) : report ? (
            <>
              <span className={`${badge} border`}>第 {report.version} 版（当前）</span>
              {report.acknowledgement ? (
                <span className={`${badge} bg-success/15 text-success`}>医生已阅</span>
              ) : (
                <span className={`${badge} bg-warning/15 text-warning`}>待阅</span>
              )}
            </>
          ) : (
            <span className={`${badge} bg-warning/15 text-warning`}>
              {stages.at(-1)?.name} · 预计 {formatClock(investigation.expectedReportAt)} 出报告
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!report && !cancellation && (
            <>
              <ClinicalConfirmation
                trigger="取消"
                triggerLabel={`取消检查：${name}`}
                triggerClassName="h-7 border-transparent bg-transparent px-2.5 text-xs text-destructive hover:bg-destructive/10"
                disabled={!writable}
                title={`取消检查：${name}？`}
                confirmLabel="确认取消"
                confirmClassName="border-destructive bg-destructive text-destructive-foreground"
                intent={`取消${name}检查申请`}
                onConfirm={onCancel}
              >
                <p className="m-0">仅首份报告发布前可取消；若报告已发布，服务端将拒绝取消。</p>
                <p className="m-0 mt-1 text-muted-foreground">取消后不再出报告，也无需确认已阅；如仍需要可重新开立。</p>
              </ClinicalConfirmation>
              <Button
                className="h-7 px-2.5 text-xs"
                disabled={!writable}
                aria-label={`立即出报告：${name}`}
                title="模拟测试控件：跳过周转时间"
                onClick={onReleaseNow}
              >
                立即出报告
              </Button>
            </>
          )}
          {report && !report.acknowledgement && (
            <ClinicalConfirmation
              trigger="确认已阅"
              triggerLabel={`确认已阅：${name}`}
              triggerClassName="h-7 px-2.5 text-xs"
              disabled={!writable}
              title={`确认已阅：${name}`}
              confirmLabel="确认已阅"
              intent={`确认已阅${name}第 ${report.version} 版报告`}
              onConfirm={() => onAcknowledge(report.reportId)}
            >
              <p className="m-0">
                第 {report.version} 版（当前）· 报告时间 {formatClock(report.releasedAt)}
              </p>
              <p className="m-0 mt-1 text-muted-foreground">确认您已查看该版本报告。仅打开查看不构成已阅确认。</p>
            </ClinicalConfirmation>
          )}
        </div>
      </div>
      {report?.correctionReason && (
        <p className="m-0 flex items-center gap-1 text-xs text-warning">
          <TriangleAlertIcon aria-hidden="true" size={12} />
          更正原因：{report.correctionReason}。旧版本的已阅不延续到本版本。
        </p>
      )}
      <ol aria-label={`${label}执行进度`} className="m-0 grid list-none auto-cols-fr grid-flow-col gap-1 p-0">
        {steps.map(({ name: stage, at }) => (
          <li
            key={stage}
            data-reached={at ? '' : undefined}
            className="flex flex-col border-t-2 border-border pt-1 text-[11.5px] text-muted-foreground data-[reached]:border-success data-[reached]:text-foreground"
          >
            <span>{stage}</span>
            <span className="font-mono">{at ? formatClock(at) : '—'}</span>
          </li>
        ))}
      </ol>
      {report && (
        <Collapsible>
          <CollapsibleTrigger
            aria-label={`查看报告：${name}`}
            className="group h-6 gap-1 border-transparent bg-transparent px-0 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon aria-hidden="true" size={13} className="transition-transform group-data-[open]:rotate-90" />
            报告详情
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ReportDetail name={name} category={category} report={report} abnormalOnly={abnormalOnly} />
            {investigation.reports.length > 1 && <SupersededVersions name={name} reports={investigation.reports.slice(0, -1)} />}
          </CollapsiblePanel>
        </Collapsible>
      )}
    </article>
  )
}

function ReportDetail({
  name,
  category,
  report,
  abnormalOnly,
}: {
  name: string
  category: InvestigationView['category']
  report: ReportView
  abnormalOnly: boolean
}) {
  const { body, acknowledgement } = report
  return (
    <section aria-label={`${name}报告`} className="flex flex-col gap-2 pt-1">
      <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>第 {report.version} 版</span>
        <span>
          {category === 'lab' ? '标本' : '部位'}：{report.specimenOrSite}
        </span>
        <span>报告：{report.reporter}</span>
        <span>审核：{report.reviewer}</span>
        <span>
          报告时间 <time dateTime={report.releasedAt}>{formatClock(report.releasedAt)}</time>
        </span>
        {acknowledgement && (
          <span>
            已阅 <time dateTime={acknowledgement.acknowledgedAt}>{formatClock(acknowledgement.acknowledgedAt)}</time> ·{' '}
            {acknowledgement.practitionerId}
          </span>
        )}
      </p>
      {body.kind === 'narrative' ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">检查所见</dt>
          <dd className="m-0">{body.findings}</dd>
          <dt className="text-muted-foreground">检查结论</dt>
          <dd className="m-0 font-semibold">{body.impression}</dd>
        </dl>
      ) : (
        <ResultTable name={name} rows={abnormalOnly ? body.results.filter((row) => row.flag) : body.results} />
      )}
    </section>
  )
}

function SupersededVersions({ name, reports }: { name: string; reports: ReportView[] }) {
  return (
    <section className="flex flex-col gap-1 pt-2 text-xs text-muted-foreground">
      <h5 className="m-0 text-xs font-medium">历史版本</h5>
      <ul aria-label={`${name}历史版本`} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {reports.map((report) => (
          <li key={report.reportId}>
            第 {report.version} 版（已替代） · 报告时间 {formatClock(report.releasedAt)} ·{' '}
            {report.acknowledgement
              ? `已阅 ${formatClock(report.acknowledgement.acknowledgedAt)} · ${report.acknowledgement.practitionerId}`
              : '未阅'}
          </li>
        ))}
      </ul>
    </section>
  )
}

const cell = 'border-b px-2 py-1 text-left'

function ResultTable({ name, rows }: { name: string; rows: ReportResultRow[] }) {
  return (
    <table aria-label={`${name}结果`} className="w-full border-collapse text-[13px]">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className={`${cell} font-medium`}>项目</th>
          <th className={`${cell} text-right font-medium`}>结果</th>
          <th className={`${cell} font-medium`}>单位</th>
          <th className={`${cell} font-medium`}>参考范围</th>
          <th className={`${cell} font-medium`}>提示</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.analyteId}>
            <td className={cell}>{row.name}</td>
            <td className={`${cell} text-right font-mono ${row.flag ? 'font-semibold text-warning' : ''}`}>
              {resultText(row)}
              {row.flag && FLAG[row.flag].mark}
            </td>
            <td className={`${cell} text-xs text-muted-foreground`}>{row.unit}</td>
            <td className={`${cell} font-mono text-xs text-muted-foreground`}>{row.referenceRange}</td>
            <td className={cell}>
              {row.flag ? (
                <span className={`${badge} bg-warning/15 text-warning`}>{FLAG[row.flag].hint}</span>
              ) : (
                <span className="text-xs text-muted-foreground">正常</span>
              )}
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={5} className={`${cell} text-xs text-muted-foreground`}>
              无异常指标
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
