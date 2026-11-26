import { createLocalStorage, createPreference } from '@ui-sdk/core'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { usePreference } from '@ui-sdk/react/preferences'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { SettingsIcon } from 'lucide-react'
import { iconButton } from './pane-styles'
import { ActionTooltip } from './ui-tooltip'

const theme = createPreference({
  values: ['system', 'light', 'dark'] as const,
  defaultValue: 'system',
  attribute: 'data-theme',
  global: true,
  storage: createLocalStorage('cm.theme'),
})

const fontScale = createPreference({
  values: ['standard', 'large', 'extra-large'] as const,
  defaultValue: 'standard',
  attribute: 'data-font-scale',
  global: true,
  storage: createLocalStorage('cm.scale'),
})

export const workbenchPreferences = [theme, fontScale]

export function WorkbenchAppearance() {
  const { value: selectedTheme } = usePreference(theme)
  const { value: selectedScale } = usePreference(fontScale)
  return (
    <Popover>
      <ActionTooltip label="工作台外观" side="bottom">
        <PopoverTrigger aria-label="工作台外观" className={iconButton}>
          <SettingsIcon aria-hidden="true" size={16} />
        </PopoverTrigger>
      </ActionTooltip>
      <PopoverContent sideOffset={6} align="end" className="flex w-64 flex-col gap-2.5 p-3 text-xs">
        <PopoverTitle className="m-0 text-[13px] font-semibold">工作台外观</PopoverTitle>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">主题</span>
          <SegmentedControl aria-label="主题" value={selectedTheme} onValueChange={(value) => {
            if (value === 'system' || value === 'light' || value === 'dark') theme.set(value)
          }}>
            <SegmentedControlIndicator />
            <SegmentedControlItem value="system">跟随系统</SegmentedControlItem>
            <SegmentedControlItem value="light">浅色</SegmentedControlItem>
            <SegmentedControlItem value="dark">深色</SegmentedControlItem>
          </SegmentedControl>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">字号</span>
          <SegmentedControl aria-label="字号" value={selectedScale} onValueChange={(value) => {
            if (value === 'standard' || value === 'large' || value === 'extra-large') fontScale.set(value)
          }}>
            <SegmentedControlIndicator />
            <SegmentedControlItem value="standard">标准</SegmentedControlItem>
            <SegmentedControlItem value="large">大</SegmentedControlItem>
            <SegmentedControlItem value="extra-large">特大</SegmentedControlItem>
          </SegmentedControl>
        </div>
      </PopoverContent>
    </Popover>
  )
}
