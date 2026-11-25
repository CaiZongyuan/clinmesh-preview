import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'

const fetchStub = vi.fn<typeof fetch>()
const ENCOUNTER = 'encounter-1'

beforeEach(() => {
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function openEncounter() {
  const api = createFakeClinicApi({ encounters: [encounterFor()] })
  fetchStub.mockImplementation(api.handle)
  vi.stubGlobal('WebSocket', api.WebSocket)
  render(
    <RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${ENCOUNTER}`] }) })} />,
  )
  return api
}

const panel = () => screen.findByRole('complementary', { name: '临床助手' }, { timeout: 8000 })
const composer = async () => within(await panel()).getByRole('textbox', { name: '问临床助手' })
const requestsTo = (method: string, path: string) =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)

async function ask(text: string) {
  const user = userEvent.setup()
  await user.type(await composer(), text)
  await user.click(screen.getByRole('button', { name: '发送给临床助手' }))
}

describe('Clinical Copilot panel', () => {
  it('lets the doctor pause automatic analysis and run waiting events together', async () => {
    const api = openEncounter()
    const user = userEvent.setup()
    const control = await screen.findByRole('switch', { name: '自动分析' })
    expect(control).toBeChecked()
    await user.click(control)
    await waitFor(() => expect(control).not.toBeChecked())
    expect(requestsTo('PUT', `/api/encounters/${ENCOUNTER}/copilot/automatic-analysis`)).toHaveLength(1)
    act(() => api.copilot.analysisEvent(ENCOUNTER, { ref: 'examination:vitals', text: '查体完成：生命体征' }))
    const run = await screen.findByRole('button', { name: '立即分析' })
    await waitFor(() => expect(run).toBeEnabled())
    expect(screen.getByRole('button', { name: /临床助手.*就绪.*1 个事件待分析/ })).toBeInTheDocument()
    expect(screen.getByText('查体完成：生命体征')).toBeInTheDocument()
    await user.click(run)
    await waitFor(() => expect(run).toBeDisabled())
    expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/pending-analysis/run`)).toHaveLength(1)
  })

  it('sends a prompt, streams the running turn, and shows the reply with steps and usage', async () => {
    const api = openEncounter()
    await panel()
    expect(requestsTo('GET', `/api/encounters/${ENCOUNTER}/copilot`)).toHaveLength(1)

    await ask('请总结目前的资料')
    expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/prompts`)).toHaveLength(1)
    await screen.findByRole('button', { name: '停止当前轮' })

    api.copilot.answer(ENCOUNTER, '根据问诊与既往资料，患者可能为上呼吸道感染。')
    const log = await screen.findByRole('log', { name: '临床助手会话' })
    await waitFor(() => expect(log).toHaveTextContent('上呼吸道感染'))
    // Steps render folded; expanding them shows the think text and the tool read with its args and result.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^思考与读取（2） · 第 1 轮$/ }))
    expect(log).toHaveTextContent('先看问诊记录。')
    expect(log).toHaveTextContent('就诊状态')
    expect(log).toHaveTextContent('详情')
    expect(log).toHaveTextContent('用量 输入 320 · 输出 96')
    expect(screen.queryByRole('button', { name: '停止当前轮' })).not.toBeInTheDocument()
  })

  it('stops the running turn from the button, and from Escape in the composer', async () => {
    const api = openEncounter()
    await ask('慢慢分析')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '停止当前轮' }))
    await waitFor(() =>
      expect(screen.getByRole('log', { name: '临床助手会话' })).toHaveTextContent('已按医生要求停止，已完成的部分保留。'),
    )

    await ask('再来一轮')
    expect(screen.getByRole('button', { name: '停止当前轮' })).toBeInTheDocument()
    const note = await screen.findByRole('textbox', { name: '主诉' })
    note.focus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/stop`)).toHaveLength(2))
    expect(api.copilot.snapshot(ENCOUNTER).turns.every((turn) => turn.status !== 'running')).toBe(true)
  })

  it('marks a reply helpful and lets the mark be taken back', async () => {
    const api = openEncounter()
    await ask('总结一下')
    api.copilot.answer(ENCOUNTER, '小结如下。')
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('log', { name: '临床助手会话' })).toHaveTextContent('小结如下。'))
    await user.click(screen.getByRole('button', { name: /^有帮助 · 第 1 轮$/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^有帮助 · 第 1 轮$/ })).toHaveAttribute('aria-pressed', 'true'))
    expect(api.copilot.snapshot(ENCOUNTER).turns[0].feedback).toBe('up')
    await user.click(screen.getByRole('button', { name: /^有帮助 · 第 1 轮$/ }))
    await waitFor(() => expect(api.copilot.snapshot(ENCOUNTER).turns[0].feedback).toBeNull())
  })

  it('edits and resends a finished turn, superseding it', async () => {
    const api = openEncounter()
    await ask('第一版问题')
    api.copilot.answer(ENCOUNTER, '第一版回答。')
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('log', { name: '临床助手会话' })).toHaveTextContent('第一版回答。'))
    await user.click(screen.getByRole('button', { name: /^编辑并重发 · 第 1 轮$/ }))
    expect(await composer()).toHaveValue('第一版问题')
    await user.type(await composer(), '（改）')
    await user.click(screen.getByRole('button', { name: '发送给临床助手' }))
    await waitFor(() => expect(api.copilot.snapshot(ENCOUNTER).turns).toHaveLength(2))
    expect(api.copilot.snapshot(ENCOUNTER).turns[0].superseded).toBe(true)
    expect(api.copilot.snapshot(ENCOUNTER).turns[1].trigger.text).toBe('第一版问题（改）')
  })

  it('keeps the selected note references when editing and resending a turn', async () => {
    const api = openEncounter()
    const path = `/api/encounters/${ENCOUNTER}/copilot`
    const mentions = [
      { kind: 'note-section', id: 'revision-1:chief-complaint', label: '主诉（已签署）' },
      { kind: 'draft', id: 'chief-complaint', label: '主诉（草稿）' },
    ]
    const seeded = await api.handle(`${path}/prompts`, {
      method: 'POST',
      body: JSON.stringify({ text: '@主诉（已签署） @主诉（草稿） 请对照。', mentions, mode: 'queue' }),
    })
    expect(seeded.status).toBe(201)
    const { turnId } = await seeded.json() as { turnId: string }
    api.copilot.answer(ENCOUNTER, '原回答。')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '编辑并重发 · 第 1 轮' }))
    await user.type(await composer(), '补充说明。')
    await user.click(screen.getByRole('button', { name: '发送给临床助手' }))
    const route = `${path}/turns/${turnId}/resend`
    await waitFor(() => {
      const body = requestsTo('POST', route).at(-1)?.[1]?.body
      expect(JSON.parse(String(body))).toMatchObject({ mentions, text: '@主诉（已签署） @主诉（草稿） 请对照。补充说明。' })
    })
  })

  it('changes model and effort with the chips', async () => {
    const api = openEncounter()
    await panel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: '选择思考力度' }))
    await user.click(await screen.findByRole('option', { name: '高' }))
    await waitFor(() => expect(api.copilot.snapshot(ENCOUNTER).model.effort).toBe('high'))
    expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/config`)).toHaveLength(1)
  })

  it('submits a slash-command prompt with Enter, and focuses the composer with Ctrl+/', async () => {
    openEncounter()
    await panel()
    const input = await composer()
    // jsdom events are never trusted, so the trigger menu itself cannot open under simulation; the menu's
    // behaviour is covered by a real-browser smoke. Enter-to-send and the prompt path are tested here.
    const user = userEvent.setup()
    await user.type(input, '/鉴别诊断')
    expect(screen.getByRole('button', { name: '发送给临床助手' })).toBeEnabled()
    await user.type(input, '{Enter}')
    await waitFor(() => expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/prompts`)).toHaveLength(1))
    expect(JSON.stringify(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/prompts`)[0]?.[1]?.body)).toContain('/鉴别诊断')
    expect(input).toHaveValue('')

    await user.click(screen.getByRole('button', { name: '隐藏临床助手' }))
    expect(screen.queryByRole('textbox', { name: '问临床助手' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /显示临床助手面板/ })).toHaveFocus()
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    expect(await composer()).toHaveFocus()
  })

  it('hides to a top-bar status with an unread count, and comes back', { timeout: 20_000 }, async () => {
    const api = openEncounter()
    const user = userEvent.setup()
    await ask('躲起来的提问')
    await user.click(screen.getByRole('button', { name: '隐藏临床助手' }))
    expect(screen.queryByRole('complementary', { name: '临床助手' })).not.toBeInTheDocument()

    const chip = screen.getByRole('button', { name: /显示临床助手面板/ })
    expect(chip).toHaveTextContent('运行中：躲起来的提问')
    api.copilot.answer(ENCOUNTER, '回答，但面板被隐藏。')
    await waitFor(() => expect(chip).toHaveTextContent('1'), { timeout: 6000 })

    await user.click(chip)
    expect(await panel()).toHaveTextContent('回答，但面板被隐藏。')
    await waitFor(() => expect(chip).not.toHaveTextContent('1'))
  })

  it('reveals streamed text while deltas are arriving continuously', async () => {
    const api = openEncounter()
    await ask('分析目前资料')
    const log = await screen.findByRole('log', { name: '临床助手会话' })
    vi.useFakeTimers()
    try {
      await act(async () => vi.advanceTimersByTimeAsync(200))
      for (let piece = 0; piece < 14; piece++) {
        await act(async () => {
          api.copilot.stream(ENCOUNTER, '正在分析')
          await vi.advanceTimersByTimeAsync(20)
        })
      }
      expect(log).toHaveTextContent('正在分析')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the doctor switch back to queue while an active turn remains', async () => {
    const api = openEncounter()
    await ask('分析目前资料')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '发送为指引' }))
    await ask('先看过敏史')
    expect(api.copilot.snapshot(ENCOUNTER).turns[0].steers).toHaveLength(1)
    // A steer is one turn only: the next prompt queues again without touching the controls.
    await ask('另一个问题')
    expect(api.copilot.snapshot(ENCOUNTER).queued).toContainEqual(expect.objectContaining({ text: '另一个问题' }))
  })

  it('opens the context view from the typed slash command: ring, categories, Case Truth zero, draft kept', async () => {
    const api = openEncounter()
    await ask('先跑一轮')
    api.copilot.answer(ENCOUNTER, '已完成的回答。')
    await waitFor(() => expect(screen.getByRole('log', { name: '临床助手会话' })).toHaveTextContent('已完成的回答。'))
    const input = await composer()
    const user = userEvent.setup()
    await user.type(input, '/上下文')
    await user.click(screen.getByRole('button', { name: '发送给临床助手' }))
    const dialog = await screen.findByRole('dialog', { name: '助手上下文（只读）' })
    expect(requestsTo('GET', `/api/encounters/${ENCOUNTER}/copilot/context`)).toHaveLength(1)
    // Usage ring against the model window with the compaction/output reserve.
    expect(dialog).toHaveTextContent('预计输入')
    expect(dialog).toHaveTextContent('128,000')
    expect(dialog).toHaveTextContent('预留（压缩与输出）')
    // Category stacked bar and table.
    expect(dialog).toHaveTextContent('上下文分类明细')
    expect(dialog).toHaveTextContent('工具定义')
    // An explicit Case Truth row, always zero and isolated.
    expect(dialog).toHaveTextContent('Case Truth')
    expect(dialog).toHaveTextContent('0 tokens · 隔离')
    // Per-request timeline reconciled with the provider usage.
    expect(dialog).toHaveTextContent('逐请求时间线')
    expect(dialog).toHaveTextContent('720')
    // What the doctor typed stays in the composer and was never sent.
    expect(input).toHaveValue('/上下文')
    expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/prompts`)).toHaveLength(1)
  })

  it('compacts the context on demand and shows the marker', async () => {
    const api = openEncounter()
    await ask('先跑一轮')
    api.copilot.answer(ENCOUNTER, '已完成的回答。')
    await waitFor(() => expect(screen.getByRole('log', { name: '临床助手会话' })).toHaveTextContent('已完成的回答。'))
    const user = userEvent.setup()
    await user.type(await composer(), '/上下文')
    await user.click(screen.getByRole('button', { name: '发送给临床助手' }))
    const dialog = await screen.findByRole('dialog', { name: '助手上下文（只读）' })
    await user.click(within(dialog).getByRole('button', { name: '压缩上下文' }))
    expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/copilot/compact`)).toHaveLength(1)
    // The compaction is queued as a run; the notice says so, and the marker lands in the session when it completes.
    expect(await within(dialog).findByText(/已加入压缩队列/)).toBeInTheDocument()
    // The marker shows in the session log after the dialog closes.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('log', { name: '临床助手会话' })).toHaveTextContent('已压缩'))
  })

  it('shows a reconnecting notice when the socket drops, and recovers', async () => {
    const api = openEncounter()
    await panel()
    api.copilot.dropConnections()
    await screen.findByText('连接中断，正在重连，恢复后从最新检查点继续。')
    // The hook reconnects with backoff; the notice clears once the replay is done.
    await waitFor(() => expect(screen.queryByText('连接中断，正在重连，恢复后从最新检查点继续。')).not.toBeInTheDocument(), { timeout: 8000 })
  })
})
