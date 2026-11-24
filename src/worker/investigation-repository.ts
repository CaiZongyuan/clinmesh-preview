import type { EncounterError, EncounterView } from '../shared/encounter'
import {
  INVESTIGATION_STAGES,
  type InvestigationView,
  type ReportBody,
  type ReportView,
} from '../shared/investigation'
import type { EncounterRepository } from './encounter-repository'
import { caseTruth } from './golden-case-pack'
import { catalogItem, reportingStaff, resolveReportBody, type CatalogItem } from './investigation-catalog'

type InvestigationRow = {
  investigation_id: string
  catalog_item_id: string
  practitioner_id: string
  issued_at: string
  stage_times: string
}

type ReportRow = {
  report_id: string
  investigation_id: string
  version: number
  released_at: string
  content: string
  acknowledged_by: string | null
  acknowledged_at: string | null
}

type ReportContent = Pick<ReportView, 'reporter' | 'reviewer' | 'specimenOrSite'> & { body: ReportBody }

export type InvestigationsResult = { ok: true; investigations: InvestigationView[] } | { ok: false; error: EncounterError }

const refuse = (error: EncounterError) => ({ ok: false, error }) as const
const iso = (ms: number) => new Date(ms).toISOString()

// Each stage after 已开立 is planned at an even share of the item's simulated turnaround, to the second.
function plannedStageTimes(item: CatalogItem, issuedAt: number): string[] {
  const stages = INVESTIGATION_STAGES[item.category]
  const step = item.simulatedTurnaroundSeconds / (stages.length - 1)
  return stages.map((_, i) => iso(issuedAt + Math.round(i * step) * 1000))
}

// Stages are planned at issue and the first Report is materialized lazily, on the first command or read at or after
// its planned time, so time handling stays deterministic. A frozen Encounter's clock stops when it ended.
// Callers run each command inside one storage transaction, so a refused command writes nothing.
export class InvestigationRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly encounters: EncounterRepository,
  ) {}

  issue(encounterId: string, catalogItemIds: readonly string[], practitionerId: string, now: number): InvestigationsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const items: CatalogItem[] = []
    for (const id of catalogItemIds) {
      const item = catalogItem(id)
      if (!item) return refuse({ code: 'catalog-item-not-found', message: `检查目录中没有项目 ${id}` })
      items.push(item)
    }
    const unsettled = this.settle(active.encounter, now)
    if (unsettled) return refuse(unsettled)
    const issued = new Set(this.rows(encounterId).map((row) => row.catalog_item_id))
    const again = items.find((item) => issued.has(item.id))
    if (again) {
      return refuse({ code: 'investigation-already-issued', message: `${again.name}已开立，不能重复开立。` })
    }
    for (const item of items) {
      this.sql.exec(
        `INSERT INTO investigation (investigation_id, encounter_id, catalog_item_id, practitioner_id, issued_at, stage_times)
         VALUES (?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), encounterId, item.id, practitionerId, iso(now), JSON.stringify(plannedStageTimes(item, now)),
      )
      this.encounters.audit(encounterId, 'investigation-issued', practitionerId, iso(now))
    }
    return this.list(active.encounter, now)
  }

  // The simulation's test control: every remaining stage happens now, which releases Report version 1.
  releaseNow(encounterId: string, investigationId: string, practitionerId: string, now: number): InvestigationsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const row = this.rows(encounterId).find((r) => r.investigation_id === investigationId)
    if (!row) return refuse({ code: 'investigation-not-found', message: `找不到检查申请 ${investigationId}` })
    const unsettled = this.settle(active.encounter, now)
    if (unsettled) return refuse(unsettled)
    if (this.reportRows(investigationId).length === 0) {
      const truth = caseTruth(active.encounter.caseId, active.encounter.caseVersion)
      if (!truth.ok) return refuse(truth.error)
      const stageTimes = (JSON.parse(row.stage_times) as string[]).map((at) => (at > iso(now) ? iso(now) : at))
      this.sql.exec('UPDATE investigation SET stage_times = ? WHERE investigation_id = ?', JSON.stringify(stageTimes), investigationId)
      this.encounters.audit(encounterId, 'investigation-released-instantly', practitionerId, iso(now))
    }
    return this.list(active.encounter, now)
  }

  // Only the latest version of a Report can be acknowledged, and only once.
  acknowledge(encounterId: string, reportIds: readonly string[], practitionerId: string, now: number): InvestigationsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const unsettled = this.settle(active.encounter, now)
    if (unsettled) return refuse(unsettled)
    const reports = this.rows(encounterId).flatMap((row) => this.reportRows(row.investigation_id))
    for (const reportId of reportIds) {
      const report = reports.find((r) => r.report_id === reportId)
      if (!report) return refuse({ code: 'report-not-found', message: `找不到报告 ${reportId}` })
      const latest = Math.max(...reports.filter((r) => r.investigation_id === report.investigation_id).map((r) => r.version))
      if (report.version !== latest) {
        return refuse({ code: 'report-superseded', message: `第 ${report.version} 版报告已被更正版本替代，请确认最新版本。` })
      }
      if (report.acknowledged_at) return refuse({ code: 'report-already-acknowledged', message: '该版本报告已确认已阅。' })
    }
    for (const reportId of reportIds) {
      this.sql.exec(
        'INSERT INTO report_acknowledgement (report_id, practitioner_id, acknowledged_at) VALUES (?, ?, ?)',
        reportId, practitionerId, iso(now),
      )
      this.encounters.audit(encounterId, 'report-acknowledged', practitionerId, iso(now))
    }
    return this.list(active.encounter, now)
  }

  list(encounter: EncounterView, now: number): InvestigationsResult {
    const unsettled = this.settle(encounter, now)
    if (unsettled) return refuse(unsettled)
    const clock = clockOf(encounter, now)
    const investigations = this.rows(encounter.encounterId).map((row): InvestigationView => {
      const item = catalogItem(row.catalog_item_id)!
      const stageTimes = JSON.parse(row.stage_times) as string[]
      return {
        investigationId: row.investigation_id,
        catalogItemId: item.id,
        name: item.name,
        category: item.category,
        specimenOrSite: item.specimenOrSite,
        department: item.department,
        practitionerId: row.practitioner_id,
        issuedAt: row.issued_at,
        expectedReportAt: stageTimes.at(-1)!,
        stages: INVESTIGATION_STAGES[item.category]
          .map((name, i) => ({ name, at: stageTimes[i] }))
          .filter((stage) => stage.at <= clock),
        reports: this.reportRows(row.investigation_id).map(toReportView),
      }
    })
    return { ok: true, investigations }
  }

  // Releases every Report that has come due. Refuses, writing nothing, when a due Report's Case Truth is retired.
  private settle(encounter: EncounterView, now: number): EncounterError | null {
    const clock = clockOf(encounter, now)
    const due = this.rows(encounter.encounterId).filter(
      (row) => (JSON.parse(row.stage_times) as string[]).at(-1)! <= clock && this.reportRows(row.investigation_id).length === 0,
    )
    if (due.length === 0) return null
    const truth = caseTruth(encounter.caseId, encounter.caseVersion)
    if (!truth.ok) return truth.error
    for (const row of due) {
      const releasedAt = (JSON.parse(row.stage_times) as string[]).at(-1)!
      const item = catalogItem(row.catalog_item_id)!
      const content: ReportContent = {
        ...reportingStaff(item),
        specimenOrSite: item.specimenOrSite,
        body: resolveReportBody(item, encounter.patient, truth.caseTruth),
      }
      this.sql.exec(
        'INSERT INTO report (report_id, investigation_id, version, released_at, content) VALUES (?, ?, 1, ?, ?)',
        crypto.randomUUID(), row.investigation_id, releasedAt, JSON.stringify(content),
      )
    }
    return null
  }

  private rows(encounterId: string): InvestigationRow[] {
    return this.sql
      .exec<InvestigationRow>(
        `SELECT investigation_id, catalog_item_id, practitioner_id, issued_at, stage_times
         FROM investigation WHERE encounter_id = ? ORDER BY rowid`,
        encounterId,
      )
      .toArray()
  }

  private reportRows(investigationId: string): ReportRow[] {
    return this.sql
      .exec<ReportRow>(
        `SELECT report.report_id, investigation_id, version, released_at, content,
           report_acknowledgement.practitioner_id AS acknowledged_by, acknowledged_at
         FROM report LEFT JOIN report_acknowledgement USING (report_id)
         WHERE investigation_id = ? ORDER BY version`,
        investigationId,
      )
      .toArray()
  }
}

const clockOf = (encounter: EncounterView, now: number) =>
  encounter.endedAt && encounter.endedAt < iso(now) ? encounter.endedAt : iso(now)

function toReportView(row: ReportRow): ReportView {
  const content = JSON.parse(row.content) as ReportContent
  return {
    reportId: row.report_id,
    version: row.version,
    releasedAt: row.released_at,
    ...content,
    acknowledgement:
      row.acknowledged_at && row.acknowledged_by
        ? { acknowledgedAt: row.acknowledged_at, practitionerId: row.acknowledged_by }
        : null,
  }
}
