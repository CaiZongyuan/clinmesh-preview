import { SparklesIcon } from 'lucide-react'
import { pane, paneBody, paneHeader } from './pane-styles'

export function CopilotPanel() {
  return (
    <aside aria-label="临床助手" className={pane}>
      <div className={paneHeader}>
        <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
          <SparklesIcon aria-hidden="true" size={15} className="text-info" />
          临床助手
        </h2>
        <span className="text-xs text-muted-foreground">未接诊</span>
      </div>
      <div className={paneBody}>
        <p className="m-0 p-4 text-[13px] text-muted-foreground">
          接诊开始后，临床助手会随问诊、查体与报告自动分析，并把草稿写入病例工作区。
        </p>
      </div>
    </aside>
  )
}
