import type { EncounterError, EncounterView } from '../shared/encounter'
import {
  INVESTIGATION_STAGES,
  type InvestigationView,
  type ReportBody,
  type ReportView,
} from '../shared/investigation'
import type { EncounterRepository } from './encounter-repository'
import { caseTruth } from './golden-case-pack'
import { catalogItem, reportingStaff, resolveReportBody, scriptedAmendments, type CatalogItem } from './investigation-catalog'

type InvestigationRow = {
  investigation_id: string
  catalog_item_id: string
  practitioner_id: string
  issued_at: string
  stage_times: string
  cancelled_at: string | null
  cancelled_by: string | null
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

// Rows written before amendments existed have no correctionReason; they are all version 1.
type ReportContent = Pick<ReportView, 'reporter' | 'reviewer' | 'specimenOrSite'> & { correctionReason?: string | null; body: ReportBody }

// A released Report version and the Investigation it belongs to.
export interface ReleasedReport extends ReportView {
  investigationId: string
}

export type InvestigationsResult = { ok: true; investigations: InvestigationView[] } | { ok: false; error: EncounterError }

const refuse = (error: EncounterError) => ({ ok: false, error }) as const
const iso = (ms: number) => new Date(ms).toISOString()
const reportTime = (row: InvestigationRow) => (JSON.parse(row.stage_times) as string[]).at(-1)!

// Each stage after 已开立 is planned at an even share of the item's simulated turnaround, to the second.
function plannedStageTimes(item: CatalogItem, issuedAt: number): string[] {
  const stages = INVESTIGATION_STAGES[item.category]
  const step = item.simulatedTurnaroundSeconds / (stages.length - 1)
  return stages.map((_, i) => iso(issuedAt + Math.round(i * step) * 1000))
}

// Stages are planned at issue and the first Report is materialized lazily, on the first command or read at or after
// its planned time, so time handling stays deterministic. Its scripted amendments are written with it, each at its
// own later release time, and every read sees only the versions released by the Encounter's clock, so an
// amendment's content never leaves the server before it publishes. A frozen Encounter's clock stops when it ended.
// Callers run each command inside one storage transaction, so a refused command writes nothing but due Reports.
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
    const issued = new Set(this.rows(encounterId).filter((row) => !row.cancelled_at).map((row) => row.catalog_item_id))
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
      this.encounters.audit(encounterId, 'investigation-issued', practitionerId, iso(now), item.id)
    }
    return { ok: true, investigations: this.list(active.encounter, now) }
  }

  // The simulation's test control: every remaining stage happens now, which releases Report version 1.
  releaseNow(encounterId: string, investigationId: string, practitionerId: string, now: number): InvestigationsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const row = this.find(encounterId, investigationId)
    if (!row) return notFound(investigationId)
    if (row.cancelled_at) return refuse({ code: 'investigation-cancelled', message: '该检查已取消，不会出报告。' })
    const unsettled = this.settle(active.encounter, now)
    if (unsettled) return refuse(unsettled)
    if (!this.hasReleasedReport(active.encounter, investigationId, now)) {
      const truth = caseTruth(active.encounter.caseId, active.encounter.caseVersion)
      if (!truth.ok) return refuse(truth.error)
      const stageTimes = (JSON.parse(row.stage_times) as string[]).map((at) => (at > iso(now) ? iso(now) : at))
      this.sql.exec('UPDATE investigation SET stage_times = ? WHERE investigation_id = ?', JSON.stringify(stageTimes), investigationId)
      this.encounters.audit(encounterId, 'investigation-released-instantly', practitionerId, iso(now), investigationId)
    }
    return { ok: true, investigations: this.list(active.encounter, now) }
  }

  // Cancellation is possible only until the first Report is released, which settling first makes exact.
  cancel(encounterId: string, investigationId: string, practitionerId: string, now: number): InvestigationsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const row = this.find(encounterId, investigationId)
    if (!row) return notFound(investigationId)
    if (row.cancelled_at) return refuse({ code: 'investigation-cancelled', message: '该检查已取消。' })
    const unsettled = this.settle(active.encounter, now)
    if (unsettled) return refuse(unsettled)
    if (this.hasReleasedReport(active.encounter, investigationId, now)) {
      return refuse({ code: 'investigation-already-reported', message: '该检查已出报告，报告发布后不能取消。' })
    }
    this.sql.exec(
      'INSERT INTO investigation_cancellation (investigation_id, practitioner_id, cancelled_at) VALUES (?, ?, ?)',
      investigationId, practitionerId, iso(now),
    )
    this.encounters.audit(encounterId, 'investigation-cancelled', practitionerId, iso(now), investigationId)
    return { ok: true, investigations: this.list(active.encounter, now) }
  }

  // Only the latest released version of a Report can be acknowledged, and only once.
  acknowledge(encounterId: string, reportIds: readonly string[], practitionerId: string, now: number): InvestigationsResult {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const unsettled = this.settle(active.encounter, now)
    if (unsettled) return refuse(unsettled)
    const reports = this.releasedReports(active.encounter, now)
    for (const reportId of reportIds) {
      const report = reports.find((r) => r.reportId === reportId)
      if (!report) return refuse({ code: 'report-not-found', message: `找不到报告 ${reportId}` })
      const latest = Math.max(...reports.filter((r) => r.investigationId === report.investigationId).map((r) => r.version))
      if (report.version !== latest) {
        return refuse({ code: 'report-superseded', message: `第 ${report.version} 版报告已被更正版本替代，请确认最新版本。` })
      }
      if (report.acknowledgement) return refuse({ code: 'report-already-acknowledged', message: '该版本报告已确认已阅。' })
    }
    for (const reportId of reportIds) {
      this.sql.exec(
        'INSERT INTO report_acknowledgement (report_id, practitioner_id, acknowledged_at) VALUES (?, ?, ?)',
        reportId, practitionerId, iso(now),
      )
      this.encounters.audit(encounterId, 'report-acknowledged', practitionerId, iso(now), reportId)
    }
    return { ok: true, investigations: this.list(active.encounter, now) }
  }

  // Reading never refuses: a Report whose Case Truth is retired simply stays unreleased, so Reports already
  // released and acknowledged stay readable. On an abandoned Encounter, settling only records Reports that came
  // due at or before it ended: a past fact, not a write after the freeze.
  list(encounter: EncounterView, now: number): InvestigationView[] {
    this.settle(encounter, now)
    return this.view(encounter, now)
  }

  private view(encounter: EncounterView, now: number): InvestigationView[] {
    const clock = clockOf(encounter, now)
    const released = this.releasedReports(encounter, now)
    return this.rows(encounter.encounterId).map((row): InvestigationView => {
      const item = catalogItem(row.catalog_item_id)!
      const stageTimes = JSON.parse(row.stage_times) as string[]
      const reports = released
        .filter((report) => report.investigationId === row.investigation_id)
        .map(({ investigationId: _, ...report }): ReportView => report)
      // A cancelled Investigation stops where it was; cancellation always happens while the Encounter is active.
      const until = row.cancelled_at ?? clock
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
          // 已出报告 is reached only when a Report exists, which a retired Case Truth can withhold.
          .filter((stage, i) => stage.at <= until && (i < stageTimes.length - 1 || reports.length > 0)),
        cancellation: row.cancelled_at && row.cancelled_by ? { cancelledAt: row.cancelled_at, practitionerId: row.cancelled_by } : null,
        reports,
      }
    })
  }

  // The only read of Report content: every version of the Encounter's Reports released by its clock, oldest first
  // within each Investigation. Scripted amendments are written ahead of their release time, so whatever shows or
  // reasons about Reports must read them here, never from the report table: the investigation list, acknowledgement,
  // cancellation, Completion Gate 2 (#11) and the Clinical Copilot's read_released_reports tool (#12). It does not
  // settle; run a command or `list` first to release Reports that have come due.
  releasedReports(encounter: EncounterView, now: number): ReleasedReport[] {
    return this.sql
      .exec<ReportRow>(
        `SELECT report.report_id, report.investigation_id, version, released_at, content,
           report_acknowledgement.practitioner_id AS acknowledged_by, acknowledged_at
         FROM report
           JOIN investigation ON investigation.investigation_id = report.investigation_id
           LEFT JOIN report_acknowledgement ON report_acknowledgement.report_id = report.report_id
         WHERE investigation.encounter_id = ? AND released_at <= ?
         ORDER BY investigation.rowid, version`,
        encounter.encounterId, clockOf(encounter, now),
      )
      .toArray()
      .map((row) => ({ investigationId: row.investigation_id, ...toReportView(row) }))
  }

  // Writes every Report version 1 that has come due, with its scripted amendments. Refuses, writing nothing,
  // when a due Report's Case Truth is retired.
  private settle(encounter: EncounterView, now: number): EncounterError | null {
    const clock = clockOf(encounter, now)
    const due = this.rows(encounter.encounterId).filter(
      (row) => !row.cancelled_at && reportTime(row) <= clock && !this.isSettled(row.investigation_id),
    )
    if (due.length === 0) return null
    const truth = caseTruth(encounter.caseId, encounter.caseVersion)
    if (!truth.ok) return truth.error
    for (const row of due) {
      const releasedAt = reportTime(row)
      const item = catalogItem(row.catalog_item_id)!
      const staff = { ...reportingStaff(item), specimenOrSite: item.specimenOrSite }
      const body = resolveReportBody(item, encounter.patient, truth.caseTruth)
      this.insertReport(row.investigation_id, 1, releasedAt, { ...staff, correctionReason: null, body })
      scriptedAmendments(item, encounter.patient, truth.caseTruth).forEach((amendment, i) => {
        const amendedAt = iso(Date.parse(releasedAt) + amendment.releaseAfterSeconds * 1000)
        this.insertReport(row.investigation_id, i + 2, amendedAt, { ...staff, correctionReason: amendment.reason, body: amendment.body })
      })
    }
    return null
  }

  private insertReport(investigationId: string, version: number, releasedAt: string, content: ReportContent) {
    this.sql.exec(
      'INSERT INTO report (report_id, investigation_id, version, released_at, content) VALUES (?, ?, ?, ?, ?)',
      crypto.randomUUID(), investigationId, version, releasedAt, JSON.stringify(content),
    )
  }

  private find(encounterId: string, investigationId: string): InvestigationRow | undefined {
    return this.rows(encounterId).find((row) => row.investigation_id === investigationId)
  }

  private rows(encounterId: string): InvestigationRow[] {
    return this.sql
      .exec<InvestigationRow>(
        `SELECT investigation.investigation_id, catalog_item_id, investigation.practitioner_id, issued_at, stage_times,
           cancelled_at, investigation_cancellation.practitioner_id AS cancelled_by
         FROM investigation LEFT JOIN investigation_cancellation USING (investigation_id)
         WHERE encounter_id = ? ORDER BY investigation.rowid`,
        encounterId,
      )
      .toArray()
  }

  private hasReleasedReport(encounter: EncounterView, investigationId: string, now: number): boolean {
    return this.releasedReports(encounter, now).some((report) => report.investigationId === investigationId)
  }

  // Whether settling has written this Investigation's Reports; reads no Report content, only for `settle`.
  private isSettled(investigationId: string): boolean {
    return this.sql.exec('SELECT 1 FROM report WHERE investigation_id = ? LIMIT 1', investigationId).toArray().length > 0
  }
}

const notFound = (investigationId: string) =>
  refuse({ code: 'investigation-not-found', message: `找不到检查申请 ${investigationId}` })

const clockOf = (encounter: EncounterView, now: number) =>
  encounter.endedAt && encounter.endedAt < iso(now) ? encounter.endedAt : iso(now)

function toReportView(row: ReportRow): ReportView {
  const { correctionReason = null, ...content } = JSON.parse(row.content) as ReportContent
  return {
    reportId: row.report_id,
    version: row.version,
    releasedAt: row.released_at,
    ...content,
    correctionReason,
    acknowledgement:
      row.acknowledged_at && row.acknowledged_by
        ? { acknowledgedAt: row.acknowledged_at, practitionerId: row.acknowledged_by }
        : null,
  }
}
