import type { EffortStyle } from './config'
import { LlmError, type FinishReason, type LlmMessage, type LlmProvider, type LlmRequest, type LlmStreamEvent } from './types'

export interface OpenAiCompatibleOptions {
  baseUrl: string
  apiKey: string
  effortStyle: EffortStyle
  fetch?: typeof fetch
}

type ChunkToolCall = { index: number; id?: string; function?: { name?: string; arguments?: string } }

interface ChatChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: ChunkToolCall[] }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}

const FINISH_REASONS: readonly FinishReason[] = ['stop', 'tool_calls', 'length', 'content_filter']

function toWireMessage(message: LlmMessage) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function effortFields(style: EffortStyle, effort: LlmRequest['effort']): Record<string, unknown> {
  if (style === 'openai') return effort === 'off' ? {} : { reasoning_effort: effort }
  if (style === 'zhipu') return { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' } }
  return {}
}

export function requestBody(request: LlmRequest, effortStyle: EffortStyle): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    }),
    ...(request.maxOutputTokens !== undefined && { max_tokens: request.maxOutputTokens }),
    ...effortFields(effortStyle, request.effort),
  }
}

// Server-sent events from any OpenAI-compatible `/chat/completions` endpoint, without an SDK.
export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const fetcher = options.fetch ?? fetch
  return {
    async *stream(request, signal) {
      let response: Response
      try {
        response = await fetcher(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(requestBody(request, options.effortStyle)),
          signal,
        })
      } catch (error) {
        throw signal.aborted ? abortedError(signal) : new LlmError('network', String(error), { retryable: true })
      }
      if (!response.ok || !response.body) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        throw new LlmError('http', `HTTP ${response.status} ${detail}`.trim(), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        })
      }
      yield* parseChatStream(response.body, signal)
    },
  }
}

const abortedError = (signal: AbortSignal) =>
  new LlmError('aborted', signal.reason instanceof Error ? signal.reason.message : 'aborted')

async function* parseChatStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<LlmStreamEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  const toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>()
  let usage: Extract<LlmStreamEvent, { type: 'usage' }> | undefined
  let finishReason: FinishReason | undefined
  let finished = false
  let buffer = ''

  const handle = function* (data: string): Generator<LlmStreamEvent> {
    if (data === '[DONE]') {
      finished = true
      return
    }
    let chunk: ChatChunk
    try {
      chunk = JSON.parse(data) as ChatChunk
    } catch {
      throw new LlmError('protocol', `unparseable stream chunk: ${data.slice(0, 80)}`)
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      const thinking = delta.reasoning_content ?? delta.reasoning
      if (thinking) yield { type: 'thinking.delta', text: thinking }
      if (delta.content) yield { type: 'text.delta', text: delta.content }
      for (const fragment of delta.tool_calls ?? []) {
        const call = toolCalls.get(fragment.index) ?? { id: '', name: '', argumentsJson: '' }
        call.id ||= fragment.id ?? ''
        call.name += fragment.function?.name ?? ''
        call.argumentsJson += fragment.function?.arguments ?? ''
        toolCalls.set(fragment.index, call)
      }
      if (choice.finish_reason) {
        finishReason = FINISH_REASONS.includes(choice.finish_reason as FinishReason) ? (choice.finish_reason as FinishReason) : 'stop'
      }
    }
    if (chunk.usage) {
      usage = {
        type: 'usage',
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
        ...(chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined && {
          reasoning: chunk.usage.completion_tokens_details.reasoning_tokens,
        }),
        ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined && {
          cached: chunk.usage.prompt_tokens_details.cached_tokens,
        }),
      }
    }
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield* handle(data)
        if (finished) break
      }
    }
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw signal.aborted ? abortedError(signal) : new LlmError('network', String(error), { retryable: true })
  } finally {
    reader.releaseLock()
    body.cancel().catch(() => {})
  }

  if (!finished && finishReason === undefined) throw new LlmError('protocol', 'stream ended before the model finished')
  for (const call of toolCalls.values()) yield { type: 'tool_call', ...call }
  if (usage) yield usage
  yield { type: 'done', finishReason: finishReason ?? (toolCalls.size > 0 ? 'tool_calls' : 'stop') }
}
