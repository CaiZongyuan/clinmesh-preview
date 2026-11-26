import { bailianVoiceEndpoint } from '../../shared/voice'
import type { Recognizer } from '../../shared/consultation'
import { connectDashScope, type ConnectUpstream } from './paraformer-transcriber'

// Worker vars and secrets, read by name: BAILIAN_TOKEN is a secret (.dev.vars locally) with no generated type.
type VoiceEnv = Readonly<Record<string, unknown>>

function tokenOf(env: VoiceEnv) {
  for (const token of [env.BAILIAN_TOKEN, env['BAILIAN-TOKEN']]) {
    if (typeof token === 'string' && token.trim()) return token.trim()
  }
  return null
}

function connectFor(env: VoiceEnv): ConnectUpstream {
  const origin = env.CLINMESH_DEV_PROVIDER_ORIGIN
  const { url, workspace } = bailianVoiceEndpoint(env)
  return (token) => connectDashScope(token, typeof origin === 'string' ? `${origin}/voice` : url, workspace)
}

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

// Same seam for the Sambert TTS upstream: Worker-seam tests run with `BAILIAN_UPSTREAM=scripted` and install a
// fake DashScope TTS service here.
let scriptedTts: ConnectUpstream | null = null

export function installScriptedSambert(connect: ConnectUpstream): void {
  scriptedTts = connect
}

export function clearScriptedSambert(): void {
  scriptedTts = null
}

export function sambertUpstream(env: VoiceEnv): { token: string; connect: ConnectUpstream } | null {
  const token = tokenOf(env)
  if (!token) return null
  if (env.BAILIAN_UPSTREAM !== 'scripted') return { token, connect: connectFor(env) }
  return {
    token,
    connect: (t) => (scriptedTts ? scriptedTts(t) : Promise.reject(new Error('No scripted Sambert service is installed'))),
  }
}

export function paraformerUpstream(env: VoiceEnv): { token: string; connect: ConnectUpstream } | null {
  const token = tokenOf(env)
  if (!token) return null
  if (env.BAILIAN_UPSTREAM !== 'scripted') return { token, connect: connectFor(env) }
  return {
    token,
    connect: (t) => (scripted ? scripted(t) : Promise.reject(new Error('No scripted Paraformer service is installed'))),
  }
}
