import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'

const id = 'encounter-1'

afterEach(() => vi.unstubAllGlobals())

async function openEncounter(api = createFakeClinicApi({ encounters: [encounterFor()] })) {
  const fetch = vi.fn<typeof globalThis.fetch>(api.handle)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('WebSocket', api.WebSocket)
  const mounted = render(<RouterProvider router={createAppRouter({
    history: createMemoryHistory({ initialEntries: [`/encounters/${id}`] }),
  })} />)
  const bridge = await waitFor(() => {
    expect(api.copilot.bridge(id)).toBeDefined()
    return api.copilot.bridge(id)!
  })
  return { api, bridge, fetch, unmount: mounted.unmount, user: userEvent.setup() }
}

type SnapshotEntry = { ref: string; label: string; focused?: boolean; doctorEdited?: boolean }
type Bridge = Awaited<ReturnType<typeof openEncounter>>['bridge']

async function readSnapshot(bridge: Bridge): Promise<SnapshotEntry[]> {
  const message = await bridge.call('ui_snapshot', {})
  expect(message.ok).toBe(true)
  return JSON.parse(message.result) as SnapshotEntry[]
}

async function writeSection(bridge: Bridge, label: string, text: string) {
  const ref = (await readSnapshot(bridge)).find((entry) => entry.label === label)?.ref
  expect(ref).toBeDefined()
  return act(async () => bridge.call('ui_act', { steps: [{ ref, action: 'setValue', args: [text] }] }))
}

it('fills and saves an untouched Clinical Note section through createAgent, then clears the halo on doctor edit', async () => {
  const { api, bridge, user } = await openEncounter()
  const field = screen.getByRole('textbox', { name: '主诉' })
  expect(await writeSection(bridge, '主诉', '发热三天。')).toMatchObject({ ok: true })
  expect(field).toHaveValue('发热三天。')
  expect(field.closest('[data-agent-draft]')).not.toBeNull()
  expect(screen.getByText('助手', { exact: true })).toBeInTheDocument()
  await waitFor(() => expect(api.note(id).draft[0]).toMatchObject({ content: '发热三天。', lastEditedBy: 'assistant' }))
  await user.type(field, '咳嗽。')
  expect(field.closest('[data-agent-draft]')).toBeNull()
  expect(await readSnapshot(bridge)).toContainEqual(expect.objectContaining({
    label: '主诉', focused: true, doctorEdited: true,
  }))
})

it('creates a Suggestion for a focused or doctor-edited field and offers accept, dismiss and undo', async () => {
  const { bridge, user } = await openEncounter()
  const field = screen.getByRole('textbox', { name: '主诉' })
  await user.click(field)
  expect(await readSnapshot(bridge)).toContainEqual(expect.objectContaining({ label: '主诉', focused: true, doctorEdited: false }))
  expect(await writeSection(bridge, '主诉', '发热伴咳嗽。')).toMatchObject({ ok: true, outcome: 'suggestion' })
  expect(field).toHaveValue('')
  expect(screen.getByRole('button', { name: /临床助手.*1 项待确认/ })).toBeInTheDocument()
  const coming = screen.getByRole('region', { name: '字段建议：主诉' })
  await user.click(within(coming).getByRole('button', { name: '不采用' }))
  expect(coming).not.toBeInTheDocument()

  await user.type(field, '医生原文')
  await user.tab()
  expect(await readSnapshot(bridge)).toContainEqual(expect.objectContaining({ label: '主诉', focused: false, doctorEdited: true }))
  expect(await writeSection(bridge, '主诉', '建议文本。')).toMatchObject({ ok: true, outcome: 'suggestion' })
  expect(field).toHaveValue('医生原文')
  const card = screen.getByRole('region', { name: '会话建议：主诉' })
  expect(card).toHaveTextContent('建议文本。')
  await user.click(within(card).getByRole('button', { name: '采纳' }))
  await waitFor(() => expect(field).toHaveValue('建议文本。'))
  await user.click(screen.getByRole('button', { name: '撤销采纳' }))
  await waitFor(() => expect(field).toHaveValue('医生原文'))
  expect(screen.getByRole('region', { name: '会话建议：主诉' })).toBeInTheDocument()
})

it('blocks bridge access to the formal signing control and accepts doctor confirmation', async () => {
  const { bridge, api, user } = await openEncounter()
  await user.type(screen.getByRole('textbox', { name: '主诉' }), '发热。')
  await user.type(screen.getByRole('textbox', { name: '现病史' }), '三天前起病。')
  await user.click(screen.getByRole('button', { name: '签署病历' }))
  const dialog = await screen.findByRole('alertdialog')
  const confirm = within(dialog).getByRole('button', { name: '确认签署' })
  expect(confirm).toHaveAttribute('data-agent-confirm')
  const result = await act(async () => bridge.call('ui_act', { steps: [{ ref: '确认签署', action: 'press', args: [] }] }))
  expect(result).toMatchObject({ ok: false, outcome: 'denied', result: expect.stringContaining('被拦截') })
  expect(api.note(id).revisions).toEqual([])
  await user.click(confirm)
  await waitFor(() => expect(api.note(id).revisions).toHaveLength(1))
})

it('shows countdown and top-bar status and sends 立即 and 跳过 to the current trigger', async () => {
  const { fetch, api, user } = await openEncounter()
  const countdown = { ref: 'consultation:x', text: '问诊定稿：何时起病？', fireAt: new Date(Date.now() + 1200).toISOString() }
  api.copilot.countdown(id, countdown)
  const card = await screen.findByRole('region', { name: '自动分析倒计时' })
  expect(card).toHaveTextContent('问诊定稿：何时起病？')
  expect(screen.getByRole('button', { name: /临床助手.*倒计时/ })).toBeInTheDocument()
  await user.click(within(card).getByRole('button', { name: '立即' }))
  expect(fetch).toHaveBeenCalledWith(`/api/encounters/${id}/copilot/triggers/consultation%3Ax/flush`, expect.objectContaining({ method: 'POST' }))
  await waitFor(() => expect(card).not.toBeInTheDocument())
  api.copilot.countdown(id, { ...countdown, ref: 'consultation:y' })
  await user.click(within(await screen.findByRole('region', { name: '自动分析倒计时' })).getByRole('button', { name: '跳过' }))
  expect(fetch).toHaveBeenCalledWith(`/api/encounters/${id}/copilot/triggers/consultation%3Ay`, { method: 'DELETE' })
})

it('cancels the remaining browser steps when the Worker stops a bridge call', async () => {
  const { bridge } = await openEncounter()
  expect(await writeSection(bridge, '主诉', '已应用。')).toMatchObject({ ok: true })
  const target = screen.getByRole('textbox', { name: '现病史' })
  const ref = (await readSnapshot(bridge)).find((entry) => entry.label === '现病史')!.ref
  const result = await act(async () => {
    const pending = bridge.call('ui_act', { steps: [{ ref, action: 'setValue', args: ['晚到的草稿。'] }] }, 'stopped-call')
    bridge.cancel('stopped-call')
    return pending
  })
  expect(result.ok).toBe(false)
  expect(target).toHaveValue('')
  expect(screen.getByRole('textbox', { name: '主诉' })).toHaveValue('已应用。')
})

it('signs the displayed note and leaves a bridge change during the save as a draft', async () => {
  const { api, bridge, fetch, user } = await openEncounter()
  await user.type(screen.getByRole('textbox', { name: '主诉' }), '发热。')
  await user.type(screen.getByRole('textbox', { name: '现病史' }), '三天前起病。')
  const plan = (await readSnapshot(bridge)).find((item) => item.label === '处理意见与随访')!.ref
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let saving = false
  fetch.mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH' && String(url).endsWith('/clinical-note/draft')) {
      saving = true
      await gate
    }
    return api.handle(url, init)
  })
  try {
    await user.click(screen.getByRole('button', { name: '签署病历' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).not.toHaveTextContent('晚到的建议。')
    await user.click(within(dialog).getByRole('button', { name: '确认签署' }))
    await waitFor(() => expect(saving).toBe(true))
    const result = await act(async () =>
      bridge.call('ui_act', { steps: [{ ref: plan, action: 'setValue', args: ['晚到的建议。'] }] }),
    )
    expect(result.ok).toBe(true)
  } finally {
    release()
  }
  await waitFor(() => expect(api.note(id).revisions).toHaveLength(1))
  expect(api.note(id).revisions[0].sections.plan).toBe('')
  await waitFor(() => expect(api.note(id).draft.find((section) => section.section === 'plan')?.content).toBe('晚到的建议。'))
})

it('adds investigation, diagnosis and prescription drafts with the real bridge and marks their tabs', async () => {
  const { user, bridge, api } = await openEncounter()
  await user.click(screen.getByRole('tab', { name: '检验检查' }))
  await screen.findByRole('button', { name: '加入待开立：血常规（五分类）' })
  const investigations = await readSnapshot(bridge)
  const cbc = investigations.find((item) => item.label === '加入待开立：血常规（五分类）')
  expect(cbc).toBeDefined()
  expect(await act(async () => bridge.call('ui_act', { steps: [{ ref: cbc!.ref, action: 'press' }] }))).toMatchObject({ ok: true })
  await screen.findByRole('tab', { name: /检验检查.*助手 1/ })

  await user.click(screen.getByRole('tab', { name: '诊断' }))
  const diagnoses = await readSnapshot(bridge)
  const diagnosis = diagnoses.find((item) => item.label === 'ICD-10 搜索' || item.label === '搜索 ICD-10 诊断')
  expect(diagnosis, JSON.stringify(diagnoses)).toBeDefined()
  const dxResult = await act(async () => bridge.call('ui_act', { steps: [{ ref: diagnosis!.ref, action: 'setValue', args: ['I10'] }] }))
  expect(dxResult, JSON.stringify(dxResult)).toMatchObject({ ok: true })
  expect(api.diagnosis(id).draft).toEqual([{ code: 'I10', primary: true, source: 'assistant' }])
  await screen.findByRole('tab', { name: /诊断.*助手 1/ })

  await user.click(screen.getByRole('tab', { name: '处方' }))
  const prescriptions = await readSnapshot(bridge)
  const medication = prescriptions.find((item) => item.label === '搜索药品（本院药房）' || item.label === '搜索药品')
  expect(medication, JSON.stringify(prescriptions)).toBeDefined()
  expect(await act(async () => bridge.call('ui_act', { steps: [{ ref: medication!.ref, action: 'setValue', args: ['doxycycline'] }] }))).toMatchObject({ ok: true })
  await screen.findByRole('tab', { name: /处方.*助手 1/ })
  const outside = screen.getByRole('tab', { name: /检验检查.*助手 1/ })
  expect(outside).toHaveAttribute('data-agent-note-updated', 'true')
  expect(outside).not.toHaveAttribute('aria-selected', 'true')
})

it('shows a pending module Suggestion after reload when the doctor had changed an Investigation draft', async () => {
  const original = await openEncounter()
  await original.user.click(screen.getByRole('tab', { name: '检验检查' }))
  await original.user.click(await screen.findByRole('button', { name: '加入待开立：血常规（五分类）' }))
  await original.user.click(screen.getByRole('button', { name: '清空待开立' }))
  await waitFor(() => expect(original.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2))
  const cbc = (await readSnapshot(original.bridge)).find((item) => item.label === '加入待开立：血常规（五分类）')!
  expect(await act(async () => original.bridge.call('ui_act', { steps: [{ ref: cbc.ref, action: 'press' }] }))).toMatchObject({ outcome: 'suggestion' })
  original.unmount()
  const reloaded = await openEncounter(original.api)
  await reloaded.user.click(screen.getByRole('tab', { name: '检验检查' }))
  const suggestion = await screen.findByRole('region', { name: '字段建议：血常规（五分类）' })
  expect(screen.getByRole('button', { name: '完诊清单 1/5' })).toBeInTheDocument()
  await reloaded.user.click(within(suggestion).getByRole('button', { name: '采纳' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: '字段建议：血常规（五分类）' })).not.toBeInTheDocument())
  const saved = await original.api.handle(`/api/encounters/${id}/clinical-drafts`)
  expect(await saved.json()).toMatchObject({ drafts: { investigations: ['cbc'] } })
})
