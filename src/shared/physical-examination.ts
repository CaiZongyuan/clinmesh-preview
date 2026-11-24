import type { VitalSign } from './encounter'

export const BODY_SYSTEMS = ['vitals', 'general', 'pharynx', 'lungs', 'heart', 'abdomen'] as const

export type BodySystem = (typeof BODY_SYSTEMS)[number]

export const BODY_SYSTEM_NAME: Record<BodySystem, string> = {
  vitals: '生命体征',
  general: '一般情况',
  pharynx: '咽部',
  lungs: '肺部',
  heart: '心脏',
  abdomen: '腹部',
}

export const isBodySystem = (value: unknown): value is BodySystem => BODY_SYSTEMS.includes(value as BodySystem)

// One body system examined in one Encounter. Only the vitals examination carries readings.
export interface PhysicalExaminationView {
  system: BodySystem
  finding: string
  vitals: VitalSign[] | null
  practitionerId: string
  examinedAt: string
}

export interface PerformPhysicalExaminationRequest {
  system: BodySystem
}

export interface PhysicalExaminationResponse {
  examination: PhysicalExaminationView
}

export interface PhysicalExaminationsResponse {
  examinations: PhysicalExaminationView[]
}
