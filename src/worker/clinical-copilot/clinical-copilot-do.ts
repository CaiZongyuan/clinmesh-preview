import { DurableObject } from 'cloudflare:workers'
import type { CopilotCompactResponse, CopilotContextView } from '../../shared/copilot-context'
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
import type { ToolSpec } from '../llm/types'
import type { AgentEvent } from '../../shared/agent-wire'
import { applyMigrations } from '../sqlite-migrations'
import { WORKSPACE_NAME } from '../workspace-name'
import { COPILOT_SYSTEM_PROMPT, encounterOverview, promptContent } from './copilot-context'
import { COMPACTION_SYSTEM_PROMPT, buildContextView, compactionItems, requestItems, rollingMessages, summarizeTranscript } from './copilot-accounting'
import { estimateTokens } from '../durable-agent/context'
import type { CopilotRead, CopilotReadResult } from './copilot-reads'
type ReadWorkspace = <R extends CopilotRead>(request: R) => Promise<CopilotReadResult<R['kind']>>
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
  // Context accounting and manual compaction (#13): one row per compaction marker the doctor triggered.
  // The seq range ties the summary to the rolling messages it replaced, so the runtime's supersede
  // invalidation covers derived material too.
  `CREATE TABLE copilot_compaction (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL,
     summarized_messages INTEGER NOT NULL,
     tokens_before INTEGER NOT NULL,
     tokens_after INTEGER NOT NULL,
     summary TEXT NOT NULL,
     from_seq INTEGER NOT NULL,
     upto_seq INTEGER NOT NULL,
     summary_seq INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
]

export type CopilotResult<T> = { ok: true; value: T } | { ok: false; error: EncounterError }

// Who sent a command, as the workspace authorized it.
export interface CopilotCommandContext {
  practitionerId: string
}

const busy: EncounterError = { code: 'copilot-busy', message: '临床助手正在运行或有排队任务，请停止或等待后再重新发送。' }
const notFound = (turnId: string): EncounterError => ({ code: 'copilot-turn-not-found', message: `找不到临床助手的第 ${turnId} 轮` })
const nothingToCompact: EncounterError = {
  code: 'copilot-nothing-to-compact',
  message: '没有可压缩的对话历史：还没有需要摘要的提问、回复或工具结果。',
}

// One per Encounter (addressed by its id). It reads the workspace only through `readForCopilot`, the read-only
// projection of what the doctor can see; it never imports the Golden Case pack and has no tool that writes.
export class ClinicalCopilotDO extends DurableObject<Env> {
  private readonly runtime: DurableAgentRuntime
  private readonly read: ReadWorkspace
  private readonly toolSpecs: ToolSpec[]

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.read = <R extends CopilotRead>(request: R): Promise<CopilotReadResult<R['kind']>> =>
      env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME).readForCopilot(this.encounterId(), request) as Promise<CopilotReadResult<R['kind']>>
    const tools = copilotTools(this.read)
    this.toolSpecs = Object.values(tools).map((tool) => tool.spec)
    const toolSpecs = this.toolSpecs
    const agent: AgentDefinition = {
      kind: 'copilot',
      streamThinking: true,
      traceSteps: true,
      tools,
      buildContext: async ({ run, messages }) => {
        const state = await this.read({ kind: 'encounter-state' })
        // A frozen Encounter takes no more analysis: whatever is still running or queued stops.
        if (!state.ok || state.data.status !== 'active') throw new RunHalted('encounter-ended')
        if (run.kind === 'compaction') {
          // The summarizer sees exactly the rolling history — never the live system context, which is
          // re-injected on every request and must not be compacted away.
          return {
            messages: [
              { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
              { role: 'user', content: `以下是临床助手本会话的对话历史，请输出摘要：\n\n${summarizeTranscript(messages)}` },
            ],
            tools: [],
          }
        }
        return {
          messages: [{ role: 'system', content: `${COPILOT_SYSTEM_PROMPT}\n\n${encounterOverview(state.data)}` }, ...messages],
          tools: toolSpecs,
        }
      },
      // #13: itemize exactly what each outbound request carries. The system message is the prompt plus the
      // re-injected 患者与分诊 (patient visible), 就诊状态 (HIS state) and 问诊记录 (consultation) sections,
      // split back by the same boundary; the durable messages are the rolling prompts, replies and results.
      account: ({ run, messages }) =>
        run.kind === 'compaction'
          ? compactionItems(messages)
          : requestItems({ messages, tools: toolSpecs }),
      // The compaction's finalization shares the run's closing transaction: the summary reply is already
      // persisted, so marking its inputs compacted and writing the marker is exactly as durable as the run.
      // A run that never completes (stopped, failed provider, frozen Encounter) settles nothing.
      settle: (run, outcome): AgentEvent[] => {
        if (run.kind !== 'compaction' || outcome.text.trim() === '') return []
        const sql = this.ctx.storage.sql
        const summarySeq = sql
          .exec<{ seq: number }>("SELECT seq FROM agent_message WHERE run_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1", run.runId)
          .toArray()[0]?.seq
        if (summarySeq === undefined) return []
        const summarized = sql
          .exec<{ seq: number; content_json: string }>(
            `SELECT seq, content_json FROM agent_message WHERE state = 'active' AND seq < ? AND (run_id IS NULL OR run_id != ?) ORDER BY seq`,
            summarySeq, run.runId,
          )
          .toArray()
        if (summarized.length === 0) return []
        const tokensBefore = summarized.reduce(
          (sum, row) => sum + estimateTokens((JSON.parse(row.content_json) as { content: string }).content),
          0,
        )
        for (const { seq } of summarized) sql.exec(`UPDATE agent_message SET state = 'compacted' WHERE seq = ? AND state = 'active'`, seq)
        sql.exec(
          `INSERT INTO copilot_compaction (run_id, summarized_messages, tokens_before, tokens_after, summary, from_seq, upto_seq, summary_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          run.runId, summarized.length, tokensBefore, estimateTokens(outcome.text.trim()), outcome.text.trim(),
          summarized[0].seq, summarized[summarized.length - 1].seq, summarySeq, Date.now(),
        )
        return [{ type: 'session.updated', runId: null }]
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

  // The 上下文 view (#13): what the next request would carry, the per-request timeline reconciled with the
  // provider's reported usage, the compaction markers, and the Case Truth row that is always zero. Reads need
  // only the Encounter to exist and work while it is frozen, like the session snapshot.
  async contextView(encounterId: string): Promise<CopilotContextView> {
    this.bind(encounterId)
    const state = await this.read({ kind: 'encounter-state' })
    const config = resolveLlmConfig(this.env as unknown as LlmEnv, 'copilot')
    return buildContextView(
      {
        systemContent: state.ok ? `${COPILOT_SYSTEM_PROMPT}\n\n${encounterOverview(state.data)}` : COPILOT_SYSTEM_PROMPT,
        messages: this.runtime.activeContextMessages(),
        tools: this.toolSpecs,
        modelWindow: config.contextWindow,
      },
      this.ctx.storage.sql,
    )
  }

  // Manual compaction (#13): a serialized runtime run of its own. It queues behind (or after) any ordinary
  // turn, so provider work never overlaps; the runtime's stall timeout and abort paths bound an
  // uncooperative provider; recovery replays it from its checkpoint; and freeze/stop close it without
  // settling — the rolling inputs stay untouched on failure. On completion its reply is the persisted
  // summary and `settle` marks the summarized inputs compacted and writes the marker.
  async compact(encounterId: string): Promise<CopilotResult<CopilotCompactResponse>> {
    this.bind(encounterId)
    const sql = this.ctx.storage.sql
    if (this.hasUnfinishedRun()) return { ok: false, error: busy }
    if (rollingMessages(sql).length === 0) return { ok: false, error: nothingToCompact }
    const { runId } = await this.runtime.enqueue({
      kind: 'compaction',
      externalRef: `compaction-${crypto.randomUUID()}`,
      trigger: { kind: 'doctor', text: '压缩上下文', mentions: [] },
      deadlineAt: null,
      messages: [],
    })
    return { ok: true, value: { turnId: runId } }
  }

  private hasUnfinishedRun(): boolean {
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM agent_run WHERE status IN ('queued', 'running')`).one().n > 0
  }

  // When a compaction run is superseded, its summary is void with it — but only the turns at or after the
  // resend target were stale. Restore the compacted originals that (a) no surviving summary still covers and
  // (b) belong to runs that are not themselves superseded. Runs' own superseded messages stay `void`.
  private restoreUncoveredCompacted(sql: SqlStorage): void {
    const voidedSummaries = sql
      .exec<{ from_seq: number; upto_seq: number }>(
        `SELECT c.from_seq, c.upto_seq FROM copilot_compaction c
         JOIN agent_message m ON m.seq = c.summary_seq AND m.state = 'void'
         JOIN agent_run r ON r.run_id = c.run_id AND r.superseded_by IS NOT NULL`,
      )
      .toArray()
    if (voidedSummaries.length === 0) return
    const surviving = sql
      .exec<{ from_seq: number; upto_seq: number }>(
        `SELECT c.from_seq, c.upto_seq FROM copilot_compaction c
         JOIN agent_message m ON m.seq = c.summary_seq AND m.state = 'active'`,
      )
      .toArray()
    const covered = (seq: number) => surviving.some((range) => seq >= range.from_seq && seq <= range.upto_seq)
    for (const range of voidedSummaries) {
      const candidates = sql
        .exec<{ seq: number; run_id: string | null; superseded: number }>(
          `SELECT m.seq, m.run_id, r.superseded_by IS NOT NULL AS superseded
           FROM agent_message m LEFT JOIN agent_run r ON r.run_id = m.run_id
           WHERE m.state = 'compacted' AND m.seq >= ? AND m.seq <= ?`,
          range.from_seq, range.upto_seq,
        )
        .toArray()
      for (const { seq, superseded } of candidates) {
        if (superseded || covered(seq)) continue
        sql.exec(`UPDATE agent_message SET state = 'active' WHERE seq = ? AND state = 'compacted'`, seq)
      }
    }
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
    this.ctx.storage.transactionSync(() => {
      this.runtime.voidFrom(turnId, request.clientPromptId)
      // A voided compaction summary no longer covers the pre-target originals it replaced: restore the ones
      // still valid (not themselves superseded, not covered by a surviving summary), so the valid prefix of a
      // compacted history survives an edit-and-resend while the stale remainder stays out.
      this.restoreUncoveredCompacted(this.ctx.storage.sql)
    })
    const prompted = await this.prompt(encounterId, { ...request, mode: 'queue' }, context)
    return { ok: true, value: prompted }
  }

  // A frozen Encounter takes no late analysis. Running and queued turns close stopped.
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
