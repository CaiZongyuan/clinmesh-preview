import { DurableObject } from 'cloudflare:workers'
import type { MessagePart } from '../../shared/communication'
import type { AgentRunSnapshot } from '../../shared/followup'
import { DurableAgentRuntime, RunHalted, type AgentDefinition, type AgentTool, type RunOutcome, type ToolResult } from '../durable-agent/runtime'
import type { LlmEnv } from '../llm/config'
import type { ToolSpec } from '../llm/types'
import { applyMigrations } from '../sqlite-migrations'

const FOLLOWUP_AGENT_MIGRATIONS: readonly string[] = [
  `CREATE TABLE followup_run_meta (
     run_id TEXT PRIMARY KEY,
     workspace_name TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     followup_plan_id TEXT,
     trigger_actor_id TEXT NOT NULL,
     membership_version INTEGER NOT NULL,
     final_message_id TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE followup_run_card (
     card_id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
]

const FOLLOWUP_SYSTEM_PROMPT = `你是 ClinMesh 互联门诊的「随访助手」，作为群成员协助医护团队与患者开展院外随访。
规则：
1. 你严格限定在当前群关联的随访计划范围内工作，严禁查询或广播患者私人病历详情，严禁跨群读取历史，严禁在群聊中触发客户端自动跳转。
2. 你不得自主做出临床诊断、不得开具或修改处方、不得自行批准随访摘要；所有随访摘要必须以 draft 状态提交，由授权医生人工审核生效。
3. 群内有人询问私人病历时，明确提示请前往私人「AI 就医助手」或「我的病历」查阅，绝不将个人病历广播到群内。
4. 收到患者不适或风险反馈时，使用 create_review_task 创建人工复核任务并提醒联系医护或及时线下就医。`

export interface FollowUpBinding {
  workspaceName: string
  clinicId: string
  conversationId: string
  followupPlanId: string | null
}

export interface StartFollowUpRunInput {
  workspaceName: string
  clinicId: string
  conversationId: string
  followupPlanId: string | null
  triggerActorId: string
  membershipVersion: number
  externalRef: string
  userText: string
}

export class FollowUpAgentDO extends DurableObject<Env> {
  private readonly runtime: DurableAgentRuntime
  private readonly toolSpecs: ToolSpec[]

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const tools = this.buildTools()
    this.toolSpecs = Object.values(tools).map((t) => t.spec)
    const toolSpecs = this.toolSpecs
    const agent: AgentDefinition = {
      kind: 'followup',
      streamThinking: false,
      traceSteps: true,
      tools,
      buildContext: async ({ binding, run, messages }) => {
        const bound = binding as FollowUpBinding | null
        const meta = this.getRunMeta(run.runId)
        if (!bound || !meta) throw new RunHalted('encounter-ended')
        const ws = this.env.CLINIC_WORKSPACE.getByName(meta.workspace_name)
        const scope = await ws.agentVerifyGroupScope(meta.conversation_id, meta.trigger_actor_id)
        if (!scope.allowed) {
          throw new RunHalted('encounter-ended')
        }
        return {
          messages: [
            {
              role: 'system',
              content: `${FOLLOWUP_SYSTEM_PROMPT}\n当前会话：${meta.conversation_id}，关联随访计划：${scope.followupPlanId ?? '无（医护协作群）'}。`,
            },
            ...messages,
          ],
          tools: toolSpecs,
        }
      },
      settlement: {
        payload: (run, outcome: RunOutcome) => {
          const meta = this.getRunMeta(run.runId)
          return {
            runId: run.runId,
            workspaceName: meta?.workspace_name ?? null,
            conversationId: meta?.conversation_id ?? null,
            triggerActorId: meta?.trigger_actor_id ?? null,
            status: outcome.status,
            text: outcome.text,
            cards: this.getRunCards(run.runId),
          }
        },
        deliver: async (raw) => {
          const payload = raw as {
            runId: string
            workspaceName: string | null
            conversationId: string | null
            triggerActorId: string | null
            status: RunOutcome['status']
            text: string
            cards: Array<MessagePart & { type: 'card' }>
          }
          if (!payload.workspaceName || !payload.conversationId || !payload.triggerActorId) return true
          if (payload.status !== 'done') return true
          const ws = this.env.CLINIC_WORKSPACE.getByName(payload.workspaceName)
          const scope = await ws.agentVerifyGroupScope(payload.conversationId, payload.triggerActorId)
          if (!scope.allowed) return false
          const parts: MessagePart[] = []
          const text = payload.text.trim()
          if (text) parts.push({ type: 'text', text })
          for (const card of payload.cards) parts.push(card)
          if (parts.length === 0) return true
          const res = await ws.postAgentMessage(
            payload.conversationId,
            'actor_agent_followup',
            `agent-run:${payload.runId}`,
            parts,
            payload.runId,
          )
          if (res.ok && res.message) {
            this.ctx.storage.sql.exec(
              'UPDATE followup_run_meta SET final_message_id = ? WHERE run_id = ?',
              res.message.messageId,
              payload.runId,
            )
            return true
          }
          if (!res.ok && (res.error.code === 'conversation-read-only' || res.error.code === 'conversation-member-forbidden')) {
            return false
          }
          throw new Error(res.ok ? 'Empty message settlement' : res.error.message)
        },
      },
    }
    this.runtime = new DurableAgentRuntime(ctx, env as unknown as LlmEnv, agent)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        this.runtime.migrate()
        applyMigrations(ctx.storage.sql, 'agent_schema_migration', FOLLOWUP_AGENT_MIGRATIONS, 'followup')
      })
    })
  }

  async alarm(): Promise<void> {
    await this.runtime.onAlarm()
  }

  async fetch(request: Request): Promise<Response> {
    return this.runtime.sockets.accept(request)
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.runtime.sockets.onMessage(socket, message)
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.runtime.sockets.onClose(socket, code, reason)
  }

  async startRun(input: StartFollowUpRunInput): Promise<{ runId: string; created: boolean }> {
    const ref = `${input.clinicId}:${input.conversationId}:actor_agent_followup`
    const bound = this.runtime.bindSession(ref, {
      workspaceName: input.workspaceName,
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      followupPlanId: input.followupPlanId,
    } satisfies FollowUpBinding)
    if (!bound) {
      throw new Error('FollowUpAgentDO session binding mismatch')
    }
    const enqueued = await this.runtime.enqueue({
      kind: 'followup-mention',
      externalRef: input.externalRef,
      trigger: { conversationId: input.conversationId, triggerActorId: input.triggerActorId },
      deadlineAt: Date.now() + 60_000,
      messages: [{ originRef: input.externalRef, message: { role: 'user', content: input.userText } }],
    })
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO followup_run_meta (
         run_id, workspace_name, conversation_id, followup_plan_id, trigger_actor_id, membership_version, final_message_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      enqueued.runId,
      input.workspaceName,
      input.conversationId,
      input.followupPlanId,
      input.triggerActorId,
      input.membershipVersion,
      new Date().toISOString(),
    )
    await this.runtime.wake()
    return enqueued
  }

  async stopRun(runId: string): Promise<{ stoppedRunId: string | null }> {
    const active = this.ctx.storage.sql
      .exec<{ run_id: string }>(`SELECT run_id FROM agent_run WHERE run_id = ? AND status = 'running'`, runId)
      .toArray()[0]
    if (!active) return { stoppedRunId: null }
    return { stoppedRunId: this.runtime.stop() }
  }

  async haltForRevocation(): Promise<void> {
    this.runtime.halt('encounter-ended')
  }

  getRunSnapshot(runId: string): AgentRunSnapshot | null {
    const run = this.ctx.storage.sql
      .exec<{
        run_id: string
        status: AgentRunSnapshot['status']
        error: string | null
        created_at: number
        finished_at: number | null
      }>('SELECT run_id, status, error, created_at, finished_at FROM agent_run WHERE run_id = ?', runId)
      .toArray()[0]
    const meta = this.getRunMeta(runId)
    if (!run || !meta) return null

    const toolCalls = this.ctx.storage.sql
      .exec<{
        call_id: string
        name: string
        status: 'dispatched' | 'ok' | 'error' | 'cancelled'
        subject: string | null
        result: string | null
      }>('SELECT call_id, name, status, subject, result FROM agent_tool_call WHERE run_id = ? ORDER BY id', runId)
      .toArray()
      .map((t) => ({
        callId: t.call_id,
        name: t.name,
        status: t.status,
        subject: t.subject,
        result: t.result,
      }))

    const text = this.runtime.replyText(
      this.ctx.storage.sql.exec<{ external_ref: string | null }>('SELECT external_ref FROM agent_run WHERE run_id = ?', runId).one().external_ref ?? '',
    )

    return {
      runId: run.run_id,
      agentKind: 'followup',
      agentActorId: 'actor_agent_followup',
      conversationId: meta.conversation_id,
      status: run.status,
      text,
      error: run.error,
      toolCalls,
      cards: this.getRunCards(runId),
      pendingActions: [],
      finalMessageId: meta.final_message_id,
      createdAt: new Date(run.created_at).toISOString(),
      finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
    }
  }

  private getRunMeta(runId: string) {
    return (
      this.ctx.storage.sql
        .exec<{
          run_id: string
          workspace_name: string
          conversation_id: string
          followup_plan_id: string | null
          trigger_actor_id: string
          membership_version: number
          final_message_id: string | null
        }>('SELECT * FROM followup_run_meta WHERE run_id = ?', runId)
        .toArray()[0] ?? null
    )
  }

  private getRunCards(runId: string): Array<MessagePart & { type: 'card' }> {
    return this.ctx.storage.sql
      .exec<{ payload_json: string }>('SELECT payload_json FROM followup_run_card WHERE run_id = ? ORDER BY created_at', runId)
      .toArray()
      .map((r) => JSON.parse(r.payload_json) as MessagePart & { type: 'card' })
  }

  private recordCard(runId: string, card: MessagePart & { type: 'card' }): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO followup_run_card (card_id, run_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      `fcard_${crypto.randomUUID().slice(0, 12)}`,
      runId,
      JSON.stringify(card),
      new Date().toISOString(),
    )
  }

  private buildTools(): Record<string, AgentTool> {
    const ok = (subject: string, data: unknown): ToolResult => ({ ok: true, subject, result: JSON.stringify(data) })
    const fail = (subject: string, message: string): ToolResult => ({ ok: false, subject, result: message, outcome: 'denied' })

    const scopedWorkspace = async (runId: string) => {
      const meta = this.getRunMeta(runId)
      if (!meta) return { ok: false as const, message: '缺少运行元数据' }
      const ws = this.env.CLINIC_WORKSPACE.getByName(meta.workspace_name)
      const scope = await ws.agentVerifyGroupScope(meta.conversation_id, meta.trigger_actor_id)
      if (!scope.allowed) return { ok: false as const, message: '当前群会话或成员权限已变更/撤销，拒绝工具调用。' }
      return { ok: true as const, meta, ws, planId: scope.followupPlanId }
    }

    return {
      get_followup_plan: {
        spec: { name: 'get_followup_plan', description: '读取当前群绑定的随访计划、任务及已提交反馈', parameters: { type: 'object', properties: {} } },
        execute: async (_args, _signal, runId) => {
          const ctx = await scopedWorkspace(runId)
          if (!ctx.ok) return fail('读取随访计划', ctx.message)
          if (!ctx.planId) return fail('读取随访计划', '当前会话未绑定随访计划。')
          const plan = await ctx.ws.agentGetFollowupPlan(ctx.planId)
          return plan ? ok(`随访计划 ${ctx.planId}`, { plan }) : fail('读取随访计划', '找不到绑定的随访计划。')
        },
      },
      present_followup_form: {
        spec: {
          name: 'present_followup_form',
          description: '在随访群内展示指定任务的随访问卷卡片，供患者填写提交',
          parameters: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
        },
        execute: async (rawArgs, _signal, runId) => {
          const taskId = typeof (rawArgs as Record<string, unknown>)?.taskId === 'string' ? String((rawArgs as Record<string, unknown>).taskId) : ''
          const ctx = await scopedWorkspace(runId)
          if (!ctx.ok) return fail('发送随访问卷', ctx.message)
          if (!ctx.planId) return fail('发送随访问卷', '当前会话未绑定随访计划。')
          const plan = await ctx.ws.agentGetFollowupPlan(ctx.planId)
          const task = plan?.tasks.find((t) => t.taskId === taskId)
          if (!plan || !task) return fail('发送随访问卷', '找不到当前随访计划中的该问卷任务。')
          const card: MessagePart & { type: 'card' } = {
            type: 'card',
            component: 'FollowupFormCard',
            version: 1,
            resourceRef: { kind: 'followup_task', id: task.taskId },
            safeProps: {
              title: task.title,
              planId: plan.planId,
              taskId: task.taskId,
              dueAt: task.dueAt,
              status: task.status,
              questionnaireVersion: task.questionnaireVersion,
              questionCount: task.questions.length,
            },
            actions: [{ name: 'followup.open', args: { planId: plan.planId, taskId: task.taskId } }],
          }
          this.recordCard(runId, card)
          return ok(`随访问卷 ${task.taskId}`, { presented: true, task, card })
        },
      },
      draft_followup_summary: {
        spec: {
          name: 'draft_followup_summary',
          description: '根据当前计划中患者已提交的随访反馈创建待医生人工审核的随访摘要草稿',
          parameters: { type: 'object', required: ['draftText'], properties: { draftText: { type: 'string' } } },
        },
        execute: async (rawArgs, _signal, runId) => {
          const draftText = typeof (rawArgs as Record<string, unknown>)?.draftText === 'string' ? String((rawArgs as Record<string, unknown>).draftText) : ''
          if (!draftText.trim()) return fail('生成随访摘要', '摘要内容不能为空。')
          const ctx = await scopedWorkspace(runId)
          if (!ctx.ok) return fail('生成随访摘要', ctx.message)
          if (!ctx.planId) return fail('生成随访摘要', '当前会话未绑定随访计划。')
          const created = await ctx.ws.agentCreateFollowupSummary(ctx.planId, draftText)
          if (!created.ok) return fail('生成随访摘要', created.error.message)
          this.recordCard(runId, {
            type: 'card',
            component: 'TaskCard',
            version: 1,
            resourceRef: { kind: 'followup_summary', id: created.summary.summaryId },
            safeProps: {
              title: `待审核随访摘要 v${created.summary.version}`,
              planId: ctx.planId,
              summaryId: created.summary.summaryId,
              status: created.summary.status,
              sourceCount: created.summary.sourceResponseIds.length,
            },
            actions: [{ name: 'followup.open', args: { planId: ctx.planId } }],
          })
          return ok(`随访摘要草稿 ${created.summary.summaryId}`, { summary: created.summary })
        },
      },
      create_review_task: {
        spec: {
          name: 'create_review_task',
          description: '为医护团队创建幂等、可审计的待人工评估/复核任务',
          parameters: {
            type: 'object',
            required: ['sourceRef', 'reason'],
            properties: {
              sourceRef: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
        execute: async (rawArgs, _signal, runId) => {
          const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
          const sourceRef = typeof args.sourceRef === 'string' ? args.sourceRef.trim() : ''
          const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
          if (!sourceRef || !reason) return fail('创建人工复核任务', '缺少 sourceRef 或 reason。')
          const ctx = await scopedWorkspace(runId)
          if (!ctx.ok) return fail('创建人工复核任务', ctx.message)
          if (!ctx.planId) return fail('创建人工复核任务', '当前会话未绑定随访计划。')
          const res = await ctx.ws.agentCreateReviewTask(ctx.planId, sourceRef, reason)
          if (!res.ok) return fail('创建人工复核任务', res.error.message)
          return ok(`复核任务 ${res.reviewTask.reviewTaskId}`, { reviewTask: res.reviewTask })
        },
      },
    }
  }
}
