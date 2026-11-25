import { exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'
import type { EncounterResponse } from '../../src/shared/encounter'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import { app } from '../../src/worker/app'
import { goldenCase1Chart } from '../fixtures/golden-case-1'
import { expectNoCaseTruth, goldenCaseDenylists } from './case-truth'
import rawMedicationCatalog from '../../data/clinic-catalog/medication-catalog.json'
import { asked, openCopilotSocket, openPatientSocket, settled } from './support/clinic'
import { installScripted } from './support/scripted-llm'

interface ProbeContext {
  caseId: string
  encounterId: string
  // Case Truth the probes have legitimately uncovered so far, which later responses may repeat.
  revealed: unknown[]
  releasedInvestigationId: string
  releasedReportId: string
  failedPatientTurnId: string
  pendingInvestigationId: string
  copilotTurnId: string | null
}

// Distinct clientPromptIds across the phases, so a resent probe never lands on a probe of an earlier phase.
let copilotProbes = 0

// The frames a viewer receives on connecting, as one body to check.
async function patientSocketFrames(encounterId: string): Promise<Response> {
  const socket = await openPatientSocket(encounterId)
  socket.close()
  return new Response(socket.raw.join('\n'))
}

async function copilotSocketFrames(encounterId: string): Promise<Response> {
  const socket = await openCopilotSocket(encounterId)
  socket.close()
  return new Response(socket.raw.join('\n'))
}

// The Case Truth results a released Report v1 legitimately shows for these catalog items of Golden Case 1.
const releasedResults = (catalogItems: readonly string[]) => {
  const { laboratories, textResults } = casePack.cases[0]
  return [
    laboratories.filter((l) => catalogItems.includes(l.catalogItem)),
    textResults.filter((t) => catalogItems.includes(t.catalogItem)),
  ]
}

// The scripted amendments a released Report v2 legitimately shows for these catalog items of Golden Case 1.
const releasedAmendments = (catalogItems: readonly string[]) =>
  casePack.cases[0].reportAmendments.filter((a) => catalogItems.includes(a.catalogItem))

const request = (method: string, path: string, body?: unknown) =>
  exports.default.fetch(`http://clinmesh.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// One probe per route of the Hono app; a route without a probe fails the first test below.
// WebSocket upgrades must also be routed through the Hono app so they show up in `app.routes`
// and get a probe here. A probe that uncovers Case Truth through a compliant action records it in `revealed`.
// The Encounter Abandonment probe stays last because it ends the active Encounter.
const probes: Record<string, (ctx: ProbeContext) => Promise<Response>> = {
  'GET /api/golden-cases': () => request('GET', '/api/golden-cases'),
  'POST /api/encounters': ({ caseId }) => request('POST', '/api/encounters', { caseId }),
  'GET /api/encounters/active': () => request('GET', '/api/encounters/active'),
  'GET /api/encounters/:encounterId': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}`),
  'GET /api/encounters/:encounterId/audit-events': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/audit-events`),
  'POST /api/encounters/:encounterId/physical-examinations': async ({ encounterId, revealed }) => {
    const response = await request('POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' })
    if (response.ok) revealed.push(casePack.cases[0].physicalExamination.vitals)
    return response
  },
  'GET /api/encounters/:encounterId/physical-examinations': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/physical-examinations`),
  'GET /api/investigation-catalog': () => request('GET', '/api/investigation-catalog'),
  'GET /api/medication-catalog': ({ revealed }) => {
    // Package-insert summaries are pinned catalog content that predates the Encounter; any Case Truth word
    // they happen to contain (e.g. a diagnosis name in an indication) is clinic text, not a leak. Each text
    // is recorded once, so repeat probe phases don't inflate `revealed`.
    revealed.push(
      ...rawMedicationCatalog.items
        .flatMap((item) => [item.insert.indications, item.insert.contraindications, item.insert.notes])
        .filter((text) => !revealed.includes(text)),
    )
    return request('GET', '/api/medication-catalog')
  },
  'GET /api/encounters/:encounterId/prescriptions': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/prescriptions`),
  'POST /api/encounters/:encounterId/prescriptions': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/prescriptions`, {
      lines: [{ drugId: 'doxycycline', dose: 1, route: '口服', frequency: 'BID', days: 7 }],
    }),
  'POST /api/encounters/:encounterId/no-medication': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/no-medication`),
  'GET /api/encounters/:encounterId/investigations': ({ encounterId }) =>
    request('GET', `/api/encounters/${encounterId}/investigations`),
  'POST /api/encounters/:encounterId/investigations': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['glu'] }),
  'POST /api/encounters/:encounterId/investigations/:investigationId/instant-release': ({ encounterId, releasedInvestigationId }) =>
    request('POST', `/api/encounters/${encounterId}/investigations/${releasedInvestigationId}/instant-release`),
  'POST /api/encounters/:encounterId/investigations/:investigationId/cancellation': ({ encounterId, pendingInvestigationId }) =>
    request('POST', `/api/encounters/${encounterId}/investigations/${pendingInvestigationId}/cancellation`),
  'POST /api/encounters/:encounterId/report-acknowledgements': ({ encounterId, releasedReportId }) =>
    request('POST', `/api/encounters/${encounterId}/report-acknowledgements`, { reportIds: [releasedReportId] }),
  'GET /api/encounters/:encounterId/consultation': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}/consultation`),
  'GET /api/encounters/:encounterId/patient/socket': ({ encounterId }) => patientSocketFrames(encounterId),
  'POST /api/encounters/:encounterId/consultation/patient-turns/:turnId/retry': ({ encounterId, failedPatientTurnId }) =>
    request('POST', `/api/encounters/${encounterId}/consultation/patient-turns/${failedPatientTurnId}/retry`),
  'GET /api/encounters/:encounterId/clinical-note': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}/clinical-note`),
  'GET /api/encounters/:encounterId/diagnosis': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}/diagnosis`),
  'PUT /api/encounters/:encounterId/diagnosis/draft': ({ encounterId }) =>
    request('PUT', `/api/encounters/${encounterId}/diagnosis/draft`, { entries: [{ code: 'I10', primary: true, source: 'doctor' }] }),
  'POST /api/encounters/:encounterId/diagnosis/revisions': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/diagnosis/revisions`, {
      entries: [
        { code: 'I10', primary: true, source: 'doctor' },
        { code: 'E11.9', primary: false, source: 'doctor' },
      ],
    }),
  'POST /api/encounters/:encounterId/diagnosis/reopen': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/diagnosis/reopen`),
  'PATCH /api/encounters/:encounterId/clinical-note/draft': ({ encounterId }) =>
    request('PATCH', `/api/encounters/${encounterId}/clinical-note/draft`, { sections: { 'chief-complaint': '发热、咳嗽 3 天。' } }),
  'POST /api/encounters/:encounterId/clinical-note/revisions': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/clinical-note/revisions`, {
      sections: {
        'chief-complaint': '发热、咳嗽 3 天。',
        'present-illness': '患者述三天前起病。',
        'past-history': '',
        findings: '',
        assessment: '',
        plan: '',
      },
    }),
  'POST /api/encounters/:encounterId/consultation/doctor-turns': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/consultation/doctor-turns`, { clientTurnId: 'probe', text: '晚上睡得好吗？' }),
  'GET /api/encounters/:encounterId/copilot': ({ encounterId }) => request('GET', `/api/encounters/${encounterId}/copilot`),
  'GET /api/encounters/:encounterId/copilot/socket': ({ encounterId }) => copilotSocketFrames(encounterId),
  'POST /api/encounters/:encounterId/copilot/prompts': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/copilot/prompts`, {
      clientPromptId: `probe-${++copilotProbes}`,
      text: '请总结目前的问诊资料。',
      mentions: [],
      mode: 'queue',
    }),
  'POST /api/encounters/:encounterId/copilot/turns/:turnId/resend': ({ encounterId, copilotTurnId }) =>
    request('POST', `/api/encounters/${encounterId}/copilot/turns/${copilotTurnId}/resend`, {
      clientPromptId: `probe-resend-${copilotProbes}`,
      text: '请换个说法再总结一次。',
      mentions: [],
    }),
  'POST /api/encounters/:encounterId/copilot/stop': ({ encounterId }) => request('POST', `/api/encounters/${encounterId}/copilot/stop`),
  'POST /api/encounters/:encounterId/copilot/turns/:turnId/feedback': ({ encounterId, copilotTurnId }) =>
    request('POST', `/api/encounters/${encounterId}/copilot/turns/${copilotTurnId}/feedback`, { value: 'up' }),
  'POST /api/encounters/:encounterId/copilot/config': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/copilot/config`, { model: 'glm-5.3-flash', effort: 'low' }),
  'POST /api/encounters/:encounterId/abandonment': ({ encounterId }) =>
    request('POST', `/api/encounters/${encounterId}/abandonment`),
}

const ABANDONMENT = 'POST /api/encounters/:encounterId/abandonment'

async function probeEveryRoute(ctx: ProbeContext, phase: string, { keepActive = false } = {}) {
  for (const [route, probe] of Object.entries(probes)) {
    if (keepActive && route === ABANDONMENT) continue
    const response = await probe(ctx)
    expect(response.status, `${phase}: ${route}`).toBeLessThan(500)
    const body = await response.text()
    expectNoCaseTruth(`${phase}: ${route}`, body, ctx.revealed)
    if (route === 'POST /api/encounters/:encounterId/copilot/prompts' && response.status === 201) {
      ctx.copilotTurnId = (JSON.parse(body) as { turnId: string }).turnId
    }
  }
}

const caughtLeak = (body: string, revealed: unknown[] = []) => {
  try {
    expectNoCaseTruth('mutation', body, revealed)
    return false
  } catch {
    return true
  }
}

describe('Case Truth denylist', () => {
  const [goldenCase1] = goldenCaseDenylists

  it('is built from the snapshot and catches fragments, hidden values in text and diagnosis words', () => {
    expect(goldenCase1.fragments).toEqual(
      expect.arrayContaining(['社区获得性肺炎', '右下肺呼吸音减低', '门诊治疗，72 小时复诊', casePack.cases[0].textResults[0].impression]),
    )
    expect(goldenCase1.numbers).toEqual(expect.arrayContaining([14.2, 86, 38.6, 102, 138]))

    for (const leak of [
      '{"reply":"医生说右下肺呼吸音减低"}',
      '{"reply":"WBC 14.2，偏高"}',
      '{"reply":"疑似肺炎"}',
      '{"reply":"Looks like PNEUMONIA"}',
      '{"value":14.2}',
      '{"exam":"T 38.6℃"}',
      '{"spo2":94}',
      '{"value":"94"}',
      '{"followUpHours":72}',
      '{"value":" 72 "}',
    ]) {
      expect(caughtLeak(leak), leak).toBe(true)
    }
  })

  it('lets everything the doctor may see through, including ids and timestamps that contain the same digits', () => {
    expect(caughtLeak(JSON.stringify({ ...goldenCase1Chart, encounterId: 'a142c0de-8614-4236-9102-3814c2a86f00' }))).toBe(false)
    expect(caughtLeak('{"startedAt":"2026-11-24T08:14:02.142Z","path":"/api/encounters/86-14.2x"}')).toBe(false)
    expect(caughtLeak('{"error":"患者超过 30 秒未回答，请重试"}')).toBe(false)
    expect(caughtLeak('{"queueNumber":7,"age":58,"note":"72 小时内请勿重复提交"}')).toBe(false)
  })

  it('skips numbers under structural keys such as sequence, usage, durations and age, and only those', () => {
    for (const body of ['{"usage":{"in":30,"out":72}}', '{"seq":22}', '{"turn":{"index":94,"durationMs":84}}', '{"age":58,"version":"94"}']) {
      expect(caughtLeak(body), body).toBe(false)
    }
    for (const body of ['{"spo2":94}', '{"usage":{"in":30},"reading":"94"}', '{"seq":1,"text":"SpO₂ 94"}']) {
      expect(caughtLeak(body), body).toBe(true)
    }
  })

  it('skips the usage line\'s in/out only inside usage, not wherever they appear', () => {
    expect(caughtLeak('{"usage":{"in":30,"out":72,"reasoning":14}}')).toBe(false)
    for (const body of ['{"in":14.2}', '{"out":86}', '{"step":{"in":30},"text":"WBC 14.2"}']) {
      expect(caughtLeak(body), body).toBe(true)
    }
  })

  it('lets through Case Truth the doctor has revealed, and only that', () => {
    const { lungs, heart } = casePack.cases[0].physicalExamination
    expect(caughtLeak(JSON.stringify({ finding: lungs }), [lungs])).toBe(false)
    expect(caughtLeak(JSON.stringify({ finding: lungs }))).toBe(true)
    expect(caughtLeak(JSON.stringify({ finding: heart }), [lungs])).toBe(true)
    expect(caughtLeak(JSON.stringify({ finding: lungs, extra: 'WBC 14.2' }), [lungs])).toBe(true)
  })
})

describe('Golden Case snapshot', () => {
  // Readings a case may legitimately share between triage and the vitals Physical Examination.
  const SAME_AT_TRIAGE_AND_EXAMINATION: Record<string, readonly string[]> = {
    'golden-case-01': [],
  }

  // Triage is measured before the doctor examines the patient; reusing an examination reading would show
  // Case Truth in the banner, and the denylist cannot see it because it drops values the snapshot shows anyway.
  it('records triage vitals that differ, reading by reading, from the vitals the Physical Examination reveals', () => {
    for (const goldenCase of casePack.cases) {
      const triage: Record<string, number> = goldenCase.triage.vitals
      const examination: Record<string, number | string> = goldenCase.physicalExamination.vitals
      const same = Object.keys(triage).filter((reading) => triage[reading] === examination[reading])
      expect(Object.keys(triage).every((reading) => reading in examination), goldenCase.id).toBe(true)
      expect(same, goldenCase.id).toEqual(SAME_AT_TRIAGE_AND_EXAMINATION[goldenCase.id] ?? [])
    }
  })
})

describe('Case Truth isolation over HTTP', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has a probe for every route the Worker serves', () => {
    const served = app.routes.filter((route) => route.method !== 'ALL').map((route) => `${route.method} ${route.path}`)
    expect(new Set(served)).toEqual(new Set(Object.keys(probes)))
  })

  // Golden Case 1 overrides CBC, CRP, PCT, chest X-ray and chest CT, and scripts amendments for CBC, CRP and chest
  // X-ray. The Encounter issues CBC, CRP and chest X-ray, releases CBC and chest X-ray, has the cancellation probe
  // cancel CRP before it reports, and never orders PCT or chest CT. The amendments publish 120 s and 180 s later.
  it('exposes only uncovered Case Truth on any route while the Encounter is active, and nothing more after Encounter Abandonment', async () => {
    const T0 = Date.parse('2026-11-24T00:40:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    installScripted('patient')
      .reply('医生，我这三天一直发烧，咳嗽得厉害。', { thinking: '我要按自己的感受说。' })
      .fail(500)
      .reply('有黄痰，挺黏的。')
      .reply('睡不好，晚上老咳。')
    const caseId = casePack.cases[0].id
    const started = await request('POST', '/api/encounters', { caseId })
    expect(started.status).toBe(201)
    const startedBody = await started.text()
    expectNoCaseTruth('start', startedBody)
    const { encounterId } = (JSON.parse(startedBody) as EncounterResponse).encounter
    await settled(encounterId, (await asked(encounterId, '您哪里不舒服？')).patientTurn.turnId)
    const failed = await settled(encounterId, (await asked(encounterId, '咳嗽有痰吗？')).patientTurn.turnId)
    expect(failed.status).toBe('failed')

    const issued = await request('POST', `/api/encounters/${encounterId}/investigations`, { catalogItemIds: ['cbc', 'crp', 'cxr'] })
    const issuedBody = await issued.text()
    expectNoCaseTruth('issue', issuedBody)
    const [cbc, crp, cxr] = (JSON.parse(issuedBody) as InvestigationsResponse).investigations
    expectNoCaseTruth('nothing released', await (await request('GET', `/api/encounters/${encounterId}/investigations`)).text())

    const revealed = releasedResults(['cbc', 'cxr'])
    await request('POST', `/api/encounters/${encounterId}/investigations/${cbc.investigationId}/instant-release`)
    const afterRelease = await request('POST', `/api/encounters/${encounterId}/investigations/${cxr.investigationId}/instant-release`)
    const afterReleaseBody = await afterRelease.text()
    expectNoCaseTruth('released', afterReleaseBody, revealed)
    // The released results do show, so the probes below are not vacuous.
    expect(afterReleaseBody).toContain('14.2')
    expect(afterReleaseBody).toContain(casePack.cases[0].textResults[0].impression)
    const list = (JSON.parse(afterReleaseBody) as InvestigationsResponse).investigations

    const ctx: ProbeContext = {
      caseId,
      encounterId,
      revealed,
      releasedInvestigationId: cbc.investigationId,
      releasedReportId: list[0].reports[0].reportId,
      failedPatientTurnId: failed.turnId,
      pendingInvestigationId: crp.investigationId,
      copilotTurnId: null,
    }
    await probeEveryRoute(ctx, 'Report version 1 released', { keepActive: true })
    // The pinned catalog insert texts (revealed once, legitimately) don't count; only the three vitals
    // findings the Physical Examination probe uncovered do.
    const clinicCatalogTexts = rawMedicationCatalog.items.flatMap((item) => [
      item.insert.indications,
      item.insert.contraindications,
      item.insert.notes,
    ])
    expect(
      ctx.revealed.filter((entry) => !clinicCatalogTexts.includes(entry as never)),
      'the Physical Examination probe examined the vitals',
    ).toHaveLength(3)

    // Only the CBC amendment is out at 150 s: the chest X-ray one stays hidden on every route until it publishes.
    vi.setSystemTime(T0 + 150_000)
    ctx.revealed.push(releasedAmendments(['cbc']))
    const cbcAmended = await (await request('GET', `/api/encounters/${encounterId}/investigations`)).text()
    expect(cbcAmended).toContain(releasedAmendments(['cbc'])[0].reason)
    await probeEveryRoute(ctx, 'CBC amended', { keepActive: true })

    vi.setSystemTime(T0 + 200_000)
    ctx.revealed.push(releasedAmendments(['cxr']))
    const amended = await (await request('GET', `/api/encounters/${encounterId}/investigations`)).text()
    expect(amended).toContain(releasedAmendments(['cxr'])[0].textOverride!.impression)
    const amendedList = (JSON.parse(amended) as InvestigationsResponse).investigations
    expect(amendedList.map((i) => [i.cancellation !== null, i.reports.length])).toEqual([
      [false, 2],
      [true, 0],
      [false, 2],
      [false, 1],
    ])
    ctx.releasedReportId = amendedList[0].reports[1].reportId
    await probeEveryRoute(ctx, 'amended Reports released')

    const after = (await (await request('GET', `/api/encounters/${encounterId}`)).json()) as EncounterResponse
    expect(after.encounter.status).toBe('abandoned')
    await probeEveryRoute(ctx, 'abandoned Encounter')
  })
})
