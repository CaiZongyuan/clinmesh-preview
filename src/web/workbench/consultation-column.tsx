import { Button } from '@ui-sdk/react/button'
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import { iconButton, pane, paneBody, paneHeader } from './pane-styles'

export function ConsultationColumn({ onCollapse }: { onCollapse: () => void }) {
  return (
    <section aria-label="问诊记录" className={pane}>
      <div className={paneHeader}>
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">问诊记录</h2>
          <p className="m-0 truncate text-[11px] text-muted-foreground">模拟患者只按版本固定的 Patient Persona 应答</p>
        </div>
        <Button aria-label="收起问诊记录" className={iconButton} onClick={onCollapse}>
          <PanelLeftCloseIcon aria-hidden="true" size={16} />
        </Button>
      </div>
      <div className={paneBody}>
        <p className="m-0 p-4 text-[13px] text-muted-foreground">接诊开始后，医患对话会实时转写在这里。</p>
      </div>
    </section>
  )
}

export function ConsultationStrip({ onExpand }: { onExpand: () => void }) {
  return (
    <section aria-label="问诊记录（已收起）" className={`${pane} items-center gap-2.5 py-2`}>
      <Button aria-label="展开问诊记录" className={iconButton} onClick={onExpand}>
        <PanelLeftOpenIcon aria-hidden="true" size={16} />
      </Button>
      <span aria-hidden="true" className="text-[13px] tracking-[2px] text-muted-foreground [writing-mode:vertical-rl]">
        问诊记录
      </span>
    </section>
  )
}
