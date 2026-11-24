# 患者就诊主线：从挂号到病案归档

**这条业务主线回答三个问题：患者是谁、这一次是谁负责、哪些事实足以结束这次照护。** 现场普通门诊与住院是两套业务过程，共享患者身份，不共享挂号、就诊号、账户或完成状态。以下是 ClinMesh 仿真医院的现状，不是通用医院规范。证据编号指向文末的源仓库路径。

## 一、认清对象与责任（M1）

| 对象 | 标识、关系及业务所有者 | 不可混用的事实 |
| --- | --- | --- |
| 合成患者档案、病例实例与院内患者 | 档案可有不可覆盖的修订，病例固定到一个修订；入院或挂号才建立本院事实。挂号员也能为没有病例来源者建档。 | 人物设定不是临床记录；手工建档不补造病史、隐藏病情或检查结果。[P1] |
| 患者身份（Patient Identity） | 一个患者可有多次门诊和住院。在同一数据世代，重复挂号沿用患者号，每次挂号另发门诊号；同一患者各次住院另发住院号，沿用首次住院生成的病案号。 | 患者号用于找人，门诊号与住院号用于找一次就诊，病案号用于归集病案。[P2、P10] |
| 现场挂号（Registration） | 挂号员为具体患者选业务日期、科室、号别、地点；一次成功办理关联一次就诊、候诊任务、账户和挂号应收。 | 不等于未来预约、医生已见到患者或费用已支付。候诊队列是等候工作，不是预约号源。[P1、P2] |
| 就诊（Encounter）与问诊（Consultation） | 一个门诊就诊贯穿分诊、当次首诊、当次复诊和完诊；带问诊的病例另有按顺序追加的医患对话。接诊时绑定实际负责医生岗位。 | 当次复诊不重挂号；出院后再次到门诊则是新挂号、新就诊和独立问诊。另一医生选中患者不改变经治责任。[P3、P4] |
| 分诊记录、诊断与门诊文书 | 分诊护士记录原始主诉、生命体征；医生从诊断草稿确认主次诊断，从文书草稿签署正式修订。已签版本和既往对话分别留存。 | 患者自述不是客观检查；推荐不是确诊，草稿不是签署件，签署件也不是完诊。[P3、P5] |
| 住院证、住院登记（Admission）与床位占用 | 住院证由经治门诊医生签发，只能转收一次；直接入院和转院登记不要求先办本院门诊。住院登记产生独立就诊和账户；一个住院可有多段床位占用。 | 已登记未必已入科；病区是地点，科室是责任组织；同一床同时至多一个占用，同一住院同时至多一张活动床。[P6] |
| 住院医嘱与执行单 | 住院医生对本次住院开药物或服务医嘱；病区护士校对，按频次形成执行单；药师发药、护士实际给药或实施服务。 | 一条长期医嘱可有多次执行；发药不是给药，发起按需执行不是已经给药。[P7] |
| 病案首页与归档件 | 主管医生提交首页修订，病案人员审核、退回或归档。每次提交固定其所用患者、诊断、过程、实际操作及账务来源。 | 首页不是门诊病历，也不是随患者基本信息动态变化的拼接页面。审核通过不等于已归档。[P10] |

## 二、门诊：排队、接诊与结束（M2／M3／ME）

| 环节与责任 | 输入 → 记录的事实 → 下一岗位 | 拒绝或恢复边界 |
| --- | --- | --- |
| 1. 挂号员办现场挂号 | 已选定患者或就绪且已有患者设定的合成病例 + 挂号目录 → 已挂号、待分诊；病例物化入口同时形成院内患者和问诊的来源绑定。 | 不同挂号员争抢同一待挂病例，只允许一个成功；失败方刷新。重复提交同一意图复用原回执；不是再签发一个门诊号。[P1、P2] |
| 2. 分诊护士交接给医生 | 本次待分诊记录 + 主诉及实测生命体征 → 分诊观察、医生候诊任务 → 医生接诊时建立病例责任。 | 分诊主诉保留原文。之后医生编辑病历不会改写分诊记录；未经授权的医生不能靠切换列表接管责任。[P3] |
| 3. 医生问诊、确认诊断 | 患者开场、医生提问、患者应答按次序留存；医生结合可见病史及正式报告形成诊断草稿，正式确认整个诊断组，恰有一项主诊断。 | 同一医生问题尚未获答时，不能追加下一问题；报告卡不是患者回答。回答失败保留问题，明确补答才产生新尝试。现有诊断的更正保留修订，不因编辑待确认草稿就改写正式诊断。[P3、P4] |
| 4. 医生处理检查与用药 | 按需开立检查，核对并确认最新报告；选择有效处方或明确记录无需用药。正式诊断、检查、处方和签署分别留痕。 | 查看报告不等于确认已阅；对旧报告的确认不能覆盖一份新的更正报告。没有检查申请不需制造报告；撤回处方不能当作无需用药。[P5] |
| 5. 医生签署、再单独完诊 | 结构化正文覆盖主诉、现病史、既往史、家族史、过敏史、月经史、孕产史、体格检查、辅助检查、评估、处置、随访。医生预览冻结的内容及责任版本后签署；另行办理完诊，写入本次就诊的结束时间。 | 草稿允许缺项，不代表每位患者签署时十二项全部必填。签署和修订检查模板、临床初复诊与适用条件。签署后新修订保留旧签署件；完诊不代收款、发药或结束全部场景。[P5] |

独立问诊路径的**七项完诊条件须同时成立**：①已确认主诊断；②有已签结构化病历；③所有未取消的检查申请均确认最新报告已阅；④已发有效处方或明确无需用药；⑤没有遗留诊断、检查、处方等待处理草稿（已有已签文书时保留的文书稿不拦截）；⑥已签正文的处置完整；⑦已签正文的随访完整。提交时重新计算，不以预览或按钮状态为准。另有针对特定情形的正式临床质控：安全红线不能覆盖，路径偏离需有权医生或获授权代理记录理由；这不是把日常病历文字质控建议变成第八项完诊条件。未带独立问诊的历史路径不能套用这一套完诊命令。[P5、P11]

**院后复诊示例：** 同一人出院后重新挂普通门诊。新就诊可以引用当前数据世代中唯一有效且已固定的病例来源；来源多义时不自动猜测。经治医生可读授权的既往门诊完诊记录和同患者已出院摘要，但住院历史用药不自动续成当前处方，未出院记录与隐藏病例依据也不进入该摘要。[P3]

## 三、住院：跨岗位交接（M2／M3／ME）

| 环节 | 谁对何物做什么 | 状态与后果 |
| --- | --- | --- |
| 登记及接床 | 登记员按直接、门诊转收、转院途径登记，并按实际情况收预交金；病区护士核对范围、接收并分配可用床。 | `registered → admitted`；零预交金不产生交易。重放登记不重收；同病区转床和两人互换床是原子操作，任一方版本过期，两人原床均保留。[P6] |
| 诊疗与护理 | 医生确认主次诊断及入院病情，签发长期或临时医嘱；护士校对。药物实际发药后到点给药；健康教育按实际执行完成；护士登记实测体征和风险评估。 | 医嘱 `signed → verified`，临时医嘱按完成执行收束；停嘱由医生申请、护士核停。执行单另有 `pending／dispensed／completed／cancelled`；已发未给不能记为已给。按需（PRN）须有当次理由，只创建待办。护理记录有来源，评分不能靠页面输入替代客观记录。[P7、P11] |
| 送检、接收与转科 | 医生开检查，病区护士校对送检，执行方完成报告。本科医生申请转科，原病区护士交接、目标病区护士选空床接收。 | `requested → handed-over → completed`；接收前可依规则取消。原科有效医嘱、未完成执行、未送且未取消的检查或在途手术阻止交接；目标接收才迁移责任和床位，已送报告可由新科接管。[P8] |
| 出院医嘱、实际离区 | 住院医生开出院医嘱；病区护士记录实际出区及离院方式。住院医嘱、检查、转科、手术各自保留原始事实。 | `admitted → discharge-pending → departed`。仍有在途检查或未完成转科不能开出院；待出院可办理停嘱／核停，不能新开或执行。实际出区时医嘱均已停止／完成、执行单均完成／取消；已出报告未阅不等于检查未完成，这里与门诊完诊条件不同。[P9] |
| 结算、清床、召回 | 收费员核对并冻结首次结算；护士在结算后清床并释放占用。医生仅可在已出区、财务未结、原床保留的窗口召回。 | 出区先结束实际在床时段，但不释放领域床位；清床才可供下一位使用。召回追加逆向事实并恢复在院，原离院记录不删除、已停医嘱不复活。未知资金不阻止出区，但阻断封账和清床。[P9] |
| 病案提交、审核、归档 | 主管医生从正式来源提交首页；有已实施操作须显式选择本次实际主操作，无操作则留作空集。离院后病案人员批准或附原因退回；通过后再次核对归档条件。 | 在院预分组用的提交不进入正式审核队列。归档须已清床且结算、同一来源修订已批准、完整核心字段、唯一主诊断、有效操作、账款一致、无在途任务。来源已变则重提重审；已归档保存完整快照，独立后续财务更正不重写它。[P10] |

**不要用一个“已完成”字段替代四个问题：** 行政状态是 `registered／admitted／discharge-pending／departed／cleared`；财务是 `open／settled`；住院汇总的病案状态是 `open／reviewed／archived`（能否归档还要核对当前首页修订及来源）；床位是否可分配由是否仍有有效占用判定。例如“已离区、未结算、未归档、原床保留”是有效组合。已清床也不等于病案已归档。[P6、P9、P10]

## 四、可用于验收的边界场景

| 给定 → 操作 | 应观察到 | 可复核证据 |
| --- | --- | --- |
| 同一患者有一次已完诊门诊 → 挂号员再次挂号 | 患者身份不变，门诊号和就诊独立；原文书仍归原就诊。 | P2、P3 |
| 问题已保存但回答结果未知 → 重新打开问诊 | 原问题存在，不能连发下一个问题；已保存回答可重放，不确定的尝试不自动再问一遍。 | P4 |
| 有已签病历但最新报告未确认 → 医生办理完诊 | 阻止完诊。补齐后重新提交；成功只结束本次就诊，不凭此断言收费或调剂成功。 | P5 |
| 两床互换时其中一份占用版本过期 → 护士提交 | 整个互换拒绝；不能出现一人两床或旧床先丢失。 | P6 |
| 药已发但未给 → 医生申请、护士核停 | 未执行给药任务取消；历史发药、库存和既有费用保留；不生成给药事实或自动退库。 | P7、P9 |
| 出区后医生召回与收费员结算并发 | 两种状态迁移不可同时成功；召回不复活旧医嘱，已结算则不能沿原住院召回。 | P9 |
| 首页已审核，费用明细变化但净额不变 → 病案人员归档 | 旧来源不能再用；主管医生重提、重新审核。已归档后患者身份资料升级，旧快照仍保持原样。 | P10 |

**范围边界：** 未将 `Appointment／Slot` 纳入当前现场挂号闭环，也未把分诊生命体征或“急危重症”警示用语推导成急诊留观、急救转运或急诊排班能力。主索引合并／撤销合并在流程文档中有设计表述，但本次未取得与普通挂号同等的公开写命令及测试证据，不列为已实现。默认场景只有一个接收新登记的住院病区；跨病区转科表示系统具备责任交接规则，不表示默认配置一定提供第二个可接收病区。[P6、P8、P12]

## 五、证据索引

路径均相对 **ClinMesh 源仓库**。实现文件用于定位事实归属，测试文件用于定位可复核场景；这里只进行了静态核对，不代表本次执行了这些测试。

| 编号 | 实现／合同（关键入口） | 场景或所有者文档 |
| --- | --- | --- |
| P1 | `apps/server/src/application/synthetic-case-visit-service.ts`（`listReadyForRegistration`、`start`）；`apps/server/src/application/workflow-service.ts`（`createPatient`、`register`） | `apps/server/tests/synthetic-case-http.test.ts` |
| P2 | `apps/server/src/infrastructure/sqlite/registration-numbering.ts` | `apps/server/tests/registration-numbering-http.test.ts` |
| P3 | `apps/server/src/application/workflow-service.ts`（`recordTriage`、`startFirstVisit`、`confirmDiagnosis`、`doctorCaseHistory`）；`apps/server/src/application/outpatient-case-source.ts`；`apps/server/src/application/doctor-inpatient-history.ts` | `apps/server/tests/outpatient-workflow-http.test.ts`；`apps/server/tests/outpatient-post-discharge-http.test.ts` |
| P4 | `apps/server/src/application/consultation-dialogue-service.ts`；`apps/server/src/application/consultation-reply-attempts.ts` | `apps/server/tests/consultation-dialogue-http.test.ts` |
| P5 | `apps/server/src/application/outpatient-clinical-document-service.ts`（`encounterCompletionPolicy`、`completeEncounter`、`signStructuredClinicalDocument`、`reviseClinicalDocument`）；`apps/server/src/application/clinical-request-kernel.ts` | `apps/server/tests/outpatient-report-acknowledgement-http.test.ts`；`apps/server/tests/outpatient-workflow-http.test.ts` |
| P6 | `packages/contracts/src/inpatient.ts`；`apps/server/src/application/inpatient-service.ts`（`issueReferral`、`applyRegister`、`assignBed`、`swapBeds`） | `apps/server/tests/inpatient-http.test.ts` |
| P7 | `packages/contracts/src/inpatient-clinical.ts`；`apps/server/src/application/inpatient-orders.ts`（`action`、`requestPrn`、`administer`、`completeService`） | `apps/server/tests/inpatient-orders-http.test.ts`；`apps/server/tests/inpatient-execution-batch-http.test.ts` |
| P8 | `apps/server/src/application/inpatient-transfers.ts`（`assertHandoverReady`、`action`）；`apps/server/src/application/inpatient-investigations.ts` | `apps/server/tests/inpatient-investigations-http.test.ts`；`apps/server/tests/inpatient-discharge-guards-http.test.ts` |
| P9 | `apps/server/src/application/inpatient-discharge.ts`（`action`、`assertOrdersFinished`、`settle`）；`apps/server/src/application/inpatient-payments.ts` | `apps/server/tests/inpatient-discharge-http.test.ts`；`apps/server/tests/inpatient-discharge-guards-http.test.ts` |
| P10 | `apps/server/src/application/inpatient-records.ts`（`submit`、`review`、`archive`）；`apps/server/src/application/inpatient-record-lock.ts` | `apps/server/tests/inpatient-record-http.test.ts` |
| P11 | `apps/server/src/application/clinical-score-service.ts`；`apps/server/src/application/clinical-quality-service.ts`；`apps/server/src/application/clinical-document-quality.ts` | `apps/server/tests/clinical-scores-http.test.ts`；`apps/server/tests/clinical-quality-gates-http.test.ts`；`apps/server/tests/clinical-document-quality-http.test.ts` |
| P12 | `docs/architecture/system.md`（当前发布范围）；`docs/architecture/clinical-workflows.md`（门诊闭环、住院闭环、患者主索引与合并） | `CONTEXT.md`（患者与就诊、临床请求与执行） |
