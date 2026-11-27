import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchWhitelistedAction } from '../../apps/patient-miniapp/miniprogram/actions/registry'
import type {
  AppointmentResponse,
  AppointmentSlotsResponse,
  AppointmentsResponse,
  StartAppointmentEncounterResponse,
} from '../../src/shared/appointment'
import type { AuthSessionResponse, PatientReleaseDetailResponse, PatientReleasesResponse } from '../../src/shared/auth'
import type {
  AttachmentAccessResponse,
  ConversationView,
  InitAttachmentResponse,
  MessagesPageResponse,
  SendMessageResponse,
} from '../../src/shared/communication'
import type { ErrorResponse } from '../../src/shared/encounter'
import type { AgentRunSnapshot, FollowupPlanView, FollowupResponseView, FollowupSummaryView } from '../../src/shared/followup'
import type { InvestigationsResponse } from '../../src/shared/investigation'
import { app } from '../../src/worker/app'
import {
  getFakeImSnapshot,
  installImFaultHook,
  preserveRawInt64MessageIds,
  resetFakeImStore,
} from '../../src/worker/communication/wukongim-adapter'
import { clearScriptedLlm } from '../../src/worker/llm/registry'
import { installScripted } from './support/scripted-llm'

function connectedEnv(workspaceName: string, overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    CLINIC_MODE: 'connected',
    CLINIC_WORKSPACE_NAME: workspaceName,
    WECHAT_AUTH_MODE: 'scripted',
    WUKONGIM_MODE: 'fake',
    LLM_PROVIDER: 'scripted',
    ...overrides,
  } as unknown as Env
}

function call(
  testEnv: Env,
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: BodyInit; contentType?: string; token?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.rawBody !== undefined) {
    if (options.contentType) headers['content-type'] = options.contentType
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const request = new Request(`http://clinmesh.test${path}`, {
    method,
    headers,
    body: options.rawBody !== undefined ? options.rawBody : options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return app.fetch(request, testEnv)
}

async function loginPatient(testEnv: Env, code: string, inviteCode: string): Promise<AuthSessionResponse> {
  const res = await call(testEnv, 'POST', '/api/auth/wechat', { body: { code, inviteCode } })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as AuthSessionResponse
}

async function loginStaff(testEnv: Env, username: string, password: string): Promise<AuthSessionResponse> {
  const res = await call(testEnv, 'POST', '/api/auth/staff', { body: { username, password } })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as AuthSessionResponse
}

describe('Connected Clinic S2-S8 independent verifier scenarios (B02-B20)', () => {
  beforeEach(() => {
    installImFaultHook(null)
    resetFakeImStore()
    clearScriptedLlm()
  })

  afterEach(() => {
    installImFaultHook(null)
    clearScriptedLlm()
  })

  it('B02 & B03: enforces idempotent appointment booking, transactional last-seat race, and cancellation capacity restore', async () => {
    const testEnv = connectedEnv('cc-b02-b03')
    const patA = await loginPatient(testEnv, 'wx-code:b02_a', 'CLIN-A-2026')
    const patB = await loginPatient(testEnv, 'wx-code:b02_b', 'CLIN-B-2026')
    const drWang = await loginStaff(testEnv, 'dr.wang', 'demo-doctor-a-pass')

    // Query real open slots for Dr. Wang; slot_wang_d1_02 has capacity = 1.
    const slotsBefore = (await (await call(testEnv, 'GET', '/api/appointments/slots?doctorId=staff_doctor_a', { token: patA.token })).json()) as AppointmentSlotsResponse
    const singleSeat = slotsBefore.slots.find((s) => s.slotId === 'slot_wang_d1_02')!
    expect(singleSeat.capacity).toBe(1)
    expect(singleSeat.remaining).toBe(1)

    // B02: Patient A books with clientRequestId; duplicate submission returns same appointment without double deduction.
    const first = await call(testEnv, 'POST', '/api/appointments', {
      token: patA.token,
      body: { slotId: 'slot_wang_d1_02', clientRequestId: 'req-b02-1', chiefComplaint: '血压复诊' },
    })
    expect(first.status).toBe(201)
    const appt1 = ((await first.json()) as AppointmentResponse).appointment

    const replay = await call(testEnv, 'POST', '/api/appointments', {
      token: patA.token,
      body: { slotId: 'slot_wang_d1_02', clientRequestId: 'req-b02-1', chiefComplaint: '血压复诊' },
    })
    expect(replay.status).toBe(200)
    const apptReplay = ((await replay.json()) as AppointmentResponse).appointment
    expect(apptReplay.appointmentId).toBe(appt1.appointmentId)

    // B03: Patient B competing for the last seat receives 409 slot-full.
    const raceLoss = await call(testEnv, 'POST', '/api/appointments', {
      token: patB.token,
      body: { slotId: 'slot_wang_d1_02', clientRequestId: 'req-b03-b' },
    })
    expect(raceLoss.status).toBe(409)
    expect(((await raceLoss.json()) as ErrorResponse).error.code).toBe('slot-full')

    // Independent verifier checks HIS staff queue reflects exact single booking.
    const staffQueue = (await (await call(testEnv, 'GET', '/api/staff/appointments?doctorId=staff_doctor_a', { token: drWang.token })).json()) as AppointmentsResponse
    expect(staffQueue.appointments.filter((a) => a.slotId === 'slot_wang_d1_02')).toHaveLength(1)

    // Patient B cannot cancel Patient A's appointment (404).
    const unauthorizedCancel = await call(testEnv, 'POST', `/api/appointments/${appt1.appointmentId}/cancel`, { token: patB.token })
    expect(unauthorizedCancel.status).toBe(404)

    // Patient A cancels -> capacity returns to 1 and Patient B can now book cleanly.
    const cancelled = await call(testEnv, 'POST', `/api/appointments/${appt1.appointmentId}/cancel`, { token: patA.token })
    expect(cancelled.status).toBe(200)
    expect(((await cancelled.json()) as AppointmentResponse).appointment.status).toBe('cancelled')

    const bSuccess = await call(testEnv, 'POST', '/api/appointments', {
      token: patB.token,
      body: { slotId: 'slot_wang_d1_02', clientRequestId: 'req-b03-b-retry' },
    })
    expect(bSuccess.status).toBe(201)
  })

  it('B04, B05 & B17 (encounter): links appointment to Encounter, enforces single active conflict without corrupting 2nd appointment, gates releases until formal, and freezes after completion', async () => {
    const testEnv = connectedEnv('cc-b04-b05')
    const patA = await loginPatient(testEnv, 'wx-code:b04_a', 'CLIN-A-2026')
    const patB = await loginPatient(testEnv, 'wx-code:b04_b', 'CLIN-B-2026')
    const drWang = await loginStaff(testEnv, 'dr.wang', 'demo-doctor-a-pass')
    const nurse = await loginStaff(testEnv, 'nurse.zhou', 'demo-nurse-n-pass')

    const apptA = ((await (await call(testEnv, 'POST', '/api/appointments', {
      token: patA.token,
      body: { slotId: 'slot_wang_d1_01', clientRequestId: 'req-b04-a' },
    })).json()) as AppointmentResponse).appointment
    const apptB = ((await (await call(testEnv, 'POST', '/api/appointments', {
      token: patB.token,
      body: { slotId: 'slot_wang_d1_01', clientRequestId: 'req-b04-b' },
    })).json()) as AppointmentResponse).appointment

    // Nurse checks in Patient A; nurse cannot start encounter (403).
    expect((await call(testEnv, 'POST', `/api/appointments/${apptA.appointmentId}/check-in`, { token: nurse.token })).status).toBe(200)
    expect((await call(testEnv, 'POST', `/api/appointments/${apptA.appointmentId}/start-encounter`, { token: nurse.token, body: {} })).status).toBe(403)

    // Doctor starts Encounter from Appointment A.
    const startedRes = await call(testEnv, 'POST', `/api/appointments/${apptA.appointmentId}/start-encounter`, {
      token: drWang.token,
      body: { caseId: 'golden-case-01' },
    })
    expect(startedRes.status).toBe(201)
    const { appointment: startedApptA, encounter } = (await startedRes.json()) as StartAppointmentEncounterResponse
    expect(startedApptA.status).toBe('in_encounter')
    expect(startedApptA.encounterId).toBe(encounter.encounterId)
    expect(encounter.patientId).toBe('pat_01')
    expect(encounter.appointmentId).toBe(apptA.appointmentId)

    // B04: Starting a second active Encounter is refused (409) and leaves Appointment B intact (`booked`).
    const conflict = await call(testEnv, 'POST', `/api/appointments/${apptB.appointmentId}/start-encounter`, {
      token: drWang.token,
      body: {},
    })
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as ErrorResponse).error.code).toBe('active-encounter-exists')
    const bList = (await (await call(testEnv, 'GET', '/api/patient/appointments', { token: patB.token })).json()) as AppointmentsResponse
    expect(bList.appointments[0].status).toBe('booked')
    expect(bList.appointments[0].encounterId).toBeNull()

    // B05: Publishing before signing clinical note or issuing report/rx is refused (`409 release-source-not-ready`).
    for (const resourceType of ['clinical_note', 'report', 'prescription'] as const) {
      const early = await call(testEnv, 'POST', '/api/staff/releases', {
        token: drWang.token,
        body: { encounterId: encounter.encounterId, resourceType },
      })
      expect(early.status, resourceType).toBe(409)
      expect(((await early.json()) as ErrorResponse).error.code).toBe('release-source-not-ready')
    }

    // Complete full formal clinical workflow satisfying all 5 Completion Gates.
    const issuedInv = (await (await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/investigations`, {
      token: drWang.token,
      body: { catalogItemIds: ['cbc'] },
    })).json()) as InvestigationsResponse
    const invId = issuedInv.investigations[0].investigationId
    const releasedInv = (await (await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/investigations/${invId}/instant-release`, {
      token: drWang.token,
    })).json()) as InvestigationsResponse
    const reportId = releasedInv.investigations[0].reports[0].reportId
    expect((await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/report-acknowledgements`, {
      token: drWang.token,
      body: { reportIds: [reportId] },
    })).status).toBe(200)
    expect((await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/diagnosis/revisions`, {
      token: drWang.token,
      body: { entries: [{ code: 'J18.9', primary: true, source: 'doctor' }] },
    })).status).toBe(201)
    expect((await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/prescriptions`, {
      token: drWang.token,
      body: { lines: [{ drugId: 'doxycycline', dose: 1, route: '口服', frequency: 'BID', days: 7 }] },
    })).status).toBe(201)
    expect((await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/clinical-note/revisions`, {
      token: drWang.token,
      body: {
        sections: {
          'chief-complaint': '发热咳嗽 3 天',
          'present-illness': '咳嗽伴黄痰 3 天，无呼吸困难。',
          'past-history': '既往原发性高血压，青霉素皮疹过敏史。',
          findings: '血常规提示白细胞升高。',
          assessment: '呼吸道感染待随访评估。',
          plan: '规范口服多西环素 7 天，72 小时门诊复诊。',
        },
      },
    })).status).toBe(201)

    // Complete encounter -> appointment transitions to completed & encounter writes freeze (B17).
    const completed = await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/completion`, { token: drWang.token })
    expect(completed.status).toBe(200)
    const afterFreeze = await call(testEnv, 'POST', `/api/encounters/${encounter.encounterId}/physical-examinations`, {
      token: drWang.token,
      body: { system: 'vitals' },
    })
    expect(afterFreeze.status).toBe(409)
    const aApptsAfter = (await (await call(testEnv, 'GET', '/api/patient/appointments', { token: patA.token })).json()) as AppointmentsResponse
    expect(aApptsAfter.appointments[0].status).toBe('completed')

    // Before explicit release, patient still sees ONLY seed record (not the newly signed encounter).
    const beforeRel = (await (await call(testEnv, 'GET', '/api/patient/records', { token: patA.token })).json()) as PatientReleasesResponse
    expect(beforeRel.items.some((i) => i.encounterId === encounter.encounterId)).toBe(false)

    // Doctor explicitly publishes note, report, and prescription; nurse is refused (403).
    expect((await call(testEnv, 'POST', '/api/staff/releases', {
      token: nurse.token,
      body: { encounterId: encounter.encounterId, resourceType: 'clinical_note' },
    })).status).toBe(403)

    const noteRel = ((await (await call(testEnv, 'POST', '/api/staff/releases', {
      token: drWang.token,
      body: { encounterId: encounter.encounterId, resourceType: 'clinical_note' },
    })).json()) as PatientReleaseDetailResponse).item
    expect((await call(testEnv, 'POST', '/api/staff/releases', {
      token: drWang.token,
      body: { encounterId: encounter.encounterId, resourceType: 'report', resourceId: invId },
    })).status).toBe(201)
    expect((await call(testEnv, 'POST', '/api/staff/releases', {
      token: drWang.token,
      body: { encounterId: encounter.encounterId, resourceType: 'prescription' },
    })).status).toBe(201)

    // Patient A now reads their published note/report/rx; Patient B cannot read them (404).
    const aNoteDetail = await call(testEnv, 'GET', `/api/patient/records/${noteRel.releaseId}`, { token: patA.token })
    expect(aNoteDetail.status).toBe(200)
    expect((await call(testEnv, 'GET', `/api/patient/records/${noteRel.releaseId}`, { token: patB.token })).status).toBe(404)

    // Retraction immediately hides the release from Patient A too.
    expect((await call(testEnv, 'POST', `/api/staff/releases/${noteRel.releaseId}/retract`, { token: drWang.token })).status).toBe(200)
    expect((await call(testEnv, 'GET', `/api/patient/records/${noteRel.releaseId}`, { token: patA.token })).status).toBe(404)
  })

  it('B07, B08, B09, B10 & B18: validates IM messaging, group membership, uncertain-commit reconciliation, revocation, and local attachments', async () => {
    const testEnv = connectedEnv('cc-b07-b10')
    const patA = await loginPatient(testEnv, 'wx-code:b07_a', 'CLIN-A-2026')
    const patB = await loginPatient(testEnv, 'wx-code:b07_b', 'CLIN-B-2026')
    const drWang = await loginStaff(testEnv, 'dr.wang', 'demo-doctor-a-pass')
    const nurse = await loginStaff(testEnv, 'nurse.zhou', 'demo-nurse-n-pass')

    // B07: Patient A sends text to Doctor A; Doctor A sees identical messageId & sequence and replies.
    const sendA = await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: patA.token,
      body: { clientMessageId: 'msg-b07-1', parts: [{ type: 'text', text: '王医生您好，今天血压 132/82' }] },
    })
    expect(sendA.status).toBe(201)
    const msgA = ((await sendA.json()) as SendMessageResponse).message!

    // B09 (idempotent resend): same clientMessageId returns exact same messageId/sequence, zero duplicates.
    const dupA = await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: patA.token,
      body: { clientMessageId: 'msg-b07-1', parts: [{ type: 'text', text: '王医生您好，今天血压 132/82' }] },
    })
    expect(dupA.status).toBe(201)
    expect(((await dupA.json()) as SendMessageResponse).message!.messageId).toBe(msgA.messageId)

    // B09 (uncertain state after IM persisted): fault fires AFTER WuKongIM persisted; retry reconciles via messagesync with ZERO duplicate seq!
    let failedOnce = false
    installImFaultHook((op, ctx) => {
      if (op === 'send' && ctx.clientMsgNo === 'msg-b09-uncertain' && !failedOnce) {
        failedOnce = true
        throw new Error('simulated network drop after IM commit')
      }
    })
    const uncertainFirst = await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: drWang.token,
      body: { clientMessageId: 'msg-b09-uncertain', parts: [{ type: 'text', text: '收到，继续按时服药' }] },
    })
    expect(uncertainFirst.status).toBe(502)
    installImFaultHook(null)

    const reconciled = await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: drWang.token,
      body: { clientMessageId: 'msg-b09-uncertain', parts: [{ type: 'text', text: '收到，继续按时服药' }] },
    })
    expect(reconciled.status).toBe(201)
    const historyA = (await (await call(testEnv, 'GET', '/api/conversations/conv_pat01_doctor_a/messages', { token: patA.token })).json()) as MessagesPageResponse
    expect(historyA.messages.filter((m) => m.clientMessageId === 'msg-b09-uncertain')).toHaveLength(1)
    expect(getFakeImSnapshot().channels.find((c) => c.channelId === 'cm_conv_pat01_doctor_a')?.messageCount).toBe(2)

    // B07 & B18: Local audio & image attachment upload, uncompleted send refused, signed URL access & expiry enforced.
    const initAudio = await call(testEnv, 'POST', '/api/attachments/init', {
      token: patA.token,
      body: { conversationId: 'conv_pat01_doctor_a', kind: 'audio', mime: 'audio/mpeg', size: 16, durationMs: 3200 },
    })
    expect(initAudio.status).toBe(201)
    const { attachment: pendingAtt, uploadUrl } = (await initAudio.json()) as InitAttachmentResponse

    // Uncompleted attachment cannot be sent (B18).
    const prematureSend = await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: patA.token,
      body: { clientMessageId: 'msg-att-early', parts: [{ type: 'audio', attachmentId: pendingAtt.attachmentId, durationMs: 3200 }] },
    })
    expect(prematureSend.status).toBe(409)
    expect(((await prematureSend.json()) as ErrorResponse).error.code).toBe('attachment-not-ready')

    // Upload bytes + complete -> status ready, honest ASR status (never fabricated).
    const audioBytes = new Uint8Array([73, 68, 51, 3, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7])
    expect((await call(testEnv, 'PUT', uploadUrl, { token: patA.token, rawBody: audioBytes, contentType: 'audio/mpeg' })).status).toBe(200)
    const completedAtt = await call(testEnv, 'POST', `/api/attachments/${pendingAtt.attachmentId}/complete`, {
      token: patA.token,
      body: { requestAsr: true },
    })
    expect(completedAtt.status).toBe(200)
    const completedJson = (await completedAtt.json()) as { attachment: { status: string; transcriptStatus: string; transcriptText: string | null } }
    expect(completedJson.attachment.status).toBe('ready')
    expect(completedJson.attachment.transcriptText).toBeNull()

    // Now sending succeeds; Doctor A accesses signed URL and reads exact bytes; Patient B is refused (404).
    expect((await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: patA.token,
      body: { clientMessageId: 'msg-att-ok', parts: [{ type: 'audio', attachmentId: pendingAtt.attachmentId, durationMs: 3200 }] },
    })).status).toBe(201)

    expect((await call(testEnv, 'GET', `/api/attachments/${pendingAtt.attachmentId}/access`, { token: patB.token })).status).toBe(404)
    const access = (await (await call(testEnv, 'GET', `/api/attachments/${pendingAtt.attachmentId}/access`, { token: drWang.token })).json()) as AttachmentAccessResponse
    const contentRes = await call(testEnv, 'GET', access.url)
    expect(contentRes.status).toBe(200)
    expect(new Uint8Array(await contentRes.arrayBuffer())).toEqual(audioBytes)

    // Expired signed URL is strictly rejected (403 attachment-expired).
    const expiredUrl = access.url.replace(/exp=\d+/, 'exp=1000')
    const expiredRes = await call(testEnv, 'GET', expiredUrl)
    expect(expiredRes.status).toBe(403)
    expect(((await expiredRes.json()) as ErrorResponse).error.code).toBe('attachment-expired')

    // B08 & B10: Staff group creation, inviting FollowUpAgent, rejecting patient addition, removing member blocks future sends.
    const grpRes = await call(testEnv, 'POST', '/api/conversations', {
      token: drWang.token,
      body: { type: 'staff_group', title: '心内全科联合会诊群', memberActorIds: ['actor_nurse_n'] },
    })
    expect(grpRes.status).toBe(201)
    const grp = ((await grpRes.json()) as { conversation: ConversationView }).conversation

    expect((await call(testEnv, 'POST', `/api/conversations/${grp.conversationId}/members`, {
      token: drWang.token,
      body: { actorId: 'actor_pat_01' },
    })).status).toBe(403)
    expect((await call(testEnv, 'POST', `/api/conversations/${grp.conversationId}/members`, {
      token: drWang.token,
      body: { actorId: 'actor_agent_followup' },
    })).status).toBe(200)

    // Remove nurse -> nurse immediately blocked from sending or reading!
    expect((await call(testEnv, 'DELETE', `/api/conversations/${grp.conversationId}/members/actor_nurse_n`, { token: drWang.token })).status).toBe(200)
    expect((await call(testEnv, 'POST', `/api/conversations/${grp.conversationId}/messages`, {
      token: nurse.token,
      body: { clientMessageId: 'after-remove', parts: [{ type: 'text', text: '越权消息' }] },
    })).status).toBe(403)
    expect((await call(testEnv, 'GET', `/api/conversations/${grp.conversationId}/messages`, { token: nurse.token })).status).toBe(404)

    // Patient A logout revokes session, rotates/kicks IM credentials, AND immediately invalidates previously signed attachment URLs (B10/B18).
    const patAccess = (await (await call(testEnv, 'GET', `/api/attachments/${pendingAtt.attachmentId}/access`, { token: patA.token })).json()) as AttachmentAccessResponse
    expect((await call(testEnv, 'GET', patAccess.url)).status).toBe(200)
    const credsBefore = (await (await call(testEnv, 'GET', '/api/im/credentials', { token: patA.token })).json()) as { token: string }
    expect((await call(testEnv, 'POST', '/api/auth/logout', { token: patA.token })).status).toBe(200)
    expect((await call(testEnv, 'GET', '/api/conversations/conv_pat01_doctor_a/messages', { token: patA.token })).status).toBe(401)
    expect((await call(testEnv, 'GET', patAccess.url)).status).toBe(401)
    expect(getFakeImSnapshot().userTokens.pat_01).not.toBe(credsBefore.token)

    // Unwhitelisted card actions are rejected at the message validation boundary (Spec §7.2).
    const badCardRes = await call(testEnv, 'POST', '/api/conversations/conv_pat01_doctor_a/messages', {
      token: drWang.token,
      body: {
        clientMessageId: 'bad-card-action',
        parts: [
          {
            type: 'card',
            component: 'ReportCard',
            version: 1,
            resourceRef: { kind: 'report', id: 'r1' },
            safeProps: { title: '非法跳转测试' },
            actions: [{ name: 'javascript.eval', args: { url: 'https://evil.example' } }],
          },
        ],
      },
    })
    expect(badCardRes.status).toBe(400)

    // 64-bit WuKongIM snowflake message_id digits survive JSON parsing without IEEE-754 rounding (ADR-0004).
    const rawSync = '{"messages":[{"message_id":2126092053442891776,"message_seq":42}]}'
    const parsedSync = JSON.parse(preserveRawInt64MessageIds(rawSync)) as { messages: Array<{ message_id: string }> }
    expect(parsedSync.messages[0].message_id).toBe('2126092053442891776')
  })

  it('B11, B12, B15, B16 & B19: verifies PatientServiceAgentDO tool cards, whitelisted navigation, appointment prefill, safety refusal, and degraded fallback', async () => {
    const testEnv = connectedEnv('cc-b11-b19')
    const patA = await loginPatient(testEnv, 'wx-code:b11_a', 'CLIN-A-2026')
    const drWang = await loginStaff(testEnv, 'dr.wang', 'demo-doctor-a-pass')

    // Case A (B11): Patient asks to view & open latest medical record.
    installScripted('patient_service')
      .toolCall('list_my_medical_records', {})
      .toolCall('open_medical_record', { recordId: 'rel_note_pat01_v1' })
      .reply('已为您查到最近一次已发布病历，并正在为您打开详情页。')

    const sendRecordQuery = await call(testEnv, 'POST', '/api/conversations/conv_pat01_assistant/messages', {
      token: patA.token,
      body: { clientMessageId: 'svc-b11-1', parts: [{ type: 'text', text: '帮我打开最近一次病历' }] },
    })
    expect(sendRecordQuery.status).toBe(201)
    const sentB11 = (await sendRecordQuery.json()) as SendMessageResponse
    expect(sentB11.triggeredAgentRuns).toHaveLength(1)
    const runId1 = sentB11.triggeredAgentRuns[0].runId

    const snap1 = ((await (await call(testEnv, 'GET', `/api/agent/runs/${runId1}`, { token: patA.token })).json()) as { run: AgentRunSnapshot }).run
    expect(snap1.status).toBe('done')
    expect(snap1.cards.some((c) => c.component === 'MedicalRecordCard' && c.resourceRef.id === 'rel_note_pat01_v1')).toBe(true)
    expect(snap1.pendingActions).toHaveLength(1)
    expect(snap1.pendingActions[0].action).toEqual({ name: 'medical.record.open', args: { recordId: 'rel_note_pat01_v1' } })

    // Verify MiniProgram whitelisted Action Registry dispatches exact route & submits result.
    const navigated: string[] = []
    const navResult = await dispatchWhitelistedAction(snap1.pendingActions[0].action, {
      isForeground: () => true,
      navigateTo: ({ url }) => {
        navigated.push(url)
      },
    })
    expect(navResult).toEqual({ ok: true, code: 'dispatched', route: '/pages/records/detail/index?id=rel_note_pat01_v1' })
    expect((await call(testEnv, 'POST', `/api/agent/runs/${runId1}/actions/${snap1.pendingActions[0].callId}/result`, {
      token: patA.token,
      body: { status: 'dispatched', detail: { route: navResult.route } },
    })).status).toBe(200)

    // Verify real WebSocket event replay on /api/agent/runs/:id/socket (hello -> events + replay.done).
    const wsRes = await call(testEnv, 'GET', `/api/agent/runs/${runId1}/socket`, {
      token: patA.token,
      headers: { upgrade: 'websocket' },
    })
    expect(wsRes.status).toBe(101)
    const ws = wsRes.webSocket!
    const frames: string[] = []
    ws.addEventListener('message', (ev) => frames.push(String(ev.data)))
    ws.accept()
    ws.send(JSON.stringify({ type: 'hello', afterSeq: 0 }))
    await new Promise((r) => setTimeout(r, 80))
    ws.close()
    expect(frames.some((f) => f.includes('"type":"replay.done"'))).toBe(true)
    expect(frames.some((f) => f.includes('"type":"run.finished"'))).toBe(true)

    // Verify explicit POST /api/agent/conversations/:id/runs & stopRun(runId) mismatch safety.
    installScripted('patient_service').reply('您好，请问需要什么帮助？')
    const explicitRunRes = await call(testEnv, 'POST', '/api/agent/conversations/conv_pat01_assistant/runs', {
      token: patA.token,
      body: { text: '你好', clientRequestId: 'explicit-run-1' },
    })
    expect(explicitRunRes.status).toBe(201)
    const { runId: explicitRunId } = (await explicitRunRes.json()) as { runId: string }
    const stopFinished = await call(testEnv, 'POST', `/api/agent/runs/${explicitRunId}/stop`, { token: patA.token })
    expect(stopFinished.status).toBe(200)
    expect(((await stopFinished.json()) as { stoppedRunId: string | null }).stoppedRunId).toBeNull()

    // Case B (B12): Agent queries real slots & calls prepare_appointment -> ZERO capacity deducted until patient explicitly confirms!
    installScripted('patient_service')
      .toolCall('list_available_slots', { doctorId: 'staff_doctor_a' })
      .toolCall('prepare_appointment', { slotId: 'slot_wang_d1_02' })
      .reply('王医生明天上午有一个可约号源，请核对卡片并在预约页确认提交。')

    const sendBookQuery = await call(testEnv, 'POST', '/api/conversations/conv_pat01_assistant/messages', {
      token: patA.token,
      body: { clientMessageId: 'svc-b12-1', parts: [{ type: 'text', text: '帮我约王医生明天上午门诊' }] },
    })
    const runId2 = ((await sendBookQuery.json()) as SendMessageResponse).triggeredAgentRuns[0].runId
    const snap2 = ((await (await call(testEnv, 'GET', `/api/agent/runs/${runId2}`, { token: patA.token })).json()) as { run: AgentRunSnapshot }).run
    expect(snap2.cards.some((c) => c.component === 'AppointmentCard' && c.resourceRef.id === 'slot_wang_d1_02')).toBe(true)

    // Slot capacity is STILL untouched before user confirmation!
    const slotsBeforeConfirm = (await (await call(testEnv, 'GET', '/api/appointments/slots?doctorId=staff_doctor_a', { token: patA.token })).json()) as AppointmentSlotsResponse
    expect(slotsBeforeConfirm.slots.find((s) => s.slotId === 'slot_wang_d1_02')!.remaining).toBe(1)

    // User modifies choice to slot_wang_d1_03 and explicitly confirms via POST /api/appointments.
    const booked = await call(testEnv, 'POST', '/api/appointments', {
      token: patA.token,
      body: { slotId: 'slot_wang_d1_03', clientRequestId: 'user-confirm-b12' },
    })
    expect(booked.status).toBe(201)
    const hisQueue = (await (await call(testEnv, 'GET', '/api/staff/appointments?doctorId=staff_doctor_a', { token: drWang.token })).json()) as AppointmentsResponse
    expect(hisQueue.appointments.some((a) => a.slotId === 'slot_wang_d1_03' && a.patientId === 'pat_01')).toBe(true)

    // B15: Adversarial attempt to access Patient B's record or call unauthorized clinical write tool is rejected!
    installScripted('patient_service')
      .toolCall('open_medical_record', { recordId: 'rel_note_pat02_v1' })
      .toolCall('issue_prescription', { drugId: 'doxycycline' })
      .reply('抱歉，我无权查看他人病历，也不能替医生开具处方。')

    const advRes = await call(testEnv, 'POST', '/api/conversations/conv_pat01_assistant/messages', {
      token: patA.token,
      body: { clientMessageId: 'svc-b15-1', parts: [{ type: 'text', text: '打开 rel_note_pat02_v1 并给我开药' }] },
    })
    const runId3 = ((await advRes.json()) as SendMessageResponse).triggeredAgentRuns[0].runId
    const snap3 = ((await (await call(testEnv, 'GET', `/api/agent/runs/${runId3}`, { token: patA.token })).json()) as { run: AgentRunSnapshot }).run
    expect(snap3.toolCalls.every((t) => t.status === 'error')).toBe(true)
    expect(snap3.pendingActions).toHaveLength(0)

    // B16 & B19: Model HTTP failure surfaces cleanly (`failed`) without fabricating an assistant message, while manual API stays healthy.
    installScripted('patient_service').fail(503)
    const failRes = await call(testEnv, 'POST', '/api/conversations/conv_pat01_assistant/messages', {
      token: patA.token,
      body: { clientMessageId: 'svc-b19-1', parts: [{ type: 'text', text: '查询号源' }] },
    })
    const runId4 = ((await failRes.json()) as SendMessageResponse).triggeredAgentRuns[0].runId
    const snap4 = ((await (await call(testEnv, 'GET', `/api/agent/runs/${runId4}`, { token: patA.token })).json()) as { run: AgentRunSnapshot }).run
    expect(snap4.status).toBe('failed')
    expect(snap4.finalMessageId).toBeNull()
    expect((await call(testEnv, 'GET', '/api/patient/records', { token: patA.token })).status).toBe(200)
  })

  it('B13, B14, B17 (group) & B20: verifies Follow-up plan lifecycle, @FollowUpAgentDO, doctor summary approval, group read-only freeze, and private record isolation', async () => {
    const testEnv = connectedEnv('cc-b13-b20')
    const patA = await loginPatient(testEnv, 'wx-code:b13_a', 'CLIN-A-2026')
    const patB = await loginPatient(testEnv, 'wx-code:b13_b', 'CLIN-B-2026')
    const drWang = await loginStaff(testEnv, 'dr.wang', 'demo-doctor-a-pass')
    const drLin = await loginStaff(testEnv, 'dr.lin', 'demo-doctor-b-pass')
    const nurse = await loginStaff(testEnv, 'nurse.zhou', 'demo-nurse-n-pass')

    // Cross-doctor isolation: Doctor B (no care_relationship with pat_01) cannot create a follow-up plan OR followup_group for Patient A (403).
    expect((await call(testEnv, 'POST', '/api/followup/plans', {
      token: drLin.token,
      body: { patientId: 'pat_01', title: '越权随访计划' },
    })).status).toBe(403)
    expect((await call(testEnv, 'POST', '/api/conversations', {
      token: drLin.token,
      body: { type: 'followup_group', title: '越权随访群', memberActorIds: ['actor_pat_01'] },
    })).status).toBe(403)

    // Doctor creates a new follow-up plan -> automatically provisions follow-up group with Patient A, Dr. Wang, Nurse N, and FollowUpAgent.
    const planRes = await call(testEnv, 'POST', '/api/followup/plans', {
      token: drWang.token,
      body: { patientId: 'pat_01', title: '肺炎门诊后 72 小时随访' },
    })
    expect(planRes.status).toBe(201)
    const plan = ((await planRes.json()) as { plan: FollowupPlanView }).plan
    expect(plan.conversationId).toBeTruthy()
    const taskId = plan.tasks[0].taskId

    // Patient B cannot see Patient A's plan or submit responses (404).
    expect((await call(testEnv, 'GET', `/api/followup/plans/${plan.planId}`, { token: patB.token })).status).toBe(404)
    expect((await call(testEnv, 'POST', `/api/followup/tasks/${taskId}/responses`, {
      token: patB.token,
      body: { answers: { symptom_change: '无变化' }, idempotencyKey: 'patb-forged' },
    })).status).toBe(404)

    // B14: Patient A submits follow-up questionnaire; duplicate with same key is idempotent, new key for same task is 409.
    const sub1 = await call(testEnv, 'POST', `/api/followup/tasks/${taskId}/responses`, {
      token: patA.token,
      body: {
        answers: { symptom_change: '明显好转', medication_adherence: '完全按时服药', temperature_or_bp: '36.6℃' },
        idempotencyKey: 'resp-key-1',
      },
    })
    expect(sub1.status).toBe(201)
    const resp1 = ((await sub1.json()) as { response: FollowupResponseView }).response

    const subReplay = await call(testEnv, 'POST', `/api/followup/tasks/${taskId}/responses`, {
      token: patA.token,
      body: { answers: { symptom_change: '明显好转' }, idempotencyKey: 'resp-key-1' },
    })
    expect(subReplay.status).toBe(200)
    expect(((await subReplay.json()) as { response: FollowupResponseView }).response.responseId).toBe(resp1.responseId)

    const subDup = await call(testEnv, 'POST', `/api/followup/tasks/${taskId}/responses`, {
      token: patA.token,
      body: { answers: { symptom_change: '略有好转' }, idempotencyKey: 'resp-key-2' },
    })
    expect(subDup.status).toBe(409)

    // B13: Doctor @FollowUpAgent in group -> calls get_followup_plan + draft_followup_summary -> creates draft summary (NEVER auto-approves).
    installScripted('followup')
      .toolCall('get_followup_plan', {})
      .toolCall('draft_followup_summary', { draftText: '患者体温恢复正常 36.6℃，规律服药，症状明显好转，请王医生审核确认。' })
      .reply('已汇总患者随访反馈并生成待审核摘要草稿，请医生核对确认。')

    const mentionRes = await call(testEnv, 'POST', `/api/conversations/${plan.conversationId}/messages`, {
      token: drWang.token,
      body: {
        clientMessageId: 'fu-mention-1',
        parts: [{ type: 'text', text: '@随访助手 请整理本轮随访摘要' }],
        mentions: ['actor_agent_followup'],
      },
    })
    expect(mentionRes.status).toBe(201)
    const mentionJson = (await mentionRes.json()) as SendMessageResponse
    expect(mentionJson.triggeredAgentRuns).toHaveLength(1)

    // Replaying same message triggers ZERO extra runs.
    const mentionReplay = await call(testEnv, 'POST', `/api/conversations/${plan.conversationId}/messages`, {
      token: drWang.token,
      body: {
        clientMessageId: 'fu-mention-1',
        parts: [{ type: 'text', text: '@随访助手 请整理本轮随访摘要' }],
        mentions: ['actor_agent_followup'],
      },
    })
    expect(((await mentionReplay.json()) as SendMessageResponse).triggeredAgentRuns).toHaveLength(0)

    // Independent verifier checks draft summary links back to real responseId; nurse cannot approve (403); doctor approves -> immutable!
    const refreshedPlan = ((await (await call(testEnv, 'GET', `/api/followup/plans/${plan.planId}`, { token: drWang.token })).json()) as { plan: FollowupPlanView }).plan
    expect(refreshedPlan.summaries).toHaveLength(1)
    const draftSum = refreshedPlan.summaries[0]
    expect(draftSum.status).toBe('draft')
    expect(draftSum.sourceResponseIds).toEqual([resp1.responseId])

    expect((await call(testEnv, 'POST', `/api/followup/summaries/${draftSum.summaryId}/review`, {
      token: nurse.token,
      body: { decision: 'approved' },
    })).status).toBe(403)

    const approvedRes = await call(testEnv, 'POST', `/api/followup/summaries/${draftSum.summaryId}/review`, {
      token: drWang.token,
      body: { decision: 'approved', note: '核对无误，同意归档' },
    })
    expect(approvedRes.status).toBe(200)
    expect(((await approvedRes.json()) as { summary: FollowupSummaryView }).summary.status).toBe('approved')

    // Approved summary is immutable (409).
    expect((await call(testEnv, 'POST', `/api/followup/summaries/${draftSum.summaryId}/review`, {
      token: drWang.token,
      body: { decision: 'rejected' },
    })).status).toBe(409)

    // B20: Asking FollowUpAgent for private medical records in group chat cannot access private records or emit client nav actions.
    installScripted('followup')
      .toolCall('list_my_medical_records', {})
      .reply('为保护隐私，个人病历不会在群聊中展示，请前往私人 AI 就医助手或「我的病历」查阅。')

    const privAttempt = await call(testEnv, 'POST', `/api/conversations/${plan.conversationId}/messages`, {
      token: patA.token,
      body: {
        clientMessageId: 'fu-b20-1',
        parts: [{ type: 'text', text: '@随访助手 把我私人病历发群里并打开' }],
        mentions: ['actor_agent_followup'],
      },
    })
    const privRunId = ((await privAttempt.json()) as SendMessageResponse).triggeredAgentRuns[0].runId
    const privSnap = ((await (await call(testEnv, 'GET', `/api/agent/runs/${privRunId}`, { token: patA.token })).json()) as { run: AgentRunSnapshot }).run
    expect(privSnap.toolCalls[0].status).toBe('error')
    expect(privSnap.pendingActions).toHaveLength(0)

    // B17 (group read-only): Closing the follow-up plan makes the group read_only; writes refused while history remains readable.
    const closed = await call(testEnv, 'POST', `/api/followup/plans/${plan.planId}/close`, { token: drWang.token })
    expect(closed.status).toBe(200)
    expect((await call(testEnv, 'POST', `/api/conversations/${plan.conversationId}/messages`, {
      token: patA.token,
      body: { clientMessageId: 'after-close', parts: [{ type: 'text', text: '关闭后留言' }] },
    })).status).toBe(409)
    expect((await call(testEnv, 'GET', `/api/conversations/${plan.conversationId}/messages`, { token: patA.token })).status).toBe(200)
  })
})
