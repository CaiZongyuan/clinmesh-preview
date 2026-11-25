import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_SECTIONS, type ClinicalNoteView } from '../../src/shared/clinical-note'
import type { DiagnosisView } from '../../src/shared/diagnosis'
import type { EncounterView } from '../../src/shared/encounter'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'

let approve = false
const agent = createAgent({ allow: (step) => !step.confirm || approve })
const fetchStub = vi.fn<typeof fetch>()
const ENCOUNTER = 'encounter-1'
const DIAGNOSIS = `/api/encounters/${ENCOUNTER}/diagnosis`

beforeEach(() => {
  approve = false
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Setup {
  encounter?: EncounterView
  diagnosis?: DiagnosisView
  note?: ClinicalNoteView
}

async function openWorkspace({ encounter = encounterFor(), diagnosis, note }: Setup = {}) {
  const api = createFakeClinicApi({
    encounters: [encounter],
    diagnoses: diagnosis ? { [ENCOUNTER]: diagnosis } : {},
    notes: note ? { [ENCOUNTER]: note } : {},
  })
  fetchStub.mockImplementation(api.handle)
  const user = userEvent.setup()
  const view = () =>
    render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${ENCOUNTER}`] }) })} />)
  const rendered = view()
  await screen.findByRole('heading', { name: '门诊病历' })
  const openTab = async () => {
    await user.click(screen.getByRole('tab', { name: '诊断' }))
    await screen.findByRole('heading', { name: '诊断' })
  }
  return { api, rendered, view, user, openTab }
}

const requestsTo = (method: string, path: string) =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)
const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body))

const searchBox = () => screen.getByRole('combobox', { name: '搜索 ICD-10 诊断' })

// Types a query into the combobox and chooses the option whose text matches, the way a doctor picks a hit.
async function addViaSearch(user: ReturnType<typeof userEvent.setup>, query: string, optionName: RegExp) {
  await user.click(searchBox())
  await user.type(searchBox(), query)
  await user.click(await screen.findByRole('option', { name: optionName }))
}

// A confirmed diagnosis:原发性高血压 as the primary, plus 2型糖尿病, at clinical revision sequence `seq`.
const confirmedDiagnosis = (seq = 1): DiagnosisView => ({
  draft: [],
  revisions: [
    {
      revisionId: 'dx-1',
      version: 1,
      seq,
      entries: [
        { code: 'I10', name: '原发性高血压', primary: true, source: 'doctor' },
        { code: 'E11.9', name: '2型糖尿病', primary: false, source: 'doctor' },
      ],
      practitionerId: 'demo-practitioner',
      confirmedAt: '2026-11-25T08:30:00.000Z',
    },
  ],
})

const signedNote = (seq = 1): ClinicalNoteView => ({
  draft: NOTE_SECTIONS.map((section) => ({ section, content: '', lastEditedBy: null, updatedAt: null })),
  revisions: [
    {
      revisionId: 'note-1',
      version: 1,
      seq,
      sections: {
        'chief-complaint': '头痛 1 周。',
        'present-illness': '一周前起病。',
        'past-history': '',
        findings: '',
        assessment: '',
        plan: '',
      },
      practitionerId: 'demo-practitioner',
      signedAt: '2026-11-25T08:10:00.000Z',
    },
  ],
})

describe('Diagnosis draft', () => {
  it('starts empty with the search box and common diagnoses', async () => {
    const { openTab } = await openWorkspace()
    await openTab()
    expect(searchBox()).toBeEnabled()
    expect(screen.getByText('暂无诊断草稿。搜索 ICD-10 编码、名称或拼音首字母添加。')).toBeInTheDocument()
    for (const name of ['急性上呼吸道感染', '原发性高血压', '发热']) {
      expect(screen.getByRole('button', { name: `添加常用诊断 ${name}` })).toBeInTheDocument()
    }
  })

  it('finds a diagnosis by pinyin initials and by code, and adds it as a draft row', async () => {
    const { api, openTab, user } = await openWorkspace()
    await openTab()

    // Pinyin initials: gxy finds 原发性高血压; the first entry of an empty draft becomes the primary.
    await addViaSearch(user, 'gxy', /原发性高血压/)
    expect(bodyOf(requestsTo('PUT', `${DIAGNOSIS}/draft`).at(-1)!)).toEqual({
      entries: [{ code: 'I10', primary: true, source: 'doctor' }],
    })
    await waitFor(() => expect(screen.getAllByText('原发性高血压').length).toBeGreaterThan(0))

    // ICD-10 code: J18 finds 社区获得性肺炎, added as a secondary row.
    await addViaSearch(user, 'J18', /社区获得性肺炎/)
    expect(bodyOf(requestsTo('PUT', `${DIAGNOSIS}/draft`).at(-1)!).entries).toEqual([
      { code: 'I10', primary: true, source: 'doctor' },
      { code: 'J18.9', primary: false, source: 'doctor' },
    ])
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toHaveLength(2))
  })

  it('adds a common diagnosis in one click and shows the source of each row', async () => {
    const { api, openTab, user } = await openWorkspace()
    await openTab()
    await user.click(screen.getByRole('button', { name: '添加常用诊断 急性上呼吸道感染' }))
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toEqual([{ code: 'J06.9', primary: true, source: 'doctor' }]))
    await screen.findAllByText('医生')
  })

  it('moves the primary mark with the radio and removes rows, keeping one primary behind', async () => {
    const { api, openTab, user } = await openWorkspace()
    await openTab()
    await user.click(screen.getByRole('button', { name: '添加常用诊断 原发性高血压' }))
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: '添加常用诊断 发热' }))
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toHaveLength(2))

    expect(screen.getByRole('radio', { name: '设为主诊断 原发性高血压' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: '设为主诊断 发热' }))
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toEqual([
      { code: 'I10', primary: false, source: 'doctor' },
      { code: 'R50.9', primary: true, source: 'doctor' },
    ]))

    await user.click(screen.getByRole('button', { name: '删除诊断草稿 发热' }))
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toEqual([{ code: 'I10', primary: true, source: 'doctor' }]))
    expect(screen.getByRole('radio', { name: '设为主诊断 原发性高血压' })).toBeChecked()
  })

  it('stops adding at eight entries', async () => {
    const { api, openTab, user } = await openWorkspace()
    await openTab()
    for (const name of ['急性上呼吸道感染', '社区获得性肺炎', '原发性高血压', '2型糖尿病', '发热']) {
      await user.click(screen.getByRole('button', { name: `添加常用诊断 ${name}` }))
    }
    for (const [query, name] of [
      ['jxzqgy', '急性支气管炎'],
      ['fylqj', '肺炎链球菌肺炎'],
      ['fjh', '肺结核'],
    ] as const) {
      await addViaSearch(user, query, new RegExp(name))
    }
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toHaveLength(8))
    // A disabled combobox leaves the accessibility tree, so the input itself is what to check.
    expect(screen.getByText(/已达 8 项上限/)).toBeInTheDocument()
    expect(document.querySelector<HTMLInputElement>('[data-slot="combobox-input"]')).toBeDisabled()
  })

  it('shows the confirmed diagnosis with its history and offers 修改已确认诊断 to reopen the draft', async () => {
    const { api, openTab, user } = await openWorkspace({ diagnosis: confirmedDiagnosis() })
    await openTab()
    expect(screen.getByText(/第 1 次确认/)).toBeInTheDocument()
    expect(screen.getByText('主诊断')).toBeInTheDocument()
    expect(screen.queryAllByRole('radio', { name: /设为主诊断/ })).toEqual([])

    await user.click(screen.getByRole('button', { name: '修改已确认诊断' }))
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toEqual([
      { code: 'I10', primary: true, source: 'doctor' },
      { code: 'E11.9', primary: false, source: 'doctor' },
    ]))
    expect(screen.getByRole('radio', { name: '设为主诊断 原发性高血压' })).toBeChecked()
  })
})

describe('confirming the Diagnosis', () => {
  it('needs Clinical Confirmation the agent bridge cannot give, then records revision 2 with exactly one primary', async () => {
    const { api, openTab, user } = await openWorkspace({ diagnosis: confirmedDiagnosis() })
    await openTab()
    await user.click(screen.getByRole('button', { name: '修改已确认诊断' }))
    await screen.findByRole('radio', { name: '设为主诊断 原发性高血压' })

    const byAgent = await agent.act({ steps: [{ ref: '确认诊断（主诊断：原发性高血压 等 2 项）', action: 'press', args: ['确认诊断'] }] })
    expect(byAgent.ok).toBe(false)
    expect(requestsTo('POST', `${DIAGNOSIS}/revisions`)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /确认诊断/ }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认诊断' })
    expect(dialog).toHaveTextContent('本次确认 2 项诊断，主诊断：原发性高血压')
    expect(within(dialog).getByRole('button', { name: '确认诊断' })).toHaveAttribute('data-agent-confirm', '确认诊断')
    await user.click(within(dialog).getByRole('button', { name: '确认诊断' }))

    await screen.findByText(/第 2 次确认 · \d\d:\d\d/)
    expect(bodyOf(requestsTo('POST', `${DIAGNOSIS}/revisions`).at(-1)!).entries).toEqual([
      { code: 'I10', primary: true, source: 'doctor' },
      { code: 'E11.9', primary: false, source: 'doctor' },
    ])
    await waitFor(() => expect(api.diagnosis(ENCOUNTER).draft).toEqual([]))
    expect(screen.getByText('历次确认：第 1 次 原发性高血压')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '修改已确认诊断' })).toBeEnabled()
  })

  it('shows the network failure inside the dialog when the confirmation cannot reach the workspace', async () => {
    const { openTab, user } = await openWorkspace({ diagnosis: confirmedDiagnosis() })
    await openTab()
    await user.click(screen.getByRole('button', { name: '修改已确认诊断' }))
    await screen.findByRole('radio', { name: '设为主诊断 原发性高血压' })
    await user.click(screen.getByRole('button', { name: /确认诊断/ }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认诊断' })
    fetchStub.mockImplementationOnce(() => Promise.reject(new TypeError('网络中断')))
    await user.click(within(dialog).getByRole('button', { name: '确认诊断' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('网络中断')
    expect(screen.queryByText(/第 2 次确认/)).not.toBeInTheDocument()
  })
})

describe('the Clinical Note against the Diagnosis', () => {
  it('marks the note 签署早于诊断修改 when a diagnosis revision is later than the latest signature', async () => {
    await openWorkspace({ diagnosis: confirmedDiagnosis(2), note: signedNote(1) })
    expect(await screen.findByText('签署早于诊断修改')).toBeInTheDocument()
    expect(screen.getByText(/第 1 版已签署/)).toBeInTheDocument()
  })

  it('does not mark the note when the signature is not older than the diagnosis', async () => {
    await openWorkspace({ diagnosis: confirmedDiagnosis(1), note: signedNote(1) })
    expect(screen.queryByText('签署早于诊断修改')).not.toBeInTheDocument()
  })

  it('offers no diagnosis edits once the Encounter is abandoned', async () => {
    const { openTab } = await openWorkspace({
      encounter: encounterFor({ status: 'abandoned', endedAt: new Date().toISOString() }),
      diagnosis: confirmedDiagnosis(),
    })
    await openTab()
    expect(screen.getByRole('button', { name: '修改已确认诊断' })).toBeDisabled()
    for (const button of screen.getAllByRole('button', { name: /添加常用诊断/ })) expect(button).toBeDisabled()
  })
})
