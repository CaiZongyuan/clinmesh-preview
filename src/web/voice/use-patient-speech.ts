import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsultationTurn } from '../../shared/consultation'
import { SAMBERT_MAX_TEXT } from '../../shared/voice'
import { synthesizePatientSpeech } from '../api'

interface Playback {
  turnId: string
  queue: string[]
  total: number
  played: number
  running: boolean
  controller: AbortController
}

const SENTENCE_END = /[。！？；!?;\n]/g

function speechChunks(text: string, final: boolean): { chunks: string[]; consumed: number } {
  let end = final ? text.length : 0
  if (!final) {
    for (const match of text.matchAll(SENTENCE_END)) end = match.index + 1
  }
  const chunks: string[] = []
  let offset = 0
  while (offset < end || text.length - offset > SAMBERT_MAX_TEXT) {
    let next = Math.min(offset + SAMBERT_MAX_TEXT, end > offset ? end : text.length)
    if (next < text.length && /[\uD800-\uDBFF]/.test(text[next - 1])) next--
    const sentences = text.slice(offset, next).trim()
    if (sentences) chunks.push(sentences)
    offset = next
  }
  return { chunks, consumed: offset }
}

function playWav(wav: ArrayBuffer, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const player = new Audio()
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
  player.src = url
  return new Promise((resolve, reject) => {
    let finished = false
    const update = () => {
      if (player.duration > 0) onProgress(Math.min(1, player.currentTime / player.duration))
    }
    const finish = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', finish)
      player.removeEventListener('ended', finish)
      player.removeEventListener('error', fail)
      player.removeEventListener('timeupdate', update)
      player.pause()
      player.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve()
    }
    const fail = (error: unknown) => {
      if (finished) return
      reject(error)
      finish()
    }
    signal.addEventListener('abort', finish, { once: true })
    player.addEventListener('ended', finish)
    player.addEventListener('error', fail)
    player.addEventListener('timeupdate', update)
    void player.play().catch(fail)
  })
}

export function usePatientSpeech(
  encounterId: string | null,
  consultation: { turns: ConsultationTurn[]; streamed: Readonly<Record<string, string>> },
) {
  const [muted, setMuted] = useState(false)
  const [interrupted, setInterrupted] = useState<ReadonlySet<string>>(new Set())
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const playback = useRef<Playback | null>(null)
  const skipped = useRef(new Set<string>())
  const observed = useRef<{ turnId: string; text: string } | null>(null)
  const pending = consultation.turns.find((turn) => turn.status === 'pending')

  const stop = useCallback(() => {
    playback.current?.controller.abort()
    playback.current = null
    setPlayingTurnId(null)
    setProgress(0)
  }, [])

  useEffect(() => {
    observed.current = null
    skipped.current.clear()
    setInterrupted(new Set())
    return stop
  }, [encounterId, stop])

  const interrupt = useCallback(() => {
    const turn = playback.current
    if (!turn?.running) return
    skipped.current.add(turn.turnId)
    setInterrupted((previous) => new Set(previous).add(turn.turnId))
    stop()
  }, [stop])

  const enqueue = useCallback((turnId: string, chunks: string[]) => {
    if (!encounterId || chunks.length === 0) return
    if (playback.current?.turnId !== turnId) {
      stop()
      playback.current = { turnId, controller: new AbortController(), queue: [], total: 0, played: 0, running: false }
    }
    const turn = playback.current
    const signal = turn.controller.signal
    turn.queue.push(...chunks)
    turn.total += chunks.length
    if (turn.running) return
    turn.running = true

    void (async () => {
      try {
        for (let text = turn.queue.shift(); text && !signal.aborted; text = turn.queue.shift()) {
          const wav = await synthesizePatientSpeech(encounterId, turnId, text, signal)
          if (signal.aborted) return
          setPlayingTurnId(turnId)
          const update = (part: number) => setProgress((turn.played + part) / turn.total)
          update(0)
          await playWav(wav, signal, update)
          turn.played++
        }
      } catch {
        if (!signal.aborted) {
          skipped.current.add(turnId)
          stop()
        }
      } finally {
        if (playback.current === turn) {
          turn.running = false
          setPlayingTurnId(null)
        }
      }
    })()
  }, [encounterId, stop])

  useEffect(() => {
    if (!encounterId) return
    const previous = observed.current
    if (previous && previous.turnId !== pending?.turnId) {
      const settled = consultation.turns.find((turn) => turn.turnId === previous.turnId)
      if (settled?.status === 'final' && !muted && !skipped.current.has(settled.turnId)) {
        const rest = settled.text.startsWith(previous.text) ? settled.text.slice(previous.text.length) : settled.text
        enqueue(settled.turnId, speechChunks(rest, true).chunks)
      } else if (settled?.status === 'failed' && playback.current?.turnId === settled.turnId) {
        stop()
      }
    }
    if (!pending) {
      observed.current = null
      return
    }
    const text = consultation.streamed[pending.turnId] ?? ''
    const prefix = previous?.turnId === pending.turnId ? previous.text : ''
    const consumed = text.startsWith(prefix) ? prefix : ''
    const batch = speechChunks(text.slice(consumed.length), false)
    observed.current = { turnId: pending.turnId, text: text.slice(0, consumed.length + batch.consumed) }
    if (!muted && !skipped.current.has(pending.turnId)) enqueue(pending.turnId, batch.chunks)
  }, [encounterId, pending, consultation.turns, consultation.streamed, muted, enqueue, stop])

  const replay = (turn: ConsultationTurn) => {
    stop()
    enqueue(turn.turnId, speechChunks(turn.text, true).chunks)
  }

  const toggleMute = () => {
    if (!muted) {
      if (pending) skipped.current.add(pending.turnId)
      stop()
    }
    setMuted(!muted)
  }

  return { muted, toggleMute, interrupted, playingTurnId, progress, replay, interrupt }
}
