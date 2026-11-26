import type { AppointmentView } from '../../../../../src/shared/appointment'
import type { Principal } from '../../../../../src/shared/auth'
import type { FollowupPlanView } from '../../../../../src/shared/followup'
import { ensureLoggedInOrRedirect, getStoredPrincipal } from '../../services/auth'
import { hisApi } from '../../services/his-api'
import { imClient } from '../../services/im-client'

Page({
  data: {
    principal: null as Principal | null,
    appointments: [] as AppointmentView[],
    plans: [] as FollowupPlanView[],
    loading: false,
    error: '',
  },

  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    this.setData({ principal: getStoredPrincipal(), loading: true, error: '' })
    try {
      const [me, appointments, plans] = await Promise.all([
        hisApi.getMe(),
        hisApi.getMyAppointments(),
        hisApi.getFollowupPlans(),
      ])
      this.setData({ principal: me, appointments, plans })
      await imClient.connect().catch(() => {})
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载首页失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  goTo(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '')
    if (!url) return
    if (url === '/pages/assistant/index' || url === '/pages/messages/index') {
      wx.switchTab({ url })
    } else {
      wx.navigateTo({ url })
    }
  },
})
