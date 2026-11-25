import type { AgentTool } from '../durable-agent/runtime'
import type { BridgeResult } from '../durable-agent/socket-hub'

export interface CopilotBridge {
  connected(): boolean
  call(tool: 'ui_snapshot' | 'ui_act', args: unknown, signal: AbortSignal, runId: string): Promise<BridgeResult>
}

// Where the latest ui_snapshot's formal (data-agent-confirm) controls are kept, so ui_act on one is refused
// server-side — even after a recovery — before it can ever reach the browser.
export interface ConfirmTargets {
  record(snapshotJson: string): number
  all(): { ref: string; label: string }[]
}

// Snapshot entries that carry a confirm sentence are the Clinical Confirmation buttons.
export const confirmControls = (snapshotJson: string): { ref: string; label: string }[] => {
  try {
    const entries = JSON.parse(snapshotJson) as unknown
    if (!Array.isArray(entries)) return []
    return entries.flatMap((entry) => {
      const e = entry as { ref?: unknown; label?: unknown; confirm?: unknown }
      return typeof e.ref === 'string' && typeof e.confirm === 'string'
        ? [{ ref: e.ref, label: typeof e.label === 'string' ? e.label : e.ref }]
        : []
    })
  } catch {
    return []
  }
}

// A ui_act step names its target by ref or by label; both are checked against the formal controls.
const stepTarget = (step: { ref?: unknown }): string | null => (typeof step.ref === 'string' ? step.ref : null)

const targetRefs = (args: unknown): string[] => {
  const steps = (args as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return []
  return steps.map(stepTarget).filter((ref): ref is string => ref !== null)
}

const DENIED = '被拦截：该按钮需要医生本人的临床确认（Clinical Confirmation），助手无法代为操作。'

// The two bridged tools. Everything else the Copilot reads stays local; these are executed by the browser
// through its ui-sdk bridge, and every call is checkpointed by the runtime like any other tool.
export function uiTools(bridge: CopilotBridge, confirm: ConfirmTargets): Record<string, AgentTool> {
  return {
    ui_snapshot: {
      spec: {
        name: 'ui_snapshot',
        description:
          '读取医生当前界面上可操作组件的快照（含各组件的 ref、label、value 与可用操作，以及需医生本人确认的按钮）。每次写入草稿前必须先读取。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: async (_args, signal, runId) => {
        const res = await bridge.call('ui_snapshot', {}, signal, runId)
        if (!res.ok) return { ok: false, subject: '界面快照', result: res.result }
        const formal = confirm.record(res.result)
        return { ok: true, subject: `界面快照 · ${formal} 个正式按钮`, result: res.result }
      },
    },
    ui_act: {
      spec: {
        name: 'ui_act',
        description:
          '对界面组件执行操作（如向病历草稿字段写入文字）。医生正在编辑或聚焦的字段会转为建议（Suggestion）等待医生采纳；正式确认按钮会被拒绝并记录为被拦截。',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ref: { type: 'string' }, action: { type: 'string' }, args: { type: 'array' } },
                required: ['ref', 'action'],
              },
            },
          },
          required: ['steps'],
          additionalProperties: false,
        },
      },
      execute: async (args, signal, runId) => {
        const targets = targetRefs(args)
        const formal = confirm.all()
        const blocked = targets.find((ref) => formal.some((c) => c.ref === ref || c.label === ref))
        if (blocked) return { ok: false, outcome: 'denied', subject: '被拦截（正式操作）', result: DENIED }
        const res = await bridge.call('ui_act', args, signal, runId)
        if (res.outcome === 'suggestion') return { ok: true, outcome: 'approval', subject: '转为建议（待医生采纳）', result: res.result }
        if (res.outcome === 'denied') return { ok: false, outcome: 'denied', subject: '被拦截（正式操作）', result: res.result }
        if (!res.ok) return { ok: false, subject: '界面操作', result: res.result }
        return { ok: true, subject: '写入草稿', result: res.result }
      },
    },
  }
}
