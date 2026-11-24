# 医院运营：费用、资金、医保、物资与质控

本章回答四个问题：一次诊疗何时形成应收、谁承担多少、钱和物是否真的发生移动、事后核查能否改变原事实。以下均指 **ClinMesh 合成医院的现有规则**，不适用于真实医院定价、地区医保待遇或临床决策。`[O1]` 等编号对应文末 ClinMesh 源仓库中的实现和验证入口。

## 1. 对象与职责：不能合并成一张「账单」的事实

| 业务对象 | 由谁、在何时确认 | 归属、关系与不能推导的事实 |
| --- | --- | --- |
| 原费用（Charge Item / Charge Record） | 诊疗活动按其计价点产生；收费员不能用收款动作生成临床活动 | 一次就诊有多条费用。原费用保留计价来源；冲减另记。门诊账单按本次就诊的费用及关联资金汇总，不是可编辑的余额，也不是财政票据。[O1–O3] |
| 收款交易、支付方式、费用分配 | 收费员核对预览并确认；模拟渠道返回成功、拒付或未知 | 一笔交易只属一次就诊；可以包含多种支付方式（钱怎么付）和多条费用分配（付了什么）。两侧金额各自合计等于整笔金额；拒付不进实收，未知不是成功或失败。[O2] |
| 退款交易与费用更正 | 收费员记录更正依据，另行办理退款 | 冲减/补计改变费用责任；退款改变净现金，必须指向成功原款，门诊合并收款还要指向原分配。退款不撤销临床执行，取消申请也不等于退款。[O2、O3] |
| 患者医保待遇结算、逐项分摊、年度账户 | 收费员先试算再确认；系统按合成品规、方案及年度累计计算 | 每次待遇针对特定费用，可分为基金、个人账户、患者负担。年度账户按患者与仿真年度归属，而费用只属于原就诊；待遇既不是收款也不是医院 DRG 核定。[O4] |
| 住院首次冻结结算、后续调整 | 已出区的首次封账由收费员办理；后续按原账逐笔追加 | 冻结原费用、原待遇及原资金。每笔后续更正保留原费用引用与原因；病案可同时显示首次金额与当前差异，不产生第二次出院。[O5、O6] |
| DRG 分组、支付参考、模拟核定 | 医生核对正式临床依据；病案归档冻结；医保办按冻结分组审阅核定 | 正式分组、假设实施后的推演、医院侧参考金额以及归档后的核定是四件事。核定绑定原病案与规则版本，不产生转款。[O7] |
| 药品批次、库存移动、手术材料预留 | 药师发药落实到批次；医生为具体手术准备和确认材料计划 | 药品库存移动说明哪个地点哪个批次实际扣减；术前材料预留说明预计使用量和价格，不锁实物库存，不是已用量或正式应收。[O8] |

## 2. 门诊：从应收到放行，再到可能的退款

1. **产生应收。** 签发独立检验、放射、病理或功能检查申请时，建立该申请唯一原费用，冻结有效价目、版本、单位及整数分单价。检验组合按所选根项目计价，不再对报告成员重复收费。草稿无应收；缺少有效正价不允许「先开再补价」。挂号项目可以列账，但当前门诊收款入口不收挂号费；药品还须满足完诊、处方有效等门禁。[O1、O3]
2. **计算本项差额。** 本项应收净额 = 原应收 − 有效冲减；本项净实收 = 成功收款分配 − 成功退款分配；本项待收按应收净额扣除净实收及有效基金、个人账户分配。不要用某笔支付成功、某张单上有医保标识或同一患者其他就诊的余额代替本项判断。[O2–O4]
3. **人工预览与收款。** 单项可分次付；一次可组合现金、银行卡和移动支付。同次就诊明确选择 2–20 项可合并，但必须全额覆盖所选各项的剩余应收，不支持任选一个总额由系统猜测分摊。一次预览失败就不收任何项目；成功预览冻结版本、金额、方式及岗位，仍不入账、不放行。确认后只建一笔原交易，整笔成功、拒付或未知。[O2]
4. **交接给执行方。** 只有资金确定且已覆盖本申请净应收，才安排受理；受理时再次检查并冻结首次放行依据。受理前撤销医保，未补足就等待；受理后撤销医保，形成财务差额，但不抹掉受理、重复执行或回退已产生的报告。处方仍按自己的门禁进入药房，不会因另一项检查已缴费一并放行。[O3、O4]
5. **更正与恢复。** 费用冲减须有理由；有效医保分配须先补偿撤销。独立检查在受理前按临床取消规则由负责医生取消，关联冲减剩余应收；有实收由收费员另向原成功交易退款。门诊退款同时受原交易可退额、原费用分配可退额和该费用累计冲减依据限制，沿原方式退。未知收/退款冻结相关额度，禁止改金额、换原款或另开交易绕开；查原尝试后仍未知就继续等待，确定后才重新计算。查询及重复确认不得凭空多出第二笔资金。[O2、O3]

**一个可手算的例子（验收用，不是合成价目）**：同一门诊两条合法项目待收 3,000 分和 2,000 分；现金 1,000 分、银行卡 4,000 分合并收款成功。业务结果是 **一笔** 5,000 分交易、**两种**付款方式、**两条**费用分配，不是四笔资金。若一项的余额在确认前变化，整单须重新审阅；若只对第二项有 500 分有效冲减依据，不能从第一项的分配退款。[O2]

## 3. 患者医保：费用是否可报、患者实际还欠多少

| 环节 | 规则与异常 |
| --- | --- |
| 识别可报费用 | 处方按药品明细、检查按开立时冻结的品规属性识别。甲类无先行自付，乙类有品规级先行自付比例，丙类目录外。混合处方先算明细、再合并；冲减后按确定性比例分摊到明细。映射缺失是无法计算，不是自动全自费、零待遇或免费。后来改目录不重写历史。[O4] |
| 确认年度待遇 | 以整数分计算：先剔除目录外及先行自付，再处理年度起付线、基金比例、封顶与可用个人账户，余款归患者。职工、居民使用仿真方案。相同患者门诊/住院分别累计起付及基金，但共用个人账户；年度首次确认固定方案，撤销不能借机换方案。[O4] |
| 确认与撤销 | 收费员处理本次就诊的可结算费用。已经确认的原费用不能再次进入另一份有效分配。预览绑定患者原年度账户版本和费用来源；其他就诊先动用个人账户会使未确认预览失效。撤销保留原待遇，追加对**原年度**的补偿（每份原待遇最多一份），不是用当前年余额抵销。未知收退款先查原尝试。[O4、O6] |
| 首次住院与事后差额 | 住院患者仅在已出区、首次结算前、未归档窗口办理首次待遇。首次完成后走专用更正：关联原费用 → 补偿原待遇 → 按原年度和原方案重新结算 → 以新的患者责任和当前净现金决定补收/退款。不用「冲减就一定退、补计就一定收」替代计算。投保住院一次只能有一个未完成更正。[O5、O6] |

## 4. 住院：钱、床、病案是三条分别负责的状态线

| 时点 | 业务结果 | 不允许据此推断 |
| --- | --- | --- |
| 入院及在院 | 预交金关联本次住院原收款；符合条件的床日、已发药、已执行检查、手术及实际材料等分别按来源记账。出区前仍实际在院的午夜可计床日。[O1、O5、O8] | 预交不是正式费用，草稿和未记费承诺不是已经产生的收费。 |
| 医生申请出院，护士实际出区 | 实际出区停止新床日计费，但原床仍占用。未结算、未清床且原床仍保留时才可召回；与结算竞争只能一方成功。[O5] | 有未知收退款不等于病人不能出区；出区不等于资金已清或床位已释放。 |
| 收费员核对并结算 | 患者责任 = 应收净额 − 基金 − 个人账户。尚应收退 = 患者责任 − 成功预交及补缴 + 成功退款；正数补收、负数退回。有未知资金或原医保来源失效须先解决。结清并复核逐项指纹后封账；有过独立拒付或未知不能回退到默认现金结清路径。[O5] | 净金额没变也不代表预览有效：逐项来源、版本或收退款可能已变。临床端的欠费摘要为未知时不能当作零。 |
| 护士清床，病案归档 | 结算后方可清床。归档对照首次冻结费用、患者资金、医保分摊与审核过的首页；保留不可变快照。[O5–O7] | 清床不自动归档，医保办核定不是归档前提。后续差额不恢复床位或解档。 |
| 首次结算后需要纠错 | 保存带原因、指向原费用的更正；先处理费用和医保，再处理现金差额。未知退款只占用当前额度，原款查询可恢复；完成后可对账「首次冻结」和「当前累计」，不覆盖旧账。[O6] | 原病例已归档不等于永远没有待收，也不等于开放一般临床写入。 |

## 5. DRG：医院侧分组与核定并不决定患者待遇

| 结果 | 输入与责任 | 明确的限制 |
| --- | --- | --- |
| 在院正式口径预分组 | 读取已确认的主次诊断、已实施操作、医生在首页明确选择的主操作及路径所需人口属性；核对编码兼容性与规则版本。[O7] | 计划术式不混入实际操作。有实际操作而未选主操作应报缺项；不能默取最后一台手术或参考金额最高的病组。不兼容编码、歧义、规则缺失分别保留。 |
| 计划推演、费用参考 | 分别展示当前正式事实与计划实施的假设。预计总收费按已发生净收费、已正式开立但未记费的承诺、未消耗预留量及当前纳入的草稿估算，阶段替换不能重复计入。[O7、O8] | 支付参考额减预计总收费是参考空间，不是利润、临床开立上限或患者欠款。缺价/缺支付参数不能补零。 |
| 归档冻结、医保办模拟核定 | 归档锁定病案依据与分组；医保办只读所需编码摘要，预览后按冻结版本和合成支付参数确认。记录病组、依据、版本、模拟额、与正式收费/原预估的差异及复核原因。[O7] | 没有确定病组或相应参数不落核定。核定不改患者待遇、不记现金、不改病案；不证明真实地区医保会如此支付。 |

## 6. 组织、库存、质控：只建能找到责任人的闭环

- **组织与岗位。** 医院、科室、病区、地点/床位是资源；人员在特定组织、地点履行的岗位才决定可办理事项。住院医生与病区护士受当前科室/病区约束；药师落实批次，收费员处理资金，病案人员审核归档，医保办核定医院侧分组。收费员可核对费用，不因此获得病历全文；病案人员可看财务差异，不因此取得退款权；管理员不是全能临床角色。已有岗位、床位和占用关系不等于已实现人力排班、考勤或绩效管理。[O1、O9]
- **药品库存。** 药品目录描述可开品规，库存批次按地点、品规、批号、效期和余量管理。开方不指定批号；调剂按合格批次、余量、地点及有效期选择，发药时再核版本和余量，扣减并追加关联该次发药的库存移动。已发药但尚未给药时停嘱，历史发药、库存和费用不能自动抹平。当前实现是发药批次扣减的最小子集，不把领域词汇中提及的追溯码、调拨、盘点或完整退药状态机写成可用业务。[O1、O8]
- **手术材料。** 一次手术计划可有多条预计材料；医生核认绑定计划、材料版本、规格、估量与价格。确认时保存术前基线，可产生或替换预留，不产生实物移动或应收。术中按原预留剩余量登记，计划外或偏离原预留须说明；核实实际及必要更正另留事实。重读计划余量时不得把已用部分再算入预计。此处没有推出采购、供应商、入库验收、器械追溯或供应链总账。[O8]
- **临床质控。** 处方/医嘱签发、门诊完诊、特定介入计划与选型、住院出院及离院后病案提交分别有正式动作关口。只读预检不修改临床事实。第一层是不可覆盖的安全红线；第二层是可说明的路径偏离，须重新提交，覆盖当下全部警示，留存受控理由、医学说明、责任人及审计。理由只适用于该次动作，不是患者永久豁免，不替代病历完整性或病案编码审核。这是仿真质控，不代表通用临床指南。[O10]

## 7. 最小验收集：跨域失败时检查什么

| 已知事实与动作 | 应观察到的业务结果 | 回归证据 |
| --- | --- | --- |
| 同一患者两次门诊，原就诊的联合付款结果未知；切到另一次再查询 | 不能借新就诊、新金额或新交易完成原款；按原款及全部原分配恢复，各费用只放行一次 | O2、O3 |
| 原申请医保全额覆盖但尚未受理，随后撤销；与受理后再撤销比较 | 前者重新等待患者资金，后者保留原放行快照，不重做检查；两者都有原待遇及补偿历史 | O3、O4 |
| 住院患者已出区，补缴或退款尚未知 | 不封账、不清床、不重复收退；查明原尝试并结清后再封账；出区事实不撤回 | O5 |
| 跨年更正已归档住院，另一就诊已用个人账户 | 使用原年度重算，新年度不受影响；旧预览失效需重审；可能冲减费用却仍需补收。归档快照不变 | O6 |
| 医生确认耗材清单后实际仅用一部分；医保办查询 | 保留原计划数量与逐笔实用，预计只含尚未使用部分；医保办不能修改计划，也不能把材料预留当成正式收费 | O7、O8 |
| 已归档病组没有模拟支付参数；或人在非授权岗位提交核定 | 前者明确说明金额不可估，不生成核定；后者拒绝。此前患者结算及归档照常有效 | O7、O9 |
| 相同临床动作分别触发硬红线、可说明警示 | 硬红线即使有说明亦无正式事实；可说明警示只在说明覆盖所有当前警示时才生成业务事实及关联记录 | O10 |

## 8. 源证据索引

以下路径均相对于 `D:\Projects\Agents\clinmesh`。测试文件是源项目已有的可复查断言，不表示本次重新运行了这些场景。

| 编号 | 事实归属与实现 | 回归或对照入口 |
| --- | --- | --- |
| O1 | `CONTEXT.md`（费用与医保、库存、身份与参与）；`docs/architecture/system.md`（领域边界、明确不做）；`docs/architecture/clinical-workflows.md`（收费、医保、出院、术前材料） | 三者冲突时，以已实现操作、状态检查和回归断言限定本模型；正式电子票据、真实支付/医保、完整财务 ERP 不纳入。 |
| O2 | `apps/server/src/application/payment-collection.ts`；`apps/server/src/application/payment-ledger.ts`；`apps/server/src/application/outpatient-refunds.ts`；`apps/server/src/application/refund-ledger.ts` | `apps/server/tests/shared-payment-collection-http.test.ts`；`apps/server/tests/outpatient-multi-charge-preview-http.test.ts`；`apps/server/tests/outpatient-multi-charge-collection-http.test.ts` |
| O3 | `apps/server/src/application/outpatient-investigation-billing.ts`；`packages/contracts/src/investigation-billing.ts` | `apps/server/tests/outpatient-investigation-insurance-http.test.ts`；`apps/server/tests/insurance-http.test.ts` |
| O4 | `apps/server/src/application/insurance-service.ts`；`apps/server/src/application/outpatient-insurance.ts`；`apps/server/src/application/catalog-insurance-coverage.ts` | `apps/server/tests/item-insurance-coverage-http.test.ts`；`apps/server/tests/insurance-http.test.ts`；`apps/server/tests/inpatient-insurance-http.test.ts` |
| O5 | `apps/server/src/application/inpatient-discharge.ts`；`apps/server/src/application/inpatient-billing.ts`；`apps/server/src/application/inpatient-payments.ts` | `apps/server/tests/inpatient-discharge-guards-http.test.ts`；`apps/server/tests/inpatient-payments-http.test.ts`；`apps/server/tests/inpatient-shared-payment-collection-http.test.ts` |
| O6 | `apps/server/src/application/inpatient-financial-adjustments.ts`；`apps/server/src/application/inpatient-insurance-adjustments.ts` | `apps/server/tests/inpatient-financial-adjustments-http.test.ts`；`apps/server/tests/inpatient-insurance-adjustments-http.test.ts`；`apps/server/tests/inpatient-insurance-archived-http.test.ts` |
| O7 | `docs/architecture/drg-grouping.md`；`apps/server/src/application/inpatient-drg.ts`；`packages/contracts/src/inpatient-drg-payer.ts`；`apps/server/src/application/inpatient-material-cost-projection.ts` | `apps/server/tests/inpatient-drg-record-checks-http.test.ts`；`apps/server/tests/inpatient-drg-payer-review-http.test.ts`；`apps/server/tests/pci-payment-drg-acceptance-http.test.ts` |
| O8 | `apps/server/src/application/outpatient-prescription-service.ts`；`apps/server/src/application/inpatient-orders.ts`；`apps/server/src/application/inpatient-material-plans.ts`；`apps/server/src/application/inpatient-surgery.ts` | `apps/server/tests/inpatient-orders-http.test.ts`；`apps/server/tests/inpatient-material-estimate-http.test.ts`；`apps/server/tests/inpatient-surgery-http.test.ts` |
| O9 | `docs/architecture/security-and-reliability.md`（身份、岗位与字段隔离）；`docs/architecture/system.md`（组织与岗位） | `apps/server/tests/payment-finance-read-audit-http.test.ts`；`apps/server/tests/inpatient-drg-read-audit-http.test.ts` |
| O10 | `apps/server/src/application/clinical-quality-service.ts`；`packages/contracts/src/clinical-quality.ts`；`docs/architecture/clinical-workflows.md`（双层事中临床质控） | `apps/server/tests/clinical-quality-gates-http.test.ts` |
