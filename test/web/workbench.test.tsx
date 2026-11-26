import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'

const fetchStub = vi.fn<typeof fetch>()
const agent = createAgent()

beforeEach(() => {
  fetchStub.mockImplementation(createFakeClinicApi().handle)
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderWorkbench(active = true) {
  if (active) fetchStub.mockImplementation(createFakeClinicApi({ encounters: [encounterFor()] }).handle)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(<RouterProvider router={router} />)
}

describe('outpatient workbench', () => {
  it('opens the roster and lists Golden Case 1 in the queue, grouped by status', async () => {
    const user = userEvent.setup()
    renderWorkbench(false)

    const rail = await screen.findByRole('navigation', { name: '候诊队列' })
    expect(fetchStub).toHaveBeenCalledWith('/api/golden-cases', undefined)
    expect(screen.getByRole('region', { name: '挂号信息' })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: '7 号 李建国 · 待诊' })).toBeInTheDocument()

    const groups = await screen.findByRole('tablist', { name: '候诊分组' })
    expect(within(groups).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['在诊 0', '待诊 1', '完诊 0'])
    expect(within(groups).getByRole('tab', { name: '待诊 1' })).toHaveAttribute('aria-selected', 'true')

    const waiting = screen.getByRole('list', { name: '待诊患者' })
    const entry = within(waiting).getByRole('listitem')
    expect(entry).toHaveTextContent('7 号')
    expect(entry).toHaveTextContent('李建国')
    expect(entry).toHaveTextContent('男 58 岁')
    expect(entry).toHaveTextContent('初诊')
    expect(entry).toHaveTextContent('发热、咳嗽 3 天')
    expect(entry).toHaveTextContent('挂号 08:31')

    await user.click(within(groups).getByRole('tab', { name: '在诊 0' }))
    expect(screen.getByRole('tabpanel', { name: '在诊 0' })).toHaveTextContent('暂无')
  })

  it('names every control uniquely and lets the ui-sdk agent bridge collapse and expand the Consultation column', async () => {
    renderWorkbench()
    await screen.findByRole('navigation', { name: '候诊队列' })
    expect(screen.getByRole('separator', { name: '调整问诊记录宽度' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: '调整病例工作区宽度' })).toBeInTheDocument()

    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy()
    }
    const labels = components.map((entry) => entry.label)
    expect(new Set(labels).size, `duplicate names in ${labels.join(', ')}`).toBe(labels.length)
    for (const label of ['打开候诊队列', '收起问诊记录', '工作台分栏']) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label)
    }

    const collapse = await agent.act({ steps: [{ ref: '收起问诊记录', action: 'press' }] })
    expect(collapse.ok, collapse.error?.message).toBe(true)
    expect(await screen.findByRole('region', { name: '问诊记录（已收起）' })).toBeInTheDocument()

    const expand = await agent.act({ steps: [{ ref: '展开问诊记录', action: 'press' }] })
    expect(expand.ok, expand.error?.message).toBe(true)
    expect(await screen.findByRole('region', { name: '问诊记录' })).toBeInTheDocument()
  })

  it('resizes the Consultation column from its separator: arrow keys, End, double-click reset, Home collapses', async () => {
    const user = userEvent.setup()
    renderWorkbench()
    const handle = await screen.findByRole('separator', { name: '调整问诊记录宽度' })
    expect(handle).toHaveAttribute('aria-valuemin')
    expect(handle).toHaveAttribute('aria-valuemax')

    const start = valueOf(handle)
    handle.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(valueOf(handle)).toBeGreaterThan(start)
    await user.keyboard('{End}')
    expect(handle.getAttribute('aria-valuenow')).toBe(handle.getAttribute('aria-valuemax'))
    await user.dblClick(handle)
    expect(valueOf(handle)).toBe(start)

    handle.focus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('region', { name: '问诊记录（已收起）' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '问诊记录' })).not.toBeInTheDocument()
  })

  it('resizes the Clinical Copilot panel from its separator: arrow keys and double-click reset', async () => {
    const user = userEvent.setup()
    renderWorkbench()
    const handle = await screen.findByRole('separator', { name: '调整病例工作区宽度' })
    expect(handle).toHaveAttribute('aria-valuemin')
    expect(handle).toHaveAttribute('aria-valuemax')
    expect(handle).toHaveAttribute('aria-controls', 'case-workspace')

    const start = valueOf(handle)
    handle.focus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(valueOf(handle)).toBeLessThan(start)
    await user.dblClick(handle)
    expect(valueOf(handle)).toBe(start)
  })

  it('applies the selected color scheme and font size from the appearance controls', async () => {
    const user = userEvent.setup()
    renderWorkbench()
    await user.click(await screen.findByRole('button', { name: '工作台外观' }))
    const theme = screen.getByRole('radiogroup', { name: '主题' })
    const font = screen.getByRole('radiogroup', { name: '字号' })
    await user.click(within(theme).getByRole('radio', { name: '深色' }))
    await user.click(within(font).getByRole('radio', { name: '特大' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-font-scale', 'extra-large')
    await user.click(within(theme).getByRole('radio', { name: '浅色' }))
    await user.click(within(font).getByRole('radio', { name: '大' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).toHaveAttribute('data-font-scale', 'large')
    await user.click(within(theme).getByRole('radio', { name: '跟随系统' }))
    await user.click(within(font).getByRole('radio', { name: '标准' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'system')
    expect(document.documentElement).toHaveAttribute('data-font-scale', 'standard')
  })

  it('lists the implemented shortcuts and focuses the case tab selected by Alt plus its number', async () => {
    const user = userEvent.setup()
    fetchStub.mockImplementation(createFakeClinicApi({ encounters: [encounterFor()] }).handle)
    render(<RouterProvider router={createAppRouter({
      history: createMemoryHistory({ initialEntries: ['/encounters/encounter-1'] }),
    })} />)
    const trigger = await screen.findByRole('button', { name: '快捷键' })
    await user.click(trigger)
    const listing = await screen.findByRole('dialog', { name: '快捷键' })
    expect(listing).toHaveTextContent('按住 Space')
    expect(listing).toHaveTextContent('暂停或恢复收音')
    expect(listing).toHaveTextContent('Alt + 1–4')
    expect(listing).toHaveTextContent('Ctrl + /')
    expect(listing).toHaveTextContent('Esc')
    await user.keyboard('{Escape}')
    const tabs = await screen.findByRole('tablist', { name: '病例页签' })
    for (const [index, name] of ['病历记录', '检验检查', '诊断', '处方'].entries()) {
      await user.keyboard(`{Alt>}${index + 1}{/Alt}`)
      const selected = within(tabs).getByRole('tab', { name })
      expect(selected).toHaveAttribute('aria-selected', 'true')
      expect(selected).toHaveFocus()
    }
  })

  it('remembers keyboard-set widths and a collapsed Consultation column across reloads', async () => {
    const user = userEvent.setup()
    const first = renderWorkbench()
    const handle = await screen.findByRole('separator', { name: '调整问诊记录宽度' })
    const start = valueOf(handle)
    handle.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    const widened = valueOf(handle)
    expect(widened).toBeGreaterThan(start)

    first.unmount()
    const second = renderWorkbench()
    expect(valueOf(await screen.findByRole('separator', { name: '调整问诊记录宽度' }))).toBe(widened)

    await user.click(screen.getByRole('button', { name: '收起问诊记录' }))
    second.unmount()
    renderWorkbench()
    const strip = await screen.findByRole('region', { name: '问诊记录（已收起）' })
    await user.click(within(strip).getByRole('button', { name: '展开问诊记录' }))
    expect(screen.getByRole('region', { name: '问诊记录' })).toBeInTheDocument()
  })
})

const valueOf = (separator: HTMLElement) => Number(separator.getAttribute('aria-valuenow'))
