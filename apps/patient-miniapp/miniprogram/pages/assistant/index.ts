import { createAgentStreamState, type AgentStreamState } from '../../../../../src/shared/agent-stream-reducer'
import type { ChatMessage } from '../../../../../src/shared/communication'
import { dispatchWhitelistedAction } from '../../actions/registry'
import { NativeAgentStreamTransport, type MiniProgramSocketTask } from '../../services/agent-transport'
import { ensureLoggedInOrRedirect, getStoredToken } from '../../services/auth'
import { getWsBaseUrl } from '../../services/config'
import { hisApi } from '../../services/his-api'

Page({
  data: {
    conversationId: '',
    messages: [] as ChatMessage[],
    inputText: '',
    stream: createAgentStreamState(0) as AgentStreamState,
    sending: false,
    error: '',
  },

  transport: null as NativeAgentStreamTransport | null,
  foreground: true,

  async onShow() {
    this.foreground = true
    if (!ensureLoggedInOrRedirect()) return
    await this.ensureConversationAndLoad()
    this.transport?.reconnect()
  },

  onHide() {
    this.foreground = false
  },

  onUnload() {
    this.foreground = false
    this.transport?.disconnect()
    this.transport = null
  },

  async ensureConversationAndLoad() {
    this.setData({ error: '' })
    try {
      const conv = await hisApi.createConversation({
        type: 'patient_assistant',
        memberActorIds: ['actor_agent_patient_svc'],
      })
      const page = await hisApi.getMessages(conv.conversationId)
      this.setData({ conversationId: conv.conversationId, messages: page.messages })
      const maxSeq = page.messages.at(-1)?.sequence ?? 0
      if (maxSeq > 0) await hisApi.markRead(conv.conversationId, maxSeq).catch(() => {})
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '加载就医助手会话失败' })
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ inputText: e.detail.value })
  },

  onQuickPrompt(e: WechatMiniprogram.BaseEvent) {
    const text = String(e.currentTarget.dataset.text || '')
    if (!text) return
    this.setData({ inputText: text })
    void this.onSend()
  },

  async onSend() {
    const text = this.data.inputText.trim()
    if (!text || !this.data.conversationId || this.data.sending) return
    this.setData({ sending: true, error: '', inputText: '' })
    try {
      const res = await hisApi.sendMessage(this.data.conversationId, {
        clientMessageId: `mp-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parts: [{ type: 'text', text }],
      })
      const run = res.triggeredAgentRuns[0]
      if (run) {
        this.attachStream(run.runId)
        await this.syncRunSnapshotAndActions(run.runId)
      }
      const latest = await hisApi.getMessages(this.data.conversationId)
      this.setData({ messages: latest.messages })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '发送失败，请重试' })
    } finally {
      this.setData({ sending: false })
    }
  },

  attachStream(runId: string) {
    this.transport?.disconnect()
    const token = getStoredToken()
    this.transport = new NativeAgentStreamTransport({
      url: `${getWsBaseUrl()}/api/agent/runs/${encodeURIComponent(runId)}/socket`,
      token,
      prefix: 'stream',
      connectSocket: (opts) => wx.connectSocket(opts) as unknown as MiniProgramSocketTask,
      onPatches: (patches) => {
        // Incremental path-level setData: never re-renders the entire historical message list.
        this.setData(patches)
      },
      onResyncRequired: () => {
        void this.ensureConversationAndLoad()
      },
    })
    this.transport.connect()
  },

  async syncRunSnapshotAndActions(runId: string) {
    try {
      const snap = await hisApi.getAgentRun(runId)
      for (const pending of snap.pendingActions) {
        if (pending.status !== 'pending') continue
        const result = await dispatchWhitelistedAction(pending.action, {
          isForeground: () => this.foreground,
          navigateTo: ({ url }) =>
            new Promise<void>((resolve, reject) => {
              wx.navigateTo({ url, success: () => resolve(), fail: (err) => reject(err) })
            }),
        })
        await hisApi.submitAgentActionResult(runId, pending.callId, result.code, {
          route: result.route,
          reason: result.reason,
        })
      }
    } catch {
      // Non-fatal: user can always tap the persisted business card.
    }
  },

  async onStopRun() {
    const activeRunId = this.data.stream.activeRunId
    if (!activeRunId) return
    await hisApi.stopAgentRun(activeRunId).catch(() => {})
  },

  async onCardAction(e: WechatMiniprogram.BaseEvent) {
    const action = e.currentTarget.dataset.action
    const res = await dispatchWhitelistedAction(action, {
      isForeground: () => this.foreground,
      navigateTo: ({ url }) =>
        new Promise<void>((resolve, reject) => {
          wx.navigateTo({ url, success: () => resolve(), fail: (err) => reject(err) })
        }),
    })
    if (!res.ok) {
      this.setData({ error: res.reason || '该操作未获授权' })
    }
  },
})
