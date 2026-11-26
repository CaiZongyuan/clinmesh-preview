import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ui-sdk/react/command'
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from '@ui-sdk/react/dialog'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '@ui-sdk/react/segmented-control'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select'
import { Switch, SwitchThumb } from '@ui-sdk/react/switch'
import {
  ActivityIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  ClockIcon,
  CheckCheckIcon,
  CpuIcon,
  FileTextIcon,
  FlaskConicalIcon,
  LayoutDashboardIcon,
  LockIcon,
  PanelRightCloseIcon,
  MessageSquareIcon,
  MicIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Share2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SparklesIcon,
  StethoscopeIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { WorkbenchAppearance } from '../workbench/workbench-preferences'
import { AudioVoiceBubble, ClinicalRichCard } from './clinical-cards'
import { NotificationRegion, StatusToastRegion, type ClinicFeedback, type NotificationTarget } from './clinic-feedback'
import { AgentSteps, RevealAfter, Spinner, StreamingText } from './clinic-motion'
import {
  PATIENTS,
  STAFF_ACTORS,
  type ClinicActions,
  type ConnectedClinicState,
  type ConversationType,
  type PatientKey,
  type StaffRole,
} from './connected-clinic-store'
import { PatientMobileApp } from './patient-mobile-app'

type HisModule =
  | 'dashboard'
  | 'appointments'
  | 'workbench'
  | 'patients'
  | 'messages'
  | 'followup'
  | 'agents'

type ChannelFilter = 'all' | 'followup' | 'patient' | 'staff'

const NAV_ITEMS: { id: HisModule; label: string; icon: typeof LayoutDashboardIcon }[] = [
  { id: 'dashboard', label: '工作台', icon: LayoutDashboardIcon },
  { id: 'messages', label: '消息协同', icon: MessageSquareIcon },
  { id: 'appointments', label: '预约队列', icon: CalendarIcon },
  { id: 'workbench', label: '临床工作台', icon: StethoscopeIcon },
  { id: 'patients', label: '患者档案', icon: UsersIcon },
  { id: 'followup', label: '随访中心', icon: ClipboardCheckIcon },
  { id: 'agents', label: 'Agent 运行', icon: CpuIcon },
]

const APT_STATUS_META: Record<string, { label: string; dot: string; badge: string }> = {
  booked: {
    label: '已预约',
    dot: 'bg-[var(--cc-ai)]',
    badge: 'bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]',
  },
  checked_in: {
    label: '已签到候诊',
    dot: 'bg-[var(--cc-amber)]',
    badge: 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]',
  },
  in_encounter: {
    label: '诊室在诊中',
    dot: 'bg-[var(--cc-emerald)]',
    badge: 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]',
  },
  completed: {
    label: '已完诊',
    dot: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
  cancelled: {
    label: '已取消',
    dot: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
}

function channelAvatarTone(type: ConversationType) {
  if (type === 'followup_group') return 'bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]'
  if (type === 'patient_doctor') return 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
  return 'bg-[var(--cc-surface-subtle)] text-foreground'
}

export function ConnectedClinicStudio({
  state,
  actions,
  feedback,
}: {
  state: ConnectedClinicState
  actions: ClinicActions
  feedback: ClinicFeedback
}) {
  const [activeModule, setActiveModule] = useState<HisModule>('dashboard')
  const [dockOpen, setDockOpen] = useState(() => window.innerWidth >= 1280)
  const [commandOpen, setCommandOpen] = useState(false)
  const [doctorFilter, setDoctorFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')
  const [selectedPatient, setSelectedPatient] = useState<PatientKey>('patient_a')
  const [selectedConvId, setSelectedConvId] = useState<string>('conv_followup_a')
  const [selectedPlanId, setSelectedPlanId] = useState<string>('fp_01')
  const [chatInput, setChatInput] = useState('')
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const [encounterBanner, setEncounterBanner] = useState<string | null>(null)
  const [sharePopoverOpen, setSharePopoverOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const staff = STAFF_ACTORS[state.currentStaff]
  const activeEncounter = state.encounters.find((e) => e.status === 'active')
  const activeEncPatient = activeEncounter ? PATIENTS[activeEncounter.patientKey] : null
  const unreadStaffCount = state.conversations.reduce((sum, c) => sum + c.unreadStaff, 0)
  const pendingSummariesCount = state.followupPlans.reduce(
    (sum, p) => sum + p.summaries.filter((s) => s.status === 'draft').length,
    0,
  )
  const unpublishedResources = state.resources.filter((r) => !r.published)

  const staffConversations = state.conversations.filter((c) => c.type !== 'patient_assistant')
  const filteredConvs = staffConversations.filter((c) => {
    if (channelFilter === 'followup') return c.type === 'followup_group'
    if (channelFilter === 'patient') return c.type === 'patient_doctor'
    if (channelFilter === 'staff') return c.type === 'staff_direct' || c.type === 'staff_group'
    return true
  })
  const activeConv =
    staffConversations.find((c) => c.id === selectedConvId) ?? staffConversations[0]
  const contextPatientKey: PatientKey = activeConv?.patientKey ?? 'patient_a'
  const contextPatient = PATIENTS[contextPatientKey]
  const linkedPlan = activeConv?.followupPlanId
    ? state.followupPlans.find((p) => p.id === activeConv.followupPlanId)
    : state.followupPlans.find((p) => p.conversationId === activeConv?.id)
  const pendingDraftSummary = linkedPlan?.summaries.find((s) => s.status === 'draft')
  const lastStaffMessageId = activeConv?.messages.findLast((m) => m.senderId === state.currentStaff)?.id

  const activePlan =
    state.followupPlans.find((p) => p.id === selectedPlanId) ?? state.followupPlans[0]

  const filteredAppointments = state.appointments.filter((apt) =>
    doctorFilter === 'all' ? true : apt.doctorId === doctorFilter,
  )

  const openModule = (module: HisModule) => {
    setActiveModule(module)
    actions.focusConversation('staff', module === 'messages' ? activeConv?.id ?? null : null)
  }

  const openConversation = (conversationId: string) => {
    setSelectedConvId(conversationId)
    setActiveModule('messages')
    setChatInput('')
    actions.setTyping('staff', null)
    actions.focusConversation('staff', conversationId)
  }

  const openStaffTarget = (target: NotificationTarget) => {
    if (target.kind === 'conversation') openConversation(target.conversationId)
    else if (target.kind === 'module') openModule(target.module)
    else openModule('patients')
  }

  const appointmentActions = (apt: (typeof state.appointments)[number]) => (
        <div className="inline-flex items-center gap-2">
          {apt.status === 'booked' && (
            <button
              type="button"
              onClick={() => actions.checkInAppointment(apt.id)}
              className="cc-btn-ghost h-7.5 px-3 text-[12px]"
            >
              签到
            </button>
          )}
          {(apt.status === 'booked' || apt.status === 'checked_in') && (
            <button
              type="button"
              disabled={staff.role !== 'doctor'}
              onClick={() => handleStartEncounter(apt.id)}
              className="cc-btn-primary h-7.5 px-3 text-[12px]"
            >
              开始接诊
            </button>
          )}
          {apt.status === 'in_encounter' && (
            <button
              type="button"
              onClick={() => openModule('workbench')}
              className="cc-btn-ai h-7.5 px-3 text-[12px]"
            >
              进入工作台 →
            </button>
          )}
        </div>
  )

  const handleStartEncounter = (appointmentId: string) => {
    const res = actions.startEncounterFromAppointment(appointmentId)
    setEncounterBanner(res.message)
    if (res.ok) openModule('workbench')
  }

  return (
    <div className="cc-app-frame">
      {/* Recessed Satin Left Sidebar */}
      <aside
        aria-label="ClinMesh 医院导航"
        className="flex w-[240px] flex-none flex-col px-3 py-3.5"
      >
        <div className="flex items-center gap-2.5 px-2 pb-3.5">
          <span className="cc-btn-primary size-7 rounded-[9px] p-0 shadow-sm" aria-hidden="true">
            <PlusIcon size={15} strokeWidth={2.75} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold tracking-tight">ClinMesh</span>
              <span className="rounded-full bg-[var(--cc-ai-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--cc-ai)]">
                Clinic
              </span>
            </div>
            <div className="truncate text-[11px] text-muted-foreground">全科 × 心内科 · 互联门诊</div>
          </div>
        </div>

        {/* Staff Role Switcher */}
        <div className="mb-2 px-0.5">
          <Select
            aria-label="切换医护角色"
            value={state.currentStaff}
            onValueChange={(value) => {
              if (value === 'doctor_a' || value === 'doctor_b' || value === 'nurse_n') {
                actions.setStaff(value as StaffRole)
              }
            }}
          >
            <SelectTrigger className="h-9 w-full justify-between rounded-[10px] border-0 bg-[var(--cc-sheet)] px-2.5 text-left text-[12px] shadow-[var(--cc-shadow-xs)]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-foreground text-[10.5px] font-semibold text-background">
                  {staff.avatar}
                </span>
                <span className="truncate font-medium text-foreground">
                  <SelectValue />
                </span>
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                <SelectItem value="doctor_a">王明 · 主治医师（医生 A）</SelectItem>
                <SelectItem value="doctor_b">林悦 · 副主任医师（医生 B）</SelectItem>
                <SelectItem value="nurse_n">周岚 · 主管护师（护士 N）</SelectItem>
              </SelectList>
            </SelectContent>
          </Select>
        </div>

        {/* ⌘K Command Trigger */}
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="mb-3.5 flex h-8.5 w-full items-center justify-between rounded-[10px] bg-[var(--cc-sheet)]/75 px-2.5 text-[12px] text-muted-foreground shadow-[0_0_0_1px_var(--cc-hairline)] transition-all hover:bg-[var(--cc-sheet)] hover:text-foreground cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <SearchIcon size={13} />
            快速搜索与命令…
          </span>
          <kbd className="rounded-md bg-[var(--cc-surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-[0_0_0_1px_var(--cc-hairline)]">
            ⌘K
          </kbd>
        </button>

        {/* Primary Module Nav */}
        <nav aria-label="主功能导航" className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          <div className="cc-kicker px-2.5 pt-1 pb-1.5">临床工作区</div>
          {NAV_ITEMS.map((item) => {
            const count =
              item.id === 'appointments'
                ? state.appointments.filter((a) => a.status !== 'completed').length
                : item.id === 'messages'
                  ? unreadStaffCount
                  : item.id === 'followup'
                    ? pendingSummariesCount
                    : item.id === 'agents'
                      ? state.agentRuns.length
                      : 0
            return (
              <button
                key={item.id}
                type="button"
                data-active={activeModule === item.id}
                onClick={() => openModule(item.id)}
                className="cc-nav-item"
              >
                <item.icon size={15} strokeWidth={1.85} />
                <span className="flex-1 text-left">{item.label}</span>
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                      item.id === 'messages'
                        ? 'bg-[var(--cc-ai)] text-white'
                        : item.id === 'followup'
                          ? 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]'
                          : 'bg-[var(--cc-surface-subtle)] text-muted-foreground'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}

          <div className="mt-auto pt-4">
            <div className="rounded-xl bg-[var(--cc-sheet)]/85 p-3 shadow-[var(--cc-shadow-xs)]">
              <div className="flex items-center gap-2 text-[11.5px] font-semibold text-foreground">
                <span className="cc-live-dot text-[var(--cc-emerald)]" />
                <span>单诊室模拟模式</span>
              </div>
              <p className="mt-1.5 mb-2 text-[11px] leading-relaxed text-muted-foreground">
                合成病例与 Simulated Patient 在线，正式临床动作均须医生放行。
              </p>
              <a
                href="/"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--cc-ai)] hover:underline"
              >
                返回原单医生工作台 <ArrowRightIcon size={11} />
              </a>
            </div>
          </div>
        </nav>
      </aside>

      {/* Main Elevated Floating Workspace Sheet */}
      <div className="cc-main-sheet @container">
        <header className="cc-glass cc-divider-b flex h-[54px] flex-none items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-2.5 text-[13px]">
            <span className="text-muted-foreground">Connected Clinic</span>
            <ChevronRightIcon size={13} className="text-muted-foreground/50" />
            <h1 className="m-0 text-[14px] font-semibold tracking-tight text-foreground">
              {NAV_ITEMS.find((i) => i.id === activeModule)?.label}
            </h1>
            {activeEncounter && activeEncPatient && (
              <button
                type="button"
                onClick={() => openModule('workbench')}
                className="ml-2 inline-flex items-center gap-2 rounded-full bg-[var(--cc-emerald-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--cc-emerald)] transition-opacity hover:opacity-85 cursor-pointer"
              >
                <span className="cc-live-dot text-[var(--cc-emerald)]" />
                <span>
                  在诊：{activeEncPatient.name} · {activeEncounter.outpatientNumber}
                </span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Live Sync Telemetry & Reset Popover */}
            <Popover>
              <PopoverTrigger className="cc-btn-ghost h-8 px-2.5 text-[12px] text-muted-foreground">
                <ActivityIcon size={13.5} className="text-[var(--cc-ai)]" />
                <span className="tabular-nums">同步流 ({state.syncEvents.length})</span>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" sideOffset={8} className="w-[420px] p-0 overflow-hidden">
                <div className="cc-divider-b flex items-center justify-between px-4 py-3">
                  <PopoverTitle className="m-0 text-[13px] font-semibold">
                    实时双端同步状态
                  </PopoverTitle>
                  <button
                    type="button"
                    onClick={actions.resetDemo}
                    className="cc-btn-ghost h-6.5 px-2 text-[11px]"
                  >
                    <RotateCcwIcon size={11} />
                    重置演示
                  </button>
                </div>
                <ol className="cc-scroll m-0 flex max-h-64 list-none flex-col divide-y divide-[var(--cc-hairline)] overflow-y-auto p-0">
                  {state.syncEvents.slice(0, 8).map((ev) => (
                    <li key={ev.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-[11.5px]">
                      <div className="flex items-center justify-between text-[10.5px]">
                        <span className="font-mono font-semibold text-[var(--cc-ai)]">
                          {ev.owner}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {ev.origin} · {ev.at}
                        </span>
                      </div>
                      <span className="text-foreground/90">{ev.summary}</span>
                    </li>
                  ))}
                </ol>
              </PopoverContent>
            </Popover>

            <WorkbenchAppearance />

            <button
              type="button"
              aria-pressed={dockOpen}
              onClick={() => setDockOpen(!dockOpen)}
              className={`${dockOpen ? 'cc-btn-ghost' : 'cc-btn-primary'} h-8.5 px-3.5 text-[12px]`}
            >
              {dockOpen ? <PanelRightCloseIcon size={14} /> : <SmartphoneIcon size={13.5} />}
              {dockOpen ? '收起患者端' : '患者手机版'}
            </button>
          </div>
        </header>

        {/* ============================================================
            MODULE 1: DASHBOARD
           ============================================================ */}
        {activeModule === 'dashboard' && (
          <main className="cc-scroll cc-ambient-wash min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <div className="mx-auto flex max-w-[1140px] flex-col gap-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
                    <span>2026 年 11 月 26 日 · 周四</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1.5 text-[var(--cc-emerald)]">
                      <span className="cc-live-dot text-[var(--cc-emerald)]" />
                      医生端与患者手机版实时同步中
                    </span>
                  </div>
                  <h2 className="m-0 mt-1 text-[24px] font-semibold tracking-[-0.025em] text-foreground">
                    早安，{staff.name}
                    <span className="ml-2.5 text-[15px] font-normal text-muted-foreground">
                      {staff.title}
                    </span>
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openModule('messages')}
                    className="cc-btn-ghost h-9 px-3.5 text-[12.5px]"
                  >
                    <MessageSquareIcon size={14} className="text-[var(--cc-ai)]" />
                    进入消息协同 ({unreadStaffCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => openModule('workbench')}
                    className="cc-btn-primary h-9 px-4 text-[12.5px]"
                  >
                    进入临床工作台
                    <ArrowRightIcon size={14} />
                  </button>
                </div>
              </div>

              {/* Active Encounter Live Spotlight */}
              {activeEncounter && activeEncPatient && (
                <section className="cc-surface overflow-hidden p-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="relative flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-900 to-slate-700 text-[16px] font-semibold text-white shadow-sm dark:from-slate-100 dark:to-slate-300 dark:text-slate-950">
                        {activeEncPatient.avatar}
                        <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-2 border-[var(--cc-sheet)] bg-[var(--cc-emerald)]" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="cc-kicker text-[var(--cc-emerald)]">当前在诊诊室</span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {activeEncounter.outpatientNumber}
                          </span>
                          {activeEncPatient.allergies.map((a) => (
                            <span
                              key={a}
                              className="rounded-full bg-[var(--cc-crimson-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--cc-crimson)]"
                            >
                              过敏：{a}
                            </span>
                          ))}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
                          <strong className="text-[17px] font-semibold tracking-tight">
                            {activeEncPatient.name}
                          </strong>
                          <span className="text-[12.5px] text-muted-foreground">
                            {activeEncPatient.sex} · {activeEncPatient.age} 岁 · 主诉：
                            {activeEncounter.chiefComplaint}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {activeEncPatient.vitals.map((v) => (
                        <div
                          key={v.label}
                          className={`rounded-xl px-3 py-1.5 text-center ${
                            v.abnormal
                              ? 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]'
                              : 'bg-[var(--cc-surface-subtle)] text-foreground'
                          }`}
                        >
                          <div className="text-[10px] opacity-75">{v.label}</div>
                          <div className="font-mono text-[13px] font-semibold tabular-nums">
                            {v.value}
                            <span className="ml-0.5 text-[10px] font-normal opacity-75">
                              {v.unit}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--cc-hairline)] pt-3.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                      <span className="font-semibold text-[var(--cc-emerald)]">
                        Completion Gates 5/5 就绪
                      </span>
                      {['主诊断已确认', '检验报告已阅', '处方已签发', '病历已签署', '无高风险遗留草稿'].map(
                        (gate) => (
                          <span
                            key={gate}
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--cc-surface-subtle)] px-2 py-0.5 text-[11px] text-muted-foreground"
                          >
                            <CheckIcon size={11} className="text-[var(--cc-emerald)]" />
                            {gate}
                          </span>
                        ),
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => openModule('workbench')}
                      className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--cc-ai)] hover:underline cursor-pointer"
                    >
                      完诊并发布至患者手机版 <ArrowRightIcon size={12} />
                    </button>
                  </div>
                </section>
              )}

              {/* Sculpted 4-Column Metric Strip */}
              <div className="cc-surface grid grid-cols-2 divide-x divide-[var(--cc-hairline)] md:grid-cols-4">
                {[
                  {
                    label: '今日预约队列',
                    value: state.appointments.length,
                    meta: `${state.appointments.filter((a) => a.status === 'checked_in').length} 位已签到候诊`,
                    icon: CalendarIcon,
                    accent: 'text-[var(--cc-ai)] bg-[var(--cc-ai-soft)]',
                    progress: 68,
                    onClick: () => openModule('appointments'),
                  },
                  {
                    label: '待医生显式确认',
                    value: pendingSummariesCount + unpublishedResources.length,
                    meta: `${unpublishedResources.length} 报告待发布 · ${pendingSummariesCount} 摘要待审`,
                    icon: ShieldCheckIcon,
                    accent: 'text-[var(--cc-amber)] bg-[var(--cc-amber-soft)]',
                    progress: 40,
                    onClick: () => openModule('followup'),
                  },
                  {
                    label: '医患与随访群未读',
                    value: unreadStaffCount,
                    meta: `${staffConversations.length} 个活跃频道 · 语音/卡片`,
                    icon: MessageSquareIcon,
                    accent: 'text-[var(--cc-emerald)] bg-[var(--cc-emerald-soft)]',
                    progress: 75,
                    onClick: () => openModule('messages'),
                  },
                  {
                    label: 'Durable Agent 运行',
                    value: state.agentRuns.length,
                    meta: '全部 settled · 零越权调用',
                    icon: SparklesIcon,
                    accent: 'text-[var(--cc-ai)] bg-[var(--cc-ai-soft)]',
                    progress: 100,
                    onClick: () => openModule('agents'),
                  },
                ].map((metric) => (
                  <button
                    key={metric.label}
                    type="button"
                    onClick={metric.onClick}
                    className="group flex flex-col gap-3 p-4.5 text-left transition-colors hover:bg-[var(--cc-surface-subtle)]/70 cursor-pointer"
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-[12px] font-medium text-muted-foreground">
                        {metric.label}
                      </span>
                      <span className={`inline-flex size-7 items-center justify-center rounded-lg ${metric.accent}`}>
                        <metric.icon size={14} />
                      </span>
                    </div>
                    <div>
                      <div className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">
                        {metric.value}
                      </div>
                      <div className="mt-1.5 text-[11.5px] text-muted-foreground">{metric.meta}</div>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--cc-surface-subtle)]">
                      <div
                        className="h-full rounded-full bg-foreground/20 transition-all group-hover:bg-[var(--cc-ai)]"
                        style={{ width: `${metric.progress}%` }}
                      />
                    </div>
                  </button>
                ))}
              </div>

              <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
                <div className="flex flex-col gap-6">
                  {/* Clinical Confirmation Queue */}
                  <section className="cc-surface overflow-hidden">
                    <div className="cc-divider-b flex items-center justify-between px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-semibold tracking-tight">
                          需要人工放行与确认
                        </span>
                        <span className="rounded-full bg-[var(--cc-amber-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--cc-amber)]">
                          Clinical Confirmation
                        </span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        仅授权医生可执行正式放行
                      </span>
                    </div>

                    <div className="divide-y divide-[var(--cc-hairline)]">
                      {unpublishedResources.map((res) => (
                        <div
                          key={res.id}
                          className="relative flex items-center justify-between gap-4 px-5 py-3.5 pl-6 transition-colors hover:bg-[var(--cc-surface-subtle)]/60"
                        >
                          <span className="absolute inset-y-3 left-2.5 w-[3px] rounded-full bg-[var(--cc-amber)]" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <FlaskConicalIcon size={14} className="text-[var(--cc-amber)]" />
                              <strong className="text-[13px] font-semibold">{res.title}</strong>
                              <span className="rounded-md bg-[var(--cc-surface-subtle)] px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                                {PATIENTS[res.patientKey].name}
                              </span>
                            </div>
                            <p className="m-0 mt-1 text-[12px] text-muted-foreground">
                              影像科已签发且医生已阅，尚未显式发布至患者手机版
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={staff.role !== 'doctor'}
                            onClick={() => actions.toggleResourcePublish(res.id)}
                            className="cc-btn-primary h-8 shrink-0 px-3 text-[12px]"
                          >
                            显式发布
                          </button>
                        </div>
                      ))}

                      {state.followupPlans.flatMap((plan) =>
                        plan.summaries
                          .filter((s) => s.status === 'draft')
                          .map((sum) => (
                            <div
                              key={sum.id}
                              className="relative flex items-center justify-between gap-4 px-5 py-3.5 pl-6 transition-colors hover:bg-[var(--cc-surface-subtle)]/60"
                            >
                              <span className="absolute inset-y-3 left-2.5 w-[3px] rounded-full bg-[var(--cc-ai)]" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <SparklesIcon size={14} className="text-[var(--cc-ai)]" />
                                  <strong className="text-[13px] font-semibold">
                                    随访摘要待审 · {PATIENTS[plan.patientKey].name}
                                  </strong>
                                  <span className="font-mono text-[10.5px] text-muted-foreground">
                                    v{sum.version}
                                  </span>
                                </div>
                                <p className="m-0 mt-1 line-clamp-1 text-[12px] text-muted-foreground">
                                  {sum.content}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  openConversation(plan.conversationId)
                                }}
                                className="cc-btn-ai h-8 shrink-0 px-3 text-[12px]"
                              >
                                会话内审批
                              </button>
                            </div>
                          )),
                      )}

                      {unpublishedResources.length === 0 && pendingSummariesCount === 0 && (
                        <div className="flex items-center gap-2 px-5 py-5 text-[12.5px] text-[var(--cc-emerald)]">
                          <CheckCircle2Icon size={15} />
                          全部临床发布与随访摘要均已完成医生放行。
                        </div>
                      )}
                    </div>
                  </section>

                  {/* Today's Clinical Timeline */}
                  <section className="cc-surface overflow-hidden">
                    <div className="cc-divider-b flex items-center justify-between px-5 py-3.5">
                      <span className="text-[13.5px] font-semibold tracking-tight">
                        今日门诊接诊时间轴
                      </span>
                      <button
                        type="button"
                        onClick={() => openModule('appointments')}
                        className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--cc-ai)] hover:underline cursor-pointer"
                      >
                        全部预约队列 <ArrowRightIcon size={12} />
                      </button>
                    </div>
                    <div className="divide-y divide-[var(--cc-hairline)]">
                      {state.appointments.slice(0, 4).map((apt) => {
                        const p = PATIENTS[apt.patientKey]
                        const meta = APT_STATUS_META[apt.status]
                        return (
                          <div
                            key={apt.id}
                            className="flex items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-[var(--cc-surface-subtle)]/60"
                          >
                            <div className="flex items-center gap-3.5 min-w-0">
                              <div className="w-16 shrink-0 font-mono text-[12px] font-medium text-muted-foreground tabular-nums">
                                {apt.timeRange.split(' ')[0]}
                                <div className="text-[10px] opacity-70">{apt.dateLabel}</div>
                              </div>
                              <span className={`size-2 shrink-0 rounded-full ${meta.dot}`} />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <strong className="text-[13px] font-semibold">{p.name}</strong>
                                  <span className="text-[11.5px] text-muted-foreground">
                                    {apt.doctorName}
                                  </span>
                                  {apt.source === 'agent_assisted' && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--cc-ai-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--cc-ai)]">
                                      <SparklesIcon size={9.5} /> 助手预约
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                                  {apt.chiefComplaint}
                                </div>
                              </div>
                            </div>
                            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${meta.badge}`}>
                              {meta.label}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                </div>

                {/* Live Telemetry Rail */}
                <section className="cc-surface flex flex-col overflow-hidden">
                  <div className="cc-divider-b flex items-center justify-between px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <ActivityIcon size={14} className="text-[var(--cc-ai)]" />
                      <span className="text-[13.5px] font-semibold tracking-tight">三方协同脉搏</span>
                    </div>
                    <span className="font-mono text-[10.5px] text-muted-foreground">
                      API · IM · Agent
                    </span>
                  </div>
                  <ol className="m-0 flex flex-1 list-none flex-col p-4 gap-3.5">
                    {state.syncEvents.slice(0, 7).map((ev, idx) => {
                      const dotColor =
                        ev.owner === 'ClinicWorkspaceDO'
                          ? 'bg-[var(--cc-emerald)]'
                          : ev.owner === 'WuKongIM'
                            ? 'bg-[var(--cc-ai)]'
                            : ev.owner === 'SecurityGate'
                              ? 'bg-[var(--cc-crimson)]'
                              : 'bg-indigo-500'
                      return (
                        <li key={ev.id} className="relative flex gap-3 pl-1">
                          {idx < Math.min(state.syncEvents.length, 7) - 1 && (
                            <span
                              className="absolute top-4 bottom-[-14px] left-[7.5px] w-px bg-[var(--cc-hairline)]"
                              aria-hidden="true"
                            />
                          )}
                          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${dotColor}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="font-mono font-semibold text-foreground/80">
                                {ev.owner}
                              </span>
                              <span className="text-muted-foreground tabular-nums">
                                {ev.origin} · {ev.at}
                              </span>
                            </div>
                            <p className="m-0 mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                              {ev.summary}
                            </p>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </section>
              </div>
            </div>
          </main>
        )}

        {/* ============================================================
            MODULE 2: UNIFIED 3-COLUMN AMBIENT CHAT CENTER
           ============================================================ */}
        {activeModule === 'messages' && activeConv && (
          <div className="grid min-h-0 flex-1 grid-cols-[264px_minmax(0,1fr)] overflow-hidden @min-[1120px]:grid-cols-[296px_minmax(0,1fr)_348px]">
            {/* Column 1: Triage & Channels */}
            <aside className="cc-divider-r flex min-h-0 flex-col bg-[var(--cc-surface-subtle)]/75">
              <div className="cc-divider-b flex flex-none flex-col gap-2.5 px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold tracking-tight">人机协同收件箱</span>
                  <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-[var(--cc-emerald)]">
                    <span className="cc-live-dot text-[var(--cc-emerald)]" />
                    WuKongIM
                  </span>
                </div>
                <SegmentedControl
                  aria-label="筛选会话类型"
                  value={channelFilter}
                  onValueChange={(v) => v && setChannelFilter(v as ChannelFilter)}
                >
                  <SegmentedControlIndicator />
                  <SegmentedControlItem value="all">全部</SegmentedControlItem>
                  <SegmentedControlItem value="followup">随访群</SegmentedControlItem>
                  <SegmentedControlItem value="patient">医患</SegmentedControlItem>
                  <SegmentedControlItem value="staff">医护</SegmentedControlItem>
                </SegmentedControl>
              </div>

              <div className="cc-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-2.5">
                {(unpublishedResources.length > 0 || pendingSummariesCount > 0) && (
                  <div className="flex flex-col gap-1.5">
                    <div className="cc-kicker px-2">优先决策</div>
                    {unpublishedResources.map((res) => (
                      <div
                        key={res.id}
                        className="flex items-center justify-between gap-2 rounded-xl bg-[var(--cc-amber-soft)] px-3 py-2 text-[11.5px]"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-foreground">{res.title}</div>
                          <div className="text-[10.5px] text-[var(--cc-amber)]">待发布至手机版</div>
                        </div>
                        <button
                          type="button"
                          disabled={staff.role !== 'doctor'}
                          onClick={() => actions.toggleResourcePublish(res.id)}
                          className="cc-btn-primary h-6 shrink-0 rounded-lg px-2 text-[10.5px]"
                        >
                          发布
                        </button>
                      </div>
                    ))}
                    {state.followupPlans.flatMap((plan) =>
                      plan.summaries
                        .filter((s) => s.status === 'draft')
                        .map((sum) => (
                          <button
                            key={sum.id}
                            type="button"
                            onClick={() => openConversation(plan.conversationId)}
                            className="flex items-center justify-between gap-2 rounded-xl bg-[var(--cc-ai-soft)] px-3 py-2 text-left text-[11.5px] transition-opacity hover:opacity-90 cursor-pointer"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-foreground">
                                摘要待审 · {PATIENTS[plan.patientKey].name}
                              </div>
                              <div className="text-[10.5px] text-[var(--cc-ai)]">点击直达会话内审批</div>
                            </div>
                            <SparklesIcon size={13} className="shrink-0 text-[var(--cc-ai)]" />
                          </button>
                        )),
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-1">
                  <div className="cc-kicker px-2 pb-0.5">活跃频道 ({filteredConvs.length})</div>
                  {filteredConvs.map((conv) => {
                    const active = conv.id === activeConv.id
                    const last = conv.messages.at(-1)
                    const preview =
                      last?.parts[0]?.type === 'text'
                        ? last.parts[0].text
                        : last?.parts[0]?.type === 'audio'
                          ? `[语音 ${last.parts[0].durationSec}″] ${last.parts[0].transcript ?? ''}`
                          : '[结构化业务卡片]'
                    const hasAgent = conv.members.some(
                      (m) => m.kind === 'agent' && m.status === 'active',
                    )
                    return (
                      <button
                        key={conv.id}
                        type="button"
                        onClick={() => openConversation(conv.id)}
                        className={`flex items-start gap-2.5 rounded-xl p-2.5 text-left transition-all cursor-pointer ${
                          active
                            ? 'bg-[var(--cc-sheet)] shadow-[var(--cc-shadow-xs)]'
                            : 'hover:bg-[var(--cc-sheet)]/60'
                        }`}
                      >
                        <div
                          className={`relative flex size-9.5 shrink-0 items-center justify-center rounded-xl text-[12px] font-semibold ${channelAvatarTone(
                            conv.type,
                          )}`}
                        >
                          {conv.type === 'followup_group'
                            ? '随访'
                            : conv.type === 'patient_doctor'
                              ? '患'
                              : '医'}
                          {hasAgent && (
                            <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-[var(--cc-ai)] text-white shadow-xs">
                              <SparklesIcon size={9} />
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[12.5px] font-semibold text-foreground">
                              {conv.title}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                              {last?.createdAt}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2">
                            <p className="m-0 truncate text-[11.5px] text-muted-foreground">
                              {conv.status === 'read_only' ? '[已归档] ' : ''}
                              {preview}
                            </p>
                            {conv.status === 'read_only' ? (
                              <LockIcon size={11} className="shrink-0 text-muted-foreground" />
                            ) : conv.unreadStaff > 0 ? (
                              <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--cc-ai)] font-mono text-[9.5px] font-semibold text-white">
                                {conv.unreadStaff}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </aside>

            {/* Column 2: Full-Bleed Conversation Canvas */}
            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--cc-sheet)]">
              <header className="cc-glass cc-divider-b flex flex-none items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div
                    className={`flex size-9 shrink-0 items-center justify-center rounded-xl text-[12px] font-semibold ${channelAvatarTone(
                      activeConv.type,
                    )}`}
                  >
                    {activeConv.type === 'followup_group'
                      ? '随访'
                      : activeConv.type === 'patient_doctor'
                        ? '患'
                        : '医'}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="m-0 truncate text-[14.5px] font-semibold tracking-tight">
                        {activeConv.title}
                      </h2>
                      {activeConv.status === 'read_only' && (
                        <span className="shrink-0 rounded-full bg-[var(--cc-amber-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-amber)]">
                          只读归档
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                      <span className="truncate">{activeConv.subtitle}</span>
                      <span className="shrink-0 font-mono text-[10.5px] opacity-70">
                        v{activeConv.membershipVersion}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <div className="hidden -space-x-1.5 2xl:flex">
                    {activeConv.members
                      .filter((m) => m.status === 'active')
                      .map((m) => (
                        <span
                          key={m.id}
                          title={`${m.name} · ${m.roleLabel}`}
                          className={`inline-flex size-6.5 items-center justify-center rounded-full border-2 border-[var(--cc-sheet)] text-[10px] font-semibold ${
                            m.kind === 'agent'
                              ? 'bg-[var(--cc-ai)] text-white'
                              : 'bg-[var(--cc-surface-subtle)] text-foreground'
                          }`}
                        >
                          {m.avatar}
                        </span>
                      ))}
                  </div>
                  {activeConv.followupPlanId && activeConv.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => actions.triggerFollowupAgentSummary(activeConv.followupPlanId!)}
                      className="cc-btn-ai h-8 px-3 text-[12px]"
                    >
                      <SparklesIcon size={13} />
                      @随访助手
                    </button>
                  )}
                  {linkedPlan && linkedPlan.status === 'active' && staff.role === 'doctor' && (
                    <AlertDialog>
                      <AlertDialogTrigger className="cc-btn-ghost h-8 px-2.5 text-[12px]">
                        结案归档
                      </AlertDialogTrigger>
                      <AlertDialogBackdrop />
                      <AlertDialogContent className="max-w-md p-5">
                        <AlertDialogTitle className="m-0 text-[15px] font-semibold">
                          关闭随访计划并归档本群？
                        </AlertDialogTitle>
                        <AlertDialogDescription className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                          关闭后，本随访群（含患者手机版）将立即转为只读状态，不可发送新消息，历史消息按原权限保留查阅。
                        </AlertDialogDescription>
                        <div className="mt-4 flex justify-end gap-2">
                          <AlertDialogClose className="cc-btn-ghost h-8 px-3 text-xs">
                            取消
                          </AlertDialogClose>
                          <AlertDialogClose
                            value="confirm"
                            className="cc-btn-primary h-8 px-3.5 text-xs"
                            onClick={() => actions.closeFollowupPlan(linkedPlan.id)}
                          >
                            确认关闭归档
                          </AlertDialogClose>
                        </div>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </header>

              {/* Inline Follow-up Agent Summary Approval Card */}
              {pendingDraftSummary && linkedPlan && (
                <div className="cc-divider-b bg-[var(--cc-surface-subtle)]/50 px-6 py-3.5">
                  <div className="cc-ai-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex size-6 items-center justify-center rounded-lg bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]">
                          <SparklesIcon size={13} />
                        </span>
                        <strong className="text-[13px] font-semibold text-foreground">
                          Follow-up Agent 随访摘要草稿 v{pendingDraftSummary.version}
                        </strong>
                        <span className="rounded-full bg-[var(--cc-amber-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-amber)]">
                          待医生显式审核
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={staff.role !== 'doctor'}
                          onClick={() =>
                            actions.reviewFollowupSummary(
                              linkedPlan.id,
                              pendingDraftSummary.id,
                              'rejected',
                            )
                          }
                          className="cc-btn-ghost h-7 px-2.5 text-[11.5px]"
                        >
                          驳回
                        </button>
                        <button
                          type="button"
                          disabled={staff.role !== 'doctor'}
                          onClick={() =>
                            actions.reviewFollowupSummary(
                              linkedPlan.id,
                              pendingDraftSummary.id,
                              'approved',
                            )
                          }
                          className="cc-btn-primary h-7 px-3 text-[11.5px]"
                        >
                          批准并固化记录
                        </button>
                      </div>
                    </div>
                    <p className="mt-2.5 mb-2 text-[12.5px] leading-relaxed text-foreground/90">
                      {pendingDraftSummary.content}
                    </p>
                    <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                      <span>溯源反馈 ID：</span>
                      <span className="rounded bg-[var(--cc-surface-subtle)] px-1.5 py-0.5">
                        {pendingDraftSummary.sourceResponseIds.join(', ') || '当前计划上下文'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className="cc-scroll flex flex-1 flex-col-reverse overflow-y-auto">
              <div className="flex flex-col gap-5 px-6 py-5" role="log" aria-label={`${activeConv.title} 消息记录`}>
                {activeConv.messages.map((msg) => {
                  if (msg.senderKind === 'system') {
                    return (
                      <div key={msg.id} className="flex items-center gap-3 py-1">
                        <span className="h-px flex-1 bg-[var(--cc-hairline)]" />
                        <span className="rounded-full bg-[var(--cc-surface-subtle)] px-3 py-1 text-[11px] text-muted-foreground">
                          {msg.parts[0]?.type === 'text' ? msg.parts[0].text : ''}
                        </span>
                        <span className="h-px flex-1 bg-[var(--cc-hairline)]" />
                      </div>
                    )
                  }

                  const isSelfStaff = msg.senderId === state.currentStaff
                  const isAgent = msg.senderKind === 'agent'

                  return (
                    <div
                      key={msg.id}
                      className={`flex items-start gap-3 ${isSelfStaff ? 'flex-row-reverse' : ''}`}
                    >
                      <span
                        className={`mt-0.5 flex size-8.5 shrink-0 items-center justify-center rounded-xl text-[12px] font-semibold ${
                          isAgent
                            ? 'bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-xs'
                            : isSelfStaff
                              ? 'bg-foreground text-background'
                              : msg.senderId.startsWith('patient')
                                ? 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                                : 'bg-[var(--cc-surface-subtle)] text-foreground'
                        }`}
                      >
                        {isAgent ? <SparklesIcon size={14} /> : msg.senderName[0]}
                      </span>

                      <div
                        className={`flex min-w-0 max-w-[78%] flex-col gap-1.5 ${
                          isSelfStaff ? 'items-end' : 'items-start'
                        }`}
                      >
                        <div className="flex items-baseline gap-2 px-0.5 text-[11.5px]">
                          <strong className="font-semibold text-foreground">{msg.senderName}</strong>
                          <span className="text-[11px] text-muted-foreground">{msg.senderRole}</span>
                          <span className="font-mono text-[10px] text-muted-foreground/75 tabular-nums">
                            {msg.createdAt} · #{msg.sequence}
                          </span>
                        </div>

                        {isAgent && msg.stream && <AgentSteps stream={msg.stream} />}
                        {msg.parts.map((part, idx) => {
                          if (part.type === 'text') {
                            return (
                              <RevealAfter key={idx} stream={msg.stream} afterMs={msg.stream ? msg.stream.textStartsAfterMs - 120 : 0}>
                              <div
                                className={`rounded-2xl px-4 py-2.5 text-[13px] leading-[1.6] ${
                                  isSelfStaff
                                    ? 'rounded-tr-sm bg-foreground text-background shadow-xs'
                                    : isAgent
                                      ? 'cc-ai-card rounded-tl-sm text-foreground'
                                      : 'rounded-tl-sm bg-[var(--cc-surface-subtle)] text-foreground shadow-[0_0_0_1px_var(--cc-hairline)]'
                                }`}
                              >
                                {isAgent ? <StreamingText text={part.text} stream={msg.stream} /> : part.text}
                              </div>
                              </RevealAfter>
                            )
                          }
                          if (part.type === 'audio') {
                            return (
                              <AudioVoiceBubble
                                key={idx}
                                part={part}
                                isSelf={isSelfStaff}
                                playing={playingAudioId === part.attachmentId}
                                onTogglePlay={() =>
                                  setPlayingAudioId(
                                    playingAudioId === part.attachmentId
                                      ? null
                                      : part.attachmentId,
                                  )
                                }
                              />
                            )
                          }
                          return (
                            <ClinicalRichCard
                              key={idx}
                              part={part}
                              resource={state.resources.find((r) => r.id === part.resourceId)}
                            />
                          )
                        })}
                        {isSelfStaff && msg.id === lastStaffMessageId && msg.delivery && (
                          <span className={`inline-flex items-center gap-1 px-0.5 text-[11px] ${msg.delivery === 'read' ? 'text-[var(--cc-ai)]' : 'text-muted-foreground'}`}>
                            {msg.delivery === 'sending' ? <Spinner size={11} /> : msg.delivery === 'read' ? <CheckCheckIcon size={13} /> : <CheckIcon size={12} />}
                            {msg.delivery === 'sending' ? '发送中' : msg.delivery === 'read' ? '患者已读' : '已送达'}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
                {state.typing.patient === activeConv.id && (
                  <div className="flex items-center gap-2 pl-1 text-[12px] text-muted-foreground" aria-live="polite">
                    <span className="cc-typing-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    {contextPatient.name} 正在输入…
                  </div>
                )}
              </div>
              </div>

              {/* Unified Floating Elevated Composer Dock */}
              <div className="flex-none px-6 pb-5 pt-2">
                {activeConv.status === 'read_only' ? (
                  <div className="flex items-center justify-center gap-2 rounded-2xl bg-[var(--cc-surface-subtle)] py-3.5 text-[12px] text-muted-foreground shadow-[0_0_0_1px_var(--cc-hairline)]">
                    <LockIcon size={13} />
                    <span>随访计划已结案，本会话转为只读归档，历史消息按权限保留。</span>
                  </div>
                ) : (
                  <div className="cc-composer-dock flex flex-col">
                    <textarea
                      rows={2}
                      value={chatInput}
                      aria-label={`以 ${staff.name} 身份回复`}
                      onChange={(e) => {
                        setChatInput(e.target.value)
                        actions.setTyping('staff', e.target.value.trim() ? activeConv.id : null)
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return
                        if (e.key === 'Enter' && !e.shiftKey && chatInput.trim()) {
                          e.preventDefault()
                          actions.sendMessage(activeConv.id, 'staff', chatInput.trim())
                          setChatInput('')
                        }
                      }}
                      placeholder={`以 ${staff.name} 身份回复消息，Enter 发送 · Shift+Enter 换行…`}
                      className="w-full resize-none border-0 bg-transparent px-4 pt-3 pb-1.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/75 focus:outline-none focus:shadow-none"
                    />
                    <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            actions.sendVoiceMessage(
                              activeConv.id,
                              'staff',
                              '李先生您好，体温已回落至 37.3 度非常理想，继续规律完成疗程即可。',
                              9,
                            )
                          }
                          className="cc-btn-ghost h-7.5 px-2.5 text-[11.5px]"
                        >
                          <MicIcon size={12.5} />
                          语音消息
                        </button>

                        <Popover open={sharePopoverOpen} onOpenChange={setSharePopoverOpen}>
                          <PopoverTrigger className="cc-btn-ghost h-7.5 px-2.5 text-[11.5px]">
                            <Share2Icon size={12.5} />
                            投递临床卡片
                          </PopoverTrigger>
                          <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-2.5">
                            <PopoverTitle className="m-0 mb-2 px-1 text-[12px] font-semibold">
                              选择已发布资料投递至当前会话
                            </PopoverTitle>
                            <div className="flex flex-col gap-1">
                              {state.resources
                                .filter((r) => r.patientKey === contextPatientKey && r.published)
                                .map((res) => (
                                  <button
                                    key={res.id}
                                    type="button"
                                    onClick={() => {
                                      actions.shareResourceCard(activeConv.id, res.id)
                                      setSharePopoverOpen(false)
                                    }}
                                    className="flex flex-col rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--cc-surface-hover)] cursor-pointer"
                                  >
                                    <span className="text-[12px] font-semibold text-foreground">
                                      {res.title}
                                    </span>
                                    <span className="text-[10.5px] text-muted-foreground">
                                      {res.department} · v{res.version} · 打开时重新鉴权
                                    </span>
                                  </button>
                                ))}
                            </div>
                          </PopoverContent>
                        </Popover>

                        {activeConv.followupPlanId && (
                          <button
                            type="button"
                            onClick={() =>
                              actions.triggerFollowupAgentSummary(activeConv.followupPlanId!)
                            }
                            className="cc-btn-ai h-7.5 px-2.5 text-[11.5px]"
                          >
                            <SparklesIcon size={12} />
                            @随访助手
                          </button>
                        )}
                      </div>

                      <button
                        type="button"
                        aria-label="发送消息"
                        disabled={!chatInput.trim()}
                        onClick={() => {
                          if (!chatInput.trim()) return
                          actions.sendMessage(activeConv.id, 'staff', chatInput.trim())
                          setChatInput('')
                        }}
                        className="cc-btn-primary size-8 rounded-full p-0"
                      >
                        <ArrowUpIcon size={15} strokeWidth={2.4} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Column 3: Living Contextual Patient Dossier & Embedded Mobile View */}
            <aside className="cc-divider-l hidden min-h-0 flex-col bg-[var(--cc-surface-subtle)]/55 @min-[1120px]:flex">
              <div className="cc-divider-b flex flex-none items-center justify-between px-4 py-3">
                <span className="text-[13px] font-semibold tracking-tight">患者实时档案</span>
                {!dockOpen && (
                  <button type="button" onClick={() => setDockOpen(true)} className="cc-btn-ghost h-7 px-2.5 text-[11.5px]">
                    <SmartphoneIcon size={12} />
                    看患者端
                  </button>
                )}
              </div>
                <div className="cc-scroll flex flex-1 flex-col divide-y divide-[var(--cc-hairline)] overflow-y-auto">
                  <div className="p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex size-10 items-center justify-center rounded-2xl bg-foreground text-[14.5px] font-semibold text-background shadow-xs">
                        {contextPatient.avatar}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <strong className="text-[14.5px] font-semibold">
                            {contextPatient.name}
                          </strong>
                          <span className="text-[11.5px] text-muted-foreground">
                            {contextPatient.sex} · {contextPatient.age} 岁
                          </span>
                        </div>
                        <div className="font-mono text-[10.5px] text-muted-foreground">
                          {contextPatient.patientId}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {contextPatient.allergies.map((a) => (
                        <span
                          key={a}
                          className="rounded-full bg-[var(--cc-crimson-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--cc-crimson)]"
                        >
                          过敏：{a}
                        </span>
                      ))}
                      {contextPatient.chronicConditions.map((c) => (
                        <span
                          key={c}
                          className="rounded-full bg-[var(--cc-sheet)] px-2 py-0.5 text-[10.5px] text-muted-foreground shadow-[0_0_0_1px_var(--cc-hairline)]"
                        >
                          {c}
                        </span>
                      ))}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {contextPatient.vitals.map((v) => (
                        <div
                          key={v.label}
                          className={`rounded-xl px-3 py-2 ${
                            v.abnormal
                              ? 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]'
                              : 'bg-[var(--cc-sheet)] shadow-[0_0_0_1px_var(--cc-hairline)]'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[10px] opacity-75">
                            <span>{v.label}</span>
                            {v.abnormal && <span className="font-semibold">偏高</span>}
                          </div>
                          <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums">
                            {v.value}{' '}
                            <span className="text-[10px] font-normal opacity-75">{v.unit}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4">
                    <div className="cc-kicker mb-2.5">手机版显式发布 & 投递卡片</div>
                    <div className="flex flex-col gap-2.5">
                      {state.resources
                        .filter((r) => r.patientKey === contextPatientKey)
                        .map((res) => (
                          <div
                            key={res.id}
                            className="flex flex-col gap-2 rounded-xl bg-[var(--cc-sheet)] p-3 shadow-[var(--cc-shadow-xs)]"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-[12.5px] font-semibold text-foreground">
                                  {res.title}
                                </div>
                                <div className="text-[10.5px] text-muted-foreground">
                                  v{res.version} ·{' '}
                                  {res.published ? `已发布 ${res.publishedAt}` : '仅院内可见'}
                                </div>
                              </div>
                              <Switch
                                aria-label={`发布 ${res.title} 至患者手机版`}
                                checked={res.published}
                                disabled={staff.role !== 'doctor'}
                                onCheckedChange={() => actions.toggleResourcePublish(res.id)}
                              >
                                <SwitchThumb />
                              </Switch>
                            </div>
                            {res.published && activeConv.status === 'active' && (
                              <button
                                type="button"
                                onClick={() => actions.shareResourceCard(activeConv.id, res.id)}
                                className="cc-btn-ai h-7 w-full text-[11px]"
                              >
                                <Share2Icon size={11} />
                                投递卡片至当前会话
                              </button>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>

                  <div className="p-4">
                    <div className="cc-kicker mb-2.5">
                      会话成员与权限投影（v{activeConv.membershipVersion}）
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {activeConv.members.map((m) => (
                        <div
                          key={m.id}
                          className="flex items-center justify-between rounded-xl bg-[var(--cc-sheet)] px-3 py-2 shadow-[var(--cc-shadow-xs)]"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`flex size-6 shrink-0 items-center justify-center rounded-lg text-[10.5px] font-semibold ${
                                m.kind === 'agent'
                                  ? 'bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]'
                                  : 'bg-[var(--cc-surface-subtle)] text-foreground'
                              }`}
                            >
                              {m.avatar}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-[12px] font-semibold">
                                {m.name}
                                {m.status === 'removed' && (
                                  <span className="ml-1.5 text-[10px] text-[var(--cc-crimson)]">
                                    已撤销
                                  </span>
                                )}
                              </div>
                              <div className="truncate text-[10.5px] text-muted-foreground">
                                {m.roleLabel}
                              </div>
                            </div>
                          </div>
                          {m.id !== 'patient_a' && m.id !== 'doctor_a' && (
                            <button
                              type="button"
                              onClick={() => actions.toggleGroupMember(activeConv.id, m.id)}
                              className="cc-btn-ghost h-6.5 px-2 text-[10.5px]"
                            >
                              {m.status === 'active' ? (
                                <>
                                  <UserMinusIcon size={11} /> 撤销
                                </>
                              ) : (
                                <>
                                  <UserPlusIcon size={11} /> 恢复
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
            </aside>
          </div>
        )}

        {/* ============================================================
            MODULE 3: APPOINTMENTS QUEUE
           ============================================================ */}
        {activeModule === 'appointments' && (
          <main className="cc-scroll min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <div className="mx-auto flex max-w-[1120px] flex-col gap-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="cc-kicker">ClinicWorkspaceDO · 事务容量校验队列</div>
                  <h2 className="m-0 mt-1 text-[21px] font-semibold tracking-tight">门诊预约队列</h2>
                </div>
                <SegmentedControl
                  aria-label="按医生筛选预约"
                  value={doctorFilter}
                  onValueChange={(v) => v && setDoctorFilter(v)}
                >
                  <SegmentedControlIndicator />
                  <SegmentedControlItem value="all">全部医生</SegmentedControlItem>
                  <SegmentedControlItem value="doctor_a">王明 医生</SegmentedControlItem>
                  <SegmentedControlItem value="doctor_b">林悦 医生</SegmentedControlItem>
                </SegmentedControl>
              </div>

              {encounterBanner && (
                <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--cc-amber-soft)] px-4 py-3 text-[12.5px] text-[var(--cc-amber)]">
                  <span className="flex items-center gap-2 font-medium">
                    <ShieldAlertIcon size={15} />
                    {encounterBanner}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEncounterBanner(null)}
                    className="text-xs underline cursor-pointer"
                  >
                    关闭
                  </button>
                </div>
              )}

              <ul className="cc-surface m-0 flex list-none flex-col divide-y divide-[var(--cc-hairline)] p-0 @min-[1040px]:hidden">
                {filteredAppointments.map((apt) => {
                  const p = PATIENTS[apt.patientKey]
                  const meta = APT_STATUS_META[apt.status]
                  return (
                    <li key={apt.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 text-[12.5px]">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--cc-surface-subtle)] font-semibold">{p.avatar}</span>
                      <div className="min-w-[220px] flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">{p.name}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {p.sex} · {p.age} 岁
                          </span>
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${meta.badge}`}>
                            <span className={`size-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-muted-foreground tabular-nums">
                          <ClockIcon size={11} />
                          {apt.dateLabel} {apt.timeRange} · {apt.doctorName}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-foreground/85">
                          <span className="truncate">{apt.chiefComplaint}</span>
                          {apt.source === 'agent_assisted' && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--cc-ai-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--cc-ai)]">
                              <SparklesIcon size={9.5} /> 助手预填
                            </span>
                          )}
                        </div>
                      </div>
                      {appointmentActions(apt)}
                    </li>
                  )
                })}
              </ul>

              <div className="cc-surface hidden overflow-hidden @min-[1040px]:block">
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead>
                    <tr className="cc-divider-b bg-[var(--cc-surface-subtle)] text-[11px] font-semibold text-muted-foreground">
                      <th className="px-5 py-3">患者</th>
                      <th className="px-5 py-3">预约医生与时段</th>
                      <th className="px-5 py-3">主诉与来源</th>
                      <th className="px-5 py-3">状态</th>
                      <th className="px-5 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--cc-hairline)]">
                    {filteredAppointments.map((apt) => {
                      const p = PATIENTS[apt.patientKey]
                      const meta = APT_STATUS_META[apt.status]
                      return (
                        <tr key={apt.id} className="transition-colors hover:bg-[var(--cc-surface-subtle)]/60">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <span className="flex size-8.5 items-center justify-center rounded-xl bg-[var(--cc-surface-subtle)] font-semibold">
                                {p.avatar}
                              </span>
                              <div>
                                <div className="font-semibold text-foreground">{p.name}</div>
                                <div className="font-mono text-[11px] text-muted-foreground">
                                  {p.sex} · {p.age} 岁 · {p.patientId}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="font-medium">
                              {apt.doctorName} · {apt.department}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                              <ClockIcon size={11} />
                              {apt.dateLabel} {apt.timeRange}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="max-w-[260px] truncate">{apt.chiefComplaint}</div>
                            {apt.source === 'agent_assisted' && (
                              <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[var(--cc-ai-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--cc-ai)]">
                                <SparklesIcon size={9.5} /> 患者助手预填
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${meta.badge}`}>
                              <span className={`size-1.5 rounded-full ${meta.dot}`} />
                              {meta.label}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            {appointmentActions(apt)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </main>
        )}

        {/* ============================================================
            MODULE 4: CLINICAL WORKBENCH & EXPLICIT PATIENT RELEASE
           ============================================================ */}
        {activeModule === 'workbench' && (
          <main className="cc-scroll min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <div className="mx-auto flex max-w-[1160px] flex-col gap-5">
              <div className="cc-surface flex flex-wrap items-center justify-between gap-4 p-4.5">
                <div className="flex items-center gap-3.5">
                  <span className="flex size-10 items-center justify-center rounded-2xl bg-[var(--cc-ai-soft)] text-[var(--cc-ai)]">
                    <StethoscopeIcon size={19} />
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="text-[15px]">
                        {activeEncounter && activeEncPatient
                          ? `${activeEncPatient.name} · ${activeEncounter.outpatientNumber}`
                          : '当前无在诊 Encounter'}
                      </strong>
                      <span className="rounded-full bg-[var(--cc-surface-subtle)] px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                        复用原三栏工作台 · Simulated Patient 模拟模式
                      </span>
                    </div>
                    <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                      保留五项 Completion Gates 与 Clinical Copilot 只读边界，新增显式发布至患者手机版控制开关。
                    </p>
                  </div>
                </div>
                {activeEncounter ? (
                  <button
                    type="button"
                    disabled={staff.role !== 'doctor'}
                    onClick={() => actions.completeActiveEncounter()}
                    className="cc-btn-primary h-9 px-4 text-[12.5px]"
                  >
                    <CheckCircle2Icon size={14} />
                    满足五项门控 · 办理完诊
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openModule('appointments')}
                    className="cc-btn-primary h-9 px-4 text-[12.5px]"
                  >
                    前往预约队列接诊
                  </button>
                )}
              </div>

              <div className="grid gap-5 lg:grid-cols-[1fr_1.5fr_1fr]">
                <section className="cc-surface flex flex-col gap-3 p-4.5">
                  <div className="cc-divider-b flex items-center justify-between pb-3">
                    <span className="text-[13.5px] font-semibold">医患问诊（独立于 IM）</span>
                    <span className="rounded-full bg-[var(--cc-surface-subtle)] px-2 py-0.5 text-[10px] text-muted-foreground">
                      Simulated
                    </span>
                  </div>
                  <div className="rounded-xl bg-[var(--cc-surface-subtle)] p-3 text-[12.5px] leading-relaxed">
                    <div className="text-[10.5px] font-semibold text-muted-foreground">模拟患者 · 李建国</div>
                    <p className="m-0 mt-1">
                      王医生，我发烧咳嗽三天了，最高烧到 38.4 度，咳黄痰，吃退烧药能降下来一会儿。我对青霉素过敏。
                    </p>
                  </div>
                  <div className="rounded-xl bg-[var(--cc-emerald-soft)]/60 p-3 text-[12.5px] leading-relaxed">
                    <div className="text-[10.5px] font-semibold text-[var(--cc-emerald)]">查体客观发现</div>
                    <p className="m-0 mt-1">
                      T 38.2°C · BP 134/84 · HR 92 · SpO₂ 97%；右下肺底闻及少量细湿啰音。
                    </p>
                  </div>
                </section>

                <section className="cc-surface flex flex-col gap-3.5 p-4.5">
                  <div className="cc-divider-b flex items-center justify-between pb-3">
                    <span className="text-[13.5px] font-semibold">正式临床记录 & 患者端显式发布</span>
                    <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--cc-emerald)]">
                      <CheckIcon size={13} /> 5/5 门控满足
                    </span>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {state.resources
                      .filter((r) => r.patientKey === 'patient_a')
                      .map((res) => (
                        <div
                          key={res.id}
                          className="flex items-center justify-between gap-3 rounded-xl bg-[var(--cc-surface-subtle)] p-3.5"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <FileTextIcon size={14} className="text-[var(--cc-ai)]" />
                              <strong className="text-[13px]">{res.title}</strong>
                              <span className="font-mono text-[10.5px] text-muted-foreground">
                                v{res.version}
                              </span>
                            </div>
                            <div className="mt-1 text-[11.5px] text-muted-foreground">
                              {res.published
                                ? `已于 ${res.publishedAt} 投影至患者手机版`
                                : '未发布 · 患者手机版严格隐藏'}
                            </div>
                          </div>
                          <Switch
                            aria-label={`发布 ${res.title}`}
                            checked={res.published}
                            disabled={staff.role !== 'doctor'}
                            onCheckedChange={() => actions.toggleResourcePublish(res.id)}
                          >
                            <SwitchThumb />
                          </Switch>
                        </div>
                      ))}
                  </div>
                </section>

                <section className="cc-ai-card flex flex-col gap-3 p-4.5">
                  <div className="cc-divider-b flex items-center justify-between pb-3">
                    <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[var(--cc-ai)]">
                      <SparklesIcon size={14} /> Clinical Copilot
                    </span>
                    <span className="rounded-full bg-[var(--cc-ai-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cc-ai)]">
                      只读 + 草稿
                    </span>
                  </div>
                  <p className="m-0 text-[12.5px] leading-relaxed text-foreground/90">
                    已核对既往青霉素过敏史，当前处方方案无冲突。胸部低剂量 CT 已完成阅片，如需患者于手机版查阅，请开启中栏发布开关。
                  </p>
                  <div className="mt-auto rounded-xl bg-[var(--cc-sheet)]/80 p-3 text-[11px] leading-relaxed text-muted-foreground shadow-[0_0_0_1px_var(--cc-hairline)]">
                    安全边界：Clinical Copilot 禁止直接提交正式病历、处方或发布投影。
                  </div>
                </section>
              </div>
            </div>
          </main>
        )}

        {/* ============================================================
            MODULE 5: PATIENTS MASTER-DETAIL
           ============================================================ */}
        {activeModule === 'patients' && (
          <main className="cc-scroll min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <div className="mx-auto grid max-w-[1120px] gap-5 lg:grid-cols-[296px_1fr]">
              <section className="cc-surface overflow-hidden">
                <div className="cc-divider-b px-4 py-3.5 text-[13px] font-semibold">
                  授权患者档案（{Object.keys(PATIENTS).length}）
                </div>
                <div className="divide-y divide-[var(--cc-hairline)]">
                  {(Object.keys(PATIENTS) as PatientKey[]).map((key) => {
                    const p = PATIENTS[key]
                    const active = selectedPatient === key
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedPatient(key)}
                        className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors cursor-pointer ${
                          active ? 'bg-[var(--cc-ai-soft)]' : 'hover:bg-[var(--cc-surface-subtle)]'
                        }`}
                      >
                        <span className="flex size-9.5 items-center justify-center rounded-xl bg-[var(--cc-surface-subtle)] text-[13px] font-semibold">
                          {p.avatar}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] font-semibold">{p.name}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {p.sex} · {p.age} 岁
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                            {p.chiefComplaint}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>

              {(() => {
                const p = PATIENTS[selectedPatient]
                const pResources = state.resources.filter((r) => r.patientKey === selectedPatient)
                return (
                  <section className="cc-surface flex flex-col gap-5 p-6">
                    <div className="cc-divider-b flex flex-wrap items-start justify-between gap-4 pb-5">
                      <div className="flex items-center gap-4">
                        <span className="flex size-13 items-center justify-center rounded-2xl bg-foreground text-[18px] font-semibold text-background shadow-sm">
                          {p.avatar}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <h2 className="m-0 text-[19px] font-semibold">{p.name}</h2>
                            <span className="font-mono text-[11.5px] text-muted-foreground">
                              {p.patientId}
                            </span>
                            <span className="rounded-full bg-[var(--cc-emerald-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--cc-emerald)]">
                              手机版已绑定
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px]">
                            {p.allergies.map((a) => (
                              <span key={a} className="rounded-full bg-[var(--cc-crimson-soft)] px-2.5 py-0.5 font-medium text-[var(--cc-crimson)]">
                                过敏：{a}
                              </span>
                            ))}
                            {p.chronicConditions.map((c) => (
                              <span key={c} className="rounded-full bg-[var(--cc-surface-subtle)] px-2.5 py-0.5 text-muted-foreground">
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {p.vitals.map((v) => (
                          <div
                            key={v.label}
                            className={`rounded-xl px-3 py-2 text-center ${
                              v.abnormal
                                ? 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]'
                                : 'bg-[var(--cc-surface-subtle)]'
                            }`}
                          >
                            <div className="text-[10px] opacity-75">{v.label}</div>
                            <div className="font-mono text-[13px] font-semibold tabular-nums">
                              {v.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="cc-kicker mb-3">正式资料发布控制</div>
                      <div className="flex flex-col gap-2.5">
                        {pResources.map((res) => (
                          <div
                            key={res.id}
                            className="flex items-center justify-between gap-4 rounded-xl bg-[var(--cc-surface-subtle)] p-3.5"
                          >
                            <div>
                              <div className="text-[13px] font-semibold">{res.title}</div>
                              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                                {res.subtitle}
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span
                                className={`rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold ${
                                  res.published
                                    ? 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {res.published ? '手机版可见' : '未发布'}
                              </span>
                              <Switch
                                aria-label={`发布 ${res.title}`}
                                checked={res.published}
                                disabled={staff.role !== 'doctor'}
                                onCheckedChange={() => actions.toggleResourcePublish(res.id)}
                              >
                                <SwitchThumb />
                              </Switch>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                )
              })()}
            </div>
          </main>
        )}

        {/* ============================================================
            MODULE 6: FOLLOW-UP CENTER
           ============================================================ */}
        {activeModule === 'followup' && activePlan && (
          <main className="cc-scroll min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <div className="mx-auto grid max-w-[1120px] gap-5 lg:grid-cols-[300px_1fr]">
              <section className="cc-surface overflow-hidden">
                <div className="cc-divider-b px-4 py-3.5 text-[13px] font-semibold">
                  随访计划（{state.followupPlans.length}）
                </div>
                <div className="divide-y divide-[var(--cc-hairline)]">
                  {state.followupPlans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => setSelectedPlanId(plan.id)}
                      className={`flex w-full flex-col gap-1 px-4 py-3.5 text-left transition-colors cursor-pointer ${
                        plan.id === activePlan.id
                          ? 'bg-[var(--cc-ai-soft)]'
                          : 'hover:bg-[var(--cc-surface-subtle)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold">
                          {PATIENTS[plan.patientKey].name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            plan.status === 'completed'
                              ? 'bg-muted text-muted-foreground'
                              : 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                          }`}
                        >
                          {plan.status === 'completed' ? '已结案' : '进行中'}
                        </span>
                      </div>
                      <div className="text-[12px] text-foreground/85">{plan.title}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {plan.responses.length} 条反馈 · {plan.summaries.length} 份摘要
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <section className="cc-surface flex flex-col gap-5 p-6">
                <div className="cc-divider-b flex flex-wrap items-start justify-between gap-3 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="m-0 text-[18px] font-semibold">{activePlan.title}</h2>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        #{activePlan.id}
                      </span>
                    </div>
                    <p className="m-0 mt-1 text-[12px] text-muted-foreground">
                      患者：{PATIENTS[activePlan.patientKey].name} · {activePlan.startDate} ~{' '}
                      {activePlan.endDate}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        openConversation(activePlan.conversationId)
                      }}
                      className="cc-btn-ghost h-8 px-3 text-[12px]"
                    >
                      进入随访群
                    </button>
                    {activePlan.status === 'active' && (
                      <button
                        type="button"
                        onClick={() => actions.triggerFollowupAgentSummary(activePlan.id)}
                        className="cc-btn-ai h-8 px-3 text-[12px]"
                      >
                        <SparklesIcon size={13} /> @随访助手 生成摘要
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="cc-kicker mb-2.5">患者问卷反馈</div>
                  {activePlan.responses.length === 0 ? (
                    <div className="rounded-xl bg-[var(--cc-surface-subtle)] p-4 text-[12px] text-muted-foreground">
                      尚未收到患者提交。请打开右上角「患者手机版」填写随访问卷。
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {activePlan.responses.map((r) => (
                        <div key={r.id} className="rounded-xl bg-[var(--cc-surface-subtle)] p-4 text-[12.5px]">
                          <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                            <span>{r.id}</span>
                            <span>{r.submittedAt}</span>
                          </div>
                          <div className="mt-2.5 grid grid-cols-3 gap-3">
                            <div>
                              <span className="text-[10.5px] text-muted-foreground">体温</span>
                              <div className="font-semibold">{r.temperature}</div>
                            </div>
                            <div>
                              <span className="text-[10.5px] text-muted-foreground">症状</span>
                              <div className="font-semibold">{r.symptomScore}</div>
                            </div>
                            <div>
                              <span className="text-[10.5px] text-muted-foreground">依从性</span>
                              <div className="font-semibold">{r.adherence}</div>
                            </div>
                          </div>
                          <p className="m-0 mt-2 text-foreground/85">{r.note}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="cc-kicker mb-2.5">Follow-up Agent 摘要与医生审核</div>
                  {activePlan.summaries.length === 0 ? (
                    <div className="rounded-xl bg-[var(--cc-surface-subtle)] p-4 text-[12px] text-muted-foreground">
                      暂无摘要，点击上方「@随访助手 生成摘要」即可基于患者反馈草拟。
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {activePlan.summaries.map((sum) => (
                        <div key={sum.id} className="cc-ai-card p-4">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[12.5px] font-semibold">
                              摘要 v{sum.version} ·{' '}
                              <span className="font-mono text-[11px] font-normal text-muted-foreground">
                                {sum.sourceResponseIds.join(', ') || '会话上下文'}
                              </span>
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold ${
                                sum.status === 'approved'
                                  ? 'bg-[var(--cc-emerald-soft)] text-[var(--cc-emerald)]'
                                  : sum.status === 'rejected'
                                    ? 'bg-[var(--cc-crimson-soft)] text-[var(--cc-crimson)]'
                                    : 'bg-[var(--cc-amber-soft)] text-[var(--cc-amber)]'
                              }`}
                            >
                              {sum.status === 'approved'
                                ? `已批准固化 · ${sum.reviewedBy}`
                                : sum.status === 'rejected'
                                  ? '已驳回'
                                  : '待医生审核'}
                            </span>
                          </div>
                          <p className="mt-2 mb-0 text-[12.5px] leading-relaxed">{sum.content}</p>
                          {sum.status === 'draft' && (
                            <div className="mt-3 flex justify-end gap-2">
                              <button
                                type="button"
                                disabled={staff.role !== 'doctor'}
                                onClick={() =>
                                  actions.reviewFollowupSummary(activePlan.id, sum.id, 'rejected')
                                }
                                className="cc-btn-ghost h-7.5 px-3 text-xs"
                              >
                                驳回重拟
                              </button>
                              <button
                                type="button"
                                disabled={staff.role !== 'doctor'}
                                onClick={() =>
                                  actions.reviewFollowupSummary(activePlan.id, sum.id, 'approved')
                                }
                                className="cc-btn-primary h-7.5 px-3.5 text-xs"
                              >
                                批准形成正式记录
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </main>
        )}

        {/* ============================================================
            MODULE 7: AGENT RUNS OBSERVABILITY
           ============================================================ */}
        {activeModule === 'agents' && (
          <main className="cc-scroll min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <div className="mx-auto flex max-w-[1120px] flex-col gap-5">
              <div className="flex items-end justify-between">
                <div>
                  <div className="cc-kicker">Durable Agent Runtime · Tool Audit</div>
                  <h2 className="m-0 mt-1 text-[21px] font-semibold tracking-tight">
                    Agent 运行与工具轨迹审计
                  </h2>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--cc-emerald-soft)] px-3 py-1 text-[11.5px] font-semibold text-[var(--cc-emerald)]">
                  <ShieldCheckIcon size={13} /> 无隐藏思考 / 无 Case Truth 泄漏
                </span>
              </div>

              <div className="flex flex-col gap-3.5">
                {state.agentRuns.map((run) => (
                  <div key={run.id} className="cc-surface p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--cc-ai-soft)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--cc-ai)]">
                          <SparklesIcon size={11} />
                          {run.agentName}
                        </span>
                        <strong className="text-[14px]">{run.triggerLabel}</strong>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {run.id}
                        </span>
                      </div>
                      <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
                        {run.startedAt} · {run.durationMs}ms ·{' '}
                        <span className="font-semibold text-[var(--cc-emerald)]">{run.status}</span>
                      </span>
                    </div>

                    <div className="mt-3.5 grid gap-2.5 md:grid-cols-2">
                      {run.tools.map((t, idx) => (
                        <div
                          key={`${t.name}-${idx}`}
                          className="flex items-start gap-2.5 rounded-xl bg-[var(--cc-surface-subtle)] p-3 text-[12px]"
                        >
                          <WrenchIcon size={13} className="mt-0.5 shrink-0 text-[var(--cc-ai)]" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-mono text-[11.5px] font-semibold">
                              <span>{t.name}</span>
                              <span className="text-[10.5px] font-normal text-muted-foreground">
                                ({t.scope})
                              </span>
                            </div>
                            <div className="mt-0.5 text-muted-foreground">{t.summary}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 text-[11.5px] text-muted-foreground">{run.auditNote}</div>
                  </div>
                ))}
              </div>
            </div>
          </main>
        )}
      </div>

      {dockOpen && (
        <aside className="cc-phone-dock" aria-label="患者端实时预览">
          <div className="flex items-start justify-between gap-2 px-1">
            <div>
              <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                <span className="cc-live-dot text-[var(--cc-emerald)]" />
                患者端 · 小程序预览
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">与医生端共享同一份实时状态，可同时操作</div>
            </div>
            <button type="button" aria-label="收起患者端预览" onClick={() => setDockOpen(false)} className="cc-btn-ghost size-7.5 p-0">
              <XIcon size={14} />
            </button>
          </div>
          <SegmentedControl
            aria-label="切换演示患者"
            className="cc-dock-switch"
            value={state.currentPatient}
            onValueChange={(value) => value && actions.setPatient(value as PatientKey)}
          >
            <SegmentedControlIndicator />
            {(Object.keys(PATIENTS) as PatientKey[]).map((key) => (
              <SegmentedControlItem key={key} value={key}>
                {PATIENTS[key].name}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <div className="cc-phone-dock-stage">
            <PatientMobileApp key={state.currentPatient} state={state} actions={actions} feedback={feedback} mode="device" />
          </div>
        </aside>
      )}

      <StatusToastRegion toaster={feedback.toast.staff} placement="desk" label="医生端提示" />
      <NotificationRegion toaster={feedback.notify.staff} placement="desk" label="医生端通知" onOpen={openStaffTarget} />

      {/* ⌘K Command Palette */}
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogBackdrop />
        <DialogContent className="cc-cmd-dialog" aria-label="快捷命令面板">
          <DialogTitle className="sr-only">快捷命令面板</DialogTitle>
          <Command
            onAction={(value) => {
              if (value === 'open-mobile') setDockOpen(true)
              else if (value === 'publish-ct') actions.toggleResourcePublish('rep_lijg_ct_unpub')
              else if (value === 'trigger-followup') {
                actions.triggerFollowupAgentSummary('fp_01')
                openConversation('conv_followup_a')
              } else if (NAV_ITEMS.some((i) => i.id === value)) {
                openModule(value as HisModule)
              }
              setCommandOpen(false)
            }}
          >
            <div className="cc-divider-b flex items-center gap-2.5 px-4 py-3">
              <SearchIcon size={15} className="text-muted-foreground" />
              <CommandInput
                aria-label="搜索命令或页面"
                placeholder="输入模块名称、患者姓名或操作命令…"
                className="w-full border-0 bg-transparent text-[13.5px] focus:shadow-none"
              />
            </div>
            <CommandEmpty className="py-8 text-center text-xs text-muted-foreground">
              未找到匹配的命令
            </CommandEmpty>
            <CommandList className="max-h-72 overflow-y-auto p-2">
              <CommandGroup>
                <CommandGroupLabel className="px-2 py-1 text-[10.5px] font-semibold text-muted-foreground">
                  快捷演示动作
                </CommandGroupLabel>
                <CommandItem value="open-mobile" className="rounded-lg px-2.5 py-2 text-[12.5px]">
                  显示患者端实时预览
                </CommandItem>
                <CommandItem value="publish-ct" className="rounded-lg px-2.5 py-2 text-[12.5px]">
                  显式发布 / 撤回李建国「胸部低剂量 CT 报告」
                </CommandItem>
                <CommandItem value="trigger-followup" className="rounded-lg px-2.5 py-2 text-[12.5px]">
                  触发 @随访助手 生成摘要并跳转至随访群
                </CommandItem>
              </CommandGroup>
              <CommandGroup>
                <CommandGroupLabel className="px-2 py-1 text-[10.5px] font-semibold text-muted-foreground">
                  切换工作区模块
                </CommandGroupLabel>
                {NAV_ITEMS.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    className="rounded-lg px-2.5 py-2 text-[12.5px]"
                  >
                    跳转至 {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  )
}
