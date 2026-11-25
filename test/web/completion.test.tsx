import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, expect, it, vi } from 'vitest'
import type { NoteSections } from '../../src/shared/clinical-note'
import type { CaseDebriefReference } from '../../src/shared/completion'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor } from './fake-clinic-api'
import { emptyNote } from './fake-clinical-note'

const agent = createAgent()
const id = 'encounter-1'
const path = `/api/encounters/${id}`
const sections: NoteSections = {
  'chief-complaint': '发热。',
  'present-illness': '三天前起病。',
  'past-history': '',
  findings: '',
  assessment: '全身状态稳定。',
  plan: '三天后复诊。',
}
const reference: CaseDebriefReference = {
  primaryDiagnosis: '社区获得性肺炎',
  secondaryDiagnoses: '原发性高血压',
  keyInvestigations: '血常规、胸部 X 线',
  keyExamination: '右下肺湿啰音',
  medicationConclusion: '避开青霉素类',
  keyHistoryQuestions: '青霉素过敏史',
  severityAssessment: '可门诊治疗',
  disposition: '门诊治疗，72 小时复诊',
}

afterEach(() => vi.unstubAllGlobals())

async function exercise(ready = false) {
  const recordedAt = '2026-11-24T00:41:00.000Z'
  const api = createFakeClinicApi({
    encounters: [encounterFor()],
    diagnoses: ready ? {
      [id]: { draft: [], revisions: [{
        revisionId: 'dx-1', version: 1, seq: 1, practitionerId: 'demo-practitioner', confirmedAt: recordedAt,
        entries: [{ code: 'I10', name: '原发性高血压', source: 'doctor', primary: true }],
      }] },
    } : {},
    notes: ready ? {
      [id]: { ...emptyNote(), revisions: [{
        revisionId: 'note-1', version: 1, seq: 2, practitionerId: 'demo-practitioner', signedAt: recordedAt, sections,
      }] },
    } : {},
    debriefReference: reference,
  })
  if (ready) expect((await api.handle(`${path}/no-medication`, { method: 'POST' })).ok).toBe(true)
  const fetch = vi.fn<typeof globalThis.fetch>(api.handle)
  vi.stubGlobal('fetch', fetch)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${id}`] }) })
  render(<RouterProvider router={router} />)
  return { fetch, user: userEvent.setup(), router }
}

it('links both live checklists to unmet gates and displays the server refusal', async () => {
  const { user, fetch } = await exercise()
  const banner = await screen.findByRole('region', { name: '患者信息' })
  await user.click(within(banner).getByRole('button', { name: '患者完诊清单 2/5' }))
  const checklist = await screen.findByRole('dialog', { name: '患者完诊清单' })
  expect(within(checklist).getAllByRole('listitem')).toHaveLength(5)
  await user.click(within(checklist).getByRole('button', { name: '前往处方' }))
  expect(screen.getByRole('tab', { name: '处方' })).toHaveAttribute('aria-selected', 'true')
  await user.click(screen.getByRole('button', { name: '完诊清单 2/5' }))
  const footer = await screen.findByRole('dialog', { name: '完诊清单' })
  expect(within(footer).getAllByRole('listitem')).toHaveLength(5)
  await user.click(within(footer).getByRole('button', { name: '前往诊断' }))
  expect(screen.getByRole('tab', { name: '诊断' })).toHaveAttribute('aria-selected', 'true')

  const complete = screen.getByRole('button', { name: '确认完诊' })
  expect(complete).toHaveClass('border-dashed')
  await user.click(complete)
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '办理完诊' }))
  expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('未满足完诊条件：主诊断确认、用药结论记录、门诊病历签署')
  expect(screen.queryByRole('tab', { name: '病例复盘' })).not.toBeInTheDocument()
  expect(fetch.mock.calls.some(([url]) => url === `${path}/debrief`)).toBe(false)
})

it('requires Clinical Confirmation before opening the Case Debrief and can replay', async () => {
  const { user, fetch, router } = await exercise(true)
  await screen.findByRole('button', { name: '完诊清单 5/5' })
  const refused = await agent.act({ steps: [{ ref: '确认完诊', action: 'press', args: ['办理完诊'] }] })
  expect(refused.ok).toBe(false)
  expect(refused.error?.message).toMatch(/person/i)
  expect(fetch.mock.calls.some(([url]) => url === `${path}/completion`)).toBe(false)

  await user.click(screen.getByRole('button', { name: '确认完诊' }))
  const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: '办理完诊' })
  expect(confirm).toHaveAttribute('data-agent-confirm')
  await user.click(confirm)

  const debrief = await screen.findByRole('table', { name: '病例复盘对照' })
  expect(within(debrief).getByRole('columnheader', { name: '本次正式记录' })).toBeInTheDocument()
  expect(debrief).toHaveTextContent('社区获得性肺炎')
  expect(debrief).toHaveTextContent('三天后复诊。')
  expect(debrief).toHaveTextContent('无需用药')
  expect(screen.queryByRole('button', { name: '确认完诊' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '开始新的就诊' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/encounters/started-1'))
  expect(await screen.findByRole('button', { name: '完诊清单 2/5' })).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: '病例复盘' })).not.toBeInTheDocument()
})

it('hydrates a saved Investigation draft and counts it until it is cleared', async () => {
  const api = createFakeClinicApi({ encounters: [encounterFor()] })
  await api.handle(`${path}/investigations/draft`, { method: 'PUT', body: JSON.stringify({ entries: ['cbc'] }) })
  vi.stubGlobal('fetch', api.handle)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${id}`] }) })
  render(<RouterProvider router={router} />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '完诊清单 1/5' }))
  const checklist = await screen.findByRole('dialog', { name: '完诊清单' })
  expect(checklist).toHaveTextContent('检查 1')
  await user.click(within(checklist).getByRole('button', { name: '前往检验检查' }))
  await user.click(screen.getByRole('button', { name: '清空待开立' }))
  await screen.findByRole('button', { name: '完诊清单 2/5' })
  await waitFor(async () => {
    expect(await (await api.handle(`${path}/clinical-drafts`)).json()).toMatchObject({ drafts: { investigations: [] } })
  })
})
