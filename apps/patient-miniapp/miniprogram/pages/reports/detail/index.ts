import type { PatientReleaseView } from '../../../../../../src/shared/auth'
import { ensureLoggedInOrRedirect } from '../../../services/auth'
import { hisApi } from '../../../services/his-api'

Page({
  data: { id: '', item: null as PatientReleaseView | null, error: '' },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({ id: query.id ? decodeURIComponent(query.id) : '' })
  },
  async onShow() {
    if (!ensureLoggedInOrRedirect() || !this.data.id) return
    try {
      this.setData({ item: await hisApi.getMyReportDetail(this.data.id), error: '' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '无权查看或未找到该报告' })
    }
  },
})
