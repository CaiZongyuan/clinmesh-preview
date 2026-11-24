import { DurableObject } from 'cloudflare:workers'
import type { EncounterView } from '../shared/encounter'
import type { GoldenCaseQueueEntry } from '../shared/golden-case-queue'
import { EncounterRepository, type EncounterResult } from './encounter-repository'
import { encounterChart, goldenCaseRegistrations } from './golden-case-pack'
import { GoldenCaseRepository } from './golden-case-repository'
import { migrateWorkspaceSchema } from './workspace-schema'

// Phase 1 has no login: every formal write and audit event is attributed to the single demo practitioner.
const DEMO_PRACTITIONER_ID = 'demo-practitioner'

export class ClinicWorkspaceDO extends DurableObject<Env> {
  private readonly goldenCases: GoldenCaseRepository
  private readonly encounters: EncounterRepository

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.goldenCases = new GoldenCaseRepository(ctx.storage.sql)
    this.encounters = new EncounterRepository(ctx.storage.sql)
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
}
