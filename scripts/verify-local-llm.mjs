// Live local LLM smoke check for zhipu/glm-5.3-flash in non-thinking mode (`thinking: { type: 'disabled' }`).
import fs from 'node:fs'

function loadDevVars() {
  const vars = {}
  if (!fs.existsSync('.dev.vars')) return vars
  for (const line of fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx > 0 && !line.trim().startsWith('#')) {
      vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  return vars
}

const vars = loadDevVars()
const baseUrl = (vars.LLM_BASE_URL || '').replace(/\/+$/, '')
const apiKey = vars.LLM_API_KEY || ''
const model = vars.LLM_MODEL || 'zhipu/glm-5.3-flash'

if (!baseUrl || !apiKey) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: 'LLM_BASE_URL or LLM_API_KEY not configured in .dev.vars' }))
  process.exit(0)
}

const t0 = performance.now()
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: '你是门诊就医助手，用简洁中文回答。' },
      { role: 'user', content: '请回复「互联门诊助手就绪」七个字。' },
    ],
    max_tokens: 40,
    thinking: { type: 'disabled' },
  }),
})
const elapsedMs = Number((performance.now() - t0).toFixed(1))
const body = await res.json().catch(() => null)
console.log(
  JSON.stringify(
    {
      ok: res.ok,
      status: res.status,
      model,
      effort: vars.LLM_REASONING_EFFORT || 'off',
      elapsedMs,
      hasReasoningContent: Boolean(body?.choices?.[0]?.message?.reasoning_content),
      content: body?.choices?.[0]?.message?.content ?? null,
    },
    null,
    2,
  ),
)
