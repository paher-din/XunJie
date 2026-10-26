# 本轮架构与设计

本轮面向真实使用中的多种课程，重新设计学生端 Agent 与可装配学习工作区，并确定重构路线。“数字逻辑与部件设计”是开发、演示与验证阶段的首条已设计样例，其活动流程和帮助策略不构成所有课程的限制。初步架构是讨论输入，后续使用 GitHub Wayfinder 逐项研究和决策；旧实现及本轮工程候选均可被替换或推翻，不限于补齐缺口。

当前云端共享数据和部分服务是尽量小的开发协作环境，用于减少成员设备、环境与数据差异造成的调试难以复现；它不决定产品运行拓扑或首版存储。教师仍设计课程运行方案，尽量由学生本地执行。依据见[需求与决策记录 L7](student-agent-decisions.md#开发协作与产品运行边界l7)。

议题、依赖和当前可推进的主题以 [GitHub 决策地图：学生端 Agent 与工作区重新设计](https://github.com/paher-din/XunJie/issues/112) 为准。按连贯主题组织议题，允许跨会话推进，不按固定 token 上限拆分；本地不复制一份议题状态清单。

| 需要了解什么 | 阅读入口 |
| --- | --- |
| 后续研究、讨论、原型与重构决策 | [学生端 Agent 与工作区重新设计：数字逻辑与部件设计先行](https://github.com/paher-din/XunJie/issues/112) |
| 与研究并行的两项已授权实施范围 | [选区引用与 IP 展示层规范](specs/README.md) |
| 初步架构候选、模块职责与关键流程 | [学生端 Agent 架构](student-agent-architecture.md) |
| Robert 已明确的要求、工程决定与待验证项 | [需求与决策记录](student-agent-decisions.md) |
| 已确认的学生主动性设置与无扰检测首版路线、后续验证方法 | [跨课程主动引导方案](references/2026-10-23-proactive-guidance-proposal.md) |
| 活动恢复、学习证据、学生画像纠正与教师共享边界 | [连续教学方案](references/2026-10-23-continuous-learning-proposal.md) |
| 自动保存、实验输入、固定引用、待发动作与同浏览器恢复 | [工作区交互与状态决议](https://github.com/paher-din/XunJie/issues/116#issuecomment-6370870664)及[可操作原型](../apps/student/prototypes/workspace-state.README.md) |
| 教师工具库、工具接入、生成内容状态与版本更新 | [课程工具与生成内容决议](https://github.com/paher-din/XunJie/issues/117)、[讨论方案](references/2026-10-26-course-tool-host-proposal.md)及[宿主技术研究](references/2026-10-26-course-tool-host-research.md) |
| 本地修改前后端、共享数据与复现场景的开发协作方式 | [开发协作方案（方向已确认）](development-collaboration.md) |
| 新 Agent 从哪里了解可用工具、如何操作和回答开发者 | [开发协作 Skill](../skills/xunjie-development/SKILL.md) → [工具状态与使用说明](development-tooling.md#新-agent-的工具入口) |
| 开发工具的实现范围、与产品议题的关系及旧入口删除 | [工具设计与实施计划](development-tooling.md#工作项与实施时机) |
| 开发协作规范、用户故事、验收标准及实施子票 | [开发协作工具规范](https://github.com/paher-din/XunJie/issues/126) |
| 成员首次接入、远程权限、连接恢复及 2–5 人云端运行策略 | [成员接入与云端运行](development-access-operations.md) |
| 当前开发服务器的配置、资源占用及性能适配依据 | [服务器核查（2026-10-23）](references/2026-10-23-development-server-assessment.md) |
| GitHub 议题、原生依赖与后续会话工作方式 | [Issue tracker](agents/issue-tracker.md) |
| 教师设计运行方案、本地优先的理由 | [ADR 0001](adr/0001-teacher-owned-course-execution-plan.md) |
| 教学状态、执行控制与有限运行时的初步取舍 | [ADR 0002](adr/0002-own-teaching-state-and-effect-control.md) |
| 三协议实际端点、SDK 验证与模型连接层选择 | [端点评估与工程判断](references/2026-10-23-model-endpoint-assessment.md) |
| 固定版本 SDK 如何保留原生续接数据 | [SDK 源码调查](references/2026-10-22-model-protocol-sdk-research.md) |
| Agent 如何阅读 PDF，以及循阶的按页读取路线 | [PDF 能力调查](references/2026-10-22-agent-pdf-capabilities-research.md) |
| 项目领域术语 | [CONTEXT.md](../CONTEXT.md) |
| 最早的产品愿景 | [最初 idea](<基于个性化学生画像的引导式项目制教学测验 Agent 系统.md>) |
| 原聊天中每条用户消息 | [用户原话](references/2026-10-18-user-discussion.md) |
| 原聊天交付的架构附件 | [2026-10-18 架构底稿](references/XunJie_Student_Agent_Architecture_2026-10-18.md) |
| 当前实现差距与关键技术前提 | [架构事实核对](references/2026-10-18-architecture-checks.md) |
| 跨课程执行、教师低门槛准备与首条 ALU 的运行方向 | [本地执行决议](https://github.com/paher-din/XunJie/issues/114#issuecomment-6363162710)及[讨论与实测记录](references/2026-10-23-local-execution-proposal.md) |
| SystemVerilog 浏览器工具链与原生打包的来源核对 | [本地执行技术调查](references/2026-10-23-systemverilog-local-execution-research.md) |
| 浏览器、本机组件与远端执行的早期比较 | [执行位置研究](references/2026-10-18-execution-topology-research.md) |

架构与决策记录随本轮讨论更新。最初 idea、用户原话和架构附件作为来源保留；其中的建议、技术核验声明和落地顺序不自动成为本轮已批准决定。最初 idea 中的教师设计、教学分析和跨学生案例库描述整体愿景，本轮教师端范围以决策记录为准。

本目录的设计状态与代码实现状态分别记录。产品决定与初步工程判断已在决策记录中区分；后续可以重新选择技术与模块边界，端点、安装、渲染器和性能仍需实测。工程测试、浏览器验收与教学效果分别记录。历史归档的使用规则见 [AGENTS.md](../AGENTS.md)。
