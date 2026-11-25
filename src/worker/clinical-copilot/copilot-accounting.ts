import type { ContextCategory } from '../../shared/agent-context'
import { CONTEXT_CATEGORY_LABEL } from '../../shared/agent-context'
import type { CopilotCompactionEntry, CopilotContextItem, CopilotContextView, CopilotRequestBreakdown } from '../../shared/copilot-context'
import { estimateTokens, type ContextItem } from '../durable-agent/context'
import type { LlmMessage, ToolSpec } from '../llm/types'

// Context accounting for the Clinical Copilot (#13): what each outbound LLM request carries, itemized by
// category, and how the estimates reconcile with the provider-reported usage. Case Truth is never itemized
// here — the view adds the explicit zero row.

// The system message is composed as `COPILOT_SYSTEM_PROMPT` + the re-injected overview sections joined by
// '\n\n## ', so it splits back losslessly along the same boundary. Each section maps to its category:
// patient visible data, HIS state, and the finalized consultation.
const SECTION_HEADERS: { prefix: string; category: ContextCategory; label: string }[] = [
  { prefix: '患者与分诊', category: 'patient_visible', label: `${CONTEXT_CATEGORY_LABEL.patient_visible}（患者与分诊）` },
  { prefix: '就诊状态', category: 'his_state_ui', label: `${CONTEXT_CATEGORY_LABEL.his_state_ui}（就诊状态）` },
  { prefix: '问诊记录', category: 'consultation', label: `${CONTEXT_CATEGORY_LABEL.consultation}（已定稿）` },
]

export function systemSections(content: string): { label: string; category: ContextCategory; text: string }[] {
  const [prompt = '', ...sections] = content.split('\n\n## ')
  return [
    { label: CONTEXT_CATEGORY_LABEL.system, category: 'system', text: prompt },
    ...sections.map((section) => {
      const known = SECTION_HEADERS.find((header) => section.startsWith(header.prefix))
      return {
        label: known?.label ?? CONTEXT_CATEGORY_LABEL.his_state_ui,
        category: known?.category ?? ('his_state_ui' as ContextCategory),
        text: `## ${section}`,
      }
    }),
  ]
}

// Itemizes one request's context exactly as it is sent: system sections, tool definitions, and every durable
// message by role (doctor prompts and replies/thinking, tool results). Ids are positional and stable.
// Itemizes a compaction run's outbound request: the summarizer instructions and the transcript of rolling
// history it was given (never the live system context).
export function compactionItems(messages: LlmMessage[]): ContextItem[] {
  const items: ContextItem[] = []
  let i = 0
  for (const message of messages) {
    const compaction = message.role === 'system'
      ? { id: `compact-system-${++i}`, category: 'system' as const, label: '压缩指令', text: message.content }
      : { id: `compact-input-${++i}`, category: 'replies_thinking' as const, label: '待压缩对话历史', text: message.content }
    items.push({ ...compaction, tokens: estimateTokens(compaction.text) })
  }
  return items
}

export function requestItems(context: { messages: LlmMessage[]; tools: ToolSpec[] }): ContextItem[] {
  const items: ContextItem[] = []
  let i = 0
  const push = (category: ContextCategory, label: string, text: string): void => {
    items.push({ id: `ctx-${++i}`, category, label, text, tokens: estimateTokens(text) })
  }
  for (const message of context.messages) {
    if (message.role === 'system') {
      for (const section of systemSections(message.content)) push(section.category, section.label, section.text)
    } else if (message.role === 'user') {
      push('replies_thinking', '医生提问与指引', message.content)
    } else if (message.role === 'assistant') {
      const toolCalls = message.toolCalls?.map((call) => `${call.name}(${call.argumentsJson})`).join('\n') ?? ''
      push('replies_thinking', message.toolCalls?.length ? '回复与工具调用' : '回复与思考', [message.content, toolCalls].filter(Boolean).join('\n'))
    } else if (message.role === 'tool') {
      push('tool_results', `工具结果（${message.toolCallId}）`, message.content)
    }
  }
  push('tools', CONTEXT_CATEGORY_LABEL.tools, JSON.stringify(context.tools))
  return items
}

type StepRow = {
  run_id: string
  step: number
  started_at: number
  status: string
  context_json: string | null
  usage_json: string | null
}

type RunUsageRow = { run_id: string; usage_json: string | null }

// Scales per-category estimates to `providerInput` so the reconciled categories sum to it exactly.
function reconcile(items: ContextItem[], providerInput: number, estimated: number): { category: ContextCategory; tokens: number }[] {
  const byCategory = new Map<ContextCategory, number>()
  for (const item of items) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.tokens)
  const categories = [...byCategory.entries()].sort((a, b) => b[1] - a[1])
  const scaled = categories.map(([category, tokens]) => ({ category, tokens: Math.floor((tokens * providerInput) / estimated) }))
  const remainder = providerInput - scaled.reduce((sum, entry) => sum + entry.tokens, 0)
  if (remainder > 0 && scaled.length > 0) scaled[0].tokens += remainder
  return scaled
}

// The 上下文 view's request timeline: one row per recorded LLM request, newest last. A run's final step has no
// per-step usage row, so its provider input is the run's reported input minus its tool steps' inputs.
export function readRequestBreakdowns(sql: SqlStorage): CopilotRequestBreakdown[] {
  const steps = sql
    .exec<StepRow>(
      `SELECT s.run_id, s.step, s.started_at, s.status, s.context_json, s.usage_json
       FROM agent_step s JOIN agent_run r USING (run_id)
       WHERE s.context_json IS NOT NULL AND r.superseded_by IS NULL
       ORDER BY s.started_at, s.step`,
    )
    .toArray()
  const runUsage = new Map(
    sql
      .exec<RunUsageRow>('SELECT run_id, usage_json FROM agent_run WHERE usage_json IS NOT NULL')
      .toArray()
      .map((row) => [row.run_id, JSON.parse(row.usage_json!) as { input: number }]),
  )
  const reported = new Map<string, number>()
  for (const step of steps) {
    const usage = step.usage_json ? (JSON.parse(step.usage_json) as { input: number }) : null
    if (usage) reported.set(step.run_id, (reported.get(step.run_id) ?? 0) + usage.input)
  }
  return steps.flatMap((step): CopilotRequestBreakdown[] => {
    if (step.context_json === null) return []
    const items = JSON.parse(step.context_json) as ContextItem[]
    const estimated = items.reduce((sum, item) => sum + item.tokens, 0)
    const usage = step.usage_json ? (JSON.parse(step.usage_json) as { input: number }) : null
    const isLastStep = steps.every((other) => other.run_id !== step.run_id || other.step <= step.step)
    const run = runUsage.get(step.run_id)
    const providerInput =
      usage?.input ??
      (isLastStep && run ? run.input - (reported.get(step.run_id) ?? 0) : null)
    return [
      {
        runId: step.run_id,
        step: step.step,
        at: new Date(step.started_at).toISOString(),
        items: items.map(({ id, category, label, tokens }) => ({ id, category, label, tokens })),
        estimatedInput: estimated,
        providerInput,
        reconciled: providerInput !== null && providerInput >= 0 && estimated > 0 ? reconcile(items, providerInput, estimated) : null,
      },
    ]
  })
}

export function readCompactions(sql: SqlStorage, limit: number): CopilotCompactionEntry[] {
  return sql
    .exec<{ id: number; run_id: string; created_at: number; summarized_messages: number; tokens_before: number; tokens_after: number; summary: string }>(
      'SELECT id, run_id, created_at, summarized_messages, tokens_before, tokens_after, summary FROM copilot_compaction ORDER BY id DESC LIMIT ?',
      limit,
    )
    .toArray()
    .map((row) => ({
      markerId: row.id,
      runId: row.run_id,
      at: new Date(row.created_at).toISOString(),
      summarizedMessages: row.summarized_messages,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      summary: row.summary,
    }))
}

export interface CurrentContext {
  systemContent: string
  messages: LlmMessage[]
  tools: ToolSpec[]
  modelWindow: number
}

// The model window minus a compaction/output reserve: the rolling context must stay within what is left.
export const RESERVE_RATIO = 0.25
export const MIN_RESERVE_TOKENS = 4_096
export const contextReserve = (modelWindow: number): number => Math.max(MIN_RESERVE_TOKENS, Math.round(modelWindow * RESERVE_RATIO))

// The full view: the next request's itemized context, the request timeline with reconciliation, every
// compaction marker, and the explicit Case Truth row that never leaves zero. The current context is
// assembled on the same path as an outbound request: the system message (system prompt + re-injected
// patient visible data, HIS state and consultation) ahead of the durable rolling messages.
export function buildContextView(current: CurrentContext, sql: SqlStorage): CopilotContextView {
  const items = requestItems({ messages: [{ role: 'system', content: current.systemContent }, ...current.messages], tools: current.tools })
  const estimatedInput = items.reduce((sum, item) => sum + item.tokens, 0)
  const reserve = contextReserve(current.modelWindow)
  return {
    modelWindow: current.modelWindow,
    reserve,
    usable: current.modelWindow - reserve,
    estimatedInput,
    items: items.map(({ id, category, label, text, tokens }): CopilotContextItem => ({ id, category, label, text, tokens })),
    caseTruth: { tokens: 0, isolated: true },
    requests: readRequestBreakdowns(sql),
    compactions: readCompactions(sql, 50),
  }
}

export const COMPACTION_SYSTEM_PROMPT = [
  '你负责压缩临床助手（Clinical Copilot）的对话历史。',
  '把给定的医生提问、助手回复、思考与工具读取结果整理成一份要点摘要，保留：症状与病史要点、已读取的资料与结论、尚未解决的疑问。',
  '不要新增任何信息，不要推测；用简体中文，分点，尽量简短。',
].join('\n')

// The rolling messages eligible for compaction: every active durable message (doctor prompts, replies and
// thinking, tool results). The system context (就诊概况、问诊记录) is rebuilt each request and never compacted.
export function rollingMessages(sql: SqlStorage): { seq: number; message: LlmMessage; tokens: number }[] {
  // The compaction runs' own summaries are outputs, not inputs: a lone summary has nothing left to compress.
  return sql
    .exec<{ seq: number; content_json: string }>(
      `SELECT seq, content_json FROM agent_message
       WHERE state = 'active'
         AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM agent_run WHERE kind = 'compaction'))
       ORDER BY seq`,
    )
    .toArray()
    .map((row) => {
      const message = JSON.parse(row.content_json) as LlmMessage
      const text =
        message.role === 'assistant'
          ? [message.content, message.toolCalls?.map((call) => `${call.name}(${call.argumentsJson})`).join('\n') ?? ''].filter(Boolean).join('\n')
          : message.content
      return { seq: row.seq, message, tokens: estimateTokens(text) }
    })
}

export const summarizeTranscript = (messages: LlmMessage[]): string =>
  messages
    .map((message) => {
      if (message.role === 'user') return `- 医生提问：${message.content}`
      if (message.role === 'tool') return `- 工具结果：${message.content}`
      if (message.role !== 'assistant') return ''
      const toolCalls = message.toolCalls?.map((call) => `${call.name}(${call.argumentsJson})`).join('、') ?? ''
      return [`- 助手回复：${message.content}`, toolCalls && `  调用工具：${toolCalls}`].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n')
