import type { VitalSign } from '../shared/encounter'

export interface TriageVitals {
  temperatureCelsius: number
  pulseBpm: number
  respiratoryRatePerMin: number
  systolicMmHg: number
  diastolicMmHg: number
  spo2Percent: number
}

const outside = (value: number, low: number, high: number) => value < low || value > high

// Adult resting reference ranges used for triage flagging.
export function triageVitalSigns(v: TriageVitals): VitalSign[] {
  return [
    { kind: 'temperature', value: String(v.temperatureCelsius), unit: '℃', abnormal: outside(v.temperatureCelsius, 36, 37.2) },
    { kind: 'pulse', value: String(v.pulseBpm), unit: '次/分', abnormal: outside(v.pulseBpm, 60, 100) },
    { kind: 'respiratory-rate', value: String(v.respiratoryRatePerMin), unit: '次/分', abnormal: outside(v.respiratoryRatePerMin, 12, 20) },
    {
      kind: 'blood-pressure',
      value: `${v.systolicMmHg}/${v.diastolicMmHg}`,
      unit: 'mmHg',
      abnormal: outside(v.systolicMmHg, 90, 139) || outside(v.diastolicMmHg, 60, 89),
    },
    { kind: 'spo2', value: String(v.spo2Percent), unit: '%', abnormal: v.spo2Percent < 95 },
  ]
}
