// The Prescription and No Medication contract, plus the parts of the medication catalog the browser may see
// (the same view backs formulary search, allergy tags and the package-insert summary).

export const MEDICATION_FREQUENCIES = {
  QD: { label: '每日 1 次', timesPerDay: 1 },
  BID: { label: '每日 2 次', timesPerDay: 2 },
  TID: { label: '每日 3 次', timesPerDay: 3 },
  QID: { label: '每日 4 次', timesPerDay: 4 },
  PRN: { label: '必要时', timesPerDay: 3 },
} as const

export type MedicationFrequency = keyof typeof MEDICATION_FREQUENCIES

export const MEDICATION_ROUTES = ['口服', '含服', '外用'] as const
export type MedicationRoute = (typeof MEDICATION_ROUTES)[number]

export const MIN_MEDICATION_DAYS = 1
export const MAX_MEDICATION_DAYS = 30
// A cross-allergen issuance needs a consciously written note; one short word is not an acceptance.
export const MIN_OVERRIDE_NOTE_LENGTH = 4

// What a cephalosporin in a penicillin-allergic patient must be issued with: a reason from this fixed
// list and a note of at least MIN_OVERRIDE_NOTE_LENGTH characters, both stored with the issued line and
// in the audit log.
export const CROSS_ALLERGY_REASONS = [
  '已评估获益大于风险',
  '既往使用同类药物无不良反应',
  '存在明确适应证且无合适替代',
  '已完成皮试或过敏评估',
  '患者知情同意',
  '其他（见说明）',
] as const

export interface PackageInsertSummary {
  indications: string
  contraindications: string
  notes: string
  // The pinned provenance of every summary in the catalog; the prototype marks them synthetic.
  source: '药品说明书摘要（合成）'
}

export interface MedicationCatalogItemView {
  id: string
  name: string
  spec: string
  // Dispense units per package, so a total quantity can be expressed in whole packages when the dose
  // unit differs from the dispense unit.
  pack: number
  unit: string
  doseUnit: string
  drugClass: string
  drugClassName: string
  pinyinInitials: readonly string[]
  defaults: { dose: number; route: MedicationRoute; frequency: MedicationFrequency; days: number }
  insert: PackageInsertSummary
}

export interface MedicationCatalogResponse {
  catalogVersion: string
  items: MedicationCatalogItemView[]
}

// Class-level allergy matching: an allergy to a drug class refuses every drug of that class, regardless
// of drug codes. Cephalosporins cross-react with penicillin allergies, so they carry a warning instead.
export type AllergyTag = 'conflict' | 'cross-allergy'

export const CROSS_ALLERGY: Record<string, { against: string; message: string }> = {
  cephalosporin: { against: 'penicillin', message: '与青霉素存在交叉过敏风险' },
}

export function allergyTagFor(item: Pick<MedicationCatalogItemView, 'drugClass'>, allergyClasses: readonly string[]): AllergyTag | null {
  if (allergyClasses.includes(item.drugClass)) return 'conflict'
  if (CROSS_ALLERGY[item.drugClass] && allergyClasses.includes(CROSS_ALLERGY[item.drugClass]!.against)) return 'cross-allergy'
  return null
}

export const ALLERGY_TAG_LABEL: Record<AllergyTag, string> = {
  conflict: '与过敏史冲突',
  'cross-allergy': '交叉过敏风险',
}

// The authoritative total quantity, computed the same way the draft table previews it:
// dose units used over the course, or whole packages when the dose unit is not the dispense unit.
export function totalQuantity(
  item: Pick<MedicationCatalogItemView, 'pack' | 'unit' | 'doseUnit'>,
  dose: number,
  frequency: MedicationFrequency,
  days: number,
): string {
  const units = dose * MEDICATION_FREQUENCIES[frequency].timesPerDay * days
  return item.doseUnit === item.unit ? `${units} ${item.unit}` : `${Math.ceil(units / item.pack)} ${item.unit}`
}

export interface PrescriptionLineRequest {
  drugId: string
  dose: number
  route: MedicationRoute
  frequency: MedicationFrequency
  days: number
  // Required for a cross-allergen line: the accepted reason and a note of at least four characters.
  override?: { reason: string; note: string }
}

export interface IssuedPrescriptionLine {
  lineId: string
  drugId: string
  name: string
  spec: string
  dose: number
  doseUnit: string
  route: MedicationRoute
  frequency: MedicationFrequency
  days: number
  totalQuantity: string
  drugClass: string
  drugClassName: string
  overrideReason: string | null
  overrideNote: string | null
  practitionerId: string
  issuedAt: string
}

export interface NoMedicationConclusion {
  practitionerId: string
  recordedAt: string
}

export interface PrescriptionsView {
  lines: IssuedPrescriptionLine[]
  noMedication: NoMedicationConclusion | null
}

export interface PrescriptionsResponse {
  prescriptions: PrescriptionsView
}

export interface IssuePrescriptionRequest {
  lines: PrescriptionLineRequest[]
}

// Issuing and recording run after Clinical Confirmation; the server re-verifies every gate atomically.
export interface RecordNoMedicationRequest {}
