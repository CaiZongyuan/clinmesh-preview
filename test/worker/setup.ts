import { reset } from 'cloudflare:test'
import { afterAll, afterEach } from 'vitest'
import { clearScriptedLlm } from '../../src/worker/llm/registry'
import { expectNoUnexpectedUncaught } from './uncaught'

// Durable Object storage persists across tests in a file unless it is reset. Scripted LLM providers are module
// state shared with the Durable Objects, so they are cleared too. Any workerd uncaught exception that no test
// allowlisted via `allowUncaught` fails the run (see ./uncaught-guard-plugin.ts).
afterEach(async () => {
  clearScriptedLlm()
  await reset()
  await expectNoUnexpectedUncaught()
})

// Uncaught workerd lines can surface after the failing test finished, so check once more for the whole file.
afterAll(async () => {
  await expectNoUnexpectedUncaught()
})
