import { decodeBase64Utf8, encodeBase64Utf8 } from '../auth/crypto'

export { decodeBase64Utf8, encodeBase64Utf8 }

export interface WuKongImEnv {
  WUKONGIM_MODE?: string
  WUKONGIM_HTTP_URL?: string
  WUKONGIM_WS_URL?: string
  WUKONGIM_MANAGER_TOKEN?: string
}

export interface ImSendParams {
  channelId: string
  channelType: number
  fromUid: string
  clientMsgNo: string
  payloadBase64: string
}

export interface ImSendResult {
  messageId: string
  messageSeq: number
}

export interface ImSyncedMessage {
  messageId: string
  messageSeq: number
  clientMsgNo: string
  fromUid: string
  payloadBase64: string
  timestamp: number
}

export interface ImAdapter {
  readonly mode: 'live' | 'fake'
  readonly wsUrl: string
  registerUserToken(uid: string, token: string): Promise<void>
  kickUserDevice(uid: string): Promise<void>
  ensureChannel(channelId: string, channelType: number, subscribers: string[]): Promise<void>
  addSubscribers(channelId: string, channelType: number, subscribers: string[]): Promise<void>
  removeSubscribers(channelId: string, channelType: number, subscribers: string[]): Promise<void>
  sendMessage(params: ImSendParams): Promise<ImSendResult>
  syncChannelMessages(params: {
    channelId: string
    channelType: number
    loginUid: string
    limit?: number
  }): Promise<ImSyncedMessage[]>
}

// Extracts 64-bit integer fields from raw JSON before JSON.parse so snowflake message_id never loses precision.
export function extractRawInt64Field(rawJson: string, field: string): string | null {
  const strMatch = new RegExp(`"${field}(?:_str|str)"\\s*:\\s*"([^"]+)"`).exec(rawJson)
  if (strMatch) return strMatch[1]
  const numMatch = new RegExp(`"${field}"\\s*:\\s*([0-9]+)`).exec(rawJson)
  if (numMatch) return numMatch[1]
  const quotedMatch = new RegExp(`"${field}"\\s*:\\s*"([0-9]+)"`).exec(rawJson)
  return quotedMatch ? quotedMatch[1] : null
}

// Rewrites unquoted 64-bit `"message_id": 1234567890123456789` into quoted strings prior to JSON.parse.
export function preserveRawInt64MessageIds(rawJson: string): string {
  return rawJson.replace(/"message_id"\s*:\s*([0-9]{10,})/g, '"message_id":"$1"')
}

// Test-only fault injection seam for B09/B10 uncertain-state & retry testing in worker tests.
export type ImFaultHook = (
  op: 'send' | 'sync' | 'channel' | 'remove' | 'kick',
  ctx: { channelId?: string; clientMsgNo?: string; uid?: string },
) => void | Promise<void>

let activeFaultHook: ImFaultHook | null = null

export function installImFaultHook(hook: ImFaultHook | null): void {
  activeFaultHook = hook
}

// Process-scoped fake WuKongIM store used when WUKONGIM_MODE=fake or no WUKONGIM_HTTP_URL is configured.
interface FakeChannelState {
  subscribers: Set<string>
  nextSeq: number
  messages: ImSyncedMessage[]
}

const fakeChannels = new Map<string, FakeChannelState>()
const fakeUserTokens = new Map<string, string>()

export function resetFakeImStore(): void {
  fakeChannels.clear()
  fakeUserTokens.clear()
}

export function getFakeImSnapshot() {
  return {
    channels: Array.from(fakeChannels.entries()).map(([id, ch]) => ({
      channelId: id,
      subscribers: Array.from(ch.subscribers),
      messageCount: ch.messages.length,
      lastSeq: ch.nextSeq - 1,
    })),
    userTokens: Object.fromEntries(fakeUserTokens.entries()),
  }
}

export function createImAdapter(env: WuKongImEnv): ImAdapter {
  const httpUrl = env.WUKONGIM_HTTP_URL?.trim().replace(/\/+$/, '')
  const wsUrl = env.WUKONGIM_WS_URL?.trim() || 'ws://127.0.0.1:15200'
  const managerToken = env.WUKONGIM_MANAGER_TOKEN?.trim() || ''
  const useLive = Boolean(httpUrl) && env.WUKONGIM_MODE !== 'fake'

  if (!useLive) {
    return {
      mode: 'fake',
      wsUrl,
      async registerUserToken(uid, token) {
        fakeUserTokens.set(uid, token)
      },
      async kickUserDevice(uid) {
        await activeFaultHook?.('kick', { uid })
        fakeUserTokens.delete(uid)
      },
      async ensureChannel(channelId, _channelType, subscribers) {
        await activeFaultHook?.('channel', { channelId })
        const existing = fakeChannels.get(channelId)
        if (existing) {
          for (const sub of subscribers) existing.subscribers.add(sub)
          return
        }
        fakeChannels.set(channelId, {
          subscribers: new Set(subscribers),
          nextSeq: 1,
          messages: [],
        })
      },
      async addSubscribers(channelId, _channelType, subscribers) {
        const ch = fakeChannels.get(channelId) ?? { subscribers: new Set<string>(), nextSeq: 1, messages: [] }
        for (const sub of subscribers) ch.subscribers.add(sub)
        fakeChannels.set(channelId, ch)
      },
      async removeSubscribers(channelId, _channelType, subscribers) {
        await activeFaultHook?.('remove', { channelId })
        const ch = fakeChannels.get(channelId)
        if (!ch) return
        for (const sub of subscribers) ch.subscribers.delete(sub)
      },
      async sendMessage(params) {
        const ch = fakeChannels.get(params.channelId) ?? {
          subscribers: new Set<string>([params.fromUid]),
          nextSeq: 1,
          messages: [],
        }
        fakeChannels.set(params.channelId, ch)
        if (!ch.subscribers.has(params.fromUid)) {
          throw new Error(`IM subscriber not authorized: ${params.fromUid}`)
        }
        // Mirror WuKongIM v2.2.5 real behavior (ADR-0004): POST /message/send appends even on duplicate client_msg_no,
        // proving HIS send_command idempotency + messagesync reconciliation is genuinely required.
        const messageSeq = ch.nextSeq++
        const messageId = `${Date.now()}${String(messageSeq).padStart(6, '0')}`
        ch.messages.push({
          messageId,
          messageSeq,
          clientMsgNo: params.clientMsgNo,
          fromUid: params.fromUid,
          payloadBase64: params.payloadBase64,
          timestamp: Math.floor(Date.now() / 1000),
        })
        // Allow tests to simulate crash/timeout AFTER IM persisted the message, before HIS settles it.
        await activeFaultHook?.('send', { channelId: params.channelId, clientMsgNo: params.clientMsgNo, uid: params.fromUid })
        return { messageId, messageSeq }
      },
      async syncChannelMessages({ channelId, limit = 50 }) {
        await activeFaultHook?.('sync', { channelId })
        const ch = fakeChannels.get(channelId)
        if (!ch) return []
        return ch.messages.slice(-limit)
      },
    }
  }

  const headers = () => ({
    'content-type': 'application/json',
    ...(managerToken ? { token: managerToken } : {}),
  })

  async function postRaw(path: string, body: unknown): Promise<string> {
    const res = await fetch(`${httpUrl}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`WuKongIM ${path} failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return text
  }

  return {
    mode: 'live',
    wsUrl,
    async registerUserToken(uid, token) {
      await postRaw('/user/token', { uid, token, device_flag: 1, device_level: 1 })
    },
    async kickUserDevice(uid) {
      await postRaw('/user/device_quit', { uid, device_flag: 1 })
    },
    async ensureChannel(channelId, channelType, subscribers) {
      await postRaw('/channel', { channel_id: channelId, channel_type: channelType, subscribers })
    },
    async addSubscribers(channelId, channelType, subscribers) {
      await postRaw('/channel/subscriber_add', { channel_id: channelId, channel_type: channelType, subscribers })
    },
    async removeSubscribers(channelId, channelType, subscribers) {
      await postRaw('/channel/subscriber_remove', { channel_id: channelId, channel_type: channelType, subscribers })
    },
    async sendMessage(params) {
      const raw = await postRaw('/message/send', {
        header: { no_persist: 0, red_dot: 1, sync_once: 0 },
        from_uid: params.fromUid,
        channel_id: params.channelId,
        channel_type: params.channelType,
        client_msg_no: params.clientMsgNo,
        payload: params.payloadBase64,
      })
      const safeParsed = JSON.parse(preserveRawInt64MessageIds(raw)) as {
        message_seq?: number
        message_id?: string | number
        data?: { message_seq?: number; message_id?: string | number }
      }
      const messageId =
        extractRawInt64Field(raw, 'message_id') ??
        String(safeParsed.data?.message_id ?? safeParsed.message_id ?? crypto.randomUUID())
      let messageSeq =
        typeof safeParsed.data?.message_seq === 'number'
          ? safeParsed.data.message_seq
          : typeof safeParsed.message_seq === 'number'
            ? safeParsed.message_seq
            : 0
      // WuKongIM v2.2.5 omits message_seq on /message/send and commits to /channel/messagesync asynchronously (~15-30ms).
      if (messageSeq <= 0) {
        const retryDelaysMs = [0, 25, 50, 100, 150, 250]
        for (const delayMs of retryDelaysMs) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
          const synced = await this.syncChannelMessages({
            channelId: params.channelId,
            channelType: params.channelType,
            loginUid: params.fromUid,
            limit: 20,
          })
          const matched =
            synced.find((m) => m.clientMsgNo === params.clientMsgNo) ??
            synced.find((m) => m.messageId === messageId)
          if (matched && matched.messageSeq > 0) {
            messageSeq = matched.messageSeq
            break
          }
        }
      }
      if (messageSeq <= 0) {
        throw new Error('WuKongIM did not return a valid positive message_seq after send')
      }
      return { messageId, messageSeq }
    },
    async syncChannelMessages({ channelId, channelType, loginUid, limit = 50 }) {
      const raw = await postRaw('/channel/messagesync', {
        login_uid: loginUid,
        channel_id: channelId,
        channel_type: channelType,
        start_message_seq: 0,
        end_message_seq: 0,
        limit,
        pull_mode: 0,
      })
      const parsed = JSON.parse(preserveRawInt64MessageIds(raw)) as {
        messages?: Array<{
          message_id?: string | number
          message_idstr?: string
          message_id_str?: string
          message_seq?: number
          client_msg_no?: string
          from_uid?: string
          payload?: string
          timestamp?: number
        }>
      }
      return (parsed.messages ?? []).map((m) => ({
        messageId: m.message_id_str ?? m.message_idstr ?? String(m.message_id ?? ''),
        messageSeq: m.message_seq ?? 0,
        clientMsgNo: m.client_msg_no ?? '',
        fromUid: m.from_uid ?? '',
        payloadBase64: m.payload ?? '',
        timestamp: m.timestamp ?? 0,
      }))
    },
  }
}
