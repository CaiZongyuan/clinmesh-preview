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
import { admitCatalog, flagFor, type CatalogItem, type RawCatalog } from '../../src/worker/investigation-catalog'

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
      { ...cxr, id: 'no-narrative', narrative: undefined },
    ]
    const admitted = admitCatalog({ ...catalog, items: [...catalog.items, ...refused] }).items.map((item) => item.id)
    expect(admitted).toEqual(catalog.items.map((item) => item.id))
  })

  it('agrees with every Golden Case override on the item, analyte, reference range and abnormal flag', () => {
    const items = (rawCatalog as RawCatalog).items
    for (const goldenCase of casePack.cases) {
      for (const lab of goldenCase.laboratories) {
        const analyte = items.find((item) => item.id === lab.catalogItem)?.analytes?.find((a) => a.id === lab.id)
        expect(analyte, `${goldenCase.id} ${lab.id}`).toBeDefined()
        const band = analyte!.baseline!.find((b) => b.sex === 'any' || b.sex === goldenCase.patient.gender)!
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
      reports: [],
    })
    expect(await investigations(encounterId)).toEqual(issued)
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

    const missing = await releaseNow(encounterId, 'no-such-investigation')
    expect(missing.status).toBe(404)
    expect(await errorCode(missing)).toBe('investigation-not-found')
  })

  it('refuses with case-version-retired, releasing nothing, when a Report comes due after its Golden Case version is retired', async () => {
    const encounterId = await startEncounter()
    const [cbc] = ((await (await issue(encounterId, ['cbc', 'crp'])).json()) as InvestigationsResponse).investigations
    await runInDurableObject(env.CLINIC_WORKSPACE.getByName('default'), (_instance, state) => {
      state.storage.sql.exec(`UPDATE encounter SET case_version = '2026-01-01.0' WHERE encounter_id = ?`, encounterId)
    })

    const instant = await releaseNow(encounterId, cbc.investigationId)
    expect(instant.status).toBe(409)
    expect(await errorCode(instant)).toBe('case-version-retired')
    // Before anything is due, the Encounter's investigations still read; once a Report is due, reads refuse too.
    expect((await investigations(encounterId)).every((i) => i.reports.length === 0)).toBe(true)
    vi.setSystemTime(T0 + 100_000)
    for (const response of [await api(`/api/encounters/${encounterId}/investigations`), await issue(encounterId, ['pct'])]) {
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('case-version-retired')
    }
    expect(await auditTypes(encounterId)).toEqual(['encounter-started', 'investigation-issued', 'investigation-issued'])
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
