import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsultationTurn } from '../../src/shared/consultation'
import type { EncounterView } from '../../src/shared/encounter'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor, turnFor } from './fake-clinic-api'

const fetchStub = vi.fn<typeof fetch>()
const ENCOUNTER = 'encounter-1'

beforeEach(() => {
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Setup {
  encounters?: EncounterView[]
  turns?: ConsultationTurn[]
  recognizer?: 'web-speech' | 'paraformer-realtime-v2'
}

function openEncounter({ encounters = [encounterFor()], turns = [], recognizer = 'web-speech' }: Setup = {}) {
  const api = createFakeClinicApi({ encounters, consultations: { [ENCOUNTER]: turns }, recognizer })
  fetchStub.mockImplementation(api.handle)
  const voiceConnections = vi.fn()
  // One WebSocket class routing both sockets by URL, like the Worker routes them.
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url: string) {
        if (!url.endsWith('/voice')) return new api.WebSocket(url)
        voiceConnections(url)
        return new api.VoiceSocket(url)
      }
    } as unknown as typeof WebSocket,
  )
  const view = () =>
    render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${ENCOUNTER}`] }) })} />)
  return { api, voiceConnections, view, rendered: view() }
}

const column = () => screen.findByRole('region', { name: '问诊记录' })
const transcriptRows = () => within(screen.getByRole('list', { name: '问诊转写' })).getAllByRole('listitem')
const voiceBar = () => screen.findByTestId('voice-bar')
const openVoiceSocket = (api: ReturnType<typeof createFakeClinicApi>) =>
  waitFor(() => expect(api.voiceSockets()).toHaveLength(1)).then(() => api.voiceSockets()[0])

// jsdom has no media stack: a silent mic and two selectable devices are enough for the browser seam.
function stubMicrophone() {
  const processors: { onaudioprocess: ((event: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void) | null }[] = []
  const track = { stop: vi.fn(), label: '测试麦克风' }
  const stream: { getTracks(): unknown[]; getAudioTracks(): unknown[] } = { getTracks: () => [track], getAudioTracks: () => [track] }
  const getUserMedia = vi.fn(async () => stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-1', kind: 'audioinput', label: '测试麦克风', groupId: 'g', toJSON: {} },
        { deviceId: 'mic-2', kind: 'audioinput', label: '另一支麦克风', groupId: 'g', toJSON: {} },
      ]),
    },
    configurable: true,
  })
  const analyser = { connect() {}, disconnect() {}, fftSize: 0, getByteTimeDomainData: () => {} }
  const processor = {
    connect() {},
    disconnect() {},
    onaudioprocess: null as ((event: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void) | null,
  }
  processors.push(processor)
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48_000
      destination = {}
      createMediaStreamSource() {
        return { connect() {} }
      }
      createAnalyser() {
        return analyser
      }
      createScriptProcessor() {
        return processor
      }
      async close() {}
    },
  )
  // One processor callback run = one 4096-sample frame of silence leaves the browser.
  return {
    getUserMedia,
    stopTrack: track.stop,
    fireAudio() {
      for (const processor of processors) processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
    },
  }
}

// A minimal SpeechRecognition double: the test feeds results through the recorded handler.
function stubSpeechRecognition() {
  const instances: { onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> }) => void) | null; start: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal(
    'SpeechRecognition',
    class {
      continuous = false
      interimResults = false
      lang = ''
      onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> }) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      start = vi.fn(function (this: { __i?: number }) { instances.push(this as never) })
      onend: (() => void) | null = null
      stop = vi.fn(() => this.onend?.())
      abort = vi.fn()
    },
  )
  return instances
}

const finalResult = (text: string) => ({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text, confidence: 0.82 } }] })

describe('voice capture', () => {
  it('falls back to the browser Web Speech API without a Bailian token, and records spoken turns with their metadata', { timeout: 20_000 }, async () => {
    const instances = stubSpeechRecognition()
    const mic = stubMicrophone()
    const { api, voiceConnections } = openEncounter({ recognizer: 'web-speech' })
    await column()
    const user = userEvent.setup()
    await user.click(within(await voiceBar()).getByRole('button', { name: '开始持续收音' }))

    expect(instances).toHaveLength(1)
    act(() => instances[0].onresult!(finalResult('您哪里不舒服？')))
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    const doctor = transcriptRows()[0]
    expect(doctor).toHaveTextContent('语音')
    expect(doctor).toHaveTextContent('您哪里不舒服？')
    expect(doctor).toHaveTextContent('网页识别')
    const request = fetchStub.mock.calls.find(([url, init]) => String(url).endsWith('/consultation/doctor-turns') && init?.method === 'POST')!
    expect(JSON.parse(String(request[1]!.body))).toMatchObject({ voice: { recognizer: 'web-speech', confidence: 0.82 } })
    await waitFor(() => expect(api.turns(ENCOUNTER)[0]).toMatchObject({ source: 'voice', voice: { recognizer: 'web-speech' } }))
    expect(voiceConnections).not.toHaveBeenCalled()
    expect(mic.getUserMedia).not.toHaveBeenCalled()
  })

  it('commits a hold as one Web Speech turn on release', async () => {
    const instances = stubSpeechRecognition()
    const mic = stubMicrophone()
    const { api, voiceConnections } = openEncounter({ recognizer: 'web-speech' })
    const bar = await voiceBar()
    await waitFor(() => expect(within(bar).getByRole('status', { name: '语音识别状态' })).toHaveTextContent('网页语音识别'))

    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    try {
      fireEvent.pointerDown(within(bar).getByRole('button', { name: '按住说话' }))
      expect(instances).toHaveLength(1)
      act(() => {
        instances[0].onresult!(finalResult('咳嗽有痰吗？'))
        instances[0].onresult!(finalResult('什么颜色？'))
      })
      expect(api.turns(ENCOUNTER)).toHaveLength(0)

      clock.mockReturnValue(startedAt + 650)
      fireEvent.pointerUp(within(bar).getByRole('button', { name: /正在录音/ }))
    } finally {
      clock.mockRestore()
    }
    await waitFor(() => expect(api.turns(ENCOUNTER)[0]).toMatchObject({
      source: 'voice',
      text: '咳嗽有痰吗？什么颜色？',
      voice: { recognizer: 'web-speech', durationMs: 650, confidence: 0.82 },
    }))
    expect(voiceConnections).not.toHaveBeenCalled()
    expect(mic.getUserMedia).not.toHaveBeenCalled()
  })

  it('streams to the Paraformer voice socket in continuous mode, shows interim captions, and accepts the recorded turn', { timeout: 20_000 }, async () => {
    stubMicrophone()
    const { api } = openEncounter({ recognizer: 'paraformer-realtime-v2' })
    await column()
    const bar = await voiceBar()
    const user = userEvent.setup()

    expect(within(bar).getByRole('status', { name: '语音识别状态' })).toHaveTextContent('未连接')
    await user.click(within(bar).getByRole('button', { name: '开始持续收音' }))
    const socket = await openVoiceSocket(api)
    await waitFor(() => expect(socket.sent.map((m) => m.type)).toEqual(['clinmesh.capture', 'start_call']))
    expect(socket.sent[0].mode).toBe('continuous')
    await waitFor(async () => expect(within(await voiceBar()).getByRole('status', { name: '语音识别状态' })).toHaveTextContent('识别服务已连接'))

    socket.interim('您哪里不')
    await waitFor(async () => expect(within(await voiceBar()).getByLabelText('正在收音')).toHaveTextContent('您哪里不'))

    const doctor = api.spokenTurn(2, '您哪里不舒服？')
    const patient = turnFor({ seq: 3, speaker: 'patient', replyTo: doctor.turnId, status: 'pending', deadlineAt: new Date(Date.now() + 30_000).toISOString() })
    socket.voiceTurn(doctor, patient)
    await waitFor(() => expect(transcriptRows()).toHaveLength(2))
    const row = transcriptRows()[0]
    expect(row).toHaveTextContent('语音 · 1.4s · Paraformer')
    await waitFor(async () => expect(within(await voiceBar()).getByRole('status', { name: '语音识别状态' })).toHaveTextContent('延迟 120ms'))
    // The interim caption is gone once the sentence finalized into a doctor turn.
    await waitFor(async () => expect(within(await voiceBar()).queryByLabelText('正在收音')).not.toHaveTextContent('您哪里不'))
  })

  it('push-to-talk commits on release, and discards a slide-up cancel', { timeout: 20_000 }, async () => {
    stubMicrophone()
    const { api } = openEncounter({ recognizer: 'paraformer-realtime-v2' })
    await column()
    const bar = await voiceBar()
    const holdButton = await within(bar).findByRole('button', { name: '按住说话' })

    fireEvent.pointerDown(holdButton)
    const socket = await openVoiceSocket(api)
    expect(socket.sent[0].mode).toBe('hold')

    // Sliding up arms cancellation; releasing discards without a commit. The holding button is a fresh
    // element (the bar swaps its controls when the capture opens), so re-query before the move.
    const holdingButton = await within(await voiceBar()).findByRole('button', { name: /正在录音/ })
    fireEvent.pointerMove(holdingButton, { clientY: -80 })
    await waitFor(async () => expect(within(await voiceBar()).getByRole('button', { name: '松开以取消' })).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 650)) // longer than the accidental-tap minimum
    fireEvent.pointerUp(within(await voiceBar()).getByRole('button', { name: '松开以取消' }))
    await waitFor(() => expect(screen.getByText('已取消，这段话没有记录。')).toBeInTheDocument())
    expect(socket.sent.filter((m) => m.type === 'clinmesh.commit')).toHaveLength(0)

    // A fresh hold that lasts past the minimum releases normally and commits the capture.
    const fresh = await within(await voiceBar()).findByRole('button', { name: '按住说话' })
    const firstSockets = api.voiceSockets()
    fireEvent.pointerDown(fresh)
    await waitFor(() => expect(api.voiceSockets()).toHaveLength(1))
    const second = api.voiceSockets().find((s) => !firstSockets.includes(s))!
    await new Promise((resolve) => setTimeout(resolve, 650))
    fireEvent.pointerUp(await within(await voiceBar()).findByRole('button', { name: /正在录音/ }))
    await waitFor(() => expect(second.sent.map((m) => m.type)).toContain('clinmesh.commit'))
  })

  it('discards holds shorter than 600 ms with a notice', { timeout: 20_000 }, async () => {
    stubMicrophone()
    const { api } = openEncounter({ recognizer: 'paraformer-realtime-v2' })
    await column()
    const bar = await voiceBar()
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(within(bar).getByRole('button', { name: '按住说话' }))
      await vi.waitFor(() => expect(api.voiceSockets()).toHaveLength(1))
      const socket = api.voiceSockets()[0]
      act(() => vi.advanceTimersByTime(300))
      fireEvent.pointerUp(within(screen.getByTestId('voice-bar')).getByRole('button', { name: /正在录音/ }))
      await vi.waitFor(() => expect(screen.getByText(/按得太短/)).toBeInTheDocument())
      expect(socket.sent.filter((m) => m.type === 'clinmesh.commit')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pausing releases the microphone and shows a persistent privacy banner', { timeout: 20_000 }, async () => {
    const mic = stubMicrophone()
    const { api } = openEncounter({ recognizer: 'paraformer-realtime-v2' })
    await column()
    const bar = await voiceBar()
    const user = userEvent.setup()
    await user.click(within(bar).getByRole('button', { name: '开始持续收音' }))
    const socket = await openVoiceSocket(api)
    await waitFor(async () => expect(within(await voiceBar()).getByRole('status', { name: '语音识别状态' })).toHaveTextContent('识别服务已连接'))

    // The mic streams a frame, then pausing gates it: no audio frame leaves the browser while paused,
    // so nothing can be transcribed.
    mic.fireAudio()
    expect(socket.frames).toBe(1)
    await user.click(within(await voiceBar()).getByRole('button', { name: '暂停收音' }))
    const banner = await screen.findByRole('status', { name: '麦克风已暂停' })
    expect(banner).toHaveTextContent('不会收音')
    expect(mic.stopTrack).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText('正在收音')).not.toBeInTheDocument()
    mic.fireAudio()
    expect(socket.frames).toBe(1) // paused: nothing is transcribed
    expect(within(await voiceBar()).getByRole('button', { name: '恢复收音' })).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByRole('status', { name: '麦克风已暂停' })).toBeInTheDocument() // persistent

    await user.click(within(await voiceBar()).getByRole('button', { name: '恢复收音' }))
    expect(mic.getUserMedia).toHaveBeenCalledTimes(2)
    mic.fireAudio()
    expect(socket.frames).toBe(2)
  })

  it('lets Space activate a focused workbench button', async () => {
    stubMicrophone()
    const { voiceConnections } = openEncounter({ recognizer: 'paraformer-realtime-v2' })
    const consultation = await column()
    const collapse = within(consultation).getByRole('button', { name: '收起问诊记录' })
    await voiceBar()
    collapse.focus()
    await userEvent.setup().keyboard(' ')

    expect(await screen.findByRole('button', { name: '展开问诊记录' })).toBeInTheDocument()
    expect(voiceConnections).not.toHaveBeenCalled()
  })

  it('M toggles hands-free listening and Space is push-to-talk', { timeout: 20_000 }, async () => {
    stubMicrophone()
    const { api } = openEncounter({ recognizer: 'paraformer-realtime-v2' })
    await column()
    await voiceBar()

    fireEvent.keyDown(document, { code: 'KeyM' })
    await openVoiceSocket(api)
    fireEvent.keyDown(document, { code: 'KeyM' })
    await waitFor(() => expect(api.voiceSockets()).toHaveLength(0))

    fireEvent.keyDown(document, { code: 'Space' })
    await waitFor(() => expect(api.voiceSockets()).toHaveLength(1))
    const socket = api.voiceSockets()[0]
    expect(within(await voiceBar()).getByRole('button', { name: /正在录音/ })).toBeInTheDocument()
    const composer = screen.getByRole('textbox', { name: '键入向患者的提问' })
    composer.focus()
    fireEvent.keyUp(composer, { code: 'Space' })
    await waitFor(async () => expect(within(await voiceBar()).getByRole('button', { name: '按住说话' })).toBeInTheDocument())
    // Released instantly: too short, so no commit, no recorded turn, and the tap notice says so.
    expect(socket.sent.filter((m) => m.type === 'clinmesh.commit')).toHaveLength(0)
    expect(screen.getByText(/按得太短/)).toBeInTheDocument()
  })
})
