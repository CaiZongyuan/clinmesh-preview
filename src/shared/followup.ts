export type FollowupPlanStatus = 'active' | 'completed' | 'cancelled'
export type FollowupTaskStatus = 'pending' | 'submitted' | 'reviewed'
export type FollowupSummaryStatus = 'draft' | 'approved' | 'rejected'

export type FollowupErrorCode =
  | 'followup-plan-not-found'
  | 'followup-plan-closed'
  | 'followup-task-not-found'
  | 'followup-task-already-submitted'
  | 'followup-summary-not-found'
  | 'followup-summary-immutable'
  | 'agent-run-not-found'
  | 'agent-action-invalid'

export interface QuestionnaireQuestion {
  id: string
  label: string
  type: 'text' | 'number' | 'choice'
  required: boolean
  options?: string[]
  unit?: string
}

export interface FollowupTaskView {
  taskId: string
  planId: string
  kind: string
  title: string
  dueAt: string
  status: FollowupTaskStatus
  questionnaireVersion: number
  questions: QuestionnaireQuestion[]
  response: FollowupResponseView | null
}

export interface FollowupResponseView {
  responseId: string
  taskId: string
  planId: string
  patientId: string
  answers: Record<string, string | number>
  submittedAt: string
}

export interface FollowupSummaryView {
  summaryId: string
  planId: string
  version: number
  sourceResponseIds: string[]
  draftText: string
  status: FollowupSummaryStatus
  createdBy: string
  reviewedBy: string | null
  reviewedByName: string | null
  reviewedAt: string | null
  reviewNote: string | null
  createdAt: string
}

export interface ReviewTaskView {
  reviewTaskId: string
  planId: string
  sourceRef: string
  reason: string
  status: 'open' | 'resolved'
  createdBy: string
  createdAt: string
}

export interface FollowupPlanView {
  planId: string
  patientId: string
  patientName: string
  encounterId: string | null
  ownerStaffId: string
  ownerStaffName: string
  title: string
  status: FollowupPlanStatus
  conversationId: string | null
  startAt: string
  endAt: string | null
  createdAt: string
  closedAt: string | null
  tasks: FollowupTaskView[]
  summaries: FollowupSummaryView[]
  reviewTasks: ReviewTaskView[]
}

export interface CreateFollowupPlanRequest {
  patientId: string
  encounterId?: string
  title: string
  nurseStaffId?: string
  dueAt?: string
  taskTitle?: string
  questions?: QuestionnaireQuestion[]
}

export interface SubmitFollowupResponseRequest {
  answers: Record<string, string | number>
  idempotencyKey: string
}

export interface ReviewFollowupSummaryRequest {
  decision: 'approved' | 'rejected'
  note?: string
}

export interface AgentRunSnapshot {
  runId: string
  agentKind: 'patient_service' | 'followup'
  agentActorId: string
  conversationId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  text: string
  error: string | null
  toolCalls: Array<{
    callId: string
    name: string
    status: 'dispatched' | 'ok' | 'error' | 'cancelled'
    subject: string | null
    result: string | null
  }>
  cards: Array<import('./communication').MessagePart & { type: 'card' }>
  pendingActions: Array<{
    callId: string
    action: import('./agent-stream-reducer').ClientActionSpec
    expiresAt: string
    status: 'pending' | 'dispatched' | 'rejected' | 'unavailable' | 'expired'
    resultJson: string | null
  }>
  finalMessageId: string | null
  createdAt: string
  finishedAt: string | null
}
