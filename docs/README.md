# 本轮架构与设计

本轮从“数字逻辑与部件设计”的学习活动出发，重新设计学生端 Agent 与可装配学习工作区，并确定重构路线。初步架构是讨论输入，后续使用 GitHub Wayfinder 逐项研究和决策；旧实现及本轮工程候选均可被替换或推翻，不限于补齐缺口。

当前云端共享数据和部分服务是尽量小的开发协作环境，用于减少成员设备、环境与数据差异造成的调试难以复现；它不决定产品运行拓扑或首版存储。教师仍设计课程运行方案，尽量由学生本地执行。依据见[需求与决策记录 L7](student-agent-decisions.md#开发协作与产品运行边界l7)。

议题、依赖和当前可推进的主题以 [GitHub 决策地图：学生端 Agent 与工作区重新设计](https://github.com/paher-din/XunJie/issues/112) 为准。按连贯主题组织议题，允许跨会话推进，不按固定 token 上限拆分；本地不复制一份议题状态清单。

| 需要了解什么 | 阅读入口 |
| --- | --- |
| 后续研究、讨论、原型与重构决策 | [学生端 Agent 与工作区重新设计：数字逻辑与部件设计先行](https://github.com/paher-din/XunJie/issues/112) |
| 与研究并行的三项已授权实施范围 | [选区引用、IP 展示层与开发自检规范](specs/README.md) |
| 初步架构候选、模块职责与关键流程 | [学生端 Agent 架构](student-agent-architecture.md) |
| Robert 已明确的要求、工程决定与待验证项 | [需求与决策记录](student-agent-decisions.md) |
| GitHub 议题、原生依赖与后续会话工作方式 | [Issue tracker](agents/issue-tracker.md) |
| 教师设计运行方案、本地优先的理由 | [ADR 0001](adr/0001-teacher-owned-course-execution-plan.md) |
| AI SDK Core 与有限自研运行时的取舍 | [ADR 0002](adr/0002-own-teaching-state-and-effect-control.md) |
| 项目领域术语 | [CONTEXT.md](../CONTEXT.md) |
| 最早的产品愿景 | [最初 idea](<基于个性化学生画像的引导式项目制教学测验 Agent 系统.md>) |
| 原聊天中每条用户消息 | [用户原话](references/2026-10-18-user-discussion.md) |
| 原聊天交付的架构附件 | [2026-10-18 架构底稿](references/XunJie_Student_Agent_Architecture_2026-10-18.md) |
| 当前实现差距与关键技术前提 | [架构事实核对](references/2026-10-18-architecture-checks.md) |
| 浏览器、本机组件与远端执行如何组合 | [执行位置研究](references/2026-10-18-execution-topology-research.md) |

架构与决策记录随本轮讨论更新。最初 idea、用户原话和架构附件作为来源保留；其中的建议、技术核验声明和落地顺序不自动成为本轮已批准决定。最初 idea 中的教师设计、教学分析和跨学生案例库描述整体愿景，本轮教师端范围以决策记录为准。

本目录的设计状态与代码实现状态分别记录。产品决定与初步工程判断已在决策记录中区分；后续可以重新选择技术与模块边界，端点、安装、渲染器和性能仍需实测。工程测试、浏览器验收与教学效果分别记录。历史归档的使用规则见 [AGENTS.md](../AGENTS.md)。
