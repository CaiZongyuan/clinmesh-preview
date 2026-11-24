import type { ActiveEncounterResponse, EncounterResponse, EncounterView, ErrorResponse } from '../shared/encounter'
import type { GoldenCaseQueueEntry, GoldenCaseQueueResponse } from '../shared/golden-case-queue'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((body as Partial<ErrorResponse> | null)?.error?.message ?? `请求失败（HTTP ${response.status}）`)
  }
  return body as T
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export async function fetchGoldenCaseQueue(): Promise<GoldenCaseQueueEntry[]> {
  return (await request<GoldenCaseQueueResponse>('/api/golden-cases')).goldenCases
}

export async function fetchActiveEncounter(): Promise<EncounterView | null> {
  return (await request<ActiveEncounterResponse>('/api/encounters/active')).encounter
}

export async function fetchEncounter(encounterId: string): Promise<EncounterView> {
  return (await request<EncounterResponse>(`/api/encounters/${encodeURIComponent(encounterId)}`)).encounter
}

export async function startEncounter(caseId: string): Promise<EncounterView> {
  return (await request<EncounterResponse>('/api/encounters', post({ caseId }))).encounter
}

export async function abandonEncounter(encounterId: string): Promise<EncounterView> {
  const path = `/api/encounters/${encodeURIComponent(encounterId)}/abandonment`
  return (await request<EncounterResponse>(path, post())).encounter
}
