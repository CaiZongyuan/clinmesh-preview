import { Link, useNavigate } from '@tanstack/react-router'
import { Button } from '@ui-sdk/react/button'
import { Preferences } from '@ui-sdk/react/preferences'
import { PlusIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AppointmentView, StaffPatientView } from '../../shared/appointment'
import type { ContactView, DoctorView, Principal } from '../../shared/auth'
import type { ConversationView } from '../../shared/communication'
import type { EncounterView } from '../../shared/encounter'
import type { AgentRunSnapshot, FollowupPlanView } from '../../shared/followup'
import { fetchActiveEncounter } from '../api'
import { DoctorMastheadNav, type ClinicTabParam } from '../workbench/doctor-masthead-nav'
import { CLINIC_DEPARTMENT } from '../workbench/queue-rail'
import { WorkbenchAppearance, workbenchPreferences } from '../workbench/workbench-preferences'
import {
  checkInStaffAppointment,
  createConversation,
  fetchAgentRun,
  fetchClinicDirectory,
  fetchConversations,
  fetchCurrentPrincipal,
  fetchFollowupPlans,
  fetchStaffAppointments,
  fetchStaffPatients,
  loginStaffAccount,
  logoutStaffAccount,
  publishPatientRelease,
  resetDemoClinicData,
  startStaffAppointmentEncounter,
  stopAgentRun,
} from './clinic-api'
import { ConnectedClinicFollowup } from './connected-clinic-followup'
import { ConnectedClinicMessages } from './connected-clinic-messages'
import './connected-clinic-shell.css'

type ClinicSection = ClinicTabParam

const SHOW_DEMO_CONTROLS = import.meta.env.DEV || import.meta.env.MODE === 'test'
const AUTO_DEV_STAFF_AUTH = import.meta.env.DEV && import.meta.env.MODE !== 'test'

function formatShanghaiTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function ConnectedClinicShell({ initialSection }: { initialSection?: ClinicSection } = {}) {
  const navigate = useNavigate()
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [username, setUsername] = useState(SHOW_DEMO_CONTROLS ? 'dr.wang' : '')
  const [password, setPassword] = useState(SHOW_DEMO_CONTROLS ? 'demo-doctor-a-pass' : '')
  const [localSection, setLocalSection] = useState<ClinicSection>(initialSection ?? 'dashboard')
  const section = initialSection ?? localSection

  function selectSection(next: ClinicSection) {
    setLocalSection(next)
    void navigate({ to: '/clinic', search: { tab: next }, replace: true })
  }
  const [appointments, setAppointments] = useState<AppointmentView[]>([])
  const [patients, setPatients] = useState<StaffPatientView[]>([])
  const [doctors, setDoctors] = useState<DoctorView[]>([])
  const [conversations, setConversations] = useState<ConversationView[]>([])
  const [contacts, setContacts] = useState<ContactView[]>([])
  const [plans, setPlans] = useState<FollowupPlanView[]>([])
  const [activeEncounter, setActiveEncounter] = useState<EncounterView | null>(null)
  const [recentRunIds, setRecentRunIds] = useState<string[]>([])
  const [runs, setRuns] = useState<AgentRunSnapshot[]>([])
  const [doctorFilter, setDoctorFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refreshAll = useCallback(async () => {
    const [appts, pats, convs, dir, fPlans, activeEnc] = await Promise.all([
      fetchStaffAppointments(),
      fetchStaffPatients(),
      fetchConversations(),
      fetchClinicDirectory(),
      fetchFollowupPlans(),
      fetchActiveEncounter().catch(() => null),
    ])
    setAppointments(appts)
    setPatients(pats)
    setDoctors(dir.doctors)
    setConversations(convs)
    setContacts(dir.contacts)
    setPlans(fPlans)
    setActiveEncounter(activeEnc)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let me = await fetchCurrentPrincipal()
      if (!me && AUTO_DEV_STAFF_AUTH) {
        me = await loginStaffAccount('dr.wang', 'demo-doctor-a-pass')
          .then((session) => session.principal)
          .catch(() => null)
      }
      if (cancelled) return
      setPrincipal(me)
      setLoadingAuth(false)
      if (me && me.staffId) {
        await refreshAll().catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : '加载门诊工作台失败')
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshAll])

  async function handleLogin(u = username, p = password) {
    setBusy(true)
    setError(null)
    try {
      const session = await loginStaffAccount(u, p)
      setPrincipal(session.principal)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    await logoutStaffAccount()
    setPrincipal(null)
    setAppointments([])
    setConversations([])
    setPlans([])
  }

  async function handleCheckIn(appointmentId: string) {
    setBusy(true)
    setError(null)
    try {
      await checkInStaffAppointment(appointmentId)
      setNotice('已办理签到。')
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '签到失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleStartEncounter(appointmentId: string) {
    setBusy(true)
    setError(null)
    try {
      const started = await startStaffAppointmentEncounter(appointmentId)
      setNotice(`已接诊，关联就诊 ${started.encounter.encounterId}`)
      await refreshAll()
      await navigate({ to: '/encounters/$encounterId', params: { encounterId: started.encounter.encounterId } })
    } catch (err) {
      setError(err instanceof Error ? err.message : '接诊失败')
    } finally {
      setBusy(false)
    }
  }

  async function handlePublish(encounterId: string, resourceType: 'clinical_note' | 'report' | 'prescription') {
    setBusy(true)
    setError(null)
    try {
      const item = await publishPatientRelease({ encounterId, resourceType })
      setNotice(`已向患者发布：${item.title}（v${item.version}）`)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布患者资料失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleMessagePatient(patientActorId: string) {
    setBusy(true)
    setError(null)
    try {
      await createConversation({ type: 'patient_doctor', memberActorIds: [patientActorId] })
      await refreshAll()
      selectSection('messages')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建医患会话失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleRefreshRuns(ids = recentRunIds) {
    const snapshots = await Promise.all(ids.map((id) => fetchAgentRun(id).catch(() => null)))
    setRuns(snapshots.filter((s): s is AgentRunSnapshot => s !== null))
  }

  async function handleResetDemo() {
    setBusy(true)
    setError(null)
    try {
      await resetDemoClinicData()
      await logoutStaffAccount()
      setPrincipal(null)
      setNotice('演示数据已重置，请重新登录。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败')
    } finally {
      setBusy(false)
    }
  }

  if (loadingAuth) {
    return (
      <main className="cc-login-wrap">
        <p>正在加载 Connected Clinic HIS...</p>
      </main>
    )
  }

  if (!principal || !principal.staffId) {
    return (
      <main className="cc-login-wrap">
        <section className="cc-login-card" aria-label="医护登录">
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>ClinMesh Connected Clinic HIS</h1>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted-foreground)' }}>
              模拟演示模式 · 所有患者、预约、病历与随访记录均为合成演示数据
            </p>
          </div>
          {error ? <div className="cc-error">{error}</div> : null}
          {notice ? <div className="cc-badge cc-badge-success">{notice}</div> : null}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            医护账号
            <input className="cc-input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            密码
            <input className="cc-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <Button className="cc-btn cc-btn-primary" disabled={busy} onClick={() => void handleLogin()}>
            登录医护工作台
          </Button>
          {SHOW_DEMO_CONTROLS ? (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 8 }}>本地开发演示账号快捷登录：</div>
              <div className="cc-row">
                <Button
                  className="cc-btn"
                  disabled={busy}
                  onClick={() => {
                    setUsername('dr.wang')
                    setPassword('demo-doctor-a-pass')
                    void handleLogin('dr.wang', 'demo-doctor-a-pass')
                  }}
                >
                  王明医生 (全科)
                </Button>
                <Button
                  className="cc-btn"
                  disabled={busy}
                  onClick={() => {
                    setUsername('dr.lin')
                    setPassword('demo-doctor-b-pass')
                    void handleLogin('dr.lin', 'demo-doctor-b-pass')
                  }}
                >
                  林悦医生 (心内科)
                </Button>
                <Button
                  className="cc-btn"
                  disabled={busy}
                  onClick={() => {
                    setUsername('nurse.zhou')
                    setPassword('demo-nurse-n-pass')
                    void handleLogin('nurse.zhou', 'demo-nurse-n-pass')
                  }}
                >
                  周岚护士
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    )
  }

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0)
  const pendingSummaries = plans.reduce((sum, p) => sum + p.summaries.filter((s) => s.status === 'draft').length, 0)
  const filteredAppointments = appointments.filter(
    (a) => (!statusFilter || a.status === statusFilter) && (!doctorFilter || a.doctorId === doctorFilter),
  )

  return (
    <Preferences preferences={workbenchPreferences}>
      <div className="workbench-shell flex h-full flex-col">
        <header className="masthead">
          <span className="brand-mark" aria-hidden="true"><PlusIcon size={15} strokeWidth={3} /></span>
          <h1>门诊医生工作台</h1>
          <span className="department">{CLINIC_DEPARTMENT}</span>
          <DoctorMastheadNav active={section} activeEncounterId={activeEncounter?.encounterId} />
          <div className="masthead-tools">
            <WorkbenchAppearance />
          </div>
        </header>
        <div className="cc-shell">
          <aside className="cc-sidebar">
            <div className="cc-brand">
              <h2 className="cc-brand-title">ClinMesh 互联门诊</h2>
              <p className="cc-brand-sub">
                {principal.displayName} · {principal.role === 'doctor' ? '主诊医生' : '护理团队'}
              </p>
            </div>
            <nav className="cc-nav" aria-label="HIS 主导航">
              {(
                [
                  ['dashboard', '工作台', null],
                  ['appointments', '预约队列', appointments.filter((a) => a.status === 'booked' || a.status === 'checked_in').length || null],
                  ['patients', '患者档案', patients.length || null],
                  ['messages', '消息中心', totalUnread || null],
                  ['followup', '随访管理', pendingSummaries || null],
                  ['runs', 'Agent 运行', runs.length || null],
                ] as const
              ).map(([id, label, badge]) => (
                <button
                  key={id}
                  type="button"
                  className="cc-nav-btn"
                  data-active={section === id}
                  onClick={() => {
                    selectSection(id)
                    if (id === 'runs') void handleRefreshRuns()
                  }}
                >
                  <span>{label}</span>
                  {badge ? <span className="cc-badge cc-badge-info">{badge}</span> : null}
                </button>
              ))}
            </nav>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {activeEncounter ? (
            <Link to="/encounters/$encounterId" params={{ encounterId: activeEncounter.encounterId }} className="cc-btn cc-btn-primary">
              进入当前临床工作台
            </Link>
          ) : (
            <Link to="/" className="cc-btn">
              独立临床模拟工作台
            </Link>
          )}
          <Button className="cc-btn" disabled={busy} onClick={() => void refreshAll()}>
            刷新数据
          </Button>
          {SHOW_DEMO_CONTROLS ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>快捷切换演示身份</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                <Button className="cc-btn" disabled={busy} onClick={() => void handleLogin('dr.wang', 'demo-doctor-a-pass')}>
                  王明
                </Button>
                <Button className="cc-btn" disabled={busy} onClick={() => void handleLogin('dr.lin', 'demo-doctor-b-pass')}>
                  林悦
                </Button>
                <Button className="cc-btn" disabled={busy} onClick={() => void handleLogin('nurse.zhou', 'demo-nurse-n-pass')}>
                  周岚
                </Button>
              </div>
              <Button className="cc-btn cc-btn-danger" disabled={busy} onClick={() => void handleResetDemo()}>
                重置演示数据
              </Button>
            </div>
          ) : null}
          <Button className="cc-btn" onClick={() => void handleLogout()}>
            退出登录
          </Button>
        </div>
      </aside>

      <div className="cc-main">
        <header className="cc-topbar">
          <strong style={{ fontSize: 15 }}>
            {section === 'dashboard' && '门诊总览工作台'}
            {section === 'appointments' && '门诊预约与接诊队列'}
            {section === 'patients' && '授权患者档案'}
            {section === 'messages' && '医患 / 医护 / 随访消息中心'}
            {section === 'followup' && '院外随访计划与摘要审核'}
            {section === 'runs' && 'Agent 运行监控（授权视图）'}
          </strong>
          <div className="cc-row">
            <span className="cc-badge cc-badge-info">模拟演示环境</span>
            <span className="cc-badge">{principal.staffId}</span>
          </div>
        </header>
        <div className="cc-banner">
          演示说明：当前诊所为单 active encounter 约束，患者诊疗采用 Golden Case 与 Simulated Patient 闭环；所有正式医疗决定须医生人工确认并显式发布给患者。
        </div>

        <main className="cc-content">
          {error ? <div className="cc-error">{error}</div> : null}
          {notice ? <div className="cc-badge cc-badge-success">{notice}</div> : null}

          {section === 'dashboard' ? (
            <>
              <div className="cc-grid-4">
                <div className="cc-card">
                  <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>待接诊预约</div>
                  <div className="cc-metric">
                    {appointments.filter((a) => a.status === 'booked' || a.status === 'checked_in').length}
                  </div>
                </div>
                <div className="cc-card">
                  <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>当前进行中接诊</div>
                  <div className="cc-metric">{activeEncounter ? '1' : '0'}</div>
                </div>
                <div className="cc-card">
                  <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>待医生审核随访摘要</div>
                  <div className="cc-metric">{pendingSummaries}</div>
                </div>
                <div className="cc-card">
                  <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>未读消息数</div>
                  <div className="cc-metric">{totalUnread}</div>
                </div>
              </div>

              {activeEncounter ? (
                <div className="cc-card">
                  <h3 className="cc-card-title">当前活跃接诊：{activeEncounter.patient.name}</h3>
                  <p style={{ fontSize: 13, color: 'var(--muted-foreground)', margin: '0 0 12px' }}>
                    就诊 ID：{activeEncounter.encounterId} · 科室：{activeEncounter.patient.department} · 主诉：{activeEncounter.patient.chiefComplaint}
                  </p>
                  <div className="cc-row">
                    <Link to="/encounters/$encounterId" params={{ encounterId: activeEncounter.encounterId }} className="cc-btn cc-btn-primary">
                      打开原临床工作台（含 Clinical Copilot）
                    </Link>
                    {principal.role === 'doctor' ? (
                      <>
                        <Button className="cc-btn" disabled={busy} onClick={() => void handlePublish(activeEncounter.encounterId, 'clinical_note')}>
                          发布已签署病历给患者
                        </Button>
                        <Button className="cc-btn" disabled={busy} onClick={() => void handlePublish(activeEncounter.encounterId, 'report')}>
                          发布最新报告给患者
                        </Button>
                        <Button className="cc-btn" disabled={busy} onClick={() => void handlePublish(activeEncounter.encounterId, 'prescription')}>
                          发布正式处方给患者
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {section === 'appointments' ? (
            <div className="cc-card">
              <div className="cc-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                <h3 className="cc-card-title" style={{ margin: 0 }}>
                  预约队列（单 active encounter 排队）
                </h3>
                <div className="cc-row">
                  <select
                    aria-label="按医生筛选预约"
                    className="cc-select"
                    value={doctorFilter}
                    onChange={(e) => setDoctorFilter(e.target.value)}
                  >
                    <option value="">全部医生</option>
                    {doctors.map((d) => (
                      <option key={d.staffId} value={d.staffId}>
                        {d.displayName} ({d.departmentName})
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="按状态筛选预约"
                    className="cc-select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">全部状态</option>
                    <option value="booked">已预约</option>
                    <option value="checked_in">已签到</option>
                    <option value="in_encounter">接诊中</option>
                    <option value="completed">已完诊</option>
                    <option value="cancelled">已取消</option>
                  </select>
                </div>
              </div>
              {activeEncounter ? (
                <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 10 }}>
                  提示：当前已有进行中的就诊（{activeEncounter.patient.name}），其他预约需等待当前完诊或放弃后方可接诊。
                </div>
              ) : null}
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>患者</th>
                    <th>医生 / 科室</th>
                    <th>预约时段</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAppointments.map((appt) => (
                    <tr key={appt.appointmentId}>
                      <td>
                        <strong>{appt.patientName}</strong>
                        <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{appt.outpatientNumber}</div>
                      </td>
                      <td>
                        {appt.doctorName} · {appt.departmentName}
                      </td>
                      <td>{formatShanghaiTime(appt.startsAt)} (北京时间)</td>
                      <td>
                        <span className="cc-badge">{appt.status}</span>
                      </td>
                      <td>
                        <div className="cc-row">
                          {appt.status === 'booked' ? (
                            <Button className="cc-btn" disabled={busy} onClick={() => void handleCheckIn(appt.appointmentId)}>
                              签到
                            </Button>
                          ) : null}
                          {principal.role === 'doctor' && (appt.status === 'booked' || appt.status === 'checked_in') ? (
                            <Button
                              className="cc-btn cc-btn-primary"
                              disabled={busy}
                              onClick={() => void handleStartEncounter(appt.appointmentId)}
                            >
                              开始接诊
                            </Button>
                          ) : null}
                          {appt.encounterId ? (
                            <>
                              <Link to="/encounters/$encounterId" params={{ encounterId: appt.encounterId }} className="cc-btn">
                                查看诊疗
                              </Link>
                              {principal.role === 'doctor' ? (
                                <Button
                                  className="cc-btn"
                                  disabled={busy}
                                  onClick={() => void handlePublish(appt.encounterId!, 'clinical_note')}
                                >
                                  发布病历
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredAppointments.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ color: 'var(--muted-foreground)' }}>
                        暂无匹配的预约记录。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {section === 'patients' ? (
            <div className="cc-card">
              <h3 className="cc-card-title">授权患者档案</h3>
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>患者</th>
                    <th>科室 / 关系</th>
                    <th>既往过敏与慢病</th>
                    <th>已发布资料 / 预约</th>
                    <th>协同</th>
                  </tr>
                </thead>
                <tbody>
                  {patients.map((p) => (
                    <tr key={p.patientId}>
                      <td>
                        <strong>{p.displayName}</strong>
                        <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{p.outpatientNumber}</div>
                      </td>
                      <td>
                        {p.departmentName} · {p.relation}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        过敏：{p.allergies.map((a) => a.agent).join('、') || '无'}
                        <br />
                        慢病：{p.chronicConditions.map((c) => c.display).join('、') || '无'}
                      </td>
                      <td>
                        {p.releaseCount} 份资料 / {p.appointmentCount} 次预约
                      </td>
                      <td>
                        <Button className="cc-btn" disabled={busy} onClick={() => void handleMessagePatient(p.actorId)}>
                          发消息
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {section === 'messages' ? (
            <ConnectedClinicMessages
              principal={principal}
              conversations={conversations}
              contacts={contacts}
              onRefresh={refreshAll}
              onRunTriggered={(runId) => {
                setRecentRunIds((prev) => [runId, ...prev.filter((id) => id !== runId)])
              }}
            />
          ) : null}

          {section === 'followup' ? (
            <ConnectedClinicFollowup principal={principal} plans={plans} patients={patients} onRefresh={refreshAll} />
          ) : null}

          {section === 'runs' ? (
            <div className="cc-card">
              <div className="cc-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <h3 className="cc-card-title" style={{ margin: 0 }}>
                  Agent 运行摘要（不展示隐藏思考或 Case Truth）
                </h3>
                <Button className="cc-btn" onClick={() => void handleRefreshRuns()}>
                  刷新运行记录
                </Button>
              </div>
              {runs.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
                  本会话尚未触发 Agent 运行。可在随访群中勾选 @随访助手 发送消息后查看工具调用摘要。
                </p>
              ) : (
                runs.map((run) => (
                  <div key={run.runId} className="cc-card" style={{ marginBottom: 10 }}>
                    <div className="cc-row" style={{ justifyContent: 'space-between' }}>
                      <strong>
                        {run.agentKind} · {run.runId}
                      </strong>
                      <div className="cc-row">
                        <span className="cc-badge cc-badge-info">{run.status}</span>
                        {run.status === 'running' ? (
                          <Button className="cc-btn cc-btn-danger" onClick={() => void stopAgentRun(run.runId).then(() => handleRefreshRuns())}>
                            停止
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      工具调用：{run.toolCalls.map((t) => `${t.name}(${t.status})`).join(' → ') || '无'}
                    </div>
                    {run.error ? <div className="cc-error" style={{ marginTop: 6 }}>{run.error}</div> : null}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </main>
        </div>
      </div>
      </div>
    </Preferences>
  )
}
