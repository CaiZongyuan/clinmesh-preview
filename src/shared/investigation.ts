export type InvestigationCategory = 'lab' | 'radiology' | 'function'

export const CATEGORY_LABEL: Record<InvestigationCategory, string> = { lab: '检验', radiology: '放射', function: '功能' }

// Every Investigation passes through its category's stages in order; the last one releases the first Report.
export const INVESTIGATION_STAGES: Record<InvestigationCategory, readonly string[]> = {
  lab: ['已开立', '已采样', '检验中', '已出报告'],
  radiology: ['已开立', '已登记', '检查中', '待审核', '已出报告'],
  function: ['已开立', '检查中', '已出报告'],
}

export interface CatalogItemView {
  id: string
  name: string
  category: InvestigationCategory
  pinyinInitials: string[]
  specimenOrSite: string
  department: string
  expectedTurnaround: string
}

export interface InvestigationCatalogResponse {
  catalogVersion: string
  items: CatalogItemView[]
}

// Which side of the reference range a result falls on; 'abnormal' for a qualitative result off its normal value.
export type ResultFlag = 'high' | 'low' | 'abnormal' | null

export interface ReportResultRow {
  analyteId: string
  name: string
  value: number | string
  decimals: number
  unit: string
  referenceRange: string
  flag: ResultFlag
}

export type ReportBody =
  | { kind: 'results'; results: ReportResultRow[] }
  | { kind: 'narrative'; findings: string; impression: string }

export interface ReportAcknowledgement {
  acknowledgedAt: string
  practitionerId: string
}

export interface ReportView {
  reportId: string
  version: number
  releasedAt: string
  reporter: string
  reviewer: string
  specimenOrSite: string
  body: ReportBody
  acknowledgement: ReportAcknowledgement | null
}

export interface ReachedStage {
  name: string
  at: string
}

export interface InvestigationView {
  investigationId: string
  catalogItemId: string
  name: string
  category: InvestigationCategory
  specimenOrSite: string
  department: string
  practitionerId: string
  issuedAt: string
  expectedReportAt: string
  stages: ReachedStage[]
  reports: ReportView[]
}

export interface InvestigationsResponse {
  investigations: InvestigationView[]
}

export interface IssueInvestigationsRequest {
  catalogItemIds: string[]
}

export interface AcknowledgeReportsRequest {
  reportIds: string[]
}
