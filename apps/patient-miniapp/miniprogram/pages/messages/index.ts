import type { ConversationView } from '../../../../../src/shared/communication'
import { ensureLoggedInOrRedirect } from '../../services/auth'
import { hisApi } from '../../services/his-api'
import { imClient } from '../../services/im-client'

Page({
  data: {
    conversations: [] as ConversationView[],
    loading: false,
    error: '',
  },

  unsubscribe: null as (() => void) | null,

  async onShow() {
    if (!ensureLoggedInOrRedirect()) return
    await this.load()
    this.unsubscribe = imClient.onIncoming(() => {
      void this.load()
    })
  },

  onHide() {
    this.unsubscribe?.()
    this.unsubscribe = null
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const conversations = await hisApi.getConversations()
      this.setData({ conversations })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载消息列表失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  openConversation(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const type = String(e.currentTarget.dataset.type || '')
    if (!id) return
    if (type === 'patient_assistant') {
      wx.switchTab({ url: '/pages/assistant/index' })
      return
    }
    wx.navigateTo({ url: `/pages/chat/index?conversationId=${encodeURIComponent(id)}` })
  },
})
