import type { AppointmentView } from '../../../../../src/shared/appointment'
import { ensureLoggedInOrRedirect } from '../../services/auth'
import { hisApi } from '../../services/his-api'

Page({
  data: {
    appointments: [] as AppointmentView[],
    error: '',
  },

  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    await this.load()
  },

  async load() {
    try {
      const appointments = await hisApi.getMyAppointments()
      this.setData({ appointments, error: '' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载预约失败' })
    }
  },

  goBook() {
    wx.navigateTo({ url: '/pages/appointments/book/index' })
  },

  async onCancel(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    try {
      await hisApi.cancelAppointment(id)
      await this.load()
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '取消失败' })
    }
  },
})
