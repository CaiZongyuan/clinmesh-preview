import { Button } from '@ui-sdk/react/button'
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@ui-sdk/react/menu'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { Textarea } from '@ui-sdk/react/textarea'
import { CheckIcon, HistoryIcon, LoaderCircleIcon, PenLineIcon } from 'lucide-react'
import {
  MAX_NOTE_SECTION_LENGTH,
  NOTE_SECTION_NAME,
  NOTE_SECTIONS,
  REQUIRED_NOTE_SECTIONS,
  type NoteSection,
  type SignedNoteRevision,
} from '../../../shared/clinical-note'
import type { EncounterView } from '../../../shared/encounter'
import { ClinicalConfirmation } from '../clinical-confirmation'
import { formatClock, formatClockSeconds } from '../format'
import { badge } from '../pane-styles'
import { useClinicalNoteContext } from './clinical-note-context'
import { NoteSuggestions } from './note-suggestions'
import type { ClinicalNote, SaveState } from './use-clinical-note'

const COMMON_PHRASES: Record<NoteSection, readonly string[]> = {
  'chief-complaint': ['发热（时间）。', '咳嗽、咳痰（时间）。', '胸痛（时间）。'],
  'present-illness': ['病程中无咯血、盗汗、体重下降。', '起病以来精神、食欲稍差，大小便正常。'],
  'past-history': ['否认糖尿病、冠心病史。', '否认手术、外伤、输血史。', '否认食物过敏史。'],
  findings: ['神志清，精神可。', '双肺呼吸音清，未闻及干湿性啰音。', '心律齐，各瓣膜区未闻及杂音。', '腹软，无压痛及反跳痛。'],
  assessment: ['结合病史、查体及辅助检查结果，考虑：', '需与以下疾病鉴别：'],
  plan: ['注意休息，多饮水。', '72 小时复诊。', '如症状加重随时急诊就诊。'],
}

const card = 'flex flex-col gap-3 rounded-lg border bg-card p-3'

export function ClinicalNoteTab({ encounter, diagnosisSeq }: { encounter: EncounterView; diagnosisSeq?: number }) {
  const context = useClinicalNoteContext()
  if (!context) return null
  const { note, writable } = context
  const last = note.revisions.at(-1)
  return (
    <div className="flex flex-col gap-3 p-3">
      <section aria-labelledby="clinical-note-heading" className={card} data-agent-note-updated={Object.values(note.authors).includes('assistant') || undefined}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 id="clinical-note-heading" className="m-0 text-sm font-semibold">
              门诊病历
            </h3>
            <SaveStatus save={note.save} onRetry={note.retrySave} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {last && (
              <span className={`${badge} bg-success/15 text-success`}>
                第 {last.version} 版已签署 · {formatClock(last.signedAt)}
              </span>
            )}
            {note.unsignedChanges && <span className={`${badge} bg-warning/15 text-warning`}>有未签署修改</span>}
            {/* A diagnosis revision with a higher clinical revision sequence than the latest signature means the
              signed note predates the current diagnosis and no longer satisfies completion. */}
            {last && diagnosisSeq !== undefined && diagnosisSeq > last.seq && (
              <span className={`${badge} bg-destructive/15 text-destructive`}>签署早于诊断修改</span>
            )}
            <SigningHistory revisions={note.revisions} />
            <SignNote note={note} encounter={encounter} writable={writable} />
          </div>
        </div>
        {note.error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {note.error}
          </p>
        )}
        {NOTE_SECTIONS.map((section) => (
          <NoteSectionField key={section} section={section} note={note} writable={writable} propose={context.propose} />
        ))}
      </section>
    </div>
  )
}

function SaveStatus({ save, onRetry }: { save: SaveState; onRetry: () => void }) {
  return (
    <span role="status" aria-label="病历草稿保存状态" className="flex items-center gap-1 text-xs text-muted-foreground">
      {save.kind === 'saving' && (
        <>
          <LoaderCircleIcon aria-hidden="true" size={12} className="animate-spin motion-reduce:animate-none" />
          保存中…
        </>
      )}
      {save.kind === 'saved' && (
        <>
          <CheckIcon aria-hidden="true" size={12} />
          已自动保存 {formatClockSeconds(save.at)}
        </>
      )}
      {save.kind === 'failed' && (
        <span className="flex items-center gap-1.5 text-destructive">
          保存失败：{save.message}
          <Button className="h-6 px-2 text-xs" onClick={onRetry}>
            重试保存
          </Button>
        </span>
      )}
    </span>
  )
}

function NoteSectionField({ section, note, writable, propose }: {
  section: NoteSection; note: ClinicalNote; writable: boolean; propose: NonNullable<ReturnType<typeof useClinicalNoteContext>>['propose']
}) {
  const name = NOTE_SECTION_NAME[section]
  const required = REQUIRED_NOTE_SECTIONS.includes(section)
  const text = note.sections[section]
  const assistantDraft = note.authors[section] === 'assistant'
  return (
    <Field disabled={!writable} className="flex flex-col gap-1" data-agent-draft={assistantDraft || undefined}>
      <FieldLabel className="text-[13px] font-medium">
        {name}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </FieldLabel>
      {assistantDraft && <span className={`${badge} self-start border border-dashed border-info/65 text-info`}>助手</span>}
      <Textarea
        value={text}
        data-note-section={section}
        data-note-author={note.authors[section]}
        onValueChange={(value, details) => {
          if (details.source !== 'agent') {
            note.edit(section, value)
            return
          }
          if (!writable || value.length > MAX_NOTE_SECTION_LENGTH) {
            details.cancel()
            return
          }
          const focused = document.activeElement?.getAttribute('data-note-section') === section
          details.cancel()
          if (value !== note.contentOf(section)) {
            propose({ module: 'note', section, text: value }, focused || note.authorOf(section) === 'doctor')
          }
        }}
        aria-required={required || undefined}
        maxLength={MAX_NOTE_SECTION_LENGTH}
        rows={section === 'chief-complaint' ? 2 : 3}
        placeholder={required ? '必填' : undefined}
        className="w-full resize-y text-[13px] leading-relaxed"
      />
      <div className="flex items-center justify-between gap-2">
        <Menu onAction={(phrase) => note.append(section, phrase)}>
          <MenuTrigger
            aria-label={`常用语：${name}`}
            disabled={!writable}
            className="h-6 border-transparent bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            常用语
          </MenuTrigger>
          <MenuContent className="max-w-72 text-[13px]">
            {COMMON_PHRASES[section].map((phrase) => (
              <MenuItem key={phrase} value={phrase}>
                {phrase}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <FieldDescription className="font-mono text-[11px] text-muted-foreground">
          {text.length}/{MAX_NOTE_SECTION_LENGTH}
        </FieldDescription>
      </div>
      <NoteSuggestions section={section} />
    </Field>
  )
}

function SigningHistory({ revisions }: { revisions: SignedNoteRevision[] }) {
  return (
    <Popover>
      <PopoverTrigger disabled={revisions.length === 0} className="h-7 gap-1 px-2.5 text-xs">
        <HistoryIcon aria-hidden="true" size={13} />
        签署历史{revisions.length > 0 && ` (${revisions.length})`}
      </PopoverTrigger>
      <PopoverContent className="flex max-h-[70vh] w-[340px] flex-col gap-2 overflow-y-auto text-xs">
        <PopoverTitle className="m-0 text-sm">签署历史</PopoverTitle>
        <ol aria-label="签署版本" className="m-0 flex list-none flex-col gap-2 p-0">
          {[...revisions].reverse().map((revision) => (
            <li key={revision.revisionId}>
              <article aria-label={`第 ${revision.version} 版`} className="flex flex-col gap-1 rounded-md bg-muted p-2">
                <header className="flex justify-between gap-2">
                  <b>第 {revision.version} 版</b>
                  <span className="text-muted-foreground">
                    <time dateTime={revision.signedAt}>{formatClockSeconds(revision.signedAt)}</time> · {revision.practitionerId}
                  </span>
                </header>
                <dl className="m-0 flex flex-col gap-0.5">
                  {NOTE_SECTIONS.map((section) => (
                    <div key={section} className="flex gap-1">
                      <dt className="flex-none text-muted-foreground">{NOTE_SECTION_NAME[section]}：</dt>
                      <dd className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{revision.sections[section] || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            </li>
          ))}
        </ol>
        <p className="m-0 text-muted-foreground">签署版本不可覆盖；修改须追加签署。</p>
      </PopoverContent>
    </Popover>
  )
}

function SignNote({ note, encounter, writable }: { note: ClinicalNote; encounter: EncounterView; writable: boolean }) {
  const version = note.revisions.length + 1
  const first = version === 1
  return (
    <ClinicalConfirmation
      trigger={
        <>
          <PenLineIcon aria-hidden="true" size={13} />
          {/* web.css squares an aria-labelled button whose only element child is an icon; text nodes don't count. */}
          <span>{first ? '签署病历' : '追加签署'}</span>
        </>
      }
      triggerLabel={first ? '签署病历' : '追加签署'}
      triggerClassName="h-7 gap-1 border-primary bg-primary px-2.5 text-xs text-primary-foreground"
      disabled={!writable}
      title={first ? '签署门诊病历？' : `追加签署第 ${version} 版病历？`}
      confirmLabel="确认签署"
      intent={`签署${encounter.patient.name}本次就诊的门诊病历第 ${version} 版`}
      onConfirm={() => note.sign(note.sections)}
    >
      <dl className="m-0 flex max-h-64 flex-col gap-1 overflow-y-auto">
        {NOTE_SECTIONS.map((section) => (
          <div key={section} className="flex gap-1">
            <dt className="flex-none text-muted-foreground">{NOTE_SECTION_NAME[section]}：</dt>
            <dd className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{note.sections[section] || '—'}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-2 text-muted-foreground">签署后形成不可覆盖的正式版本；之后的修改须追加签署。主诉、现病史为必填。</p>
    </ClinicalConfirmation>
  )
}
