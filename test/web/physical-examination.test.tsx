import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EncounterView } from '../../src/shared/encounter'
import type { PhysicalExaminationView } from '../../src/shared/physical-examination'
import { createAppRouter } from '../../src/web/router'
import { formatClock } from '../../src/web/workbench/format'
import { createFakeClinicApi, encounterFor, examinationFor } from './fake-clinic-api'

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

function openEncounter(encounter: EncounterView = encounterFor(), examinations: PhysicalExaminationView[] = []) {
  const api = createFakeClinicApi({ encounters: [encounter], examinations: { [encounter.encounterId]: examinations } })
  fetchStub.mockImplementation(api.handle)
  render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${encounter.encounterId}`] }) })} />)
  return api
}

const EXAMINE_PATH = '/api/encounters/encounter-1/physical-examinations'
const examinationRequests = () =>
  fetchStub.mock.calls.filter(([url, init]) => String(url) === EXAMINE_PATH && init?.method === 'POST')
const consultation = () => screen.findByRole('region', { name: '问诊记录' })
const transcriptRows = async () => within(within(await consultation()).getByRole('list', { name: '问诊转写' })).getAllByRole('listitem')
const banner = () => screen.findByRole('region', { name: '患者信息' })

describe('Physical Examination', () => {
  it('examines one body system and shows the finding inline in the transcript as an examination row with its time', async () => {
    const user = userEvent.setup()
    openEncounter()
    const column = await consultation()
    expect(within(column).getByRole('button', { name: /体格检查 0\/6/ })).toHaveAttribute('aria-expanded', 'true')
    expect(within(column).queryByRole('list', { name: '问诊转写' })).not.toBeInTheDocument()

    await user.click(within(column).getByRole('button', { name: '查体：肺部' }))

    const [row] = await waitFor(transcriptRows)
    expect(JSON.parse(String(examinationRequests()[0][1]?.body))).toEqual({ system: 'lungs' })
    expect(row).toHaveAttribute('data-kind', 'examination')
    expect(within(row).getByText('查体')).toBeInTheDocument()
    expect(row).toHaveTextContent('肺部：右下肺呼吸音减低，可闻及湿性啰音；左肺呼吸音清')
    const time = within(row).getByText(/^\d{2}:\d{2}$/)
    expect(time.tagName).toBe('TIME')

    const lungs = within(column).getByRole('button', { name: '查体：肺部' })
    expect(lungs).toBeDisabled()
    expect(lungs).toHaveAttribute('data-examined')
    expect(within(column).getByRole('button', { name: '查体：心脏' })).toBeEnabled()
    expect(within(column).getByRole('button', { name: /体格检查 1\/6/ })).toBeInTheDocument()
  })

  it('shows earlier examinations in time order after a reload, each body system disabled once examined', async () => {
    openEncounter(encounterFor(), [
      examinationFor('general', '2026-11-24T01:02:00.000Z'),
      examinationFor('heart', '2026-11-24T01:05:00.000Z'),
    ])
    const rows = await waitFor(transcriptRows)
    expect(rows.map((row) => row.textContent)).toEqual([
      `查体一般情况：神志清，急性病容，对答切题${formatClock('2026-11-24T01:02:00.000Z')}`,
      `查体心脏：心率 102 次/分，律齐，各瓣膜区未闻及杂音${formatClock('2026-11-24T01:05:00.000Z')}`,
    ])
    const column = await consultation()
    for (const name of ['一般情况', '心脏']) expect(within(column).getByRole('button', { name: `查体：${name}` })).toBeDisabled()
    for (const name of ['生命体征', '咽部', '肺部', '腹部']) expect(within(column).getByRole('button', { name: `查体：${name}` })).toBeEnabled()
  })

  it('updates the banner vitals tiles with abnormal flags and the examination as source and time', async () => {
    const user = userEvent.setup()
    openEncounter()
    expect(within(await banner()).getByRole('list', { name: '分诊生命体征' })).toBeInTheDocument()

    await user.click(within(await consultation()).getByRole('button', { name: '查体：生命体征' }))

    const tiles = await within(await banner()).findByRole('list', { name: '查体生命体征' })
    expect(within(tiles).getAllByRole('listitem').map((tile) => tile.textContent)).toEqual([
      'T体温38.6℃↑偏高',
      'P脉搏102次/分↑偏高',
      'R呼吸22次/分↑偏高',
      'BP血压138/84mmHg',
      'SpO₂血氧饱和度94%↓偏低',
    ])
    expect(within(await banner()).queryByRole('list', { name: '分诊生命体征' })).not.toBeInTheDocument()
    const [row] = await transcriptRows()
    const examinedAt = within(row).getByText(/^\d{2}:\d{2}$/).getAttribute('datetime')!
    expect(await banner()).toHaveTextContent(`查体 ${formatClock(examinedAt)}`)
    expect(row).toHaveTextContent('生命体征：T 38.6℃，P 102 次/分，R 22 次/分，BP 138/84 mmHg，SpO₂ 94%（未吸氧）')
  })

  it('asks for no acknowledgement and leaves the completion count alone', async () => {
    const user = userEvent.setup()
    openEncounter()
    await user.click(within(await consultation()).getByRole('button', { name: '查体：腹部' }))
    await waitFor(transcriptRows)
    expect(within(await consultation()).queryByRole('button', { name: /已阅|确认/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完诊清单 2/5' })).toBeInTheDocument()
  })

  it('shows the server refusal when the body system was examined elsewhere in the meantime', async () => {
    const user = userEvent.setup()
    const api = openEncounter()
    const column = await consultation()
    await api.handle(EXAMINE_PATH, { method: 'POST', body: JSON.stringify({ system: 'pharynx' }) })

    await user.click(within(column).getByRole('button', { name: '查体：咽部' }))
    expect(await within(column).findByRole('alert')).toHaveTextContent('本次就诊已查过咽部，每个部位只查一次。')
    await waitFor(() => expect(within(column).getByRole('button', { name: '查体：咽部' })).toBeDisabled())
    expect(await transcriptRows()).toHaveLength(1)
  })

  it('keeps findings visible but allows no examination on an abandoned Encounter', async () => {
    openEncounter(encounterFor({ status: 'abandoned', endedAt: new Date().toISOString() }), [examinationFor('general')])
    expect(await waitFor(transcriptRows)).toHaveLength(1)
    const column = await consultation()
    for (const name of ['生命体征', '一般情况', '咽部', '肺部', '心脏', '腹部']) {
      expect(within(column).getByRole('button', { name: `查体：${name}` })).toBeDisabled()
    }
  })

  it('lets the agent bridge examine only once the doctor approves that step', async () => {
    openEncounter()
    await consultation()
    const examine = { steps: [{ ref: '查体：心脏', action: 'press' }] }

    const refused = await agent.act(examine)
    expect(refused.ok).toBe(false)
    expect(examinationRequests()).toHaveLength(0)

    approve = true
    const approved = await agent.act(examine)
    expect(approved.ok, approved.error?.message).toBe(true)
    await waitFor(() => expect(examinationRequests()).toHaveLength(1))
  })
})
