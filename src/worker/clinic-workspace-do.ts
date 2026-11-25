import { DurableObject } from 'cloudflare:workers'
import { isVoiceCapture, MAX_QUESTION_LENGTH, type AskPatientRequest, type ConsultationTurn } from '../shared/consultation'
import { COMPLETION_GATE_LABELS, completionGates, dispositionRecorded, type CaseDebrief, type ClinicalDrafts } from '../shared/completion'
import type { AuditEventType, EncounterError, EncounterView } from '../shared/encounter'
import type { CopilotRead, CopilotReadResult } from './clinical-copilot/copilot-reads'
import { CopilotReadModel } from './copilot-read-model'
import type { GoldenCaseQueueEntry } from '../shared/golden-case-queue'
import type { BodySystem } from '../shared/physical-examination'
import type { NoteSections } from '../shared/clinical-note'
import { DiagnosisRepository, type DiagnosisResult } from './diagnosis-repository'
import { ClinicalNoteRepository, type ClinicalNoteResult } from './clinical-note-repository'
import type { DiagnosisDraftEntry } from '../shared/diagnosis'
import { PrescriptionRepository, type PrescriptionsResult } from './prescription-repository'
import type { PrescriptionLineRequest } from '../shared/medication'
import { ConsultationRepository, type Exchange } from './consultation-repository'
import { EncounterRepository, type EncounterResult } from './encounter-repository'
import { EncounterCompletionRepository } from './encounter-completion-repository'
import { caseTruth, encounterChart, goldenCaseRegistrations, personaFor } from './golden-case-pack'
import { GoldenCaseRepository } from './golden-case-repository'
import { PhysicalExaminationRepository, type PhysicalExaminationResult } from './physical-examination-repository'
import type { InvestigationCatalogResponse } from '../shared/investigation'
import { catalogItem, catalogVersion, catalogView } from './investigation-catalog'
import { medicationCatalog } from './medication-catalog'
import { InvestigationRepository, type InvestigationsResult } from './investigation-repository'
import type { PatientPersona } from './simulated-patient/patient-context'
import type { PatientReplyRequest, PatientTurnSettlement } from './simulated-patient/simulated-patient-do'
import { migrateWorkspaceSchema } from './workspace-schema'

// Phase 1 has no login: every formal write and audit event is attributed to the single demo practitioner.
const DEMO_PRACTITIONER_ID = 'demo-practitioner'

type Refusal = { ok: false; error: EncounterError }
export type ConsultationResult = { ok: true; turns: ConsultationTurn[] } | Refusal
export type ExchangeResult = ({ ok: true } & Exchange) | Refusal
// A recorded exchange, with the persona to ask the Simulated Patient with when it is new (not a resent request).
type Recorded = { ok: true; exchange: Exchange; persona?: PatientPersona } | Refusal

const millis = (value: unknown, fallback: number) => {
  const n = Number(value)
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

export class ClinicWorkspaceDO extends DurableObject<Env> {
  private readonly goldenCases: GoldenCaseRepository
  private readonly encounters: EncounterRepository
  private readonly completion: EncounterCompletionRepository
  private readonly examinations: PhysicalExaminationRepository
  private readonly investigations: InvestigationRepository
  private readonly consultation: ConsultationRepository
  private readonly clinicalNote: ClinicalNoteRepository
  private readonly diagnosis: DiagnosisRepository
  private readonly prescriptions: PrescriptionRepository
  private readonly copilotReads: CopilotReadModel
  // How long the Simulated Patient has to answer, and how much longer the workspace waits for it to say so.
  private readonly turnTimeoutMs: number
  private readonly expiryGraceMs: number

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.goldenCases = new GoldenCaseRepository(ctx.storage.sql)
    this.encounters = new EncounterRepository(ctx.storage.sql)
    this.completion = new EncounterCompletionRepository(ctx.storage.sql)
    this.examinations = new PhysicalExaminationRepository(ctx.storage.sql, this.encounters)
    this.investigations = new InvestigationRepository(ctx.storage.sql, this.encounters)
    this.consultation = new ConsultationRepository(ctx.storage.sql)
    this.clinicalNote = new ClinicalNoteRepository(ctx.storage.sql, this.encounters)
    this.diagnosis = new DiagnosisRepository(ctx.storage.sql, this.encounters)
    this.prescriptions = new PrescriptionRepository(ctx.storage.sql, this.encounters)
    this.copilotReads = new CopilotReadModel(this.encounters, this.examinations, this.investigations, this.consultation)
    this.turnTimeoutMs = millis(env.PATIENT_TURN_TIMEOUT_MS, 30_000)
    this.expiryGraceMs = millis(env.PATIENT_TURN_EXPIRY_GRACE_MS, 5_000)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        migrateWorkspaceSchema(ctx.storage.sql)
        this.goldenCases.reconcile(goldenCaseRegistrations())
      })
    })
  }

  listGoldenCaseQueue(): GoldenCaseQueueEntry[] {
    return this.goldenCases.listQueue()
  }

  startEncounter(caseId: string): EncounterResult {
    const chart = encounterChart(caseId)
    if (!chart) {
      return { ok: false, error: { code: 'golden-case-not-found', message: `找不到 Golden Case ${caseId}` } }
    }
    return this.ctx.storage.transactionSync(() =>
      this.encounters.start(caseId, chart, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  async abandonEncounter(encounterId: string): Promise<EncounterResult> {
    const result = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const result = this.encounters.abandon(encounterId, DEMO_PRACTITIONER_ID, now.toISOString())
      // A frozen Encounter takes no late reply: the waiting patient turn fails with it.
      if (result.ok) this.consultation.failPending(encounterId, 'encounter-ended', now)
      return result
    })
    if (result.ok) await this.freezeCopilot(encounterId)
    return result
  }

  private async freezeCopilot(encounterId: string): Promise<void> {
    // Await outside the transaction. Copilot's freeze hook only updates its own storage.
    try {
      await this.env.CLINICAL_COPILOT.getByName(encounterId).freeze(encounterId)
    } catch (error) {
      console.error('Clinical Copilot freeze failed', encounterId, error)
    }
  }

  async completeEncounter(encounterId: string): Promise<EncounterResult> {
    const result = this.ctx.storage.transactionSync((): EncounterResult => {
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      const now = new Date()
      const diagnosis = this.diagnosis.view(encounterId)
      const prescriptions = this.prescriptions.view(encounterId)
      const note = this.clinicalNote.view(encounterId)
      if (!diagnosis.ok) return diagnosis
      if (!prescriptions.ok) return prescriptions
      if (!note.ok) return note
      const investigations = this.investigations.list(active.encounter, now.getTime())
      const failedGates = completionGates(
        diagnosis.diagnosis, investigations, prescriptions.prescriptions,
        note.note.revisions.at(-1), this.completion.drafts(encounterId),
      ).filter((gate) => !gate.met).map((gate) => gate.id)
      if (failedGates.length) {
        return { ok: false, error: {
          code: 'completion-gates-unmet',
          message: `未满足完诊条件：${failedGates.map((gate) => COMPLETION_GATE_LABELS[gate]).join('、')}`,
          failedGates,
        } }
      }
      const truth = caseTruth(active.encounter.caseId, active.encounter.caseVersion)
      if (!truth.ok) return truth
      this.completion.recordDebrief(encounterId, truth.caseTruth.debriefReference)
      this.consultation.failPending(encounterId, 'encounter-ended', now)
      return this.encounters.end(encounterId, 'completed', DEMO_PRACTITIONER_ID, now.toISOString())
    })
    if (result.ok) await this.freezeCopilot(encounterId)
    return result
  }

  getCaseDebrief(encounterId: string): { ok: true; debrief: CaseDebrief } | Refusal {
    const found = this.encounters.get(encounterId)
    if (!found.ok) return found
    if (found.encounter.status !== 'completed') {
      return { ok: false, error: { code: 'debrief-locked', message: '完诊后才能查看病例复盘。' } }
    }
    const reference = this.completion.reference(encounterId)
    const diagnosis = this.diagnosis.view(encounterId)
    const prescriptions = this.prescriptions.view(encounterId)
    const examinations = this.examinations.list(encounterId)
    const note = this.clinicalNote.view(encounterId)
    if (!diagnosis.ok) return diagnosis
    if (!prescriptions.ok) return prescriptions
    if (!examinations.ok) return examinations
    if (!note.ok) return note
    const signedNote = note.note.revisions.at(-1)
    if (!reference || !signedNote) {
      return { ok: false, error: { code: 'debrief-locked', message: '该就诊没有可用的病例复盘。' } }
    }
    const questions = this.consultation.list(encounterId)
      .filter((turn) => turn.speaker === 'doctor' && turn.status === 'final')
      .map(({ turnId, text }) => ({ turnId, text }))
    const investigations = this.ctx.storage.transactionSync(() =>
      this.investigations.list(found.encounter, Date.parse(found.encounter.endedAt!)),
    )
    return {
      ok: true,
      debrief: {
        reference, signedNote, questions,
        diagnoses: diagnosis.diagnosis.revisions.at(-1)?.entries ?? [],
        investigations,
        examinations: examinations.examinations,
        prescriptions: prescriptions.prescriptions,
        dispositionRecorded: dispositionRecorded(signedNote.sections.plan ?? ''),
      },
    }
  }

  getClinicalDrafts(encounterId: string): { ok: true; drafts: ClinicalDrafts } | Refusal {
    const found = this.encounters.get(encounterId)
    return found.ok ? { ok: true, drafts: this.completion.drafts(encounterId) } : found
  }

  saveInvestigationDraft(encounterId: string, entries: string[]): { ok: true; drafts: ClinicalDrafts } | Refusal {
    return this.ctx.storage.transactionSync(() => {
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      if (entries.some((id) => !catalogItem(id))) {
        return { ok: false, error: { code: 'catalog-item-not-found', message: '检查目录中未找到草稿项目。' } }
      }
      this.completion.saveDraft(encounterId, 'investigations', entries)
      return { ok: true, drafts: this.completion.drafts(encounterId) }
    })
  }

  savePrescriptionDraft(encounterId: string, entries: ClinicalDrafts['prescriptions']): { ok: true; drafts: ClinicalDrafts } | Refusal {
    return this.ctx.storage.transactionSync(() => {
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      const catalog = medicationCatalog().items
      if (entries.some((entry) => !catalog.some((item) => item.id === entry.drugId))) {
        return { ok: false, error: { code: 'catalog-item-not-found', message: '药品目录中未找到处方草稿项目。' } }
      }
      this.completion.saveDraft(encounterId, 'prescriptions', entries)
      return { ok: true, drafts: this.completion.drafts(encounterId) }
    })
  }

  getEncounter(encounterId: string): EncounterResult {
    return this.encounters.get(encounterId)
  }

  getActiveEncounter(): EncounterView | null {
    return this.encounters.active()
  }

  listAuditEvents(encounterId: string) {
    return this.encounters.auditEvents(encounterId)
  }

  performPhysicalExamination(encounterId: string, system: BodySystem): PhysicalExaminationResult {
    return this.ctx.storage.transactionSync(() =>
      this.examinations.perform(encounterId, system, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  listPhysicalExaminations(encounterId: string) {
    return this.examinations.list(encounterId)
  }

  investigationCatalog(): InvestigationCatalogResponse {
    return { catalogVersion, items: catalogView() }
  }

  // Reading can release a Report that has come due, so it runs as a transaction like a command.
  listInvestigations(encounterId: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() => {
      const found = this.encounters.get(encounterId)
      return found.ok ? { ok: true, investigations: this.investigations.list(found.encounter, Date.now()) } : found
    })
  }

  issueInvestigations(encounterId: string, catalogItemIds: string[]): InvestigationsResult {
    return this.ctx.storage.transactionSync(() => {
      const issued = this.investigations.issue(encounterId, catalogItemIds, DEMO_PRACTITIONER_ID, Date.now())
      if (issued.ok) this.completion.issuedInvestigations(encounterId, catalogItemIds)
      return issued
    })
  }

  releaseInvestigationNow(encounterId: string, investigationId: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() =>
      this.investigations.releaseNow(encounterId, investigationId, DEMO_PRACTITIONER_ID, Date.now()),
    )
  }

  cancelInvestigation(encounterId: string, investigationId: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() =>
      this.investigations.cancel(encounterId, investigationId, DEMO_PRACTITIONER_ID, Date.now()),
    )
  }

  acknowledgeReports(encounterId: string, reportIds: string[]): InvestigationsResult {
    return this.ctx.storage.transactionSync(() =>
      this.investigations.acknowledge(encounterId, reportIds, DEMO_PRACTITIONER_ID, Date.now()),
    )
  }

  getClinicalNote(encounterId: string): ClinicalNoteResult {
    return this.clinicalNote.view(encounterId)
  }

  saveClinicalNoteDraft(encounterId: string, sections: Partial<NoteSections>): ClinicalNoteResult {
    return this.ctx.storage.transactionSync(() =>
      this.clinicalNote.saveDraft(encounterId, sections, 'doctor', new Date().toISOString()),
    )
  }

  signClinicalNote(encounterId: string, sections: NoteSections): ClinicalNoteResult {
    return this.ctx.storage.transactionSync(() =>
      this.clinicalNote.sign(encounterId, sections, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  getDiagnosis(encounterId: string): DiagnosisResult {
    return this.diagnosis.view(encounterId)
  }

  saveDiagnosisDraft(encounterId: string, entries: DiagnosisDraftEntry[]): DiagnosisResult {
    return this.ctx.storage.transactionSync(() =>
      this.diagnosis.saveDraft(encounterId, entries, new Date().toISOString()),
    )
  }

  confirmDiagnosis(encounterId: string, entries: DiagnosisDraftEntry[]): DiagnosisResult {
    return this.ctx.storage.transactionSync(() =>
      this.diagnosis.confirm(encounterId, entries, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  reopenDiagnosis(encounterId: string): DiagnosisResult {
    return this.ctx.storage.transactionSync(() => this.diagnosis.reopen(encounterId, new Date().toISOString()))
  }

  getPrescriptions(encounterId: string): PrescriptionsResult {
    return this.prescriptions.view(encounterId)
  }

  issuePrescription(encounterId: string, lines: PrescriptionLineRequest[]): PrescriptionsResult {
    return this.ctx.storage.transactionSync(() => {
      const issued = this.prescriptions.issue(encounterId, lines, DEMO_PRACTITIONER_ID, new Date().toISOString())
      if (issued.ok) this.completion.issuedPrescriptions(encounterId, lines)
      return issued
    })
  }

  recordNoMedication(encounterId: string): PrescriptionsResult {
    return this.ctx.storage.transactionSync(() =>
      this.prescriptions.recordNoMedication(encounterId, DEMO_PRACTITIONER_ID, new Date().toISOString()),
    )
  }

  getConsultation(encounterId: string): ConsultationResult {
    return this.ctx.storage.transactionSync(() => {
      const found = this.encounters.get(encounterId)
      if (!found.ok) return found
      this.consultation.expireOverdue(encounterId, new Date(), this.expiryGraceMs)
      return { ok: true, turns: this.consultation.list(encounterId) }
    })
  }

  // Records the doctor's question, typed or spoken, and a pending patient turn in one transaction, then asks the
  // Simulated Patient. Typed questions come over HTTP; spoken ones from the voice pipeline or the browser's recognizer.
  async askPatient(encounterId: string, question: AskPatientRequest): Promise<ExchangeResult> {
    const text = question.text.trim()
    if (!text || text.length > MAX_QUESTION_LENGTH || !question.clientTurnId || question.clientTurnId.length > 100) {
      return { ok: false, error: { code: 'invalid-request', message: `提问须为 1–${MAX_QUESTION_LENGTH} 个字符` } }
    }
    if (question.voice !== undefined && !isVoiceCapture(question.voice)) {
      return { ok: false, error: { code: 'invalid-request', message: '语音识别信息无效' } }
    }
    const recorded = this.ctx.storage.transactionSync((): Recorded => {
      const ready = this.readyToAsk(encounterId)
      if (!ready.ok) return ready
      const resent = this.consultation.exchangeFor(encounterId, question.clientTurnId)
      // A resent question whose reply still waits is dispatched again: the first dispatch may never have left
      // (a crash between recording and dispatch), and the Simulated Patient takes each reply once.
      if (resent) return { ok: true, exchange: resent, persona: resent.patientTurn.status === 'pending' ? ready.persona : undefined }
      if (this.consultation.pending(encounterId)) {
        return { ok: false, error: { code: 'patient-turn-pending', message: '患者还在回答上一个问题，请稍候再问。' } }
      }
      const exchange = this.consultation.ask(
        encounterId,
        { clientTurnId: question.clientTurnId, text, practitionerId: DEMO_PRACTITIONER_ID, voice: question.voice },
        ready.now,
        new Date(ready.now.getTime() + this.turnTimeoutMs),
      )
      this.encounters.audit(encounterId, 'consultation-question-asked', DEMO_PRACTITIONER_ID, ready.now.toISOString(), exchange.doctorTurn.turnId)
      return { ok: true, exchange, persona: ready.persona }
    })
    return this.dispatchReply(encounterId, recorded)
  }

  // A failed reply gets a fresh attempt at the same doctor turn; the failed one stays in the record.
  async retryPatientTurn(encounterId: string, patientTurnId: string): Promise<ExchangeResult> {
    const recorded = this.ctx.storage.transactionSync((): Recorded => {
      const ready = this.readyToAsk(encounterId)
      if (!ready.ok) return ready
      const deadline = new Date(ready.now.getTime() + this.turnTimeoutMs)
      const retried = this.consultation.retry(encounterId, patientTurnId, ready.now, deadline)
      if (!retried.ok) return retried
      this.encounters.audit(encounterId, 'patient-reply-retried', DEMO_PRACTITIONER_ID, ready.now.toISOString(), retried.patientTurn.turnId)
      return { ok: true, exchange: retried, persona: ready.persona }
    })
    return this.dispatchReply(encounterId, recorded)
  }

  // Called by the Simulated Patient's outbox, at least once per reply.
  settlePatientTurn(settlement: PatientTurnSettlement): { accepted: boolean } {
    const accepted = this.ctx.storage.transactionSync(() =>
      this.consultation.settle(settlement.encounterId, settlement.patientTurnId, settlement.outcome, new Date(), this.expiryGraceMs),
    )
    if (accepted && settlement.outcome.status === 'final') this.triggerCopilot(settlement.encounterId, settlement.patientTurnId)
    return { accepted }
  }

  // A finalized consultation turn starts the Clinical Copilot's ambient countdown; the trigger is
  // fire-and-forget, so a slow or absent Copilot never blocks settling the patient's reply.
  private triggerCopilot(encounterId: string, patientTurnId: string): void {
    try {
      const doctorTurn = this.consultation.doctorTurnOf(patientTurnId)
      if (!doctorTurn) return
      void this.env.CLINICAL_COPILOT.getByName(encounterId).triggerAnalysis(encounterId, {
        ref: `consultation:${doctorTurn.turnId}`,
        text: `问诊定稿：${doctorTurn.text.slice(0, 80)}`,
      })
    } catch (error) {
      console.error('Copilot trigger failed', error)
    }
  }

  // The Clinical Copilot's only way into the workspace: read-only projections of what the doctor can see.
  readForCopilot<R extends CopilotRead>(encounterId: string, read: R): CopilotReadResult<R['kind']> {
    return this.ctx.storage.transactionSync(() => this.copilotReads.read(encounterId, read, Date.now()))
  }

  // Copilot commands are writes on the Encounter's session: refused once it is frozen, and audited once done.
  authorizeCopilotCommand(encounterId: string): { ok: true; practitionerId: string } | Refusal {
    const active = this.encounters.requireActive(encounterId)
    return active.ok ? { ok: true, practitionerId: DEMO_PRACTITIONER_ID } : active
  }

  // Returns the refusal when the Encounter froze before the audit landed, so a caller that answers 201 on
  // success never reports a successful command without its audit event.
  async auditCopilotCommand(encounterId: string, eventType: AuditEventType, subject: string): Promise<{ ok: true } | Refusal> {
    return this.ctx.storage.transactionSync(() => {
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      this.encounters.audit(encounterId, eventType, DEMO_PRACTITIONER_ID, new Date().toISOString(), subject)
      return { ok: true, value: null }
    })
  }

  // The Encounter is active and its Patient Persona version still exists; an overdue reply has released the lock.
  private readyToAsk(encounterId: string): { ok: true; now: Date; persona: PatientPersona } | Refusal {
    const active = this.encounters.requireActive(encounterId)
    if (!active.ok) return active
    const { caseId, personaVersion } = active.encounter
    const persona = personaFor(caseId, personaVersion)
    if (!persona.ok) return persona
    const now = new Date()
    this.consultation.expireOverdue(encounterId, now, this.expiryGraceMs)
    return { ok: true, now, persona: persona.persona }
  }

  private async dispatchReply(encounterId: string, recorded: Recorded): Promise<ExchangeResult> {
    if (!recorded.ok) return recorded
    const { exchange, persona } = recorded
    if (persona) {
      const request: PatientReplyRequest = {
        encounterId,
        persona,
        doctorTurnId: exchange.doctorTurn.turnId,
        doctorText: exchange.doctorTurn.text,
        patientTurnId: exchange.patientTurn.turnId,
        attempt: exchange.patientTurn.attempt,
        deadlineAt: exchange.patientTurn.deadlineAt!,
      }
      try {
        await this.env.SIMULATED_PATIENT.getByName(encounterId).beginReply(request)
      } catch (error) {
        console.error('Simulated Patient unavailable', error)
        this.ctx.storage.transactionSync(() => this.consultation.failIfPending(request.patientTurnId, 'patient-unavailable', new Date()))
      }
    }
    return { ok: true, doctorTurn: exchange.doctorTurn, patientTurn: this.consultation.find(exchange.patientTurn.turnId)! }
  }
}
