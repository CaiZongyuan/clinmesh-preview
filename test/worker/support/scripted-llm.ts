import { installScriptedLlm } from '../../../src/worker/llm/registry'
import { LlmError, type AgentKind, type LlmProvider, type LlmRequest, type LlmStreamEvent } from '../../../src/worker/llm/types'

type Script = (signal: AbortSignal) => AsyncGenerator<LlmStreamEvent>

export interface Gate {
  // Resolves once the run has streamed the text before the gate and is waiting on it. Polled, because a promise
  // resolved inside a Durable Object's request and awaited by the test crashes workerd.
  reached: Promise<void>
  release(): void
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const chunk = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []

// The LLM boundary double for Worker-seam tests: a queue of scripts, one per LLM call, and a record of every
// request (deep-cloned) the agent made.
export class ScriptedLlm implements LlmProvider {
  readonly requests: LlmRequest[] = []
  private readonly scripts: Script[] = []

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    this.requests.push(structuredClone(request))
    const script = this.scripts.shift()
    if (!script) throw new LlmError('protocol', 'the scripted LLM has no script left')
    return script(signal)
  }

  reply(text: string, { thinking, chunkSize = 4 }: { thinking?: string; chunkSize?: number } = {}): this {
    this.scripts.push(async function* () {
      if (thinking) yield { type: 'thinking.delta', text: thinking }
      for (const part of chunk(text, chunkSize)) yield { type: 'text.delta', text: part }
      yield { type: 'usage', input: 100, output: text.length }
      yield { type: 'done', finishReason: 'stop' }
    })
    return this
  }

  // Streams `before`, waits until the test releases it, then streams `after`.
  gate(before: string, after: string): Gate {
    let atGate = false
    const released = deferred()
    this.scripts.push(async function* () {
      yield { type: 'text.delta', text: before }
      atGate = true
      await released.promise
      yield { type: 'text.delta', text: after }
      yield { type: 'done', finishReason: 'stop' }
    })
    return {
      get reached() {
        return (async () => {
          while (!atGate) await new Promise((resolve) => setTimeout(resolve, 5))
        })()
      },
      release: released.resolve,
    }
  }

  // Streams a thinking fragment, asks for one tool call, and ends the step.
  toolCall(name: string, argsJson: Record<string, unknown> | string, { thinking }: { thinking?: string } = {}): this {
    const argumentsJson = typeof argsJson === 'string' ? argsJson : JSON.stringify(argsJson)
    this.scripts.push(async function* () {
      if (thinking) yield { type: 'thinking.delta', text: thinking }
      yield { type: 'tool_call', id: `call-${Math.random().toString(36).slice(2, 8)}`, name, argumentsJson }
      yield { type: 'usage', input: 50, output: 10 }
      yield { type: 'done', finishReason: 'tool_calls' }
    })
    return this
  }

  // Never answers; ends only when the agent aborts the call (its deadline).
  hang(partial = ''): this {
    this.scripts.push(async function* (signal) {
      if (partial) yield { type: 'text.delta', text: partial }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new LlmError('aborted', 'aborted')
    })
    return this
  }

  fail(status: number): this {
    this.scripts.push(async function* () {
      throw new LlmError('http', `HTTP ${status}`, { status, retryable: status >= 500 })
    })
    return this
  }
}

export function installScripted(kind: AgentKind): ScriptedLlm {
  const llm = new ScriptedLlm()
  installScriptedLlm(kind, llm)
  return llm
}
