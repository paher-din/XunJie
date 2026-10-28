# 学生端 Agent 与工作区的 Wayfinder 决议

本目录是[学生端 Agent 与工作区重新设计](https://github.com/paher-din/XunJie/issues/112)的本地决议入口。八个主题的最终决议正文已收录；研究报告、详细设计与文档内验证附件集中在上层实施目录，由各决议页链接进入。GitHub 保留讨论、确认及原始交付记录，实施时从这里读取已定结论及后续修正。

这里收录最终决议，不把中途建议、未确认方案或历史实现状态提升为当前要求。正文保留来源语境；其中的“已测”“未测”均指原议题收束时。新的实现状态由对应工作包的交付证据记录。

## 决议与材料入口

| 主题 | 本地最终决议 | 主要详细材料 |
| --- | --- | --- |
| 首条学习活动、公开行为表与帮助策略 | [数字逻辑与部件设计](alu-activity.md) | [ALU 活动设计](../../references/2026-10-23-alu-activity-design.md)、[课程资料](../../../../course_matrial/README.md) |
| 本地优先、设备准备与执行生命周期 | [本地执行](local-execution.md) | [执行方案与实测](../../references/2026-10-23-local-execution-proposal.md)、[工具链研究](../../references/2026-10-23-systemverilog-local-execution-research.md) |
| 三协议、原生续接、多模态与 PDF | [模型接入](model-access.md) | [端点评估](../../references/2026-10-23-model-endpoint-assessment.md)、[SDK 研究](../../references/2026-10-22-model-protocol-sdk-research.md)、[PDF 研究](../../references/2026-10-22-agent-pdf-capabilities-research.md) |
| 自动保存、固定引用、待发动作与恢复 | [工作区交互与状态](workspace-state.md) | [可操作原型与说明](../../../../apps/student/prototypes/workspace-state.README.md) |
| 组件库、动态接入、生成内容与版本更新 | [课程组件](course-components.md) | [宿主设计](../../references/2026-10-26-course-tool-host-proposal.md)、[宿主技术研究](../../references/2026-10-26-course-tool-host-research.md) |
| 主动性、连续活动、证据、画像与纠正 | [连续教学](continuous-learning.md) | [主动引导](../../references/2026-10-23-proactive-guidance-proposal.md)、[活动与画像](../../references/2026-10-23-continuous-learning-proposal.md)、[检测证据](../../references/2026-10-23-unobtrusive-guidance-evidence.md)、[实现调查](../../references/2026-10-23-unobtrusive-guidance-implementations.md) |
| 模块、持久 Agent、能力扩展、交互与部署 | [总体架构](architecture.md) | [运行与部署](../../references/2026-10-27-overall-architecture-proposal.md)、[Agent 能力](../../references/2026-10-27-agent-capabilities-design.md)、[交互设计](../../references/2026-10-27-agent-interaction-design.md)、[调试评估](../../references/2026-10-27-agent-evaluation-integration.md) |
| 直接重建、统一 PostgreSQL、Flights 与实施交接 | [重构与存储](rebuild-storage.md) | [重构方案](../../references/2026-10-28-rebuild-storage-and-acceptance-proposal.md)、[存储研究](../../references/2026-10-28-storage-options-research.md)、[本机 PG 研究](../../references/2026-10-28-postgres-local-runtime-research.md) |

每份本地决议页均链接对应的 GitHub 最终评论。更细的内核、消息调度、过程显示、部署参照和平台试用材料见[本轮文档索引](../../README.md)，不在本目录重复保存。

## 后续确认

以下更新和原决议一起读取；后续明确确认优先于来源正文中的旧安排。

- **2026-10-28，存储与重建范围已收束：** [重构与存储决议](rebuild-storage.md)补完[总体架构](architecture.md)交接的事项。统一原生 PostgreSQL，由产品管理本机实例；旧版只有开发数据，直接重建 schema 和接口，保留原件、按需提取。
- **2026-10-28，第二样本与教师范围已澄清：** 第二样本已确定为伯克利 STAT 20 / Flights，更新[连续教学决议](continuous-learning.md)中“第二门课程未定”的当时状态。ALU/Flights 内容是开发交付资料；教师端课程设计与制作属于产品能力，本轮仅展开学生端所需关联路径，后续继续深入设计。
- **2026-10-29，负责人确认按工作包交付：** 先完成实施总览，之后逐包写规范，再在包内拆实施子任务；工作包之间标注 `blocked by`。每包完成自身范围的完整验收，包含与已完成依赖的真实集成、失败恢复及受影响回归。**取消另设整轮重构总验收。** 原存储决议的五阶段顺序作为来源保留，当前安排见[实施总览](../../student-agent-implementation-overview.md)。
- **2026-10-29，本地检索要求：** 最终决议集中收录并关联既有研究和交付附件；实施总览不增加“决议到工作包”的覆盖表。
- **2026-10-29，目录组织：** 负责人指定 `docs/student-agent-implementation/` 统一保存本轮架构、决策、实施总览、规范、研究附件和 `wayfinder/`；[目录入口](../../README.md)提供完整检索。原决议中的历史路径保留来源原貌，当前路径使用各页开头的本地材料链接。

## 实施时怎样使用

先读[实施总览](../../student-agent-implementation-overview.md)找到工作包和前置依赖，再读本目录相关决议及详细设计，最后按所需证据进入研究或原型。决策依据、工作包规范和实际交付结果分别记录；新证据要求改变决定时，同步本目录的后续确认与相关设计入口。
