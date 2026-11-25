import type { CopilotMention } from '../../shared/copilot-turn'
import type { ConsultationTurn } from '../../shared/consultation'
import type { BannerPatient, EncounterError, EncounterStatus, Triage, VisibleSourceHistory } from '../../shared/encounter'
import type { CatalogItemView, InvestigationCategory, ReportBody } from '../../shared/investigation'
import type { BodySystem, PhysicalExaminationView } from '../../shared/physical-examination'

// Everything the Clinical Copilot can ever read, all of it shown to the doctor too. Nothing here reaches Case
// Truth beyond what the doctor has uncovered, and no read changes a formal record.
export type CopilotRead =
  | { kind: 'encounter-state' }
  | { kind: 'visible-source-history' }
  | { kind: 'examination-findings'; system?: BodySystem }
  | { kind: 'released-reports'; investigationId?: string }
  | { kind: 'catalog'; query?: string }

export type CopilotNoteMention = Pick<CopilotMention, 'kind' | 'id'> & { content: string }

export interface CopilotEncounterState {
  status: EncounterStatus
  startedAt: string
  patient: BannerPatient
  triage: Triage
  // Settled turns only: a reply still being given, or one that failed, is not something the patient said.
  consultation: { speaker: ConsultationTurn['speaker']; text: string; at: string }[]
  examinedSystems: BodySystem[]
  investigations: {
    investigationId: string
    name: string
    category: InvestigationCategory
    issuedAt: string
    stage: string
    releasedVersions: number
  }[]
}

export interface CopilotReleasedReport {
  investigationId: string
  name: string
  reportId: string
  version: number
  latest: boolean
  releasedAt: string
  // Why an amended version corrected the one before it; null for version 1.
  correctionReason: string | null
  specimenOrSite: string
  body: ReportBody
  acknowledged: boolean
}

export type CopilotReadData = {
  'encounter-state': CopilotEncounterState
  'visible-source-history': VisibleSourceHistory
  'examination-findings': PhysicalExaminationView[]
  'released-reports': CopilotReleasedReport[]
  catalog: CatalogItemView[]
}

export type CopilotReadResult<K extends CopilotRead['kind'] = CopilotRead['kind']> =
  | { ok: true; data: CopilotReadData[K] }
  | { ok: false; error: EncounterError }

// The one workspace method the Clinical Copilot calls.
export interface CopilotWorkspace {
  readForCopilot<R extends CopilotRead>(encounterId: string, read: R): Promise<CopilotReadResult<R['kind']>>
}
