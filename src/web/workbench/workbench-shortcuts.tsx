import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { KeyboardIcon } from 'lucide-react'
import { iconButton } from './pane-styles'

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
      <PopoverTrigger aria-label="快捷键" title="快捷键" className={iconButton}>
        <KeyboardIcon aria-hidden="true" size={16} />
      </PopoverTrigger>
      <PopoverContent className="w-72 max-w-[calc(100vw-1rem)] space-y-2 px-3 py-2 text-xs">
        <PopoverTitle className="m-0 text-sm">快捷键</PopoverTitle>
        <dl className="m-0 flex flex-col gap-1.5">
          {shortcuts.map(([key, action]) => (
            <div key={key} className="grid grid-cols-[5.5rem_1fr] gap-1.5">
              <dt><kbd className="font-mono">{key}</kbd></dt>
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
