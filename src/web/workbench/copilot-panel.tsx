import { NoteSuggestions } from './clinical-note/note-suggestions'
import { Button } from '@ui-sdk/react/button'
import { Switch, SwitchThumb } from '@ui-sdk/react/switch'
import { ScrollArea, ScrollAreaContent, ScrollAreaScrollToEnd, ScrollAreaViewport } from '@ui-sdk/react/scroll-area'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@ui-sdk/react/dialog'
import { Select, SelectContent, SelectItem, SelectList, SelectTrigger, SelectValue } from '@ui-sdk/react/select'
import {
  createTriggerMenuController,
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuEmpty,
  TriggerMenuGroup,
  TriggerMenuGroupLabel,
  TriggerMenuItem,
  TriggerMenuInput,
  TriggerMenuList,
} from '@ui-sdk/react/trigger-menu'
import type { TriggerMenuContentState, TriggerMenuData, TriggerMenuDataGroup, TriggerMenuDataItem, TriggerMenuSelectDetails } from '@ui-sdk/react/trigger-menu'
import {
  AtSignIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChartPieIcon,
  CheckIcon,
  ScanLineIcon,
  XIcon,
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
import { NOTE_SECTION_NAME, NOTE_SECTIONS } from '../../shared/clinical-note'
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
import { CopilotMarkdown } from './copilot-markdown'
import { CopilotContextViewPanel } from './copilot-context-view'
import { badge, iconButton, pane } from './pane-styles'
import { ActionTooltip } from './ui-tooltip'

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
  ok: '已完成',
  error: '读取失败',
  cancelled: '未执行',
  denied: '已拦截',
  approval: '待确认',
}

const seconds = (dur: number) => `${dur.toFixed(1)}s`

function ToolStep({ step, label }: { step: Extract<CopilotStep, { kind: 'tool' }>; label: string }) {
  const status = TOOL_STATE_TEXT[step.state]
  return (
    <li className="tool-step" data-tool-state={step.state}>
      <details>
        <summary aria-label={`详情 · ${label} · ${step.subject}`}>
          <WrenchIcon size={14} /><strong>{step.subject}</strong><span>{status}</span>
          <small>{seconds(step.dur)}</small><ChevronDownIcon size={12} /><span className="sr-only">详情</span>
        </summary>
        <dl><dt>工具</dt><dd>{step.name}</dd><dt>参数</dt><dd><pre>{JSON.stringify(step.args, null, 2)}</pre></dd>
          <dt>结果</dt><dd><pre>{step.result || '尚无结果'}</pre></dd></dl>
      </details>
    </li>
  )
}

function TurnSteps({ turn, label }: { turn: CopilotTurn; label: string }) {
  const [open, setOpen] = useState(false)
  const steps = turn.steps
  if (steps.length === 0) return null
  return (
    <div className="copilot-steps">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`思考与读取（${steps.length}） · ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon aria-hidden="true" size={13} />
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

function TurnActions({ turn, label, copilot, onEdit, writable }: { writable: boolean; turn: CopilotTurn; label: string; copilot: CopilotSession; onEdit: (text: string) => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.reply)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="turn-actions flex items-center gap-0.5 text-muted-foreground">
      <ActionTooltip label={copied ? '已复制' : '复制回答'} closeOnPress={false} side="top">
        <Button aria-label={`复制回答 · ${label}`} className={iconButton} onClick={() => void copy()}>
          {copied
            ? <CheckIcon aria-hidden="true" size={14} className="text-success" />
            : <CopyIcon aria-hidden="true" size={14} />}
        </Button>
      </ActionTooltip>
      {copied && <span className="sr-only" role="status">已复制</span>}
      {writable && turn.status === 'done' && (
        <>
          <ActionTooltip label="重新生成" side="top">
            <Button aria-label={`重新生成 · ${label}`} className={iconButton} onClick={() => void copilot.resend(turn.turnId, turn.trigger.text, turn.trigger.mentions)}>
              <RefreshCwIcon aria-hidden="true" size={14} />
            </Button>
          </ActionTooltip>
          <ActionTooltip label="编辑并重发" side="top">
            <Button aria-label={`编辑并重发 · ${label}`} className={iconButton} onClick={() => onEdit(turn.trigger.text)}>
              <PencilIcon aria-hidden="true" size={14} />
            </Button>
          </ActionTooltip>
          <ActionTooltip label={turn.feedback === 'up' ? '取消有帮助' : '有帮助'} side="top">
            <Button
              aria-label={`有帮助 · ${label}`}
              aria-pressed={turn.feedback === 'up'}
              className={iconButton}
              onClick={() => void copilot.setFeedback(turn.turnId, turn.feedback === 'up' ? null : 'up')}
            >
              <ThumbsUpIcon aria-hidden="true" size={14} />
            </Button>
          </ActionTooltip>
          <ActionTooltip label={turn.feedback === 'down' ? '取消没有帮助' : '没有帮助'} side="top">
            <Button
              aria-label={`没有帮助 · ${label}`}
              aria-pressed={turn.feedback === 'down'}
              className={iconButton}
              onClick={() => void copilot.setFeedback(turn.turnId, turn.feedback === 'down' ? null : 'down')}
            >
              <ThumbsDownIcon aria-hidden="true" size={14} />
            </Button>
          </ActionTooltip>
        </>
      )}
    </div>
  )
}

function CopilotTurnView({ turn, index, copilot, onEdit, writable }: { writable: boolean; turn: CopilotTurn; index: number; copilot: CopilotSession; onEdit: (text: string) => void }) {
  const live = turn.status === 'running'
  const label = `第 ${index + 1} 轮`
  return (
    <li className="copilot-turn" data-turn-status={turn.status} data-turn-superseded={turn.superseded || undefined}>
      {turn.trigger.kind === 'doctor' ? (
        <div className="turn-prompt"><span className="prompt-avatar" aria-hidden="true">医</span>
          <div><p className="turn-byline">医生 · {formatClockSeconds(turn.startedAt)}{turn.superseded && ' · 已被取代'}</p>
          <p>{turn.trigger.text}</p></div>
        </div>
      ) : <div className="turn-event"><strong>{turn.trigger.text} · 自动</strong></div>}
      {turn.trigger.mentions.length > 0 && (
        <p className="m-0 flex flex-wrap gap-1">
          {turn.trigger.mentions.map((mention) => (
            <span key={`${mention.kind}:${mention.id}`} className={badge}>
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
          <CopilotMarkdown text={turn.reply || '…'} />
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
          <TurnActions writable={writable} turn={turn} label={label} copilot={copilot} onEdit={onEdit} />
        </div>
      )}
    </li>
  )
}

function ModelChip({ model, onChange }: { model: CopilotModelSetting; onChange: (m: string, e: CopilotModelSetting['effort']) => void }) {
  return (
    <span className="model-controls">
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
  onOpenContext: () => void
}

type MentionItem = TriggerMenuDataItem<string> & { value: string; label: string }

function mentionCandidates(encounterId: string, examinations: PhysicalExaminationView[]) {
  const item = (value: string, label: string): MentionItem => ({ value, label })
  const queryItems = (items: MentionItem[], query: string) =>
    items.filter((candidate) => candidate.label.toLowerCase().includes(query.toLowerCase()))
  const reports = async (query: string): Promise<TriggerMenuData<string>> => {
    const investigations = await fetchInvestigations(encounterId)
    return [
      {
        type: 'group',
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
  const exams: TriggerMenuDataGroup<string> = {
    type: 'group',
    label: '查体',
    items: examinations.map((examination) => item(`examination:${examination.system}`, BODY_SYSTEM_NAME[examination.system])),
  }
  const noteSections = async (query: string): Promise<TriggerMenuData<string>> => {
    const note = await fetchClinicalNote(encounterId)
    const signed = note.revisions.at(-1)
    const signedItems = signed
      ? NOTE_SECTIONS
          .filter((section) => signed.sections[section].trim() !== '')
          .map((section) => item(`note-section:${signed.revisionId}:${section}`, `${NOTE_SECTION_NAME[section]}（已签署）`))
      : []
    const draftItems = note.draft
      .filter((draft) => draft.content.trim() !== '')
      .map((draft) => item(`draft:${draft.section}`, `${NOTE_SECTION_NAME[draft.section]}（草稿）`))
    return [
      { type: 'group', label: '病历（已签署）', items: queryItems(signedItems, query) },
      { type: 'group', label: '病历草稿', items: queryItems(draftItems, query) },
    ]
  }
  return { reports, exams, noteSections }
}

function renderMenuItem(item: TriggerMenuData<unknown>[number]) {
  if (typeof item !== 'object' || !('value' in item) || typeof item.value !== 'string') return null
  return (
    <TriggerMenuItem key={item.value} value={item.value} label={item.label} className="copilot-menu-item">
      <span>{item.label}</span>
      {'description' in item && typeof item.description === 'string' && (
        <span className="text-[11px] text-muted-foreground">{item.description}</span>
      )}
    </TriggerMenuItem>
  )
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

function CopilotComposer({ copilot, encounterId, examinations, draft, onDraftChange, mentions, onMentionsChange, editing, onCancelEdit, onOpenContext }: ComposerProps) {
  const [mode, setMode] = useState<CopilotPromptMode>('queue')
  const [menuOpen, setMenuOpen] = useState(false)
  const [sendError, setSendError] = useState('')
  const [menu] = useState(createTriggerMenuController)

  const submit = async () => {
    const text = draft.trim()
    if (!text || text.length > MAX_PROMPT_LENGTH) return
    if (text === CONTEXT_COMMAND) {
      // A typed slash command opens the same read-only view the menu action does; what the doctor typed stays.
      onOpenContext()
      return
    }
    setSendError('')
    const used = mentions.filter((mention) => text.includes(`@${mention.label}`))
    const sent = editing ? await copilot.resend(editing, text, used) : await copilot.prompt(text, used, mode)
    if (sent) {
      // A steer applies to one turn only; the next prompt queues again unless the doctor opts back in.
      if (mode === 'steer') setMode('queue')
      onDraftChange('')
      onMentionsChange([])
      onCancelEdit()
    } else {
      setSendError('发送失败，内容已保留，可以重试。')
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
          const { reports, exams, noteSections } = known.current
          const [reportGroups, noteGroups] = await Promise.all([reports(query), noteSections(query)])
          return [...reportGroups, exams, ...noteGroups]
        },
        insert: (item: { value: string; label: string }) => `@${item.label} `,
      },
    ],
    [encounterId],
  )

  const onSelect = (value: string, details: TriggerMenuSelectDetails<string>) => {
    if (value === CONTEXT_COMMAND) {
      // Open the read-only context view; the composer keeps whatever the doctor had typed.
      details.preventDefault()
      onOpenContext()
      return
    }
    if (details.trigger !== '@') return
    const separator = value.indexOf(':')
    const kind = value.slice(0, separator)
    const id = value.slice(separator + 1)
    if (kind === 'report' || kind === 'examination' || kind === 'note-section' || kind === 'draft') {
      onMentionsChange([...mentions.filter((mention) => mention.kind !== kind || mention.id !== id), { kind, id, label: details.item.label }])
    }
  }

  return (
    <div className="copilot-composer">
      {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      {editing && (
        <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
          正在编辑并重发上一轮
          <Button aria-label="取消编辑" className="h-5 text-[11px]" onClick={onCancelEdit}>
            取消
          </Button>
        </p>
      )}
      <TriggerMenu
        controller={menu}
        triggers={triggers}
        onOpenChange={setMenuOpen}
        onSelect={onSelect}
      >
        <TriggerMenuInput
          aria-label="问临床助手"
          data-copilot-composer
          placeholder={copilot.busy ? '输入指引或加入队列…' : '询问本次就诊，或用 @ 引用资料…'}
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
              state.items.map((entry) =>
                typeof entry === 'object' && 'type' in entry && entry.type === 'group'
                  ? (
                      <TriggerMenuGroup key={entry.label}>
                        <TriggerMenuGroupLabel className="px-2 py-1 text-xs text-muted-foreground">{entry.label}</TriggerMenuGroupLabel>
                        {entry.items.map(renderMenuItem)}
                      </TriggerMenuGroup>
                    )
                  : renderMenuItem(entry),
              )
            }
          </TriggerMenuList>
        </TriggerMenuContent>
      </TriggerMenu>
      <div className="composer-toolbar">
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
            <>
              <ActionTooltip label="引用就诊资料（@）" side="top">
                <Button aria-label="引用就诊资料" className="composer-shortcut" onClick={() => void menu.open({ trigger: '@' })}>
                  <AtSignIcon aria-hidden="true" size={15} />
                </Button>
              </ActionTooltip>
              <ActionTooltip label="打开助手命令（/）" side="top">
                <Button aria-label="打开助手命令" className="composer-shortcut" onClick={() => void menu.open({ trigger: '/' })}>/</Button>
              </ActionTooltip>
              {copilot.model && <ModelChip model={copilot.model} onChange={(m, e) => void copilot.configure(m, e)} />}
            </>
          )}
        <ActionTooltip label="发送（Enter）" side="top" disabled={!draft.trim()}>
          <Button aria-label="发送给临床助手" data-variant="solid" className="send-prompt" disabled={!draft.trim()} onClick={() => void submit()}>
            <ArrowUpIcon aria-hidden="true" size={15} />
          </Button>
        </ActionTooltip>
      </div>
    </div>
  )
}

export interface CopilotPanelProps {
  copilot: CopilotSession
  encounter: EncounterView
  examinations: PhysicalExaminationView[]
  onHide: () => void
  draft: string
  setDraft: (text: string) => void
  mentions: CopilotMention[]
  setMentions: (mentions: CopilotMention[]) => void
  editing: string | null
  setEditing: (id: string | null) => void
}

export function CopilotPanel({ copilot, encounter, examinations, onHide, draft, setDraft, mentions, setMentions, editing, setEditing }: CopilotPanelProps) {
  const [tab, setTab] = useState('session')
  const [contextOpen, setContextOpen] = useState(false)
  const latest = copilot.turns.at(-1)
  const contextProps = {
    encounterId: encounter.encounterId,
    modelLabel: copilot.model?.model ?? null,
    writable: encounter.status === 'active',
    revision: [latest?.turnId, latest?.status, latest?.steps.length, copilot.compactions[0]?.markerId, examinations.length].join('/'),
  }
  return (
    <aside aria-label="临床助手" className={`${pane} copilot-pane`} data-stream={copilot.stream} data-running={copilot.busy || undefined}>
      <div className="pane-heading">
        <span className="section-icon assistant-icon"><SparklesIcon size={19} /></span>
        <div className="agent-session"><h2>临床助手</h2><p title={`就诊 ${encounter.patient.outpatientNumber}`}>
          就诊 {encounter.patient.outpatientNumber} · 检查点 {copilot.checkpoint === null ? '…' : `#${copilot.checkpoint}`}
        </p></div>
        <div className="pane-options">
          {encounter?.status === 'active' && (
            <label className="flex shrink-0 items-center gap-1 text-xs">
              <span>自动分析</span>
              <Switch
                checked={copilot.autoAnalysis}
                disabled={!copilot.model}
                onCheckedChange={(enabled) => void copilot.setAutomaticAnalysis(enabled)}
                data-agent-confirm="更改自动分析设置"
              >
                <SwitchThumb />
              </Switch>
            </label>
          )}
          <ActionTooltip label="隐藏临床助手" side="bottom">
            <Button aria-label="隐藏临床助手" className={iconButton} onClick={onHide}>
              <ChevronRightIcon aria-hidden="true" size={16} />
            </Button>
          </ActionTooltip>
        </div>
      </div>
      {copilot.stream === 'reconnecting' && (
        <p className="m-0 bg-warning/10 px-3.5 py-1 text-xs text-warning" role="status">
          连接中断，正在重连，恢复后从最新检查点继续。
        </p>
      )}
      <Tabs className="assistant-tabs" value={tab} onValueChange={(value) => value && setTab(value)}>
        <TabsList aria-label="临床助手视图" className="section-tabs">
          <TabsTab value="session">会话</TabsTab>
          <TabsTab value="context">上下文</TabsTab>
        </TabsList>
        <TabsPanel value="session" className="session-panel">
          <ScrollArea stickToEnd className="session-scroll">
            <ScrollAreaViewport role="log" aria-label="临床助手会话" className="session-viewport">
              <ScrollAreaContent className="session-content">
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
              <div className="conversation-empty"><span className="section-icon assistant-icon"><SparklesIcon size={20} /></span>
                <strong>本次就诊会话</strong><p>可询问鉴别诊断、检查建议或病历小结。</p>
                {encounter.status === 'active' && <div>{['/检查建议', '/病历小结'].map((command) => <Button key={command}
                  onClick={() => { setDraft(command + ' '); document.querySelector<HTMLElement>('[data-copilot-composer]')?.focus() }}>{command}</Button>)}</div>}
              </div>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-3 pb-3">
                {copilot.turns.map((turn, index) => (
                  <CopilotTurnView writable={encounter.status === 'active'} key={turn.turnId} index={index} turn={turn} copilot={copilot} onEdit={(text) => {
                    setDraft(text)
                    setMentions(turn.trigger.mentions)
                    setEditing(turn.turnId)
                  }} />
                ))}
              </ol>
            )}
              </ScrollAreaContent>
            </ScrollAreaViewport>
            <ScrollAreaScrollToEnd className="consultation-jump"><ArrowDownIcon size={13} />回到最新回复</ScrollAreaScrollToEnd>
          </ScrollArea>
        </TabsPanel>
        <TabsPanel value="context" className="context-panel">
          {tab === 'context' && <><div className="inspector-heading"><h3>上下文洞察</h3>
            <Button aria-label="展开上下文" onClick={() => setContextOpen(true)}><ScanLineIcon size={15} />展开</Button></div>
            <CopilotContextViewPanel {...contextProps} /></>}
        </TabsPanel>
      </Tabs>
      {encounter.status === 'active' && <div className="assistant-input-area">
          <CopilotComposer
            onOpenContext={() => setContextOpen(true)}
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
          <p className="composer-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>/</kbd> 命令 · <kbd>@</kbd> 引用</p>
      </div>}
      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent className="context-dialog" aria-label="上下文洞察">
          <header><span className="section-icon assistant-icon"><ChartPieIcon size={18} /></span>
            <DialogTitle>上下文洞察</DialogTitle><DialogClose aria-label="关闭上下文"><XIcon size={17} /></DialogClose></header>
          {contextOpen && <CopilotContextViewPanel {...contextProps} />}
        </DialogContent>
      </Dialog>
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
