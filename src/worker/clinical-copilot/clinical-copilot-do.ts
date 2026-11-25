import { DurableObject } from 'cloudflare:workers'
import type {
  CopilotConfigRequest,
  CopilotFeedback,
  CopilotModelSetting,
  CopilotPromptRequest,
  CopilotPromptResponse,
  CopilotResendRequest,
  CopilotSnapshot,
  CopilotStopResponse,
} from '../../shared/copilot-turn'
import type { EncounterError } from '../../shared/encounter'
import { DurableAgentRuntime, RunHalted, type AgentDefinition } from '../durable-agent/runtime'
import { resolveLlmConfig, type LlmEnv } from '../llm/config'
import { applyMigrations } from '../sqlite-migrations'
import { WORKSPACE_NAME } from '../workspace-name'
import { COPILOT_SYSTEM_PROMPT, encounterOverview, promptContent } from './copilot-context'
import type { CopilotRead, CopilotReadResult } from './copilot-reads'
import { readSession, type CopilotTrigger } from './copilot-session'
import { copilotTools } from './copilot-tools'

// Append-only, recorded under component `copilot` in `agent_schema_migration`, after the runtime's own.
const COPILOT_MIGRATIONS: readonly string[] = [
  // The doctor's helpful / not helpful mark on a reply, one per turn.
  `CREATE TABLE copilot_feedback (
     run_id TEXT PRIMARY KEY,
     value TEXT NOT NULL CHECK (value IN ('up', 'down')),
     updated_at INTEGER NOT NULL
   );`,
]

export type CopilotResult<T> = { ok: true; value: T } | { ok: false; error: EncounterError }

// Who sent a command, as the workspace authorized it.
export interface CopilotCommandContext {
  practitionerId: string
}

const busy: EncounterError = { code: 'copilot-busy', message: '临床助手正在运行或有排队任务，请停止或等待后再重新发送。' }
const notFound = (turnId: string): EncounterError => ({ code: 'copilot-turn-not-found', message: `找不到临床助手的第 ${turnId} 轮` })

// One per Encounter (addressed by its id). It reads the workspace only through `readForCopilot`, the read-only
// projection of what the doctor can see; it never imports the Golden Case pack and has no tool that writes.
export class ClinicalCopilotDO extends DurableObject<Env> {
  private readonly runtime: DurableAgentRuntime

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const read = <R extends CopilotRead>(request: R): Promise<CopilotReadResult<R['kind']>> =>
      env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME).readForCopilot(this.encounterId(), request) as Promise<CopilotReadResult<R['kind']>>
    const tools = copilotTools(read)
    const agent: AgentDefinition = {
      kind: 'copilot',
      streamThinking: true,
      traceSteps: true,
      tools,
      buildContext: async ({ messages }) => {
        const state = await read({ kind: 'encounter-state' })
        // A frozen Encounter takes no more analysis: whatever is still running or queued stops.
        if (!state.ok || state.data.status !== 'active') throw new RunHalted('encounter-ended')
        return {
          messages: [{ role: 'system', content: `${COPILOT_SYSTEM_PROMPT}\n\n${encounterOverview(state.data)}` }, ...messages],
          tools: Object.values(tools).map((tool) => tool.spec),
        }
      },
    }
    this.runtime = new DurableAgentRuntime(ctx, env as unknown as LlmEnv, agent)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        this.runtime.migrate()
        applyMigrations(ctx.storage.sql, 'agent_schema_migration', COPILOT_MIGRATIONS, 'copilot')
      })
    })
  }

  async snapshot(encounterId: string): Promise<CopilotSnapshot> {
    this.bind(encounterId)
    return { seq: this.runtime.events.latestSeq(), model: this.modelSetting(), ...readSession(this.ctx.storage.sql) }
  }

  // Queued after anything running, or, as a steer, read by the running turn before its next step.
  async prompt(encounterId: string, request: CopilotPromptRequest, context: CopilotCommandContext): Promise<CopilotPromptResponse> {
    this.bind(encounterId)
    const trigger: CopilotTrigger = { kind: 'doctor', text: request.text, mentions: request.mentions, practitionerId: context.practitionerId }
    const content = promptContent(request.text, request.mentions)
    if (request.mode === 'steer') {
      const steered = await this.runtime.steer(request.clientPromptId, content, trigger, 'prompt')
      return { kind: steered.kind, turnId: steered.runId }
    }
    const { runId } = await this.runtime.enqueue({
      kind: 'prompt',
      externalRef: request.clientPromptId,
      trigger,
      deadlineAt: null,
      messages: [{ originRef: request.clientPromptId, message: { role: 'user', content } }],
    })
    return { kind: 'run', turnId: runId }
  }

  // Edit-and-resend and regenerate: a new turn from the context before `turnId`, which with every later turn is
  // superseded and leaves the context. Only while nothing runs or waits, so no running turn loses its context.
  async resend(
    encounterId: string,
    turnId: string,
    request: CopilotResendRequest,
    context: CopilotCommandContext,
  ): Promise<CopilotResult<CopilotPromptResponse>> {
    this.bind(encounterId)
    const sql = this.ctx.storage.sql
    const resent = sql.exec<{ run_id: string }>('SELECT run_id FROM agent_run WHERE external_ref = ?', request.clientPromptId).toArray()[0]
    if (resent) return { ok: true, value: { kind: 'run', turnId: resent.run_id } }
    const target = sql
      .exec<{ trigger_json: string; status: string; superseded_by: string | null; started_at: number | null }>(
        'SELECT trigger_json, status, superseded_by, started_at FROM agent_run WHERE run_id = ?',
        turnId,
      )
      .toArray()[0]
    if (!target || target.superseded_by || target.started_at === null || (JSON.parse(target.trigger_json) as CopilotTrigger).kind !== 'doctor') {
      return { ok: false, error: notFound(turnId) }
    }
    if (sql.exec<{ n: number }>(`SELECT count(*) AS n FROM agent_run WHERE status IN ('queued', 'running')`).one().n > 0) {
      return { ok: false, error: busy }
    }
    this.ctx.storage.transactionSync(() => this.runtime.voidFrom(turnId, request.clientPromptId))
    const prompted = await this.prompt(encounterId, { ...request, mode: 'queue' }, context)
    return { ok: true, value: prompted }
  }

  // Freeze hook for the Encounter's end (abandonment today; encounter completion can call the same hook): a
  // frozen Encounter takes no late analysis, so the running turn stops and every queued prompt closes stopped.
  freeze(encounterId: string): void {
    this.bind(encounterId)
    this.runtime.halt('encounter-ended')
  }

  stop(encounterId: string): CopilotStopResponse {
    this.bind(encounterId)
    return { stoppedTurnId: this.runtime.stop() }
  }

  setFeedback(encounterId: string, turnId: string, value: CopilotFeedback | null): CopilotResult<null> {
    this.bind(encounterId)
    const sql = this.ctx.storage.sql
    const finished = sql
      .exec(`SELECT 1 FROM agent_run WHERE run_id = ? AND status IN ('done', 'failed', 'stopped')`, turnId)
      .toArray().length
    if (!finished) return { ok: false, error: notFound(turnId) }
    this.ctx.storage.transactionSync(() => {
      if (value === null) sql.exec('DELETE FROM copilot_feedback WHERE run_id = ?', turnId)
      else {
        sql.exec(
          `INSERT INTO copilot_feedback (run_id, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          turnId, value, Date.now(),
        )
      }
      this.runtime.announce({ type: 'session.updated', runId: null })
    })
    return { ok: true, value: null }
  }

  // The model chip: a session-only choice among the models the environment offers.
  configure(encounterId: string, request: CopilotConfigRequest): CopilotResult<CopilotModelSetting> {
    this.bind(encounterId)
    if (!this.modelSetting().options.includes(request.model)) {
      return { ok: false, error: { code: 'invalid-request', message: `模型 ${request.model} 不在可选列表中` } }
    }
    this.ctx.storage.transactionSync(() => this.runtime.setSessionConfig({ model: request.model, effort: request.effort }))
    return { ok: true, value: this.modelSetting() }
  }

  async fetch(request: Request): Promise<Response> {
    return this.runtime.sockets.accept(request)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.runtime.sockets.onMessage(ws, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.runtime.sockets.onClose(ws, code, reason)
  }

  async alarm(): Promise<void> {
    await this.runtime.onAlarm()
  }

  private bind(encounterId: string): void {
    if (!this.runtime.bindSession(encounterId, { encounterId })) {
      throw new Error(`Clinical Copilot ${this.ctx.id} is bound to another Encounter`)
    }
  }

  private encounterId(): string {
    return this.ctx.storage.sql.exec<{ binding_ref: string }>('SELECT binding_ref FROM agent_session').one().binding_ref
  }

  private modelSetting(): CopilotModelSetting {
    const defaults = resolveLlmConfig(this.env as unknown as LlmEnv, 'copilot')
    const chosen = this.runtime.sessionConfig()
    return {
      model: chosen.model && defaults.modelOptions.includes(chosen.model) ? chosen.model : defaults.model,
      effort: chosen.effort ?? defaults.effort,
      defaultModel: defaults.model,
      defaultEffort: defaults.effort,
      options: defaults.modelOptions,
    }
  }
}
