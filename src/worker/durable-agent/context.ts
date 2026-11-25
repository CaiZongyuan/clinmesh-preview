// Token estimation, and a re-export of the accounting vocabulary shared with the browser's 上下文 view.
export { CONTEXT_CATEGORY_LABEL, type ContextCategory, type ContextItem } from '../../shared/agent-context'
import type { ContextItem } from '../../shared/agent-context'

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/g

// A local estimate, reconciled against provider-reported usage per request: about 0.7 tokens per CJK character
// and one per four other characters.
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 4)
}

export const contextItemTotal = (items: ContextItem[]): number => items.reduce((sum, item) => sum + item.tokens, 0)
