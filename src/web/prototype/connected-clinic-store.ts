// Unified Connected Clinic prototype in-memory state store (Desktop HIS + Patient Mobile App).
// All state lives in memory and can be reset cleanly at any time.

export type StaffRole = 'doctor_a' | 'doctor_b' | 'nurse_n'
export type PatientKey = 'patient_a' | 'patient_b' | 'patient_c'

export interface StaffActor {
  id: StaffRole
  name: string
  title: string
  role: 'doctor' | 'nurse'
  department: string
  avatar: string
  imUid: string
}

export interface PatientProfile {
  id: PatientKey
  patientId: string
  name: string
  sex: '男' | '女'
  age: number
  avatar: string
  chiefComplaint: string
  allergies: string[]
  chronicConditions: string[]
  vitals: { label: string; value: string; unit: string; abnormal?: boolean }[]
  mobileBound: boolean
  inviteCode: string
  imUid: string
}

export interface AppointmentSlot {
  id: string
  doctorId: StaffRole
  doctorName: string
  department: string
  dateLabel: string
  timeRange: string
  capacity: number
  booked: number
}

export type AppointmentStatus = 'booked' | 'checked_in' | 'in_encounter' | 'completed' | 'cancelled'

export interface ClinicAppointment {
  id: string
  patientKey: PatientKey
  slotId: string
  doctorId: StaffRole
  doctorName: string
  department: string
  dateLabel: string
  timeRange: string
  chiefComplaint: string
  status: AppointmentStatus
  source: 'manual' | 'agent_assisted'
  encounterId?: string
  createdAt: string
}

export interface ClinicalEncounterState {
  id: string
  appointmentId: string
  patientKey: PatientKey
  practitionerId: StaffRole
  status: 'active' | 'completed'
  outpatientNumber: string
  chiefComplaint: string
  signedNote: boolean
  diagnosisConfirmed: boolean
  diagnosisText: string
  reportsAcknowledged: boolean
  prescriptionIssued: boolean
  noPendingDrafts: boolean
  releasedToPatient: boolean
}

export interface PublishedResource {
  id: string
  kind: 'record' | 'report' | 'prescription'
  patientKey: PatientKey
  encounterId: string
  title: string
  subtitle: string
  department: string
  doctorName: string
  version: number
  published: boolean
  publishedAt?: string
  summary: string
  details: { label: string; value: string; flag?: 'normal' | 'high' | 'low' }[]
}

export type ConversationType =
  | 'patient_assistant'
  | 'patient_doctor'
  | 'staff_direct'
  | 'staff_group'
  | 'followup_group'

export interface ConversationMember {
  id: string
  name: string
  kind: 'human' | 'agent'
  roleLabel: string
  avatar: string
  status: 'active' | 'removed'
}

export type CardComponent =
  | 'AppointmentCard'
  | 'MedicalRecordCard'
  | 'ReportCard'
  | 'PrescriptionCard'
  | 'FollowupFormCard'
  | 'TaskCard'
  | 'HandoffCard'

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'audio'; attachmentId: string; durationSec: number; transcript?: string; asrStatus: 'pending' | 'ready' | 'unavailable' }
  | {
      type: 'card'
      component: CardComponent
      resourceId: string
      title: string
      subtitle: string
      meta: string[]
      actionLabel: string
      actionName: string
      statusTag?: string
      slotIds?: string[]
      taskId?: string
      handoff?: { conversationId: string; draft: string; recipient: string; sentAt?: string }
    }

export type DeliveryStatus = 'sending' | 'sent' | 'read'

export interface AgentStreamStep {
  label: string
  doneAfterMs: number
}

export interface AgentStream {
  startedAt: number
  steps: AgentStreamStep[]
  textStartsAfterMs: number
  chunkMs: number
  status: 'streaming' | 'settled' | 'stopped'
}

export interface ChatMessage {
  id: string
  conversationId: string
  sequence: number
  senderId: string
  senderName: string
  senderKind: 'human' | 'agent' | 'system'
  senderRole: string
  createdAt: string
  parts: MessagePart[]
  mentions?: string[]
  agentRunId?: string
  delivery?: DeliveryStatus
  stream?: AgentStream
}

export interface ClinicConversation {
  id: string
  type: ConversationType
  title: string
  subtitle: string
  patientKey?: PatientKey
  followupPlanId?: string
  status: 'active' | 'read_only'
  unreadStaff: number
  unreadPatient: number
  membershipVersion: number
  members: ConversationMember[]
  messages: ChatMessage[]
}

export interface FollowupResponseItem {
  id: string
  submittedAt: string
  symptomScore: string
  temperature: string
  adherence: string
  note: string
}

export interface FollowupSummaryItem {
  id: string
  version: number
  status: 'draft' | 'approved' | 'rejected'
  createdAt: string
  sourceResponseIds: string[]
  content: string
  reviewedBy?: string
  reviewedAt?: string
}

export interface FollowupPlan {
  id: string
  patientKey: PatientKey
  ownerStaffId: StaffRole
  title: string
  department: string
  status: 'active' | 'completed'
  conversationId: string
  startDate: string
  endDate: string
  taskStatus: 'pending' | 'submitted' | 'reviewed'
  taskTitle: string
  dueLabel: string
  responses: FollowupResponseItem[]
  summaries: FollowupSummaryItem[]
}

export interface AgentRunRecord {
  id: string
  agentName: 'Patient Service Agent' | 'Follow-up Agent' | 'Clinical Copilot'
  conversationId: string
  triggerLabel: string
  status: 'running' | 'settled' | 'failed'
  startedAt: string
  durationMs: number
  tools: { name: string; scope: string; status: 'ok' | 'running' | 'denied'; summary: string }[]
  auditNote: string
}

export interface SyncEvent {
  id: string
  at: string
  owner: 'ClinicWorkspaceDO' | 'WuKongIM' | 'DurableAgent' | 'SecurityGate'
  origin: '医生工作台' | '患者手机版' | 'Agent Runtime'
  summary: string
  tone: 'info' | 'success' | 'warning' | 'destructive'
}

export interface ConnectedClinicState {
  currentStaff: StaffRole
  currentPatient: PatientKey
  appointments: ClinicAppointment[]
  slots: AppointmentSlot[]
  encounters: ClinicalEncounterState[]
  resources: PublishedResource[]
  conversations: ClinicConversation[]
  followupPlans: FollowupPlan[]
  agentRuns: AgentRunRecord[]
  syncEvents: SyncEvent[]
  lastIsolationBlock: string | null
  typing: { staff: string | null; patient: string | null }
}

export const STAFF_ACTORS: Record<StaffRole, StaffActor> = {
  doctor_a: {
    id: 'doctor_a',
    name: '王明',
    title: '主治医师 · 医生 A',
    role: 'doctor',
    department: '全科医学科',
    avatar: '王',
    imUid: 'im_staff_dr_wang',
  },
  doctor_b: {
    id: 'doctor_b',
    name: '林悦',
    title: '副主任医师 · 医生 B',
    role: 'doctor',
    department: '心内科',
    avatar: '林',
    imUid: 'im_staff_dr_lin',
  },
  nurse_n: {
    id: 'nurse_n',
    name: '周岚',
    title: '主管护师 · 护士 N',
    role: 'nurse',
    department: '全科 / 随访护理',
    avatar: '周',
    imUid: 'im_staff_nurse_zhou',
  },
}

export const PATIENTS: Record<PatientKey, PatientProfile> = {
  patient_a: {
    id: 'patient_a',
    patientId: 'pat_01_lijg',
    name: '李建国',
    sex: '男',
    age: 58,
    avatar: '李',
    chiefComplaint: '发热、咳嗽 3 天',
    allergies: ['青霉素（皮疹）'],
    chronicConditions: ['原发性高血压（控制稳定）'],
    vitals: [
      { label: '体温', value: '38.2', unit: '°C', abnormal: true },
      { label: '血压', value: '134/84', unit: 'mmHg' },
      { label: '心率', value: '92', unit: 'bpm' },
      { label: 'SpO₂', value: '97', unit: '%' },
    ],
    mobileBound: true,
    inviteCode: 'CM-DEMO-A01',
    imUid: 'im_pat_01_lijg',
  },
  patient_b: {
    id: 'patient_b',
    patientId: 'pat_02_chenzy',
    name: '陈志远',
    sex: '男',
    age: 67,
    avatar: '陈',
    chiefComplaint: '间断胸骨后闷痛 6 小时，伴出汗、气促',
    allergies: ['无已知药物过敏'],
    chronicConditions: ['2 型糖尿病', '高脂血症'],
    vitals: [
      { label: '体温', value: '36.7', unit: '°C' },
      { label: '血压', value: '152/94', unit: 'mmHg', abnormal: true },
      { label: '心率', value: '104', unit: 'bpm', abnormal: true },
      { label: 'SpO₂', value: '95', unit: '%' },
    ],
    mobileBound: true,
    inviteCode: 'CM-DEMO-B02',
    imUid: 'im_pat_02_chenzy',
  },
  patient_c: {
    id: 'patient_c',
    patientId: 'pat_03_wangxy',
    name: '王秀英',
    sex: '女',
    age: 54,
    avatar: '王',
    chiefComplaint: '多饮、多尿伴尿频、尿急 2 周',
    allergies: ['磺胺类药物'],
    chronicConditions: ['糖耐量异常史'],
    vitals: [
      { label: '体温', value: '36.9', unit: '°C' },
      { label: '血压', value: '128/80', unit: 'mmHg' },
      { label: '心率', value: '82', unit: 'bpm' },
      { label: 'SpO₂', value: '99', unit: '%' },
    ],
    mobileBound: true,
    inviteCode: 'CM-DEMO-C03',
    imUid: 'im_pat_03_wangxy',
  },
}

export function nowClock() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function createInitialClinicState(): ConnectedClinicState {
  return {
    currentStaff: 'doctor_a',
    currentPatient: 'patient_a',
    lastIsolationBlock: null,
    typing: { staff: null, patient: null },
    slots: [
      {
        id: 'slot_wang_am_0900',
        doctorId: 'doctor_a',
        doctorName: '王明 医生',
        department: '全科医学科',
        dateLabel: '明天 (11/27)',
        timeRange: '09:00 – 09:30',
        capacity: 3,
        booked: 1,
      },
      {
        id: 'slot_wang_am_1000',
        doctorId: 'doctor_a',
        doctorName: '王明 医生',
        department: '全科医学科',
        dateLabel: '明天 (11/27)',
        timeRange: '10:00 – 10:30',
        capacity: 2,
        booked: 1,
      },
      {
        id: 'slot_wang_am_1100',
        doctorId: 'doctor_a',
        doctorName: '王明 医生',
        department: '全科医学科',
        dateLabel: '明天 (11/27)',
        timeRange: '11:00 – 11:30',
        capacity: 2,
        booked: 2,
      },
      {
        id: 'slot_lin_pm_1400',
        doctorId: 'doctor_b',
        doctorName: '林悦 医生',
        department: '心内科',
        dateLabel: '明天 (11/27)',
        timeRange: '14:00 – 14:30',
        capacity: 3,
        booked: 1,
      },
    ],
    appointments: [
      {
        id: 'apt_1001',
        patientKey: 'patient_a',
        slotId: 'slot_today_0900',
        doctorId: 'doctor_a',
        doctorName: '王明 医生',
        department: '全科医学科',
        dateLabel: '今日',
        timeRange: '09:00 – 09:30',
        chiefComplaint: '发热、咳嗽 3 天',
        status: 'in_encounter',
        source: 'manual',
        encounterId: 'enc_active_01',
        createdAt: '08:32',
      },
      {
        id: 'apt_1002',
        patientKey: 'patient_b',
        slotId: 'slot_today_0930',
        doctorId: 'doctor_b',
        doctorName: '林悦 医生',
        department: '心内科',
        dateLabel: '今日',
        timeRange: '09:30 – 10:00',
        chiefComplaint: '间断胸骨后闷痛 6 小时，伴出汗、气促',
        status: 'checked_in',
        source: 'manual',
        createdAt: '08:50',
      },
      {
        id: 'apt_1003',
        patientKey: 'patient_c',
        slotId: 'slot_today_1030',
        doctorId: 'doctor_a',
        doctorName: '王明 医生',
        department: '全科医学科',
        dateLabel: '今日',
        timeRange: '10:30 – 11:00',
        chiefComplaint: '多饮、多尿伴尿频、尿急 2 周',
        status: 'booked',
        source: 'agent_assisted',
        createdAt: '09:12',
      },
    ],
    encounters: [
      {
        id: 'enc_active_01',
        appointmentId: 'apt_1001',
        patientKey: 'patient_a',
        practitionerId: 'doctor_a',
        status: 'active',
        outpatientNumber: 'OP-20261126-001',
        chiefComplaint: '发热、咳嗽 3 天',
        signedNote: true,
        diagnosisConfirmed: true,
        diagnosisText: '急性下呼吸道感染（待进一步随访评估）',
        reportsAcknowledged: true,
        prescriptionIssued: true,
        noPendingDrafts: true,
        releasedToPatient: false,
      },
    ],
    resources: [
      {
        id: 'rec_lijg_20261126',
        kind: 'record',
        patientKey: 'patient_a',
        encounterId: 'enc_active_01',
        title: '全科门诊病历（2026-11-26）',
        subtitle: '主诉：发热、咳嗽 3 天 · 已签署 v1',
        department: '全科医学科',
        doctorName: '王明 医生',
        version: 1,
        published: true,
        publishedAt: '09:42',
        summary: '患者 3 天前受凉后出现发热（最高 38.4°C）、咳嗽伴黄痰，双肺底可闻及散在湿啰音。已行血常规、CRP 及胸部影像检查，予对症抗感染及退热支持，嘱 72 小时随访复评。',
        details: [
          { label: '主诉', value: '发热、咳嗽 3 天' },
          { label: '查体摘要', value: 'T 38.2°C，咽部轻度充血，右下肺可闻及少量细湿啰音' },
          { label: '临床诊断', value: '急性支气管炎 / 社区获得性呼吸道感染（已确认）' },
          { label: '处理与随访', value: '规律服药，多饮水，体温监测，纳入 7 日线上随访计划' },
        ],
      },
      {
        id: 'rep_lijg_cbc_v2',
        kind: 'report',
        patientKey: 'patient_a',
        encounterId: 'enc_active_01',
        title: '血常规 + 超敏 CRP 检验报告',
        subtitle: '检验科已签发 · 第 2 版（已更正复核）',
        department: '检验科',
        doctorName: '王明 医生已阅',
        version: 2,
        published: true,
        publishedAt: '09:45',
        summary: '白细胞及超敏 C 反应蛋白轻度升高，支持急性感染性炎症过程，血红蛋白及血小板正常。',
        details: [
          { label: '白细胞计数 (WBC)', value: '11.4 ×10⁹/L', flag: 'high' },
          { label: '中性粒细胞比例', value: '78.6 %', flag: 'high' },
          { label: '超敏 CRP', value: '24.8 mg/L', flag: 'high' },
          { label: '血红蛋白 (Hb)', value: '142 g/L', flag: 'normal' },
        ],
      },
      {
        id: 'rep_lijg_ct_unpub',
        kind: 'report',
        patientKey: 'patient_a',
        encounterId: 'enc_active_01',
        title: '胸部低剂量 CT 影像报告',
        subtitle: '影像科已出片 · 待医生显式发布至手机版',
        department: '医学影像科',
        doctorName: '王明 医生已阅',
        version: 1,
        published: false,
        summary: '右下肺野见小片状模糊渗出影，余肺野清晰，纵隔未见明显肿大淋巴结。建议抗感染治疗后复查。',
        details: [
          { label: '检查部位', value: '胸部平扫（低剂量）' },
          { label: '影像所见', value: '右下肺背段见斑片状磨玻璃样及淡薄渗出影' },
          { label: '影像意见', value: '考虑右下肺轻度炎性病变，请结合临床' },
        ],
      },
      {
        id: 'rx_lijg_01',
        kind: 'prescription',
        patientKey: 'patient_a',
        encounterId: 'enc_active_01',
        title: '全科门诊处方 #RX-261126-08',
        subtitle: '已签发 · 规避青霉素过敏史 · 只读',
        department: '全科医学科',
        doctorName: '王明 医生',
        version: 1,
        published: true,
        publishedAt: '09:46',
        summary: '避开患者青霉素过敏史，开具大环内酯类口服及对症止咳化痰方案（演示合成处方，仅供演示）。',
        details: [
          { label: '阿奇霉素分散片 0.25g', value: '口服，首日 0.5g，第 2–5 日每日 0.25g 一次' },
          { label: '氨溴索口服溶液 10ml', value: '口服，每日三次，饭后服用' },
          { label: '用药安全提示', value: '已核对青霉素过敏史；如高热持续 >48h 或气促加重请及时线下复诊' },
        ],
      },
      {
        id: 'rec_chenzy_prior',
        kind: 'record',
        patientKey: 'patient_b',
        encounterId: 'enc_hist_b1',
        title: '心内科复诊病历（2026-10-18）',
        subtitle: '主诉：血压及血糖定期复查 · 已签署 v1',
        department: '心内科',
        doctorName: '林悦 医生',
        version: 1,
        published: true,
        publishedAt: '10-18 15:20',
        summary: '既往 2 型糖尿病及血脂异常，规律服药，近 1 月偶有活动后轻度乏力，嘱监测家庭血压。',
        details: [
          { label: '主诉', value: '常规心内科慢病复查' },
          { label: '诊断', value: '2 型糖尿病；高脂血症' },
          { label: '随访建议', value: '如出现胸闷、胸痛或出汗不适立即就近急诊评估' },
        ],
      },
    ],
    conversations: [
      {
        id: 'conv_assistant_a',
        type: 'patient_assistant',
        title: 'AI 就医助手',
        subtitle: '李建国 · 专属私人服务会话',
        patientKey: 'patient_a',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 1,
        members: [
          { id: 'patient_a', name: '李建国', kind: 'human', roleLabel: '患者本人', avatar: '李', status: 'active' },
          { id: 'agent_patient_svc', name: 'AI 就医助手', kind: 'agent', roleLabel: 'Patient Service Agent', avatar: 'AI', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_pa_1',
            conversationId: 'conv_assistant_a',
            sequence: 1,
            senderId: 'agent_patient_svc',
            senderName: 'AI 就医助手',
            senderKind: 'agent',
            senderRole: 'Patient Service Agent',
            createdAt: '09:05',
            parts: [
              {
                type: 'text',
                text: '您好李先生，我是您的专属就医助手。我可以帮您查询可用号源、预填预约、查阅医生已发布的病历与报告，或联系您的医疗团队。所有正式预约均需您本人确认。',
              },
            ],
          },
        ],
      },
      {
        id: 'conv_pd_a',
        type: 'patient_doctor',
        title: '李建国 · 医患直连',
        subtitle: '患者 A ↔ 王明 医生（全科）',
        patientKey: 'patient_a',
        status: 'active',
        unreadStaff: 1,
        unreadPatient: 0,
        membershipVersion: 1,
        members: [
          { id: 'patient_a', name: '李建国', kind: 'human', roleLabel: '患者 A', avatar: '李', status: 'active' },
          { id: 'doctor_a', name: '王明', kind: 'human', roleLabel: '主治医师', avatar: '王', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_pd_1',
            conversationId: 'conv_pd_a',
            sequence: 1,
            senderId: 'patient_a',
            senderName: '李建国',
            senderKind: 'human',
            senderRole: '患者',
            createdAt: '10:02',
            delivery: 'read',
            parts: [
              { type: 'text', text: '王医生您好，我刚才在药房取了药，想问下今天抽血结果大概什么时候可以在手机上看到？' },
            ],
          },
          {
            id: 'msg_pd_2',
            conversationId: 'conv_pd_a',
            sequence: 2,
            senderId: 'patient_a',
            senderName: '李建国',
            senderKind: 'human',
            senderRole: '患者',
            createdAt: '10:03',
            delivery: 'sent',
            parts: [
              {
                type: 'audio',
                attachmentId: 'att_audio_1002',
                durationSec: 11,
                asrStatus: 'ready',
                transcript: '还有刚才咳嗽的时候胸口稍微有点闷，但歇一会儿就好了，需要提前复查吗？',
              },
            ],
          },
          {
            id: 'msg_pd_3',
            conversationId: 'conv_pd_a',
            sequence: 3,
            senderId: 'doctor_a',
            senderName: '王明 医生',
            senderKind: 'human',
            senderRole: '主治医师',
            createdAt: '10:06',
            parts: [
              { type: 'text', text: '李先生您好，您的血常规 + 超敏 CRP 第 2 版已经发布，点击下方卡片可直接查看。按时服药观察 48 小时，若胸闷持续或呼吸困难请立即线下就诊。' },
              {
                type: 'card',
                component: 'ReportCard',
                resourceId: 'rep_lijg_cbc_v2',
                title: '血常规 + 超敏 CRP 检验报告',
                subtitle: '第 2 版（已复核发布） · WBC 11.4↑ · CRP 24.8↑',
                meta: ['检验科', '王明 医生已阅', '需身份鉴权打开'],
                actionLabel: '查看已发布报告',
                actionName: 'report.open',
                statusTag: '已发布',
              },
            ],
          },
        ],
      },
      {
        id: 'conv_followup_a',
        type: 'followup_group',
        title: '李建国 · 呼吸道感染 7 日随访群',
        subtitle: '4 位成员 · 含 Follow-up Agent · 关联计划 #FP-01',
        patientKey: 'patient_a',
        followupPlanId: 'fp_01',
        status: 'active',
        unreadStaff: 2,
        unreadPatient: 1,
        membershipVersion: 3,
        members: [
          { id: 'patient_a', name: '李建国', kind: 'human', roleLabel: '患者本人', avatar: '李', status: 'active' },
          { id: 'doctor_a', name: '王明', kind: 'human', roleLabel: '主管医生', avatar: '王', status: 'active' },
          { id: 'nurse_n', name: '周岚', kind: 'human', roleLabel: '随访护士', avatar: '周', status: 'active' },
          { id: 'agent_followup', name: '随访助手', kind: 'agent', roleLabel: 'Follow-up Agent', avatar: 'AI', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_fg_1',
            conversationId: 'conv_followup_a',
            sequence: 1,
            senderId: 'system',
            senderName: '系统',
            senderKind: 'system',
            senderRole: 'System',
            createdAt: '10:15',
            parts: [{ type: 'text', text: '王明 医生创建了「呼吸道感染 7 日随访计划」，已邀请周岚 护士与 @随访助手 加入本群。' }],
          },
          {
            id: 'msg_fg_2',
            conversationId: 'conv_followup_a',
            sequence: 2,
            senderId: 'agent_followup',
            senderName: '随访助手',
            senderKind: 'agent',
            senderRole: 'Follow-up Agent',
            createdAt: '10:16',
            agentRunId: 'run_fu_01',
            parts: [
              { type: 'text', text: '李先生您好，为了协助王医生与周护士了解您服药后的恢复情况，请填写第 1 次症状随访问卷：' },
              {
                type: 'card',
                component: 'FollowupFormCard',
                resourceId: 'fp_01',
                taskId: 'task_fp01_d1',
                title: '48 小时体温与咳嗽症状随访问卷',
                subtitle: '问卷版本 v1.2 · 覆盖体温、咳嗽评分与服药依从性',
                meta: ['计划 #FP-01', '截止 今日 20:00', '约 30 秒'],
                actionLabel: '填写并提交反馈',
                actionName: 'followup.submit',
                statusTag: '待患者填写',
              },
            ],
          },
          {
            id: 'msg_fg_3',
            conversationId: 'conv_followup_a',
            sequence: 3,
            senderId: 'patient_a',
            senderName: '李建国',
            senderKind: 'human',
            senderRole: '患者',
            createdAt: '10:28',
            delivery: 'read',
            parts: [
              {
                type: 'audio',
                attachmentId: 'att_audio_fg_03',
                durationSec: 12,
                asrStatus: 'ready',
                transcript: '王医生周护士好，上午吃完阿奇霉素和止咳糖浆后退烧了，刚量体温 37.3 度，晚点我把问卷填上。',
              },
            ],
          },
          {
            id: 'msg_fg_4',
            conversationId: 'conv_followup_a',
            sequence: 4,
            senderId: 'nurse_n',
            senderName: '周岚 护士',
            senderKind: 'human',
            senderRole: '随访护士',
            createdAt: '10:31',
            parts: [
              {
                type: 'text',
                text: '收到李先生，体温回落是个好信号。请多喝温水，按时完成 5 天疗程，晚上 8 点前点击上方卡片打卡即可；若再次超过 38.5°C 或胸闷加重请随时在群里告知。',
              },
            ],
          },
        ],
      },
      {
        id: 'conv_assistant_b',
        type: 'patient_assistant',
        title: 'AI 就医助手',
        subtitle: '陈志远 · 专属私人服务会话',
        patientKey: 'patient_b',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 1,
        members: [
          { id: 'patient_b', name: '陈志远', kind: 'human', roleLabel: '患者本人', avatar: '陈', status: 'active' },
          { id: 'agent_patient_svc', name: 'AI 就医助手', kind: 'agent', roleLabel: 'Patient Service Agent', avatar: 'AI', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_pb_1',
            conversationId: 'conv_assistant_b',
            sequence: 1,
            senderId: 'agent_patient_svc',
            senderName: 'AI 就医助手',
            senderKind: 'agent',
            senderRole: 'Patient Service Agent',
            createdAt: '09:31',
            parts: [
              {
                type: 'text',
                text: '陈先生您好，您已在心内科签到候诊。我可以帮您查看排队进度、医生已发布的病历，或把问题整理好转给林悦医生。如胸痛加重、大汗或呼吸困难，请立即告知分诊护士或拨打 120。',
              },
            ],
          },
        ],
      },
      {
        id: 'conv_pd_b',
        type: 'patient_doctor',
        title: '陈志远 · 医患直连',
        subtitle: '患者 B ↔ 林悦 医生（心内科）',
        patientKey: 'patient_b',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 1,
        membershipVersion: 1,
        members: [
          { id: 'patient_b', name: '陈志远', kind: 'human', roleLabel: '患者 B', avatar: '陈', status: 'active' },
          { id: 'doctor_b', name: '林悦', kind: 'human', roleLabel: '副主任医师', avatar: '林', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_pdb_1',
            conversationId: 'conv_pd_b',
            sequence: 1,
            senderId: 'doctor_b',
            senderName: '林悦 医生',
            senderKind: 'human',
            senderRole: '副主任医师',
            createdAt: '09:24',
            parts: [
              { type: 'text', text: '陈先生，已看到您的分诊信息。请在候诊区坐下休息，不要自行走动，护士会先给您复测血压和心电图，我这边马上接诊。' },
            ],
          },
        ],
      },
      {
        id: 'conv_assistant_c',
        type: 'patient_assistant',
        title: 'AI 就医助手',
        subtitle: '王秀英 · 专属私人服务会话',
        patientKey: 'patient_c',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 1,
        members: [
          { id: 'patient_c', name: '王秀英', kind: 'human', roleLabel: '患者本人', avatar: '王', status: 'active' },
          { id: 'agent_patient_svc', name: 'AI 就医助手', kind: 'agent', roleLabel: 'Patient Service Agent', avatar: 'AI', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_pc_1',
            conversationId: 'conv_assistant_c',
            sequence: 1,
            senderId: 'agent_patient_svc',
            senderName: 'AI 就医助手',
            senderKind: 'agent',
            senderRole: 'Patient Service Agent',
            createdAt: '09:12',
            parts: [
              {
                type: 'text',
                text: '王女士您好，您今天 10:30 的全科门诊已预约成功。我可以帮您改约、查看已发布的检查结果，或提醒您完成血糖打卡。',
              },
            ],
          },
        ],
      },
      {
        id: 'conv_pd_c',
        type: 'patient_doctor',
        title: '王秀英 · 医患直连',
        subtitle: '患者 C ↔ 王明 医生（全科）',
        patientKey: 'patient_c',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 1,
        members: [
          { id: 'patient_c', name: '王秀英', kind: 'human', roleLabel: '患者 C', avatar: '王', status: 'active' },
          { id: 'doctor_a', name: '王明', kind: 'human', roleLabel: '主治医师', avatar: '王', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_pdc_1',
            conversationId: 'conv_pd_c',
            sequence: 1,
            senderId: 'patient_c',
            senderName: '王秀英',
            senderKind: 'human',
            senderRole: '患者',
            createdAt: '08:40',
            delivery: 'read',
            parts: [{ type: 'text', text: '王医生早，今天复诊需要空腹抽血吗？' }],
          },
          {
            id: 'msg_pdc_2',
            conversationId: 'conv_pd_c',
            sequence: 2,
            senderId: 'doctor_a',
            senderName: '王明 医生',
            senderKind: 'human',
            senderRole: '主治医师',
            createdAt: '08:46',
            parts: [{ type: 'text', text: '需要的，早餐先不吃，带上这两周的血糖记录本，抽完血再吃东西。' }],
          },
        ],
      },
      {
        id: 'conv_followup_c',
        type: 'followup_group',
        title: '王秀英 · 血糖 14 日随访群',
        subtitle: '4 位成员 · 含 Follow-up Agent · 关联计划 #FP-02',
        patientKey: 'patient_c',
        followupPlanId: 'fp_02',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 2,
        members: [
          { id: 'patient_c', name: '王秀英', kind: 'human', roleLabel: '患者本人', avatar: '王', status: 'active' },
          { id: 'doctor_a', name: '王明', kind: 'human', roleLabel: '主管医生', avatar: '王', status: 'active' },
          { id: 'nurse_n', name: '周岚', kind: 'human', roleLabel: '随访护士', avatar: '周', status: 'active' },
          { id: 'agent_followup', name: '随访助手', kind: 'agent', roleLabel: 'Follow-up Agent', avatar: 'AI', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_fc_1',
            conversationId: 'conv_followup_c',
            sequence: 1,
            senderId: 'patient_c',
            senderName: '王秀英',
            senderKind: 'human',
            senderRole: '患者',
            createdAt: '昨日 19:40',
            delivery: 'read',
            parts: [{ type: 'text', text: '已提交第 2 次血糖打卡：空腹 7.4，夜里起夜两次。' }],
          },
          {
            id: 'msg_fc_2',
            conversationId: 'conv_followup_c',
            sequence: 2,
            senderId: 'agent_followup',
            senderName: '随访助手',
            senderKind: 'agent',
            senderRole: 'Follow-up Agent',
            createdAt: '08:15',
            parts: [{ type: 'text', text: '王女士，您的打卡已收到并转交王医生审核。今天复诊记得带上血糖记录。' }],
          },
        ],
      },
      {
        id: 'conv_staff_dept',
        type: 'staff_group',
        title: '全科 × 心内科 协同会诊群',
        subtitle: '内部医护群 · 3 位成员 · 患者不可见',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 2,
        members: [
          { id: 'doctor_a', name: '王明', kind: 'human', roleLabel: '全科医生', avatar: '王', status: 'active' },
          { id: 'doctor_b', name: '林悦', kind: 'human', roleLabel: '心内科医生', avatar: '林', status: 'active' },
          { id: 'nurse_n', name: '周岚', kind: 'human', roleLabel: '主管护师', avatar: '周', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_sg_1',
            conversationId: 'conv_staff_dept',
            sequence: 1,
            senderId: 'nurse_n',
            senderName: '周岚 护士',
            senderKind: 'human',
            senderRole: '主管护师',
            createdAt: '09:20',
            parts: [
              { type: 'text', text: '林医生，2 号陈志远先生已签到，诉胸骨后闷痛 6 小时，分诊血压 152/94、心率 104，建议优先安排接诊评估。' },
            ],
          },
          {
            id: 'msg_sg_2',
            conversationId: 'conv_staff_dept',
            sequence: 2,
            senderId: 'doctor_b',
            senderName: '林悦 医生',
            senderKind: 'human',
            senderRole: '副主任医师',
            createdAt: '09:22',
            parts: [
              { type: 'text', text: '收到，等当前唯一在诊诊室空出后我立即接诊，先请分诊台做好生命体征复测。' },
            ],
          },
        ],
      },
      {
        id: 'conv_staff_direct',
        type: 'staff_direct',
        title: '王明 医生 ↔ 周岚 护士',
        subtitle: '医护私聊 · 随访交接',
        status: 'active',
        unreadStaff: 0,
        unreadPatient: 0,
        membershipVersion: 1,
        members: [
          { id: 'doctor_a', name: '王明', kind: 'human', roleLabel: '主治医师', avatar: '王', status: 'active' },
          { id: 'nurse_n', name: '周岚', kind: 'human', roleLabel: '主管护师', avatar: '周', status: 'active' },
        ],
        messages: [
          {
            id: 'msg_sd_1',
            conversationId: 'conv_staff_direct',
            sequence: 1,
            senderId: 'doctor_a',
            senderName: '王明 医生',
            senderKind: 'human',
            senderRole: '主治医师',
            createdAt: '10:12',
            parts: [{ type: 'text', text: '周护士，李建国刚纳入 7 日随访，下午若体温仍超过 38.5°C 请安排一次人工电话回访。' }],
          },
        ],
      },
    ],
    followupPlans: [
      {
        id: 'fp_01',
        patientKey: 'patient_a',
        ownerStaffId: 'doctor_a',
        title: '急性下呼吸道感染 7 日居家随访',
        department: '全科医学科',
        status: 'active',
        conversationId: 'conv_followup_a',
        startDate: '2026-11-26',
        endDate: '2026-12-03',
        taskStatus: 'pending',
        taskTitle: '第 1 次：48 小时体温与咳嗽症状随访问卷',
        dueLabel: '今日 20:00 前',
        responses: [],
        summaries: [],
      },
      {
        id: 'fp_02',
        patientKey: 'patient_c',
        ownerStaffId: 'doctor_a',
        title: '血糖与泌尿道症状 14 日监测随访',
        department: '全科医学科',
        status: 'active',
        conversationId: 'conv_followup_c',
        startDate: '2026-11-20',
        endDate: '2026-12-04',
        taskStatus: 'submitted',
        taskTitle: '第 2 次：空腹血糖及排尿症状打卡',
        dueLabel: '已完成提交',
        responses: [
          {
            id: 'resp_fp02_01',
            submittedAt: '昨日 19:40',
            symptomScore: '尿频较前减轻（3/10）',
            temperature: '36.6°C',
            adherence: '按医嘱每日记录饮水量',
            note: '晨起空腹末梢血糖 7.4 mmol/L，夜间起夜由 4 次减至 2 次。',
          },
        ],
        summaries: [
          {
            id: 'sum_fp02_v1',
            version: 1,
            status: 'draft',
            createdAt: '今日 08:15',
            sourceResponseIds: ['resp_fp02_01'],
            content:
              '【待医生审核草稿】依据患者 11-25 提交的随访反馈（resp_fp02_01）：尿频症状较基线减轻（自评 3/10），夜尿次数由 4 次降至 2 次，晨起空腹末梢血糖 7.4 mmol/L，未报告发热或腰痛。建议医生结合今日复诊检验进一步评估。',
          },
        ],
      },
    ],
    agentRuns: [
      {
        id: 'run_fu_01',
        agentName: 'Follow-up Agent',
        conversationId: 'conv_followup_a',
        triggerLabel: '随访计划 #FP-01 定时任务触发',
        status: 'settled',
        startedAt: '10:16:02',
        durationMs: 1180,
        tools: [
          { name: 'get_followup_plan', scope: 'plan:fp_01', status: 'ok', summary: '读取计划与当前待办任务 task_fp01_d1' },
          { name: 'present_followup_form', scope: 'conv:conv_followup_a', status: 'ok', summary: '投递版本化问卷卡片 v1.2' },
        ],
        auditNote: '只读绑定单患者单计划 scope；无隐藏思考与 Case Truth 访问。',
      },
      {
        id: 'run_cop_01',
        agentName: 'Clinical Copilot',
        conversationId: 'enc_active_01',
        triggerLabel: '环境感知 · 血常规第 2 版报告入库',
        status: 'settled',
        startedAt: '09:38:14',
        durationMs: 1640,
        tools: [
          { name: 'read_released_reports', scope: 'enc:enc_active_01', status: 'ok', summary: '读取 WBC 11.4↑ / CRP 24.8↑' },
          { name: 'propose_note_draft', scope: 'ui-draft', status: 'ok', summary: '生成病历草稿建议（等待医生签署）' },
        ],
        auditNote: '严格遵循只读 + UI 草稿边界；禁止直接提交正式临床记录。',
      },
    ],
    syncEvents: [
      {
        id: 'ev_init_1',
        at: '10:16',
        owner: 'DurableAgent',
        origin: 'Agent Runtime',
        summary: 'Follow-up Agent 向「李建国随访群」投递问卷卡片 (run_fu_01 settled)',
        tone: 'info',
      },
      {
        id: 'ev_init_2',
        at: '10:06',
        owner: 'WuKongIM',
        origin: '医生工作台',
        summary: '王明 医生发送 ReportCard（血常规 v2）至医患私聊 seq #3',
        tone: 'success',
      },
      {
        id: 'ev_init_3',
        at: '09:42',
        owner: 'ClinicWorkspaceDO',
        origin: '医生工作台',
        summary: '显式发布「全科门诊病历 v1」至患者手机版安全投影 (patient_release)',
        tone: 'success',
      },
    ],
  }
}

export type ClinicSide = 'staff' | 'patient'

export interface BookingResult {
  ok: boolean
  message: string
  appointmentId?: string
}

export interface FollowupPayload {
  symptomScore: string
  temperature: string
  adherence: string
  note: string
}

export interface ClinicActions {
  setStaff: (role: StaffRole) => void
  setPatient: (patient: PatientKey) => void
  resetDemo: () => void
  bookAppointment: (slotId: string, source: 'manual' | 'agent_assisted', complaint?: string) => BookingResult
  checkInAppointment: (appointmentId: string) => void
  startEncounterFromAppointment: (appointmentId: string) => { ok: boolean; message: string }
  completeActiveEncounter: () => void
  toggleResourcePublish: (resourceId: string) => void
  sendMessage: (conversationId: string, senderType: ClinicSide, text: string) => void
  sendVoiceMessage: (conversationId: string, senderType: ClinicSide, transcript: string, durationSec?: number) => void
  shareResourceCard: (conversationId: string, resourceId: string) => void
  toggleGroupMember: (conversationId: string, memberId: string) => void
  askPatientAgent: (prompt: string) => void
  stopAgentRun: (messageId: string) => void
  sendHandoff: (messageId: string) => void
  submitFollowupQuestionnaire: (planId: string, payload: FollowupPayload) => void
  triggerFollowupAgentSummary: (planId: string) => void
  reviewFollowupSummary: (planId: string, summaryId: string, decision: 'approved' | 'rejected') => void
  closeFollowupPlan: (planId: string) => void
  testCrossPatientIsolation: () => void
  dismissIsolationBlock: () => void
  focusConversation: (side: ClinicSide, conversationId: string | null) => void
  setTyping: (side: ClinicSide, conversationId: string | null) => void
}
