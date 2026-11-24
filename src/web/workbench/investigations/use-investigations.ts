import { useCallback, useEffect, useState } from 'react'
import type { EncounterView } from '../../../shared/encounter'
import type { CatalogItemView, InvestigationView } from '../../../shared/investigation'
import {
  acknowledgeReports,
  fetchInvestigationCatalog,
  fetchInvestigations,
  issueInvestigations,
  releaseInvestigationNow,
} from '../../api'

const POLL_MS = 2000

export const latestReport = (investigation: InvestigationView) => investigation.reports.at(-1)
export const awaitingAcknowledgement = (investigation: InvestigationView) => {
  const report = latestReport(investigation)
  return !!report && !report.acknowledgement
}

// The 检验检查 tab's state: the catalog, the doctor's pending list (a local Draft until issued) and the
// Encounter's issued Investigations, re-read while any Report is still due.
export function useInvestigations(encounter: EncounterView) {
  const { encounterId, status } = encounter
  const [catalog, setCatalog] = useState<CatalogItemView[]>([])
  const [investigations, setInvestigations] = useState<InvestigationView[]>([])
  const [pending, setPending] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    fetchInvestigationCatalog()
      .then((items) => current && setCatalog(items))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : '检查目录加载失败'))
    return () => {
      current = false
    }
  }, [])

  const awaitingReports = status === 'active' && investigations.some((i) => i.reports.length === 0)
  useEffect(() => {
    let current = true
    const refresh = () =>
      fetchInvestigations(encounterId)
        .then((list) => current && setInvestigations(list))
        .catch((e: unknown) => current && setError(e instanceof Error ? e.message : '检查申请加载失败'))
    void refresh()
    const timer = awaitingReports ? setInterval(refresh, POLL_MS) : undefined
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [encounterId, status, awaitingReports])

  const run = useCallback(async (command: () => Promise<InvestigationView[]>, fallback: string) => {
    setError(null)
    try {
      setInvestigations(await command())
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback)
      throw e
    }
  }, [])

  return {
    catalog,
    investigations,
    pending,
    error,
    pendingCount: pending.length + investigations.filter(awaitingAcknowledgement).length,
    add: (id: string) => setPending((list) => (list.includes(id) ? list : [...list, id])),
    remove: (id: string) => setPending((list) => list.filter((item) => item !== id)),
    clear: () => setPending([]),
    issue: async () => {
      await run(() => issueInvestigations(encounterId, pending), '开立检查失败')
      setPending([])
    },
    releaseNow: (investigationId: string) =>
      run(() => releaseInvestigationNow(encounterId, investigationId), '出报告失败').catch(() => {}),
    acknowledge: (reportIds: string[]) => run(() => acknowledgeReports(encounterId, reportIds), '确认已阅失败'),
  }
}

export type Investigations = ReturnType<typeof useInvestigations>
