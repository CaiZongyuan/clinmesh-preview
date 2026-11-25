import http from 'node:http'
import type { Plugin } from 'vite'

/**
 * Test-harness-only guard for unexpected workerd uncaught exceptions.
 *
 * workerd logs uncaught exceptions (e.g. errors escaping a DO RPC, alarm, fetch or WebSocket handler) as
 * "uncaught exception; ..." lines. The @cloudflare/vitest-plugin hardcodes its structured-log handler and
 * prints those lines without failing vitest, so a real production fault could hide in the noise. This
 * plugin runs on the Node side (the pool writes the lines to process.stdout/stderr here), captures them,
 * and exposes them to the workerd-resident test setup over a loopback HTTP bridge (workerd cannot read
 * Node memory or files). `test/worker/uncaught.ts` posts its allowlist and asserts no unexpected line.
 */

const lines: string[] = []
const patternSources: string[] = []

function installCapture() {
  const flag = globalThis as Record<string, unknown>
  if (flag.__clinmeshUncaughtCaptureInstalled) return
  flag.__clinmeshUncaughtCaptureInstalled = true
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream)
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string' && chunk.includes('uncaught exception')) lines.push(chunk)
      return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof stream.write
  }
}

let bridgePort: number | undefined

async function startBridge(): Promise<number> {
  if (bridgePort !== undefined) return bridgePort
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        try {
          const { patterns } = JSON.parse(body || '{}') as { patterns?: string[] }
          if (Array.isArray(patterns)) patternSources.push(...patterns)
          const unexpected = lines.filter((line) => !patternSources.some((source) => new RegExp(source).test(line)))
          res.end(JSON.stringify({ unexpected }))
        } catch (error) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(error) }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      bridgePort = port
      resolve(port)
    })
    // An unref'ed server still serves the vitest run but does not keep the process alive afterwards.
    server.unref()
  })
}

/**
 * Installs the capture and exposes the bridge port as an env binding named `UNCAUGHT_GUARD_PORT`.
 * Pass the same `miniflare` options object that is handed to `cloudflareTest`.
 */
export function uncaughtGuardPlugin(miniflareOptions: { bindings?: Record<string, unknown> }): Plugin {
  return {
    name: 'clinmesh-uncaught-guard',
    async config() {
      installCapture()
      const port = await startBridge()
      miniflareOptions.bindings = { ...miniflareOptions.bindings, UNCAUGHT_GUARD_PORT: String(port) }
    },
  }
}
