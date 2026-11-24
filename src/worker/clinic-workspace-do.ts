import { DurableObject } from 'cloudflare:workers'
import type { EncounterView } from '../shared/encounter'
import type { GoldenCaseQueueEntry } from '../shared/golden-case-queue'
import type { BodySystem } from '../shared/physical-examination'
import { EncounterRepository, type EncounterResult } from './encounter-repository'
import { encounterChart, goldenCaseRegistrations } from './golden-case-pack'
import { GoldenCaseRepository } from './golden-case-repository'
import { PhysicalExaminationRepository, type PhysicalExaminationResult } from './physical-examination-repository'
import type { InvestigationCatalogResponse } from '../shared/investigation'
import { catalogVersion, catalogView } from './investigation-catalog'
import { InvestigationRepository, type InvestigationsResult } from './investigation-repository'
import { migrateWorkspaceSchema } from './workspace-schema'

// Phase 1 has no login: every formal write and audit event is attributed to the single demo practitioner.
const DEMO_PRACTITIONER_ID = 'demo-practitioner'

export class ClinicWorkspaceDO extends DurableObject<Env> {
  private readonly goldenCases: GoldenCaseRepository
  private readonly encounters: EncounterRepository
  private readonly examinations: PhysicalExaminationRepository
  private readonly investigations: InvestigationRepository

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.goldenCases = new GoldenCaseRepository(ctx.storage.sql)
    this.encounters = new EncounterRepository(ctx.storage.sql)
    this.examinations = new PhysicalExaminationRepository(ctx.storage.sql, this.encounters)
    this.investigations = new InvestigationRepository(ctx.storage.sql, this.encounters)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        migrateWorkspaceSchema(ctx.storage.sql)
        this.goldenCases.reconcile(goldenCaseRegistrations())
      })
    })
  }

  listGoldenCaseQueue(): GoldenCaseQueueEntry[] {
    return this.goldenCases.listQueue()
  }

  startEncounter(caseId: string): EncounterResult {
    const chart = encounterChart(caseId)
    if (!chart) {
      return { ok: false, error: { code: 'golden-case-not-found', message: `找不到 Golden Case ${caseId}` } }
    }
    return this.ctx.storage.transactionSync(() =>
      this.encounters.start(caseId, chart, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  abandonEncounter(encounterId: string): EncounterResult {
    return this.ctx.storage.transactionSync(() =>
      this.encounters.abandon(encounterId, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  getEncounter(encounterId: string): EncounterResult {
    return this.encounters.get(encounterId)
  }

  getActiveEncounter(): EncounterView | null {
    return this.encounters.active()
  }

  listAuditEvents(encounterId: string) {
    return this.encounters.auditEvents(encounterId)
  }

  performPhysicalExamination(encounterId: string, system: BodySystem): PhysicalExaminationResult {
    return this.ctx.storage.transactionSync(() =>
      this.examinations.perform(encounterId, system, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  listPhysicalExaminations(encounterId: string) {
    return this.examinations.list(encounterId)
  }

  investigationCatalog(): InvestigationCatalogResponse {
    return { catalogVersion, items: catalogView() }
  }

  // Reading can release a Report that has come due, so it runs as a transaction like a command.
  listInvestigations(encounterId: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() => {
      const found = this.encounters.get(encounterId)
      return found.ok ? { ok: true, investigations: this.investigations.list(found.encounter, Date.now()) } : found
    })
  }

  issueInvestigations(encounterId: string, catalogItemIds: string[]): InvestigationsResult {
    return this.ctx.storage.transactionSync(() =>
      this.investigations.issue(encounterId, catalogItemIds, DEMO_PRACTITIONER_ID, Date.now()),
    )
  }

  releaseInvestigationNow(encounterId: string, investigationId: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() =>
      this.investigations.releaseNow(encounterId, investigationId, DEMO_PRACTITIONER_ID, Date.now()),
    )
  }

  acknowledgeReports(encounterId: string, reportIds: string[]): InvestigationsResult {
    return this.ctx.storage.transactionSync(() =>
      this.investigations.acknowledge(encounterId, reportIds, DEMO_PRACTITIONER_ID, Date.now()),
    )
  }
}
