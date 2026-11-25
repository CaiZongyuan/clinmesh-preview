import catalogData from '../../data/clinic-catalog/medication-catalog.json'
import {
  CROSS_ALLERGY_REASONS,
  MEDICATION_FREQUENCIES,
  MEDICATION_ROUTES,
  type MedicationCatalogItemView,
  type MedicationCatalogResponse,
  type MedicationFrequency,
  type MedicationRoute,
} from '../shared/medication'

interface RawItem {
  id: string
  name: string
  spec: string
  pack: number
  unit: string
  doseUnit: string
  drugClass: string
  drugClassName: string
  pinyinInitials: string[]
  defaults: { dose: number; route: string; frequency: string; days: number }
  insert: { indications: string; contraindications: string; notes: string }
}

interface RawCatalog {
  version: string
  items: RawItem[]
}

// Why an item may not enter the formulary, or null when it may: the browser search, the allergy tags and
// the insert summary all read this view, so every field must be complete and every default prescribable.
function admissionRefusal(item: RawItem): string | null {
  if (!(item.pack > 0) || !item.unit || !item.doseUnit) return `${item.id} has no package`
  if (!MEDICATION_ROUTES.includes(item.defaults.route as MedicationRoute)) return `${item.id} has an unknown route`
  if (!(item.defaults.frequency in MEDICATION_FREQUENCIES)) return `${item.id} has an unknown frequency`
  if (!(item.defaults.dose > 0)) return `${item.id} has a non-positive dose`
  if (!item.pinyinInitials.length) return `${item.id} has no pinyin initials`
  for (const field of ['indications', 'contraindications', 'notes'] as const) {
    if (!item.insert[field]) return `${item.id} has an incomplete package insert`
  }
  return null
}

const catalog = catalogData as RawCatalog
const admitted: MedicationCatalogItemView[] = catalog.items
  .filter((item) => admissionRefusal(item) === null)
  .map((item) => ({
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
      route: item.defaults.route as MedicationRoute,
      frequency: item.defaults.frequency as MedicationFrequency,
      days: item.defaults.days,
    },
    insert: { ...item.insert, source: '药品说明书摘要（合成）' },
  }))

export const catalogVersion = catalog.version

export function medicationCatalog(): MedicationCatalogResponse {
  return { catalogVersion, items: admitted }
}

export const medication = (id: string): MedicationCatalogItemView | undefined => admitted.find((item) => item.id === id)

export { CROSS_ALLERGY_REASONS }
