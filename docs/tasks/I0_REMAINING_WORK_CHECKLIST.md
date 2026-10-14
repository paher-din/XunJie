# I0：剩余工作清单（30 项）

建档：2026-10-13；最新核对：2026-10-15（Asia/Shanghai），应用/前端已交付main `37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`（PR #75，2026-10-14 23:41:36合并）。记录主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。用途：将跨电脑交接中的完整工作清单保存在仓库，后续不依赖个人附件或另一台电脑的文件路径。

来源：Robert 于2026-10-13提供的 `i0-remaining-work.html`，标题“I0 前端接入：当前还能做什么”，页面生成时间为2026-10-13 14:50，标注main `c437ef2`。附件SHA-256为 `0d850e95f6bce0b85bd164417194bca34694091bd7ae71a1597ef352c3e58364`。本页保留全部30个编号、工作及交付/进入条件，并补仓库内任务映射；不执行附件脚本，也不把其建议转为新实现授权。

`UI-PREP`、`UI-REAL`、`UI-TUTOR` 是工作清单编号，不是正式团队A/B/C任务编号。负责人决定、实际写集、实现与验证仍记对应任务；本清单不取代[产品基线](../product/MVP_SPEC.md)、[共同计划](../planning/TEAM_WORK_PLAN.md)或成员记录。已完成工作不凭本清单重新开工，未确认项目保持待核。

**最新结论：** 登录/保存/运行/辅导前端已随PR #57/#64/#66合main；UI-PREP-01/03/05/06已随[PR #69](https://github.com/paher-din/XunJie/pull/69)交付，新包接收、两处现场UI修复和真实C1复验已随[PR #75](https://github.com/paher-din/XunJie/pull/75)合main，继续`i0/ui-frontend`。新143文件包已切入本机网关，严格TLS/check16/16、新v9保存冻结、真实Core成功、原Job停止及已有完整产物21字节下载/hash核对均有[分批证据](I0-UI_PR69_REAL_BROWSER_RECHECK.md#4-修复包冻结与最终现场结果)；不再安排首次接包或正向下载。当前推进UI-PREP-04/07/08，见[本批记录](I0-UI_PREP_04_07_08_CLOSEOUT.md)。H-05已获裁决并交修复PR #73，合并/运行生效与基线汇总另核；HDL由并行会话承接。工程/隔离、固定现场窗口、模型/真人和完整验收继续分列。

## 1. 快照与实际状态

| 对象 | 原页面快照 | 本次记录边界/更新来源 |
| --- | --- | --- |
| 准备工程 | PR #50/#51已合并；108项浏览器与238项单测通过 | 原通过数的精确版本、失败轮次和范围见[I0-UI-BV](I0_UI_BV_EDITOR_BROWSER_VERIFICATION.md)，不算真实I0-A/I0-B通过 |
| 真实入口 | 默认后台只启动健康入口；前端real在分配发现处停止 | 本批固定main `cde69cc`仍需真实入口接线；后续按对应交付版本核，不将默认健康检查当业务就绪 |
| A/C回交 | 原页称“只有两条原交接评论，未见成员回交” | 这条已落后于本批读取的[#30最新A回交](https://github.com/paher-din/XunJie/issues/30)。A正常宿主/bootstrap已有[Draft PR #53](https://github.com/paher-din/XunJie/pull/53)，核查时未合入main；已交材料、真实节点/UI联调分别记录，不沿用“完全未回交” |
| B侧 | PR #46于14:39合并；#45关闭，最新复审通过 | 本批已回读相同合并事实，详见[G2 §22](G2_OVERALL_COORDINATION.md#22-2026-10-13-pr-46-放行复审与合并准备)。历史真实与最新离线证据分开 |
| 模型许可 | 原一次性许可已用完，追加调用需新许可 | 清单保存、规格定稿与提交不发供应商请求，也不恢复旧批次 |
| 依赖审计 | 原页报告6项，非6条可利用漏洞 | 这是原页审计快照，本次未重新运行audit；处理归UI-PREP-07，不据此升级依赖 |
| 本批辅导计划 | 原页没有具体实施票或完成日期 | [I0-B规格](I0-B_UI_TUTOR_SPEC.md)与[六票计划](I0-B_UI_TUTOR_PLAN.md)承接UI-TUTOR-01～08及UI-PREP-09操作映射，规划已按Robert委托检查定稿；应用实现/验证未执行 |

上表全部保留2026-10-13规划时点，其中“本批/本次/当前”均指该历史核查，不是最新结论。2026-10-14辅导工程交付见§8，PR #64/#66与最新A/C条件见§9；不能把历史“未执行/待交接”当当前代码状态。

## 2. UI-PREP：不依赖真实后台的9项

下表“可检查的交付”保留原清单含义；最新状态按对应记录核对。没有完整专项证据的编号保持待核，不把局部覆盖计成整项通过，也不把后续已修复的问题继续列成现有缺陷。

| 编号 | 工作 | 可检查的交付 | 截至2026-10-15状态/剩余 |
| --- | --- | --- | --- |
| UI-PREP-01 | 补IDEMPOTENCY_CONFLICT浏览器回放 | 原命令保留；不自动换键，不丢草稿，不重复业务动作 | [本轮专项](I0-UI_PREP_VERIFICATION_CLOSEOUT.md#41-新反例与必要修复)已完成：同authority公开POST占位、实际409、在途较新草稿/原key-body、刷新比较零补写，明确选择后新键/当前CAS只保存一次 |
| UI-PREP-02 | 加强撤销/重做证明 | 分别断言编辑、撤销、重做后的正文；核原EOL/BOM和历史分支 | 已补原文历史根因修复、逐组undo/redo和新分支证据，见[I0-B §13](I0-B_UI_TUTOR_PLAN.md#13-2026-10-14-六票逐项收尾审查)及[浏览器原文用例](../../apps/student/e2e/tutoringReturn.spec.ts)；不沿用旧“只检查最终文字”判断 |
| UI-PREP-03 | 补完整键盘流程 | 新建、文件切换、保存、比较、冲突、运行、停止及返回；核焦点恢复 | [连续键盘专项](I0-UI_PREP_VERIFICATION_CLOSEOUT.md#41-新反例与必要修复)已完成：真实Tab/Shift+Tab贯穿全部操作，修文件菜单Esc和同上下文只读视图返回焦点；保留原模型/正文/undo/选区 |
| UI-PREP-04 | 核真实中文输入法 | 候选确认/取消不丢字；组合输入、搜索、跨文件编辑有实际操作证据 | [真实IME证据](evidence/i0-ui-prep-04-07-08/ime/README.md)已交：Robert实际系统候选确认/取消、中文查找1 of 1与跨文件；220事件原trust值、两份正文/本机草稿、undo/redo和刷新逐身份/LF核对，零自动业务写。具体IME产品名未识别；没有以insertText或合成composition替代 |
| UI-PREP-05 | 补独立冷启动采样 | 核首次依赖预优化、504、启动/关闭与端口回收；不增加无理由的全量复跑 | [独立采样](I0-UI_PREP_VERIFICATION_CLOSEOUT.md#42-兼容复验与冷启动)已完成：原配置/独立新缓存，prep/real各两次，无504/资源失败，退出0/端口释放/自有缓存清理；不计NFR或真实服务通过 |
| UI-PREP-06 | 核最新客户端/服务端契约 | 对照当前main的公开输入、信封、版本、错误和裁剪；差异交A/C | [当前契约表](I0-UI_PREP_VERIFICATION_CLOSEOUT.md#5-ui-prep-06当前公开契约核对)已完成；PR #67未变API/schema。辅导异常中文提示补反例/窄修复，原命令/诊断保留；H-05获准修源码且A/C已交PR #73，合并/运行生效另核，产品汇总仍待授权维护者 |
| UI-PREP-07 | 形成依赖修复方案 | 区分运行时与测试工具链影响；列精确版本与回归范围，获准后再改依赖 | [当前审计与精确方案](evidence/i0-ui-prep-04-07-08/dependencies/DEPENDENCY_REPAIR_PROPOSAL.md)已形成：固定lock全树6包条目、runtime仅2 low，逐通报/用途/前置与候选版本/回归分列；Monaco内嵌旧DOMPurify不能仅override消除。依赖升级/构建映射待批准，package/lock未变 |
| UI-PREP-08 | 校正文档与证据入口 | Issue #30早期状态、04截图指针、05的104/106计数及基线请求；交原维护者 | 当前页首/接包/下载已校正；wubq511即我们，本人原04缺图指针/MVP误链和05固定来源104/新增10及fileLifecycle5已直接勘误，原统计/日期保留。[交接索引](evidence/i0-ui-prep-04-07-08/documentation-handoff.md)给A当前Issue状态与授权基线输入；共享Git发布尚待本批明确回执，保护基线及原图未来回补不代签完成 |
| UI-PREP-09 | 准备I0-B操作/接口映射 | 核现有求助、消息、停止、返回、采集操作；列缺失组件和最小接入范围 | 映射及六票前端工程已交，见[I0-B计划](I0-B_UI_TUTOR_PLAN.md)；后台采集/分析与UI-TUTOR-09分列 |

原页提示（2026-10-13）：UI-PREP-02的已有测试连续按undo/redo但只检查最终文字；两个快捷键都无效也可能满足该断言。这是历史风险线索，后续逐组断言与原文历史修复已补，见上表。原页中文文字输入不能证明真实组合流程；2026-10-15专项已有实际系统IME证据，见UI-PREP-04当前行。

原页audit统计为2 critical、1 high、1 moderate、2 low，涉及Vitest/tinypool、source-map-js、Monaco/DOMPurify等。保留原统计范围，不解释成当前漏洞结论；修复先核实际用途，不直接跨大版本自动升级。

UI-PREP-09映射位置为[计划§4操作/接口映射](I0-B_UI_TUTOR_PLAN.md#4-当前公开-http-能力映射)与[§5差异清单](I0-B_UI_TUTOR_PLAN.md#5-差异交接与落实状态)。后续D-01/D-02/D-03与六票前端交付见§8及计划较新记录；映射本身不等于全系统采集或真实模型/真人验收通过。

## 3. UI-REAL：按A/C交接分批接入的12项

| 编号 | 工作 | 必需条件 | 截至2026-10-15工程/隔离状态与剩余 |
| --- | --- | --- | --- |
| UI-REAL-01 | 真实登录/退出与会话失效 | H-01：正常宿主、同源HTTPS、合成账号、Session/CSRF | [会话批次](I0-UI_AUTH_SESSION_ENTRY.md)已交、PR #64已合main；隔离HTTPS已验，PR #68正式b7e73c5 UI30已有表单重进及原会话证据；本轮匿名Session401/严格TLS核查通过，会话过期与完整现场仍分列 |
| UI-REAL-02 | 本人分配、固定活动和资料 | H-01/H-02及读取H-06；可用授权深链 | PR #64已接获准深链/bootstrap及可见资料；PR #67旧版本现场深链/公开资料/private redacted已验；未增加分配列表或跨设备Attempt发现，正式版本当次授权仍须复核 |
| UI-REAL-03 | 已有Attempt/文件/快照只读 | 身份、获准Attempt引用与读取样例 | 已在[I0-B真实入口](I0-B_REAL_ENTRY.md)及[保存恢复](I0-UI_REAL_SAVE_RECOVERY.md)覆盖获准引用/已有作品/快照读回；不另造独立整项通过数，跨设备发现未增加 |
| UI-REAL-04 | 首次创建Attempt | H-03受信代际与创建样例；学生主动操作 | 已有主动创建接线及实际服务浏览器覆盖，见[I0-B真实入口](I0-B_REAL_ENTRY.md)与[运行批次](I0-UI_REAL_RUN_CONTROL_HISTORY.md)；无自动创建，不再列待开发 |
| UI-REAL-05 | 缺首次代际时禁写 | 合法初始化后核零写请求与提示 | [保存恢复](I0-UI_REAL_SAVE_RECOVERY.md)隔离HTTPS真实409/零业务写通过，PR #64已合main |
| UI-REAL-06 | 确认保存与冻结快照 | H-01/H-03/H-05及保存/快照H-06 | PR #64隔离多文件/原字节/hash/manifest通过；PR #68正式UI30已有v8保存/冻结/刷新；[PR #75复验](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)实际明确保存新v9并冻结，原fileId/正文/hash/manifest及旧v8不变、刷新重登录均核对。实际丢ACK/恢复仍分列 |
| UI-REAL-07 | 版本与暂停/终态 | H-05：保存后重读，两个revision分开 | PR #64隔离paused/submitted/reviewed、VERSION_CONFLICT与两revision通过；UI30已有原Attempt暂停/恢复，submitted/reviewed等现场仍未替代；H-05已获准修源码并交PR #73，合并、当次运行生效及授权基线汇总分别核验 |
| UI-REAL-08 | 账号切换与会话恢复 | 两个获准合成账号，核隔离与迟到响应 | PR #64已交；两个合成账号/草稿/迟到响应/同账号恢复隔离通过；不清空其他账号草稿 |
| UI-REAL-09 | Core运行/诊断 | H-04当前指纹/代际/profile/消费者及运行H-06 | [运行批次](I0-UI_REAL_RUN_CONTROL_HISTORY.md)与PR #66已交；PR #68有真实C1成功/程序超时；[PR #75复验](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)已接正式修复包并完成新v9真实C1 succeeded，原Run/Job/快照/profile/代际关联一致。结果绑定该窗口，不记此刻在线或完整故障通过 |
| UI-REAL-10 | 停止与未知核对 | 原Job/Run和停止样例；未知不自动重跑 | PR #66隔离原ID/取消/unknown/丢ACK/双标签通过；PR #68有真实取消/历史；[PR #75复验](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)独立v4原Job实际running→cancelling→cancelled，确认后才显示停止。真实丢ACK未知、持久账本/OS恢复与完整停止故障仍分列 |
| UI-REAL-11 | 历史比较与公开产物 | 对应H-06；核裁剪、hash/bytes与下载 | PR #66隔离历史/下载/摘要/裁剪通过；[PR #75复验](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)已实际查看/下载已有获准v3完整report.txt，21 UTF-8 bytes和SHA-256匹配；历史/参数只读零业务写。未增加新Report运行能力，不补missing/redacted/incomplete；Core仍只创建stats/find/top |
| UI-REAL-12 | 故障/冲突/恢复 | 获准环境中核断网、丢ACK、重启与旧代际 | PR #64已交；隔离断网/原命令重放/双标签/旧代际通过；重开仅同进程同库，进程崩溃、旧备份/RPO及节点恢复保持未执行 |

H-01/H-02归A；H-03～H-06由A/C交清，H-06按读取、保存、运行、停止、产物分批。读取无需等运行，保存无需等节点，I0-A无需等B。宿主、执行消费者和节点维护由A/C负责，不纳入UI本批代实现。

原页关于“UI-REAL-05尚未验证、real初始化未跨H-02、正式登录UI未交”的描述已被上述后续交付替代。当前表格记录工程与隔离服务证据，不把12项勾成完整现场验收；真实C1服务端已有A/C证据，现场浏览器和最新运行窗口仍需对应验证。不能把材料未合main误记为材料未交，也不以Draft、Node HTTPS或合成runner替代现场浏览器通过。

## 4. UI-TUTOR：I0-B的9项

### 4.1 分层进入条件

| 阶段 | 可以做什么 | 进入条件 |
| --- | --- | --- |
| 准备 | 核现有页面；映射help、消息、回执与控制；列合成反例 | 明确I0-B本批写集，补齐原I0-A范围外的接入方案 |
| 分批实现 | 适配已交B2/C3能力；验证原文、回执、停止、返回和政策 | 该批范围确认；对应公开契约、内容和环境可用 |
| 真实浏览器联调 | 从获准Attempt发起求助并渲染；核引用、回执和取消 | 正常身份/入口及对应对象读取可用；使用批准的合成内容或历史材料 |
| 完整真实验收 | 两类真实求助后，学生自主修改、保存并重跑 | I0-A跑通、B/C对应批次齐备、新调用许可及人工语义审阅落实 |

消息、回执与控制不必等待新的供应商请求。代码求助需要文件/快照读取；运行求助还需原运行结果。新真实内容生成与已获准内容渲染分别记账。

### 4.2 完整编号与本批映射

| 编号 | 工作 | 原清单进入条件 | 本批承接 |
| --- | --- | --- | --- |
| UI-TUTOR-01 | 正式help与状态 | 本批范围确认；help/Job契约与身份/Attempt交接齐备 | [I0-B-02](I0-B-02_HELP_STOP_REPLACE.md) |
| UI-TUTOR-02 | 代码/选区求助 | 获准文件、快照/hash与原文坐标可读取 | [I0-B-03](I0-B-03_CODE_SELECTION_HELP.md)，D-01原Action对象来源已接入 |
| UI-TUTOR-03 | 运行结果求助 | 原run/snapshot与公开诊断可读取 | [I0-B-04](I0-B-04_RUN_RESULT_HELP.md)，D-01原Run/snapshot来源已接入 |
| UI-TUTOR-04 | 原文、Action与重连补取 | 对应消息/事件读取及已审阅内容可用 | [I0-B-01](I0-B-01_MESSAGES_RECEIPTS.md)，D-02已有公开授权历史已接入 |
| UI-TUTOR-05 | received/displayed/acknowledged | UI-TUTOR-04可真实渲染；用户明确动作可核查 | [I0-B-01](I0-B-01_MESSAGES_RECEIPTS.md)，真实DOM/可见性/回应分列 |
| UI-TUTOR-06 | 停止/替换/迟到 | 原Job/Action取消与事件控制交接齐备 | [I0-B-02](I0-B-02_HELP_STOP_REPLACE.md)，教学取消与运行取消区分 |
| UI-TUTOR-07 | 例子与返回 | 已有例子展示与原对象/位置映射可用 | [I0-B-05](I0-B-05_EXAMPLE_RETURN.md)，原实例/视图核验及最小槽位适配 |
| UI-TUTOR-08 | 政策与三个独立控制 | 当前政策、Attempt/采集/提醒契约可用 | [I0-B-06](I0-B-06_POLICY_CONTROLS.md)，D-03同事务限定检查投影与发送守卫已接入 |
| UI-TUTOR-09 | 两类真实求助到自主重跑 | 完整真实验收条件满足；保留失败和缺口 | 本批范围外，待I0-A/所需B-C批次/新许可/人工语义；没有另建实施票 |

六张票覆盖01～08。2026-10-14，获准前端工程已完成并随PR #57合入main；D-01/D-02/D-03、正常宿主及离线合成provider的实际HTTPS浏览器证据已交，见§8及[批次计划§13～14](I0-B_UI_TUTOR_PLAN.md#13-2026-10-14-六票逐项收尾审查)。这些依赖不再列成未接入；真实供应商语义、学生本人自主接棒、UI-TUTOR-09和全系统采集/分析保持分列，原清单编号与验收条件不变。

原页未约定完成日期，本页也不补造排期。历史B模型证据和最新离线修复分开，一次性许可不复用。

## 5. 其他任务的承接边界

下列为原页面范围提示，不计入上述30项，也不成为本批新任务或授权。

| 工作 | 可准备的材料 | 真实接入/验收归属 |
| --- | --- | --- |
| 数字逻辑UI | BoardProfile/Build/Session、四值、扫描、波形与输入顺序消费清单 | #37/#38/#40、DL-E2E；DL-C合并不等课程/入口/节点已可用 |
| 教师设计、审阅与反馈 | 实际成员UI与已交A4/C4的操作差异 | P5/I1及A5/B3等对应批次，不塞入I0-A |
| 固定提交、重开、后续活动、导出 | 公开契约与所缺操作 | P5/I1/I2、A/C接入包 |
| 完整AC/NFR | 覆盖/失败/未执行矩阵 | [#22](https://github.com/paher-din/XunJie/issues/22)、A6/B4/C5/I2；原负载/样本量不变 |
| 真人试点与教学效果 | 观察/反馈方案 | I3/AC-13/14/G4，工程与数据/账号条件满足后执行 |

## 6. 原建议顺序与当前用法

原页建议先核H-01/H-02读取交接，同时补UI-PREP-01～03及契约差异；读取跑通后接已有Attempt，再接创建/保存/快照，随后Core运行、停止与产物。UI-PREP-09先做辅导操作映射；消息/回执/控制按已交能力先接，代码求助再接文件/快照，运行求助接原结果，UI-TUTOR-09等完整条件。

这个顺序是2026-10-13的来源建议，当时授权为I0-B规划定稿/文档提交；后续六票、登录会话、保存恢复和运行批次已分别获准交付。本轮Robert明确授权01/03/05/06工程补验及真实节点入口准备，见§10；没有把准备授权扩大为节点/配置/信任变更、新模型调用或真人验收。依赖按能力核，不等待不相关整卡。

## 7. 验证与维护记录

2026-10-13，读取附件全部业务正文与嵌入源稿，确认30个唯一编号为UI-PREP-01～09、UI-REAL-01～12、UI-TUTOR-01～09。本页保留工作与条件，区分来源快照、本批已核事实、规划交付和未执行。八项辅导范围各有对应ticket，09的真实验收留待后续。

本页与本批SPEC/PLAN/六票同次本地提交；原HTML附件保留，不复制主题CSS/脚本到源码或改变原附件。静态检查结果和提交事实统一记录于[批次计划](I0-B_UI_TUTOR_PLAN.md)。后续有实际交付时追加日期与来源，在相应任务更新事实，不凭表格标签宣称正式通过。

## 8. 2026-10-14 当前实现与证据入口

本节保留I0-B六票完成时的交付范围；其后的登录、保存、运行与Git合并结果以§9为准。

六票在原`i0/ui-frontend`整合；四条初始工作支线、后续D-01/D-02/D-03和真实入口独立支线的代码与记录已保留。Robert对计划§10.3授权后，补入既有公共投影、原B2/C3持久消费者及同一真实工作区深链；不合并他人Draft、不增加schema或真实模型请求。

| 对象 | 当前交付 | 证据/保留条件 |
| --- | --- | --- |
| D-01 | 首次获准事件正文含原Action的Job/Message/对象/版本；页面校验并显示原来源，改稿不改贴 | [投影专项](I0-B-01A_EVENT_PROJECTION.md)、[代码票](I0-B-03_CODE_SELECTION_HELP.md)、[运行票](I0-B-04_RUN_RESULT_HELP.md) |
| D-02 | 原公开GET本人教学历史；另一client只读shown记录，不伪报展示、不分配新Delivery | [历史专项](I0-B-01H_HISTORY_READ.md)、[消息票](I0-B-01_MESSAGES_RECEIPTS.md)；“仅内部接缝”的旧判断已纠正 |
| D-03 | 原GET Attempt同事务limitedCheck；未知/true均不放行，发送前重读，服务仍独立拒绝绕过 | [检查专项](I0-B-06A_LIMITED_CHECK.md)、[控制票](I0-B-06_POLICY_CONTROLS.md) |
| D-04代码 | 固定A宿主选择性复用，组合现有28表工厂/B2/C3/C消费者；真实Session/深链与正常dist可用 | [宿主记录](I0-B_HOST_COMPOSITION.md)、[真实入口](I0-B_REAL_ENTRY.md)；受控证书/节点部署仍须按维护者原条件验收 |
| 浏览器/服务 | 原生hidden→visible及实际HTTPS/SQLite/原worker的离线合成项目/代码求助、原来源、跨标签历史已验 | [批次最终结果](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)；协议替身、dev authority、实际合成HTTPS分列 |
| 例子/接棒 | 原只读资料槽与原实例/视图返回已交，共同设计的合成相邻例子通过 | Robert明确本批不需要外部教师批准；真人与UI-TUTOR-09保持本批范围外 |

I0-B六票完成时，UI-REAL仅对登录后授权深链、首次创建、保存/冻结、本机刷新及辅导链增加证据，没有把12项全部勾过。当时未交的正式登录UI、保存恢复故障与运行接线随后由PR #64/#66承接；跨设备Attempt发现、现场受控节点浏览器及完整真人条件仍分列。产品基线及MVP_SPEC§10为“待授权维护者汇总”。

2026-10-14职责复核：06控制UI已交，不等于逐次编辑采集/被动分析/提醒调度已通。前端目前不自动上传编辑过程，正常宿主仅处理主动求助；相应跨模块能力不得列成Robert必须包揽的后台任务。前端事件上报若后续接入，需C/A明确契约，仍不自动确认学生作品。当前更正及负责人共同设计例子决定见[批次§12](I0-B_UI_TUTOR_PLAN.md#12-2026-10-14-负责人纠正与前端职责复核)。

2026-10-14最终收尾：UI-TUTOR-01～08对应六票的**获准前端工程交付完成**，原分支`i0/ui-frontend`整合；逐条证据、历史失败、最新34文件464项规则与169项完整Chrome见[批次§13](I0-B_UI_TUTOR_PLAN.md#13-2026-10-14-六票逐项收尾审查)。其中消息19、控制11、求助/停止8、代码5、历史5、返回4、运行4、实际HTTPS1共57项包含在169中，不累计重复执行。发送状态/预算与超时保存、同名重建/晚到来源、原文undo及本机返回、跨标签/账号/代际控制与原作品/运行回归均补齐；06全系统采集/分析行为、UI-TUTOR-09和UI-REAL其余项目仍分列，不能据此把30项全部勾完。六票前端交付无需补外部教师材料或新增模型调用；产品基线/MVP_SPEC§10待授权维护者汇总。

## 9. 2026-10-14 PR #64/#66后的最新状态与下一批

本节保留PR #69之前的核查时点；PR #56/#65/#69合并、正式UI30和PAHER只读结果见§11；随后新包实际浏览器复验以§12为最新，不把下文Open/Draft/旧ready503/未连接当当前状态。

### 9.1 已合入main的前端交付

| 批次 | 实际Git交付 | 已执行验证与范围 |
| --- | --- | --- |
| UI-TUTOR-01～08 / UI-PREP-09 | [PR #57](https://github.com/paher-din/XunJie/pull/57)，2026-10-14 13:13:16合入，merge `657ec10b03f833d3a9891650a27ac2c60b645ece` | 六票前端工程完成；34文件464单元、169项Chrome全量通过，包含57项辅导专项和1项离线合成provider实际HTTPS。完整真实模型/真人及跨模块采集不在该结论内 |
| UI-REAL-01/02/08与05/06/07/12 | [PR #64](https://github.com/paher-din/XunJie/pull/64)，2026-10-14 19:16:22合入，merge `8e6d37d843a79c87bd223689746bd1aefff3bb2f` | [登录会话](I0-UI_AUTH_SESSION_ENTRY.md)与[保存恢复§11](I0-UI_REAL_SAVE_RECOVERY.md#11-2026-10-14-pr-与合并交付授权)；合并前集成48/48 Chrome、464单元/typecheck/build/教学类型通过。隔离HTTPS/合成账号，重开只核同进程同库 |
| UI-REAL-09/10/11 | [PR #66](https://github.com/paher-din/XunJie/pull/66)，2026-10-14 20:13:09合入，merge `5c8c60ec93e00bc1782a534a88b696ae98c76c37` | [运行批次§5～7](I0-UI_REAL_RUN_CONTROL_HISTORY.md#5-实施与验证记录)；464单元、24宿主回归、类型/构建通过；17项新增实际服务与60项兼容分别验证。77项组合曾76通过/1失败，修复后受影响10项复验通过，不能写成一次77/77全绿。真实HTTP/SQLite/原消费者加合成runner |

首次核查确认上述三PR为MERGED、main为`5c8c60e`；收尾main已收到PR #67至`b7e73c5`，见§10。本地继续`i0/ui-frontend`，原`.zcodeignore`保留。当时GitHub未报告配置的CI检查，不称CI通过；合并不等于部署或现场验收。UI-REAL-03/04的读取/主动创建覆盖见§3，未另算一个独立完整验收批次。

### 9.2 A/C条件：材料已交，现场进入条件另核

以下是固定公开材料及有日期的现场记录，本轮没有连接PAHER、重读节点或领取秘密。因此“有材料/有历史通过”与“此刻入口在线/浏览器可用”分开。

| 条件 | 已交事实与固定证据 | 进入浏览器联调前还需核什么 |
| --- | --- | --- |
| H-03 / H-04节点代际、profile与就绪 | C于2026-10-13完成原源码重验/登记，profile=`c17-gcc15.3.0-textscope-v1`、sourceHash=`7f4ec4f3…`、fingerprintHash=`b07cddf9…`及受信代际已交；10项认证SSH与2项实际C1联调通过。[C固定交接](https://github.com/paher-din/XunJie/blob/ea5a6523245ef25e2ab15712fa5aae5fc182deb8/docs/tasks/I0_C_HANDOFF.md#92-本次实际验证与证据) | 使用原受控来源重读当次节点/宿主、bootstrap代际与固定活动profile；历史ready不是永久有效凭据，不将代际写成前端常量 |
| 正常宿主与原持续消费者 | C于2026-10-14 14:35接收应用源`964abb4`；14:35:58.573严格TLS `/health/ready=200/data.status=ready`，no-store/requestId匹配，原24表库/对象与节点指纹/代际保留。[现场§18](https://github.com/paher-din/XunJie/blob/279f2145a33b0526f394f97739a204a1e5f0016c/docs/tasks/DLA_C_CLOSEOUT_HANDOFF.md#18-2026-10-14-批准执行-pr59-的-paher-定向接入)、[换版后摘要](https://github.com/paher-din/XunJie/blob/279f2145a33b0526f394f97739a204a1e5f0016c/docs/tasks/evidence/c-entry-readiness-pr59/after-switch.json) | 当前运行窗口和停止责任；本轮未现场探测，不断言现在仍active。PAHER静态目录在该记录中仍是旧`9fa76ad`产物，需要接收已交新版前端 |
| H-05 / H-06公开请求、版本与结果样例 | [C的33份公共HTTP样例](https://github.com/paher-din/XunJie/blob/ea5a6523245ef25e2ab15712fa5aae5fc182deb8/docs/tasks/evidence/i0-c-revalidation/http-samples.json)为实际app.inject/Session/SQLite，runner故障transport标合成；[持久新库20项结果](https://github.com/paher-din/XunJie/blob/61ae758e745cf63797b009e1622bf410dc34a2a8/docs/tasks/evidence/c-entry-recovery/https-verification.json)与[去敏HTTP](https://github.com/paher-din/XunJie/blob/61ae758e745cf63797b009e1622bf410dc34a2a8/docs/tasks/evidence/c-entry-recovery/https-http.json)记录真实HTTPS/正常main/原消费者/C1的20/20、178个TLS响应，包括Core、报告bytes/hash、检查裁剪、原ID取消、暂停与旧代际 | 浏览器按当前合法对象消费对应样例；按实际范围补停止/unknown/产物等行为，不把服务端20项计成浏览器通过，不重复无变化的整批节点验收 |
| 现场浏览器、信任与账号通道 | 后续[PR #67固定完整记录](https://github.com/paher-din/XunJie/blob/b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43/docs/tasks/I0-UI55_BROWSER_ENTRY.md)已按准确对象授权并落实：CurrentUser Root/Chrome155正常TLS、固定主机公钥/既有维护SSH、14443转发/本机HTTPS gateway、指定合成学生内存口令消费；登录/深链/刷新/退出/重登录已实测 | 复用既有获准本机入口及[工具](../../tools/i0-ui55/README.md)，不重索首次通道/信任方案。核当次窗口/进程归属/启动停止责任，接收本批正式dist；原候选结果不能视为正式UI已验 |
| PR #67候选现场的版本/门禁 | PAHER应用仍`9fa76ad`、前端`40db96c`加本地H-04候选（后映射`79f9037`），[manifest](https://github.com/paher-din/XunJie/blob/b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43/docs/tasks/evidence/i0-ui55-browser/ui-dist-manifest-h04-20261014.json)保留sourceDirty/未提交产物事实；真实C1 v7/v4运行/取消/历史关联已验；最终入口check为15通过/1失败，唯一失败HTTP ready503 | 原146内核恢复后的C1独立ready退出0，不能覆盖HTTP ready503；14:35的ready200属于另一固定应用/窗口。接收既有正式宿主/就绪实现和本批正式UI后重读ready/代际/profile，503时正确禁止新Run。正向产物下载和正式版本现场仍待验 |

A就绪修复的来源链为PR #59→#53→#56，来源关闭不代表代码弃用；本前端批次已按明确三文件授权把既有C就绪能力随PR #66合入，并保留辅导消费者。[PR #56](https://github.com/paher-din/XunJie/pull/56)本轮仍Open/Draft、head `246451e423f5d792ebd93ad64d30b55794e41584`；其完整HDL/共享宿主集成未合main，不作为上述C前端材料首次交付的等待条件。

### 9.3 下一批建议与责任

1. **复用现成入口补正式版本的真实C1联调（UI-REAL-09/10/11及相关缺口）。** 不再等待首次H-04/H-06/信任/账号材料；接收本批正式前端和现有正式宿主/就绪修复，核当次HTTP ready/代际/profile。503不放行；ready后从正式登录/授权深链，经保存/冻结到Core、原Job停止/unknown、历史与可用公开产物。PR #67旧候选实测保留，正向下载/正式UI现场另验。问题回原模块：UI修页面，A修身份/宿主/契约，C修作品/节点。
2. **条件齐备后做UI-TUTOR-09。** 两类真实求助、人工语义审阅及学生本人自主修改/保存/重跑分开核；当前该批新模型调用许可和真人操作安排未在本任务确认，不复用已消耗的旧批次许可。
3. **准备项剩余04/07/08。** 本轮01/03/05/06已完成获准补验，不重开02原文历史修复；04需要真实IME操作，07先形成当前审计/精确方案再按授权更新依赖，08剩余证据和他人记录交原维护者。完整30项仍不全部关闭。

本轮负责人随后明确授权工程补验与入口准备，实际交付见§10；上述新现场/模型/真人执行仍未在本批启动。数字逻辑、全系统采集/分析、完整NFR与教师/真人任务继续按§5和原分工承接。

### 9.4 本轮文档维护记录

2026-10-14，Robert明确要求更新本清单。写集仅本文件，保留30个原编号、原交付/进入条件及历史记录；不改产品/规划/规范或其他作者任务。已读README、PRD §4.2～4.4、MVP_SPEC §6/7及§8核心验证条件、TECH_DESIGN §7.4/7.5/8.1/8.2及TEAM的A/C/UI职责正文；核当前会话/保存/运行记录、I0-B §13～14、C固定H-03～H-06材料与#30最新回交。关联AC-03/04/06/10/12/15，只更新事实索引，不宣称整项验收通过。

本轮只读GitHub回读main及PR #57/#64/#66/#56；首次main请求连接超时，重试成功，未据失败推断远端状态。首次文档检查发现本轮新增运行记录链接的锚点错误，已改为实际“实施与验证记录”标题；最终`node tools/a0-review/check.mjs`为85份文档/1264条内部链接、errors=[]，`rtk git diff --check`通过。30个表格编号全部唯一，UI-PREP 9 / UI-REAL 12 / UI-TUTOR 9；差异仅本文件。未运行新的业务/浏览器/节点/模型测试，已有结果均保留所属版本与边界。产品基线及MVP_SPEC §10：待授权维护者汇总。

## 10. 2026-10-14 UI-PREP-01/03/05/06与正式入口准备

本节是工程补验与包冻结时点，随PR #69正式合main；之后的Git/只读核查与A/C交接见§11，新包实际复验见§12。

Robert明确要求在原`i0/ui-frontend`开始四项补验并准备真实节点联调入口；[当前任务](I0-UI_PREP_VERIFICATION_CLOSEOUT.md)记录已读正文/适用编号、写集、反例与窄修复、公开契约矩阵、原失败及最终复验。幂等同键异正文和连续键盘专项已通过；菜单Esc/只读视图返回焦点、辅导故障中文说明已修，原命令/诊断/学生作品保持。

464/464单元、类型与正常build通过；90项兼容组合有3失败并提前中止，后续44项43通过/1失败，修正正文冲突说明后受影响20/20复验通过，不写一次90/90、不重复累加。实际HTTPS服务的Session4项和辅导1项通过，仍为隔离合成验证。最终prep/real各两次独立冷启动无504，进程退出0/端口释放/自有缓存清理通过；不计现场或NFR。

收尾核main已接收PR #67（2026-10-14 20:44:32合入，merge `b7e73c5`）。工具/信任/账号通道和旧候选现场证据复用，未变生产源码/API/schema；15/16的HTTP ready503与旧应用/候选版本边界保留。本批固定正常dist/源码/校验清单见[交付记录§7](I0-UI_PREP_VERIFICATION_CLOSEOUT.md#7-正式产物与本地git交付)，本轮未连接PAHER、领取秘密、改信任/配置/库/节点或调用模型。下一步是接收正式版本和既有就绪修复后补现场，不重新实现后台。

清单仍完整保留30个原编号及条件；本轮本地分支提交、最终文档检查与产物事实由当前任务追加，不改产品/规划/参考/他人记录。产品基线及MVP_SPEC §10：待授权维护者汇总。

## 11. 2026-10-14 PR #69合并与直接SSH交接

本节是PR70交接时点；“新ZIP尚未切入”随后已由§12实际接收和复验更新。

Robert要求先推PR并合main，再给A/C整理各自事项，并提供本机现成SSH工具。已完成[PR #69](https://github.com/paher-din/XunJie/pull/69)，head `1f7d9f0`，21:58:34合main `87edd51e165b2bab660d73a551864ff8db0bed86`；同窗口PR #56/#65已合入，正常接收且学生生产输入无新变化。PR56作者70/70及审核复用；当前组合的五份正常HTTPS/SQLite service spec另补22/22通过、零skip/flaky/failure，仍为隔离合成runner/provider，不与旧通过数累计。

从负责人指定工具直接核查：SSH身份成功、当前f761dcd的两个应用unit均active/running；本机网关16/16、HTTP ready200、C1原146/profile/指纹/代际匹配、原24表v8快照两文件/manifest重算通过。旧probe检查的recovered单位已inactive而总退出1，不等于SSH断连。固定运行源和本机当前静态包分别仍是C记录的f761dcd与b7e73c5 UI30，不把main合并当已部署；本批新ZIP仍未切入gateway。

[A/C可执行交接](I0-UI_AC_HANDOFF_20261014.md)明确：A联合C处理H-05差异并走原负责人/授权维护者决定路径；C提供实现/反例与既有运行环境职责。SSH只读、Robert本机产物接收及浏览器复验由UI直接承担，不要求C重复首次接线/ready修复/H-04/H-06。PR #68正式UI30回交保留所属版本，当前HDL UI按已交H4包分批进入，不等后置H3；新模型、真人与完整验收仍沿原门禁。

本轮交接/去敏摘要以共享Git提供给成员，未自动私信其他聊天、未重复发Issue评论；没有秘密/配置/库/节点/服务写操作。本轮检查与共享Git回执见[A/C说明§6](I0-UI_AC_HANDOFF_20261014.md#6-当前共享宿主兼容验证与文档交付)，原30编号/进入条件及失败历史保留。产品基线/MVP_SPEC §10待授权维护者汇总。

## 12. 2026-10-14 新包真实浏览器复验与现场修复

本节保留新包现场与本地收尾时点；随后负责人要求本批推PR/合main，已创建[PR #75](https://github.com/paher-din/XunJie/pull/75)，最新Git交付见[本轮发布记录](I0-UI_PR69_REAL_BROWSER_RECHECK.md#6-2026-10-14-pr发布与合并授权)及该PR最终公开回执。

Robert明确授权接收新包、仅切本机网关选择、复用现有SSH和获准合成A做实际Chrome复验，并在原`i0/ui-frontend`修问题/更新清单。[完整本轮记录](I0-UI_PR69_REAL_BROWSER_RECHECK.md)列读依据、精确授权、两条现场反例、红/绿与来源/失败/未执行。先接PR69源`4a0bdbb`原143文件ZIP；再修首次打开回收文件及明确不可重试的辅导拒绝仍轮询，固定本地源码`b50918a`，独立143文件新包/入口`index-DmeUPG54.js`已由原工具切入，check16/16、严格TLS/ready200。远端正常24表源仍`f761dcd`，没有部署新宿主或改库/schema/账号/信任/代际/节点。

| 清单关联 | 本轮新增实际证据 | 仍保留的范围 |
| --- | --- | --- |
| UI-PREP-01/03/05/06 | 正式production包真实键盘菜单/比较/运行返回、原文undo；只读契约、命令/回执/版本/hash来源和真实拒绝呈现均核对；原冷启动/同键冲突固定证据保留 | 没有重复旧批整套故障/冷启动或累计NFR通过；H-05依A/C决定路径 |
| UI-REAL-01/02/03/04/08 | 正常表单登录、明确领取原Attempt、读原作品材料、fresh browser首active、退出200及重登录恢复原v9；没有初始化自动保存/Run或新Attempt | 本轮只原合成A；第二账号、真实过期/撤权沿原隔离证据，未计现场覆盖 |
| UI-REAL-05/06/07/12 | 原main明确保存v9/documentVersion7、144字节/hash及新快照；原v8与其他文件不变；正常刷新/重登录/独立只读SQLite核对通过 | 真实丢ACK/旧代际/库恢复、暂停/终态等故障分支未本轮注入 |
| UI-REAL-09/10/11 | 新v9真实C1 succeeded、独立v4 running→cancelling→cancelled；原Job/Run/hash/profile关联、参数历史只读且零业务写；已有v3完整report.txt实际下载21字节/hash一致 | 当前Report新运行能力仍未交，下载消费已有获准available/complete原产物；执行unknown等现场故障未覆盖 |
| UI-TUTOR | 当前24表未组合C3自然400后暂停自动poll，手动读仍400但不损作品；新24/28表实际HTTPS服务2/2及原兼容33/33通过 | 不记PAHER辅导路由/语义或UI-TUTOR-09通过；无新help/模型/真人 |

验证另为34文件464单元/类型/正常build通过，新增文件浏览器1/1与原兼容7/7分别通过，服务2/2及辅导33/33分别通过；两条首RED和工具校验/读取时序失败完整保留，不写一次整批全绿。最终现场业务POST只1 sync、1 snapshot、2 runs、1 cancel，help/新Assignment/新Attempt为0；SSH只读投影原runCount10→12、旧10条不变、最后无活动或unknown，v8/v9两个manifest原字节一致。公开摘要、下载摘要和截图见本轮记录§4。

正向完整产物下载缺口本轮已有实际证据，原§9～11“尚未切新包/下载待验”只保留历史时点。A/C剩余H-05及以后真实辅导组合环境见[追加交接](I0-UI_AC_HANDOFF_20261014.md#7-新包真实复验后追加交接2026-10-14)；不派C重复SSH/C1接线。下一批仍可推进准备04的真实IME、07的精确依赖审计方案、08的剩余原维护者回交，或沿已交H4范围分批接HDL；新模型/真人须原独立门禁，本轮不替完整30项/产品验收。

新修复在原前端分支本地提交，未自动新PR或合main；README仅补本轮入口，保护文档与他人记录保留。产品基线/MVP_SPEC §10待授权维护者汇总。
