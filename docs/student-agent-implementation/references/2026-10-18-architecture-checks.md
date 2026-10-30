# 架构讨论的事实核对

核对日期：2026-10-18。仓库基线：`697149c`。范围为当前源码和公开一手资料；未读取历史归档，未接入实际模型端点，未运行工程测试、浏览器验收或教学效果验证。以下事实与工程判断支持[架构基线](../student-agent-architecture.md)，不是实施验收报告。

## 当前实现与目标的差距

| 当前事实 | 对本轮设计的影响 | 源码入口 |
| --- | --- | --- |
| 工作区按 `hdl_board` 分流，注入不同运行和面板逻辑。 | 课程配置需要取代主页面课程分支；现有组件可以按能力重新封装。 | [PrepWorkspacePage.tsx](../../../apps/web/src/pages/PrepWorkspacePage.tsx#L74) |
| 编辑后的防抖主要保护本机草稿；服务端保存与冻结由独立操作触发。 | 实时同步需要新的确认、补传和提问前协调契约，不能把当前本机保护视为已实现实时状态。 | [本机保护](../../../apps/web/src/components/workspace/useProjectWorkspace.ts#L336)、[保存与冻结](../../../apps/web/src/pages/PrepWorkspacePage.tsx#L636) |
| 代码求助先要求已确认文件、快照，再捕获代码引用。 | 通用划选引用与取消手动保存前提需要同时改造。 | [onCodeHelp](../../../apps/web/src/pages/PrepWorkspacePage.tsx#L234) |
| C 运行已绑定快照、输入、摘要与运行身份。 | 实际执行依据应保留为内部能力，由系统自动生成，不要求学生管理。 | [运行命令](../../../apps/server/server/workspace/commands.ts#L171) |
| 学生辅导一次生成有限动作，明确禁止修改文件和运行代码；动作 schema 也固定这些行为为 false。 | 真正的工具型 Agent 需要重建执行与教学策略边界，不能只改提示词。 | [辅导策略](../../../apps/server/server/tutoring/core.ts#L89)、[动作定义](../../../apps/server/server/records/teaching.ts#L50) |
| 演示 IP 使用 `COUNTER_GUIDE` 预置步骤。 | 已有视觉载体可复用，连续教学驱动仍需实现。 | [演示脚本](../../../apps/web/src/pages/WorkspacePage.tsx#L29) |
| 通用个人模型传输固定请求 `/chat/completions`。 | 三协议路线、能力声明与原生续接不是现成能力。 | [兼容传输](../../../apps/server/server/tutoring/openai-compatible.ts#L140) |
| 生成沙箱已有初始化和状态回传；真实聊天的卡片持久化、小测等入口仍不可用。 | 可复用 iframe 生命周期与桥接经验，统一工作区对象持久化和教学事件链仍待补齐。 | [沙箱消息](../../../apps/web/src/bridge/genSandbox.ts#L40)、[真实 API](../../../apps/web/src/bridge/agentApi.ts#L158) |
| 现有数据库事务接口要求同步、不可嵌套，直接操作 SQLite。 | 增加 PostgreSQL 不是换连接字符串；双数据库会增加实际适配与验收工作。 | [事务接口](../../../apps/server/server/db/transaction.ts#L93) |
| 应用支持登记多执行节点；节点主动用 SSH 反向隧道接入业务服务，浏览器提交登记的节点 ID。 | 已有“服务在云端、编译在学生电脑”的静态协议基础，源码与结果仍经业务服务；不能把本地计算等同于离线或数据不上云。 | [多节点组合](../../../apps/server/server/app/digital-logic.ts#L47)、[节点选择](../../../apps/server/server/app/execution-nodes.ts#L30)、[现行回连入口](../../../tools/xj-dev/README.md#模式与受管连接)（原脚本已由 #128 替代） |
| 执行协议已有 query/submit/cancel/readResult，并保持任务的原节点与代际；现有节点选择函数只检查登记与代际。 | 可复用意图、结果和恢复语义；用户配对、节点归属与使用权限仍需明确。不能把登记节点自动视为所有学生都可使用。 | [执行协议](../../../apps/server/server/records/runner.ts#L54)、[节点绑定](../../../apps/server/server/app/execution-nodes.ts#L29) |
| HDL 执行依赖 Linux 容器、资源约束、无网络、只读输入与 AppArmor 等机制。 | 隔离由执行环境提供；跨平台本地运行需要实际安装与兼容验证，不能简单替换成普通子进程。 | [容器执行参数](../../../apps/server/runner/hdl-executor.ts#L16) |
| 教师工作台读取 Attempt、提交和快照；教师 Agent 复用模型与辅导模块。 | 学生端重构仍要决定共享接口与旧数据如何过渡；教师端“不展开设计”不等于没有影响。 | [教师工作台](../../../apps/server/server/app/teacher-workbench.ts#L49)、[教师模型依赖](../../../apps/server/server/design/teacher-agent.ts#L9) |

现有教学记录区分交付、展示、确认和失效，可作为后续运行时证据记录的复用候选。迁移时保留其目的，不必沿用全部字段与表结构。[记录定义](../../../apps/server/server/records/teaching.ts#L40)

当前个人模型通道要求公网 HTTPS，拒绝 localhost 和私网地址；计算节点本地化不会自动支持本地模型。若后续需要本地模型，需通过明确的受信连接机制实现，而非直接放开现有公网端点校验。[模型地址策略](../../../apps/server/server/tutoring/openai-compatible.ts#L24)

## 模型调用层

**已确认：应用可以自己控制本地工具执行顺序。** AI SDK Core 的工具 `execute` 可省略，宿主取得调用后自行执行并回填结果。因此“先持久化完整意图，再进入 ToolExecutor”的方案有公开接口基础；服务商托管工具不受这个本地执行入口控制。[AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

**有条件：可回放消息不等于任意方言无损透传。** 核对 AI SDK 固定提交 `fce9210c6405c0ad8452fee3f50717e8ea910b97`，Core 将内容块中的 provider metadata 带入回放消息；适配器分别处理兼容 Chat reasoning、Responses reasoning items、Anthropic thinking/signature。持久化时必须保留所需元数据和内容顺序，实际目标端点仍需往返验证。[Core 回放转换](https://github.com/vercel/ai/blob/fce9210c6405c0ad8452fee3f50717e8ea910b97/packages/ai/src/generate-text/to-response-messages.ts) · [Chat 转换](https://github.com/vercel/ai/blob/fce9210c6405c0ad8452fee3f50717e8ea910b97/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts) · [Responses 转换](https://github.com/vercel/ai/blob/fce9210c6405c0ad8452fee3f50717e8ea910b97/packages/open-responses/src/responses/convert-to-open-responses-input.ts) · [Messages 转换](https://github.com/vercel/ai/blob/fce9210c6405c0ad8452fee3f50717e8ea910b97/packages/anthropic/src/convert-to-anthropic-prompt.ts)

**有条件：三协议都有第三方接入机制，但不能因此宣称所有端点已兼容。** `openai-compatible` 支持自定义端点；`open-responses` 面向 Open Responses 实现；Anthropic provider 可配置地址、认证与 headers，但仍包含模型能力规则。能力契约应同时固定 SDK/provider 版本与实际端点、模型、协议；服务商方言由明确的 adapter 承担。[Chat provider](https://ai-sdk.dev/providers/openai-compatible-providers) · [Open Responses provider](https://ai-sdk.dev/providers/ai-sdk-providers/open-responses) · [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)

**需要修正附件的一个隐含前提：每步重读事实，不代表可以任意重写模型历史和工具定义。** Anthropic 文档对部分模型的 preserved thinking 要求此前 system、tools 与消息前缀保持一致。循阶实际第三方端点是否执行相同规则尚未实测；Gateway 应按能力配置选择追加观察、端点明确支持的动态更新或开启新续接段，不能静默丢弃原生记录来掩盖不兼容。[Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#keeping-the-prefix-unchanged)

这些证据支持采用 AI SDK Core 作为可替换调用层，不证明它在所有教学场景中优于 Pi 或 DeepSeek Harness。领域所需的教学状态、工具意图持久化、未知结果核实与恢复仍由循阶维护。

### 内核取舍的工程判断

Pi 的固定提交提供有状态 Agent、运行中输入队列、每次请求前的上下文准备、工具前后钩子，以及助手消息处理完成后再开始工具预检的顺序。它是可行的内层循环候选，不能以“无法实时读取”或“无法在工具前处理”排除。[Pi agent-core](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/README.md)

DeepSeek Harness 的固定提交以 Cordis 插件组合工具、模型、会话日志与 Agent loop，提供 profile/bundle 与 SessionEvent 体系。它能复用更多完整运行框架，同时意味着循阶需要与该应用组合和会话模型集成。[Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md)

教学状态由循阶持有，不足以推出必须自研完整内核；Pi 的钩子同样可能承接所需顺序。本轮采用 Core 的成本判断是：首期仅需一条有界运行入口，调用原语可直接组织“取证—模型步骤—持久化—工具执行—重新判断”，暂不需要额外集成通用会话与插件框架。TeachingEpisode 先是数据，Controller 先是触发规则，避免把职责划分变成框架建设清单。

代价是自行维护有限步骤、预算、取消和恢复，不能估成只写一个 while 循环。若开始需要大量队列或调度设施，应通过 ModelPort/RunDriver 边界重新比较现成循环的复用成本。工程判断见 [ADR 0002](../adr/0002-own-teaching-state-and-effect-control.md)；没有完成各内核接入原型或性能比较，也不依赖仓库当前已安装的 SDK。

## OpenIntelligentUI 复用

核对附件固定提交 `8391a94c1c3939c679e40ddd7bfc08a9ef690e70`。上游具有逐步预览与最终 iframe 渲染路径，renderer 仍依赖 Websandbox、主题、桥接与应用组件；将其抽离是有依据的工程方案，尚未通过本项目抽离构建验证。[renderer](https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx) · [prompt bridge](https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/lib/sandbox/prompt-bridge.tsx)

上游架构说明会话检查点在进程内存，跟进生成另一份回答快照；任意 iframe 控件状态不会自动同步给 Agent。因此状态定义、持久保存、恢复注入、选区上报与学习交互回传必须计入循阶自己的工作量，不能把保存生成代码视为完整状态恢复。[上游架构说明](https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/docs/architecture.md)

本轮据此只复用局部渲染能力，并让课程组件与教学产物共用工作区 SDK 和状态体系。抽离成本尚未验证；若引入上游框架的成本超过渲染收益，应缩小抽取范围，而不是引入第二套状态宿主。

## 后续验证的边界

当前可以确认方案有相应接口与源码基础；尚不能确认真实端点的工具往返、原生续接、取消、故障恢复、生成 UI 质量和教学效果。后续应选择实际端点与真实课程活动完成验证，避免用“能请求成功”代替能力验收。
