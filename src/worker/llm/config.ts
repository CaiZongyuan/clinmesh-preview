import { REASONING_EFFORTS } from '../../shared/reasoning-effort'
import type { AgentKind, ReasoningEffort } from './types'

// Worker vars and secrets, read by name so per-agent overrides need no generated types.
export type LlmEnv = Readonly<Record<string, unknown>>

export type LlmProviderName = 'openai-compatible' | 'scripted'
export type EffortStyle = 'openai' | 'zhipu' | 'none'

export interface LlmConfig {
  provider: LlmProviderName
  baseUrl: string | undefined
  apiKey: string | undefined
  model: string
  effort: ReasoningEffort
  effortStyle: EffortStyle
  contextWindow: number
  // Models the Clinical Copilot's model chip offers; the configured model is always one of them.
  modelOptions: string[]
}

// A session-only choice (the Copilot's model chip) that overrides the environment's model and effort.
export interface LlmOverride {
  model?: string
  effort?: ReasoningEffort
}

const AGENT_PREFIX: Record<AgentKind, string> = { patient: 'PATIENT_', copilot: 'COPILOT_' }

const DEFAULT_MODEL = 'glm-5.3-flash'
const DEFAULT_CONTEXT_WINDOW = 128_000
const EFFORTS: readonly ReasoningEffort[] = REASONING_EFFORTS
const EFFORT_STYLES: readonly EffortStyle[] = ['openai', 'zhipu', 'none']

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

// `PATIENT_LLM_MODEL` overrides `LLM_MODEL` for the Simulated Patient, `COPILOT_LLM_MODEL` for the Clinical Copilot.
export function resolveLlmConfig(env: LlmEnv, kind: AgentKind): LlmConfig {
  const read = (key: string): string | undefined => {
    for (const name of [`${AGENT_PREFIX[kind]}LLM_${key}`, `LLM_${key}`]) {
      const value = env[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }
  const contextWindow = Number(read('CONTEXT_WINDOW'))
  const model = read('MODEL') ?? DEFAULT_MODEL
  const options = (read('MODEL_OPTIONS') ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  return {
    provider: read('PROVIDER') === 'scripted' ? 'scripted' : 'openai-compatible',
    baseUrl: read('BASE_URL')?.replace(/\/+$/, ''),
    apiKey: read('API_KEY'),
    model,
    effort: oneOf(read('REASONING_EFFORT'), EFFORTS, 'low'),
    effortStyle: oneOf(read('EFFORT_STYLE'), EFFORT_STYLES, 'none'),
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    modelOptions: [...new Set([model, ...options])],
  }
}
