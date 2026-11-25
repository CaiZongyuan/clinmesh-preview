export const MAX_DIAGNOSIS_ENTRIES = 8

export type DiagnosisSource = 'doctor' | 'assistant'

export const DIAGNOSIS_SOURCE_NAME: Record<DiagnosisSource, string> = {
  doctor: '医生',
  assistant: '临床助手',
}

// A candidate entry as the doctor builds it: the catalogue resolves the name at confirmation time, so a
// confirmed revision keeps the name it was confirmed with even if the catalogue changes later.
export interface DiagnosisDraftEntry {
  code: string
  primary: boolean
  source: DiagnosisSource
}

export interface DiagnosisEntry extends DiagnosisDraftEntry {
  name: string
}

export interface SignedDiagnosisRevision {
  revisionId: string
  version: number
  // The Encounter's clinical revision sequence, shared with signed Clinical Note revisions, so a signature
  // can be compared with the Diagnosis it was signed against.
  seq: number
  entries: DiagnosisEntry[]
  practitionerId: string
  confirmedAt: string
}

export interface DiagnosisView {
  // Empty once the doctor confirms, until 修改已确认诊断 reopens one from the latest revision.
  draft: DiagnosisDraftEntry[]
  // Oldest first.
  revisions: SignedDiagnosisRevision[]
}

export interface DiagnosisResponse {
  diagnosis: DiagnosisView
}

export interface SaveDiagnosisDraftRequest {
  entries: DiagnosisDraftEntry[]
}

// What the doctor confirmed in Clinical Confirmation: the revision records exactly this.
export type ConfirmDiagnosisRequest = SaveDiagnosisDraftRequest

export interface IcdEntry {
  code: string
  name: string
  // Pinyin initials, so the doctor finds 高血压 by typing gxy.
  pinyin: readonly string[]
}

// The outpatient catalogue of Golden Case season 1. Search runs on the client; the Worker checks codes
// against it without ever sending it in a response.
export const ICD_CATALOG: readonly IcdEntry[] = [
  { code: 'J18.9', name: '社区获得性肺炎', pinyin: ['sqhdxfy', 'fy'] },
  { code: 'J15.9', name: '细菌性肺炎', pinyin: ['xjxfy', 'fy'] },
  { code: 'J13', name: '肺炎链球菌肺炎', pinyin: ['fylqjfy', 'fy'] },
  { code: 'J20.9', name: '急性支气管炎', pinyin: ['jxzqgy'] },
  { code: 'J06.9', name: '急性上呼吸道感染', pinyin: ['jxshxdgr', 'sg'] },
  { code: 'J44.1', name: '慢性阻塞性肺疾病伴急性加重', pinyin: ['mxzsxfjb', 'copd'] },
  { code: 'A15.0', name: '肺结核', pinyin: ['fjh'] },
  { code: 'R50.9', name: '发热', pinyin: ['fr'] },
  { code: 'I10', name: '原发性高血压', pinyin: ['yfxgxy', 'gxy'] },
  { code: 'E11.9', name: '2型糖尿病', pinyin: ['2xtnb', 'tnb'] },
  { code: 'N39.0', name: '尿路感染', pinyin: ['nlgr', 'nlgm'] },
  { code: 'E78.5', name: '高脂血症', pinyin: ['gzxz'] },
  { code: 'K29.7', name: '慢性胃炎', pinyin: ['mxwy'] },
  { code: 'M54.5', name: '腰痛', pinyin: ['yt'] },
  { code: 'J03.9', name: '急性扁桃体炎', pinyin: ['jxbtty'] },
  { code: 'H10.9', name: '结膜炎', pinyin: ['jmy'] },
  { code: 'Z88.0', name: '青霉素过敏个人史', pinyin: ['qmsgm'] },
  { code: 'I21.4', name: '急性非ST段抬高型心肌梗死', pinyin: ['jxfstdgtxxgs', 'xxgs', 'nstemi'] },
  { code: 'I25.103', name: '冠状动脉粥样硬化性心脏病', pinyin: ['gzdmzyyhzxzb', 'gxb', 'xzb'] },
]

// The diagnoses an outpatient clinic reaches for most; each adds in one click.
export const COMMON_DIAGNOSIS_CODES: readonly string[] = ['J06.9', 'J18.9', 'I10', 'E11.9', 'R50.9']

export const icdName = (code: string): string | undefined => ICD_CATALOG.find((entry) => entry.code === code)?.name

export const isIcdCode = (value: unknown): value is string =>
  typeof value === 'string' && ICD_CATALOG.some((entry) => entry.code === value)

