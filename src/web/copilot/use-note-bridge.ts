import { createAgent } from '@ui-sdk/react/agent'
import { useEffect, useRef } from 'react'
import type { ClientMessage, ServerMessage } from '../../shared/agent-wire'
import { MAX_NOTE_SECTION_LENGTH, NOTE_SECTIONS, NOTE_SECTION_NAME } from '../../shared/clinical-note'
import { openCopilotSocket } from '../api'

type Agent = ReturnType<typeof createAgent>
type Step = Parameters<Agent['act']>[0]['steps'][number]
type Answer = Extract<ClientMessage, { type: 'bridge.result' }>

const noteLabels = new Set<string>(NOTE_SECTIONS.map((section) => NOTE_SECTION_NAME[section]))

function bridgeSteps(args: unknown): Step[] | null {
  const steps = (args as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 16) return null
  if (steps.some((step) => !step || typeof step.ref !== 'string' || typeof step.action !== 'string' ||
    (step.args !== undefined && !Array.isArray(step.args)))) return null
  return steps as Step[]
}

function formalControls() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-agent-confirm]')).flatMap((element) => {
    const label = element.getAttribute('aria-label') || element.textContent?.trim()
    const confirm = element.getAttribute('data-agent-confirm')
    return label && confirm ? [{ ref: `formal:${label}`, label, confirm, actions: ['press'] }] : []
  })
}

function view(agent: Agent) {
  const focused = document.activeElement
  const snapshot = agent.snapshot().filter((entry) =>
    !entry.offPage && (noteLabels.has(entry.label ?? '') || entry.label === '病例页签' || Boolean(entry.confirm)),
  ).map((entry) => {
    const field = NOTE_SECTIONS.find((section) => NOTE_SECTION_NAME[section] === entry.label)
    if (!field) return entry
    const input = document.querySelector(`textarea[data-note-section="${field}"]`)
    return {
      ...entry,
      focused: input !== null && input === focused,
      doctorEdited: input?.getAttribute('data-note-author') === 'doctor',
    }
  })
  return [...snapshot, ...formalControls().filter((control) => !snapshot.some((entry) => entry.label === control.label))]
}

export function useNoteBridge(encounterId: string | null) {
  const active = useRef<{ suggestionIds: string[]; runId: string | undefined } | null>(null)

  useEffect(() => {
    if (!encounterId) return
    let denied = false
    let disposed = false
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = 500
    const agent = createAgent({
      allow(step) {
        if (disposed) return false
        if (step.confirm) {
          denied = true
          return false
        }
        if (step.label === '病例页签' && step.component === 'tabs' && step.action === 'setValue') {
          return step.args?.[0] === 'note' || step.args?.[0] === '病历记录'
        }
        const text = step.args?.[0]
        return step.component === 'textarea' && noteLabels.has(step.label ?? '') && step.action === 'setValue' &&
          typeof text === 'string' && text.length <= MAX_NOTE_SECTION_LENGTH
      },
    })

    const handle = async (ws: WebSocket, message: Extract<ServerMessage, { type: 'bridge.call' }>) => {
      if (disposed || socket !== ws) return
      const { callId, tool, args } = message
      const respond = (response: Omit<Answer, 'type' | 'callId'>) => {
        if (!disposed && socket === ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'bridge.result', callId, ...response }))
      }
      if (tool === 'ui_snapshot') {
        respond({ ok: true, result: JSON.stringify(view(agent)) })
        return
      }
      if (tool !== 'ui_act') return
      const steps = bridgeSteps(args)
      if (!steps || active.current) {
        respond({ ok: false, result: '界面操作参数无效，或正在执行另一项操作。' })
        return
      }
      const targets = formalControls()
      if (steps.some((step) => targets.some((target) =>
        target.ref === step.ref || target.label === step.ref || step.args?.includes(target.label),
      ))) {
        respond({ ok: false, outcome: 'denied', result: '被拦截：该操作需要医生本人的临床确认。' })
        return
      }
      const recorded = { suggestionIds: [] as string[], runId: message.runId }
      active.current = recorded
      denied = false
      try {
        const result = await agent.act({ steps })
        if (denied) {
          respond({ ok: false, outcome: 'denied', result: '被拦截：该操作需要医生本人的临床确认。' })
        } else if (recorded.suggestionIds.length) {
          respond({
            ok: true, outcome: 'suggestion',
            result: JSON.stringify({ suggestionIds: recorded.suggestionIds, action: result }),
          })
        } else {
          respond({ ok: result.ok, result: JSON.stringify(result) })
        }
      } catch {
        respond({ ok: false, result: '界面操作失败，请重新读取快照后再试。' })
      } finally {
        if (active.current === recorded) active.current = null
      }
    }

    const connect = () => {
      const ws = openCopilotSocket(encounterId, 'bridge')
      socket = ws
      ws.onopen = () => { delay = 500 }
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage
          if (message.type === 'bridge.call' && typeof message.callId === 'string') void handle(ws, message)
        } catch {}
      }
      ws.onclose = (event) => {
        if (disposed || socket !== ws || event?.reason === 'Bridge replaced') return
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 2, 8000)
      }
    }
    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      active.current = null
      socket?.close()
    }
  }, [encounterId])

  return (suggestionId: string) => {
    active.current?.suggestionIds.push(suggestionId)
    return active.current?.runId
  }
}
