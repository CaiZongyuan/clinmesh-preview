import type { PatientReleaseView } from '../../../../../src/shared/auth'
import { ensureLoggedInOrRedirect } from '../../services/auth'
import { hisApi } from '../../services/his-api'

Page({
  data: { items: [] as PatientReleaseView[], error: '' },
  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    try {
      this.setData({ items: await hisApi.getMyReports(), error: '' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载检查报告失败' })
    }
  },
  openDetail(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (id) wx.navigateTo({ url: `/pages/reports/detail/index?id=${encodeURIComponent(id)}` })
  },
})
