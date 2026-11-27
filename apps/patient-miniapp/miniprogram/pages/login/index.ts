import { loginWithWeChatCode, wxLoginCode } from '../../services/auth'

Page({
  data: {
    inviteCode: 'CLIN-A-2026',
    demoUserKey: 'demo_pat_a',
    loading: false,
    error: '',
  },

  onInviteInput(e: WechatMiniprogram.Input) {
    this.setData({ inviteCode: e.detail.value })
  },

  onSelectDemoPatient(e: WechatMiniprogram.BaseEvent) {
    const key = String(e.currentTarget.dataset.key || 'demo_pat_a')
    const invite = String(e.currentTarget.dataset.invite || 'CLIN-A-2026')
    this.setData({ demoUserKey: key, inviteCode: invite })
  },

  async onWeChatLogin() {
    this.setData({ loading: true, error: '' })
    try {
      let code: string
      try {
        code = await wxLoginCode()
      } catch {
        code = `wx-code:${this.data.demoUserKey}`
      }
      await loginWithWeChatCode(code, this.data.inviteCode)
      wx.switchTab({ url: '/pages/home/index' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '登录失败，请检查本地服务与邀请码' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async onLocalScriptedLogin() {
    this.setData({ loading: true, error: '' })
    try {
      await loginWithWeChatCode(`wx-code:${this.data.demoUserKey}`, this.data.inviteCode)
      wx.switchTab({ url: '/pages/home/index' })
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : '本地演示登录失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
