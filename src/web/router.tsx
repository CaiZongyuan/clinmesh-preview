import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type ErrorComponentProps,
  type RouterHistory,
} from '@tanstack/react-router'
import { fetchActiveEncounter, fetchEncounter, fetchGoldenCaseQueue, fetchPhysicalExaminations } from './api'
import { Workbench } from './workbench/workbench'

const rootRoute = createRootRoute({ component: Outlet })

// Without a selected case, the workbench opens the workspace's active Encounter, so a reload lands back in it.
const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { case?: string } =>
    typeof search.case === 'string' ? { case: search.case } : {},
  loaderDeps: ({ search }) => ({ caseId: search.case }),
  loader: async ({ deps }) => {
    const [queue, active] = await Promise.all([fetchGoldenCaseQueue(), fetchActiveEncounter()])
    if (active && !deps.caseId) {
      throw redirect({ to: '/encounters/$encounterId', params: { encounterId: active.encounterId }, replace: true })
    }
    return { queue, selected: queue.find((entry) => entry.caseId === deps.caseId) }
  },
  component: function WorkbenchRoute() {
    const { queue, selected } = workbenchRoute.useLoaderData()
    return <Workbench queue={queue} focus={selected ? { kind: 'registration', entry: selected } : { kind: 'none' }} />
  },
  errorComponent: WorkbenchLoadError,
})

const encounterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/encounters/$encounterId',
  loader: async ({ params }) => {
    const [queue, encounter, examinations] = await Promise.all([
      fetchGoldenCaseQueue(),
      fetchEncounter(params.encounterId),
      fetchPhysicalExaminations(params.encounterId),
    ])
    return { queue, encounter, examinations }
  },
  component: function EncounterRoute() {
    const { queue, encounter, examinations } = encounterRoute.useLoaderData()
    return <Workbench queue={queue} focus={{ kind: 'encounter', encounter, examinations }} />
  },
  errorComponent: WorkbenchLoadError,
})

function WorkbenchLoadError({ error }: ErrorComponentProps) {
  return (
    <main className="grid h-full place-items-center p-6">
      <p role="alert" className="text-destructive">
        {error instanceof Error ? error.message : '工作台加载失败'}
      </p>
    </main>
  )
}

const routeTree = rootRoute.addChildren([workbenchRoute, encounterRoute])

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, history: options.history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
