import type { AuditEvent, AuditEventType, EncounterError, EncounterStatus, EncounterView } from '../shared/encounter'
import type { EncounterChart } from './golden-case-pack'

type EncounterRow = {
  encounter_id: string
  case_id: string
  case_version: string
  persona_version: string
  practitioner_id: string
  status: EncounterStatus
  started_at: string
  ended_at: string | null
  visible_chart: string
}

type AuditEventRow = {
  event_type: AuditEventType
  practitioner_id: string
  occurred_at: string
}

export type EncounterResult = { ok: true; encounter: EncounterView } | { ok: false; error: EncounterError }

const refuse = (error: EncounterError) => ({ ok: false, error }) as const
const notFound = (encounterId: string) =>
  refuse({ code: 'encounter-not-found', message: `找不到就诊记录 ${encounterId}` })

// Callers run each command inside one storage transaction, so a refused or failed command writes nothing.
export class EncounterRepository {
  constructor(private readonly sql: SqlStorage) {}

  start(caseId: string, chart: EncounterChart, practitionerId: string, now: string): EncounterResult {
    const active = this.active()
    if (active) {
      return refuse({
        code: 'active-encounter-exists',
        message: `已有进行中的就诊（${active.patient.name}），完诊或放弃该就诊后才能开始新的就诊。`,
      })
    }
    const encounterId = crypto.randomUUID()
    const { caseVersion, personaVersion, ...visibleChart } = chart
    this.sql.exec(
      `INSERT INTO encounter (encounter_id, case_id, case_version, persona_version, practitioner_id, status, started_at, visible_chart)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      encounterId, caseId, caseVersion, personaVersion, practitionerId, now, JSON.stringify(visibleChart),
    )
    this.audit(encounterId, 'encounter-started', practitionerId, now)
    return { ok: true, encounter: this.find(encounterId)! }
  }

  abandon(encounterId: string, practitionerId: string, now: string): EncounterResult {
    const active = this.requireActive(encounterId)
    if (!active.ok) return active
    this.sql.exec(`UPDATE encounter SET status = 'abandoned', ended_at = ? WHERE encounter_id = ?`, now, encounterId)
    this.audit(encounterId, 'encounter-abandoned', practitionerId, now)
    return { ok: true, encounter: this.find(encounterId)! }
  }

  // Every command that writes to an Encounter goes through here, so abandoned and completed ones stay frozen.
  requireActive(encounterId: string): EncounterResult {
    const encounter = this.find(encounterId)
    if (!encounter) return notFound(encounterId)
    if (encounter.status !== 'active') {
      return refuse({ code: 'encounter-not-active', message: '该就诊已结束，写入已冻结。' })
    }
    return { ok: true, encounter }
  }

  get(encounterId: string): EncounterResult {
    const encounter = this.find(encounterId)
    return encounter ? { ok: true, encounter } : notFound(encounterId)
  }

  active(): EncounterView | null {
    const row = this.sql.exec<EncounterRow>(`SELECT * FROM encounter WHERE status = 'active'`).toArray()[0]
    return row ? toView(row) : null
  }

  auditEvents(encounterId: string): { ok: true; auditEvents: AuditEvent[] } | { ok: false; error: EncounterError } {
    if (!this.find(encounterId)) return notFound(encounterId)
    const rows = this.sql
      .exec<AuditEventRow>(
        `SELECT event_type, practitioner_id, occurred_at FROM audit_event WHERE encounter_id = ? ORDER BY audit_event_id`,
        encounterId,
      )
      .toArray()
    return {
      ok: true,
      auditEvents: rows.map((r) => ({ eventType: r.event_type, practitionerId: r.practitioner_id, occurredAt: r.occurred_at })),
    }
  }

  private find(encounterId: string): EncounterView | undefined {
    const row = this.sql.exec<EncounterRow>('SELECT * FROM encounter WHERE encounter_id = ?', encounterId).toArray()[0]
    return row && toView(row)
  }

  audit(encounterId: string, eventType: AuditEventType, practitionerId: string, occurredAt: string) {
    this.sql.exec(
      'INSERT INTO audit_event (encounter_id, event_type, practitioner_id, occurred_at) VALUES (?, ?, ?, ?)',
      encounterId, eventType, practitionerId, occurredAt,
    )
  }
}

function toView(row: EncounterRow): EncounterView {
  return {
    encounterId: row.encounter_id,
    caseId: row.case_id,
    caseVersion: row.case_version,
    personaVersion: row.persona_version,
    status: row.status,
    practitionerId: row.practitioner_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(JSON.parse(row.visible_chart) as Pick<EncounterView, 'patient' | 'triage' | 'visibleSourceHistory'>),
  }
}
