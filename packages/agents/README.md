# Agent 场景、共享能力与 session v2 传输

`@xunjie/agents` 在 [agent-runtime](../agent-runtime/README.md) 上装配普通学生助手与工作区助手。它依赖 contracts/storage、[model-gateway](../model-gateway/README.md) 和 [learning-space](../learning-space/README.md)，不再导出或构造旧 `createTeachingAgent` / RunDriver。

## 场景与能力

| 入口 | 职责 |
| --- | --- |
| 根入口、`conversation/index` | `createConversationPipeline`：模型段、原生工具结果配对、固定绑定、输入策略、上下文压缩和 continuation |
| `student-assistant/index` | `createStudentAssistant`：普通会话、真实学习查询与明确授权后的个人项目创建；首问不创建 activity |
| `workspace-assistant/index` | `createWorkspaceAssistant`：真实活动、课程帮助策略、固定作品/引用与获准工具 |
| `capabilities/*` | 用户提问、资料/PDF、Skills、显式学生事实和输入政策；只通过所属 owner 的公开 port 获取事实或执行效果 |

普通 session 不要求活动。workspace session 由目录绑定真实 `activityId + target`；输入中的 `context.action` 保留固定 ActionInput、作品原字节与引用。宿主校验主体、活动、原 owner 及 dispatch permit。创建个人项目的权限来自明确用户输入或匹配的真实回应，模型工具参数与呈现行为不构成授权。

[conversation 细节](src/conversation/README.md)与[学生事实投影](src/capabilities/student-facts/README.md)保留各自接口约束。资料 reading 属于资料 owner，图片及 native model segment 属于模型 owner，Agent 不接管它们的存储。

## 公开传输

- `transport/session-service` 提供 `agent.sessions.v2`，RPC 显式 `version: 2`。公开 port 与 JSON contracts 独立于 core 实现和 SDK 类型。
- `transport/session-dependencies` 提供 `agent.dependencies.v2`，按原 session owner、可信连接 source 和原 permit 解析模型/工具工厂。
- `transport/workspace-data` 仅编码真实 workspace/course 领域调用，不包含旧教学 RPC 或另一套运行引擎。
- `transport/session-storage` 组合 core v1–v8 与 chunk v9，提供完整 Agent service 维护与来源闭包；分块机制来自 storage。

浏览器只能经可信 HTTP 宿主取得身份；`initialize` 由受认证宿主授权，`resolveWait` 只向可信服务开放。版本不兼容和未支持 operation 在写入前拒绝，不重派给旧协议。`conversation` 是产品投影，`snapshot` 是独立调试读取。

装配生命周期由 [product-runtime](../product-runtime/README.md) 的 `createProductAgent` 管理：defer recovery，participant reopen/resume 后放行。部署 module ID 继续为 `teaching-agent`；HTTP、能力与显式旧开发数据重置见[部署说明](../../docs/deployment.md)。

## 验证边界

仓库根 `node scripts/test.mjs agents --list` 列本地行为测试，`--external --list` 列真实 PG 测试；运行时移除 `--list`，会先准备依赖。统一 verify 只运行本地组。新 session/dependency/storage、资料、Skills 与两场景的 PG 测试均为 external，需 `XUNJIE_PRODUCT_POSTGRES_BIN`。构建与静态检查不替代真实宿主、浏览器、供应商或跨机验收；具体结果由本次实际执行记录说明。
