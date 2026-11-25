import {
  MAX_DIAGNOSIS_ENTRIES,
  type DiagnosisDraftEntry,
  type DiagnosisEntry,
  type DiagnosisView,
  type SaveDiagnosisDraftRequest,
  icdName,
  isIcdCode,
} from '../../src/shared/diagnosis'
import type { EncounterError, EncounterView } from '../../src/shared/encounter'

type Refuse = (code: EncounterError['code'], message: string) => Response

export const emptyDiagnosis = (): DiagnosisView => ({ draft: [], revisions: [] })

const toEntries = (draft: DiagnosisDraftEntry[]): DiagnosisEntry[] =>
  draft.map((entry) => ({ ...entry, name: icdName(entry.code)! }))

// The Diagnosis routes of the fake clinic API, following the contract the Worker seam pins down.
export function createFakeDiagnoses(refuse: Refuse, diagnoses: Record<string, DiagnosisView> = {}) {
  const byEncounter = new Map(Object.entries(structuredClone(diagnoses)))
  const diagnosisOf = (encounterId: string) =>
    byEncounter.get(encounterId) ?? byEncounter.set(encounterId, emptyDiagnosis()).get(encounterId)!
  const respond = (encounterId: string, status = 200) => Response.json({ diagnosis: diagnosisOf(encounterId) }, { status })

  function handle(method: string, encounter: EncounterView, action: string, body: unknown): Response | undefined {
    const { encounterId } = encounter
    if (method === 'GET' && action === 'diagnosis') return respond(encounterId)
    if (method === 'POST' && action === 'diagnosis/reopen') {
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      const diagnosis = diagnosisOf(encounterId)
      const latest = diagnosis.revisions.at(-1)
      if (!latest) return refuse('diagnosis-not-confirmed', '尚未确认诊断，没有可修改的已确认版本。')
      diagnosis.draft = latest.entries.map(({ code, primary, source }) => ({ code, primary, source }))
      return respond(encounterId)
    }
    if (action !== 'diagnosis/draft' && action !== 'diagnosis/revisions') return undefined
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    const entries = (body as SaveDiagnosisDraftRequest | undefined)?.entries
    const valid =
      Array.isArray(entries) &&
      entries.length <= MAX_DIAGNOSIS_ENTRIES &&
      entries.every((entry) => isIcdCode(entry.code) && typeof entry.primary === 'boolean') &&
      new Set(entries.map((entry) => entry.code)).size === entries.length
    if (!valid) return refuse('invalid-request', '请求体须为 { "entries": [...] }，诊断编码须在目录中且不重复。')
    const diagnosis = diagnosisOf(encounterId)
    if (action === 'diagnosis/draft') {
      diagnosis.draft = entries as DiagnosisDraftEntry[]
      return respond(encounterId)
    }
    if (entries.filter((entry) => entry.primary).length !== 1) {
      return refuse('diagnosis-needs-primary', '每次确认须恰有一项主诊断。')
    }
    const version = diagnosis.revisions.length + 1
    diagnosis.revisions.push({
      revisionId: `diagnosis-${encounterId}-${version}`,
      version,
      seq: version,
      entries: toEntries(entries as DiagnosisDraftEntry[]),
      practitionerId: 'demo-practitioner',
      confirmedAt: new Date().toISOString(),
    })
    diagnosis.draft = []
    return respond(encounterId, 201)
  }

  return { handle, diagnosis: diagnosisOf }
}
