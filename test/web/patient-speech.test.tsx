import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../src/web/router'
import { createFakeClinicApi, encounterFor, turnFor } from './fake-clinic-api'

const fetchStub = vi.fn<typeof fetch>()
const ENCOUNTER = 'encounter-1'

beforeEach(() => {
  FakeAudio.instances.length = 0
  vi.stubGlobal('fetch', fetchStub)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:audio-${++createObjectURLCalls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// jsdom has no media stack: a silent mic is enough for the doctor's capture to begin.
function stubMicrophone() {
  const processor = { connect() {}, disconnect() {}, onaudioprocess: null as ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null }
  const track = { stop: vi.fn(), label: '测试麦克风' }
  const stream: { getTracks(): unknown[]; getAudioTracks(): unknown[] } = { getTracks: () => [track], getAudioTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => []) },
    configurable: true,
  })
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48_000
      destination = {}
      createMediaStreamSource() {
        return { connect() {} }
      }
      createAnalyser() {
        return { connect() {}, disconnect() {}, fftSize: 0, getByteTimeDomainData: () => {} }
      }
      createScriptProcessor() {
        return processor
      }
      async close() {}
    },
  )
  return (level: number) => act(() => processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) },
  }))
}

// jsdom has no audio playback: a controllable player whose time the test drives.
class FakeAudio {
  static instances: FakeAudio[] = []
  src = ''
  duration = 4
  currentTime = 0
  paused = true
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>()
  constructor() {
    FakeAudio.instances.push(this)
  }
  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener))
  }
  play() {
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {
    this.src = ''
  }
  private emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
  tick(second: number) {
    this.currentTime = second
    this.emit('timeupdate')
  }
  end() {
    this.currentTime = this.duration
    this.emit('ended')
  }
}

function openEncounter(turns: ReturnType<typeof turnFor>[] = []) {
  const api = createFakeClinicApi({
    encounters: [encounterFor()],
    consultations: { [ENCOUNTER]: turns },
    recognizer: 'paraformer-realtime-v2',
    patientSpeech: true,
  })
  fetchStub.mockImplementation(api.handle)
  vi.stubGlobal('WebSocket', api.WebSocket)
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio)
  return api
}
let createObjectURLCalls = 0

const view = () =>
  render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/encounters/${ENCOUNTER}`] }) })} />)
const column = () => screen.findByRole('region', { name: '问诊记录' })
const live = () => waitFor(() => expect(screen.getByRole('status', { name: '模拟患者连接' })).toHaveTextContent('实时'))
const voiceBar = () => screen.findByTestId('voice-bar')

async function askQuestion(text: string) {
  const user = userEvent.setup()
  await user.type(within(await column()).getByRole('textbox', { name: '键入向患者的提问' }), text)
  await user.click(screen.getByRole('button', { name: '发送' }))
}

describe('patient speech playback', () => {
  it('speaks each completed sentence while the reply still streams, with a progress bar', async () => {
    const api = openEncounter()
    view()
    await column()
    await live()
    await askQuestion('您哪里不舒服？')

    act(() => api.patient.stream(ENCOUNTER, '医生，我这三天'))
    act(() => api.patient.stream(ENCOUNTER, '发烧。'))
    await waitFor(() => expect(api.speechRequests().map((r) => r.text)).toEqual(['医生，我这三天发烧。']))
    // Playback has begun while the text is still streaming (the turn is still pending).
    expect(api.turns(ENCOUNTER)[1].status).toBe('pending')
    const player = await waitFor(() => {
      expect(FakeAudio.instances.length).toBeGreaterThan(0)
      return FakeAudio.instances[0]
    })
    expect(player.paused).toBe(false)
    expect(screen.getByRole('progressbar', { name: /语音播放进度/ })).toBeInTheDocument()

    act(() => api.patient.answer(ENCOUNTER, '医生，我这三天发烧。还咳嗽。'))
    act(() => player.end())
    await waitFor(() => expect(api.speechRequests().map((r) => r.text)).toEqual(['医生，我这三天发烧。', '还咳嗽。']))
    const settledPlayer = await waitFor(() => {
      expect(FakeAudio.instances.length).toBeGreaterThan(1)
      return FakeAudio.instances[1]
    })
    await waitFor(() => expect(screen.getByRole('progressbar', { name: /语音播放进度/ })).toBeInTheDocument())
    act(() => settledPlayer.tick(1))
    // One chunk done, one quarter through the second of two.
    expect(screen.getByRole('progressbar', { name: /语音播放进度/ })).toHaveAttribute('aria-valuenow', '63')
    act(() => settledPlayer.end())
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: /语音播放进度/ })).not.toBeInTheDocument())
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('offers a mute toggle that stops playback and queues nothing further', async () => {
    const api = openEncounter()
    view()
    await column()
    await live()
    await askQuestion('您哪里不舒服？')
    act(() => api.patient.stream(ENCOUNTER, '我发烧了。'))
    await waitFor(() => expect(FakeAudio.instances.length).toBeGreaterThan(0))
    await waitFor(() => expect(FakeAudio.instances[0].paused).toBe(false))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '静音患者语音' }))
    expect(FakeAudio.instances[0].paused).toBe(true)
    act(() => api.patient.answer(ENCOUNTER, '我发烧了。还咳嗽。'))
    await waitFor(() => expect(api.turns(ENCOUNTER)[1].status).toBe('final'))
    expect(api.speechRequests()).toHaveLength(1)
    // Unmuting brings the toggle back.
    await user.click(screen.getByRole('button', { name: '取消患者语音静音' }))
  })

  it('replays a settled patient turn on demand', async () => {
    const api = openEncounter([
      turnFor({ seq: 1, speaker: 'doctor', text: '您哪里不舒服？', source: 'typed', attribution: 'workbench-input', createdAt: new Date().toISOString() }),
      turnFor({
        seq: 2,
        speaker: 'patient',
        status: 'final',
        replyTo: 't1',
        text: '我这三天一直发烧，还咳嗽。',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      }),
    ])
    view()
    await column()
    await live()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重播第 2 条回答' }))
    await waitFor(() => expect(api.speechRequests()).toEqual([{ encounterId: ENCOUNTER, turnId: api.turns(ENCOUNTER)[1].turnId, text: '我这三天一直发烧，还咳嗽。' }]))
    expect(screen.getByRole('progressbar', { name: /语音播放进度/ })).toBeInTheDocument()
  })

  it.each(['按住说话', '开始持续收音'])('interrupts at speech onset when using %s', async (control) => {
    const microphone = stubMicrophone()
    const api = openEncounter()
    view()
    await column()
    await live()
    await askQuestion('您哪里不舒服？')
    act(() => api.patient.stream(ENCOUNTER, '我这三天发烧。'))
    await waitFor(() => expect(FakeAudio.instances[0]?.paused).toBe(false))

    const button = within(await voiceBar()).getByRole('button', { name: control })
    if (control === '按住说话') fireEvent.pointerDown(button)
    else await userEvent.setup().click(button)
    await waitFor(() => expect(api.voiceSockets()).toHaveLength(1))
    microphone(0)
    expect(FakeAudio.instances[0].paused).toBe(false)
    microphone(0.25)

    expect(FakeAudio.instances[0].paused).toBe(true)
    expect(screen.getByText('播放已打断')).toBeInTheDocument()
    act(() => api.patient.answer(ENCOUNTER, '我这三天发烧。还有些咳嗽。'))
    await screen.findByText('我这三天发烧。还有些咳嗽。')
    expect(api.speechRequests()).toHaveLength(1)

    await userEvent.setup().click(screen.getByRole('button', { name: '重播第 2 条回答' }))
    await waitFor(() => expect(FakeAudio.instances[1]?.paused).toBe(false))
    microphone(0.25)
    expect(FakeAudio.instances[1].paused).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('aborts synthesis and drops late audio when leaving the Consultation', async () => {
    const api = openEncounter([
      turnFor({ seq: 2, speaker: 'patient', status: 'final', text: '我还在咳嗽。' }),
    ])
    let pending: { signal: AbortSignal | undefined; resolve(response: Response): void } | undefined
    fetchStub.mockImplementation((input, init) => {
      if (!String(input).endsWith('/speech')) return api.handle(input, init)
      return new Promise((resolve) => { pending = { signal: init?.signal ?? undefined, resolve } })
    })
    const rendered = view()
    await column()
    await userEvent.setup().click(screen.getByRole('button', { name: '重播第 2 条回答' }))
    await waitFor(() => expect(pending?.signal?.aborted).toBe(false))

    rendered.unmount()
    expect(pending?.signal?.aborted).toBe(true)
    await act(async () => pending?.resolve(new Response(new ArrayBuffer(48))))
    expect(FakeAudio.instances).toHaveLength(0)
  })
})
