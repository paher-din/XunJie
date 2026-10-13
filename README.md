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

教学服务的精确 Node/依赖要求见 [package.json](apps/teaching/package.json)。默认 `npm start` 只提供健康入口；I0 C 业务模式通过 XUNJIE_I0_CONFIG 引用受控配置，装配原 Workspace、同源 HTTPS、现有 UI dist 与原 Job 消费；初始化、字段、启动与验证命令见 [I0-A/C §12](docs/tasks/I0_A_C_HANDOFF.md#12-本批实现与运行交接)。配置、TLS、签名和 C 节点材料由原授权通道交接。DL-A 的两课程 HDL 模式通过 XUNJIE_APP_CONFIG 引用受控配置，与 C 模式共用原 bootstrap、静态服务、Job 消费和关停；当前35表合成初始化、配置差异和联合验证见 [DL-A §16](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md#16-35表去重联合收尾实现与验证)。A 的 ALU/HDL求助会审、固定源码包清单及 C 接收说明见 [DL-A §18](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md#18-a可独立推进的会审与固定执行包2026-10-13)。模块专项命令与合成库/真实节点/模型门禁在相应任务中，启动健康入口不表示完整应用可用。

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
| P3 数字逻辑与反馈闭环 | [G3 总协调](docs/tasks/G3_OVERALL_COORDINATION.md)、[DL-0](docs/tasks/DL-0_DIGITAL_LOGIC_ADDON.md)、[DL-A](docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md) |
| C4 → A4 → DL-C 顺序集成 | [集成记录](docs/tasks/ORDERED_C4_A4_DL_C_INTEGRATION.md)、[C4](docs/tasks/C4_SUBMISSIONS_REOPEN_RECOVERY.md)、[A4](docs/tasks/A4_LEARNER_STATE_REVIEW.md)、[DL-C](docs/tasks/DL-C_HDL_BUILD_SIMULATION.md) |
| 学生 UI 准备交付与真实接入 | [I0 收尾](docs/tasks/I0_UI_CLOSEOUT.md)、[接入规格](docs/tasks/I0_UI_SPEC.md)、[准备票索引](docs/tasks/I0_UI_PREPARATION.md)；H-01～H-06 回交在 [#30](https://github.com/paher-din/XunJie/issues/30) |
| A/C 按 H 编号回交 | [I0-A/C 交接](docs/tasks/I0_A_C_HANDOFF.md)；身份/分配、受信代际、原 Job 与版本/公开样例，实际联调条件逐项保留 |
| 编辑器补验与测试耗时优化 | [I0-UI-BV](docs/tasks/I0_UI_BV_EDITOR_BROWSER_VERIFICATION.md)；保留全部 108 项浏览器检查的覆盖/实测对照与交付状态 |
| 仓库入口与规则重写 | [W4](docs/tasks/W4_REPO_ENTRYPOINT_REWRITE.md) |
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
