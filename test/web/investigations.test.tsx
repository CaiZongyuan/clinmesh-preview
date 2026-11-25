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

type User = ReturnType<typeof userEvent.setup>

async function openInvestigations(encounter: EncounterView = encounterFor()) {
  const user = userEvent.setup()
  const api = createFakeClinicApi({ encounters: [encounter] })
  fetchStub.mockImplementation(api.handle)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${encounter.encounterId}`] }) })
  render(<RouterProvider router={router} />)
  await user.click(await screen.findByRole('tab', { name: /^检验检查/ }))
  await screen.findByRole('list', { name: '检查目录' })
  await waitFor(() => expect(catalogNames().length).toBeGreaterThan(10))
  return { user, api }
}

const requestsTo = (method: string, path: string) =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)
const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body))

const catalogNames = () =>
  within(screen.getByRole('list', { name: '检查目录' }))
    .queryAllByRole('listitem')
    .map((item) => item.firstElementChild?.firstElementChild?.firstChild?.textContent)
const investigationsTab = () => screen.getByRole('tab', { name: /^检验检查/ })
const card = (name: string) => screen.getByRole('article', { name })

async function confirmIn(user: User, dialogName: string, confirmLabel: string) {
  const dialog = await screen.findByRole('alertdialog', { name: dialogName })
  const confirm = within(dialog).getByRole('button', { name: confirmLabel })
  expect(confirm).toHaveAttribute('data-agent-confirm')
  await user.click(confirm)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  return dialog
}

async function issue(user: User, names: string[]) {
  for (const name of names) await user.click(screen.getByRole('button', { name: `加入待开立：${name}` }))
  await user.click(screen.getByRole('button', { name: `开立 ${names.length} 项` }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认开立' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  await screen.findByRole('article', { name: names[0] })
}

describe('investigation catalog', () => {
  it('searches by name or pinyin initials, filters by 检验 / 放射 / 功能, and shows specimen or site, department and turnaround', async () => {
    const { user } = await openInvestigations()
    const search = screen.getByRole('searchbox', { name: '搜索检查项目' })

    await user.type(search, 'xcg')
    expect(catalogNames()).toEqual(['血常规（五分类）'])
    expect(within(screen.getByRole('list', { name: '检查目录' })).getByRole('listitem')).toHaveTextContent(
      '静脉血 · EDTA 紫帽 · 检验科 · 预计 30 分钟',
    )

    await user.clear(search)
    await user.type(search, '胸部')
    expect(catalogNames()).toEqual(['胸部正侧位 X 线', '胸部 CT 平扫'])
    expect(screen.getByRole('list', { name: '检查目录' })).toHaveTextContent('胸部 · 正侧位 · 放射科 · 预计 1 小时')

    await user.clear(search)
    const categories = screen.getByRole('radiogroup', { name: '检查类别' })
    await user.click(within(categories).getByRole('radio', { name: '功能' }))
    expect(catalogNames()).toEqual(['12 导联心电图', '经胸超声心动图'])
    await user.click(within(categories).getByRole('radio', { name: '放射' }))
    expect(catalogNames()).toEqual(['胸部正侧位 X 线', '胸部 CT 平扫'])
    await user.type(search, 'xbct')
    expect(catalogNames()).toEqual(['胸部 CT 平扫'])
    await user.type(search, 'zz')
    expect(screen.getByRole('list', { name: '检查目录' })).toHaveTextContent('无匹配项目')
  })
})

describe('issuing Investigations', () => {
  it('collects a removable pending list and issues it together only with the doctor’s Clinical Confirmation', async () => {
    const { user, api } = await openInvestigations()
    for (const name of ['血常规（五分类）', 'C 反应蛋白', '胸部正侧位 X 线', '降钙素原']) {
      await user.click(screen.getByRole('button', { name: `加入待开立：${name}` }))
    }
    await user.click(screen.getByRole('button', { name: '移除：降钙素原' }))
    const pendingList = screen.getByRole('list', { name: '待开立检查' })
    expect(within(pendingList).getAllByRole('listitem').map((item) => item.firstChild?.firstChild?.textContent)).toEqual([
      '血常规（五分类）',
      'C 反应蛋白',
      '胸部正侧位 X 线',
    ])
    expect(investigationsTab()).toHaveTextContent('检验检查待处理 3')
    expect(screen.getByRole('button', { name: '加入待开立：降钙素原' })).toBeInTheDocument()

    const byAgent = await agent.act({ steps: [{ ref: '开立 3 项', action: 'press', args: ['确认开立'] }] })
    expect(byAgent.ok).toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(requestsTo('POST', '/api/encounters/encounter-1/investigations')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '开立 3 项' }))
    const dialog = await screen.findByRole('alertdialog', { name: '开立 3 项检查？' })
    expect(dialog).toHaveTextContent('血常规（五分类） · 静脉血 · EDTA 紫帽 · 检验科')
    const confirm = within(dialog).getByRole('button', { name: '确认开立' })
    expect(confirm).toHaveAttribute('data-agent-confirm')
    await user.click(confirm)

    await screen.findByRole('article', { name: '胸部正侧位 X 线' })
    const calls = requestsTo('POST', '/api/encounters/encounter-1/investigations')
    expect(calls.map(bodyOf)).toEqual([{ catalogItemIds: ['cbc', 'crp', 'cxr'] }])
    expect(api.investigations('encounter-1')).toHaveLength(3)
    expect(screen.queryByRole('list', { name: '待开立检查' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开立' })).toBeDisabled()
    expect(investigationsTab()).toHaveTextContent(/^检验检查$/)

    const steps = within(card('胸部正侧位 X 线')).getByRole('list', { name: '胸部正侧位 X 线执行进度' })
    expect(within(steps).getAllByRole('listitem').map((step) => step.textContent)).toEqual([
      expect.stringMatching(/^已开立\d\d:\d\d$/),
      '已登记—',
      '检查中—',
      '待审核—',
      '已出报告—',
    ])
    expect(card('血常规（五分类）')).toHaveTextContent(/已开立 · 预计 \d\d:\d\d 出报告/)
    expect(within(screen.getByRole('list', { name: '检查目录' })).getAllByText('已开立')).toHaveLength(3)
  })
})

describe('Reports', () => {
  it('releases through the instant-release control and shows a lab Report table with flags and an only-abnormal filter', async () => {
    const { user } = await openInvestigations()
    await issue(user, ['血常规（五分类）', '胸部正侧位 X 线'])

    await user.click(within(card('血常规（五分类）')).getByRole('button', { name: '立即出报告：血常规（五分类）' }))
    const cbc = card('血常规（五分类）')
    await within(cbc).findByText('第 1 版（当前）')
    expect(cbc).toHaveTextContent('待阅')
    expect(within(within(cbc).getByRole('list', { name: '血常规（五分类）执行进度' })).getAllByRole('listitem').map((s) => s.textContent)).toEqual(
      ['已开立', '已采样', '检验中', '已出报告'].map((stage) => expect.stringMatching(new RegExp(`^${stage}\\d\\d:\\d\\d$`))),
    )
    expect(investigationsTab()).toHaveTextContent('检验检查待处理 1')

    await user.click(within(cbc).getByRole('button', { name: '查看报告：血常规（五分类）' }))
    const report = within(cbc).getByRole('region', { name: '血常规（五分类）报告' })
    for (const text of ['第 1 版', '标本：静脉血 · EDTA 紫帽', '报告：王丽（检验师）', '审核：陈刚（主管检验师）', '报告时间']) {
      expect(report).toHaveTextContent(text)
    }
    const table = within(report).getByRole('table', { name: '血常规（五分类）结果' })
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['项目', '结果', '单位', '参考范围', '提示'])
    const rows = () => within(table).getAllByRole('row').slice(1).map((row) => row.textContent)
    expect(rows()).toEqual([
      '白细胞计数 WBC14.2 ↑×10⁹/L3.5–9.5偏高',
      '中性粒细胞百分比 NEUT%86.1 ↑%40–75偏高',
      '淋巴细胞百分比 LYM%9.2 ↓%20–50偏低',
      '红细胞计数 RBC4.82×10¹²/L4.3–5.8正常',
      '血红蛋白 HGB142g/L130–175正常',
      '血小板计数 PLT236×10⁹/L125–350正常',
    ])

    await user.click(screen.getByRole('checkbox', { name: '仅看异常' }))
    expect(rows()).toEqual([
      '白细胞计数 WBC14.2 ↑×10⁹/L3.5–9.5偏高',
      '中性粒细胞百分比 NEUT%86.1 ↑%40–75偏高',
      '淋巴细胞百分比 LYM%9.2 ↓%20–50偏低',
    ])

    await user.click(within(card('胸部正侧位 X 线')).getByRole('button', { name: '立即出报告：胸部正侧位 X 线' }))
    const cxr = card('胸部正侧位 X 线')
    await user.click(await within(cxr).findByRole('button', { name: '查看报告：胸部正侧位 X 线' }))
    const imaging = within(cxr).getByRole('region', { name: '胸部正侧位 X 线报告' })
    expect(imaging).toHaveTextContent('部位：胸部 · 正侧位')
    expect(imaging).toHaveTextContent('报告：刘洋（放射科医师）')
    expect(imaging).toHaveTextContent('检查所见右肺下叶见斑片状实变影，边界模糊。检查结论右下肺炎。')

    expect(requestsTo('POST', '/api/encounters/encounter-1/report-acknowledgements')).toHaveLength(0)
    expect(cbc).toHaveTextContent('待阅')
    expect(investigationsTab()).toHaveTextContent('检验检查待处理 2')
  })

  it('acknowledges a Report only with the doctor’s Clinical Confirmation, recording time and doctor', async () => {
    const { user } = await openInvestigations()
    await issue(user, ['C 反应蛋白'])
    await user.click(screen.getByRole('button', { name: '立即出报告：C 反应蛋白' }))
    const crp = card('C 反应蛋白')
    await within(crp).findByText('待阅')

    const byAgent = await agent.act({ steps: [{ ref: '确认已阅：C 反应蛋白', action: 'press', args: ['确认已阅'] }] })
    expect(byAgent.ok).toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(requestsTo('POST', '/api/encounters/encounter-1/report-acknowledgements')).toHaveLength(0)

    await user.click(within(crp).getByRole('button', { name: '确认已阅：C 反应蛋白' }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认已阅：C 反应蛋白' })
    expect(dialog).toHaveTextContent('第 1 版（当前）')
    expect(dialog).toHaveTextContent('仅打开查看不构成已阅确认')
    await user.click(within(dialog).getByRole('button', { name: '确认已阅' }))

    await within(crp).findByText('医生已阅')
    const [call] = requestsTo('POST', '/api/encounters/encounter-1/report-acknowledgements')
    expect(bodyOf(call)).toEqual({ reportIds: ['report-investigation-1'] })
    expect(within(crp).queryByRole('button', { name: '确认已阅：C 反应蛋白' })).not.toBeInTheDocument()
    await user.click(within(crp).getByRole('button', { name: '查看报告：C 反应蛋白' }))
    expect(within(crp).getByRole('region', { name: 'C 反应蛋白报告' })).toHaveTextContent(/已阅 \d\d:\d\d · demo-practitioner/)
    expect(investigationsTab()).toHaveTextContent(/^检验检查$/)
  })
})

describe('Report amendments', () => {
  it('shows an amendment as the current version, reopened for acknowledgement with its reason, above the superseded versions', async () => {
    const { user, api } = await openInvestigations()
    await issue(user, ['血常规（五分类）'])
    await user.click(screen.getByRole('button', { name: '立即出报告：血常规（五分类）' }))
    await user.click(await screen.findByRole('button', { name: '确认已阅：血常规（五分类）' }))
    await confirmIn(user, '确认已阅：血常规（五分类）', '确认已阅')
    await within(card('血常规（五分类）')).findByText('医生已阅')

    api.amendReport('encounter-1', 'investigation-1', '仪器复核后更正', {
      kind: 'results',
      results: [{ analyteId: 'cbc-wbc', name: '白细胞计数 WBC', value: 15, decimals: 1, unit: '×10⁹/L', referenceRange: '3.5–9.5', flag: 'high' }],
    })
    // The amendment arrives with the next poll; the browser cannot know in advance that one is scripted.
    const cbc = card('血常规（五分类）')
    await within(cbc).findByText('第 2 版（当前）', {}, { timeout: 4000 })
    expect(cbc).toHaveTextContent('待阅')
    expect(cbc).not.toHaveTextContent('医生已阅')
    expect(cbc).toHaveTextContent('更正原因：仪器复核后更正。旧版本的已阅不延续到本版本。')
    expect(investigationsTab()).toHaveTextContent('检验检查待处理 1')

    await user.click(within(cbc).getByRole('button', { name: '查看报告：血常规（五分类）' }))
    const report = within(cbc).getByRole('region', { name: '血常规（五分类）报告' })
    expect(report).toHaveTextContent('第 2 版')
    expect(within(report).getAllByRole('row')[1]).toHaveTextContent('白细胞计数 WBC15.0 ↑')
    const history = within(cbc).getByRole('list', { name: '血常规（五分类）历史版本' })
    expect(within(history).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^第 1 版（已替代） · 报告时间 \d\d:\d\d · 已阅 \d\d:\d\d · demo-practitioner$/),
    ])

    await user.click(within(cbc).getByRole('button', { name: '确认已阅：血常规（五分类）' }))
    const dialog = await confirmIn(user, '确认已阅：血常规（五分类）', '确认已阅')
    expect(dialog).toHaveTextContent('第 2 版（当前）')
    await within(cbc).findByText('医生已阅')
    expect(bodyOf(requestsTo('POST', '/api/encounters/encounter-1/report-acknowledgements').at(-1)!)).toEqual({
      reportIds: ['report-investigation-1-v2'],
    })
  })
})

describe('cancelling an Investigation', () => {
  it('cancels only before its first Report and only with the doctor’s Clinical Confirmation, then allows issuing it again', async () => {
    const { user } = await openInvestigations()
    await issue(user, ['C 反应蛋白', '血常规（五分类）'])
    await user.click(screen.getByRole('button', { name: '立即出报告：血常规（五分类）' }))
    await within(card('血常规（五分类）')).findByText('第 1 版（当前）')
    expect(within(card('血常规（五分类）')).queryByRole('button', { name: /^取消检查/ })).not.toBeInTheDocument()

    const byAgent = await agent.act({ steps: [{ ref: '取消检查：C 反应蛋白', action: 'press', args: ['确认取消'] }] })
    expect(byAgent.ok).toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(requestsTo('POST', '/api/encounters/encounter-1/investigations/investigation-1/cancellation')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '取消检查：C 反应蛋白' }))
    const dialog = await confirmIn(user, '取消检查：C 反应蛋白？', '确认取消')
    expect(dialog).toHaveTextContent('仅首份报告发布前可取消')
    const cancelled = await screen.findByRole('article', { name: 'C 反应蛋白（已取消）' })
    expect(requestsTo('POST', '/api/encounters/encounter-1/investigations/investigation-1/cancellation')).toHaveLength(1)
    expect(within(cancelled).queryByRole('button')).not.toBeInTheDocument()
    expect(within(within(cancelled).getByRole('list', { name: 'C 反应蛋白（已取消）执行进度' })).getAllByRole('listitem').map((s) => s.textContent)).toEqual([
      expect.stringMatching(/^已开立\d\d:\d\d$/),
      expect.stringMatching(/^已取消\d\d:\d\d$/),
    ])

    await user.click(screen.getByRole('button', { name: '加入待开立：C 反应蛋白' }))
    await user.click(screen.getByRole('button', { name: '开立 1 项' }))
    await confirmIn(user, '开立 1 项检查？', '确认开立')
    expect(await screen.findByRole('article', { name: 'C 反应蛋白' })).toHaveTextContent('预计')
    expect(screen.getByRole('article', { name: 'C 反应蛋白（已取消）' })).toBeInTheDocument()
  })
})

describe('batch Report Acknowledgement', () => {
  it('acknowledges the selected Reports together with one Clinical Confirmation', async () => {
    const { user } = await openInvestigations()
    const names = ['血常规（五分类）', 'C 反应蛋白', '胸部正侧位 X 线']
    await issue(user, names)
    for (const name of names) {
      await user.click(screen.getByRole('button', { name: `立即出报告：${name}` }))
      await screen.findByRole('button', { name: `确认已阅：${name}` })
    }
    expect(screen.getByRole('button', { name: '确认所选已阅' })).toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: '选择待阅：血常规（五分类）' }))
    await user.click(screen.getByRole('checkbox', { name: '选择待阅：胸部正侧位 X 线' }))
    const byAgent = await agent.act({ steps: [{ ref: '确认所选已阅（2）', action: 'press', args: ['确认 2 份已阅'] }] })
    expect(byAgent.ok).toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '确认所选已阅（2）' }))
    const dialog = await confirmIn(user, '确认 2 份报告已阅？', '确认 2 份已阅')
    expect(dialog).toHaveTextContent('血常规（五分类） · 第 1 版（当前）')
    expect(dialog).toHaveTextContent('胸部正侧位 X 线 · 第 1 版（当前）')

    await within(card('胸部正侧位 X 线')).findByText('医生已阅')
    expect(card('血常规（五分类）')).toHaveTextContent('医生已阅')
    expect(card('C 反应蛋白')).toHaveTextContent('待阅')
    expect(requestsTo('POST', '/api/encounters/encounter-1/report-acknowledgements').map(bodyOf)).toEqual([
      { reportIds: ['report-investigation-1', 'report-investigation-3'] },
    ])
    expect(investigationsTab()).toHaveTextContent('检验检查待处理 1')
    expect(screen.queryByRole('button', { name: /^确认所选已阅/ })).not.toBeInTheDocument()
  })
})

describe('检验检查 tab', () => {
  it('names every control uniquely with pending, issued and released items', async () => {
    const { user } = await openInvestigations()
    await issue(user, ['血常规（五分类）', 'C 反应蛋白'])
    await user.click(screen.getByRole('button', { name: '立即出报告：血常规（五分类）' }))
    await screen.findByRole('button', { name: '确认已阅：血常规（五分类）' })
    await issue(user, ['胸部正侧位 X 线', '12 导联心电图'])
    await user.click(screen.getByRole('button', { name: '立即出报告：胸部正侧位 X 线' }))
    await screen.findByRole('button', { name: '确认已阅：胸部正侧位 X 线' })
    await user.click(screen.getByRole('button', { name: '取消检查：12 导联心电图' }))
    await confirmIn(user, '取消检查：12 导联心电图？', '确认取消')
    await user.click(screen.getByRole('checkbox', { name: '选择待阅：胸部正侧位 X 线' }))
    await user.click(screen.getByRole('button', { name: '加入待开立：降钙素原' }))

    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy()
    }
    const labels = components.map((entry) => entry.label)
    expect(new Set(labels).size, `duplicate names in ${labels.join(', ')}`).toBe(labels.length)
    for (const label of [
      '搜索检查项目',
      '检查类别',
      '开立 1 项',
      '移除：降钙素原',
      '立即出报告：C 反应蛋白',
      '取消检查：C 反应蛋白',
      '确认已阅：血常规（五分类）',
      '选择待阅：血常规（五分类）',
      '确认所选已阅（1）',
      '仅看异常',
    ]) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label)
    }
  })

  it('keeps every ordering control disabled once the Encounter is abandoned', async () => {
    await openInvestigations(encounterFor({ status: 'abandoned', endedAt: new Date().toISOString() }))
    expect(screen.getByRole('button', { name: '加入待开立：血常规（五分类）' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '开立' })).toBeDisabled()
  })
})
