import { app } from './app'

export { ClinicalCopilotDO } from './clinical-copilot/clinical-copilot-do'
export { ClinicWorkspaceDO } from './clinic-workspace-do'
export { FollowUpAgentDO } from './followup-agent/followup-agent-do'
export { PatientServiceAgentDO } from './patient-service-agent/patient-service-agent-do'
export { ConsultationVoiceAgent } from './voice/consultation-voice-agent'
export { SimulatedPatientDO } from './simulated-patient/simulated-patient-do'

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
