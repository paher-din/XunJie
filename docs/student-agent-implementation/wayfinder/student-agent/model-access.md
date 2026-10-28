# 三协议模型接入与原生续接

来源：[GitHub 最终决议](https://github.com/paher-din/XunJie/issues/115#issuecomment-6346123203)。已于 2026-10-29 收录最终决议正文。正文中的“本次”“尚未”等状态指该票收束时；研究结论、版本与实测不等于当前实现或新的验收结果。后续确认见[本地决议索引](README.md#后续确认)。

本地配套材料：[端点评估与方案取舍](../../references/2026-10-23-model-endpoint-assessment.md) · [SDK 源码研究](../../references/2026-10-22-model-protocol-sdk-research.md) · [PDF 能力研究](../../references/2026-10-22-agent-pdf-capabilities-research.md) · [HTTP 探针记录](../../references/2026-10-23-model-endpoint-probe-results.json) · [SDK 探针记录](../../references/2026-10-23-model-sdk-probe-results.json)。

## 原决议

本票完成模型连接层的技术判断。Robert 已确认首批端点、图像必需、PDF 阅读与引用范围，并确认采用按页读取工具；模型调用层选型由 Robert 明确委托 Agent 从第一性原理判断。这里决定接入边界，不决定完整教学调度框架。

### 决策

**三协议采用直接协议 SDK 加薄 adapter。** `openai@7.42.0` 承接 Chat Completions / Responses，`@anthropic-ai/sdk@1.1.0` 承接 Anthropic Messages；它们均连接已配置的第三方服务。项目实现依赖尚未变更，这组版本是首批互操作基线。

理由：本项目必须掌握原生 reasoning、签名、工具配对和完整助手内容。通过 Core messages 再重建原生历史会增加一套保真转换；混用 provider 与直接 SDK 还需同时维护两种消息表示。直接 SDK 保留原生表示，薄 adapter 只负责方言参数、必要流聚合、应用事件/用量/错误归一化及能力规则。代价是自行维护这些有限转换；教学调度和工具执行不放进 adapter。

AI SDK Core 并非不能保留专有数据，已测 Chat / Messages provider 样本通过。但固定 `@ai-sdk/openai@4.0.99` 在官方 DeepSeek Responses 上丢掉非空 reasoning，在 Command Code Responses 上遇到 `function_call` added 事件缺少 `arguments` 而报流校验错误。HTTP 200、可读回答或正确 nonce 都不足以证明原生保真。两条 Responses 的直接 SDK 样本及随后补测的 Chat / Messages 直接 SDK 样本均完成原生回放。

### 首批实际路线与能力

| 实际服务及型号 | 协议 | 实测结果 |
| --- | --- | --- |
| DeepSeek 官方 `deepseek-flash` | Chat | 流式工具、完整往返、reasoning、基础图像、工具产图链路、客户端 abort 通过相应样本；标准 `json_schema` 入口拒绝 |
| 同上 | Responses | 同上；原生 reasoning item 可回放；有效 schema 样本通过、无效 schema 被拒绝；无服务端存储续接 |
| 同上 | Messages | thinking/signature 完整回放；基础图像和工具结果图像可用；`output_config.format` 未被证实执行 schema 约束 |
| Command Code `deepseek/deepseek-v4.1-flash` | Chat | 工具、reasoning、基础图像、工具产图链路、客户端 abort 通过相应样本；无效 schema 仍被接受，不能标为 strict 支持 |
| 同上 | Responses | 原生 summary/items 回放、工具与基础图像样本通过；有效 schema 样本通过、无效 schema 被拒绝 |

Command Code 实时模型目录只列 Chat / Responses，目标型号的 Messages 路线记为不支持，未使用别的型号替代验证。官方 DeepSeek 三协议在 thinking 开启时强制指定具体工具均被拒绝，`auto` 则完成往返。模型别名、参数模式、SDK/adapter 版本和验证日期均属于能力证据。

### 原生续接与执行约束

- 可见会话、运行事实和原生续接记录分开；原生内容按路线保存，保留顺序、完整块与调用身份。连接层返回模型输出和工具意图，运行层负责权限、执行、结果和教学判断。
- 新工作区观察带版本与来源追加；执行前重新核对实际状态。改 system/工具集合、压缩历史或切路线时，首版在工具已结清的步骤边界开启新的原生续接段；不改写旧签名块，不跨服务搬运 response/tool ID。明确可共享的文件引用另按服务规则处理。
- DeepSeek Responses 重发原生历史，不依赖 `previous_response_id`。半截参数、失败流或终态缺失不能执行工具或记为成功。SDK 自动重试设为 0，由运行层统一控制；已完成结果复用，副作用结果未知先核实。
- 必需能力不足且没有预先配置的替代策略时明确失败，不静默换协议/模型。JSON mode、应用校验和原生 strict schema 分别记录。客户端 abort、停止工具与撤销修改分开；缺失最终 usage 记为未知。

### PDF

采用文档工具按需读取相关页，返回文字、页图及文档版本/页序引用，回答能回到原页。扫描页先走视觉读取，确需全文搜索时再加 OCR；不以向量库为前置。首版不含 PDF 生成、编辑、表单填写。

本机 PDF skill 使用解析/渲染工具组合，Claude Code 的分页 Read 使用 `pdftoppm`；所查 OpenCode / Gemini CLI 路径主要把 PDF 字节直接交给模型。因此 Agent PDF 能力不必依赖目标模型的原生 PDF 接口。具体库与执行位置交由[课程工具与生成内容：接入、运行宿主和状态恢复](https://github.com/paher-din/XunJie/issues/117)，引用交互交由[工作区交互与状态：自动保存、选区引用、执行依据和提交](https://github.com/paher-din/XunJie/issues/116)。

### 证据与交接

已发布的研究材料固定在提交 `d496cd0c6d7d38f9aa9c94ae4fbc6c86dd1cceaf`，研究分支为 `codex/model-protocol-assessment`，未合入主分支：

- [端点评估、方案成本比较和实现约束](https://github.com/paher-din/XunJie/blob/d496cd0c6d7d38f9aa9c94ae4fbc6c86dd1cceaf/docs/references/2026-10-23-model-endpoint-assessment.md)
- [固定版本 SDK 源码调查](https://github.com/paher-din/XunJie/blob/d496cd0c6d7d38f9aa9c94ae4fbc6c86dd1cceaf/docs/references/2026-10-22-model-protocol-sdk-research.md)
- [四种 Agent PDF 实现调查](https://github.com/paher-din/XunJie/blob/d496cd0c6d7d38f9aa9c94ae4fbc6c86dd1cceaf/docs/references/2026-10-22-agent-pdf-capabilities-research.md)
- [raw HTTP 脱敏记录](https://github.com/paher-din/XunJie/blob/d496cd0c6d7d38f9aa9c94ae4fbc6c86dd1cceaf/docs/references/2026-10-23-model-endpoint-probe-results.json)及[固定 SDK 脱敏记录](https://github.com/paher-din/XunJie/blob/d496cd0c6d7d38f9aa9c94ae4fbc6c86dd1cceaf/docs/references/2026-10-23-model-sdk-probe-results.json)

共 58 次有记录的 raw HTTP 请求、1 次额外错误诊断、20 次有记录的 SDK 请求。五条实际路线都有直接 SDK 工具往返与原生续接样本；图像和工具产图使用合成 PNG。流错误后的 Command Code provider 续接仅作无副作用诊断，不算通过。密钥、推理正文和签名未进入公开记录。

未验收：生产工程构建/测试、浏览器与教学效果、实际 PDF 解析渲染/引用、复杂电路图与扫描质量、SDK 图像历史、长历史、跨路线迁移、进程重启、服务端取消计费和故障恢复。以上作为实现阶段验收项，不能以本票关闭代替通过。完整内核与部署继续由[总体架构与复用取舍：模块边界、Agent 内核和部署方式](https://github.com/paher-din/XunJie/issues/119)决定。
