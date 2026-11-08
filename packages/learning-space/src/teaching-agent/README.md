# 可恢复的学习对话

`teaching-agent` 是正式学习对话的 PostgreSQL owner。它消费 WP02 的可靠 `ActionReceiver`、WP06 的 `ModelGateway` 和活动 owner，保存请求回执、取消记录、Run、输入、session log、不可变快照与持久待发项；浏览器不直接创建原生 attempt，也不持有推进权。

## 数据与推进

| 表 | 事实 |
| --- | --- |
| `teaching_requests` | 固定输入摘要、接收/取消状态、原回执与 `runId/inputId` 关联 |
| `teaching_runs` | 状态、停止请求、`attempt_id/segment_id/model/usage`、DB 时间 lease、generation、`previous_run_id` |
| `teaching_events` | 活动级稳定 `seq` 的输入、上下文装配、派发、增量进度、答复、终态与系统说明 |
| `teaching_sessions` | 活动连续的 native segment、固定前缀指纹 |
| `teaching_snapshots` | 外发前的不可变装配正文、来源、模型参数、`payloadSha256` 与资源引用 |
| `teaching_agent_definitions` / `teaching_resolved_agents` | 固定 AgentDefinition 正文与版本、按主体/活动/课程解析的实际 Prompt、工具与 executor 来源；Run 保存初始身份，步骤绑定当时身份 |
| `teaching_segment_transitions` | 首段、装配变化及模型切换的共同接收/完成记录，固定原段/新段、装配、close/create 请求正文与原操作回执 |
| `teaching_steps` | 稳定模型 attempt、完整输入计划、请求快照、原生结果关联、工具配对与输出预留/结算 |
| `teaching_commands` | 独立 command ID、原生 call ID、固定命令依据、派发许可、原回执与完整结果资源 |
| `teaching_waits` | 原命令、身份与摘要、期限、确定性查询时点和唯一消费事实 |
| `teaching_budgets` | 本 Run 固定的模型步骤、工具命令、并行和 Wait 配置 |
| `teaching_student_questions` | 固定 `student.ask` 问题、来源、问题/Wait 版本、呈现与明确回答状态 |
| `teaching_student_presentations` | 幂等呈现回执；不代表学生回答或模型已采用 |
| `teaching_student_responses` | 独立输入身份、原文摘要、接受/拒绝结果及原回应查询 |

接收、Run、输入与事件在同一事务提交；同身份同内容返回原回执，换内容冲突。接收前取消写入持久取消记录，迟到派发不能复活。`RunDriver` 用 `clock_timestamp()` 领取代际与 lease，条件提交保证单一推进权；lease 只决定推进权，不是生成期限。过期接管先按原 attempt 身份查询/续接，已接受未派发的 attempt 由新推进者继续派发，不第二次付费生成。

停止先持久标记 `stop_requested`，等待中的 Run 取消原调用；已经发生的结果按 `assistant` + 终态事件保存，未确认的外发保持 unknown 并暂停。符合恢复条件的非终态按原身份继续，失败或停止等终态后须明确选择输入建立关联后继，原终态不复活。

## 版本化装配与执行

按需目录、固定绑定加载及大结果范围读取见 [#216 实施说明](../../../../docs/student-agent-implementation/wp08-216-tool-discovery.md)。它们沿原 Command、原生配对、预算及资源保留边界，不新增运行循环；小结果反馈保持原字段位置。

`assembly.ts` 是普通步骤与显式换模型共同使用的装配入口。`AgentDefinition` 固定目的、Prompt 模板、能力引用、上下文策略、输出契约和预算规则；`ResolvedAgent` 固定实际交集、模型、分层规则、工具完整定义和 executor 绑定。同逻辑名称的不同来源产生稳定协议别名，调用只按已保存绑定进入原 executor。生产工具 host 从实际平台与课程贡献生成装配，跨 owner 的 `tool.contributions` 保留同一来源；执行前重新核对当前来源、版本、对象资格和原 Run 许可。

新步骤使用快照 v2，内含完整 `resolvedAgent` 与 `contextManifest`；旧 v1 继续可读。清单保存已采用输入、规则、原效果、Command/Wait、实际观察与原生 payload 的固定内容、范围、摘要及容量未知项。旧请求查询只读已保留的 JSON 和资源，不重新装配、检索或调用模型。未消费 queue 不进入装配；steering 仍按原顺序采用。

`segments.ts` 的 `receive` / `advance` 接口由原 Run 或模型切换的持久权限推进，记录原操作身份后才接触模型 owner。接管核对同一段、前缀与路线；父权限代际改变时不能被旧的内部 lease 阻塞。未闭合原生工具配对拒绝换段，accepted 已闭合配对可保留原 Wait。配置变化不伪造学生换模型事件，换段不重置预算或重新派发工具。工具发现与加载沿这个入口追加真实变化；Skills 和压缩继续复用同一边界。

`skills.ts` 保存独立说明包的固定版本、个人范围选择、停用与实际读取；课程包随原发布固定，正文/附件由所属 Agent 授权读取。`skill-runtime.ts` 把渐进读取接入同一工具命令账本：普通读取保留原生配对，配置变化沿共同装配和换段生效。正文低于课程帮助规则和学生当前意图，scripts 只作为资料，allowed-tools 不授予执行权限。旧步骤从原快照和来源纯读，不重新加载当前版本。正式设置/草稿、范围与维护细节见 [#217](../../../../docs/student-agent-implementation/wp08-217-skills.md)。

运行中补充与排队由同一 owner 的迁移 8 保存：`teaching_inputs` 是当前输入投影，`teaching_input_revisions` 保留不可变版本，`teaching_controls` 保存原控制回执，`teaching_run_input_selections` 固定显式续接选择。短元数据事务共用持久顺序屏障；外部调用不持锁。步骤计划固定本次输入版本和所观察的 Wait 结果，接收、采纳、许可和收尾竞争有统一顺序。正常完整轮只自动推进明确 queue；失败、停止或预算到期暂停未消费输入。可恢复的非终态续原 Run，终态后须明确选择输入建立关联后继。详见 [#200 实施选择](../../../../docs/student-agent-implementation/specs/wp07-input-control.md)。

`driver.ts` 使用同一状态机推进模型和工具。模型外发前先保存完整步骤计划和稳定 attempt 身份，再保存实际请求快照并取得派发许可。模型结果保存后，原件关联、步骤完成与工具意图在一个所属事务提交；恢复重读原结果，不重新生成。不可消费的输出不产生工具命令。

`tools.ts` 提供版本化的 `read_work`、`read_reference`、`read_material`、`read_result`、`execution_query`、`execution_stop`；活动有对应组件时增加 `course_operation`。模型选择工具，宿主按本次固定授权取证与执行。课程操作从 manifest 与课程运行方案派生，不在 Driver 内硬编码课程信号。图像只接受 WP06 支持的固定 PNG，并核对原生段已核实的图像能力。

WP03 的 `executions.agent` 是受信任的代码接口，持有 Run／步骤／命令／快照关联及执行点资格回调；普通学生 HTTP 入口不能自报 Agent 发起者。查询与停止限定原 Run 发起的执行，学生独立实验不受影响。已完成输入与其仍在运行的原生会话分别记录，后续停止不改写原输入结果。

浏览器操作通过所属 owner 持久待发与原浏览器领取，再进入既有 broker／Worker／WASM；原生操作通过既有隔离执行器。首次领取固定浏览器身份，多页共享同一持久 broker。丢回执后查询原命令，不换身份、浏览器或节点重跑。

长任务的接受回执先闭合原生工具调用，另存持久 Wait。等待释放模型连接和内存 Run 处理者；有界程序查询原执行，真实结果作为有来源的新观察继续模型。重复通知只消费一次，晚结果归档原 Run，不复活终态。默认配置与具体持久屏障见 [实施选择](../../../../docs/student-agent-implementation/specs/wp07-agent-tools.md)。

`RunDriver` 另外登记固定的 `student.ask` 能力，三协议原生函数名为 `student_ask`。问题、Wait、工具接受和日志在同一准入事务提交，并遵守既有串行工具通道；呈现与明确回应分别记录。回应以独立 requestId、问题版本和 Wait 版本唯一消费原等待，随后按当前资格及剩余预算继续同一 Run。普通新消息不被文本分类成回应。期限结束、停止和晚回应保留实际原因，不复活终态。设计见[明确回应](../../../../docs/student-agent-implementation/specs/wp07-student-ask.md)。

## 上下文与模型

`context.ts` 分开平台指令、Agent 输出契约、运行职责、课程帮助规则与学生输入/事实。活动目标、材料目录、固定引用和作品进入用户数据层，材料不能提高指令优先级。课程发布固定帮助策略；策略禁止问答时在接收前直接取消，不产生模型调用。历史按真实 `student/assistant` 角色进入可移植前缀；换段只携带获准事实与原业务身份。

每次外发使用保存的 `contextWindow` / `maxOutputTokens`，不套用探针的次数、步数、输出或时间限制。容量事实以最终原生 payload 字符数、输出预留和配置窗口记录为 `counter:"unavailable"` 的不确定性事实，不换算成 token，也不据粗略估算缩小配置窗口；输入超过学习传输边界（前缀 400,000 字符、用户文本 1,000,000 字符）时保留完整输入并暂停，不截断作品或历史。

学习正文由 Gateway 在解析协议增量时经过凭据尾部扣留后写入 `model_attempt_progress`；`RunDriver` 只读取已持久化的安全前缀，按 attempt 稳定身份追加 `assistant-progress` 增量事件。`conversation` 把同一 attempt 的增量与最终答复合并为一条消息（稳定 `eventId`），客户端刷新不会重复显示。完整结果落定后不再发布增量；凭据出现在正文时停止公开，最终结果仍按 Gateway 的敏感输出规则处理。

## 公开接口

`learning-entry` 暴露 `agent/<activityId>/conversation|events|capabilities`、`agent/<activityId>/runs/<runId>`、`.../stop`、`.../continue`、`.../requests/<requestId>` 和 `.../snapshots/<snapshotId>`。查询按所属活动与主体授权；`conversation` 以最后返回事件的 `seq` 为游标，重复读取不增加模型调用。快照重建只读取保存的 payload、来源与摘要。

活动页面使用同一个 `ActivityConversation` 控制器轮询对话、显示 Run 状态并提供停止/继续；问题草稿和固定引用仍由可靠草稿 owner 保存。首页“建立并开始对话”把首问写入持久草稿后创建无课程活动，活动页以固定 `requestId` 发送并隔离切换活动后的迟到回复。

明确回应使用 `agent/<activityId>/questions/<questionId>/presentations|responses` 和 `agent/<activityId>/responses/<requestId>`；呈现 POST 不消费 Wait，回应回包不明时 GET 查询原身份。对话卡片沿现有工作区 IndexedDB 的附加 v8 存储先固定输入再提交，未接受时保留原文。IP 仅定位到同一卡片，不自动作答或抢焦点；隔离还原只读展示原事实。所有新表参加相同 owner 的迁移、保留、备份、校验与接管。

## 独立部署

`service.ts` 将同一接收、查询、对话、事件、快照、停止和继续接口暴露给受认证的 WP01 `teaching.agent` 通道。维护者在身份 owner 保存成员的 Agent 配置，学习数据 owner 在首次解析时固定活动路由；后续配置仅影响新活动。运行层通过领域接口装配，不写 Agent 业务表。

独立 Agent 使用自己的 storage、迁移与维护参与者。`dependencies.ts` 将活动、模型与固定课程工具请求送回实际所有者；双向连接分别绑定真实环境、服务、安装和授权。`remote-state.ts` 固定原依赖连接，模型接收及实际外发复核原 Run、步骤、attempt、领取者和代际。慢速 RPC 期间续租，旧处理者失去推进资格后不能取得新派发权。

`chunk-channel.ts` 在有界 WP01 JSON 通道上传递较大的固定输入、快照和工具结果，分片及回复由实际 owner 持久保留并校验资源引用。未知回包按原业务身份查询，分片通道不会重放未知外部效果；维护和恢复同样验证这些资源。

正式 `createAgentConnection` 将业务关联、固定内容摘要和预分配 transfer ID 写入 runtime 私有 journal；driver/generation 仅更新当前资格，不改变原传输。小请求同样预分配 ID，较大回复不会因首个回包丢失而失联。完整回复先持久接受，再 ACK 释放接收端资源；ACK 丢失、进程重开和授权换发都沿原记录恢复。`unknown` 不执行、不 ACK。恢复到旧授权命名空间只允许已有传输；原 owner 明确返回 missing 后，可保留同一 ID 在当前授权下首次交付。派发授权等纯读恢复旧回复后必须再核验当前资格。

`recover` 控制操作按原来源分页返回最多 16 个传输 ID、状态和输入摘要，不返回正文；以 `after` 续页。当前 grant 的同安装来源可查询旧 grant，跨安装须由宿主验证退休继任链。维护方可对确认未执行的 `receiving` 显式 ACK；`completed` 先恢复并持久接受原回复；`unknown` 保留原身份向领域 owner 核对。旧 namespace 不能创建新传输来绕过容量。runtime schema 2 备份将 journal 按记录保存为独立加密认证附件，包含完整未消费回复；旧 runtime 拒绝此版本，新 runtime 仍可隔离核对不含新事实的 schema 1 备份。

固定依赖描述允许仅轮换 `credentialRef`；持久原描述和 owner、能力及传输地址继续核对。正式跨安装恢复由 WP01 接管证明确认安装继任，新安装仍须重新取得真实授权，不能凭继任记录重用源 token。

## 跨安装维护与恢复

`collectTeachingBoundary(storage)` 在关闸、排空后读取本 owner 的完整记录及引用资源，返回版本化的 `xunjie.teaching-agent.boundary`：各表数量与内容摘要、原 Run/请求身份、未结与停止待确认状态、资源原字节摘要，以及待处理输入、命令和学生问题数量。物理模型调用和执行的安全边界仍由模型与执行 owner 分别确认；Agent idle 不构成备份许可。

`validateTeachingBoundary` 在独立目标重新导出相同事实后核对清单。受支持的旧通用清单仍走原服务/资源校验；未知必需清单版本拒绝恢复。日志外壳仍为 v1，可忽略扩展使用 `kind: extension` 和显式 `ignorable: true` 的版本化正文，查询保留原件，推进不解释其语义。未知必需事件及外壳版本拒绝推进，已发布迁移保持不变。

接收端撤权使用同一 owner 的 `collectTeachingReceiverBoundary`：休眠的已确认逻辑 Wait 可保留，未知派发和停止待确认仍阻断；真实模型/执行 owner 仍须各自确认物理边界。完整备份始终保存全部逻辑未结项，不因接收端投影而丢失等待记录。

完整流程及实际平台范围见 [#204 交付](../../../../docs/student-agent-implementation/wp07-204-conversation-recovery.md)；Mac 与真实跨机交接见 [#212](https://github.com/paher-din/XunJie/issues/212)。隔离副本只读，维护者通过正式 CLI 接管；恢复不重置原预算、Wait 或命令，不重放未知效果。

## 验证

- `apps/server/tests/teaching-agent.runtime.test.mjs`：真实 PostgreSQL、三协议 SDK transport、长上下文、课程策略、增量发布、重启/停止/继续、快照重建、备份/还原/接管。
- `apps/server/tests/teaching-agent.driver.runtime.test.mjs`：两个独立 `driverId` 竞争同一 Run，验证 lease/generation 单一派发。
- `apps/server/tests/teaching-agent.tools.runtime.test.mjs`：三协议真实工具往返、固定旧版本、不可消费输出拒绝、跨活动授权、请求重建和工具资源备份还原。
- `apps/server/tests/teaching-agent.tools-recovery.runtime.test.mjs`：真实 Gateway／作品／原生会话／WASM 的关联前中断、丢回执、双推进者、预算、停止与晚结果。
- `apps/server/tests/teaching-agent.student-ask.runtime.test.mjs`：真实 HTTP/Agent/Gateway/PG 的问题、呈现、明确选择/文字/跳过、原身份查询、竞争回应、期限/预算、重启、隔离只读和接管。
- `apps/server/tests/teaching-agent.recovery.runtime.test.mjs`：正式独立还原的完整 owner 清单、修订队列/预算、学生与真实 WP03 工具 Wait、接管确认丢失、旧客户端拒绝及未知必需格式拒绝。
- `apps/server/tests/teaching-tools-host.runtime.test.mjs`：执行点资格、连续原生状态、浏览器领取与撤销、固定来源和维护所属边界。
- `apps/server/tests/model-progress.test.mjs`：增量发布的凭据尾部扣留与停止公开。
- `apps/web/e2e/teachingConversation.spec.ts`：正式入口首问、刷新、追加问题、生成期间保留新草稿和引导入口、停止、课程问答、进程重启和缺模型设置入口；macOS 与 Windows 桌面 Chrome 均执行。
- `apps/web/e2e/teachingTools.spec.ts`：正式对话中的工具记录、来源定位、真实组件、浏览器等待／停止／重开和丢回执核对；实际平台结果以 #198 交付证据为准。
- `apps/web/e2e/studentAsk.spec.ts`：正式 Chrome 回应入口、IP 定位、焦点/草稿保护、中文原文、未接收/丢回包、明确跳过和明暗窄桌面；实际平台通过项与未执行项分别报告。
