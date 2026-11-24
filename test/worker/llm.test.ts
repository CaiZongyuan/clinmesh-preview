import { describe, expect, it, vi } from 'vitest'
import { resolveLlmConfig } from '../../src/worker/llm/config'
import { createOpenAiCompatibleProvider } from '../../src/worker/llm/openai-compatible'
import { resolveLlmProvider } from '../../src/worker/llm/registry'
import { LlmError, type LlmRequest, type LlmStreamEvent } from '../../src/worker/llm/types'

// A sanitized chat-completions stream in the shape OpenAI-compatible providers send: reasoning first, then text,
// a tool call split over chunks, the finish reason, and usage in a final chunk with no choices.
const SSE_FIXTURE = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"先想"}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"一想。"}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"发烧"}}]}',
  ': keep-alive comment',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"三天了。"}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"ui_snap","arguments":"{\\"sc"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"shot","arguments":"ope\\":1}"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":12},"prompt_tokens_details":{"cached_tokens":64}}}',
  'data: [DONE]',
].join('\n\n') + '\n\n'

const request: LlmRequest = {
  model: 'glm-5.3-flash',
  effort: 'low',
  messages: [
    { role: 'system', content: '你是患者。' },
    { role: 'user', content: '哪里不舒服？' },
  ],
  tools: [],
}

// Splits the body at awkward places (mid-event, mid-UTF-8 character) to exercise the parser's buffering.
function streamOf(text: string, chunkBytes = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkBytes) controller.enqueue(bytes.slice(i, i + chunkBytes))
      controller.close()
    },
  })
}

async function collect(iterable: AsyncIterable<LlmStreamEvent>) {
  const events: LlmStreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('OpenAI-compatible provider', () => {
  it('posts a streaming chat completion and parses thinking, text, tool calls, usage and the finish reason', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'https://llm.test/v4',
      apiKey: 'test-key',
      effortStyle: 'zhipu',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return new Response(streamOf(SSE_FIXTURE), { headers: { 'content-type': 'text/event-stream' } })
      },
    })

    const events = await collect(provider.stream(request, new AbortController().signal))
    expect(events).toEqual([
      { type: 'thinking.delta', text: '先想' },
      { type: 'thinking.delta', text: '一想。' },
      { type: 'text.delta', text: '发烧' },
      { type: 'text.delta', text: '三天了。' },
      { type: 'tool_call', id: 'call_1', name: 'ui_snapshot', argumentsJson: '{"scope":1}' },
      { type: 'usage', input: 120, output: 30, reasoning: 12, cached: 64 },
      { type: 'done', finishReason: 'tool_calls' },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://llm.test/v4/chat/completions')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer test-key')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'glm-5.3-flash',
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
    })
  })

  it('maps reasoning effort per provider style and sends tools and tool results in the OpenAI shape', async () => {
    let body: Record<string, unknown> = {}
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'https://llm.test',
      apiKey: 'k',
      effortStyle: 'openai',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init!.body))
        return new Response(streamOf('data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
      },
    })
    const withTools: LlmRequest = {
      ...request,
      effort: 'medium',
      maxOutputTokens: 256,
      tools: [{ name: 'ui_snapshot', description: '读取界面', parameters: { type: 'object', properties: {} } }],
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'ui_snapshot', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ],
    }
    expect(await collect(provider.stream(withTools, new AbortController().signal))).toEqual([
      { type: 'text.delta', text: '好' },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(body).toMatchObject({
      reasoning_effort: 'medium',
      max_tokens: 256,
      tools: [{ type: 'function', function: { name: 'ui_snapshot', description: '读取界面', parameters: { type: 'object', properties: {} } } }],
    })
    expect((body.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ui_snapshot', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ])
  })

  it('reports HTTP errors, truncated streams and aborts as LLM errors', async () => {
    const providerFor = (response: () => Response) =>
      createOpenAiCompatibleProvider({ baseUrl: 'https://llm.test', apiKey: 'k', effortStyle: 'none', fetch: async () => response() })

    const http = await collect(providerFor(() => new Response('rate limited', { status: 429 })).stream(request, new AbortController().signal)).catch(
      (e: unknown) => e,
    )
    expect(http).toBeInstanceOf(LlmError)
    expect(http).toMatchObject({ kind: 'http', options: { status: 429, retryable: true } })

    const truncated = await collect(
      providerFor(() => new Response(streamOf('data: {"choices":[{"delta":{"content":"发"}}]}\n\n'))).stream(request, new AbortController().signal),
    ).catch((e: unknown) => e)
    expect(truncated).toMatchObject({ kind: 'protocol' })

    const controller = new AbortController()
    controller.abort(new Error('deadline'))
    const aborted = await collect(
      createOpenAiCompatibleProvider({
        baseUrl: 'https://llm.test',
        apiKey: 'k',
        effortStyle: 'none',
        fetch: async (_url, init) => {
          init?.signal?.throwIfAborted()
          return new Response('')
        },
      }).stream(request, controller.signal),
    ).catch((e: unknown) => e)
    expect(aborted).toMatchObject({ kind: 'aborted' })
  })
})

describe('OpenAI-compatible stream edge cases', () => {
  const providerOver = (body: BodyInit) =>
    createOpenAiCompatibleProvider({ baseUrl: 'https://llm.test', apiKey: 'k', effortStyle: 'none', fetch: async () => new Response(body) })

  it('keeps a final event that ends the stream without its blank line', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n'
    expect(await collect(providerOver(body).stream(request, new AbortController().signal))).toEqual([
      { type: 'text.delta', text: '好' },
      { type: 'done', finishReason: 'stop' },
    ])
  })

  it('surfaces an error the provider reports mid-stream, with its message', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"error":{"message":"rate limited","code":"1302"}}\n\n'
    const error = await collect(providerOver(body).stream(request, new AbortController().signal)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'http', message: 'provider error: 1302 rate limited' })
  })

  it('cancels the upstream response when it stops reading early', async () => {
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {not json\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    const error = await collect(providerOver(upstream).stream(request, new AbortController().signal)).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'protocol' })
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })
})

describe('LLM configuration', () => {
  it('defaults to glm-5.3-flash at low effort and lets each agent override the shared settings', () => {
    const env = {
      LLM_BASE_URL: 'https://llm.test/v4/',
      LLM_API_KEY: 'shared-key',
      LLM_MODEL: 'glm-5.3-flash',
      PATIENT_LLM_MODEL: 'patient-model',
      COPILOT_LLM_REASONING_EFFORT: 'high',
      LLM_EFFORT_STYLE: 'zhipu',
    }
    expect(resolveLlmConfig(env, 'patient')).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://llm.test/v4',
      apiKey: 'shared-key',
      model: 'patient-model',
      effort: 'low',
      effortStyle: 'zhipu',
      contextWindow: 128_000,
    })
    expect(resolveLlmConfig(env, 'copilot')).toMatchObject({ model: 'glm-5.3-flash', effort: 'high' })
    expect(resolveLlmConfig({}, 'patient')).toMatchObject({ model: 'glm-5.3-flash', effort: 'low', apiKey: undefined })
  })

  it('reports llm-not-configured without an API key', () => {
    expect(resolveLlmProvider({ LLM_BASE_URL: 'https://llm.test' }, 'patient')).toMatchObject({ ok: false, reason: 'llm-not-configured' })
    expect(resolveLlmProvider({ LLM_BASE_URL: 'https://llm.test', LLM_API_KEY: 'k' }, 'patient')).toMatchObject({ ok: true, model: 'glm-5.3-flash' })
  })
})
