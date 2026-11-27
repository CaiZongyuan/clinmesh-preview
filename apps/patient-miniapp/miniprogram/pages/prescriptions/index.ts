import type { PatientReleaseView } from '../../../../../src/shared/auth'
import { ensureLoggedInOrRedirect } from '../../services/auth'
import { hisApi } from '../../services/his-api'

Page({
  data: { items: [] as PatientReleaseView[], error: '' },
  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    try {
      this.setData({ items: await hisApi.getMyPrescriptions(), error: '' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载处方失败' })
    }
  },
})
