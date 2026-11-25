import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_SECTION_NAME, NOTE_SECTIONS, type ClinicalNoteView } from '../../src/shared/clinical-note'
import type { ConsultationTurn } from '../../src/shared/consultation'
import type { EncounterView } from '../../src/shared/encounter'
import type { PhysicalExaminationView } from '../../src/shared/physical-examination'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor, examinationFor, turnFor } from './fake-clinic-api'

let approve = false
const agent = createAgent({ allow: (step) => !step.confirm || approve })
const fetchStub = vi.fn<typeof fetch>()
const ENCOUNTER = 'encounter-1'
const NOTE = `/api/encounters/${ENCOUNTER}/clinical-note`

beforeEach(() => {
  approve = false
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Setup {
  encounter?: EncounterView
  turns?: ConsultationTurn[]
  examinations?: PhysicalExaminationView[]
  note?: ClinicalNoteView
}

async function openNote({ encounter = encounterFor(), turns = [], examinations = [], note }: Setup = {}) {
  const api = createFakeClinicApi({
    encounters: [encounter],
    consultations: { [ENCOUNTER]: turns },
    examinations: { [ENCOUNTER]: examinations },
    notes: note ? { [ENCOUNTER]: note } : {},
  })
  fetchStub.mockImplementation(api.handle)
  const view = () =>
    render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${ENCOUNTER}`] }) })} />)
  const rendered = view()
  await screen.findByRole('heading', { name: '门诊病历' })
  if (encounter.status === 'active') await waitFor(() => expect(field('主诉')).toBeEnabled())
  return { api, view, rendered, user: userEvent.setup() }
}

const field = (name: string) => screen.getByRole('textbox', { name })
// The character counter is the field's description.
const counterOf = (box: HTMLElement) => document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent
const saveStatus = () => screen.getByRole('status', { name: '病历草稿保存状态' })
const autosaved = () => waitFor(() => expect(saveStatus()).toHaveTextContent(/^已自动保存 \d\d:\d\d:\d\d$/), { timeout: 3000 })
const requestsTo = (method: string, path: string) =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)
const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body))

async function signNote(user: ReturnType<typeof userEvent.setup>, trigger: '签署病历' | '追加签署') {
  await user.click(screen.getByRole('button', { name: trigger }))
  const dialog = await screen.findByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: '确认签署' }))
  return dialog
}

describe('Clinical Note Draft', () => {
  it('shows six sections, marks chief complaint and HPI required, counts characters and offers common phrases', async () => {
    const { user } = await openNote()
    for (const section of NOTE_SECTIONS) {
      const box = field(NOTE_SECTION_NAME[section])
      expect(box).toHaveValue('')
      expect(counterOf(box)).toBe('0/1000')
      expect(screen.getByRole('button', { name: `常用语：${NOTE_SECTION_NAME[section]}` })).toBeInTheDocument()
    }
    expect(field('主诉')).toHaveAttribute('aria-required', 'true')
    expect(field('现病史')).toHaveAttribute('aria-required', 'true')
    expect(field('既往史与过敏史')).not.toHaveAttribute('aria-required')
    expect(field('主诉').closest('[data-slot="field"]')).toHaveTextContent('主诉*')

    await user.type(field('主诉'), '发热、咳嗽 3 天。')
    expect(counterOf(field('主诉'))).toBe('10/1000')

    await user.type(field('既往史与过敏史'), '自述青霉素过敏')
    await user.click(screen.getByRole('button', { name: '常用语：既往史与过敏史' }))
    await user.click(await screen.findByRole('menuitem', { name: '否认手术、外伤、输血史。' }))
    expect(field('既往史与过敏史')).toHaveValue('自述青霉素过敏；否认手术、外伤、输血史。')
  })

  it('undoes an inserted common phrase and keeps the doctor’s other edits', async () => {
    const { api, user } = await openNote()
    const history = field('既往史与过敏史')
    await user.type(history, '自述青霉素过敏')
    await user.click(screen.getByRole('button', { name: '常用语：既往史与过敏史' }))
    await user.click(await screen.findByRole('menuitem', { name: '否认手术、外伤、输血史。' }))
    expect(history).toHaveValue('自述青霉素过敏；否认手术、外伤、输血史。')
    const undo = await screen.findByRole('button', { name: '撤销常用语' })
    expect(screen.getByText('已向「既往史与过敏史」插入常用语')).toBeInTheDocument()
    await user.type(history, '另自述季节性鼻炎。')
    await user.click(undo)
    expect(history).toHaveValue('自述青霉素过敏另自述季节性鼻炎。')
    await autosaved()
    expect(api.note(ENCOUNTER).draft.find(({ section }) => section === 'past-history')?.content)
      .toBe('自述青霉素过敏另自述季节性鼻炎。')
  })

  it('autosaves after a pause with a visible 保存中 / 已自动保存 state, sending only changed sections, and survives a refresh', async () => {
    const { api, rendered, view, user } = await openNote()
    expect(saveStatus()).toHaveTextContent('')

    await user.type(field('主诉'), '发热 3 天')
    expect(saveStatus()).toHaveTextContent('保存中…')
    await autosaved()
    const saves = requestsTo('PATCH', `${NOTE}/draft`)
    expect(saves.length).toBeLessThan(3)
    expect(bodyOf(saves.at(-1)!)).toEqual({ sections: { 'chief-complaint': '发热 3 天' } })
    expect(api.note(ENCOUNTER).draft[0]).toMatchObject({ content: '发热 3 天', lastEditedBy: 'doctor' })

    await user.type(field('处理意见与随访'), '复诊')
    await autosaved()
    expect(bodyOf(requestsTo('PATCH', `${NOTE}/draft`).at(-1)!)).toEqual({ sections: { plan: '复诊' } })

    rendered.unmount()
    view()
    await waitFor(() => expect(screen.getByRole('textbox', { name: '主诉' })).toHaveValue('发热 3 天'))
    expect(field('处理意见与随访')).toHaveValue('复诊')
  })

  it('saves what is still waiting when the doctor leaves before the pause ends', async () => {
    const { api, rendered, user } = await openNote()
    await user.type(field('评估与诊断依据'), '待查')
    rendered.unmount()
    await waitFor(() => expect(api.note(ENCOUNTER).draft.find((d) => d.section === 'assessment')?.content).toBe('待查'))
  })

  it('shows a failed save and retries it on request', async () => {
    const { api, user } = await openNote()
    fetchStub.mockImplementation((input, init) =>
      init?.method === 'PATCH' ? Promise.reject(new TypeError('网络中断')) : api.handle(input, init),
    )
    await user.type(field('主诉'), '咳嗽')
    await waitFor(() => expect(saveStatus()).toHaveTextContent('保存失败：网络中断'), { timeout: 3000 })

    fetchStub.mockImplementation(api.handle)
    await user.click(within(saveStatus()).getByRole('button', { name: '重试保存' }))
    await autosaved()
    expect(api.note(ENCOUNTER).draft[0].content).toBe('咳嗽')
  })
})

describe('quoting the Consultation', () => {
  const turns = [
    turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？' }),
    turnFor({ seq: 2, speaker: 'patient', text: '发烧三天了，咳嗽得厉害。' }),
  ]

  it('quotes any turn into a chosen section, with a toast that undoes it', async () => {
    const { api, user } = await openNote({ turns, examinations: [examinationFor('lungs')] })
    await user.type(field('现病史'), '三天前起病')
    await autosaved()

    await user.click(await screen.findByRole('button', { name: '引用第 2 条到病历' }))
    await user.click(await screen.findByRole('menuitem', { name: '现病史' }))
    expect(field('现病史')).toHaveValue('三天前起病；患者述：“发烧三天了，咳嗽得厉害。”')
    const toast = await screen.findByRole('button', { name: '撤销引用' })
    expect(screen.getByText('已引用到「现病史」')).toBeInTheDocument()
    await autosaved()
    expect(api.note(ENCOUNTER).draft[1].content).toBe('三天前起病；患者述：“发烧三天了，咳嗽得厉害。”')

    await user.click(toast)
    expect(field('现病史')).toHaveValue('三天前起病')
    await autosaved()
    expect(api.note(ENCOUNTER).draft[1].content).toBe('三天前起病')

    await user.click(screen.getByRole('button', { name: '引用第 1 条到病历' }))
    await user.click(await screen.findByRole('menuitem', { name: '主诉' }))
    expect(field('主诉')).toHaveValue('医生问：“您哪里不舒服？”')

    await user.click(screen.getByRole('button', { name: '引用查体：肺部到病历' }))
    await user.click(await screen.findByRole('menuitem', { name: '体格检查与辅助检查' }))
    expect(field('体格检查与辅助检查')).toHaveValue(`查体·肺部：${examinationFor('lungs').finding}`)
  })

  it('undoes just the quoted words when the doctor has typed after quoting', async () => {
    const { user } = await openNote({ turns })
    await user.click(await screen.findByRole('button', { name: '引用第 2 条到病历' }))
    await user.click(await screen.findByRole('menuitem', { name: '现病史' }))
    await user.type(field('现病史'), '伴寒战')
    await user.click(await screen.findByRole('button', { name: '撤销引用' }))
    expect(field('现病史')).toHaveValue('伴寒战')
  })

  it('offers no quoting once the Encounter is abandoned', async () => {
    await openNote({ turns, encounter: encounterFor({ status: 'abandoned', endedAt: new Date().toISOString() }) })
    await screen.findByRole('button', { name: '复制第 2 条' })
    expect(screen.queryByRole('button', { name: '引用第 2 条到病历' })).not.toBeInTheDocument()
    for (const section of NOTE_SECTIONS) expect(field(NOTE_SECTION_NAME[section])).toBeDisabled()
    expect(screen.getByRole('button', { name: '签署病历' })).toBeDisabled()
  })
})

describe('signing the Clinical Note', () => {
  it('needs Clinical Confirmation the agent bridge cannot give, then records revision 1', async () => {
    const { api, user } = await openNote()
    await user.type(field('主诉'), '发热、咳嗽 3 天。')
    await user.type(field('现病史'), '三天前起病。')

    const byAgent = await agent.act({ steps: [{ ref: '签署病历', action: 'press', args: ['确认签署'] }] })
    expect(byAgent.ok).toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(requestsTo('POST', `${NOTE}/revisions`)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '签署病历' }))
    const dialog = await screen.findByRole('alertdialog', { name: '签署门诊病历？' })
    expect(dialog).toHaveTextContent('主诉：发热、咳嗽 3 天。')
    expect(dialog).toHaveTextContent('现病史：三天前起病。')
    expect(within(dialog).getByRole('button', { name: '确认签署' })).toHaveAttribute('data-agent-confirm', '签署李建国本次就诊的门诊病历第 1 版')
    await user.click(within(dialog).getByRole('button', { name: '确认签署' }))

    await screen.findByText(/^第 1 版已签署 · \d\d:\d\d$/)
    const [call] = requestsTo('POST', `${NOTE}/revisions`)
    expect(bodyOf(call)).toEqual({
      sections: { 'chief-complaint': '发热、咳嗽 3 天。', 'present-illness': '三天前起病。', 'past-history': '', findings: '', assessment: '', plan: '' },
    })
    expect(api.note(ENCOUNTER).draft[0].content).toBe('发热、咳嗽 3 天。')
    expect(screen.queryByText('有未签署修改')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '追加签署' })).toBeEnabled()
  })

  it('shows the server refusal when a required section is blank', async () => {
    const { user } = await openNote()
    await user.type(field('处理意见与随访'), '复诊')
    const dialog = await signNote(user, '签署病历')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('签署前请填写必填项：主诉、现病史。')
    expect(screen.queryByText(/版已签署/)).not.toBeInTheDocument()
  })

  it('flags edits after signing, appends revision 2 with 追加签署, and lists every revision with its content', async () => {
    const { user } = await openNote()
    await user.type(field('主诉'), '发热 3 天')
    await user.type(field('现病史'), '三天前起病')
    await signNote(user, '签署病历')
    await screen.findByText(/^第 1 版已签署/)

    await user.type(field('处理意见与随访'), '72 小时复诊')
    expect(screen.getByText('有未签署修改')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '追加签署' }))
    const dialog = await screen.findByRole('alertdialog', { name: '追加签署第 2 版病历？' })
    await user.click(within(dialog).getByRole('button', { name: '确认签署' }))
    await screen.findByText(/^第 2 版已签署/)
    expect(screen.queryByText('有未签署修改')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '签署历史 (2)' }))
    const versions = within(await screen.findByRole('list', { name: '签署版本' })).getAllByRole('article')
    expect(versions.map((v) => v.getAttribute('aria-label'))).toEqual(['第 2 版', '第 1 版'])
    expect(versions[0]).toHaveTextContent('处理意见与随访：72 小时复诊')
    expect(versions[1]).toHaveTextContent('处理意见与随访：—')
    expect(versions[1]).toHaveTextContent('主诉：发热 3 天')
    expect(versions[1]).toHaveTextContent('demo-practitioner')
  })

  it('loads signed revisions and flags a Draft that differs from the last one', async () => {
    const sections = { 'chief-complaint': '发热 3 天', 'present-illness': '三天前起病', 'past-history': '', findings: '', assessment: '', plan: '' }
    await openNote({
      note: {
        draft: NOTE_SECTIONS.map((section) => ({ section, content: section === 'plan' ? '复诊' : sections[section], lastEditedBy: 'doctor', updatedAt: '2026-11-24T01:00:00.000Z' })),
        revisions: [{ revisionId: 'r1', version: 1, seq: 1, sections, practitionerId: 'demo-practitioner', signedAt: '2026-11-24T00:59:00.000Z' }],
      },
    })
    expect(screen.getByText('第 1 版已签署 · 08:59')).toBeInTheDocument()
    expect(screen.getByText('有未签署修改')).toBeInTheDocument()
  })
})

describe('agent bridge', () => {
  it('names every control uniquely on the 病历记录 tab with a Consultation and examination to quote', async () => {
    await openNote({
      turns: [turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？' }), turnFor({ seq: 2, speaker: 'patient', text: '发烧三天了。' })],
      examinations: [examinationFor('lungs')],
    })
    await screen.findByRole('button', { name: '引用第 2 条到病历' })
    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
    for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy()
    const labels = components.map((entry) => entry.label)
    expect(new Set(labels).size, `duplicate names in ${labels.join(', ')}`).toBe(labels.length)
    for (const label of ['主诉', '现病史', '常用语：主诉', '签署病历', '引用第 1 条到病历', '引用查体：肺部到病历']) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label)
    }
  })

  it('lets the agent fill a Draft section, which autosaves like the doctor’s typing', async () => {
    const { api } = await openNote()
    const filled = await agent.act({ steps: [{ ref: '评估与诊断依据', action: 'setValue', args: ['考虑下呼吸道感染'] }] })
    expect(filled.ok, filled.error?.message).toBe(true)
    expect(field('评估与诊断依据')).toHaveValue('考虑下呼吸道感染')
    await autosaved()
    expect(api.note(ENCOUNTER).draft.find((d) => d.section === 'assessment')?.content).toBe('考虑下呼吸道感染')
  })
})
