// Local development defaults; override via storage key `clinmesh.apiBaseUrl` in WeChat DevTools.
const DEFAULT_API_BASE = 'http://127.0.0.1:5173'
const DEFAULT_WS_BASE = 'ws://127.0.0.1:5173'

export function getApiBaseUrl(): string {
  try {
    const custom = wx.getStorageSync('clinmesh.apiBaseUrl') as string | undefined
    return custom && custom.trim() ? custom.trim().replace(/\/+$/, '') : DEFAULT_API_BASE
  } catch {
    return DEFAULT_API_BASE
  }
}

export function getWsBaseUrl(): string {
  const api = getApiBaseUrl()
  if (api.startsWith('https://')) return `wss://${api.slice('https://'.length)}`
  if (api.startsWith('http://')) return `ws://${api.slice('http://'.length)}`
  return DEFAULT_WS_BASE
}
