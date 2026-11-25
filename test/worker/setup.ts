import { reset } from 'cloudflare:test'
import { afterEach } from 'vitest'
import { clearScriptedLlm } from '../../src/worker/llm/registry'
import { clearScriptedParaformer } from '../../src/worker/voice/voice-config'

// Durable Object storage persists across tests in a file unless it is reset. Scripted LLM providers and the fake
// Paraformer service are module state shared with the Durable Objects, so they are cleared too.
afterEach(async () => {
  clearScriptedLlm()
  clearScriptedParaformer()
  await reset()
})
