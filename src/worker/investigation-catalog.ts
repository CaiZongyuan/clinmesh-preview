import catalogData from '../../data/clinic-catalog/investigation-catalog.json'
import type { Sex } from '../shared/golden-case-queue'
import type {
  CatalogItemView,
  InvestigationCategory,
  ReportBody,
  ReportResultRow,
  ResultFlag,
} from '../shared/investigation'

// A baseline band applies to its sex ('any' for both) from `ageFrom` years until a later band of the same sex takes over.
interface Band {
  sex: Sex | 'any'
  ageFrom: number
}

export interface ReferenceRange {
  low?: number
  high?: number
  text: string
}

interface ResultBand extends Band {
  referenceRange: ReferenceRange
  value: number | string
}

interface NarrativeBand extends Band {
  findings: string
  impression: string
}

interface Analyte {
  id: string
  name: string
  unit: string
  decimals: number
  baseline?: ResultBand[]
}

export interface CatalogItem {
  id: string
  name: string
  category: InvestigationCategory
  pinyinInitials: string[]
  specimenOrSite: string
  department: string
  expectedTurnaround: string
  simulatedTurnaroundSeconds: number
  analytes?: Analyte[]
  narrative?: NarrativeBand[]
}

export interface RawCatalog {
  version: string
  reportingStaff: Record<string, { reporter: string; reviewer: string }>
  items: CatalogItem[]
}

export interface Patient {
  sex: Sex
  age: number
}

// What a Golden Case's Case Truth says about one Encounter's investigations; nothing else of the case.
export interface CaseTruthResults {
  laboratories: { id: string; catalogItem: string; value: number | string }[]
  textResults: { catalogItem: string; findings: string; impression: string }[]
}

const SEXES: readonly Sex[] = ['male', 'female']

// The band with the latest `ageFrom` that the patient has reached; admission guarantees there is exactly one.
export function bandFor<B extends Band>(bands: readonly B[], patient: Patient): B | undefined {
  return bands
    .filter((band) => (band.sex === 'any' || band.sex === patient.sex) && band.ageFrom <= patient.age)
    .sort((a, b) => b.ageFrom - a.ageFrom)[0]
}

export function flagFor(value: number | string, range: ReferenceRange): ResultFlag {
  if (typeof value === 'string') return value === range.text ? null : 'abnormal'
  if (range.low !== undefined && value < range.low) return 'low'
  if (range.high !== undefined && value > range.high) return 'high'
  return null
}

// Each sex has exactly one applicable band at each age where some band starts.
const unambiguous = (bands: readonly Band[]) =>
  SEXES.every((sex) =>
    bands.every((band) => bands.filter((b) => b.ageFrom === band.ageFrom && (b.sex === 'any' || b.sex === sex)).length <= 1),
  )

// Why an item may not enter the catalog, or null when it may. Every result must resolve from exactly one baseline
// rule for any patient, so each sex needs a band from birth and no two bands may tie, and a baseline value must
// itself be normal.
export function admissionRefusal(item: CatalogItem): string | null {
  const coversEveryone = (bands: readonly Band[] | undefined) =>
    !!bands?.length && SEXES.every((sex) => bands.some((band) => band.ageFrom === 0 && (band.sex === 'any' || band.sex === sex)))
  if (item.category === 'lab') {
    if (!item.analytes?.length) return 'has no analytes'
    for (const analyte of item.analytes) {
      if (!coversEveryone(analyte.baseline)) return `${analyte.id} has no baseline rule for every age and sex`
      if (!unambiguous(analyte.baseline!)) return `${analyte.id} has two baseline rules for the same age and sex`
      const abnormal = analyte.baseline!.find((band) => flagFor(band.value, band.referenceRange) !== null)
      if (abnormal) return `${analyte.id} has an abnormal baseline value`
    }
    return null
  }
  if (!coversEveryone(item.narrative)) return 'has no baseline rule for every age and sex'
  return unambiguous(item.narrative!) ? null : 'has two baseline rules for the same age and sex'
}

export function admitCatalog(raw: RawCatalog) {
  const admitted = raw.items.filter((item) => admissionRefusal(item) === null && raw.reportingStaff[item.department])
  return { ...raw, items: admitted }
}

const catalog = admitCatalog(catalogData as RawCatalog)

export const catalogVersion = catalog.version

export function catalogItem(id: string): CatalogItem | undefined {
  return catalog.items.find((item) => item.id === id)
}

export function catalogView(): CatalogItemView[] {
  return catalog.items.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    pinyinInitials: item.pinyinInitials,
    specimenOrSite: item.specimenOrSite,
    department: item.department,
    expectedTurnaround: item.expectedTurnaround,
  }))
}

export const reportingStaff = (item: CatalogItem) => catalog.reportingStaff[item.department]

// A Report's results come from the case's per-item overrides, else from the item's baseline rule; nothing is generated.
export function resolveReportBody(item: CatalogItem, patient: Patient, truth: CaseTruthResults): ReportBody {
  if (item.category !== 'lab') {
    const override = truth.textResults.find((t) => t.catalogItem === item.id)
    const { findings, impression } = override ?? bandFor(item.narrative!, patient)!
    return { kind: 'narrative', findings, impression }
  }
  const results = item.analytes!.map((analyte): ReportResultRow => {
    const band = bandFor(analyte.baseline!, patient)!
    const override = truth.laboratories.find((l) => l.catalogItem === item.id && l.id === analyte.id)
    const value = override ? override.value : band.value
    return {
      analyteId: analyte.id,
      name: analyte.name,
      value,
      decimals: analyte.decimals,
      unit: analyte.unit,
      referenceRange: band.referenceRange.text,
      flag: flagFor(value, band.referenceRange),
    }
  })
  return { kind: 'results', results }
}
