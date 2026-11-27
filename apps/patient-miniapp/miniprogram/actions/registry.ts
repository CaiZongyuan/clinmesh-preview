import { parseClientAction, type ClientActionSpec } from '../services/agent-stream-reducer'

export interface ActionExecutionResult {
  ok: boolean
  code: 'dispatched' | 'rejected' | 'unavailable'
  route?: string
  reason?: string
}

// Strict whitelisted route mapping for Patient MiniProgram frontend actions.
// Never accepts arbitrary URLs, external domains, or dynamic eval.
export function resolveMiniProgramRoute(action: ClientActionSpec): string {
  switch (action.name) {
    case 'medical.record.open':
      return `/pages/records/detail/index?id=${encodeURIComponent(action.args.recordId)}`
    case 'report.open':
      return `/pages/reports/detail/index?id=${encodeURIComponent(action.args.reportId)}`
    case 'appointment.open': {
      const params: string[] = []
      if (action.args.slotId) params.push(`slotId=${encodeURIComponent(action.args.slotId)}`)
      if (action.args.doctorId) params.push(`doctorId=${encodeURIComponent(action.args.doctorId)}`)
      return `/pages/appointments/book/index${params.length ? `?${params.join('&')}` : ''}`
    }
    case 'followup.open': {
      const params = [`planId=${encodeURIComponent(action.args.planId)}`]
      if (action.args.taskId) params.push(`taskId=${encodeURIComponent(action.args.taskId)}`)
      return `/pages/followup/detail/index?${params.join('&')}`
    }
  }
}

export interface MiniProgramNavigator {
  navigateTo(options: { url: string }): Promise<void> | void
  isForeground(): boolean
}

export async function dispatchWhitelistedAction(
  rawAction: unknown,
  navigator: MiniProgramNavigator,
): Promise<ActionExecutionResult> {
  const action = parseClientAction(rawAction)
  if (!action) {
    return { ok: false, code: 'rejected', reason: 'Unsupported or invalid client action payload' }
  }
  if (!navigator.isForeground()) {
    return { ok: false, code: 'unavailable', reason: 'MiniProgram is not in foreground' }
  }
  const route = resolveMiniProgramRoute(action)
  await navigator.navigateTo({ url: route })
  return { ok: true, code: 'dispatched', route }
}
