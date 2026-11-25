import {
  NOTE_SECTION_NAME,
  NOTE_SECTIONS,
  REQUIRED_NOTE_SECTIONS,
  type ClinicalNoteView,
  type NoteSections,
  type SaveNoteDraftRequest,
  type SignClinicalNoteRequest,
} from '../../src/shared/clinical-note'
import type { EncounterError, EncounterView } from '../../src/shared/encounter'

type Refuse = (code: EncounterError['code'], message: string) => Response

export const emptyNote = (): ClinicalNoteView => ({
  draft: NOTE_SECTIONS.map((section) => ({ section, content: '', lastEditedBy: null, updatedAt: null })),
  revisions: [],
})

// The Clinical Note routes of the fake clinic API, following the contract the Worker seam pins down.
export function createFakeClinicalNotes(refuse: Refuse, notes: Record<string, ClinicalNoteView> = {}) {
  const byEncounter = new Map(Object.entries(structuredClone(notes)))
  const noteOf = (encounterId: string) => byEncounter.get(encounterId) ?? byEncounter.set(encounterId, emptyNote()).get(encounterId)!
  const respond = (encounterId: string, status = 200) => Response.json({ note: noteOf(encounterId) }, { status })

  function handle(method: string, encounter: EncounterView, action: string, body: unknown): Response | undefined {
    const { encounterId } = encounter
    if (method === 'GET' && action === 'clinical-note') return respond(encounterId)
    const write = (method === 'PATCH' && action === 'clinical-note/draft') || (method === 'POST' && action === 'clinical-note/revisions')
    if (!write) return undefined
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    const note = noteOf(encounterId)
    const now = new Date().toISOString()

    if (method === 'PATCH') {
      for (const [section, content] of Object.entries((body as SaveNoteDraftRequest).sections)) {
        const draft = note.draft.find((d) => d.section === section)!
        if (draft.content !== content) Object.assign(draft, { content, lastEditedBy: 'doctor', updatedAt: now })
      }
      return respond(encounterId)
    }

    const { sections } = body as SignClinicalNoteRequest
    const blank = REQUIRED_NOTE_SECTIONS.filter((section) => !sections[section].trim())
    if (blank.length) return refuse('clinical-note-incomplete', `签署前请填写必填项：${blank.map((s) => NOTE_SECTION_NAME[s]).join('、')}。`)
    const version = note.revisions.length + 1
    note.revisions.push({
      revisionId: `revision-${encounterId}-${version}`,
      version,
      seq: version,
      sections: { ...sections } as NoteSections,
      practitionerId: 'demo-practitioner',
      signedAt: now,
    })
    return respond(encounterId, 201)
  }

  return { handle, note: noteOf }
}
