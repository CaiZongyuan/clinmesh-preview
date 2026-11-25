import type { Recognizer } from '../../shared/consultation'
import { connectDashScope, type ConnectUpstream } from './paraformer-transcriber'

// Worker vars and secrets, read by name: BAILIAN_TOKEN is a secret (.dev.vars locally) with no generated type.
type VoiceEnv = Readonly<Record<string, unknown>>

const tokenOf = (env: VoiceEnv) => (typeof env.BAILIAN_TOKEN === 'string' && env.BAILIAN_TOKEN.trim() ? env.BAILIAN_TOKEN.trim() : null)

// Without a Bailian token the browser recognizes speech itself (Web Speech API) and sends the text over HTTP.
export const recognizerFor = (env: VoiceEnv): Recognizer => (tokenOf(env) ? 'paraformer-realtime-v2' : 'web-speech')

// Worker-seam tests run with `BAILIAN_UPSTREAM=scripted` and install a fake DashScope service here. Tests and
// Durable Objects share this module state in the Workers Vitest pool.
let scripted: ConnectUpstream | null = null

export function installScriptedParaformer(connect: ConnectUpstream): void {
  scripted = connect
}

export function clearScriptedParaformer(): void {
  scripted = null
}

export function paraformerUpstream(env: VoiceEnv): { token: string; connect: ConnectUpstream } | null {
  const token = tokenOf(env)
  if (!token) return null
  if (env.BAILIAN_UPSTREAM !== 'scripted') return { token, connect: connectDashScope }
  return {
    token,
    connect: (t) => (scripted ? scripted(t) : Promise.reject(new Error('No scripted Paraformer service is installed'))),
  }
}
