# ZCode 供应商与模型配置实现研究

日期：2026-10-15。角色：本轮个人模型接线任务的独立源码研究。本文是实现参考，不是产品基线批准或真实供应商验收。

## 1. 身份、范围与许可

Robert 指定本机 `D:\ZCode`。只读安装产物 `resources/app.asar` 的 ASAR 索引与根 `package.json`，确认它是 `@zcode/desktop` **3.14.0**，`productName=ZCode`、`homepage=https://zcode.z.ai`、作者邮箱域为 `zcode.z.ai`。未读取用户配置、凭据、会话、模型日志，也未启动 ZCode、安装依赖或调用模型。

与该身份相符的一手上游为 [zai-org/ZCode](https://github.com/zai-org/ZCode)，不是搜索结果里的其他同名项目或社区重发行版。官方仓库反链同一官网；本研究固定公开源码提交 **`aac4755666d09fdcd70272fcf063c077a639015f`**，`git ls-remote` 在研究时返回该 HEAD。其 [README](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/README.md) 记录公开源码更新至 3.15.1。因此以下事实属于固定公开源码，不声称本机 3.14.0 二进制实现完全相同。

[LICENSE](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/LICENSE) 是 Apache-2.0，版权署名为 Z.AI Co., Ltd；[NOTICE §四](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/NOTICE.md) 明确第一方源码适用根许可，第三方代码、素材、二进制有独立条款。可以采用有明确来源的第一方小模块；实际复制时保留许可证、版权与需要保留的通知，并标记修改。不能从安装包可读推导其所有内容均可自由复制。本研究没有向 XunJie 复制第三方实现。

## 2. 供应商、模型、选择与执行的分层

| 层 | 固定源码事实 | 对 XunJie 的价值 |
| --- | --- | --- |
| Provider | `access` 与 `api` 分开；API 类型为 `anthropic-messages`、`openai-chat-completions`、`openai-responses`；API 类型、Base URL 与认证决定执行装配 | 保存地址与 Key 不代表支持所有协议；当前 OpenAI Chat 范围应明确标识协议 |
| Model | `properties` 表示上下文、输入输出和工具/结构化输出能力；`optionSpecs` 表示合法推理档位、最大输出和请求映射 | UI 编辑、后端校验与真实发送应消费同一份模型能力，不各维护默认值 |
| Selection | 只有 Provider ID、Model ID 与已选推理档位，不携带 Key、Endpoint 或完整配置 | 浏览器只提交选型；服务端查本人当前配置并固定执行事实 |
| Active Model | 创建时读取 Registry 的完整配置，冻结属性、选项与执行依赖；后续更新不热改在途 Model | 新配置影响下次发送；当前调用的归因、输出和 usage 仍对应接纳时配置 |

依据：[Provider schema](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/provider/src/config/provider-data-schema.ts#L4)、[公共 Model 契约](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/working-memory/provider-refactor/design/model/contract.md#L28)、[创建与鉴权](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/working-memory/provider-refactor/design/registry/model-creation.md#L24)。

配置更新链为 Built-in 与 Personal 合成 Effective Config，再由 Registry 校验。`config-service.ts` 监听来源变化，`registry-service.ts` 刷新 Registry；`provider-node` 提供进程生命周期与可选文件监听。当前 Model 保留旧配置，下一次创建查新配置。依据：[Config service](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/provider/src/config-service.ts#L107)、[Registry service](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/provider/src/registry-service.ts#L81)、[Model 创建的更新边界](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/working-memory/provider-refactor/design/registry/model-creation.md#L82)。

## 3. 能力来源和保存校验

ZCode 已将旧 `models.dev` / Model Catalog / 按 modelId 猜能力的路径退役。当前能力来自显式 Built-in / Personal Model Config Rules；不要把旧设计文件里的 prefix matcher 或旧默认策略作为当前可采用实现。[旧能力设计的退役声明](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/docs/design/v2/model/model-capability-resolution.md)。

当前模型 Schema 要求正整数上下文、正整数最大输出、无空白/无重复的有序推理档位和可编译的映射。编辑界面保留用户稀疏覆盖，清空时恢复继承，而不是把全部推荐值复制成个人覆盖。依据：[共享 Schema](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/shared/src/model-config.ts#L21)、[模型编辑数据校验](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts#L130)。

执行前再次校验推理值属于已声明列表、输出值为正整数且不超过模型上限，并检查图片/PDF/视频/工具/结构化输出能力。非法请求在网络 I/O 前失败，不静默截短、不用其他模型兜底。[实际 Model 实现](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/model.ts#L106)。

对本轮的直接结论：连接测试 `/models` 成功仅证明连通/鉴权及可用 ID；不能据此宣称用户填入的 context、output、low/high/max 都已被供应商验证。能力声明、合法请求投影、实际供应商接纳、浏览器展示要分别留证。

## 4. low / high / max 与真实请求字段

ZCode 公共接口不把三档写死为统一枚举，而是每模型的有序字符串列表。模型的请求映射有唯一权威，先组合绑定/单次选项，再在协议序列化后对最终 JSON Body 应用映射；生成与流式共用该执行链。[Model Option Map](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/working-memory/provider-refactor/design/model/model-option-map.md#L9)。

固定提交的 [Built-in 配置](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/config/provider/zcode-builtin.json) 中，DeepSeek v4.1 Flash 的模型规则声明 `disabled/low/high/max`。其 Chat Completions 的非关闭映射同时表达 `thinking.type=enabled` 与 `reasoning_effort=<选择值>`；Anthropic 映射使用 `thinking.type=enabled` 与 `output_config.effort`；OpenRouter 的站点规则另有覆盖。不能把一种 API 的字段无条件发给另一种。该文件中的能力/数值是 ZCode 的内置声明，不是对所有部署端点的供应商保证。

`maxOutputTokens` 在该契约中表示推理与最终答案共享的生成预算，和上下文窗口是两类概念。未知能力不能用看似精确的显示值伪装成已验证。XunJie 可以采用上述分层语义，但本轮无需引入 ZCode 的完整 CEL 编译器、AI SDK、账号套餐体系；用现有传输内一个小而显式的协议映射更容易保持一致。

特别注意：该项目的 [通用 Chat 兜底说明](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/working-memory/provider-refactor/design/model/model-option-map.md#L139) 会同时发多个推理控制字段，文档明确承认这建立在未知字段被忽略等兼容假设上。XunJie 不应直接照搬这一兜底作为供应商普适事实，更不应在失败后删除字段重试来假装设置已生效。

## 5. 思考流、失联与取消

实际流投影将 `text_start/delta/end` 与 `reasoning_start/delta/end` 分开；reasoning 增量兼容读取 SDK 的 `delta` 或 `text`，保持各自事件。[runner-normalization.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/runner-normalization.ts#L62)。因此没有正文时可能处于真实思考阶段，但单凭正文为空不能下结论；需观察供应商推理/活动事件。XunJie 只需据真实 reasoning 事件显示状态，无需存储或展示内部推理全文。

ZCode **有失联保护**：[`DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS=600000`](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/contracts/src/config/index.ts#L284)。其 [`readNextWithStreamIdleTimeout`](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts#L98) 对每次迭代等待单独计时，收到下一事件后新一轮等待重新开始，并允许非正值关闭该包装层计时。它不是固定总思考时长，也不应概括为整个项目所有网络层都无限等待。

Stop 通过 linked AbortController 传给底层请求，同时把 `AbortSignal` 与 `iterator.next()` 做 race；即使供应商迭代器迟迟不结束，调用方也能立即退出等待。finally 清理 timer/listener。这个短小的生命周期模块适合按 Apache-2.0 归属条件摘用/改写；保留 XunJie 的现有单次调用、不自动重试语义，不能随手带入上游 runner 的重试流程。

XunJie 更适合在原始 HTTP/SSE 数据活动层续期，而不只依赖最终正文：供应商可能只发空白/注释保活或推理片段。若只用正文刷新失联窗口，仍会错误截断正常思考。这是针对本轮传输的采用建议，不声称 ZCode 的 SDK 包装能逐字节观察所有原始保活。

## 6. 本轮采用建议和可复用边界

1. **直接采用接口原则**：一个服务端选型/执行快照同时供独立聊天和 `student_help` 使用；模型 ID、上下文、输出、实际选择的 effort 一路保持，已接纳回合不受后续配置变更影响。
2. **采用小模块行为**：可停止的滑动 idle 等待、统一输入/选项 preflight、reasoning/text 分离、精确归因。若复制源码，记录固定提交、原文件和 Apache-2.0 通知；若独立实现，仅注明设计参考即可，勿虚构为搬运原代码。
3. **避免必要性不足的限制**：不要为 low/high/max 再人为设总思考时长；保留可配置失联保护与用户主动停止。输出预算尊重用户设置和真实协议限制，不能继续用旧课程 4096 或固定 45 秒覆盖个人配置。
4. **避免过度搬运**：不导入 ZCode 的业务账号、套餐网关、遥测、自动重试、工具执行、CEL 全栈或模型猜测历史代码。现有用户批准的公网 HTTPS、加密保存及账号隔离仍有效。
5. **专项验收**：对两处通道捕获脱敏请求投影，覆盖 low/high/max、max output、context、设置后下一回合生效；流夹具覆盖只有 reasoning、只有保活、最终正文、真正失联、主动 stop、EOF 仍无正文、输出截断。对实际启用供应商再验证真实正文；单测和连接成功不替代真实调用。

本研究只新建本文，不修改运行代码、产品/规划/参考规范、原课程库或凭据。后续实施由主 Agent 在本轮已有授权与任务记录下统一落地。
