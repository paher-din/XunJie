# 通用 Agent 内核

`@xunjie/agent-runtime` 保存与推进独立 Agent session，不依赖活动、课程、教学工具或模型供应商。依赖仅为 `contracts`、`storage` 与纯 schema 库。场景由 [agents](../agents/README.md) 装配，可信宿主由 [product-runtime](../product-runtime/README.md) 提供。

## 职责与公开入口

- 根导出提供 `createAgentRuntime`、`agentRuntimeMigrations`、Turn/Step 主循环与模型适配器类型；`./maintenance`、`./source-closure` 提供维护边界与资源来源校验。
- 内核持有 session、Turn、Step、Attempt、ToolCall、Question、通知、输入、预算、事件与宿主独占状态。同一 Session 最多一个活跃 Turn；完整模型响应持久化后整批派发工具，当前串行执行。
- 主循环是唯一的执行路径：`runTurn → runStep → generate → executeTools`。不存在公开的 `start/resume/advance/recover` 调度阶段，也不在原执行位置续跑。
- `initialize/submit/answerQuestion/stop/continueSession/turn/events/conversation/sessionSnapshot/request/inputControl/registerNotification/recordProgress/assertDispatch` 按真实身份和 session 检查权限；场景提供模型与工具，内核不直接调用 SDK 或学习数据库。
- 重试查询原 `requestId` 和固定输入；新的输入与网络重试分别保留身份。停止在同一事务标记 Turn 并保存取消意图，不因晚结果复活；进程中断后旧 Turn 收尾为 interrupted，用户手动继续创建新 Turn。
- 最新用户输入已接纳后，修订须先确认没有活跃 Turn，再以同一输入的新版本创建新 Turn；模型历史从该输入处重新构建，旧提问的回应退出当前上下文。原始请求、执行事实和回执保留，界面按修订事件更新时间而保持消息顺序。
- `AgentDispatchPermit` 固定 `sessionId/runId/stepId/operationId/generation`。`assertDispatch` 只读校验活跃 Turn、执行中的 Step 与预算期限，是跨机适配器的派发前检查，不是循环阶段，也不向浏览器开放。
- 模型网关按会话解析（`ModelGatewaySource`），同一内核可为多个真实身份提供各自的模型绑定；原生响应续接与压缩 segment 由适配器管理。

内核迁移当前为 v1–v9；[Agent transport storage](../agents/src/transport/session-storage.ts) 在其后组合 chunk 迁移 v10。内核自身不引入 RPC 或分块表。宿主在 reopen、维护和恢复时使用相同 owner 的完整迁移及来源闭包。

## 测试与工程接入

[工程入口](../../docs/student-agent-implementation/engineering-entrypoints.md)规定构建顺序与共享 dist 协调。真实 PG 测试位于 `test/*.runtime.test.mjs`，明确属于 external：

```sh
node scripts/test.mjs agent-runtime --external --list
node scripts/test.mjs agent-runtime --external
```

命令在仓库根执行，实际运行会先准备依赖，需要 Node 24.21.0 及 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向受支持的 PostgreSQL 分发。普通 verify 没有运行这些测试，不能将 0 个 local 文件计为 native 通过。共享构建占用时只列清单，或在统一构建完成后直接对既有 dist 执行选定的 `node --test` 文件。

部署仍使用 `teaching-agent` module ID；源码包名变化不创建新部署模块。旧开发教学 schema 的处理是[显式数据重置](../../docs/deployment.md#旧开发-agent-数据的显式重置)，不属于内核自动兼容。

## 旧教学会话导入

产品宿主的离线迁接将旧版可见聊天存为 `history-imported` 事件，并初始化可移植的文本历史。
该事件包含原活动与源摘要，重试必须使用相同摘要，且仅允许写入空 Session。原始旧 owner 与完整备份保留。
历史思考、提问和工具结果由产品投影供查看；它们不创建内核 Turn、待执行工具、通知或供应商续接链。
旧输入只读，新输入按正常 Turn 执行。继续聊天只传递可见文本，不重放旧工具。完整读包含归档，增量读只传递新增事实。
