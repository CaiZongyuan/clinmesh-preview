import type { AuthSessionResponse, Principal } from '../../../../src/shared/auth'
import { getApiBaseUrl } from './config'

const TOKEN_KEY = 'clinmesh.mp.token'
const PRINCIPAL_KEY = 'clinmesh.mp.principal'

export function getStoredToken(): string {
  try {
    return (wx.getStorageSync(TOKEN_KEY) as string) || ''
  } catch {
    return ''
  }
}

export function getStoredPrincipal(): Principal | null {
  try {
    const raw = wx.getStorageSync(PRINCIPAL_KEY) as string | undefined
    return raw ? (JSON.parse(raw) as Principal) : null
  } catch {
    return null
  }
}

export function saveSession(session: AuthSessionResponse): void {
  wx.setStorageSync(TOKEN_KEY, session.token)
  wx.setStorageSync(PRINCIPAL_KEY, JSON.stringify(session.principal))
}

export function clearLocalAuthCache(): void {
  try {
    wx.removeStorageSync(TOKEN_KEY)
    wx.removeStorageSync(PRINCIPAL_KEY)
  } catch {}
}

export function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res.code) resolve(res.code)
        else reject(new Error('wx.login 未返回临时 code'))
      },
      fail: (err) => reject(new Error(err.errMsg || 'wx.login 调用失败')),
    })
  })
}

export function loginWithWeChatCode(code: string, inviteCode?: string): Promise<AuthSessionResponse> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getApiBaseUrl()}/api/auth/wechat`,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: inviteCode && inviteCode.trim() ? { code, inviteCode: inviteCode.trim() } : { code },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = res.data as AuthSessionResponse
          saveSession(data)
          resolve(data)
        } else {
          const errBody = res.data as { error?: { message?: string } } | undefined
          reject(new Error(errBody?.error?.message || `登录失败 (${res.statusCode})`))
        }
      },
      fail: (err) => reject(new Error(err.errMsg || '网络请求失败')),
    })
  })
}

export function logoutAndClear(): Promise<void> {
  const token = getStoredToken()
  return new Promise((resolve) => {
    if (!token) {
      clearLocalAuthCache()
      resolve()
      return
    }
    wx.request({
      url: `${getApiBaseUrl()}/api/auth/logout`,
      method: 'POST',
      header: { Authorization: `Bearer ${token}` },
      complete: () => {
        clearLocalAuthCache()
        resolve()
      },
    })
  })
}

export function isLocalDevMiniapp(): boolean {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion !== 'release'
  } catch {
    return true
  }
}

export async function ensureDevPatientSession(): Promise<boolean> {
  if (getStoredToken()) return true
  if (!isLocalDevMiniapp()) return false
  try {
    await loginWithWeChatCode('wx-code:dev_pat_01', 'CLIN-A-2026')
    return true
  } catch {
    return false
  }
}

export function ensureLoggedInOrRedirect(): boolean {
  if (getStoredToken()) return true
  wx.reLaunch({ url: '/pages/login/index' })
  return false
}
