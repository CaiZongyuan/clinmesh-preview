import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PrescriptionDraftLine } from '../../../shared/completion'
import type { ClinicalDraftState } from '../use-clinical-drafts'
import type { EncounterView } from '../../../shared/encounter'
import {
  allergyTagFor,
  type AllergyTag,
  type MedicationCatalogItemView,
  type MedicationFrequency,
  type MedicationRoute,
  type PrescriptionsView,
} from '../../../shared/medication'
import { fetchMedicationCatalog, fetchPrescriptions, issuePrescription, recordNoMedication } from '../../api'

export type DraftLine = PrescriptionDraftLine

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

// The 处方 tab's state: the formulary, the issued lines and No Medication conclusion of the Encounter, and
// the Draft the doctor edits until Clinical Confirmation posts it whole — a red line refusal
// leaves both the server record and this Draft untouched.
export function usePrescriptions(encounter: EncounterView, drafts: ClinicalDraftState) {
  const { encounterId, status } = encounter
  const [catalog, setCatalog] = useState<MedicationCatalogItemView[]>([])
  const [view, setView] = useState<PrescriptionsView>({ lines: [], noMedication: null })
  const draft = drafts.drafts.prescriptions
  const setDraft = (update: (entries: DraftLine[]) => DraftLine[]) => drafts.change('prescriptions', update)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    Promise.all([fetchMedicationCatalog(), fetchPrescriptions(encounterId)])
      .then(([items, prescriptions]) => {
        if (current) {
          setCatalog(items)
          setView(prescriptions)
        }
      })
      .catch((e: unknown) => current && setError(message(e, '处方信息加载失败')))
    return () => {
      current = false
    }
  }, [encounterId])

  // Class-level allergy tags, computed exactly as the server does when the prescription is issued.
  const allergyClasses = useMemo(
    () =>
      encounter.visibleSourceHistory.allergies
        .map((allergy) => allergy.drugClass)
        .filter((drugClass): drugClass is string => typeof drugClass === 'string'),
    [encounter.visibleSourceHistory.allergies],
  )
  const tagFor = useCallback((drug: Pick<MedicationCatalogItemView, 'drugClass'>) => allergyTagFor(drug, allergyClasses), [allergyClasses])
  // The drugs in the Draft that need the cross-allergy acceptance when the prescription is issued.
  const crossDrugIds = useMemo(
    () =>
      draft
        .filter((line) => {
          const drug = catalog.find((item) => item.id === line.drugId)
          return drug && allergyTagFor(drug, allergyClasses) === 'cross-allergy'
        })
        .map((line) => line.drugId),
    [draft, catalog, allergyClasses],
  )

  const writable = status === 'active' && !busy && drafts.loaded
  const drugOf = (drugId: string) => catalog.find((drug) => drug.id === drugId)

  const add = (drugId: string) => {
    const drug = drugOf(drugId)
    if (!drug || draft.some((line) => line.drugId === drugId) || view.lines.some((line) => line.drugId === drugId) || view.noMedication)
      return
    setError(null)
    setDraft((entries) => entries.some((entry) => entry.drugId === drugId) ? entries : [...entries, { drugId, ...drug.defaults }])
  }

  const edit = (drugId: string, field: keyof Omit<DraftLine, 'drugId'>, value: number | MedicationRoute | MedicationFrequency) =>
    setDraft((entries) => entries.map((line) => (line.drugId === drugId ? { ...line, [field]: value } : line)))

  const remove = (drugId: string) => setDraft((entries) => entries.filter((line) => line.drugId !== drugId))

  const run = useCallback(async (command: () => Promise<PrescriptionsView>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      const next = await command()
      setView(next)
      return next
    } catch (e) {
      setError(message(e, fallback))
      throw e
    } finally {
      setBusy(false)
    }
  }, [])

  const issue = (override?: { reason: string; note: string }) =>
    run(
      async () => {
        await drafts.flush()
        return issuePrescription(
          encounterId,
          draft.map((line) =>
            crossDrugIds.includes(line.drugId) && override ? { ...line, override } : line,
          ),
        )
      },
      '开具处方失败',
    ).then((next) => {
      // A clean issuance empties the Draft; a refusal leaves it exactly as it was.
      drafts.replace('prescriptions', (entries) => entries.filter((line) => !draft.includes(line)))
      return next
    })

  const recordNoMed = () => run(() => recordNoMedication(encounterId), '记录无需用药失败')

  return {
    catalog,
    view,
    draft,
    error,
    busy,
    writable,
    tagFor: tagFor as (drug: Pick<MedicationCatalogItemView, 'drugClass'>) => AllergyTag | null,
    crossDrugIds,
    add,
    edit,
    remove,
    clearDraft: () => setDraft(() => []),
    issue,
    recordNoMed,
    drugOf,
  }
}

export type PrescriptionsState = ReturnType<typeof usePrescriptions>
