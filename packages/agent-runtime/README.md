# 通用 Agent 内核

`@xunjie/agent-runtime` 保存与推进独立 Agent session，不依赖活动、课程、教学工具或模型供应商。依赖仅为 `contracts`、`storage` 与纯 schema 库。场景由 [agents](../agents/README.md) 装配，可信宿主由 [product-runtime](../product-runtime/README.md) 提供。

## 职责与公开入口

- 根导出提供 `createAgentRuntime`、`agentRuntimeMigrations` 及公开 pipeline/operation 类型；`./maintenance`、`./source-closure` 提供维护边界与资源来源校验。
- 内核持有 session、原始/当前输入、Run、步骤、固定 operation、generation/dispatch permit、等待、预算、事件、进度和恢复状态。
- `initialize/accept/run/events/request/sessionSnapshot/snapshot/inputControl/stop/continueRun/respond/resolveWait/assertDispatch` 按真实身份和 session 检查权限；pipeline 提供模型与业务效果，内核不直接调用 SDK 或学习数据库。
- 重试查询原 `requestId` 和固定输入；新的输入、回应、继续与网络重试分别保留身份。停止不因晚结果而复活；未知外部效果通过原 operation 核对，不盲目重放。
- 停止事务同时保留原步骤的取消投递；进程重启或投递失败后只重试这些原操作。owner 确认收到取消后结束内核重试，物理停止的持续核对仍由实际 owner 负责。
- `AgentDispatchPermit` 固定 `sessionId/runId/stepId/operationId/generation`。用户等待可显式声明可被 steering 中断；取消等待不等于学生回应，也不授予业务权限。

内核迁移当前为 v1–v8；[Agent transport storage](../agents/src/transport/session-storage.ts) 在其后组合 chunk 迁移 v9。内核自身不引入 RPC 或分块表。宿主在 reopen、维护和恢复时使用相同 owner 的完整迁移及来源闭包。

## 测试与工程接入

[工程入口](../../docs/student-agent-implementation/engineering-entrypoints.md)规定构建顺序与共享 dist 协调。真实 PG 测试位于 `test/*.runtime.test.mjs`，明确属于 external：

```sh
node scripts/test.mjs agent-runtime --external --list
node scripts/test.mjs agent-runtime --external
```

命令在仓库根执行，实际运行会先准备依赖，需要 Node 24.21.0 及 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向受支持的 PostgreSQL 分发。普通 verify 没有运行这些测试，不能将 0 个 local 文件计为 native 通过。共享构建占用时只列清单，或在统一构建完成后直接对既有 dist 执行选定的 `node --test` 文件。

部署仍使用 `teaching-agent` module ID；源码包名变化不创建新部署模块。旧开发教学 schema 的处理是[显式数据重置](../../docs/deployment.md#旧开发-agent-数据的显式重置)，不属于内核自动兼容。
