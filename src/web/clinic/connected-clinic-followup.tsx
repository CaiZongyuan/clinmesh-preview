import { Button } from '@ui-sdk/react/button'
import { useState } from 'react'
import type { Principal } from '../../shared/auth'
import type { StaffPatientView } from '../../shared/appointment'
import type { FollowupPlanView } from '../../shared/followup'
import { closeFollowupPlan, createFollowupPlan, reviewFollowupSummary } from './clinic-api'

interface Props {
  principal: Principal
  plans: FollowupPlanView[]
  patients: StaffPatientView[]
  onRefresh: () => Promise<void>
}

export function ConnectedClinicFollowup({ principal, plans, patients, onRefresh }: Props) {
  const [patientId, setPatientId] = useState(patients[0]?.patientId ?? '')
  const [title, setTitle] = useState('门诊后 7 天居家随访计划')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDoctor = principal.role === 'doctor'

  async function handleCreate() {
    if (!patientId || !title.trim()) return
    setBusy(true)
    setError(null)
    try {
      await createFollowupPlan({ patientId, title: title.trim() })
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建随访计划失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleReview(summaryId: string, decision: 'approved' | 'rejected') {
    setBusy(true)
    setError(null)
    try {
      await reviewFollowupSummary(summaryId, { decision, note: decision === 'approved' ? '医生已核对确认' : '需补充反馈后重拟' })
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '审核失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleClose(planId: string) {
    setBusy(true)
    setError(null)
    try {
      await closeFollowupPlan(planId)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '关闭随访计划失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error ? <div className="cc-error">{error}</div> : null}

      {isDoctor ? (
        <div className="cc-card">
          <h3 className="cc-card-title">创建院外随访计划（自动建随访群并加入随访助手）</h3>
          <div className="cc-row">
            <select
              aria-label="选择随访患者"
              className="cc-select"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              <option value="">选择患者...</option>
              {patients.map((p) => (
                <option key={p.patientId} value={p.patientId}>
                  {p.displayName} ({p.outpatientNumber})
                </option>
              ))}
            </select>
            <input
              aria-label="随访计划标题"
              className="cc-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button className="cc-btn cc-btn-primary" disabled={busy || !patientId || !title.trim()} onClick={() => void handleCreate()}>
              创建计划与随访群
            </Button>
          </div>
        </div>
      ) : null}

      {plans.map((plan) => (
        <div key={plan.planId} className="cc-card">
          <div className="cc-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h3 className="cc-card-title" style={{ marginBottom: 4 }}>
                {plan.title} · {plan.patientName}
              </h3>
              <div className="cc-row">
                <span className={`cc-badge ${plan.status === 'active' ? 'cc-badge-success' : ''}`}>{plan.status}</span>
                <span className="cc-badge">负责人：{plan.ownerStaffName}</span>
                {plan.conversationId ? <span className="cc-badge cc-badge-info">随访群：{plan.conversationId}</span> : null}
              </div>
            </div>
            {isDoctor && plan.status === 'active' ? (
              <Button className="cc-btn cc-btn-danger" disabled={busy} onClick={() => void handleClose(plan.planId)}>
                关闭计划（群转只读）
              </Button>
            ) : null}
          </div>

          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>随访问卷任务</strong>
            {plan.tasks.map((task) => (
              <div key={task.taskId} style={{ marginTop: 6, padding: 8, background: 'var(--muted)', borderRadius: 6, fontSize: 13 }}>
                <div className="cc-row" style={{ justifyContent: 'space-between' }}>
                  <span>{task.title}</span>
                  <span className="cc-badge">{task.status}</span>
                </div>
                {task.response ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted-foreground)' }}>
                    患者反馈：{JSON.stringify(task.response.answers)}（提交于 {task.response.submittedAt.slice(0, 16)}）
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>随访摘要审核（需医生人工确认）</strong>
            {plan.summaries.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>
                暂无摘要草稿（可在随访群中 @随访助手 生成待审核摘要）。
              </div>
            ) : (
              plan.summaries.map((sum) => (
                <div key={sum.summaryId} style={{ marginTop: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
                  <div className="cc-row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      v{sum.version} · 来源反馈 {sum.sourceResponseIds.length} 条
                    </span>
                    <span
                      className={`cc-badge ${
                        sum.status === 'approved' ? 'cc-badge-success' : sum.status === 'draft' ? 'cc-badge-warn' : ''
                      }`}
                    >
                      {sum.status}
                    </span>
                  </div>
                  <p style={{ margin: '6px 0', fontSize: 13 }}>{sum.draftText}</p>
                  {isDoctor && sum.status === 'draft' ? (
                    <div className="cc-row">
                      <Button className="cc-btn cc-btn-primary" disabled={busy} onClick={() => void handleReview(sum.summaryId, 'approved')}>
                        医生确认批准
                      </Button>
                      <Button className="cc-btn cc-btn-danger" disabled={busy} onClick={() => void handleReview(sum.summaryId, 'rejected')}>
                        驳回草稿
                      </Button>
                    </div>
                  ) : sum.reviewedByName ? (
                    <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                      审核人：{sum.reviewedByName} · {sum.reviewNote ?? ''}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {plan.reviewTasks.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>待人工复核任务</strong>
              {plan.reviewTasks.map((rt) => (
                <div key={rt.reviewTaskId} style={{ marginTop: 6, padding: 8, background: 'var(--muted)', borderRadius: 6, fontSize: 12 }}>
                  <span className="cc-badge cc-badge-warn" style={{ marginRight: 8 }}>
                    {rt.status}
                  </span>
                  {rt.reason}（来源：{rt.sourceRef}）
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
