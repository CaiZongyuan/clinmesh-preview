import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'

const fetchStub = vi.fn<typeof fetch>()
const agent = createAgent()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  const api = createFakeClinicApi({ encounters: [encounterFor()] })
  fetchStub.mockImplementation(api.handle)
  vi.stubGlobal('fetch', fetchStub)
  vi.stubGlobal('WebSocket', api.WebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function openEncounter() {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/encounters/encounter-1'] }) })
  return render(<RouterProvider router={router} />)
}

describe('hover timing and UX polish', () => {
  it('applies 500ms warm-up on first hover, 0ms instant switching across siblings, and cools down on exit', async () => {
    const user = userEvent.setup()
    openEncounter()
    const shortcuts = await screen.findByRole('button', { name: '快捷键' })
    const appearance = screen.getByRole('button', { name: '工作台外观' })
    const shortcutTip = document.getElementById(shortcuts.getAttribute('aria-describedby') ?? '')
    const appearanceTip = document.getElementById(appearance.getAttribute('aria-describedby') ?? '')
    expect(shortcutTip).toHaveTextContent('快捷键')
    expect(appearanceTip).toHaveTextContent('工作台外观')

    await user.hover(shortcuts)
    await pause(220)
    expect(shortcutTip).not.toHaveAttribute('data-open')

    await waitFor(() => expect(shortcutTip).toHaveAttribute('data-open'), { timeout: 600 })

    await user.hover(appearance)
    await pause(30)
    expect(appearanceTip).toHaveAttribute('data-open')

    // jsdom returns zero rects, so pointermove off (0, 0) exits ui-sdk's safe-triangle hover bridge.
    await user.unhover(appearance)
    fireEvent.pointerMove(document.body, { clientX: 500, clientY: 500 })
    await waitFor(() => expect(appearanceTip).not.toHaveAttribute('data-open'), { timeout: 300 })

    await pause(450)
    await user.hover(shortcuts)
    await pause(200)
    expect(shortcutTip).not.toHaveAttribute('data-open')
    await user.unhover(shortcuts)
    fireEvent.pointerMove(document.body, { clientX: 500, clientY: 500 })
  })

  it('keeps the copy tooltip open on press and switches its label to 已复制 in place', async () => {
    const user = userEvent.setup()
    openEncounter()
    const copyButton = await screen.findByRole('button', { name: '复制门诊号' })
    const tip = document.getElementById(copyButton.getAttribute('aria-describedby') ?? '')
    expect(tip).toHaveTextContent('复制门诊号')

    await pause(450)
    await user.hover(copyButton)
    await waitFor(() => expect(tip).toHaveAttribute('data-open'), { timeout: 800 })

    await user.click(copyButton)
    expect(await navigator.clipboard.readText()).toBe('20261124-0007')
    expect(tip).toHaveAttribute('data-open')
    expect(tip).toHaveTextContent('已复制')
    await user.unhover(copyButton)
    fireEvent.pointerMove(document.body, { clientX: 500, clientY: 500 })
  })

  it('opens the shared QueueRail patient glance tooltip after warm-up and keeps disabled triggers safe', async () => {
    const user = userEvent.setup()
    openEncounter()
    const rail = await screen.findByRole('navigation', { name: '候诊队列' })
    const patient = within(rail).getByRole('button', { name: '7 号 李建国 · 在诊' })

    expect(screen.getByRole('button', { name: '发送给临床助手' })).toBeDisabled()
    const components = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more')
    expect(components.every((e) => Boolean(e.label))).toBe(true)
    expect(new Set(components.map((e) => e.label)).size).toBe(components.length)

    await pause(450)
    await user.hover(patient)
    await pause(180)
    expect(document.querySelector('.cm-rail-tooltip[data-open]')).toBeNull()

    await waitFor(() => expect(document.querySelector('.cm-rail-tooltip[data-open]')).not.toBeNull(), { timeout: 600 })
    const glance = document.querySelector('.cm-rail-tooltip[data-open]')
    expect(glance).toHaveTextContent('李建国')
    expect(glance).toHaveTextContent('发热、咳嗽 3 天')
    await user.unhover(patient)
    fireEvent.pointerMove(document.body, { clientX: 500, clientY: 500 })
  })
})
