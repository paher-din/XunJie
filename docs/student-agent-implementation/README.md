# 学生端 Agent 设计与实施

本轮面向真实使用中的多种课程，设计长期使用的学生端 Agent 与可装配学习工作区。八个 Wayfinder 主题已形成最终决议，包括统一原生 PostgreSQL、直接重建旧开发模型、完整 Agent 能力及部署组合。数字逻辑 ALU 与 STAT 20 / Flights 是开发交付资料，其活动流程不构成所有课程的限制。当前进入[实施总览](student-agent-implementation-overview.md)，按工作包逐包完整验收；设计定稿不等于实现或验收通过。

当前云端共享数据和部分服务是尽量小的开发协作环境，用于减少成员设备、环境与数据差异造成的调试难以复现；它不决定产品运行拓扑或存储选型。教师仍设计课程运行方案，尽量由学生本地执行。依据见[需求与决策记录 L7](student-agent-decisions.md#开发协作与产品运行边界l7)。

本目录集中保存架构、需求、实施总览、ADR、已有组件规范、Wayfinder 决议，以及研究与验证附件。后续本轮工作包规范放在 `specs/`。

最终结论从[Wayfinder 本地决议索引](wayfinder/student-agent/README.md)读取，包含完整决议、后续确认及研究附件入口。讨论与原始确认保留在 [GitHub 决策地图：学生端 Agent 与工作区重新设计](https://github.com/paher-din/XunJie/issues/112)。本地决议索引不复制 Issue 的动态认领或实施状态；实施工作包的边界与 `blocked by` 见总览，具体规范和实施票随后逐包形成。

| 需要了解什么 | 阅读入口 |
| --- | --- |
| 本轮有哪些工作包、前置依赖和完整验收边界 | [实施总览](student-agent-implementation-overview.md) |
| 学习空间身份、学校接入及无课程活动的生产入口和验证边界 | [学习空间身份与活动交接](wp02-identity-activity.md) |
| 课程任务、固定发布、访问投影及跨 owner 活动建立的实施方案与验收记录 | [课程任务与固定发布版本实施方案](specs/wp02-course-task-releases.md) · [验收记录](wp02-course-releases-acceptance.md) |
| 活动作品编辑、自动保存、本机保护、冲突与资源恢复 | [可靠作品编辑与自动保存](wp02-reliable-works.md) |
| 固定引用、问题草稿持久恢复及来源授权的待审实施方案 | [固定引用与问题草稿恢复](specs/wp02-fixed-references-and-question-drafts.md) |
| 学校身份与本机学习数据绑定、业务备份及跨机接管 | [混合部署与业务恢复](wp02-hybrid-deployment.md) |
| 目标代码结构、依赖规则及各 WP 同步完成的结构改造 | [代码结构与实施节奏](student-agent-implementation-overview.md#代码结构与实施节奏)；取舍见 [ADR 0003](adr/0003-runtime-entrypoints-and-owned-modules.md) |
| 当前工程入口、测试环境及 #143/#144 接入交接 | [工程入口与 WP01 交接](engineering-entrypoints.md) |
| #142 产品运行与数据底座的预期、实际效果及组合验收 | [WP01 父票验收](wp01-acceptance.md) |
| #143 产品运行候选、公开接口、安装资源与实际验收 | [产品运行交接](runtime-acceptance.md)；[固定资源](runtime-resources.md) |
| #144 PostgreSQL 事务、所属资源、维护接入与故障证据 | [存储接入与验收](storage-acceptance.md)；[package 使用说明](../../packages/storage/README.md) |
| #145 维护、完整备份、隔离恢复、升级与权威接管 | [维护操作与验收](maintenance-acceptance.md)；[运行库接入](../../packages/product-runtime/README.md) |
| 八个 Wayfinder 主题的完整结论、来源和后续修正 | [本地决议索引](wayfinder/student-agent/README.md) |
| 本轮设计决策的讨论与确认来源 | [学生端 Agent 与工作区重新设计：数字逻辑与部件设计先行](https://github.com/paher-din/XunJie/issues/112) |
| ALU 的学习目标、公开行为表、帮助边界和场景 | [活动决议](wayfinder/student-agent/alu-activity.md)及[活动设计](references/2026-10-23-alu-activity-design.md) |
| 直接重建范围、统一 PostgreSQL、STAT 20 / Flights 与实施验收 | [重构、存储与验收方案](references/2026-10-28-rebuild-storage-and-acceptance-proposal.md) |
| SQLite / PostgreSQL 与文件 / S3 资源的事实和代价 | [存储方案官方研究](references/2026-10-28-storage-options-research.md) |
| 原生 PostgreSQL 本机管理与 PGlite 的实际差异 | [本机数据库运行研究](references/2026-10-28-postgres-local-runtime-research.md) |
| 工作包规范、实施票与已交付的选区引用、IP 展示层 | [规范目录与已有交付记录](specs/README.md) |
| 长期目标架构、领域职责与产品流程 | [学生端 Agent 架构](student-agent-architecture.md) |
| 模块、内核、持久运行、部署组合与演进契约 | [总体运行与部署设计](references/2026-10-27-overall-architecture-proposal.md) |
| Agent tools、Skills、MCP、plugin、提示词的覆盖审计与术语口径 | [Agent 设计覆盖审计](references/2026-10-27-agent-design-coverage-audit.md) |
| Agent 定义、工具、Skills/MCP/Plugin、Prompt/上下文/Memory 与交付 | [Agent 能力与质量契约](references/2026-10-27-agent-capabilities-design.md) |
| 默认引导/排队、工具与思考摘要显示、无课程自主学习 | [Agent 交互设计](references/2026-10-27-agent-interaction-design.md) |
| DeepSeek Harness / Pi 的实际新消息介入时点、收尾和无模型探针 | [steering 调度研究](references/2026-10-27-agent-steering-research.md) |
| OpenCode / Claude Code 的工具记录、thinking 和等待状态 | [过程显示研究](references/2026-10-27-agent-progress-display-research.md) |
| 后续开发调试、Prompt 迭代和评估平台选择 | [Langfuse、Phoenix、LangSmith 与 Braintrust 比较](references/2026-10-27-agent-observability-evaluation-research.md) |
| 两平台在 M5 上的功能、界面、资源与独立实例移交实测 | [Phoenix 与 Langfuse 本机试用](references/2026-10-27-observability-local-trial.md) |
| 本机调试、选定案例共享与开源发布边界 | [本机 Phoenix 与调试包协作](references/2026-10-27-agent-evaluation-integration.md) |
| 个人本地、学校与混合部署的产品参照 | [Open WebUI、Dify、Immich 与 Supabase 部署研究](references/2026-10-27-deployment-patterns-research.md) |
| 自有循环、Pi core/durable 与 DeepSeek Harness 的当前事实 | [Agent 内核复用研究](references/2026-10-27-agent-kernel-reuse-research.md) |
| 内核比较的可复现代码、故障情形与实际结果 | [隔离接入探针](references/probes/2026-10-27-agent-kernel/README.md) |
| Robert 已明确的要求、工程决定与待验证项 | [需求与决策记录](student-agent-decisions.md) |
| 已确认的学生主动性设置与无扰检测路线、验证方法 | [跨课程主动引导方案](references/2026-10-23-proactive-guidance-proposal.md) |
| 活动恢复、学习证据、学生画像纠正与教师共享边界 | [连续教学方案](references/2026-10-23-continuous-learning-proposal.md) |
| 自动保存、实验输入、固定引用、待发动作与同浏览器恢复 | [工作区交互与状态决议](wayfinder/student-agent/workspace-state.md)及[可操作原型](../../apps/web/prototypes/workspace-state.README.md) |
| 教师组件库、组件接入、生成内容状态与版本更新 | [课程组件决议](wayfinder/student-agent/course-components.md)、[详细设计](references/2026-10-26-course-tool-host-proposal.md)及[宿主技术研究](references/2026-10-26-course-tool-host-research.md) |
| GitHub 议题、原生依赖与后续会话工作方式 | [Issue tracker](../agents/issue-tracker.md) |
| 教师设计运行方案、本地优先的理由 | [ADR 0001](adr/0001-teacher-owned-course-execution-plan.md) |
| 自有持久 RunDriver 的长期选择、替代方案与维护责任 | [ADR 0002](adr/0002-own-teaching-state-and-effect-control.md) |
| 三协议实际端点、SDK 验证与模型连接层选择 | [端点评估与工程判断](references/2026-10-23-model-endpoint-assessment.md) |
| 固定版本 SDK 如何保留原生续接数据 | [SDK 源码调查](references/2026-10-22-model-protocol-sdk-research.md) |
| Agent 如何阅读 PDF，以及循阶的按页读取路线 | [PDF 能力调查](references/2026-10-22-agent-pdf-capabilities-research.md) |
| 项目领域术语 | [CONTEXT.md](../../CONTEXT.md) |
| 最早的产品愿景 | [最初 idea](<../基于个性化学生画像的引导式项目制教学测验 Agent 系统.md>) |
| 原聊天中每条用户消息 | [用户原话](references/2026-10-18-user-discussion.md) |
| 原聊天交付的架构附件 | [2026-10-18 架构底稿](references/XunJie_Student_Agent_Architecture_2026-10-18.md) |
| 当前实现差距与关键技术前提 | [架构事实核对](references/2026-10-18-architecture-checks.md) |
| 跨课程执行、教师低门槛准备与首条 ALU 的运行方向 | [本地执行决议](https://github.com/paher-din/XunJie/issues/114#issuecomment-6363162710)及[讨论与实测记录](references/2026-10-23-local-execution-proposal.md) |
| SystemVerilog 浏览器工具链与原生打包的来源核对 | [本地执行技术调查](references/2026-10-23-systemverilog-local-execution-research.md) |
| 浏览器、本机组件与远端执行的早期比较 | [执行位置研究](references/2026-10-18-execution-topology-research.md) |

架构与决策记录随本轮讨论更新。最初 idea、用户原话和架构附件作为来源保留；其中的建议、技术核验声明和落地顺序不自动成为本轮已批准决定。最初 idea 中的教师设计、教学分析和跨学生案例库描述整体愿景，本轮教师端范围以决策记录为准。

本目录的设计状态与代码实现状态分别记录。产品要求、工程选择和具体确认来源已在决策记录中区分；端点、生产恢复、安装、渲染器和性能仍需实测。工程测试、浏览器验收与教学效果分别记录。历史归档的使用规则见 [AGENTS.md](../../AGENTS.md)。
