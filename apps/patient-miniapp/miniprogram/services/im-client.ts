import type { ImCredentialsResponse } from '../../../../src/shared/communication'
import { hisApi } from './his-api'

type PushListener = () => void

// Thin WuKongIM live subscription wrapper for WeChat MiniProgram.
// Persistent sends and read cursors stay authoritative in HIS (ADR-0004); this socket drives instant refresh.
export class MiniProgramImClient {
  private credentials: ImCredentialsResponse | null = null
  private listeners = new Set<PushListener>()
  private pollTimer: number | null = null

  async connect(): Promise<void> {
    this.credentials = await hisApi.getImCredentials()
    // Keep foreground push notification responsive both in fake/dev mode and alongside live WuKongIM WS.
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      for (const listener of this.listeners) listener()
    }, 3500) as unknown as number
  }

  onIncoming(listener: PushListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getCredentials(): ImCredentialsResponse | null {
    return this.credentials
  }

  disconnect(): void {
    this.stopPolling()
    this.credentials = null
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}

export const imClient = new MiniProgramImClient()
