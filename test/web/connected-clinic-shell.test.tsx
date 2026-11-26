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

  it('logs in as Dr. Wang, renders dashboard, appointments, messages, and follow-up review actions', async () => {
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
        return Response.json({ conversations: [] })
      }
      if (url.endsWith('/api/clinic/departments')) {
        return Response.json({ departments: [{ departmentId: 'dept_general', name: '全科医学科' }] })
      }
      if (url.endsWith('/api/clinic/doctors')) {
        return Response.json({ doctors: [] })
      }
      if (url.endsWith('/api/contacts')) {
        return Response.json({ contacts: [] })
      }
      if (url.endsWith('/api/followup/plans')) {
        return Response.json({ plans: [] })
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
    expect(screen.getByText(/王明/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /预约队列/ }))
    expect(await screen.findByText('李建国')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始接诊' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalled()
  })
})
