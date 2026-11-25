import type { ReactNode } from 'react'
import type { CaseDebrief } from '../../shared/completion'
import { MEDICATION_FREQUENCIES } from '../../shared/medication'
import { BODY_SYSTEM_NAME } from '../../shared/physical-examination'

function items(entries: { key: string; text: string }[]): ReactNode {
  if (!entries.length) return '未记录'
  return (
    <ul className="m-0 list-disc pl-4">
      {entries.map(({ key, text }) => <li key={key}>{text}</li>)}
    </ul>
  )
}

export function CaseDebriefPanel({ debrief }: { debrief: CaseDebrief }) {
  const { reference, diagnoses, investigations, examinations, prescriptions, questions, signedNote, dispositionRecorded } = debrief
  const diagnosisItem = ({ code, name }: (typeof diagnoses)[number]) => ({ key: code, text: `${code} ${name}` })
  const rows = [
    { label: '主诊断', actual: items(diagnoses.filter((entry) => entry.primary).map(diagnosisItem)), reference: reference.primaryDiagnosis },
    { label: '次要诊断', actual: items(diagnoses.filter((entry) => !entry.primary).map(diagnosisItem)), reference: reference.secondaryDiagnoses },
    { label: '关键检查', actual: items(investigations.filter((entry) => !entry.cancellation).map((entry) => ({
      key: entry.investigationId, text: `${entry.name} · 报告第 ${entry.reports.at(-1)?.version} 版已阅`,
    }))), reference: reference.keyInvestigations },
    { label: '查体', actual: items(examinations.map((entry) => ({
      key: entry.system, text: `${BODY_SYSTEM_NAME[entry.system]} · ${entry.finding}`,
    }))), reference: reference.keyExamination },
    { label: '用药结论', actual: prescriptions.noMedication ? '无需用药' : items(prescriptions.lines.map((line) => ({
      key: line.lineId, text: `${line.name} ${line.dose} ${line.doseUnit} · ${line.route} · ${MEDICATION_FREQUENCIES[line.frequency].label} · ${line.days} 天`,
    }))), reference: reference.medicationConclusion },
    { label: '关键问诊', actual: items(questions.map((turn) => ({ key: turn.turnId, text: turn.text }))), reference: reference.keyHistoryQuestions },
    { label: '严重程度评估', actual: signedNote.sections.assessment || '未记录', reference: reference.severityAssessment },
    { label: '处置与随访', actual: (<>
      {signedNote.sections.plan || '未记录'}
      <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${dispositionRecorded ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
        {dispositionRecorded ? '处置已记录' : '处置未记录'}
      </span>
    </>), reference: reference.disposition },
  ]
  return (
    <div className="px-3 py-2">
      <table aria-label="病例复盘对照" className="w-full table-fixed border-collapse text-left text-xs leading-relaxed">
        <thead>
          <tr className="border-b">
            <th scope="col" className="w-[23%] p-2">项目</th>
            <th scope="col" className="p-2">本次正式记录</th>
            <th scope="col" className="p-2">Golden Case 参考</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b align-top">
              <th scope="row" className="p-2 font-medium">{row.label}</th>
              <td className="break-words whitespace-pre-wrap p-2">{row.actual}</td>
              <td className="break-words whitespace-pre-wrap p-2 text-muted-foreground">{row.reference}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
