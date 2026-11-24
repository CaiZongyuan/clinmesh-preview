// Context accounting vocabulary shared by the agents. The Clinical Copilot's itemized breakdown (#13) builds on it.
export type ContextCategory =
  | 'system'
  | 'tools'
  | 'patient_visible'
  | 'consultation'
  | 'his_state_ui'
  | 'replies_thinking'
  | 'tool_results'

export interface ContextItem {
  id: string
  category: ContextCategory
  label: string
  text: string
  tokens: number
}

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/g

// A local estimate, reconciled against provider-reported usage per request: about 0.7 tokens per CJK character
// and one per four other characters.
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 4)
}
