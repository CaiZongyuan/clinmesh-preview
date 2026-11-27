import { Button } from '@ui-sdk/react/button'
import { useEffect, useRef, useState } from 'react'
import type { ContactView, Principal } from '../../shared/auth'
import type { ChatMessage, ConversationView, MessagePart } from '../../shared/communication'
import {
  createConversation,
  fetchAttachmentAccess,
  fetchConversationMessages,
  fetchImCredentials,
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

function partKey(messageId: string, part: MessagePart): string {
  if (part.type === 'audio' || part.type === 'image') return `${messageId}:${part.type}:${part.attachmentId}`
  if (part.type === 'card') return `${messageId}:card:${part.component}:${part.resourceRef.id}`
  return `${messageId}:text:${part.text.slice(0, 32)}:${part.text.length}`
}

export function ConnectedClinicMessages({ principal, conversations, contacts, onRefresh, onRunTriggered }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(conversations[0]?.conversationId ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [mentionAgent, setMentionAgent] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [inviteActorId, setInviteActorId] = useState('')
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordStartRef = useRef<number>(0)

  const activeConversation = conversations.find((c) => c.conversationId === selectedId) ?? conversations[0] ?? null
  const activeId = activeConversation?.conversationId ?? null

  async function syncMessages(conversationId: string, markRead: boolean) {
    try {
      const page = await fetchConversationMessages(conversationId)
      setMessages(page.messages)
      setNextCursor(page.nextCursor)
      if (markRead) {
        const maxSeq = page.messages.at(-1)?.sequence ?? 0
        if (maxSeq > 0) await markConversationRead(conversationId, maxSeq).catch(() => {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载消息失败')
    }
  }

  // External timer sync for live incoming messages alongside WuKongIM credential bootstrap.
  useEffect(() => {
    if (!activeId) return
    let active = true
    void fetchImCredentials().catch(() => {})
    void (async () => {
      const page = await fetchConversationMessages(activeId).catch(() => null)
      if (!active || !page) return
      setMessages(page.messages)
      setNextCursor(page.nextCursor)
    })()
    const timer = window.setInterval(() => {
      void (async () => {
        const page = await fetchConversationMessages(activeId).catch(() => null)
        if (!active || !page) return
        setMessages(page.messages)
        setNextCursor(page.nextCursor)
      })()
    }, 4000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [activeId])

  function handleSelectConversation(conversationId: string) {
    setSelectedId(conversationId)
    setError(null)
    void syncMessages(conversationId, true)
  }

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
      await syncMessages(activeConversation.conversationId, true)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleUploadFile(kind: 'image' | 'audio', file: Blob, mime: string, durationMs?: number) {
    if (!activeConversation) return
    setBusy(true)
    setError(null)
    try {
      const att = await uploadLocalAttachment(
        {
          conversationId: activeConversation.conversationId,
          kind,
          mime: mime || (kind === 'audio' ? 'audio/webm' : 'image/png'),
          size: file.size,
          ...(kind === 'audio' ? { durationMs: Math.max(1000, Math.min(60_000, durationMs ?? 3000)) } : {}),
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
      await syncMessages(activeConversation.conversationId, true)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '附件发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleRecording() {
    if (recording && recorderRef.current) {
      recorderRef.current.stop()
      setRecording(false)
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('当前浏览器不支持麦克风录音，请使用音频文件上传。')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recordStartRef.current = Date.now()
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop()
        const durationMs = Math.max(1000, Date.now() - recordStartRef.current)
        const mime = recorder.mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type: mime })
        if (blob.size > 0) void handleUploadFile('audio', blob, mime, durationMs)
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法开启麦克风录音')
    }
  }

  async function handleShareReportCard() {
    if (!activeConversation || !activeConversation.patientId) return
    setBusy(true)
    setError(null)
    try {
      const reportId = activeConversation.patientId === 'pat_01' ? 'rel_rep_pat01_v1' : 'rel_rep_pat02_v1'
      await sendConversationMessage(activeConversation.conversationId, {
        clientMessageId: `web-card-${crypto.randomUUID()}`,
        parts: [
          {
            type: 'card',
            component: 'ReportCard',
            version: 1,
            resourceRef: { kind: 'report', id: reportId },
            safeProps: {
              title: '检查检验报告引用卡片',
              summary: '点击后将由服务端重新核验发布权限与患者归属。',
            },
            actions: [{ name: 'report.open', args: { reportId } }],
          },
        ],
      })
      await syncMessages(activeConversation.conversationId, true)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '分享报告卡片失败')
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
      setAttachmentUrls((prev) => ({ ...prev, [attachmentId]: access.url }))
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
              onClick={() => handleSelectConversation(conv.conversationId)}
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
                    {msg.parts.map((part) => (
                      <div key={partKey(msg.messageId, part)} className="cc-msg-part">
                        {part.type === 'text' ? <div>{part.text}</div> : null}
                        {part.type === 'audio' ? (
                          <div className="cc-row">
                            <span>语音 ({Math.max(1, Math.round(part.durationMs / 1000))}s)</span>
                            {attachmentUrls[part.attachmentId] ? (
                              <audio controls src={attachmentUrls[part.attachmentId]} />
                            ) : (
                              <Button className="cc-btn" onClick={() => void loadAttachmentUrl(part.attachmentId)}>
                                授权播放
                              </Button>
                            )}
                          </div>
                        ) : null}
                        {part.type === 'image' ? (
                          <div>
                            {attachmentUrls[part.attachmentId] ? (
                              <img src={attachmentUrls[part.attachmentId]} alt="会话图片" style={{ maxWidth: 220, borderRadius: 6 }} />
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
                  <Button className="cc-btn" disabled={busy} onClick={() => void handleToggleRecording()}>
                    {recording ? '停止并发送录音' : '麦克风录音'}
                  </Button>
                  <label className="cc-btn">
                    发图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleUploadFile('image', file, file.type)
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
                        if (file) void handleUploadFile('audio', file, file.type)
                      }}
                    />
                  </label>
                  {activeConversation.patientId ? (
                    <Button className="cc-btn" disabled={busy} onClick={() => void handleShareReportCard()}>
                      分享报告引用卡片
                    </Button>
                  ) : null}
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
