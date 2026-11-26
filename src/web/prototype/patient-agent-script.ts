import {
  PATIENTS,
  STAFF_ACTORS,
  type AgentRunRecord,
  type AgentStreamStep,
  type ConnectedClinicState,
  type MessagePart,
  type PatientKey,
  type StaffRole,
} from './connected-clinic-store'

type CardPart = Extract<MessagePart, { type: 'card' }>

export interface AgentPlan {
  steps: AgentStreamStep[]
  text: string
  cards: CardPart[]
  tools: AgentRunRecord['tools']
  urgent?: boolean
}

export const PRIMARY_DOCTOR: Record<PatientKey, StaffRole> = {
  patient_a: 'doctor_a',
  patient_b: 'doctor_b',
  patient_c: 'doctor_a',
}

export const ASSISTANT_PROMPTS: Record<PatientKey, string[]> = {
  patient_a: ['帮我预约王医生明天上午的门诊', '打开最近一次病历', '血常规结果怎么样', '药怎么吃', '咳嗽还没好，想问问医生'],
  patient_b: ['我现在排到第几位了', '打开最近一次病历', '胸口还是有点闷', '帮我约林医生明天的号'],
  patient_c: ['今天复诊要注意什么', '帮我改约到明天', '血糖打卡怎么填', '想问问王医生'],
}

function steps(labels: string[], first = 520, gap = 560): AgentStreamStep[] {
  return labels.map((label, index) => ({ label, doneAfterMs: first + index * gap }))
}

function doctorConversationId(state: ConnectedClinicState, patientKey: PatientKey) {
  return state.conversations.find((c) => c.type === 'patient_doctor' && c.patientKey === patientKey)?.id
}

function handoffCard(state: ConnectedClinicState, patientKey: PatientKey, draft: string): CardPart[] {
  const conversationId = doctorConversationId(state, patientKey)
  if (!conversationId) return []
  const doctor = STAFF_ACTORS[PRIMARY_DOCTOR[patientKey]]
  return [
    {
      type: 'card',
      component: 'HandoffCard',
      resourceId: conversationId,
      title: `转给${doctor.name}医生`,
      subtitle: '已帮你整理成一条消息，确认后由你本人发送',
      meta: ['医生通常 30 分钟内回复', 'AI 不会替你发送'],
      actionLabel: `发送给${doctor.name}医生`,
      actionName: 'handoff.send',
      handoff: { conversationId, draft, recipient: `${doctor.name}医生` },
    },
  ]
}

export function planPatientAgentReply(state: ConnectedClinicState, patientKey: PatientKey, prompt: string): AgentPlan {
  const patient = PATIENTS[patientKey]
  const scope = `patient:${patient.patientId}`
  const doctorKey: StaffRole = /林/.test(prompt) ? 'doctor_b' : /王医生|王明/.test(prompt) ? 'doctor_a' : PRIMARY_DOCTOR[patientKey]
  const doctor = STAFF_ACTORS[doctorKey]
  const published = state.resources.filter((r) => r.patientKey === patientKey && r.published)
  const honorific = patient.sex === '男' ? `${patient.name.slice(0, 1)}先生` : `${patient.name.slice(0, 1)}女士`

  if (/胸痛|胸口痛|呼吸困难|喘不上|昏|晕倒|意识/.test(prompt)) {
    return {
      urgent: true,
      steps: steps(['识别到可能的紧急症状'], 380),
      text: `${honorific}，你描述的情况可能需要紧急处理。如果胸痛持续超过 15 分钟、伴大汗、气促或意识不清，请立即拨打 120 或前往最近的急诊，不要等待线上回复。我已把情况整理好，你也可以马上转给医生。`,
      cards: handoffCard(state, patientKey, `${doctor.name}医生您好，我是${patient.name}。${prompt}，想请您尽快看一下。`),
      tools: [{ name: 'safety_triage', scope, status: 'ok', summary: '命中红旗症状，提示急诊，不做诊断' }],
    }
  }

  if (/预约|挂号|号源|改约|约.*号|明天/.test(prompt)) {
    const slots = state.slots.filter((s) => s.doctorId === doctorKey)
    const open = slots.filter((s) => s.booked < s.capacity)
    const full = slots.filter((s) => s.booked >= s.capacity)
    const pick = open[0] ?? slots[0]
    return {
      steps: steps([`查询${doctor.name}医生明天的号源`, '核对你已有的预约', '生成预约卡片（不提前占号）']),
      text: open.length
        ? `${doctor.name}医生明天有 ${open.length} 个时段还有号${full.length ? `，${full.map((s) => s.timeRange.split(' ')[0]).join('、')} 已满` : ''}。我先帮你选了最早的时段，可以在卡片里换时间，确认后才会真正预约：`
        : `${doctor.name}医生明天的号已经约满了，可以换其他医生或改天再试。`,
      cards: pick
        ? [
            {
              type: 'card',
              component: 'AppointmentCard',
              resourceId: pick.id,
              slotIds: slots.map((s) => s.id),
              title: `${doctor.name} 医生 · ${doctor.department}`,
              subtitle: `${pick.dateLabel} ${pick.timeRange}`,
              meta: ['需本人确认', '实时余号'],
              actionLabel: '去确认预约',
              actionName: 'appointment.open',
              statusTag: '已查实号源',
            },
          ]
        : [],
      tools: [
        { name: 'list_available_slots', scope: `doctor:${doctorKey}`, status: 'ok', summary: `返回 ${slots.length} 个时段，${open.length} 个有余号` },
        { name: 'prepare_appointment', scope, status: 'ok', summary: '生成待确认卡片，不占号' },
      ],
    }
  }

  if (/病历|记录/.test(prompt)) {
    const record = published.find((r) => r.kind === 'record')
    return {
      steps: steps(['查询你本人已发布的病历']),
      text: record ? `找到了，这是医生签署并发布给你的最近一次门诊病历：` : '还没有医生发布给你的病历。医生签署并发布后，会第一时间出现在这里。',
      cards: record
        ? [
            {
              type: 'card',
              component: 'MedicalRecordCard',
              resourceId: record.id,
              title: record.title,
              subtitle: `${record.department} · ${record.doctorName}`,
              meta: [`v${record.version}`, `发布于 ${record.publishedAt}`],
              actionLabel: '打开病历',
              actionName: 'medical.record.open',
              statusTag: '已发布',
            },
          ]
        : [],
      tools: [{ name: 'list_my_medical_records', scope, status: 'ok', summary: record ? `命中 ${record.id}` : '无已发布病历' }],
    }
  }

  if (/报告|检查|化验|CT|血常规|结果|指标/.test(prompt)) {
    const report = published.find((r) => r.kind === 'report')
    const flagged = report?.details.filter((d) => d.flag === 'high' || d.flag === 'low').map((d) => d.label.replace(/\s*\(.*\)/, ''))
    return {
      steps: steps(['查询你本人已发布的报告', '整理需要关注的指标']),
      text: report
        ? `你有 ${published.filter((r) => r.kind === 'report').length} 份医生已发布的报告。最新一份里${flagged?.length ? ` ${flagged.join('、')} 标记为偏高，具体意义以医生解读为准，有疑问可以让我转给医生` : '没有标记异常的指标'}：`
        : '医生还没有发布你的检查报告，发布后我会提醒你。',
      cards: report
        ? [
            {
              type: 'card',
              component: 'ReportCard',
              resourceId: report.id,
              title: report.title,
              subtitle: report.subtitle,
              meta: [report.department, `v${report.version}`],
              actionLabel: '查看报告',
              actionName: 'report.open',
              statusTag: '已发布',
            },
          ]
        : [],
      tools: [{ name: 'get_released_report', scope, status: 'ok', summary: report ? `返回 ${report.id}` : '无已发布报告' }],
    }
  }

  if (/药|处方|怎么吃|服用|剂量/.test(prompt)) {
    const rx = published.find((r) => r.kind === 'prescription')
    return {
      steps: steps(['读取医生已签发的处方']),
      text: rx
        ? `按医生的处方：${rx.details
            .filter((d) => !d.label.includes('提示'))
            .map((d) => `${d.label.split(' ')[0]}${d.value.replace(/^口服，?/, '，')}`)
            .join('；')}。不要自行加减药量，有不适请直接问医生。`
        : '暂时没有医生发布给你的处方。',
      cards: rx
        ? [
            {
              type: 'card',
              component: 'PrescriptionCard',
              resourceId: rx.id,
              title: rx.title,
              subtitle: rx.subtitle,
              meta: [rx.doctorName, '只读'],
              actionLabel: '查看处方',
              actionName: 'report.open',
              statusTag: '已签发',
            },
          ]
        : [],
      tools: [{ name: 'get_released_prescription', scope, status: 'ok', summary: rx ? `返回 ${rx.id}` : '无已发布处方' }],
    }
  }

  if (/随访|问卷|打卡|体温/.test(prompt)) {
    const plan = state.followupPlans.find((p) => p.patientKey === patientKey && p.status === 'active')
    return {
      steps: steps(['查询你的随访计划']),
      text: plan
        ? plan.taskStatus === 'pending'
          ? `你有一项随访待办：「${plan.taskTitle}」，${plan.dueLabel}完成。填完会直接同步给医生和护士：`
          : `「${plan.taskTitle}」你已经提交了，医生审核后会在随访群里回复你。`
        : '你目前没有进行中的随访计划。',
      cards:
        plan && plan.taskStatus === 'pending'
          ? [
              {
                type: 'card',
                component: 'FollowupFormCard',
                resourceId: plan.id,
                title: plan.taskTitle.replace(/^第 \d+ 次：/, ''),
                subtitle: `${plan.title} · 约 30 秒`,
                meta: [plan.dueLabel],
                actionLabel: '填写问卷',
                actionName: 'followup.submit',
                statusTag: '待填写',
              },
            ]
          : [],
      tools: [{ name: 'get_followup_tasks', scope, status: 'ok', summary: plan ? `计划 ${plan.id} · ${plan.taskStatus}` : '无进行中计划' }],
    }
  }

  if (/医生|联系|转给|问问|咳|发烧|发热|不舒服|胸闷|疼|痛|排到|第几/.test(prompt)) {
    const queue = /排到|第几/.test(prompt)
    const ahead = state.encounters.filter((e) => e.status === 'active' && e.patientKey !== patientKey).length
    return {
      steps: steps(queue ? ['查询今日候诊队列'] : ['确认你的主管医生', '整理要发给医生的内容']),
      text: queue
        ? ahead
          ? `你已签到，诊室里还有 ${ahead} 位患者在就诊，轮到你时手机会提醒。等待中如果症状加重，请马上告诉分诊护士。`
          : '诊室现在空闲，医生接诊后手机会提醒你。等待中如果症状加重，请马上告诉分诊护士。'
        : `这个问题需要医生来判断，我不能替医生诊断或调整用药。我把你的情况整理成了一条消息，你确认后可以直接发给${doctor.name}医生：`,
      cards: queue ? [] : handoffCard(state, patientKey, `${doctor.name}医生您好，我是${patient.name}。${prompt.replace(/[，。]?想问问医生$/, '')}，想请您看看需不需要调整用药或者复诊。`),
      tools: [{ name: 'contact_care_team', scope, status: 'ok', summary: '整理转医生草稿，由患者本人确认发送' }],
    }
  }

  return {
    steps: steps(['理解你的问题'], 420),
    text: `我可以帮你预约挂号、查看医生已发布的病历和报告、解释处方怎么吃、提醒随访打卡，或把问题整理好转给医生。我不能做诊断或开药。`,
    cards: [],
    tools: [{ name: 'describe_capabilities', scope, status: 'ok', summary: '未命中业务意图，返回能力说明' }],
  }
}
