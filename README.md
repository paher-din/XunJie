# XunJie

项目制教学 Agent：教师与 Agent 共同设计项目，学生在真实动手、试验与修订中学习，教师依据具体表现改进后续教学。首版是面向高校 CS 课程的独立 Web 应用。

## 当前进度

2026-10-11，项目负责人批准保留 C17/GCC、TextScope Core→Report 与现有 Web/应用服务/执行隔离架构，新增「数字逻辑与部件设计」的一条本地真实演示链。首条实验采用课程题目 PDF 已定义的 4 位 ALU 范围与 Nexys4 DDR Rev. C；课件用于讲解，未定义组合和 Cout 暂不判分。具体分工已纳入 [TEAM 的 P3～P5](docs/planning/TEAM_WORK_PLAN.md)：P3 的 DL-A/DL-C/DL-B 分别由 A/C/B 负责，P4 的 A6/B4/C5 验证两课程，P5 完成整体 UI 与应用验收。当前 P2 的 A3/B2/C3 继续原范围；数字逻辑评审/开发从 P2 原预交付确认后开始。材料、决定和交付证据见 [DL-0](docs/tasks/DL-0_DIGITAL_LOGIC_ADDON.md)，数字逻辑应用/真实模型/浏览器 Demo 尚未验收，原正式条件保留。

2026-10-11，项目负责人确认进入 P2（G2 服务端教学支持）。[P2 总协调记录](docs/tasks/G2_OVERALL_COORDINATION.md)负责阶段依赖、跨模块契约核对、集成审查与验收汇总；A3/B2/C3 仍由既定成员分别实现，A 保留公共契约与应用集成职责。P2 服务端预交付及完整 G2 尚未验收，B1 实际模型接入和原 #22/#23 后续条件继续保留。

P2 任务已发布：[总协调 #24](https://github.com/paher-din/XunJie/issues/24)、[A3 #25](https://github.com/paher-din/XunJie/issues/25)、[B2 #26](https://github.com/paher-din/XunJie/issues/26)、[C3 #27](https://github.com/paher-din/XunJie/issues/27)，均 Open；任务范围、依赖与分层验收见各 Issue，发布核对见总协调记录第 6 节。

2026-10-12，A3/B1 SDK/C3/B2 的 PR #28/#29/#33/#32 均已合入；P2 整体复验仍有两项已复现阻塞：教师与学生能力同时装配时重复 Job 路由导致启动失败，C3 将合法长未知说明当作 ID 拒收。#24/#25/#26/#27 及真实模型待验的 #11 保持 Open，服务端预交付与完整 G2 尚未通过；验证事实、修复归属和关闭核对见 [G2 第 14 节](docs/tasks/G2_OVERALL_COORDINATION.md#14-2026-10-12-p2-整体复验与-issue-关闭核对)。

2026-10-12，负责人授权总协调修复上述两项缺口，本地修复候选已通过新增三项回归、原独立反例、typecheck/build；完整 260 项为 252 通过、1 个既有环境失败、7 跳过。公开推送/PR 尚未执行，Issue 状态与真实模型/教师/UI门禁保留；具体实现、验证和交付边界见 [G2 第 15 节](docs/tasks/G2_OVERALL_COORDINATION.md#15-2026-10-12-g2-r01r02-最小修复)。

2026-10-12，负责人已批准公开推送上述修复，`codex/p2-integration-fixes` 已推送并建立 [Draft PR #35](https://github.com/paher-din/XunJie/pull/35)，尚未合并，#11/#24/#25/#26/#27 保持 Open。固定修复 `981d055` 的验证结果不变，发布核对见 [G2 第 15.4 节](docs/tasks/G2_OVERALL_COORDINATION.md#154-公开分支与-draft-pr-交付)，真实模型/教师/UI等原关闭条件保留。

2026-10-12，PR #35 已合并为 `5d725ba`，合并树与已验证修复一致；A3 #25、C3 #27 按原服务端批次条件关闭为 Completed。B2 #26 的确定性部分已完成，人工语义未验收；B1 #11 离线部分已完成，真实模型门禁未落实，两项与 P2 #24 保持 Open。P2 继续准备显式获准的真实模型验证，原完整 G2/教师/UI条件保留，见 [G2 第 16 节](docs/tasks/G2_OVERALL_COORDINATION.md#16-2026-10-12-pr-35-合并模块关闭核对与-p2-下一步)。

当前 A1/A2/C1/C2 服务端与 B1 合成核心已合入 main，C2 [PR #20](https://github.com/paher-din/XunJie/pull/20) 的四项原审查意见已修复并合并。[G1 #9](https://github.com/paher-din/XunJie/issues/9) 已按负责人确认的服务端预交付阶段关闭为 Completed；完整产品 G1/正式应用仍未验收：UI/AC/NFR 由 [#22](https://github.com/paher-din/XunJie/issues/22) 承接，环境稳定性由 [#23](https://github.com/paher-din/XunJie/issues/23) 跟踪，B1 实际 SDK/模型仍在 [#11](https://github.com/paher-din/XunJie/issues/11)。Web UI 由团队成员负责，按其实际交付接入。

2026-10-11，项目负责人要求关闭 A1/A2/C1/C2 后先整合全部本地分支与工作树。A1 #10、A2 #13、C1 #12、C2 #14 已回读 Closed / Completed；B1 #11、完整 G1 UI/AC/NFR #22 和环境稳定性 #23 保持 Open。各任务旧 Open 表述保留其日期，当前管理状态见 [G1 第 19 节](docs/tasks/G1_OVERALL_COORDINATION.md#19-2026-10-11-执行-issue-关闭与本地全部工作整合)。12 个原有分支、9 个工作树 HEAD 和主副本未提交文件已整合到本地 main，逐项祖先关系与原始证据摘要核对通过。全部分支、工作树和备份保留；负责人随后授权推送并拉取，整合成果已普通推送至远端 main，快进拉取后两端提交一致、工作区干净，发布事实见 G1 第 19.4 节。

2026-10-12，项目负责人确认启动 P3 总协调，并保留未完成的 P2 工作。[P3 总协调记录](docs/tasks/G3_OVERALL_COORDINATION.md)跟踪数字逻辑增量与原反馈闭环的依赖、评审、集成和分层验收，DL-A/DL-C/DL-B 与 A4/A5/B3/C4 仍由 A/B/C 按既定职责交付。A3/C3 已收口，B1 真实模型、B2 人工语义及 P2 #24 仍待完成；P3 启动不表示 P2 预交付或完整 G2 通过，数字逻辑具体评审/实施仍保留原预交付确认与契约/运行授权条件。P3 两个出口与完整 G3 尚未验收，原 P4/P5、M/AC/NFR 和真人门槛保持有效。

2026-10-12，P3 总/子任务已发布：[总协调 #37](https://github.com/paher-din/XunJie/issues/37)、[DL-A #38](https://github.com/paher-din/XunJie/issues/38)、[DL-C #39](https://github.com/paher-din/XunJie/issues/39)、[DL-B #40](https://github.com/paher-din/XunJie/issues/40)、[A4 #41](https://github.com/paher-din/XunJie/issues/41)、[B3 #42](https://github.com/paher-din/XunJie/issues/42)、[C4 #43](https://github.com/paher-din/XunJie/issues/43)、[A5 #44](https://github.com/paher-din/XunJie/issues/44)，均 Open，完整正文与依赖链接已回读核对。P2 遗留与原实施/验收门禁保留；发布事实见 [G3 第 8 节](docs/tasks/G3_OVERALL_COORDINATION.md#8-2026-10-12-p3-总子-issue-发布)，本地总协调记录尚未提交/推送，公开 Issue 不依赖未发布文档。

2026-10-12，负责人授权的 P3 总协调记录与 README 已普通提交/推送到 main，首发提交为 `1b2bd10`；远端引用与两份文档 blob 回读一致，文档/空白/写入范围检查通过。总协调 Issue #37 已补公开文档入口，原任务状态与 P2/P3 实施/验收门禁保留；推送及记录同步见 [G3 第 9 节](docs/tasks/G3_OVERALL_COORDINATION.md#9-2026-10-12-本地总协调文档推送)。

2026-10-12，项目负责人决定收口本次 P2 工程审查，并将 B1/B2 的未完成模型接入、真实调用和人工语义补验集中到 [B 后续 #45](https://github.com/paher-din/XunJie/issues/45)，主责为 B；账号与真实调用继续暂缓。总协调正提交剩余验证入口并执行旧 Issue 关闭，实际结果见 [G2 第 18 节](docs/tasks/G2_OVERALL_COORDINATION.md#18-2026-10-12-p2-工程审查收口与-b-后续交付)，B 交付后再复审，原完整产品验收条件保留。

2026-10-12，剩余验证入口 [PR #36](https://github.com/paher-din/XunJie/pull/36) 已合入 main（`46617a2`），本次 P2 工程审查通过，[#24](https://github.com/paher-din/XunJie/issues/24)、B1 #11、B2 #26 已关闭；全部 B 侧未完成项由 [#45](https://github.com/paher-din/XunJie/issues/45) 继续承担。typecheck/build 与 49 项专项验证通过，2 项真实模型测试按门禁跳过；真实调用及人工语义仍待完成，B 交付后由负责人通知复审，不自动跟进，见 [G2 第 18.4 节](docs/tasks/G2_OVERALL_COORDINATION.md#184-已完成收口与最终交付)。

2026-10-12，P3 的 [C4 #43](https://github.com/paher-din/XunJie/issues/43) 已由 C 在分支 `codex/c4-submissions-recovery`（`7063fd2`）交付服务端实现并建立 [PR #47](https://github.com/paher-din/XunJie/pull/47)，尚未合并，#43 保持 Open。改动全在 C 属，A 属与 B 属文件零改动；新增两张表只写 C 属合成 schema，属红线内的 schema 追加，已在任务稿与 PR 正文明示并请负责人复核。任务稿第 6 节的四项解释与跨属提案待负责人裁决，A4/A5 实际路由接入后的联合验证、真实浏览器/执行节点/备份恢复均未执行，分层结果见 [C4 第 8 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#8-实现记录)。

2026-10-12，项目负责人批准 C4 的合成库 schema 追加与任务稿第 6 节的四项解释与跨属提案，[PR #47](https://github.com/paher-din/XunJie/pull/47) 据此继续审查，尚未合并，[#43](https://github.com/paher-din/XunJie/issues/43) 保持 Open。批准按任务稿原文字面，只覆盖已实现的读法与 C 属两张合成表，不覆盖真实数据库建表迁移与生产部署，也不构成对 A 属新增活动版本字段或新增权限用途的授权，那两部分仍只是提案。批准不改动任何代码。四条读法若需写回 PRD/MVP_SPEC/TECH_DESIGN，按文档优先规则交由授权维护者汇总，当前状态为待授权维护者汇总；浏览器、真人师生、真实模型与完整 G3 的验收条件不变，逐项落地含义见 [C4 第 6 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#6-待确认的解释项与跨属提案)。

2026-10-12，项目负责人进一步授权把 C4 的三条已批准读法写回产品基线，汇总已完成。核对后 [PRD](docs/product/PRD.md) 与 [MVP_SPEC](docs/product/MVP_SPEC.md) 无需改动，M-07 原文「仅对课程明确要求的目标补充短解释、预测或变式检查」本身已是该读法，缺的是技术侧活动版本字段而非产品要求；实际只在 [TECH_DESIGN](docs/product/TECH_DESIGN.md) 三处既有行与既有段内追加文字：controls 行的 `resume_revision` 授权用途、submissions 行的说明与检查引用校验范围及活动版本字段缺口、以及「失效按用途」一段中暂停与提交/重开的取消范围拆分。未改名任何标题、未增删任何路由、未放宽任何验收，文档检查退出码 0 且各项计数与改动前一致。授权范围仅限这三条读法；「分配暂停使已发放的重开许可失效、恢复分配不使其复活」一条不在其中，仍只作为交 A5/UI 的事实保留在任务稿，未写入基线。

2026-10-13，项目负责人一并授权 C4 审查留下的两项裁决：从 TECH_DESIGN 第 7.2.1 节该句删去「提交」在授权范围内、不回退；「分配暂停使已发放的重开许可失效、恢复分配不使其复活」写入产品基线，已落在第 5 节 reopen 行。授权按字面只覆盖这两项，不含合并任何 PR、不含修改 #48（DL-C）分支，也不改变任何未执行项。#47 与 #48 的合成库表数撞点已实测并记录，顺序建议先合 #47 再合 #48，合并仍由负责人执行。

## 首版范围

首发为 C 程序设计/C、函数/数组/指针先备及指定教材；学生只在 Web 工作区完成 TextScope Core（stats/find/top）→教师反馈→Report，不需要本地工具链或终端。后台 Linux/容器归 C，UI 由成员最后交付。DeepSeek/deepseek-flash 配置、合成开发/预置账号/私有试点/90 天复核不自动删除及数据责任已批准；预算金额和投入/交付日期不入文档，原外部项目门槛仅作参考。教材 PDF 本次经负责人确认公开分发授权后纳入仓库，MVP 资料导入仍按 TXT/Markdown 范围。

## 文档

阅读顺序：PRD → MVP_SPEC → TECH_DESIGN。文档间冲突的处理规则见 PRD 1.2。

| 文档 | 内容 |
| --- | --- |
| [PRD](docs/product/PRD.md) | 为谁解决什么问题、产品原则、核心流程、成功标准 |
| [MVP_SPEC](docs/product/MVP_SPEC.md) | 第一版做到哪里、业务行为、限额与验收 |
| [TECH_DESIGN](docs/product/TECH_DESIGN.md) | 后台、Agent 与 UI 对接的结构和契约 |
| [三人分工与交付顺序](docs/planning/TEAM_WORK_PLAN.md) | 当前 P2 保持原范围；P3 的 A/C/B 数字逻辑任务卡、P4 两课程验证、P5 整体接入及个人执行顺序 |
| [DL-0 数字逻辑课程增量](docs/tasks/DL-0_DIGITAL_LOGIC_ADDON.md) | ALU/板卡材料、决定、授权与分工/验证记录；具体执行任务以 TEAM 的 P3～P5 为准 |
| [DL-A 课程、共享契约与业务接入](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md) | 获准提前评审准备，A 域输入已交；仍待 C/B/UI 具体提案、配置/schema/运行授权 |
| [A4 有效学习状态与教师纠正](docs/tasks/A4_LEARNER_STATE_REVIEW.md) | C4 合并后获准精确 33 表合成库、受控状态/纠正接口、C3 同事务失效与 B2 读取；PR修复专项51/51、两轴未解决0；默认/串行全量失败与后置项单列 |
| [A0 业务权限与公共契约评审稿](docs/tasks/A0_BUSINESS_CONTRACT_REVIEW.md) | Issue #2 的权限、状态、逐命令与短事务提案、D-03、验证方案和待会审差异；未成为正式契约 |
| [G0 Issue 跟踪](docs/planning/G0_ISSUES.md) | 已发布的统筹 Issue 与 A0/B0/C0 三个执行 Issue，任务正文、交付和关闭条件 |
| [G0 交付核对与实施门禁](docs/tasks/G0_SCOPE_CONTRACT_GATE_REVIEW.md) | 三项 PR、差异与真实验证，以及负责人统一裁决/准备门禁记录；不代签或计作产品验收 |
| [G0 TextScope 参考与活动适配](docs/tasks/G0_TEXTSCOPE_ACTIVITY_SPEC.md) | 外部候选供追溯，Web 学生空间的 Core/Report 活动提案另列；不照搬本地开发/六阶段/评分要求 |
| [G0 缺口收敛与批准记录](docs/tasks/G0_CLOSURE_PROPOSAL.md) | 已获负责人统一批准的教学/模型/数据/技术/首批进入方案及五份文件授权；正式契约以产品基线为准，未实施应用 |
| [G1 总协调与作品链交付跟踪](docs/tasks/G1_OVERALL_COORDINATION.md) | 服务端交付/合并/分层证据与 #9 行政收口；原完整 G1 条件在 #22、时钟问题在 #23 保留，产品基线未改；模块仍由 A/B/C 负责 |
| [G2 / P2 总协调与教学支持交付跟踪](docs/tasks/G2_OVERALL_COORDINATION.md) | 教师生成/采用、学生辅导/取消与消息采集两条链的依赖、交接和分层验收；不代做 A3/B2/C3 |
| [G3 / P3 总协调、数字逻辑增量与反馈闭环](docs/tasks/G3_OVERALL_COORDINATION.md) | P2 遗留、P3 任务依赖/评审、两条集成链与分层验收；不代做 A/B/C/UI，原预交付和实施门禁保留 |
| [C4 固定提交、学生修订与闭环恢复](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md) | 学生固定提交、教师复核阶段推进、重开许可与学生本人 `resume_revision`、闭环恢复读取的服务端实现与 AC-06/08/09/12 确定性验证；代码改动全在 C 属，新增两表只写 C 属合成 schema，不迁移既有库。合成 schema 与第 6 节四项解释/跨属提案已于 2026-10-12 经负责人批准，三条读法已写回 TECH_DESIGN；交 A5 的事务接缝与恢复反馈接缝已给出，真实浏览器/执行节点/备份恢复与 A4/A5 联合验证未执行 |
| [C3 教学消息、回执、采集控制与作业失效](docs/tasks/C3_TEACHING_MESSAGES_RECEIPTS.md) | 两轮审查问题已修复（首轮 14 项 + PR #33 的 5 项 P2/9 项 P3），C3 专项 20/20、C3+B1 组合 67/67 通过；Windows 全量 212 项中唯一失败是 Linux-only `RunControl`，属 #23 既有环境限制，完整 G2/B2/UI 未验收。实现与交接见第 8～9 节，两轮修复与真实验证见第 11、13 节 |
| [C1 专用隔离执行与可信检查](docs/tasks/C1_ISOLATED_RUNNER.md) | 专用 KVM Ubuntu VM、受认证原 ID 控制/取消/恢复、固定 C17 profile、Core/Report 可信检查、全部限额与真实 ready；节点验收已通过，业务与 UI 接入属后续任务 |
| [C2 工作区、快照与基础作业](docs/tasks/C2_WORKSPACE_JOBS.md) | 完整服务端工作区/快照/基础作业、A1/A2 同事务与批准新二十二表合成库、C1 原 ID 运行/检查/产物；四项审查修复与作者32项含节点组合见第13节，最新合并/组合验证见G1记录 |
| [C1/C2/A1/A2 合并记录](docs/tasks/A1_A2_PR_MERGE.md) | 四项 PR 固定提交、旧审查关闭、依赖顺序合并和 main 验证；完整 C2/G1 与浏览器/TLS 仍分别验收 |
| [C0 工作区、记录与执行交付稿](docs/tasks/C0_WORKSPACE_RECORDS_RUNNER.md) | 独立任务文档：StudentIDE 参考差异、接口提案、资源/恢复约定和验证方案；待 A/B 会审 |
| [工作空间规范](AGENTS.md) | 已确认决定、协作分工、工程纪律与操作红线 |
| [产品研究依据](docs/reference/PRODUCT_RESEARCH.md) | 影响首版的研究结论、证据边界与公开来源 |
| [工程衔接说明](docs/reference/ENGINEERING_HANDOFF.md) | 可沿用的 IDE/记录/运行/诊断契约与历史试验限制 |
| [工作区合并与 Issue 收口](docs/tasks/W2_WORKSPACE_MAIN_INTEGRATION.md) | 本地 skills/接入记录、授权教材与既有工作树的 main 集成及实际验证/关闭记录 |
| [课程教材目录](course_matrial/) | C 教材的既有分发授权见 W2；数字逻辑四份参考材料于 2026-10-11 经负责人确认有分发权并授权公开推送，原样/hash 记录见 DL-0；资料导入仍按 TXT/Markdown |
| [B0 模型、帮助与候选分析交接稿](docs/tasks/B0_模型帮助分析契约.md) | 三类输入/输出、可信来源、保存归属、拒绝与取消提案；待 A/C 会审 |
| [B0 模型与预算复核](docs/tasks/B0_MODEL_VENDOR_RESEARCH.md) | 精确型号/区域/结构化方式、数据条款证据状态及预算/配额建议；D-02 待批准 |
| [B0 合成工程样例](docs/tasks/B0_TEACHING_EXAMPLES.md) | E1～E10 的具体输入/时序、确定性与人工判据，补教师/候选实例；业务验收未执行 |
| [B1 Agent 核心](docs/tasks/B1_AGENT_CORE.md) | 教师生成、无历史学生辅导、合成 provider、实际 AI SDK/DeepSeek 适配与离线 transport 验证记录 |
| [B2 学生辅导与控制权](docs/tasks/B2_STUDENT_HELP.md) | 显式 help 接纳、真实 ObjectRef/上下文、动态预算与当前性守卫、B1 执行，以及 C3 Message/Action/Delivery/Receipt 服务端合成联调；实际 UI/真人仍未验收 |
| [学生前端导入与 C 场景入口](docs/tasks/I0_UI_01_IMPORT_C_ENTRY.md) | 设计仓库固定提交导入 `apps/student/`、准备模式 fixture、窄读取客户端与最小浏览器检查；I0 学生纵向切片的第一张任务 |
| [学生确认保存与不可变快照](docs/tasks/I0_UI_03_CONFIRM_SNAPSHOT.md) | 学生主动创建 Attempt、原命令持久化与重放、原子确认和快照回取；准备范围验证及真实服务交接限制 |
| [断线与原保存请求恢复](docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md) | 断线继续编辑、刷新保留草稿、重连只核或重放原保存命令；未知/拒绝/版本冲突/旧代际的分流与准备范围验证 |
| [文件实例回收恢复与只读版本比较](docs/tasks/I0_UI_05_FILE_HISTORY.md) | 回收/恢复文件实例（同名重建是新实例、恢复路径被占用先显式处理占用者）、两快照或草稿与确认作品的只读比较；准备范围验证及真实服务交接限制 |
| [固定快照 Core 运行与基础结果](docs/tasks/I0_UI_06_RUN_RESULTS.md) | 学生主动选择快照与 stats/find/top 参数、持久化原命令、只读公开 Job/Run 与诊断；准备范围验证；停止/未知核对见 06A |
| [运行停止与原请求核对](docs/tasks/I0_UI_06A_RUN_CONTROL.md) | 学生显式停止、等待权威确认，丢回执后原键核对；准备实现与验证，真实停止/恢复交接仍后置 |
| [历史运行比较与公开产物](docs/tasks/I0_UI_06B_RUN_HISTORY.md) | 只读比较已有运行，区分本机参数与缺项、检查裁剪与产物可用性；完整公开文本经来源/ID/hash/bytes 校验后查看和下载；真实交接仍后置 |
| [I0-UI 接入规格](docs/tasks/I0_UI_SPEC.md) | 学生前端接入主仓库的用户行为、实现决策、测试边界与不做事项；十张任务的依赖索引在[准备记录](docs/tasks/I0_UI_PREPARATION.md) |
| [I0-UI 准备批次收尾与真实接入交接](docs/tasks/I0_UI_CLOSEOUT.md) | 十张票准备交付、main 整合/修复与 104 项 Chrome 回归、已合并 PR #50 和 A/C/B 逐能力交接；真实 I0 与完整产品仍未验收 |

安排开发时继续阅读 [TEAM_WORK_PLAN](docs/planning/TEAM_WORK_PLAN.md)：先完成当前 P2 原预交付，P3 的 A/C/B 接数字逻辑并分批联调，同时保留原反馈闭环；P4 的 A6/B4/C5 验证两课程，P5 完成整体集成与正式验收。服务端预交付、数字逻辑 Demo 与完整产品验收分别记录。

上述文档及其仓库内引用可供团队独立查阅，必要的一手资料使用公开链接。原研究的完整归档、旧实验操作手册与原始过程资料不作为正式开发的阅读依赖；历史实现和通过统计不代表当前应用已交付。

## 开发 Agent 边界

开发 Agent 必须遵守 [Agent 权限与项目边界](AGENTS.md#agent-权限与项目边界硬性要求)：`docs/product/` 整体默认只读，包括 MVP_SPEC 的进度记录；规范、共同计划和参考材料同样受保护。执行任务、完成 Issue 或要求“文档优先”不自动授予基线修改权限。边界需要调整时，先提出差异，再由项目负责人明确授权指定维护者修改对应文件。

按 [文档优先规则](AGENTS.md#文档优先硬性要求)，编码前阅读相关规格，方案、差异、进展和验证结果写入 `docs/tasks/<任务编号>_<主题>.md`；影响产品结果或共享契约的提案待确认后实施。需同步产品基线时列出汇总请求，由获授权维护者处理。代码交付必须包含对应任务记录；基线汇总未处理时如实标为待汇总，不越权写入或宣称已同步。

## 开发 skills

项目安装的 27 个技能包保存在 [skills/](skills/)，来源与安装清单见 [W0](docs/tasks/W0_AGENT_SKILLS_INSTALL.md)，Codex 接入与验证见 [W1](docs/tasks/W1_CODEX_SKILLS_CONFIG.md)。Codex 通过 `.agents/skills` 发现本项目技能，该路径链接到 `skills/`，维护时只编辑实体目录。

本机已建立入口。其他工作副本首次接入时，在仓库根目录执行：

```powershell
# Windows：无需复制技能，也无需管理员权限
New-Item -ItemType Directory -Path .agents -Force | Out-Null
New-Item -ItemType Junction -Path .agents\skills -Target (Resolve-Path .\skills).Path
```

```bash
# macOS / Linux
mkdir -p .agents && ln -s ../skills .agents/skills
```

目录联接本身不随 Git 分发，`/.agents/skills/` 已忽略，避免重复纳入技能文件；已有 `.dsh/skills` 入口保留。可在 Codex 输入 `$code-review`、`$diagnosing-bugs` 或 `$tdd` 选择技能；有全局同名技能时按项目路径选择。Codex 会自动发现变更，若选择器没有刷新，重启 Codex，参见 [官方技能文档](https://learn.chatgpt.com/docs/build-skills)。

技能使用遵守 [AGENTS.md](AGENTS.md) 的授权、文档与操作边界。议题、标签和领域文档的 `setup-matt-pocock-skills` 初始化流程属于另一个配置范围，本次仅接入技能发现。

## 文档验证

### A0 评审材料引用检查

A0 评审材料可使用 [只读检查脚本](tools/a0-review/check.mjs) 验证。需要本机已有 Node.js，不安装依赖：

```powershell
node tools/a0-review/check.mjs
node --test tools/a0-review/check.test.mjs
```

第一条检查项目文档的行内文件/目录引用、A0 既有编号/矩阵/JSON/映射与接口覆盖，兼容 G0 采纳后的 27 条变更接口；第二条检查路径、合法目录导航/错误目录锚点、旧提案兼容、必需接口缺失和未知接口反例，均只在内存构造。失败返回退出码 1。静态通过不校验业务/权限/状态语义、真实模型或执行隔离，不创建数据库或启动应用；skills 内示例不作为产品文档验收入口，正式应用仍未实现。

### B1 Agent 核心

B1 核心已接入共享锁定的 Zod、AI SDK 和 DeepSeek provider。在 Node.js 24.21.0 与 `apps/teaching` 已按锁文件安装依赖的环境中，可单独执行：

```powershell
cd apps/teaching
npm run typecheck
node --test server/tutoring/test/*.test.ts
```

领域测试同时通过实际 SDK/provider 和受控内存 transport，供应商网络调用为 0；它不代替待 D-02、凭据与付费授权后的真实 DeepSeek 验证。完整记录见 [B1 任务文档](docs/tasks/B1_AGENT_CORE.md)。

### B2 学生辅导服务端批次

B2 当前可独立交付的学生辅导服务端批次可执行：

```powershell
cd apps/teaching
node --test server/tutoring/test/student-help.test.ts
```

该批次验证显式求助同事务接纳、精确 ObjectRef/资料与状态过滤、无历史降级、跨 worker 三次调用台账、替换/停止/版本守卫，以及 B1 教学 body 经 C3 Message/TeachingAction/Delivery/Receipt 的持久接纳与补取。测试只使用合成账号、数据和 provider；真实模型网络调用、实际浏览器显示、真人接棒与教学语义仍未验收，详见 [B2 任务文档](docs/tasks/B2_STUDENT_HELP.md)。

### P2 真实模型接口核验（显式授权后）

2026-10-12，已准备教师候选/明确采用/局部 PATCH 与学生获准求助/原文/未展示取消的验证入口，默认跳过。账号/API、条款/数据范围、额度及付费合成请求必须先按 D-02 落实；代码准备和内存重放不等于真实模型通过，具体边界见 [G2 第 17 节](docs/tasks/G2_OVERALL_COORDINATION.md#17-p2-真实模型接口验证准备2026-10-12)。

2026-10-12，验证入口已按负责人授权公开至 [Draft PR #36](https://github.com/paher-din/XunJie/pull/36)，尚未合并；仅合成材料的限定实际调用已获条件许可，安全凭据入口和账号条件仍待落实，真实调用未执行，见 [G2 第 17.4 节](docs/tasks/G2_OVERALL_COORDINATION.md#174-验证入口发布与条件调用授权)。

2026-10-12，验证入口已随 PR #36 合入 main；负责人暂缓账号和真实调用，当前不执行下列命令。B 的进入条件、实际结果和人工语义补验集中在 [#45](https://github.com/paher-din/XunJie/issues/45)，恢复实际调用须按原条件落实，工程审查收口不代替模型验收。

下列命令仅供已获上述授权、批准安全通道已提供本机凭据、Node 24.21.0/精确 lock 就绪的环境执行；在仓库根进入应用目录后串行运行，最多三个 Job/九次模型请求，失败不自动重跑，不写凭据或预算金额。

```powershell
cd apps/teaching
# DEEPSEEK_API_KEY 必须已由批准的安全通道提供；不要将值写入此文件或日志。
$env:XUNJIE_P2_REAL_MODEL = 'approved-synthetic'
try {
    node --test --test-name-pattern='P2 real-model' tests/design-agent.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Teacher model validation failed; inspect its evidence before retrying.' }
    node --test --test-name-pattern='P2 real-model' server/tutoring/test/student-help.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Student model validation failed; inspect its evidence before retrying.' }
} finally {
    Remove-Item Env:XUNJIE_P2_REAL_MODEL
}
```

### A4 有效学习状态与纠正事务

2026-10-12，负责人已批准 A4 的 fresh-only 31 表和公共验证范围。以下命令从仓库根目录执行，进入 `apps/teaching` 后使用 Node 24.21.0 与锁定依赖；验证创建并保留合成库，不迁移已有库，真实模型/执行节点开关保持关闭，详见 [A4 记录](docs/tasks/A4_LEARNER_STATE_REVIEW.md#83-当前实现与工程验证2026-10-12)。

2026-10-13，当前源码已纳入 C4，以下同一验证入口现按负责人批准创建并保留精确33表合成库（原31表加两张C4表），在初始化前核完整表集合；旧31表批次记录保留。范围与实际组合结果见 [A4 §14](docs/tasks/A4_LEARNER_STATE_REVIEW.md#14-c4-合并后-33-表集成2026-10-13)，不迁移既有库、不修改凭据/CI/UI，真实节点与模型仍不启用。

```powershell
cd apps/teaching
node --test tests/review.test.ts
npm run typecheck
npm test
```


### 学生前端（apps/student）

2026-10-13，学生前端使用独立 lockfile，在 apps/student 目录以 Node 24 执行准备检查；不依赖 Design checkout。准备模式使用隔离合成数据，正常模式不回退。来源、完整启动说明、端口与故障回放见 [学生 README](apps/student/README.md) 和 [IMPORT_SOURCE](apps/student/IMPORT_SOURCE.md)。

```bash
npm ci
npm run dev:prep
npm run dev
npm run typecheck
npm test
npm run build
npm run test:e2e
# 已安装真实 Chrome 时使用同一套浏览器检查
XUNJIE_E2E_BROWSER_CHANNEL=chrome npm run test:e2e
```

## 阶段状态记录

### G0 基线批准、门禁与任务发布

三份产品文档已于 2026-10-09 更新为 v0.3：项目负责人统一批准 G0 的教学/模型/数据/技术契约和分段实施方案，并明确授权同步五份基线。裁决角色为负责人，A0/B0/C0 PR 作为输入，不记录三人逐一签字；正式应用与业务验收仍未完成。

G0 准备门禁已完成，五份基线及任务记录已直接推送 main，[G0 #1](https://github.com/paher-din/XunJie/issues/1) 已关闭为 Completed。实际模型、执行隔离/备份恢复、浏览器与真人验收未执行，G1～G4 尚未完成。

G0 任务已发布到 GitHub：[总 Issue #1](https://github.com/paher-din/XunJie/issues/1) 跟踪共同决策、跨模块会审和实施门禁；A0/B0/C0 执行 Issue 的链接与正文见上方任务跟踪文档。Issue 已建立不代表契约交付、范围冻结或业务验收通过。

A0/B0/C0 的材料已通过 PR #5/#8/#6 合入并纳入统一裁决。2026-10-09 按负责人“合并现有工作区并关闭所有 Issue”的指令，主工作副本已合并/更新 main，skills/接入记录和授权教材入库，现有 #1～#4 全部关闭；原任务稿/规划中的 Open 保留其当时范围，以 [W2 集成记录](docs/tasks/W2_WORKSPACE_MAIN_INTEGRATION.md) 的较新关闭事实为准，不表示新增个人签认或产品验收通过。

当前准备门禁与后置条件见 [G0 统筹记录](docs/planning/TEAM_WORK_PLAN.md#41-整体-g0-统筹与冻结记录)。A1-P1、B1 合成核心、C2 首批可按批准进入条件建立任务并推进；真实数据库、凭据/付费/数据、C1 节点/隔离、最后 UI/真人链仍按各自授权和验收门禁落实，本工作项不开始应用编码。

### G1 进入阶段与总协调

2026-10-09，项目负责人明确进入 G1，并指定整体 G1 总协调工作项。依赖、阻塞与证据集中记录在 [G1 总协调任务](docs/tasks/G1_OVERALL_COORDINATION.md)，A/B/C 仍按既定分工交付，A 保留集成协调职责。已按负责人指令建立 [G1 总 Issue #9](https://github.com/paher-din/XunJie/issues/9)、[A1 #10](https://github.com/paher-din/XunJie/issues/10)、[A2 #13](https://github.com/paher-din/XunJie/issues/13)、[B1 #11](https://github.com/paher-din/XunJie/issues/11)、[C1 #12](https://github.com/paher-din/XunJie/issues/12)、[C2 #14](https://github.com/paher-din/XunJie/issues/14)，正文/依赖已回读，均 Open。当前完成协调记录与任务发布，服务端作品链和完整 G1 验收未执行；实际 UI 仍在最终阶段接入。

### C1 专用隔离执行与可信检查

C1 已在本机 WSL2 内的专用 QEMU/KVM Ubuntu VM 交付 [runner](apps/teaching/runner/) 和 [节点契约](apps/teaching/contracts/runner/index.ts)：固定内容 ID、快照、受限编译/运行、原 ID/代际/两槽、持久取消/未知保槽/进程恢复、可信 Core/Report 与不可变产物均有实际合成验收。审查修复后 guest 48 项通过，宿主受认证控制链 10 项通过，strict 类型检查通过；应用入口实际 ready=true，整台 VM 重启后的原结果/代际保留有前次原始证明；本次新源码/指纹的 ready 已重新验收。guest 内跳过的 SSH 入口由宿主完整执行，不计为通过。top N 按已确认 C int 范围（1～2,147,483,647）；validator 为 v2。准备/启动/复验、历史/新指纹和下游责任见 [C1 第 14 节](docs/tasks/C1_ISOLATED_RUNNER.md#14-2026-10-10-收口方案批准与执行)。

在获准且已准备的 Linux 宿主维护环境，从仓库根执行 `sh apps/teaching/runner/vm.sh start`，再按任务稿同步源码并运行 `/opt/xunjie-runner/node/bin/node apps/teaching/runner/acceptance.ts`；它包含合成故障注入/Engine 恢复/测试代际注册，仅用于无真实业务作业的维护窗口。停止 VM 用 `sh apps/teaching/runner/vm.sh stop`，不删除持久盘/密钥/账本；未准备的开发副本不能假定本机节点、权限或私钥已存在。学生仍只操作团队 Web UI。

### C2 工作区、快照与基础作业

C1 完成节点实现与独立验收；C2 已完成 [workspace](apps/teaching/server/workspace/) 与 [records](apps/teaching/server/records/) 的完整服务端接入。createWorkspaceApp 组合 A 的真实登录/资源授权/同事务记录与固定活动分配，createWorkspaceDatabase 只新建准确获准的二十二表临时合成库，文件/快照/双键/Job/必要过程全部提交后才 ACK。运行、未知原 ID 对账、暂停/取消、限定帮助和只读产物已经过真实 A1/A2/C1 作品链验证。业务备份、浏览器、负载和真人仍按对应任务验收；进度待授权维护者汇总。完整 C2 已通过 [PR #20](https://github.com/paher-din/XunJie/pull/20) 提交审查，尚未合并/关闭 #14，不计完整应用/G1 或教学效果。

在已批准 Node 24.21.0 工具环境、apps/teaching 目录验证；WSL 请把源码和精确 lock 依赖放在 Linux 文件系统，Windows 挂载目录的模块启动开销曾触发既有子进程时限，原生目录保持原检查全部通过：

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm test
# 无真实业务作业的获准合成环境；JSON 仅 endpoint 与原 application key/known_hosts 路径
XUNJIE_C2_RUNTIME=1 XUNJIE_C2_SSH_CONFIG='<C 维护方提供的 SSH 配置 JSON>' \
  node --test --test-concurrency=1 server/records/*.test.ts server/workspace/*.test.ts
```

不设置 XUNJIE_C2_RUNTIME 时，专用节点对接明确跳过。PR #20 审阅四项修复后，最新 C2 **32/32 通过、0 跳过**（两项真实 C1）；全工程 typecheck/build 通过，原 npm test 复跑 **177 通过、0 失败、5 节点专项跳过（182 项）**。首轮两项 A2 认证失败及只读监测到约 18.7 秒 WSL 墙钟回拨均有原始记录，时钟异常尚未修复；没有改变会话规则、并发或时限来取得通过。当前修复/源码清单/原始输出见 [C2 第 13 节](docs/tasks/C2_WORKSPACE_JOBS.md#13-2026-10-11-pr-20-审阅修复)，原交付见 [第 11 节](docs/tasks/C2_WORKSPACE_JOBS.md#11-完整-c2-服务端交付与实际验收)。A3 组装该工厂并消费原 jobs，B2 读取受控快照/诊断与限定帮助状态，C3/C4 复用过程/覆盖和不可变作品；这些后继业务与实际 UI 分别验收。

### A1 资源权限与 C2 事务接缝（服务端验证已收口）

[A1 记录](docs/tasks/A1_FOUNDATION_ACCESS_TRANSACTION.md#13-已批准收尾批次实施记录进行中尚未-pr) 中的 createAccessApp 注册真实登录/退出与当前 Session 读取；withAuthorizedResource 使用当前 Session、课程成员和同 tx 可信资源定位器，提供用途/学生归属守卫。A 的 server/db/records-adapter 消费 C 已交公共类型/函数，把 Attempt/Job/Receipt/Event 与授权活跃时间同事务保存。C2 文件/别名/执行整链不因此已验收。

准确批准的 createCompletionDatabase 仅新建系统临时 xunjie-a12-completion-*/synthetic.sqlite，共十七张应用表；旧五表/十表工厂保留范围，不迁移或清理现有库。应用调用方显式提供获准 HTTPS Origin、即时签名材料、实际 DB 和领域路由；不配置真实账号/密钥或替代 UI。默认 main 仍健康入口，ready=503。使用批准 Node 在 apps/teaching 执行 node --test tests/records-adapter.test.ts；全工程 npm run typecheck / npm test 仍必须通过后交付。A1 独立分支已吸收 C1/C2 新提交；完整类型检查（含 runner）、build 与本分支统一回归通过：117 项中 112 通过、0 失败、5 项 Linux/真实节点检查跳过。早期联合 A1/A2 的 144/149 为历史范围，见任务稿。两轴审查的幂等/记录范围问题已修正并增量复核关闭；PAHER 已另行完成 A2 指定真实 C1 联调 1/1，记录随 A2 交付；本 A1 分支独立结果不改写。准确批准范围已通过 [A1 PR #18](https://github.com/paher-din/XunJie/pull/18) 交付并合入 main（上游 C1 #16、C2 #17 已先行合并），完整 G1/浏览器/TLS/真实账号保持后置。

### A2 固定活动、分配与控制（服务端验证已收口）

[完整服务端批次记录](docs/tasks/A2_TEACHER_DESIGN_VERSIONS.md#12-已批准完整服务端批次实际记录待真实-c1-联调与最终审查) 对应 server/design/application.ts 的 createDesignApp。调用方显式提供 A1 的 db/origin/signingSecret、受信 currentGeneration 和 C RunnerTransport；教师政策/检查规则配置使用工厂的当前教师授权方法。公共 GET 覆盖蓝图/预览/资料/活动/分配；release/assignment/control 和资源/manual/copy/PATCH/checks 复用 C 公共记录与同一 SQL 事务。没有业务监听或账号/密钥自动初始化，默认 main 仍 ready=503。

在已批准 Node 24.21.0 工具环境，apps/teaching 目录执行 npm ci、npm run typecheck、npm test；npm ci 仅安装精确 lock 依赖，不准备 C 节点。统一测试包含 A/B/C 领域，Linux/受认证节点专属用例遵守原门禁。独立 A2 批次可从仓库根执行 node --test apps/teaching/tests/design-activities.test.ts，只用保留的十七表新临时合成库，不运行真实 SSH/模型/容器。这里的 ready 是明确的测试替身，不能计为真实 C1 开放；真实节点连接/验证交接见任务稿 §12.2。

A2 当前联合类型检查/build 与统一回归通过：157 项中 151 通过、0 失败、6 跳过。8 个新增合成业务用例通过，PAHER 对源码 8421157 的真实受认证 C1 正向用例已另行执行 1 通过、0 失败、0 跳过；原本机六项跳过保留事实。该用例通过 XUNJIE_A2_RUNTIME/XUNJIE_A2_SSH_CONFIG 显式启用，只使用 C 提供的受控配置，具体单用例命令见任务稿 §12.2。独立两轴审查已完成，幂等重放 P2 已修复并增量复核关闭，两轴未解决 0；本次真实就绪开放联调已补齐，原字节证据/指纹核验见任务稿 §12.6；已通过 [A2 PR #19](https://github.com/paher-din/XunJie/pull/19) 交付并合入 main（上游 A1 #18 已先行合并）。仅批准服务端范围收口，完整 C2/G1、浏览器/TLS/真人未验收。

2026-10-10，按项目负责人明确授权，C1 #16 → C2 #17 → A1 #18 → A2 #19 已依次合并到 main，源分支/原历史保留。最终合并代码树与已验证 A2 候选完全一致；五条旧审查已复核关闭，实际验证与合并 SHA 见 [合并记录](docs/tasks/A1_A2_PR_MERGE.md)。此状态不替代完整 C2/G1、浏览器/TLS/真人验收。

A2 PR #19 合并后的 checks/release 慢节点回执问题已由 [PR #21](https://github.com/paher-din/XunJie/pull/21) 修复并合入 e401aac，原两条意见已解决；原针对性23/24、Windows完整161/167（6原条件跳过）及边界保留，作者交付时点记录见 [A2 §13](docs/tasks/A2_TEACHER_DESIGN_VERSIONS.md#13-pr-19-合并后慢节点重放修复)。C2 #20 后续合入 2cfb61a，新组合同时保留 A2 回执优先和 C2 原 ACK/双键/原子保存。

2026-10-11 总体核对：合并组合的 Node24.21.0/TypeScript7.0.2 typecheck/build、C2专项30通过/2节点项跳过、稳定 Windows A2/records/B1 59通过/1节点项跳过；作者 C1 48guest/10SSH、A2实际节点1/1、C2最终节点组合32/32的入库证据摘要核对一致，各自范围单列。Linux完整192项两轮仍有认证/限流/双进程失败且观测到约18.7秒墙钟跳变，未宣称全量通过或改变守卫，正式试点前在#23补验。该段 B1 数字是合并时点记录；后续 `codex/b1-sdk-adapter` 已实现实际 AI SDK/DeepSeek/Zod invoker、保守 16K 输入上界及零供应商网络 transport 测试，真实模型与语义仍未完成，不用离线结果冒充模型调用。

### A3 教师 Agent 与提案（合成服务端）

[A3 任务记录](docs/tasks/A3_TEACHER_AGENT_PROPOSALS.md) 对应 Issue #25。业务宿主可在 createDesignApp / createWorkspaceApp 的选项中显式传入 teacherAgent={provider, versions, budgetAvailable}；模型调用在短事务外，宿主驱动返回的 teacherAgent.processJob(jobId)。候选/蓝图生成只返回异步 Job，教师通过 design-proposals 查询/选择创建草稿；局部提案及量规试评的明确修改走现有 PATCH/CAS。默认 npm start 仍是健康入口。

负责人已批准独立 createTeacherDesignDatabase，仅新建保留的临时合成库，共 24 表（原 workspace 22 表＋教师请求/提案两表），不迁移已有库。使用批准 Node 24.21.0，在 apps/teaching 执行 node --test tests/design-agent.test.ts；合成 provider 是唯一外部替身，登录、CSRF、数据库、Job、回执与事务均真实。接入字段、私有资料/旧版本/取消/预算边界、原结果保存失败后安全重试见任务记录 §2、§5。

首批验证时点记录：获准合成服务端已实现，A3 专项20/20通过、typecheck/build通过，两轴审查未解决0。Windows完整201项为193通过、1既有C2 Linux-only用例失败、7原条件跳过，全套未通过；原字节证据/失败复现及边界见任务记录第6节。B1 真实 invoker/token counter、D-02、真实模型联调、教师内容会审与最终浏览器/TLS 未执行，不能据此宣称完整 A3/G2/MVP 通过。

2026-10-11，PR #28 外部审查指出两项调用记账问题，修复与复现记录见 [A3 §9](docs/tasks/A3_TEACHER_AGENT_PROPOSALS.md#9-pr-28-外部审查修复2026-10-11)：超时/停止后保存原调用实际 usage，InputLimitError 明确未发送时安全释放末尾预留。正文接收与采用守卫继续生效，其他未知调用保守占用。新增5项合成验证，A3专项25/25、typecheck/build通过；Windows完整206项：198通过、1既有C2平台失败、7原条件跳过，全套未通过。原始证据和复核结果见任务记录 §9，原 §6 统计保留历史事实。

PR #29 合并后，A3 已同步最新 main 并适配新的16K预检机制；[A3 §10](docs/tasks/A3_TEACHER_AGENT_PROPOSALS.md#10-已合并-b1-新预检接缝适配2026-10-11)保留旧接口组合失败反例及修复说明。组合typecheck/build通过、A3专项25/25；完整217项：209通过、1既有C2平台失败、7原条件跳过，全套未通过。B1 SDK适配源码已接入，真实供应商网络调用及教师/UI验收仍未执行。

2026-10-12，整体复验确认上文的 Workspace 加 teacherAgent 组合目前无法构造，会因重复 Job/cancel 路由报错；独立 Design 工厂验证不受该组合问题影响。A 需统一公共路由后复验，当前失败事实及学生正文接缝问题见 [G2 第 14 节](docs/tasks/G2_OVERALL_COORDINATION.md#14-2026-10-12-p2-整体复验与-issue-关闭核对)，不将该组合说明视为已可用。

2026-10-12，本地修复候选由 Workspace 唯一公共 Job 路由按持久 purpose 调用原教师/学生处理器，独立 Design 默认路由保留；教师/学生权限、取消、重放和重启回归通过。C3 长未知文字保存与原结果重放亦已验证，公开交付仍待发布确认，见 [G2 第 15 节](docs/tasks/G2_OVERALL_COORDINATION.md#15-2026-10-12-g2-r01r02-最小修复)。

2026-10-12，B1/B2 未验条件已逐项保留在 [#45](https://github.com/paher-din/XunJie/issues/45)，工程审查收口与旧卡关闭按负责人决定执行；合成/离线、真实模型、人工语义和浏览器/真人分别计账，具体交接与实际结果见 [G2 第 18 节](docs/tasks/G2_OVERALL_COORDINATION.md#18-2026-10-12-p2-工程审查收口与-b-后续交付)。

2026-10-12，PR #36 已合入，本次 P2 工程审查及 #24 已收口；B1/B2 已交工程批次关闭，全部 B 侧未验项继续在 #45，B 完成后由负责人通知复审。完整 G2、教师/UI/真人、NFR 与环境失败分别保留原账目，最终交付和核对见 [G2 第 18.4 节](docs/tasks/G2_OVERALL_COORDINATION.md#184-已完成收口与最终交付)。

### G3 / P3 启动与总协调

2026-10-12，P3 总协调已启动，当前只建立任务/依赖/评审与验收跟踪；数字逻辑 Demo、原服务端反馈闭环与完整 G3 均未验收。P2 的 #11/#26/#24 保持 Open，原 #22/#23/#30 继续各自范围；具体证据、放行条件、模块交接与待授权维护者汇总事项见 [G3 总协调记录](docs/tasks/G3_OVERALL_COORDINATION.md)。

2026-10-12，P3 总协调 #37 与七个 A/B/C 执行 Issue #38～44 已发布并核对，任务/依赖和分层关闭条件见各正文；UI 分批接入与 DL-E2E 由总任务跟踪既定责任。原 P2/模型/UI/环境 Issue 未修改或关闭，发布不算应用验收；详细记录见 [G3 第 8 节](docs/tasks/G3_OVERALL_COORDINATION.md#8-2026-10-12-p3-总子-issue-发布)。

### A4 有效学习状态与教师纠正

2026-10-12，A 已基于最新 main 建立 [DL-A](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md) 的能力差异/共享输入提案，再按等待 DL 批次可推进独立 A4 的顺序建立 [A4 实施方案](docs/tasks/A4_LEARNER_STATE_REVIEW.md)。DL 正式评审仍等待 P2 原预交付确认和 C/B/UI 消费输入；A4 的五表 fresh-only 合成库、受控接口与公共验证接缝待批准。两项源码/业务验收均未执行，#38/#41 保持 Open，进度待授权维护者汇总。

2026-10-12，负责人已批准 DL-A 提前评审准备和 A4 §2～6 的具体实施；A4 公共专项 40/40、typecheck/build 通过，Windows 全量 304 项为 293 通过、2 失败、9 跳过，原启动测试单独复跑 4/4。实现/交接与真实失败、未执行项见 [A4](docs/tasks/A4_LEARNER_STATE_REVIEW.md#83-当前实现与工程验证2026-10-12)；[DL-A](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md#73-最新工程收口与早期评审准备2026-10-12) 的 A 域输入已准备，仍缺 C/B/UI 提案及精确实施授权。代码审查尚待完成，#38/#41 未关闭，产品基线待授权维护者汇总。

2026-10-13，A4 获准服务端批次已完成代码与两轴审查，专项 43/43、typecheck/build 通过；固定源码全量 307 项为 297 通过、1 个既有 Windows/Linux RunControl 环境失败、9 跳过，历史失败保留。验收记录、原日志摘要、消费接缝与后置项见 [A4 最终记录](docs/tasks/A4_LEARNER_STATE_REVIEW.md#11-最终固定源码验收证据与交付边界2026-10-13)；[DL-A](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md#74-2026-10-13-远端复核与本批交接) 的 A 域提前评审准备已交，仍缺 C/B/UI 具体契约和实施授权。远端新增 PR #46/#47 尚未合入本源码，#38/#41 未关闭，基线待授权维护者汇总。

2026-10-13，负责人批准公开推送与创建 A4 PR，已交付 [PR #49](https://github.com/paher-din/XunJie/pull/49)；创建时无合并冲突，#38/#41 保留 Open。公开交付不改变上述验收结果或 DL-A 待决条件，实际发布记录见 [A4 §11.4](docs/tasks/A4_LEARNER_STATE_REVIEW.md#114-负责人批准的公开交付2026-10-13)。

2026-10-13，A4 PR #49 新审查修复已实现，含真实版本读取、31表初始化范围守卫、证据勘误和原停止原因保全；局部反例/typecheck通过，本轮完整回归和两轴审查待执行，详情见 [A4修复记录](docs/tasks/A4_LEARNER_STATE_REVIEW.md#12-pr-49-新审查意见修复2026-10-13)。C试合并复核及审计归因待裁决项分别登记，不宣称实际联合验收已完成。

2026-10-13，A4 PR #49 本轮修复专项51/51、typecheck/build通过；默认全量315项为304通过/2失败/9跳过，SDK单独11/11，串行同全集305通过/1个既有Windows/Linux环境失败/9跳过，历史失败完整保留。实现、两轴0项、原日志勘误与审计归因待裁决见[A4修复最终记录](docs/tasks/A4_LEARNER_STATE_REVIEW.md#13-pr-49-修复最终结果2026-10-13)；C4联合范围授权、实际合并后复确认与B消费验收继续单列。

2026-10-13，C4 已先行合入 main，负责人批准的 A4 合成库精确33表守卫及公共工厂断言已实施；更新主线后的 A4/C4/C3 组合81项为80通过、0失败、1环境跳过，typecheck/build通过。旧31表证据保留，实际远程合并结果及两轴审查见 [顺序集成记录](docs/tasks/ORDERED_C4_A4_DL_C_INTEGRATION.md)；B消费、审计归因裁决及正式产品后置项仍分别跟踪。

### C4 固定提交、学生修订与闭环恢复

2026-10-12，C4 已在分支 `codex/c4-submissions-recovery` 交付 [#43](https://github.com/paher-din/XunJie/issues/43) 的服务端实现：学生固定提交、教师复核阶段推进、重开许可与学生本人主动 `resume_revision`、以及闭环恢复读取。契约、领域计划、存储、命令与只读投影全部落在 C 属的 [contracts/workspace](apps/teaching/contracts/workspace/) 与 [server/workspace](apps/teaching/server/workspace/)，A 属与 B 属文件零改动。新增的 `workspace_submissions` 与 `workspace_reopen_grants` 两张表写进 C 属 `workspaceSchema` 字符串，延续 C2/C3 已批准的做法，只新建临时合成库，不迁移既有库，也不做真实数据库建表或备份操作。交 A5 的接缝是 `transitionAttemptInTransaction`、`planReopenGrant`/`writeReopenGrant` 与恢复读取中的反馈接缝；C4 不为教师复核与重开发放发布替代产品路由，正式反馈仍归 A5。

在已批准 Node 24.21.0 工具环境、`apps/teaching` 目录执行，只用临时合成库，不连接真实执行节点、真实模型或真实账号：

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm test
node --test server/workspace/submissions.test.ts
```

2026-10-12，验证结果为服务端确定性验证通过、其余分层未执行。C4 专项 10/10 通过；全工程 typecheck 与 build 通过；完整套件 274 项中 264 通过、1 失败、9 跳过，同一命令在基线 37849f4 的独立工作树实测 264 项中 254 通过、1 失败、9 跳过，即净增 10 项测试与 10 项通过，失败数与跳过数不变。唯一失败项在两侧完全相同，是 `review.test.ts` 经 `control.ts` 要求 Linux 的既有平台失败，C4 未修改这两个文件；9 项跳过全部来自既有的平台与环境门，C4 新增测试文件不含任何跳过。真实浏览器与 UI 接入、真人教师与学生、真实模型语义、真实执行节点掉线与迟到结果对账、完整备份恢复与实际 RPO/RTO、真实数据库建表迁移与生产部署均未执行；A4/A5 实际路由接入后的联合验证同样未执行，本任务只用测试支撑中模拟 A5 的教师路由验证接缝形状。任务稿第 6 节的四项解释与跨属提案仍待负责人确认，未获确认前不是已批准契约。实际代码位置、命令、原始结果、验证中修正的两处缺陷与未执行清单见 [C4 第 8 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#8-实现记录)。

2026-10-12，C4 已按普通推送交付分支 `codex/c4-submissions-recovery`（`7063fd2`）并建立 [PR #47](https://github.com/paher-din/XunJie/pull/47)，尚未合并，[#43](https://github.com/paher-din/XunJie/issues/43) 保持 Open。合并由负责人执行，本任务不代签、不自行合并，也不把 PR 建立当作应用验收。

2026-10-12，项目负责人批准上文请其复核的合成库 schema 追加与任务稿第 6 节的四项解释与跨属提案，据此收口：两张表保留在 C 属 `workspaceSchema`，A 属 `server/db/transaction.ts` 零改动，合成库表数断言 24 为已批准事实；提交只取消教学类用途，不取消在途 `student_run`，已发生的执行事实与原始引用保留；短反思与可信检查引用不强制，只校验形状、边界与引用匹配，缺省不视为违规；`resume_revision` 保持 `read` 用途授权加 C 属阶段、分配与许可守卫，A 属权限文件不增列用途；`transitionAttemptInTransaction`、`planReopenGrant` 与 `writeReopenGrant` 的现有签名即为交 A5 的契约形状。批准不改动任何代码，不改变上文任何未执行项与通过统计，也不构成对 A 属新增活动版本字段或新增权限用途的授权，那两部分仍只是提案，需负责人另行明确文件与范围才能实施。产品基线汇总待授权维护者处理，逐项落地含义见 [C4 第 6 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#6-待确认的解释项与跨属提案)。

2026-10-12，负责人授权后基线汇总已完成：PRD 与 MVP_SPEC 经核对无需改动，只在 TECH_DESIGN 三处既有行与既有段内追加上述三条读法，未改名标题、未增删路由、未放宽验收门槛，`node tools/a0-review/check.mjs` 退出码 0 且 `baselineMutationRoutes` 与 `internalLinks` 计数与改动前一致。AC-06/08/09/12 的判据未变，因此无需同步任何验收条目；上文全部未执行项与通过统计不受影响。逐处位置与授权范围见 [C4 第 6 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#6-待确认的解释项与跨属提案)。

2026-10-12 审查修订，上一段关于文档检查计数的记录有一半说反了，原文保留不倒写。`internalLinks` 并非与改动前一致：逐提交实测为 `37849f4` 551、`13172cb` 578、`e14d2ee` 585、`f600c99` 585，`documents` 由 37 变为 38，也就是该计数在写下那句话的 `e14d2ee` 自身就从 578 变为 585。成立的一半是 `baselineMutationRoutes` 全程 27、`errors` 全程为空数组、`additionalProposedRoutes` 全程为空、已批准路由集合未变，所以没有任何检查真的被破坏，问题纯在记录，而这恰好是一条关于受保护文档写入的验证结论。四个数字由本任务在一棵不装依赖的临时工作树上逐提交实跑得到，与负责人审查给出的表逐项一致。此后凡声称某个计数「与改动前一致」，改动前后两侧都必须实测。逐提交表、错误归因的更正与教训见 [C4 第 6 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#6-待确认的解释项与跨属提案)。

2026-10-13，负责人授权后审查 P3-1 的授权疑问关闭：从 TECH_DESIGN 第 7.2.1 节该句删去「提交」在授权范围内，不回退。同一次授权把「分配暂停使已发放的重开许可失效、恢复分配不使其复活」写入产品基线，落在第 5 节 `POST /api/attempts/:id/reopen` 一行，同行一并记入发放许可递增 `attemptRevision` 与 `decisionEpoch`、许可行保持 `valid` 不被静默消费、恢复读取以 `actionable=false` 让学生界面区分「从未发放」与「发放过但已作废」。改动在既有表格行内追加文字，原分句逐字保留，未改名标题、未增删路由、未放宽验收门槛，PRD 与 MVP_SPEC 经核对仍无需改动。与 #48 的表数撞点实测数据、先合 #47 再合 #48 的顺序建议，以及本任务未改 #48 分支的理由，见 [C4 第 5 节](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md#5-与-a4a5b3c5-的分批交接)。

2026-10-13，按负责人要求进入 C4 → A4 → DL-C 顺序审阅与合并。C4 本轮新发现的两项 P2 已修复：暂停期间发放许可的工作区及恢复投影读取真实可用性；请求文档勘误明确 checkRunIds 输入与 checkRefs 输出。类型检查、构建与公开接口专项验证通过（21 项中 20 通过、0 失败、1 跳过），两轴增量复审各 0 项；完整源码回归及远程合并结果在 [顺序集成记录](docs/tasks/ORDERED_C4_A4_DL_C_INTEGRATION.md) 追加。其余产品与浏览器后置验收不变。
### I0-UI 准备批次与真实接入交接

2026-10-13，十张本地 I0-UI ticket 已交付准备工程，07 记录真实 Chrome 手动链及 102 项准备浏览器检查；本批正在整合最新 main 并准备 Draft PR。真实服务、节点、模型、完整 AC/NFR 与教学效果未验收，#30/#22 保持 Open；A/C 按能力交接，B 真实模型/语义余项沿 #45。当前状态、组合验证与交接入口见 [I0-UI 收尾记录](docs/tasks/I0_UI_CLOSEOUT.md)，启动/来源与故障细节见学生 README，规划文档保留其有日期的原快照。

2026-10-13，main 已普通合入 UI 分支，准备批次已推送并发布 [Draft PR #50](https://github.com/paher-din/XunJie/pull/50)，尚未合并。四项审查问题已修复，最终 typecheck/build、Vitest 238 项、真实 Chrome 104 项与文档检查通过；[#30 交接清单](https://github.com/paher-din/XunJie/issues/30#issuecomment-6137496293) 已发布，成员按 H 编号回交，完整验收未覆盖项登记在 [#22 证据索引](https://github.com/paher-din/XunJie/issues/22#issuecomment-6137502504)。真实接线/节点/模型/完整 AC/NFR 与教学效果未验收。

2026-10-13，负责人 Robert 明确批准合并后，[PR #50](https://github.com/paher-din/XunJie/pull/50) 已以 merge commit 合入 main（`69a26d5`），合并树与已验证交付完全一致，UI 分支保留。[#30 协作评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6137712134) 已同步结果；A/C 可更新 main 后在各自任务分支继续按 H 编号回交。#30/#22 保持 Open，真实接入与完整产品验收仍待完成；实际提交与核对见 [I0 收尾 §8.4](docs/tasks/I0_UI_CLOSEOUT.md#84-协作方式与合并确认)。

### 当前整体状态与后置验收

当前 `npm start` 仍只启动健康入口；业务宿主需显式组装 `createWorkspaceApp`/`createDesignApp`、传获准数据库/Origin/签名与 runner 并消费原 jobs。工厂验证只用批准的新临时合成库，不是生产迁移/长期账号/HTTPS/TLS配置。实际 UI 与原 AC/NFR、B2/C3 的辅导/回执/限制仍按#22及TEAM阶段接入；不创建替代界面，也不因#9按服务端阶段关闭而宣称完整G1/MVP/教学效果通过。最新授权、真实状态与未执行项见 [G1收口记录](docs/tasks/G1_OVERALL_COORDINATION.md)。
