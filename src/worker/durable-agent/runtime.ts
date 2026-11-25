import type { AgentEvent } from '../../shared/agent-wire'
import type { ContextItem } from '../../shared/agent-context'
import type { LlmEnv, LlmOverride } from '../llm/config'
import { resolveLlmProvider } from '../llm/registry'
import { LlmError, type AgentKind, type LlmMessage, type LlmStreamEvent, type ToolCall, type ToolSpec } from '../llm/types'
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

export type RunError =
  | 'timeout'
  | 'stalled'
  | 'llm-not-configured'
  | 'llm-error'
  | 'too-many-steps'
  | 'crashed-repeatedly'

// Why a run stopped before it finished: the doctor pressed Stop, a newer run for the same subject replaced it,
// or the agent ended it (e.g. its Encounter ended).
export type StopReason = 'stop-requested' | 'superseded' | 'encounter-ended'

export type RunOutcome =
  | { status: 'done'; text: string }
  | { status: 'failed'; error: RunError; text: string }
  | { status: 'stopped'; reason: StopReason; text: string }

export interface RunUsage {
  input: number
  output: number
  reasoning: number
  cached: number
  estimatedInput: number
}

export interface ToolResult {
  ok: boolean
  // What the call looked at, in a few words, for the doctor reading the step.
  subject: string
  result: string
}

// A tool the runtime executes itself. Every tool an agent has today only reads.
export interface AgentTool {
  spec: ToolSpec
  execute(args: unknown, signal: AbortSignal): Promise<ToolResult>
}

// Thrown by an agent's context builder to end the run without an error, e.g. once its Encounter has ended.
export class RunHalted extends Error {
  constructor(readonly reason: StopReason) {
    super(reason)
  }
}

// What makes one agent different from another; the runtime owns everything durable.
export interface AgentDefinition {
  kind: AgentKind
  // The next LLM step's messages and tools, rebuilt from the session binding and the active messages every step.
  buildContext(input: { binding: unknown; run: AgentRun; messages: LlmMessage[] }):
    | { messages: LlmMessage[]; tools: ToolSpec[] }
    | Promise<{ messages: LlmMessage[]; tools: ToolSpec[] }>
  streamThinking: boolean
  // Tools the runtime executes by name; a call to any other tool gets an error the model can read.
  tools?: Readonly<Record<string, AgentTool>>
  // Announce steps, tool calls, steers and queued runs to viewers (the Clinical Copilot's session view).
  traceSteps?: boolean
  // Per-request context accounting (#13): itemizes what the next LLM step would carry, by category. The
  // items are stored with the step, so the doctor's context view can show and reconcile every request.
  account?: (context: { run: AgentRun; messages: LlmMessage[]; tools: ToolSpec[] }) => ContextItem[]
  // Finalizes a run durably, inside the closing transaction (the Clinical Copilot's compaction marks its
  // summarized messages compacted and writes its marker here). Called only when a run completed; the
  // returned events are appended to the log with the run's own closing event.
  settle?: (run: AgentRun, outcome: Extract<RunOutcome, { status: 'done' }>) => AgentEvent[]
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
  // Context the run adds when it starts, each keyed by where it came from so a resent command adds it once.
  messages: { originRef: string; message: LlmMessage }[]
  // What the run answers. Queued or running runs for the same subject are stopped as superseded.
  subject?: string
}

export type SteerResult = { kind: 'steer'; runId: string } | { kind: 'run'; runId: string }

type RunRow = {
  run_id: string
  kind: string
  trigger_json: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  external_ref: string | null
  deadline_at: number | null
  attempts: number
  input_json: string | null
  stop_requested_at: number | null
  stop_reason: StopReason | null
}

type ToolCallRow = { id: number; call_id: string; name: string; arguments_json: string; step: number }

const MAX_STEPS = 8
const MAX_RECOVERIES = 3
const WATCHDOG_MS = 5 * 60_000
const DEFAULT_STALL_MS = 60_000

const toRun = (row: RunRow): AgentRun => ({
  runId: row.run_id,
  kind: row.kind,
  trigger: JSON.parse(row.trigger_json),
  externalRef: row.external_ref,
  deadlineAt: row.deadline_at,
})

const positive = (value: unknown, fallback: number) => {
  const n = Number(value)
  return typeof value === 'string' && Number.isFinite(n) && n > 0 ? n : fallback
}

class RunStalled extends Error {}

async function untilAborted<T>(pending: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([aborted, pending])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// Reads a provider's stream but gives up the moment `signal` aborts, even if the provider ignores the abort and
// never yields again: a stuck provider must not hold the run (and the queue behind it) forever.
async function* abortable<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    for (;;) {
      signal.throwIfAborted()
      const result = await untilAborted(iterator.next(), signal)
      if (result.done) return
      yield result.value
    }
  } finally {
    iterator.return?.()?.catch(() => {})
  }
}

// A thin durable agent loop on Durable Object SQLite. Commands enqueue runs; the alarm executes them one at a
// time. Each LLM step and each tool result is checkpointed, so a crash (or eviction) mid-run is recovered by the
// next alarm: the run restarts from its last checkpoint, or fails if its deadline passed.
export class DurableAgentRuntime {
  readonly events: EventLog
  readonly sockets: SocketHub
  private readonly outbox: Outbox
  private readonly sql: SqlStorage
  private readonly stallMs: number
  private pumping = false
  private active: { runId: string; controller: AbortController } | null = null

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
    this.stallMs = positive(env.AGENT_STALL_TIMEOUT_MS, DEFAULT_STALL_MS)
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

  sessionConfig(): LlmOverride {
    const row = this.sql.exec<{ config_json: string }>('SELECT config_json FROM agent_session').toArray()[0]
    return row ? (JSON.parse(row.config_json) as LlmOverride) : {}
  }

  setSessionConfig(config: LlmOverride): void {
    this.sql.exec('UPDATE agent_session SET config_json = ?', JSON.stringify(config))
    this.announce({ type: 'session.updated', runId: null })
  }

  // Idempotent by `externalRef`: resending the same command neither adds context twice nor runs twice.
  async enqueue(command: EnqueueRun, { head = false } = {}): Promise<{ runId: string; created: boolean }> {
    const published: LoggedEvent[] = []
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec<{ run_id: string }>('SELECT run_id FROM agent_run WHERE external_ref = ?', command.externalRef)
        .toArray()[0]
      if (existing) return { runId: existing.run_id, created: false }
      if (command.subject !== undefined) published.push(...this.supersede(command.subject))
      const runId = this.insertRun(command, head)
      if (this.agent.traceSteps) published.push(this.events.append({ type: 'run.queued', runId, ref: command.externalRef }))
      return { runId, created: true }
    })
    this.publish(published)
    if (result.created) await this.scheduler.wakeAt(Date.now())
    return result
  }

  // A doctor's word while a run is running is read before that run's next step; with nothing running it is a run
  // of its own, ahead of anything queued. Idempotent by `clientRef`.
  async steer(clientRef: string, content: string, trigger: unknown, kind: string): Promise<SteerResult> {
    const steered = this.ctx.storage.transactionSync((): SteerResult | null => {
      const known = this.sql.exec<{ run_id: string }>('SELECT run_id FROM agent_steer WHERE client_ref = ?', clientRef).toArray()[0]
      if (known) return { kind: 'steer', runId: known.run_id }
      const running = this.sql.exec<{ run_id: string }>(`SELECT run_id FROM agent_run WHERE status = 'running'`).toArray()[0]
      if (!running) return null
      this.sql.exec(
        'INSERT INTO agent_steer (run_id, client_ref, content, trigger_json, created_at) VALUES (?, ?, ?, ?, ?)',
        running.run_id, clientRef, content, JSON.stringify(trigger), Date.now(),
      )
      this.announce({ type: 'steer.added', runId: running.run_id })
      return { kind: 'steer', runId: running.run_id }
    })
    if (steered) return steered
    const { runId } = await this.enqueue(
      { kind, externalRef: clientRef, trigger, deadlineAt: null, messages: [{ originRef: clientRef, message: { role: 'user', content } }] },
      { head: true },
    )
    return { kind: 'run', runId }
  }

  // Freezes the whole session: the running run stops with `reason` and every queued run closes stopped. The
  // Encounter calls this once it ends (abandonment today; completion hooks in the same way), so no turn may
  // still run or finish with a late reply after the Encounter is frozen.
  halt(reason: StopReason): void {
    const running = this.ctx.storage.transactionSync(() => {
      const queued = this.sql.exec<RunRow>(`SELECT * FROM agent_run WHERE status = 'queued'`).toArray()
      const published = queued.flatMap((row) => this.close(toRun(row), { status: 'stopped', reason, text: '' }, null))
      const active = this.sql.exec<{ run_id: string }>(`SELECT run_id FROM agent_run WHERE status = 'running'`).toArray()[0]
      if (active) this.requestStop(active.run_id, reason)
      this.publish(published)
      return active?.run_id ?? null
    })
    if (running) this.abortActive(running, reason)
  }

  // Stops the running run: its remaining steps are cancelled, what it already did stays. Queued runs go on.
  stop(): string | null {
    const runId = this.ctx.storage.transactionSync(() => {
      const running = this.sql.exec<{ run_id: string }>(`SELECT run_id FROM agent_run WHERE status = 'running'`).toArray()[0]
      if (!running) return null
      this.requestStop(running.run_id, 'stop-requested')
      return running.run_id
    })
    if (runId) this.abortActive(runId)
    return runId
  }

  // Marks `fromRunId` and every run that started after it superseded by `byRunRef`, and voids their messages, so
  // an edited or regenerated prompt starts from the context before it. Only finished runs can be superseded.
  voidFrom(fromRunId: string, byRunRef: string): void {
    const from = this.sql.exec<{ started_at: number }>('SELECT started_at FROM agent_run WHERE run_id = ?', fromRunId).one()
    const runs = this.sql
      .exec<{ run_id: string }>(
        `SELECT run_id FROM agent_run WHERE started_at >= ? AND status IN ('done', 'failed', 'stopped') AND superseded_by IS NULL`,
        from.started_at,
      )
      .toArray()
    for (const { run_id } of runs) {
      this.sql.exec('UPDATE agent_run SET superseded_by = ? WHERE run_id = ?', byRunRef, run_id)
      this.sql.exec(`UPDATE agent_message SET state = 'void' WHERE run_id = ?`, run_id)
    }
    this.announce({ type: 'session.updated', runId: null })
  }

  // Appends an event and sends it to ready viewers; call inside a transaction or alone.
  announce(event: AgentEvent): void {
    this.publish([this.events.append(event)])
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
        let run: AgentRun | null
        try {
          run = this.claimNext()
        } catch (error) {
          // A run that cannot even be claimed (a bug, a corrupt row) must not hold the queue in a hot alarm loop.
          console.error('agent run could not be claimed', error)
          if (!this.quarantine()) throw error
          continue
        }
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

  private candidate(): RunRow | undefined {
    return (
      this.sql.exec<RunRow>(`SELECT * FROM agent_run WHERE status = 'running'`).toArray()[0] ??
      this.sql.exec<RunRow>(`SELECT * FROM agent_run WHERE status = 'queued' ORDER BY queue_order LIMIT 1`).toArray()[0]
    )
  }

  // A `running` row seen here belongs to an execution that died with its instance: the run is recovered.
  private claimNext(): AgentRun | null {
    const published: LoggedEvent[] = []
    const run = this.ctx.storage.transactionSync((): AgentRun | null => {
      for (;;) {
        const now = Date.now()
        const row = this.candidate()
        if (!row) return null
        const run = toRun(row)
        if (row.stop_requested_at !== null) {
          published.push(...this.close(run, { status: 'stopped', reason: row.stop_reason ?? 'stop-requested', text: '' }, null))
          continue
        }
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
          this.sql.exec(`DELETE FROM agent_step WHERE run_id = ? AND status = 'running'`, run.runId)
          published.push(this.events.append({ type: 'run.reset', runId: run.runId }))
        } else {
          const inputs = row.input_json ? (JSON.parse(row.input_json) as EnqueueRun['messages']) : []
          for (const { originRef, message } of inputs) {
            this.sql.exec(
              `INSERT INTO agent_message (run_id, role, content_json, origin_ref, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)
               ON CONFLICT (origin_ref) DO NOTHING`,
              run.runId, message.role, JSON.stringify(message), originRef, now,
            )
          }
          published.push(this.events.append({ type: 'run.started', runId: run.runId, ref: run.externalRef }))
        }
        return run
      }
    })
    this.publish(published)
    return run
  }

  private quarantine(runId?: string): boolean {
    const row = runId === undefined
      ? this.candidate()
      : this.sql.exec<RunRow>(
          `SELECT * FROM agent_run WHERE run_id = ? AND status = 'running'`,
          runId,
        ).toArray()[0]
    if (!row) return false
    let published: LoggedEvent[]
    try {
      published = this.ctx.storage.transactionSync(() =>
        this.close(toRun(row), { status: 'failed', error: 'crashed-repeatedly', text: '' }, null),
      )
    } catch {
      // A corrupted run can fail normal close again. Drop its incomplete context so it cannot block the next run.
      published = this.ctx.storage.transactionSync(() => {
        const now = Date.now()
        this.sql.exec(
          `UPDATE agent_run SET status = 'failed', error = 'crashed-repeatedly', finished_at = ? WHERE run_id = ?`,
          now, row.run_id,
        )
        this.sql.exec(`UPDATE agent_message SET state = 'void' WHERE run_id = ?`, row.run_id)
        this.sql.exec(
          `UPDATE agent_tool_call SET status = 'cancelled', completed_at = ? WHERE run_id = ? AND status = 'dispatched'`,
          now, row.run_id,
        )
        this.events.dropDeltas(row.run_id)
        return [...this.closeRunningSteps(row.run_id, 'failed', now), this.events.append({
          type: 'run.finished',
          runId: row.run_id,
          ref: row.external_ref,
          status: 'failed',
          error: 'crashed-repeatedly',
        })]
      })
    }
    this.publish(published)
    return true
  }

  private async execute(run: AgentRun): Promise<void> {
    const controller = new AbortController()
    this.active = { runId: run.runId, controller }
    const deadline = run.deadlineAt === null ? null : AbortSignal.timeout(Math.max(0, run.deadlineAt - Date.now()))
    const signal = deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal
    const deltas = new DeltaBuffer(run.runId, (event) => this.publish([this.events.append(event)]))
    const usage: RunUsage = { input: 0, output: 0, reasoning: 0, cached: 0, estimatedInput: 0 }
    let step = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM agent_step WHERE run_id = ?`, run.runId).one().n
    // A run recovered after a crash restarts past its committed tool steps, whose usage is already durable; keep
    // counting from there instead of from zero, or the closed run under-reports what its LLM calls cost.
    for (const row of this.sql
      .exec<{ usage_json: string }>(`SELECT usage_json FROM agent_step WHERE run_id = ? AND usage_json IS NOT NULL`, run.runId)
      .toArray()) {
      const committed = JSON.parse(row.usage_json) as { input: number; output: number }
      usage.input += committed.input
      usage.output += committed.output
    }
    let text = ''
    let thinking = ''
    let outcome: RunOutcome
    try {
      const llm = resolveLlmProvider(this.env, this.agent.kind, this.sessionConfig())
      if (!llm.ok) {
        outcome = { status: 'failed', error: llm.reason, text: '' }
      } else {
        outcome = { status: 'failed', error: 'too-many-steps', text: '' }
        for (; step < MAX_STEPS; step++) {
          await this.runDispatchedTools(run.runId, signal)
          this.consumeSteers(run.runId)
          const context = await this.withIdleLimit(signal, () =>
            this.agent.buildContext({ binding: this.binding(), run, messages: this.contextMessages(run.runId) }),
          )
          signal.throwIfAborted()
          const items = this.agent.account?.({ run, messages: context.messages, tools: context.tools })
          usage.estimatedInput += items ? items.reduce((sum, item) => sum + item.tokens, 0) : context.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
          this.beginStep(run.runId, step, items ?? null)
          const toolCalls: ToolCall[] = []
          const stepUsage = { input: 0, output: 0 }
          text = ''
          thinking = ''
          // A step that streams nothing for the stall timeout is abandoned, even if the provider ignores the abort.
          const idle = new AbortController()
          const stepSignal = AbortSignal.any([signal, idle.signal])
          let timer = setTimeout(() => idle.abort(), this.stallMs)
          try {
            const stream = llm.provider.stream({ model: llm.model, effort: llm.effort, ...context }, stepSignal)
            for await (const event of abortable<LlmStreamEvent>(stream, stepSignal)) {
              clearTimeout(timer)
              timer = setTimeout(() => idle.abort(), this.stallMs)
              if (event.type === 'text.delta') {
                text += event.text
                deltas.push('text.delta', event.text)
              } else if (event.type === 'thinking.delta') {
                thinking += event.text
                if (this.agent.streamThinking) deltas.push('thinking.delta', event.text)
              } else if (event.type === 'tool_call') {
                toolCalls.push({ id: event.id, name: event.name, argumentsJson: event.argumentsJson })
              } else if (event.type === 'usage') {
                usage.input += event.input
                usage.output += event.output
                usage.reasoning += event.reasoning ?? 0
                usage.cached += event.cached ?? 0
                stepUsage.input += event.input
                stepUsage.output += event.output
              }
            }
          } catch (error) {
            if (idle.signal.aborted && !signal.aborted) throw new RunStalled()
            throw error
          } finally {
            clearTimeout(timer)
          }
          deltas.flush()
          if (toolCalls.length === 0) {
            outcome = { status: 'done', text }
            break
          }
          this.checkpointToolStep(run.runId, step, { text, thinking, toolCalls, usage: stepUsage })
          text = ''
          thinking = ''
          await this.runDispatchedTools(run.runId, signal)
        }
      }
    } catch (error) {
      deltas.flush()
      if (controller.signal.aborted) {
        outcome = { status: 'stopped', reason: (controller.signal.reason as StopReason) ?? 'stop-requested', text }
      } else if (error instanceof RunHalted) {
        outcome = { status: 'stopped', reason: error.reason, text }
      } else if (deadline?.aborted) {
        outcome = { status: 'failed', error: 'timeout', text }
      } else if (error instanceof RunStalled) {
        outcome = { status: 'failed', error: 'stalled', text }
      } else {
        outcome = { status: 'failed', error: 'llm-error', text }
        if (!(error instanceof LlmError)) console.error('agent run failed', run.runId, error)
      }
    } finally {
      deltas.discard()
      this.active = null
    }
    // A provider that ignores the abort and answers late has still missed the deadline.
    if (outcome.status === 'done' && deadline?.aborted) outcome = { status: 'failed', error: 'timeout', text: outcome.text }
    try {
      const published = this.ctx.storage.transactionSync(() => [
        ...this.endStep(run.runId, step, outcome, thinking),
        ...this.close(run, outcome, usage),
      ])
      this.publish(published)
    } catch (error) {
      console.error('agent run could not be closed', run.runId, error)
      if (!this.quarantine(run.runId)) throw error
    }
  }

  private requestStop(runId: string, reason: StopReason): void {
    this.sql.exec(
      'UPDATE agent_run SET stop_requested_at = coalesce(stop_requested_at, ?), stop_reason = coalesce(stop_reason, ?) WHERE run_id = ?',
      Date.now(), reason, runId,
    )
  }

  private abortActive(runId: string, reason: StopReason = 'stop-requested'): void {
    if (this.active?.runId === runId) this.active.controller.abort(reason)
  }

  // Queued runs for the subject close as superseded; a running one is asked to stop. Returns events to publish.
  private supersede(subject: string): LoggedEvent[] {
    const published: LoggedEvent[] = []
    const rows = this.sql
      .exec<RunRow>(`SELECT * FROM agent_run WHERE subject = ? AND status IN ('queued', 'running')`, subject)
      .toArray()
    for (const row of rows) {
      if (row.status === 'queued') {
        published.push(...this.close(toRun(row), { status: 'stopped', reason: 'superseded', text: '' }, null))
      } else {
        this.requestStop(row.run_id, 'superseded')
        this.abortActive(row.run_id, 'superseded')
      }
    }
    return published
  }

  private insertRun(command: EnqueueRun, head: boolean): string {
    const runId = crypto.randomUUID()
    const order = head
      ? (this.sql.exec<{ n: number | null }>(`SELECT min(queue_order) AS n FROM agent_run WHERE status = 'queued'`).one().n ??
          this.sql.exec<{ n: number | null }>('SELECT max(queue_order) AS n FROM agent_run').one().n ??
          1) - 1
      : (this.sql.exec<{ n: number | null }>('SELECT max(queue_order) AS n FROM agent_run').one().n ?? 0) + 1
    this.sql.exec(
      `INSERT INTO agent_run (run_id, kind, trigger_json, status, queue_order, external_ref, deadline_at, created_at, subject, input_json)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      runId, command.kind, JSON.stringify(command.trigger ?? null), order, command.externalRef, command.deadlineAt, Date.now(),
      command.subject ?? null, JSON.stringify(command.messages),
    )
    return runId
  }

  private messageState(): 'unsettled' | 'active' {
    return this.agent.settlement ? 'unsettled' : 'active'
  }

  private insertMessage(runId: string, message: LlmMessage, originRef: string | null = null): void {
    this.sql.exec(
      `INSERT INTO agent_message (run_id, role, content_json, origin_ref, state, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      runId, message.role, JSON.stringify(message), originRef, this.messageState(), Date.now(),
    )
  }

  private beginStep(runId: string, step: number, items: ContextItem[] | null): void {
    if (!this.agent.traceSteps) return
    this.sql.exec(
      `INSERT OR REPLACE INTO agent_step (run_id, step, status, started_at, context_json) VALUES (?, ?, 'running', ?, ?)`,
      runId, step, Date.now(), items === null ? null : JSON.stringify(items),
    )
    this.announce({ type: 'step.started', runId, step })
  }

  // Closes the step the run ended in, inside the closing transaction.
  private endStep(runId: string, step: number, outcome: RunOutcome, thinking: string): LoggedEvent[] {
    if (!this.agent.traceSteps) return []
    const status = outcome.status === 'done' ? 'done' : outcome.status
    const changed = this.sql.exec(
      `UPDATE agent_step SET status = ?, thinking = ?, text = ?, finished_at = ? WHERE run_id = ? AND step = ? AND status = 'running'`,
      status, thinking, outcome.text, Date.now(), runId, step,
    ).rowsWritten
    return changed > 0 ? [this.events.append({ type: 'step.finished', runId, step })] : []
  }

  private closeRunningSteps(runId: string, status: RunOutcome['status'], now: number): LoggedEvent[] {
    if (!this.agent.traceSteps) return []
    return this.sql.exec<{ step: number }>(
      `UPDATE agent_step SET status = ?, finished_at = ? WHERE run_id = ? AND status = 'running' RETURNING step`,
      status, now, runId,
    ).toArray().map(({ step }) => this.events.append({ type: 'step.finished', runId, step }))
  }

  // Checkpoint A: an LLM step that asked for tools. The calls are recorded as dispatched; each result is its own
  // checkpoint, so a recovered run executes only the calls that never finished. For a settling agent the
  // checkpoint is `unsettled` like its reply: only its own run sees it until the outcome is accepted.
  private checkpointToolStep(
    runId: string,
    step: number,
    result: { text: string; thinking: string; toolCalls: ToolCall[]; usage: { input: number; output: number } },
  ): void {
    const published = this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.insertMessage(runId, { role: 'assistant', content: result.text, toolCalls: result.toolCalls })
      for (const call of result.toolCalls) {
        this.sql.exec(
          `INSERT INTO agent_tool_call (run_id, step, call_id, name, arguments_json, status, dispatched_at) VALUES (?, ?, ?, ?, ?, 'dispatched', ?)`,
          runId, step, call.id, call.name, call.argumentsJson, now,
        )
      }
      if (!this.agent.traceSteps) return []
      this.sql.exec(
        `UPDATE agent_step SET status = 'done', thinking = ?, text = ?, usage_json = ?, finished_at = ? WHERE run_id = ? AND step = ?`,
        result.thinking, result.text, JSON.stringify(result.usage), now, runId, step,
      )
      return [this.events.append({ type: 'step.finished', runId, step })]
    })
    this.publish(published)
  }

  // Checkpoint B, one per call: executes every call still dispatched, in order, and records its result.
  private async runDispatchedTools(runId: string, signal: AbortSignal): Promise<void> {
    const calls = this.sql
      .exec<ToolCallRow>(`SELECT id, call_id, name, arguments_json, step FROM agent_tool_call WHERE run_id = ? AND status = 'dispatched' ORDER BY id`, runId)
      .toArray()
    for (const call of calls) {
      signal.throwIfAborted()
      if (this.agent.traceSteps) this.announce({ type: 'tool.started', runId, callId: call.call_id, name: call.name })
      const outcome = await this.withIdleLimit(signal, (toolSignal) => this.executeTool(call, toolSignal))
      signal.throwIfAborted()
      const published = this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE agent_tool_call SET status = ?, subject = ?, result = ?, completed_at = ? WHERE id = ?`,
          outcome.ok ? 'ok' : 'error', outcome.subject, outcome.result, Date.now(), call.id,
        )
        this.insertMessage(runId, { role: 'tool', toolCallId: call.call_id, content: outcome.result })
        return this.agent.traceSteps
          ? [this.events.append({ type: 'tool.finished', runId, callId: call.call_id, status: outcome.ok ? 'ok' : 'error' })]
          : []
      })
      this.publish(published)
    }
  }

  private async withIdleLimit<T>(signal: AbortSignal, operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    const idle = new AbortController()
    const operationSignal = AbortSignal.any([signal, idle.signal])
    const timer = setTimeout(() => idle.abort(), this.stallMs)
    try {
      operationSignal.throwIfAborted()
      return await untilAborted(operation(operationSignal), operationSignal)
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted) throw new RunStalled()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async executeTool(call: ToolCallRow, signal: AbortSignal): Promise<ToolResult> {
    const tool = this.agent.tools?.[call.name]
    if (!tool) return { ok: false, subject: call.name, result: `tool ${call.name} is not available` }
    let args: unknown
    try {
      args = call.arguments_json.trim() === '' ? {} : JSON.parse(call.arguments_json)
    } catch {
      return { ok: false, subject: call.name, result: `参数不是合法的 JSON：${call.arguments_json.slice(0, 200)}` }
    }
    try {
      return await tool.execute(args, signal)
    } catch (error) {
      if (signal.aborted) throw error
      console.error('tool failed', call.name, error)
      return { ok: false, subject: call.name, result: `工具执行出错：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // Steers sent while the run was running join its context before its next step.
  private consumeSteers(runId: string): void {
    const published = this.ctx.storage.transactionSync(() => {
      const steers = this.sql
        .exec<{ id: number; client_ref: string; content: string }>(
          'SELECT id, client_ref, content FROM agent_steer WHERE run_id = ? AND consumed_at IS NULL ORDER BY id',
          runId,
        )
        .toArray()
      if (steers.length === 0) return []
      for (const steer of steers) {
        this.insertMessage(runId, { role: 'user', content: steer.content }, steer.client_ref)
        this.sql.exec('UPDATE agent_steer SET consumed_at = ? WHERE id = ?', Date.now(), steer.id)
      }
      return this.agent.traceSteps ? [this.events.append({ type: 'steer.consumed', runId })] : []
    })
    this.publish(published)
  }

  replyText(externalRef: string): string {
    const run = this.sql.exec<{ run_id: string; status: string }>(
      'SELECT run_id, status FROM agent_run WHERE external_ref = ?', externalRef,
    ).toArray()[0]
    if (run?.status === 'done') {
      return this.sql.exec<{ text: string }>(
        `SELECT json_extract(content_json, '$.content') AS text FROM agent_message
         WHERE run_id = ? AND role = 'assistant' AND state IN ('unsettled', 'active') ORDER BY seq DESC LIMIT 1`, run.run_id,
      ).toArray()[0]?.text ?? ''
    }
    if (run?.status !== 'running') return ''
    return this.sql.exec<{ text: string }>(
      `SELECT json_extract(payload_json, '$.text') AS text FROM agent_event
       WHERE run_id = ? AND type = 'text.delta' ORDER BY seq`, run.run_id,
    ).toArray().map(({ text }) => text).join('')
  }

  // Closes a run inside the caller's transaction and returns the events to publish once it commits.
  private close(run: AgentRun, outcome: RunOutcome, usage: RunUsage | null): LoggedEvent[] {
    const now = Date.now()
    const published = this.closeRunningSteps(run.runId, outcome.status, now)
    if (outcome.status === 'done') {
      // The run's input message already carries `external_ref`; the reply needs no origin of its own.
      this.sql.exec(
        `INSERT INTO agent_message (run_id, role, content_json, origin_ref, state, created_at) VALUES (?, 'assistant', ?, NULL, ?, ?)`,
        run.runId, JSON.stringify({ role: 'assistant', content: outcome.text } satisfies LlmMessage),
        this.messageState(), now,
      )
    }
    // A completed run's host finalization shares the closing transaction, so its effects are exactly as
    // durable as the run itself: a crash before this point replays, after this point it is committed.
    if (outcome.status === 'done' && this.agent.settle) {
      for (const event of this.agent.settle(run, outcome)) published.push(this.events.append(event))
    }
    // Every tool call the model made gets an answer, so the context stays well-formed for the next run.
    const unanswered = this.sql
      .exec<{ id: number; call_id: string }>(`SELECT id, call_id FROM agent_tool_call WHERE run_id = ? AND status = 'dispatched' ORDER BY id`, run.runId)
      .toArray()
    for (const call of unanswered) {
      this.sql.exec(`UPDATE agent_tool_call SET status = 'cancelled', completed_at = ? WHERE id = ?`, now, call.id)
      this.insertMessage(run.runId, { role: 'tool', toolCallId: call.call_id, content: '未执行：本轮已结束。' })
    }
    this.sql.exec(
      `UPDATE agent_run SET status = ?, error = ?, stop_reason = ?, usage_json = ?, finished_at = ? WHERE run_id = ?`,
      outcome.status, outcome.status === 'failed' ? outcome.error : null, outcome.status === 'stopped' ? outcome.reason : null,
      usage && JSON.stringify(usage), now, run.runId,
    )
    // A failed run settles nothing it said: its checkpoints never reach another run's context.
    if (outcome.status !== 'done') {
      this.sql.exec(`UPDATE agent_message SET state = 'void' WHERE run_id = ? AND state = 'unsettled'`, run.runId)
    }
    published.push(...this.requeueSteers(run.runId))
    if (this.agent.settlement) this.outbox.enqueue(run.runId, this.agent.settlement.payload(run, outcome), now)
    this.events.dropDeltas(run.runId)
    const finished: AgentEvent = {
      type: 'run.finished',
      runId: run.runId,
      ref: run.externalRef,
      status: outcome.status,
      error: outcome.status === 'failed' ? outcome.error : outcome.status === 'stopped' ? outcome.reason : null,
    }
    published.push(this.events.append(finished))
    return published
  }

  // A steer the run ended before reading becomes a run of its own, ahead of anything queued, in the order sent.
  private requeueSteers(runId: string): LoggedEvent[] {
    const steers = this.sql
      .exec<{ id: number; client_ref: string; content: string; trigger_json: string }>(
        'SELECT id, client_ref, content, trigger_json FROM agent_steer WHERE run_id = ? AND consumed_at IS NULL ORDER BY id DESC',
        runId,
      )
      .toArray()
    const published: LoggedEvent[] = []
    for (const steer of steers) {
      const requeued = this.insertRun(
        {
          kind: 'prompt',
          externalRef: steer.client_ref,
          trigger: JSON.parse(steer.trigger_json),
          deadlineAt: null,
          messages: [{ originRef: steer.client_ref, message: { role: 'user', content: steer.content } }],
        },
        true,
      )
      this.sql.exec('UPDATE agent_steer SET consumed_at = ?, requeued_as = ? WHERE id = ?', Date.now(), requeued, steer.id)
      if (this.agent.traceSteps) published.push(this.events.append({ type: 'run.queued', runId: requeued, ref: steer.client_ref }))
    }
    return published
  }

  private async deliverDue(): Promise<void> {
    const settlement = this.agent.settlement
    if (!settlement) return
    for (const entry of this.outbox.due(Date.now())) {
      try {
        const accepted = await settlement.deliver(entry.payload)
        const settled = this.ctx.storage.transactionSync(() => {
          this.outbox.delivered(entry.id, Date.now())
          this.sql.exec(
            `UPDATE agent_message SET state = ? WHERE run_id = ? AND state = 'unsettled'`,
            accepted ? 'active' : 'void', entry.runId,
          )
          const ref = this.sql.exec<{ external_ref: string | null }>('SELECT external_ref FROM agent_run WHERE run_id = ?', entry.runId).one()
          return this.events.append({ type: 'run.settled', runId: entry.runId, ref: ref.external_ref, accepted })
        })
        this.publish([settled])
      } catch (error) {
        this.outbox.failed(entry, Date.now(), String(error))
      }
    }
  }

  // Active messages, oldest first: exactly what the next LLM request would carry, so the doctor's
  // context view (#13) and a compaction (#13) read the same rolling context the run loop does.
  activeContextMessages(): LlmMessage[] {
    return this.sql
      .exec<{ content_json: string }>(`SELECT content_json FROM agent_message WHERE state = 'active' ORDER BY seq`)
      .toArray()
      .map((row) => JSON.parse(row.content_json) as LlmMessage)
  }

  private binding(): unknown {
    const row = this.sql.exec<{ binding_json: string }>('SELECT binding_json FROM agent_session').toArray()[0]
    return row ? JSON.parse(row.binding_json) : null
  }

  // Active messages in order (the inputs runs were given, settled replies and checkpoints), plus this run's own
  // checkpoints while they are unsettled.
  private contextMessages(runId: string): LlmMessage[] {
    return this.sql
      .exec<{ content_json: string }>(
        `SELECT content_json FROM agent_message WHERE state = 'active' OR (state = 'unsettled' AND run_id = ?) ORDER BY seq`,
        runId,
      )
      .toArray()
      .map((row) => JSON.parse(row.content_json) as LlmMessage)
  }

  private publish(events: LoggedEvent[]): void {
    for (const event of events) this.sockets.broadcast(event)
  }
}
