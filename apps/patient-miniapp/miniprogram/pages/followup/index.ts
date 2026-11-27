import type { FollowupPlanView } from '../../../../../src/shared/followup'
import { ensureLoggedInOrRedirect } from '../../services/auth'
import { hisApi } from '../../services/his-api'

Page({
  data: { plans: [] as FollowupPlanView[], error: '' },
  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    try {
      this.setData({ plans: await hisApi.getFollowupPlans(), error: '' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载随访计划失败' })
    }
  },
  openPlan(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (id) wx.navigateTo({ url: `/pages/followup/detail/index?planId=${encodeURIComponent(id)}` })
  },
})
