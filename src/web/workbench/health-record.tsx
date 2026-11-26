import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { HistoryIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PriorMedication, VisibleSourceHistory } from '../../shared/encounter'
import { badge } from './pane-styles'
import { formatDate } from './format'

const medicationText = (m: PriorMedication) => `${m.display} ${m.dosageText}`
const cell = 'border-b px-2 py-1.5 align-top'
const muted = 'text-xs text-muted-foreground'

export function HealthRecordPopover({ history }: { history: VisibleSourceHistory }) {
  return (
    <Popover>
      <PopoverTrigger className="h-7 gap-1 px-2 text-xs">
        <HistoryIcon aria-hidden="true" size={13} />
        健康档案
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-[440px] max-w-[calc(100vw-32px)] p-2.5">
        <PopoverTitle className="m-0 px-1 pb-1.5 text-xs font-semibold">健康档案 · 本院既往记录</PopoverTitle>
        <Tabs defaultValue="visits">
          <TabsList aria-label="健康档案分类" className="grid w-full grid-cols-4">
            <TabsTab value="visits">既往就诊</TabsTab>
            <TabsTab value="allergies">过敏史</TabsTab>
            <TabsTab value="chronic">慢病</TabsTab>
            <TabsTab value="medications">既往用药</TabsTab>
          </TabsList>
          <TabsPanel value="visits" className="pt-1">
            <RecordTable empty={history.priorVisits.length === 0}>
              {history.priorVisits.map((visit) => (
                <tr key={visit.visitedAt}>
                  <td className={`${cell} font-mono whitespace-nowrap ${muted}`}>{formatDate(visit.visitedAt)}</td>
                  <td className={cell}>
                    <div>{visit.reason}</div>
                    <div className={muted}>
                      {visit.diagnoses.map((d) => `${d.code} ${d.display}`).join('；')}
                      {visit.medications.length > 0 && ` · ${visit.medications.map(medicationText).join('；')}`}
                    </div>
                  </td>
                  <td className={`${cell} whitespace-nowrap ${muted}`}>{visit.department}</td>
                </tr>
              ))}
            </RecordTable>
          </TabsPanel>
          <TabsPanel value="allergies" className="pt-1">
            <RecordTable empty={history.allergies.length === 0}>
              {history.allergies.map((allergy) => (
                <tr key={allergy.agent}>
                  <td className={cell}>
                    <span className={`${badge} bg-destructive text-destructive-foreground`}>{allergy.agent}</span>
                  </td>
                  <td className={cell}>{allergy.reaction}</td>
                  <td className={`${cell} ${muted}`}>
                    {allergy.onset} · {allergy.source}
                  </td>
                </tr>
              ))}
            </RecordTable>
          </TabsPanel>
          <TabsPanel value="chronic" className="pt-1">
            <RecordTable empty={history.chronicConditions.length === 0}>
              {history.chronicConditions.map((condition) => (
                <tr key={condition.code}>
                  <td className={cell}>
                    {condition.code} {condition.display}
                  </td>
                  <td className={`${cell} ${muted}`}>{condition.onset} 起</td>
                  <td className={`${cell} text-xs`}>{condition.status}</td>
                </tr>
              ))}
            </RecordTable>
          </TabsPanel>
          <TabsPanel value="medications" className="pt-1">
            <RecordTable empty={history.priorMedications.length === 0}>
              {history.priorMedications.map((medication) => (
                <tr key={medication.display}>
                  <td className={cell}>{medication.display}</td>
                  <td className={`${cell} text-xs`}>{medication.dosageText}</td>
                </tr>
              ))}
            </RecordTable>
          </TabsPanel>
        </Tabs>
        <p className="m-0 border-t px-1 pt-2 text-[11px] text-muted-foreground">
          来源：本院既往记录（Visible Source History）。不含本次就诊结论，也不含病例真值。
        </p>
      </PopoverContent>
    </Popover>
  )
}

function RecordTable({ empty, children }: { empty: boolean; children: ReactNode }) {
  if (empty) return <p className="m-0 p-3 text-center text-xs text-muted-foreground">无记录</p>
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>{children}</tbody>
    </table>
  )
}
