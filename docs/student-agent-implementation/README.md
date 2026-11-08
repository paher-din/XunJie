# 学生端 Agent 设计与实施

本轮面向真实使用中的多种课程，设计长期使用的学生端 Agent 与可装配学习工作区。八个 Wayfinder 主题已形成最终决议，包括统一原生 PostgreSQL、直接重建旧开发模型、完整 Agent 能力及部署组合。数字逻辑 ALU 与 STAT 20 / Flights 是开发交付资料，其活动流程不构成所有课程的限制。当前进入[实施总览](student-agent-implementation-overview.md)，按工作包逐包完整验收；设计定稿不等于实现或验收通过。

当前云端共享数据和部分服务是尽量小的开发协作环境，用于减少成员设备、环境与数据差异造成的调试难以复现；它不决定产品运行拓扑或存储选型。教师仍设计课程运行方案，尽量由学生本地执行。依据见[需求与决策记录 L7](student-agent-decisions.md#开发协作与产品运行边界l7)。

本目录集中保存架构、需求、实施总览、ADR、已有组件规范、Wayfinder 决议，以及研究与验证附件。后续本轮工作包以 GitHub 规范母票为审阅与拆票入口，`specs/` 保留索引及已有实施文档。

最终结论从[Wayfinder 本地决议索引](wayfinder/student-agent/README.md)读取，包含完整决议、后续确认及研究附件入口。讨论与原始确认保留在 [GitHub 决策地图：学生端 Agent 与工作区重新设计](https://github.com/paher-din/XunJie/issues/112)。本地决议索引不复制 Issue 的动态认领或实施状态；实施工作包的边界与 `blocked by` 见总览，具体规范和实施票随后逐包形成。

| 需要了解什么 | 阅读入口 |
| --- | --- |
| WP08 正式 PDF 添加、页/区域固定引用、真实页图入模与两平台证据 | [#218 PDF 交付](wp08-218-pdf.md) · [验收证据](evidence/wp08-218/README.md) |
| 本轮有哪些工作包、前置依赖和完整验收边界 | [实施总览](student-agent-implementation-overview.md) |
| WP02 的统一产品 UI、复用组件、前后截图及后续 WP 接入位置 | [产品 UI 整合与验收](wp02-product-ui.md) · [Web 接入表](../../apps/web/README.md#正式产品入口与后续-wp) |
| WP03 的组件宿主、语义引用、依赖准备及有限作业/持续会话实施契约 | [课程组件宿主与公共执行规范](specs/wp03-course-components-and-execution.md) |
| WP04 正式 ALU 活动的资料导入、公共执行适配、编辑运行及固定结果恢复 | [#192 设计与实施方案](specs/wp04-alu-edit-run.md) · [工作区交互设计](wp04-192-workspace-design.md) · [Windows 本机交付](wp04-192-windows-acceptance.md) · [#206 跨平台与剩余验收登记](wp04-206-acceptance.md) · [Mac 接续验收票](https://github.com/paher-din/XunJie/issues/206) |
| WP04 虚拟板自由实验、已启用作品、4096 组检查及反例/恢复 | [#193 设计与实施方案](specs/wp04-alu-board-check.md) · [工作区交互设计](wp04-193-workspace-design.md) · [审查修复与本机验收](wp04-193-acceptance.md) · [剩余验收 #211 记录](wp04-211-acceptance.md)；Mac/跨机 HTTPS/系统输入法已在 #211 逐条登记，未用转交抵扣通过 |
| WP04 的固定预测、比较、解释修订、真实 VCD 与语义引用 | [#194 设计与验证边界](specs/wp04-alu-learning.md) · [#194 验收与实际界面对照](wp04-194-acceptance.md) |
| WP04 ALU 一致备份、隔离重读、维护结算与唯一接管 | [#195 实现与恢复验收](wp04-195-acceptance.md) |
| WP03 合入 main 的双轴审查、冲突裁决与 Windows 集成复验 | [PR #189 审查与复验](wp03-pr189-review.md) |
| WP03 组件与未结执行的一致备份、隔离只读还原及权威接管 | [#176 设计与验收计划](specs/wp03-execution-recovery.md) · [实现与本机验收](wp03-176-recovery-implementation.md) · [#188 Mac/学校跨机验收](wp03-188-cross-platform.md) |
| WP03 的浏览器有限作业：固定执行请求、持久接收、真实 Worker/WASM 计算、查询/停止与结果重读 | [浏览器计算与持久执行](wp03-execution.md) · [固定表格聚合样例](../../components/table-aggregation/README.md) |
| WP03 标注对象与真实聚合结果的固定选区、来源核验和定位 | [#172 交付](wp03-semantic-references.md) · [实施方案](specs/wp03-nontext-references.md) · [#185 Apple Silicon 验收](wp03-185-mac-references.md) |
| WP03 第三项：真实依赖准备、独立自检、版本缓存及失败继续的方案与验收 | [#171 实施与验收](specs/wp03-component-preparation.md) · [Mac 交接](wp03-171-mac-handoff.md) |
| WP03 第四项：本机原生有状态会话、连续输入、持久会话事实与真实停止 | [设计与边界](specs/wp03-native-sessions.md) · [实施与验收](wp03-native-sessions.md) · [四态累加样例](../../components/state-accumulator/README.md) |
| WP03 第五项：会话控制、可靠检查点与关联恢复实例 | [实施方案](specs/wp03-session-recovery.md) · [实现与验证](wp03-session-recovery.md) · [#187 Apple Silicon 验收](wp03-187-mac-session-recovery.md) |
| WP03 第四项的 Apple Silicon 收口：Seatbelt 隔离、回收与预算、产品包与桌面 Chrome 验收 | [#184 原生会话隔离与产品包验收](wp03-184-mac-native-isolation.md) |
| #175 已完成：课程运行方案固定、按操作判定执行位置、Linux 受限会话入口、学校节点真实原生会话与撤权/旧安装失权 | [#175 课程运行方案与学校节点执行](wp03-course-execution-plan.md) |
| WP06 的模型配置、三协议接入、原生续接及调用恢复边界 | [三协议模型连接规范](specs/wp06-model-connections.md) |
| WP07 的持久运行、session log、请求重建及正式学习对话 | [WP07：持久 Agent 与学习对话](https://github.com/paher-din/XunJie/issues/196) · [交付与验收](wp07-197-recoverable-learning-conversation.md) · [双轴审查](wp07-197-code-review.md) · [实施子票](specs/README.md#wp07-实施子票) |
| WP07 固定作品读取、课程工具、持久等待与原执行核对 | [#198 实现与验收](wp07-198-agent-tools.md) · [实施选择](specs/wp07-agent-tools.md) · [双轴审查](wp07-198-code-review.md) · [旧消费者迁接归属](wp07-198-legacy-consumers.md) |
| WP07 Agent 独立服务、固定活动路由与跨机设备模型 | [#203 部署与验收](wp07-203-agent-deployment.md) · [双轴审查](wp07-203-code-review.md) |
| WP07 Agent 固定提问、可靠明确回应及原 Run 继续 | [#199 实现与验收](wp07-199-student-ask.md) · [实施选择](specs/wp07-student-ask.md) · [双轴审查](wp07-199-code-review.md) · [Agent owner](../../packages/learning-space/src/teaching-agent/README.md) |
| WP07 忙碌时引导、FIFO 排队、输入修订及暂停选择继续 | [#200 实施选择](specs/wp07-input-control.md) · [实现与验收](wp07-200-input-control.md) · [双轴审查](wp07-200-code-review.md) |
| WP07 #200 的 macOS 引导、排队与暂停续接实机验收 | [#210 macOS 验收](wp07-210-mac-acceptance.md) |
| WP07 学习对话的完整备份、隔离还原与权威接管 | [#204 实施选择](specs/wp07-conversation-recovery.md) · [交付与验收](wp07-204-conversation-recovery.md) · [双轴审查](wp07-204-code-review.md) · [Mac/跨机交接 #212](https://github.com/paher-din/XunJie/issues/212) |
| WP07 Windows 工程检查的 20 项后续修复与重新验收 | [实施与复验](wp07-engineering-checks.md) · [双轴审查](wp07-engineering-code-review.md) |
| WP07 与已合入 main 的最终 WP04 整合、组合回归及清理 | [合并与复验](wp07-main-integration.md) |
| WP08 的能力装配、独立 Skills、上下文压缩、记忆读取及 PDF 资料来源；MCP/Plugin 暂缓 | [WP08：Agent 能力、上下文与扩展](https://github.com/paher-din/XunJie/issues/214) |
| WP08 现有学习对话的版本化能力装配、固定上下文与持久换段 | [#215 实现与验收](wp08-215-versioned-assembly.md) · [实际验收证据](evidence/wp08-215/README.md) |
| WP08 平台与课程工具的按需发现、固定加载、大结果原件与范围读取 | [#216 实现与验收](wp08-216-tool-discovery.md) · [实际验收证据](evidence/wp08-216/README.md) |
| WP08 课程与个人独立 Skills、正式设置和问题草稿、固定版本及渐进读取 | [#217 实现与验收](wp08-217-skills.md) · [实际验收证据](evidence/wp08-217/README.md) |
| WP08 长历史的有界压缩、原操作延续及摘要恢复 | [#220 实现与验收](wp08-220-context-compaction.md) · [实际验收证据](evidence/wp08-220/README.md) |
| WP08 四项能力合入 `wp08`、旧分支迁移与备份兼容、组合验证 | [整合说明](wp08-integration.md) · [本次验证证据](evidence/wp08-integration/README.md) |
| PR #177 审查报告的 12 项修复与回归 | [审查修复记录](wp06-pr177-review-fixes.md) |
| WP06 Responses 原生结果、工具图像和持久续接 | [Responses 交付与验收](wp06-responses-acceptance.md) |
| WP06 Messages 思考/签名、工具图像和持久续接 | [Messages 交付与验收](wp06-messages-acceptance.md) |
| WP06 学校/个人来源选择、Chat 图片工具与原生续接的实际交付 | [选择与原生 Chat 验收](wp06-chat-selection-acceptance.md) · [模型 owner](../../packages/learning-space/src/model-connections/README.md) |
| 学习空间身份、学校接入及无课程活动的生产入口和验证边界 | [学习空间身份与活动交接](wp02-identity-activity.md) |
| 课程任务、固定发布、访问投影及跨 owner 活动建立的实施方案与验收记录 | [课程任务与固定发布版本实施方案](specs/wp02-course-task-releases.md) · [验收记录](wp02-course-releases-acceptance.md) |
| 活动作品编辑、自动保存、本机保护、冲突与资源恢复 | [可靠作品编辑与自动保存](wp02-reliable-works.md) |
| 固定引用、问题草稿持久恢复及来源授权 | [实施方案](specs/wp02-fixed-references-and-question-drafts.md) · [验收记录](wp02-fixed-references-acceptance.md) |
| 明确动作的固定依据、可靠待发、取消、原请求核实及接收回执 | [固定依据与持久待发意图](wp02-action-intents.md) · [实施方案](specs/wp02-durable-action-intents.md) |
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
| DeepSeek Harness 的 session log、上下文投影、持久屏障与 WP07 取舍 | [Session log 源码研究](references/2026-11-05-harness-session-log-research.md) |
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
