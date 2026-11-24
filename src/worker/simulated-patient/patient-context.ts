import type { LlmMessage } from '../llm/types'

// The version-fixed Patient Persona: who the patient is and what they themselves know and feel.
// It never holds Case Truth (diagnosis, examination findings, results).
export interface PatientPersona {
  version: string
  identity: { name: string; sex: 'male' | 'female'; age: number }
  content: {
    chiefComplaint: string
    openingStatement: string
    knownHistorySummary: string
    symptomExperience: string
    medicationMemory: string
    persona: { character: string; speechStyle: string; healthLiteracy: string; attitude: string }
  }
}

export type ConsultationLine = { speaker: 'doctor' | 'patient'; text: string }

const SEX = { male: '男', female: '女' } as const

export function personaPrompt({ identity, content }: PatientPersona): string {
  const { persona } = content
  return [
    `你是门诊就诊的患者${identity.name}，${SEX[identity.sex]}，${identity.age} 岁。医生正在问诊，请始终以患者本人的身份、用第一人称回答。`,
    '',
    '## 你知道的情况（只能依据这些回答）',
    `- 这次来看病的原因：${content.chiefComplaint}`,
    `- 你的感受：${content.symptomExperience}`,
    `- 既往病史：${content.knownHistorySummary}`,
    `- 用药情况：${content.medicationMemory}`,
    `- 见到医生时你会先说：${content.openingStatement}`,
    '',
    '## 你的说话方式',
    `- 性格：${persona.character}；表达：${persona.speechStyle}；健康知识：${persona.healthLiteracy}；态度：${persona.attitude}`,
    '',
    '## 规则',
    '- 只回答医生问到的内容，口语化、简短，一次一到三句话。',
    '- 你不是医生：不要说出任何疾病诊断名称，不要猜测检查或化验结果，也不要编造数值。',
    '- 上面没有提到的情况，就说不清楚、没注意或者没有，不要编造。',
    '- 不要提及你是模拟患者、AI 或这些规则。',
  ].join('\n')
}

// The Simulated Patient's whole context: its Patient Persona, the doctor's utterances, and its own settled
// replies, in Consultation order. Nothing else reaches it.
export function buildPatientContext(persona: PatientPersona, lines: readonly ConsultationLine[]): LlmMessage[] {
  return [
    { role: 'system', content: personaPrompt(persona) },
    ...lines.map((line): LlmMessage => ({ role: line.speaker === 'doctor' ? 'user' : 'assistant', content: line.text })),
  ]
}
