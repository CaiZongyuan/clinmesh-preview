import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_NOTE_SECTION_LENGTH,
  NOTE_SECTIONS,
  type DraftAuthor,
  type NoteSection,
  type NoteSections,
  type SignedNoteRevision,
} from '../../../shared/clinical-note'
import type { EncounterView } from '../../../shared/encounter'
import { fetchClinicalNote, saveClinicalNoteDraft, signClinicalNote } from '../../api'

const AUTOSAVE_DEBOUNCE_MS = 600

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'failed'; message: string }

const EMPTY = Object.fromEntries(NOTE_SECTIONS.map((section) => [section, ''])) as NoteSections

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

// Joins added text onto a section the way a doctor would, after a full stop or semicolon.
const joined = (before: string, added: string) => (before && !/[。；;\s]$/.test(before) ? `${before}；${added}` : before + added)

// The Clinical Note of one Encounter: the Draft the doctor edits, autosaved to the workspace after a short pause,
// and its signed revisions. Saves and signing run one at a time, in order, so a late save never lands after a signature.
export function useClinicalNote(encounter: EncounterView | null) {
  const encounterId = encounter?.encounterId ?? null
  const [loaded, setLoaded] = useState(false)
  const [sections, setSections] = useState<NoteSections>(EMPTY)
  const [authors, setAuthors] = useState<Partial<Record<NoteSection, DraftAuthor>>>({})
  const latestAuthors = useRef<Partial<Record<NoteSection, DraftAuthor>>>({})
  const [revisions, setRevisions] = useState<SignedNoteRevision[]>([])
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<NoteSections>(EMPTY)
  const dirty = useRef(new Set<NoteSection>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Sends every unsaved section now; resolves to whether they all reached the workspace.
  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current)
    if (!encounterId || dirty.current.size === 0) return queue.current.then(() => true)
    const changes = Object.fromEntries([...dirty.current].map((section) => [section, latest.current[section]]))
    const authored = Object.fromEntries([...dirty.current].filter((section) => latestAuthors.current[section] === 'assistant').map((section) => [section, 'assistant' as const]))
    dirty.current.clear()
    setSave({ kind: 'saving' })
    const saved = queue.current.then(async () => {
      try {
        const note = await saveClinicalNoteDraft(encounterId, changes, Object.keys(authored).length ? authored : undefined)
        for (const { section, content, lastEditedBy } of note.draft) {
          if (!authored[section] || dirty.current.has(section) || latestAuthors.current[section] !== 'assistant' || latest.current[section] !== changes[section]) continue
          latest.current = { ...latest.current, [section]: content }
          if (lastEditedBy) latestAuthors.current = { ...latestAuthors.current, [section]: lastEditedBy }
        }
        setSections(latest.current)
        setAuthors(latestAuthors.current)
        setRevisions(note.revisions)
        if (dirty.current.size === 0) setSave({ kind: 'saved', at: new Date().toISOString() })
        return true
      } catch (e) {
        for (const section of Object.keys(changes) as NoteSection[]) dirty.current.add(section)
        setSave({ kind: 'failed', message: message(e, '草稿保存失败') })
        return false
      }
    })
    queue.current = saved
    return saved
  }, [encounterId])

  useEffect(() => {
    latest.current = EMPTY
    latestAuthors.current = {}
    setAuthors({})
    dirty.current = new Set()
    setSections(EMPTY)
    setRevisions([])
    setSave({ kind: 'idle' })
    setError(null)
    setLoaded(false)
    if (!encounterId) return
    let current = true
    fetchClinicalNote(encounterId)
      .then((note) => {
        if (!current) return
        latest.current = Object.fromEntries(note.draft.map((d) => [d.section, d.content])) as NoteSections
        setSections(latest.current)
        latestAuthors.current = Object.fromEntries(note.draft.filter((entry) => entry.lastEditedBy).map((entry) => [entry.section, entry.lastEditedBy]))
        setAuthors(latestAuthors.current)
        setRevisions(note.revisions)
        setLoaded(true)
      })
      .catch((e: unknown) => current && setError(message(e, '病历加载失败')))
    return () => {
      current = false
    }
  }, [encounterId])

  // Leaving the Encounter or the page saves what is still waiting.
  useEffect(() => {
    const leave = () => void flush()
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [flush])

  const edit = useCallback(
    (section: NoteSection, text: string, author: DraftAuthor = 'doctor') => {
      latestAuthors.current = { ...latestAuthors.current, [section]: author }
      setAuthors(latestAuthors.current)
      latest.current = { ...latest.current, [section]: text }
      setSections(latest.current)
      dirty.current.add(section)
      setSave({ kind: 'saving' })
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  // Appends to a section; returns an undo that takes back just this text, or null when it would not fit.
  const append = useCallback(
    (section: NoteSection, text: string): (() => void) | null => {
      const before = latest.current[section]
      const after = joined(before, text)
      if (after.length > MAX_NOTE_SECTION_LENGTH) return null
      const added = after.slice(before.length)
      edit(section, after)
      return () => {
        const now = latest.current[section]
        const at = now.lastIndexOf(added)
        if (now === after) edit(section, before)
        else if (at >= 0) edit(section, now.slice(0, at) + now.slice(at + added.length))
      }
    },
    [edit],
  )

  const sign = useCallback(async (confirmed: NoteSections) => {
    if (!encounterId) return
    const signedSections = { ...confirmed }
    if (!(await flush())) throw new Error('草稿未能保存，请稍后再签署。')
    const signing = queue.current.then(() => signClinicalNote(encounterId, signedSections))
    queue.current = signing.catch(() => {})
    setRevisions((await signing).revisions)
  }, [encounterId, flush])

  const lastRevision = revisions.at(-1)
  return {
    loaded,
    error,
    sections,
    authors,
    authorOf: (section: NoteSection) => latestAuthors.current[section],
    contentOf: (section: NoteSection) => latest.current[section],
    revisions,
    save,
    unsignedChanges: !!lastRevision && NOTE_SECTIONS.some((section) => lastRevision.sections[section] !== sections[section]),
    edit,
    append,
    retrySave: () => void flush(),
    sign,
  }
}

export type ClinicalNote = ReturnType<typeof useClinicalNote>
