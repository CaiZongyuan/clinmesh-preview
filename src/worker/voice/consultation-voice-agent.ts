import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import { withVoiceInput } from 'agents/voice'
import type { VoiceCapture } from '../../shared/consultation'
import type { CaptureMode, VoiceClientMessage, VoiceServerMessage } from '../../shared/voice'
import { workspaceName, type WorkspaceModeEnv } from '../workspace-name'
import { PARAFORMER_MODEL, ParaformerTranscriber, type RecognizedSpeech } from './paraformer-transcriber'
import { paraformerUpstream } from './voice-config'

interface Submission {
  encounterId: string
  clientTurnId: string
  text: string
  voice: VoiceCapture
  latencyMs: number | null
}

// Refused sentences kept for a resubmit; the oldest are forgotten first.
const MAX_REFUSED = 20

const send = (connection: Connection, message: VoiceServerMessage) => connection.send(JSON.stringify(message))

const encounterOf = (connection: Connection) => {
  const path = connection.uri ? new URL(connection.uri).pathname : ''
  const id = path.match(/^\/api\/encounters\/([^/]+)\/voice$/)?.[1]
  return id ? decodeURIComponent(id) : null
}

// The doctor's voice capture for one Encounter (ADR-0003). Cloudflare `agents/voice` (`withVoiceInput`) owns the
// audio transport and the call and turn lifecycle; the ParaformerTranscriber recognizes the speech; each finalized
// utterance is asked of the Simulated Patient through the workspace's own askPatient command, exactly like a typed
// question (single pending turn, idempotent client turn id). The reply streams on the Simulated Patient's socket.
export class ConsultationVoiceAgent extends withVoiceInput(Agent<Env>) {
  private readonly modes = new Map<string, CaptureMode>()
  private readonly transcribers = new Map<string, ParaformerTranscriber>()
  private readonly recognized = new Map<string, RecognizedSpeech[]>()
  private readonly refused = new Map<string, Submission>()
  private readonly practitioners = new Map<string, string>()

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const practitionerId = ctx.request.headers.get('x-clinmesh-practitioner-id')
    if (practitionerId) this.practitioners.set(connection.id, practitionerId)
    await super.onConnect(connection, ctx)
  }

  createTranscriber(connection: Connection): ParaformerTranscriber | null {
    const upstream = paraformerUpstream(this.env as unknown as Record<string, unknown>)
    if (!upstream) return null
    const transcriber = new ParaformerTranscriber({
      ...upstream,
      mode: this.modes.get(connection.id) ?? 'continuous',
      onRecognized: (speech) => this.recognized.set(connection.id, [...(this.recognized.get(connection.id) ?? []), speech]),
      onEmpty: () => send(connection, { type: 'clinmesh.capture-empty' }),
      onFailure: (code, taskId) => {
        if (connection.readyState !== WebSocket.OPEN) return
        const reason = code === 'AllocationQuota.FreeTierOnly' ? '百炼拒绝了本次免费识别请求'
          : code === 'StartTimeout' ? '等待百炼启动识别超时'
          : code === 'ConnectionClosed' ? '百炼语音连接已关闭'
          : '本次百炼语音识别失败'
        send(connection, { type: 'error', code, message: `${reason}（${code}）。任务号 ${taskId}` })
      },
    })
    this.transcribers.set(connection.id, transcriber)
    return transcriber
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: VoiceClientMessage
    try {
      parsed = JSON.parse(message) as VoiceClientMessage
    } catch {
      return
    }
    if (parsed.type === 'clinmesh.capture' && (parsed.mode === 'continuous' || parsed.mode === 'hold')) {
      this.modes.set(connection.id, parsed.mode)
    } else if (parsed.type === 'clinmesh.commit') {
      this.transcribers.get(connection.id)?.commit()
    } else if (parsed.type === 'clinmesh.resubmit') {
      const submission = this.refused.get(parsed.clientTurnId)
      if (!submission) {
        send(connection, { type: 'error', message: '这句语音已失效，请重新说一遍。' })
        return
      }
      this.refused.delete(parsed.clientTurnId)
      await this.submit(connection, submission)
    }
  }

  async onTranscript(text: string, connection: Connection): Promise<void> {
    const encounterId = encounterOf(connection)
    if (!encounterId) return
    const pending = this.recognized.get(connection.id) ?? []
    const index = pending.findIndex((speech) => speech.text === text)
    const speech = index >= 0 ? pending.splice(index, 1)[0] : undefined
    await this.submit(connection, {
      encounterId,
      clientTurnId: crypto.randomUUID(),
      text,
      voice: { recognizer: PARAFORMER_MODEL, durationMs: speech?.durationMs ?? 0, confidence: null },
      latencyMs: speech?.latencyMs ?? null,
    })
  }

  onClose(connection: Connection): void {
    this.modes.delete(connection.id)
    this.transcribers.delete(connection.id)
    this.recognized.delete(connection.id)
    this.practitioners.delete(connection.id)
  }

  private async submit(connection: Connection, submission: Submission) {
    const { encounterId, clientTurnId, text, voice, latencyMs } = submission
    const practitionerId = this.practitioners.get(connection.id)
    const result = await this.env.CLINIC_WORKSPACE.getByName(workspaceName(this.env as unknown as WorkspaceModeEnv)).askPatient(
      encounterId,
      { clientTurnId, text, voice },
      practitionerId,
    )
    if (result.ok) {
      send(connection, { type: 'clinmesh.voice-turn', ok: true, doctorTurn: result.doctorTurn, patientTurn: result.patientTurn, latencyMs })
      return
    }
    if (result.error.code === 'patient-turn-pending') {
      this.refused.set(clientTurnId, submission)
      if (this.refused.size > MAX_REFUSED) this.refused.delete(this.refused.keys().next().value!)
    }
    send(connection, { type: 'clinmesh.voice-turn', ok: false, clientTurnId, text, error: result.error, latencyMs })
  }
}
