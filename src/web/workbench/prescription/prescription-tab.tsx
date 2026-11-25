import { Button } from '@ui-sdk/react/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from '@ui-sdk/react/combobox'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { BookOpenIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import type { EncounterView } from '../../../shared/encounter'
import {
  ALLERGY_TAG_LABEL,
  CROSS_ALLERGY,
  CROSS_ALLERGY_REASONS,
  MAX_MEDICATION_DAYS,
  MEDICATION_FREQUENCIES,
  MEDICATION_ROUTES,
  MIN_MEDICATION_DAYS,
  MIN_OVERRIDE_NOTE_LENGTH,
  totalQuantity,
  type MedicationCatalogItemView,
  type MedicationFrequency,
  type MedicationRoute,
} from '../../../shared/medication'
import { ClinicalConfirmation } from '../clinical-confirmation'
import { formatClock } from '../format'
import { badge } from '../pane-styles'
import type { DraftLine, PrescriptionsState } from './use-prescriptions'

const card = 'flex flex-col gap-3 rounded-lg border bg-card p-3'
const numIn = 'h-8 w-16 rounded-md border bg-background px-2 text-[13px]'
const select = 'h-8 rounded-md border bg-background px-2 text-[13px]'

export function PrescriptionTab({ encounter, state }: { encounter: EncounterView; state: PrescriptionsState }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [mode, setMode] = useState<'rx' | 'nomed'>('rx')
  const writable = state.writable && encounter.status === 'active'
  const { lines, noMedication } = state.view

  // A cephalosporin in a penicillin-allergic patient needs the acceptance before the server will issue.
  const crossLines = state.draft.filter((line) => state.crossDrugIds.includes(line.drugId))
  const overrideAccepted =
    crossLines.length === 0 ||
    ((CROSS_ALLERGY_REASONS as readonly string[]).includes(reason) && note.trim().length >= MIN_OVERRIDE_NOTE_LENGTH)

  const issue = async () => {
    await state.issue({ reason, note: note.trim() })
    setReason('')
    setNote('')
  }

  const lineSummary = (line: DraftLine) => {
    const drug = state.drugOf(line.drugId)!
    return `${drug.name} ${line.dose} ${drug.doseUnit} ${line.route} ${MEDICATION_FREQUENCIES[line.frequency].label} × ${line.days} 天（共 ${totalQuantity(drug, line.dose, line.frequency, line.days)}）`
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <section aria-labelledby="prescription-heading" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 id="prescription-heading" className="m-0 text-sm font-semibold">
              处方
            </h3>
            <span className="text-xs text-muted-foreground">须先确认诊断 · 青霉素类过敏为红线，不可越权</span>
          </div>
          <div role="group" aria-label="用药结论" className="flex items-center gap-1">
            {(
              [
                ['rx', '处方'],
                ['nomed', '无需用药'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                data-variant={mode === value ? 'solid' : 'ghost'}
                className="h-7 px-2.5 text-xs"
                aria-pressed={mode === value}
                disabled={!writable || state.busy}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        {state.error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {state.error?.includes('药事安全红线拦截') && (
              <span className="mr-1.5 inline-block font-mono text-xs">MEDICATION_ALLERGY_CONFLICT</span>
            )}
            {state.error}
          </p>
        )}
        {noMedication && (
          <p className={`${badge} w-fit bg-success/15 text-success`} style={{ margin: 0 }}>
            已确认无需用药 {formatClock(noMedication.recordedAt)}
          </p>
        )}
        {lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">药品</th>
                  <th className="py-1.5 pr-2 font-medium">用法用量</th>
                  <th className="py-1.5 pr-2 font-medium">总量</th>
                  <th className="py-1.5 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.lineId} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-2">
                      {line.name}
                      <div className="text-xs text-muted-foreground">{line.spec}</div>
                    </td>
                    <td className="py-1.5 pr-2">
                      {line.dose} {line.doseUnit} {line.route} {MEDICATION_FREQUENCIES[line.frequency].label} × {line.days} 天
                    </td>
                    <td className="py-1.5 pr-2 font-mono">{line.totalQuantity}</td>
                    <td className="py-1.5">
                      <span className={`${badge} bg-success/15 text-success`}>已开具 {formatClock(line.issuedAt)}</span>
                      {line.overrideReason && (
                        <div className="text-xs text-muted-foreground">
                          已登记：{line.overrideReason}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {mode === 'rx' && !noMedication && (
          <>
            {state.draft.length > 0 && (
              <DraftTable state={state} writable={writable} />
            )}
            {crossLines.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[13px]" role="alert">
                <b className="text-warning">临床质控警示（需登记原因）</b>
                <span>
                  {crossLines.map((line) => state.drugOf(line.drugId)!.name).join('、')}{' '}
                  {CROSS_ALLERGY.cephalosporin.message}。
                </span>
                <label className="flex items-center gap-1.5 text-xs">
                  登记原因
                  <select
                    className={select}
                    value={reason}
                    aria-label="登记原因"
                    disabled={!writable}
                    onChange={(e) => setReason(e.target.value)}
                  >
                    <option value="">选择登记原因…</option>
                    {CROSS_ALLERGY_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <textarea
                  className="min-h-12 rounded-md border bg-background p-2 text-[13px]"
                  placeholder={`补充说明（至少 ${MIN_OVERRIDE_NOTE_LENGTH} 字）`}
                  aria-label="补充说明"
                  value={note}
                  disabled={!writable}
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
                />
                <span className="text-xs text-muted-foreground">登记内容进入审计记录。</span>
              </div>
            )}
            {state.draft.length === 0 && lines.length === 0 && (
              <p className="m-0 text-[13px] text-muted-foreground">暂无处方草稿。须先确认诊断才能开具。</p>
            )}
            <MedicationSearch state={state} disabled={!writable} onAdd={state.add} />
            <ClinicalConfirmation
              disabled={!writable || state.draft.length === 0 || !overrideAccepted}
              title="正式开具处方"
              intent="正式开具处方"
              confirmLabel="正式开具"
              onConfirm={issue}
              trigger={<span>正式开具处方{state.draft.length > 1 && `（${state.draft.length} 项）`}</span>}
            >
              <ul className="m-0 list-disc pl-4">
                {state.draft.map((line) => (
                  <li key={line.drugId}>{lineSummary(line)}</li>
                ))}
              </ul>
              {crossLines.length > 0 && (
                <p className="mt-1.5 mb-0">
                  已登记：{reason || '（未选原因）'}；说明：{note.trim() || '（未填写）'}
                </p>
              )}
            </ClinicalConfirmation>
          </>
        )}
        {mode === 'nomed' && !noMedication && lines.length === 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="flex-1 text-muted-foreground">
              适用于自限性疾病等无需药物治疗的情况；与有效处方互斥，开具前须先确认诊断。
            </span>
            <ClinicalConfirmation
              disabled={!writable}
              title="确认无需用药"
              intent="确认无需用药"
              confirmLabel="确认无需用药"
              onConfirm={async () => {
                await state.recordNoMed()
              }}
              trigger="确认无需用药"
            >
              本次门诊评估无需用药；与有效处方互斥。
            </ClinicalConfirmation>
          </div>
        )}
      </section>
    </div>
  )
}

function DraftTable({ state, writable }: { state: PrescriptionsState; writable: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-2 font-medium">药品</th>
            <th className="py-1.5 pr-2 font-medium">单次剂量</th>
            <th className="py-1.5 pr-2 font-medium">用法</th>
            <th className="py-1.5 pr-2 font-medium">频次</th>
            <th className="py-1.5 pr-2 font-medium">天数</th>
            <th className="py-1.5 pr-2 font-medium">总量</th>
            <th className="py-1.5 font-medium" aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {state.draft.map((line) => {
            const drug = state.drugOf(line.drugId)!
            const tag = state.tagFor(drug)
            return (
              <tr
                key={line.drugId}
                className={`border-b last:border-b-0 ${tag === 'conflict' ? 'bg-destructive/5' : ''}`}
              >
                <td className="py-1.5 pr-2 align-top">
                  <span className="flex items-center gap-1.5">
                    {drug.name}
                    {tag && <AllergyTagBadge tag={tag} />}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {drug.spec} · {drug.drugClassName}
                    <InsertSummary drug={drug} />
                  </span>
                </td>
                <td className="py-1.5 pr-2 align-top">
                  <span className="flex items-center gap-1">
                    <input
                      className={numIn}
                      type="number"
                      min={0}
                      step={0.5}
                      value={line.dose}
                      aria-label={`${drug.name} 单次剂量`}
                      disabled={!writable}
                      onChange={(e) => state.edit(line.drugId, 'dose', Number(e.target.value) || 0)}
                    />
                    <span className="text-xs text-muted-foreground">{drug.doseUnit}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-2 align-top">
                  <select
                    className={select}
                    value={line.route}
                    aria-label={`${drug.name} 用法`}
                    disabled={!writable}
                    onChange={(e) => state.edit(line.drugId, 'route', e.target.value as MedicationRoute)}
                  >
                    {MEDICATION_ROUTES.map((route) => (
                      <option key={route} value={route}>
                        {route}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 pr-2 align-top">
                  <select
                    className={select}
                    value={line.frequency}
                    aria-label={`${drug.name} 频次`}
                    disabled={!writable}
                    onChange={(e) => state.edit(line.drugId, 'frequency', e.target.value as MedicationFrequency)}
                  >
                    {Object.entries(MEDICATION_FREQUENCIES).map(([code, freq]) => (
                      <option key={code} value={code}>
                        {code} {freq.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 pr-2 align-top">
                  {/* Uncontrolled while typing, so clearing the field isn't rewritten to the minimum mid-edit;
                     the state (and the total) only moves for valid day counts, and blur restores the last one. */}
                  <input
                    key={line.drugId}
                    className={numIn}
                    type="number"
                    min={MIN_MEDICATION_DAYS}
                    max={MAX_MEDICATION_DAYS}
                    defaultValue={line.days}
                    aria-label={`${drug.name} 天数`}
                    disabled={!writable}
                    onChange={(e) => {
                      const days = Math.trunc(Number(e.target.value))
                      if (Number.isInteger(days) && days >= MIN_MEDICATION_DAYS && days <= MAX_MEDICATION_DAYS) {
                        state.edit(line.drugId, 'days', days)
                      }
                    }}
                    onBlur={(e) => {
                      e.target.value = String(line.days)
                    }}
                  />
                </td>
                <td className="py-1.5 pr-2 font-mono align-top">{totalQuantity(drug, line.dose, line.frequency, line.days)}</td>
                <td className="py-1.5 text-right align-top">
                  <Button
                    data-variant="ghost"
                    className="size-7 p-0"
                    disabled={!writable}
                    aria-label={`删除处方草稿 ${drug.name}`}
                    onClick={() => state.remove(line.drugId)}
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function AllergyTagBadge({ tag }: { tag: keyof typeof ALLERGY_TAG_LABEL }) {
  return (
    <span className={`${badge} ${tag === 'conflict' ? 'bg-destructive text-destructive-foreground' : 'bg-warning/15 text-warning'}`}>
      {ALLERGY_TAG_LABEL[tag]}
    </span>
  )
}

function InsertSummary({ drug }: { drug: MedicationCatalogItemView }) {
  return (
    <Popover>
      <PopoverTrigger className="h-auto w-fit p-0 text-[11px] text-primary underline-offset-2 hover:underline">
        <BookOpenIcon aria-hidden className="size-3" />
        说明书
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-[360px] max-w-[calc(100vw-32px)] p-2 text-[13px]">
        <PopoverTitle className="m-0 pb-1.5 text-xs font-semibold">
          {drug.name} <span className="font-normal text-muted-foreground">{drug.spec}</span>
        </PopoverTitle>
        <dl className="m-0 flex flex-col gap-1.5">
          <div>
            <dt className="text-xs font-medium">适应证</dt>
            <dd className="m-0">{drug.insert.indications}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium">禁忌</dt>
            <dd className="m-0">{drug.insert.contraindications}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium">注意事项</dt>
            <dd className="m-0">{drug.insert.notes}</dd>
          </div>
        </dl>
        <p className="mb-0 mt-1.5 text-[11px] text-muted-foreground">来源：{drug.insert.source}</p>
      </PopoverContent>
    </Popover>
  )
}

// Formulary search by name, pinyin initials or class; every hit is tagged before it can be added.
function MedicationSearch({
  state,
  disabled,
  onAdd,
}: {
  state: PrescriptionsState
  disabled: boolean
  onAdd: (drugId: string) => void
}) {
  return (
    <Combobox
      onValueChange={(drugId, details) => {
        // The field stays a search box: refuse the selection so the typed query remains, and add the drug.
        details.cancel()
        if (drugId) onAdd(drugId)
      }}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxLabel className="text-xs font-medium text-muted-foreground">搜索药品（本院药房）</ComboboxLabel>
      <ComboboxInput placeholder="搜索药品名称、拼音或类别，如 amxl、头孢" aria-label="搜索药品" />
      <ComboboxContent>
        <ComboboxEmpty>没有匹配的药品。</ComboboxEmpty>
        <ComboboxList>
          {state.catalog.map((drug) => {
            const tag = state.tagFor(drug)
            return (
              <ComboboxItem
                key={drug.id}
                value={drug.id}
                label={drug.name}
                keywords={[...drug.pinyinInitials, drug.drugClassName]}
                className={tag === 'conflict' ? 'text-destructive' : undefined}
              >
                {drug.name}
                <span className="text-xs text-muted-foreground">
                  {drug.spec} · {drug.drugClassName}
                </span>
                {tag && <AllergyTagBadge tag={tag} />}
              </ComboboxItem>
            )
          })}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
