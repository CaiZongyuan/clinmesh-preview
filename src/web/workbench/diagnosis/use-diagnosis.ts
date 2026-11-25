import { useCallback, useEffect, useState } from 'react'
import { MAX_DIAGNOSIS_ENTRIES, type DiagnosisDraftEntry, type DiagnosisView } from '../../../shared/diagnosis'
import type { EncounterView } from '../../../shared/encounter'
import { confirmDiagnosis, fetchDiagnosis, reopenDiagnosis, saveDiagnosisDraft } from '../../api'

export type DiagnosisState = {
  view: DiagnosisView
  error: string | null
  busy: boolean
  // Adds an entry as the doctor's; the first entry in an empty draft becomes the primary.
  add: (code: string) => void
  setPrimary: (code: string) => void
  remove: (code: string) => void
  confirm: () => Promise<DiagnosisView>
  revise: () => Promise<DiagnosisView>
}

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

// The Diagnosis of one Encounter: the Draft the doctor builds from the ICD-10 catalogue, and the confirmed
// revisions. Every change replaces the whole Draft on the workspace, so the server always holds the set the
// doctor sees; confirmations and reopens run one at a time.
export function useDiagnosis(encounter: EncounterView): DiagnosisState {
  const { encounterId } = encounter
  const [view, setView] = useState<DiagnosisView>({ draft: [], revisions: [] })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    fetchDiagnosis(encounterId)
      .then((diagnosis) => current && setView(diagnosis))
      .catch((e: unknown) => current && setError(message(e, '诊断加载失败')))
    return () => {
      current = false
    }
  }, [encounterId])

  const run = useCallback(
    async (command: () => Promise<DiagnosisView>, fallback: string): Promise<DiagnosisView> => {
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
    },
    [],
  )

  const updateDraft = useCallback(
    (entries: DiagnosisDraftEntry[]) => run(() => saveDiagnosisDraft(encounterId, entries), '诊断草稿保存失败'),
    [encounterId, run],
  )

  const add = useCallback(
    (code: string) => {
      if (view.draft.some((entry) => entry.code === code) || view.draft.length >= MAX_DIAGNOSIS_ENTRIES) return
      void updateDraft([...view.draft, { code, primary: view.draft.length === 0, source: 'doctor' }])
    },
    [view.draft, updateDraft],
  )

  const setPrimary = useCallback(
    (code: string) => void updateDraft(view.draft.map((entry) => ({ ...entry, primary: entry.code === code }))),
    [view.draft, updateDraft],
  )

  const remove = useCallback(
    (code: string) => {
      const remaining = view.draft.filter((entry) => entry.code !== code)
      // The draft must never lose its one primary mark: keep the selected primary unless it is the row being
      // removed, in which case the first remaining entry stands in.
      void updateDraft(
        remaining.map((entry, index) => ({ ...entry, primary: entry.primary || (index === 0 && !remaining.some((e) => e.primary)) })),
      )
    },
    [view.draft, updateDraft],
  )

  const confirm = useCallback(
    () => run(() => confirmDiagnosis(encounterId, view.draft), '确认诊断失败'),
    [encounterId, run, view.draft],
  )

  const revise = useCallback(() => run(() => reopenDiagnosis(encounterId), '修改诊断失败'), [encounterId, run])

  return {
    view,
    error,
    busy,
    add,
    setPrimary,
    remove,
    confirm,
    revise,
  }
}
