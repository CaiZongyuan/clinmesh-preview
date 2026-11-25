import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import rawCatalog from '../../data/clinic-catalog/investigation-catalog.json'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import type {
  InvestigationCatalogResponse,
  InvestigationsResponse,
  InvestigationView,
  ReportResultRow,
} from '../../src/shared/investigation'
import { ageOn } from '../../src/worker/golden-case-pack'
import { admitCatalog, bandFor, flagFor, type CatalogItem, type RawCatalog } from '../../src/worker/investigation-catalog'
import { EncounterRepository } from '../../src/worker/encounter-repository'
import { InvestigationRepository } from '../../src/worker/investigation-repository'

const T0 = Date.parse('2026-11-24T00:40:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://clinmesh.test${path}`, init)
const post = (path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function startEncounter(): Promise<string> {
  const response = await post('/api/encounters', { caseId: 'golden-case-01' })
  return ((await response.json()) as EncounterResponse).encounter.encounterId
}

const issue = (encounterId: string, catalogItemIds: unknown) =>
  post(`/api/encounters/${encounterId}/investigations`, { catalogItemIds })
const releaseNow = (encounterId: string, investigationId: string) =>
  post(`/api/encounters/${encounterId}/investigations/${investigationId}/instant-release`)
const acknowledge = (encounterId: string, reportIds: unknown) =>
  post(`/api/encounters/${encounterId}/report-acknowledgements`, { reportIds })

async function investigations(encounterId: string): Promise<InvestigationView[]> {
  const response = await api(`/api/encounters/${encounterId}/investigations`)
  expect(response.status).toBe(200)
  return ((await response.json()) as InvestigationsResponse).investigations
}

async function retireCaseVersion(encounterId: string) {
  await runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
    state.storage.sql.exec(`UPDATE encounter SET case_version = '2026-01-01.0' WHERE encounter_id = ?`, encounterId)
  })
}

const byItem = (list: InvestigationView[], catalogItemId: string) => list.find((i) => i.catalogItemId === catalogItemId)!
const auditTypes = async (encounterId: string) =>
  ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents.map(
    (e) => e.eventType,
  )

async function errorCode(response: Response) {
  return ((await response.json()) as ErrorResponse).error.code
}

const row = (name: string, value: number | string, unit: string, referenceRange: string, flag: ReportResultRow['flag']) =>
  expect.objectContaining({ name, value, unit, referenceRange, flag })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('investigation catalog', () => {
  it('lists every item with its category, specimen or body site, performing department and expected turnaround, and no results', async () => {
    const response = await api('/api/investigation-catalog')
    expect(response.status).toBe(200)
    const { catalogVersion, items } = (await response.json()) as InvestigationCatalogResponse
    expect(catalogVersion).toBe(rawCatalog.version)
    expect(items.map((item) => item.id)).toEqual(rawCatalog.items.map((item) => item.id))
    expect(items.find((item) => item.id === 'cbc')).toEqual({
      id: 'cbc',
      name: '血常规（五分类）',
      category: 'lab',
      pinyinInitials: ['xcg', 'cbc'],
      specimenOrSite: '静脉血 · EDTA 紫帽',
      department: '检验科',
      expectedTurnaround: '30 分钟',
    })
    for (const id of ['crp', 'cxr', 'hs-ctni', 'ecg', 'urinalysis', 'glu', 'hba1c']) {
      expect(items.map((item) => item.id), id).toContain(id)
    }
    expect(new Set(items.map((item) => item.category))).toEqual(new Set(['lab', 'radiology', 'function']))
  })

  it('admits no item without an age/sex-banded baseline rule for every patient', () => {
    const catalog = rawCatalog as RawCatalog
    const cbc = catalog.items.find((item) => item.id === 'cbc')!
    const cxr = catalog.items.find((item) => item.id === 'cxr')!
    const withAnalyte = (baseline: unknown): CatalogItem =>
      ({ ...cbc, id: 'probe', analytes: [{ ...cbc.analytes![0], baseline }] }) as CatalogItem
    const refused: CatalogItem[] = [
      { ...cbc, id: 'no-rule', analytes: [{ ...cbc.analytes![0], baseline: undefined }] },
      withAnalyte([]),
      withAnalyte([{ sex: 'male', ageFrom: 0, referenceRange: { low: 1, high: 2, text: '1–2' }, value: 1.5 }]),
      withAnalyte([{ sex: 'any', ageFrom: 18, referenceRange: { low: 1, high: 2, text: '1–2' }, value: 1.5 }]),
      withAnalyte([{ sex: 'any', ageFrom: 0, referenceRange: { low: 1, high: 2, text: '1–2' }, value: 3 }]),
      withAnalyte([
        { sex: 'any', ageFrom: 0, referenceRange: { low: 1, high: 2, text: '1–2' }, value: 1.5 },
        { sex: 'any', ageFrom: 0, referenceRange: { low: 1, high: 3, text: '1–3' }, value: 1.5 },
      ]),
      withAnalyte([
        { sex: 'any', ageFrom: 0, referenceRange: { low: 1, high: 2, text: '1–2' }, value: 1.5 },
        { sex: 'female', ageFrom: 60, referenceRange: { low: 1, high: 3, text: '1–3' }, value: 1.5 },
        { sex: 'any', ageFrom: 60, referenceRange: { low: 1, high: 4, text: '1–4' }, value: 1.5 },
      ]),
      {
        ...cxr,
        id: 'tied-narrative',
        narrative: [cxr.narrative![0], { ...cxr.narrative![0], sex: 'male', impression: '另一结论。' }],
      },
      { ...cxr, id: 'no-narrative', narrative: undefined },
    ]
    const admitted = admitCatalog({ ...catalog, items: [...catalog.items, ...refused] }).items.map((item) => item.id)
    expect(admitted).toEqual(catalog.items.map((item) => item.id))
  })

  it('agrees with every Golden Case override on the item, analyte, reference range and abnormal flag', () => {
    const items = (rawCatalog as RawCatalog).items
    for (const goldenCase of casePack.cases) {
      const patient = {
        sex: goldenCase.patient.gender as 'male' | 'female',
        age: ageOn(goldenCase.patient.birthDate, goldenCase.registration.registeredAt),
      }
      for (const lab of goldenCase.laboratories) {
        const analyte = items.find((item) => item.id === lab.catalogItem)?.analytes?.find((a) => a.id === lab.id)
        expect(analyte, `${goldenCase.id} ${lab.id}`).toBeDefined()
        const band = bandFor(analyte!.baseline!, patient)!
        expect(band.referenceRange, lab.id).toEqual(lab.referenceRange)
        const flag = { H: 'high', L: 'low', N: null }[lab.interpretation as 'H' | 'L' | 'N']
        expect(flagFor(lab.value, band.referenceRange), lab.id).toBe(flag)
      }
      for (const text of goldenCase.textResults) {
        expect(items.find((item) => item.id === text.catalogItem)?.narrative, text.id).toBeDefined()
      }
    }
  })
})

describe('issuing Investigations', () => {
  it('issues the pending items together, each starting at 已开立 and audited with the practitioner', async () => {
    const encounterId = await startEncounter()
    const response = await issue(encounterId, ['cbc', 'crp', 'cxr'])
    expect(response.status).toBe(201)
    const issued = ((await response.json()) as InvestigationsResponse).investigations
    expect(issued.map((i) => i.catalogItemId)).toEqual(['cbc', 'crp', 'cxr'])
    expect(byItem(issued, 'cxr')).toEqual({
      investigationId: expect.any(String),
      catalogItemId: 'cxr',
      name: '胸部正侧位 X 线',
      category: 'radiology',
      specimenOrSite: '胸部 · 正侧位',
      department: '放射科',
      practitionerId: 'demo-practitioner',
      issuedAt: at(0),
      expectedReportAt: at(150),
      stages: [{ name: '已开立', at: at(0) }],
      cancellation: null,
      reports: [],
    })
    expect(await investigations(encounterId)).toEqual(issued)
    const audit = ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents
    expect(audit.slice(1)).toEqual(
      ['cbc', 'crp', 'cxr'].map((subject) => ({ eventType: 'investigation-issued', practitionerId: 'demo-practitioner', occurredAt: at(0), subject })),
    )
    expect(await auditTypes(encounterId)).toEqual([
      'encounter-started',
      'investigation-issued',
      'investigation-issued',
      'investigation-issued',
    ])
  })

  it('refuses malformed lists, unknown items and items already issued, writing nothing', async () => {
    const encounterId = await startEncounter()
    await issue(encounterId, ['cbc'])
    for (const ids of [[], ['crp', 'crp'], 'crp', [7]]) {
      const response = await issue(encounterId, ids)
      expect(response.status, JSON.stringify(ids)).toBe(400)
      expect(await errorCode(response)).toBe('invalid-request')
    }
    const unknown = await issue(encounterId, ['crp', 'no-such-item'])
    expect(unknown.status).toBe(404)
    expect(await errorCode(unknown)).toBe('catalog-item-not-found')
    const again = await issue(encounterId, ['crp', 'cbc'])
    expect(again.status).toBe(409)
    expect(await errorCode(again)).toBe('investigation-already-issued')

    expect((await investigations(encounterId)).map((i) => i.catalogItemId)).toEqual(['cbc'])
    expect(await auditTypes(encounterId)).toEqual(['encounter-started', 'investigation-issued'])
  })
})

describe('simulated turnaround', () => {
  it('advances each category through its stages with timestamps and releases Report version 1 at the end', async () => {
    const encounterId = await startEncounter()
    await issue(encounterId, ['cbc', 'cxr', 'ecg'])

    vi.setSystemTime(T0 + 31_000)
    let list = await investigations(encounterId)
    expect(byItem(list, 'cbc').stages).toEqual([
      { name: '已开立', at: at(0) },
      { name: '已采样', at: at(30) },
    ])
    expect(byItem(list, 'ecg').stages.map((s) => s.name)).toEqual(['已开立', '检查中'])
    expect(byItem(list, 'cxr').stages.map((s) => s.name)).toEqual(['已开立'])
    expect(list.every((i) => i.reports.length === 0)).toBe(true)

    vi.setSystemTime(T0 + 100_000)
    list = await investigations(encounterId)
    expect(byItem(list, 'cbc').stages).toEqual([
      { name: '已开立', at: at(0) },
      { name: '已采样', at: at(30) },
      { name: '检验中', at: at(60) },
      { name: '已出报告', at: at(90) },
    ])
    expect(byItem(list, 'cbc').reports).toEqual([expect.objectContaining({ version: 1, releasedAt: at(90), acknowledgement: null })])
    expect(byItem(list, 'ecg').reports).toEqual([expect.objectContaining({ version: 1, releasedAt: at(60) })])
    expect(byItem(list, 'cxr').stages.map((s) => s.name)).toEqual(['已开立', '已登记', '检查中'])
    expect(byItem(list, 'cxr').reports).toEqual([])

    vi.setSystemTime(T0 + 200_000)
    expect(byItem(await investigations(encounterId), 'cxr').stages).toEqual([
      { name: '已开立', at: at(0) },
      { name: '已登记', at: at(38) },
      { name: '检查中', at: at(75) },
      { name: '待审核', at: at(113) },
      { name: '已出报告', at: at(150) },
    ])
  })

  it('releases at once through the instant-release test control, audited, and only once', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations

    vi.setSystemTime(T0 + 5_000)
    const response = await releaseNow(encounterId, cbc.investigationId)
    expect(response.status).toBe(200)
    const list = ((await response.json()) as InvestigationsResponse).investigations
    expect(byItem(list, 'cbc').stages).toEqual(['已开立', '已采样', '检验中', '已出报告'].map((name, i) => ({ name, at: at(i && 5) })))
    expect(byItem(list, 'cbc').reports).toHaveLength(1)
    expect(byItem(list, 'crp').reports).toHaveLength(0)

    const again = await releaseNow(encounterId, cbc.investigationId)
    expect(again.status).toBe(200)
    expect(byItem(((await again.json()) as InvestigationsResponse).investigations, 'cbc').reports).toEqual(byItem(list, 'cbc').reports)
    expect(await auditTypes(encounterId)).toEqual([
      'encounter-started',
      'investigation-issued',
      'investigation-issued',
      'investigation-released-instantly',
    ])
    const audit = ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents
    expect(audit.at(-1)?.subject).toBe(cbc.investigationId)

    const missing = await releaseNow(encounterId, 'no-such-investigation')
    expect(missing.status).toBe(404)
    expect(await errorCode(missing)).toBe('investigation-not-found')
  })

  it('refuses commands with case-version-retired once its Golden Case version is retired, but keeps reading', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations
    await retireCaseVersion(encounterId)

    const instant = await releaseNow(encounterId, cbc.investigationId)
    expect(instant.status).toBe(409)
    expect(await errorCode(instant)).toBe('case-version-retired')
    vi.setSystemTime(T0 + 100_000)
    const issueAfter = await issue(encounterId, ['pct'])
    expect(issueAfter.status).toBe(409)
    expect(await errorCode(issueAfter)).toBe('case-version-retired')
    // Due Reports stay unreleased rather than resolve from a retired Case Truth, and 已出报告 is not shown as reached.
    const list = await investigations(encounterId)
    expect(list.map((i) => i.reports)).toEqual([[], []])
    expect(byItem(list, 'cbc').stages.map((s) => s.name)).toEqual(['已开立', '已采样', '检验中'])
    expect(await auditTypes(encounterId)).toEqual(['encounter-started', 'investigation-issued', 'investigation-issued'])
  })

  it('keeps released and acknowledged Reports of an abandoned Encounter readable after its case version is retired', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations
    const released = ((await (await releaseNow(encounterId, cbc.investigationId)).json()) as InvestigationsResponse).investigations
    await acknowledge(encounterId, [byItem(released, 'cbc').reports[0].reportId])
    vi.setSystemTime(T0 + 100_000)
    await post(`/api/encounters/${encounterId}/abandonment`)
    await retireCaseVersion(encounterId)

    const list = await investigations(encounterId)
    expect(byItem(list, 'cbc').reports).toEqual([
      expect.objectContaining({ version: 1, acknowledgement: expect.objectContaining({ practitionerId: 'demo-practitioner' }) }),
    ])
    expect(byItem(list, 'crp').reports).toEqual([])
  })

  it('stops the clock when the Encounter is abandoned: nothing due later is ever released', async () => {
    const encounterId = await startEncounter()
    await issue(encounterId, ['cbc'])
    vi.setSystemTime(T0 + 40_000)
    await post(`/api/encounters/${encounterId}/abandonment`)
    vi.setSystemTime(T0 + 3_600_000)
    const [cbc] = await investigations(encounterId)
    expect(cbc.stages.map((s) => s.name)).toEqual(['已开立', '已采样'])
    expect(cbc.reports).toEqual([])
  })
})

describe('Report content', () => {
  async function released(catalogItemIds: string[]) {
    const encounterId = await startEncounter()
    const issued = ((await (await issue(encounterId, catalogItemIds)).json()) as InvestigationsResponse).investigations
    for (const i of issued) await releaseNow(encounterId, i.investigationId)
    return { encounterId, list: await investigations(encounterId) }
  }

  it('resolves results from Case Truth overrides with reference ranges and ↑/↓ flags', async () => {
    const { list } = await released(['cbc', 'crp', 'cxr'])
    const [cbcReport] = byItem(list, 'cbc').reports
    expect(cbcReport).toEqual({
      reportId: expect.any(String),
      version: 1,
      releasedAt: at(0),
      reporter: '王丽（检验师）',
      reviewer: '陈刚（主管检验师）',
      specimenOrSite: '静脉血 · EDTA 紫帽',
      correctionReason: null,
      acknowledgement: null,
      body: {
        kind: 'results',
        results: [
          row('白细胞计数 WBC', 14.2, '×10⁹/L', '3.5–9.5', 'high'),
          row('中性粒细胞百分比 NEUT%', 86.1, '%', '40–75', 'high'),
          row('淋巴细胞百分比 LYM%', 9.2, '%', '20–50', 'low'),
          row('红细胞计数 RBC', 4.82, '×10¹²/L', '4.3–5.8', null),
          row('血红蛋白 HGB', 142, 'g/L', '130–175', null),
          row('血小板计数 PLT', 236, '×10⁹/L', '125–350', null),
        ],
      },
    })
    expect(byItem(list, 'crp').reports[0].body).toEqual({ kind: 'results', results: [row('C 反应蛋白 CRP', 86, 'mg/L', '0–8', 'high')] })
    const truthCxr = casePack.cases[0].textResults.find((t) => t.catalogItem === 'cxr')!
    expect(byItem(list, 'cxr').reports[0]).toEqual(
      expect.objectContaining({
        reporter: '刘洋（放射科医师）',
        specimenOrSite: '胸部 · 正侧位',
        body: { kind: 'narrative', findings: truthCxr.findings, impression: truthCxr.impression },
      }),
    )
  })

  it('resolves every other item from the baseline rule for the patient’s age and sex', async () => {
    const { list } = await released(['renal', 'urinalysis', 'nt-probnp', 'ecg'])
    // Golden Case 1 is a 58-year-old man: the male band from birth, not the 60+ band or the female one.
    expect(byItem(list, 'renal').reports[0].body).toEqual({
      kind: 'results',
      results: [
        row('尿素 UREA', 5.4, 'mmol/L', '3.1–8.0', null),
        row('肌酐 CREA', 82, 'μmol/L', '57–97', null),
        row('尿酸 UA', 350, 'μmol/L', '208–428', null),
      ],
    })
    expect(byItem(list, 'nt-probnp').reports[0].body).toEqual({
      kind: 'results',
      results: [row('N 末端脑钠肽前体 NT-proBNP', 80, 'ng/L', '<125', null)],
    })
    const urinalysis = byItem(list, 'urinalysis').reports[0].body
    expect(urinalysis.kind === 'results' && urinalysis.results.find((r) => r.analyteId === 'ua-nit')).toEqual(
      row('亚硝酸盐 NIT', '阴性', '', '阴性', null),
    )
    expect(byItem(list, 'ecg').reports[0]).toEqual(
      expect.objectContaining({
        reporter: '孙婷（心电图医师）',
        body: expect.objectContaining({ kind: 'narrative', impression: '窦性心律，正常心电图。' }),
      }),
    )
  })
})

describe('Report Acknowledgement', () => {
  it('is not implied by reading the Report, and records time and practitioner when confirmed', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc'])).json()) as InvestigationsResponse).investigations
    await releaseNow(encounterId, cbc.investigationId)
    await investigations(encounterId)
    const [{ reports }] = await investigations(encounterId)
    expect(reports[0].acknowledgement).toBeNull()

    vi.setSystemTime(T0 + 20_000)
    const response = await acknowledge(encounterId, [reports[0].reportId])
    expect(response.status).toBe(200)
    const [after] = ((await response.json()) as InvestigationsResponse).investigations
    expect(after.reports[0].acknowledgement).toEqual({ acknowledgedAt: at(20), practitionerId: 'demo-practitioner' })
    expect(await auditTypes(encounterId)).toEqual([
      'encounter-started',
      'investigation-issued',
      'investigation-released-instantly',
      'report-acknowledged',
    ])

    const again = await acknowledge(encounterId, [reports[0].reportId])
    expect(again.status).toBe(409)
    expect(await errorCode(again)).toBe('report-already-acknowledged')
  })

  it('acknowledges only the latest version: a superseded one is refused and a batch containing it acknowledges nothing', async () => {
    const encounterId = await startEncounter()
    const issued = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations
    for (const i of issued) await releaseNow(encounterId, i.investigationId)
    const list = await investigations(encounterId)
    const cbcV1 = byItem(list, 'cbc').reports[0].reportId
    const crpV1 = byItem(list, 'crp').reports[0].reportId
    // The CBC amendment publishes 120 s after version 1, the CRP one only at 150 s.
    vi.setSystemTime(T0 + 130_000)
    const cbcV2 = byItem(await investigations(encounterId), 'cbc').reports[1].reportId

    for (const reportIds of [[cbcV1], [crpV1, cbcV1]]) {
      const response = await acknowledge(encounterId, reportIds)
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('report-superseded')
    }
    const unchanged = await investigations(encounterId)
    expect(unchanged.flatMap((i) => i.reports.map((r) => r.acknowledgement))).toEqual([null, null, null])

    const latest = await acknowledge(encounterId, [cbcV2])
    expect(latest.status).toBe(200)
    const [cbc] = ((await latest.json()) as InvestigationsResponse).investigations
    expect(cbc.reports.map((r) => [r.version, r.acknowledgement?.practitionerId ?? null])).toEqual([
      [1, null],
      [2, 'demo-practitioner'],
    ])
    const audit = ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents
    expect(audit.filter((e) => e.eventType === 'report-acknowledged').map((e) => e.subject)).toEqual([cbcV2])
  })

  it('acknowledges several latest-version Reports in one command, each with time and practitioner and its own audit event', async () => {
    const encounterId = await startEncounter()
    const issued = ((await (await issue(encounterId, ['cbc', 'crp', 'cxr'])).json()) as InvestigationsResponse).investigations
    for (const i of issued) await releaseNow(encounterId, i.investigationId)
    const reportIds = (await investigations(encounterId)).map((i) => i.reports[0].reportId)

    vi.setSystemTime(T0 + 40_000)
    const response = await acknowledge(encounterId, reportIds)
    expect(response.status).toBe(200)
    const list = ((await response.json()) as InvestigationsResponse).investigations
    expect(list.map((i) => i.reports[0].acknowledgement)).toEqual(
      reportIds.map(() => ({ acknowledgedAt: at(40), practitionerId: 'demo-practitioner' })),
    )
    const audit = ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents
    expect(audit.filter((e) => e.eventType === 'report-acknowledged')).toEqual(
      reportIds.map((subject) => ({ eventType: 'report-acknowledged', practitionerId: 'demo-practitioner', occurredAt: at(40), subject })),
    )
  })

  it('refuses unknown or malformed Report ids without acknowledging any of the batch', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc'])).json()) as InvestigationsResponse).investigations
    await releaseNow(encounterId, cbc.investigationId)
    const [{ reports }] = await investigations(encounterId)

    const unknown = await acknowledge(encounterId, [reports[0].reportId, 'no-such-report'])
    expect(unknown.status).toBe(404)
    expect(await errorCode(unknown)).toBe('report-not-found')
    for (const ids of [[], [reports[0].reportId, reports[0].reportId], undefined]) {
      expect((await acknowledge(encounterId, ids)).status).toBe(400)
    }
    const [after] = await investigations(encounterId)
    expect(after.reports[0].acknowledgement).toBeNull()
  })

  it('answers 404 for investigations of an Encounter that does not exist', async () => {
    for (const response of [
      await api('/api/encounters/no-such-encounter/investigations'),
      await issue('no-such-encounter', ['cbc']),
      await acknowledge('no-such-encounter', ['r']),
    ]) {
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('encounter-not-found')
    }
  })
})

describe('Report amendments', () => {
  const amendment = (catalogItem: string) => casePack.cases[0].reportAmendments.find((a) => a.catalogItem === catalogItem)!

  it('publishes a scripted amendment as a new version with its correction reason at its scripted time', async () => {
    const encounterId = await startEncounter()
    await issue(encounterId, ['cbc', 'cxr', 'renal'])
    // CBC version 1 is due at 90 s, the chest X-ray at 150 s; their amendments 120 s and 180 s later.
    vi.setSystemTime(T0 + 209_000)
    let list = await investigations(encounterId)
    expect(byItem(list, 'cbc').reports.map((r) => r.version)).toEqual([1])

    vi.setSystemTime(T0 + 210_000)
    list = await investigations(encounterId)
    const [v1, v2] = byItem(list, 'cbc').reports
    expect(v2).toEqual({
      reportId: expect.any(String),
      version: 2,
      releasedAt: at(210),
      reporter: v1.reporter,
      reviewer: v1.reviewer,
      specimenOrSite: v1.specimenOrSite,
      correctionReason: amendment('cbc').reason,
      acknowledgement: null,
      body: {
        kind: 'results',
        results: [
          row('白细胞计数 WBC', 15.0, '×10⁹/L', '3.5–9.5', 'high'),
          row('中性粒细胞百分比 NEUT%', 87.4, '%', '40–75', 'high'),
          row('淋巴细胞百分比 LYM%', 8.8, '%', '20–50', 'low'),
          row('红细胞计数 RBC', 4.82, '×10¹²/L', '4.3–5.8', null),
          row('血红蛋白 HGB', 142, 'g/L', '130–175', null),
          row('血小板计数 PLT', 236, '×10⁹/L', '125–350', null),
        ],
      },
    })
    expect(v1).toEqual(expect.objectContaining({ version: 1, releasedAt: at(90), correctionReason: null }))
    expect(byItem(list, 'cbc').stages.at(-1)).toEqual({ name: '已出报告', at: at(90) })

    expect(byItem(list, 'cxr').reports.map((r) => r.version)).toEqual([1])
    vi.setSystemTime(T0 + 330_000)
    const cxr = byItem(await investigations(encounterId), 'cxr')
    expect(cxr.reports[1]).toEqual(
      expect.objectContaining({
        version: 2,
        releasedAt: at(330),
        correctionReason: amendment('cxr').reason,
        body: { kind: 'narrative', ...amendment('cxr').textOverride },
      }),
    )

    vi.setSystemTime(T0 + 3_600_000)
    expect(byItem(await investigations(encounterId), 'renal').reports.map((r) => r.version)).toEqual([1])
  })

  it('reopens an acknowledged Report as unacknowledged and keeps the earlier acknowledgement on the superseded version', async () => {
    const encounterId = await startEncounter()
    const [crp] = ((await (await issue(encounterId, ['crp'])).json()) as InvestigationsResponse).investigations
    await releaseNow(encounterId, crp.investigationId)
    const [{ reports: [v1] }] = await investigations(encounterId)
    vi.setSystemTime(T0 + 30_000)
    await acknowledge(encounterId, [v1.reportId])

    vi.setSystemTime(T0 + 150_000)
    const [amended] = await investigations(encounterId)
    expect(amended.reports.map((r) => [r.version, r.correctionReason, r.acknowledgement])).toEqual([
      [1, null, { acknowledgedAt: at(30), practitionerId: 'demo-practitioner' }],
      [2, amendment('crp').reason, null],
    ])
    expect(amended.reports[1].body).toEqual({ kind: 'results', results: [row('C 反应蛋白 CRP', 112, 'mg/L', '0–8', 'high')] })

    vi.setSystemTime(T0 + 160_000)
    const response = await acknowledge(encounterId, [amended.reports[1].reportId])
    expect(response.status).toBe(200)
    const [after] = ((await response.json()) as InvestigationsResponse).investigations
    expect(after.reports.map((r) => r.acknowledgement?.acknowledgedAt)).toEqual([at(30), at(160)])
  })

  it('keeps a scripted amendment out of releasedReports, the one read of Report content, until it publishes', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc'])).json()) as InvestigationsResponse).investigations
    await releaseNow(encounterId, cbc.investigationId)
    const read = (seconds: number) =>
      runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
        const encounters = new EncounterRepository(state.storage.sql)
        const found = encounters.get(encounterId)
        if (!found.ok) throw new Error(found.error.message)
        const written = state.storage.sql
          .exec('SELECT version FROM report WHERE investigation_id = ? ORDER BY version', cbc.investigationId)
          .toArray()
          .map((r) => r.version)
        const released = new InvestigationRepository(state.storage.sql, encounters).releasedReports(found.encounter, T0 + seconds * 1000)
        return { written, released: released.map((r) => [r.investigationId, r.version, r.correctionReason]) }
      })

    // The amendment is already written, 120 s ahead, yet absent from the accessor until then.
    expect(await read(119)).toEqual({ written: [1, 2], released: [[cbc.investigationId, 1, null]] })
    expect((await read(120)).released).toEqual([
      [cbc.investigationId, 1, null],
      [cbc.investigationId, 2, amendment('cbc').reason],
    ])
  })

  it('never publishes an amendment scripted after the Encounter ended', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc'])).json()) as InvestigationsResponse).investigations
    await releaseNow(encounterId, cbc.investigationId)
    vi.setSystemTime(T0 + 60_000)
    await post(`/api/encounters/${encounterId}/abandonment`)
    vi.setSystemTime(T0 + 3_600_000)
    const [after] = await investigations(encounterId)
    expect(after.reports.map((r) => r.version)).toEqual([1])
  })
})

describe('cancelling an Investigation', () => {
  const cancel = (encounterId: string, investigationId: string) =>
    post(`/api/encounters/${encounterId}/investigations/${investigationId}/cancellation`)

  it('cancels before the first Report, audited with the practitioner; it then never advances or reports', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations
    vi.setSystemTime(T0 + 40_000)
    const response = await cancel(encounterId, cbc.investigationId)
    expect(response.status).toBe(200)
    const afterCancel = ((await response.json()) as InvestigationsResponse).investigations
    expect(byItem(afterCancel, 'cbc').cancellation).toEqual({ cancelledAt: at(40), practitionerId: 'demo-practitioner' })
    expect(byItem(afterCancel, 'crp').cancellation).toBeNull()

    vi.setSystemTime(T0 + 3_600_000)
    const later = byItem(await investigations(encounterId), 'cbc')
    expect(later.stages).toEqual([
      { name: '已开立', at: at(0) },
      { name: '已采样', at: at(30) },
    ])
    expect(later.reports).toEqual([])
    expect(byItem(await investigations(encounterId), 'crp').reports).not.toEqual([])

    for (const refused of [await cancel(encounterId, cbc.investigationId), await releaseNow(encounterId, cbc.investigationId)]) {
      expect(refused.status).toBe(409)
      expect(await errorCode(refused)).toBe('investigation-cancelled')
    }
    const audit = ((await (await api(`/api/encounters/${encounterId}/audit-events`)).json()) as AuditEventsResponse).auditEvents
    expect(audit.filter((e) => e.eventType === 'investigation-cancelled')).toEqual([
      { eventType: 'investigation-cancelled', practitionerId: 'demo-practitioner', occurredAt: at(40), subject: cbc.investigationId },
    ])
  })

  it('is refused once the first Report exists, including one that came due without being read', async () => {
    const encounterId = await startEncounter()
    const [cbc, crp] = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations
    await releaseNow(encounterId, cbc.investigationId)
    vi.setSystemTime(T0 + 91_000)

    for (const investigation of [cbc, crp]) {
      const response = await cancel(encounterId, investigation.investigationId)
      expect(response.status, investigation.catalogItemId).toBe(409)
      expect(await errorCode(response)).toBe('investigation-already-reported')
    }
    const list = await investigations(encounterId)
    expect(list.map((i) => [i.cancellation, i.reports.length])).toEqual([
      [null, 1],
      [null, 1],
    ])
    expect(await auditTypes(encounterId)).not.toContain('investigation-cancelled')

    const missing = await cancel(encounterId, 'no-such-investigation')
    expect(missing.status).toBe(404)
    expect(await errorCode(missing)).toBe('investigation-not-found')
  })

  it('lets the doctor issue a cancelled item again as a new Investigation', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc'])).json()) as InvestigationsResponse).investigations
    await cancel(encounterId, cbc.investigationId)

    const again = await issue(encounterId, ['cbc'])
    expect(again.status).toBe(201)
    const list = ((await again.json()) as InvestigationsResponse).investigations
    expect(list.map((i) => [i.catalogItemId, i.cancellation === null])).toEqual([
      ['cbc', false],
      ['cbc', true],
    ])
    expect(list[1].investigationId).not.toBe(cbc.investigationId)
    expect((await issue(encounterId, ['cbc'])).status).toBe(409)
  })
})
