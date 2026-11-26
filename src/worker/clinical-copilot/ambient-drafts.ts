import { NOTE_SECTION_NAME, type NoteSection } from '../../shared/clinical-note'
import type { CopilotAnalysisEvent } from '../../shared/copilot-turn'

export function isGreeting(text: string) {
  const words = text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
  return /^(?:(?:你好|您好|大家好|早上好|上午好|下午好|晚上好|早安|hello|hi|hey|哈喽|嗨)(?:呀|啊|哇|哦|呢)?)+$/.test(words)
}

export function eventSections(event: CopilotAnalysisEvent): NoteSection[] {
  if (event.ref.startsWith('examination:') || event.ref.startsWith('report:')) return ['findings']
  if (!event.ref.startsWith('consultation:')) return []
  if (/过敏|既往|慢病|病史|用药史|长期服药/.test(event.text)) return ['past-history']
  return ['chief-complaint', 'present-illness']
}

export function allowedAmbientEdit(args: unknown, snapshot: string | null, sections: NoteSection[]) {
  const steps = (args as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps) || !steps.length || !snapshot) return false
  const labels = new Set(sections.map((section) => NOTE_SECTION_NAME[section]))
  let entries: unknown
  try { entries = JSON.parse(snapshot) } catch { return false }
  if (!Array.isArray(entries)) return false
  return steps.every((step) => {
    if (step?.action !== 'setValue' || typeof step.args?.[0] !== 'string' || !step.args[0].trim()) return false
    return entries.some((entry) => entry && (entry.ref === step.ref || entry.label === step.ref) &&
      (entry.component === 'textarea' || entry.component === 'input') && labels.has(entry.label))
  })
}
