// Context accounting vocabulary shared by both durable agents. The Clinical Copilot's itemized
// breakdown (#13) itemizes every outbound request with these categories; the Case Truth row is added
// by the view, never by the accounting itself.
export type ContextCategory =
  | 'system'
  | 'tools'
  | 'patient_visible'
  | 'consultation'
  | 'his_state_ui'
  | 'replies_thinking'
  | 'tool_results'

export const CONTEXT_CATEGORY_LABEL: Record<ContextCategory, string> = {
  system: '系统提示词',
  tools: '工具定义',
  patient_visible: '患者可见资料',
  consultation: '问诊记录',
  his_state_ui: 'HIS 状态',
  replies_thinking: '回复与思考',
  tool_results: '工具结果',
}

export interface ContextItem {
  id: string
  category: ContextCategory
  label: string
  text: string
  tokens: number
}
