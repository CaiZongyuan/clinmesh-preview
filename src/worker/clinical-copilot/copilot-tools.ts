import { BODY_SYSTEM_NAME, isBodySystem } from '../../shared/physical-examination'
import type { AgentTool, ToolResult } from '../durable-agent/runtime'
import type { CopilotRead, CopilotReadResult } from './copilot-reads'
import { uiTools, type CopilotBridge, type ConfirmTargets } from './ui-bridge'

export type ReadWorkspace = <R extends CopilotRead>(read: R) => Promise<CopilotReadResult<R['kind']>>

const json = (data: unknown) => JSON.stringify(data, null, 2)

function answer<R extends CopilotRead>(result: CopilotReadResult<R['kind']>, subject: (data: never) => string): ToolResult {
  if (!result.ok) return { ok: false, subject: '读取失败', result: result.error.message }
  return { ok: true, subject: subject(result.data as never), result: json(result.data) }
}

const text = (args: unknown, key: string): string | undefined => {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

// The Clinical Copilot's whole tool set. Every tool reads what the doctor can see through the workspace's read
// model; none reads Case Truth or changes a formal record. ui_snapshot / ui_act run in the browser over the
// ui-sdk bridge (#14) and stay subject to the same rules.
export function copilotTools(read: ReadWorkspace, bridge?: CopilotBridge, confirm?: ConfirmTargets): Record<string, AgentTool> {
  return {
    ...(bridge && confirm ? uiTools(bridge, confirm) : {}),
    read_encounter_state: {
      spec: {
        name: 'read_encounter_state',
        description: '读取本次就诊的正式状态：患者信息、分诊生命体征、已定稿的问诊记录、已查体部位、已开立检查及进度。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: async () =>
        answer(await read({ kind: 'encounter-state' }), (data: { consultation: unknown[] }) => `就诊状态 · 问诊 ${data.consultation.length} 条`),
    },
    read_visible_source_history: {
      spec: {
        name: 'read_visible_source_history',
        description: '读取本次就诊前已知的既往资料（Visible Source History）：既往就诊、过敏史、慢性病、既往用药。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: async () => answer(await read({ kind: 'visible-source-history' }), () => '既往史与过敏'),
    },
    read_examination_findings: {
      spec: {
        name: 'read_examination_findings',
        description: '读取医生已完成的查体发现。可按部位筛选；未查的部位没有结果。',
        parameters: {
          type: 'object',
          properties: { system: { type: 'string', enum: Object.keys(BODY_SYSTEM_NAME), description: '查体部位，留空为全部' } },
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const system = text(args, 'system')
        const filter = isBodySystem(system) ? system : undefined
        return answer(await read({ kind: 'examination-findings', system: filter }), (data: unknown[]) =>
          `${filter ? BODY_SYSTEM_NAME[filter] : '全部查体'} · ${data.length} 项`,
        )
      },
    },
    read_released_reports: {
      spec: {
        name: 'read_released_reports',
        description: '读取已发布的检查检验报告的全部版本（含医生尚未确认已阅的版本与更正版本）。可按检查申请筛选。',
        parameters: {
          type: 'object',
          properties: { investigationId: { type: 'string', description: '检查申请 ID，留空为全部' } },
          additionalProperties: false,
        },
      },
      execute: async (args) =>
        answer(await read({ kind: 'released-reports', investigationId: text(args, 'investigationId') }), (data: { name: string; version: number }[]) =>
          data.length === 0 ? '暂无已发布报告' : [...new Set(data.map((r) => `${r.name} 第 ${r.version} 版`))].join('、'),
        ),
    },
    search_clinic_catalog: {
      spec: {
        name: 'search_clinic_catalog',
        description: '检索诊所检查检验目录（名称、编码或拼音首字母），返回可开立的项目、标本或部位与预计出报告时间。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '关键词，留空列出全部' } },
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const query = text(args, 'query')
        return answer(await read({ kind: 'catalog', query }), (data: unknown[]) => `检查目录${query ? ` · ${query}` : ''} · ${data.length} 项`)
      },
    },
  }
}
