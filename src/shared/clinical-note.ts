export const NOTE_SECTIONS = ['chief-complaint', 'present-illness', 'past-history', 'findings', 'assessment', 'plan'] as const

export type NoteSection = (typeof NOTE_SECTIONS)[number]

export const NOTE_SECTION_NAME: Record<NoteSection, string> = {
  'chief-complaint': '主诉',
  'present-illness': '现病史',
  'past-history': '既往史与过敏史',
  findings: '体格检查与辅助检查',
  assessment: '评估与诊断依据',
  plan: '处理意见与随访',
}

// Signing refuses a Clinical Note whose required sections are blank.
export const REQUIRED_NOTE_SECTIONS: readonly NoteSection[] = ['chief-complaint', 'present-illness']

export const MAX_NOTE_SECTION_LENGTH = 1000

export const isNoteSection = (value: unknown): value is NoteSection => NOTE_SECTIONS.includes(value as NoteSection)

export type NoteSections = Record<NoteSection, string>

// Who last wrote a Draft section: the doctor at the workbench, or the Clinical Copilot.
export type DraftAuthor = 'doctor' | 'assistant'

export interface NoteSectionDraft {
  section: NoteSection
  content: string
  // Null until the section is first written.
  lastEditedBy: DraftAuthor | null
  updatedAt: string | null
}

// A signed, immutable revision. `seq` comes from the Encounter's clinical revision sequence, which Diagnosis
// revisions share, so a signature can be compared with the Diagnosis it was signed against.
export interface SignedNoteRevision {
  revisionId: string
  version: number
  seq: number
  sections: NoteSections
  practitionerId: string
  signedAt: string
}

export interface ClinicalNoteView {
  // Every section, in NOTE_SECTIONS order.
  draft: NoteSectionDraft[]
  // Oldest first.
  revisions: SignedNoteRevision[]
}

export interface ClinicalNoteResponse {
  note: ClinicalNoteView
}

export interface SaveNoteDraftRequest {
  sections: Partial<NoteSections>
}

// What the doctor confirmed in Clinical Confirmation: the revision records exactly this.
export interface SignClinicalNoteRequest {
  sections: NoteSections
}
