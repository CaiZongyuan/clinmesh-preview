import { isNoteSection } from '../shared/clinical-note'
import type { CopilotMention } from '../shared/copilot-turn'
import type { CopilotNoteMention, CopilotRead, CopilotReadData, CopilotReadResult } from './clinical-copilot/copilot-reads'
import type { ClinicalNoteRepository } from './clinical-note-repository'
import type { ConsultationRepository } from './consultation-repository'
import type { EncounterRepository } from './encounter-repository'
import { catalogView } from './investigation-catalog'
import type { InvestigationRepository } from './investigation-repository'
import type { PhysicalExaminationRepository } from './physical-examination-repository'

// The workspace's answers to the Clinical Copilot's reads: projections of what the doctor can already see. The
// only write a read can cause is the one a doctor's own read causes: releasing Reports that have come due by the
// Encounter's clock. Report content is read only through `releasedReports`, so a scripted amendment written ahead
// of its release time never reaches the Copilot. Callers run `read` inside one storage transaction.
export class CopilotReadModel {
  constructor(
    private readonly encounters: EncounterRepository,
    private readonly examinations: PhysicalExaminationRepository,
    private readonly investigations: InvestigationRepository,
    private readonly consultation: ConsultationRepository,
    private readonly notes: ClinicalNoteRepository,
  ) {}

  noteMentions(encounterId: string, mentions: readonly CopilotMention[]): CopilotNoteMention[] {
    const selected = mentions.filter(({ kind }) => kind === 'note-section' || kind === 'draft')
    if (selected.length === 0) return []
    const found = this.notes.view(encounterId)
    if (!found.ok) return []
    const { note } = found
    const resolved: CopilotNoteMention[] = []
    for (const { kind, id } of selected) {
      const separator = kind === 'note-section' ? id.indexOf(':') : -1
      const section = id.slice(separator + 1)
      if (!isNoteSection(section)) continue
      const revision = separator === -1
        ? note.revisions.at(-1)
        : note.revisions.find(({ revisionId }) => revisionId === id.slice(0, separator))
      const content = kind === 'draft'
        ? note.draft.find((draft) => draft.section === section)?.content
        : revision?.sections[section]
      if (content?.trim()) resolved.push({ kind, id, content })
    }
    return resolved
  }

  read<R extends CopilotRead>(encounterId: string, read: R, now: number): CopilotReadResult<R['kind']> {
    const found = this.encounters.get(encounterId)
    if (!found.ok) return found
    const { encounter } = found
    const data = (): CopilotReadData[CopilotRead['kind']] => {
      switch (read.kind) {
        case 'encounter-state': {
          const examined = this.examinations.list(encounterId)
          return {
            status: encounter.status,
            startedAt: encounter.startedAt,
            patient: encounter.patient,
            triage: encounter.triage,
            consultation: this.consultation
              .list(encounterId)
              .filter((turn) => turn.status === 'final')
              .map((turn) => ({ speaker: turn.speaker, text: turn.text, at: turn.settledAt ?? turn.createdAt })),
            examinedSystems: examined.ok ? examined.examinations.map((e) => e.system) : [],
            investigations: this.investigations.list(encounter, now).map((i) => ({
              investigationId: i.investigationId,
              name: i.name,
              category: i.category,
              issuedAt: i.issuedAt,
              stage: i.stages.at(-1)?.name ?? '已开立',
              releasedVersions: i.reports.length,
            })),
          }
        }
        case 'visible-source-history':
          return encounter.visibleSourceHistory
        case 'examination-findings': {
          const examined = this.examinations.list(encounterId)
          const all = examined.ok ? examined.examinations : []
          return read.system ? all.filter((e) => e.system === read.system) : all
        }
        case 'released-reports': {
          const names = new Map(this.investigations.list(encounter, now).map((i) => [i.investigationId, i.name]))
          const released = this.investigations
            .releasedReports(encounter, now)
            .filter((report) => !read.investigationId || report.investigationId === read.investigationId)
          const latest = new Map(released.map((report) => [report.investigationId, report.version]))
          return released.map((report) => ({
            investigationId: report.investigationId,
            name: names.get(report.investigationId) ?? '',
            reportId: report.reportId,
            version: report.version,
            latest: latest.get(report.investigationId) === report.version,
            releasedAt: report.releasedAt,
            correctionReason: report.correctionReason,
            specimenOrSite: report.specimenOrSite,
            body: report.body,
            acknowledged: report.acknowledgement !== null,
          }))
        }
        case 'catalog': {
          const query = read.query?.trim().toLowerCase()
          return catalogView().filter(
            (item) =>
              !query ||
              item.name.toLowerCase().includes(query) ||
              item.id.toLowerCase().includes(query) ||
              item.pinyinInitials.some((initials) => initials.toLowerCase().startsWith(query)),
          )
        }
      }
    }
    return { ok: true, data: data() as CopilotReadData[R['kind']] }
  }
}
