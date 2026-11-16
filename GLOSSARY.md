# 术语表（Glossary）

本表以学生端 Agent 内核收拢计划第 2 节为准，记录当前唯一术语。其他业务的 execution/run 名词不机械替换；Gateway／课程模块已有请求 ID 保留其业务意义。

## Agent 内核

- **Session（会话）**：长期对话及其历史。同一 Session 同时最多一个活跃 Turn。Session 身份与业务目录（`agent_session_directory`）长期保留。
- **Turn（回合）**：由用户输入、手动继续或符合条件的后台完成通知启动的一次连续处理，包含一个或多个 Step。终态：`completed` / `stopped` / `interrupted` / `failed`。用户点击“继续”会新建 Turn，不恢复原执行位置。
- **Step（步）**：一次逻辑主模型生成，加上该响应产生的全部 ToolCall。无工具的响应也算一个 Step。不同 Step 串行；整个 Step 结束才接纳 steering 输入。
- **Attempt（尝试）**：实际的主模型调用尝试。失败重试仍归属同一个 Step；只有被选为有效响应的 Attempt 能派发工具。默认每 Step 最多 3 个 Attempt，退避 1s/2s。
- **ToolCall（工具调用）**：主模型响应中的单项调用，具有稳定 `toolCallId`、批次序号、输入、执行模式（foreground/background）和唯一结束结果。单响应最多 8 个 ToolCall；Turn 累计上限 64。
- **ToolResult（工具结果）**：五种结束种类——`completed`（success/error）、`accepted`（后台任务真实受理回执，含 taskId）、`interrupted`、`not_started`、`outcome_unknown`。任务当前状态、取消确认与工具返回种类分开表达。
- **Question（问题）**：绑定 ToolCall 的真实问题及真实答案，是提问能力的业务记录，不再是通用 AgentWait。状态：`pending` / `answered` / `skipped` / `expired` / `closed`。答案持久化先于唤醒；重复提交返回已有回执。
- **通知（Notification）**：任务终态的简短输入记录，带稳定来源、版本及 `notificationId`（由 taskId + 稳定终态版本派生）。它不是旧工具调用的第二个结果。最小字段：`notificationId, sessionId, originTurnId, taskId, taskVersion, terminalStatus, summary, resultRef`。
- **steering（转向输入）**：Turn 活跃时到达的普通新消息，保存后在整个当前 Step 完成后进入上下文；不抢占、不跳过当前批次尚未开始的调用。
- **deferred（延迟输入）**：目标为 stopped/interrupted/failed Turn 但未接纳到 Step 的用户消息，保留原文、顺序、requestId，在下一次新用户输入或手动继续开启新 Turn 时按原顺序一起接纳。

## 任务与归属

- **Task（任务）**：课程执行模块持有的长任务，以稳定 `taskId` 标识，可跨 Step、Turn 存活。Task 持续运行不意味着其发起 ToolCall 仍未返回。
- **originTurnId（来源 Turn）**：任务的来源追踪信息，不是阻止跨 Turn 查询的限制。任务可访问性由身份、任务持有人、所属 Session／工作区、目标环境和教学权限决定。
- **executionMode（执行模式）**：支持长任务工具公开 schema 中的可选字段，缺省 `foreground`，可显式 `background`。不支持的工具传入 background 返回参数错误。注意：参考仓库 DSH 的同名 `executionMode` 指并行/独占，与此处前台/后台业务参数含义不同。
- **宿主级独占 owner（host owner lock）**：对同一 Agent 存储 owner（environment/service/binding）用一条专用 PostgreSQL 连接持有稳定键的 `pg_try_advisory_lock`。未取得锁的进程不运行该存储的 Agent 循环，也不执行启动修复。

## 预算默认值

每 Turn 最多 16 个逻辑主模型 Step、64 个 ToolCall、累计输入 1,048,576 tokens、输出 65,536 tokens、普通模型/工具调用 10 分钟、Turn 硬截止 24 小时。提问等待保留 24h 上限。压缩等辅助调用计入总 token 预算，但不增加主循环 Step。

## 取代关系

本表取代旧“逻辑 Run 原位恢复”术语。Run 不再作为与 Turn 并列的 Agent 公共生命周期；详见 [ADR 0004](docs/student-agent-implementation/adr/0004-direct-turn-step-loop.md)。