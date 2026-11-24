import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsultationTurn } from '../../src/shared/consultation'
import type { EncounterView } from '../../src/shared/encounter'
import type { PhysicalExaminationView } from '../../src/shared/physical-examination'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor, examinationFor, turnFor } from './fake-clinic-api'

const agent = createAgent()
const fetchStub = vi.fn<typeof fetch>()
const ENCOUNTER = 'encounter-1'

beforeEach(() => {
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Setup {
  encounters?: EncounterView[]
  turns?: ConsultationTurn[]
  examinations?: PhysicalExaminationView[]
}

function openEncounter({ encounters = [encounterFor()], turns = [], examinations = [] }: Setup = {}) {
  const api = createFakeClinicApi({
    encounters,
    consultations: { [ENCOUNTER]: turns },
    examinations: { [ENCOUNTER]: examinations },
  })
  fetchStub.mockImplementation(api.handle)
  vi.stubGlobal('WebSocket', api.WebSocket)
  const view = () => render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${ENCOUNTER}`] }) })} />)
  return { api, view, rendered: view() }
}

const column = () => screen.findByRole('region', { name: '问诊记录' })
const transcriptRows = () => within(screen.getByRole('list', { name: '问诊转写' })).getAllByRole('listitem')
const live = () => waitFor(() => expect(screen.getByRole('status', { name: '模拟患者连接' })).toHaveTextContent('实时'))
const requestsTo = (method: string, path: string) =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)

async function askQuestion(text: string) {
  const user = userEvent.setup()
  await user.type(within(await column()).getByRole('textbox', { name: '键入向患者的提问' }), text)
  await user.click(screen.getByRole('button', { name: '发送' }))
}

describe('typed Consultation', () => {
  it('sends a typed question, streams the Simulated Patient reply into the transcript, then shows it settled', async () => {
    const { api } = openEncounter()
    await column()
    await live()
    await askQuestion('您哪里不舒服？')

    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    const [doctor, patient] = transcriptRows()
    expect(doctor).toHaveAccessibleName('第 1 条 · 医生')
    expect(doctor).toHaveTextContent('接诊医生')
    expect(doctor).toHaveTextContent('键入')
    expect(doctor).toHaveTextContent('您哪里不舒服？')
    expect(within(doctor).getByText(/^\d{2}:\d{2}:\d{2}$/)).toHaveAttribute('datetime')
    expect(patient).toHaveAccessibleName('第 2 条 · 患者')
    expect(patient).toHaveTextContent('李建国')
    expect(patient).toHaveTextContent('模拟患者正在组织语言')
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveAttribute('placeholder', '等待患者回答…')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    const [[, init]] = requestsTo('POST', `/api/encounters/${ENCOUNTER}/consultation/doctor-turns`)
    expect(JSON.parse(String(init?.body))).toEqual({ clientTurnId: expect.any(String), text: '您哪里不舒服？' })

    act(() => api.patient.stream(ENCOUNTER, '医生，我这三天'))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('医生，我这三天'))
    act(() => api.patient.stream(ENCOUNTER, '一直发烧。'))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('医生，我这三天一直发烧。'))

    act(() => api.patient.answer(ENCOUNTER, '医生，我这三天一直发烧，咳嗽得厉害。'))
    await waitFor(() => expect(transcriptRows()[1]).not.toHaveTextContent('模拟患者正在组织语言'))
    expect(transcriptRows()[1]).toHaveTextContent('医生，我这三天一直发烧，咳嗽得厉害。')
    expect(transcriptRows()[1]).toHaveTextContent('模拟患者')
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveAttribute('placeholder', '键入问题（不经过语音）')
  })

  it('shows the server refusal when a reply is still pending, e.g. from another tab', async () => {
    const { api } = openEncounter()
    await live()
    await api.handle(`/api/encounters/${ENCOUNTER}/consultation/doctor-turns`, {
      method: 'POST',
      body: JSON.stringify({ clientTurnId: 'other-tab', text: '咳嗽有痰吗？' }),
    })
    await askQuestion('平时抽烟吗？')

    expect(await within(await column()).findByRole('alert')).toHaveTextContent('患者还在回答上一个问题')
    await waitFor(() => expect(transcriptRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('咳嗽有痰吗？'),
      expect.stringContaining('模拟患者正在组织语言'),
    ]))
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveValue('平时抽烟吗？')
  })

  it('keeps a failed reply in the record and retries it in one click', async () => {
    const { api } = openEncounter()
    await live()
    await askQuestion('您哪里不舒服？')
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    act(() => api.patient.fail(ENCOUNTER, 'timeout'))

    const failed = await waitFor(() => {
      const row = transcriptRows()[1]
      expect(row).toHaveTextContent('模拟患者回答超时，本轮已标记失败，提问锁已释放。')
      return row
    })
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveAttribute('placeholder', '键入问题（不经过语音）')

    await userEvent.setup().click(within(failed).getByRole('button', { name: '重试这一问' }))
    await waitFor(() => expect(transcriptRows()).toHaveLength(3))
    expect(requestsTo('POST', `/api/encounters/${ENCOUNTER}/consultation/patient-turns/${api.turns(ENCOUNTER)[1].turnId}/retry`)).toHaveLength(1)
    expect(transcriptRows()[1]).toHaveTextContent('模拟患者回答超时')
    expect(within(transcriptRows()[1]).queryByRole('button', { name: '重试这一问' })).not.toBeInTheDocument()
    expect(transcriptRows()[2]).toHaveTextContent('第 2 次作答')

    act(() => api.patient.answer(ENCOUNTER, '发烧三天了。'))
    await waitFor(() => expect(transcriptRows()[2]).toHaveTextContent('发烧三天了。'))
  })

  it('explains a reply that failed because no model is configured', async () => {
    openEncounter({
      turns: [
        turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？' }),
        turnFor({ seq: 2, speaker: 'patient', status: 'failed', failure: 'llm-not-configured' }),
      ],
    })
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('未配置大模型接口（LLM_API_KEY），模拟患者无法回答。'))
    expect(within(transcriptRows()[1]).getByRole('button', { name: '重试这一问' })).toBeInTheDocument()
  })

  it('offers no question box or retry on an abandoned Encounter', async () => {
    openEncounter({
      encounters: [encounterFor({ status: 'abandoned', endedAt: new Date().toISOString() })],
      turns: [
        turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？' }),
        turnFor({ seq: 2, speaker: 'patient', status: 'failed', failure: 'encounter-ended' }),
      ],
    })
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('就诊已结束，本轮未作答。'))
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '重试这一问' })).not.toBeInTheDocument()
  })
})

describe('transcript', () => {
  const turns = () => [
    turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？', createdAt: '2026-11-24T00:41:00.000Z' }),
    turnFor({ seq: 2, speaker: 'patient', text: '发烧三天了。', createdAt: '2026-11-24T00:41:00.000Z', settledAt: '2026-11-24T00:41:04.000Z' }),
    turnFor({ seq: 3, speaker: 'doctor', text: '咳嗽有痰吗？', createdAt: '2026-11-24T00:43:00.000Z' }),
    turnFor({ seq: 4, speaker: 'patient', text: '有黄痰。', createdAt: '2026-11-24T00:43:00.000Z', settledAt: '2026-11-24T00:43:09.000Z' }),
  ]

  it('interleaves examination rows by time and filters all / doctor / patient / examination', async () => {
    const user = userEvent.setup()
    openEncounter({ turns: turns(), examinations: [examinationFor('pharynx', '2026-11-24T00:42:00.000Z')] })
    await waitFor(() => expect(transcriptRows()).toHaveLength(5))
    expect(transcriptRows().map((row) => row.getAttribute('data-speaker') ?? row.getAttribute('data-kind'))).toEqual([
      'doctor',
      'patient',
      'examination',
      'doctor',
      'patient',
    ])
    // A reply shows when the patient gave it, not when the question was asked.
    expect(within(transcriptRows()[1]).getByText('08:41:04')).toHaveAttribute('datetime', '2026-11-24T00:41:04.000Z')
    expect(within(transcriptRows()[3]).getByText('08:43:00')).toBeInTheDocument()

    const filter = screen.getByRole('radiogroup', { name: '筛选问诊记录' })
    await user.click(within(filter).getByRole('radio', { name: '医生' }))
    expect(transcriptRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('您哪里不舒服？'),
      expect.stringContaining('咳嗽有痰吗？'),
    ])
    await user.click(within(filter).getByRole('radio', { name: '患者' }))
    expect(transcriptRows().map((row) => row.getAttribute('data-speaker'))).toEqual(['patient', 'patient'])
    await user.click(within(filter).getByRole('radio', { name: '查体' }))
    expect(transcriptRows()).toHaveLength(1)
    expect(transcriptRows()[0]).toHaveAttribute('data-kind', 'examination')
    await user.click(within(filter).getByRole('radio', { name: '全部' }))
    expect(transcriptRows()).toHaveLength(5)
  })

  it('says so when a filter matches nothing', async () => {
    const user = userEvent.setup()
    openEncounter({ turns: turns() })
    await waitFor(() => expect(transcriptRows()).toHaveLength(4))
    await user.click(screen.getByRole('radio', { name: '查体' }))
    expect(screen.getByText('还没有查体记录。')).toBeInTheDocument()
  })

  it('copies one turn', async () => {
    const user = userEvent.setup()
    openEncounter({ turns: turns() })
    await waitFor(() => expect(transcriptRows()).toHaveLength(4))
    await user.click(screen.getByRole('button', { name: '复制第 4 条' }))
    expect(await navigator.clipboard.readText()).toBe('有黄痰。')
    expect(screen.getByRole('status', { name: '第 4 条复制状态' })).toHaveTextContent('已复制')
  })

  it('offers a jump back to the latest turn once the doctor scrolls up', async () => {
    const user = userEvent.setup()
    openEncounter({ turns: turns() })
    await waitFor(() => expect(transcriptRows()).toHaveLength(4))
    const viewport = screen.getByRole('log', { name: '问诊实时记录' })
    const jump = screen.getByRole('button', { name: '回到最新', hidden: true })
    let scrollTop = 600
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) },
    })

    fireEvent.scroll(viewport)
    expect(jump).not.toHaveAttribute('data-visible')
    // The scroll area tells the doctor's scrolling from its own once a scroll settles.
    await new Promise((resolve) => setTimeout(resolve, 50))
    scrollTop = 100
    fireEvent.wheel(viewport, { deltaY: -500 })
    fireEvent.scroll(viewport)
    await waitFor(() => expect(jump).toHaveAttribute('data-visible'))

    viewport.scrollTo = ((options: ScrollToOptions) => {
      scrollTop = options.top ?? scrollTop
      fireEvent.scroll(viewport)
    }) as typeof viewport.scrollTo
    await user.click(jump)
    await waitFor(() => expect(scrollTop).toBeGreaterThan(590))
    await waitFor(() => expect(jump).not.toHaveAttribute('data-visible'))
  })
})

describe('collapsed Consultation column', () => {
  it('shows the waiting indicator while a reply is pending', async () => {
    const user = userEvent.setup()
    const { api } = openEncounter()
    await live()
    await askQuestion('您哪里不舒服？')
    await user.click(screen.getByRole('button', { name: '收起问诊记录' }))
    const strip = await screen.findByRole('region', { name: '问诊记录（已收起）' })
    expect(within(strip).getByRole('status', { name: '等待患者回答' })).toBeInTheDocument()
    expect(strip).toHaveTextContent('问诊记录 · 1 问')

    act(() => api.patient.answer(ENCOUNTER, '发烧三天了。'))
    await waitFor(() => expect(within(strip).queryByRole('status', { name: '等待患者回答' })).not.toBeInTheDocument())
  })
})

describe('refresh and disconnects', () => {
  it('restores the transcript and the reply streamed so far after a page refresh', async () => {
    const { api, rendered, view } = openEncounter()
    await live()
    await askQuestion('您哪里不舒服？')
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    act(() => api.patient.stream(ENCOUNTER, '我这三天'))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('我这三天'))

    rendered.unmount()
    view()
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('我这三天'))
    act(() => api.patient.answer(ENCOUNTER, '我这三天一直发烧。'))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('我这三天一直发烧。'))
  })

  it('reconnects after a dropped connection and catches up on what streamed meanwhile', async () => {
    const { api } = openEncounter()
    await live()
    await askQuestion('您哪里不舒服？')
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    act(() => api.patient.stream(ENCOUNTER, '我这三天'))

    act(() => api.patient.dropConnections())
    await waitFor(() => expect(screen.getByRole('status', { name: '模拟患者连接' })).toHaveTextContent('连接中断，重连中…'))
    act(() => api.patient.stream(ENCOUNTER, '一直发烧。'))
    act(() => api.patient.answer(ENCOUNTER, '我这三天一直发烧。'))

    await waitFor(() => expect(screen.getByRole('status', { name: '模拟患者连接' })).toHaveTextContent('实时'), { timeout: 3000 })
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('我这三天一直发烧。'))
    expect(api.openSockets()).toHaveLength(1)
  })
})

describe('keeping the transcript current', () => {
  it('reloads only once the workspace has the reply, not when the patient run merely finished', async () => {
    const { api } = openEncounter()
    await live()
    await askQuestion('您哪里不舒服？')
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    const reads = () => requestsTo('GET', `/api/encounters/${ENCOUNTER}/consultation`).length

    act(() => void api.patient.finishOnly(ENCOUNTER))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transcriptRows()[1]).toHaveTextContent('模拟患者正在组织语言')
    const before = reads()

    act(() => api.patient.deliver(ENCOUNTER, '发烧三天了。'))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('发烧三天了。'))
    expect(reads()).toBe(before + 1)
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveAttribute('placeholder', '键入问题（不经过语音）')
  })

  it('asks the workspace again once a pending reply is past its deadline, even with no event', async () => {
    const { api } = openEncounter({
      turns: [
        turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？' }),
        turnFor({ seq: 2, speaker: 'patient', status: 'pending', deadlineAt: new Date(Date.now() - 10_000).toISOString() }),
      ],
    })
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('模拟患者正在组织语言'))
    // Let the socket finish its replay (whose own reload would otherwise pick up the change), so only the
    // deadline re-check can.
    await live()
    await new Promise((resolve) => setTimeout(resolve, 100))
    api.patient.expireSilently(ENCOUNTER)

    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('模拟患者回答超时'), { timeout: 4000 })
    expect(within(transcriptRows()[1]).getByRole('button', { name: '重试这一问' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveAttribute('placeholder', '键入问题（不经过语音）')
  })

  it('shows the waiting reply as ended once the doctor abandons the Encounter', async () => {
    const user = userEvent.setup()
    openEncounter()
    await live()
    await askQuestion('您哪里不舒服？')
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('模拟患者正在组织语言'))

    await user.click(screen.getByRole('button', { name: '放弃就诊' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认放弃' }))
    await waitFor(() => expect(transcriptRows()[1]).toHaveTextContent('就诊已结束，本轮未作答。'))
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '重试这一问' })).not.toBeInTheDocument()
  })

  it('resends a question whose request failed under the same client turn id', async () => {
    const user = userEvent.setup()
    const { api } = openEncounter()
    await live()
    fetchStub.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
    fetchStub.mockImplementation(api.handle)
    await askQuestion('您哪里不舒服？')
    expect(await within(await column()).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '键入向患者的提问' })).toHaveValue('您哪里不舒服？')

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    const ids = fetchStub.mock.calls
      .filter(([url, init]) => String(url).endsWith('/consultation/doctor-turns') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)).clientTurnId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
  })
})

describe('agent bridge', () => {
  it('names every control uniquely with a Consultation in progress', async () => {
    openEncounter({
      turns: [
        turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？' }),
        turnFor({ seq: 2, speaker: 'patient', text: '发烧三天了。' }),
        turnFor({ seq: 3, speaker: 'doctor', text: '咳嗽有痰吗？' }),
        turnFor({ seq: 4, speaker: 'patient', status: 'failed', failure: 'timeout' }),
      ],
    })
    await waitFor(() => expect(transcriptRows()).toHaveLength(4))
    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
    for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy()
    const labels = components.map((entry) => entry.label)
    expect(new Set(labels).size, `duplicate names in ${labels.join(', ')}`).toBe(labels.length)
    for (const label of ['键入向患者的提问', '筛选问诊记录', '复制第 1 条', '复制第 2 条', '重试这一问']) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label)
    }
  })
})
