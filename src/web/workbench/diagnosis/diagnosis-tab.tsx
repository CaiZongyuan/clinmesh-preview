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
import { RadioGroup, Radio } from '@ui-sdk/react/radio'
import { HistoryIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import {
  COMMON_DIAGNOSIS_CODES,
  DIAGNOSIS_SOURCE_NAME,
  ICD_CATALOG,
  MAX_DIAGNOSIS_ENTRIES,
  icdName,
} from '../../../shared/diagnosis'
import type { EncounterView } from '../../../shared/encounter'
import { ClinicalConfirmation } from '../clinical-confirmation'
import { formatClock } from '../format'
import { badge } from '../pane-styles'
import type { DiagnosisState } from './use-diagnosis'

const card = 'flex flex-col gap-3 rounded-lg border bg-card p-3'

export function DiagnosisTab({ encounter, state }: { encounter: EncounterView; state: DiagnosisState }) {
  const writable = encounter.status === 'active'
  const { draft, revisions } = state.view
  const last = revisions.at(-1)
  const primary = draft.find((entry) => entry.primary) ?? draft[0]
  const full = draft.length >= MAX_DIAGNOSIS_ENTRIES

  return (
    <div className="flex flex-col gap-3 p-3">
      <section aria-labelledby="diagnosis-heading" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 id="diagnosis-heading" className="m-0 text-sm font-semibold">
              诊断
            </h3>
            <span className="text-xs text-muted-foreground">ICD-10 · 恰有一项主诊断 · 最多 {MAX_DIAGNOSIS_ENTRIES} 项</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {last && (
              <span className={`${badge} bg-success/15 text-success`}>
                第 {last.version} 次确认 · {formatClock(last.confirmedAt)}
              </span>
            )}
            <ConfirmationHistory revisions={revisions} />
          </div>
        </div>
        {state.error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {state.error}
          </p>
        )}
        {revisions.length > 0 && draft.length === 0 && (
          <div className="flex flex-col gap-1.5">
            {last!.entries.map((entry) => (
              <div key={entry.code} className="flex items-center gap-2 text-[13px]">
                <span className={`${badge} ${entry.primary ? 'bg-primary/10 text-primary' : 'border'}`}>
                  {entry.primary ? '主诊断' : '次诊断'}
                </span>
                <span>{entry.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{entry.code}</span>
              </div>
            ))}
            <div>
              <Button
                className="h-7 gap-1 px-2.5 text-xs"
                disabled={!writable || state.busy}
                onClick={() => void state.revise()}
              >
                <HistoryIcon aria-hidden className="size-3.5" />
                修改已确认诊断
              </Button>
            </div>          </div>
        )}
        {draft.length > 0 && (
          <DraftTable
            entries={draft}
            primaryCode={primary?.code}
            writable={writable}
            busy={state.busy}
            onPrimary={state.setPrimary}
            onRemove={state.remove}
          />
        )}
        {draft.length === 0 && revisions.length === 0 && (
          <p className="m-0 text-[13px] text-muted-foreground">暂无诊断草稿。搜索 ICD-10 编码、名称或拼音首字母添加。</p>
        )}
        <IcdSearch disabled={!writable || full} full={full} onAdd={state.add} />
        <CommonDiagnoses disabled={!writable} onAdd={state.add} />
        <ConfirmDiagnosis state={state} primaryName={primary ? icdName(primary.code) : undefined} writable={writable} />
      </section>
    </div>
  )
}

function DraftTable({
  entries,
  primaryCode,
  writable,
  busy,
  onPrimary,
  onRemove,
}: {
  entries: DiagnosisState['view']['draft']
  primaryCode: string | undefined
  writable: boolean
  busy: boolean
  onPrimary: (code: string) => void
  onRemove: (code: string) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-2 font-medium">主诊断</th>
            <th className="py-1.5 pr-2 font-medium">诊断名称</th>
            <th className="py-1.5 pr-2 font-medium">ICD-10</th>
            <th className="py-1.5 pr-2 font-medium">来源</th>
            <th className="py-1.5 font-medium" aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          <RadioGroup
            value={primaryCode}
            onValueChange={(code) => code && onPrimary(code)}
            aria-label="选择主诊断"
            className="contents"
          >
            {entries.map((entry) => (
              <tr key={entry.code} className="border-b last:border-b-0">
                <td className="py-1.5 pr-2">
                  <Radio value={entry.code} disabled={!writable || busy} aria-label={`设为主诊断 ${icdName(entry.code)}`} />
                </td>
                <td className="py-1.5 pr-2">{icdName(entry.code)}</td>
                <td className="py-1.5 pr-2 font-mono text-xs">{entry.code}</td>
                <td className="py-1.5 pr-2 text-xs text-muted-foreground">{DIAGNOSIS_SOURCE_NAME[entry.source]}</td>
                <td className="py-1.5 text-right">
                  <Button
                    data-variant="ghost"
                    className="size-7 p-0"
                    disabled={!writable || busy}
                    aria-label={`删除诊断草稿 ${icdName(entry.code)}`}
                    onClick={() => onRemove(entry.code)}
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </RadioGroup>
        </tbody>
      </table>
    </div>
  )
}

// The ICD-10 search: typing filters by name, code or pinyin initials (via item keywords); Enter adds the
// highlighted entry, or the doctor clicks it. The selection resets so the field keeps acting as a search box.
function IcdSearch({ disabled, full, onAdd }: { disabled: boolean; full: boolean; onAdd: (code: string) => void }) {
  return (
    <Combobox
      onValueChange={(code, details) => {
        // The field stays a search box: refuse the selection so the typed query remains, and add the entry.
        details.cancel()
        if (code) onAdd(code)
      }}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxLabel className="text-xs font-medium text-muted-foreground">
        搜索 ICD-10 诊断{full ? `（已达 ${MAX_DIAGNOSIS_ENTRIES} 项上限）` : ''}
      </ComboboxLabel>
      <ComboboxInput placeholder="搜索诊断名称、编码或拼音，如 gxy、J18" aria-label="搜索 ICD-10 诊断" />
      <ComboboxContent>
        <ComboboxEmpty>没有匹配的诊断。</ComboboxEmpty>
        <ComboboxList>
          {ICD_CATALOG.map((entry) => (
            <ComboboxItem key={entry.code} value={entry.code} label={entry.name} keywords={[entry.code, ...entry.pinyin]}>
              {entry.name}
              <span className="font-mono text-xs text-muted-foreground">{entry.code}</span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function CommonDiagnoses({ disabled, onAdd }: { disabled: boolean; onAdd: (code: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">常用：</span>
      {COMMON_DIAGNOSIS_CODES.map((code) => (
        <Button
          key={code}
          data-variant="outline"
          className="h-7 rounded-full px-2.5 text-xs"
          disabled={disabled}
          aria-label={`添加常用诊断 ${icdName(code)}`}
          onClick={() => onAdd(code)}
        >
          <PlusIcon aria-hidden className="size-3" />
          {icdName(code)}
        </Button>
      ))}
    </div>
  )
}

function ConfirmationHistory({ revisions }: { revisions: DiagnosisState['view']['revisions'] }) {
  if (revisions.length < 2) return null
  const names = revisions
    .slice(0, -1)
    .map((revision) => `第 ${revision.version} 次 ${revision.entries.find((entry) => entry.primary)?.name ?? ''}`)
  return <span className="text-xs text-muted-foreground">历次确认：{names.join('；')}</span>
}

function ConfirmDiagnosis({
  state,
  primaryName,
  writable,
}: {
  state: DiagnosisState
  primaryName: string | undefined
  writable: boolean
}) {
  const entries = state.view.draft
  if (entries.length === 0) return null
  return (
    <div className="flex justify-end">
      <ClinicalConfirmation
        disabled={!writable || state.busy}
        title="确认诊断"
        intent="确认诊断"
        trigger={
          primaryName ? (
            <span>
              确认诊断（主诊断：{primaryName}
              {entries.length > 1 && ` 等 ${entries.length} 项`}）
            </span>
          ) : (
            '确认诊断'
          )
        }
        triggerClassName="h-8 gap-1.5 bg-primary px-3 text-[13px] text-primary-foreground hover:bg-primary/90"
        confirmLabel="确认诊断"
        confirmClassName="h-8 bg-primary px-3 text-[13px] text-primary-foreground hover:bg-primary/90"
        onConfirm={async () => {
          await state.confirm()
        }}
      >
        <span>本次确认 {entries.length} 项诊断，主诊断：{primaryName}。确认形成新的正式版本，历史保留。</span>
      </ClinicalConfirmation>
    </div>
  )
}
