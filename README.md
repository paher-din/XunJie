# XunJie

项目制教学 Agent：教师与 Agent 共同设计项目，学生在真实动手、试验与修订中学习，教师依据具体表现改进后续教学。首版是面向高校 CS 课程的独立 Web 应用。

当前仓库保存团队开发所需的产品规格、工作规范和必要参考，正式应用尚未实现。Web UI 由团队成员负责，后台与 Agent 按其实际交付对接。

## 文档

| 文档 | 内容 |
| --- | --- |
| [PRD](docs/product/PRD.md) | 为谁解决什么问题、产品原则、核心流程、成功标准 |
| [MVP_SPEC](docs/product/MVP_SPEC.md) | 第一版做到哪里、业务行为、限额与验收 |
| [TECH_DESIGN](docs/product/TECH_DESIGN.md) | 后台、Agent 与 UI 对接的结构和契约 |
| [三人分工与交付顺序](docs/planning/TEAM_WORK_PLAN.md) | A/B/C 的详细任务、并行与等待关系、交接和验收责任；UI 成员仅在最终接入阶段参与 |
| [A0 业务权限与公共契约评审稿](docs/tasks/A0_BUSINESS_CONTRACT_REVIEW.md) | Issue #2 的权限、状态、逐命令与短事务提案、D-03、验证方案和待会审差异；未成为正式契约 |
| [G0 Issue 跟踪](docs/planning/G0_ISSUES.md) | 已发布的统筹 Issue 与 A0/B0/C0 三个执行 Issue，任务正文、交付和关闭条件 |
| [G0 交付核对与实施门禁](docs/tasks/G0_SCOPE_CONTRACT_GATE_REVIEW.md) | 三项 PR、差异与真实验证，以及负责人统一裁决/准备门禁记录；不代签或计作产品验收 |
| [G0 TextScope 参考与活动适配](docs/tasks/G0_TEXTSCOPE_ACTIVITY_SPEC.md) | 外部候选供追溯，Web 学生空间的 Core/Report 活动提案另列；不照搬本地开发/六阶段/评分要求 |
| [G0 缺口收敛与批准记录](docs/tasks/G0_CLOSURE_PROPOSAL.md) | 已获负责人统一批准的教学/模型/数据/技术/首批进入方案及五份文件授权；正式契约以产品基线为准，未实施应用 |
| [C0 工作区、记录与执行交付稿](docs/tasks/C0_WORKSPACE_RECORDS_RUNNER.md) | 独立任务文档：StudentIDE 参考差异、接口提案、资源/恢复约定和验证方案；待 A/B 会审 |
| [工作空间规范](AGENTS.md) | 已确认决定、协作分工、工程纪律与操作红线 |
| [产品研究依据](docs/reference/PRODUCT_RESEARCH.md) | 影响首版的研究结论、证据边界与公开来源 |
| [工程衔接说明](docs/reference/ENGINEERING_HANDOFF.md) | 可沿用的 IDE/记录/运行/诊断契约与历史试验限制 |
| [B0 模型、帮助与候选分析交接稿](docs/tasks/B0_模型帮助分析契约.md) | 三类输入/输出、可信来源、保存归属、拒绝与取消提案；待 A/C 会审 |
| [B0 模型与预算复核](docs/tasks/B0_MODEL_VENDOR_RESEARCH.md) | 精确型号/区域/结构化方式、数据条款证据状态及预算/配额建议；D-02 待批准 |
| [B0 合成工程样例](docs/tasks/B0_TEACHING_EXAMPLES.md) | E1～E10 的具体输入/时序、确定性与人工判据，补教师/候选实例；业务验收未执行 |

阅读顺序：PRD → MVP_SPEC → TECH_DESIGN。文档间冲突的处理规则见 PRD 1.2。

安排开发时继续阅读 [TEAM_WORK_PLAN](docs/planning/TEAM_WORK_PLAN.md)：三人先按业务契约完成后台、Agent 与执行能力，再在最后接入团队实际 UI。服务端预交付与完整产品验收分别记录，不提前宣称浏览器流程通过。

开发 Agent 必须遵守 [Agent 权限与项目边界](AGENTS.md#agent-权限与项目边界硬性要求)：`docs/product/` 整体默认只读，包括 MVP_SPEC 的进度记录；规范、共同计划和参考材料同样受保护。执行任务、完成 Issue 或要求“文档优先”不自动授予基线修改权限。边界需要调整时，先提出差异，再由项目负责人明确授权指定维护者修改对应文件。

按 [文档优先规则](AGENTS.md#文档优先硬性要求)，编码前阅读相关规格，方案、差异、进展和验证结果写入 `docs/tasks/<任务编号>_<主题>.md`；影响产品结果或共享契约的提案待确认后实施。需同步产品基线时列出汇总请求，由获授权维护者处理。代码交付必须包含对应任务记录；基线汇总未处理时如实标为待汇总，不越权写入或宣称已同步。

## 文档验证

A0 评审材料可使用 [只读检查脚本](tools/a0-review/check.mjs) 验证。需要本机已有 Node.js，不安装依赖：

```powershell
node tools/a0-review/check.mjs
node --test tools/a0-review/check.test.mjs
```

第一条检查行内引用、A0 既有编号/矩阵/JSON/映射与接口覆盖，兼容提案阶段及 G0 采纳后的 27 条变更接口；第二条检查路径边界、旧提案兼容、五条采纳/扩展接口缺失和未知接口反例，均只在内存构造。失败返回退出码 1。静态通过不校验业务/权限/状态语义、真实模型或执行隔离，不创建数据库或启动应用；正式后台版本已批准，实际兼容/验收尚未执行。

## 状态

三份产品文档已于 2026-10-09 更新为 v0.3：项目负责人统一批准 G0 的教学/模型/数据/技术契约和分段实施方案，并明确授权同步五份基线。裁决角色为负责人，A0/B0/C0 PR 作为输入，不记录三人逐一签字；正式应用与业务验收仍未完成。

当前准备门禁与后置条件见 [G0 统筹记录](docs/planning/TEAM_WORK_PLAN.md#41-整体-g0-统筹与冻结记录)。A1-P1、B1 合成核心、C2 首批可按批准进入条件建立任务并推进；真实数据库、凭据/付费/数据、C1 节点/隔离、最后 UI/真人链仍按各自授权和验收门禁落实，本工作项不开始应用编码。

G0 任务已发布到 GitHub：[总 Issue #1](https://github.com/paher-din/XunJie/issues/1) 跟踪共同决策、跨模块会审和实施门禁；A0/B0/C0 执行 Issue 的链接与正文见上方任务跟踪文档。Issue 已建立不代表契约交付、范围冻结或业务验收通过。

A0/B0/C0 的材料已通过 PR #5/#8/#6 合入并纳入统一裁决，子 Issue 的最终作者交接/关闭状态由各自主责维护；原任务稿作为有日期的历史输入，最新正式行为在 TECH。

首发为 C 程序设计/C、函数/数组/指针先备及指定教材；学生只在 Web 工作区完成 TextScope Core（stats/find/top）→教师反馈→Report，不需要本地工具链或终端。后台 Linux/容器归 C，UI 由成员最后交付。DeepSeek/deepseek-flash 配置、合成开发/预置账号/私有试点/90 天复核不自动删除及数据责任已批准；预算金额和投入/交付日期不入文档，教材未公开交付，原外部项目门槛仅作参考。

上述文档及其仓库内引用可供团队独立查阅，必要的一手资料使用公开链接。原研究的完整归档、旧实验操作手册与原始过程资料不作为正式开发的阅读依赖；历史实现和通过统计不代表当前应用已交付。
