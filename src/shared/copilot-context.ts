import type { ContextCategory } from './agent-context'

// One piece of the Clinical Copilot's outbound context, as the 上下文 view shows it. `text` carries the
// item's content for the itemized browser (current context only; always doctor-visible data).
export interface CopilotContextItem {
  id: string
  category: ContextCategory
  label: string
  tokens: number
  text?: string
}

// One LLM request's accounting: the estimated per-item breakdown recorded when the request was built,
// reconciled with the provider-reported input tokens for the same call.
export interface CopilotRequestBreakdown {
  runId: string
  step: number
  at: string
  items: CopilotContextItem[]
  estimatedInput: number
  // Provider-reported input tokens; null while the step has not reported usage (still running).
  providerInput: number | null
  // Categories scaled to `providerInput`, present once the request is reconciled.
  reconciled: { category: ContextCategory; tokens: number }[] | null
}

// A manual compaction: how many rolling messages the summary replaced and what it saved.
export interface CopilotCompactionEntry {
  markerId: number
  at: string
  summarizedMessages: number
  tokensBefore: number
  tokensAfter: number
  summary: string
}

export interface CopilotContextView {
  modelWindow: number
  // Reserved for compaction and output: never available to the rolling context.
  reserve: number
  usable: number
  // What the next request would carry, estimated locally.
  estimatedInput: number
  items: CopilotContextItem[]
  // Always present, always zero: Case Truth is not in the Copilot's context.
  caseTruth: { tokens: 0; isolated: true }
  requests: CopilotRequestBreakdown[]
  compactions: CopilotCompactionEntry[]
}

export interface CopilotCompactResponse {
  markerId: number
  summarizedMessages: number
  tokensBefore: number
  tokensAfter: number
}
