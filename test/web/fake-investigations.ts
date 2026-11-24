import rawCatalog from '../../data/clinic-catalog/investigation-catalog.json'
import type { EncounterError, EncounterView } from '../../src/shared/encounter'
import {
  INVESTIGATION_STAGES,
  type CatalogItemView,
  type InvestigationView,
  type ReportBody,
} from '../../src/shared/investigation'

export const fakeCatalog: CatalogItemView[] = rawCatalog.items.map((item) => ({
  id: item.id,
  name: item.name,
  category: item.category as CatalogItemView['category'],
  pinyinInitials: item.pinyinInitials,
  specimenOrSite: item.specimenOrSite,
  department: item.department,
  expectedTurnaround: item.expectedTurnaround,
}))

const lab = (analyteId: string, name: string, value: number | string, decimals: number, unit: string, referenceRange: string, flag: 'high' | 'low' | null) =>
  ({ analyteId, name, value, decimals, unit, referenceRange, flag })

// What the Worker releases for Golden Case 1; items not listed here release a plain normal narrative.
const REPORT_BODIES: Record<string, ReportBody> = {
  cbc: {
    kind: 'results',
    results: [
      lab('cbc-wbc', '白细胞计数 WBC', 14.2, 1, '×10⁹/L', '3.5–9.5', 'high'),
      lab('cbc-neut-pct', '中性粒细胞百分比 NEUT%', 86.1, 1, '%', '40–75', 'high'),
      lab('cbc-lym-pct', '淋巴细胞百分比 LYM%', 9.2, 1, '%', '20–50', 'low'),
      lab('cbc-rbc', '红细胞计数 RBC', 4.82, 2, '×10¹²/L', '4.3–5.8', null),
      lab('cbc-hgb', '血红蛋白 HGB', 142, 0, 'g/L', '130–175', null),
      lab('cbc-plt', '血小板计数 PLT', 236, 0, '×10⁹/L', '125–350', null),
    ],
  },
  crp: { kind: 'results', results: [lab('crp', 'C 反应蛋白 CRP', 86, 0, 'mg/L', '0–8', 'high')] },
  cxr: { kind: 'narrative', findings: '右肺下叶见斑片状实变影，边界模糊。', impression: '右下肺炎。' },
}

const STAFF: Record<string, { reporter: string; reviewer: string }> = rawCatalog.reportingStaff

type Refuse = (code: EncounterError['code'], message: string) => Response

// The investigation routes of the fake clinic API: issue, instant release and acknowledgement, without any turnaround.
export function createFakeInvestigations(refuse: Refuse) {
  const byEncounter = new Map<string, InvestigationView[]>()
  let sequence = 0
  const list = (encounterId: string) => byEncounter.get(encounterId) ?? []
  const respond = (encounterId: string, status = 200) => Response.json({ investigations: list(encounterId) }, { status })

  function handle(method: string, encounter: EncounterView, action: string, body: unknown): Response | undefined {
    const { encounterId } = encounter
    if (method === 'GET' && action === 'investigations') return respond(encounterId)
    if (method !== 'POST') return undefined
    const isWrite = action === 'investigations' || action === 'report-acknowledgements' || action.endsWith('/instant-release')
    if (!isWrite) return undefined
    if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
    const now = new Date().toISOString()

    if (action === 'investigations') {
      const ids = (body as { catalogItemIds: string[] }).catalogItemIds
      const issued = ids.map((id): InvestigationView => {
        const item = fakeCatalog.find((c) => c.id === id)!
        return {
          investigationId: `investigation-${++sequence}`,
          catalogItemId: id,
          name: item.name,
          category: item.category,
          specimenOrSite: item.specimenOrSite,
          department: item.department,
          practitionerId: 'demo-practitioner',
          issuedAt: now,
          expectedReportAt: new Date(Date.now() + 90_000).toISOString(),
          stages: [{ name: '已开立', at: now }],
          reports: [],
        }
      })
      byEncounter.set(encounterId, [...list(encounterId), ...issued])
      return respond(encounterId, 201)
    }

    if (action === 'report-acknowledgements') {
      const ids = (body as { reportIds: string[] }).reportIds
      for (const investigation of list(encounterId)) {
        for (const report of investigation.reports) {
          if (ids.includes(report.reportId)) report.acknowledgement = { acknowledgedAt: now, practitionerId: 'demo-practitioner' }
        }
      }
      return respond(encounterId)
    }

    const investigationId = action.split('/')[1]
    const investigation = list(encounterId).find((i) => i.investigationId === investigationId)
    if (!investigation) return refuse('investigation-not-found', `找不到检查申请 ${investigationId}`)
    if (investigation.reports.length === 0) {
      investigation.stages = INVESTIGATION_STAGES[investigation.category].map((name, i) => ({ name, at: i ? now : investigation.issuedAt }))
      investigation.reports = [
        {
          reportId: `report-${investigationId}`,
          version: 1,
          releasedAt: now,
          ...STAFF[investigation.department],
          specimenOrSite: investigation.specimenOrSite,
          body: REPORT_BODIES[investigation.catalogItemId] ?? { kind: 'narrative', findings: '未见异常。', impression: '未见明显异常。' },
          acknowledgement: null,
        },
      ]
    }
    return respond(encounterId)
  }

  return { handle, list }
}
