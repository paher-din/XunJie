# ADR 0004：以直接 Turn/Step 主循环替代持久 RunDriver 原位恢复

2026-11-14。本决定替代 [学生端 Agent 决策记录](../student-agent-decisions.md) P1 中“按 L23 长期采用自有持久 RunDriver、逻辑 Run 原位承接多步生成与恢复”的执行内核选择，并取代 `agent-runtime/src/driver.ts` 的 RunDriver、`ports.ts` 的 AgentPipeline/AgentSettlement 以及 store 中按 Operation 推进/原位恢复的逻辑。[ADR 0002](0002-own-teaching-state-and-effect-control.md) 的教学状态与效果归属、三协议直接 SDK 决议、PostgreSQL 统一存储与课程执行模块继续成立，不在本次替代范围。

## 背景

旧内核把每次模型生成、工具批次、学生等待和后台回执都建模为可恢复 Operation，由 RunDriver 按计划/派发/对账/应用推进，并在进程重启后原位续跑。这带来通用调度、逐 Operation 租约、generation 引擎与 `AgentSettlement` 批量状态替换协议。循阶真正额外需要的能力只有跨本机／学校的身份与调用边界、课程与工作区任务的独立生命周期、教学规则、真实学生回答与业务归属；它们不足以证明维持一套通用可恢复 Operation 引擎的长期维护成本。负责人本轮明确：要直接可读的主循环，不要新旧两套循环并存，不为旧运行引擎做兼容。

## 决定

`packages/agent-runtime` 收拢为唯一直接主循环 `runTurn → runStep → generate → executeTools`：

- **术语**：Session（长期对话，同一 Session 最多一个活跃 Turn）、Turn（用户输入或符合条件的后台通知启动的一次连续处理）、Step（一次逻辑主模型生成加该响应的整个工具批次）、Attempt（同 Step 内的模型调用重试）、ToolCall（稳定 ID、批次序号、执行模式、唯一结束结果）、Question（绑定 ToolCall 的真实问答，替代通用 AgentWait）、通知（任务终态的简短输入记录，稳定 `notificationId` 由 taskId+taskVersion 派生）。公共 API／事件／UI 不再把 Run 与 Turn 并列为两个生命周期。
- **工具串行**：完整模型响应保存成功后才整批派发；本次先串行 `await execute(call)`，前一项返回后才启动下一项。保留逐调用 ID、结果映射与统一批次入口以支持后续并发，但不预建并发调度器。
- **前后台**：仅支持长任务的课程工具暴露可选 `executionMode`，缺省 foreground，可显式 background；超时不自动转后台。后台返回真实受理回执（taskId 与来源关联可查询），终态走独立通知路径，不改写已结束 ToolCall 的 accepted 结果。
- **宿主级独占 owner**：对同一 Agent 存储 owner 用一条专用 PostgreSQL 连接持有稳定键的 `pg_try_advisory_lock`；未取得锁的进程不运行循环也不启动修复。锁丢失立即中止本宿主所有活跃循环。新进程取得锁后只把旧 owner 的活跃 Turn 收尾为 interrupted，不原位续跑、不自动重派发模型/工具。
- **中断与继续**：结束旧 Turn，不恢复原执行位置；用户手动继续创建新 Turn，带必要历史与筛选后的任务事实，由模型自行决定查询、重新提问或发起新操作。未启动调用记 not_started，效果不明记 outcome_unknown，真实最终结果保留。
- **Stop**：在同一事务标记指定 turnId 为 stopped 并保存持久取消意图，再枚举来源为该 Turn 的非终态课程任务投递幂等取消；不连带取消先前 Turn 的任务。`cancel_requested` 不等于 cancelled。
- **项目创建**：主模型在普通对话中判断学习语义，先经现有提问界面征求明确同意，同意后创建；彻底删除独立分类模型与“明确要求即免提问”路径。`proposalKey` 关联同批问答与幂等业务创建。
- **上下文**：给决策事实而非整本任务台账；任务事实增量区每次最多 8 项、合计 8192 字符、单项 512 字符，按真实关联/输入来源/是否已消费/状态版本确定性筛选，不引入相关性分类模型。原生历史续接与压缩 segment 边界由模型适配器明确管理。

## 取舍

直接主循环把控制边界集中在一个可读循环里，删除通用调度与原位恢复语义，降低长期维护与心智成本；代价是放弃进程崩溃后的原位续跑——中断后由用户手动继续开启新 Turn，已受理任务由课程 owner 持续记录、晚到结果按真实事实查询。这是明确的产品选择，不是能力缺口的掩盖。跨本机／学校仍路由到各自 owner；授权、教学权限、任务归属、幂等请求与 Stop fence 全部保留，删除的只是主循环公开 permit 阶段与通用 Operation 语义。

## 影响

- `agents` 只保留场景、教学上下文、教学规则与具体工具；通用 history/context/budgets 收进内核，删除 ConversationPipeline 与旧 execution 层。
- `product-runtime` 以 `workspace-agent-tasks` 替代 `workspace-agent-waits`，负责任务观察、取消投递与通知桥接；产品入口与 UI 投影一次切换到 Turn/Step，随后删除旧 Pipeline/Driver/wait/恢复通道，不用配置开关长期保留旧引擎。
- 数据切换为一次性明确作用域：保留 `agent_session_directory` 业务行、原 Session ID、身份/目标/工作区关联及业务创建回执；清空旧运行历史；`personal_learning_projects.workspaceSessionId` 按原 operationId 派生且与回执一致；不做整库 drop，不承担恢复执行位置。
- 新术语见仓库根目录 [GLOSSARY.md](../../../GLOSSARY.md)；实施规格与验收场景见本轮计划文档第 2、14 节。