import { Button } from '@ui-sdk/react/button'
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import type { EncounterView } from '../../shared/encounter'
import type { PhysicalExaminationView } from '../../shared/physical-examination'
import { iconButton, pane, paneBody, paneHeader } from './pane-styles'
import { PhysicalExaminationPanel, PhysicalExaminationRow } from './physical-examination'

export interface EncounterContext {
  encounter: EncounterView
  examinations: PhysicalExaminationView[]
}

export function ConsultationColumn({ encounter, onCollapse }: { encounter?: EncounterContext; onCollapse: () => void }) {
  const examinations = encounter?.examinations ?? []
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
        {examinations.length === 0 ? (
          <p className="m-0 p-4 text-[13px] text-muted-foreground">接诊开始后，医患对话会实时转写在这里。</p>
        ) : (
          <ol aria-label="问诊转写" className="m-0 flex list-none flex-col gap-2 p-3">
            {examinations.map((examination) => (
              <PhysicalExaminationRow key={examination.system} examination={examination} />
            ))}
          </ol>
        )}
      </div>
      {encounter && (
        <div className="flex-none border-t px-3.5 py-2">
          <PhysicalExaminationPanel encounter={encounter.encounter} examinations={examinations} />
        </div>
      )}
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
