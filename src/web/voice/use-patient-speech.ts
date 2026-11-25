import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsultationTurn } from '../../shared/consultation'
import type { EncounterView } from '../../shared/encounter'
import { SAMBERT_MAX_TEXT } from '../../shared/voice'
import { synthesizePatientSpeech } from '../api'

export interface PatientSpeech {
  muted: boolean
  toggleMute(): void
  // Patient turns whose automatic playback the doctor cut off by starting to speak.
  interrupted: ReadonlySet<string>
  // The turn (and 0–1 progress through its reply) being spoken right now.
  playingTurnId: string | null
  progress: number
  replay(turn: ConsultationTurn): void
}

interface Chunk {
  turnId: string
  text: string
}

// A sentence end, used to split the streamed reply so speech starts before the whole answer has arrived.
const SENTENCE_END = /[。！？；!?;\n]/

// Splits text into sentences; the trailing text after the last sentence end stays (undefined when there is none).
function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_END.test(text[i])) {
      sentences.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  return { sentences, rest: text.slice(start) }
}

// The Simulated Patient's spoken replies (ADR-0003): the streamed reply text is split into sentences, each is
// synthesized by the Worker's SambertTTSProvider, and the browser plays the chunks in order — so playback starts
// while the text still streams. The doctor starting to speak (either capture mode) cancels playback and marks the
// turn 播放已打断. A frozen or switched-away Encounter stops everything, and late synthesis jobs are dropped.
export function usePatientSpeech(
  encounter: EncounterView | null,
  consultation: { turns: ConsultationTurn[]; streamed: Readonly<Record<string, string>> },
  doctorSpeaking: boolean,
): PatientSpeech {
  const [muted, setMuted] = useState(false)
  const [interrupted, setInterrupted] = useState<ReadonlySet<string>>(new Set())
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<Chunk[]>([])
  const busyRef = useRef(false)
  const mutedRef = useRef(false)
  mutedRef.current = muted
  // One generation per (Encounter, liveness) era; a response from an older era is a stale job and is dropped.
  const generationRef = useRef(0)
  const controllersRef = useRef(new Set<AbortController>())
  // Per-turn counts, for the progress bar: how many chunks the turn has, how many finished playing.
  const countsRef = useRef(new Map<string, { queued: number; played: number }>())

  const audio = () => (audioRef.current ??= new Audio())

  const stopAudio = useCallback(() => {
    const player = audioRef.current
    if (player) {
      player.pause()
      player.removeAttribute('src')
    }
    setPlayingTurnId(null)
    setProgress(0)
  }, [])

  // Drops everything in flight. Only a stop caused by the doctor's own speech marks the turn 播放已打断.
  const stop = useCallback(
    (byDoctor: boolean) => {
      generationRef.current++
      for (const controller of controllersRef.current) controller.abort()
      controllersRef.current.clear()
      queueRef.current = []
      countsRef.current.clear()
      busyRef.current = false
      setPlayingTurnId((was) => {
        if (byDoctor && was) setInterrupted((all) => new Set(all).add(was))
        return null
      })
      stopAudio()
    },
    [stopAudio],
  )

  const encounterId = encounter?.encounterId ?? null
  const live = encounter?.status === 'active'
  // Reset when the Encounter changes, and the moment it freezes (completed or abandoned).
  useEffect(() => {
    stop(false)
    setInterrupted(new Set())
  }, [encounterId, live, stop])

  // Doctor speech onset — toggle-on of 持续收音 or the hold button going down — barge-ins the playback.
  useEffect(() => {
    if (doctorSpeaking) stop(true)
  }, [doctorSpeaking, stop])

  const pump = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    const generation = generationRef.current
    try {
      while (queueRef.current.length) {
        const chunk = queueRef.current[0]
        const controller = new AbortController()
        controllersRef.current.add(controller)
        let wav: ArrayBuffer
        try {
          wav = await synthesizePatientSpeech(encounterId!, chunk.turnId, chunk.text.slice(0, SAMBERT_MAX_TEXT), controller.signal)
        } finally {
          controllersRef.current.delete(controller)
        }
        if (generation !== generationRef.current) return // stale job from a cancelled or frozen era
        queueRef.current.shift()
        const counts = countsRef.current.get(chunk.turnId)!
        const player = audio()
        player.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
        setPlayingTurnId(chunk.turnId)
        const fraction = () => {
          const within = player.duration > 0 ? player.currentTime / player.duration : 0
          setProgress(Math.min(1, (counts.played + within) / counts.queued))
        }
        player.addEventListener('timeupdate', fraction)
        try {
          await new Promise<void>((resolve) => {
            const done = () => resolve()
            player.addEventListener('ended', done, { once: true })
            player.addEventListener('error', done, { once: true })
            void player.play().catch(() => resolve())
          })
        } finally {
          player.removeEventListener('timeupdate', fraction)
        }
        if (generation !== generationRef.current) return
        counts.played++
        setProgress(counts.played >= counts.queued ? 1 : counts.played / counts.queued)
        if (counts.played >= counts.queued) countsRef.current.delete(chunk.turnId)
      }
    } catch {
      // Synthesis refused or the fetch aborted: the remaining chunks belong to the next pump or are dropped.
    } finally {
      busyRef.current = false
      if (generation === generationRef.current) stopAudio()
    }
  }, [encounterId, stopAudio])

  const enqueue = useCallback(
    (turnId: string, texts: string[]) => {
      if (!encounterId || !texts.length) return
      const counts = countsRef.current.get(turnId) ?? { queued: 0, played: 0 }
      counts.queued += texts.length
      countsRef.current.set(turnId, counts)
      for (const text of texts) queueRef.current.push({ turnId, text })
      if (!mutedRef.current) void pump()
    },
    [encounterId, pump],
  )

  // Streaming replies: speak each completed sentence as it arrives while the turn is pending, and the remainder
  // once it settles. A failed turn speaks nothing further.
  const spokenThrough = useRef<Record<string, number>>({})
  const prevPendingRef = useRef<string | null>(null)
  const pendingTurnId = consultation.turns.find((turn) => turn.status === 'pending')?.turnId ?? null
  useEffect(() => {
    const previous = prevPendingRef.current
    prevPendingRef.current = pendingTurnId
    if (pendingTurnId) {
      const text = consultation.streamed[pendingTurnId] ?? ''
      const fresh = text.slice(spokenThrough.current[pendingTurnId] ?? 0)
      if (!fresh) return
      const { sentences, rest } = splitSentences(fresh)
      spokenThrough.current[pendingTurnId] = text.length - rest.length
      enqueue(pendingTurnId, sentences)
      return
    }
    if (!previous) return
    const turn = consultation.turns.find((t) => t.turnId === previous)
    if (turn?.status !== 'final') {
      delete spokenThrough.current[previous]
      return
    }
    const rest = turn.text.slice(spokenThrough.current[previous] ?? 0)
    spokenThrough.current[previous] = turn.text.length
    if (rest.trim()) enqueue(turn.turnId, [rest])
  }, [pendingTurnId, consultation.turns, consultation.streamed, live, enqueue])

  const replay = useCallback(
    (turn: ConsultationTurn) => {
      if (!turn.text.trim()) return
      stop(false)
      enqueue(turn.turnId, [turn.text.slice(0, SAMBERT_MAX_TEXT)])
    },
    [enqueue, stop],
  )

  const toggleMute = useCallback(() => {
    // Muting drops what is playing and what is queued; replay is an explicit ask, so it plays even while muted.
    setMuted((current) => {
      mutedRef.current = !current
      return !current
    })
    stop(false)
  }, [stop])

  return { muted, toggleMute, interrupted, playingTurnId, progress, replay }
}
