// Wrapper around the normal `vitest run` entrypoint. workerd logs errors escaping a DO RPC, alarm, fetch or
// WebSocket handler as "uncaught exception; ..." lines without failing vitest, so a real production fault
// could hide in that noise. This wrapper streams the child's stdout and stderr, collects every complete
// exception header until the child closes (including teardown), and fails the run if any header's error
// message is not one of the exact signatures of the deliberate fault injections in consultation.test.ts.
// CLI args, exit code and output are preserved. Run it via `pnpm test` (or `pnpm test <vitest args>`).
import { spawn } from 'node:child_process'

// Exact error messages of the deliberate fault injections (test/worker/consultation.test.ts). Exact match:
// no pattern, no substring, no file-global allowlist.
const allowedFaultMessages = [
  'connection lost after commit',
  'workspace briefly unreachable',
  'patient unreachable',
  'response lost',
]

const child = spawn('pnpm', ['exec', 'vitest', 'run', ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'],
})

const headers = []
for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  let buffered = ''
  stream.on('data', (chunk) => {
    out.write(chunk)
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.startsWith('uncaught exception')) headers.push(line)
    }
  })
  // A header line with no trailing newline would still be flushed at stream close.
  stream.on('close', () => {
    if (buffered.startsWith('uncaught exception')) headers.push(buffered)
  })
}

child.on('close', (code) => {
  // workerd prints the header as one line: `uncaught exception; source = ...; stack = Error: <message>`,
  // with the stack frames on the following lines (which we do not capture).
  const messageOf = (header) => {
    const marker = 'stack = Error: '
    const start = header.indexOf(marker)
    return start === -1 ? header : header.slice(start + marker.length).trim()
  }
  const unexpected = headers.filter((header) => !allowedFaultMessages.includes(messageOf(header)))
  if (unexpected.length > 0) {
    console.error(`\nUnexpected workerd uncaught exception(s) (not allowlisted deliberate fault injections):`)
    for (const header of unexpected) console.error(header)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
