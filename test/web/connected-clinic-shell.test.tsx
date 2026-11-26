import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStaffToken } from '../../src/web/api'
import { createAppRouter } from '../../src/web/router'

describe('Connected Clinic HIS Web shell (/clinic)', () => {
  afterEach(() => {
    setStaffToken(null)
    vi.restoreAllMocks()
  })

  it('logs in as Dr. Wang, navigates appointments, messages, and follow-up review actions with accessible named controls', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/auth/staff') && method === 'POST') {
        return Response.json({
          token: 'test-staff-token',
          principal: {
            sessionId: 'sess_1',
            accountId: 'acct_staff_doctor_a',
            actorId: 'actor_doctor_a',
            clinicId: 'clinic_clinmesh_demo',
            kind: 'human',
            role: 'doctor',
            displayName: '王明',
            imUid: 'staff_doctor_a',
            patientId: null,
            staffId: 'staff_doctor_a',
            departmentId: 'dept_general',
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
        })
      }
      if (url.endsWith('/api/staff/appointments')) {
        return Response.json({
          appointments: [
            {
              appointmentId: 'appt_1',
              patientId: 'pat_01',
              patientName: '李建国',
              outpatientNumber: 'OP-DEMO-001',
              slotId: 'slot_wang_d1_01',
              doctorId: 'staff_doctor_a',
              doctorName: '王明',
              departmentId: 'dept_general',
              departmentName: '全科医学科',
              startsAt: '2026-11-27T00:30:00.000Z',
              endsAt: '2026-11-27T01:00:00.000Z',
              status: 'booked',
              clientRequestId: 'req-1',
              encounterId: null,
              chiefComplaint: '高血压复诊',
              createdAt: '2026-11-26T00:00:00.000Z',
              updatedAt: '2026-11-26T00:00:00.000Z',
              cancelledAt: null,
            },
          ],
        })
      }
      if (url.endsWith('/api/staff/patients')) {
        return Response.json({ patients: [] })
      }
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversations: [
            {
              conversationId: 'conv_dept_general_group',
              type: 'staff_group',
              title: '全科医护协作群',
              imChannelId: 'cm_conv_dept_general_group',
              imChannelType: 2,
              patientId: null,
              encounterId: null,
              followupPlanId: null,
              departmentId: 'dept_general',
              status: 'active',
              membershipVersion: 1,
              lastSequence: 1,
              lastReadSeq: 0,
              unreadCount: 1,
              lastMessagePreview: '早交班同步',
              lastMessageAt: '2026-11-26T01:00:00.000Z',
              createdAt: '2026-11-26T00:00:00.000Z',
              members: [
                {
                  actorId: 'actor_doctor_a',
                  displayName: '王明',
                  kind: 'human',
                  actorRole: 'doctor',
                  imUid: 'staff_doctor_a',
                  role: 'owner',
                  status: 'active',
                  joinedAt: '2026-11-26T00:00:00.000Z',
                  removedAt: null,
                  lastReadSeq: 0,
                },
              ],
            },
          ],
        })
      }
      if (url.includes('/api/conversations/conv_dept_general_group/messages')) {
        return Response.json({
          messages: [
            {
              schemaVersion: 1,
              messageId: 'm1',
              clientMessageId: 'cm1',
              conversationId: 'conv_dept_general_group',
              senderActorId: 'actor_doctor_a',
              senderName: '王明',
              senderKind: 'human',
              sequence: 1,
              createdAt: '2026-11-26T01:00:00.000Z',
              parts: [{ type: 'text', text: '早交班同步' }],
              mentions: [],
            },
          ],
          nextCursor: null,
          hasMore: false,
        })
      }
      if (url.endsWith('/api/im/credentials')) {
        return Response.json({ uid: 'staff_doctor_a', token: 'im-tok', wsUrl: 'ws://127.0.0.1:15200', mode: 'fake' })
      }
      if (url.endsWith('/api/clinic/departments')) {
        return Response.json({ departments: [{ departmentId: 'dept_general', name: '全科医学科' }] })
      }
      if (url.endsWith('/api/clinic/doctors')) {
        return Response.json({
          doctors: [
            {
              staffId: 'staff_doctor_a',
              actorId: 'actor_doctor_a',
              displayName: '王明',
              title: '主治医师',
              departmentId: 'dept_general',
              departmentName: '全科医学科',
            },
          ],
        })
      }
      if (url.endsWith('/api/contacts')) {
        return Response.json({ contacts: [] })
      }
      if (url.endsWith('/api/followup/plans')) {
        return Response.json({
          plans: [
            {
              planId: 'plan_1',
              patientId: 'pat_03',
              patientName: '王秀英',
              encounterId: null,
              ownerStaffId: 'staff_doctor_a',
              ownerStaffName: '王明',
              title: '血压复核随访计划',
              status: 'active',
              conversationId: 'conv_fu_1',
              startAt: '2026-11-26T00:00:00.000Z',
              endAt: null,
              createdAt: '2026-11-26T00:00:00.000Z',
              closedAt: null,
              tasks: [],
              summaries: [
                {
                  summaryId: 'sum_1',
                  planId: 'plan_1',
                  version: 1,
                  sourceResponseIds: ['resp_1'],
                  draftText: '居家血压控制平稳，待医生审核。',
                  status: 'draft',
                  createdBy: 'actor_agent_followup',
                  reviewedBy: null,
                  reviewedByName: null,
                  reviewedAt: null,
                  reviewNote: null,
                  createdAt: '2026-11-26T00:00:00.000Z',
                },
              ],
              reviewTasks: [
                {
                  reviewTaskId: 'rt_1',
                  planId: 'plan_1',
                  sourceRef: 'msg_9',
                  reason: '患者反馈轻度头晕需人工回访',
                  status: 'open',
                  createdBy: 'actor_agent_followup',
                  createdAt: '2026-11-26T00:00:00.000Z',
                },
              ],
            },
          ],
        })
      }
      if (url.endsWith('/api/encounters/active')) {
        return Response.json({ encounter: null })
      }
      return Response.json({ ok: true })
    })

    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/clinic'] }) })
    render(<RouterProvider router={router} />)

    const loginBtn = await screen.findByRole('button', { name: '登录医护工作台' })
    await user.click(loginBtn)

    await waitFor(() => {
      expect(screen.getByText('门诊总览工作台')).toBeInTheDocument()
    })

    // Appointments queue: named doctor & status filters + Asia/Shanghai time display.
    await user.click(screen.getByRole('button', { name: /预约队列/ }))
    expect(await screen.findByText('李建国')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '按医生筛选预约' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '按状态筛选预约' })).toBeInTheDocument()
    expect(screen.getByText(/北京时间/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始接诊' })).toBeInTheDocument()

    // Messages center: renders conversation + named controls for composer & recording.
    await user.click(screen.getByRole('button', { name: /消息中心/ }))
    expect(await screen.findByRole('heading', { name: '全科医护协作群' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '消息输入框' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '麦克风录音' })).toBeInTheDocument()

    // Follow-up tab: renders draft summary review buttons and agent review tasks.
    await user.click(screen.getByRole('button', { name: /随访管理/ }))
    expect(await screen.findByRole('button', { name: '医生确认批准' })).toBeInTheDocument()
    expect(screen.getByText(/患者反馈轻度头晕需人工回访/)).toBeInTheDocument()

    // Agent-readiness check: every interactive button on the active view carries an accessible name.
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent?.trim() || button.getAttribute('aria-label')).toBeTruthy()
    }
    expect(fetchMock).toHaveBeenCalled()
  })
})
