# XunJie

面向高校 CS 课程的独立 Web 项目制教学应用：教师与 Agent 共同设计项目，学生动手、试验和修订，教师依据具体表现改进教学。首版面向一位教师与少量学生的个人项目。

## 从这里开始

- **了解产品：** 按 [PRD](docs/product/PRD.md) → [MVP_SPEC](docs/product/MVP_SPEC.md) → [TECH_DESIGN](docs/product/TECH_DESIGN.md) 阅读。首版 C / TextScope Core → Report 与数字逻辑增量的范围、限额及验收以基线和批准任务为准。
- **领取或继续任务：** 先读 [AGENTS.md](AGENTS.md)，再按 [TEAM_WORK_PLAN](docs/planning/TEAM_WORK_PLAN.md) 找对应任务，核对最新负责人决定、进入条件、授权写集和交付状态。
- **运行学生前端：** 使用下方准备入口；正常业务服务的接线条件见 [学生 README](apps/student/README.md)。
- **接收模块交付：** 按下方任务入口与原 Issue 回交证据，区分材料已交、联调通过、失败和未执行。

## 本地运行与验证

学生前端需要 Node 24，使用自己的 lockfile，不依赖 Design 仓库 checkout。以下命令在仓库根开始；`dev:prep` 使用隔离合成数据，不写真实学习记录、不连接执行节点或模型。

```sh
cd apps/student
npm ci
npm run dev:prep
```

正常模式、浏览器端口、真实 Chrome、专项/全量测试及故障回放见 [学生运行说明](apps/student/README.md)；来源、许可与同步边界见 [IMPORT_SOURCE](apps/student/IMPORT_SOURCE.md)。正常请求失败不回退到 fixture。

学生前端的交付检查在 `apps/student` 执行：

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

教学服务使用 Node24.21.0，依赖与命令见 [package.json](apps/teaching/package.json)。默认 npm start 提供健康入口；受控 XUNJIE_I0_CONFIG 启动 C 课程宿主，XUNJIE_APP_CONFIG 启动两课程35表 HDL 宿主。两种模式共用 HTTPS、分配 bootstrap、原 Job 消费和关停，只能选择一种。配置的可选 tutoring 复用既有模型通道，实际调用须有对应预算和数据授权，默认关闭。

正常 I0 就绪检查数据库、原消费者与执行节点，失败保持503。已有启动/账号/配置交接见 [I0-A/C](docs/tasks/I0_A_C_HANDOFF.md)和[正常辅导宿主](docs/tasks/I0-B_HOST_COMPOSITION.md)；数字逻辑固定配置与35表初始化见 [DL-A §16](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md#16-35表去重联合收尾实现与验证)。统一 PR56 的 main 集成、真实 HDL 链路、H4 请求/投递与 UI 回交见[本轮 C 续作](docs/tasks/DLA_CONTINUATION_20261014.md)。服务端、模型、浏览器和真人验收分别记录。

规范或入口文档修改后，从仓库根检查引用与标题锚点：

```sh
node tools/a0-review/check.mjs
```

检查脚本与自身反例见 [tools/a0-review/](tools/a0-review/)；静态通过不代表业务、模型或隔离验收。

## 任务与交接入口

最新事实和有日期的历史保存在任务记录中；表格提供入口，不另维护一套阶段账目。

| 工作 | 入口 |
| --- | --- |
| G0 决定与实施门禁 | [批准记录](docs/tasks/G0_CLOSURE_PROPOSAL.md)、[交付核对](docs/tasks/G0_SCOPE_CONTRACT_GATE_REVIEW.md) |
| G1 作品链、服务端交付与后置验收 | [G1 总协调](docs/tasks/G1_OVERALL_COORDINATION.md)；完整 UI/AC/NFR [#22](https://github.com/paher-din/XunJie/issues/22)、环境稳定性 [#23](https://github.com/paher-din/XunJie/issues/23) |
| P2 工程收口与 B 后续 | [G2 总协调](docs/tasks/G2_OVERALL_COORDINATION.md)、[B/P2-F 交付](docs/tasks/B_P2_MODEL_SEMANTIC_VERIFICATION.md)；模型/语义 [#45](https://github.com/paher-din/XunJie/issues/45)，已用批次的[历史命令](docs/tasks/G2_OVERALL_COORDINATION.md#223-已用模型批次的历史命令保存) |
| P3 数字逻辑与反馈闭环 | [G3 总协调](docs/tasks/G3_OVERALL_COORDINATION.md)、[DL-0](docs/tasks/DL-0_DIGITAL_LOGIC_ADDON.md)、[DL-A](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md)、[DL-B](docs/tasks/DL-B_HDL_TUTORING_CONTEXT.md) |
| P3 最新分工（2026-10-14） | A 当前推进 A5，C 接续 DL-A 剩余部分；职责、交接与同步记录见 [G3 第14节](docs/tasks/G3_OVERALL_COORDINATION.md#14-2026-10-14-a5-与-dl-a-剩余工作转派) |
| P4 截止日前核心验证与后续验收 | [核心验证安排与授权](docs/tasks/P4_DEADLINE_CORE_VERIFICATION.md)；[总协调 #60](https://github.com/paher-din/XunJie/issues/60)、[A6 #61](https://github.com/paher-din/XunJie/issues/61)、[B4 #62](https://github.com/paher-din/XunJie/issues/62)、[C5 #63](https://github.com/paher-din/XunJie/issues/63) |
| C4 → A4 → DL-C 顺序集成 | [集成记录](docs/tasks/ORDERED_C4_A4_DL_C_INTEGRATION.md)、[C4](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md)、[A4](docs/tasks/A4_LEARNER_STATE_REVIEW.md)、[DL-C](docs/tasks/DL-C_HDL_BUILD_SIMULATION.md) |
| 学生 UI 准备交付与真实接入 | [I0 收尾](docs/tasks/I0_UI_CLOSEOUT.md)、[接入规格](docs/tasks/I0_UI_SPEC.md)、[准备票索引](docs/tasks/I0_UI_PREPARATION.md)；H-01～H-06 回交在 [#30](https://github.com/paher-din/XunJie/issues/30) |
| A/C 按 H 编号回交 | [I0-A/C 交接](docs/tasks/I0_A_C_HANDOFF.md)；[HTTPS 与账号入口准备](docs/tasks/I0_HOST_ENTRY_PREPARATION.md)单列 C 准备/现场执行、A 复核及 UI 接收；身份/分配、受信代际、原 Job 与版本/公开样例沿原交接 |
| C 现场 HTTPS 与持久合成库恢复 | [C 当前宿主与交接](docs/tasks/DLA_C_CLOSEOUT_HANDOFF.md#18-2026-10-14-批准执行-pr59-的-paher-定向接入)；历史恢复、新版本就绪、现有对象及启动/停止方式由该任务承载 |
| I0-B 学生辅导接线与宿主组合 | [六票执行与交接](docs/tasks/I0-B_UI_TUTOR_PLAN.md)、[正常宿主](docs/tasks/I0-B_HOST_COMPOSITION.md)、[完整30项清单](docs/tasks/I0_REMAINING_WORK_CHECKLIST.md)；准备、实际 HTTPS 服务链、受控节点/模型与真人证据分开记录 |
| 学生真实登录、会话恢复与退出 | [I0-UI 会话入口](docs/tasks/I0-UI_AUTH_SESSION_ENTRY.md)；UI-REAL-01/02/08，获准深链及同账号草稿恢复，两个合成账号的 HTTPS/SQLite 验证 |
| 学生真实保存、快照与故障恢复 | [I0-UI 保存与恢复](docs/tasks/I0-UI_REAL_SAVE_RECOVERY.md)；UI-REAL-05/06/07/12，受信代际、原文确认、状态/版本限制与隔离服务故障验证 |
| 学生真实运行、停止与历史产物 | [I0-UI 运行接入](docs/tasks/I0-UI_REAL_RUN_CONTROL_HISTORY.md)；UI-REAL-09/10/11，正常宿主就绪门禁、原 Job/Run 核对与公开产物 |
| 编辑器补验与测试耗时优化 | [I0-UI-BV](docs/tasks/I0_UI_BV_EDITOR_BROWSER_VERIFICATION.md)；保留全部 108 项浏览器检查的覆盖/实测对照与交付状态 |
| 仓库入口与规则重写 | [W4](docs/tasks/W4_REPO_ENTRYPOINT_REWRITE.md) |
| 指定 PR 集成 | [54 → 55、59 → 53、55 → 53](docs/tasks/PR_INTEGRATION_54_55_59_53.md)；实际接纳差异、验证与审核交付 |
| DL-A 当前续作 | [main 集成与真实 H4 交接](docs/tasks/DLA_CONTINUATION_20261014.md)；原 #56 统一基础，真实 HDL 与模型/浏览器分层验证 |
| #53 → #56 集成 | [当前集成记录](docs/tasks/PR_INTEGRATION_53_56.md)；来源、共用宿主适配、专项验证与 PR 回交 |
| 其他模块与历史交付 | [全部任务记录](docs/tasks/)；按模块/编号查实现、批准范围、实际命令与原始证据 |

准备浏览器通过、服务端预交付、Issue 关闭与阶段进入分别记账；真实服务/节点/模型、完整 M/AC/NFR、真人与教学效果按原条件验收。产品进度由获授权维护者汇总至 MVP_SPEC §10。

## 开发 skills

项目技能在 [skills/](skills/)，Codex 的 `.agents/skills` 指向该实体目录。首次接入与 Windows/macOS/Linux 命令见 [W1](docs/tasks/W1_CODEX_SKILLS_CONFIG.md)，来源/安装清单见 [W0](docs/tasks/W0_AGENT_SKILLS_INSTALL.md)。已有同名全局技能时按项目路径选择；技能不扩大 [AGENTS.md](AGENTS.md) 的权限。

## 目录与参考

| 目录 | 用途 |
| --- | --- |
| [apps/student/](apps/student/) | 成员交付的学生 Web UI、准备 fixture 与浏览器检查 |
| [apps/teaching/](apps/teaching/) | A/B/C 教学业务、Agent、作品/记录与隔离执行能力 |
| [docs/](docs/) | 产品基线、共同计划、任务记录与参考依据 |
| [course_matrial/](course_matrial/) | 已获分发授权的课程材料；来源/授权见 [W2](docs/tasks/W2_WORKSPACE_MAIN_INTEGRATION.md) 与 DL-0，MVP 资料导入仍按 TXT/Markdown 范围 |
| [tools/](tools/) | 仓库检查工具 |

复用旧工程时读 [ENGINEERING_HANDOFF](docs/reference/ENGINEERING_HANDOFF.md)；追溯研究依据时读 [PRODUCT_RESEARCH](docs/reference/PRODUCT_RESEARCH.md)。旧实验/实现/通过数保留其来源与适用范围，不能计作正式产品验收，旧实验原始归档不作为团队开工前置。
