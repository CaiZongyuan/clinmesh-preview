export interface WeChatAuthEnv {
  WECHAT_APP_ID?: string
  WECHAT_APP_SECRET?: string
  WECHAT_AUTH_MODE?: string
  WECHAT_API_BASE_URL?: string
}

export type WeChatResolveResult =
  | { ok: true; openid: string }
  | { ok: false; code: 'wechat-not-configured' | 'wechat-auth-failed'; message: string }

const SCRIPTED_CODE = /^wx-code:([A-Za-z0-9_-]{3,64})$/

// Exchanges a temporary wx.login code for a stable openid without ever storing or returning session_key or AppSecret.
export async function resolveWeChatOpenId(code: string, env: WeChatAuthEnv): Promise<WeChatResolveResult> {
  const trimmed = code.trim()
  if (!trimmed || trimmed.length > 128) {
    return { ok: false, code: 'wechat-auth-failed', message: '微信登录凭证无效。' }
  }

  if (env.WECHAT_AUTH_MODE === 'scripted') {
    const match = SCRIPTED_CODE.exec(trimmed)
    if (!match) {
      return { ok: false, code: 'wechat-auth-failed', message: '微信登录凭证校验失败。' }
    }
    return { ok: true, openid: `wx_openid_${match[1]}` }
  }

  const appId = env.WECHAT_APP_ID?.trim()
  const secret = env.WECHAT_APP_SECRET?.trim()
  if (!appId || !secret) {
    return { ok: false, code: 'wechat-not-configured', message: '未配置微信小程序 AppID/AppSecret，无法完成微信登录。' }
  }

  const base = (env.WECHAT_API_BASE_URL?.trim() || 'https://api.weixin.qq.com').replace(/\/$/, '')
  const url = `${base}/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(trimmed)}&grant_type=authorization_code`

  try {
    const response = await fetch(url, { method: 'GET' })
    if (!response.ok) {
      return { ok: false, code: 'wechat-auth-failed', message: '微信登录服务暂时不可用。' }
    }
    const payload = (await response.json()) as { openid?: unknown; errcode?: unknown }
    if (typeof payload.openid !== 'string' || !payload.openid || (typeof payload.errcode === 'number' && payload.errcode !== 0)) {
      return { ok: false, code: 'wechat-auth-failed', message: '微信 code2Session 校验失败。' }
    }
    return { ok: true, openid: payload.openid }
  } catch {
    return { ok: false, code: 'wechat-auth-failed', message: '微信登录网络请求失败。' }
  }
}
