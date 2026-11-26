import { allowedAmbientEdit, eventSections } from './ambient-drafts'
import { NOTE_SECTION_NAME } from '../../shared/clinical-note'
import { DurableObject } from 'cloudflare:workers'
import type { CopilotCompactResponse, CopilotContextView } from '../../shared/copilot-context'
import type {
  CopilotAnalysisEvent,
  CopilotConfigRequest,
  CopilotCountdown,
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
import { workspaceName, type WorkspaceModeEnv } from '../workspace-name'
import { COPILOT_SYSTEM_PROMPT, encounterOverview, promptContent } from './copilot-context'
import { COMPACTION_SYSTEM_PROMPT, buildContextView, compactionItems, requestItems, rollingMessages, summarizeTranscript } from './copilot-accounting'
import { estimateTokens } from '../durable-agent/context'
import type { CopilotNoteMention, CopilotRead, CopilotReadResult } from './copilot-reads'
type ReadWorkspace = <R extends CopilotRead>(request: R) => Promise<CopilotReadResult<R['kind']>>
import { readSession, type CopilotTrigger } from './copilot-session'
import { copilotTools } from './copilot-tools'
import { type ConfirmTargets, confirmControls as uiConfirmControls } from './ui-bridge'

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
  // An ambient trigger counting down its debounce (~1.2s) before it becomes a run; a newer finalized turn
  // flushes the pending one into the queue. Singleton, so only one countdown is ever visible.
  `CREATE TABLE copilot_pending_trigger (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     ref TEXT NOT NULL,
     text TEXT NOT NULL,
     fire_at INTEGER NOT NULL
   );
   CREATE TABLE copilot_seen_trigger (ref TEXT PRIMARY KEY);
   CREATE TABLE copilot_ended (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));`,
  // The formal (data-agent-confirm) controls from the latest ui_snapshot, so ui_act on one is refused here
  // even after a recovery, before it can reach the browser.
  `CREATE TABLE copilot_bridge_state (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     confirm_refs_json TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  `CREATE TABLE copilot_analysis_setting (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
   );
   CREATE TABLE copilot_analysis_event (
     id INTEGER PRIMARY KEY,
     ref TEXT NOT NULL UNIQUE,
     text TEXT NOT NULL,
     automatic INTEGER NOT NULL CHECK (automatic IN (0, 1))
   );`,
]

// The ambient debounce between a finalized consultation turn and the automatic analysis.
const COUNTDOWN_MS = 1_200

export type CopilotResult<T> = { ok: true; value: T } | { ok: false; error: EncounterError }

// Who sent a command, as the workspace authorized it.
export interface CopilotCommandContext {
  practitionerId: string
  noteMentions: CopilotNoteMention[]
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
      env.CLINIC_WORKSPACE.getByName(workspaceName(env as unknown as WorkspaceModeEnv)).readForCopilot(this.encounterId(), request) as Promise<CopilotReadResult<R['kind']>>
    const tools = copilotTools(this.read, this.bridge(), this.confirmTargets())
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
      wakeHint: () => this.pendingFireAt(),
      startTool: (run) => {
        if (run.kind !== 'compaction' && (run.kind === 'event' || this.runtime.sockets.bridgeConnected())) return 'ui_snapshot'
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
    const snapshot = {
      seq: this.runtime.events.latestSeq(),
      model: this.modelSetting(),
      countdown: this.countdown(),
      autoAnalysis: this.automaticAnalysis(),
      pendingAnalysis: this.analysisEvents(false).map(({ ref, text }) => ({ ref, text })),
      ...readSession(this.ctx.storage.sql),
    }
    if (!snapshot.turns.some((turn) => turn.status === 'stopped')) return snapshot
    const kept = await this.env.CLINIC_WORKSPACE.getByName(workspaceName(this.env as unknown as WorkspaceModeEnv)).getDraftAppliedCounts(encounterId)
    return {
      ...snapshot,
      turns: snapshot.turns.map((turn) => {
        const keptDrafts = kept[turn.turnId]
        return keptDrafts && turn.status === 'stopped' ? { ...turn, keptDrafts } : turn
      }),
    }
  }

  // The workspace calls this when a consultation turn finalizes: the trigger waits ~1.2s (立即 / 跳过 in the
  // session); a newer finalized turn flushes the pending one into the queue and replaces the countdown.
  async triggerAnalysis(encounterId: string, trigger: CopilotAnalysisEvent, debounce = true): Promise<void> {
    this.bind(encounterId)
    // A frozen Encounter takes no ambient analysis; the workspace also stops any countdown at its freeze hook.
    const state = await this.read({ kind: 'encounter-state' })
    if (!state.ok || state.data.status !== 'active') return
    const fireAt = Date.now() + COUNTDOWN_MS
    const result = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql
      if (sql.exec('SELECT 1 FROM copilot_ended').toArray().length) return null
      const seen = sql.exec('INSERT OR IGNORE INTO copilot_seen_trigger (ref) VALUES (?)', trigger.ref).rowsWritten
      if (!seen) return null
      const automatic = this.automaticAnalysis()
      if (!automatic || !debounce) {
        this.storeAnalysisEvent(trigger, automatic)
        return { previous: null }
      }
      const pending = this.pending()
      this.ctx.storage.sql.exec(
        `INSERT INTO copilot_pending_trigger (singleton, ref, text, fire_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET ref = excluded.ref, text = excluded.text, fire_at = excluded.fire_at`,
        trigger.ref, trigger.text, fireAt,
      )
      return { previous: pending }
    })
    if (!result) return
    this.runtime.announce({ type: 'session.updated', runId: null })
    if (result.previous) await this.enqueueTrigger(result.previous)
    else {
      const next = this.pendingFireAt()
      if (next !== null) {
        const alarm = await this.ctx.storage.getAlarm()
        if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next)
      }
    }
  }

  setAutomaticAnalysis(encounterId: string, enabled: boolean): CopilotResult<{ enabled: boolean }> {
    this.bind(encounterId)
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql
      if (sql.exec('SELECT 1 FROM copilot_ended').toArray().length) {
        return { ok: false, error: { code: 'encounter-not-active', message: '就诊已结束。' } }
      }
      if (this.automaticAnalysis() !== enabled) {
        sql.exec(`INSERT INTO copilot_analysis_setting VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET enabled = excluded.enabled`, Number(enabled))
        if (!enabled) {
          sql.exec('UPDATE copilot_analysis_event SET automatic = 0 WHERE automatic = 1')
          const countdown = this.pending()
          if (countdown) {
            this.storeAnalysisEvent(countdown, false)
            sql.exec('DELETE FROM copilot_pending_trigger')
          }
        }
        this.runtime.announce({ type: 'session.updated', runId: null })
      }
      return { ok: true, value: { enabled } }
    })
  }

  async runPendingAnalysis(encounterId: string): Promise<CopilotResult<CopilotPromptResponse | null>> {
    this.bind(encounterId)
    const sql = this.ctx.storage.sql
    if (sql.exec('SELECT 1 FROM copilot_ended').toArray().length) {
      return { ok: false, error: { code: 'encounter-not-active', message: '就诊已结束。' } }
    }
    const events = this.analysisEvents(false)
    const last = events.at(-1)
    if (!last) return { ok: true, value: null }
    if (!this.runtime.sockets.bridgeConnected()) {
      return { ok: false, error: { code: 'copilot-bridge-required', message: '临床助手界面尚未连接，待分析事件已保留。' } }
    }
    const value = await this.enqueueTrigger({
      ref: `analysis-batch:${crypto.randomUUID()}`,
      text: `批量分析（${events.length} 个事件）：${events.map(({ text }) => text).join('；')}`,
    }, () => {
      sql.exec('DELETE FROM copilot_analysis_event WHERE automatic = 0 AND id <= ?', last.id)
    }, [...new Set(events.flatMap(eventSections))])
    return { ok: true, value }
  }

  private automaticAnalysis(): boolean {
    return this.ctx.storage.sql.exec<{ enabled: number }>('SELECT enabled FROM copilot_analysis_setting').toArray()[0]?.enabled !== 0
  }

  private analysisEvents(automatic: boolean) {
    return this.ctx.storage.sql.exec<{ ref: string; text: string; id: number }>(
      'SELECT id, ref, text FROM copilot_analysis_event WHERE automatic = ? ORDER BY id',
      Number(automatic),
    ).toArray()
  }

  private storeAnalysisEvent(event: CopilotAnalysisEvent, automatic: boolean) {
    this.ctx.storage.sql.exec('INSERT INTO copilot_analysis_event (ref, text, automatic) VALUES (?, ?, ?)', event.ref, event.text, Number(automatic))
  }

  // 立即：the doctor pulls the countdown forward; idempotent once it has become a run.
  async flushCountdown(encounterId: string, ref: string): Promise<CopilotResult<CopilotPromptResponse>> {
    this.bind(encounterId)
    const pending = this.ctx.storage.transactionSync(() => {
      const row = this.pending()
      if (!row || row.ref !== ref) return null
      this.ctx.storage.sql.exec('DELETE FROM copilot_pending_trigger')
      return row
    })
    if (!pending) return { ok: true, value: { kind: 'run', turnId: '' } }
    return this.enqueueTrigger(pending).then((response) => ({ ok: true as const, value: response }))
  }

  // 跳过：the trigger is discarded, not queued.
  skipCountdown(encounterId: string, ref: string): CopilotResult<null> {
    this.bind(encounterId)
    const row = this.pending()
    if (!row || row.ref !== ref) return { ok: false, error: notFound(ref) }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM copilot_pending_trigger WHERE ref = ?', ref)
      this.runtime.announce({ type: 'session.updated', runId: null })
    })
    return { ok: true, value: null }
  }

  // Fires due countdowns from the alarm: enqueues a run only when a bridge is connected, so no provider call
  // is spent on a turn that cannot see the screen; otherwise the fire time slips until one joins.
  async fireDueTriggers(): Promise<void> {
    if (!this.runtime.sockets.bridgeConnected()) return
    while (this.runtime.sockets.bridgeConnected()) {
      const event = this.analysisEvents(true)[0]
      if (!event) break
      await this.enqueueTrigger(event, () => {
        this.ctx.storage.sql.exec('DELETE FROM copilot_analysis_event WHERE id = ?', event.id)
      })
    }
    const due = this.ctx.storage.transactionSync(() => {
      const row = this.pending()
      if (!row || row.fire_at > Date.now()) return null
      this.ctx.storage.sql.exec('DELETE FROM copilot_pending_trigger')
      return row
    })
    if (due) await this.enqueueTrigger(due)
  }

  private enqueueTrigger(trigger: CopilotAnalysisEvent, onEnqueue?: () => void, sections = eventSections(trigger)): Promise<CopilotPromptResponse> {
    const copilotTrigger: CopilotTrigger = { kind: 'event', text: trigger.text, mentions: [], sections }
    return this.runtime
      .enqueue({
        kind: 'event',
        externalRef: trigger.ref,
        trigger: copilotTrigger,
        deadlineAt: null,
        subject: trigger.ref,
        messages: [{ originRef: trigger.ref, message: { role: 'user', content: `${trigger.text}\n本轮只整理该事件新增且已证实的信息，可写字段：${sections.map((key) => NOTE_SECTION_NAME[key]).join('、') || '无'}。不要借用既往资料补全其他栏，不要推测阴性症状或写诊断、检查、处方、随访计划。没有新增证据就不操作。用一句话说明实际更新。` } }],
      }, { onEnqueue })
      .then(({ runId }) => ({ kind: 'run' as const, turnId: runId }))
  }

  private pending(): { ref: string; text: string; fire_at: number } | null {
    return this.ctx.storage.sql
      .exec<{ ref: string; text: string; fire_at: number }>('SELECT ref, text, fire_at FROM copilot_pending_trigger')
      .toArray()[0] ?? null
  }

  private countdown(): CopilotCountdown | null {
    const row = this.pending()
    return row && { ref: row.ref, text: row.text, fireAt: new Date(row.fire_at).toISOString() }
  }

  private pendingFireAt(): number | null {
    if (!this.runtime.sockets.bridgeConnected()) return null
    if (this.ctx.storage.sql.exec('SELECT 1 FROM copilot_analysis_event WHERE automatic = 1 LIMIT 1').toArray().length) return Date.now()
    return this.pending()?.fire_at ?? null
  }

  private bridge() {
    return {
      connected: () => this.runtime.sockets.bridgeConnected(),
      call: (tool: 'ui_snapshot' | 'ui_act', args: unknown, signal: AbortSignal, runId: string) => {
        if (tool === 'ui_act') {
          const sql = this.ctx.storage.sql
          const run = sql.exec<{ kind: string; subject: string | null; trigger_json: string }>(
            'SELECT kind, subject, trigger_json FROM agent_run WHERE run_id = ?', runId,
          ).toArray()[0]
          if (run?.kind === 'event') {
            const trigger: CopilotTrigger = JSON.parse(run.trigger_json)
            const sections = trigger.sections ?? eventSections({ ref: run.subject ?? '', text: trigger.text })
            const snapshot = sql.exec<{result: string}>(`SELECT result FROM agent_tool_call
              WHERE run_id = ? AND name = 'ui_snapshot' AND status = 'ok' ORDER BY id DESC LIMIT 1`, runId).toArray()[0]
            if (!allowedAmbientEdit(args, snapshot?.result ?? null, sections)) {
              return Promise.resolve({ ok: false, result: '自动分析只可补充与本事件直接相关的病历字段。', outcome: 'denied' as const })
            }
            args = { ...(args as object), allowedNoteLabels: sections.map((section) => NOTE_SECTION_NAME[section]) }
          }
        }
        return this.runtime.sockets.callBridge(tool, args, signal, runId)
      },
    }
  }

  private confirmTargets(): ConfirmTargets {
    const sql = () => this.ctx.storage.sql
    return {
      record(snapshotJson: string): number {
        const controls = uiConfirmControls(snapshotJson)
        sql().exec(
          `INSERT INTO copilot_bridge_state (singleton, confirm_refs_json, updated_at) VALUES (1, ?, ?)
           ON CONFLICT (singleton) DO UPDATE SET confirm_refs_json = excluded.confirm_refs_json, updated_at = excluded.updated_at`,
          JSON.stringify(controls), Date.now(),
        )
        return controls.length
      },
      all() {
        const row = sql().exec<{ confirm_refs_json: string }>('SELECT confirm_refs_json FROM copilot_bridge_state').toArray()[0]
        return row ? (JSON.parse(row.confirm_refs_json) as { ref: string; label: string }[]) : []
      },
    }
  }

  // Queued after anything running, or, as a steer, read by the running turn before its next step.
  async prompt(encounterId: string, request: CopilotPromptRequest, context: CopilotCommandContext): Promise<CopilotPromptResponse> {
    this.bind(encounterId)
    const trigger: CopilotTrigger = { kind: 'doctor', text: request.text, mentions: request.mentions, practitionerId: context.practitionerId }
    const content = promptContent(request.text, request.mentions, context.noteMentions)
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
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO copilot_ended VALUES (1)')
      this.ctx.storage.sql.exec('DELETE FROM copilot_analysis_event')
      this.ctx.storage.sql.exec('DELETE FROM copilot_pending_trigger')
      this.runtime.announce({ type: 'session.updated', runId: null })
    })
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
    await this.fireDueTriggers()
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
