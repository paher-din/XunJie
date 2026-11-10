# 模型选择、有限检查与三协议原生续接

本模块承接 #164–#167 的 `ModelGateway`，由产品组合注入 WP02 的真实授权与所属 storage。配置、加密凭据、选择/授权、固定图片、工具结果、原生段和调用事实属于独立 `model-connection` owner。浏览器只消费 [公开 wire](../../../contracts/src/model-connections.ts)，不引用 SDK、数据库或旧 Session/store。验收见 [#164](../../../../docs/student-agent-implementation/wp06-personal-models-acceptance.md)、[#165](../../../../docs/student-agent-implementation/wp06-chat-selection-acceptance.md)、[#166](../../../../docs/student-agent-implementation/wp06-responses-acceptance.md)和 [#167](../../../../docs/student-agent-implementation/wp06-messages-acceptance.md)。

## 公开接口与生命周期

| 接口 | 行为 |
| --- | --- |
| `list/save(identity, input)` | 兼容单模型调用方的连接投影与 CAS 保存；凭据通过 `keep/replace/clear` 明确操作；已归组连接通过供应商接口更新 |
| `providers.list/save(identity, input)` | 供应商共享名称、协议、地址、密钥；一个事务保存所有模型，供应商及每个模型分别核对版本；原 requestId 核实原回执 |
| `profiles.read(identity, input)` | 从公开目录解析型号、思考档位与参考容量；未知型号不禁止手填，显式 refresh 更新目录 |
| `checks.receive(identity, input)` | 稳定 attemptId 固定主体、用途、配置、限制及原生请求；同内容返回原记录，不同内容冲突；临时凭据与接收同事务 |
| `checks.dispatch(identity, id)` | 有效授权与代际下最多一次外发；重复派发只查原记录；没有课程、活动或 Run 前置 |
| `checks.read/list(identity, id?)` | 只读原事实，并核验结果资源；结果含部分文本、usage 及 resultRef，不返回原生 reasoning 或错误正文 |
| `checks.cancel(identity, id)` | 未外发确认未开始；外发后 abort 本机 SDK；保留终态竞争的实际事实，上游计算/费用仍未知 |
| `checks.progress(identity, id)` | 只返回学习 attempt 已通过凭据尾部扣留并持久化的安全正文前缀与修订号；探针不写进度 |
| `school.save(spaceId, input)` | 仅受认证的宿主管理入口调用；每个学校一个默认连接，CAS 更新、停用、检查许可和限额 |
| `selection.read/save`、`selection.createGrant/revoke` | 真实主体的显式引用、费用来源及授权版本；撤销不删除历史，不回退到学校额度 |
| `images.upload` | 接收本主体的固定 PNG 原件或有来源的变换版本；不接受 URL、教师材料 ID 或任意文件路径 |
| `segments.create/read/settle` | 固定路线、格式版本、system/工具/参数前缀、序号、完整结果引用及调用方工具结清 |

HTTP 装配见 [learning-entry](../learning-entry/README.md)。每个检查只发送固定合成短文本；最多 128 个输出 token、30 秒等待、每主体每小时 6 次准入，全组件最多 2 个、同主体最多 1 个未结束物理请求。取消、失败、缺 usage、重复请求或重启均不返还准入计数。授权 60 秒有效，查询时将未派发的过期检查终结并释放临时凭据。临时凭据随检查终态在同一所属事务删除，避免完成回执后崩溃留下密钥。

个人配置编辑器通过 `readCredential(identity, connectionId, version)` 读取自己原版本的完整密钥，默认遮挡并可切换显示；此入口不读取学校默认或他人授权连接的密钥。列表、选择与检查投影仍不返回密钥。编辑器每次保存输入框当前值，非空即替换，清空即移除；`keep/replace/clear` 保留为底层及学校管理调用契约，不再作为用户编辑操作。读取失败时阻止保存与检查，避免把读取失败误当成清空保存。

保存前共用 `modelBaseUrlError` 校验确定的格式与路径组合错误。协议由地址旁的分段控件选择并切换示例地址，系统追加固定接口路径。可达性、鉴权与上游协议支持由显式连接检查确认，不归类为输入格式错误。已有错误地址的投影仍能读取，允许在编辑器修正。

供应商卡片和每个模型行分别提供启停开关，实际 `enabled = providerEnabled && modelEnabled`。停用供应商保留每个模型的选择，禁止新的选用和外发。旧连接按单模型供应商读取，首次保存时建立组；保留原 connectionId、routeId、授权及历史版本。启停使用底层 `credential.keep`，不读取或重发明文密钥。

正式编辑器使用“思考强度”，内部自动解析供应商适配，用户不再选择 dialect / parameterMode。已核对的模型规则与动态目录共同提供档位，未知型号默认仅 auto，用户可按供应商资料手动声明档位；资料和声明都不提升能力验证状态。`reasoningLevels/reasoningSource` 固定进保存版本，调用时按原快照编码，不随外部目录变化。旧版本缺少 reasoningEffort 时保持旧 wire 行为。

动态资料按需从 `https://models.dev/api.json` 整体下载，不上传密钥、地址或模型 ID。进程内共享下载与 24 小时缓存，用户可显式更新；失败保留已有缓存和保存版本的资料。没有另设常驻进程，也未实现供应商 `/models` 自动发现；当前模型 ID 保持自由填写。目录容量是参考值，用户选择“填入参考容量”后才写进表单。

## 学校默认和个人引用

正式产品宿主可在 `openProductRuntime().install({ learningAdmissionPolicy })` 固定 learning 准入策略，保存到安装配置并随 runtime 备份还原；浏览器不能提交该策略。同一策略版本不能对应不同数值，变更值须使用新版本。省略时采用本模块的有限默认值，原 attempt 保留接收时的策略与费用来源。SDK 已在本地结束与上游计算已确认结束分别记录；未知上游保留物理槽，未知 usage 保留费用预留。需要在一个未知调用未清账时开始另一个独立请求的部署，应显式配置相应的有限主体并发，不能通过换 Run、grant 或安装重置旧占用。

学校维护者使用 `xunjie school-model --root <学校环境> --file <私有 JSON>`，其输入为 `schoolModelInputSchema`：正常连接保存字段、`requestId/expectedVersion/credential`，以及 `policy: { checksAllowed, maxChecksPerHour, maxOutputTokens, timeoutMs }`。首次版本为 0；更新用返回版本；`enabled:false` 停用，`credential.action:"clear"` 显式清除。凭据放私有文件，命令只输出脱敏配置；管理凭据由产品在本机解析，学生不能调用管理写入。没有“管理员允许个人模型”开关。

正式设置通过 `models/selection` 读取学校默认、本人及本机持有的选项。个人选项的“授权并选用”先用 `models/grants` 为**当前已认证主体**建立引用，再以选择版本 CAS 提交；`owner:device` 只由安装客户端证明本机持有者。学校网页的个人连接由该网页所在持有方保管，跨组件的本机模型由安装客户端持有。不存在以账号同名、请求中的主体 ID 或连接 ID 借用密钥的入口。

安装客户端沿 WP02 的真实学校连接授权实时核验身份及目标；学校服务在学校生成，个人服务在本机生成。客户端 owner 持久绑定每个 attempt/segment/image ID 的原持有方和输入摘要，重复接收和后续查询/取消不会因当前选择改变而转发到另一方。断连/撤销后不能继续外发；完整独立部署、跨机和代际接管归 #168。`x-xj-expected-subject/namespace` 只作视图隔离，不能建立身份。

跨学校/本机持有方换段时，客户端模型 owner 通过原持有方认证读取 `models/results/<ref>` 的完成/结清公开事实，使用 `segments/<id>/close` 明确封存旧段，再保存带原 owner、路线、结果引用和可见文本摘要的 `provenance`。新持有方只收到调用方可移植文本，不伪称自己验证了外部原件，也不搬运旧 native/tool ID；原出处由客户端的持久段路由记录保留并返回。原件继续被原 owner 的段/尝试保留。多 owner 之间不做分布式事务：创建新段失败时旧边界仍可查询，修正请求可引用同一已封存边界重新创建，不自动恢复旧调用。

接收和紧邻 SDK 外发前均重新检查成员、个人授权版本、连接启用及凭据可用性。普通配置更新不更换已接受请求的模型、地址、参数、凭据引用或费用来源；清除/替换凭据、停用和撤销阻止尚未外发者。共享学校检查上限按费用来源串行准入，不从个人借额；原生探针与检查均有持久准入和物理并发上限，不是 WP07 的学习 Run 预算。

## 原生 Chat 调用 wire

`POST models/segments` 接收 `segmentId/requestId/source/prefix/portable`，可用 `previousSegmentId` 表达新段出处。`prefix` 固定 `system`、工具 `{name,description,inputSchema}` 和可选参数：显式 `toolChoice`、`responseFormat`、`applicationSchema`、`requiredCapabilities`、`capabilityProbe`。工具只支持同步、有限深度的本地 JSON Schema 校验；异步、外部引用、正则执行等未接入项在外发前拒绝。

`POST models/calls` 是受控调用方使用的同一 Gateway 入口：`purpose:"chat-probe"`、稳定 `attemptId`、`segmentId/expectedSequence`、`input:{text,images,toolResults,observations}` 和有限 `limits`。这不建立学习聊天或执行工具。`models/calls/<id>` 的查询、`dispatch/cancel` 复用可靠调用状态机；`models/checks` 仍只接受合成文本检查用途，两类 ID 不能混用。原生探针调用最多 2048 输出 token、30 秒、32 步；完整探针 wire 最多 1 MB、8 张图片，超限拒绝而不裁剪。

学习用途由 `teaching-agent` 的受认证 `RunDriver` 在自己的 owner 内接收，不经过公开 `models/calls`。学习段与 attempt 复用同一选择、授权、segment/check 状态机、三协议 SDK 和原生结果资源，但不受探针次数、段序号、输出或时间上限约束；输出上限与上下文窗口取保存的模型配置，`maxOutputTokens` 不再被探针上限静默改写。每段可携带真实 `user/assistant` 角色的可移植历史；学习调用仍不执行工具。

学习 attempt 的增量正文写入独立 `model_attempt_progress` 表（迁移 11）。三种协议都在解析各自增量后调用同一个凭据尾部扣留发布器：完整凭据出现前不公开可能拼出凭据的尾部，出现后停止公开；探针、检查与取消不产生进度行。进度读取只返回已持久化的安全前缀与修订号，`teaching-agent` 再用稳定 attempt 身份追加事件。

WP09 在相同进度记录中追加有界工具参数预览。只有固定工具定义声明的 JSON 字符串属性可投影，保留原 call/attempt 与单调修订；三协议共用凭据处理和持久确认，不把该内部描述传给供应商。半截 JSON 不修复成工具意图，完整结果与派发仍由下述终态边界决定；渲染和启用归 [WP09](../../../../docs/student-agent-implementation/wp09-implementation.md)。

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

维护先关闭新准入/派发，等待已接收检查结果落盘，再封存储写。真实进程崩溃后不重新生成；仅在主机/PID/进程出生身份能确认旧本机处理者已结束时确认其本地 SDK 已结束，未知 usage 不变。无法确认远端处理者死亡时继续保守占用；跨机接管由后续子票补齐。

## 恢复与验证

用正式包的 `xunjie install --profile model --root <设备环境>` 创建独立模型运行环境，然后用 `xunjie start --root <设备环境>` 启动。`status` 返回独立的 `model-connection` 服务身份及监听地址，`stop` 走正式维护排空。此模式保留主体认证和模型 owner，使用 PostgreSQL，不装配学习数据 owner。配置仍使用本机产品的 `?settings=models` 入口。学校配对时，成员的学习目标与 WP01 授权来源都使用该设备的 `model-connection` 服务身份。学校无需访问设备监听端口。

独立模型环境使用通用 `backup`、`restore`、`takeover` 流程。恢复默认保留 `model` 装配。接管后在正式模型设置核对提示，并用原引用检查结果。重新连接时为新安装签发 WP01 授权并更新设备绑定。

学校侧受控调用方可用正式包中的 `xunjie model-task --root <学校环境> --file <请求 JSON>` 或产品运行时的 `modelTask` 接口提交和查询已配对设备的调用任务。两者都走学校宿主的本机控制端口。任务用独立 `taskId` 标识，`attemptId` 保持模型调用原身份。设备主动经 `learning.authority` 拉取并交回回执；早期调用任务仍核对学习 owner，WP07 的版本化学习任务使用独立成员模型绑定，不改变学校活动和作品的目标。

`service.ts` 的 `LearningModelPort` 覆盖选择、原生段、学习请求、公开进度、请求重建、固定图片与结果保留。`paired-learning.ts` 在学校模型 owner 保存任务及段/attempt/图片/结果的固定目标；后续选择或绑定变化不能把旧请求转发到新设备。设备模型凭据留在设备，SDK 外发前重新验证原 Agent 服务、安装、授权和 Run 领取代际。单次任务内部读取共享接受时的准入结果，外发校验独立执行；未知回包使用原业务身份核对。版本化任务支持建段前准备，不伪造尚未存在的 Run 或 attempt。

Root 的 `models.selection.read/save` 保存同一成员选择版本，合并学校默认、Root self 和已配对设备的选项。设备经原 `learning.authority` 的 `modelChoices` 发布公开投影；学校设置页可直接发现选项，无需先打开活动或调用 Agent。迁移 14 保存设备元数据及按原 outbox 接受顺序更新的刷新事实；绑定、发布和设备个人空间的选择都不改 Root pointer。显式选设备仍用原 `selection.save` 的 `{kind:'personal',connectionId,grantId}`。个人凭据、native 与费用事实留在实际 owner。旧段、attempt、图片及结果沿已持久路由继续访问；设备离线不改选择，不借用 Root 或学校额度，未选设备的离线不阻塞已有 Root 选择。

`paired-grants.ts` 与迁移 15 保存授权创建、撤销、固定 grant 路由和结清事实。学校网页为设备选项创建授权时，任务由原设备实际建立 grant，Root 导入确认事实后才返回，现有“授权并选用”的连续请求无需中间刷新。撤销先在 Root 持久禁止该 grant 的新调用，包含原段和在途 attempt，再由原 owner 确认 inactive；未知回包保留原任务和原因，重查不会改变 owner。安装客户端的学校空间读写同一 Root pointer，其已有 school-scope 配置、个人配置与凭据继续由设备保管，个人空间的选择保持独立。授权任务遇到临时不可用、维护、资源忙或未知提交时保持 pending；恢复后沿原 task/request/grant 核实，不提交永久错误回执。调度按实际 binding 读取未结清任务，单批最多 16 条，维护验证及备份包含这些事实。

`selection.resolve` 是学习 service 的新增操作，对指定 source 的真实 grant 重新核验并返回 snapshot，不读取或修改设备当前 selection。设备学习建段允许第二个 source 参数，实际 owner 重新校验该 grant，并把它纳入原段创建指纹。宿主对外部设备选择消费 paired adapter；原始 Root `selection.snapshot` 对设备 pointer 明确拒绝本地解析。安装客户端学校视图已接 Root 入口，个人视图继续使用设备自己的 pointer。

学习网络 `selection.read` 拒绝不同主体的可选 `deviceOwner`。本机 UI 由可信宿主解析个人身份后直接调用 `Gateway.selection.read(schoolIdentity, personalIdentity)`，保留原有本人设备用途；对端不能通过参数指定另一账号。

`origins.ts` 的迁移 13 把设备侧 journal 放入实际模型 owner。`models.origins.bind(identity, associationId, origin)` 固定原任务或 attempt 的主体、Agent 服务/安装/grant、设备恢复代际及已有 run/activity；调度者 driverId/generation 只用于每次任务的资格复核。`assert` 是不读取正文的可信 Node 核对接口，`validate` 进入 Gateway 维护验证，journal 随模型备份还原。school-client 只迁入并删除旧文件，不再创建文件 journal；其 `modelTarget` 与学习数据 `target` 独立。

宿主可提供 `authorizeActive(identity, attemptId)`，在 SDK 在途期间强制复核原任务资格，不得复用准入 cache。未提供时沿用 fresh `authorizeDispatch`；两者都没有时使用普通授权。默认每 1000ms 非重叠复核，可通过 `authorizationPollMs` 调整；短请求在归档前也复核。失权或无法确认时先持久请求取消，再 abort 原 SDK；已经开始的复核必须结清才能归档成功。内部 `models.checks.cleanup.status(scope, attemptId)` / `cancel(scope, attemptId)` 只接收原 `{environmentId,spaceId,principalId}` 与 attempt，绕过成员授权但不能读正文、创建或派发请求，也不加入网络 service 操作表。未确认的清理阻止维护 drain 宣告完成；原生结果仍归档到原 attempt，撤权后的完成不发布工具意图或恢复成功状态。

```ts
const school = openProductRuntime({ root: schoolRoot });
const binding = { grantId: runtimeGrant.grantId, installationId: deviceInstallationId };
await school.modelTask({ operation: 'enqueue', identity, binding,
  task: { taskId, attemptId, operation: 'read' } });
const result = await school.modelTask({ operation: 'read', identity, binding, taskId });
```

`identity` 使用学校已认证成员身份，`runtimeGrant` 来自已批准的 WP01 `learning.authority` 配对。`receipt: null` 表示学校尚未持久收到回执。若提交响应丢失，用同一任务参数和 `taskId` 查询或重复提交。需要查看设备上的最新调用状态时，用新的 `taskId` 排队一个 `read`，沿用原 `attemptId`。

任务和回执随模型 owner schema 10 进入备份，接管后查询仍按原身份和原绑定返回。新绑定不会领取旧绑定的待处理任务。原生结果仍由模型 owner 持有，Run、活动和交付可通过 owner 的 `results.retain` 与 `results.release` 增减各自的保留引用。

独立模型的 Root 发现、创建、撤销和在途停止见 [paired-model-grants.runtime.test.mjs](../../../../apps/server/tests/paired-model-grants.runtime.test.mjs)；安装客户端设置与实际独立 Agent 三条路线见 [agent-model-selection.runtime.test.mjs](../../../product-runtime/test/agent-model-selection.runtime.test.mjs)。[learning-model-school-tasks.runtime.test.mjs](../../../../apps/server/tests/learning-model-school-tasks.runtime.test.mjs)覆盖授权已提交但回包丢失、撤销后资源忙与原任务恢复。

配置版本、加密凭据引用、vault key、请求、结果资源和独立设备路由随所属迁移和 WP01 加密备份恢复。当前完整默认产品共五个 owner（含 runtime 与教学 Agent）。恢复旧备份时，隔离阶段保持其实际 owner 集合，按通用恢复的精确版本校验推进，不回退到 legacy 模型配置。

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

## PR #177 审查修复

模型 owner 的网络资格由可信产品装配给出：学校普通成员的个人连接只允许公网 HTTPS；`manage/model-default` 由管理员显式批准学校内部端点；`local/model` 持有方可访问本人设备的 loopback/私网模型。浏览器不能自报持有方或提高资格。保存、草稿/已保存快照和派发均检查目标；公网域名的全部解析结果都必须获准，SDK 使用紧邻外发重新校验后固定的 DNS 地址，禁止重定向。link-local、元数据与其他特殊网段不开放。已有学校配置不能借用设备网络资格，离线设备不回退到学校宿主。

`POST models/capabilities` 接收 `{source,prefix}`，与段创建使用同一固定配置判定器。公开结果包含 `routeId/configurationVersion`、全部必需项的 available/unknown/unsupported、证据、限制及实际装配方式；缺项的段创建返回 HTTP 422 / `capability-unavailable` 与相同 decision。学校转发保留该结果；探针不会晋升证据或更换路线。

三协议在协议定义的参数解析与分片聚合后使用共享敏感值门禁，明确结构化输出边界的检查独立于成功状态。凭据命中不发布成功或工具意图，并清除可重建凭据的原生正文；签名/隐藏块不改写为可回放内容。被解析器拒绝或原生结果无效的正文整体扣留，保留安全结果 envelope 与已确认状态/用量/上游事实；合法截断仍保留可解释的原生片段。已知 logprobs 主 token 序列同样检查。Chat 在完整有效终态后保留传输断开前的事实，格式错误、显式错误及资源超限仍拒绝消费；最终 usage 独立于输出 completed/incomplete。2 MB 原始响应限界位于 SDK 解析前，包含 SSE 注释与未闭合行。三协议持久保存同一白名单上游 HTTP 事实。

Chat 先补齐同一组全部工具回复，再追加用户图片消息；每张工具图携带原 callId 与固定资源版本。Messages 截断工具 JSON 时继续读取有界终态与用量，合法空 end_turn 可完成；半截参数始终不产生工具意图。设置页后台读取不会清除操作失败；冲突时保留草稿与密钥意图，显式读取/核对后重试；未知提交使用原 requestId 与原 payload 核对。

定向单测见 [协议](../../../../apps/server/tests/model-protocol-review.test.mjs)、[Messages](../../../../apps/server/tests/model-messages-review.test.mjs)、[网络政策](../../../../apps/server/tests/model-network-policy.test.mjs)、[能力和图片](../../../../apps/server/tests/model-capability-images.test.mjs)。真实 PostgreSQL、宿主权限、持久化和重启回归见 [model-review.runtime.test.mjs](../../../../apps/server/tests/model-review.runtime.test.mjs)；修复矩阵与实际验收见 [PR #177 修复记录](../../../../docs/student-agent-implementation/wp06-pr177-review-fixes.md)。

## Learning 共享准入（R9）

`learning-admission.ts` 在模型 owner 的持久事务中按稳定 attempt 接收顺序保存队列、政策版本、费用来源、跨活动主体资格、费用预留及物理槽。默认 `learning-token-budget-v1` 为每费用来源滚动 24 小时 1000 万 token、owner 并发 8、费用来源并发 4、主体并发 1；可信宿主可通过 `learningAdmissionPolicy` 配置有限政策，新参数必须使用新版本。Learning 不消费探针每小时次数；其共享预算、物理并发与 Run 自身预算分别成立。

预留为原生请求 UTF-8 字节数、4096 token 帧开销余量及实际输出上限之和；最终费用按 input/output 总量核对，cache/reasoning 细项不重复累计。服务商报告的更高 total 以实际值结算，超出预留的差额保留在共享账中，后续请求继续受预算约束。最终 usage 和结果引用同事务结算一次，未知费用持续占预留，跨预算窗口也不退款。确认调用结束但 usage 未知只释放物理槽；取消、断流和旧 dispatcher 结束不会证明上游结束，继续保留费用与物理槽。`ModelAttempt.physicalRequestEnded` 保持本地 SDK 结束的原语义；ledger 的独立 `upstream_ended` 才授权释放 `physical_held`。本地结束后逻辑 stop、维护排空和备份可以完成，未知上游占用随账本恢复并继续限制新准入。确定外发前取消或未发送的 claim 才能撤销预留。

缺少资格时 attempt 保持 `accepted` 和原输入，`reason` 分别说明主体并发、费用来源并发、owner 物理容量、费用预算、单请求超预算或公平队列等待。仅已请求派发的请求进入公平队列，按原接收顺序选取当前合格者。派发在慢预检前持久标记 ticket，资源等待保留 ticket；授权或预检失败时撤回未预留的 ticket，保留原 attempt 与输入。撤回事务失败或提交未知时向上传播存储错误，由 Run 沿原 attempt 重试确认后再报告原授权失败；ticket 身份防止旧失败回包撤回较新并发重试；尚未请求派发或已失去资格的旧请求不能阻塞其他主体。`LIMIT 20` 仅是教学端扫描批次；准入上限由政策和持久占用决定。迁移 19 保存这些准入事实；教学端等待释放逻辑执行者，后台重试同一 attempt，并轮转扫描等待的 Run。

[原生 PostgreSQL 准入测试](../../../../apps/server/tests/learning-admission.runtime.test.mjs) 使用实际 owner 事务与 SDK、受控 fetch 计数，核对竞争、等待、重启、未知调用和一次结算；[政策源码测试](../../../../apps/server/tests/learning-admission-policy.test.mjs) 核对有限配置与真实 usage 核算。
