import type { VitalSign, VitalSignFlag, VitalSignKind } from '../shared/encounter'

// One set of readings, as the Golden Case records it at triage and in the vitals Physical Examination.
export interface VitalReadings {
  temperatureCelsius: number
  pulseBpm: number
  respiratoryRatePerMin: number
  systolicMmHg: number
  diastolicMmHg: number
  spo2Percent: number
}

const flag = (value: number, low: number, high: number): VitalSignFlag =>
  value < low ? 'low' : value > high ? 'high' : null

// Adult resting reference ranges.
export function vitalSigns(v: VitalReadings): VitalSign[] {
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

const ABBREVIATION: Record<VitalSignKind, string> = {
  temperature: 'T',
  pulse: 'P',
  'respiratory-rate': 'R',
  'blood-pressure': 'BP',
  spo2: 'SpO₂',
}

// "T 38.6℃，P 102 次/分，…，SpO₂ 94%（未吸氧）", the way a clinician writes the vitals finding.
export function vitalSignsSentence(signs: VitalSign[], spo2Condition?: string): string {
  return signs
    .map(({ kind, value, unit }) => {
      const reading = `${ABBREVIATION[kind]} ${value}${unit === '℃' || unit === '%' ? '' : ' '}${unit}`
      return kind === 'spo2' && spo2Condition ? `${reading}（${spo2Condition}）` : reading
    })
    .join('，')
}
