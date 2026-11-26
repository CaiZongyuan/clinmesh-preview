import type { ClinicMode } from '../shared/auth'

// Default Phase 1 simulation workspace; Connected Clinic runs in its own isolated DO namespace.
export const WORKSPACE_NAME = 'default'
export const CONNECTED_WORKSPACE_NAME = 'connected-clinic'

export interface WorkspaceModeEnv {
  CLINIC_MODE?: string
  CLINIC_WORKSPACE_NAME?: string
}

export function clinicMode(env?: WorkspaceModeEnv): ClinicMode {
  return env?.CLINIC_MODE === 'connected' ? 'connected' : 'simulation'
}

export function workspaceName(env?: WorkspaceModeEnv): string {
  const configured = env?.CLINIC_WORKSPACE_NAME?.trim()
  if (configured) return configured
  return clinicMode(env) === 'connected' ? CONNECTED_WORKSPACE_NAME : WORKSPACE_NAME
}
