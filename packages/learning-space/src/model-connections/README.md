# 模型选择、有限检查与三协议原生续接

本模块承接 #164–#167 的 `ModelGateway`，由产品组合注入 WP02 的真实授权与所属 storage。配置、加密凭据、选择/授权、固定图片、工具结果、原生段和调用事实属于独立 `model-connection` owner。浏览器只消费 [公开 wire](../../../contracts/src/model-connections.ts)，不引用 SDK、数据库或旧 Session/store。验收见 [#164](../../../../docs/student-agent-implementation/wp06-personal-models-acceptance.md)、[#165](../../../../docs/student-agent-implementation/wp06-chat-selection-acceptance.md)、[#166](../../../../docs/student-agent-implementation/wp06-responses-acceptance.md)和 [#167](../../../../docs/student-agent-implementation/wp06-messages-acceptance.md)。

## 公开接口与生命周期

| 接口 | 行为 |
| --- | --- |
| `list/save(identity, input)` | 本人连接投影；CAS 版本保存；空白凭据保留、显式替换或清除；认证目标变化拒绝隐式带上旧凭据 |
| `checks.receive(identity, input)` | 稳定 attemptId 固定主体、用途、配置、限制及原生请求；同内容返回原记录，不同内容冲突；临时凭据与接收同事务 |
| `checks.dispatch(identity, id)` | 有效授权与代际下最多一次外发；重复派发只查原记录；没有课程、活动或 Run 前置 |
| `checks.read/list(identity, id?)` | 只读原事实，并核验结果资源；结果含部分文本、usage 及 resultRef，不返回原生 reasoning 或错误正文 |
| `checks.cancel(identity, id)` | 未外发确认未开始；外发后 abort 本机 SDK；保留终态竞争的实际事实，上游计算/费用仍未知 |
| `school.save(spaceId, input)` | 仅受认证的宿主管理入口调用；每个学校一个默认连接，CAS 更新、停用、检查许可和限额 |
| `selection.read/save`、`selection.createGrant/revoke` | 真实主体的显式引用、费用来源及授权版本；撤销不删除历史，不回退到学校额度 |
| `images.upload` | 接收本主体的固定 PNG 原件或有来源的变换版本；不接受 URL、教师材料 ID 或任意文件路径 |
| `segments.create/read/settle` | 固定路线、格式版本、system/工具/参数前缀、序号、完整结果引用及调用方工具结清 |

HTTP 装配见 [learning-entry](../learning-entry/README.md)。每个检查只发送固定合成短文本；最多 128 个输出 token、30 秒等待、每主体每小时 6 次准入，全组件最多 2 个、同主体最多 1 个未结束物理请求。取消、失败、缺 usage、重复请求或重启均不返还准入计数。授权 60 秒有效，查询时将未派发的过期检查终结并释放临时凭据。临时凭据随检查终态在同一所属事务删除，避免完成回执后崩溃留下密钥。

## 学校默认和个人引用

学校维护者使用 `xunjie school-model --root <学校环境> --file <私有 JSON>`，其输入为 `schoolModelInputSchema`：正常连接保存字段、`requestId/expectedVersion/credential`，以及 `policy: { checksAllowed, maxChecksPerHour, maxOutputTokens, timeoutMs }`。首次版本为 0；更新用返回版本；`enabled:false` 停用，`credential.action:"clear"` 显式清除。凭据放私有文件，命令只输出脱敏配置；管理凭据由产品在本机解析，学生不能调用管理写入。没有“管理员允许个人模型”开关。

正式设置通过 `models/selection` 读取学校默认、本人及本机持有的选项。个人选项的“授权并选用”先用 `models/grants` 为**当前已认证主体**建立引用，再以选择版本 CAS 提交；`owner:device` 只由安装客户端证明本机持有者。学校网页的个人连接由该网页所在持有方保管，跨组件的本机模型由安装客户端持有。不存在以账号同名、请求中的主体 ID 或连接 ID 借用密钥的入口。

安装客户端沿 WP02 的真实学校连接授权实时核验身份及目标；学校服务在学校生成，个人服务在本机生成。客户端 owner 持久绑定每个 attempt/segment/image ID 的原持有方和输入摘要，重复接收和后续查询/取消不会因当前选择改变而转发到另一方。断连/撤销后不能继续外发；完整独立部署、跨机和代际接管归 #168。`x-xj-expected-subject/namespace` 只作视图隔离，不能建立身份。

跨学校/本机持有方换段时，客户端模型 owner 通过原持有方认证读取 `models/results/<ref>` 的完成/结清公开事实，使用 `segments/<id>/close` 明确封存旧段，再保存带原 owner、路线、结果引用和可见文本摘要的 `provenance`。新持有方只收到调用方可移植文本，不伪称自己验证了外部原件，也不搬运旧 native/tool ID；原出处由客户端的持久段路由记录保留并返回。原件继续被原 owner 的段/尝试保留。多 owner 之间不做分布式事务：创建新段失败时旧边界仍可查询，修正请求可引用同一已封存边界重新创建，不自动恢复旧调用。

接收和紧邻 SDK 外发前均重新检查成员、个人授权版本、连接启用及凭据可用性。普通配置更新不更换已接受请求的模型、地址、参数、凭据引用或费用来源；清除/替换凭据、停用和撤销阻止尚未外发者。共享学校检查上限按费用来源串行准入，不从个人借额；原生探针与检查均有持久准入和物理并发上限，不是 WP07 的学习 Run 预算。

## 原生 Chat 调用 wire

`POST models/segments` 接收 `segmentId/requestId/source/prefix/portable`，可用 `previousSegmentId` 表达新段出处。`prefix` 固定 `system`、工具 `{name,description,inputSchema}` 和可选参数：显式 `toolChoice`、`responseFormat`、`applicationSchema`、`requiredCapabilities`、`capabilityProbe`。工具只支持同步、有限深度的本地 JSON Schema 校验；异步、外部引用、正则执行等未接入项在外发前拒绝。

`POST models/calls` 是受控调用方使用的同一 Gateway 入口：`purpose:"chat-probe"`、稳定 `attemptId`、`segmentId/expectedSequence`、`input:{text,images,toolResults,observations}` 和有限 `limits`。这不建立学习聊天或执行工具。`models/calls/<id>` 的查询、`dispatch/cancel` 复用可靠调用状态机；`models/checks` 仍只接受合成文本检查用途，两类 ID 不能混用。原生调用最多 2048 输出 token、30 秒、32 步；完整 wire 最多 1 MB、8 张图片，超限拒绝而不裁剪。

工具参数按 choice/tool index 聚合；只有名字、身份、完整 JSON/schema、整体终态和可读持久结果同时成立，公开结果才出现 `toolIntents`。拒绝、半截参数、截断、未知关键块、缺终态或本地发布失败不交付意图。DeepSeek 保留 `reasoning_content`；已实测 Command Code 方言保留 `reasoning` 及按块索引聚合的 `reasoning_details`，未知关键格式保留原始 chunks 但不可续接。公开投影不返回原生推理。

调用方用 `toolResults:{callId,outcome,text,images}` 明确提供 success/error/not-executed；同段下一步必须完整、唯一配对。也可用 `POST models/segments/<id>/tool-results` 先结清而不请求模型。Gateway 不替调用方执行或取消工具。工具产图用配对文本结果和紧邻用户图像，原关联保留在工具结果及输入元数据；不声明原生 tool-image 支持。

段前缀不允许修改；换 system、工具集合、参数或路线时，在工具已结清且物理请求结束后创建新段，封存旧段。新段只接调用方提供的可移植文本和本主体已完成结果引用，不搬旧 native/tool ID。新观察使用 `{observationId,version,source:"caller",text}` 追加，版本冲突不能覆盖；这只记录调用方提供的观察，不替代 WP02 的材料/工作区授权。没有 WP08 压缩算法或 WP07 切换流程。

前缀摘要按固定 UTF16 键序生成，与主机语言设置无关。选用界面区分已确认 CAS 拒绝和未知提交：确认冲突后重读可按新版本重试，未知结果保留原请求身份核实。显式 `json-schema/strict:true` 同样视为必需原生能力，未知/不支持时在外发前拒绝；受控能力探针必须明确标记，不能把 strict 请求降为仅本地校验。

图片只支持固定 `image/png`，单件不超过 256 KiB、2048×2048，校验 PNG chunk/CRC、颜色/位深、解压长度及扫描线。输入每组最多两张；总历史仍受上述 wire 限制。原件和变换来源均按当前主体校验并保留资源引用，真正编码为 image content；不能用图片 ID 读取其他主体或教师原件。

## 能力证据与参数组合

直接 SDK `openai@7.42.0`，原生 adapter `xunjie-chat-native-v2`。`capabilities.ts` 只匹配已复验的 endpoint/model/protocol/dialect/mode，并返回日期和 SDK/adapter 版本；改名称不改变证据，改地址/型号/模式不能继承。凭据和当前可用性仍单独检查，文本检查不会自动点亮其他能力。

JSON mode、应用校验与 native strict 是不同事实。前两者执行实际 JSON 解析/schema 校验；native strict 需要有效和无效 schema 对照。已测两条标准 Chat 路线均不标为 native strict。DeepSeek thinking + auto 可用，显式强制工具组合的已测限制单独记录；必需能力缺项在外发前拒绝。受控 `capabilityProbe` 可复验未知/受限组合以记录新的实际结果，不能把探针成功等同于所有输入或所有服务版本可用。

真实端点复验入口为 [probe-model-chat.mjs](../../../../scripts/probe-model-chat.mjs)，必须显式提供私有凭据文件和输出路径，最多 11 次生成、每次 2048 token/30 秒、重试为 0。报告只记录状态、哈希、保真比较及用量，不输出密钥、签名或原生 reasoning。`--provider` 可限定单条路线。

## SDK、结果及错误

`openai@7.42.0` 直接 Chat adapter `xunjie-chat-text-v1`，`maxRetries: 0`、拒绝重定向。base URL 与固定 `/chat/completions` 组成实际地址。DeepSeek 方言显式设置 thinking；默认文本参数不保证其他上游关闭其默认推理。尚未接入的协议/参数模式可保存但不能执行检查；不能静默退回另一协议或忽略显式思考配置。

原生请求不含认证；完整原生响应由 owner 保存，公开文本再次脱敏。只有结果资源与结果引用可靠提交后才发布完成。HTTP、流内错误、畸形数据、截断、缺终态、超时、取消和未知状态分别记录。累计 usage 以最后实际值替换，未知不补零，真实零值保留。

维护先关闭新准入/派发，等待已接收检查结果落盘，再封存储写。真实进程崩溃后不重新生成；仅在主机/PID/进程出生身份能确认旧本机处理者已结束时回收其本机物理槽，未知 usage 不变。无法确认远端处理者死亡时继续保守占用；跨机接管由后续子票补齐。

## 恢复与验证

配置版本、加密凭据引用、vault key、请求及结果资源随所属迁移和 WP01 加密备份恢复。默认产品新增后共四个 owner（含 runtime）。恢复旧三 owner 备份时，隔离阶段保持原 owner 集合；按原流程接管后正常停止/启动一次，才初始化空的模型 owner。不要跳过通用恢复的精确版本校验，也不回退到 legacy 模型配置。

#165 新增迁移仅追加到既有版本；授权、选择、图片/变换来源、工具结果、观察、段和客户端持有方绑定都进入同一模型 owner。资源 pin 随接收/结果/段事务提交，旧段或设置更新不释放仍引用的原件。维护验证检查已有结果与图片内容；真实备份→隔离还原→接管后可读原引用并继续原生工具配对。旧 schema 必须走 WP01 正式升级，正常启动不偷偷迁移。

主测试 [model-gateway.runtime.test.mjs](../../../../apps/server/tests/model-gateway.runtime.test.mjs) 经生产 API、真实身份/PostgreSQL/资源和 SDK→合成 HTTP/SSE；需要 `XUNJIE_PRODUCT_POSTGRES_BIN`。桌面 Chrome 用例见 [personalModelSettings.spec.ts](../../../../apps/web/e2e/personalModelSettings.spec.ts)，可指定 `XUNJIE_PRODUCT_WEB_ROOT` 验普通 Web，或 `XUNJIE_PRODUCT_TEST_PACKAGE` 启动完整独立包。实施范围见 [#164 方案](../../../../docs/student-agent-implementation/specs/wp06-personal-model-checks.md)。


## Responses（#166）

同一 Gateway、尝试、授权、费用和续接段支持 `responses`；正式设置和安装客户端消费同一 wire。直接 `openai@7.42.0` / `xunjie-responses-native-v1`，retries=0；DeepSeek 使用 `reasoning.effort`，系统前缀编码为 `instructions`。每次 `store:false`，原生完整历史重发，不使用远端 retrieve/cancel。

owner 保存完整 events/response/output，并在维护和续接时校验格式、已观察增量与终态的一致性。工具 added 暂缺 arguments 合法，只有完整 completed、原生回放验证与工具参数应用校验都通过才发布意图。凭据回显拒绝成功，敏感原生正文及可重建的碎片不保存。图片使用固定所属资源；工具图片直接进入 `function_call_output.output`，按 call_id 配对，不使用 item ID。新段沿用结清工具与可移植上下文规则。

主测试 [model-responses.runtime.test.mjs](../../../../apps/server/tests/model-responses.runtime.test.mjs) 使用生产 Gateway、真实 PG/资源和 SDK；含重启、备份还原、取消和 Chat 双向换段。[实际路线及能力边界](../../../../docs/student-agent-implementation/wp06-responses-acceptance.md)区分 JSON mode、应用 schema、原生 schema 与 strictTools；未知能力不自动晋升。显式实测工具 [probe-model-responses.mjs](../../../../scripts/probe-model-responses.mjs) 从获准 Magpie 私有配置读取 DeepSeek key，支持 `--case native|schemas`；每次最多六次有限生成，输出不含原生推理或密钥。Command Code 本轮由负责人豁免真实端点，合成 summary/缺 arguments 方言回归保留。

## Anthropic Messages（#167）

同一 Gateway、授权、费用、调用状态机和原生段支持 Messages；正式设置、学校网页与安装客户端消费同一 wire。直接 `@anthropic-ai/sdk@1.1.0`，adapter `xunjie-messages-native-v1`，retries=0。DeepSeek base 为 `https://api.deepseek.com/anthropic`，SDK 路径 `/v1/messages`，固定兼容 header `2023-06-01`；不改成 Claude 模型。末尾已有 `/v1` 的 base 可保留配置，但派发前拒绝，须由用户修正。

system 为顶层字段，thinking 模式明确编码；DeepSeek 忽略 budget_tokens，因此不把其 SDK 必填值当作有效思考预算，仍有请求输出上限。直接 SDK 事件流有界聚合并保存完整 assistant content、thinking/signature、工具身份与事件。SDK MessageStream 会覆盖 signature 片段，本模块显式拼接并以持久事件重建校验；未知关键块、缺整体 message_stop、拒绝、截断和无效 JSON/schema 不可消费。新格式纳入所属维护验证、资源保留、备份还原及接管，不新增状态权威。

工具结果按 tool_use_id 原顺序放在下一条用户消息前部，含原生 tool_result 图像；error/not-executed 同时使用明确配对文字和 is_error，不依赖 DeepSeek 忽略的标志。用户图片和工具图均从获准固定资源物化；原生段与跨协议边界不改变旧规则。最终 usage 按方言覆盖累计值，缺失保持 partial/unknown；不捏造 total_tokens，input_tokens 与缓存命中分列。取消后上游计算/费用未知。

应用 schema 由显式 applicationSchema 验证。未验证/不支持的原生格式（含 strict:false）及 strict 工具请求在外发前拒绝；受控 capabilityProbe 才能验证反例，不会自动晋升。Messages 不编码 JSON object mode，不把 prompt 或输出 200 当能力。实际 DeepSeek plain output_config.format 与不可满足严格工具 schema 的反例均由本地校验拒绝；thinking+具名强制工具有 HTTP 400 反例。Command Code 目标型号 2026-11-03 目录不含 Messages，配置可读、检查拒绝，不借别的型号替代；目录变化后显式复验更新证据。

`ModelAttempt.upstream` 只保存可确认 HTTP 状态、有限 request-id、retry-after 秒数或绝对日期，不投影其他 headers/body；含凭据的请求 ID 丢弃，等待提示不授权自动重试。该事实同结果一次提交并纳入 owner 9 的 JSON 约束/版本；旧 owner 8 环境通过 WP01 正式 schema upgrade，正常启动不偷偷迁移。

主测试 [model-messages.runtime.test.mjs](../../../../apps/server/tests/model-messages.runtime.test.mjs)、[桌面 Chrome 用例](../../../../apps/web/e2e/messagesModelSettings.spec.ts)和[真实端点探针](../../../../scripts/probe-model-messages.mjs)均消费生产入口。探针按 `--case native|schemas|controls|check|cancel` 分组，显式提供获准私有配置与脱敏输出，单组最多 6 次，输出只含状态、哈希、保真比较和用量。完整行为、反例与验证限制见 [#167 交付](../../../../docs/student-agent-implementation/wp06-messages-acceptance.md)。
