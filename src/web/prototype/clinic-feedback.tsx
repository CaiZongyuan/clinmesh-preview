import { Toast, ToastAction, ToastClose, ToastRegion, createToaster, type ToastData } from '@ui-sdk/react/toast'
import {
  AlertTriangleIcon,
  BellIcon,
  CheckIcon,
  InfoIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Spinner } from './clinic-motion'

export type FeedbackSide = 'patient' | 'staff'

export type NotificationTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'module'; module: 'appointments' | 'followup' | 'messages' }

export interface NotificationData {
  avatar: string
  tone: 'human' | 'agent' | 'system'
  at: string
  target?: NotificationTarget
  actionLabel?: string
}

type Toaster = ReturnType<typeof createToaster<string>>

export interface ClinicFeedback {
  toast: Record<FeedbackSide, Toaster>
  notify: Record<FeedbackSide, Toaster>
}

export function createClinicFeedback(): ClinicFeedback {
  return {
    toast: { patient: createToaster<string>({ duration: 3600 }), staff: createToaster<string>({ duration: 3600 }) },
    notify: { patient: createToaster<string>({ duration: 9000 }), staff: createToaster<string>({ duration: Infinity }) },
  }
}

export function showUndoToast(toaster: Toaster, title: string, undoLabel: string, onUndo: () => void) {
  const id = toaster.success(title, {
    duration: 6000,
    action: {
      label: undoLabel,
      dismiss: false,
      onAction: () => {
        onUndo()
        toaster.update(id, { title: '已撤销', type: 'info', action: undefined, duration: 1600 })
      },
    },
  })
}

function ToastIcon({ type }: { type: ToastData['type'] }) {
  if (type === 'loading') return <Spinner size={14} />
  if (type === 'success') return <CheckIcon size={14} strokeWidth={2.6} />
  if (type === 'error' || type === 'warning') return <AlertTriangleIcon size={13} strokeWidth={2.4} />
  return <InfoIcon size={14} strokeWidth={2.3} />
}

export function StatusToastRegion({
  toaster,
  placement,
  label,
}: {
  toaster: Toaster
  placement: 'phone' | 'desk'
  label: string
}) {
  return (
    <ToastRegion toaster={toaster} side="top" align="center" maxVisible={1} aria-label={label} className={`cc-toast-region cc-toast-region--${placement}`}>
      {(item: ToastData<ReactNode>) => (
        <Toast className="cc-toast" data-sheen={item.type === 'success' ? '' : undefined}>
          <span key={`${item.type}-icon`} className="cc-toast-icon" data-type={item.type} aria-hidden="true">
            <ToastIcon type={item.type} />
          </span>
          <span key={`${item.version}-text`} className="cc-toast-text">
            <span className="cc-toast-title">{item.title as ReactNode}</span>
            {item.description ? <span className="cc-toast-desc">{item.description as ReactNode}</span> : null}
          </span>
          {item.action && (
            <ToastAction className="cc-toast-undo">
              <svg className="cc-toast-ring" viewBox="0 0 20 20" aria-hidden="true" style={{ animationDuration: `${item.duration}ms` }}>
                <circle cx="10" cy="10" r="8" />
              </svg>
              {item.action.label as ReactNode}
            </ToastAction>
          )}
        </Toast>
      )}
    </ToastRegion>
  )
}

export function NotificationRegion({
  toaster,
  placement,
  label,
  onOpen,
}: {
  toaster: Toaster
  placement: 'phone' | 'desk'
  label: string
  onOpen: (target: NotificationTarget, id: string) => void
}) {
  return (
    <ToastRegion
      toaster={toaster}
      side="top"
      align={placement === 'phone' ? 'center' : 'end'}
      maxVisible={3}
      aria-label={label}
      className={`cc-notify-region cc-notify-region--${placement}`}
    >
      {(item: ToastData<ReactNode>) => {
        const data = item.data as NotificationData
        return (
          <Toast
            className="cc-notify"
            render={(props, state) => (
              <li {...props} inert={state.leaving || (!state.expanded && state.index > 0) || undefined} />
            )}
          >
            <span className="cc-notify-avatar" data-tone={data.tone} aria-hidden="true">
              {data.tone === 'agent' ? <SparklesIcon size={15} /> : data.tone === 'system' ? <BellIcon size={15} /> : data.avatar}
            </span>
            <div className="cc-notify-body">
              <div className="cc-notify-head">
                <span className="cc-notify-title">{item.title as ReactNode}</span>
                <span className="cc-notify-time">{data.at}</span>
              </div>
              {item.description ? <p className="cc-notify-desc">{item.description as ReactNode}</p> : null}
              {data.target && (
                <div className="cc-notify-actions">
                  <button
                    type="button"
                    className="cc-notify-btn"
                    onClick={() => toaster.dismiss(item.id)}
                  >
                    稍后
                  </button>
                  <button
                    type="button"
                    className="cc-notify-btn"
                    data-primary=""
                    onClick={() => {
                      if (data.target) onOpen(data.target, item.id)
                      toaster.dismiss(item.id)
                    }}
                  >
                    {data.actionLabel ?? '查看'}
                  </button>
                </div>
              )}
            </div>
            <ToastClose className="cc-notify-close" aria-label="关闭通知">
              <XIcon size={12} strokeWidth={2.6} />
            </ToastClose>
          </Toast>
        )
      }}
    </ToastRegion>
  )
}
