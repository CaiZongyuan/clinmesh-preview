import { describe, expect, it } from 'vitest'
import type { DiagnosisResponse, DiagnosisView } from '../../src/shared/diagnosis'
import type { AuditEventsResponse, ErrorResponse } from '../../src/shared/encounter'
import type { ClinicalNoteResponse } from '../../src/shared/clinical-note'
import { expectNoCaseTruth } from './case-truth'
import { api, send, startEncounter } from './support/clinic'

const diagnosisPath = (encounterId: string) => `/api/encounters/${encounterId}/diagnosis`
const saveDraft = (encounterId: string, entries: unknown) => send('PUT', `${diagnosisPath(encounterId)}/draft`, { entries })
const confirm = (encounterId: string, entries: unknown) => send('POST', `${diagnosisPath(encounterId)}/revisions`, { entries })
const reopen = (encounterId: string) => send('POST', `${diagnosisPath(encounterId)}/reopen`)

async function diagnosis(encounterId: string): Promise<DiagnosisView> {
  const response = await api(diagnosisPath(encounterId))
  expect(response.status).toBe(200)
  const body = await response.text()
  expectNoCaseTruth('diagnosis', body)
  return ((JSON.parse(body) as DiagnosisResponse).diagnosis)
}

const entry = (code: string, primary = false, source = 'doctor') => ({ code, primary, source })

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as ErrorResponse).error }
}

const auditEvents = async (encounterId: string) =>
  ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents

const signableNote = {
  'chief-complaint': '血压升高 1 年。',
  'present-illness': '患者述一年前体检查出血压升高。',
  'past-history': '',
  findings: '',
  assessment: '',
  plan: '',
}

const signNote = async (encounterId: string) => {
  const response = await send('POST', `/api/encounters/${encounterId}/clinical-note/revisions`, { sections: signableNote })
  expect(response.status).toBe(201)
  return ((await response.json()) as ClinicalNoteResponse).note.revisions.at(-1)!
}

describe('Diagnosis draft', () => {
  it('starts with an empty draft and no confirmed revision', async () => {
    const encounterId = await startEncounter()
    expect(await diagnosis(encounterId)).toEqual({ draft: [], revisions: [] })
  })

  it('saves draft entries with who added each one, replacing the whole set', async () => {
    const encounterId = await startEncounter()
    const saved = await saveDraft(encounterId, [entry('I10', true), entry('E11.9', false, 'assistant')])
    expect(saved.status).toBe(200)
    expect(await diagnosis(encounterId)).toMatchObject({
      draft: [
        { code: 'I10', primary: true, source: 'doctor' },
        { code: 'E11.9', primary: false, source: 'assistant' },
      ],
      revisions: [],
    })

    await saveDraft(encounterId, [entry('I10', true)])
    expect((await diagnosis(encounterId)).draft).toEqual([entry('I10', true)])
  })

  it('clears the draft when the entry list becomes empty', async () => {
    const encounterId = await startEncounter()
    await saveDraft(encounterId, [entry('I10', true)])
    expect((await saveDraft(encounterId, [])).status).toBe(200)
    expect((await diagnosis(encounterId)).draft).toEqual([])
  })

  it('refuses unknown codes, malformed entries, duplicates and more than eight entries', async () => {
    const encounterId = await startEncounter()
    expect((await saveDraft(encounterId, [entry('NOPE')])).status).toBe(400)
    expect((await saveDraft(encounterId, [{ code: 'I10' }])).status).toBe(400)
    expect((await saveDraft(encounterId, [entry('I10'), entry('I10')])).status).toBe(400)
    expect((await saveDraft(encounterId, Array.from({ length: 9 }, () => entry('I10')))).status).toBe(400)
    expect((await saveDraft(encounterId, 'I10')).status).toBe(400)
    expect((await diagnosis(encounterId)).draft).toEqual([])
  })
})

describe('Diagnosis confirmation', () => {
  it('refuses a confirmation without exactly one primary diagnosis and writes nothing', async () => {
    const encounterId = await startEncounter()
    for (const entries of [[entry('I10'), entry('E11.9')], [entry('I10', true), entry('E11.9', true)], []]) {
      const { status, code } = await errorOf(await confirm(encounterId, entries))
      expect(status).toBe(422)
      expect(code).toBe('diagnosis-needs-primary')
    }
    expect(await diagnosis(encounterId)).toEqual({ draft: [], revisions: [] })
    expect(await auditEvents(encounterId)).toEqual([expect.objectContaining({ eventType: 'encounter-started' })])
  })

  it('records exactly what the doctor confirmed as an immutable revision with names resolved, and audits it', async () => {
    const encounterId = await startEncounter()
    const confirmed = await confirm(encounterId, [entry('I10', true), entry('E11.9', false, 'assistant')])
    expect(confirmed.status).toBe(201)
    const view = await diagnosis(encounterId)
    expect(view.revisions).toHaveLength(1)
    const revision = view.revisions[0]
    expect(revision).toMatchObject({
      version: 1,
      entries: [
        { code: 'I10', name: '原发性高血压', primary: true, source: 'doctor' },
        { code: 'E11.9', name: '2型糖尿病', primary: false, source: 'assistant' },
      ],
      practitionerId: 'demo-practitioner',
    })
    expect(revision.seq).toBeGreaterThan(0)
    expect(view.draft).toEqual([])
    expect(await auditEvents(encounterId)).toEqual([
      expect.objectContaining({ eventType: 'encounter-started' }),
      expect.objectContaining({ eventType: 'diagnosis-confirmed', practitionerId: 'demo-practitioner', subject: revision.revisionId }),
    ])
  })

  it('keeps every confirmed revision in order and shares the clinical revision sequence with signed notes', async () => {
    const encounterId = await startEncounter()
    await confirm(encounterId, [entry('I10', true)])
    const noteRevision = await signNote(encounterId)
    await confirm(encounterId, [entry('I10', true), entry('E11.9', false)])

    const view = await diagnosis(encounterId)
    expect(view.revisions.map((r) => [r.version, r.entries.length])).toEqual([[1, 1], [2, 2]])
    expect(view.revisions[1].seq).toBeGreaterThan(view.revisions[0].seq)
    expect(view.revisions[1].seq).toBeGreaterThan(noteRevision.seq)
  })

  it('reopens a draft from the latest revision, keeping codes, primary marks and sources', async () => {
    const encounterId = await startEncounter()
    await confirm(encounterId, [entry('I10', true), entry('E11.9', false, 'assistant')])
    const reopened = await reopen(encounterId)
    expect(reopened.status).toBe(200)
    expect((await diagnosis(encounterId)).draft).toEqual([
      entry('I10', true),
      entry('E11.9', false, 'assistant'),
    ])
    await reopen(encounterId)
    expect((await diagnosis(encounterId)).draft).toEqual([entry('I10', true), entry('E11.9', false, 'assistant')])
  })

  it('refuses reopening before anything was confirmed', async () => {
    const encounterId = await startEncounter()
    const { status, code } = await errorOf(await reopen(encounterId))
    expect(status).toBe(409)
    expect(code).toBe('diagnosis-not-confirmed')
  })
})
