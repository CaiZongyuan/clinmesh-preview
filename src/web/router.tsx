import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type ErrorComponentProps,
  type RouterHistory,
} from '@tanstack/react-router'
import { fetchGoldenCaseQueue } from './api'
import { Workbench } from './workbench/workbench'

const rootRoute = createRootRoute({ component: Outlet })

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: fetchGoldenCaseQueue,
  component: WorkbenchRoute,
  errorComponent: WorkbenchLoadError,
})

function WorkbenchRoute() {
  const queue = workbenchRoute.useLoaderData()
  return <Workbench queue={queue} />
}

function WorkbenchLoadError({ error }: ErrorComponentProps) {
  return (
    <main className="grid h-full place-items-center p-6">
      <p role="alert" className="text-destructive">
        {error instanceof Error ? error.message : '工作台加载失败'}
      </p>
    </main>
  )
}

const routeTree = rootRoute.addChildren([workbenchRoute])

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, history: options.history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
