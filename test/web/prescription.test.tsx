import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosisView } from '../../src/shared/diagnosis'
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

// A confirmed diagnosis, so the prescription gates pass on their own where the test isn't about them.
const confirmedDiagnosis = (): Record<string, DiagnosisView> => ({
  'encounter-1': {
    draft: [],
    revisions: [
      {
        revisionId: 'dx-1',
        version: 1,
        seq: 1,
        entries: [{ code: 'J06.9', name: '急性上呼吸道感染', primary: true, source: 'doctor' }],
        practitionerId: 'demo-practitioner',
        confirmedAt: '2026-11-25T08:30:00.000Z',
      },
    ],
  },
})

async function openPrescriptions(encounter: EncounterView = encounterFor(), diagnoses = confirmedDiagnosis()) {
  const user = userEvent.setup()
  const api = createFakeClinicApi({ encounters: [encounter], diagnoses })
  fetchStub.mockImplementation(api.handle)
  render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${encounter.encounterId}`] }) })} />)
  await user.click(await screen.findByRole('tab', { name: '处方' }))
  await screen.findByRole('heading', { name: '处方' })
  await screen.findByRole('combobox', { name: '搜索药品（本院药房）' })
  return { user, api }
}

const searchBox = () => screen.getByRole('combobox', { name: '搜索药品（本院药房）' })

// The popup closes between searches, so open it only when it is not already focused.
async function focusSearch(user: ReturnType<typeof userEvent.setup>) {
  if (document.activeElement !== searchBox()) await user.click(searchBox())
}

async function addViaSearch(user: ReturnType<typeof userEvent.setup>, query: string, optionName: RegExp) {
  await focusSearch(user)
  await user.type(searchBox(), query)
  const option = await waitFor(() => {
    const found = screen.queryAllByRole('option').find((o) => optionName.test(o.textContent ?? ''))
    expect(found, `${query} → ${optionName}`).toBeTruthy()
    return found!
  })
  await user.click(option)
}

// Confirms inside the Clinical Confirmation dialog. When the server refuses, the dialog stays open with
// the refusal in its error state; pass `refusal` to assert it and close with 返回.
async function confirmIn(
  user: ReturnType<typeof userEvent.setup>,
  dialogName: string,
  confirmLabel: string,
  refusal?: string,
) {
  const dialog = await screen.findByRole('alertdialog', { name: dialogName })
  const confirm = within(dialog).getByRole('button', { name: confirmLabel })
  expect(confirm).toHaveAttribute('data-agent-confirm')
  await user.click(confirm)
  if (refusal) {
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(refusal))
    await user.click(within(dialog).getByRole('button', { name: '返回' }))
  }
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
}

describe('formulary search', () => {
  it('matches by name, pinyin initials and class, tagging each hit 与过敏史冲突 or 交叉过敏风险 before it is added', async () => {
    const { user } = await openPrescriptions()

    await focusSearch(user)
    await user.type(searchBox(), 'amxl')
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('阿莫西林胶囊'),
      expect.stringContaining('阿莫西林克拉维酸钾片'),
    ])
    expect(options[0]).toHaveTextContent('与过敏史冲突')
    expect(options[1]).toHaveTextContent('与过敏史冲突')

    // Adding the conflicting drug is not blocked in the draft — the hard refusal comes from the server on issue.
    await user.click(options[0])
    expect(screen.getByRole('cell', { name: /阿莫西林胶囊/ })).toHaveTextContent('与过敏史冲突')

    const optionNamed = async (query: string, name: RegExp) => {
      await focusSearch(user)
      await user.clear(searchBox())
      await user.type(searchBox(), query)
      const option = await waitFor(() => {
        const found = screen.queryAllByRole('option').find((o) => name.test(o.textContent ?? ''))
        expect(found, `${query} → ${name}`).toBeTruthy()
        return found!
      })
      return option
    }
    expect(await optionNamed('tbfx', /头孢呋辛酯片/)).toHaveTextContent('交叉过敏风险')
    expect(await optionNamed('头孢', /头孢呋辛酯片/)).toHaveTextContent('交叉过敏风险')
  })
})

describe('draft lines', () => {
  it('edits dose, route, frequency and days with a live computed total quantity', async () => {
    const { user } = await openPrescriptions()
    await addViaSearch(user, 'amxl', /阿莫西林胶囊/)
    await addViaSearch(user, 'axs', /氨溴索/)
    await screen.findByText('42 粒') // 2 TID × 7 天
    await screen.findByText('2 瓶') // 10 mL TID × 5 天 → 150 mL → 2 瓶

    const dose = screen.getByRole('spinbutton', { name: '阿莫西林胶囊 单次剂量' })
    await user.clear(dose)
    await user.type(dose, '3')
    await screen.findByText('63 粒')
    await user.selectOptions(screen.getByRole('combobox', { name: '阿莫西林胶囊 频次' }), 'QD')
    await screen.findByText('21 粒')
    const days = screen.getByRole('spinbutton', { name: '阿莫西林胶囊 天数' })
    await user.clear(days)
    await user.type(days, '3')
    await screen.findByText('9 粒')
    await user.selectOptions(screen.getByRole('combobox', { name: '盐酸氨溴索口服溶液 用法' }), '含服')
    expect(screen.getByRole('combobox', { name: '盐酸氨溴索口服溶液 用法' })).toHaveValue('含服')

    await user.click(screen.getByRole('button', { name: '删除处方草稿 阿莫西林胶囊' }))
    await waitFor(() => expect(screen.queryByText('9 粒')).not.toBeInTheDocument())
  })

  it('shows the package-insert summary of a formulary drug', async () => {
    const { user } = await openPrescriptions()
    await addViaSearch(user, 'amxl', /阿莫西林胶囊/)
    await user.click(screen.getByRole('button', { name: '说明书' }))
    const summary = await screen.findByText('青霉素类药物过敏史或青霉素皮肤试验阳性患者禁用。')
    expect(summary).toBeInTheDocument()
    expect(screen.getByText('适应证')).toBeInTheDocument()
    expect(screen.getByText('禁忌')).toBeInTheDocument()
    expect(screen.getByText('来源：药品说明书摘要（合成）')).toBeInTheDocument()
  })
})

describe('issuing prescriptions', () => {
  it('shows the server red line, unchangeable, and leaves the record and the draft untouched', async () => {
    const { user, api } = await openPrescriptions()
    await addViaSearch(user, 'amxl', /阿莫西林胶囊/)
    await user.click(screen.getByRole('button', { name: /正式开具处方/ }))
    await confirmIn(user, '正式开具处方', '正式开具', '药事安全红线拦截（不可越权）')
    expect(screen.getByText('MEDICATION_ALLERGY_CONFLICT')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: /阿莫西林胶囊/ })).toBeInTheDocument() // the draft survives
    expect(api.prescriptions('encounter-1').lines).toEqual([])
  })

  it('keeps the Clinical Copilot bridge from pressing the confirming button', async () => {
    const { user, api } = await openPrescriptions()
    await addViaSearch(user, 'dxhs', /多西环素/)
    await user.click(screen.getByRole('button', { name: /正式开具处方/ }))
    await screen.findByRole('alertdialog', { name: '正式开具处方' })
    approve = false
    const denied = await agent.act({ steps: [{ ref: '正式开具', action: 'press', args: [] }] })
    expect(denied).toMatchObject({ ok: false })
    await user.click(within(screen.getByRole('alertdialog', { name: '正式开具处方' })).getByRole('button', { name: '返回' }))
    expect(api.prescriptions('encounter-1').lines).toEqual([])
  })

  it('issues a cephalosporin only with a fixed reason and a note of at least four characters, recorded with the line', async () => {
    const { user, api } = await openPrescriptions()
    await addViaSearch(user, 'tbfx', /头孢呋辛酯片/)

    const warning = screen.getByText('临床质控警示（需登记原因）')
    expect(warning.parentElement).toHaveTextContent('与青霉素存在交叉过敏风险')
    expect(screen.getByRole('button', { name: /正式开具处方/ })).toBeDisabled()

    await user.selectOptions(screen.getByRole('combobox', { name: '登记原因' }), '患者知情同意')
    const note = screen.getByRole('textbox', { name: '补充说明' })
    await user.type(note, '已知') // 2 characters: still refused
    expect(screen.getByRole('button', { name: /正式开具处方/ })).toBeDisabled()
    await user.type(note, '风险，已告知')
    await user.click(screen.getByRole('button', { name: /正式开具处方/ }))
    await confirmIn(user, '正式开具处方', '正式开具')
    await waitFor(() => expect(api.prescriptions('encounter-1').lines).toHaveLength(1))
    const [line] = api.prescriptions('encounter-1').lines
    expect(line).toMatchObject({
      drugId: 'cefuroxime',
      overrideReason: '患者知情同意',
      totalQuantity: '14 片',
    })
    expect(line.overrideNote).toBe('已知风险，已告知')
    expect(screen.getByText('已登记：患者知情同意')).toBeInTheDocument()
  })
})

describe('No Medication', () => {
  it('records the conclusion only with Clinical Confirmation and blocks prescriptions afterwards', async () => {
    const { user, api } = await openPrescriptions()
    await user.click(screen.getByRole('button', { name: '无需用药' }))
    await user.click(screen.getByRole('button', { name: '确认无需用药' }))
    await confirmIn(user, '确认无需用药', '确认无需用药')
    await waitFor(() => expect(api.prescriptions('encounter-1').noMedication).not.toBeNull())
    expect(api.prescriptions('encounter-1').noMedication).not.toBeNull()

    // The recorded conclusion stands in 处方 mode too: no new draft can be started against it
    // (the server's both-ways refusal is pinned at the Worker seam).
    await user.click(screen.getByRole('button', { name: '使用处方' }))
    expect(screen.queryByRole('combobox', { name: '搜索药品（本院药房）' })).not.toBeInTheDocument()
    expect(api.prescriptions('encounter-1').lines).toEqual([])
  })

  it('refuses No Medication before a Diagnosis is confirmed', async () => {
    const { user, api } = await openPrescriptions(encounterFor(), {})
    await user.click(screen.getByRole('button', { name: '无需用药' }))
    await user.click(screen.getByRole('button', { name: '确认无需用药' }))
    await confirmIn(user, '确认无需用药', '确认无需用药', '须先确认诊断')
    expect(api.prescriptions('encounter-1').noMedication).toBeNull()
  })
})
