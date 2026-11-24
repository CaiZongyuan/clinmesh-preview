import { reset } from 'cloudflare:test'
import { afterEach } from 'vitest'
import { clearScriptedLlm } from '../../src/worker/llm/registry'

// Durable Object storage persists across tests in a file unless it is reset. Scripted LLM providers are module
// state shared with the Durable Objects, so they are cleared too.
afterEach(async () => {
  clearScriptedLlm()
  await reset()
})
