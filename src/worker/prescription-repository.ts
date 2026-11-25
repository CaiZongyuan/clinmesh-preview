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
  type MedicationFrequency,
  type MedicationRoute,
  type NoMedicationConclusion,
  type PrescriptionLineRequest,
  type PrescriptionsView,
} from '../shared/medication'
import type { EncounterError } from '../shared/encounter'
import { CROSS_ALLERGY } from '../shared/medication'
import type { EncounterRepository } from './encounter-repository'
import { medication } from './medication-catalog'

export type PrescriptionsResult = { ok: true; prescriptions: PrescriptionsView } | { ok: false; error: EncounterError }

type LineRow = {
  line_id: string
  drug_id: string
  drug_name: string
  spec: string
  dose: number
  dose_unit: string
  route: MedicationRoute
  frequency: MedicationFrequency
  days: number
  total_quantity: string
  drug_class: string
  drug_class_name: string
  override_reason: string | null
  override_note: string | null
  practitioner_id: string
  issued_at: string
}

type NoMedicationRow = { practitioner_id: string; recorded_at: string }

const refuse = (error: EncounterError) => ({ ok: false, error }) as const

// Line list from a request body: valid prescribable fields, no duplicate drugs. Null when malformed.
export function prescriptionLines(list: unknown): PrescriptionLineRequest[] | null {
  if (!Array.isArray(list) || list.length === 0) return null
  const lines: PrescriptionLineRequest[] = []
  for (const item of list) {
    const { drugId, dose, route, frequency, days, override } = (item ?? {}) as Record<string, unknown>
    if (typeof drugId !== 'string') return null
    if (typeof dose !== 'number' || !(dose > 0)) return null
    if (!MEDICATION_ROUTES.includes(route as MedicationRoute)) return null
    if (typeof frequency !== 'string' || !(frequency in MEDICATION_FREQUENCIES)) return null
    if (typeof days !== 'number' || !Number.isInteger(days) || days < MIN_MEDICATION_DAYS || days > MAX_MEDICATION_DAYS)
      return null
    let accepted: PrescriptionLineRequest['override']
    if (override !== undefined) {
      const { reason, note } = (override ?? {}) as Record<string, unknown>
      if (typeof reason !== 'string' || typeof note !== 'string') return null
      accepted = { reason, note }
    }
    lines.push({
      drugId,
      dose,
      route: route as MedicationRoute,
      frequency: frequency as MedicationFrequency,
      days,
      ...(accepted ? { override: accepted } : {}),
    })
  }
  if (new Set(lines.map((line) => line.drugId)).size !== lines.length) return null
  return lines
}

// Callers run each command inside one storage transaction, so a refused command writes nothing.
export class PrescriptionRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly encounters: EncounterRepository,
  ) {}

  view(encounterId: string): PrescriptionsResult {
    const found = this.encounters.get(encounterId)
    return found.ok ? { ok: true, prescriptions: this.read(encounterId) } : found
  }

  // Issues the whole prescription or none of it. Gates, in order: an active Encounter, no No Medication
  // conclusion, a confirmed Diagnosis, the class-level allergy red line (no override), then the
  // cross-allergen acceptance per line.
  issue(encounterId: string, lines: PrescriptionLineRequest[], practitionerId: string, now: string): PrescriptionsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    if (this.noMedicationRow(encounterId)) {
      return refuse({
        code: 'no-medication-conflict',
        message: '已记录无需用药结论，与处方互斥，无法开具处方。',
      })
    }
    if (!this.diagnosisConfirmed(encounterId)) {
      return refuse({ code: 'diagnosis-not-confirmed', message: '须先确认诊断，才能开具处方。' })
    }
    const allergyClasses = active.encounter.visibleSourceHistory.allergies
      .map((allergy) => allergy.drugClass)
      .filter((cls): cls is string => typeof cls === 'string')
    const resolved = lines.map((line) => {
      const drug = medication(line.drugId)
      return drug ? { line, drug } : null
    })
    if (resolved.some((entry) => entry === null)) {
      return refuse({ code: 'catalog-item-not-found', message: '处方中含有本院药房没有的药品。' })
    }
    const tagged = resolved.map((entry) => ({ ...entry!, tag: allergyTagFor(entry!.drug, allergyClasses) }))

    // The red line refuses the whole prescription server-side; there is no override path.
    const conflicts = tagged.filter((entry) => entry.tag === 'conflict')
    if (conflicts.length > 0) {
      const names = conflicts.map((entry) => entry.drug.name).join('、')
      return refuse({
        code: 'MEDICATION_ALLERGY_CONFLICT',
        message: `药事安全红线拦截（不可越权）：${names}（${conflicts
          .map((entry) => entry.drug.drugClassName)
          .join('、')}）与患者过敏史冲突。整张处方未开具，请删除相关药品后重新提交。`,
      })
    }

    for (const entry of tagged) {
      if (entry.tag !== 'cross-allergy') continue
      const override = entry.line.override
      const note = override?.note.trim() ?? ''
      if (!override || !(CROSS_ALLERGY_REASONS as readonly string[]).includes(override.reason) || note.length < MIN_OVERRIDE_NOTE_LENGTH) {
        const { message } = CROSS_ALLERGY[entry.drug.drugClass]!
        return refuse({
          code: 'medication-override-required',
          message: `${entry.drug.name} ${message}：须从固定原因列表中选择登记原因，并填写至少 ${MIN_OVERRIDE_NOTE_LENGTH} 字的补充说明。`,
        })
      }
    }

    for (const { line, drug, tag } of tagged) {
      const lineId = crypto.randomUUID()
      this.sql.exec(
        `INSERT INTO prescription_line
           (line_id, encounter_id, drug_id, drug_name, spec, dose, dose_unit, route, frequency, days,
            total_quantity, drug_class, drug_class_name, override_reason, override_note, practitioner_id, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lineId,
        encounterId,
        drug.id,
        drug.name,
        drug.spec,
        line.dose,
        drug.doseUnit,
        line.route,
        line.frequency,
        line.days,
        totalQuantity(drug, line.dose, line.frequency, line.days),
        drug.drugClass,
        drug.drugClassName,
        line.override?.reason ?? null,
        line.override?.note.trim() ?? null,
        practitionerId,
        now,
      )
      const subject =
        tag === 'cross-allergy'
          ? `${drug.id}（登记原因：${line.override!.reason}；说明：${line.override!.note.trim()}）`
          : drug.id
      this.encounters.audit(encounterId, 'prescription-issued', practitionerId, now, subject)
    }
    return { ok: true, prescriptions: this.read(encounterId) }
  }

  // Records the explicit No Medication conclusion, mutually exclusive with issued prescriptions.
  recordNoMedication(encounterId: string, practitionerId: string, now: string): PrescriptionsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    if (this.lineRows(encounterId).length > 0) {
      return refuse({ code: 'no-medication-conflict', message: '已有开具的处方，与无需用药结论互斥。' })
    }
    if (!this.diagnosisConfirmed(encounterId)) {
      return refuse({ code: 'diagnosis-not-confirmed', message: '须先确认诊断，才能记录无需用药。' })
    }
    this.sql.exec(
      'INSERT INTO no_medication (encounter_id, practitioner_id, recorded_at) VALUES (?, ?, ?)',
      encounterId,
      practitionerId,
      now,
    )
    this.encounters.audit(encounterId, 'no-medication-recorded', practitionerId, now)
    return { ok: true, prescriptions: this.read(encounterId) }
  }

  private read(encounterId: string): PrescriptionsView {
    return {
      lines: this.lineRows(encounterId).map(
        (row): IssuedPrescriptionLine => ({
          lineId: row.line_id,
          drugId: row.drug_id,
          name: row.drug_name,
          spec: row.spec,
          dose: row.dose,
          doseUnit: row.dose_unit,
          route: row.route,
          frequency: row.frequency,
          days: row.days,
          totalQuantity: row.total_quantity,
          drugClass: row.drug_class,
          drugClassName: row.drug_class_name,
          overrideReason: row.override_reason,
          overrideNote: row.override_note,
          practitionerId: row.practitioner_id,
          issuedAt: row.issued_at,
        }),
      ),
      noMedication: this.noMedicationView(encounterId),
    }
  }

  private lineRows(encounterId: string): LineRow[] {
    return this.sql
      .exec<LineRow>('SELECT * FROM prescription_line WHERE encounter_id = ? ORDER BY issued_at, line_id', encounterId)
      .toArray()
  }

  private noMedicationRow(encounterId: string): NoMedicationRow | undefined {
    return this.sql.exec<NoMedicationRow>('SELECT practitioner_id, recorded_at FROM no_medication WHERE encounter_id = ?', encounterId)
      .toArray()[0]
  }

  private noMedicationView(encounterId: string): NoMedicationConclusion | null {
    const row = this.noMedicationRow(encounterId)
    return row ? { practitionerId: row.practitioner_id, recordedAt: row.recorded_at } : null
  }

  private diagnosisConfirmed(encounterId: string): boolean {
    return (
      this.sql.exec<{ revisions: number }>('SELECT count(*) AS revisions FROM diagnosis_revision WHERE encounter_id = ?', encounterId)
        .one().revisions > 0
    )
  }
}
