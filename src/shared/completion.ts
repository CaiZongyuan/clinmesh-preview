import type { SignedNoteRevision } from './clinical-note'
import type { ConsultationTurn } from './consultation'
import type { DiagnosisView, SignedDiagnosisRevision } from './diagnosis'
import type { InvestigationView } from './investigation'
import type { PrescriptionLineRequest, PrescriptionsView } from './medication'
import type { PhysicalExaminationView } from './physical-examination'

export type PrescriptionDraftLine = Omit<PrescriptionLineRequest, 'override'>

export interface ClinicalDrafts {
  investigations: string[]
  prescriptions: PrescriptionDraftLine[]
}

export const COMPLETION_GATE_LABELS = {
  'primary-diagnosis': '主诊断确认',
  reports: '必需报告查阅',
  medication: '用药结论记录',
  'signed-note': '门诊病历签署',
  drafts: '待提交草稿处理',
} as const

export type CompletionGateId = keyof typeof COMPLETION_GATE_LABELS

export interface CompletionGate {
  id: CompletionGateId
  met: boolean
  detail: string
}

export function completionGates(
  diagnosis: DiagnosisView,
  investigations: InvestigationView[],
  prescriptions: PrescriptionsView,
  signedNote: SignedNoteRevision | undefined,
  drafts: ClinicalDrafts,
  pendingSuggestions = 0,
): CompletionGate[] {
  const confirmed = diagnosis.revisions.at(-1)
  const activeInvestigations = investigations.filter((item) => !item.cancellation)
  const awaitingReport = activeInvestigations.filter((item) => !item.reports.at(-1)?.acknowledgement).length
  const staleNote = signedNote && confirmed && signedNote.seq <= confirmed.seq
  const outstanding = [
    [drafts.investigations.length, '检查'],
    [diagnosis.draft.length, '诊断'],
    [drafts.prescriptions.length, '处方'],
    [pendingSuggestions, '待确认建议'],
  ] as const
  const draftsDetail = outstanding.filter(([count]) => count > 0).map(([count, label]) => `${label} ${count}`).join(' · ')

  return [
    { id: 'primary-diagnosis', met: confirmed?.entries.filter((entry) => entry.primary).length === 1,
      detail: confirmed ? `第 ${confirmed.version} 次确认` : '尚未确认诊断' },
    { id: 'reports', met: awaitingReport === 0,
      detail: awaitingReport ? `${awaitingReport} 项待出报告或待阅` : activeInvestigations.length ? '最新版本均已阅' : '无已开立检查' },
    { id: 'medication', met: Boolean(prescriptions.noMedication) || prescriptions.lines.length > 0,
      detail: prescriptions.noMedication ? '已确认无需用药' : prescriptions.lines.length ? `已开具 ${prescriptions.lines.length} 种药` : '尚未开具处方或确认无需用药' },
    { id: 'signed-note', met: Boolean(signedNote && !staleNote),
      detail: !signedNote ? '尚未签署' : staleNote ? '签署早于诊断修改，需追加签署' : `第 ${signedNote.version} 版已签署` },
    { id: 'drafts', met: outstanding.every(([count]) => count === 0), detail: draftsDetail || '无遗留草稿' },
  ]
}

export interface CaseDebriefReference {
  primaryDiagnosis: string
  secondaryDiagnoses: string
  keyInvestigations: string
  keyExamination: string
  medicationConclusion: string
  keyHistoryQuestions: string
  severityAssessment: string
  disposition: string
}

export interface CaseDebrief {
  reference: CaseDebriefReference
  diagnoses: SignedDiagnosisRevision['entries']
  investigations: InvestigationView[]
  examinations: PhysicalExaminationView[]
  prescriptions: PrescriptionsView
  questions: Pick<ConsultationTurn, 'turnId' | 'text'>[]
  signedNote: SignedNoteRevision
  dispositionRecorded: boolean
}

// A plan records a disposition when it names where the patient goes next, whatever the case's diagnosis is.
export const DISPOSITION_TERMS = ['转院', '转诊', '转上级', '住院', '收住', '留观', '随访', '复诊'] as const

export function dispositionRecorded(plan: string): boolean {
  return DISPOSITION_TERMS.some((term) => plan.includes(term))
}
