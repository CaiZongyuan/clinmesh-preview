export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export const isReasoningEffort = (value: unknown): value is ReasoningEffort => REASONING_EFFORTS.includes(value as ReasoningEffort)
