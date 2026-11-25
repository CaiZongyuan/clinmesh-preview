import type { ReasoningEffort } from './reasoning-effort'
import type { CopilotCompactionEntry } from './copilot-context'

export type { ReasoningEffort } from './reasoning-effort'

// HIS objects a doctor can @-mention in a Copilot prompt. Sources that don't exist yet (note sections, Drafts)
// join this list as their features land; the Copilot reads every kind the same way, as a reference to look up.
export type CopilotMentionKind = 'report' | 'examination' | 'note-section' | 'draft'

export interface CopilotMention {
  kind: CopilotMentionKind
  id: string
  label: string
}

export const MENTION_KIND_LABEL: Record<CopilotMentionKind, string> = {
  report: '报告',
  examination: '查体',
  'note-section': '病历',
  draft: '草稿',
}

export interface CopilotCommand {
  command: string
  description: string
  // What the Copilot is asked when the prompt starts with the command; anything typed after it follows.
  prompt: string | null
}

// `/上下文` opens the context view in the browser (#13) and never reaches the Copilot.
export const COPILOT_COMMANDS: readonly CopilotCommand[] = [
  { command: '/鉴别诊断', description: '按现有资料列出鉴别诊断与依据', prompt: '请根据目前可见的资料，列出鉴别诊断，并逐条说明支持与不支持的依据、还需补充的问诊或检查。' },
  { command: '/检查建议', description: '建议下一步检查及理由', prompt: '请建议下一步的检查检验（只从诊所检查目录中选），说明每项的理由与优先级。' },
  { command: '/用药核查', description: '核对用药与过敏、相互作用', prompt: '请核对患者的既往用药、过敏史与目前考虑的治疗，指出过敏、相互作用和剂量方面的风险。' },
  { command: '/病历小结', description: '生成本次就诊小结', prompt: '请根据本次就诊目前的问诊、查体和已发布报告，写一份简洁的就诊小结。' },
  { command: '/上下文', description: '查看助手当前上下文', prompt: null },
]

export const CONTEXT_COMMAND = '/上下文'

export type CopilotTurnStatus = 'running' | 'done' | 'stopped' | 'failed'

export type CopilotFailure = 'timeout' | 'stalled' | 'llm-not-configured' | 'llm-error' | 'too-many-steps' | 'crashed-repeatedly'

export type CopilotStopReason = 'stop-requested' | 'superseded' | 'encounter-ended'

export type CopilotStep =
  | { kind: 'think'; text: string; state: 'running' | 'done' | 'stopped'; dur?: number }
  | {
      kind: 'tool'
      callId: string
      name: string
      subject: string
      args: unknown
      result: string
      // 'error' is a read that failed; 'denied' and 'approval' arrive with the UI bridge (#14).
      state: 'running' | 'ok' | 'error' | 'cancelled' | 'denied' | 'approval'
      dur: number
    }

export interface CopilotSteer {
  text: string
  sentAt: string
  // Read before a later step of this turn; one the turn ended before reading became a turn of its own.
  read: boolean
}

export type CopilotFeedback = 'up' | 'down'

// One Copilot run as the doctor sees it: what triggered it, its folded steps, its markdown reply and its usage.
export interface CopilotTurn {
  turnId: string
  trigger: { kind: 'event' | 'doctor'; text: string; mentions: CopilotMention[] }
  status: CopilotTurnStatus
  failure: CopilotFailure | null
  stopReason: CopilotStopReason | null
  keptDrafts?: number
  steps: CopilotStep[]
  steers: CopilotSteer[]
  reply: string
  usage: { in: number; out: number } | null
  startedAt: string
  finishedAt: string | null
  feedback: CopilotFeedback | null
  // Replaced by an edited or regenerated prompt: no longer part of the Copilot's context.
  superseded: boolean
}

export interface CopilotQueuedItem {
  turnId: string
  kind: 'event' | 'doctor'
  text: string
}

export interface CopilotModelSetting {
  model: string
  effort: ReasoningEffort
  defaultModel: string
  defaultEffort: ReasoningEffort
  options: string[]
}

export interface CopilotSnapshot {
  // The last event the snapshot includes: say `hello { afterSeq: seq }` to follow on from it.
  seq: number
  // Durable checkpoints so far (finished steps and tool results); a resumed session continues from the latest.
  checkpoint: number
  model: CopilotModelSetting
  turns: CopilotTurn[]
  queued: CopilotQueuedItem[]
  // Manual compaction markers (#13), newest first: each summarizes the turns before it.
  compactions: CopilotCompactionEntry[]
  // An ambient trigger counting down its ~1.2s debounce (立即 / 跳过); a newer finalized turn flushes it into the queue.
  countdown: CopilotCountdown | null
}

export interface CopilotCountdown {
  ref: string
  text: string
  fireAt: string
}

export type CopilotPromptMode = 'queue' | 'steer'

// What a ui_act step became, as the browser reported it over the bridge: a written Draft, a Suggestion
// waiting for the doctor's 采纳 / 不采用, or a refused data-agent-confirm control (被拦截).
export type CopilotToolOutcome = 'denied' | 'approval'

export interface CopilotPromptRequest {
  // Chosen by the browser, so resending a prompt after a dropped response records it once.
  clientPromptId: string
  text: string
  mentions: CopilotMention[]
  // While a turn runs: steer it (read before its next step) or queue after it.
  mode: CopilotPromptMode
}

export interface CopilotPromptResponse {
  kind: 'run' | 'steer'
  turnId: string
}

export interface CopilotResendRequest {
  clientPromptId: string
  text: string
  mentions: CopilotMention[]
}

export interface CopilotFeedbackRequest {
  value: CopilotFeedback | null
}

export interface CopilotConfigRequest {
  model: string
  effort: ReasoningEffort
}

export interface CopilotStopResponse {
  stoppedTurnId: string | null
}

export const MAX_PROMPT_LENGTH = 2000
export const MAX_MENTIONS = 10
