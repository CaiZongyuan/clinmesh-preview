// Unified Connected Clinic prototype entrypoint (/prototype/connected-clinic).
// Combines Desktop HIS (A-style shell) + Ambient 3-column Chat (C-style inbox) + Patient Mobile App.

import { Preferences } from '@ui-sdk/react/preferences'
import { useState } from 'react'
import { workbenchPreferences } from '../workbench/workbench-preferences'
import {
  createInitialClinicState,
  nowClock,
  PATIENTS,
  STAFF_ACTORS,
  type ClinicActions,
  type ConnectedClinicState,
  type PatientKey,
  type StaffRole,
  type SyncEvent,
} from './connected-clinic-store'
import './connected-clinic-prototype.css'
import { ConnectedClinicStudio } from './connected-clinic-studio'

function appendEvent(
  events: SyncEvent[],
  owner: SyncEvent['owner'],
  origin: SyncEvent['origin'],
  summary: string,
  tone: SyncEvent['tone'] = 'info',
): SyncEvent[] {
  return [
    {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: nowClock(),
      owner,
      origin,
      summary,
      tone,
    },
    ...events,
  ].slice(0, 30)
}

function useConnectedClinicStore(): [ConnectedClinicState, ClinicActions] {
  const [state, setState] = useState<ConnectedClinicState>(createInitialClinicState)

  const actions: ClinicActions = {
    setStaff(role: StaffRole) {
      setState((prev) => ({
        ...prev,
        currentStaff: role,
        syncEvents: appendEvent(
          prev.syncEvents,
          'ClinicWorkspaceDO',
          '医生工作台',
          `切换医护会话身份 → ${STAFF_ACTORS[role].name} (${STAFF_ACTORS[role].title})`,
        ),
      }))
    },

    setPatient(patient: PatientKey) {
      setState((prev) => ({
        ...prev,
        currentPatient: patient,
        lastIsolationBlock: null,
        syncEvents: appendEvent(
          prev.syncEvents,
          'ClinicWorkspaceDO',
          '患者手机版',
          `切换患者身份 → ${PATIENTS[patient].name} (${PATIENTS[patient].patientId})，已清理旧本地缓存`,
        ),
      }))
    },

    resetDemo() {
      setState(createInitialClinicState())
    },

    bookAppointment(slotId, source, complaint) {
      let result: { ok: boolean; message: string; appointmentId?: string } = {
        ok: false,
        message: '未找到对应号源',
      }

      setState((prev) => {
        const slot = prev.slots.find((s) => s.id === slotId)
        if (!slot) return prev
        if (slot.booked >= slot.capacity) {
          result = {
            ok: false,
            message: `409 Conflict：${slot.doctorName} ${slot.timeRange} 已满号，请更换其他可用时段。`,
          }
          return {
            ...prev,
            syncEvents: appendEvent(
              prev.syncEvents,
              'ClinicWorkspaceDO',
              '患者手机版',
              `预约被事务容量校验拒绝：${slot.timeRange} 已满 (${slot.booked}/${slot.capacity})`,
              'warning',
            ),
          }
        }
        const dup = prev.appointments.find(
          (a) =>
            a.patientKey === prev.currentPatient &&
            a.slotId === slotId &&
            a.status !== 'cancelled',
        )
        if (dup) {
          result = {
            ok: true,
            appointmentId: dup.id,
            message: `幂等命中：您已预约过该时段（${dup.id}），未重复扣号。`,
          }
          return prev
        }

        const aptId = `apt_${Math.floor(2000 + Math.random() * 7999)}`
        const patient = PATIENTS[prev.currentPatient]
        result = {
          ok: true,
          appointmentId: aptId,
          message: `预约成功（${aptId}）：${slot.doctorName} ${slot.dateLabel} ${slot.timeRange}，已同步至医生端队列。`,
        }

        return {
          ...prev,
          slots: prev.slots.map((s) => (s.id === slotId ? { ...s, booked: s.booked + 1 } : s)),
          appointments: [
            {
              id: aptId,
              patientKey: prev.currentPatient,
              slotId: slot.id,
              doctorId: slot.doctorId,
              doctorName: slot.doctorName,
              department: slot.department,
              dateLabel: slot.dateLabel,
              timeRange: slot.timeRange,
              chiefComplaint: complaint?.trim() || patient.chiefComplaint,
              status: 'booked',
              source,
              createdAt: nowClock(),
            },
            ...prev.appointments,
          ],
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '患者手机版',
            `${patient.name} 确认预约 ${slot.doctorName} ${slot.dateLabel} ${slot.timeRange} (${aptId})`,
            'success',
          ),
        }
      })

      return result
    },

    checkInAppointment(appointmentId) {
      setState((prev) => {
        const target = prev.appointments.find((a) => a.id === appointmentId)
        if (!target) return prev
        return {
          ...prev,
          appointments: prev.appointments.map((a) =>
            a.id === appointmentId ? { ...a, status: 'checked_in' } : a,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '医生工作台',
            `${PATIENTS[target.patientKey].name} 预约 ${appointmentId} 已签到候诊`,
          ),
        }
      })
    },

    startEncounterFromAppointment(appointmentId) {
      let response = { ok: false, message: '无法接诊' }
      setState((prev) => {
        const active = prev.encounters.find((e) => e.status === 'active')
        if (active) {
          response = {
            ok: false,
            message: `单在诊约束冲突：当前已有在诊 Encounter（${PATIENTS[active.patientKey].name} · ${active.outpatientNumber}），请先完成当前接诊再接诊下一位；本条预约未被破坏。`,
          }
          return {
            ...prev,
            syncEvents: appendEvent(
              prev.syncEvents,
              'ClinicWorkspaceDO',
              '医生工作台',
              `拒绝并发接诊 ${appointmentId}：当前存在未完诊 ${active.outpatientNumber}`,
              'warning',
            ),
          }
        }
        const apt = prev.appointments.find((a) => a.id === appointmentId)
        if (!apt) return prev
        const encId = `enc_${Math.floor(100 + Math.random() * 899)}`
        const opNum = `OP-20261126-0${prev.encounters.length + 1}`
        response = {
          ok: true,
          message: `已成功为 ${PATIENTS[apt.patientKey].name} 建立在诊 Encounter (${opNum})`,
        }
        return {
          ...prev,
          encounters: [
            {
              id: encId,
              appointmentId: apt.id,
              patientKey: apt.patientKey,
              practitionerId: prev.currentStaff,
              status: 'active',
              outpatientNumber: opNum,
              chiefComplaint: apt.chiefComplaint,
              signedNote: true,
              diagnosisConfirmed: true,
              diagnosisText: '门诊初步评估完成（模拟病例）',
              reportsAcknowledged: true,
              prescriptionIssued: true,
              noPendingDrafts: true,
              releasedToPatient: false,
            },
            ...prev.encounters,
          ],
          appointments: prev.appointments.map((a) =>
            a.id === appointmentId ? { ...a, status: 'in_encounter', encounterId: encId } : a,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '医生工作台',
            `${STAFF_ACTORS[prev.currentStaff].name} 接诊 ${PATIENTS[apt.patientKey].name} → ${opNum}`,
            'success',
          ),
        }
      })
      return response
    },

    completeActiveEncounter() {
      setState((prev) => {
        const active = prev.encounters.find((e) => e.status === 'active')
        if (!active) return prev
        return {
          ...prev,
          encounters: prev.encounters.map((e) =>
            e.id === active.id ? { ...e, status: 'completed' } : e,
          ),
          appointments: prev.appointments.map((a) =>
            a.id === active.appointmentId ? { ...a, status: 'completed' } : a,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '医生工作台',
            `${active.outpatientNumber} 通过五项 Completion Gates 正式完诊并冻结临床写入`,
            'success',
          ),
        }
      })
    },

    toggleResourcePublish(resourceId) {
      setState((prev) => {
        const res = prev.resources.find((r) => r.id === resourceId)
        if (!res) return prev
        const nextPublished = !res.published
        return {
          ...prev,
          resources: prev.resources.map((r) =>
            r.id === resourceId
              ? { ...r, published: nextPublished, publishedAt: nextPublished ? nowClock() : undefined }
              : r,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '医生工作台',
            `${STAFF_ACTORS[prev.currentStaff].name} ${nextPublished ? '显式发布' : '撤回发布'}「${res.title} v${res.version}」（${PATIENTS[res.patientKey].name} 手机版即时同步）`,
            nextPublished ? 'success' : 'warning',
          ),
        }
      })
    },

    sendMessage(conversationId, senderType, text) {
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === conversationId)
        if (!conv || conv.status === 'read_only') return prev
        const staff = STAFF_ACTORS[prev.currentStaff]
        const patient = PATIENTS[prev.currentPatient]
        const nextSeq = (conv.messages.at(-1)?.sequence ?? 0) + 1
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  unreadPatient: senderType === 'staff' ? c.unreadPatient + 1 : 0,
                  unreadStaff: senderType === 'patient' ? c.unreadStaff + 1 : 0,
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_${Date.now()}`,
                      conversationId,
                      sequence: nextSeq,
                      senderId: senderType === 'staff' ? staff.id : patient.id,
                      senderName: senderType === 'staff' ? `${staff.name}` : patient.name,
                      senderKind: 'human',
                      senderRole: senderType === 'staff' ? staff.title : '患者',
                      createdAt: nowClock(),
                      parts: [{ type: 'text', text }],
                    },
                  ],
                }
              : c,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'WuKongIM',
            senderType === 'staff' ? '医生工作台' : '患者手机版',
            `${senderType === 'staff' ? staff.name : patient.name} 发送消息至「${conv.title}」seq #${nextSeq}`,
          ),
        }
      })
    },

    sendVoiceMessage(conversationId, senderType, transcript, durationSec = 9) {
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === conversationId)
        if (!conv || conv.status === 'read_only') return prev
        const staff = STAFF_ACTORS[prev.currentStaff]
        const patient = PATIENTS[prev.currentPatient]
        const nextSeq = (conv.messages.at(-1)?.sequence ?? 0) + 1
        const attId = `att_voice_${Date.now()}`
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  unreadPatient: senderType === 'staff' ? c.unreadPatient + 1 : 0,
                  unreadStaff: senderType === 'patient' ? c.unreadStaff + 1 : 0,
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_${Date.now()}`,
                      conversationId,
                      sequence: nextSeq,
                      senderId: senderType === 'staff' ? staff.id : patient.id,
                      senderName: senderType === 'staff' ? staff.name : patient.name,
                      senderKind: 'human',
                      senderRole: senderType === 'staff' ? staff.title : '患者',
                      createdAt: nowClock(),
                      parts: [
                        {
                          type: 'audio',
                          attachmentId: attId,
                          durationSec,
                          asrStatus: 'ready',
                          transcript,
                        },
                      ],
                    },
                  ],
                }
              : c,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'WuKongIM',
            senderType === 'staff' ? '医生工作台' : '患者手机版',
            `上传私有语音 ${durationSec}″ (${attId}) 并生成独立 ASR 转写，seq #${nextSeq}`,
            'success',
          ),
        }
      })
    },

    shareResourceCard(conversationId, resourceId) {
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === conversationId)
        const res = prev.resources.find((r) => r.id === resourceId)
        if (!conv || !res || conv.status === 'read_only') return prev
        const staff = STAFF_ACTORS[prev.currentStaff]
        const nextSeq = (conv.messages.at(-1)?.sequence ?? 0) + 1
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  unreadPatient: c.unreadPatient + 1,
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_${Date.now()}`,
                      conversationId,
                      sequence: nextSeq,
                      senderId: staff.id,
                      senderName: staff.name,
                      senderKind: 'human',
                      senderRole: staff.title,
                      createdAt: nowClock(),
                      parts: [
                        {
                          type: 'card',
                          component: res.kind === 'report' ? 'ReportCard' : 'MedicalRecordCard',
                          resourceId: res.id,
                          title: res.title,
                          subtitle: res.subtitle,
                          meta: [res.department, `v${res.version}`, '打开时重新鉴权'],
                          actionLabel: res.kind === 'report' ? '查看已发布报告' : '打开门诊病历',
                          actionName: res.kind === 'report' ? 'report.open' : 'medical.record.open',
                          statusTag: '已发布',
                        },
                      ],
                    },
                  ],
                }
              : c,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'WuKongIM',
            '医生工作台',
            `${staff.name} 投递资源引用卡片「${res.title}」至「${conv.title}」seq #${nextSeq}`,
            'success',
          ),
        }
      })
    },

    toggleGroupMember(conversationId, memberId) {
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === conversationId)
        if (!conv) return prev
        const member = conv.members.find((m) => m.id === memberId)
        if (!member) return prev
        const nextStatus = member.status === 'active' ? 'removed' : 'active'
        const nextSeq = (conv.messages.at(-1)?.sequence ?? 0) + 1
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  membershipVersion: c.membershipVersion + 1,
                  members: c.members.map((m) =>
                    m.id === memberId ? { ...m, status: nextStatus } : m,
                  ),
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_sys_${Date.now()}`,
                      conversationId,
                      sequence: nextSeq,
                      senderId: 'system',
                      senderName: '系统',
                      senderKind: 'system',
                      senderRole: 'System',
                      createdAt: nowClock(),
                      parts: [
                        {
                          type: 'text',
                          text:
                            nextStatus === 'removed'
                              ? `已移除成员「${member.name}」并撤销 IM 频道投影权限 (membership v${c.membershipVersion + 1})。`
                              : `已重新邀请「${member.name}」加入本群 (membership v${c.membershipVersion + 1})。`,
                        },
                      ],
                    },
                  ],
                }
              : c,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'SecurityGate',
            '医生工作台',
            `${nextStatus === 'removed' ? '撤销' : '恢复'}成员 ${member.name} 于「${conv.title}」的访问权`,
            nextStatus === 'removed' ? 'warning' : 'info',
          ),
        }
      })
    },

    triggerPatientAgentPrompt(prompt) {
      setState((prev) => {
        const patient = PATIENTS[prev.currentPatient]
        const assistantConv = prev.conversations.find((c) => c.type === 'patient_assistant')
        if (!assistantConv) return prev
        const nextSeq = (assistantConv.messages.at(-1)?.sequence ?? 0) + 1
        const runId = `run_pa_${Math.floor(100 + Math.random() * 899)}`

        const wantsBooking = /预约|挂号|王医生|号源|明天/.test(prompt)
        const wantsRecord = /病历|记录/.test(prompt)
        const wantsReport = /报告|检查|化验|CT|血常规/.test(prompt)

        const myPublished = prev.resources.filter(
          (r) => r.patientKey === prev.currentPatient && r.published,
        )

        let replyParts: ConnectedClinicState['conversations'][number]['messages'][number]['parts'] = []
        let tools: ConnectedClinicState['agentRuns'][number]['tools'] = []

        if (wantsBooking) {
          const wangSlots = prev.slots.filter((s) => s.doctorId === 'doctor_a')
          const firstOpen = wangSlots.find((s) => s.booked < s.capacity) ?? wangSlots[0]
          tools = [
            { name: 'list_doctors', scope: 'clinic:default', status: 'ok', summary: '查询到王明医生（全科医学科）' },
            {
              name: 'list_available_slots',
              scope: 'doctor:doctor_a',
              status: 'ok',
              summary: `实时返回 ${wangSlots.length} 个明天上午时段（含满号状态）`,
            },
            {
              name: 'prepare_appointment',
              scope: `patient:${patient.patientId}`,
              status: 'ok',
              summary: `生成待确认预约卡片（${firstOpen?.id}），不提前占号`,
            },
          ]
          replyParts = [
            {
              type: 'text',
              text: `已为您实时查询王明医生明天上午号源：09:00 与 10:00 尚有余号，11:00 已满。我已为您预填推荐时段，点击下方卡片可调整时间并由您本人确认预约：`,
            },
            {
              type: 'card',
              component: 'AppointmentCard',
              resourceId: firstOpen?.id ?? 'slot_wang_am_0900',
              slotIds: [firstOpen?.id ?? 'slot_wang_am_0900'],
              title: `${firstOpen?.doctorName ?? '王明 医生'} · 全科医学科`,
              subtitle: `推荐时段：${firstOpen?.dateLabel} ${firstOpen?.timeRange}`,
              meta: ['需本人确认', '不提前锁号', '实时容量校验'],
              actionLabel: '预填并前往确认预约',
              actionName: 'appointment.open',
              statusTag: '已查实号源',
            },
          ]
        } else if (wantsRecord) {
          const latestRec = myPublished.find((r) => r.kind === 'record')
          tools = [
            {
              name: 'list_my_medical_records',
              scope: `patient:${patient.patientId}`,
              status: 'ok',
              summary: latestRec
                ? `命中本人已发布病历 ${latestRec.id} (v${latestRec.version})`
                : '当前患者暂无已发布病历',
            },
          ]
          replyParts = latestRec
            ? [
                {
                  type: 'text',
                  text: `已为您检索到本人最近一次经医生签署并发布的正式门诊病历，点击下方卡片可安全打开详情：`,
                },
                {
                  type: 'card',
                  component: 'MedicalRecordCard',
                  resourceId: latestRec.id,
                  title: latestRec.title,
                  subtitle: latestRec.subtitle,
                  meta: [latestRec.department, latestRec.doctorName, `发布于 ${latestRec.publishedAt}`],
                  actionLabel: '打开门诊病历详情',
                  actionName: 'medical.record.open',
                  statusTag: '已授权投影',
                },
              ]
            : [{ type: 'text', text: '暂未查到您本人已发布的门诊病历（医生未显式发布的草稿不会提前展示）。' }]
        } else if (wantsReport) {
          const latestRep = myPublished.find((r) => r.kind === 'report')
          tools = [
            {
              name: 'get_released_report',
              scope: `patient:${patient.patientId}`,
              status: 'ok',
              summary: latestRep
                ? `返回本人已发布报告 ${latestRep.id} (v${latestRep.version})`
                : '暂无已发布报告',
            },
          ]
          replyParts = latestRep
            ? [
                {
                  type: 'text',
                  text: `当前共查到 ${myPublished.filter((r) => r.kind === 'report').length} 份已由医生显式发布的报告，以下为最新一份：`,
                },
                {
                  type: 'card',
                  component: 'ReportCard',
                  resourceId: latestRep.id,
                  title: latestRep.title,
                  subtitle: latestRep.subtitle,
                  meta: [latestRep.department, `v${latestRep.version}`],
                  actionLabel: '查看已发布报告详情',
                  actionName: 'report.open',
                  statusTag: '已发布',
                },
              ]
            : [{ type: 'text', text: '您目前暂无已发布的检验检查报告。待医生审核并显式发布后即可在此查阅。' }]
        } else {
          tools = [
            {
              name: 'contact_care_team',
              scope: `patient:${patient.patientId}`,
              status: 'ok',
              summary: '校验本人医疗服务关系，未执行任何临床诊断动作',
            },
          ]
          replyParts = [
            {
              type: 'text',
              text: '我可以帮您查询可用门诊号源、打开本人已发布的病历与检查报告，或引导您联系王明医生。请注意：患者助手不提供自主诊断或处方，如有急性胸痛、呼吸困难等不适请立即线下急诊。',
            },
          ]
        }

        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === assistantConv.id
              ? {
                  ...c,
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_u_${Date.now()}`,
                      conversationId: assistantConv.id,
                      sequence: nextSeq,
                      senderId: patient.id,
                      senderName: patient.name,
                      senderKind: 'human',
                      senderRole: '患者本人',
                      createdAt: nowClock(),
                      parts: [{ type: 'text', text: prompt }],
                    },
                    {
                      id: `msg_a_${Date.now() + 1}`,
                      conversationId: assistantConv.id,
                      sequence: nextSeq + 1,
                      senderId: 'agent_patient_svc',
                      senderName: '患者服务助手',
                      senderKind: 'agent',
                      senderRole: 'Patient Service Agent',
                      createdAt: nowClock(),
                      agentRunId: runId,
                      parts: replyParts,
                    },
                  ],
                }
              : c,
          ),
          agentRuns: [
            {
              id: runId,
              agentName: 'Patient Service Agent',
              conversationId: assistantConv.id,
              triggerLabel: `患者 ${patient.name}：${prompt}`,
              status: 'settled',
              startedAt: `${nowClock()}:12`,
              durationMs: 920,
              tools,
              auditNote: `强绑定本人身份 ${patient.patientId}；所有业务变更须患者本人显式确认。`,
            },
            ...prev.agentRuns,
          ],
          syncEvents: appendEvent(
            prev.syncEvents,
            'DurableAgent',
            'Agent Runtime',
            `Patient Service Agent 完成 ${runId}（${tools.map((t) => t.name).join(' → ')}）`,
            'info',
          ),
        }
      })
    },

    submitFollowupQuestionnaire(planId, payload) {
      setState((prev) => {
        const plan = prev.followupPlans.find((p) => p.id === planId)
        if (!plan || plan.status !== 'active') return prev
        const respId = `resp_${planId}_${plan.responses.length + 1}`
        const patient = PATIENTS[plan.patientKey]
        const conv = prev.conversations.find((c) => c.id === plan.conversationId)
        const nextSeq = (conv?.messages.at(-1)?.sequence ?? 0) + 1

        return {
          ...prev,
          followupPlans: prev.followupPlans.map((p) =>
            p.id === planId
              ? {
                  ...p,
                  taskStatus: 'submitted',
                  responses: [
                    {
                      id: respId,
                      submittedAt: `今日 ${nowClock()}`,
                      ...payload,
                    },
                    ...p.responses,
                  ],
                }
              : p,
          ),
          conversations: prev.conversations.map((c) =>
            c.id === plan.conversationId
              ? {
                  ...c,
                  unreadStaff: c.unreadStaff + 1,
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_fu_sub_${Date.now()}`,
                      conversationId: c.id,
                      sequence: nextSeq,
                      senderId: patient.id,
                      senderName: patient.name,
                      senderKind: 'human',
                      senderRole: '患者',
                      createdAt: nowClock(),
                      parts: [
                        {
                          type: 'text',
                          text: `已提交随访问卷反馈（${respId}）：体温 ${payload.temperature}，${payload.symptomScore}；${payload.adherence}。备注：${payload.note}`,
                        },
                      ],
                    },
                  ],
                }
              : c,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '患者手机版',
            `${patient.name} 提交随访问卷反馈 ${respId}（已同步至随访群与医生端）`,
            'success',
          ),
        }
      })
    },

    triggerFollowupAgentSummary(planId) {
      setState((prev) => {
        const plan = prev.followupPlans.find((p) => p.id === planId)
        if (!plan || plan.status !== 'active') return prev
        const nextVer = plan.summaries.length + 1
        const sumId = `sum_${plan.id}_v${nextVer}`
        const runId = `run_fu_${Math.floor(100 + Math.random() * 899)}`
        const latestResp = plan.responses[0]
        const sourceIds = plan.responses.map((r) => r.id)
        const content = latestResp
          ? `【待医生审核草稿】依据随访问卷反馈（${sourceIds.join(', ')}）：患者自测体温 ${latestResp.temperature}，${latestResp.symptomScore}，用药依从性良好（${latestResp.adherence}），自述「${latestResp.note}」。未报告呼吸困难或持续高热警示信号，提请主管医生复核后固化为正式随访记录。`
          : `【待医生审核草稿】依据当前随访群沟通轨迹与计划 #${plan.id}：患者已领药并查看血常规报告 v2，暂无新增问卷提交。建议提醒患者今日 20:00 前完成体温与咳嗽打卡。`

        const conv = prev.conversations.find((c) => c.id === plan.conversationId)
        const nextSeq = (conv?.messages.at(-1)?.sequence ?? 0) + 1

        return {
          ...prev,
          followupPlans: prev.followupPlans.map((p) =>
            p.id === planId
              ? {
                  ...p,
                  summaries: [
                    {
                      id: sumId,
                      version: nextVer,
                      status: 'draft',
                      createdAt: `今日 ${nowClock()}`,
                      sourceResponseIds: sourceIds,
                      content,
                    },
                    ...p.summaries,
                  ],
                }
              : p,
          ),
          conversations: prev.conversations.map((c) =>
            c.id === plan.conversationId
              ? {
                  ...c,
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_agent_sum_${Date.now()}`,
                      conversationId: c.id,
                      sequence: nextSeq,
                      senderId: 'agent_followup',
                      senderName: '随访助手',
                      senderKind: 'agent',
                      senderRole: 'Follow-up Agent',
                      createdAt: nowClock(),
                      agentRunId: runId,
                      parts: [
                        {
                          type: 'text',
                          text: `已应 @随访助手 请求生成随访摘要草稿 v${nextVer}（溯源：${sourceIds.join(', ') || '群会话上下文'}），当前处于待医生审核状态，不会自动写入正式病历。`,
                        },
                      ],
                    },
                  ],
                }
              : c,
          ),
          agentRuns: [
            {
              id: runId,
              agentName: 'Follow-up Agent',
              conversationId: plan.conversationId,
              triggerLabel: `@随访助手 生成随访摘要（${PATIENTS[plan.patientKey].name}）`,
              status: 'settled',
              startedAt: `${nowClock()}:34`,
              durationMs: 1340,
              tools: [
                { name: 'get_followup_plan', scope: `plan:${plan.id}`, status: 'ok', summary: `读取 ${plan.responses.length} 条已提交反馈` },
                { name: 'draft_followup_summary', scope: `summary:${sumId}`, status: 'ok', summary: '创建待审核草稿（禁止自动批准）' },
              ],
              auditNote: '仅限当前随访群授权上下文；不自主做临床诊断或处方调整。',
            },
            ...prev.agentRuns,
          ],
          syncEvents: appendEvent(
            prev.syncEvents,
            'DurableAgent',
            'Agent Runtime',
            `Follow-up Agent 生成待审摘要 ${sumId} (${runId} settled)`,
            'info',
          ),
        }
      })
    },

    reviewFollowupSummary(planId, summaryId, decision) {
      setState((prev) => {
        const staff = STAFF_ACTORS[prev.currentStaff]
        if (staff.role !== 'doctor') return prev
        const plan = prev.followupPlans.find((p) => p.id === planId)
        if (!plan) return prev
        return {
          ...prev,
          followupPlans: prev.followupPlans.map((p) =>
            p.id === planId
              ? {
                  ...p,
                  taskStatus: decision === 'approved' ? 'reviewed' : p.taskStatus,
                  summaries: p.summaries.map((s) =>
                    s.id === summaryId
                      ? {
                          ...s,
                          status: decision,
                          reviewedBy: `${staff.name} 医生`,
                          reviewedAt: nowClock(),
                        }
                      : s,
                  ),
                }
              : p,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '医生工作台',
            `${staff.name} 医生${decision === 'approved' ? '批准并固化' : '驳回'}随访摘要 ${summaryId}`,
            decision === 'approved' ? 'success' : 'warning',
          ),
        }
      })
    },

    closeFollowupPlan(planId) {
      setState((prev) => {
        const staff = STAFF_ACTORS[prev.currentStaff]
        if (staff.role !== 'doctor') return prev
        const plan = prev.followupPlans.find((p) => p.id === planId)
        if (!plan) return prev
        const conv = prev.conversations.find((c) => c.id === plan.conversationId)
        const nextSeq = (conv?.messages.at(-1)?.sequence ?? 0) + 1
        return {
          ...prev,
          followupPlans: prev.followupPlans.map((p) =>
            p.id === planId ? { ...p, status: 'completed' } : p,
          ),
          conversations: prev.conversations.map((c) =>
            c.id === plan.conversationId
              ? {
                  ...c,
                  status: 'read_only',
                  messages: [
                    ...c.messages,
                    {
                      id: `msg_close_${Date.now()}`,
                      conversationId: c.id,
                      sequence: nextSeq,
                      senderId: 'system',
                      senderName: '系统',
                      senderKind: 'system',
                      senderRole: 'System',
                      createdAt: nowClock(),
                      parts: [
                        {
                          type: 'text',
                          text: `${staff.name} 医生已关闭随访计划 #${plan.id}，本随访群转为只读归档，历史消息按原策略鉴权保留。`,
                        },
                      ],
                    },
                  ],
                }
              : c,
          ),
          syncEvents: appendEvent(
            prev.syncEvents,
            'ClinicWorkspaceDO',
            '医生工作台',
            `关闭随访计划 #${plan.id} → 关联随访群同步切换为 read_only 只读归档`,
            'warning',
          ),
        }
      })
    },

    testCrossPatientIsolation() {
      setState((prev) => {
        const actor = PATIENTS[prev.currentPatient]
        const msg = `GET /api/patient/records/rec_lijg_20261126 被拒绝：当前会话主体为 ${actor.name} (${actor.patientId})，无权读取 patient_a (李建国) 的病历投影或随访群附件。`
        return {
          ...prev,
          lastIsolationBlock: msg,
          syncEvents: appendEvent(
            prev.syncEvents,
            'SecurityGate',
            '患者手机版',
            `403 Forbidden · 拦截跨患者访问 (${actor.patientId} 尝试读取 pat_01_lijg 病历)`,
            'destructive',
          ),
        }
      })
    },
  }

  return [state, actions]
}

export function ConnectedClinicPrototype() {
  const [state, actions] = useConnectedClinicStore()
  return (
    <Preferences preferences={workbenchPreferences}>
      <div className="cc-proto-root">
        <ConnectedClinicStudio state={state} actions={actions} />
      </div>
    </Preferences>
  )
}
