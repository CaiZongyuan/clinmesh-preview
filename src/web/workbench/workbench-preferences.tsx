import { createLocalStorage, createPreference } from '@ui-sdk/core'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover'
import { usePreference } from '@ui-sdk/react/preferences'
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { SettingsIcon } from 'lucide-react'
import { iconButton } from './pane-styles'

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
      <PopoverTrigger aria-label="工作台外观" title="工作台外观" className={iconButton}>
        <SettingsIcon aria-hidden="true" size={16} />
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-2 px-3 py-2 text-xs">
        <PopoverTitle className="m-0 text-sm">工作台外观</PopoverTitle>
        <SegmentedControl aria-label="主题" value={selectedTheme} onValueChange={(value) => {
          if (value === 'system' || value === 'light' || value === 'dark') theme.set(value)
        }}>
          <SegmentedControlIndicator />
          <SegmentedControlItem value="system">跟随系统</SegmentedControlItem>
          <SegmentedControlItem value="light">浅色</SegmentedControlItem>
          <SegmentedControlItem value="dark">深色</SegmentedControlItem>
        </SegmentedControl>
        <SegmentedControl aria-label="字号" value={selectedScale} onValueChange={(value) => {
          if (value === 'standard' || value === 'large' || value === 'extra-large') fontScale.set(value)
        }}>
          <SegmentedControlIndicator />
          <SegmentedControlItem value="standard">标准</SegmentedControlItem>
          <SegmentedControlItem value="large">大</SegmentedControlItem>
          <SegmentedControlItem value="extra-large">特大</SegmentedControlItem>
        </SegmentedControl>
      </PopoverContent>
    </Popover>
  )
}
