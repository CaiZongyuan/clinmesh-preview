export const SEX_LABEL = { male: '男', female: '女' } as const
export const VISIT_KIND_LABEL = { first: '初诊', return: '复诊' } as const

const clinicClock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
})

const clinicDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Shanghai' })

export const formatClock = (iso: string) => clinicClock.format(new Date(iso))
export const formatDate = (iso: string) => clinicDate.format(new Date(iso))

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return h > 0 ? `${h}:${mmss}` : mmss
}

const clinicClockSeconds = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
})

export const formatClockSeconds = (iso: string) => clinicClockSeconds.format(new Date(iso))
