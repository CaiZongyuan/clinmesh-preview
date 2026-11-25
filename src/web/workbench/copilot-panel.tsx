import { NoteSuggestions } from './clinical-note/note-suggestions'
import { Button } from '@ui-sdk/react/button'
import { Switch, SwitchThumb } from '@ui-sdk/react/switch'
import { Dialog, DialogContent, DialogTitle } from '@ui-sdk/react/dialog'
import { Select, SelectContent, SelectItem, SelectList, SelectTrigger, SelectValue } from '@ui-sdk/react/select'
import {
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuEmpty,
  TriggerMenuItem,
  TriggerMenuInput,
  TriggerMenuList,
} from '@ui-sdk/react/trigger-menu'
import type { TriggerMenuContentState, TriggerMenuData, TriggerMenuDataItem } from '@ui-sdk/react/trigger-menu'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CopyIcon,
  ListPlusIcon,
  PencilIcon,
  RefreshCwIcon,
  FoldVerticalIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  WrenchIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CONTEXT_COMMAND, COPILOT_COMMANDS, MENTION_KIND_LABEL, MAX_PROMPT_LENGTH } from '../../shared/copilot-turn'
import { NOTE_SECTION_NAME, type NoteSection } from '../../shared/clinical-note'
import type { EncounterView } from '../../shared/encounter'
import type {
  CopilotMention,
  CopilotModelSetting,
  CopilotPromptMode,
  CopilotStep,
  CopilotTurn,
} from '../../shared/copilot-turn'
import { BODY_SYSTEM_NAME } from '../../shared/physical-examination'
import { fetchClinicalNote, fetchInvestigations } from '../api'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import type { CopilotSession } from '../copilot/use-copilot'
import { formatClockSeconds } from './format'
import { markdown } from './copilot-markdown'
import { CopilotContextDialog } from './copilot-context-view'
import { badge, iconButton, pane, paneHeader } from './pane-styles'

const EFFORT_LABEL: Record<CopilotModelSetting['effort'], string> = { off: '关', low: '低', medium: '中', high: '高' }
const FAILURE_TEXT: Record<NonNullable<CopilotTurn['failure']>, string> = {
  timeout: '本轮超时，已停止。',
  stalled: '模型长时间没有输出，本轮已中止。',
  'llm-not-configured': '未配置大模型接口（LLM_API_KEY），临床助手无法回答。',
  'llm-error': '模型调用出错，本轮失败。',
  'too-many-steps': '本轮步骤过多，已中止。',
  'crashed-repeatedly': '运行反复崩溃，本轮失败。',
}
const STOP_TEXT: Record<NonNullable<CopilotTurn['stopReason']>, string> = {
  'stop-requested': '已按医生要求停止，已完成的部分保留。',
  superseded: '已被修改后的提问取代。',
  'encounter-ended': '就诊已结束，本轮停止。',
}

const TOOL_STATE_TEXT: Record<string, string> = {
  running: '读取中…',
  ok: '',
  error: '读取失败',
  cancelled: '未执行',
  denied: '已拦截',
  approval: '待确认',
}

const seconds = (dur: number) => `${dur.toFixed(1)}s`

function ToolStep({ step, label }: { step: Extract<CopilotStep, { kind: 'tool' }>; label: string }) {
  const status = TOOL_STATE_TEXT[step.state]
  return (
    <li className="flex items-center gap-1.5 text-xs text-muted-foreground" data-tool-state={step.state}>
      <WrenchIcon aria-hidden="true" size={13} />
      <span>{step.subject}</span>
      {status && <span className="text-info">{status}</span>}
      <details className="min-w-0">
        <summary aria-label={`详情 · ${label} · ${step.subject}`} className="cursor-pointer list-none underline decoration-dotted">详情</summary>
        <pre className="copilot-args overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
          {JSON.stringify(step.args)}
          {'\n────\n'}
          {step.result}
        </pre>
      </details>
      {step.dur > 0 && <span>{seconds(step.dur)}</span>}
    </li>
  )
}

function TurnSteps({ turn, label }: { turn: CopilotTurn; label: string }) {
  const [open, setOpen] = useState(false)
  const steps = turn.steps
  if (steps.length === 0) return null
  const Icon = open ? ChevronDownIcon : ChevronRightIcon
  return (
    <div className="copilot-steps">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground"
        aria-expanded={open}
        aria-label={`思考与读取（${steps.length}） · ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon aria-hidden="true" size={13} />
        思考与读取（{steps.length}）
      </button>
      {open && (
        <ol className="m-0 flex list-none flex-col gap-1 pl-4">
          {steps.map((step, i) =>
            step.kind === 'think' ? (
              <li key={i} className="text-xs whitespace-pre-wrap text-muted-foreground" data-step-state={step.state}>
                {step.text || '思考中…'}
                {step.dur !== undefined && <span> · {seconds(step.dur)}</span>}
              </li>
            ) : (
              <ToolStep key={step.callId} step={step} label={`${label}步骤 ${i + 1}`} />
            ),
          )}
        </ol>
      )}
    </div>
  )
}

function TurnActions({ turn, label, copilot, onEdit }: { turn: CopilotTurn; label: string; copilot: CopilotSession; onEdit: (text: string) => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.reply)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="flex items-center gap-0.5 text-muted-foreground">
      <Button aria-label={`复制回答 · ${label}`} title="复制回答" className={iconButton} onClick={() => void copy()}>
        <CopyIcon aria-hidden="true" size={14} />
      </Button>
      {copied && <span className="text-[11px]">已复制</span>}
      {turn.status === 'done' && (
        <>
          <Button aria-label={`重新生成 · ${label}`} title="重新生成" className={iconButton} onClick={() => void copilot.resend(turn.turnId, turn.trigger.text, turn.trigger.mentions)}>
            <RefreshCwIcon aria-hidden="true" size={14} />
          </Button>
          <Button aria-label={`编辑并重发 · ${label}`} title="编辑并重发" className={iconButton} onClick={() => onEdit(turn.trigger.text)}>
            <PencilIcon aria-hidden="true" size={14} />
          </Button>
          <Button
            aria-label={`有帮助 · ${label}`}
            aria-pressed={turn.feedback === 'up'}
            className={iconButton}
            onClick={() => void copilot.setFeedback(turn.turnId, turn.feedback === 'up' ? null : 'up')}
          >
            <ThumbsUpIcon aria-hidden="true" size={14} />
          </Button>
          <Button
            aria-label={`没有帮助 · ${label}`}
            aria-pressed={turn.feedback === 'down'}
            className={iconButton}
            onClick={() => void copilot.setFeedback(turn.turnId, turn.feedback === 'down' ? null : 'down')}
          >
            <ThumbsDownIcon aria-hidden="true" size={14} />
          </Button>
        </>
      )}
    </div>
  )
}

function CopilotTurnView({ turn, index, copilot, onEdit }: { turn: CopilotTurn; index: number; copilot: CopilotSession; onEdit: (text: string) => void }) {
  const live = turn.status === 'running'
  const label = `第 ${index + 1} 轮`
  return (
    <li className="flex flex-col gap-1.5 border-b pb-3" data-turn-status={turn.status} data-turn-superseded={turn.superseded || undefined}>
      <p className="m-0 text-xs text-muted-foreground">
        {turn.trigger.kind === 'doctor' ? '医生' : '自动'} · {formatClockSeconds(turn.startedAt)}
        {turn.superseded && ' · 已被取代'}
      </p>
      <p className="m-0 text-[13px] font-medium">{turn.trigger.text}</p>
      {turn.trigger.mentions.length > 0 && (
        <p className="m-0 flex flex-wrap gap-1">
          {turn.trigger.mentions.map((mention) => (
            <span key={mention.id} className={badge}>
              {MENTION_KIND_LABEL[mention.kind]} · {mention.label}
            </span>
          ))}
        </p>
      )}
      <TurnSteps turn={turn} label={label} />
      <NoteSuggestions runId={turn.turnId} />
      {turn.steers.length > 0 && (
        <p className="m-0 text-xs text-muted-foreground">
          {turn.steers.map((steer) => `${steer.text}${steer.read ? '（已读）' : '（转为新一轮）'}`).join('、')}
        </p>
      )}
      {(turn.reply || live) && (
        <div className="copilot-reply text-[13px]" aria-busy={live}>
          {markdown(turn.reply || '…')}
        </div>
      )}
      {turn.failure && <p className="m-0 text-xs text-destructive">{FAILURE_TEXT[turn.failure]}</p>}
      {!turn.failure && turn.stopReason && (
        <p className="m-0 text-xs text-muted-foreground">{STOP_TEXT[turn.stopReason]}{turn.keptDrafts !== undefined && `已保留 ${turn.keptDrafts} 项草稿。`}</p>
      )}
      {!live && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {turn.usage ? `用量 输入 ${turn.usage.in} · 输出 ${turn.usage.out}` : ''}
          </span>
          <TurnActions turn={turn} label={label} copilot={copilot} onEdit={onEdit} />
        </div>
      )}
    </li>
  )
}

function ModelChip({ model, onChange }: { model: CopilotModelSetting; onChange: (m: string, e: CopilotModelSetting['effort']) => void }) {
  return (
    <span className="flex items-center gap-1">
      <Select
        aria-label="助手模型"
        value={model.model}
        onValueChange={(value) => value && onChange(value, model.effort)}
      >
        <SelectTrigger aria-label="选择助手模型" className="h-7 gap-1 px-2 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {model.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectList>
        </SelectContent>
      </Select>
      <Select
        aria-label="思考力度"
        value={model.effort}
        onValueChange={(value) => value && onChange(model.model, value as CopilotModelSetting['effort'])}
      >
        <SelectTrigger aria-label="选择思考力度" className="h-7 gap-1 px-2 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {(['off', 'low', 'medium', 'high'] as const).map((effort) => (
              <SelectItem key={effort} value={effort}>
                {EFFORT_LABEL[effort]}
              </SelectItem>
            ))}
          </SelectList>
        </SelectContent>
      </Select>
    </span>
  )
}

interface ComposerProps {
  copilot: CopilotSession
  encounterId: string
  examinations: PhysicalExaminationView[]
  draft: string
  onDraftChange: (text: string) => void
  mentions: CopilotMention[]
  onMentionsChange: (mentions: CopilotMention[]) => void
  editing: string | null
  onCancelEdit: () => void
}

// The mentions a `@` menu may insert: every released Report version and every completed examination.
type MentionItem = TriggerMenuDataItem<string> & { value: string; label: string }

function mentionCandidates(encounterId: string, examinations: PhysicalExaminationView[]) {
  const item = (value: string, label: string): MentionItem => ({ value, label })
  const queryItems = (items: MentionItem[], query: string) =>
    items.filter((candidate) => candidate.label.toLowerCase().includes(query.toLowerCase()))
  const reports = async (query: string): Promise<TriggerMenuData<string>> => {
    const investigations = await fetchInvestigations(encounterId)
    return [
      {
        value: 'reports',
        label: '已发布报告',
        items: queryItems(
          investigations.flatMap((investigation) =>
            investigation.reports.map((report) => item(`report:${report.reportId}`, `${investigation.name} 第${report.version}版`)),
          ),
          query,
        ),
      },
    ]
  }
  const exams: { value: string; label: string; items: MentionItem[] } = {
    value: 'examinations',
    label: '查体',
    items: examinations.map((examination) => item(`examination:${examination.system}`, BODY_SYSTEM_NAME[examination.system])),
  }
  // What the doctor can see of the Clinical Note: signed sections from the latest revision, and the draft
  // sections as they are on screen. Doctor-authored content only — nothing beyond the note's visible state.
  const noteSections = async (query: string): Promise<TriggerMenuData<string>> => {
    const note = await fetchClinicalNote(encounterId)
    const signed = note.revisions.at(-1)?.sections
    const signedItems = signed
      ? (Object.entries(signed) as [NoteSection, string][])
          .filter(([, content]) => content.trim() !== '')
          .map(([section]) => item(`note-section:${section}`, NOTE_SECTION_NAME[section]))
      : []
    const draftItems = note.draft
      .filter((draft) => draft.content.trim() !== '')
      .map((draft) => item(`draft:${draft.section}`, `${NOTE_SECTION_NAME[draft.section]}（草稿）`))
    return [
      { value: 'note-sections', label: '病历（已签署）', items: queryItems(signedItems, query) },
      { value: 'drafts', label: '病历草稿', items: queryItems(draftItems, query) },
    ]
  }
  return { reports, exams, noteSections }
}

function CompactionMarkers({ compactions }: { compactions: CopilotSession['compactions'] }) {
  if (compactions.length === 0) return null
  return (
    <ol className="m-0 mb-2 flex list-none flex-col gap-0.5 p-0" aria-label="压缩记录">
      {compactions.map((marker) => (
        <li key={marker.markerId} className="flex items-center gap-1 text-[11px] text-muted-foreground" title={marker.summary}>
          <FoldVerticalIcon aria-hidden="true" size={12} />
          {formatClockSeconds(marker.at)} 已压缩 {marker.summarizedMessages} 条（{marker.tokensBefore} → {marker.tokensAfter} tokens）
        </li>
      ))}
    </ol>
  )
}

function CopilotComposer({ copilot, encounterId, examinations, draft, onDraftChange, mentions, onMentionsChange, editing, onCancelEdit }: ComposerProps) {
  const [mode, setMode] = useState<CopilotPromptMode>('queue')
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  const submit = async () => {
    const text = draft.trim()
    if (!text || text.length > MAX_PROMPT_LENGTH) return
    if (text === CONTEXT_COMMAND) {
      // A typed slash command opens the same read-only view the menu action does; what the doctor typed stays.
      setContextOpen(true)
      return
    }
    const used = mentions.filter((mention) => text.includes(`@${mention.label}`))
    const sent = editing ? await copilot.resend(editing, text, used) : await copilot.prompt(text, used, mode)
    if (sent) {
      // A steer applies to one turn only; the next prompt queues again unless the doctor opts back in.
      if (mode === 'steer') setMode('queue')
      onDraftChange('')
      onMentionsChange([])
      onCancelEdit()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && (editing || menuOpen)) {
      event.stopPropagation()
      if (editing && !menuOpen) onCancelEdit()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !menuOpen) {
      event.preventDefault()
      void submit()
    }
  }

  const known = useRef(mentionCandidates(encounterId, examinations))
  known.current = mentionCandidates(encounterId, examinations)
  const mentionOf = (value: string): CopilotMention | null => {
    const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
    if (kind === 'report') {
      for (const investigation of lastInvestigations.current) {
        const report = investigation.reports.find((r) => r.reportId === id)
        if (report) return { kind: 'report', id, label: `${investigation.name} 第${report.version}版` }
      }
    }
    if (kind === 'examination') return { kind: 'examination', id, label: BODY_SYSTEM_NAME[id as keyof typeof BODY_SYSTEM_NAME] ?? id }
    return null
  }
  const lastInvestigations = useRef<Awaited<ReturnType<typeof fetchInvestigations>>>([])

  const triggers = useMemo(
    () => [
      {
        char: '/',
        items: COPILOT_COMMANDS.map((command) => ({
          value: command.command,
          label: command.command,
          description: command.description,
          // /上下文 opens the local context view instead of composing text.
          after: command.prompt === null ? ('submit' as const) : ('compose' as const),
        })),
        insert: (item: { value: string }) => `${item.value} `,
      },
      {
        char: '@',
        type: 'mention',
        spaces: true,
        items: async (query: string): Promise<TriggerMenuData<string>> => {
          const groups = await known.current.reports(query)
          lastInvestigations.current = await fetchInvestigations(encounterId)
          const noteGroups = await known.current.noteSections(query)
          return [...groups, known.current.exams, ...noteGroups]
        },
        insert: (item: { value: string; label: string }) => `@${item.label} `,
      },
    ],
    [encounterId],
  )

  const onSelect = (value: string, details?: { preventDefault?: () => void }) => {
    if (value === CONTEXT_COMMAND) {
      // Open the read-only context view; the composer keeps whatever the doctor had typed.
      details?.preventDefault?.()
      setContextOpen(true)
      return
    }
    const mention = mentionOf(value)
    if (mention) onMentionsChange([...mentions.filter((m) => m.id !== mention.id), mention])
  }

  return (
    <div className="flex flex-col gap-1.5 border-t px-3 py-2">
      {editing && (
        <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
          正在编辑并重发上一轮
          <Button aria-label="取消编辑" className="h-5 text-[11px]" onClick={onCancelEdit}>
            取消
          </Button>
        </p>
      )}
      <TriggerMenu
        triggers={triggers}
        onOpenChange={setMenuOpen}
        onSelect={onSelect}
      >
        <TriggerMenuInput
          ref={input}
          aria-label="问临床助手"
          data-copilot-composer
          placeholder={copilot.busy ? '助手正在运行：发送可指引（steer）或排队' : '输入问题，/ 唤出命令，@ 引用报告与查体'}
          value={draft}
          maxLength={MAX_PROMPT_LENGTH}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-16 w-full resize-none rounded-md border bg-transparent p-2 text-[13px]"
        />
        <TriggerMenuContent className="copilot-menu">
          <TriggerMenuEmpty>没有匹配的命令或对象</TriggerMenuEmpty>
          <TriggerMenuList className="max-h-56 overflow-auto">
            {(state: TriggerMenuContentState) =>
              state.items.flatMap((raw) => {
                const item = raw as { value?: string; label?: string; description?: string }
                return typeof item.value === 'string'
                  ? [
                      <TriggerMenuItem key={item.value} value={item.value} label={item.label ?? item.value} className="copilot-menu-item">
                        <span>{item.label ?? item.value}</span>
                        {item.description && <span className="text-[11px] text-muted-foreground">{item.description}</span>}
                      </TriggerMenuItem>,
                    ]
                  : []
              })
            }
          </TriggerMenuList>
        </TriggerMenuContent>
      </TriggerMenu>
      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent className="copilot-menu max-w-lg overflow-auto p-4" aria-label="助手上下文（只读）">
          <DialogTitle className="m-0 text-sm font-semibold">助手上下文（只读）</DialogTitle>
          <CopilotContextDialog
            encounterId={encounterId}
            modelLabel={copilot.model ? `${copilot.model.model} · ${EFFORT_LABEL[copilot.model.effort]}` : null}
          />
        </DialogContent>
      </Dialog>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {copilot.busy ? (
            <>
              <Button aria-label="停止当前轮" className="h-7 gap-1 px-2" onClick={() => void copilot.stop()}>
                <CircleStopIcon aria-hidden="true" size={14} />
                停止 (Esc)
              </Button>
              <Button aria-label="发送为指引" aria-pressed={mode === 'steer'} className="h-7 px-2" onClick={() => setMode('steer')}>
                <ListPlusIcon aria-hidden="true" size={14} />
                指引当前轮
              </Button>
              <Button aria-label="回到排队" aria-pressed={mode === 'queue'} className="h-7 px-2" onClick={() => setMode('queue')}>
                排队
              </Button>
            </>
          ) : (
            <span>Enter 发送 · Shift+Enter 换行 · Ctrl+/ 聚焦</span>
          )}
        </div>
        <Button aria-label="发送给临床助手" className="h-7 px-3" disabled={!draft.trim()} onClick={() => void submit()}>
          发送
        </Button>
      </div>
    </div>
  )
}

export interface CopilotPanelProps {
  copilot: CopilotSession
  encounter: EncounterView | undefined
  examinations: PhysicalExaminationView[]
  onHide: () => void
}

export function CopilotPanel({ copilot, encounter, examinations, onHide }: CopilotPanelProps) {
  const [draft, setDraft] = useState('')
  const [mentions, setMentions] = useState<CopilotMention[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const model = copilot.model
  return (
    <aside aria-label="临床助手" className={pane} data-stream={copilot.stream}>
      <div className={paneHeader}>
        <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
          <SparklesIcon aria-hidden="true" size={15} className="text-info" />
          临床助手
          {copilot.busy && <span className="text-xs font-normal text-info">运行中</span>}
        </h2>
        <div className="flex items-center gap-1.5">
          {encounter?.status === 'active' && (
            <label className="flex shrink-0 items-center gap-1 text-xs">
              <span>自动分析</span>
              <Switch
                checked={copilot.autoAnalysis}
                disabled={!model}
                onCheckedChange={(enabled) => void copilot.setAutomaticAnalysis(enabled)}
                data-agent-confirm="更改自动分析设置"
              >
                <SwitchThumb />
              </Switch>
            </label>
          )}
          {model && <ModelChip model={model} onChange={(m, e) => void copilot.configure(m, e)} />}
          <Button aria-label="隐藏临床助手" title="隐藏临床助手" className={iconButton} onClick={onHide}>
            <ChevronRightIcon aria-hidden="true" size={16} />
          </Button>
        </div>
      </div>
      {copilot.stream === 'reconnecting' && (
        <p className="m-0 bg-warning/10 px-3.5 py-1 text-xs text-warning" role="status">
          连接中断，正在重连，恢复后从最新检查点继续。
        </p>
      )}
      {!encounter ? (
        <div className="min-h-0 flex-1">
          <p className="m-0 p-4 text-[13px] text-muted-foreground">
            接诊开始后，临床助手会随问诊、查体与报告自动分析，并把草稿写入病例工作区。
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto px-3.5 pt-3" role="log" aria-label="临床助手会话">
            {encounter.status === 'active' && <AmbientCountdown copilot={copilot} />}
            {encounter.status === 'active' && (!copilot.autoAnalysis || copilot.pendingAnalysis.length > 0) && (
              <section aria-label="待分析" className="mb-2 rounded-md border border-dashed border-border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span>{copilot.pendingAnalysis.length} 个事件待分析</span>
                  <Button
                    className="h-7 px-2 text-xs"
                    disabled={!copilot.pendingAnalysis.length}
                    onClick={() => void copilot.runPendingAnalysis()}
                    data-agent-confirm="运行待分析事件"
                  >
                    立即分析
                  </Button>
                </div>
                {copilot.pendingAnalysis.length > 0 && (
                  <ul className="m-0 pl-4 text-muted-foreground">
                    {copilot.pendingAnalysis.map((event) => <li key={event.ref}>{event.text}</li>)}
                  </ul>
                )}
              </section>
            )}
            <div className="grid gap-2 empty:hidden mb-2"><NoteSuggestions /></div>
            {copilot.queued.length > 0 && (
              <p className="m-0 mb-2 text-xs text-muted-foreground">
                排队中：{copilot.queued.map((item) => item.text).join('、')}
              </p>
            )}
            <CompactionMarkers compactions={copilot.compactions} />
            {copilot.turns.length === 0 ? (
              <p className="m-0 pb-3 text-[13px] text-muted-foreground">向临床助手提问，它会用只读工具查阅本次就诊的资料后回答。</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-3 pb-3">
                {copilot.turns.map((turn, index) => (
                  <CopilotTurnView key={turn.turnId} index={index} turn={turn} copilot={copilot} onEdit={(text) => { setDraft(text); setEditing(turn.turnId) }} />
                ))}
              </ol>
            )}
          </div>
          <CopilotComposer
            copilot={copilot}
            encounterId={encounter.encounterId}
            examinations={examinations}
            draft={draft}
            onDraftChange={setDraft}
            mentions={mentions}
            onMentionsChange={setMentions}
            editing={editing}
            onCancelEdit={() => setEditing(null)}
          />
        </>
      )}
    </aside>
  )
}

function AmbientCountdown({ copilot }: { copilot: CopilotSession }) {
  const countdown = copilot.countdown
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!countdown) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [countdown])
  if (!countdown) return null
  const remaining = Math.min(1.2, Math.max(0, (Date.parse(countdown.fireAt) - now) / 1000))
  return (
    <section aria-label="自动分析倒计时" className="mb-2 rounded-md border border-info/40 bg-info/5 p-2 text-xs">
      <div className="flex items-center gap-2">
        <strong className="flex-1 text-info">即将分析 <span className="font-mono">{remaining.toFixed(1)}s</span></strong>
        <Button className="h-7 px-2 text-xs" onClick={() => void copilot.flushCountdown(countdown.ref)}>立即</Button>
        <Button className="h-7 px-2 text-xs" onClick={() => void copilot.skipCountdown(countdown.ref)}>跳过</Button>
      </div>
      <p className="m-0 text-muted-foreground">{countdown.text}</p>
    </section>
  )
}
