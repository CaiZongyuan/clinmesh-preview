import { Hono } from 'hono'
import type { GoldenCaseQueueResponse } from '../shared/golden-case-queue'

const WORKSPACE_NAME = 'default'

export const app = new Hono<{ Bindings: Env }>().basePath('/api')

app.get('/golden-cases', async (c) => {
  const workspace = c.env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME)
  const goldenCases = await workspace.listGoldenCaseQueue()
  return c.json<GoldenCaseQueueResponse>({ goldenCases })
})
