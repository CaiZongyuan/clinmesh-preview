import { COPILOT_COMMANDS, MENTION_KIND_LABEL, type CopilotMention } from '../../shared/copilot-turn'
import { BODY_SYSTEM_NAME } from '../../shared/physical-examination'
import type { CopilotEncounterState } from './copilot-reads'

const SEX = { male: '男', female: '女' } as const

export const COPILOT_SYSTEM_PROMPT = [
  '你是门诊临床助手（Clinical Copilot），在负责医生接诊时提供分析与建议。',
  '',
  '## 规则',
  '- 你只能用只读工具查阅本次就诊中医生同样可见的资料：既往资料、诊所检查目录、就诊状态与问诊记录、已完成的查体发现、已发布的检查检验报告（含未确认已阅的版本）。',
  '- 没有查过的部位、没开立或还没出报告的检查，你都不知道结果；不要推测或编造数值。',
  '- 你没有正式医疗签发权：诊断、开检查、开处方、确认报告已阅、签署病历和完诊都必须由医生本人确认。',
  '- 用简体中文和 Markdown 回答，简洁、分点，说明依据来自哪份资料。',
].join('\n')

// The part of the Copilot's context rebuilt from the workspace before every LLM step, so it is never stale.
export function encounterOverview(state: CopilotEncounterState): string {
  const { patient, triage } = state
  const lines = [
    '## 当前就诊概况',
    `- 患者：${patient.name}，${SEX[patient.sex]}，${patient.age} 岁；${patient.department}；主诉：${patient.chiefComplaint}`,
    `- 分诊（${triage.measuredAt}）：${triage.vitals.map((v) => `${v.kind} ${v.value}${v.unit}`).join('，')}`,
    `- 已查体部位：${state.examinedSystems.map((s) => BODY_SYSTEM_NAME[s]).join('、') || '无'}`,
    `- 已开立检查：${state.investigations.map((i) => `${i.name}（${i.stage}${i.releasedVersions ? `，已发布 ${i.releasedVersions} 版报告` : ''}）`).join('、') || '无'}`,
    '',
    '## 问诊记录（已定稿）',
    ...(state.consultation.length === 0
      ? ['（尚无）']
      : state.consultation.map((turn) => `- ${turn.speaker === 'doctor' ? '医生' : '患者'}：${turn.text}`)),
  ]
  return lines.join('\n')
}

// What the Copilot is asked for a doctor's prompt: a slash command expands to its instruction, and @-mentioned
// HIS objects are listed by id so the Copilot can read them with its tools.
export function promptContent(text: string, mentions: readonly CopilotMention[]): string {
  const command = COPILOT_COMMANDS.find((c) => c.prompt && (text === c.command || text.startsWith(`${c.command} `)))
  const asked = command ? [command.prompt, text.slice(command.command.length).trim()].filter(Boolean).join('\n') : text
  if (mentions.length === 0) return asked
  return [asked, '', '医生引用的 HIS 对象：', ...mentions.map((m) => `- ${MENTION_KIND_LABEL[m.kind]}「${m.label}」（id: ${m.id}）`)].join('\n')
}
