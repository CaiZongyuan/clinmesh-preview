import { Link } from '@tanstack/react-router'

export type ClinicTabParam = 'dashboard' | 'appointments' | 'patients' | 'messages' | 'followup' | 'runs'

export type UnifiedNavKey = 'clinical' | ClinicTabParam

const CLINIC_NAV_ITEMS: ReadonlyArray<{ key: ClinicTabParam; label: string }> = [
  { key: 'dashboard', label: '门诊总览' },
  { key: 'appointments', label: '预约队列' },
  { key: 'patients', label: '患者档案' },
  { key: 'messages', label: '消息中心' },
  { key: 'followup', label: '随访管理' },
]

export function DoctorMastheadNav({ active, activeEncounterId }: { active: UnifiedNavKey; activeEncounterId?: string | null }) {
  return (
    <nav aria-label="医生端模块导航" className="masthead-nav">
      {activeEncounterId ? (
        <Link
          to="/encounters/$encounterId"
          params={{ encounterId: activeEncounterId }}
          className="masthead-nav-link"
          data-active={active === 'clinical' || undefined}
        >
          临床接诊
        </Link>
      ) : (
        <Link to="/" className="masthead-nav-link" data-active={active === 'clinical' || undefined}>
          临床接诊
        </Link>
      )}
      {CLINIC_NAV_ITEMS.map((item) => (
        <Link
          key={item.key}
          to="/clinic"
          search={{ tab: item.key }}
          className="masthead-nav-link"
          data-active={active === item.key || undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
