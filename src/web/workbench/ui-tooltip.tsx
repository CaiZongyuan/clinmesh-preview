import {
  Tooltip,
  TooltipContent,
  TooltipShortcut,
  TooltipTrigger,
} from '@ui-sdk/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export const TOOLTIP_OPEN_DELAY = 500
export const TOOLTIP_CLOSE_DELAY = 0

interface ActionTooltipProps {
  label: ReactNode
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  closeOnPress?: boolean
  disabled?: boolean
  delay?: number
  container?: DocumentFragment | Element | null
  children: ReactElement<{ disabled?: boolean }>
}

export function ActionTooltip({
  label,
  shortcut,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  closeOnPress = true,
  disabled,
  delay = TOOLTIP_OPEN_DELAY,
  container,
  children,
}: ActionTooltipProps) {
  // ui-sdk rejects natively disabled buttons as TooltipTrigger because keyboard users cannot reach them.
  if (disabled || children.props.disabled) return children
  return (
    <Tooltip
      delay={delay}
      closeDelay={TOOLTIP_CLOSE_DELAY}
      closeOnPress={closeOnPress}
      shortcut={shortcut}
      type="description"
      container={container}
    >
      <TooltipTrigger render={children} />
      <TooltipContent side={side} align={align} sideOffset={sideOffset} className="cm-tooltip">
        <span>{label}</span>
        {shortcut && <TooltipShortcut className="cm-tooltip-kbd" />}
      </TooltipContent>
    </Tooltip>
  )
}
