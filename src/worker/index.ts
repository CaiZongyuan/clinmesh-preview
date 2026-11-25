import { app } from './app'

export { ClinicalCopilotDO } from './clinical-copilot/clinical-copilot-do'
export { ClinicWorkspaceDO } from './clinic-workspace-do'
export { SimulatedPatientDO } from './simulated-patient/simulated-patient-do'

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
