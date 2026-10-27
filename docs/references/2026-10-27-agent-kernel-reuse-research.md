# Agent 内核复用：有界自有运行、Pi 与 DeepSeek Harness

日期：2026-10-27。用途：为[总体架构与复用取舍：模块边界、Agent 内核和部署方式](https://github.com/paher-din/XunJie/issues/119)提供工程判断的证据；当前工程选择见[当前运行与部署设计](2026-10-27-overall-architecture-proposal.md)。先完成官方网页与固定源码核对，随后补充隔离的真实库/固定源码接入探针；未接真实模型端点、使用密钥或付费请求，未修改应用依赖。

## 结论与适用边界

**事实：Pi 与 DeepSeek Harness 都存在可替换模型入口和工具执行入口，不能因循阶掌握教学事实就排除复用。** Pi 当前还提供独立 `pi-durable`，其持久任务与恢复设施比早期 `agent-core` 更完整。DeepSeek Harness 的官方身份已经证实，不属于只能依靠二手介绍的未知候选。[P1] · [P2] · [P7] · [D1] · [D2]

**补充探针并按长期目标复核后的工程选择：长期采用自有持久 RunDriver，沿用已定直接协议 SDK 与模型连接契约。** 运行推进直接对应原生模型结果、固定命令、执行器回执、等待、预算和取消条件，减少对框架特定消息、任务与恢复策略的适配；相应调度设施由项目长期维护。Pi core 仍需宿主恢复工具意图和等待；Pi durable 确有持久任务收益，完整托管是有效替代；Harness 确有会话日志、取消和恢复收益。下文逐项说明收益、代价和未测范围；这不是三个生产实现的性能或总成本优胜证明。

**修正首轮证据边界：Harness 的公开进程内组合可以单会话取消。** 正式外层 SDK wire 的限制仍成立，但不能推广成 Harness 内核缺少取消；[真实接入报告](probes/2026-10-27-agent-kernel/harness/report.md)已验证取消一个 Agent 不停止另一个。取舍中不再以此作为排除理由。

这里的“有界”指每个运行有明确预算、停止/等待状态、持久检查点及副作用边界，**不指只允许少数几步**。生成工具与交互页面可以跨多轮模型、校验、资源生成和人工等待；应比较这条长流程如何可靠推进，不能用步骤少预先判自建胜出。

部署约束按用户最新输入：同一核心须可放入本机可信进程，也可放学校共享服务；学生/教师个人全本地、学校统一账号与模型服务、使用方选模块混合部署均是目标架构要求。课程实验仍按教师运行方案。以下只评价嵌入边界，不重新选择产品拓扑；“全本地”也不自动等于模型离线推理。

负责人进一步要求核对完整 Agent 能力，发现调用面、Skills/MCP/plugin 装配及提示词体系尚未收束，见[覆盖审计](2026-10-27-agent-design-coverage-audit.md)。本研究只覆盖其声明的内核接口和故障路径；[能力与质量契约](2026-10-27-agent-capabilities-design.md)已补成逐项方案，保留自有运行所有者；这属于组合设计检查，不能替代真实模型/工具集成验收。

## 已定输入与比较方法

本轮沿用此前讨论与研究，补齐未验证的接入和恢复问题：

| 既有材料 | 已提供的依据 | 本轮如何使用 |
| --- | --- | --- |
| [原讨论用户原话](2026-10-18-user-discussion.md)与[决策来源](../student-agent-decisions.md#来源与状态) | 要求按实际教学场景比较自建、复用或组合；AI SDK → Pi → AI SDK Core 是当时建议变化，不能视为用户逐项批准 | 不用旧附件标题或当前依赖预定胜者 |
| [架构事实核对](2026-10-18-architecture-checks.md#内核取舍的工程判断) | Pi 的实时上下文和工具前钩子可用；Harness 可复用插件、会话及运行机制；当时未做内核接入原型 | 保留可行候选，补测接入屏障与恢复，不重复泛泛的功能列表 |
| [ADR 0002](../adr/0002-own-teaching-state-and-effect-control.md) | 自有有限运行是初步成本判断，同时明确恢复、队列和调度复杂后需重新比较 | 将多步工具生成、持久等待、取消及重启纳入同等责任比较 |
| [模型协议 SDK 研究](2026-10-22-model-protocol-sdk-research.md)与[实际端点评估](2026-10-23-model-endpoint-assessment.md#从目标推导模型调用层) | 三协议直接 SDK 已按真实样本选定；原生续接保真、前缀稳定和终态校验是接入要求 | 本轮比较位于该连接层之上，不重做已完成的付费端点实验，也不以通用消息覆盖原件 |

10 月 18 日的[完整架构附件](XunJie_Student_Agent_Architecture_2026-10-18.md)保存了方案推导；其中 AI SDK Core 默认调用层已由后续模型接入决定替代，不能作为当前固定依赖。

- [三协议模型接入决议](https://github.com/paher-din/XunJie/issues/115#issuecomment-6346123203)：直接 `openai` SDK Chat/Responses 与 Anthropic Messages SDK 薄 adapter；原生历史按 route 保存；完整工具意图及必要终态到齐后才执行；SDK retry=0，由运行层控制。DeepSeek Responses stateless，完整原生块必须保全。已有记录的 SDK 基线为 `openai@7.42.0`、`@anthropic-ai/sdk@1.1.0`；本次未重做端点实验。[X1]
- [工作区交互与状态决议](https://github.com/paher-din/XunJie/issues/116#issuecomment-6370870664)：请求身份、不可变输入快照、本地保存确认、共享接收回执分离；结果未知先查原身份，不重复副作用。
- [跨课程连续教学决议](https://github.com/paher-din/XunJie/issues/118#issuecomment-6364486548)：学习活动、学习事实与证据独立于模型聊天。[课程工具与生成内容决议](https://github.com/paher-din/XunJie/issues/117#issuecomment-6409950554)：工具共用状态/命令/观察/引用语义，课程组件固定版本，页面恢复不是重跑。
- 标记：**F** 为读到的官方声明或源码事实；**I** 为针对这些输入的接入推断；**U** 为尚未实测或没有足够证据。自有运行列是设计方案与必须实现的责任，不冒充已有可用实现。

本文的 `ModelGateway` 指按已定三协议接入契约待实现的模块；已有端点/SDK 探针不代表仓库已完成生产网关。下文“桥接”比较的是未来接入成本。

## 官方项目与固定基线

| 候选 | 实时确认及固定版本 | 本次实际关注的最小集合 |
| --- | --- | --- |
| 自有持久有界运行 | XunJie 调查起点 HEAD `3eea16b7a90e83a94d6abd934e0c9da76c1f9848`；本轮决定与上述输入优先 | ModelGateway、持久 RunDriver、ToolExecutor 的职责及契约；没有新增实现 |
| Pi | 旧 `badlogic/pi-mono` 实时重定向到 `earendil-works/pi`。固定 `6c384aa30f619d7b28963f2bab24d8dacbe73cb6`（2026-10-26 UTC）；源码 package.json 中 `@earendil-works/pi-ai`、`pi-agent-core`、`pi-durable` 均 `1.4.0`，不据此声称已验证 npm 发布包。[P1] · [P3] · [P8] | agent-core 的 streamFn/请求准备/消息屏障/工具预检；pi-ai 三协议与签名；durable 的 generation/tool task、等待与存储 |
| DeepSeek Harness | DeepSeek 官方站直接链接 `deepseek-ai/deepseek-harness`；固定 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（2026-10-23 UTC）。本次核对的 `dsh-agent-loop`、`dsh-llm`、`dsh-sdk-client` package.json 为 `0.2.1-rc.3`。[D1] · [D2] · [D3] · [D4] | SDK/profile、LlmAdapter/replayState、agent-loop、tools pipeline、checkpoint policy；不展开团队、桌面、终端或生态全景 |

这与 10 月 18 日笔记的 Pi `8efd314…`、Harness `687f282…` 基线不同；下述能力只对本次固定提交负责。两者均 MIT；Pi durable README 明确标为实验性、版本间 API 可不预告地变化，Harness README 也明确处于 developer preview 且会有兼容破坏。持久能力与维护成熟度必须分别判断。[P1] · [P7] · [D2]

## 证据矩阵

| 比较项 | 自有持久有界运行 | Pi agent-core / pi-ai | Pi durable（单独计价） | DeepSeek Harness |
| --- | --- | --- | --- | --- |
| 本机可信进程嵌入 | I：直接运行同一 driver 和 SDK；存储/凭据由宿主注入 | F：`Agent` 是可直接构造的 TS 库，必需 `streamFn`；可只注册课程所需 Agent 工具，无需 coding CLI。[P2] · [P3] | F：`Harness.open(storage, { models, registry })`；有 Node SQLite/JSONL 和浏览器 IndexedDB 等后端；不必装 CodingTools。[P7] · [P8] | F：内部可通过 Cordis `ctx.agents` 编程创建；正式 TS SDK 启动同版本 dsh 子进程，用 stdio JSON-RPC；支持的应用启动路径是 profile。[D3] · [D5] |
| 共享服务与混合部署 | I：同一 driver 可放共享服务，需自己实现身份、租户、并发所有权及回执 | I：可放 Node 服务，HTTP/SSE 与租户隔离由循阶持有；浏览器代理例子不要求采用其前端或 proxy。[P2] | F：存储一次只允许一个进程拥有，库没有跨进程锁；I：共享服务需分区单写者或另做协调，不能多副本同时打开同库。[P7] | F：有 Web、headless、sdk profile；I：可在本机或学校进程托管，账号/租户边界不能从“有 Web UI”推定已符合循阶。[D5] |
| 固定组织云依赖 | I：接口不应写死组织云；端点、存储、执行器显式配置 | F：库与自定义 transport 无必需的组织云前提。[P2] · [P3] | F：可传本地存储、Models、Registry；Cloudflare 后端是选项。[P7] | F：可本地启动、profile 与模型 adapter 可替换；不要求固定组织云平台。I：需管理独立 Harness home/profile 与生命周期。[D2] · [D3] · [D5] |
| 三协议第三方端点 | I：沿用三协议决议已选薄 adapter，不新增协议翻译层 | F：pi-ai 有 Chat、Responses、Messages 实现，模型 baseUrl、headers、fetch、onPayload 可配置；这不等于所有第三方方言已通过。[P4] · [P5] · [P6] | F：通过 Models 走 pi-ai；也能注册自己的 Provider；不是直接接收现有 ModelGateway 接口。[P8] · [P9] | F：llm-pi-ai 支持手工声明协议/端点/兼容参数；亦可注册自有 LlmAdapter；标准多 provider 路径本身复用 pi-ai。[D4] · [D9] |
| reasoning 与 signature | I：原生历史按 route 保存为权威，显示/控制投影不能回写覆盖原件 | F：Chat 保留已支持 reasoning 字段及 reasoning_details；Responses 把完整已识别 reasoning item JSON 放入 thinkingSignature；Messages 保存 thinking signature/redacted payload。[P4] · [P5] · [P6] | F：模型历史仍采用 pi-ai 消息；I：若需任意原生字段无损保留，须另存原件/引用，不能只依赖标准 AssistantMessage。[P7] · [P9] | F：AssistantSource 有 adapter 私有 `replayState`；内建 pi-ai adapter 保存版本化签名/ID 等元数据，并验证模型归属；不是任意原生响应自动透传。[D4] · [D9] · [D10] |
| 完整助手终态后执行 | I：需自己实现协议终态校验与持久屏障 | F：先 await 完整响应；error/aborted 不执行工具，length 将工具判错；`Agent` 订阅者可形成异步屏障，低层 `agentLoop()` 事件消费者本身不是持久屏障。[P2] · [P3] | F：terminal response 分类后才创建 tool round；助手记录与工具任务在一次提交中建立，工具体前持久化 intent。[P10] · [P11] | F：完整流结算为 assistant/message 后才调用 tools.execute；error/aborted/max-tokens 不走成功工具分支；持久落盘另依赖 checkpoint policy。[D6] · [D8] |
| 执行前重新授权 | I：在实际执行器原子检查授权、固定版本、输入条件 | F：beforeToolCall 可异步阻止；默认 parallel 先完成各预检，再一起执行，早期预检可能过时。[P3] | F：正常调用跑 beforeTool 后提交 intent；恢复的 safe 分支直接 run，不重跑 beforeTool。[P11] | F：pre-execute → approval → monotonic guards → dispatch；但之后可 await checkpoint flush；I：最终授权/输入条件仍应在实际 ToolExecutor 使用处复核。[D7] · [D8] |
| 取消 | I：模型与命令分别取消；取消后的未知结果仍需查询 | F：abort signal 到模型/工具；工具必须配合，不能撤销已发生效果。[P2] · [P3] | F：取消等待不取消工作；root.abort 才取消队列/当前任务并等 idle；后台所有权另有规则。[P7] | F：公开进程内 agent.cancel 已实测单会话隔离；外层 SDK wire 无 cancel/session-close 的限制仍成立，不能推广为内核限制。[D3] · [D6] |
| 预算 | I：需持久扣留/结算模型、工具、时间及多步额度 | F：有 usage 与请求控制、finishTurn/prepareRequest 钩子；本次已读循环无自动总运行预算。[P2] · [P3] | F：有 pi.usage、retry/compaction 设置；本次已读 HarnessSettings 未找到总运行金额/步数硬上限；I：额度仍由宿主入场检查与执行器强制。[P7] · [P8] | F：maxTokens 是每请求输出上限；agent-loop 明确无内建 turn budget。I：还需外部全局额度和每次调用前检查。[D3] · [D6] |
| 持久步骤与未知效果 | I：需显式保存 run/step/model outcome/intent/receipt/wait/cancel，自己维护恢复机 | F：core 状态与队列在内存，可替换 messages/continue；没有由 core 自动提供的持久步骤恢复。[P2] | F：task/checkpoint、durable wait、requestId 去重、恢复与 replay policy 已有；unsafe 工具中断返回 interrupted，safe 才重跑；不是外部效果 exactly-once。[P7] · [P11] | F：SessionEvent、请求/调用检查点与 resume 已有；不匹配的 started call 形成 TOOL_OUTCOME_UNKNOWN；不是按业务命令 ID 自动查外部执行器。[D6] · [D8] |

## 四个决定性差异

### 1. 直连协议 adapter 的注入成本与原生历史

**F：Pi core 的 `StreamFn` 接收 Pi TranscriptContext，返回 AssistantMessageEventStream；`convertToLlm` 的返回值仍是 Pi Message[]，不是三家 SDK 原生历史。** 但它不强迫使用内建 pi-ai HTTP provider。[P2] · [P3] · [P9]

**I：保留三协议接入决议的可行做法**是让自有 streamFn 调用待实现的 ModelGateway：从 route 取权威原生历史，完成原生响应持久化，再投影为 Pi 的 text/thinking/toolCall/usage/stopReason。工具结果也必须以同一调用 ID 写回原生历史。成本是流事件与完成态桥接、原生记录和 Pi 消息关联、错误映射及一致性屏障，不是“换个 baseURL”。原生历史不能先压成 Pi Message[]，再期待转换回完全相同的 SDK 响应。

**F：Pi durable 只公开 `models: Models | (() => Models)` 作为这里的模型入口，generation 调用 models.streamSimple；没有与 core 相同的直接 streamFn 参数。** Models 的 Provider 接口可实现自有 stream/streamSimple，故可以桥接，但要额外适配 model/auth/catalog 形状及持久原件关联。[P8] · [P9] · [P10] **I：注入并非不可行，也不能算零成本。**

**F：Harness 可注册自有 LlmAdapter，AssistantSource.replayState 是 lossless-JSON adapter 状态槽。运行时只向同时拥有来源与目标 route 的 adapter 提供其 replayState。** 因而可以在 adapter 中保存原生响应或其可靠引用；但需实现 Harness 消息/StreamChunk/finish、模型能力元数据、route 注册与 replay 校验，并确保用户消息和工具结果也能正确装配原生请求。[D9] · [D10]

**F：Pi 已识别的 reasoning/signature 有明确保存代码，不应写成“Pi 丢失所有推理”。** 同时，其标准 AssistantMessage 仅有有限内容类型；Responses 文本块会折叠为文本与 textSignature，Messages 也按已知类型转换，不能证明任意未知原生块或额外字段无损。跨 provider/api/model 的转换会丢弃不适用 thinking/signature；这是一种请求投影策略，不应据此删除 route 原件。[P4] · [P5] · [P6] · [P9]

DeepSeek 官方实时文档再次确认 Responses 无服务端会话保存，必须重传完整 input；不支持 previous_response_id。因此保存 responseId 或通用摘要不足以恢复。官方网页是动态资料，访问日如上；具体端点兼容仍以三协议接入决议的固定 SDK 与实际 route 验证为准。[W1] · [X1]

### 2. 持久检查点与多步生成

**I：自有方案的合理形态是显式持久运行状态机，而不是一个不断扩张的 while 循环。** 多步生成页面至少可能经过模型规划、内容生成、资源/工具任务、校验、修订和发布；检查点要足以判断下一步是模型、工具、等待、交付还是结束。若这些状态开始需要通用 task scheduler、父子任务和版本迁移，自研承担的成本会接近框架，此时 durable 复用收益上升。

**F：Pi durable 已有 checkpoint task、存储、submission requestId 去重和等待状态。** 自定义 task 可 commit `waiting` 或 `sleeping`，阶段结束后不保留运行中的 invocation；进程重启从 checkpoint 继续。普通 ToolTask 的 execute 仍是一段异步工具调用，不能把“有 durable task”理解成任意 Promise 自动变成外部任务回执。[P7] · [P11]

**F：Harness 将 session persistence 与检查点策略分开。** checkpoint policy 在模型 stream、顶层工具体与下一步边界 flush，失败不派发；仅装 JSONL backend 不等于拥有这些屏障。嵌套工具复用外层检查点，不替循阶保存每条实验命令的业务 intent/receipt。末尾结果的落盘与 shutdown 仍需验证，agent-loop 文档明确列出 root shutdown 的最终 turn/end 可能未保存。[D6] · [D8]

### 3. 异步工具等待与释放模型运行

**F：两者的标准循环均在模型流完成后才 await 工具，工具等待期间不继续占用该次模型 HTTP 流。** Pi core 与 Harness 标准 driver 仍保有运行中 Promise/Agent，进程丢失后的等待不因此自动成为可恢复外部任务。Pi durable 的自定义 waiting task 提供了更明确的持久等待机制。[P3] · [P7] · [D6]

**I：三个方案都可采用同一个产品 seam：** ToolExecutor 先返回持久 commandId/receipt；driver 保存 waiting 与唤醒条件并结束当前模型运行；结果到达后按原身份核实，活动恢复后决定是否开启新的模型步骤。不把刷新/重连当成重发命令，也不为长实验保持模型请求。若要完全复用框架内等待，Pi durable 需自定义 task/唤醒桥接；Harness 此次最小集合只证实 Session/inbox/resume，**未验证**释放 live Agent 后按业务回执自动唤醒的完整实现。

这与学生/教师本机、学校服务或混合部署相容：命令接收与运行唤醒通过接口和持久身份衔接，不依赖固定组织云。是否需要独立 worker，由总体部署设计决定。

### 4. 模型恢复不是模型请求 exactly-once

**F：正常运行中，Pi durable 在已提交助手消息后建立工具任务；Harness 在已结算助手消息后派发工具。** 重启恢复须分别判断：本轮 Harness 在已 flush 的助手消息后恢复原件并生成 `TOOL_NOT_STARTED`，停在 idle，没有自动进入旧工具阶段；该切点的 flush 由探针手动注入。继续旧意图需要宿主的持久 continuation，不能把“恢复原件而未重问模型”写成“框架自动续跑工具”。Pi durable 的任务恢复事实见其独立探针。[P10] · [D6]

**I：请求发出后、完整响应提交前进程丢失，不能据这些库承诺模型调用不会重复或计费一次。** 对 stateless Responses，缺失完整原件时只能明确标记中断；新的模型尝试应有新 attempt 身份，并从最后完整原生历史开始。模型重试与工具重试必须分开；未结算助手流不得触发工具。

**F：Pi 的这三条 provider 路径把 SDK retries 设为 0，另有 provider retry wrapper，其默认重试次数在本次源码中也为 0。** durable 还拥有独立 generation retry；Harness pi-ai adapter 则 maxRetries=0，重试由 llm-retry 与 route policy 决定，默认 policy 可有五次重试。[P4] · [P5] · [P6] · [P12] · [P10] · [D4] **I：落实三协议接入决议时需明确唯一重试 owner，不能让自有运行层与框架各重试一遍。**

## 明显阻碍与最小可复用 seam

| 方案 | 明显阻碍/真实新增成本 | 最小接入边界及收益 |
| --- | --- | --- |
| 自有持久 driver | 没有上游替我们维护 crash cut、持久 wait、取消 tombstone、重复回执、预算及步骤版本迁移。步骤多不是排除理由，恢复状态数量与维护投入才是 | 保留 ModelGateway、ToolExecutor、RunStore；自有 driver 只组织状态迁移。直接协议/history 路径最短，但恢复投入全部自担 |
| Pi core | 自己实现 durability；streamFn 仍需把原生响应投影为 Pi 事件。低层事件流不能直接充当落盘屏障；parallel 预检不能充当执行点授权 | 仅嵌入 Agent + 自有 streamFn + 课程 AgentTool 代理；复用队列、流、循环与钩子，原生历史与业务执行账本独立 |
| Pi durable | 改接 Models/Provider、Chord Context/Storage/task/doc；single-owner 存储影响共享服务副本设计。safe 恢复跳过 beforeTool，执行器内必须复核；工具按名字解析，课程版本需自行编码绑定 | Provider 桥接既有直连 ModelGateway；自定义课程 task/ToolExecutor 代理；复用 checkpoint、waiting、requestId 去重与恢复调度。不要默认把学习证据迁入 pi.* 文档 |
| Harness | 自有 adapter/SessionEvent 接入、业务恢复续跑与迁移；本轮所需 native executor 同版 npm 发布返回 404，成功路径是固定源码组合，需维护构建入口 | 公开进程内组合已验证 loop、单会话取消、Agent 工具、JSONL/checkpoint 和尾部修复；无需私有取消桥。业务命令回执查询与持久等待仍由宿主接入 |

**I：可共用的最小契约**应至少能表达 `runId/stepId/attemptId`、固定 `route`、原生历史引用、完整模型 outcome、Agent 工具及所属课程组件版本、不可变 inputRef、commandId、授权依据、unknown/waiting/cancelled 状态与结果回执。它们可以先是普通 TypeScript 接口和数据库记录，不要求建立新的通用框架。Pi/Harness 的 toolCallId 或 sessionId 用于关联，不自动等同于工作区交互决议的业务命令身份或共享接收回执。

CLI 的 read/write/bash、持久终端、coding persona、SDK-minimal 的默认工具均不计为教学产品复用收益。特别是 Harness sdk-minimal 本身仍是带 shell/image/working_directory 和自动 compaction 的 coding composition；选它并不等于获得“只含课程所需 Agent 工具的纯内核”。Pi 的 CodingTools 同样是可选扩展。[P7] · [D11]

## 实际接入探针与工程取舍

共同输入、脚本和复现入口见[探针说明](probes/2026-10-27-agent-kernel/README.md)。均使用假模型与假工具；运行在 macOS arm64 / Node 24.18.0，未验收工程目标 Node 24.21.0。各组计数表示不同粒度的检查，不能相加成为产品测试覆盖率。

| 候选 | 本轮新增实证 | 仍由循阶承担或需要接管 |
| --- | --- | --- |
| 自有最小 driver 与 Pi core | [69 项情形与接口检查](probes/2026-10-27-agent-kernel/core/report.md)：同一宿主持久记录下两者均完成 fixture 往返、进程退出后恢复、未知命令查询、等待、取消及执行条件核对；Pi 的异步 listener 屏障和独立实例取消有效 | 两种模式共用原件、命令、等待和恢复代码。裸 Pi `continue()` 拒绝 assistant 末尾，须由宿主完成未结工具再续接。不能将共同宿主的恢复能力记作 core 内置能力 |
| Pi durable | [30 条断言、9 个情形](probes/2026-10-27-agent-kernel/durable/report.md)：真实 Provider/Harness、unsafe 不重放、safe 恢复、跨进程休眠与取消后晚回执 | 原件与 Pi 状态原子关联、业务回执查询/唤醒、执行点授权、持久预算和单写者协调。unsafe 默认记 interrupted 后继续，未自动完成循阶的“先查结果再继续” |
| DeepSeek Harness | [17 个情形](probes/2026-10-27-agent-kernel/harness/report.md)：固定源码公开组合、原生 replay 槽、工具前 JSONL flush、单会话取消、6 次 SIGKILL 恢复 | 恢复把未开始/未知工具分别记为 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`；业务自动续跑及回执查询仍需补。裸 EOF 缺 finish 会执行工具，adapter 必须强制协议终态；源码构建入口也需维护 |

**长期采用自有持久 RunDriver 的具体取舍：** 一次逻辑运行围绕稳定请求和固定输入，持续推进“模型步骤—已保存意图—执行器回执—下一步或持久等待”。运行记录同时承担唯一调度权威，阶段直接对应已定的原生模型、命令确认和等待规则；同机和跨机使用同一语义，维护时能按原身份解释每个推进条件。项目接受长期维护调度设施的成本。这是工程选择，不是由“业务事实必须自有”必然推出的结论，也不依赖流程短或早期实现简单。

这项取舍承认上游的真实收益：Pi core 的内存循环、队列与事件；Pi durable 的任务检查点与调度；Harness 的会话日志、工具流水线和恢复修复。**有效替代是让 Pi durable 整体承接运行状态和调度，领域记录仅保留任务引用**，从而省去自研对应设施；采用框架并不必然产生双重调度权威。本轮未完成这种整体委托的原生记录、业务回执和存储接入，不能断言其生产成本更高。当前推荐是在“直接控制业务运行阶段”与“整体委托框架调度”之间优先前者，代价如下；experimental 或发布缺口仅计入升级与交付成本，不单独决定胜负。

**自研范围与责任不能隐去：** 必须实现并维护持久阶段、原子待处理记录、领取代际、完整原件与工具意图的关联、未知结果查询、等待/唤醒、取消标记、预算预留/结算、顺序与并发边界、协议错误归一化和记录升级。探针仅验证其中有限路径，未证明生产自研更省代码或更可靠。教学活动、画像和作品各自保留领域责任，RunDriver 不发展成通用插件、团队协作或事件溯源平台。

**长期维护与修订：** 多步工具生成、长等待、恢复、取消和并发控制已属于 RunDriver 的完整责任，不留作后续补丁。`waiting` 保留原逻辑 Run，释放模型连接和内存处理者；取消后的晚结果不复活运行。不安排未来改用某个框架的阶段。只有真实需求或运行证据暴露当前边界的问题时，再比较修改与替换，连同记录迁移一起决定；正常增加课程或同一循环的步数不自动要求换内核。

## 剩余验证与实施交接

1. **原生协议完整集成：** fixture 原件序列化与恢复已局部验证；真实 SDK 输入装配、协议终态检测、前缀/签名、路线切换、长历史与图片工具结果仍需接入验收。保留此前真实端点样本作为回归依据。
2. **生产持久恢复：** 本轮有正常退出、指定切点退出和 SIGKILL 实证；原子业务提交、多进程领取/代际、网络分区、磁盘故障及数据库迁移未验收。Pi durable 原件文件与框架库双写未解决；Harness 尾部修复不等于业务恢复完成。
3. **权限与课程版本：** 自有/core 执行器替身和 durable safe 恢复处已核对撤权；真实对象条件写入、课程版本固定与工具更新、并发预检后的变化仍需验收。
4. **等待与取消：** 已验证宿主持久等待/取消与 durable 休眠恢复；真实本机/远端回执事件、重复投递、活动暂停后迟到提示、浏览器断开和执行器停止仍需端到端验证。
5. **预算与运行环境：** 本轮只验证调用入口可拒绝。真实金额预留/结算、未知用量、重试/压缩与工具费用、性能、租户隔离、目标 Node 和操作系统矩阵未验收。浏览器体验和教学效果也未验证。

## 一手来源索引

所有 GitHub 源码链接固定到本文基线；官方动态网页注明本次访问日。已有 XunJie 研究仅用于已定输入及旧线索，不冒充本次运行结果。

[X1]: 2026-10-23-model-endpoint-assessment.md
[P1]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/README.md
[P2]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/agent/README.md
[P3]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/agent/src/agent-loop.ts
[P4]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/ai/src/api/openai-completions.ts
[P5]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/ai/src/api/openai-responses-shared.ts
[P6]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/ai/src/api/anthropic-messages.ts
[P7]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/durable/README.md
[P8]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/durable/src/harness/types.ts
[P9]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/ai/src/models.ts
[P10]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/durable/src/harness/generation.ts
[P11]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/durable/src/harness/tool.ts
[P12]: https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/ai/src/utils/provider-retry.ts
[D1]: https://deepseek.com/harness/
[D2]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/README.md
[D3]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/README.md
[D4]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm-pi-ai/README.md
[D5]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/architecture.md
[D6]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md
[D7]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/pipeline.ts
[D8]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-checkpoint-policy/src/index.ts
[D9]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/index.ts
[D10]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/message.ts
[D11]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/bundle/sdk-minimal/README.md
[W1]: https://api-docs.deepseek.com/api/create-response/
