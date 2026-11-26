import { Button } from '@ui-sdk/react/button'
import { HomeIcon, MessageCircleIcon, SparklesIcon, UserIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NotificationRegion, StatusToastRegion, type ClinicFeedback, type NotificationTarget } from './clinic-feedback'
import { Shockwave, type ShockwavePulse } from './clinic-motion'
import './clinic-motion.css'
import type { ClinicActions, ConnectedClinicState } from './connected-clinic-store'
import { ChatView, type ChatIntent } from './patient-chat'
import './patient-mobile.css'
import {
  BookingPage,
  FollowupPage,
  HomePage,
  InboxPage,
  IsolationBanner,
  MembersPage,
  ProfilePage,
  RecordsPage,
  ResourcePage,
  type ResourceKind,
} from './patient-pages'

export type MobileTab = 'home' | 'messages' | 'assistant' | 'profile'

type Page =
  | { kind: 'chat'; conversationId: string }
  | { kind: 'book'; slotId?: string; fromAgent: boolean }
  | { kind: 'records'; resourceKind: ResourceKind }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'followup'; planId: string }
  | { kind: 'members'; conversationId: string }

type Direction = 'push' | 'pop' | 'tab'

const LOAD_MS = 700

const TABS = [
  { id: 'home', label: '首页', icon: HomeIcon },
  { id: 'messages', label: '消息', icon: MessageCircleIcon },
  { id: 'assistant', label: '助手', icon: SparklesIcon },
  { id: 'profile', label: '我的', icon: UserIcon },
] as const

function pageKey(page: Page) {
  if (page.kind === 'chat' || page.kind === 'members') return `${page.kind}:${page.conversationId}`
  if (page.kind === 'records') return 'records'
  if (page.kind === 'resource') return `resource:${page.resourceId}`
  if (page.kind === 'followup') return `followup:${page.planId}`
  return 'book'
}

function StatusBar() {
  return (
    <div className="cc-m-statusbar" aria-hidden="true">
      <span>9:41</span>
      <span className="cc-m-island" />
      <span className="flex items-center gap-1.5">
        <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
          <rect x="0" y="7" width="3" height="4" rx="1" />
          <rect x="4.5" y="5" width="3" height="6" rx="1" />
          <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
          <rect x="13.5" y="0" width="3" height="11" rx="1" />
        </svg>
        <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="currentColor" opacity="0.4" />
          <rect x="2" y="2" width="15" height="8" rx="2" fill="currentColor" />
          <rect x="23" y="4" width="1.5" height="4" rx="0.75" fill="currentColor" opacity="0.4" />
        </svg>
      </span>
    </div>
  )
}

export function PatientMobileApp({
  state,
  actions,
  feedback,
  mode,
}: {
  state: ConnectedClinicState
  actions: ClinicActions
  feedback: ClinicFeedback
  mode: 'device' | 'fullscreen'
}) {
  const [tab, setTab] = useState<MobileTab>('home')
  const [stack, setStack] = useState<Page[]>([])
  const [direction, setDirection] = useState<Direction>('tab')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [visited, setVisited] = useState<Record<string, boolean>>({})
  const [pulse, setPulse] = useState<ShockwavePulse | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const assistantTabRef = useRef<HTMLButtonElement>(null)

  useEffect(() => () => actions.focusConversation('patient', null), [actions])

  const patientKey = state.currentPatient
  const mine = state.conversations.filter((c) => c.patientKey === patientKey)
  const assistant = mine.find((c) => c.type === 'patient_assistant')
  const doctorChat = mine.find((c) => c.type === 'patient_doctor')
  const unreadTotal = mine.reduce((sum, c) => sum + (c.type === 'patient_assistant' ? 0 : c.unreadPatient), 0)
  const page = stack.at(-1)

  const load = (key: string) => {
    if (visited[key]) return
    setVisited((prev) => ({ ...prev, [key]: true }))
    setPending((prev) => ({ ...prev, [key]: true }))
    setTimeout(() => setPending((prev) => ({ ...prev, [key]: false })), LOAD_MS)
  }

  const go = (nextTab: MobileTab, nextStack: Page[], nextDirection: Direction) => {
    setTab(nextTab)
    setStack(nextStack)
    setDirection(nextDirection)
    const top = nextStack.at(-1)
    const focused = top?.kind === 'chat' ? top.conversationId : !top && nextTab === 'assistant' ? assistant?.id ?? null : null
    actions.focusConversation('patient', focused)
  }

  const push = (next: Page) => {
    if (next.kind === 'chat') load(`chat:${next.conversationId}`)
    if (next.kind === 'records') load(`records:${next.resourceKind}`)
    go(tab, [...stack.filter((p) => pageKey(p) !== pageKey(next)), next], 'push')
  }

  const back = () => go(tab, stack.slice(0, -1), 'pop')

  const shockFrom = (origin?: HTMLElement | null) => {
    const screen = screenRef.current
    const source = origin ?? assistantTabRef.current
    if (!screen || !source) return
    const s = screen.getBoundingClientRect()
    const o = source.getBoundingClientRect()
    setPulse({ id: Date.now(), x: o.left + o.width / 2 - s.left, y: o.top + o.height / 2 - s.top })
  }

  const openAssistant = (origin?: HTMLElement, prompt?: string) => {
    if (!(tab === 'assistant' && stack.length === 0)) shockFrom(origin)
    go('assistant', [], 'tab')
    if (prompt) actions.askPatientAgent(prompt)
  }

  const openConversation = (conversationId: string) => {
    if (conversationId === assistant?.id) {
      openAssistant()
      return
    }
    load(`chat:${conversationId}`)
    go('messages', [{ kind: 'chat', conversationId }], 'push')
  }

  const openResource = (resourceId: string) => {
    const resource = state.resources.find((r) => r.id === resourceId)
    if (!resource || resource.patientKey !== patientKey || !resource.published) {
      actions.testCrossPatientIsolation()
      return
    }
    push({ kind: 'resource', resourceId })
  }

  const onIntent = (intent: ChatIntent) => {
    switch (intent.kind) {
      case 'book':
        push({ kind: 'book', slotId: intent.slotId, fromAgent: intent.fromAgent })
        return
      case 'resource':
        openResource(intent.resourceId)
        return
      case 'followup':
        push({ kind: 'followup', planId: intent.planId })
        return
      case 'doctor':
        if (!doctorChat) return
        if (intent.draft) setDrafts((prev) => ({ ...prev, [doctorChat.id]: intent.draft ?? '' }))
        openConversation(doctorChat.id)
        return
      case 'assistant':
        openAssistant(intent.origin, intent.prompt)
        return
      case 'members':
        if (page?.kind === 'chat') push({ kind: 'members', conversationId: page.conversationId })
    }
  }

  const openTarget = (target: NotificationTarget) => {
    if (target.kind === 'conversation') openConversation(target.conversationId)
    else if (target.kind === 'resource') {
      go(tab, [], 'tab')
      openResource(target.resourceId)
    }
  }

  const chatProps = (conversationId: string) => ({
    state,
    actions,
    feedback,
    onIntent,
    draft: drafts[conversationId] ?? '',
    onDraftChange: (text: string) => setDrafts((prev) => ({ ...prev, [conversationId]: text })),
  })

  const renderPage = (current: Page) => {
    switch (current.kind) {
      case 'chat': {
        const conversation = mine.find((c) => c.id === current.conversationId)
        if (!conversation) return null
        return <ChatView conversation={conversation} onBack={back} loading={pending[`chat:${conversation.id}`] === true} {...chatProps(conversation.id)} />
      }
      case 'book':
        return (
          <BookingPage
            state={state}
            actions={actions}
            prefilledSlotId={current.slotId}
            fromAgent={current.fromAgent}
            onBack={back}
            onDone={(next) => {
              go('home', [], 'pop')
              if (next) onIntent(next)
            }}
          />
        )
      case 'records':
        return (
          <RecordsPage
            state={state}
            kind={current.resourceKind}
            loading={pending[`records:${current.resourceKind}`] === true}
            onKindChange={(resourceKind) => {
              load(`records:${resourceKind}`)
              setStack([...stack.slice(0, -1), { kind: 'records', resourceKind }])
            }}
            onBack={back}
            onOpen={openResource}
          />
        )
      case 'resource': {
        const resource = state.resources.find((r) => r.id === current.resourceId)
        return resource ? <ResourcePage resource={resource} onBack={back} onIntent={onIntent} /> : null
      }
      case 'followup':
        return (
          <FollowupPage
            state={state}
            actions={actions}
            planId={current.planId}
            onBack={back}
            onSubmitted={(conversationId) => {
              load(`chat:${conversationId}`)
              go('messages', [{ kind: 'chat', conversationId }], 'pop')
            }}
          />
        )
      case 'members': {
        const conversation = mine.find((c) => c.id === current.conversationId)
        return conversation ? <MembersPage conversation={conversation} onBack={back} /> : null
      }
    }
  }

  const renderTab = () => {
    if (tab === 'home')
      return (
        <HomePage
          state={state}
          onIntent={onIntent}
          onOpenList={(resourceKind) => push({ kind: 'records', resourceKind })}
          onOpenConversation={openConversation}
          unreadTotal={unreadTotal}
        />
      )
    if (tab === 'messages') return <InboxPage state={state} onOpenConversation={openConversation} onOpenAssistant={(origin) => openAssistant(origin)} />
    if (tab === 'assistant' && assistant) return <ChatView conversation={assistant} loading={false} inTab {...chatProps(assistant.id)} />
    return <ProfilePage state={state} actions={actions} showDemoControls={mode === 'fullscreen'} onOpenList={(resourceKind) => push({ kind: 'records', resourceKind })} />
  }

  const viewKey = page ? pageKey(page) : `tab:${tab}`

  const screen = (
    <div ref={screenRef} className={`cc-m cc-m-screen ${mode === 'fullscreen' ? 'cc-m-fullscreen' : ''}`}>
      {mode === 'device' && <StatusBar />}
      <div key={viewKey} className={`cc-m-view ${direction === 'push' ? 'cc-m-push' : 'cc-m-fade'}`}>
        {page ? renderPage(page) : renderTab()}
      </div>
      {state.lastIsolationBlock && (
        <div className="absolute inset-x-0 z-30" style={{ top: 'calc(var(--m-safe-top) + 52px)' }}>
          <IsolationBanner message={state.lastIsolationBlock} onDismiss={actions.dismissIsolationBlock} />
        </div>
      )}
      {!page && (
        <nav className="cc-m-tabbar" aria-label="患者端主导航">
          {TABS.map((item) => {
            const active = tab === item.id
            const badge = item.id === 'messages' ? unreadTotal : 0
            return (
              <Button
                key={item.id}
                ref={item.id === 'assistant' ? assistantTabRef : undefined}
                className="cc-m-tab"
                aria-current={active ? 'page' : undefined}
                onClick={(event) => (item.id === 'assistant' ? openAssistant(event.currentTarget) : go(item.id, [], 'tab'))}
              >
                {item.id === 'assistant' ? (
                  <span className="cc-m-tab-orb">
                    <SparklesIcon size={15} strokeWidth={2.2} />
                  </span>
                ) : (
                  <item.icon size={24} strokeWidth={active ? 2.2 : 1.7} />
                )}
                <span className={item.id === 'assistant' ? 'cc-m-tab-label-ai' : undefined}>{item.label}</span>
                {badge > 0 && <span className="cc-m-badge">{badge}</span>}
              </Button>
            )
          })}
        </nav>
      )}
      {mode === 'device' && <span className="cc-m-homebar" />}
      <Shockwave pulse={pulse} />
      <StatusToastRegion toaster={feedback.toast.patient} placement="phone" label="患者端提示" />
      <NotificationRegion toaster={feedback.notify.patient} placement="phone" label="患者端通知" onOpen={openTarget} />
    </div>
  )

  return mode === 'device' ? <div className="cc-device">{screen}</div> : screen
}
