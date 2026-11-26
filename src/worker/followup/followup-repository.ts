import type { Principal } from '../../shared/auth'
import type { EncounterError } from '../../shared/encounter'
import type {
  CreateFollowupPlanRequest,
  FollowupPlanStatus,
  FollowupPlanView,
  FollowupResponseView,
  FollowupSummaryStatus,
  FollowupSummaryView,
  FollowupTaskStatus,
  FollowupTaskView,
  QuestionnaireQuestion,
  ReviewFollowupSummaryRequest,
  ReviewTaskView,
  SubmitFollowupResponseRequest,
} from '../../shared/followup'
import type { AuthRepository } from '../auth/auth-repository'
import type { CommunicationRepository } from '../communication/communication-repository'

type Refusal = { ok: false; error: EncounterError }
const refuse = (error: EncounterError): Refusal => ({ ok: false, error })

const DEFAULT_QUESTIONS: QuestionnaireQuestion[] = [
  { id: 'symptom_change', label: '近两日主要症状变化情况', type: 'choice', required: true, options: ['明显好转', '略有好转', '无变化', '有所加重'] },
  { id: 'medication_adherence', label: '是否按医嘱规律服药', type: 'choice', required: true, options: ['完全按时服药', '偶有漏服', '未服药'] },
  { id: 'temperature_or_bp', label: '居家自测体温或血压记录', type: 'text', required: false },
  { id: 'notes', label: '其他需要告知医护团队的情况', type: 'text', required: false },
]

type PlanRow = {
  plan_id: string
  patient_id: string
  patient_name: string
  encounter_id: string | null
  owner_staff_id: string
  owner_staff_name: string
  title: string
  status: FollowupPlanStatus
  conversation_id: string | null
  start_at: string
  end_at: string | null
  created_at: string
  closed_at: string | null
}

type TaskRow = {
  task_id: string
  plan_id: string
  kind: string
  title: string
  due_at: string
  status: FollowupTaskStatus
  questionnaire_version: number
  schema_json: string
}

type ResponseRow = {
  response_id: string
  task_id: string
  plan_id: string
  patient_id: string
  payload_json: string
  submitted_at: string
}

type SummaryRow = {
  summary_id: string
  plan_id: string
  version: number
  source_response_ids_json: string
  draft_text: string
  status: FollowupSummaryStatus
  created_by: string
  reviewed_by: string | null
  reviewed_by_name: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
}

type ReviewTaskRow = {
  review_task_id: string
  plan_id: string
  source_ref: string
  reason: string
  status: 'open' | 'resolved'
  created_by: string
  created_at: string
}

export class FollowupRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: AuthRepository,
    private readonly comm: CommunicationRepository,
  ) {}

  ensureDemoPlansSeeded(nowIso: string): void {
    const count = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM followup_plan').one().count
    if (count > 0) return

    // Seed 2 demo follow-up plans (Spec §10): one pending patient feedback, one with draft summary awaiting doctor review.
    this.sql.exec(
      `INSERT INTO conversation (
         conversation_id, type, title, im_channel_id, im_channel_type, direct_key,
         patient_id, encounter_id, followup_plan_id, department_id, status, membership_version,
         created_by, created_at, updated_at
       ) VALUES (
         'conv_followup_pat01', 'followup_group', '李建国 · 慢病随访群', 'cm_conv_followup_pat01', 2, NULL,
         'pat_01', NULL, 'plan_demo_pat01', 'dept_general', 'active', 1,
         'actor_doctor_a', ?, ?
       )`,
      nowIso,
      nowIso,
    )
    for (const [actorId, role] of [
      ['actor_doctor_a', 'owner'],
      ['actor_nurse_n', 'member'],
      ['actor_pat_01', 'member'],
      ['actor_agent_followup', 'agent'],
    ] as const) {
      this.sql.exec(
        `INSERT INTO conversation_member (conversation_id, actor_id, role, status, joined_at, removed_at, last_read_seq)
         VALUES ('conv_followup_pat01', ?, ?, 'active', ?, NULL, 0)`,
        actorId,
        role,
        nowIso,
      )
    }

    this.sql.exec(
      `INSERT INTO followup_plan (
         plan_id, patient_id, encounter_id, owner_staff_id, title, status, conversation_id, start_at, end_at, created_at, closed_at
       ) VALUES ('plan_demo_pat01', 'pat_01', NULL, 'staff_doctor_a', '高血压慢病 7 天随访计划', 'active', 'conv_followup_pat01', ?, NULL, ?, NULL)`,
      nowIso,
      nowIso,
    )
    this.sql.exec(
      `INSERT INTO followup_task (task_id, plan_id, kind, title, due_at, status, questionnaire_version, schema_json, created_at)
       VALUES ('task_demo_pat01_day3', 'plan_demo_pat01', 'questionnaire', '第 3 天血压与用药随访问卷', '2026-11-29T02:00:00.000Z', 'pending', 1, ?, ?)`,
      JSON.stringify(DEFAULT_QUESTIONS),
      nowIso,
    )

    // Plan 2: pat_03 with submitted response & draft summary awaiting review.
    this.sql.exec(
      `INSERT INTO conversation (
         conversation_id, type, title, im_channel_id, im_channel_type, direct_key,
         patient_id, encounter_id, followup_plan_id, department_id, status, membership_version,
         created_by, created_at, updated_at
       ) VALUES (
         'conv_followup_pat03', 'followup_group', '王秀英 · 复诊随访群', 'cm_conv_followup_pat03', 2, NULL,
         'pat_03', NULL, 'plan_demo_pat03', 'dept_general', 'active', 1,
         'actor_doctor_a', ?, ?
       )`,
      nowIso,
      nowIso,
    )
    for (const [actorId, role] of [
      ['actor_doctor_a', 'owner'],
      ['actor_nurse_n', 'member'],
      ['actor_pat_03', 'member'],
      ['actor_agent_followup', 'agent'],
    ] as const) {
      this.sql.exec(
        `INSERT INTO conversation_member (conversation_id, actor_id, role, status, joined_at, removed_at, last_read_seq)
         VALUES ('conv_followup_pat03', ?, ?, 'active', ?, NULL, 0)`,
        actorId,
        role,
        nowIso,
      )
    }
    this.sql.exec(
      `INSERT INTO followup_plan (
         plan_id, patient_id, encounter_id, owner_staff_id, title, status, conversation_id, start_at, end_at, created_at, closed_at
       ) VALUES ('plan_demo_pat03', 'pat_03', NULL, 'staff_doctor_a', '王秀英 血压复核随访计划', 'active', 'conv_followup_pat03', ?, NULL, ?, NULL)`,
      nowIso,
      nowIso,
    )
    this.sql.exec(
      `INSERT INTO followup_task (task_id, plan_id, kind, title, due_at, status, questionnaire_version, schema_json, created_at)
       VALUES ('task_demo_pat03_day3', 'plan_demo_pat03', 'questionnaire', '第 3 天症状复核问卷', '2026-11-28T02:00:00.000Z', 'submitted', 1, ?, ?)`,
      JSON.stringify(DEFAULT_QUESTIONS),
      nowIso,
    )
    this.sql.exec(
      `INSERT INTO followup_response (response_id, task_id, plan_id, patient_id, payload_json, idempotency_key, submitted_at)
       VALUES ('resp_demo_pat03_1', 'task_demo_pat03_day3', 'plan_demo_pat03', 'pat_03', ?, 'seed-resp-pat03-1', ?)`,
      JSON.stringify({ symptom_change: '明显好转', medication_adherence: '完全按时服药', temperature_or_bp: '128/80 mmHg' }),
      nowIso,
    )
    this.sql.exec(
      `INSERT INTO followup_summary (
         summary_id, plan_id, version, source_response_ids_json, draft_text, status, created_by, reviewed_by, reviewed_at, review_note, created_at
       ) VALUES ('sum_demo_pat03_v1', 'plan_demo_pat03', 1, ?, ?, 'draft', 'actor_agent_followup', NULL, NULL, NULL, ?)`,
      JSON.stringify(['resp_demo_pat03_1']),
      '患者自述症状明显好转，规律服药，居家自测血压 128/80 mmHg。建议医生审核确认后归入随访记录。',
      nowIso,
    )
  }

  createPlan(
    principal: Principal,
    input: CreateFollowupPlanRequest,
    nowIso: string,
  ): { ok: true; plan: FollowupPlanView; imChannelId: string; imChannelType: number; subscriberImUids: string[] } | Refusal {
    if (!principal.staffId || principal.role !== 'doctor') {
      return refuse({ code: 'forbidden', message: '仅授权医生可创建院外随访计划。' })
    }
    const verified = this.auth.verifyActiveStaff(principal.staffId, true)
    if (!verified.ok) return verified

    const patient = this.sql
      .exec<{ patient_id: string; actor_id: string; display_name: string }>(
        'SELECT patient_id, actor_id, display_name FROM patient_profile WHERE patient_id = ?',
        input.patientId,
      )
      .toArray()[0]
    if (!patient) {
      return refuse({ code: 'resource-not-found', message: `找不到患者 ${input.patientId}` })
    }

    const memberActorIds = [patient.actor_id, 'actor_agent_followup']
    const nurseStaffId = input.nurseStaffId?.trim() || 'staff_nurse_n'
    const nurse = this.sql
      .exec<{ actor_id: string }>('SELECT actor_id FROM staff_profile WHERE staff_id = ?', nurseStaffId)
      .toArray()[0]
    if (nurse) {
      memberActorIds.push(nurse.actor_id)
      this.sql.exec(
        `INSERT OR IGNORE INTO care_relationship (patient_id, staff_id, relation_kind, created_at)
         VALUES (?, ?, 'followup', ?)`,
        patient.patient_id,
        nurseStaffId,
        nowIso,
      )
    }

    const planId = `plan_${crypto.randomUUID().slice(0, 12)}`
    const convResult = this.comm.createConversation(
      principal,
      {
        type: 'followup_group',
        title: `${patient.display_name} · ${input.title.trim()}`,
        memberActorIds,
        patientId: patient.patient_id,
        encounterId: input.encounterId,
      },
      nowIso,
      { followupPlanId: planId },
    )
    if (!convResult.ok) return convResult

    this.sql.exec(
      `INSERT INTO followup_plan (
         plan_id, patient_id, encounter_id, owner_staff_id, title, status, conversation_id, start_at, end_at, created_at, closed_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, NULL)`,
      planId,
      patient.patient_id,
      input.encounterId ?? null,
      verified.staffId,
      input.title.trim(),
      convResult.conversation.conversationId,
      nowIso,
      nowIso,
    )

    const taskId = `task_${crypto.randomUUID().slice(0, 12)}`
    const dueAt = input.dueAt?.trim() || new Date(Date.parse(nowIso) + 3 * 24 * 60 * 60 * 1000).toISOString()
    this.sql.exec(
      `INSERT INTO followup_task (task_id, plan_id, kind, title, due_at, status, questionnaire_version, schema_json, created_at)
       VALUES (?, ?, 'questionnaire', ?, ?, 'pending', 1, ?, ?)`,
      taskId,
      planId,
      input.taskTitle?.trim() || '院外随访问卷',
      dueAt,
      JSON.stringify(input.questions?.length ? input.questions : DEFAULT_QUESTIONS),
      nowIso,
    )

    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'followup.plan.create',
      resourceType: 'followup_plan',
      resourceId: planId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    return {
      ok: true,
      plan: this.loadPlan(planId)!,
      imChannelId: convResult.conversation.imChannelId,
      imChannelType: convResult.conversation.imChannelType,
      subscriberImUids: convResult.subscriberImUids,
    }
  }

  listPlans(principal: Principal): FollowupPlanView[] {
    let ids: string[]
    if (principal.role === 'patient' && principal.patientId) {
      ids = this.sql
        .exec<{ plan_id: string }>('SELECT plan_id FROM followup_plan WHERE patient_id = ? ORDER BY created_at DESC', principal.patientId)
        .toArray()
        .map((r) => r.plan_id)
    } else if (principal.staffId) {
      ids = this.sql
        .exec<{ plan_id: string }>(
          `SELECT DISTINCT fp.plan_id
           FROM followup_plan fp
           LEFT JOIN care_relationship r ON r.patient_id = fp.patient_id AND r.staff_id = ?
           LEFT JOIN conversation_member m ON m.conversation_id = fp.conversation_id AND m.actor_id = ? AND m.status = 'active'
           WHERE fp.owner_staff_id = ? OR r.staff_id IS NOT NULL OR m.actor_id IS NOT NULL
           ORDER BY fp.created_at DESC`,
          principal.staffId,
          principal.actorId,
          principal.staffId,
        )
        .toArray()
        .map((r) => r.plan_id)
    } else {
      ids = []
    }
    return ids.map((id) => this.loadPlan(id)!).filter(Boolean)
  }

  getPlan(principal: Principal, planId: string): { ok: true; plan: FollowupPlanView } | Refusal {
    const plan = this.loadPlan(planId)
    if (!plan || !this.canViewPlan(principal, plan)) {
      return refuse({ code: 'followup-plan-not-found', message: '找不到随访计划或无权访问。' })
    }
    return { ok: true, plan }
  }

  getPlanForAgent(planId: string): FollowupPlanView | null {
    return this.loadPlan(planId)
  }

  submitResponse(
    principal: Principal,
    taskId: string,
    input: SubmitFollowupResponseRequest,
    nowIso: string,
  ): { ok: true; response: FollowupResponseView; created: boolean; planId: string } | Refusal {
    if (principal.role !== 'patient' || !principal.patientId) {
      return refuse({ code: 'forbidden', message: '仅患者本人可提交随访问卷反馈。' })
    }
    const existingByKey = this.sql
      .exec<ResponseRow>(
        'SELECT response_id, task_id, plan_id, patient_id, payload_json, submitted_at FROM followup_response WHERE patient_id = ? AND idempotency_key = ?',
        principal.patientId,
        input.idempotencyKey,
      )
      .toArray()[0]
    if (existingByKey) {
      return {
        ok: true,
        response: toResponseView(existingByKey),
        created: false,
        planId: existingByKey.plan_id,
      }
    }

    const task = this.sql
      .exec<TaskRow>('SELECT * FROM followup_task WHERE task_id = ?', taskId)
      .toArray()[0]
    if (!task) {
      return refuse({ code: 'followup-task-not-found', message: `找不到随访任务 ${taskId}` })
    }
    const plan = this.loadPlan(task.plan_id)
    if (!plan || plan.patientId !== principal.patientId) {
      return refuse({ code: 'followup-task-not-found', message: '找不到随访任务或无权提交。' })
    }
    if (plan.status !== 'active') {
      return refuse({ code: 'followup-plan-closed', message: '该随访计划已关闭，无法继续提交问卷。' })
    }

    const already = this.sql
      .exec<{ response_id: string }>('SELECT response_id FROM followup_response WHERE task_id = ? AND patient_id = ?', taskId, principal.patientId)
      .toArray()[0]
    if (already) {
      return refuse({ code: 'followup-task-already-submitted', message: '该随访问卷已提交，请勿重复提交。' })
    }

    const responseId = `resp_${crypto.randomUUID().slice(0, 12)}`
    this.sql.exec(
      `INSERT INTO followup_response (response_id, task_id, plan_id, patient_id, payload_json, idempotency_key, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      responseId,
      taskId,
      plan.planId,
      principal.patientId,
      JSON.stringify(input.answers),
      input.idempotencyKey,
      nowIso,
    )
    this.sql.exec(`UPDATE followup_task SET status = 'submitted' WHERE task_id = ?`, taskId)
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: 'followup.response.submit',
      resourceType: 'followup_task',
      resourceId: taskId,
      requestId: input.idempotencyKey,
      outcome: 'allowed',
      occurredAt: nowIso,
    })

    const createdRow = this.sql
      .exec<ResponseRow>('SELECT * FROM followup_response WHERE response_id = ?', responseId)
      .one()
    return { ok: true, response: toResponseView(createdRow), created: true, planId: plan.planId }
  }

  createDraftSummary(
    createdByActorId: string,
    planId: string,
    draftText: string,
    nowIso: string,
  ): { ok: true; summary: FollowupSummaryView } | Refusal {
    const plan = this.loadPlan(planId)
    if (!plan) return refuse({ code: 'followup-plan-not-found', message: `找不到随访计划 ${planId}` })
    if (plan.status !== 'active') {
      return refuse({ code: 'followup-plan-closed', message: '已关闭的随访计划不能生成新摘要草稿。' })
    }
    const sourceResponseIds = plan.tasks.map((t) => t.response?.responseId).filter((id): id is string => Boolean(id))
    const nextVersion =
      (this.sql.exec<{ v: number | null }>('SELECT MAX(version) AS v FROM followup_summary WHERE plan_id = ?', planId).one().v ?? 0) + 1
    const summaryId = `sum_${crypto.randomUUID().slice(0, 12)}`
    // Never overwrites previous approved versions: always inserts a new draft version.
    this.sql.exec(
      `INSERT INTO followup_summary (
         summary_id, plan_id, version, source_response_ids_json, draft_text, status, created_by, reviewed_by, reviewed_at, review_note, created_at
       ) VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, ?)`,
      summaryId,
      planId,
      nextVersion,
      JSON.stringify(sourceResponseIds),
      draftText.trim(),
      createdByActorId,
      nowIso,
    )
    this.auth.audit({
      actorId: createdByActorId,
      actorRole: createdByActorId.startsWith('actor_agent_') ? 'agent' : 'doctor',
      action: 'followup.summary.draft',
      resourceType: 'followup_summary',
      resourceId: summaryId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, summary: this.loadSummary(summaryId)! }
  }

  reviewSummary(
    principal: Principal,
    summaryId: string,
    input: ReviewFollowupSummaryRequest,
    nowIso: string,
  ): { ok: true; summary: FollowupSummaryView } | Refusal {
    if (!principal.staffId || principal.role !== 'doctor') {
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'followup.summary.review',
        resourceType: 'followup_summary',
        resourceId: summaryId,
        outcome: 'denied',
        occurredAt: nowIso,
      })
      return refuse({ code: 'forbidden', message: '仅授权医生可审核随访摘要。' })
    }
    const verified = this.auth.verifyActiveStaff(principal.staffId, true)
    if (!verified.ok) return verified

    const existing = this.loadSummary(summaryId)
    if (!existing) {
      return refuse({ code: 'followup-summary-not-found', message: `找不到随访摘要 ${summaryId}` })
    }
    const plan = this.loadPlan(existing.planId)
    if (!plan || !this.canViewPlan(principal, plan)) {
      return refuse({ code: 'followup-summary-not-found', message: '无权审核该随访摘要。' })
    }
    if (existing.status !== 'draft') {
      return refuse({ code: 'followup-summary-immutable', message: '该随访摘要已审核定稿，不能重复修改。' })
    }

    this.sql.exec(
      `UPDATE followup_summary
       SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE summary_id = ?`,
      input.decision,
      principal.actorId,
      nowIso,
      input.note?.trim() || null,
      summaryId,
    )
    if (input.decision === 'approved') {
      this.sql.exec(`UPDATE followup_task SET status = 'reviewed' WHERE plan_id = ? AND status = 'submitted'`, plan.planId)
    }
    this.auth.audit({
      actorId: principal.actorId,
      actorRole: principal.role,
      action: `followup.summary.${input.decision}`,
      resourceType: 'followup_summary',
      resourceId: summaryId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return { ok: true, summary: this.loadSummary(summaryId)! }
  }

  closePlan(principal: Principal, planId: string, nowIso: string): { ok: true; plan: FollowupPlanView } | Refusal {
    if (!principal.staffId || principal.role !== 'doctor') {
      return refuse({ code: 'forbidden', message: '仅授权医生可关闭随访计划。' })
    }
    const plan = this.loadPlan(planId)
    if (!plan || !this.canViewPlan(principal, plan)) {
      return refuse({ code: 'followup-plan-not-found', message: `找不到随访计划 ${planId}` })
    }
    if (plan.status === 'active') {
      this.sql.exec(
        `UPDATE followup_plan SET status = 'completed', end_at = ?, closed_at = ? WHERE plan_id = ?`,
        nowIso,
        nowIso,
        planId,
      )
      if (plan.conversationId) {
        this.comm.setConversationStatus(plan.conversationId, 'read_only', nowIso)
      }
      this.auth.audit({
        actorId: principal.actorId,
        actorRole: principal.role,
        action: 'followup.plan.close',
        resourceType: 'followup_plan',
        resourceId: planId,
        outcome: 'allowed',
        occurredAt: nowIso,
      })
    }
    return { ok: true, plan: this.loadPlan(planId)! }
  }

  createReviewTask(
    actorId: string,
    planId: string,
    sourceRef: string,
    reason: string,
    nowIso: string,
  ): { ok: true; reviewTask: ReviewTaskView; created: boolean } | Refusal {
    const plan = this.loadPlan(planId)
    if (!plan) return refuse({ code: 'followup-plan-not-found', message: `找不到随访计划 ${planId}` })
    if (plan.status !== 'active') return refuse({ code: 'followup-plan-closed', message: '随访计划已关闭。' })
    const existing = this.sql
      .exec<ReviewTaskRow>('SELECT * FROM review_task WHERE plan_id = ? AND source_ref = ?', planId, sourceRef)
      .toArray()[0]
    if (existing) {
      return { ok: true, reviewTask: toReviewTaskView(existing), created: false }
    }
    const reviewTaskId = `rtask_${crypto.randomUUID().slice(0, 12)}`
    this.sql.exec(
      `INSERT INTO review_task (review_task_id, plan_id, source_ref, reason, status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      reviewTaskId,
      planId,
      sourceRef,
      reason.trim(),
      actorId,
      nowIso,
    )
    this.auth.audit({
      actorId,
      actorRole: actorId.startsWith('actor_agent_') ? 'agent' : 'staff',
      action: 'followup.review_task.create',
      resourceType: 'review_task',
      resourceId: reviewTaskId,
      outcome: 'allowed',
      occurredAt: nowIso,
    })
    return {
      ok: true,
      reviewTask: toReviewTaskView(this.sql.exec<ReviewTaskRow>('SELECT * FROM review_task WHERE review_task_id = ?', reviewTaskId).one()),
      created: true,
    }
  }

  private canViewPlan(principal: Principal, plan: FollowupPlanView): boolean {
    if (principal.role === 'patient') return principal.patientId === plan.patientId
    if (!principal.staffId) return false
    if (plan.ownerStaffId === principal.staffId) return true
    if (plan.conversationId && this.comm.isActiveMember(plan.conversationId, principal.actorId)) return true
    const rel = this.sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM care_relationship WHERE patient_id = ? AND staff_id = ?',
        plan.patientId,
        principal.staffId,
      )
      .one().count
    return rel > 0
  }

  private loadPlan(planId: string): FollowupPlanView | null {
    const row = this.sql
      .exec<PlanRow>(
        `SELECT fp.plan_id, fp.patient_id, p.display_name AS patient_name, fp.encounter_id,
                fp.owner_staff_id, sa.display_name AS owner_staff_name, fp.title, fp.status,
                fp.conversation_id, fp.start_at, fp.end_at, fp.created_at, fp.closed_at
         FROM followup_plan fp
         JOIN patient_profile p ON p.patient_id = fp.patient_id
         JOIN staff_profile s ON s.staff_id = fp.owner_staff_id
         JOIN actor sa ON sa.actor_id = s.actor_id
         WHERE fp.plan_id = ?`,
        planId,
      )
      .toArray()[0]
    if (!row) return null

    const responses = this.sql
      .exec<ResponseRow>('SELECT * FROM followup_response WHERE plan_id = ?', planId)
      .toArray()
    const responseByTask = new Map(responses.map((r) => [r.task_id, toResponseView(r)]))

    const tasks: FollowupTaskView[] = this.sql
      .exec<TaskRow>('SELECT * FROM followup_task WHERE plan_id = ? ORDER BY due_at ASC', planId)
      .toArray()
      .map((t) => ({
        taskId: t.task_id,
        planId: t.plan_id,
        kind: t.kind,
        title: t.title,
        dueAt: t.due_at,
        status: t.status,
        questionnaireVersion: t.questionnaire_version,
        questions: JSON.parse(t.schema_json) as QuestionnaireQuestion[],
        response: responseByTask.get(t.task_id) ?? null,
      }))

    const summaries = this.sql
      .exec<SummaryRow>(
        `SELECT s.summary_id, s.plan_id, s.version, s.source_response_ids_json, s.draft_text, s.status,
                s.created_by, s.reviewed_by, ra.display_name AS reviewed_by_name, s.reviewed_at, s.review_note, s.created_at
         FROM followup_summary s
         LEFT JOIN actor ra ON ra.actor_id = s.reviewed_by
         WHERE s.plan_id = ?
         ORDER BY s.version DESC`,
        planId,
      )
      .toArray()
      .map(toSummaryView)

    const reviewTasks = this.sql
      .exec<ReviewTaskRow>('SELECT * FROM review_task WHERE plan_id = ? ORDER BY created_at DESC', planId)
      .toArray()
      .map(toReviewTaskView)

    return {
      planId: row.plan_id,
      patientId: row.patient_id,
      patientName: row.patient_name,
      encounterId: row.encounter_id,
      ownerStaffId: row.owner_staff_id,
      ownerStaffName: row.owner_staff_name,
      title: row.title,
      status: row.status,
      conversationId: row.conversation_id,
      startAt: row.start_at,
      endAt: row.end_at,
      createdAt: row.created_at,
      closedAt: row.closed_at,
      tasks,
      summaries,
      reviewTasks,
    }
  }

  private loadSummary(summaryId: string): FollowupSummaryView | null {
    const row = this.sql
      .exec<SummaryRow>(
        `SELECT s.summary_id, s.plan_id, s.version, s.source_response_ids_json, s.draft_text, s.status,
                s.created_by, s.reviewed_by, ra.display_name AS reviewed_by_name, s.reviewed_at, s.review_note, s.created_at
         FROM followup_summary s
         LEFT JOIN actor ra ON ra.actor_id = s.reviewed_by
         WHERE s.summary_id = ?`,
        summaryId,
      )
      .toArray()[0]
    return row ? toSummaryView(row) : null
  }
}

function toResponseView(row: ResponseRow): FollowupResponseView {
  return {
    responseId: row.response_id,
    taskId: row.task_id,
    planId: row.plan_id,
    patientId: row.patient_id,
    answers: JSON.parse(row.payload_json) as Record<string, string | number>,
    submittedAt: row.submitted_at,
  }
}

function toSummaryView(row: SummaryRow): FollowupSummaryView {
  return {
    summaryId: row.summary_id,
    planId: row.plan_id,
    version: row.version,
    sourceResponseIds: JSON.parse(row.source_response_ids_json) as string[],
    draftText: row.draft_text,
    status: row.status,
    createdBy: row.created_by,
    reviewedBy: row.reviewed_by,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    createdAt: row.created_at,
  }
}

function toReviewTaskView(row: ReviewTaskRow): ReviewTaskView {
  return {
    reviewTaskId: row.review_task_id,
    planId: row.plan_id,
    sourceRef: row.source_ref,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}
