# 三协议模型接入：固定版本 SDK 与原生续接保真研究

> **状态：研究事实，不是已批准方案。** 议题日期为 2026-10-22，整理于 2026-10-23。文中的选型和验证建议尚未由负责人确认。
>
> **本文不包含端点实测。** 本研究仅浏览官方文档、下载并检查官方 npm 发布包源码；未读取凭据、调用模型、运行 SDK fixture、安装项目依赖、操作 GitHub 或提交代码。主线端点实验另见 [端点评估](2026-10-23-model-endpoint-assessment.md)，两份文档的证据层级不得混用。
>
> **当前范围：** 首批 DeepSeek 官方 `deepseek-flash` 与 Command Code 的 `deepseek/deepseek-v4.1-flash`；图像是首版要求。官方 OpenAI/Claude 的能力用于解释协议和适配器，不代表实际接入路线拥有这些能力。PDF 专项由主线另行整合。

> **后续主线结果：** 本源码调查完成后，主线补做了固定版本 SDK 的真实往返，并选择三协议直接 SDK 加薄 adapter。官方 DeepSeek Responses 的内容丢失得到实测确认；Command Code 的 OpenAI provider 路线还出现流事件校验失败。五条实际路线的直接 SDK 样本均完成工具与原生续接。详见 [端点评估](2026-10-23-model-endpoint-assessment.md#固定版本-sdk-的真实往返) 和 [脱敏记录](2026-10-23-model-sdk-probe-results.json)。以下“本研究未测”仅限定本源码调查的独立证据，不表示整个议题仍未测试。

## 可供本轮决策使用的结论

1. **原生协议可用，不等于选定 SDK 能无损承接。** 固定版本 `@ai-sdk/openai@4.0.99` 的 Responses 适配器没有将 `response.reasoning_text.*` 映射为 reasoning 输出，也没有 DeepSeek `reasoning.content[{type:"reasoning_text",text:…}]` 的回传路径。其 OpenAI reasoning 机制围绕 `summary`、`encrypted_content` 和存储项引用构建。仅修改 `baseURL` 不足以满足官方 DeepSeek 的 reasoning 往返。[S-OA] [D-DR] [D-DRA]
2. **Core 本身允许保留专有数据。** 仓库锁定的 `ai@7.0.136` 已将输出 part 的 `providerMetadata` 搬入下一轮 `response.messages` 的 `providerOptions`；reasoning 文本为空也不因此删除该 part。实际风险在 provider 转换、应用存储和下一轮重建，不应概括成“AI SDK 只能保存公共文本”。[S-AI136]
3. **Chat 路线已有更贴合的候选。** 仓库锁定的 `@ai-sdk/deepseek@3.0.63` 会保留 V4 reasoning、为没有 reasoning part 的 assistant 补 `reasoning_content:""`，并支持用户图像及工具结果图像转换。`@ai-sdk/openai-compatible@3.0.75` 也能回传非空 `reasoning_content`，但空字段和工具图像默认行为不同。[S-DS] [S-OC]
4. **Messages 的 thinking/signature 有明确保留路径，结构化输出则不能照搬 Claude。** `@ai-sdk/anthropic@4.0.85` 能读取 thinking/signature 并重建原生块。对非 Claude 模型，默认的 JSON 输出回退使用 JSON 工具；显式 enabled thinking 下，强制工具选择会降级为 `auto` 并产生 warning。DeepSeek 文档只声明 `output_config.effort`，不能把 JSON-tool 回退或响应 200 当作原生 schema 约束。[S-AN] [D-DA]
5. **Command Code 与 DeepSeek 官方必须分别验证 SDK 保真。** Command Code 文档要求按每个模型的 `supported_endpoints` 选择路线；即使某条路线返回 summary 事件、事件名更接近 OpenAI 适配器，也不能证明 item、metadata、下一轮回放全部等价。具体端点事件与实际支持路线由主线报告给出。[D-CC] [S-OA]

以上是文档和源码判断；本文没有声称 SDK 端到端测试通过。

## 固定版本与证据边界

本地核对的 HEAD 为 `1f29715edbabc1997bbbb61bd73319a56becd8a4`。`apps/teaching/package.json` 与 lock 固定 `ai@7.0.136`、`@ai-sdk/deepseek@3.0.63`；三个比较中的 provider 和两个直接协议 SDK 均不在该工程直接依赖中。

| 包 | 本次实际核对版本 | 与仓库关系 | 固定发布元数据 |
| --- | --- | --- | --- |
| `ai` | **7.0.136** | 仓库基线，已取得发布源码 | [registry](https://registry.npmjs.org/ai/7.0.136) |
| `@ai-sdk/deepseek` | **3.0.63** | 仓库基线，已取得发布源码 | [registry](https://registry.npmjs.org/@ai-sdk/deepseek/3.0.63) |
| `ai` | **7.0.148** | 另行检查的比较版本，不代表已升级 | [registry](https://registry.npmjs.org/ai/7.0.148) |
| `@ai-sdk/openai` | **4.0.99** | 候选适配器 | [registry](https://registry.npmjs.org/@ai-sdk/openai/4.0.99) |
| `@ai-sdk/openai-compatible` | **3.0.75** | 候选适配器 | [registry](https://registry.npmjs.org/@ai-sdk/openai-compatible/3.0.75) |
| `@ai-sdk/anthropic` | **4.0.85** | 候选适配器 | [registry](https://registry.npmjs.org/@ai-sdk/anthropic/4.0.85) |
| `openai` | **7.42.0** | 直接协议 SDK | [registry](https://registry.npmjs.org/openai/7.42.0) |
| `@anthropic-ai/sdk` | **1.1.0** | 直接协议 SDK | [registry](https://registry.npmjs.org/@anthropic-ai/sdk/1.1.0) |
| `@ai-sdk/provider` / `@ai-sdk/provider-utils` | **4.0.31 / 5.0.65** | 三个候选 provider 的发布依赖；辅助源码核对 | [provider](https://registry.npmjs.org/@ai-sdk/provider/4.0.31)、[utils](https://registry.npmjs.org/@ai-sdk/provider-utils/5.0.65) |

版本取自本轮实际 registry 响应，源码取自对应 `dist.tarball`；下载包的 SHA-512 均与该版本 `dist.integrity` 核对一致。**上述版本没有取得失败项。** 不以滚动网页上的“当前版本”替代仓库 lock，也不将候选 provider 与 `ai@7.0.136` 的组合说成已编译或运行验证。

`openai@7.42.0` 的 registry `gitHead` 为 `802a3239e91b46c408c350e11ecff84b76fb17d4`；其余比较发布元数据没有提供 `gitHead`，故本文以**固定 npm 版本内的源码**为依据，不杜撰源码 commit。Core `7.0.136` 与 `7.0.148` 的 `src/generate-text/to-response-messages.ts` 本次比较内容相同；这不证明两版整体等价。

本地实现另外核对了 `apps/teaching/server/tutoring/openai-compatible.ts` 与 `server/personal-agent/model-protocol.ts`：当前 transport 手写 `/chat/completions`，JSON 模式发送 `json_object`，返回以 text/usage 为中心；reasoning 识别用于活动指示。主线提供的云配置和端点结果不属于本研究独立核验范围。

## 协议能力对照：只说明各官方契约

| 维度 | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages |
| --- | --- | --- | --- |
| 客户端工具往返 | assistant `tool_calls` → tool `tool_call_id` | `function_call` → `function_call_output`，按 `call_id` 配对；item ID 是另一标识 | assistant `tool_use` → user `tool_result`，按 `tool_use_id` 配对 |
| 流式输出 | choices/delta；工具参数分片；通常 `[DONE]` 结束 | typed SSE；item/文本/参数事件及 completed/incomplete/failed | message/content-block 生命周期；`input_json_delta`、thinking/signature delta |
| 结构化输出 | `response_format` 的 JSON/schema 模式与 strict tools 分开 | `text.format` 与 strict tools 分开 | `output_config.format` 与 `strict` tools 分开；限支持模型 |
| reasoning 续接 | 不能套用 Responses 的加密 item 语义；第三方 `reasoning_content` 是方言 | 完整 output items；可用服务端链或手动历史；加密 reasoning 不等于可见 summary | thinking/signature、redacted blocks 保留在 assistant 内容中 |
| 取消 | 请求 signal/流中断 | 请求中断；另有 background response cancel/retrieve | 请求 signal/stream abort；不能凭消息 ID 推定可恢复生成 |
| 用量/失败 | stream usage 末块可能因中断缺失；有 finish_reason 与 HTTP 错误 | usage、status、incomplete/error；200 后仍可能有失败事件 | message_delta usage 是累计量；200 后也可能收到 error 事件 |
| 图像 | 支持模型使用 image content；不能等同图片生成 | 支持模型接受 input_image；图片生成工具是另一能力 | image 输入/工具结果；Claude vision 文档不提供原生图片生成 |

依据：[OpenAI function calling][D-OT]、[Chat API][D-OC]、[Responses reasoning][D-OR]、[OpenAI streaming][D-OS]、[structured outputs][D-OJ]、[background][D-OB]、[vision][D-OV]；[Claude 工具结果][D-AT]、[streaming][D-AS]、[structured outputs][D-AJ]、[thinking 往返][D-AW]、[vision][D-AV]；直接 SDK 固定源码 [S-NO] [S-NA]。

### 首批路线的文档约束

| 路线 | 可依据的能力 | 不能据协议名称推定的能力 |
| --- | --- | --- |
| DeepSeek Chat | 工具、流式 `reasoning_content`、JSON mode、图像；带 tools 的 thinking 历史要求完整回传 reasoning | Chat 原生 `json_schema`、强制工具与 thinking 的任意组合；strict tool 文档另指向 `/beta` |
| DeepSeek Responses | function 工具、typed stream、明文 reasoning content、`text.format` 的 schema 模式、图像 | 服务端会话/response chain、加密 reasoning、OpenAI 内建工具全集 |
| DeepSeek Messages | text/image/thinking/tool_use/tool_result | Claude 的原生 JSON format、redacted thinking、document；`is_error` 的官方 Claude 语义也不能照搬 |
| Command Code | 文档提供 Chat/Responses/Messages 入口；每个 model 的 `supported_endpoints` 决定可选路线 | 不能用全站三个入口推定目标 DeepSeek 模型也有 Messages；不能推定网关与官方采用相同 reasoning 方言 |

DeepSeek 依据：[Chat API][D-DC]、[thinking][D-DT]、[JSON mode][D-DJ]、[strict tools][D-DTools]、[Responses API][D-DRA]、[兼容说明][D-DR]、[Messages 兼容说明][D-DA]、[vision][D-DV]。Command Code 依据：[Provider API][D-CC]。

目标模型的实时目录、raw 工具往返、reasoning、图像和 thinking/forced-tool 组合的实测结论统一由主线端点评估报告负责。本文不复制该矩阵；对某个工具选择组合的限制，不能泛化为“不支持工具”。

## SDK 保真判断与可替代边界

### 1. `@ai-sdk/openai@4.0.99`：区分 Chat 和 Responses

`createOpenAI(...)(model)` / `.languageModel(model)` 默认创建 Responses 模型；Chat 必须显式用 `.chat(model)`。改 URL 不改变协议工厂。[S-OA]（`openai-provider.ts:323–368`）

**官方 DeepSeek Responses 有三个独立缺口：**

- **接收事件：** schema 明确建模 `reasoning_summary_*`；`reasoning_text.*` 命中 unknown-event fallback，变成 `unknown_chunk`，不进入标准 reasoning 文本输出。请求开启 raw chunks 能旁路保留原事件，但不改变此语义转换。[S-OA]（`openai-responses-api.ts:840–856,1479–1488`；`openai-responses-language-model.ts:2765–2828`）
- **接收 item：** 非流式 reasoning schema 要求 `summary`，没有建模明文 `content`。若返回 `summary:[]` 加 `content`，规范化结果不含该 content；若不返回所需 summary，则存在校验失败风险。**具体返回形状对应哪条分支，须用主线脱敏样本做 fixture，本文未运行。**[S-OA]（`openai-responses-api.ts:1678–1687`；`openai-responses-language-model.ts:932–948`）
- **下一轮：** converter 默认以 `store:true` 解释历史，有 item ID 时可产生 `item_reference`；设置 `store:false` 后则构造 `summary/encrypted_content`。两条都不是 DeepSeek 接受的 `reasoning.content`。设置 `previousResponseId` 还会使 converter 跳过已有 ID 的 reasoning；DeepSeek 是 stateless，服务端不会替客户端恢复这些历史。[S-OA]（`openai-responses-language-model.ts:424–442`；`convert-to-openai-responses-input.ts:1266–1350`；D-DR）

**不能只删 unsupported 参数。** DeepSeek 文档说明未支持的顶层参数会被忽略，因此 `store/include` 不一定触发报错；但客户端仍可能按错误的存储假设生成后续 input。请求成功无法证明历史被利用。[D-DR]

模型家族判断也有影响：该适配器依据模型能力和 `forceReasoning` 决定是否序列化 reasoning 设置；当 `store:false` 且按 reasoning 模型处理时还自动请求 `reasoning.encrypted_content`。这不是 DeepSeek 方言的能力探测。模型别名、`forceReasoning`、system/developer 映射应一起核对。[S-OA]（`openai-responses-language-model.ts:305–371,424–442,593–597,654–669`）

**边界建议，待确认：** 官方 DeepSeek Responses 需专门的请求/响应转换或直接协议 SDK；仅 `baseURL`、provider options 或开启 raw chunks 不足以满足无损往返。Command Code summary 方言单独做 fixture，不能沿用官方缺口的全部结论，也不能仅凭事件名判定通过。

### 2. `@ai-sdk/openai-compatible@3.0.75`：适用于 Chat 方言，不是三协议适配器

读入 `reasoning_content ?? reasoning`，生成 Core reasoning part；回放时拼接 reasoning，并在非空时写入 `reasoning_content`。所以当前固定版不是“只显示 reasoning、不回传”。但它没有通用 `reasoning_details` 无损映射；专有字段需要 extractor/转换逻辑。[S-OC]（`openai-compatible-chat-language-model.ts:382–420`；`convert-to-openai-compatible-chat-messages.ts:231–290`）

三个默认值会改变能力表现：`includeUsage` 默认不开启；`supportsStructuredOutputs` 默认 false，JSON schema 请求可能转为 `json_object`；`supportsMultiPartToolContent` 默认 false，工具内容数组被 JSON 字符串化。对于工具返回的截图，字符串中的 base64 不能当作真实图像输入。DeepSeek Chat API 文档已列出 tool content 图像，启用开关仍需针对所选服务验证。[S-OC；D-DC；D-COMP]

`metadataExtractor` 可读取原始响应/流 chunk；`transformRequestBody` 可改变请求；provider 命名空间下的额外顶层参数也可传入。**提取到结果 metadata 不等于自动把它放回对应 assistant part。** 如需支持 `reasoning_details`、签名或未知 blocks，必须定义关联关系及反向序列化，不能仅记录顶层 JSON。[S-OC]

### 3. 仓库已有 `@ai-sdk/deepseek@3.0.63`

其模型判断包含 `modelId.includes('deepseek-v4')` 与 `startsWith('deepseek-flash')`。V4 分支保留较早 assistant reasoning，并在缺失时补空 `reasoning_content`；兼容 provider 仅输出非空 reasoning，两者不完全等价。若网关另换 alias，仍需验证命名判断。[S-DS]（`is-deepseek-v4-model.ts`；`convert-to-deepseek-chat-messages.ts:283–355`）

图像转换包括 image URL、内联数据和 file reference；含图像的工具结果也转为内容数组。这使它成为首批 Chat 验证的合理候选，但它不是 Responses/Messages provider。其 API 支持与对应参数能否在端点生效仍是两件事。[S-DS]（chat converter 与 `deepseek-provider.ts`）

另有明确的版本差异提示：该版本在 thinking 模式下省略 `top_p`，而当前官方 Flash Responses/兼容说明描述 thinking 模式可接受该参数。不要将 SDK 能接收某个选项等同于实际发送，也不要因此泛化所有采样配置；如首版不需要此设置，可列为后续兼容项。[S-DS]（`deepseek-chat-language-model.ts:376–378`；D-DRA）

### 4. `@ai-sdk/anthropic@4.0.85`

非流式输出将 thinking 的 `signature` 放入 `providerMetadata.anthropic.signature`，redacted block 放入 `redactedData`；下一轮 converter 据 metadata 重建原块。无签名/无 redactedData 的 reasoning 会产生 unsupported metadata warning 并不按 thinking 发送。thinking delta 与 signature delta 是不同事件，应用不能只保存可见文字。[S-AN]（`anthropic-language-model.ts:1352–1373,2810–2823`；`convert-to-anthropic-prompt.ts:820–870`）

非流式 parser 对 thinking 的 signature 要求字符串。该要求、流中签名到达时机和持久化后的回放应一起测试；**本研究没有验证该 adapter 对真实 DeepSeek Messages 的往返结果。**[S-AN]（`anthropic-api.ts:831–835`）

非 Claude ID 的能力默认 `supportsStructuredOutput:false`，auto 模式可能构造名为 `json` 的工具代替原生 format。显式 `thinking.type:"enabled"` 会令工具准备逻辑将 `required` 降为 `auto`；指定工具也可能降为仅提供该工具的 `auto`。这可能避免 forced-tool HTTP 400，代价是工具不保证被调用，必须检查 warnings 和实际结果。[S-AN]（`anthropic-language-model.ts:480–523,1089–1100,3514–3528`；`anthropic-prepare-tools.ts:489–544`）

不应通过伪装成新 Claude 模型来“打开能力”：SDK 会按 Claude 型号选择默认设置，DeepSeek 又会将某些 Claude alias 映射到其他模型；该办法改变的不只是类型检查。`outputFormat` 不能让 DeepSeek 获得未声明的 `output_config.format` 支持。[S-AN；D-DA]

还有 URL 拼接差异：AI SDK provider 默认在自定义 baseURL 后加 `/messages`；直接 Anthropic SDK 请求路径为 `/v1/messages`。DeepSeek 直接 SDK 示例 baseURL 为 `https://api.deepseek.com/anthropic`，对应 AI SDK 候选配置应核对 `https://api.deepseek.com/anthropic/v1`。以最终请求 URL 为验收依据。[S-AN]（`anthropic-language-model.ts:1194–1195`；S-NA：`resources/messages/messages.ts:116`；D-DF）

### 5. 直接 SDK 与 Core 各自替代什么

| 方案 | 能替代的工作 | 仍由应用负责 |
| --- | --- | --- |
| Core + 匹配 provider | 调用、SSE 映射、工具参数处理、schema 结果验证、通用错误/usage、metadata 往返 | route 能力记录、原生数据持久化、方言差异、业务工具副作用与重放策略 |
| `openai@7.42.0` | Chat/Responses 原生请求与响应对象、原始流、signal、API error；Responses retrieve/cancel 等官方资源 | DeepSeek 特有 Chat 字段的类型扩展；完整历史与 native event reducer；端点不支持的 API 仍不可用 |
| `@anthropic-ai/sdk@1.1.0` | Messages 原生 content blocks、流聚合/`finalMessage()`、signal/abort、API error | 第三方字段子集、续接历史、工具执行、结构化输出降级 |

直接 `openai` SDK 的固定类型已包含 `ResponseReasoningItem.content` 和 `response.reasoning_text.delta/done`，其底层 stream 解析会产出 JSON 事件；这是官方 DeepSeek Responses 的更直接表示路径。**不要把 `output_text` 快捷字段当作完整 response，也不要假设所有高阶聚合 helper 对第三方事件均无损。** 本次未运行 helper 对照测试。[S-NO]（`resources/responses/responses.ts:7480–7534,7748–7785`；`core/streaming.ts:132–168`）

两个直接 SDK 都有自动重试配置；固定版本默认最大重试数为 2。Core/运行时若再包一层重试，必须区分一次请求重试和已经执行工具后的整个步骤重放。取消 signal 不等于撤回已经完成的本地工具副作用，也不证明上游停止计费。[S-NO]（README retries/cancellation；S-NA：`client.ts:978–993,1859–1869`；工程推论）

## 应保存什么，什么不能直接跨 route 搬运

这里的 route 是建议中的应用标识：服务商、实际 API origin/path、账户范围、model、协议与方言配置的组合；不是任何 SDK 已提供的统一身份。

| 数据 | 固定 SDK 可保留的路径 | 回放/跨 route 边界 |
| --- | --- | --- |
| DeepSeek Chat reasoning | DeepSeek/compatible provider 的 reasoning part → `reasoning_content` | 保存完整文本与所属 assistant；不能改名成 Claude signature 或 OpenAI encrypted content |
| DeepSeek Responses reasoning | 直接 SDK 的原生 `content`/reasoning_text 事件；OpenAI provider 只能用 raw 旁路留档 | 当前 OpenAI provider 的标准转换不能完成相同语义回传 |
| OpenAI Responses 原生状态 | responseId、itemId、reasoningEncryptedContent；text phase/annotations、部分工具 metadata | response/item/file/container ID 属于服务端对象；不能换服务商、账户后沿用引用。加密内容不能当可见文本转换 |
| Anthropic thinking | signature/redactedData 与 thinking 文本；流末签名 metadata | 内容、顺序及必要前缀需保留。DeepSeek 不支持 redacted_thinking；不能转发 Claude redacted block |
| 工具调用/结果 | toolCallId、toolName、input/output、provider metadata | 不能丢配对 ID、改变块顺序或将 server-executed 工具误当待执行工具 |
| 图像及文件引用 | 多模态 part、实际文件内容或 provider reference | 同一服务商的显式共享规则才允许复用 ID；不是所有 route 都不能复用，也不是同协议即可复用 |
| usage、finish、warnings | 各 provider 的 usage.raw、raw finish 与 metadata；raw chunks 可补诊断 | 是运行证据；不要当续接 input 自动灌回。缺失 usage 不能解释为 0 |

映射依据：[S-AI136] [S-OA] [S-OC] [S-AN] [S-DS]。续接约束依据：[OpenAI reasoning][D-OR]、[Claude thinking 往返][D-AW]、[preserved thinking][D-AP]。

有两个不能简化的例外：DeepSeek Files 文档明确同账户 keys 共享文件，可跨其 API family 引用，Messages 路径另要求 Files beta header；所以“所有 native metadata 一律不可跨 route”过度绝对。另一方面，Claude 当前部分模型存在模型/账户/前缀绑定，可能丢弃不兼容 thinking 而仍返回成功；不能用一次 HTTP 200 推定原生续接成功。[D-DF] [D-AP]

**尚未批准的存储建议：** 同时持久化可供 UI 使用的通用 parts，以及带 route/version 的原生续接数据；输出后到下一请求之间做 round-trip 校验。跨 route 时重新构建可移植上下文，只在有明确映射与证据时迁移专有状态。不能用 UI 过滤、摘要或删空块的结果作为唯一模型历史。

## 取消、错误、用量与结构化输出的关键丢失风险

- **流完成条件不能只检查 text。** Chat 的 finish/usage、Responses 的 completed/incomplete/failed、Messages 的 message_stop/error 是不同契约。终止事件缺失时不应将已有文本认定为完整成功。[D-OC] [D-OS] [D-AS]
- **reasoning 完成态要晚于文本片段保存。** OpenAI 原生 SDK 注释要求使用 `response.output_item.done` 中最终加密内容；added 事件中可能不完整。Anthropic signature 可能在 thinking 文本之后到达，甚至 thinking 文本为空。DeepSeek 的明文 reasoning 则需完整聚合回放。[S-NO]（`responses.ts:7487–7495`；D-AS；D-DT）
- **usage 要留 raw 和完整性状态。** Anthropic message_delta 是累计量，不能逐块累加；Chat 中断可能收不到末尾 usage。Core `usage.raw` 与 provider 原始 usage 有助于保留 cache/reasoning 字段，但跨步骤 totalUsage 不是原始账单对象。[S-AI136]（`types/usage.ts:67,100,118`；S-OA/S-OC/S-AN 的 usage converter；D-OC；D-AS）
- **错误有 HTTP 与流内两层。** provider-utils 的 `APICallError` 保存 status、headers、body 等；接入时仅捕获开始调用的 Promise 错误不足以处理 stream error。对第三方新增事件/错误形状，raw 与 normalized 结果要一起比对。[S-UTIL]（`response-handler.ts:130–172`；S-OC：chat model `587–609`；D-AIERR）
- **schema、JSON mode、本地验证不可合并为一个布尔值。** prompt 要求 JSON、`json_object`、tool 模拟输出、原生 schema 约束和应用解析成功是不同证据。尤其 DeepSeek Messages 不能因 provider 支持 Claude JSON format 就标记为支持原生 schema。[S-AN] [S-OC] [D-DJ] [D-DA] [D-DRA]

## 后续验证建议：优先复用主线已有证据

以下是**未执行的建议**，不要求重复主线的付费端点实验。先将主线脱敏原生响应作为固定 fixture，验证 adapter 接收与下一轮请求；只有出现无法由既有样本判断的端点问题，再由主线决定补测。

| 检查 | 可执行输入与断言 | 判定目标 |
| --- | --- | --- |
| 官方 Responses reasoning | 重放非空 `reasoning_text.delta`、reasoning output item；收集 provider normalized 与 raw 输出；捕获下一轮 JSON | 标出文本在哪一层消失；下一轮必须具备 DeepSeek `content`，不能只剩 item reference/summary |
| Command Code Responses | 单独重放其 summary 事件及完整 output item；与官方 fixture 分开 | 验证 summary、itemId、空/非空加密字段和回放 body；不能用事件名代替全链判定 |
| Chat 双 provider 对照 | 同一份 `reasoning_content+tool_calls` 样本进入 compatible 与 DeepSeek provider；再经 Core `response.messages` 回放 | 非空/空 reasoning、tool IDs、参数、结果均可恢复；核对网关模型 ID 命中分支 |
| Messages 签名 | thinking+signature+tool_use fixture；补一次空 thinking、有 signature 的样本；流末才发 signature | 保存、JSON 序列化、读回、再生成请求后签名及块顺序不变 |
| 图像必需项 | 用户截图及工具截图分别进入转换器；检查最终 body 和 media type/reference | 图片实际进入多模态数组，而非 JSON/text 字符串；必要时比较 file/reference 映射 |
| 结构化输出 | 分别配置 json mode、schema、JSON-tool；捕获实际请求与 warnings | 区分原生 enforcement 和 local validation；发现 forced→auto、schema→json_object 降级 |
| 错误/取消 | 合成 HTTP 429、200 后 error、工具参数中途断流、abort；不触发真实工具副作用 | 错误与中断不会被当完成；不执行半截参数；不把缺失 usage 当 0 |
| 存储与升级 | 将 Core messages 和原生数据序列化后读回；以固定版本重复请求转换 | 应用存储没有丢 providerOptions/metadata；升级差异可定位到 SDK/应用层 |

建议最小证据记录：`provider/model/protocol/dialect`、SDK 精确版本、最终 URL、已脱敏的请求结构、原生事件类型/次序、规范化 parts、warnings、finish/raw finish、usage/raw usage，以及下一轮发出的历史。凭据不得进入记录。

## 未解决点与交付状态

- **本源码调查未运行 SDK fixture 或真实端点测试。** 主线随后补做 SDK 实测；本文仍是固定源码证据，不是项目工程通过报告。
- Command Code Responses 原先未知的 adapter 保真问题已由主线补测：该固定 OpenAI provider 失败，直接 SDK 路线样本通过。未扩大其他供应商比较。
- 主线已在临时目录安装并运行表中主要 SDK 组合，未修改项目依赖；项目 TypeScript 构建、完整 fixture 回归与所有候选组合仍未验证。
- 新增字段、未覆盖的 server tools、完整 PDF 行为未由本稿验证；PDF 专项归主线，不以“SDK 能发 file”推定端点支持。
- 负责人随后授权 Agent 判断调用层选型，主线选定直接协议 SDK；正式决策与续接约束见对应议题。本源码稿保留备选方案的事实依据，不替代议题决策。
- 工程测试未执行；浏览器验收未执行；教学效果未评估。本文交付为研究材料。

## 固定源码索引

以下路径均相对于表中 npm tarball 的 `package/`，行号对应本轮实际读取的发布源码。链接是固定版本官方 npm 发布包，不是滚动 `main`。

| 标识 | 固定源码 | 本次关键检查位置 |
| --- | --- | --- |
| S-AI136 | [ai 7.0.136][S-AI136] | `src/generate-text/to-response-messages.ts:42–96`；`stream-text.ts:1614–1633`；`src/types/usage.ts` |
| S-AI148 | [ai 7.0.148][S-AI148] | 对照同名 `to-response-messages.ts`；没有据此声称仓库已经升级 |
| S-OA | [@ai-sdk/openai 4.0.99][S-OA] | `src/openai-provider.ts`；`src/responses/openai-responses-api.ts`、`openai-responses-language-model.ts`、`convert-to-openai-responses-input.ts`、`openai-responses-provider-metadata.ts`、`convert-openai-responses-usage.ts`；`src/openai-language-model-capabilities.ts` |
| S-OC | [@ai-sdk/openai-compatible 3.0.75][S-OC] | `src/chat/openai-compatible-chat-language-model.ts`、`convert-to-openai-compatible-chat-messages.ts`、`convert-openai-compatible-chat-usage.ts`；`src/openai-compatible-provider.ts` |
| S-AN | [@ai-sdk/anthropic 4.0.85][S-AN] | `src/anthropic-language-model.ts`、`anthropic-api.ts`、`convert-to-anthropic-prompt.ts`、`anthropic-prepare-tools.ts`、`convert-anthropic-usage.ts` |
| S-DS | [@ai-sdk/deepseek 3.0.63][S-DS] | `src/chat/is-deepseek-v4-model.ts`、`convert-to-deepseek-chat-messages.ts`、`deepseek-chat-language-model.ts`；`src/files/deepseek-files.ts` |
| S-NO | [openai 7.42.0][S-NO] | `src/resources/responses/responses.ts`；`src/core/streaming.ts`；README retries/cancellation |
| S-NA | [@anthropic-ai/sdk 1.1.0][S-NA] | `src/resources/messages/messages.ts`；`src/lib/MessageStream.ts`；`src/client.ts` |
| S-UTIL | [@ai-sdk/provider-utils 5.0.65][S-UTIL] | `src/response-handler.ts:130–172` |

[S-AI136]: https://registry.npmjs.org/ai/-/ai-7.0.136.tgz
[S-AI148]: https://registry.npmjs.org/ai/-/ai-7.0.148.tgz
[S-OA]: https://registry.npmjs.org/@ai-sdk/openai/-/openai-4.0.99.tgz
[S-OC]: https://registry.npmjs.org/@ai-sdk/openai-compatible/-/openai-compatible-3.0.75.tgz
[S-AN]: https://registry.npmjs.org/@ai-sdk/anthropic/-/anthropic-4.0.85.tgz
[S-DS]: https://registry.npmjs.org/@ai-sdk/deepseek/-/deepseek-3.0.63.tgz
[S-NO]: https://registry.npmjs.org/openai/-/openai-7.42.0.tgz
[S-NA]: https://registry.npmjs.org/@anthropic-ai/sdk/-/sdk-1.1.0.tgz
[S-UTIL]: https://registry.npmjs.org/@ai-sdk/provider-utils/-/provider-utils-5.0.65.tgz
[D-DR]: https://api-docs.deepseek.com/guides/responses_api/
[D-DRA]: https://api-docs.deepseek.com/api/create-response/
[D-DA]: https://api-docs.deepseek.com/guides/anthropic_api/
[D-DC]: https://api-docs.deepseek.com/api/create-chat-completion/
[D-DT]: https://api-docs.deepseek.com/guides/thinking_mode/
[D-DJ]: https://api-docs.deepseek.com/guides/json_mode/
[D-DTools]: https://api-docs.deepseek.com/guides/tool_calls/
[D-DV]: https://api-docs.deepseek.com/guides/vision/
[D-DF]: https://api-docs.deepseek.com/guides/files_api/
[D-CC]: https://commandcode.ai/docs/provider
[D-OT]: https://developers.openai.com/api/docs/guides/function-calling
[D-OC]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
[D-OR]: https://developers.openai.com/api/docs/guides/reasoning
[D-OS]: https://developers.openai.com/api/docs/guides/streaming-responses
[D-OJ]: https://developers.openai.com/api/docs/guides/structured-outputs
[D-OB]: https://developers.openai.com/api/docs/guides/background
[D-OV]: https://developers.openai.com/api/docs/guides/images-vision
[D-AT]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
[D-AS]: https://platform.claude.com/docs/en/build-with-claude/streaming
[D-AJ]: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
[D-AW]: https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows
[D-AP]: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
[D-AV]: https://platform.claude.com/docs/en/build-with-claude/vision
[D-COMP]: https://ai-sdk.dev/providers/openai-compatible-providers
[D-AIERR]: https://ai-sdk.dev/docs/ai-sdk-core/error-handling
