export type QueueStatus = 'in-encounter' | 'waiting' | 'completed'

export type VisitKind = 'first' | 'return'

export type Sex = 'male' | 'female'

export interface GoldenCaseQueueEntry {
  caseId: string
  queueNumber: number
  patientName: string
  sex: Sex
  age: number
  chiefComplaint: string
  registeredAt: string
  visitKind: VisitKind
  queueStatus: QueueStatus
}

export interface GoldenCaseQueueResponse {
  goldenCases: GoldenCaseQueueEntry[]
}
