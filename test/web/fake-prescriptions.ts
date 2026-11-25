import rawCatalog from '../../data/clinic-catalog/medication-catalog.json'
import type { EncounterError, EncounterView } from '../../src/shared/encounter'
import {
  allergyTagFor,
  CROSS_ALLERGY_REASONS,
  MEDICATION_FREQUENCIES,
  MEDICATION_ROUTES,
  MIN_MEDICATION_DAYS,
  MAX_MEDICATION_DAYS,
  MIN_OVERRIDE_NOTE_LENGTH,
  totalQuantity,
  type IssuedPrescriptionLine,
  type MedicationCatalogItemView,
  type PrescriptionsView,
} from '../../src/shared/medication'

export const fakeMedicationCatalog: MedicationCatalogItemView[] = rawCatalog.items.map((item) => ({
  id: item.id,
  name: item.name,
  spec: item.spec,
  pack: item.pack,
  unit: item.unit,
  doseUnit: item.doseUnit,
  drugClass: item.drugClass,
  drugClassName: item.drugClassName,
  pinyinInitials: item.pinyinInitials,
  defaults: {
    dose: item.defaults.dose,
    route: item.defaults.route as MedicationCatalogItemView['defaults']['route'],
    frequency: item.defaults.frequency as MedicationCatalogItemView['defaults']['frequency'],
    days: item.defaults.days,
  },
  insert: { ...item.insert, source: '药品说明书摘要（合成）' },
}))

type Refuse = (code: EncounterError['code'], message: string) => Response

// The prescription routes of the fake clinic API, enforcing the same invariants the Worker seam pins down:
// a confirmed Diagnosis first, the class-level allergy red line without any override, the cross-allergen
// acceptance, and mutual exclusion with No Medication in both directions.
export function createFakePrescriptions(refuse: Refuse, confirmed: (encounterId: string) => boolean) {
  const byEncounter = new Map<string, PrescriptionsView>()
  let sequence = 0
  const viewOf = (encounterId: string) =>
    byEncounter.get(encounterId) ?? byEncounter.set(encounterId, { lines: [], noMedication: null }).get(encounterId)!
  const respond = (encounterId: string, status = 200) => Response.json({ prescriptions: viewOf(encounterId) }, { status })

  const allergyClassesOf = (encounter: EncounterView) =>
    encounter.visibleSourceHistory.allergies
      .map((allergy) => allergy.drugClass)
      .filter((drugClass): drugClass is string => typeof drugClass === 'string')

  function handle(method: string, encounter: EncounterView, action: string, body: unknown): Response | undefined {
    const { encounterId } = encounter
    if (method === 'GET' && action === 'prescriptions') return respond(encounterId)
    if (method !== 'POST' || (action !== 'prescriptions' && action !== 'no-medication')) return undefined
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    const view = viewOf(encounterId)
    if (!confirmed(encounterId)) return refuse('diagnosis-not-confirmed', '须先确认诊断，才能开具处方。')
    if (action === 'no-medication') {
      if (view.lines.length > 0) return refuse('no-medication-conflict', '已有开具的处方，与无需用药结论互斥。')
      view.noMedication = { practitionerId: 'demo-practitioner', recordedAt: new Date().toISOString() }
      return respond(encounterId, 201)
    }
    if (view.noMedication) return refuse('no-medication-conflict', '已记录无需用药结论，与处方互斥，无法开具处方。')
    const raw = (body as { lines?: unknown } | undefined)?.lines
    if (!Array.isArray(raw) || raw.length === 0) return refuse('invalid-request', '请求体须为 { "lines": [...] }。')
    const lines = raw as Record<string, unknown>[]
    if (new Set(lines.map((l) => l.drugId)).size !== lines.length) return refuse('invalid-request', '药品不重复。')
    const classes = allergyClassesOf(encounter)
    const resolved = lines.map((l) => {
      const drug = fakeMedicationCatalog.find((item) => item.id === l.drugId)
      if (!drug) return refuse('catalog-item-not-found', '处方中含有本院药房没有的药品。')
      const dose = l.dose as number
      const valid =
        typeof dose === 'number' &&
        dose > 0 &&
        MEDICATION_ROUTES.includes(l.route as never) &&
        typeof l.frequency === 'string' &&
        l.frequency in MEDICATION_FREQUENCIES &&
        typeof l.days === 'number' &&
        Number.isInteger(l.days) &&
        l.days >= MIN_MEDICATION_DAYS &&
        l.days <= MAX_MEDICATION_DAYS
      if (!valid) return refuse('invalid-request', '剂量、用法、频次或天数无效。')
      const tag = allergyTagFor(drug, classes)
      if (tag === 'conflict') {
        return refuse(
          'MEDICATION_ALLERGY_CONFLICT',
          `药事安全红线拦截（不可越权）：${drug.name}（${drug.drugClassName}）与患者过敏史冲突。整张处方未开具，请删除相关药品后重新提交。`,
        )
      }
      if (tag === 'cross-allergy') {
        const override = l.override as { reason?: unknown; note?: unknown } | undefined
        const note = typeof override?.note === 'string' ? override.note.trim() : ''
        if (
          !override ||
          typeof override.reason !== 'string' ||
          !(CROSS_ALLERGY_REASONS as readonly string[]).includes(override.reason) ||
          note.length < MIN_OVERRIDE_NOTE_LENGTH
        ) {
          return refuse(
            'medication-override-required',
            `${drug.name} 与青霉素存在交叉过敏风险：须从固定原因列表中选择登记原因，并填写至少 ${MIN_OVERRIDE_NOTE_LENGTH} 字的补充说明。`,
          )
        }
      }
      return { drug, line: l }
    })
    for (const entry of resolved) if (entry instanceof Response) return entry
    const now = new Date().toISOString()
    for (const entry of resolved as { drug: MedicationCatalogItemView; line: Record<string, unknown> }[]) {
      const drug = entry.drug
      const line = entry.line
      const override = line.override as { reason: string; note: string } | undefined
      view.lines.push({
        lineId: `line-${++sequence}`,
        drugId: drug.id,
        name: drug.name,
        spec: drug.spec,
        dose: line.dose as number,
        doseUnit: drug.doseUnit,
        route: line.route as IssuedPrescriptionLine['route'],
        frequency: line.frequency as IssuedPrescriptionLine['frequency'],
        days: line.days as number,
        totalQuantity: totalQuantity(drug, line.dose as number, line.frequency as never, line.days as number),
        drugClass: drug.drugClass,
        drugClassName: drug.drugClassName,
        overrideReason: override?.reason ?? null,
        overrideNote: override?.note.trim() ?? null,
        practitionerId: 'demo-practitioner',
        issuedAt: now,
      })
    }
    return respond(encounterId, 201)
  }

  return { handle, view: viewOf }
}
