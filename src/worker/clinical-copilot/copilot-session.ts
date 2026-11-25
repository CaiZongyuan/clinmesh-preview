import type {
  CopilotFailure,
  CopilotFeedback,
  CopilotMention,
  CopilotQueuedItem,
  CopilotStep,
  CopilotStopReason,
  CopilotTurn,
  CopilotTurnStatus,
} from '../../shared/copilot-turn'
import type { RunUsage } from '../durable-agent/runtime'
import type { CopilotCompactionEntry } from '../../shared/copilot-context'

// What a Copilot run was asked, as recorded in its trigger.
export interface CopilotTrigger {
  kind: 'event' | 'doctor'
  text: string
  mentions: CopilotMention[]
  practitionerId?: string
}

type RunRow = {
  run_id: string
  kind: string
  status: CopilotTurnStatus | 'queued'
  trigger_json: string
  error: CopilotFailure | null
  stop_reason: CopilotStopReason | null
  usage_json: string | null
  started_at: number | null
  finished_at: number | null
  superseded_by: string | null
  feedback: CopilotFeedback | null
}
type StepRow = { step: number; status: 'running' | 'done' | 'stopped' | 'failed'; thinking: string; text: string; started_at: number; finished_at: number | null }
type CallRow = {
  step: number
  call_id: string
  name: string
  arguments_json: string
  status: 'dispatched' | 'ok' | 'error' | 'cancelled'
  subject: string | null
  result: string | null
  dispatched_at: number
  completed_at: number | null
}
type SteerRow = { run_id: string; trigger_json: string; created_at: number; consumed_at: number | null; requeued_as: string | null }

const iso = (ms: number) => new Date(ms).toISOString()
const seconds = (from: number, to: number | null) => Math.max(0, ((to ?? Date.now()) - from) / 1000)

function parseArgs(json: string): unknown {
  try {
    return json.trim() === '' ? {} : JSON.parse(json)
  } catch {
    return json
  }
}

// The Copilot session as the doctor sees it, projected from the runtime's durable tables in one synchronous read,
// so it matches the event log up to `seq`. A running step's thinking and text come from its streamed deltas.
export function readSession(sql: SqlStorage): { turns: CopilotTurn[]; queued: CopilotQueuedItem[]; checkpoint: number; compactions: CopilotCompactionEntry[] } {
  const runs = sql
    .exec<RunRow>(
      `SELECT run_id, kind, status, trigger_json, error, stop_reason, usage_json, started_at, finished_at, superseded_by, copilot_feedback.value AS feedback
       FROM agent_run LEFT JOIN copilot_feedback USING (run_id)
       ORDER BY started_at IS NULL, started_at, queue_order`,
    )
    .toArray()
  const steers = sql.exec<SteerRow>('SELECT run_id, trigger_json, created_at, consumed_at, requeued_as FROM agent_steer ORDER BY id').toArray()

  // Compaction runs are not turns: the doctor sees their markers, not a session entry.
  const turns = runs
    .filter((run) => run.kind !== 'compaction' && run.status !== 'queued' && run.started_at !== null)
    .map((run): CopilotTurn => {
      const trigger = JSON.parse(run.trigger_json) as CopilotTrigger
      const steps = sql.exec<StepRow>('SELECT * FROM agent_step WHERE run_id = ? ORDER BY step', run.run_id).toArray()
      const calls = sql.exec<CallRow>('SELECT * FROM agent_tool_call WHERE run_id = ? ORDER BY id', run.run_id).toArray()
      const running = run.status === 'running'
      const live = running ? liveStep(sql, run.run_id) : null
      const last = steps.at(-1)
      const finalStep = last && !calls.some((call) => call.step === last.step) ? last : undefined
      const projected: CopilotStep[] = steps.flatMap((step): CopilotStep[] => {
        const isRunning = step.status === 'running'
        const thinking = isRunning ? (live?.thinking ?? '') : step.thinking
        // Text the model wrote before calling tools is part of its reasoning; the last step's text is the reply.
        const narration = step === finalStep || isRunning ? '' : step.text
        const thought = [thinking, narration].filter(Boolean).join('\n\n')
        const think: CopilotStep[] =
          thought || isRunning
            ? [
                {
                  kind: 'think',
                  text: thought,
                  state: isRunning ? 'running' : step.status === 'done' ? 'done' : 'stopped',
                  ...(isRunning ? {} : { dur: seconds(step.started_at, step.finished_at) }),
                },
              ]
            : []
        const tools = calls
          .filter((call) => call.step === step.step)
          .map(
            (call): CopilotStep => ({
              kind: 'tool',
              callId: call.call_id,
              name: call.name,
              subject: call.subject ?? call.name,
              args: parseArgs(call.arguments_json),
              result: call.result ?? (call.status === 'cancelled' ? '未执行：本轮已结束。' : ''),
              state: call.status === 'dispatched' ? 'running' : call.status,
              dur: seconds(call.dispatched_at, call.completed_at),
            }),
          )
        return [...think, ...tools]
      })
      const usage = run.usage_json ? (JSON.parse(run.usage_json) as RunUsage) : null
      return {
        turnId: run.run_id,
        trigger: { kind: trigger.kind, text: trigger.text, mentions: trigger.mentions ?? [] },
        status: run.status as CopilotTurnStatus,
        failure: run.status === 'failed' ? run.error : null,
        stopReason: run.status === 'stopped' ? run.stop_reason : null,
        steps: projected,
        steers: steers
          .filter((steer) => steer.run_id === run.run_id)
          .map((steer) => ({
            text: (JSON.parse(steer.trigger_json) as CopilotTrigger).text,
            sentAt: iso(steer.created_at),
            read: steer.consumed_at !== null && steer.requeued_as === null,
          })),
        reply: running ? (live?.text ?? '') : (finalStep?.text ?? ''),
        usage: usage && { in: usage.input, out: usage.output },
        startedAt: iso(run.started_at!),
        finishedAt: run.finished_at === null ? null : iso(run.finished_at),
        feedback: run.feedback,
        superseded: run.superseded_by !== null,
      }
    })

  const queued = runs
    .filter((run) => run.kind !== 'compaction' && run.status === 'queued')
    .map((run): CopilotQueuedItem => {
      const trigger = JSON.parse(run.trigger_json) as CopilotTrigger
      return { turnId: run.run_id, kind: trigger.kind, text: trigger.text }
    })
  const checkpoint =
    sql.exec<{ n: number }>(`SELECT count(*) AS n FROM agent_step WHERE status != 'running'`).one().n +
    sql.exec<{ n: number }>(`SELECT count(*) AS n FROM agent_tool_call WHERE status != 'dispatched'`).one().n
  const compactions: CopilotCompactionEntry[] = sql
    .exec<{ id: number; run_id: string; created_at: number; summarized_messages: number; tokens_before: number; tokens_after: number; summary: string }>(
      'SELECT id, run_id, created_at, summarized_messages, tokens_before, tokens_after, summary FROM copilot_compaction ORDER BY id DESC LIMIT 20',
    )
    .toArray()
    .map((row) => ({
      markerId: row.id,
      runId: row.run_id,
      at: new Date(row.created_at).toISOString(),
      summarizedMessages: row.summarized_messages,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      summary: row.summary,
    }))
  return { turns, queued, checkpoint, compactions }
}

// What the running step has streamed so far: the deltas since its `step.started`.
function liveStep(sql: SqlStorage, runId: string): { thinking: string; text: string } {
  const since = sql
    .exec<{ seq: number | null }>(`SELECT max(seq) AS seq FROM agent_event WHERE run_id = ? AND type = 'step.started'`, runId)
    .one().seq ?? 0
  const live = { thinking: '', text: '' }
  for (const row of sql
    .exec<{ type: string; payload_json: string }>(
      `SELECT type, payload_json FROM agent_event WHERE run_id = ? AND seq > ? AND type IN ('thinking.delta', 'text.delta') ORDER BY seq`,
      runId, since,
    )
    .toArray()) {
    const { text } = JSON.parse(row.payload_json) as { text: string }
    if (row.type === 'thinking.delta') live.thinking += text
    else live.text += text
  }
  return live
}
