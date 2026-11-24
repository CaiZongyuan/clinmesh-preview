import type { GoldenCaseQueueEntry, GoldenCaseQueueResponse } from '../shared/golden-case-queue'

export async function fetchGoldenCaseQueue(): Promise<GoldenCaseQueueEntry[]> {
  const response = await fetch('/api/golden-cases')
  if (!response.ok) {
    throw new Error(`候诊队列加载失败（HTTP ${response.status}）`)
  }
  const body: GoldenCaseQueueResponse = await response.json()
  return body.goldenCases
}
