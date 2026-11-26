import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type {
  AuthSessionResponse,
  ContactView,
  DemoResetResponse,
  DepartmentView,
  DoctorView,
  MeResponse,
  PatientReleaseDetailResponse,
  PatientReleasesResponse,
} from '../../src/shared/auth'
import type { AuditEventsResponse, EncounterResponse, ErrorResponse } from '../../src/shared/encounter'
import { app } from '../../src/worker/app'
import { CONNECTED_WORKSPACE_NAME, WORKSPACE_NAME } from '../../src/worker/workspace-name'

function connectedEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    CLINIC_MODE: 'connected',
    CLINIC_WORKSPACE_NAME: CONNECTED_WORKSPACE_NAME,
    WECHAT_AUTH_MODE: 'scripted',
    ...overrides,
  } as unknown as Env
}

function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string>; customEnv?: Env } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const request = new Request(`http://clinmesh.test${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return app.fetch(request, options.customEnv ?? connectedEnv())
}

async function loginWeChat(code: string, inviteCode?: string, customEnv?: Env): Promise<AuthSessionResponse> {
  const res = await call('POST', '/api/auth/wechat', {
    body: inviteCode === undefined ? { code } : { code, inviteCode },
    customEnv,
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as AuthSessionResponse
}

async function loginStaff(username: string, password: string, customEnv?: Env): Promise<AuthSessionResponse> {
  const res = await call('POST', '/api/auth/staff', { body: { username, password }, customEnv })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as AuthSessionResponse
}

describe('Connected Clinic S1: auth, WeChat binding, RBAC, isolation and resettable seed', () => {
  it('B01: binds WeChat patient identity via valid invite code, rejects missing/invalid/expired/claimed codes, and revokes on logout', async () => {
    const testEnv = connectedEnv({ CLINIC_WORKSPACE_NAME: 'connected-b01' })

    // Missing invite code on first login -> 403
    const missing = await call('POST', '/api/auth/wechat', { body: { code: 'wx-code:user_b01_a' }, customEnv: testEnv })
    expect(missing.status).toBe(403)
    expect(((await missing.json()) as ErrorResponse).error.code).toBe('invite-code-required')

    // Invalid invite code -> 403
    const invalid = await call('POST', '/api/auth/wechat', {
      body: { code: 'wx-code:user_b01_a', inviteCode: 'NO-SUCH-CODE' },
      customEnv: testEnv,
    })
    expect(invalid.status).toBe(403)
    expect(((await invalid.json()) as ErrorResponse).error.code).toBe('invite-code-invalid')

    // Expired invite code -> 403
    const expired = await call('POST', '/api/auth/wechat', {
      body: { code: 'wx-code:user_b01_exp', inviteCode: 'CLIN-EXP-2025' },
      customEnv: testEnv,
    })
    expect(expired.status).toBe(403)
    expect(((await expired.json()) as ErrorResponse).error.code).toBe('invite-code-expired')

    // Valid invite code binds Patient A (case-insensitive)
    const first = await loginWeChat('wx-code:user_b01_a', 'clin-a-2026', testEnv)
    expect(first.principal.role).toBe('patient')
    expect(first.principal.patientId).toBe('pat_01')
    expect(first.principal.actorId).toBe('actor_pat_01')
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain('wx_openid_')
    expect(serialized).not.toContain('session_key')
    expect(serialized).not.toContain('password_hash')

    // Repeat login with same openid returns same bound patient without invite code, and ignores another patient's invite code
    const repeat = await loginWeChat('wx-code:user_b01_a', 'CLIN-B-2026', testEnv)
    expect(repeat.principal.patientId).toBe('pat_01')
    expect(repeat.token).not.toBe(first.token)

    // Another WeChat user cannot hijack already-bound Patient A's invite code -> 409
    const hijack = await call('POST', '/api/auth/wechat', {
      body: { code: 'wx-code:user_b01_intruder', inviteCode: 'CLIN-A-2026' },
      customEnv: testEnv,
    })
    expect(hijack.status).toBe(409)
    expect(((await hijack.json()) as ErrorResponse).error.code).toBe('patient-already-bound')

    // GET /api/me returns principal; logout revokes token immediately
    const me = await call('GET', '/api/me', { token: first.token, customEnv: testEnv })
    expect(me.status).toBe(200)
    expect(((await me.json()) as MeResponse).principal.patientId).toBe('pat_01')

    const logout = await call('POST', '/api/auth/logout', { token: first.token, customEnv: testEnv })
    expect(logout.status).toBe(200)

    const afterLogout = await call('GET', '/api/me', { token: first.token, customEnv: testEnv })
    expect(afterLogout.status).toBe(401)
    expect(((await afterLogout.json()) as ErrorResponse).error.code).toBe('unauthorized')

    // Real WeChat mode without AppID/AppSecret refuses cleanly with 503
    const unconfiguredEnv = connectedEnv({ CLINIC_WORKSPACE_NAME: 'connected-b01', WECHAT_AUTH_MODE: undefined })
    const unconfigured = await call('POST', '/api/auth/wechat', { body: { code: 'real-wx-code' }, customEnv: unconfiguredEnv })
    expect(unconfigured.status).toBe(503)
    expect(((await unconfigured.json()) as ErrorResponse).error.code).toBe('wechat-not-configured')
  })

  it('B06: enforces cross-patient resource isolation and blocks patients from all clinical HTTP and WS routes', async () => {
    const testEnv = connectedEnv({ CLINIC_WORKSPACE_NAME: 'connected-b06' })
    const doctorA = await loginStaff('dr.wang', 'demo-doctor-a-pass', testEnv)
    const patientA = await loginWeChat('wx-code:b06_pat_a', 'CLIN-A-2026', testEnv)
    const patientB = await loginWeChat('wx-code:b06_pat_b', 'CLIN-B-2026', testEnv)

    // Doctor starts an active encounter in Connected Clinic workspace
    const started = await call('POST', '/api/encounters', {
      body: { caseId: 'golden-case-01' },
      token: doctorA.token,
      customEnv: testEnv,
    })
    expect(started.status).toBe(201)
    const { encounterId } = ((await started.json()) as EncounterResponse).encounter

    // Patient A sees ONLY A's non-retracted releases
    const aRecords = (await (await call('GET', '/api/patient/records', { token: patientA.token, customEnv: testEnv })).json()) as PatientReleasesResponse
    expect(aRecords.items.map((item) => item.releaseId)).toEqual(['rel_note_pat01_v1'])

    const aRecordDetail = await call('GET', '/api/patient/records/rel_note_pat01_v1', { token: patientA.token, customEnv: testEnv })
    expect(aRecordDetail.status).toBe(200)
    expect(((await aRecordDetail.json()) as PatientReleaseDetailResponse).item.resourceId).toBe('hist_note_pat01_202609')

    // Retracted record is inaccessible even to its own patient
    const retracted = await call('GET', '/api/patient/records/rel_note_pat01_retracted', { token: patientA.token, customEnv: testEnv })
    expect(retracted.status).toBe(404)

    // Patient B cannot read Patient A's records or reports (by releaseId or resourceId)
    for (const path of [
      '/api/patient/records/rel_note_pat01_v1',
      '/api/patient/records/hist_note_pat01_202609',
      '/api/patient/reports/rel_rep_pat01_v1',
      '/api/patient/reports/hist_rep_pat01_lipid',
    ]) {
      const denied = await call('GET', path, { token: patientB.token, customEnv: testEnv })
      expect(denied.status, path).toBe(404)
    }

    // Patient B sees only B's releases and zero prescriptions
    const bRecords = (await (await call('GET', '/api/patient/records', { token: patientB.token, customEnv: testEnv })).json()) as PatientReleasesResponse
    expect(bRecords.items.map((item) => item.releaseId)).toEqual(['rel_note_pat02_v1'])
    const bRx = (await (await call('GET', '/api/patient/prescriptions', { token: patientB.token, customEnv: testEnv })).json()) as PatientReleasesResponse
    expect(bRx.items).toEqual([])

    // Contacts: Patient A sees ONLY care team + Patient Service Agent, NEVER other patients
    const aContacts = (await (await call('GET', '/api/contacts', { token: patientA.token, customEnv: testEnv })).json()) as { contacts: ContactView[] }
    expect(aContacts.contacts.map((c) => c.actorId)).toEqual(['actor_agent_patient_svc', 'actor_doctor_a', 'actor_nurse_n'])
    expect(aContacts.contacts.some((c) => c.role === 'patient')).toBe(false)

    // Staff cannot access patient-only portal endpoints
    const staffOnPatientPortal = await call('GET', '/api/patient/records', { token: doctorA.token, customEnv: testEnv })
    expect(staffOnPatientPortal.status).toBe(403)

    // Patient A is strictly blocked (403) from EVERY legacy clinical HTTP & WS route, even with known encounterId
    const forbiddenForPatient: Array<[string, string, unknown?, Record<string, string>?]> = [
      ['GET', '/api/golden-cases'],
      ['GET', '/api/encounters/active'],
      ['POST', '/api/encounters', { caseId: 'golden-case-01' }],
      ['GET', `/api/encounters/${encounterId}`],
      ['GET', `/api/encounters/${encounterId}/audit-events`],
      ['GET', `/api/encounters/${encounterId}/debrief`],
      ['POST', `/api/encounters/${encounterId}/physical-examinations`, { system: 'vitals' }],
      ['GET', `/api/encounters/${encounterId}/investigations`],
      ['GET', `/api/encounters/${encounterId}/clinical-note`],
      ['GET', `/api/encounters/${encounterId}/diagnosis`],
      ['GET', `/api/encounters/${encounterId}/prescriptions`],
      ['GET', `/api/encounters/${encounterId}/consultation`],
      ['GET', `/api/encounters/${encounterId}/copilot`],
      ['GET', `/api/encounters/${encounterId}/copilot/context`],
      ['GET', `/api/encounters/${encounterId}/patient/socket`, undefined, { upgrade: 'websocket' }],
      ['GET', `/api/encounters/${encounterId}/copilot/socket`, undefined, { upgrade: 'websocket' }],
      ['GET', `/api/encounters/${encounterId}/copilot/bridge`, undefined, { upgrade: 'websocket' }],
      ['GET', `/api/encounters/${encounterId}/voice`, undefined, { upgrade: 'websocket' }],
    ]
    for (const [method, path, body, headers] of forbiddenForPatient) {
      const res = await call(method, path, { body, headers, token: patientA.token, customEnv: testEnv })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(((await res.json()) as ErrorResponse).error.code).toBe('forbidden')
    }
  })

  it('enforces connected-mode auth, attributes clinical writes to real authenticated doctor, blocks nurse formal writes, and isolates from simulation workspace', async () => {
    const testEnv = connectedEnv({ CLINIC_WORKSPACE_NAME: 'connected-rbac' })

    // Unauthenticated requests in connected mode -> 401
    expect((await call('GET', '/api/golden-cases', { customEnv: testEnv })).status).toBe(401)
    expect((await call('POST', '/api/encounters', { body: { caseId: 'golden-case-01' }, customEnv: testEnv })).status).toBe(401)
    expect((await call('GET', '/api/encounters/active', { customEnv: testEnv })).status).toBe(401)

    // Invalid staff password -> 401
    const badStaff = await call('POST', '/api/auth/staff', {
      body: { username: 'dr.wang', password: 'wrong-password' },
      customEnv: testEnv,
    })
    expect(badStaff.status).toBe(401)

    const doctorA = await loginStaff('dr.wang', 'demo-doctor-a-pass', testEnv)
    const nurseN = await loginStaff('nurse.zhou', 'demo-nurse-n-pass', testEnv)
    expect(doctorA.principal.staffId).toBe('staff_doctor_a')
    expect(nurseN.principal.staffId).toBe('staff_nurse_n')

    // Directory reads succeed for authenticated staff
    const depts = (await (await call('GET', '/api/clinic/departments', { token: doctorA.token, customEnv: testEnv })).json()) as {
      departments: DepartmentView[]
    }
    expect(depts.departments.map((d) => d.departmentId)).toEqual(['dept_cardiology', 'dept_general'])
    const doctors = (await (await call('GET', '/api/clinic/doctors', { token: doctorA.token, customEnv: testEnv })).json()) as {
      doctors: DoctorView[]
    }
    expect(doctors.doctors.map((d) => d.staffId)).toEqual(['staff_doctor_a', 'staff_doctor_b'])

    // Nurse cannot start encounter -> 403
    const nurseStart = await call('POST', '/api/encounters', {
      body: { caseId: 'golden-case-01' },
      token: nurseN.token,
      customEnv: testEnv,
    })
    expect(nurseStart.status).toBe(403)

    // Direct DO transactional check also refuses nurse (no TOCTOU bypass)
    const doRefusal = await env.CLINIC_WORKSPACE.getByName('connected-rbac').startEncounter('golden-case-01', 'staff_nurse_n')
    expect(doRefusal.ok).toBe(false)
    if (!doRefusal.ok) expect(doRefusal.error.code).toBe('forbidden')

    // Doctor A starts encounter -> attributed to staff_doctor_a (NOT demo-practitioner)
    const started = await call('POST', '/api/encounters', {
      body: { caseId: 'golden-case-01' },
      token: doctorA.token,
      customEnv: testEnv,
    })
    expect(started.status).toBe(201)
    const { encounter } = (await started.json()) as EncounterResponse
    expect(encounter.practitionerId).toBe('staff_doctor_a')

    // Phase 1 simulation default workspace remains completely separate (no active encounter there)
    const simActive = await env.CLINIC_WORKSPACE.getByName(WORKSPACE_NAME).getActiveEncounter()
    expect(simActive).toBeNull()

    // Nurse can view active encounter read-only, but cannot perform exam, prescribe, diagnose, sign note, or view debrief
    expect((await call('GET', `/api/encounters/${encounter.encounterId}`, { token: nurseN.token, customEnv: testEnv })).status).toBe(200)
    expect((await call('POST', `/api/encounters/${encounter.encounterId}/physical-examinations`, {
      body: { system: 'vitals' },
      token: nurseN.token,
      customEnv: testEnv,
    })).status).toBe(403)
    expect((await call('GET', `/api/encounters/${encounter.encounterId}/debrief`, { token: nurseN.token, customEnv: testEnv })).status).toBe(403)

    // Doctor A performs examination -> audit log attributes to staff_doctor_a
    const exam = await call('POST', `/api/encounters/${encounter.encounterId}/physical-examinations`, {
      body: { system: 'vitals' },
      token: doctorA.token,
      customEnv: testEnv,
    })
    expect(exam.status).toBe(201)

    const audits = (await (await call('GET', `/api/encounters/${encounter.encounterId}/audit-events`, {
      token: doctorA.token,
      customEnv: testEnv,
    })).json()) as AuditEventsResponse
    expect(audits.auditEvents.map((e) => [e.eventType, e.practitionerId])).toEqual([
      ['encounter-started', 'staff_doctor_a'],
      ['physical-examination-performed', 'staff_doctor_a'],
    ])
  })

  it('guards /api/demo/reset behind DEMO_RESET_ENABLED and wipes sessions and bindings cleanly on reset', async () => {
    const disabledEnv = connectedEnv({ CLINIC_WORKSPACE_NAME: 'connected-reset' })
    const refused = await call('POST', '/api/demo/reset', { customEnv: disabledEnv })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as ErrorResponse).error.code).toBe('demo-reset-disabled')

    const enabledEnv = connectedEnv({ CLINIC_WORKSPACE_NAME: 'connected-reset', DEMO_RESET_ENABLED: 'true' })
    const patientA = await loginWeChat('wx-code:reset_user_1', 'CLIN-A-2026', enabledEnv)
    expect((await call('GET', '/api/me', { token: patientA.token, customEnv: enabledEnv })).status).toBe(200)

    const reset = await call('POST', '/api/demo/reset', { customEnv: enabledEnv })
    expect(reset.status).toBe(200)
    const summary = (await reset.json()) as DemoResetResponse
    expect(summary).toMatchObject({
      workspace: 'connected-reset',
      departments: 2,
      staff: 3,
      patients: 4,
      slots: 30,
      releases: 6,
    })

    // Previous session token is invalidated immediately after reset
    expect((await call('GET', '/api/me', { token: patientA.token, customEnv: enabledEnv })).status).toBe(401)

    // Invite code can be cleanly bound by a fresh WeChat account after reset
    const freshA = await loginWeChat('wx-code:reset_user_2', 'CLIN-A-2026', enabledEnv)
    expect(freshA.principal.patientId).toBe('pat_01')
  })
})
