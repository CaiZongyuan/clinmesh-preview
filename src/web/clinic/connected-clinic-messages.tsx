import { Button } from '@ui-sdk/react/button'
import { useEffect, useState } from 'react'
import type { ContactView, Principal } from '../../shared/auth'
import type { ChatMessage, ConversationView, MessagePart } from '../../shared/communication'
import {
  createConversation,
  fetchAttachmentAccess,
  fetchConversationMessages,
  inviteConversationMember,
  markConversationRead,
  removeConversationMember,
  sendConversationMessage,
  uploadLocalAttachment,
} from './clinic-api'

interface Props {
  principal: Principal
  conversations: ConversationView[]
  contacts: ContactView[]
  onRefresh: () => Promise<void>
  onRunTriggered: (runId: string) => void
}

export function ConnectedClinicMessages({ principal, conversations, contacts, onRefresh, onRunTriggered }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(conversations[0]?.conversationId ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [mentionAgent, setMentionAgent] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [inviteActorId, setInviteActorId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({})

  const activeConversation = conversations.find((c) => c.conversationId === selectedId) ?? conversations[0] ?? null
  const activeId = activeConversation?.conversationId ?? null

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    void (async () => {
      try {
        const page = await fetchConversationMessages(activeId)
        if (cancelled) return
        setMessages(page.messages)
        setNextCursor(page.nextCursor)
        const maxSeq = page.messages.at(-1)?.sequence ?? 0
        if (maxSeq > 0) await markConversationRead(activeId, maxSeq).catch(() => {})
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载消息失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  async function loadOlder() {
    if (!activeId || !nextCursor) return
    const page = await fetchConversationMessages(activeId, nextCursor)
    setMessages((prev) => [...page.messages, ...prev])
    setNextCursor(page.nextCursor)
  }

  async function handleSend() {
    if (!activeConversation || !draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      const mentions = mentionAgent ? ['actor_agent_followup'] : []
      const res = await sendConversationMessage(activeConversation.conversationId, {
        clientMessageId: `web-${crypto.randomUUID()}`,
        parts: [{ type: 'text', text: draft.trim() }],
        mentions,
      })
      setDraft('')
      setMentionAgent(false)
      if (res.message) setMessages((prev) => [...prev.filter((m) => m.messageId !== res.message!.messageId), res.message!])
      for (const run of res.triggeredAgentRuns) onRunTriggered(run.runId)
      const latest = await fetchConversationMessages(activeConversation.conversationId)
      setMessages(latest.messages)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleUploadFile(kind: 'image' | 'audio', file: File) {
    if (!activeConversation) return
    setBusy(true)
    setError(null)
    try {
      const att = await uploadLocalAttachment(
        {
          conversationId: activeConversation.conversationId,
          kind,
          mime: file.type || (kind === 'audio' ? 'audio/webm' : 'image/png'),
          size: file.size,
          ...(kind === 'audio' ? { durationMs: 3000 } : {}),
        },
        file,
      )
      const part: MessagePart =
        kind === 'audio'
          ? { type: 'audio', attachmentId: att.attachmentId, durationMs: att.durationMs ?? 3000 }
          : { type: 'image', attachmentId: att.attachmentId }
      await sendConversationMessage(activeConversation.conversationId, {
        clientMessageId: `web-att-${crypto.randomUUID()}`,
        parts: [part],
      })
      const latest = await fetchConversationMessages(activeConversation.conversationId)
      setMessages(latest.messages)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '附件发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateDeptGroup() {
    if (!groupTitle.trim()) return
    setBusy(true)
    setError(null)
    try {
      const staffPeers = contacts.filter((c) => c.staffId !== null).map((c) => c.actorId)
      const conv = await createConversation({
        type: 'staff_group',
        title: groupTitle.trim(),
        memberActorIds: staffPeers,
      })
      setGroupTitle('')
      setSelectedId(conv.conversationId)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '建群失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleInvite() {
    if (!activeConversation || !inviteActorId) return
    setBusy(true)
    setError(null)
    try {
      await inviteConversationMember(activeConversation.conversationId, inviteActorId)
      setInviteActorId('')
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '邀请成员失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(actorId: string) {
    if (!activeConversation) return
    setBusy(true)
    setError(null)
    try {
      await removeConversationMember(activeConversation.conversationId, actorId)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除成员失败')
    } finally {
      setBusy(false)
    }
  }

  async function loadAttachmentUrl(attachmentId: string) {
    try {
      const access = await fetchAttachmentAccess(attachmentId)
      setAudioUrls((prev) => ({ ...prev, [attachmentId]: access.url }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取附件授权失败')
    }
  }

  const canManageGroup =
    activeConversation &&
    activeConversation.status === 'active' &&
    (activeConversation.type === 'staff_group' || activeConversation.type === 'followup_group')

  const hasFollowupAgent = activeConversation?.members.some(
    (m) => m.actorId === 'actor_agent_followup' && m.status === 'active',
  )

  return (
    <div className="cc-split">
      <div className="cc-card">
        <h3 className="cc-card-title">会话列表</h3>
        <div className="cc-row" style={{ marginBottom: 10 }}>
          <input
            aria-label="新科室群名称"
            className="cc-input"
            placeholder="新建科室群名称"
            value={groupTitle}
            onChange={(e) => setGroupTitle(e.target.value)}
            style={{ flex: 1 }}
          />
          <Button className="cc-btn" disabled={busy || !groupTitle.trim()} onClick={() => void handleCreateDeptGroup()}>
            建群
          </Button>
        </div>
        <div className="cc-list">
          {conversations.map((conv) => (
            <button
              key={conv.conversationId}
              type="button"
              className="cc-list-item"
              data-selected={conv.conversationId === activeId}
              onClick={() => setSelectedId(conv.conversationId)}
            >
              <div className="cc-row" style={{ justifyContent: 'space-between' }}>
                <strong>{conv.title}</strong>
                {conv.unreadCount > 0 ? <span className="cc-badge cc-badge-info">{conv.unreadCount}</span> : null}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>
                {conv.status === 'read_only' ? '只读 · ' : ''}
                {conv.lastMessagePreview ?? '暂无消息'}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error ? <div className="cc-error">{error}</div> : null}
        {activeConversation ? (
          <>
            <div className="cc-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3 className="cc-card-title" style={{ marginBottom: 4 }}>
                  {activeConversation.title}
                </h3>
                <div className="cc-row">
                  <span className="cc-badge">{activeConversation.type}</span>
                  <span className="cc-badge">{activeConversation.status}</span>
                  {activeConversation.members
                    .filter((m) => m.status === 'active')
                    .map((m) => (
                      <span key={m.actorId} className="cc-badge cc-badge-info">
                        {m.displayName}
                        {canManageGroup && m.actorId !== principal.actorId ? (
                          <button
                            type="button"
                            aria-label={`移除 ${m.displayName}`}
                            onClick={() => void handleRemove(m.actorId)}
                            style={{ marginLeft: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    ))}
                </div>
              </div>
              {canManageGroup ? (
                <div className="cc-row">
                  <select
                    aria-label="选择邀请成员"
                    className="cc-select"
                    value={inviteActorId}
                    onChange={(e) => setInviteActorId(e.target.value)}
                  >
                    <option value="">邀请成员/Agent...</option>
                    {contacts
                      .filter((c) => !activeConversation.members.some((m) => m.actorId === c.actorId && m.status === 'active'))
                      .map((c) => (
                        <option key={c.actorId} value={c.actorId}>
                          {c.displayName} ({c.role})
                        </option>
                      ))}
                  </select>
                  <Button className="cc-btn" disabled={busy || !inviteActorId} onClick={() => void handleInvite()}>
                    邀请
                  </Button>
                </div>
              ) : null}
            </div>

            {nextCursor ? (
              <Button className="cc-btn" onClick={() => void loadOlder()}>
                加载更早历史
              </Button>
            ) : null}

            <div className="cc-messages">
              {messages.length === 0 ? (
                <div style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>暂无消息记录</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.messageId} className="cc-msg" data-mine={msg.senderActorId === principal.actorId}>
                    <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}>
                      {msg.senderName} · #{msg.sequence} · {msg.senderKind}
                    </div>
                    {msg.parts.map((part, idx) => (
                      <div key={`${msg.messageId}-${idx}`} style={{ marginTop: idx > 0 ? 6 : 0 }}>
                        {part.type === 'text' ? <div>{part.text}</div> : null}
                        {part.type === 'audio' ? (
                          <div className="cc-row">
                            <span>语音 ({Math.max(1, Math.round(part.durationMs / 1000))}s)</span>
                            {audioUrls[part.attachmentId] ? (
                              <audio controls src={audioUrls[part.attachmentId]} />
                            ) : (
                              <Button className="cc-btn" onClick={() => void loadAttachmentUrl(part.attachmentId)}>
                                授权播放
                              </Button>
                            )}
                          </div>
                        ) : null}
                        {part.type === 'image' ? (
                          <div>
                            {audioUrls[part.attachmentId] ? (
                              <img src={audioUrls[part.attachmentId]} alt="会话图片" style={{ maxWidth: 220, borderRadius: 6 }} />
                            ) : (
                              <Button className="cc-btn" onClick={() => void loadAttachmentUrl(part.attachmentId)}>
                                查看图片附件
                              </Button>
                            )}
                          </div>
                        ) : null}
                        {part.type === 'card' ? (
                          <div className="cc-card" style={{ padding: 10 }}>
                            <div className="cc-badge cc-badge-info">{part.component}</div>
                            <div style={{ fontWeight: 600, marginTop: 4 }}>{String(part.safeProps.title ?? part.resourceRef.id)}</div>
                            {part.safeProps.summary ? (
                              <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>
                                {String(part.safeProps.summary)}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>

            {activeConversation.status === 'active' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="cc-row">
                  <input
                    aria-label="消息输入框"
                    className="cc-input"
                    placeholder="输入消息内容..."
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void handleSend()
                      }
                    }}
                    style={{ flex: 1 }}
                  />
                  {hasFollowupAgent ? (
                    <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={mentionAgent} onChange={(e) => setMentionAgent(e.target.checked)} />
                      @随访助手
                    </label>
                  ) : null}
                  <Button className="cc-btn cc-btn-primary" disabled={busy || !draft.trim()} onClick={() => void handleSend()}>
                    发送
                  </Button>
                </div>
                <div className="cc-row" style={{ fontSize: 12 }}>
                  <label className="cc-btn">
                    发图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleUploadFile('image', file)
                      }}
                    />
                  </label>
                  <label className="cc-btn">
                    发语音文件
                    <input
                      type="file"
                      accept="audio/*"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleUploadFile('audio', file)
                      }}
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>当前会话为只读状态，仅可查阅历史消息。</div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--muted-foreground)' }}>请选择左侧会话</div>
        )}
      </div>
    </div>
  )
}
