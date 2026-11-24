import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoldenCaseQueueResponse } from '../../src/shared/golden-case-queue'
import { createAppRouter } from '../../src/web/router'

const queueResponse: GoldenCaseQueueResponse = {
  goldenCases: [
    {
      caseId: 'outpatient-cap-penicillin-anaphylaxis-v1',
      queueNumber: 7,
      patientName: '李建国',
      sex: 'male',
      age: 58,
      chiefComplaint: '发热、咳嗽 3 天',
      registeredAt: '2026-11-24T08:31:00+08:00',
      visitKind: 'first',
      queueStatus: 'waiting',
    },
  ],
}

const fetchStub = vi.fn<typeof fetch>()
const agent = createAgent()

beforeEach(() => {
  fetchStub.mockImplementation(async () => Response.json(queueResponse))
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderWorkbench() {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(<RouterProvider router={router} />)
}

describe('outpatient workbench', () => {
  it('lays out the four regions and lists Golden Case 1 in the queue, grouped by status', async () => {
    const user = userEvent.setup()
    renderWorkbench()

    const rail = await screen.findByRole('navigation', { name: '候诊队列' })
    expect(fetchStub).toHaveBeenCalledWith('/api/golden-cases')
    expect(screen.getByRole('region', { name: '问诊记录' })).toBeInTheDocument()
    expect(screen.getByRole('main', { name: '病例工作区' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '临床助手' })).toBeInTheDocument()
    expect(within(rail).getByRole('listitem', { name: '7 号 李建国 · 待诊' })).toBeInTheDocument()

    await user.click(within(rail).getByRole('button', { name: '打开候诊队列' }))
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

  it('names every control so the ui-sdk agent bridge can find it', async () => {
    renderWorkbench()
    await screen.findByRole('navigation', { name: '候诊队列' })

    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy()
    }
    const labels = components.map((entry) => entry.label)
    for (const label of ['打开候诊队列', '收起问诊记录', '工作台分栏']) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label)
    }
  })

  it('resizes columns from keyboard-operable separators and remembers a collapsed Consultation column', async () => {
    const user = userEvent.setup()
    const first = renderWorkbench()

    const consultationHandle = await screen.findByRole('separator', { name: '调整问诊记录宽度' })
    const copilotHandle = screen.getByRole('separator', { name: '调整临床助手宽度' })
    for (const handle of [consultationHandle, copilotHandle]) {
      expect(handle).toHaveAttribute('aria-valuenow')
      expect(handle).toHaveAttribute('aria-valuemin')
      expect(handle).toHaveAttribute('aria-valuemax')
    }

    const start = Number(consultationHandle.getAttribute('aria-valuenow'))
    consultationHandle.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(Number(consultationHandle.getAttribute('aria-valuenow'))).toBeGreaterThan(start)
    await user.keyboard('{End}')
    expect(consultationHandle.getAttribute('aria-valuenow')).toBe(consultationHandle.getAttribute('aria-valuemax'))
    await user.dblClick(consultationHandle)
    expect(Number(consultationHandle.getAttribute('aria-valuenow'))).toBe(start)

    await user.click(screen.getByRole('button', { name: '收起问诊记录' }))
    expect(screen.getByRole('region', { name: '问诊记录（已收起）' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '问诊记录' })).not.toBeInTheDocument()

    first.unmount()
    renderWorkbench()
    const strip = await screen.findByRole('region', { name: '问诊记录（已收起）' })
    await user.click(within(strip).getByRole('button', { name: '展开问诊记录' }))
    expect(screen.getByRole('region', { name: '问诊记录' })).toBeInTheDocument()
  })
})
