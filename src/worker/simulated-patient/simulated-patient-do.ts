import { DurableObject } from 'cloudflare:workers'
import type { PatientTurnFailure } from '../../shared/consultation'
import { DurableAgentRuntime, type AgentDefinition, type RunError, type RunOutcome } from '../durable-agent/runtime'
import type { LlmEnv } from '../llm/config'
import { WORKSPACE_NAME } from '../workspace-name'
import { buildPatientContext, type ConsultationLine, type PatientPersona } from './patient-context'

// Everything the Simulated Patient is ever given, built only by the workspace: the Patient Persona and one
// doctor utterance at a time. This Durable Object never reads the Golden Case pack.
export interface PatientReplyRequest {
  encounterId: string
  persona: PatientPersona
  doctorTurnId: string
  doctorText: string
  patientTurnId: string
  attempt: number
  deadlineAt: string
}

export type PatientReplyOutcome =
  | { status: 'final'; text: string }
  | { status: 'failed'; failure: PatientTurnFailure; text: string }

export interface PatientTurnSettlement {
  encounterId: string
  patientTurnId: string
  outcome: PatientReplyOutcome
}

type ReplyTrigger = { encounterId: string; doctorTurnId: string; attempt: number }

const FAILURE: Record<RunError, PatientTurnFailure> = {
  timeout: 'timeout',
  'llm-not-configured': 'llm-not-configured',
  'llm-error': 'llm-error',
  'too-many-steps': 'llm-error',
  'crashed-repeatedly': 'llm-error',
}

function settlementOf(trigger: ReplyTrigger, patientTurnId: string, outcome: RunOutcome): PatientTurnSettlement {
  return {
    encounterId: trigger.encounterId,
    patientTurnId,
    outcome:
      outcome.status === 'done'
        ? { status: 'final', text: outcome.text }
        : { status: 'failed', failure: FAILURE[outcome.error], text: outcome.text },
  }
}

// One per Encounter (addressed by its id), so a replayed Golden Case starts a fresh patient with an empty memory.
export class SimulatedPatientDO extends DurableObject<Env> {
  private readonly runtime: DurableAgentRuntime

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const agent: AgentDefinition = {
      kind: 'patient',
      streamThinking: false,
      buildContext: ({ binding, messages }) => ({
        messages: buildPatientContext(
          binding as PatientPersona,
          messages.flatMap((m): ConsultationLine[] =>
            m.role === 'user' ? [{ speaker: 'doctor', text: m.content }] : m.role === 'assistant' ? [{ speaker: 'patient', text: m.content }] : [],
          ),
        ),
        tools: [],
      }),
      settlement: {
        payload: (run, outcome) => settlementOf(run.trigger as ReplyTrigger, run.externalRef!, outcome),
        deliver: async (payload) =>
          (await env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME).settlePatientTurn(payload as PatientTurnSettlement)).accepted,
      },
    }
    this.runtime = new DurableAgentRuntime(ctx, env as unknown as LlmEnv, agent)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => this.runtime.migrate())
    })
  }

  // Returns once the reply is durably queued; the alarm streams it and settles the patient turn in the workspace.
  async beginReply(request: PatientReplyRequest): Promise<void> {
    if (!this.runtime.bindSession(request.encounterId, request.persona)) {
      throw new Error(`Simulated Patient ${this.ctx.id} is bound to another Encounter`)
    }
    await this.runtime.enqueue({
      kind: 'reply',
      externalRef: request.patientTurnId,
      trigger: { encounterId: request.encounterId, doctorTurnId: request.doctorTurnId, attempt: request.attempt } satisfies ReplyTrigger,
      deadlineAt: Date.parse(request.deadlineAt),
      messages: [{ originRef: request.doctorTurnId, message: { role: 'user', content: request.doctorText } }],
    })
  }

  async fetch(request: Request): Promise<Response> {
    return this.runtime.sockets.accept(request)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.runtime.sockets.onMessage(ws, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.runtime.sockets.onClose(ws, code, reason)
  }

  async alarm(): Promise<void> {
    await this.runtime.onAlarm()
  }
}
