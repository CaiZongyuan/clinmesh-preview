# 开源 HIS 对照：全球 Mini HIS 的核心、选装模块与机构配置

本笔记为 [ClinMesh 的 Mini HIS 范围决策](global-mini-his.md) 提供外部对照，不是现状提取、产品排名或技术选型。证据取自项目和实施方发布的文档、源码与具名配置；源码链接固定到所读提交。发行清单能证明某组件可装配，不能证明某医院正在运行它；站点配置也不证明临床效果、合规性或当前上线版本。

## OpenMRS：把一次来院、一次接触和一条临床事实分开

| 核对的事实 | 对 ClinMesh 的建议（不是 OpenMRS 的强制规则） |
| --- | --- |
| [`Visit`](https://github.com/openmrs/openmrs-core/blob/727557e860664e5e05e7fa26d3855de3d83e298e/api/src/main/java/org/openmrs/Visit.java) 有患者、类型、地点、起止时间，可归集多个接触；[`Encounter`](https://github.com/openmrs/openmrs-core/blob/727557e860664e5e05e7fa26d3855de3d83e298e/api/src/main/java/org/openmrs/Encounter.java) 另有时间、类型、服务者及角色，可关联医嘱、诊断和观察。 | 保留患者纵向病历。一次来院中，预检护士量血压、医师接诊可分别记时间与责任人；不必挂两次号，也不能只留下最后修改整张就诊单的人。无需照搬类名或增加一道必办手续。 |
| [`Obs`](https://github.com/openmrs/openmrs-core/blob/727557e860664e5e05e7fa26d3855de3d83e298e/api/src/main/java/org/openmrs/Obs.java) 将项目概念、发生时间、数值／编码／文本等值类型与实际记录相联，可关联接触、申请和前一版本。[`PatientIdentifier`](https://github.com/openmrs/openmrs-core/blob/727557e860664e5e05e7fa26d3855de3d83e298e/api/src/main/java/org/openmrs/PatientIdentifier.java) 把标识值、类型、地点、是否首选与患者本身区分。 | 项目字典定义“测什么”，病历记录“谁在何时测得什么”；换表单或改显示名不重写旧结果。病历号不是患者主键，不同签发方可用相同号码。**不要**把处方、收费、签署等有自己生命周期的事实都塞进通用观察表。 |
| [O3 参考发行版说明](https://github.com/openmrs/openmrs-distro-referenceapplication/blob/e0292411a17feb6271866d1f9c7e5cbec7a7ac1c/README.md#overview) 将后端初始配置称为起点，前端另有模块清单；[发行属性](https://github.com/openmrs/openmrs-distro-referenceapplication/blob/e0292411a17feb6271866d1f9c7e5cbec7a7ac1c/distro/distro.properties) 分列参考内容、演示内容与展示内容。 | 区分可运行的核心、诊所业务内容和教学种子数据。验收空诊所从登记首位患者开始，不靠演示库初始化病历；不必引入 OpenMRS 的前后端运行栈。 |

**具名实施：Partners In Health（PIH）→ 海地 Zanmi Lasante → 站点。** [PIH 配置说明](https://github.com/PIH/openmrs-config-pihemr/blob/5645aa15a3a13e93851f619348e0ddd969684517/README.md) 列出共享的地点、角色、权限等元数据，以及国家发行版可补充／覆盖的地址层级、药品等；[海地发行版](https://github.com/PIH/zl-emr/blob/0de6581261e6544d8cd7aaf3d33c6f7802e43ff3/README.md) 实际组合 PIH 基础发行与当地内容。同一国家内，[Belladère](https://github.com/PIH/zl-emr/blob/0de6581261e6544d8cd7aaf3d33c6f7802e43ff3/content/configuration/backend_configuration/pih/pih-config-haiti-belladere.json) 使用病历号前缀 `HNB`，组件清单含急诊分诊；[Hinche](https://github.com/PIH/zl-emr/blob/0de6581261e6544d8cd7aaf3d33c6f7802e43ff3/content/configuration/backend_configuration/pih/pih-config-haiti-hinche.json) 前缀为 `HSTH`，清单含病理追踪。两者都列有患者登记与接诊。**建议**：将术语和地区默认值与站点能力、签号规则分开；选择国家并不等于启用该国每个站点和专科。用同一地区的两个虚构站点验证这一点，而不只测中英文切换。

## Bahmni：院内有没有检验科、要不要完整 ERP，是装配决策

**发行证据。** [Bahmni Docker 说明](https://github.com/Bahmni/bahmni-docker/blob/84b0559a76d43c6795df8c6302d52ad8292c4832/README.md) 明确区分 Lite 与 Standard，通过 profile 选择服务。[Lite 清单](https://github.com/Bahmni/bahmni-docker/blob/84b0559a76d43c6795df8c6302d52ad8292c4832/bahmni-lite/docker-compose.yml) 中 `bahmni-lab` 在 `emr` profile 内，Crater 不在该 profile 内；[Standard 清单](https://github.com/Bahmni/bahmni-docker/blob/84b0559a76d43c6795df8c6302d52ad8292c4832/bahmni-standard/docker-compose.yml) 中 OpenMRS、OpenELIS 和 Odoo 的 profile 可以区分。Lite 不是“永远无检验”，Standard 也不是“必须把所有服务一起开”。这里证明的是产品提供不同装配方式，不是各个集成可在停机或断网时无损工作。

**具名实施：Jan Swasthya Sahyog（JSS）医院。** [医院自己的配置仓库](https://github.com/JanSwasthyaSahyog/jss-config/blob/a78dd9759403c97970a09e657fdf69d560b30a5d/README.md) 把本院内容与 Bahmni 应用分开。[登记配置](https://github.com/JanSwasthyaSahyog/jss-config/blob/a78dd9759403c97970a09e657fdf69d560b30a5d/openmrs/apps/registration/app.json) 将 `ABHA Number`、`ABHA Address` 列为只读附加标识，另列本地采集的社会信息；[地址层级迁移](https://github.com/JanSwasthyaSahyog/jss-config/blob/a78dd9759403c97970a09e657fdf69d560b30a5d/openmrs/migrations/V1_74__AddGramPanchayatAndHouseNumberStreetAsNewAddressHierarchyLevels.sql) 加入 `Gram Panchayat` 和门牌／街道层级。不能由此推断所有印度机构都要求这些字段，更不应把它们变成全球必填项。

**对 ClinMesh 的取舍。** 核心拥有申请意图、可追溯的报告与接收责任；只有院内执行才增加标本与处理队列。没有 LIS 时，授权人员仍能登记有来源的外院报告。最小收费模块只拥有逐项应收、收退与对账，不因需要一张收据就引入 ERP；财务也不得代写临床完诊。首先用同一应用验收「无现场收费、检验外送」与「现场收费、院内检验」两种门诊，再决定是否接外部 LIS 或财务系统。借鉴的是**责任和配置的边界**，而非拆成相同数量的容器或复制某医院的登记表。

## OpenEMR：结果签发之后仍有工作；保险报文不是收费本身

[OpenEMR v8.5.0](https://github.com/openemr/openemr/releases/tag/v8_5_0) 的[结果后续处理页面](https://github.com/openemr/openemr/blob/c1b2b8bcbe91aa81858f7ba8b25c31d9a82639a5/interface/orders/pending_followup.php)按查询列出尚待完成的后续服务；[患者匹配界面](https://github.com/openemr/openemr/blob/c1b2b8bcbe91aa81858f7ba8b25c31d9a82639a5/interface/orders/patient_match_dialog.php)允许人工选择匹配患者，但候选计算含美国 SSN 假设。收费目录中有独立的 [X12 270 资格查询](https://github.com/openemr/openemr/blob/c1b2b8bcbe91aa81858f7ba8b25c31d9a82639a5/interface/billing/edi_270.php)与 [X12 835 汇款通知处理](https://github.com/openemr/openemr/blob/c1b2b8bcbe91aa81858f7ba8b25c31d9a82639a5/interface/billing/era_payments.php)。这是代码职责的证据，不表示这些文件就是可单独部署的模块。

**建议**：把“报告形成”“临床人员确认已阅”“约定的后续行动已办结”分开。ClinMesh 不能用一次已阅关闭所有责任，但也不必为每份正常报告强建随访。身份匹配需要人工核对通道，规则可按签发方替换。现金收退、基本收据不依赖任何理赔报文；美国 X12 与中国医保各走自己的地区适配器。

## GNU Health：没有住院的机构也有完整的患者档案

[患者管理手册](https://docs.gnuhealth.org/his/userguide/patientmanagement/patientmanagement.html)区分自然人资料与患者角色；[住院手册](https://docs.gnuhealth.org/his/userguide/modules/inpatientmanagement.html)明确该章功能要求安装住院和住院日历模块，患者档案与本次住院记录是两种记录。[库存手册](https://docs.gnuhealth.org/his/userguide/modules/stockmanagement.html)以物品、数量和地点描述库存，允许库位层级。

**建议**：住院模块拥有入院、在院责任和床位占用，不拥有患者主档。小门诊只开外配处方，就无需创建仓库；有院内药房才记录库位、批次和实际出入。无需因为参考系统采用 `Party` 就强行统一患者、药品供应商与机构的生命周期。

## Open Hospital：用断公网的基层医院检验“Mini”是否成立

[项目说明](https://github.com/informatici/openhospital/blob/4dd861c08f3750bec3ab353ebde9bd9d0231668f/README.md)明确其设计针对低资源、无需互联网的运行环境。核心仓库分别实现[门诊](https://github.com/informatici/openhospital-core/blob/de4f6d9f776e5271d1518fd1299f4681a2b9fbc1/src/main/java/org/isf/opd/manager/OpdBrowserManager.java)、[入院](https://github.com/informatici/openhospital-core/blob/de4f6d9f776e5271d1518fd1299f4681a2b9fbc1/src/main/java/org/isf/admission/manager/AdmissionBrowserManager.java)和[药品盘点](https://github.com/informatici/openhospital-core/blob/de4f6d9f776e5271d1518fd1299f4681a2b9fbc1/src/main/java/org/isf/medicalinventory/manager/MedicalInventoryManager.java)。存在这些实现不等于项目支持任意模块热插拔。

**建议**：首版在院内网络与本地服务器正常、仅公网中断时，仍能登记、接诊、签署和查本地记录；外送、在线支付、理赔明确显示待传或待核。院内服务器也不可用时应走停机登记与恢复核对。不要把这个要求扩大为“所有终端离线写入后自动合并病历和资金”。

## 建议落入目标本体的首批业务判据

| 模型落点 | 验收情形 | 不应发生 |
| --- | --- | --- |
| M1 对象／M2 行为：患者标识、来院与接触 | 同一患者同一次到院先由护士分诊、再由医生接诊；两次接触的责任人、时间都可追溯。外部报告遇到同名候选先挂起人工核对。 | 按姓名或某国证件格式自动并档；为了记录第二个责任人而重复挂号。 |
| M3 规则／M7 工作清单：结果后的责任 | 病人离院、外送报告次日到；负责人已阅但要求复查。分别看得到报告版本、谁已阅、谁承接复查、何时关闭。 | “签发报告”自动视为“已阅”，“已阅”自动视为“已完成随访”。 |
| M5 岗位／机构配置：地区默认、机构覆写 | 同一国家的甲诊所无床无收费，乙医院有床有药房。用同一构建产物，变更有版本的能力、授权和字典配置；旧单据仍可解释。 | 以国家名决定开床或装药库；停用模块后抹掉历史记录。 |
| M6 流程／MI 接口：断公网仍能接诊 | 断开公网后登记至签署仍成功；外部回执未到可见，不确定结果恢复后核实原请求。 | 依赖在线术语、医保或 AI 才能保存临床记录；重连后重复收款。 |

**实施取舍**：借 OpenMRS 的领域语义、Bahmni 的装配思路、OpenEMR 的门诊后续工作、GNU Health 的住院边界、Open Hospital 的小型机构约束。ClinMesh 继续用模块化单体，第一步只切清事实归属和接口，不搬入上述产品栈。本次查阅官方资料和实现，未安装运行五套系统，亦未验证其临床安全性或地区合规性。
