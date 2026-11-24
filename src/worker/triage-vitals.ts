import type { VitalSign, VitalSignFlag } from '../shared/encounter'

export interface TriageVitals {
  temperatureCelsius: number
  pulseBpm: number
  respiratoryRatePerMin: number
  systolicMmHg: number
  diastolicMmHg: number
  spo2Percent: number
}

const flag = (value: number, low: number, high: number): VitalSignFlag =>
  value < low ? 'low' : value > high ? 'high' : null

// Adult resting reference ranges used for triage flagging.
export function triageVitalSigns(v: TriageVitals): VitalSign[] {
  return [
    { kind: 'temperature', value: String(v.temperatureCelsius), unit: '℃', flag: flag(v.temperatureCelsius, 36, 37.2) },
    { kind: 'pulse', value: String(v.pulseBpm), unit: '次/分', flag: flag(v.pulseBpm, 60, 100) },
    { kind: 'respiratory-rate', value: String(v.respiratoryRatePerMin), unit: '次/分', flag: flag(v.respiratoryRatePerMin, 12, 20) },
    {
      kind: 'blood-pressure',
      value: `${v.systolicMmHg}/${v.diastolicMmHg}`,
      unit: 'mmHg',
      flag: flag(v.systolicMmHg, 90, 139) ?? flag(v.diastolicMmHg, 60, 89),
    },
    { kind: 'spo2', value: String(v.spo2Percent), unit: '%', flag: flag(v.spo2Percent, 95, 100) },
  ]
}
