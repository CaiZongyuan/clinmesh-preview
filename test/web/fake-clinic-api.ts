import type { EncounterError, EncounterView } from '../../src/shared/encounter'
import type { GoldenCaseQueueEntry } from '../../src/shared/golden-case-queue'
import { BODY_SYSTEM_NAME, isBodySystem, type PhysicalExaminationView } from '../../src/shared/physical-examination'
import { goldenCase1Chart, goldenCase1Findings, goldenCase1QueueEntry } from '../fixtures/golden-case-1'

const STATUS: Record<EncounterError['code'], number> = {
  'invalid-request': 400,
  'golden-case-not-found': 404,
  'encounter-not-found': 404,
  'active-encounter-exists': 409,
  'encounter-not-active': 409,
  'body-system-already-examined': 409,
  'case-version-retired': 409,
}

const refuse = (code: EncounterError['code'], message: string) => Response.json({ error: { code, message } }, { status: STATUS[code] })

export function encounterFor(overrides: Partial<EncounterView> = {}): EncounterView {
  return {
    ...goldenCase1Chart,
    encounterId: 'encounter-1',
    status: 'active',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    endedAt: null,
    ...overrides,
  }
}

// Stands in for the Worker at the fetch boundary, following the HTTP contract the Worker seam tests pin down.
export function examinationFor(system: keyof typeof goldenCase1Findings, examinedAt = new Date().toISOString()): PhysicalExaminationView {
  return { system, ...goldenCase1Findings[system], practitionerId: goldenCase1Chart.practitionerId, examinedAt }
}

export function createFakeClinicApi({
  encounters = [] as EncounterView[],
  examinations = {} as Record<string, PhysicalExaminationView[]>,
} = {}) {
  const state = { encounters: [...encounters], examinations: structuredClone(examinations), started: 0 }
  const active = () => state.encounters.find((e) => e.status === 'active') ?? null

  const queue = (): GoldenCaseQueueEntry[] => [
    { ...goldenCase1QueueEntry, queueStatus: active()?.caseId === goldenCase1QueueEntry.caseId ? 'in-encounter' : 'waiting' },
  ]

  function startEncounter(caseId: string) {
    if (caseId !== goldenCase1QueueEntry.caseId) return refuse('golden-case-not-found', `找不到 Golden Case ${caseId}`)
    if (active()) return refuse('active-encounter-exists', `已有进行中的就诊（${active()!.patient.name}），完诊或放弃该就诊后才能开始新的就诊。`)
    const encounter = encounterFor({ encounterId: `started-${++state.started}`, startedAt: new Date().toISOString() })
    state.encounters.push(encounter)
    return Response.json({ encounter }, { status: 201 })
  }

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/api/golden-cases') return Response.json({ goldenCases: queue() })
    if (method === 'GET' && path === '/api/encounters/active') return Response.json({ encounter: active() })
    if (method === 'POST' && path === '/api/encounters') return startEncounter(JSON.parse(String(init?.body)).caseId)

    const [, encounterId, action] = path.match(/^\/api\/encounters\/([^/]+)(?:\/(.+))?$/) ?? []
    const encounter = state.encounters.find((e) => e.encounterId === encounterId)
    if (!encounter) return refuse('encounter-not-found', `找不到就诊记录 ${encounterId}`)
    if (method === 'GET' && action === undefined) return Response.json({ encounter })
    if (action === 'physical-examinations') {
      const performed = (state.examinations[encounter.encounterId] ??= [])
      if (method === 'GET') return Response.json({ examinations: performed })
      const { system } = JSON.parse(String(init?.body)) as { system: unknown }
      if (!isBodySystem(system)) return refuse('invalid-request', '请求体须为 { "system": BodySystem }')
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      if (performed.some((e) => e.system === system)) {
        return refuse('body-system-already-examined', `本次就诊已查过${BODY_SYSTEM_NAME[system]}，每个部位只查一次。`)
      }
      const examination = examinationFor(system)
      performed.push(examination)
      return Response.json({ examination }, { status: 201 })
    }
    if (method === 'POST' && action === 'abandonment') {
      if (encounter.status !== 'active') return refuse('encounter-not-active', '该就诊已结束，写入已冻结。')
      Object.assign(encounter, { status: 'abandoned', endedAt: new Date().toISOString() })
      return Response.json({ encounter })
    }
    throw new Error(`The fake clinic API has no route for ${method} ${path}`)
  }

  return {
    handle,
    encounters: () => state.encounters,
    // Another browser tab starting an Encounter behind this one's back.
    startElsewhere: (caseId: string) => startEncounter(caseId),
  }
}
