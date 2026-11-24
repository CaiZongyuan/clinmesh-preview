import { pane, paneBody, paneHeader } from './pane-styles'

export function CaseWorkspace() {
  return (
    <main aria-label="病例工作区" className={pane}>
      <div className={paneHeader}>
        <h2 className="m-0 text-sm font-semibold">病例工作区</h2>
      </div>
      <div className={`${paneBody} grid place-items-center`}>
        <p className="m-0 p-6 text-center text-[13px] text-muted-foreground">
          从候诊队列选择患者开始接诊后，这里显示患者信息、病历记录、检验检查、诊断与处方。
        </p>
      </div>
      <div className="flex flex-none items-center gap-2 border-t px-3.5 py-2 text-xs text-muted-foreground">
        完诊 <b className="font-mono text-foreground">0/5</b>
      </div>
    </main>
  )
}
