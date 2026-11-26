import type { ChatMessage, ConversationView } from '../../../../../src/shared/communication'
import { dispatchWhitelistedAction } from '../../actions/registry'
import { ensureLoggedInOrRedirect } from '../../services/auth'
import { getApiBaseUrl } from '../../services/config'
import { hisApi } from '../../services/his-api'
import { imClient } from '../../services/im-client'

Page({
  data: {
    conversationId: '',
    conversation: null as ConversationView | null,
    messages: [] as ChatMessage[],
    nextCursor: null as number | null,
    inputText: '',
    mentionAgent: false,
    recording: false,
    sending: false,
    error: '',
  },

  unsubscribe: null as (() => void) | null,
  recorder: null as WechatMiniprogram.RecorderManager | null,
  recordStartedAt: 0,

  onLoad(query: Record<string, string | undefined>) {
    if (query.conversationId) {
      this.setData({ conversationId: decodeURIComponent(query.conversationId) })
    }
  },

  async onShow() {
    if (!ensureLoggedInOrRedirect() || !this.data.conversationId) return
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
    try {
      const [conversation, page] = await Promise.all([
        hisApi.getConversation(this.data.conversationId),
        hisApi.getMessages(this.data.conversationId),
      ])
      this.setData({ conversation, messages: page.messages, nextCursor: page.nextCursor, error: '' })
      const maxSeq = page.messages.at(-1)?.sequence ?? 0
      if (maxSeq > 0) await hisApi.markRead(this.data.conversationId, maxSeq).catch(() => {})
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载会话失败' })
    }
  },

  async onLoadOlder() {
    if (!this.data.nextCursor) return
    const page = await hisApi.getMessages(this.data.conversationId, this.data.nextCursor)
    this.setData({ messages: [...page.messages, ...this.data.messages], nextCursor: page.nextCursor })
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ inputText: e.detail.value })
  },

  onToggleMention() {
    this.setData({ mentionAgent: !this.data.mentionAgent })
  },

  async onSendText() {
    const text = this.data.inputText.trim()
    if (!text || this.data.sending) return
    this.setData({ sending: true, error: '', inputText: '' })
    try {
      await hisApi.sendMessage(this.data.conversationId, {
        clientMessageId: `mp-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parts: [{ type: 'text', text }],
        mentions: this.data.mentionAgent ? ['actor_agent_followup'] : [],
      })
      this.setData({ mentionAgent: false })
      await this.load()
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '发送失败' })
    } finally {
      this.setData({ sending: false })
    }
  },

  onStartRecord() {
    if (this.data.recording) return
    const recorder = wx.getRecorderManager()
    this.recorder = recorder
    this.recordStartedAt = Date.now()
    recorder.onStop((res) => {
      this.setData({ recording: false })
      const durationMs = Math.max(1000, Math.min(60000, res.duration || Date.now() - this.recordStartedAt))
      void this.uploadAndSendAudio(res.tempFilePath, durationMs)
    })
    recorder.onError((err) => {
      this.setData({ recording: false, error: err.errMsg || '录音失败' })
    })
    this.setData({ recording: true, error: '' })
    recorder.start({ duration: 60000, format: 'mp3' })
  },

  onStopRecord() {
    this.recorder?.stop()
  },

  async uploadAndSendAudio(filePath: string, durationMs: number) {
    this.setData({ sending: true, error: '' })
    try {
      const fs = wx.getFileSystemManager()
      const buffer = fs.readFileSync(filePath) as ArrayBuffer
      const init = await hisApi.initAttachment({
        conversationId: this.data.conversationId,
        kind: 'audio',
        mime: 'audio/mpeg',
        size: buffer.byteLength,
        durationMs,
      })
      await hisApi.uploadAttachmentBuffer(init.uploadUrl, 'audio/mpeg', buffer)
      await hisApi.completeAttachment(init.attachment.attachmentId, true)
      await hisApi.sendMessage(this.data.conversationId, {
        clientMessageId: `mp-aud-${Date.now()}`,
        parts: [{ type: 'audio', attachmentId: init.attachment.attachmentId, durationMs }],
      })
      await this.load()
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '语音上传发送失败' })
    } finally {
      this.setData({ sending: false })
    }
  },

  async onPlayAudio(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    try {
      const access = await hisApi.getAttachmentAccess(id)
      const audio = wx.createInnerAudioContext()
      audio.src = `${getApiBaseUrl()}${access.url}`
      audio.play()
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '语音播放失败' })
    }
  },

  async onCardAction(e: WechatMiniprogram.BaseEvent) {
    const action = e.currentTarget.dataset.action
    const res = await dispatchWhitelistedAction(action, {
      isForeground: () => true,
      navigateTo: ({ url }) =>
        new Promise<void>((resolve, reject) => {
          wx.navigateTo({ url, success: () => resolve(), fail: (err) => reject(err) })
        }),
    })
    if (!res.ok) this.setData({ error: res.reason || '操作受限' })
  },
})
