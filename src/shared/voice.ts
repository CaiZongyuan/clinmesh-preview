import type { ConsultationTurn, Recognizer } from './consultation'
import type { EncounterError } from './encounter'

// GET /api/voice: which recognizer turns the doctor's speech into Consultation turns. Paraformer when the Worker
// has a BAILIAN_TOKEN, otherwise the browser's Web Speech API. Never carries the token.
export interface VoiceConfigResponse {
  recognizer: Recognizer
}

// How one capture is segmented into doctor turns: hands-free (持续收音) lets the recognizer's VAD end each sentence;
// push-to-talk (按住说话) makes everything said while holding one turn, committed on release.
export type CaptureMode = 'continuous' | 'hold'

// The voice socket (/api/encounters/:encounterId/voice) speaks the Cloudflare `agents/voice` protocol, version 1:
// the browser sends `start_call` / `end_call` and binary 16 kHz mono PCM16 frames, the server answers with
// `status`, `transcript_interim`, `transcript` and `error`. These are the parts the workbench uses, plus ClinMesh's
// own messages, prefixed `clinmesh.`.
export type VoiceClientMessage =
  | { type: 'start_call' }
  | { type: 'end_call' }
  // Sent before `start_call`: how the next capture is segmented.
  | { type: 'clinmesh.capture'; mode: CaptureMode }
  // Push-to-talk released: finish recognizing what was said and record it as one doctor turn.
  | { type: 'clinmesh.commit' }
  // Ask again with a recognized question the workspace refused (e.g. while a reply was pending), under its same id.
  | { type: 'clinmesh.resubmit'; clientTurnId: string }

export type VoiceServerMessage =
  | { type: 'status'; status: 'idle' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'transcript_interim'; text: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'error'; message: string; code?: string; retryable?: boolean }
  | VoiceTurnMessage
  // A committed push-to-talk capture in which nothing was recognized.
  | { type: 'clinmesh.capture-empty' }

// What became of a recognized sentence: recorded as a doctor turn (with the patient turn awaiting the reply), or
// refused by the workspace with the same error the HTTP route would give.
export type VoiceTurnMessage =
  | {
      type: 'clinmesh.voice-turn'
      ok: true
      doctorTurn: ConsultationTurn
      patientTurn: ConsultationTurn
      // From the moment the recognizer had the audio to the moment it finalized the sentence.
      latencyMs: number | null
    }
  | { type: 'clinmesh.voice-turn'; ok: false; clientTurnId: string; text: string; error: EncounterError; latencyMs: number | null }

// Push-to-talk captures shorter than this are discarded as accidental taps.
export const MIN_HOLD_MS = 600
