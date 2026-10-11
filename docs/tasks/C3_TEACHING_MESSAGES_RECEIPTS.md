# C3：教学消息、回执、采集控制与作业失效

日期：2026-10-11（Asia/Shanghai）。任务编号：C3，主责：C，对应 [Issue #27](https://github.com/paher-din/XunJie/issues/27)，阶段关联 [G2 / P2 #24](https://github.com/paher-din/XunJie/issues/24)。

**当前状态：原实施与授权追溯见第 8 节；第一轮独立审查的 14 项问题见第 11 节，[PR #33](https://github.com/paher-din/XunJie/pull/33) 首次人工审查的 5 项 P2 与 9 项 P3 见第 13 节。最新 C3 专项 20/20、C3+B1 组合 67/67 通过。Windows / Node 24.21.0 全量 212 项：204 通过、1 失败（`runner/control.ts` 的 Linux-only `RunControl`，属 #23 既有环境限制）、7 跳过，不宣称全量通过；§11.2 在 Linux 报的 A2 双进程 401 在 Windows 未复现、根因未定位。§8.2/§8.3/§8.4 原有的 `access/app.ts`、事务 `DELETE` 白名单、`invalidatedActionIds`、better-sqlite3 与失败归因等断言已按第 13 节修订或撤回。实际 B2 联调、浏览器与完整 G2 尚未验收。**

## 1. 依据、责任与写入范围

已按顺序阅读 [AGENTS](../../AGENTS.md)、[README](../../README.md)、[PRD](../product/PRD.md)、[MVP_SPEC](../product/MVP_SPEC.md)、[TECH_DESIGN](../product/TECH_DESIGN.md)，以及 [TEAM 第 6 节](../planning/TEAM_WORK_PLAN.md#6-p2接通教师-agent-与学生辅导)、[G2 协调记录](G2_OVERALL_COORDINATION.md)、[C0 第 5～7 节](C0_WORKSPACE_RECORDS_RUNNER.md#5-公共-jobcommandreceipt-与事件)、[C2 第 10～13 节](C2_WORKSPACE_JOBS.md) 与 [工程衔接说明](../reference/ENGINEERING_HANDOFF.md)。正式行为依据如下：

| 依据 | 本任务落实的行为 |
| --- | --- |
| PRD §3/5/8，PRD-07/09/10 | 保存实际教学内容与学生主动问题；学生可暂停过程采集；事实、推断和教师判断分开 |
| MVP M-04/M-05、§4/5/6 | 生成、发送、展示和确认分离；三种控制独立；缺回执未知；功能数据例外和覆盖空窗 |
| AC-06/07/08/11/12，NFR-04/06 | 去重、缺口、失效竞态、持久恢复、范围裁剪、配置与用量事实；只报告 C3 接缝实际执行部分 |
| TECH §4.1/4.3/4.4、§5、§6、§7、§9/10 | 可信信封、固定对象/政策、同 tx Job/Receipt/Event、租约/代际、投递重查、采集版本与最小存储 |
| TEAM C3 / Issue #27 | C 管原文/Action/回执/事件与取消；B2 管 help、上下文与生成；A4 管有效状态和教师决定 |

开始时 main 为 `c42f356b6135ca9bb00c2e3c61c3d2aae713f602`，工作区干净；准备分支为 `codex/c3-teaching-records`。当前只可写本文；批准后预计变更范围见第 6 节。

只读：`AGENTS.md` 及其他目录规范、`docs/product/**`、`docs/planning/**`、`docs/reference/**`、其他成员任务稿。不会借方案改变 A/B/C/UI 分工、课程或模型选择、原 AC/NFR/G0～G4 完成条件。

## 2. 现有实现与实际缺口

以下为源码核查，不是本次测试结果，也不将 C2 历史通过数计入 C3：

| 位置 | 已有能力 | C3 需要补齐 |
| --- | --- | --- |
| [records/jobs.ts](../../apps/teaching/server/records/jobs.ts) | 有界 Job、租约、3 次调用、停止意图、用途取消及纯函数 epoch 失效计划；终态 Job 可保存 stopRequested | 计划还未覆盖持久 Action；A4 所需同 tx 范围/epoch/Job/Action/事件接缝 |
| [records/commands.ts](../../apps/teaching/server/records/commands.ts)、[db/records-adapter.ts](../../apps/teaching/server/db/records-adapter.ts) | 公共摘要、Receipt/Event、授权后重放、受校验的同连接记录读写 | 消费已有格式，不能另建队列/业务命令回执或绕过校验 |
| [workspace/application.ts](../../apps/teaching/server/workspace/application.ts) | A1/A2 真实授权与作品路由；当前 cancel 只走 cancelRunCommand/ownRun | 教学用途取消、Action 回执、获准事件分页与教学记录组合 |
| [workspace/controls.ts](../../apps/teaching/server/workspace/controls.ts)、[storage.ts](../../apps/teaching/server/workspace/storage.ts) | captureRevision 与 epoch 分开，采集同值设定不重复变化；过程/覆盖持久化，旧过程拒收不阻塞合法作品 | 复用既有协议，补教学功能数据和在途被动分析/Action 的停止守卫；将控制记录投影为可回查空窗 |
| [design/activities.ts](../../apps/teaching/server/design/activities.ts) | 教师暂停同 tx 更新分配/epoch 并 stopAttemptJobs | 在该原事务内停止关联未展示 Action，不能由另一次 HTTP/后台提交补写 |
| [contracts/tutoring](../../apps/teaching/contracts/tutoring/index.ts)、[tutoring/core.ts](../../apps/teaching/server/tutoring/core.ts) | StudentHelpBody、配置版本、actual/unknown usage、当前性守卫及合成生成 | C 保存经 B 校验的实际 body 与受信信封；B2 的实际 help/worker 接入另行交付，不修改 B1 核心 |
| [workspace/schema.ts](../../apps/teaching/server/workspace/schema.ts)、[db/transaction.ts](../../apps/teaching/server/db/transaction.ts) | 准确获准的全新二十二表合成库与短事务 | 没有 Message/Action/ActionReceipt 存储。旧授权不覆盖 C3 新表，必须批准第 3 节后才实现 |

已检索 enqueue/finish/cancelByPurpose/invalidateInTransaction、stopAttemptJobs、controlCommand/cancelRunCommand、createWorkspaceApp 和 readProcessRecords 的调用方与测试。需要覆盖 C2 控制/运行、A2 活动/分配控制、公共记录适配、B2 接口消费者及工程样例；不仅修改一条取消路由。

## 3. 待批准的数据方案与数据库操作范围

复用现有 SQLite、Job/CommandReceipt/AuditEvent、工作区快照和过程表。新增 `server/records/schema.ts`，仅由新的 `createTeachingDatabase()` 工厂在系统临时目录独占新建 `xunjie-a12-completion-*/synthetic.sqlite` 时初始化：原二十二表加以下四表，共二十六张应用表。沿用已批准的路径校验、外键、WAL、FULL 和短同步事务。

| 新表提案 | 独立列/关联及 JSON 内容 | 约束与索引 |
| --- | --- | --- |
| `teaching_messages` | message_id、course_id/student_id/attempt_id、job_id、request_receipt_id、author_kind、content_hash、message_json；JSON 保存原问题或最终 StudentHelpBody 原 UTF-8 JSON、ObjectRef、固定活动/政策/模型/提示/schema 版本、输入/帮助/覆盖引用与配置/用量事实 | message_id 主键；course/student/attempt、Job、原业务 Receipt 外键；来源限定 student/model；同 Job 同来源只存一个最终原文，重放同 hash 返回原 ID、异原文冲突；按 attempt/Job 索引 |
| `teaching_actions` | action_id、course_id/student_id/attempt_id、job_id、message_id、content_hash、disposition、action_json；JSON 保存目标版本、decisionEpoch、相关状态/依据、generation、停止原因和依据修订标记 | action_id 主键；job_id/message_id 各自唯一并引用原 Job/Message；disposition 提案为 pending/cancelled/stale/failed，只表示当前投递资格，展示/确认事实另存；按 attempt/disposition 索引 |
| `teaching_deliveries` | delivery_id、action_id、recipient_id、client_id、content_hash、recovery_generation、server_seq、delivery_json；JSON 保存受信发送尝试时间、当时控制/epoch/对象版本和事件关联 | delivery_id 主键，引用 Action/目标账号/原事件 server_seq；每次真实响应发送尝试独立追加，可重试而不推断已收到；按 action/client 索引 |
| `teaching_action_receipts` | receipt_id、action_id、delivery_id、content_hash、receipt_kind、client_receipt_id、client_id、server_seq、receipt_json；JSON 保存客户端声明时间、服务端接收时间、版本核验和竞态原因 | receipt_id 主键；Action/Delivery/事件外键；UNIQUE(action_id,content_hash,receipt_kind,client_receipt_id)；kind 为 received/displayed/acknowledged/cancelled/stale/failed；按 action/server_seq 索引 |

各 JSON 必须 json_valid，hash 必须 64 位十六进制；应用读回做严格字段与全部关联范围校验，数据库 FK 不能代替授权。`clientId` 仅表示经认证账号的目标页面通道，Delivery 将其绑定到具体 Action/账号/内容/代际；不能据此证明现实操作者身份。

`resultHash` 对持久的原 body JSON 字节计算，`contentHash` 对确切可展示 content 的 UTF-8 字节计算，两者不混用。正文不 trim、改换行或用重新序列化结果冒充原结果；模型不能提供可信 hash、scope、版本或租约。只接受最终获准 body 和短理由，不存内部思维链；失败用量未知保持 unknown。

现有 B1 返回 body 对象，B2 适配在首次保存前将最终获准 body 序列化一次交给 C；C 保存该确切 JSON 文本并核 hash。这里的原字节指实际持久的最终 body，不宣称保留供应商完整响应或内部思维链；body.content 的实际文字保持原样。

发送尝试独立成表是为了回执核对确切目标和版本，不另建通知队列。公共审计仅存必要类型/ID/引用，不把教学原文、逐次源码或凭据塞入审计正文。模型原文在获准业务记录中可回取。

**准确操作范围：仅新增 schema 源码和新工厂、执行新合成库建表/测试及关库重开。** 保持已有五/十/十七/二十二表工厂不变，不打开/迁移/覆盖旧库或生产库；不增加自动迁移、清理、删除或恢复脚本。合成库与测试产物关闭后保留。

## 4. 待批准的接口与最小组合方案

### 4.1 B2 / A4 的同事务入口

在 `server/records/teaching.ts` 与 `storage.ts` 提供以下受信服务入口；名字/输入是本次待评审提案，当前没有这些导出。均消费 A 的当前 `Transaction` 和已授权 actor，不自开连接、提交或做网络等待：

| 接缝提案 | 输入与事务内效果 | 责任边界 |
| --- | --- | --- |
| `acceptStudentQuestionInTransaction` | 原命令 Receipt 身份、问题/ObjectRef、由 B2/A 构造并核验的固定活动/政策/输入引用、新 Job ID；同 tx 保存原问题、有界 Job、Receipt/Event，返回原 messageId/jobId | B2 注册正式 help、检查政策与上下文、决定替换旧帮助；C 保存实际输入，不自行新增 help 产品入口或有效状态 |
| `completeTeachingInTransaction` | 原 jobId、leaseToken、generation、最终 body JSON、受信版本/相关依据及 usage；重查授权/阶段/用途开关/限定检查/政策/对象/相关状态/epoch/租约/deadline，保存 Message/Action/Job 结果/事件 | B 校验教学语义和引用，C 仍核结构、范围和当前性；无学习状态只明确使用 0/null，不以占位状态阻塞帮助 |
| `stopTeachingJobsInTransaction` | 经授权 scope、具体 jobIds 或 purposes、reason/causeRef、generation；保存 stopRequested、关联未展示 Action 的 cancelled/stale、原命令事件/回执 | 通用停止和按用途控制；已 succeeded Job 也处理 Action，保留终态和已生成/已展示事实 |
| `invalidateTeachingInTransaction` | actor、courseId/studentId/相关 attemptIds、expectedEpochs、reason/causeRef、generation/now；核所属范围与全部 epoch CAS，按同一 tx 保存 Attempt/epoch、相关 Job/Action 和原因事件，返回 epochs/jobIds/actionIds | A4 已先核教师决定/expectedStateRevision，并把有效状态/决定写入同一 tx；C 不代写决定/学习状态，不含普通运行事实失效 |
| `readTeachingRecords` / `readCoverage` | 当前授权范围、角色、分页边界；读取原文/确切引用/控制与缺口，按角色裁剪 | 无持久学习状态时未知；不从编辑或缺回执补造帮助、能力或观察 |

完成的同 Job 同结果重放只返回原 IDs，不创建新 Action、不再次成为待投递；异结果冲突。取消先提交则迟到有效 body 最多归档为不适用的实际生成事实，不能成为新待投递 Action；超时/停止/过时的事实与费用不改写成零。未通过安全校验的内容不进入学生读取投影。

现有纯函数 `invalidateInTransaction(jobs, request, epochs)` 保留调用兼容；新的持久入口消费它的计划并补范围/Action/原因持久化，不把纯函数返回值当数据库提交。同命令重放先返原结果，不再次递增 epoch/事件；新 CAS 才能应用新业务决定。

### 4.2 HTTP、游标与回执

新增 `createTeachingRecordsApp(options)` 组合现有 `createWorkspaceApp`，使用同一 app/access/db 和原 Job 表，不默认监听、不创建长期账号。优先实现 TECH §5 已允许的游标分页，暂不增加常驻 SSE 连接。

| 正式基线路由 | 本次载荷/接入提案 |
| --- | --- |
| GET `/api/attempts/:id/events` | afterServerSeq、limit（默认 50、最多 100）、clientId、recoveryGeneration 和已同步 decisionEpoch；先授权并返回当前控制/epoch/代际。未同步/不匹配时只返回控制与需重同步状态，符合后才返回可展示正文及 deliveryId。游标/hash 不授予权限，教师读取不生成学生 Delivery |
| POST `/api/actions/:id/receipts` | Idempotency-Key、recoveryGeneration、deliveryId/clientId、contentHash、receiptKind/clientReceiptId、声明时间与确切目标版本；当前本人授权、核原目标 Delivery 和 Action 版本。声明时间只保留，不作为追认展示或过程采集的依据 |
| POST `/api/jobs/:id/cancel` | 复用现有 generation 与 Idempotency-Key；运行仍走 C2 原 ID/整单元取消，教学学生用途改走持久停止与 Action 失效。教师设计/样例取消的发起权限和结果继续由 A3/A 的业务入口集成，不用学生 Attempt 冒充 |
| POST `/api/attempts/:id/controls` | 沿用 C2 已批准 DTO 与 CAS。捕获变化/用途停止/Action/覆盖在原 tx 内完成；同值控制不造新覆盖区间 |

事件分页按授权 Attempt 和服务端 serverSeq 有界补取，payloadRef 回取前再次裁剪；学生不读他人、私有资产、未经检查或尚未获准投递的模型内容。曾实际展示的原文保留历史与依据后来被修订的标记，不当作当前建议再投递。读取/发送不激活 Attempt、不排模型作业。

响应构造时记录 Delivery 只说明发送尝试，网络失败不能宣称收到。received/displayed/acknowledged 事实独立存在，不强制补齐中间阶段；同四元组完全相同返原回执，改变客户端/Delivery/版本等实质字段拒绝冲突。客户端或服务端 cancelled/stale/failed 不抹除其他事实；多次回执仅用于追溯同一 Action，不累计为独立能力证据。

displayed 的客户端条件仍是目标内容已渲染且页面可见，acknowledged 必须来自学生明确点击或回应；服务端只记录该已认证通道的报告，不能自行从 received、后续编辑或停顿推断展示/理解。

迟到的真实 displayed 在当前账号/原 Delivery 可核验后追加，标与停止/epoch/对象变化的竞态，不回滚当前控制、不复活 Action。旧恢复代际变更按基线 RECOVERY_REQUIRED 拒绝；保留已有原事实，不能将旧请求改贴新代际。

### 4.3 A2 / C2 的共享接缝

需要批准两个 A 所有文件的最小扩展，不改 A 的业务决定或权限规则：

1. `server/db/transaction.ts`：新增第 3 节的新合成库工厂，复用原路径/事务/驱动规则；旧工厂不自动获得新表。
2. `server/design/application.ts`：增加一个可选、同步的同 tx 教学停止回调。活动/分配暂停从原控制结果取得实际 stoppedJobIds/attemptIds，在原命令提交前调用，传课程、理由、原命令 causeRef 和时间；异步/失败回调使整个事务回滚。旧 A2/C2 工厂无回调保持原范围；新的教学组合工厂必定提供 C 的实现，不能因缺回调假装完成 Action 失效。公共控制响应/分配算法不变。

C 的 `workspace/application.ts` 在 Attempt 暂停、关闭提醒、关闭采集、限定检查和教学取消的原 tx 中调用同一 C 停止能力。基线 receipt-first 重放仍保留，GET 不作新的学习决定；不能为接入而将 A1 的 `assertResourceUse(..., 'write')` 放宽到 submitted/reviewed。回执是本人历史事实，用当前读取授权后做专用版本/目标校验，教师不能代学生上报。

完成/投递判断使用相关用途/阶段/epoch/对象/政策/依据，不机械比较无关 attemptRevision。采集开关导致的 attemptRevision 变化不能取消显式 student_help；关闭提醒只停止 reminder。调用方传入的 actor/作用域来自 A 的授权入口，不接受浏览器构造的教师角色或学生 ID。

模型 abort 和客户端通知在提交后，通过实际 stoppedJobIds 调用 B2 取消接缝；通知失败仅重试通知，不重做 epoch/状态/停止决定。普通进程重启原 generation 保留；可靠旧备份恢复登记及真实恢复演练留给 C5，不在 C3 造替代机制。

## 5. 采集、覆盖与功能数据

复用 `workspace_process_records` 的 sync/coverage 记录，不再新增覆盖表。按创建基线和服务端控制提交点投影 collecting/paused 区间，末段以读取 cutoff/serverSeq 明确仍开放。区间只表示服务端可接收该代际的范围，不承诺每一步都已观察。

- 暂停/恢复均沿现有逻辑递增 captureRevision，不增加通用 decisionEpoch；同值设定无变化。
- 暂停期间只保持必要最新确认作品与最小版本/去重元数据；不保留逐次时间线或排被动分析。显式保存/求助/运行/提交的必要数据按原功能边界持久保存。
- 旧/缺 captureRevision 的过程部分独立拒收，合法作品仍按原 CAS 确认，ACK 的 process 原因独立可回查。恢复不补传，不按客户端时钟追认旧队列，不给旧过程改贴新版本。
- 被动分析在暂停事务内持久停止，完成再核 captureRevision/用途；恢复不接纳原 cancelled/stale Job。主动问题不转为被动采集证据。
- 覆盖投影保存或引用拒收/空窗原因，无法观察的离线段保持未知；不凭 serverSeq 的全局跳号、停顿、焦点或粘贴判定学生没有行动。

## 6. 批准后的预计文件范围与兼容要求

| 文件范围 | 预计改动 |
| --- | --- |
| `contracts/records/index.ts`，必要 `contracts/workspace/index.ts` | 增加已评审的 Message/Action/Delivery/Receipt/分页 DTO；沿用原 Scope/Purpose/JobStatus/ObjectRef/错误，不单方改旧字段含义 |
| `server/records/schema.ts`、`teaching.ts`、`storage.ts`、`application.ts`、相应 `*.test.ts`（计划新增） | 四表、可信原文/Action/回执、持久失效、角色投影和游标入口；测试精确数据与失败反例 |
| `server/records/jobs.ts`、`records.test.ts` | 仅必要的停止/失效幂等及当前性复用；保留纯函数既有调用兼容 |
| `server/workspace/application.ts`、必要 `commands.ts`/`storage.ts`/`inputs.ts`、C 测试夹具与集成测试 | 教学取消/控制 tx 接入、覆盖投影、通用权限/恢复反例；运行/原 ACK/快照/采集协议保持 |
| `server/db/transaction.ts`、`server/design/application.ts` | 第 4.3 节两处明确 A 接缝，批准前只读；不改 Session/密码/授权规则或设计内容算法 |
| 本文、`README.md` | 实施状态、真实使用/验证命令、限制和交接导航；不改保护基线 |

调用方兼容范围包含 A2 控制、C2 同步/快照/普通运行/限定检查/原取消、公共 Job/记录测试和 B1 合成核心。若 B2/A3 同期交付导致共享文件变化，先核差异并兼容，保留他人工作；超出以上方案的公共契约差异重新提出，不覆盖他人任务记录。

无需新依赖、模型供应商、前端框架、UI 页面或通用调度/依赖图。C3 不实现 B2 的正式 help/生成策略或 A4 的状态/教师复核；交清可调用接口和真实合成证据后再与实际 B2 联调。

## 7. 验证计划与分层完成条件

以下均为计划，未执行不得改写为通过：

| 用例组 | 必须验证的反例与不变量 | 对应 |
| --- | --- | --- |
| C3-V01 原文/信封 | 问题与 body 原字节可回取、两类 hash、固定引用/配置/actual/unknown usage、无内部思维链；同结果返原 IDs、异结果冲突 | M-05、NFR-06 |
| C3-V02 回执 | 重复/异摘要、乱序、缺 received 的真实 displayed、未知展示、错误 client/Delivery/hash/版本、迟到竞态、教师代报拒绝 | AC-06/08、NFR-04 |
| C3-V03 范围与补取 | 跨学生/课程/角色/私有资料、不可见 ID、游标越范围；旧 epoch/代际先同步控制、当前对象改变拒投、已展示历史保留 | AC-02/04/06/15 |
| C3-V04 采集 | 暂停→编辑/显式保存/合成主动问题/运行必要数据→恢复；旧/缺 captureRevision 拒过程不拒作品、两个页面旧版本、同值设定、空窗不回填 | AC-07/11 |
| C3-V05 取消竞态 | queued/running/succeeded 教学 Job 未展示 Action 停止；完成/创建/投递与取消交错，提醒/采集用途独立、resume 不复活，已展示事实不抹除 | AC-05/06/08 |
| C3-V06 同 tx 失效 | A 事务调用 C 接缝的多 Attempt 范围/epoch CAS；后段 SQL 在 Message/Action/Receipt/Event/Job/Attempt/控制各点失败均回滚，A2 暂停也覆盖 Action | AC-08、NFR-04 |
| C3-V07 恢复 | 真关库重开/子进程竞争、同命令/结果/回执原 ID、旧 lease/worker/代际拒绝、已停止 Action 重连不再投递 | AC-06/12 |
| C3-V08 B2 交接 | 实际 B2 help/worker→C 原文/Action→客户端工程回执→停止，当前政策/ObjectRef/租约一致 | P2 学生链；未交付 B2 时明确未执行 |

批准后使用既有 Node 24.21.0/TypeScript 7.0.2 与精确 lock，不改变并发、认证、时限或跳过条件：

```powershell
# apps/teaching，准确版本和已有 lock 依赖就绪后
npm run typecheck
npm test
# C3 与所触及 C2/A2 接缝专项；新增测试随实现落在下列既有 glob
node --test server/records/*.test.ts server/workspace/*.test.ts
# 仓库根目录文档检查
node tools/a0-review/check.mjs
node --test tools/a0-review/check.test.mjs
git diff --check
```

服务端真实 SQLite 合成验证与内存领域测试分别报告。工程测试客户端的 received/displayed/acknowledged 只证明协议，不证明实际学生展示、阅读、理解或教学效果；实际 UI 的上传停止/开关/返回/重连属于 #22 最终接入。完整教师纠正/候选接纳属 A4/B3，备份恢复属 C5，真实模型/语义/NFR 负载按 B1/B4 和原阶段条件另验。#23 的既有环境稳定性问题不因本任务而宣称修复。

## 8. 待负责人批准的准确范围、理由与风险

需要一次明确确认第 3～7 节的 C3 服务端实施方案，包括四表/二十六表新合成库操作、待评审接口/字段、两个 A 文件的最小共享接缝与对应合成测试。依据来自 [AGENTS 的红线及大改动要求](../../AGENTS.md#红线必须先说明操作理由风险并征得用户同意)，以及 Issue #27 的“具体接口/数据方案先评审”和“不批准新 schema/迁移”。领取 C3 或进入 P2 不自动解除这两项约束。

理由：缺少持久 Message/Action/Delivery/Receipt 时，无法证明内容可回取、目标回执可核对、succeeded Job 未展示 Action 可停止和重启后不复活；A2 原控制事务若不接入 Action，不能满足同事务失效要求。

风险：会新增并保留含合成教学记录的临时数据库，占用磁盘；共享工厂/组合回调影响 A2/C2 接入，需要全工程回归；字段和接缝需要 B2/A4 以同一契约消费。数据库权限和应用守卫仍须实际验证，文档不能提供技术上的越权拦截保证。

批准不包含旧库/生产迁移、删除、.env/密钥/token/CI/CD、付费模型/真实学生数据、公开发布/推送/部署、受保护基线写入或替代 UI。不会关闭 Issue #27 或宣称 P2/完整 G2 完成，直到其真实交付条件具备。

批准记录：**2026-10-11 项目负责人指示“根据 C3 的实施方案完成 issue C3”，即批准第 3～7 节的准确范围并授权实施 C3。** 准备时点事实保留在原文，不倒写为此前已批准。实际实现、差异与验证结果见第 8 节。

## 8. 2026-10-11 授权后的实施记录

### 8.1 批准与授权范围

| 项目 | 记录 |
| --- | --- |
| 指示方 | 项目负责人（本轮直接指示） |
| 指示原文 | 根据 C3 的实施方案完成 issue C3 |
| 授权范围 | 第 3 节四表/二十六表新合成库与建表操作；第 4.1～4.3 节待评审接口与两个 A 文件最小共享接缝；第 5～7 节范围与验证；第 6 节文件范围 |
| 未包含 | 旧库/生产迁移与删除、受保护基线写入、真实模型/凭据、真实学生数据、UI 替代实现、推送与部署 |
| 记录责任 | 本节的实现与验证事实由 C 记录；受影响基线的汇总仍待授权维护者 |

### 8.2 实际实现与代码位置

按第 6 节范围实现；未新增依赖、模型供应商、前端框架或 UI 页面。

| 文件 | 实际改动 |
| --- | --- |
| [records/schema.ts](../../apps/teaching/server/records/schema.ts) | 新增 `teaching_messages`/`teaching_actions`/`teaching_deliveries`/`teaching_action_receipts` 四表及约束/索引，仅由新工厂初始化 |
| [db/transaction.ts](../../apps/teaching/server/db/transaction.ts) | 新增 `createTeachingDatabase()`；原 access/design/completion/workspace 工厂保持原表集合，不迁移、不打开旧库。事务语句白名单最终仍为 `SELECT|INSERT|UPDATE`（第 96 行），第 11 节已移除一度加入的 `DELETE`；本行原写法与 §11.2 自相矛盾，已按最终代码修订 |
| [contracts/records/index.ts](../../apps/teaching/contracts/records/index.ts) | 新增 Message/Action/Delivery/Receipt/Coverage/Control/Event/分页 DTO；原 Scope/Purpose/JobStatus/CommandReceipt 含义未变。第 13 节补写 `Job.attemptCount`（跨 worker 累计台账）与 `TeachingMessageEnvelope.calls`（单次执行内计数）的语义 |
| [records/teaching.ts](../../apps/teaching/server/records/teaching.ts) | `acceptStudentQuestionInTransaction`、`saveTeachingJobInTransaction`、`completeTeachingInTransaction`、`stopTeachingJobsInTransaction`、`invalidateTeachingInTransaction`、`deliverTeachingActionInTransaction`、`recordTeachingReceiptInTransaction`、`readCoverageIntervals`、`readTeachingRecordsInTransaction` 及严格读回校验 |
| [db/records-adapter.ts](../../apps/teaching/server/db/records-adapter.ts) | **共享事务语义变更，影响 A2/C2 全部 `finishRecordCommand` 调用方**：确认事件的 `serverSeq` 改为落库时读 `MAX(server_seq)+1`（原取调用前快照），新增 `receipt.receiptId===receiptId` 硬校验与可选 `afterCommit` 依赖写入钩子。另新增 `saveRecordPlanWithReference`（事件 `payloadRef` 指向本条事实对象而非命令收据），并让 `readRecords` 校验这类行与其归属行一致。`audit_events.server_seq` 全局 UNIQUE 且被 `command_receipts.server_seq` 外键引用，全局 `MAX+1` 成立，也避免与 `work` 内依赖写入争用；该变更属 §11.1 授权的 records-adapter「必要修复」，但此前未在本表登记，第 13 节补记 |
| `server/access/**` | **无需改动，交付中也确实零改动**：A 的既有资源守卫已允许教师以 `read` 用途读取学生作品，事件路由正是以 `read` 用途授权（`records/application.ts` 的 `authorizeAttempt(request, attemptId, 'read', ...)`）。原表此行描述的 `access/app.ts` 守卫扩展不存在，第 13 节已删除该幽灵条目 |
| [records/application.ts](../../apps/teaching/server/records/application.ts) | `createTeachingRecordsApp`、`teachingStopHandler`、`designTeachingStop`、`GET /api/attempts/:id/events`、`POST /api/actions/:id/receipts` 与请求 schema；`TeachingStopHandler` 复用 `workspace/commands.ts` 的唯一定义 |
| [workspace/application.ts](../../apps/teaching/server/workspace/application.ts)、[commands.ts](../../apps/teaching/server/workspace/commands.ts)、[storage.ts](../../apps/teaching/server/workspace/storage.ts)、[inputs.ts](../../apps/teaching/server/workspace/inputs.ts) | 同 tx 停止接缝（`stopJobs`）、教学用途取消（`cancelTeachingJobCommand` + 可选 `reason`）、命令事件取当前 serverSeq、`GET /api/attempts/:id/teaching-records` 与 `GET /api/attempts/:id/coverage`、读取投影 |
| [design/activities.ts](../../apps/teaching/server/design/activities.ts)、[design/application.ts](../../apps/teaching/server/design/application.ts) | 可选同 tx 教学停止回调 `DesignTeachingStop` 与 `generation` 透传；Action 失效只在原事务内部完成，**公共活动/分配控制结果的形状未变、不追加任何字段** |
| [workspace/test-support.ts](../../apps/teaching/server/workspace/test-support.ts)、[records/teaching.test.ts](../../apps/teaching/server/records/teaching.test.ts) | 夹具可选组合教学应用与夹具专用路由、C3-V01～V07 用例 |
| [tools/wsl-verify.sh](../../apps/teaching/tools/wsl-verify.sh) | 本机验证入口脚本，仅在已批准的 Node 24.21.0 下同步源码到 WSL Linux 文件系统并运行测试；不进入应用运行时 |

与原方案的实现差异（实现所见事实，待评审）：

1. B2 的正式 help 入口不在本任务实现（第 6 节明确 C3 不实现 B2 的 help/生成策略）。C 交付同 tx 接缝 `workspace.teaching.acceptStudentQuestion/completeTeaching` 与 `GET /api/attempts/:id/events`、`POST /api/actions/:id/receipts` 两个 C 自有路由；夹具中的 `/fixture/help/:id`、`/fixture/complete/:id`、`/fixture/records/:id`、`/fixture/coverage/:id` 仅存在于测试支撑。
2. 问题保存与有界 Job 分两步在同一事务内完成：`acceptStudentQuestionInTransaction` 只规划消息，`finishRecordCommand` 写完命令收据后由依赖写入 `saveTeachingJobInTransaction` 落库，因为 `teaching_messages.request_receipt_id` 与 `jobs.request_receipt_id` 都引用该收据行。Job ID 由服务端生成，因此等价请求摘要不含随机 ID，同键不同问题返回 `IDEMPOTENCY_CONFLICT`。
3. 消息 `contentHash` 对确切可展示正文（`content` 或原问题）计算，`resultHash` 对持久的最终 body JSON 文本计算；模型正文以 `bodyJson` 文本保存并按其字节核 hash，读回时字节一致。
4. 教学事件的 `payloadRef` 指向本条事实对象（Delivery/Receipt/停用请求），不是命令收据；`teaching.completed` 例外，它保留命令收据引用。这样事件分页可把事件解析回具体 Action，同时不改变 C2 的收据/事件约定。
5. 停止的教学事实记录在**发起命令自己的事件/回执**里（`job.cancel` → `teaching.stopped` 类型、`attempt.control` → 控制事件），停止例程本身不再补写第二条审计行；`stopTeachingJobsInTransaction` 的 `audit:false` 由停止接缝固定传入。
6. 发送尝试按 `(action, client)` 记录一次：同一页在回报前重复读取会复用该 Delivery，而不是每次读取都追加新尝试；`readTeachingDeliveries` 等读回校验同时核对列与 JSON，两者不一致会失败而不是静默。

### 8.3 本次验证与结果

环境说明（第 13 节修订）：本节结果在 WSL Ubuntu 内的官方 Node 24.21.0 下取得，[tools/wsl-verify.sh](../../apps/teaching/tools/wsl-verify.sh) 把源码同步到 Linux 文件系统后运行测试；该脚本只是本机验证入口，不进入应用运行时，也不改变仓库既有的启动/测试命令。原文称「本机 Windows 未安装已批准的 Node 24.21.0，且 `better-sqlite3@13.0.3` 在 Windows 上没有预编译产物（其 GitHub v13.0.3 release 仅含源码，需要 MSVC 现场编译）」，其中关于 better-sqlite3 的断言**不实且已撤回**：npm 包自带全平台 prebuilds，实测 `apps/teaching/node_modules/better-sqlite3/prebuilds/win32-x64.node` 存在（13.0.3，1,989,632 字节），GitHub Release 是否只含源码与此无关。当时改用 WSL 的真实原因没有留下可核查证据，本节不把它追认为某个具体原因；Windows 侧可复现的真实前置条件见 §8.4 第 1 条。

| 验证项 | 命令 | 实际结果 |
| --- | --- | --- |
| 运行时 | `node tools/check-runtime.mjs` | 通过（WSL 内 Node v24.21.0，与 `engines` 一致） |
| 类型检查 | `tsc --noEmit`（apps/teaching） | 通过，0 错误 |
| C3 用例 | `node --test server/records/teaching.test.ts` | **C3-V01～V07 全部通过（7/7）** |
| C2 记录/工作区回归 | `node --test server/records/*.test.ts server/workspace/*.test.ts` | 39 项中 **37 通过、0 失败、2 跳过**（跳过为原有节点专项门槛，未设置 `XUNJIE_C2_RUNTIME`） |
| 全量回归 | `npm test`（含 `pretest` 构建） | 最好一次 **199 项中 194 通过、0 失败、5 跳过**；另有若干次出现 1 项 A2 用例失败（见 8.4 第 2 条），其余 198 项通过。跳过为原有节点专项门槛 |
| 文档检查 | `node tools/a0-review/check.mjs`、`node --test tools/a0-review/check.test.mjs` | 通过：`errors=[]`；检查器回归 16/16 |
| 空白与文件范围 | `git diff --check` | 通过；受保护基线未修改 |

C3-V01～V07 覆盖：原文/正文逐字节与两个 hash、同结果重放与异结果冲突；分层回执幂等、顺序无关、声明时间只作声明；范围/角色裁剪、游标边界与陈旧 epoch 只回控制；暂停采集保留显式功能数据、旧过程原因可见且不补填空窗；succeeded Job 停用未展示 Action、已展示事实不复活；同 tx 停止随调用方回滚与 A2 暂停同事务失效；真实重开后原 ID 重放与停止后不重投。

### 8.4 未完成项与环境阻塞

1. **原「Windows 宿主缺少可编译依赖」的断言不实，已撤回**（第 13 节修订）。实测事实：`better-sqlite3@13.0.3` 的 npm 包自带 `prebuilds/win32-x64.node`（1,989,632 字节）与 `win32-arm64.node`，Windows 上无需 MSVC 现场编译即可跑真实 SQLite 测试；独立审查已在 Windows / Node 24.21.0 下跑通本 PR 全量，所以「`npm test` 在宿主 Windows 上仍未跑通」不成立。Windows 侧真实的前置条件是另外两条，与 better-sqlite3 无关：
   - `tools/check-runtime.mjs` 要求 `process.version` 精确等于 `v24.21.0`；PATH 上是其它版本（该机曾为 v24.15.0）时，`npm run typecheck/build/test` 的 `&&` 链直接失败。
   - 仓库既有 `apps/teaching/node_modules/@typescript/` 只有 `typescript-linux-x64`；TypeScript 7 是原生移植版，缺 `@typescript/typescript-win32-x64@7.0.2`（版本须与已装 typescript 一致）时 `tsc` 以 `Unable to resolve @typescript/typescript-win32-x64` 崩溃。

   这两条属 [#23 环境稳定性](https://github.com/paher-din/XunJie/issues/23) 范围。本任务只在本文记录，未代为修改 #23、依赖清单或 `check-runtime`；第 13 节的 Windows 验证是在独立工作树内临时前置已批准 Node、并把该原生包只解压进工作树的 `node_modules` 副本完成的，`package.json`/`package-lock.json`/`tsconfig` 零改动。
2. **A2 双进程认证失败：根因未定位，原归因不成立**（第 13 节修订）。原写法称该失败「是既有夹具的会话/时钟交互，不是 C3 代码路径」。但当时的对照基线 `e13f12d` 本身就是 C3 的实施提交、**已包含 C3**，两侧都有 C3，该对照只能说明失败在 C3 的两个版本之间稳定，**不能排除 C3**。从代码路径看同样不能排除：该用例打的 `/api/activities/:id/controls` 正好穿过本 PR 改动的两处共享代码——`finishRecordCommand`（serverSeq 改为落库时读 `MAX+1`、新增 `receiptId` 硬校验与 `afterCommit` 钩子）与 `controlActivity`（新增 `generation`、`teachingStop` 两个参数）。
   独立审查在 Windows 上既不能复现也不能反驳：本 PR 全量 210 项的唯一失败是 `server/workspace/review.test.ts` → `runner/control.ts:48` 的 Linux-only `RunControl`，而 main `83e528e` 单独实测为 192 项/184 通过/**同一条**失败/7 跳过；§11.2 报的那条 401 在 Windows 上未出现。就 Windows 而言本 PR 未引入新失败。
   要真正定位，最小充分实验是在同一 Linux 环境下对 `83e528e`（不含 C3）与本 head 各跑若干次、比较该用例失败率；在此之前不把它记为既有抖动。§11.2 已如实写明 2/2 选择性对照「不证明全量失败根因已定位」、也未宣称全量通过，该口径保留。
3. 未执行：真实模型/B2 正式 help 联调（C3-V08）、浏览器与实际 UI 验收、真人与负载验收、备份恢复（C5）、Issue #27 关闭与推送。
4. 下一步：B2 以 `workspace.teaching.acceptStudentQuestion`/`completeTeaching` 接入正式 help 与 worker 后执行 C3-V08。原「宿主 Windows 若要直接跑 `npm test` 需先安装 MSVC 生成工具」的要求随第 1 条一并撤回；Windows 直接跑只需满足第 1 条的两项前置（精确 Node 24.21.0、补齐 `@typescript/typescript-win32-x64`），第 13 节已按此在本机实测全量。

## 9. 待交接（B2 / A4 / 后续）

| 交接对象 | 可调用入口 | 约定 |
| --- | --- | --- |
| B2 help 入口 | `createTeachingRecordsApp(...).workspace.teaching.acceptStudentQuestion(request, attemptId, input)` | B2 负责鉴权后的政策/上下文/ObjectRef 校验；C 存确切问题、有界 Job、Receipt 与事件 |
| B2 worker | `workspace.teaching.completeTeaching(request, attemptId, input)` | 传入已校验的最终 `bodyJson`、代际/依据/usage，以及**必填**的 `leaseToken`（第 13 节起不再从已持久作业回填，省略即 400）。作业仍为 `queued` 时 C 用该 token 领取有界租约；已 `running` 时必须与持有者 token 相符，否则 409。同 job 同 hash 返原 IDs，异 hash 409 |
| B2 / A3 调用计账 | `records/jobs.ts` 的 `recordModelCall(job, token, generation, now)` | 按负责人选定的方案：`Job.attemptCount` 是**跨 worker 累计**台账，只由执行侧在每次 provider 调用前调 `recordModelCall` 递增（`>=3` 时拒绝）；`TeachingMessageEnvelope.calls` 只是**单次执行内**计数。C3 完成时的 `Math.max(job.attemptCount, input.calls)` 只是对账，不承担累计。B2 接线前该累计无人执行，缺口见 §13.2 |
| A4 教师纠正 | `invalidateTeachingInTransaction(tx, ...)` | A4 先在同一事务写入教师决定；C 只做范围/epoch CAS、Job 与 Action 失效及原因事件 |
| A2 控制 | `options.teaching.stop`（`teachingStopHandler`） | 活动/分配暂停在 A 的原事务内调用；异步或失败回调使整个事务回滚 |
| 客户端 | `GET /api/attempts/:id/events`、`POST /api/actions/:id/receipts` | 需先同步 `recoveryGeneration`/`decisionEpoch`；游标与 hash 不授予权限 |
| A2 同 tx 停止（C3-V06 已验证路径） | `options.teaching.stop` / `options.teaching.design` | 停止事实记录在发起命令自己的事件与回执里（`job.cancel` → `shared.teaching.stopped`；`attempt.control` 暂停 → 控制事件），停止例程本身不补写第二条审计行 |
| 运行验证 | Windows 宿主：`npm test`（apps/teaching，需先满足 §8.4 第 1 条的两项前置）；Linux：`bash apps/teaching/tools/wsl-verify.sh bash -c "npm test"` | 两条都只是本机验证入口，不进入运行时。第 13 节起 Windows 全量已实测可跑通，`wsl-verify.sh` 不再是验证前置，仅作为 Linux 侧可选入口按负责人决定保留 |

## 10. 本次准备验证与待交接（准备阶段原文）


已完成：回读 Issue #27 的完整正文/状态（Open，0 评论）；基线与上游正文阅读；源码/调用方/二十二表工厂核查；建立本任务方案。

首次文档检查发现本文 C2 第 10 节锚点错误，检查器与依赖该结构的 4 个用例失败；已修正为该任务文件的有效相对入口，没有修改检查器或上游文档。

| 准备验证 | 实际结果 |
| --- | --- |
| `node tools/a0-review/check.mjs` | 最终通过：32 份文档、408 处内部引用、27 条正式变更路由，errors=[] |
| `node --test tools/a0-review/check.test.mjs` | 最终 16/16 通过，0 失败、0 跳过；仅文档检查器回归 |
| 空白/末尾换行、`git diff --check` 与文件范围 | 通过；仅新增本文，已有跟踪文件无差异，产品/规划/参考/规范/其他任务稿/应用源码无修改 |
| 环境 | 本机 Node v24.15.0，仅执行文档检查；没有用它绕过批准应用运行时要求 |
| 外部写入 | 未提交、推送、发布评论、发送成员消息、修改或关闭 Issue |

C3 编码、数据库新建/迁移、业务测试、B2 实际联调、模型/节点/浏览器/真人与负载/备份恢复均**未执行**。文档检查通过不表示 C3 或产品已完成。

下一步：负责人批准第 3～7 节准确范围后实施 C3 核心及两处共享接缝，完成合成同 tx/权限/恢复验证并更新本文和 README；实际 B2 到位后执行 C3-V08。待授权维护者汇总请求只在出现真实实施/验收事实后提出，本次不要求将准备方案写入 MVP_SPEC §10 或 TEAM。

## 11. 2026-10-11 审查修复批次

项目负责人在独立审查报告之后明确要求“修复吧”，授权修复报告中的 14 项问题及必需调用方、测试和交付记录。依据仍为 PRD-07/09/10、M-04/M-05、AC-06/07/08/11/12、NFR-04/06 与 TECH §4.3/5/7；不修改受保护基线、不新增 schema 或迁移，不执行删除、凭据/CI 修改、付费模型、发布或部署。

起点 `e13f12db6fdc6d1798f26309d242ee65f958ae89`，已有 `G2_OVERALL_COORDINATION.md` 修改和 `I0_STUDENT_VERTICAL_SLICE.md` 未跟踪文件均属其他工作，本批保留且不暂存。负责模块为 C3 教学记录、C2 必要接缝和本次审查指出的 A2 响应恢复。

### 11.1 编码前修复范围

| 审查项 | 修复与验证方案 |
| --- | --- |
| Standards 1 | 修改验证脚本以复用已有准确运行时/依赖、采用新验证目录；取消自动删除/下载/原生构建，不执行原脚本的删除路径 |
| Standards 2 | 恢复 A2 公共控制结果的原批准形状，Action 失效留在原事务内部；核 DB 事实而非增加公开字段 |
| Standards 3 | 先生成真实 Action，再逐个尾段 SQL 失败注入，严格要求失败和完整回滚；补同事务 A2 暂停与取消/重开事实 |
| Spec 4/14 | 使用统一 Attempt 持久化入口同步 epoch/JSON，保持原始依据不变；按目标 jobId 取消，历史 Job 的取消不影响新 Job |
| Spec 5/6/12 | 先按范围和游标过滤后分页、严格客户端目标；使用请求幂等键，回执重放直接消费原命令结果 |
| Spec 7/8/9 | 停止与展示事实分离；生成/投递/原文读取共用当前性守卫；核原 Delivery 客户端/Action 确切版本，保存迟到真实事实 |
| Spec 10/11 | 在既有 message_json 内保存确切 body JSON 字节，不新增列或迁移；取消无关 capture/attemptRevision 守卫，保留相关 epoch/政策/对象/停止/租约检查 |
| Spec 13 | 从服务端创建/控制提交点建立覆盖区间；拒收原因仅消费实际 ACK，不改变旧 collecting 事实，不将合法旧过程补成拒收 |

预计可写：`server/records/application.ts`、`teaching.ts`、对应测试及 `contracts/records/index.ts`；`server/workspace/application.ts`、`commands.ts`、`storage.ts` 和必要测试夹具；`server/db/records-adapter.ts`、`transaction.ts` 的必要修复；`server/design/activities.ts`、`contracts/design/results.ts` 的响应恢复；验证脚本、README 和本文。`AGENTS`、product/planning/reference、其他任务稿只读。复用原依赖、同一 DB/Job/Receipt/Event，不增加队列、UI 或通用框架。

原审查已在新 WSL 合成副本、Node 24.21.0 复现核心反例，类型检查/构建与旧 C3 7/7 通过，但反例没有被旧测试覆盖；全量一次为 199 项中 192 通过、2 失败、5 原条件跳过，两项认证相关失败尚未归因于 C3。本批先固化失败断言，再逐项修复；不能把原通过数当修复后验证。

旧实现未持久的原 JSON 字节无法还原，本批不从重序列化对象补造原文。新生成记录保存原字节；旧记录只保留已有事实并明确缺失。B2 实际联调、教师纠正全链、UI/真实模型/真人/负载/备份恢复仍按原阶段条件验收。

### 11.2 实际修复与验证

14 项审查问题已落实到实现与回归断言：

- 求助使用真实请求幂等键，同请求返原 IDs，新请求替换旧帮助并递增 epoch；取消只影响指定 Job。原文和回执重放不生成新 Action/Receipt。
- 事件在 SQL 中先按授权 Attempt、游标和客户端裁剪，再分页；只在本页有空间时登记发送尝试。生成、发送、展示、确认与当前投递资格分开，停止不抹掉回执，迟到真实展示保存竞态。
- 学生原文读取仅保留自己的问题及有展示/确认事实的历史帮助；未获准内容不从旁路泄露。生成/投递重查阶段、政策、限定检查、epoch、代际与确切对象；完成消费已持久租约，拒绝旧 worker。
- 新生成记录在已有 JSON 列中保存 `bodyJsonText`，读回核确切字节/hash 与解析后正文一致；原已丢失字节不回填，旧记录缺该字段即明确缺失。
- 采集变更不机械作废显式帮助；覆盖从确切创建/控制提交点解释，拒收仅使用实际 sync ACK 原因。旧合法过程不会被新 captureRevision 改成拒收或改写为 paused。
- A4 同 tx 通过 `saveAttempt` 保存 epoch/JSON/revision，原生成依据保持不变；已展示且后来取消的历史在纠正后标注依据修订，不复活投递。
- A2/C2 公开控制响应恢复原形状，Action 失效由同一事务完成；尾段 SQL 失败严格返回失败并验证 Job/Action/Attempt/Receipt/Event/会话活跃元数据全回滚。验证脚本不自动下载/安装/删除，原 DELETE 语句权限扩展已移除。

新增 [teaching-review.test.ts](../../apps/teaching/server/records/teaching-review.test.ts) 11 组回归，原 C3 7 组补齐真实 Action、严格回滚与取消后重开的断言。最初 10 组回归在修复前版本全部失败（0/10），确保断言能捕获所审查的症状；随后增加对象变更与旧租约用例，并扩展 A4 真实历史保留验证。测试只使用新合成库，不操作真实学生或生产库。

| 修复后验证 | 实际结果 |
| --- | --- |
| Node 24.21.0、精确 lock 与真实原生驱动 | 复用已准备环境；源码复制到全新 Linux 验证目录，没有安装、清理或放宽运行时要求 |
| `npm run typecheck` / `npm test` 的 pretest build | 通过；首次增量发现回调类型交叉和严格 optional 类型不符，已修正并复验，未关闭严格选项 |
| C3 专项 | 最新全量内 11 组修复回归 + 7 组原 C3 = **18/18 通过、0 跳过** |
| 首轮全量 `npm test` | 210 项：203 通过、2 失败、5 原节点条件跳过；失败为 A2 双进程及 checks 重放认证相关用例 |
| 最终源码全量 `npm test` | **210 项：204 通过、1 失败、5 原节点条件跳过**。失败为 `two independent processes serialize identical receipts, reject competing control CAS and preserve state on lock busy` 在起草准备返回 401 而非 200；不宣称全量通过 |
| 原 `e13f12d` 对照及最终源码选择性复验 | 两版本均按原用例的 `--test-name-pattern='two independent processes serialize\|committed checks replay'` 选择 2 项；原版和修复版均 **2/2 通过、0 跳过**。此对照不证明全量失败根因已定位，也不替代全量结果 |
| 文档检查器/回归 | 通过，`errors=[]`，16/16；不计业务验收 |
| 写入范围、空白、冲突和源字节核验 | C3 工作树 `git diff --check` 通过；恢复的 12 份实现/测试文件与最终已验证副本 SHA-256 逐一一致；受保护基线、依赖/配置及他人任务稿未改 |

全量认证失败与已有 [环境稳定性 #23](https://github.com/paher-din/XunJie/issues/23) 分开跟踪；验证期间可见宿主/WSL 文件时间约 13 秒差异，但不据此宣布根因或修复。没有修改时钟、会话/权限规则、测试并发、时限或跳过条件来获取通过。

恢复执行时，主工作副本已从 C3 分支切至 main（`c42f356`），应用临时 stash 后有未合并冲突。本批在基于 `e13f12d` 的独立 `codex/c3-review-fixes` 工作树恢复已验证修复，保留 main 的冲突、暂存、stash 和 G2/I0 工作，不自动合并或替他人解除冲突。交付源在本分支，主副本未纳入本批修复。

自动两轴独立复核因工具用量限制未完成，未登记为审查通过；执行 Agent 已按原 14 项清单逐项核对实际改动和回归。真实 B2/模型、完整 A4 教师判断链、UI/真人、负载与 C5 备份恢复均未执行；Issue #27 保持原状态，不推送、公开发布或宣称完整 G2 完成。进度待授权维护者汇总。

## 12. PR 发布与 main/stash 现场恢复

项目负责人明确要求“推送pr，然后处理一下main 冲突和 stash”，授权普通推送修复分支、创建 PR、保存现场后解除本地 main 的错误 stash 应用冲突并同步已发布 main。该操作不包含 PR 合并、生产部署、删除文件或 stash/Git 历史、受保护基线变更、课程资料发布、其他成员任务内容改写。

发布起点为本地修复提交 `5c36989`，原 C3 `e13f12d` 尚未合入 main，旧 PR #31 已关闭。因此新 PR 会同时包含原 C3 实施与这次审查修复，不将只有修复增量的测试口径冒充全产品验收。最新 origin/main 为 `0afd008`；修复分支已正常合入该 main 的 G2/I0 文档更新（无源码冲突），不重写历史或改动两份作者任务记录。

本地主副本仍是 `c42f356`，临时 stash 基于 `e13f12d`，应用到 main 后产生修改/删除及内容冲突；G2/I0 已有工作与 `course_matrial/data_logic/` 新资料需保留。恢复顺序为：核修复已入 PR → 保存当前文件、索引、stash 身份和摘要 → 将 main 不应包含的 C3 文件保存在恢复目录 → 仅恢复明确冲突/修复路径的索引和 main 基线 → 快进至已发布 origin/main → 核对 G2/I0/新资料与 stash 保留。不得用 reset --hard、clean、stash drop/pop 或删除来“清理”现场，不把恢复目录作为团队查阅代码或验证的入口。

PR 链接、推送回读、现场恢复与核验实际结果在执行后追加。上一节的 18 项 C3 通过、全量 1 项认证失败和未执行条件保持，不因发布或冲突处理宣称产品完成。

### 12.1 发布事实与新 main 组合验证

首轮普通推送因连接重置失败；同分支普通重试成功，没有强推或永久网络配置变更。发布候选为 `ea37814`。GitHub 连接器创建 PR 返回 403（integration 无创建权限）；回读确认无同 head PR 后，使用已登录 `gh pr create --body-file` 成功建立 [PR #33](https://github.com/paher-din/XunJie/pull/33)，Open，head=`codex/c3-review-fixes`、base=`main`，已附加至 C3 工作项。没有合并 PR、关闭 #27 或重复建立 PR。

随后已发布 main 合入 B1 [PR #29](https://github.com/paher-din/XunJie/pull/29)，前进至 `83e528e`。main 与 C3 修复分支均正常同步该版本，保留作者 B1 实现/文档，不代改其源码。组合候选 `d15e5b5` 在新 Linux 验证目录复用 Node 24.21.0/精确 lock：`npm run typecheck`、`npm run build` 通过；`node --test server/records/teaching*.test.ts server/tutoring/test/*.test.ts` **65/65 通过、0 跳过**，其中 C3 18 项。供应商调用为离线 transport，真实模型调用 0；SDK 原兼容性警告保留，没有关闭日志或检查。

这是同步新 B1 后的相关组合验证，没有把第 11 节的 210 项旧组合全量结果改写为新组合全量通过。本节发布/恢复记录完成后再普通提交/推送至同一 PR，最终 head 以本地、远端及 PR 回读一致为准。

### 12.2 main 冲突与 stash 处理结果

已先保存并核验 14 份现有文件、原 Git 索引和 stash 身份，并保存 4 份新课程资料的 SHA-256 清单。main 无对应路径的 C3 文件及新增回归用例保存在本机恢复目录，原 stash 和分支完整保留；未删除文件或 Git 历史。G2/I0 现有内容分别与已发布 blob `7775dce` / `b6add896` 一致，不存在需要重写的本地内容差异。

首次 `git restore --staged` 对 main 不存在的修改/删除冲突路径拒绝，未宣称该步骤成功。文件已经保存移出主副本后，仅移除这些不存在于 main 的冲突索引项，再恢复 main 原跟踪路径；未执行文件删除、reset --hard、clean 或 stash drop/pop。随后 main 正常快进到已发布 main，最终核对 `83e528e` 与当前 origin/main 相同。

核验通过：main 的跟踪文件与索引干净、未合并项为 0；G2/I0 原 blob 一致；`course_matrial/data_logic/` 四个文件 SHA-256 全部不变，仍是未跟踪资料，没有加入 PR 或发布。原 `stash@{0}` 仍为 `da0c0009fda44d5c16f02286aa072daea624b973`，标记为已核对的恢复备份：C3 修复在 PR #33，G2/I0 已在 main，不再重复应用到 main。

main 文档检查通过（32 份文档、406 处内部引用、27 条正式路由，errors=[]）。恢复目录、原索引、stash、工作树和临时验证产物全部保留。main 同步不代表 C3 PR 已合入，原教学/UI/模型/全量环境限制继续保持。

## 13. 2026-10-11 PR #33 首次人工审查的修复批次

项目负责人以审查发布身份对 [PR #33](https://github.com/paher-din/XunJie/pull/33) 完成首次人工审查（merge-base `83e528e` → head `9fc9fae3`，19 文件 +2378/-56；因 PR 作者与审查发布为同一账号，GitHub 只允许 COMMENT，故该审查不构成批准），列出 5 项 P2 与 9 项 P3，随后指示按评论内容修复 C3。本节记录该批次的授权、实际改动与验证。§8.2/§8.3/§8.4 的就地修订均标注「第 13 节修订」，不倒写为当时已知。

起点为 PR head `9fc9fae3`，全部操作在独立工作树 `codex/c3-review-fixes` 内完成；主工作树 `D:/XunJie` 的并行改动（`AGENTS.md`、`README.md`、`docs/product/**`、数字逻辑材料）未纳入、未暂存、未回退。执行期间 origin/main 前进到 `8a6c70c`（数字逻辑文档与课程材料），与本分支无源码交集，未代为合并。

### 13.1 授权范围与负责人决定

| 项目 | 记录 |
| --- | --- |
| 指示方 | 项目负责人 |
| 指示原文 | 根据 pr#33 comment 的内容，修复一下 c3 |
| 授权范围 | 审查报告的 5 项 P2 与 9 项 P3，含必需的调用方、测试与本任务稿修订 |
| P2-1 决定 | 三个方案中选定**方案 1**：`calls` = 单次执行内计数、`Job.attemptCount` = 跨 worker 累计台账（只由执行侧 `recordModelCall` 递增），C3 保留 `Math.max` 作完成时对账。不改计账代码，不动 `records-adapter.ts` 的 `natural.max(3)` |
| `wsl-verify.sh` 决定 | **保留脚本**，只修订文档说明；未执行删除（删除文件属 AGENTS 红线，本批未获该授权） |
| Issue #23 决定 | Windows 验证的两条真实前置条件**只写进本文** §8.4，未代为评论或修改 #23 |
| 未包含 | 受保护基线写入、schema 变更与迁移、旧库或生产操作、真实模型与凭据、真实学生数据、UI 替代实现、PR 合并与 Issue #27 关闭 |

### 13.2 实际修复

**P2-1（调用预算，按方案 1）**：在 [contracts/records/index.ts](../../apps/teaching/contracts/records/index.ts) 为 `Job.attemptCount` 与 `TeachingMessageEnvelope.calls` 补写语义（累计台账 vs 单次执行计数），并在 `teaching.ts` 的 `Math.max` 处注明它只是对账、求和会双算；§9 增列「B2 / A3 调用计账」交接行。**代码计账逻辑与 schema 上限未改**，因此审查指出的缺口按方案 1 的分工仍然存在：`recordModelCall` 在本 head 上没有生产调用方（A3 的调用方在未合并的 #28），B2 接线前跨 worker 累计无人执行，台账可能低于真实供应商用量。该项按负责人决定记为 B2 接线的前置条件，不由 C 单方冻结。

**P2-2（leaseToken）**：`teachingCompleteInput.leaseToken` 由 `id.optional()` 改为**必填** `id`；删除 `input.leaseToken ?? claimed.leaseToken ?? randomUUID()` 的持有者回填与 `claimJob` 的 `?? randomUUID()`，改为直接使用调用方 token。补反例：省略 `leaseToken` 的完成请求返回 400 且数据库快照不变。**该反例已验证能捕获原症状**——临时回退修复后同一请求返回 **200 并真的写入 Message/Action/Job**，即审查所说的「租约复查在省略字段时空转」；随后恢复修复版并复验 20/20。

**P2-3 / P2-4 / P2-5（记录准确性）**：就地修订 §8.2 与 §8.3/§8.4，逐条标注「第 13 节修订」——删除 `access/app.ts` 幽灵行（`server/access/**` 交付中零改动，A 的既有守卫已允许教师以 `read` 用途读学生作品）；事务白名单改为按最终代码 `SELECT|INSERT|UPDATE`（`db/transaction.ts` 第 96 行），消除与 §11.2「DELETE 已移除」的自相矛盾；删除 `contracts/design/results.ts` 行与「回调返回时追加 `invalidatedActionIds`」；补记 `finishRecordCommand` 的共享事务语义变更；撤回 better-sqlite3 的不实断言并写明 Windows 的两条真实前置条件；把「不是 C3 代码路径」改为「对照基线 `e13f12d` 已含 C3，本次对照不能排除 C3；根因未定位，Windows 侧未复现」。

**P3（判断项）**：

1. `contracts/design/results.ts` 恢复为 main 版本，本 PR 对 A 属契约文件不再有只剩行尾换行的无谓改动；
2. `/api/jobs/:id/cancel` 的授权预检改为 `advanceActivity=false`，不再在 `execute(...)` 之前多写一次 `sessions.last_active_at_ms`、也不再拆成两个事务；
3. 修正「Teacher-side design jobs stay owned by A3」注释：实际行为是接了 `teachingStop` 后所有非 run 用途都进入学生专用分支，教师的设计作业在此被 403 拒绝，教师侧设计取消仍由 A3 自己的入口负责；
4. `TeachingStopHandler` 改为复用 `workspace/commands.ts` 的唯一定义并由 `records/application.ts` 再导出，消除双份类型；
5. 新增 `passive_analysis` 用例：真实持久化一个被动分析作业后关闭采集，断言停止是**落库**的（作业行 `stopRequested=true`、`status='cancelled'`）、显式 help 不受影响、恢复采集不复活旧作业；
6. 新增客户端 `cancelled`/`stale`/`failed` 回执用例：三种都不需要 Delivery 行即可记录、按序追加为四条事实、不撤销已有 `displayed`、不回滚当前控制（epoch/captureRevision/attemptRevision 不变）、同 `clientReceiptId` 重放返原回执；
7. 尾段失败注入从 3 条扩到 7 条（增 `UPDATE activity_controls`、`UPDATE assignments`、`INSERT INTO attempts`、`INSERT INTO jobs`），`snapshot()` 同时纳入 `activity_controls`/`assignments`/`workspace_command_bindings`/`workspace_process_records`，使晚段失败也能证明设计侧写入一并回滚。

未采纳并已说明理由的两项 P3：`records/application.ts` 与 `records/teaching.ts` 的 zod 形状重复保留，因为两者处于不同信任边界（前者校验未受信 HTTP 输入，后者校验已持久记录与受信信封），合并会让任一侧放宽都波及另一侧；`readRecords` 的 `(serverSeq, committedAt)` 位置关联保留，因 `audit_events.server_seq` 全局 UNIQUE，关联成立，仅不变量弱于 `payloadRef`。

### 13.3 本次验证与结果

环境：Windows 宿主，Node `v24.21.0`（临时前置于 PATH，未覆盖 `D:/nodejs`、未改永久 PATH）；`@typescript/typescript-win32-x64@7.0.2` 只解压进本工作树的 `node_modules` 副本，`package.json`/`package-lock.json`/`tsconfig` 零改动。真实 SQLite 由 `better-sqlite3@13.0.3` 自带的 `prebuilds/win32-x64.node` 提供，未编译、未换驱动。

| 验证项 | 命令 | 实际结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过，退出码 0（`noUnusedLocals`/`noUnusedParameters` 均开启） |
| 构建 | `npm run build` | 通过，退出码 0 |
| C3 专项 | `node --test server/records/teaching.test.ts server/records/teaching-review.test.ts` | **20/20 通过、0 失败、0 跳过**（原 C3 7 组 + 修复回归 13 组，本批新增 2 组） |
| C3+B1 组合 | `node --test server/records/teaching*.test.ts server/tutoring/test/*.test.ts` | **67/67 通过、0 失败、0 跳过**（§12.1 的 65 项 + 本批 2 项） |
| records/workspace 组 | `node --test server/records/*.test.ts server/workspace/*.test.ts` | 52 项：49 通过、**1 失败**、2 跳过 |
| 全量 | `npm test`（含 pretest build） | **212 项：204 通过、1 失败、7 跳过**，退出码 1；不宣称全量通过 |
| 文档检查 | `node tools/a0-review/check.mjs` | 通过：33 份文档、446 处内部引用、27 条正式变更路由，`errors=[]` |
| 检查器自测 | `node --test tools/a0-review/check.test.mjs` | 16/16 通过、0 失败、0 跳过 |
| 空白 | `git diff --check` | 通过 |

唯一失败项为 `server/workspace/review.test.ts` → `runner/control.ts:48` 的 `RunnerError: Linux and trusted control context required`（`code: INVALID_CONFIGURATION`），即 Linux-only `RunControl` 在 Windows 上不可用；这与独立审查在同一平台对 main `83e528e` 与本 PR head 测到的**同一条**失败一致，属 [#23](https://github.com/paher-din/XunJie/issues/23) 的既有环境限制，不是本批引入。212 = 审查时的 210 + 本批新增 2；204 对审查的 202、7 跳过对 7 跳过，差额即新增两项。

§11.2 报的 A2 双进程 401 在 Windows 上仍未复现；本批未修改该用例，也未据本批结果宣布其根因已定位（见 §8.4 第 2 条）。

### 13.4 未完成项与限制

1. P2-1 的跨 worker 累计计账在 B2/A3 接线前无人执行，按方案 1 属执行侧职责；C3 侧只交付契约语义与对账，**不宣称 #26 的「换 worker 共用 3 次」已被强制**。
2. `leaseToken` 改为必填是 B2 接缝的输入契约变化。B2 尚未接线（本 PR 不含任何 B2 接缝类型引用），实际联调时 B2 必须自带 token；C3-V08 仍未执行。
3. 未执行：真实模型与 B2 正式 help 联调、浏览器与实际 UI、真人与负载、C5 备份恢复、完整教师判断链。
4. 本批未合并 PR、未关闭 Issue #27、未改动受保护基线、未代为评论 #23。进度待授权维护者汇总。
5. 结构性独立审查缺口保留：C3 线仍以负责人账号交付，本批修复由执行 Agent 完成，不构成独立复核。
