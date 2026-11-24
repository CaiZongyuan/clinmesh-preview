import { DurableObject } from 'cloudflare:workers'
import type { GoldenCaseQueueEntry } from '../shared/golden-case-queue'
import { goldenCaseRegistrations } from './golden-case-pack'
import { GoldenCaseRepository } from './golden-case-repository'

export class ClinicWorkspaceDO extends DurableObject<Env> {
  private readonly goldenCases: GoldenCaseRepository

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.goldenCases = new GoldenCaseRepository(ctx.storage.sql)
    ctx.blockConcurrencyWhile(async () => {
      this.goldenCases.ensureSchema()
      this.goldenCases.seed(goldenCaseRegistrations())
    })
  }

  listGoldenCaseQueue(): GoldenCaseQueueEntry[] {
    return this.goldenCases.listQueue()
  }
}
