# 三协议端点调查与互操作结果

状态：本轮技术调查与工程判断。负责人已确认 PDF 范围及按页读取路线，并授权 Agent 从第一性原理判断模型调用层选型；正式决策以 [三协议模型接入：第三方端点能力、适配与原生续接](https://github.com/paher-din/XunJie/issues/115) 的 resolution comment 为准。父地图为 [学生端 Agent 与工作区重新设计：数字逻辑与部件设计先行](https://github.com/paher-din/XunJie/issues/112)。

调查开始于 2026-10-22，端点测试发生于 2026-10-23 00:00–00:35（Asia/Shanghai）。源码基线为 `1f29715edbabc1997bbbb61bd73319a56becd8a4`。

## 负责人已明确的范围

- 三种协议都要支持，不使用 OpenAI / Claude 官方模型服务；已有 AI SDK Core 方案可重新选择。
- 本轮实际模型采用 DeepSeek 官方 `deepseek-flash`，以及 Command Code 的 DeepSeek V4.1 Flash。
- 图像输入是首版必需能力。
- PDF 首版支持 Agent 阅读与引用：定位页码、读取正文、查看图表及扫描页，回答可回到对应页面；生成、编辑与填写 PDF 暂不纳入。负责人随后确认采用按页读取工具，返回文字、页图、文档版本与页码引用；扫描页先走视觉读取，确需全文搜索时再加 OCR。具体渲染库随运行位置选择。

## 现有实现的边界

以下是源码事实，不是远端模型能力结论：

| 位置 | 实际行为 | 对本轮的影响 |
| --- | --- | --- |
| `apps/teaching/server/personal-agent/types.ts` | `ModelSelection` 没有独立协议字段；`CompatibleMessage` 只表示文本、图片和三种会话角色 | 不能表达完整工具往返、原生 reasoning、签名或 Responses items |
| `apps/teaching/server/tutoring/openai-compatible.ts` | 调用 `/chat/completions`，解析可见文本及 usage；reasoning 只触发活动指示 | 当前通道不是三协议调用层；HTTP 成功不能证明工具与续接成立 |
| 同上 | 结构化任务发送 `json_object` 和 schema 提示词 | 是 JSON 生成与应用校验路径，不等于服务端 strict JSON Schema |
| `apps/teaching/server/personal-agent/service.ts` | 历史保存文本和图片；resume 追加部分回答与“请继续” | 这是产品层继续回答，不是协议原生续接 |
| `apps/teaching/package-lock.json` | 锁定 `ai@7.0.136`、`@ai-sdk/deepseek@3.0.63`、`@ai-sdk/provider@4.0.26`、`@ai-sdk/provider-utils@5.0.58` | 当前工作区未安装这些包；OpenAI、OpenAI-compatible、Anthropic provider 未在此 lock 中。不能把下面 raw HTTP 结果写成这些 SDK 的端点验证 |

只读配置盘点找到两家选定服务的现有凭据与协议入口。凭据仅在内存用于请求授权服务，没有写入源码、日志或本证据。

## 路线与文档声明

| 服务 | modelId | 路线 |
| --- | --- | --- |
| DeepSeek 官方 | `deepseek-flash` | `https://api.deepseek.com/v1/chat/completions` |
| DeepSeek 官方 | `deepseek-flash` | `https://api.deepseek.com/v1/responses` |
| DeepSeek 官方 | `deepseek-flash` | `https://api.deepseek.com/anthropic/v1/messages` |
| Command Code | `deepseek/deepseek-v4.1-flash` | `https://api.commandcode.ai/provider/v1/chat/completions` |
| Command Code | `deepseek/deepseek-v4.1-flash` | `https://api.commandcode.ai/provider/v1/responses` |

Command Code 的带认证实时 `/provider/v1/models` 查询中，该 modelId 的 `supported_endpoints` 仅列 `/chat/completions` 和 `/responses`。因此该模型在 Command Code 的 Messages 组合按目录记为不支持，未以另一个模型或另一个协议冒充验证。[Provider API](https://commandcode.ai/docs/provider)

DeepSeek 官方 `deepseek-flash` 是滚动别名。调查时官方说明其服务模型为 DeepSeek-V4.1-Flash-1017；模型别名和服务版本应分别记录，不能把一次验证视为永久能力承诺。[官方入口与模型标识](https://api-docs.deepseek.com/)

DeepSeek 官方 Responses 是无服务端会话存储的接口，不支持 `previous_response_id`、`conversation`、`background`，`store` 总是 false。续接要重发原生历史，不能只存一个 response ID。[Responses 兼容表](https://api-docs.deepseek.com/guides/responses_api/)

## 实际验证矩阵

本节 raw HTTP 实验使用 Node.js `v26.0.0` 内置 `fetch`、`AbortController` 和 SSE 解析；没有调用项目的既有适配器，也没有使用候选 SDK。随后另做了下节的固定版本 SDK 实测。工具为无副作用的 `read_probe`：模型发起请求后，本地生成随机 nonce 并返回；第二次模型调用必须正确引用该 nonce。图像是现场生成的红、蓝两半 PNG，只询问左右颜色；不发送学生作品或其他真实数据。

每条路线有限调用，禁用自动重试；单次上限为 2048 输出 token、60 秒，最多两条路线同时测试。保留脱敏记录于 [端点探测结果](2026-10-23-model-endpoint-probe-results.json)。这些是样本互操作结果，不是性能统计或完整协议认证。

| 路线 | 自动工具选择 + 流式工具参数 | 完整工具结果往返 | 图片理解 | strict 结构化输出探测 | 客户端流取消 |
| --- | --- | --- | --- | --- | --- |
| DeepSeek / Chat | 通过，补充样本实收 `reasoning_content` | 保留该字段回放通过 | 通过 | 标准入口拒绝 `json_schema`，有效与无效 schema 均 HTTP 400 | 收到文本后中止成功 |
| DeepSeek / Responses | 通过，补充样本实收 reasoning item | 保留该 item 回放通过 | 通过 | 有效 schema 样本通过，无效 schema HTTP 400 | 收到文本后中止成功 |
| DeepSeek / Messages | 通过，实收 thinking 与 signature | 保留原生块回放通过 | 通过 | `output_config.format` 无效 schema 仍 HTTP 200；有效样本也未得到裸 JSON | 收到文本后中止成功 |
| Command Code / Chat | 通过，实收 `reasoning_content` | 保留该字段回放通过 | 通过 | 有效样本符合 schema，但无效 schema 仍 HTTP 200，不能标为服务端 strict 验收通过 | 收到文本后中止成功 |
| Command Code / Responses | 通过 | 通过 | 通过 | 有效 schema 样本通过，无效 schema HTTP 400 | 收到文本后中止成功 |

“完整工具往返通过”包含：工具名与参数匹配、调用身份存在、原生助手内容回放、结果 nonce 被最终文本正确使用。它不代表真实课程工具已经接入。

针对 PDF 工具阅读的接入需要，另补测了“调用工具后再看到工具产出的图片”。五条路线均正确回报 nonce 与图片左右颜色。Responses 使用 `function_call_output` 内的图像，Messages 使用 `tool_result` 内的图像；Chat 路线保留与调用匹配的文本工具结果，再以相邻用户图像消息提供图片。后者是一次已测的兼容装配方式，不等于 Chat 原生工具结果支持图像。该实验使用直接生成的 PNG，没有执行 PDF 解析或渲染，因此不能算 PDF 端到端验收。

以下限制必须随矩阵一起阅读：

- 首轮 DeepSeek 官方三协议在 thinking 开启时强制指定具体工具均 HTTP 400；另一次诊断确认错误为 `Thinking mode does not support this tool_choice`。调整为 `auto` 后完成往返。这是参数组合限制，不能记为“不支持工具”。
- 简单工具请求有时不产生非空 reasoning。官方 Chat / Responses 另以四位寄存器变换题、`high` effort 触发非空 reasoning，再执行工具往返，补足相应回放样本。不能要求每次成功响应都必须有非空 reasoning。
- Command Code Responses 首轮实收 `response.reasoning_summary_text.delta` 等事件；DeepSeek 官方补充样本实收 `response.reasoning_text.delta`。两家的流方言不同。
- 完整响应均收到 token 用量；取消后的最终用量、服务端是否停止计算与计费未知。客户端 abort 不能当成服务端取消成功。
- 追加工作区观察的请求均被接受，但用户消息中的新版本与此前工具事实可能冲突；有样本要求重新读取工具。初始检测还把 `v2` 的表达漏判，并把出现数字 2 误当作采纳。该组只支持“追加请求可被接收”的协议结论，不用于证明教学语义或观察权威策略正确。
- 有效结构化输出只测了一个小 schema；无效 schema 探测用于识别明显忽略约束的路径。未覆盖完整 JSON Schema 子集、复杂工具 schema 或严格工具参数 beta 路线。
- 未验证大图/复杂波形的识别质量、PDF 读取链、限流与服务端故障恢复、进程重启后的原生回放、切换路线、前缀改写、压缩历史或服务端存储续接。

## 固定版本 SDK 的真实往返

源码调查揭示 provider 与端点方言存在差异，因此在独立临时目录安装固定版本，补做 20 次真实请求。项目依赖和业务代码未修改。每个案例先流式调用工具，再将 `response.messages` 或原生助手内容序列化、反序列化并构造下一轮；在内存比较原生推理内容、签名及实际发出的历史。调用预算与上节相同，重试为零。[脱敏 SDK 结果](2026-10-23-model-sdk-probe-results.json)

| 实际路线 | 调用组件 | 接收与回放结果 | 判断 |
| --- | --- | --- | --- |
| DeepSeek / Chat | `ai@7.0.136` + `@ai-sdk/deepseek@3.0.63` | 收到 831 字符 reasoning，规范化与下一轮完全一致；工具 nonce 正确 | 本样本通过 |
| Command Code / Chat | 同上 | 收到 1144 字符 reasoning，规范化与下一轮完全一致；工具 nonce 正确 | 本样本通过 |
| DeepSeek / Messages | `ai@7.0.136` + `@ai-sdk/anthropic@4.0.85` | thinking 文本与签名序列化后均原样回传；工具 nonce 正确 | 本样本通过 |
| DeepSeek / Responses | `ai@7.0.136` + `@ai-sdk/openai@4.0.99` | 原始响应有 768 字符 reasoning，规范化及下一轮均为 0；下一轮 HTTP 200，nonce 仍正确 | **原生保真失败**，回答正确不等于 reasoning 保留 |
| Command Code / Responses | 同上 | `function_call` 的 added 事件缺少 provider schema 要求的 `arguments`，产生 `AI_TypeValidationError`；规范化有 summary，诊断性下一轮未回传 reasoning | **流与回放验收失败** |
| DeepSeek / Responses | 直接 `openai@7.42.0` | 用低层流迭代器保留 completed response；全部原生 output items 原样回放，nonce 正确 | 本样本通过 |
| Command Code / Responses | 同上 | 原生 summary/items 原样回放，nonce 正确 | 本样本通过 |
| DeepSeek / Chat | 直接 `openai@7.42.0` | 原生流交付 `reasoning_content` 与工具参数；聚合后的助手内容原样回放，nonce 正确 | 本样本通过 |
| Command Code / Chat | 同上 | 同上，网关型号与端点保持独立 | 本样本通过 |
| DeepSeek / Messages | 直接 `@anthropic-ai/sdk@1.1.0` | `stream.finalMessage()` 聚合出的 thinking、signature 与原始事件逐字一致；完整 content 回放、nonce 正确 | 本样本通过 |

AI SDK 的 Responses 配置已显式使用 `store:false`、`forceReasoning:true`、`reasoningEffort:high`，不是只改 URL 后使用错误的默认存储模式。官方 DeepSeek 的问题仍然发生。Command Code 的缺字段也在直接 SDK 实验中再次观察到；直接 SDK 能交付原生 JSON 事件，未套用该 provider 的运行时 schema。[固定版本源码依据](2026-10-22-model-protocol-sdk-research.md)

Command Code AI SDK 案例发生流错误后，实验仍做了一次**无副作用的诊断性续接**，以核对发出的历史；这不构成生产执行许可或成功验收。运行时应把流错误保留为失败，不能因为仍能提取工具名与参数就执行真实工具。

这些结果验证了有限样本的 SDK 运行组合和 JSON 序列化往返；没有运行项目 TypeScript 构建，也未验证 SDK 图像回放、进程重启、长历史或所有错误形状。直接 SDK 的 Chat 使用低层流和本地增量聚合，Responses 使用低层流及 completed response，Messages 使用 `stream.finalMessage()`；不推广到未测高阶 helper。Chat 聚合只覆盖本次出现的文本、reasoning 和工具字段，不承诺自动理解所有未知扩展。`@ai-sdk/openai-compatible@3.0.75` 本轮仅做源码调查。

## PDF：模型输入与 Agent 文件能力

DeepSeek 官方 Files API 接收 JPEG、PNG、GIF、WebP；Messages 兼容表明确不支持 `document` 内容块。当前不能把 PDF 作为这组路线的原生文件能力承诺。[Files API](https://api-docs.deepseek.com/guides/files_api/) · [Messages 兼容表](https://api-docs.deepseek.com/guides/anthropic_api/)

这并不排除 Agent 使用工具阅读 PDF。用户要求的实现比较见 [Agent PDF 能力研究](2026-10-22-agent-pdf-capabilities-research.md)。阅读与引用范围及“文字 + 按需看页图”的工具路线已确认；具体库与执行位置交由 [课程工具与生成内容：接入、运行宿主和状态恢复](https://github.com/paher-din/XunJie/issues/117) 选择，页面引用与返回原页交由 [工作区交互与状态：自动保存、选区引用、执行依据和提交](https://github.com/paher-din/XunJie/issues/116) 承接。

## 从目标推导模型调用层

本层要完成的是：向明确的第三方路线发出一次模型步骤，稳定取得文本和工具意图，保留下一轮需要的原生数据，报告完成、失败与用量。教学调度、课程工具执行、工作区事实和权限判断属于上层；使用 SDK 自带的 Agent loop 不能省去这些领域职责。

本轮有三个决定成本的事实：三协议不可删减；目标服务存在协议方言；原生续接必须保真。模型调用成功的公共字段不足以重建 reasoning、签名和工具配对。无论选哪个库，应用都要保存原生续接记录和运行事实，不能以可见对话替代。

| 方案 | 能复用的部分 | 本项目仍需维护的部分 | 本轮判断 |
| --- | --- | --- | --- |
| AI SDK Core + 全部 provider | 统一消息、流、工具参数、usage 和 schema 生成接口 | 两条 Responses 方言的专门适配；原生数据与 Core parts 的双向映射、存储及保真测试 | 可行，但在最关键的原生数据路径增加转换；本轮不选 |
| Chat / Messages 用 provider，Responses 用直接 SDK | 复用三个已通过的 provider 样本及两条直接 SDK 路线 | 同时维护 Core messages 与原生 Responses，统一运行接口之外再维护两类存储转换 | 曾作为候选；兼容证据成立，但长期维护边界不够统一 |
| 三协议都用直接协议 SDK | HTTP、认证配置、底层 SSE、错误对象和取消；Messages 已测聚合器 | 三个薄 adapter：方言参数、必要增量聚合、统一事件/用量/错误、能力规则与回放测试 | **本轮采用**；原生内容直接作为续接依据，转换集中在展示和应用事件边界 |

采用 `openai@7.42.0` 承接 Chat / Responses，`@anthropic-ai/sdk@1.1.0` 承接 Messages，按这组版本建立首批实现基线。它们连接的是已配置的第三方地址，不引入官方 OpenAI/Claude 模型服务。版本升级和新路线需重新验证；不把当前版本号当成永久冻结要求。

选择依据不是依赖数量或“少抽象”的口号，而是**减少对原生历史的往返转换，同时把必须自有的领域执行权留在应用层**。代价也明确：不能再依赖 Core 替本项目归一化所有流事件、用量、错误与结构化输出。上述适配应限制在模型连接层，禁止逐步长成另一套教学运行框架。未来若通用循环层有收益，在 [总体架构与复用取舍：模块边界、Agent 内核和部署方式](https://github.com/paher-din/XunJie/issues/119) 比较，不能反向改写本票已经核实的原生保真要求。

## 接入边界与续接约束

1. 将端点、模型和协议组成明确的调用路线；将能力证据绑定到路线、参数模式和 adapter 版本。服务名不能替代协议与方言配置。
2. 可见会话内容、运行事实和原生续接数据分开。原生数据包含 reasoning、签名、工具调用身份与完整内容块，按路线保存并保留顺序；不能只存可见文本，也不能跨服务直接搬运签名或 ID。
3. 模型调用层返回内容与工具意图；教学运行层决定是否执行课程工具并记录结果。本票不选择完整教学调度框架。
4. 能力不足时，按任务要求明确拒绝、应用侧校验、文件工具转换或使用预先配置的替代路线；没有替代策略就失败，不能静默换协议或模型。严格结构化输出只标注有证据的路线；应用校验与受限修复可以使用，但必须保留它不是原生 strict enforcement 的事实。
5. 连接接口只需表达一步调用输入、规范化事件、终态、原生助手内容和运行证据。工具参数完整且校验通过、流成功完成后，才交由运行层判断执行；不得在增量参数或失败流上提前执行。

以下是首批实现必须遵守的约束，不声称本轮已完成相应端到端实验：

| 变化或故障 | 处理规则 | 本轮证据边界 |
| --- | --- | --- |
| 新工作区观察 | 附带版本与来源追加；保留此前工具结果作为当时事实。新观察不偷偷改写旧工具结果；运行层在执行动作前按当前状态校验 | 追加请求可被端点接收已测；模型对冲突观察的采纳策略未验收 |
| system / 工具集合变化 | 不在已有签名历史中随意改前缀；在已结清工具调用的步骤边界，以可移植事实开始新的原生续接段 | 具体前缀容忍度未测，首版不依赖其宽容行为 |
| 历史压缩 | 摘要用于新的上下文段，原始运行事实及必要来源另存；不将压缩后的文本冒充原始签名块 | 未做压缩往返实验 |
| 切换路线 | 在步骤边界以可移植上下文重建。旧路线的签名、响应 ID、工具 ID 不直接移植；明确共享的文件引用另按服务规则核对 | 五条路线分别通过；跨路线迁移未测 |
| 取消与断流 | 模型请求取消、工具停止和撤销修改分开。半截工具参数不可执行；终态缺失不得标为完整成功；usage 未到记未知 | raw 客户端 abort 已测；服务端停止及最终计费未知 |
| 重试 | 直接 SDK 的自动重试设为 0，由运行层统一控制预算和步骤重试。已完成的工具结果复用；副作用结果未知时先核实，不重跑整轮 | 本轮无副作用工具；真实课程工具恢复待实现验收 |
| 服务端续接 | DeepSeek Responses 首版重发完整原生历史；不依赖 `previous_response_id` 或远端存储恢复 | stateless 契约和原生回放已验证；进程重启尚未测 |

## 验证口径与交接

完成 58 次有记录的 raw HTTP 请求、1 次额外错误诊断，以及 20 次有记录的 SDK 请求；五条实际路线都有直接 SDK 的工具/原生续接样本。记录不含密钥、推理正文或签名。工程构建与测试、浏览器验收、PDF 端到端阅读及教学效果均未执行，均不计为通过。

本票交付模型连接层的决策和首批能力证据；实现阶段仍要加入固定样本的 adapter 回归、HTTP/流内失败与中断、进程重启回放、必要图像/PDF 链路及真实工具重复执行保护。生产依赖、运行代码、部署方式与完整教学调度框架未由本次研究改动。
