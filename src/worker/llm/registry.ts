import { resolveLlmConfig, type LlmEnv } from './config'
import { createOpenAiCompatibleProvider } from './openai-compatible'
import type { AgentKind, LlmProvider, ReasoningEffort } from './types'

export type ResolvedLlm =
  | { ok: true; provider: LlmProvider; model: string; effort: ReasoningEffort }
  | { ok: false; reason: 'llm-not-configured'; message: string }

// Worker-seam tests run with `LLM_PROVIDER=scripted` and install a scripted provider per agent kind here.
// Tests and Durable Objects share this module state in the Workers Vitest pool, across evictions too.
const scripted = new Map<AgentKind, LlmProvider>()

export function installScriptedLlm(kind: AgentKind, provider: LlmProvider): void {
  scripted.set(kind, provider)
}

export function clearScriptedLlm(): void {
  scripted.clear()
}

export function resolveLlmProvider(env: LlmEnv, kind: AgentKind): ResolvedLlm {
  const config = resolveLlmConfig(env, kind)
  if (config.provider === 'scripted') {
    const provider = scripted.get(kind)
    return provider
      ? { ok: true, provider, model: config.model, effort: config.effort }
      : { ok: false, reason: 'llm-not-configured', message: `没有为 ${kind} 安装脚本化模型` }
  }
  if (!config.apiKey || !config.baseUrl) {
    return { ok: false, reason: 'llm-not-configured', message: '未配置大模型接口（LLM_BASE_URL / LLM_API_KEY）' }
  }
  return {
    ok: true,
    provider: createOpenAiCompatibleProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, effortStyle: config.effortStyle }),
    model: config.model,
    effort: config.effort,
  }
}
