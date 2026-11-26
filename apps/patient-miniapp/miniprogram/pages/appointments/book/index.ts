import type { AppointmentSlotView } from '../../../../../../src/shared/appointment'
import { ensureLoggedInOrRedirect } from '../../../services/auth'
import { hisApi } from '../../../services/his-api'

Page({
  data: {
    slots: [] as AppointmentSlotView[],
    selectedSlotId: '',
    doctorFilter: '',
    chiefComplaint: '',
    submitting: false,
    error: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    // Supports Agent pre-fill via appointment.open({ slotId, doctorId }).
    this.setData({
      selectedSlotId: query.slotId ? decodeURIComponent(query.slotId) : '',
      doctorFilter: query.doctorId ? decodeURIComponent(query.doctorId) : '',
    })
  },

  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    try {
      const slots = await hisApi.getSlots(this.data.doctorFilter ? { doctorId: this.data.doctorFilter } : undefined)
      const openSlots = slots.filter((s) => s.status === 'open')
      this.setData({
        slots: openSlots,
        selectedSlotId: this.data.selectedSlotId || openSlots.find((s) => s.remaining > 0)?.slotId || '',
        error: '',
      })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载号源失败' })
    }
  },

  onSelectSlot(e: WechatMiniprogram.BaseEvent) {
    this.setData({ selectedSlotId: String(e.currentTarget.dataset.id || '') })
  },

  onComplaintInput(e: WechatMiniprogram.Input) {
    this.setData({ chiefComplaint: e.detail.value })
  },

  async onConfirmBook() {
    if (!this.data.selectedSlotId || this.data.submitting) return
    this.setData({ submitting: true, error: '' })
    try {
      await hisApi.bookAppointment({
        slotId: this.data.selectedSlotId,
        clientRequestId: `mp-book-${this.data.selectedSlotId}-${Date.now()}`,
        chiefComplaint: this.data.chiefComplaint.trim() || undefined,
      })
      wx.showToast({ title: '预约已确认', icon: 'success' })
      wx.navigateBack()
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '预约失败，请重新选择号源' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
