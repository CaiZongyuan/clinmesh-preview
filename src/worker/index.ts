import { app } from './app'

export { ClinicWorkspaceDO } from './clinic-workspace-do'
export { SimulatedPatientDO } from './simulated-patient/simulated-patient-do'

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
