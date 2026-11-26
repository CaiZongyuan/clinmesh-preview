import { test as base, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { unstable_dev } from 'wrangler'

interface Completion {
  model: string
  messages: { role: string; content: string; tool_call_id?: string }[]
  tools?: unknown[]
}

function completionFrames(body: Completion) {
  const summary = body.messages[0]?.content.includes('你负责压缩')
  const lastPrompt = body.messages.findLastIndex((message) => message.role === 'user')
  const hasToolResult = body.messages.slice(lastPrompt + 1).some((message) => message.tool_call_id === 'call-state')
  if (body.tools?.length && !hasToolResult) {
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-state', function: { name: 'read_encounter_state', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 620, completion_tokens: 14 } },
    ]
  }
  const lines = summary ? ['已记录患者主诉、查体与本次就诊状态。'] : hasToolResult
    ? ['已查阅本次就诊记录。\n\n', '**问诊小结**\n患者自述发热、咳嗽 3 天。\n\n', '**待补充**\n- 核实症状变化与伴随不适。\n- 记录查体结果及后续安排。']
    : ['医生，我这三天一直发烧，', '还咳嗽，晚上比较明显。']
  return [...lines.map((content) => ({ choices: [{ delta: { content } }] })),
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: hasToolResult ? 940 : 280, completion_tokens: 62 } }]
}

export const test = base.extend<{ clinic: string }>({
  clinic: async ({}, use) => {
    const provider = createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer browser-test') {
        res.writeHead(404).end()
        return
      }
      let payload = ''
      for await (const chunk of req) payload += chunk
      const body: Completion = JSON.parse(payload)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (body.messages.findLast((message) => message.role === 'user')?.content.includes('持续查看本次问诊')) {
        const partial = { choices: [{ delta: { content: '正在核对已记录的问诊。' } }] }
        res.write(`data: ${JSON.stringify(partial)}\n\n`)
        return
      }
      for (const frame of completionFrames(body)) {
        if (res.destroyed) return
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
        await new Promise((done) => setTimeout(done, 45))
      }
      res.end('data: [DONE]\n\n')
    })
    const temp = await mkdtemp(join(tmpdir(), 'clinmesh-browser-'))
    try {
      provider.listen(0, '127.0.0.1')
      await once(provider, 'listening')
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Missing provider port')
      const envFile = join(temp, 'clinic.env')
      await writeFile(envFile, `LLM_API_KEY=browser-test\nLLM_BASE_URL=http://127.0.0.1:${address.port}/v1\n`)
      const worker = await unstable_dev(resolve('dist/clinmesh_preview/index.js'), {
        config: resolve('dist/clinmesh_preview/wrangler.json'),
        envFiles: [envFile],
        port: 0, inspectorPort: 0, ip: '127.0.0.1', persistTo: join(temp, 'state'),
        logLevel: 'error', experimental: { watch: false, disableExperimentalWarning: true, disableDevRegistry: true },
      })
      try {
        await use(`http://127.0.0.1:${worker.port}`)
      } finally {
        await worker.stop()
      }
    } finally {
      provider.closeAllConnections()
      await new Promise<void>((done) => provider.close(() => done()))
      await rm(temp, { recursive: true, force: true })
    }
  },
})
export { expect }
