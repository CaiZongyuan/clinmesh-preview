import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EncounterView } from '../../src/shared/encounter'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'

let approve = false
const agent = createAgent({ allow: (step) => !step.confirm || approve })
const fetchStub = vi.fn<typeof fetch>()

beforeEach(() => {
  approve = false
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function openWorkbench(path: string, encounters: EncounterView[] = []) {
  const api = createFakeClinicApi({ encounters })
  fetchStub.mockImplementation(api.handle)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<RouterProvider router={router} />)
  return { api, router }
}

const requestsTo = (method: string, path: string) =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)

const banner = () => screen.findByRole('region', { name: '患者信息' })

describe('starting an Encounter', () => {
  it('selects a waiting patient in the queue, starts the Encounter and shows the patient banner', async () => {
    const user = userEvent.setup()
    const { router } = openWorkbench('/')
    const rail = await screen.findByRole('navigation', { name: '候诊队列' })
    await user.click(within(rail).getByRole('button', { name: '7 号 李建国 · 待诊' }))

    const registration = await screen.findByRole('region', { name: '挂号信息' })
    expect(registration).toHaveTextContent('李建国')
    expect(registration).toHaveTextContent('主诉：发热、咳嗽 3 天')
    expect(screen.queryByRole('region', { name: '患者信息' })).not.toBeInTheDocument()
    await user.click(within(registration).getByRole('button', { name: '开始接诊' }))

    const patient = await banner()
    expect(requestsTo('POST', '/api/encounters')).toHaveLength(1)
    expect(JSON.parse(String(requestsTo('POST', '/api/encounters')[0][1]?.body))).toEqual({ caseId: 'golden-case-01' })
    expect(router.state.location.pathname).toBe('/encounters/started-1')

    expect(within(patient).getByRole('heading', { level: 2, name: '李建国' })).toBeInTheDocument()
    for (const text of ['男 · 58 岁', '初诊', '分诊 3 级', '慢病：原发性高血压', '就诊中', '20261124-0007', '挂号 08:31', '全科医学科门诊', '城镇职工医保', '主诉：发热、咳嗽 3 天']) {
      expect(patient).toHaveTextContent(text)
    }
    expect(within(patient).getByText('过敏：青霉素（过敏性休克）')).toHaveClass('bg-destructive', 'text-destructive-foreground')
    expect(within(patient).getByTitle('本次就诊时长')).toHaveTextContent(/^就诊时长00:0\d$/)

    const vitals = within(within(patient).getByRole('list', { name: '分诊生命体征' })).getAllByRole('listitem')
    expect(vitals.map((tile) => tile.textContent)).toEqual([
      'T体温38.4℃↑偏高',
      'P脉搏98次/分',
      'R呼吸20次/分',
      'BP血压136/82mmHg',
      'SpO₂血氧饱和度95%',
    ])
    expect(patient).toHaveTextContent('分诊 08:20')

    const railAfter = screen.getByRole('navigation', { name: '候诊队列' })
    expect(within(railAfter).getByRole('button', { name: '7 号 李建国 · 在诊' })).toHaveAttribute('aria-current', 'true')
  })

  it('returns to the active Encounter from the server after a reload', async () => {
    const { router } = openWorkbench('/', [encounterFor()])
    const patient = await banner()
    expect(router.state.location.pathname).toBe('/encounters/encounter-1')
    expect(patient).toHaveTextContent('就诊中')
    expect(within(patient).getByTitle('本次就诊时长')).toHaveTextContent(/05:0\d/)
  })

  it('marks a low reading with a visible arrow, not only color', async () => {
    const encounter = encounterFor()
    encounter.triage = {
      ...encounter.triage,
      vitals: encounter.triage.vitals.map((v) => (v.kind === 'spo2' ? { ...v, value: '91', flag: 'low' as const } : v)),
    }
    openWorkbench('/encounters/encounter-1', [encounter])
    const vitals = within(within(await banner()).getByRole('list', { name: '分诊生命体征' })).getAllByRole('listitem')
    expect(vitals.at(-1)).toHaveTextContent('SpO₂血氧饱和度91%↓偏低')
  })

  it('shows the server refusal when another Encounter became active in the meantime', async () => {
    const user = userEvent.setup()
    const { api } = openWorkbench('/?case=golden-case-01')
    const registration = await screen.findByRole('region', { name: '挂号信息' })
    await api.startElsewhere('golden-case-01')

    await user.click(within(registration).getByRole('button', { name: '开始接诊' }))
    expect(await within(registration).findByRole('alert')).toHaveTextContent('已有进行中的就诊（李建国）')
    expect(screen.queryByRole('region', { name: '患者信息' })).not.toBeInTheDocument()
  })
})

describe('patient banner', () => {
  it('shows prior visits, allergies, chronic conditions and prior medications from the Visible Source History in 健康档案', async () => {
    const user = userEvent.setup()
    openWorkbench('/encounters/encounter-1', [encounterFor()])
    await user.click(within(await banner()).getByRole('button', { name: '健康档案' }))

    const categories = await screen.findByRole('tablist', { name: '健康档案分类' })
    expect(within(categories).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['既往就诊', '过敏史', '慢病', '既往用药'])

    const visits = within(screen.getByRole('tabpanel', { name: '既往就诊' })).getAllByRole('row')
    expect(visits.map((row) => row.textContent)).toEqual([
      '2024-03-12高血压复诊I10 原发性高血压 · 苯磺酸氨氯地平片 5 mg 每日一次 口服全科医学科',
      '2023-11-02咽痛流涕 2 天J06.9 急性上呼吸道感染全科医学科',
      '2015-06-02注射青霉素后呼吸困难、血压下降T88.6 药物过敏性休克急诊科',
    ])

    await user.click(within(categories).getByRole('tab', { name: '过敏史' }))
    expect(screen.getByRole('tabpanel', { name: '过敏史' })).toHaveTextContent('青霉素过敏性休克2015-06 · 急诊抢救记录')

    await user.click(within(categories).getByRole('tab', { name: '慢病' }))
    expect(screen.getByRole('tabpanel', { name: '慢病' })).toHaveTextContent('I10 原发性高血压2014 起规律服药，控制可')

    await user.click(within(categories).getByRole('tab', { name: '既往用药' }))
    expect(screen.getByRole('tabpanel', { name: '既往用药' })).toHaveTextContent('苯磺酸氨氯地平片5 mg 每日一次 口服')
    expect(screen.getByText(/来源：本院既往记录（Visible Source History）/)).toBeInTheDocument()
  })

  it('copies the outpatient number', async () => {
    const user = userEvent.setup()
    openWorkbench('/encounters/encounter-1', [encounterFor()])
    await user.click(within(await banner()).getByRole('button', { name: '复制门诊号' }))
    expect(await navigator.clipboard.readText()).toBe('20261124-0007')
    expect(screen.getByRole('status', { name: '复制状态' })).toHaveTextContent('已复制门诊号')
  })

  it('names every control uniquely while an Encounter is open', async () => {
    openWorkbench('/encounters/encounter-1', [encounterFor()])
    await banner()
    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy()
    }
    const labels = components.map((entry) => entry.label)
    expect(new Set(labels).size, `duplicate names in ${labels.join(', ')}`).toBe(labels.length)
    for (const label of ['7 号 李建国 · 在诊', '复制门诊号', '健康档案', '放弃就诊', '查体：生命体征', '查体：腹部']) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label)
    }
  })
})

describe('Encounter Abandonment', () => {
  it('needs the doctor’s Clinical Confirmation, which the agent bridge cannot give', async () => {
    const user = userEvent.setup()
    const { api } = openWorkbench('/encounters/encounter-1', [encounterFor()])
    await banner()

    const byAgent = await agent.act({ steps: [{ ref: '放弃就诊', action: 'press', args: ['确认放弃'] }] })
    expect(byAgent.ok).toBe(false)
    expect(requestsTo('POST', '/api/encounters/encounter-1/abandonment')).toHaveLength(0)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '放弃就诊' }))
    const dialog = await screen.findByRole('alertdialog', { name: '放弃李建国的本次就诊？' })
    expect(dialog).toHaveTextContent('不解锁病例真值与病例复盘')
    expect(within(dialog).getByRole('button', { name: '确认放弃' })).toHaveAttribute('data-agent-confirm')
    await user.click(within(dialog).getByRole('button', { name: '返回' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(requestsTo('POST', '/api/encounters/encounter-1/abandonment')).toHaveLength(0)
    expect(api.encounters()[0].status).toBe('active')

    await user.click(screen.getByRole('button', { name: '放弃就诊' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认放弃' }))

    await waitFor(() => expect(screen.getByRole('region', { name: '患者信息' })).toHaveTextContent('已放弃'))
    expect(requestsTo('POST', '/api/encounters/encounter-1/abandonment')).toHaveLength(1)
    expect(screen.getByText('本次就诊已放弃：写入冻结，病例真值未解锁。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '放弃就诊' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '7 号 李建国 · 待诊' })).toBeInTheDocument()
  })

  it('lets the agent bridge confirm only once the doctor approves that step', async () => {
    openWorkbench('/encounters/encounter-1', [encounterFor()])
    await banner()
    const abandon = { steps: [{ ref: '放弃就诊', action: 'press', args: ['确认放弃'] }] }

    const refused = await agent.act(abandon)
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toMatch(/person/i)
    approve = true
    const approved = await agent.act(abandon)
    expect(approved.ok, approved.error?.message).toBe(true)
    await waitFor(() => expect(requestsTo('POST', '/api/encounters/encounter-1/abandonment')).toHaveLength(1))
  })

  it('keeps an abandoned Encounter frozen on reload and lets the doctor start a fresh one for the same patient', async () => {
    const user = userEvent.setup()
    const abandoned = encounterFor({
      status: 'abandoned',
      startedAt: '2026-11-24T00:40:00.000Z',
      endedAt: '2026-11-24T00:52:34.000Z',
    })
    const { router } = openWorkbench('/encounters/encounter-1', [abandoned])
    const patient = await banner()
    expect(within(patient).getByTitle('本次就诊时长')).toHaveTextContent('12:34')
    expect(patient).toHaveTextContent('已放弃')
    expect(screen.getByRole('button', { name: '放弃就诊' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '开始新的就诊' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/encounters/started-1'))
    expect(await banner()).toHaveTextContent('就诊中')
    expect(screen.queryByText('本次就诊已放弃：写入冻结，病例真值未解锁。')).not.toBeInTheDocument()
  })
})
