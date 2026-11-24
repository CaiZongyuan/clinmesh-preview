import { app } from './app'

export { ClinicWorkspaceDO } from './clinic-workspace-do'

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
