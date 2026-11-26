import type { Principal } from '../../../../../src/shared/auth'
import { ensureLoggedInOrRedirect, getStoredPrincipal, logoutAndClear } from '../../services/auth'
import { imClient } from '../../services/im-client'

Page({
  data: {
    principal: null as Principal | null,
  },

  onShow() {
    if (!ensureLoggedInOrRedirect()) return
    this.setData({ principal: getStoredPrincipal() })
  },

  async onLogout() {
    imClient.disconnect()
    await logoutAndClear()
    wx.reLaunch({ url: '/pages/login/index' })
  },
})
