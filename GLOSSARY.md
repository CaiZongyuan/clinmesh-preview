# ClinMesh Preview 门诊诊疗领域

本系统面向单医生门诊场景，结合模拟患者与无感化医生助理，支持从接诊、医患对话、检查检验、诊断、开方到病历签署与完诊的完整门诊闭环。本词汇表仅定义领域概念，不记录技术实现。

## 仿真与病例来源

**Golden Case**:
预先编写、版本固定的黄金门诊病例，包含完整的患者基础资料、`Visible Source History`、`Patient Persona` 与预先备齐的 `Case Truth`（含全部检验、影像、功能检查数据）。准备病例不产生本院就诊、检查或处方事实。
_Avoid_: Authored Case Pack, seed data, fixture, mock patient

**Visible Source History**:
本次就诊开始前允许医生和 `Clinical Copilot` 查阅的既往病史、既往过敏与基线信息。它属于历史背景，不等同于本次就诊新形成的临床结论。
_Avoid_: Case Truth, current Clinical Note

**Patient Persona**:
驱动模拟患者表达的版本固定档案，包含性格、表达方式、主诉体验与自知病史。它只描述患者本人知道的内容，不直接暴露尚未确诊的疾病名称或客观检查真值。
_Avoid_: System prompt, Case Truth, chat script

**Case Truth**:
与一次合成病例绑定的隐藏客观事实，包含真实病情、客观体征及检查检验结果依据。它对医生和医生助理不可直接读取，只能经由合规问诊或开立检查逐步揭示。
_Avoid_: Answer key, clinical record, Visible Source History

**Simulated Patient**:
依据固定 Patient Persona 与医生互动的虚拟患者参与者，负责在问诊中按患者视角应答，不替医生作临床判断。
_Avoid_: Chatbot, real patient, Patient Persona

## 门诊诊疗主线

**Encounter**:
一名患者在本院发生的一次完整门诊接诊周期，贯穿医患问诊、检查申请、报告确认、诊断、处方与文书签署，直至医生显式完诊。
_Avoid_: Consultation, session, chat, visit ticket

**Consultation**:
一次 Encounter 中的医患实时对话过程，按顺序记录医生与患者的发言原文。它保留沟通证据，不等同于医生整理和签署的正式病历。
_Avoid_: Encounter, Clinical Note, chat log

**Encounter Abandonment**:
负责医生显式放弃一次尚未完诊的 Encounter 的临床事实。被放弃的 Encounter 冻结写入、不解锁 Case Truth，也不视为完诊。
_Avoid_: Cancel encounter, delete encounter, reset

**Physical Examination**:
负责医生针对本次 Encounter 按部位执行的查体动作，其发现依据 Case Truth 即时确定性揭示。查体发现属于客观证据，不同于患者口述，也不需要已阅确认。
_Avoid_: Patient self-report, Investigation, vitals in Visible Source History

**Investigation**:
医生针对本次 Encounter 正式签发的检验或检查申请。申请成立不等于结果已返回，也不等于医生已核对报告。首份 Report 签发前可经确认后取消；已取消的申请不再要求已阅。
_Avoid_: Lab order draft, report, test result

**Report**:
针对一项 Investigation 正式签发的检查检验结果修订。结果更正会形成新版本，医生对旧版本的已阅确认不自动覆盖最新版本。
_Avoid_: Investigation, snapshot, raw finding

**Report Acknowledgement**:
负责医生明确确认已查看某份 Report 指定版本的临床事实。打开查看本身不构成已阅确认。
_Avoid_: Read receipt, report approval, viewed flag

**Diagnosis**:
负责医生针对本次 Encounter 正式确认的主次诊断集合，每次确认恰有一项主诊断。修订保留历史确认版本，草稿不具有正式效力。诊断修订晚于病历签署时，原签署病历不再满足完诊条件，须追加签署新修订。
_Avoid_: Differential suggestion, Diagnosis Draft, Case Truth

**Prescription**:
负责医生针对本次 Encounter 正式签发的用药方案集合。若医生评估无需用药，须记录独立的 **No Medication** 结论，而不是开立空处方。
_Avoid_: Medication draft, cart, empty prescription

**Clinical Note**:
负责医生针对本次 Encounter 整理并签署的结构化门诊病历。草稿可反复更新，签署后形成不可覆盖的正式版本，修改须追加新修订。
_Avoid_: Consultation, transcript, summary

## 临床辅助与确认边界

**Clinical Copilot**:
伴随负责医生开展本次 Encounter 的无感化临床助理，实时观察患者资料、医患对话与诊疗状态，提供分析建议并代填各类草稿。它没有正式医疗签发权。
_Avoid_: Doctor, autonomous prescriber, chatbot

**Draft**:
由医生编辑或由 Clinical Copilot 自动生成的待核对临床内容（包括候选诊断、待开检查、待开处方与病历草稿）。Draft 不是正式临床事实，不触发正式执行或完诊满足条件。
_Avoid_: Formal record, confirmed order, signed note

**Suggestion**:
Clinical Copilot 针对医生已编辑或正在关注的草稿内容提出的待处理修改建议，须医生逐条接受或驳回。Suggestion 不覆盖医生原文，也不是 Draft 本身。
_Avoid_: Auto-fill, overwrite, Draft

**Case Debrief**:
Encounter 完诊后才解锁的只读复盘，将本次正式临床记录与 Golden Case 参考逐项并排对照。它不产生评分，也不修改任何临床记录。
_Avoid_: Score, grading, answer reveal during encounter

**Clinical Confirmation**:
负责医生对高风险正式医疗意图（确认诊断、签发检查、签发处方或无需用药、确认报告已阅、签署病历、完诊）作出的显式人工放行。
_Avoid_: Auto-apply, silent commit, suggestion accept

**Completion Gate**:
办理门诊完诊前由服务端实时重验的五项强制临床前提（恰有一项已确认主诊断、所有未取消检查最新报告已阅、已签发有效处方或明确无需用药、已签署且不早于当前诊断的结构化病历、无遗留待确认高风险草稿）。高风险草稿指未签发也未丢弃的检查、处方或诊断草稿，以及未处理的 Suggestion。
_Avoid_: Frontend button state, checklist UI, soft warning
