import type { CopilotRead, CopilotReadData, CopilotReadResult } from './clinical-copilot/copilot-reads'
import type { ConsultationRepository } from './consultation-repository'
import type { EncounterRepository } from './encounter-repository'
import { catalogView } from './investigation-catalog'
import type { InvestigationRepository } from './investigation-repository'
import type { PhysicalExaminationRepository } from './physical-examination-repository'

// The workspace's answers to the Clinical Copilot's reads: projections of what the doctor can already see, read
// with plain SELECTs. Nothing here writes (not even a lazy Report release or reply expiry) or reads Case Truth.
export class CopilotReadModel {
  constructor(
    private readonly encounters: EncounterRepository,
    private readonly examinations: PhysicalExaminationRepository,
    private readonly investigations: InvestigationRepository,
    private readonly consultation: ConsultationRepository,
  ) {}

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
            investigations: this.investigations.view(encounter, now).map((i) => ({
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
        case 'released-reports':
          return this.investigations
            .view(encounter, now)
            .filter((i) => !read.investigationId || i.investigationId === read.investigationId)
            .flatMap((i) =>
              i.reports.map((report) => ({
                investigationId: i.investigationId,
                name: i.name,
                reportId: report.reportId,
                version: report.version,
                latest: report.version === Math.max(...i.reports.map((r) => r.version)),
                releasedAt: report.releasedAt,
                specimenOrSite: report.specimenOrSite,
                body: report.body,
                acknowledged: report.acknowledgement !== null,
              })),
            )
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
