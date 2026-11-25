import { useEffect, useRef, useState } from 'react'
import type { ClinicalDrafts } from '../../shared/completion'
import { useClinicalNoteContext } from './clinical-note/clinical-note-context'
import { fetchClinicalDrafts, saveClinicalDraft } from '../api'

type DraftKind = keyof ClinicalDrafts
const EMPTY: ClinicalDrafts = { investigations: [], prescriptions: [] }

export function useClinicalDrafts(encounterId: string) {
  const [drafts, setDrafts] = useState(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = useRef(EMPTY)
  const jobs = useRef(Promise.resolve())
  const revision = useRef(0)
  const failures = useRef(new Set<DraftKind>())
  const incoming = useClinicalNoteContext()?.changes
  const investigations = incoming?.investigations
  const prescriptions = incoming?.prescriptions
  useEffect(() => {
    if (investigations?.module !== 'investigations') return
    current.current = { ...current.current, investigations: investigations.drafts.investigations }
    setDrafts(current.current)
  }, [investigations])
  useEffect(() => {
    if (prescriptions?.module !== 'prescriptions') return
    current.current = { ...current.current, prescriptions: prescriptions.drafts.prescriptions }
    setDrafts(current.current)
  }, [prescriptions])

  useEffect(() => {
    let mounted = true
    fetchClinicalDrafts(encounterId).then((loadedDrafts) => {
      if (!mounted) return
      current.current = loadedDrafts
      setDrafts(loadedDrafts)
      setLoaded(true)
    }).catch(() => mounted && setError('待提交草稿加载失败。'))
    return () => { mounted = false }
  }, [encounterId])

  function replace<K extends DraftKind>(kind: K, update: (entries: ClinicalDrafts[K]) => ClinicalDrafts[K]) {
    const entries = update(current.current[kind])
    current.current = { ...current.current, [kind]: entries }
    setDrafts(current.current)
    return entries
  }

  function change<K extends DraftKind>(kind: K, update: (entries: ClinicalDrafts[K]) => ClinicalDrafts[K]) {
    if (!loaded) return
    const entries = replace(kind, update)
    const saveRevision = ++revision.current
    setSaving(true)
    jobs.current = jobs.current.then(async () => {
      try {
        await saveClinicalDraft(encounterId, kind, entries)
        failures.current.delete(kind)
      } catch {
        failures.current.add(kind)
      } finally {
        if (saveRevision === revision.current) {
          setSaving(false)
          setError(failures.current.size ? '待提交草稿保存失败，请重试。' : null)
        }
      }
    })
  }

  async function flush() {
    await jobs.current
    if (!loaded || failures.current.size) throw new Error('待提交草稿尚未保存，请重试。')
  }

  function retry() {
    for (const kind of failures.current) change(kind, (entries) => entries)
  }

  return { drafts, loaded, saving, error, replace, change, flush, retry }
}

export type ClinicalDraftState = ReturnType<typeof useClinicalDrafts>
