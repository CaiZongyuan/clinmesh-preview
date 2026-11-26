import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { KeyboardIcon } from 'lucide-react'
import { iconButton } from './pane-styles'
import { ActionTooltip } from './ui-tooltip'

const shortcuts = [
  ['按住 Space', '按住说话'],
  ['M', '暂停或恢复收音'],
  ['Alt + 1–4', '切换病历、检验检查、诊断、处方'],
  ['Ctrl + /', '打开临床助手并聚焦输入框'],
  ['Esc', '停止临床助手当前运行'],
] as const

export function WorkbenchShortcuts() {
  return (
    <Popover>
      <ActionTooltip label="快捷键" side="bottom">
        <PopoverTrigger aria-label="快捷键" className={iconButton}>
          <KeyboardIcon aria-hidden="true" size={16} />
        </PopoverTrigger>
      </ActionTooltip>
      <PopoverContent sideOffset={6} align="end" className="w-72 max-w-[calc(100vw-1rem)] gap-2.5 p-3 text-xs">
        <PopoverTitle className="m-0 text-[13px] font-semibold">快捷键</PopoverTitle>
        <dl className="m-0 flex flex-col gap-2">
          {shortcuts.map(([key, action]) => (
            <div key={key} className="grid grid-cols-[5.75rem_1fr] items-center gap-2">
              <dt>
                <kbd className="inline-block rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {key}
                </kbd>
              </dt>
              <dd className="m-0 text-muted-foreground">{action}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}

export function workbenchOwnsShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false
  return !(event.target instanceof Element && event.target.closest(
    '[role="alertdialog"], [role="dialog"], [role="menu"], [role="listbox"], [popover][data-open]',
  ))
}
