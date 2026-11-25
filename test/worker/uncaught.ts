import { env } from 'cloudflare:workers'
import { expect } from 'vitest'

/**
 * workerd-side half of the uncaught-exception guard (see ./uncaught-guard-plugin.ts).
 * Tests call `allowUncaught` for deliberate fault injection; the worker setup then fails the run if any
 * captured workerd "uncaught exception" line does not match an allowlisted pattern.
 */

const allowPatterns: string[] = []

/** Mark the matching uncaught workerd lines as deliberate fault injection for this file's tests. */
export function allowUncaught(pattern: RegExp): void {
  allowPatterns.push(pattern.source)
}

/** Called from the worker setup afterEach/afterAll: fail on any unexpected uncaught workerd line. */
export async function expectNoUnexpectedUncaught(): Promise<void> {
  // UNCAUGHT_GUARD_PORT is injected by the vitest plugin, not the wrangler config, so it is not in Env.
  const port = (env as unknown as { UNCAUGHT_GUARD_PORT: string }).UNCAUGHT_GUARD_PORT
  const response = await fetch(`http://127.0.0.1:${port}/check`, {
    method: 'POST',
    body: JSON.stringify({ patterns: allowPatterns }),
  })
  const { unexpected } = (await response.json()) as { unexpected?: string[] }
  expect(
    unexpected ?? [],
    `unexpected workerd uncaught exception(s):\n${(unexpected ?? []).map((line) => line.split('\n').slice(0, 4).join('\n')).join('\n---\n')}`,
  ).toEqual([])
}
