import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { EncounterView } from '../../src/shared/encounter'
import type { GoldenCaseQueueEntry } from '../../src/shared/golden-case-queue'

export const goldenCase1QueueEntry: GoldenCaseQueueEntry = {
  caseId: 'golden-case-01',
  queueNumber: 7,
  patientName: '李建国',
  sex: 'male',
  age: 58,
  chiefComplaint: '发热、咳嗽 3 天',
  registeredAt: '2026-11-24T08:31:00+08:00',
  visitKind: 'first',
  queueStatus: 'waiting',
}

// What any Encounter for Golden Case 1 shows the browser, apart from its id, status and times.
export const goldenCase1Chart = {
  caseId: 'golden-case-01',
  caseVersion: casePack.version,
  personaVersion: casePack.cases[0].persona.version,
  practitionerId: 'demo-practitioner',
  patient: {
    name: '李建国',
    sex: 'male',
    age: 58,
    visitKind: 'first',
    outpatientNumber: '20261124-0007',
    registeredAt: '2026-11-24T08:31:00+08:00',
    department: '全科医学科门诊',
    insurance: '城镇职工医保',
    chiefComplaint: '发热、咳嗽 3 天',
  },
  triage: {
    level: 3,
    measuredAt: '2026-11-24T08:20:00+08:00',
    vitals: [
      { kind: 'temperature', value: '38.4', unit: '℃', flag: 'high' },
      { kind: 'pulse', value: '98', unit: '次/分', flag: null },
      { kind: 'respiratory-rate', value: '20', unit: '次/分', flag: null },
      { kind: 'blood-pressure', value: '136/82', unit: 'mmHg', flag: null },
      { kind: 'spo2', value: '95', unit: '%', flag: null },
    ],
  },
  visibleSourceHistory: {
    priorVisits: [
      {
        visitedAt: '2024-03-12T09:10:00+08:00',
        department: '全科医学科',
        reason: '高血压复诊',
        diagnoses: [{ code: 'I10', display: '原发性高血压' }],
        medications: [{ display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' }],
      },
      {
        visitedAt: '2023-11-02T10:20:00+08:00',
        department: '全科医学科',
        reason: '咽痛流涕 2 天',
        diagnoses: [{ code: 'J06.9', display: '急性上呼吸道感染' }],
        medications: [],
      },
      {
        visitedAt: '2015-06-02T15:40:00+08:00',
        department: '急诊科',
        reason: '注射青霉素后呼吸困难、血压下降',
        diagnoses: [{ code: 'T88.6', display: '药物过敏性休克' }],
        medications: [],
      },
    ],
    allergies: [{ agent: '青霉素', reaction: '过敏性休克', onset: '2015-06', source: '急诊抢救记录' }],
    chronicConditions: [{ code: 'I10', display: '原发性高血压', onset: '2014', status: '规律服药，控制可' }],
    priorMedications: [{ display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' }],
  },
} satisfies Omit<EncounterView, 'encounterId' | 'status' | 'startedAt' | 'endedAt'>
