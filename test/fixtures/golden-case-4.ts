import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { EncounterView } from '../../src/shared/encounter'
import type { GoldenCaseQueueEntry } from '../../src/shared/golden-case-queue'
import type { BodySystem, PhysicalExaminationView } from '../../src/shared/physical-examination'

export const goldenCase4QueueEntry: GoldenCaseQueueEntry = {
  caseId: 'golden-case-04',
  queueNumber: 10,
  patientName: '王雅琴',
  sex: 'female',
  age: 34,
  chiefComplaint: '鼻塞、流涕、咽痛 3 天',
  registeredAt: '2026-11-24T09:12:00+08:00',
  visitKind: 'first',
  queueStatus: 'waiting',
}

// What any Encounter for Golden Case 4 shows the browser, apart from its id, status and times.
export const goldenCase4Chart = {
  caseId: 'golden-case-04',
  caseVersion: casePack.version,
  personaVersion: casePack.cases.find((c) => c.id === 'golden-case-04')!.persona.version,
  practitionerId: 'demo-practitioner',
  patient: {
    name: '王雅琴',
    sex: 'female',
    age: 34,
    visitKind: 'first',
    outpatientNumber: '20261124-0010',
    registeredAt: '2026-11-24T09:12:00+08:00',
    department: '全科医学科门诊',
    insurance: '城乡居民医保',
    chiefComplaint: '鼻塞、流涕、咽痛 3 天',
  },
  triage: {
    level: 4,
    measuredAt: '2026-11-24T09:00:00+08:00',
    vitals: [
      { kind: 'temperature', value: '36.8', unit: '℃', flag: null },
      { kind: 'pulse', value: '78', unit: '次/分', flag: null },
      { kind: 'respiratory-rate', value: '16', unit: '次/分', flag: null },
      { kind: 'blood-pressure', value: '118/76', unit: 'mmHg', flag: null },
      { kind: 'spo2', value: '99', unit: '%', flag: null },
    ],
  },
  visibleSourceHistory: {
    priorVisits: [
      {
        visitedAt: '2024-01-15T10:40:00+08:00',
        department: '全科医学科',
        reason: '咽痛、流涕 2 天',
        diagnoses: [{ code: 'J06.9', display: '急性上呼吸道感染' }],
        medications: [],
      },
    ],
    allergies: [],
    chronicConditions: [],
    priorMedications: [],
  },
} satisfies Omit<EncounterView, 'encounterId' | 'status' | 'startedAt' | 'endedAt'>

// What each body system's Physical Examination reveals for Golden Case 4, apart from who examined it and when.
export const goldenCase4Findings = {
  vitals: {
    finding: 'T 37.3℃，P 84 次/分，R 18 次/分，BP 120/78 mmHg，SpO₂ 98%（未吸氧）',
    vitals: [
      { kind: 'temperature', value: '37.3', unit: '℃', flag: 'high' },
      { kind: 'pulse', value: '84', unit: '次/分', flag: null },
      { kind: 'respiratory-rate', value: '18', unit: '次/分', flag: null },
      { kind: 'blood-pressure', value: '120/78', unit: 'mmHg', flag: null },
      { kind: 'spo2', value: '98', unit: '%', flag: null },
    ],
  },
  general: { finding: '神志清，一般情况可', vitals: null },
  pharynx: { finding: '咽部充血明显，扁桃体不大，未见脓性分泌物', vitals: null },
  lungs: { finding: '双肺呼吸音清，未闻及干湿啰音', vitals: null },
  heart: { finding: '律齐，未闻及杂音', vitals: null },
  abdomen: { finding: '腹软，无压痛', vitals: null },
} satisfies Record<BodySystem, Pick<PhysicalExaminationView, 'finding' | 'vitals'>>
