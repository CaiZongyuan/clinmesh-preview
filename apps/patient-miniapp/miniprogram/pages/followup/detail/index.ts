import type { FollowupPlanView } from '../../../../../../src/shared/followup'
import { ensureLoggedInOrRedirect } from '../../../services/auth'
import { hisApi } from '../../../services/his-api'

Page({
  data: {
    planId: '',
    plan: null as FollowupPlanView | null,
    symptomChange: '明显好转',
    adherence: '完全按时服药',
    measurement: '',
    notes: '',
    submitting: false,
    error: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ planId: query.planId ? decodeURIComponent(query.planId) : '' })
  },

  async onShow() {
    if (!ensureLoggedInOrRedirect() || !this.data.planId) return
    await this.load()
  },

  async load() {
    try {
      this.setData({ plan: await hisApi.getFollowupPlan(this.data.planId), error: '' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载随访详情失败' })
    }
  },

  onMeasurementInput(e: WechatMiniprogram.Input) {
    this.setData({ measurement: e.detail.value })
  },

  onNotesInput(e: WechatMiniprogram.Input) {
    this.setData({ notes: e.detail.value })
  },

  async onSubmitTask(e: WechatMiniprogram.BaseEvent) {
    const taskId = String(e.currentTarget.dataset.taskId || '')
    if (!taskId || this.data.submitting) return
    this.setData({ submitting: true, error: '' })
    try {
      await hisApi.submitFollowupResponse(
        taskId,
        {
          symptom_change: this.data.symptomChange,
          medication_adherence: this.data.adherence,
          temperature_or_bp: this.data.measurement || '126/78 mmHg',
          notes: this.data.notes,
        },
        `mp-resp-${taskId}`,
      )
      wx.showToast({ title: '反馈已提交', icon: 'success' })
      await this.load()
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '提交随访反馈失败' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  openGroup() {
    const cid = this.data.plan?.conversationId
    if (cid) wx.navigateTo({ url: `/pages/chat/index?conversationId=${encodeURIComponent(cid)}` })
  },
})
