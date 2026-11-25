import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  MAX_NOTE_SECTION_LENGTH,
  NOTE_SECTIONS,
  type ClinicalNoteResponse,
  type ClinicalNoteView,
  type NoteSections,
} from '../../src/shared/clinical-note'
import type { AuditEventsResponse, ErrorResponse } from '../../src/shared/encounter'
import { expectNoCaseTruth } from './case-truth'
import { api, send, startEncounter } from './support/clinic'

const PRACTITIONER_ID = 'demo-practitioner'

const notePath = (encounterId: string) => `/api/encounters/${encounterId}/clinical-note`
const saveDraft = (encounterId: string, sections: unknown) => send('PATCH', `${notePath(encounterId)}/draft`, { sections })
const sign = (encounterId: string, sections: unknown) => send('POST', `${notePath(encounterId)}/revisions`, { sections })

async function note(encounterId: string): Promise<ClinicalNoteView> {
  const response = await api(notePath(encounterId))
  expect(response.status).toBe(200)
  const body = await response.text()
  expectNoCaseTruth('clinical note', body)
  return (JSON.parse(body) as ClinicalNoteResponse).note
}

const contentOf = (view: ClinicalNoteView) => Object.fromEntries(view.draft.map((d) => [d.section, d.content]))
const auditEvents = async (encounterId: string) =>
  ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents

const complete = (overrides: Partial<NoteSections> = {}): NoteSections => ({
  'chief-complaint': '发热、咳嗽 3 天。',
  'present-illness': '患者述：“这三天一直发烧，咳嗽得厉害。”',
  'past-history': '自述青霉素过敏。',
  findings: '',
  assessment: '',
  plan: '注意休息，多饮水。',
  ...overrides,
})

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as ErrorResponse).error }
}

describe('Clinical Note Draft', () => {
  it('starts with six empty sections in order and no signed revision', async () => {
    const encounterId = await startEncounter()
    expect(await note(encounterId)).toEqual({
      draft: NOTE_SECTIONS.map((section) => ({ section, content: '', lastEditedBy: null, updatedAt: null })),
      revisions: [],
    })
  })

  it('autosaves the sections the doctor changed, attributed to the doctor, and keeps them across a workspace restart', async () => {
    const encounterId = await startEncounter()
    const before = Date.now()
    const saved = await saveDraft(encounterId, { 'chief-complaint': '发热、咳嗽 3 天。', plan: '注意休息。' })
    expect(saved.status).toBe(200)
    const { note: afterSave } = (await saved.json()) as ClinicalNoteResponse

    const chief = afterSave.draft.find((d) => d.section === 'chief-complaint')!
    expect(chief).toEqual({ section: 'chief-complaint', content: '发热、咳嗽 3 天。', lastEditedBy: 'doctor', updatedAt: expect.any(String) })
    expect(Date.parse(chief.updatedAt!)).toBeGreaterThanOrEqual(before - 1000)
    expect(afterSave.draft.find((d) => d.section === 'present-illness')).toEqual({
      section: 'present-illness',
      content: '',
      lastEditedBy: null,
      updatedAt: null,
    })

    await saveDraft(encounterId, { plan: '注意休息，多饮水。' })
    await evictDurableObject(env.CLINIC_WORKSPACE.getByName('default'))
    const reloaded = await note(encounterId)
    expect(contentOf(reloaded)).toMatchObject({ 'chief-complaint': '发热、咳嗽 3 天。', plan: '注意休息，多饮水。', findings: '' })
    expect(reloaded.draft.find((d) => d.section === 'chief-complaint')).toEqual(chief)
    expect(reloaded.revisions).toEqual([])
  })

  it('lets the doctor clear a section, and leaves a section saved with unchanged text as it was', async () => {
    const encounterId = await startEncounter()
    await saveDraft(encounterId, { findings: '咽部充血。', plan: '复诊。' })
    const first = await note(encounterId)
    await saveDraft(encounterId, { findings: '', plan: '复诊。' })
    const second = await note(encounterId)
    expect(contentOf(second)).toMatchObject({ findings: '', plan: '复诊。' })
    expect(second.draft.find((d) => d.section === 'plan')).toEqual(first.draft.find((d) => d.section === 'plan'))
  })

  it('refuses malformed drafts and unknown Encounters, saving nothing', async () => {
    const encounterId = await startEncounter()
    for (const sections of [
      undefined,
      {},
      [],
      { 'chief-complaint': 3 },
      { diagnosis: '肺部感染' },
      { plan: 'x'.repeat(MAX_NOTE_SECTION_LENGTH + 1) },
    ]) {
      const refused = await errorOf(await saveDraft(encounterId, sections))
      expect(refused, JSON.stringify(sections)).toMatchObject({ status: 400, code: 'invalid-request' })
    }
    expect((await saveDraft(encounterId, { plan: 'x'.repeat(MAX_NOTE_SECTION_LENGTH) })).status).toBe(200)
    expect(await errorOf(await saveDraft('no-such-encounter', { plan: '复诊。' }))).toMatchObject({ status: 404, code: 'encounter-not-found' })
    expect(await errorOf(await api(notePath('no-such-encounter')))).toMatchObject({ status: 404, code: 'encounter-not-found' })
    expect(contentOf(await note(encounterId))).toMatchObject({ 'chief-complaint': '', plan: 'x'.repeat(MAX_NOTE_SECTION_LENGTH) })
  })
})

describe('signing the Clinical Note', () => {
  it('records exactly what the doctor confirmed as revision 1, with the practitioner, and audits it', async () => {
    const encounterId = await startEncounter()
    await saveDraft(encounterId, complete())
    const before = Date.now()
    const response = await sign(encounterId, complete())
    expect(response.status).toBe(201)
    const body = await response.text()
    expectNoCaseTruth('signed note', body)
    const { note: signed } = JSON.parse(body) as ClinicalNoteResponse

    expect(signed.revisions).toEqual([
      {
        revisionId: expect.any(String),
        version: 1,
        seq: 1,
        sections: complete(),
        practitionerId: PRACTITIONER_ID,
        signedAt: expect.any(String),
      },
    ])
    const [revision] = signed.revisions
    expect(Date.parse(revision.signedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(contentOf(signed)).toEqual(complete())
    expect((await auditEvents(encounterId)).slice(1)).toEqual([
      { eventType: 'clinical-note-signed', practitionerId: PRACTITIONER_ID, occurredAt: revision.signedAt, subject: revision.revisionId },
    ])

    await evictDurableObject(env.CLINIC_WORKSPACE.getByName('default'))
    expect((await note(encounterId)).revisions).toEqual(signed.revisions)
  })

  it('refuses a note whose chief complaint or history of present illness is blank, recording nothing', async () => {
    const encounterId = await startEncounter()
    const cases: [Partial<NoteSections>, string][] = [
      [{ 'chief-complaint': '' }, '主诉'],
      [{ 'present-illness': ' \n\t ' }, '现病史'],
      [{ 'chief-complaint': '   ', 'present-illness': '' }, '主诉、现病史'],
    ]
    for (const [blank, named] of cases) {
      const refused = await errorOf(await sign(encounterId, complete(blank)))
      expect(refused).toEqual({ status: 422, code: 'clinical-note-incomplete', message: `签署前请填写必填项：${named}。` })
    }
    expect((await note(encounterId)).revisions).toEqual([])
    expect((await auditEvents(encounterId)).map((e) => e.eventType)).toEqual(['encounter-started'])
  })

  it('refuses a malformed signing request', async () => {
    const encounterId = await startEncounter()
    const { plan: _omitted, ...missingPlan } = complete()
    for (const sections of [undefined, missingPlan, { ...complete(), plan: null }, { ...complete(), extra: '' }, complete({ plan: 'x'.repeat(MAX_NOTE_SECTION_LENGTH + 1) })]) {
      expect(await errorOf(await sign(encounterId, sections))).toMatchObject({ status: 400, code: 'invalid-request' })
    }
    expect((await note(encounterId)).revisions).toEqual([])
  })

  it('appends a new revision after later edits, keeping every earlier revision with its own content', async () => {
    const encounterId = await startEncounter()
    await sign(encounterId, complete())
    const amended = complete({ plan: '注意休息，多饮水。72 小时复诊。' })
    await saveDraft(encounterId, { plan: amended.plan })
    const response = await sign(encounterId, amended)
    expect(response.status).toBe(201)
    const { note: view } = (await response.json()) as ClinicalNoteResponse

    expect(view.revisions.map(({ version, seq, sections }) => ({ version, seq, sections }))).toEqual([
      { version: 1, seq: 1, sections: complete() },
      { version: 2, seq: 2, sections: amended },
    ])
    expect(new Set(view.revisions.map((r) => r.revisionId)).size).toBe(2)
    expect((await auditEvents(encounterId)).filter((e) => e.eventType === 'clinical-note-signed').map((e) => e.subject)).toEqual(
      view.revisions.map((r) => r.revisionId),
    )
  })

  it('signs again with unchanged content, since a revision can be needed without edits (e.g. after a Diagnosis revision)', async () => {
    const encounterId = await startEncounter()
    await sign(encounterId, complete())
    const again = await sign(encounterId, complete())
    expect(again.status).toBe(201)
    expect(((await again.json()) as ClinicalNoteResponse).note.revisions.map((r) => r.version)).toEqual([1, 2])
  })

  it('numbers revisions per Encounter', async () => {
    const first = await startEncounter()
    await sign(first, complete())
    await send('POST', `/api/encounters/${first}/abandonment`)
    const second = await startEncounter()
    const { note: view } = (await (await sign(second, complete())).json()) as ClinicalNoteResponse
    expect(view.revisions.map(({ version, seq }) => ({ version, seq }))).toEqual([{ version: 1, seq: 1 }])
  })

  it('keeps signed revisions immutable in storage', async () => {
    const encounterId = await startEncounter()
    await sign(encounterId, complete())
    const signed = (await note(encounterId)).revisions
    await runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE clinical_note_revision SET content = '{}'`)).toThrow(/immutable/)
      expect(() => state.storage.sql.exec('DELETE FROM clinical_note_revision')).toThrow(/immutable/)
    })
    expect((await note(encounterId)).revisions).toEqual(signed)
  })
})
