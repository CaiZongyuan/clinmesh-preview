import type { AgentEvent } from '../../shared/agent-wire'
import type { LlmEnv } from '../llm/config'
import { resolveLlmProvider } from '../llm/registry'
import { LlmError, type AgentKind, type LlmMessage, type ToolCall, type ToolSpec } from '../llm/types'
import { applyMigrations } from '../sqlite-migrations'
import { estimateTokens } from './context'
import { DeltaBuffer, EventLog, type LoggedEvent } from './event-log'
import { Outbox } from './outbox'
import { alarmScheduler, type Scheduler } from './ports'
import { AGENT_RUNTIME_MIGRATIONS } from './schema'
import { SocketHub } from './socket-hub'

export interface AgentRun {
  runId: string
  kind: string
  trigger: unknown
  externalRef: string | null
  deadlineAt: number | null
}

export type RunError = 'timeout' | 'llm-not-configured' | 'llm-error' | 'too-many-steps' | 'crashed-repeatedly'

export type RunOutcome = { status: 'done'; text: string } | { status: 'failed'; error: RunError; text: string }

export interface RunUsage {
  input: number
  output: number
  reasoning: number
  cached: number
  estimatedInput: number
}

// What makes one agent different from another; the runtime owns everything durable.
export interface AgentDefinition {
  kind: AgentKind
  // The next LLM step's messages and tools, rebuilt from the session binding and the active messages every step.
  buildContext(input: { binding: unknown; run: AgentRun; messages: LlmMessage[] }): { messages: LlmMessage[]; tools: ToolSpec[] }
  streamThinking: boolean
  // A run whose outcome another Durable Object must accept. Its reply stays `unsettled` (out of the context)
  // until `deliver` resolves true, and turns `void` when refused.
  settlement?: {
    payload(run: AgentRun, outcome: RunOutcome): unknown
    deliver(payload: unknown): Promise<boolean>
  }
}

export interface EnqueueRun {
  kind: string
  externalRef: string
  trigger: unknown
  deadlineAt: number | null
  // Context the run adds before it starts, each keyed by where it came from so a resent command adds it once.
  messages: { originRef: string; message: LlmMessage }[]
}

type RunRow = {
  run_id: string
  kind: string
  trigger_json: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  external_ref: string | null
  deadline_at: number | null
  attempts: number
}

const MAX_STEPS = 8
const MAX_RECOVERIES = 3
const WATCHDOG_MS = 5 * 60_000

const toRun = (row: RunRow): AgentRun => ({
  runId: row.run_id,
  kind: row.kind,
  trigger: JSON.parse(row.trigger_json),
  externalRef: row.external_ref,
  deadlineAt: row.deadline_at,
})

// A thin durable agent loop on Durable Object SQLite. Commands enqueue runs; the alarm executes them one at a
// time. Each LLM step's result is checkpointed, so a crash (or eviction) mid-run is recovered by the next alarm:
// the run restarts from its last checkpoint, or fails if its deadline passed.
export class DurableAgentRuntime {
  readonly events: EventLog
  readonly sockets: SocketHub
  private readonly outbox: Outbox
  private readonly sql: SqlStorage
  private pumping = false

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LlmEnv,
    private readonly agent: AgentDefinition,
    private readonly scheduler: Scheduler = alarmScheduler(ctx.storage),
  ) {
    this.sql = ctx.storage.sql
    this.events = new EventLog(this.sql)
    this.sockets = new SocketHub(ctx, this.events)
    this.outbox = new Outbox(this.sql)
  }

  // Call inside the host's constructor transaction, before the agent's own migrations.
  migrate(): void {
    applyMigrations(this.sql, 'agent_schema_migration', AGENT_RUNTIME_MIGRATIONS, 'runtime')
  }

  // Binds the session on first use; a different binding for the same agent is refused, never overwritten.
  bindSession(ref: string, binding: unknown): boolean {
    this.sql.exec(
      `INSERT INTO agent_session (singleton, agent_kind, binding_ref, binding_json, created_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (singleton) DO NOTHING`,
      this.agent.kind, ref, JSON.stringify(binding), Date.now(),
    )
    return this.sql.exec<{ binding_ref: string }>('SELECT binding_ref FROM agent_session').one().binding_ref === ref
  }

  // Idempotent by `externalRef`: resending the same command neither adds context twice nor runs twice.
  async enqueue(command: EnqueueRun): Promise<{ runId: string; created: boolean }> {
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec<{ run_id: string }>('SELECT run_id FROM agent_run WHERE external_ref = ?', command.externalRef)
        .toArray()[0]
      if (existing) return { runId: existing.run_id, created: false }
      const now = Date.now()
      for (const { originRef, message } of command.messages) {
        this.sql.exec(
          `INSERT INTO agent_message (role, content_json, origin_ref, state, created_at) VALUES (?, ?, ?, 'active', ?)
           ON CONFLICT (origin_ref) DO NOTHING`,
          message.role, JSON.stringify(message), originRef, now,
        )
      }
      const runId = crypto.randomUUID()
      const order = this.sql.exec<{ n: number | null }>('SELECT max(queue_order) AS n FROM agent_run').one().n ?? 0
      this.sql.exec(
        `INSERT INTO agent_run (run_id, kind, trigger_json, status, queue_order, external_ref, deadline_at, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
        runId, command.kind, JSON.stringify(command.trigger ?? null), order + 1, command.externalRef, command.deadlineAt, now,
      )
      return { runId, created: true }
    })
    if (result.created) await this.scheduler.wakeAt(Date.now())
    return result
  }

  onAlarm(): Promise<void> {
    return this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        await this.deliverDue()
        const run = this.claimNext()
        if (!run) break
        await this.scheduler.wakeAt(run.deadlineAt ?? Date.now() + WATCHDOG_MS)
        await this.execute(run)
      }
    } finally {
      this.pumping = false
      // Computed in the same turn as the last claim, so a run enqueued meanwhile is never missed.
      await this.scheduler.wakeAt(this.nextWake())
    }
  }

  private nextWake(): number | null {
    const waiting = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM agent_run WHERE status IN ('queued', 'running')`).one().n
    return waiting > 0 ? Date.now() : this.outbox.nextAttemptAt()
  }

  // A `running` row seen here belongs to an execution that died with its instance: the run is recovered.
  private claimNext(): AgentRun | null {
    const published: LoggedEvent[] = []
    const run = this.ctx.storage.transactionSync((): AgentRun | null => {
      for (;;) {
        const now = Date.now()
        const row =
          this.sql.exec<RunRow>(`SELECT * FROM agent_run WHERE status = 'running'`).toArray()[0] ??
          this.sql.exec<RunRow>(`SELECT * FROM agent_run WHERE status = 'queued' ORDER BY queue_order LIMIT 1`).toArray()[0]
        if (!row) return null
        const run = toRun(row)
        if (run.deadlineAt !== null && now >= run.deadlineAt) {
          published.push(...this.close(run, { status: 'failed', error: 'timeout', text: '' }, null))
          continue
        }
        if (row.attempts >= MAX_RECOVERIES) {
          published.push(...this.close(run, { status: 'failed', error: 'crashed-repeatedly', text: '' }, null))
          continue
        }
        this.sql.exec(
          `UPDATE agent_run SET status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, ?) WHERE run_id = ?`,
          now, run.runId,
        )
        if (row.status === 'running') {
          this.events.dropDeltas(run.runId)
          published.push(this.events.append({ type: 'run.reset', runId: run.runId }))
        } else {
          published.push(this.events.append({ type: 'run.started', runId: run.runId, ref: run.externalRef }))
        }
        return run
      }
    })
    this.publish(published)
    return run
  }

  private async execute(run: AgentRun): Promise<void> {
    const deadline = run.deadlineAt === null ? null : AbortSignal.timeout(Math.max(0, run.deadlineAt - Date.now()))
    const signal = deadline ?? new AbortController().signal
    const deltas = new DeltaBuffer(run.runId, (event) => this.publish([this.events.append(event)]))
    const usage: RunUsage = { input: 0, output: 0, reasoning: 0, cached: 0, estimatedInput: 0 }
    let text = ''
    let outcome: RunOutcome
    try {
      const llm = resolveLlmProvider(this.env, this.agent.kind)
      if (!llm.ok) {
        outcome = { status: 'failed', error: llm.reason, text: '' }
      } else {
        outcome = { status: 'failed', error: 'too-many-steps', text: '' }
        for (let step = 0; step < MAX_STEPS; step++) {
          const context = this.agent.buildContext({ binding: this.binding(), run, messages: this.contextMessages() })
          usage.estimatedInput += context.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
          const toolCalls: ToolCall[] = []
          text = ''
          for await (const event of llm.provider.stream({ model: llm.model, effort: llm.effort, ...context }, signal)) {
            if (event.type === 'text.delta') {
              text += event.text
              deltas.push('text.delta', event.text)
            } else if (event.type === 'thinking.delta') {
              if (this.agent.streamThinking) deltas.push('thinking.delta', event.text)
            } else if (event.type === 'tool_call') {
              toolCalls.push({ id: event.id, name: event.name, argumentsJson: event.argumentsJson })
            } else if (event.type === 'usage') {
              usage.input += event.input
              usage.output += event.output
              usage.reasoning += event.reasoning ?? 0
              usage.cached += event.cached ?? 0
            }
          }
          deltas.flush()
          if (toolCalls.length === 0) {
            outcome = { status: 'done', text }
            break
          }
          this.checkpointToolStep(run.runId, text, toolCalls)
        }
      }
    } catch (error) {
      deltas.flush()
      const timedOut = deadline?.aborted ?? false
      outcome = { status: 'failed', error: timedOut ? 'timeout' : 'llm-error', text }
      if (!timedOut && !(error instanceof LlmError)) console.error('agent run failed', run.runId, error)
    } finally {
      deltas.discard()
    }
    // A provider that ignores the abort and answers late has still missed the deadline.
    if (outcome.status === 'done' && deadline?.aborted) outcome = { status: 'failed', error: 'timeout', text: outcome.text }
    const published = this.ctx.storage.transactionSync(() => this.close(run, outcome, usage))
    this.publish(published)
  }

  // Checkpoint after an LLM step that asked for tools. No agent has tools yet, so each call is answered with an
  // error the model can read, and the loop goes on to the next step.
  private checkpointToolStep(runId: string, text: string, toolCalls: ToolCall[]): void {
    this.ctx.storage.transactionSync(() => {
      const messages: LlmMessage[] = [
        { role: 'assistant', content: text, toolCalls },
        ...toolCalls.map((call): LlmMessage => ({ role: 'tool', toolCallId: call.id, content: `tool ${call.name} is not available` })),
      ]
      for (const message of messages) {
        this.sql.exec(
          `INSERT INTO agent_message (run_id, role, content_json, state, created_at) VALUES (?, ?, ?, 'active', ?)`,
          runId, message.role, JSON.stringify(message), Date.now(),
        )
      }
    })
  }

  // Closes a run inside the caller's transaction and returns the events to publish once it commits.
  private close(run: AgentRun, outcome: RunOutcome, usage: RunUsage | null): LoggedEvent[] {
    const now = Date.now()
    const settles = this.agent.settlement !== undefined
    if (outcome.status === 'done') {
      this.sql.exec(
        `INSERT INTO agent_message (run_id, role, content_json, origin_ref, state, created_at) VALUES (?, 'assistant', ?, ?, ?, ?)`,
        run.runId, JSON.stringify({ role: 'assistant', content: outcome.text } satisfies LlmMessage), run.externalRef,
        settles ? 'unsettled' : 'active', now,
      )
    }
    this.sql.exec(
      `UPDATE agent_run SET status = ?, error = ?, usage_json = ?, finished_at = ? WHERE run_id = ?`,
      outcome.status, outcome.status === 'failed' ? outcome.error : null, usage && JSON.stringify(usage), now, run.runId,
    )
    if (this.agent.settlement) this.outbox.enqueue(run.runId, this.agent.settlement.payload(run, outcome), now)
    this.events.dropDeltas(run.runId)
    const finished: AgentEvent = {
      type: 'run.finished',
      runId: run.runId,
      ref: run.externalRef,
      status: outcome.status,
      error: outcome.status === 'failed' ? outcome.error : null,
    }
    return [this.events.append(finished)]
  }

  private async deliverDue(): Promise<void> {
    const settlement = this.agent.settlement
    if (!settlement) return
    for (const entry of this.outbox.due(Date.now())) {
      try {
        const accepted = await settlement.deliver(entry.payload)
        this.ctx.storage.transactionSync(() => {
          this.outbox.delivered(entry.id, Date.now())
          this.sql.exec(
            `UPDATE agent_message SET state = ? WHERE run_id = ? AND state = 'unsettled'`,
            accepted ? 'active' : 'void', entry.runId,
          )
        })
      } catch (error) {
        this.outbox.failed(entry, Date.now(), String(error))
      }
    }
  }

  private binding(): unknown {
    const row = this.sql.exec<{ binding_json: string }>('SELECT binding_json FROM agent_session').toArray()[0]
    return row ? JSON.parse(row.binding_json) : null
  }

  // Active messages in order: the inputs runs were given, settled replies and tool-step checkpoints.
  private contextMessages(): LlmMessage[] {
    return this.sql
      .exec<{ content_json: string }>(`SELECT content_json FROM agent_message WHERE state = 'active' ORDER BY seq`)
      .toArray()
      .map((row) => JSON.parse(row.content_json) as LlmMessage)
  }

  private publish(events: LoggedEvent[]): void {
    for (const event of events) this.sockets.broadcast(event)
  }
}
