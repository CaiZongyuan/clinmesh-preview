import { DurableObject } from 'cloudflare:workers'
import type {
  AppointmentSlotView,
  AppointmentStatus,
  AppointmentView,
  BookAppointmentRequest,
  PublishPatientReleaseRequest,
  StaffPatientView,
} from '../shared/appointment'
import type {
  ContactView,
  DemoResetResponse,
  DepartmentView,
  DoctorView,
  PatientReleaseResourceType,
  PatientReleaseView,
  Principal,
} from '../shared/auth'
import type {
  AttachmentView,
  ChatMessage,
  ConversationView,
  CreateConversationRequest,
  ImCredentialsResponse,
  InitAttachmentRequest,
  MessagePart,
  SendCommandStatus,
  SendMessageRequest,
  SendMessageResponse,
  TranscriptStatus,
} from '../shared/communication'
import type {
  CreateFollowupPlanRequest,
  FollowupPlanView,
  FollowupResponseView,
  FollowupSummaryView,
  ReviewFollowupSummaryRequest,
  ReviewTaskView,
  SubmitFollowupResponseRequest,
} from '../shared/followup'
import type { DraftAuthor, NoteSection, NoteSections } from '../shared/clinical-note'
import { COMPLETION_GATE_LABELS, completionGates, dispositionRecorded, type CaseDebrief, type ClinicalDrafts } from '../shared/completion'
import { isVoiceCapture, MAX_QUESTION_LENGTH, type AskPatientRequest, type ConsultationTurn } from '../shared/consultation'
import type { CopilotAnalysisEvent, CopilotMention } from '../shared/copilot-turn'
import type { DiagnosisDraftEntry } from '../shared/diagnosis'
import type { DraftAssistance, DraftAssistanceCommand } from '../shared/draft-assistance'
import type { AuditEventType, EncounterError, EncounterView } from '../shared/encounter'
import type { GoldenCaseQueueEntry } from '../shared/golden-case-queue'
import type { InvestigationCatalogResponse } from '../shared/investigation'
import type { PrescriptionLineRequest } from '../shared/medication'
import { BODY_SYSTEM_NAME, type BodySystem } from '../shared/physical-examination'
import { AppointmentRepository } from './appointments/appointment-repository'
import {
  AuthRepository,
  normalizeInviteCode,
  prepareSeedHashes,
  type PatientReleaseDetailResult,
  type PatientReleasesResult,
  type PrincipalResult,
} from './auth/auth-repository'
import { generateOpaqueToken, hashSecret, sha256Hex } from './auth/crypto'
import { AttachmentRepository, signAttachmentAccess } from './communication/attachment-repository'
import { CommunicationRepository } from './communication/communication-repository'
import { createImAdapter, encodeBase64Utf8, type WuKongImEnv } from './communication/wukongim-adapter'
import { FollowupRepository } from './followup/followup-repository'
import { PatientReleaseRepository } from './patient-portal/release-repository'
import { isGreeting } from './clinical-copilot/ambient-drafts'
import type { CopilotNoteMention, CopilotRead, CopilotReadResult } from './clinical-copilot/copilot-reads'
import { ClinicalNoteRepository, type ClinicalNoteResult } from './clinical-note-repository'
import { ConsultationRepository, type Exchange } from './consultation-repository'
import { CopilotReadModel } from './copilot-read-model'
import { DiagnosisRepository, type DiagnosisResult } from './diagnosis-repository'
import { DraftAssistanceRepository, type DraftAssistanceResult } from './draft-assistance-repository'
import { EncounterCompletionRepository } from './encounter-completion-repository'
import { EncounterRepository, type EncounterResult } from './encounter-repository'
import { caseTruth, encounterChart, goldenCaseRegistrations, personaFor } from './golden-case-pack'
import { GoldenCaseRepository } from './golden-case-repository'
import { catalogItem, catalogVersion, catalogView } from './investigation-catalog'
import { InvestigationRepository, type InvestigationsResult } from './investigation-repository'
import { medicationCatalog } from './medication-catalog'
import { PhysicalExaminationRepository, type PhysicalExaminationResult } from './physical-examination-repository'
import { PrescriptionRepository, type PrescriptionsResult } from './prescription-repository'
import type { PatientPersona } from './simulated-patient/patient-context'
import type { PatientReplyRequest, PatientTurnSettlement } from './simulated-patient/simulated-patient-do'
import { clinicMode, type WorkspaceModeEnv } from './workspace-name'
import { migrateWorkspaceSchema } from './workspace-schema'

// Phase 1 simulation mode has no login: formal writes and audits attribute to the single demo practitioner.
const DEMO_PRACTITIONER_ID = 'demo-practitioner'

type Refusal = { ok: false; error: EncounterError }
export type ConsultationResult = { ok: true; turns: ConsultationTurn[] } | Refusal
export type ExchangeResult = ({ ok: true } & Exchange) | Refusal
export type AuthSessionResult = { ok: true; token: string; principal: Principal } | Refusal
// A recorded exchange, with the persona to ask the Simulated Patient with when it is new (not a resent request).
type Recorded = { ok: true; exchange: Exchange; persona?: PatientPersona } | Refusal

const millis = (value: unknown, fallback: number) => {
  const n = Number(value)
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

export class ClinicWorkspaceDO extends DurableObject<Env> {
  private readonly auth: AuthRepository
  private readonly appointments: AppointmentRepository
  private readonly releases: PatientReleaseRepository
  private readonly comm: CommunicationRepository
  private readonly attachments: AttachmentRepository
  private readonly followup: FollowupRepository
  private readonly goldenCases: GoldenCaseRepository
  private readonly encounters: EncounterRepository
  private readonly completion: EncounterCompletionRepository
  private readonly draftAssistance: DraftAssistanceRepository
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
    this.auth = new AuthRepository(ctx.storage.sql)
    this.goldenCases = new GoldenCaseRepository(ctx.storage.sql)
    this.encounters = new EncounterRepository(ctx.storage.sql)
    this.completion = new EncounterCompletionRepository(ctx.storage.sql)
    this.examinations = new PhysicalExaminationRepository(ctx.storage.sql, this.encounters)
    this.investigations = new InvestigationRepository(ctx.storage.sql, this.encounters)
    this.consultation = new ConsultationRepository(ctx.storage.sql)
    this.clinicalNote = new ClinicalNoteRepository(ctx.storage.sql, this.encounters)
    this.diagnosis = new DiagnosisRepository(ctx.storage.sql, this.encounters)
    this.prescriptions = new PrescriptionRepository(ctx.storage.sql, this.encounters)
    this.draftAssistance = new DraftAssistanceRepository(ctx.storage.sql, this.completion, this.diagnosis, this.clinicalNote, this.prescriptions)
    this.copilotReads = new CopilotReadModel(this.encounters, this.examinations, this.investigations, this.consultation, this.clinicalNote)
    this.appointments = new AppointmentRepository(ctx.storage.sql, this.auth, this.encounters)
    this.releases = new PatientReleaseRepository(ctx.storage.sql, this.auth, this.encounters, this.clinicalNote, this.investigations, this.prescriptions)
    this.comm = new CommunicationRepository(ctx.storage.sql, this.auth)
    this.attachments = new AttachmentRepository(ctx.storage.sql, this.auth, this.comm)
    this.followup = new FollowupRepository(ctx.storage.sql, this.auth, this.comm)
    this.turnTimeoutMs = millis(env.PATIENT_TURN_TIMEOUT_MS, 30_000)
    this.expiryGraceMs = millis(env.PATIENT_TURN_EXPIRY_GRACE_MS, 5_000)
    ctx.blockConcurrencyWhile(async () => {
      const seedHashes = clinicMode(env as unknown as WorkspaceModeEnv) === 'connected' ? await prepareSeedHashes() : null
      ctx.storage.transactionSync(() => {
        migrateWorkspaceSchema(ctx.storage.sql)
        this.goldenCases.reconcile(goldenCaseRegistrations())
        if (seedHashes) {
          const nowIso = new Date().toISOString()
          this.auth.ensureSeeded(seedHashes, nowIso)
          this.comm.ensureDemoConversationsSeeded(nowIso)
          this.followup.ensureDemoPlansSeeded(nowIso)
        }
      })
    })
  }

  private async ensureClinicSeeded(): Promise<void> {
    if (this.auth.isSeeded()) {
      this.ctx.storage.transactionSync(() => {
        const nowIso = new Date().toISOString()
        this.comm.ensureDemoConversationsSeeded(nowIso)
        this.followup.ensureDemoPlansSeeded(nowIso)
      })
      return
    }
    const seedHashes = await prepareSeedHashes()
    this.ctx.storage.transactionSync(() => {
      const nowIso = new Date().toISOString()
      this.auth.ensureSeeded(seedHashes, nowIso)
      this.comm.ensureDemoConversationsSeeded(nowIso)
      this.followup.ensureDemoPlansSeeded(nowIso)
    })
  }

  private imAdapter() {
    return createImAdapter(this.env as unknown as WuKongImEnv)
  }

  private attachmentSigningSecret(): string {
    const raw = (this.env as unknown as Record<string, unknown>).ATTACHMENT_SIGNING_SECRET
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    const existing = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM workspace_state WHERE key = 'attachment_signing_secret'`)
      .toArray()[0]
    if (existing) return existing.value
    const generated = generateOpaqueToken()
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_state (key, value) VALUES ('attachment_signing_secret', ?)`,
      generated,
    )
    return this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM workspace_state WHERE key = 'attachment_signing_secret'`)
      .one().value
  }

  private workspaceEpoch(): string {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM workspace_state WHERE key = 'reset_epoch'`)
      .toArray()[0]
    return row?.value ?? '0'
  }

  private bumpWorkspaceEpoch(): void {
    const next = String(Number(this.workspaceEpoch()) + 1)
    this.ctx.storage.sql.exec(
      `INSERT INTO workspace_state (key, value) VALUES ('reset_epoch', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      next,
    )
  }

  // Checks practitioner eligibility inside the same transaction that mutates state, preventing TOCTOU bypass.
  private resolvePractitioner(practitionerId?: string, doctorOnly = true): { ok: true; practitionerId: string } | Refusal {
    if (!practitionerId || practitionerId === DEMO_PRACTITIONER_ID) {
      if (clinicMode(this.env as unknown as WorkspaceModeEnv) === 'connected') {
        return { ok: false, error: { code: 'unauthorized', message: 'Connected Clinic 模式须使用已认证医护身份执行此操作。' } }
      }
      return { ok: true, practitionerId: DEMO_PRACTITIONER_ID }
    }
    const verified = this.auth.verifyActiveStaff(practitionerId, doctorOnly)
    return verified.ok ? { ok: true, practitionerId: verified.staffId } : verified
  }

  // --- Connected Clinic S1 Auth, Directory, Patient Portal & Demo Reset ---

  async loginStaff(username: string, password: string): Promise<AuthSessionResult> {
    await this.ensureClinicSeeded()
    const normalized = username.trim().toLowerCase()
    const passwordHash = await hashSecret(`staff:${normalized}`, password)
    const token = generateOpaqueToken()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const result = this.auth.loginStaff(normalized, passwordHash, tokenHash, new Date())
      return result.ok ? { ok: true, token, principal: result.principal } : result
    })
  }

  async loginWeChat(openid: string, inviteCode?: string): Promise<AuthSessionResult> {
    await this.ensureClinicSeeded()
    const trimmedInvite = inviteCode?.trim()
    const inviteCodeHash = trimmedInvite ? await hashSecret('invite', normalizeInviteCode(trimmedInvite)) : null
    const token = generateOpaqueToken()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const result = this.auth.loginWeChat(openid, inviteCodeHash, tokenHash, new Date())
      return result.ok ? { ok: true, token, principal: result.principal } : result
    })
  }

  async authenticateBearer(token: string): Promise<PrincipalResult> {
    if (!token) return { ok: false, error: { code: 'unauthorized', message: '缺少认证凭据。' } }
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.auth.authenticateSession(tokenHash, new Date())
  }

  async logoutBearer(token: string): Promise<PrincipalResult> {
    if (!token) return { ok: false, error: { code: 'unauthorized', message: '缺少认证凭据。' } }
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const rotated = generateOpaqueToken()
    const result = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const revoked = this.auth.revokeSession(tokenHash, now)
      if (revoked.ok) {
        this.comm.rotateImToken(revoked.principal.actorId, revoked.principal.imUid, rotated, now.toISOString())
      }
      return revoked
    })
    if (result.ok) {
      const im = this.imAdapter()
      await im.kickUserDevice(result.principal.imUid).catch(() => {})
      await im.registerUserToken(result.principal.imUid, rotated).catch(() => {})
    }
    return result
  }

  async listDepartments(token: string): Promise<{ ok: true; departments: DepartmentView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return { ok: true, departments: this.auth.listDepartments() }
  }

  async listDoctors(token: string): Promise<{ ok: true; doctors: DoctorView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return { ok: true, doctors: this.auth.listDoctors() }
  }

  async listContacts(token: string): Promise<{ ok: true; contacts: ContactView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return { ok: true, contacts: this.auth.listContacts(auth.principal) }
  }

  async listPatientReleases(token: string, resourceType: PatientReleaseResourceType): Promise<PatientReleasesResult> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.auth.listPatientReleases(auth.principal, resourceType, now.toISOString())
    })
  }

  async getPatientRelease(token: string, resourceType: PatientReleaseResourceType, id: string): Promise<PatientReleaseDetailResult> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.auth.getPatientRelease(auth.principal, resourceType, id, now.toISOString())
    })
  }

  recordAccessDenial(actorId: string, actorRole: string, action: string, resourceType: string, resourceId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.auth.audit({
        actorId,
        actorRole,
        action,
        resourceType,
        resourceId,
        outcome: 'denied',
        occurredAt: new Date().toISOString(),
      })
    })
  }

  async resetDemoClinic(workspace: string): Promise<DemoResetResponse> {
    const seedHashes = await prepareSeedHashes()
    return this.ctx.storage.transactionSync(() => {
      const nowIso = new Date().toISOString()
      // Clear clinical tables in child-first order (preserving immutable triggers only where unused, or resetting encounters).
      // Clinical revision tables carry immutability triggers, so remove only active/draft tables and re-seed Connected Clinic state.
      this.ctx.storage.sql.exec('DELETE FROM copilot_draft_stop')
      this.ctx.storage.sql.exec('DELETE FROM doctor_draft_touch')
      this.ctx.storage.sql.exec('DELETE FROM copilot_draft_proposal')
      this.ctx.storage.sql.exec('DELETE FROM encounter_draft')
      this.ctx.storage.sql.exec('DELETE FROM case_debrief_reference')
      this.ctx.storage.sql.exec('DELETE FROM no_medication')
      this.ctx.storage.sql.exec('DELETE FROM diagnosis_draft')
      this.ctx.storage.sql.exec('DELETE FROM clinical_note_section')
      this.ctx.storage.sql.exec('DELETE FROM consultation_turn')
      this.ctx.storage.sql.exec('DELETE FROM report_acknowledgement')
      this.ctx.storage.sql.exec('DELETE FROM report')
      this.ctx.storage.sql.exec('DELETE FROM investigation_cancellation')
      this.ctx.storage.sql.exec('DELETE FROM investigation')
      this.ctx.storage.sql.exec('DELETE FROM physical_examination')
      this.ctx.storage.sql.exec('DELETE FROM agent_run_index')
      this.ctx.storage.sql.exec('DELETE FROM review_task')
      this.ctx.storage.sql.exec('DELETE FROM followup_summary')
      this.ctx.storage.sql.exec('DELETE FROM followup_response')
      this.ctx.storage.sql.exec('DELETE FROM followup_task')
      this.ctx.storage.sql.exec('DELETE FROM followup_plan')
      this.ctx.storage.sql.exec('DELETE FROM attachment_blob')
      this.ctx.storage.sql.exec('DELETE FROM attachment')
      this.ctx.storage.sql.exec('DELETE FROM im_user_token')
      this.ctx.storage.sql.exec('DELETE FROM im_message_mirror')
      this.ctx.storage.sql.exec('DELETE FROM send_command')
      this.ctx.storage.sql.exec('DELETE FROM conversation_member')
      this.ctx.storage.sql.exec('DELETE FROM conversation')
      this.ctx.storage.sql.exec('DELETE FROM appointment')
      this.ctx.storage.sql.exec('DELETE FROM audit_event')
      this.ctx.storage.sql.exec(`UPDATE encounter SET status = 'abandoned', ended_at = COALESCE(ended_at, ?) WHERE status = 'active'`, nowIso)
      this.goldenCases.reconcile(goldenCaseRegistrations())
      this.bumpWorkspaceEpoch()
      const summary = this.auth.resetDemo(workspace, seedHashes, nowIso)
      this.comm.ensureDemoConversationsSeeded(nowIso)
      this.followup.ensureDemoPlansSeeded(nowIso)
      return summary
    })
  }

  // --- Phase 1 Outpatient Clinical Commands (with Transactional Practitioner Attribution) ---

  listGoldenCaseQueue(): GoldenCaseQueueEntry[] {
    return this.goldenCases.listQueue()
  }

  startEncounter(caseId: string, practitionerId?: string): EncounterResult {
    const chart = encounterChart(caseId)
    if (!chart) {
      return { ok: false, error: { code: 'golden-case-not-found', message: `找不到 Golden Case ${caseId}` } }
    }
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.encounters.start(caseId, chart, actor.practitionerId, new Date().toISOString())
    })
  }

  async abandonEncounter(encounterId: string, practitionerId?: string): Promise<EncounterResult> {
    const result = this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const now = new Date()
      const result = this.encounters.abandon(encounterId, actor.practitionerId, now.toISOString())
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

  async completeEncounter(encounterId: string, practitionerId?: string): Promise<EncounterResult> {
    const result = this.ctx.storage.transactionSync((): EncounterResult => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
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
        note.note.revisions.at(-1), this.completion.drafts(encounterId), this.draftAssistance.pendingCount(encounterId),
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
      this.appointments.markCompletedByEncounter(encounterId, now.toISOString())
      return this.encounters.end(encounterId, 'completed', actor.practitionerId, now.toISOString())
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

  saveInvestigationDraft(encounterId: string, entries: string[], practitionerId?: string): { ok: true; drafts: ClinicalDrafts } | Refusal {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      if (entries.some((id) => !catalogItem(id))) {
        return { ok: false, error: { code: 'catalog-item-not-found', message: '检查目录中未找到草稿项目。' } }
      }
      this.draftAssistance.touch(encounterId, 'investigations')
      const removed = this.completion.draft(encounterId, 'investigations').filter((id) => !entries.includes(id))
      this.draftAssistance.removeAttribution(encounterId, 'investigations', removed)
      this.completion.saveDraft(encounterId, 'investigations', entries)
      return { ok: true, drafts: this.completion.drafts(encounterId) }
    })
  }

  savePrescriptionDraft(encounterId: string, entries: ClinicalDrafts['prescriptions'], practitionerId?: string): { ok: true; drafts: ClinicalDrafts } | Refusal {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      const catalog = medicationCatalog().items
      if (entries.some((entry) => !catalog.some((item) => item.id === entry.drugId))) {
        return { ok: false, error: { code: 'catalog-item-not-found', message: '药品目录中未找到处方草稿项目。' } }
      }
      this.draftAssistance.touch(encounterId, 'prescriptions')
      const edited = this.completion.draft(encounterId, 'prescriptions').filter((previous) =>
        !entries.some((entry) => entry.drugId === previous.drugId && entry.dose === previous.dose &&
          entry.route === previous.route && entry.frequency === previous.frequency && entry.days === previous.days),
      ).map((entry) => entry.drugId)
      this.draftAssistance.removeAttribution(encounterId, 'prescriptions', edited)
      this.completion.saveDraft(encounterId, 'prescriptions', entries)
      return { ok: true, drafts: this.completion.drafts(encounterId) }
    })
  }

  getDraftAssistance(encounterId: string): { ok: true; assistance: DraftAssistance } | Refusal {
    const found = this.encounters.get(encounterId)
    return found.ok ? { ok: true, assistance: this.draftAssistance.view(encounterId) } : found
  }

  updateDraftAssistance(encounterId: string, command: DraftAssistanceCommand, practitionerId?: string): DraftAssistanceResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const active = this.encounters.requireActive(encounterId)
      return active.ok ? this.draftAssistance.command(active.encounter, command) : active
    })
  }

  getDraftAppliedCounts(encounterId: string): Record<string, number> {
    return this.draftAssistance.appliedCounts(encounterId)
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

  performPhysicalExamination(encounterId: string, system: BodySystem, practitionerId?: string): PhysicalExaminationResult {
    const result = this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.examinations.perform(encounterId, system, actor.practitionerId, new Date().toISOString())
    })
    if (result.ok) this.notifyCopilot(encounterId, { ref: `examination:${system}`, text: `查体完成：${BODY_SYSTEM_NAME[system]}` })
    return result
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

  issueInvestigations(encounterId: string, catalogItemIds: string[], practitionerId?: string): InvestigationsResult {
    const result = this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const issued = this.investigations.issue(encounterId, catalogItemIds, actor.practitionerId, Date.now())
      if (issued.ok) {
        this.completion.issuedInvestigations(encounterId, catalogItemIds)
        this.draftAssistance.removeAttribution(encounterId, 'investigations', catalogItemIds)
      }
      return issued
    })
    if (result.ok) this.wakeReportAnalysis()
    return result
  }

  releaseInvestigationNow(encounterId: string, investigationId: string, practitionerId?: string): InvestigationsResult {
    const result = this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.investigations.releaseNow(encounterId, investigationId, actor.practitionerId, Date.now())
    })
    if (result.ok) this.wakeReportAnalysis()
    return result
  }

  async alarm(): Promise<void> {
    const encounter = this.encounters.active()
    if (!encounter) return
    const now = Date.now()
    const investigations = this.ctx.storage.transactionSync(() => this.investigations.list(encounter, now))
    const released = investigations.flatMap((investigation) => investigation.reports.map((report) => ({
      ref: `report:${report.reportId}`,
      text: `${report.version === 1 ? '报告发布' : '报告更正'}：${investigation.name}（第 ${report.version} 版）`,
      releasedAt: report.releasedAt,
    }))).sort((a, b) => a.releasedAt.localeCompare(b.releasedAt))
    for (const { ref, text } of released) {
      await this.env.CLINICAL_COPILOT.getByName(encounter.encounterId).triggerAnalysis(encounter.encounterId, { ref, text }, false)
    }
    const next = this.investigations.nextReportReleaseAt(encounter.encounterId, now)
    if (next !== null) await this.scheduleReportAnalysis(next)
  }

  private wakeReportAnalysis() {
    this.ctx.waitUntil(this.scheduleReportAnalysis(Date.now()).catch((error) => console.error('Report analysis scheduling failed', error)))
  }

  private async scheduleReportAnalysis(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  cancelInvestigation(encounterId: string, investigationId: string, practitionerId?: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.investigations.cancel(encounterId, investigationId, actor.practitionerId, Date.now())
    })
  }

  acknowledgeReports(encounterId: string, reportIds: string[], practitionerId?: string): InvestigationsResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.investigations.acknowledge(encounterId, reportIds, actor.practitionerId, Date.now())
    })
  }

  getClinicalNote(encounterId: string): ClinicalNoteResult {
    return this.clinicalNote.view(encounterId)
  }

  saveClinicalNoteDraft(
    encounterId: string,
    sections: Partial<NoteSections>,
    authors: Partial<Record<NoteSection, DraftAuthor>> = {},
    practitionerId?: string,
  ): ClinicalNoteResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.clinicalNote.saveDraft(encounterId, sections, authors, new Date().toISOString())
    })
  }

  signClinicalNote(encounterId: string, sections: NoteSections, practitionerId?: string): ClinicalNoteResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.clinicalNote.sign(encounterId, sections, actor.practitionerId, new Date().toISOString())
    })
  }

  getDiagnosis(encounterId: string): DiagnosisResult {
    return this.diagnosis.view(encounterId)
  }

  saveDiagnosisDraft(encounterId: string, entries: DiagnosisDraftEntry[], practitionerId?: string): DiagnosisResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const result = this.diagnosis.saveDraft(encounterId, entries, new Date().toISOString())
      if (result.ok) this.draftAssistance.touch(encounterId, 'diagnosis')
      return result
    })
  }

  confirmDiagnosis(encounterId: string, entries: DiagnosisDraftEntry[], practitionerId?: string): DiagnosisResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.diagnosis.confirm(encounterId, entries, actor.practitionerId, new Date().toISOString())
    })
  }

  reopenDiagnosis(encounterId: string, practitionerId?: string): DiagnosisResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const result = this.diagnosis.reopen(encounterId, new Date().toISOString())
      if (result.ok) this.draftAssistance.touch(encounterId, 'diagnosis')
      return result
    })
  }

  getPrescriptions(encounterId: string): PrescriptionsResult {
    return this.prescriptions.view(encounterId)
  }

  issuePrescription(encounterId: string, lines: PrescriptionLineRequest[], practitionerId?: string): PrescriptionsResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const issued = this.prescriptions.issue(encounterId, lines, actor.practitionerId, new Date().toISOString())
      if (issued.ok) {
        this.completion.issuedPrescriptions(encounterId, lines)
        this.draftAssistance.removeAttribution(encounterId, 'prescriptions', lines.map((line) => line.drugId))
      }
      return issued
    })
  }

  recordNoMedication(encounterId: string, practitionerId?: string): PrescriptionsResult {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      return this.prescriptions.recordNoMedication(encounterId, actor.practitionerId, new Date().toISOString())
    })
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
  async askPatient(encounterId: string, question: AskPatientRequest, practitionerId?: string): Promise<ExchangeResult> {
    const text = question.text.trim()
    if (!text || text.length > MAX_QUESTION_LENGTH || !question.clientTurnId || question.clientTurnId.length > 100) {
      return { ok: false, error: { code: 'invalid-request', message: `提问须为 1–${MAX_QUESTION_LENGTH} 个字符` } }
    }
    if (question.voice !== undefined && !isVoiceCapture(question.voice)) {
      return { ok: false, error: { code: 'invalid-request', message: '语音识别信息无效' } }
    }
    const recorded = this.ctx.storage.transactionSync((): Recorded => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
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
        { clientTurnId: question.clientTurnId, text, practitionerId: actor.practitionerId, voice: question.voice },
        ready.now,
        new Date(ready.now.getTime() + this.turnTimeoutMs),
      )
      this.encounters.audit(encounterId, 'consultation-question-asked', actor.practitionerId, ready.now.toISOString(), exchange.doctorTurn.turnId)
      return { ok: true, exchange, persona: ready.persona }
    })
    return this.dispatchReply(encounterId, recorded)
  }

  // A failed reply gets a fresh attempt at the same doctor turn; the failed one stays in the record.
  async retryPatientTurn(encounterId: string, patientTurnId: string, practitionerId?: string): Promise<ExchangeResult> {
    const recorded = this.ctx.storage.transactionSync((): Recorded => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const ready = this.readyToAsk(encounterId)
      if (!ready.ok) return ready
      const deadline = new Date(ready.now.getTime() + this.turnTimeoutMs)
      const retried = this.consultation.retry(encounterId, patientTurnId, ready.now, deadline)
      if (!retried.ok) return retried
      this.encounters.audit(encounterId, 'patient-reply-retried', actor.practitionerId, ready.now.toISOString(), retried.patientTurn.turnId)
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
    const doctorTurn = this.consultation.doctorTurnOf(patientTurnId)
    if (!doctorTurn || isGreeting(doctorTurn.text)) return
    this.notifyCopilot(encounterId, {
      ref: `consultation:${doctorTurn.turnId}`,
      text: `问诊定稿：${doctorTurn.text.slice(0, 80)}`,
    }, true)
  }

  private notifyCopilot(encounterId: string, event: CopilotAnalysisEvent, debounce = false): void {
    this.ctx.waitUntil(this.env.CLINICAL_COPILOT.getByName(encounterId).triggerAnalysis(encounterId, event, debounce)
      .catch((error) => console.error('Copilot trigger failed', error)))
  }

  // The Clinical Copilot's only way into the workspace: read-only projections of what the doctor can see.
  readForCopilot<R extends CopilotRead>(encounterId: string, read: R): CopilotReadResult<R['kind']> {
    return this.ctx.storage.transactionSync(() => this.copilotReads.read(encounterId, read, Date.now()))
  }

  // Copilot commands are writes on the Encounter's session: refused once it is frozen, and audited once done.
  authorizeCopilotCommand(
    encounterId: string,
    mentions: readonly CopilotMention[] = [],
    practitionerId?: string,
  ): { ok: true; practitionerId: string; noteMentions: CopilotNoteMention[] } | Refusal {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      return { ok: true, practitionerId: actor.practitionerId, noteMentions: this.copilotReads.noteMentions(encounterId, mentions) }
    })
  }

  // Returns the refusal when the Encounter froze before the audit landed, so a caller that answers 201 on
  // success never reports a successful command without its audit event.
  async auditCopilotCommand(encounterId: string, eventType: AuditEventType, subject: string, practitionerId?: string): Promise<{ ok: true } | Refusal> {
    return this.ctx.storage.transactionSync(() => {
      const actor = this.resolvePractitioner(practitionerId, true)
      if (!actor.ok) return actor
      const active = this.encounters.requireActive(encounterId)
      if (!active.ok) return active
      if (eventType === 'copilot-stopped') this.draftAssistance.stopRun(encounterId, subject)
      this.encounters.audit(encounterId, eventType, actor.practitionerId, new Date().toISOString(), subject)
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

  async listAppointmentSlots(
    token: string,
    filters: { departmentId?: string; doctorId?: string; date?: string } = {},
  ): Promise<{ ok: true; slots: AppointmentSlotView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return { ok: true, slots: this.appointments.listSlots(filters) }
  }

  async bookAppointment(
    token: string,
    input: BookAppointmentRequest,
  ): Promise<{ ok: true; appointment: AppointmentView; created: boolean } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.appointments.book(auth.principal, input, now.toISOString())
    })
  }

  async listPatientAppointments(
    token: string,
    status?: AppointmentStatus,
  ): Promise<{ ok: true; appointments: AppointmentView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.appointments.listForPatient(auth.principal, status)
  }

  async cancelAppointment(token: string, appointmentId: string): Promise<{ ok: true; appointment: AppointmentView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.appointments.cancel(auth.principal, appointmentId, now.toISOString())
    })
  }

  async listStaffAppointments(
    token: string,
    filters: { doctorId?: string; status?: AppointmentStatus } = {},
  ): Promise<{ ok: true; appointments: AppointmentView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.appointments.listForStaff(auth.principal, filters)
  }

  async checkInAppointment(token: string, appointmentId: string): Promise<{ ok: true; appointment: AppointmentView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.appointments.checkIn(auth.principal, appointmentId, now.toISOString())
    })
  }

  async startAppointmentEncounter(
    token: string,
    appointmentId: string,
    caseId?: string,
  ): Promise<{ ok: true; appointment: AppointmentView; encounter: EncounterView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.appointments.startEncounter(auth.principal, appointmentId, caseId, now.toISOString())
    })
  }

  async listStaffPatients(token: string): Promise<{ ok: true; patients: StaffPatientView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.appointments.listAuthorizedPatients(auth.principal)
  }

  async publishStaffRelease(
    token: string,
    input: PublishPatientReleaseRequest,
  ): Promise<{ ok: true; item: PatientReleaseView; created: boolean } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.releases.publish(auth.principal, input, now)
    })
  }

  async retractStaffRelease(token: string, releaseId: string): Promise<{ ok: true; releaseId: string } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.releases.retract(auth.principal, releaseId, now.toISOString())
    })
  }

  async listEncounterReleases(token: string, encounterId: string): Promise<{ ok: true; items: PatientReleaseView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.releases.listForEncounter(auth.principal, encounterId)
  }

  async issueImCredentials(token: string): Promise<{ ok: true; credentials: ImCredentialsResponse } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const freshToken = generateOpaqueToken()
    const issued = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      const imToken = this.comm.getOrIssueImToken(auth.principal.actorId, auth.principal.imUid, freshToken, now.toISOString())
      return { ok: true as const, imUid: auth.principal.imUid, token: imToken.token }
    })
    if (!issued.ok) return issued
    const im = this.imAdapter()
    await im.registerUserToken(issued.imUid, issued.token).catch((error) => {
      console.error('WuKongIM registerUserToken failed', error)
    })
    return {
      ok: true,
      credentials: {
        uid: issued.imUid,
        token: issued.token,
        wsUrl: im.wsUrl,
        mode: im.mode,
      },
    }
  }

  async listConversations(token: string): Promise<{ ok: true; conversations: ConversationView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return { ok: true, conversations: this.comm.listConversations(auth.principal) }
  }

  async getConversation(token: string, conversationId: string): Promise<{ ok: true; conversation: ConversationView } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.comm.getConversation(auth.principal, conversationId)
  }

  async createConversation(
    token: string,
    input: CreateConversationRequest,
  ): Promise<{ ok: true; conversation: ConversationView; created: boolean } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const created = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.comm.createConversation(auth.principal, input, now.toISOString())
    })
    if (!created.ok) return created
    if (created.conversation.status === 'provisioning') {
      const im = this.imAdapter()
      try {
        await im.ensureChannel(created.conversation.imChannelId, created.conversation.imChannelType, created.subscriberImUids)
        const activated = this.ctx.storage.transactionSync(() =>
          this.comm.activateProvisionedConversation(created.conversation.conversationId, new Date().toISOString()),
        )
        return { ok: true, conversation: activated ?? created.conversation, created: created.created }
      } catch (error) {
        return {
          ok: false,
          error: { code: 'im-delivery-failed', message: `IM 频道创建失败，请重试：${error instanceof Error ? error.message : String(error)}` },
        }
      }
    }
    return { ok: true, conversation: created.conversation, created: created.created }
  }

  async addConversationMember(
    token: string,
    conversationId: string,
    targetActorId: string,
  ): Promise<{ ok: true; conversation: ConversationView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const updated = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.comm.addMember(auth.principal, conversationId, targetActorId, now.toISOString())
    })
    if (!updated.ok) return updated
    const im = this.imAdapter()
    await im.ensureChannel(
      updated.imChannelId,
      updated.imChannelType,
      updated.conversation.members.filter((m) => m.status === 'active').map((m) => m.imUid),
    ).catch(() => {})
    await im.addSubscribers(updated.imChannelId, updated.imChannelType, [updated.targetImUid]).catch(() => {})
    return { ok: true, conversation: updated.conversation }
  }

  async removeConversationMember(
    token: string,
    conversationId: string,
    targetActorId: string,
  ): Promise<{ ok: true; conversation: ConversationView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const updated = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.comm.removeMember(auth.principal, conversationId, targetActorId, now.toISOString())
    })
    if (!updated.ok) return updated
    await this.imAdapter().removeSubscribers(updated.imChannelId, updated.imChannelType, [updated.targetImUid]).catch(() => {})
    if (targetActorId === 'actor_agent_followup') {
      const doName = `${this.workspaceEpoch()}:${updated.conversation.conversationId}:actor_agent_followup`
      await this.env.FOLLOWUP_AGENT.getByName(doName).haltForRevocation().catch(() => {})
    }
    return { ok: true, conversation: updated.conversation }
  }

  async sendConversationMessage(
    token: string,
    workspaceName: string,
    conversationId: string,
    input: SendMessageRequest,
  ): Promise<{ ok: true; result: SendMessageResponse } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const prep = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      const prepared = this.comm.prepareSendCommand(auth.principal.actorId, 'human', conversationId, input, now.toISOString())
      if (!prepared.ok) return prepared
      return { ok: true as const, principal: auth.principal, prepared: prepared.prepared }
    })
    if (!prep.ok) return prep

    const delivered = await this.executePreparedSend(prep.prepared)
    if (!delivered.ok) return delivered

    const triggeredAgentRuns: SendMessageResponse['triggeredAgentRuns'] = []
    if (delivered.triggerAgents.length > 0 && delivered.message) {
      const userText = input.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'audio' ? `[语音消息${p.transcript ? `: ${p.transcript}` : ''}]` : p.type === 'image' ? '[图片消息]' : `[卡片 ${p.component}]`))
        .join('\n')
      for (const trigger of delivered.triggerAgents) {
        const started = await this.dispatchAgentRunInternal({
          workspaceName,
          principal: prep.principal,
          conversationId,
          agentActorId: trigger.agentActorId,
          externalRef: `msg:${delivered.message.messageId}`,
          userText,
        })
        if (started.ok) {
          triggeredAgentRuns.push({ agentActorId: trigger.agentActorId, runId: started.runId, conversationId })
        }
      }
    }

    return {
      ok: true,
      result: {
        commandId: prep.prepared.commandId,
        status: 'sent' as SendCommandStatus,
        message: delivered.message,
        triggeredAgentRuns,
      },
    }
  }

  async postAgentMessage(
    conversationId: string,
    agentActorId: string,
    clientMessageId: string,
    parts: MessagePart[],
    agentRunId: string,
  ): Promise<{ ok: true; message: ChatMessage | null } | Refusal> {
    const prep = this.ctx.storage.transactionSync(() =>
      this.comm.prepareSendCommand(
        agentActorId,
        'agent',
        conversationId,
        { clientMessageId, parts, mentions: [] },
        new Date().toISOString(),
        { agentRunId },
      ),
    )
    if (!prep.ok) return prep
    const delivered = await this.executePreparedSend(prep.prepared)
    if (!delivered.ok) return delivered
    return { ok: true, message: delivered.message }
  }

  private async executePreparedSend(
    prepared: import('./communication/communication-repository').PreparedSendCommand,
  ): Promise<
    | { ok: true; message: ChatMessage; triggerAgents: Array<{ agentActorId: string; conversationType: import('../shared/communication').ConversationType }> }
    | Refusal
  > {
    if (prepared.mode === 'already_sent' && prepared.existingMessage) {
      return { ok: true, message: prepared.existingMessage, triggerAgents: [] }
    }
    const im = this.imAdapter()
    try {
      await im.ensureChannel(prepared.imChannelId, prepared.imChannelType, prepared.activeMemberImUids)
      let externalMessageId: string | null = null
      let sequence = 0

      if (prepared.mode === 'reconcile') {
        const synced = await im.syncChannelMessages({
          channelId: prepared.imChannelId,
          channelType: prepared.imChannelType,
          loginUid: prepared.senderImUid,
          limit: 50,
        })
        const matched = synced.find((m) => m.clientMsgNo === prepared.clientMessageId)
        if (matched) {
          externalMessageId = matched.messageId
          sequence = matched.messageSeq
        }
      }

      if (!externalMessageId) {
        const sent = await im.sendMessage({
          channelId: prepared.imChannelId,
          channelType: prepared.imChannelType,
          fromUid: prepared.senderImUid,
          clientMsgNo: prepared.clientMessageId,
          payloadBase64: encodeBase64Utf8(prepared.payloadJson),
        })
        externalMessageId = sent.messageId
        sequence = sent.messageSeq
      }

      const settled = this.ctx.storage.transactionSync(() =>
        this.comm.settleSendCommandSuccess(prepared, externalMessageId!, sequence, new Date().toISOString()),
      )
      return { ok: true, message: settled.message, triggerAgents: settled.triggerAgents }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.storage.transactionSync(() => this.comm.settleSendCommandFailure(prepared.commandId, detail, new Date().toISOString()))
      return { ok: false, error: { code: 'im-delivery-failed', message: `消息投递失败（已记录待重试补偿）：${detail}` } }
    }
  }

  async listConversationMessages(
    token: string,
    conversationId: string,
    cursor?: number,
    limit?: number,
  ): Promise<{ ok: true; messages: ChatMessage[]; nextCursor: number | null; hasMore: boolean } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.comm.listMessages(auth.principal, conversationId, { cursor, limit })
  }

  async markConversationRead(
    token: string,
    conversationId: string,
    seq: number,
  ): Promise<{ ok: true; lastReadSeq: number; unreadCount: number } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const auth = this.auth.authenticateSession(tokenHash, new Date())
      if (!auth.ok) return auth
      return this.comm.markRead(auth.principal, conversationId, seq)
    })
  }

  async initAttachment(token: string, input: InitAttachmentRequest): Promise<{ ok: true; attachment: AttachmentView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.attachments.init(auth.principal, input, now.toISOString())
    })
  }

  async uploadAttachmentBytes(
    token: string,
    attachmentId: string,
    dataBase64: string,
    byteLength: number,
    hashHex: string,
  ): Promise<{ ok: true; attachment: AttachmentView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.attachments.upload(auth.principal, attachmentId, dataBase64, byteLength, hashHex, now.toISOString())
    })
  }

  async completeAttachment(
    token: string,
    attachmentId: string,
    transcript: { status: TranscriptStatus; text: string | null },
  ): Promise<{ ok: true; attachment: AttachmentView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.attachments.complete(auth.principal, attachmentId, transcript, now.toISOString())
    })
  }

  async authorizeAttachmentAccess(
    token: string,
    attachmentId: string,
    ttlMs = 300_000,
  ): Promise<{ ok: true; attachment: AttachmentView; actorId: string; exp: number; sig: string; expiresAt: string } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const now = Date.now()
    const checked = this.ctx.storage.transactionSync(() => {
      const auth = this.auth.authenticateSession(tokenHash, new Date(now))
      if (!auth.ok) return auth
      const allowed = this.attachments.authorizeAccess(auth.principal, attachmentId, new Date(now).toISOString())
      if (!allowed.ok) return allowed
      return {
        ok: true as const,
        attachment: allowed.attachment,
        actorId: auth.principal.actorId,
        secret: this.attachmentSigningSecret(),
      }
    })
    if (!checked.ok) return checked
    const exp = now + ttlMs
    const sig = await signAttachmentAccess(checked.secret, attachmentId, checked.actorId, exp)
    return {
      ok: true,
      attachment: checked.attachment,
      actorId: checked.actorId,
      exp,
      sig,
      expiresAt: new Date(exp).toISOString(),
    }
  }

  async readSignedAttachmentContent(
    attachmentId: string,
    actorId: string,
    expMs: number,
    sig: string,
  ): Promise<{ ok: true; mime: string; dataBase64: string } | Refusal> {
    return this.attachments.readSignedContent(attachmentId, actorId, expMs, sig, this.attachmentSigningSecret(), Date.now())
  }

  async startAgentRunForConversation(
    token: string,
    workspaceName: string,
    conversationId: string,
    input: { text: string; clientRequestId: string; agentActorId?: string },
  ): Promise<{ ok: true; runId: string; agentKind: 'patient_service' | 'followup'; created: boolean } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const authorized = this.ctx.storage.transactionSync(() => {
      const auth = this.auth.authenticateSession(tokenHash, new Date())
      if (!auth.ok) return auth
      const conv = this.comm.getConversation(auth.principal, conversationId)
      if (!conv.ok) return conv
      if (conv.conversation.status !== 'active') {
        return { ok: false as const, error: { code: 'conversation-read-only' as const, message: '该会话已只读，不能触发 Agent 运行。' } }
      }
      const targetAgent =
        input.agentActorId ??
        (conv.conversation.type === 'patient_assistant' ? 'actor_agent_patient_svc' : 'actor_agent_followup')
      const hasAgent = conv.conversation.members.some(
        (m) => m.actorId === targetAgent && m.kind === 'agent' && m.status === 'active',
      )
      if (!hasAgent) {
        return { ok: false as const, error: { code: 'conversation-member-forbidden' as const, message: '目标 Agent 不是当前会话的有效成员。' } }
      }
      return { ok: true as const, principal: auth.principal, targetAgent }
    })
    if (!authorized.ok) return authorized
    return this.dispatchAgentRunInternal({
      workspaceName,
      principal: authorized.principal,
      conversationId,
      agentActorId: authorized.targetAgent,
      externalRef: `req:${input.clientRequestId}`,
      userText: input.text,
    })
  }

  private async dispatchAgentRunInternal(input: {
    workspaceName: string
    principal: Principal
    conversationId: string
    agentActorId: string
    externalRef: string
    userText: string
  }): Promise<{ ok: true; runId: string; agentKind: 'patient_service' | 'followup'; created: boolean } | Refusal> {
    const convCtx = this.comm.getConversationContextForAgent(input.conversationId)
    if (!convCtx || convCtx.status !== 'active') {
      return { ok: false, error: { code: 'conversation-read-only', message: '当前会话不可用。' } }
    }
    const epoch = this.workspaceEpoch()
    if (input.agentActorId === 'actor_agent_patient_svc') {
      if (input.principal.role !== 'patient' || !input.principal.patientId || convCtx.type !== 'patient_assistant') {
        return { ok: false, error: { code: 'forbidden', message: '仅患者本人可在私人助手会话中调用 AI 就医助手。' } }
      }
      const doName = `${input.principal.clinicId}:${epoch}:${input.principal.actorId}`
      const started = await this.env.PATIENT_SERVICE_AGENT.getByName(doName).startRun({
        workspaceName: input.workspaceName,
        clinicId: input.principal.clinicId,
        conversationId: input.conversationId,
        patientActorId: input.principal.actorId,
        patientId: input.principal.patientId,
        sessionId: input.principal.sessionId,
        externalRef: input.externalRef,
        userText: input.userText,
      })
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO agent_run_index (run_id, agent_kind, do_name, conversation_id, trigger_actor_id, created_at)
         VALUES (?, 'patient_service', ?, ?, ?, ?)`,
        started.runId,
        doName,
        input.conversationId,
        input.principal.actorId,
        new Date().toISOString(),
      )
      return { ok: true, runId: started.runId, agentKind: 'patient_service', created: started.created }
    }

    const doName = `${epoch}:${input.conversationId}:actor_agent_followup`
    const started = await this.env.FOLLOWUP_AGENT.getByName(doName).startRun({
      workspaceName: input.workspaceName,
      clinicId: input.principal.clinicId,
      conversationId: input.conversationId,
      followupPlanId: convCtx.followupPlanId,
      triggerActorId: input.principal.actorId,
      membershipVersion: convCtx.membershipVersion,
      externalRef: input.externalRef,
      userText: input.userText,
    })
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO agent_run_index (run_id, agent_kind, do_name, conversation_id, trigger_actor_id, created_at)
       VALUES (?, 'followup', ?, ?, ?, ?)`,
      started.runId,
      doName,
      input.conversationId,
      input.principal.actorId,
      new Date().toISOString(),
    )
    return { ok: true, runId: started.runId, agentKind: 'followup', created: started.created }
  }

  async resolveAuthorizedAgentRun(
    token: string,
    runId: string,
  ): Promise<
    | {
        ok: true
        principal: Principal
        agentKind: 'patient_service' | 'followup'
        doName: string
        conversationId: string
        triggerActorId: string
      }
    | Refusal
  > {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const auth = this.auth.authenticateSession(tokenHash, new Date())
      if (!auth.ok) return auth
      const row = this.ctx.storage.sql
        .exec<{ agent_kind: 'patient_service' | 'followup'; do_name: string; conversation_id: string; trigger_actor_id: string }>(
          'SELECT agent_kind, do_name, conversation_id, trigger_actor_id FROM agent_run_index WHERE run_id = ?',
          runId,
        )
        .toArray()[0]
      if (!row || !this.comm.isActiveMember(row.conversation_id, auth.principal.actorId)) {
        return { ok: false, error: { code: 'agent-run-not-found', message: '找不到该 Agent 运行或无权访问。' } }
      }
      return {
        ok: true,
        principal: auth.principal,
        agentKind: row.agent_kind,
        doName: row.do_name,
        conversationId: row.conversation_id,
        triggerActorId: row.trigger_actor_id,
      }
    })
  }

  async createFollowupPlan(
    token: string,
    input: CreateFollowupPlanRequest,
  ): Promise<{ ok: true; plan: FollowupPlanView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const created = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.followup.createPlan(auth.principal, input, now.toISOString())
    })
    if (!created.ok) return created
    try {
      await this.imAdapter().ensureChannel(created.imChannelId, created.imChannelType, created.subscriberImUids)
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'im-delivery-failed',
          message: `随访群 IM 频道创建失败（会话保持 provisioning，未开放写入）：${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
    if (created.plan.conversationId) {
      this.ctx.storage.transactionSync(() => {
        this.comm.activateProvisionedConversation(created.plan.conversationId!, new Date().toISOString())
      })
    }
    return { ok: true, plan: created.plan }
  }

  async listFollowupPlans(token: string): Promise<{ ok: true; plans: FollowupPlanView[] } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return { ok: true, plans: this.followup.listPlans(auth.principal) }
  }

  async getFollowupPlan(token: string, planId: string): Promise<{ ok: true; plan: FollowupPlanView } | Refusal> {
    const auth = await this.authenticateBearer(token)
    if (!auth.ok) return auth
    return this.followup.getPlan(auth.principal, planId)
  }

  async submitFollowupResponse(
    token: string,
    taskId: string,
    input: SubmitFollowupResponseRequest,
  ): Promise<{ ok: true; response: FollowupResponseView; created: boolean } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      const res = this.followup.submitResponse(auth.principal, taskId, input, now.toISOString())
      return res.ok ? { ok: true, response: res.response, created: res.created } : res
    })
  }

  async reviewFollowupSummary(
    token: string,
    summaryId: string,
    input: ReviewFollowupSummaryRequest,
  ): Promise<{ ok: true; summary: FollowupSummaryView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    return this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.followup.reviewSummary(auth.principal, summaryId, input, now.toISOString())
    })
  }

  async closeFollowupPlan(token: string, planId: string): Promise<{ ok: true; plan: FollowupPlanView } | Refusal> {
    await this.ensureClinicSeeded()
    const tokenHash = await sha256Hex(token)
    const closed = this.ctx.storage.transactionSync(() => {
      const now = new Date()
      const auth = this.auth.authenticateSession(tokenHash, now)
      if (!auth.ok) return auth
      return this.followup.closePlan(auth.principal, planId, now.toISOString())
    })
    if (closed.ok && closed.plan.conversationId) {
      const doName = `${this.workspaceEpoch()}:${closed.plan.conversationId}:actor_agent_followup`
      await this.env.FOLLOWUP_AGENT.getByName(doName).haltForRevocation().catch(() => {})
    }
    return closed
  }

  agentListDepartments(): DepartmentView[] {
    return this.auth.listDepartments()
  }

  agentListDoctors(): DoctorView[] {
    return this.auth.listDoctors()
  }

  agentListAvailableSlots(filters: { departmentId?: string; doctorId?: string; date?: string }): AppointmentSlotView[] {
    return this.appointments.listSlots(filters).filter((s) => s.status === 'open' && s.remaining > 0)
  }

  private agentPatientPrincipal(patientId: string): Principal {
    return {
      sessionId: 'agent',
      accountId: 'agent',
      actorId: 'actor_agent_patient_svc',
      clinicId: 'clinic_clinmesh_demo',
      kind: 'agent',
      role: 'patient',
      displayName: 'Agent',
      imUid: 'agent_patient_svc',
      patientId,
      staffId: null,
      departmentId: null,
      expiresAt: '',
    }
  }

  agentListPatientAppointments(patientId: string): AppointmentView[] {
    const res = this.appointments.listForPatient(this.agentPatientPrincipal(patientId))
    return res.ok ? res.appointments : []
  }

  agentListPatientReleases(patientId: string, resourceType: PatientReleaseResourceType): PatientReleaseView[] {
    const res = this.auth.listPatientReleases(this.agentPatientPrincipal(patientId), resourceType, new Date().toISOString())
    return res.ok ? res.items : []
  }

  agentGetPatientRelease(patientId: string, resourceType: PatientReleaseResourceType, id: string): PatientReleaseView | null {
    const res = this.auth.getPatientRelease(this.agentPatientPrincipal(patientId), resourceType, id, new Date().toISOString())
    return res.ok ? res.item : null
  }

  agentListPatientCareTeam(patientId: string): ContactView[] {
    return this.auth.listContacts(this.agentPatientPrincipal(patientId))
  }

  agentVerifyGroupScope(conversationId: string, triggerActorId: string): { allowed: boolean; followupPlanId: string | null } {
    const ctx = this.comm.getConversationContextForAgent(conversationId)
    if (!ctx || ctx.status !== 'active') return { allowed: false, followupPlanId: null }
    const agentActive = ctx.members.some((m) => m.actorId === 'actor_agent_followup' && m.status === 'active')
    const triggerActive = ctx.members.some((m) => m.actorId === triggerActorId && m.status === 'active')
    return { allowed: agentActive && triggerActive, followupPlanId: ctx.followupPlanId }
  }

  agentGetFollowupPlan(planId: string): FollowupPlanView | null {
    return this.followup.getPlanForAgent(planId)
  }

  agentCreateFollowupSummary(planId: string, draftText: string): { ok: true; summary: FollowupSummaryView } | Refusal {
    return this.ctx.storage.transactionSync(() =>
      this.followup.createDraftSummary('actor_agent_followup', planId, draftText, new Date().toISOString()),
    )
  }

  agentCreateReviewTask(
    planId: string,
    sourceRef: string,
    reason: string,
  ): { ok: true; reviewTask: ReviewTaskView; created: boolean } | Refusal {
    return this.ctx.storage.transactionSync(() =>
      this.followup.createReviewTask('actor_agent_followup', planId, sourceRef, reason, new Date().toISOString()),
    )
  }
}
