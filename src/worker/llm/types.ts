import type { ReasoningEffort } from '../../shared/reasoning-effort'

export type { ReasoningEffort }

export type AgentKind = 'patient' | 'copilot'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  argumentsJson: string
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface LlmRequest {
  model: string
  effort: ReasoningEffort
  messages: LlmMessage[]
  tools: ToolSpec[]
  maxOutputTokens?: number
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter'

export type LlmStreamEvent =
  | { type: 'thinking.delta'; text: string }
  | { type: 'text.delta'; text: string }
  | ({ type: 'tool_call' } & ToolCall)
  | { type: 'usage'; input: number; output: number; reasoning?: number; cached?: number }
  | { type: 'done'; finishReason: FinishReason }

export interface LlmProvider {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>
}

export type LlmErrorKind = 'http' | 'network' | 'aborted' | 'protocol'

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
