# C0：工作区、记录与执行契约交付稿

日期：2026-10-08（Asia/Shanghai）。主责：C。关联：[C0 #4](https://github.com/paher-din/XunJie/issues/4)、[G0 #1](https://github.com/paher-din/XunJie/issues/1)。

自查修订：2026-10-09；发现及修订范围见第 14 节。新增协议细节仍为提案，未获 A/B 会审或实施批准。

状态：C 的接口提案、资源需求与验证方案及五项讨论决定已整理，交付 PR 正在提交；A/B 会审和实施批准未完成。正式应用代码、运行隔离、恢复和浏览器验收未执行，Issue 保持 Open。

## 1. 范围与文档边界

基线阅读：[AGENTS](../../AGENTS.md) → [README](../../README.md) → [PRD 第 3/5/8/9 节](../product/PRD.md) → [MVP_SPEC 的 M-03、M-05、M-07、M-09、M-10 及第 4/5/6/8 节](../product/MVP_SPEC.md) → [TECH_DESIGN 第 4.1/5/7/8/9/10 节](../product/TECH_DESIGN.md)，以及 [TEAM_WORK_PLAN 的 C0](../planning/TEAM_WORK_PLAN.md#c0工作区记录和执行契约)、[工程衔接说明](../reference/ENGINEERING_HANDOFF.md)。

本文是独立任务交付文档。“基线”表示沿用既定行为，“提案”表示本任务建议的字段/接口/协作办法，未批准提案不能覆盖基线或作为实施授权。按 2026-10-08 的明确要求，执行 Agent 不修改受保护文档；既有 Issue 中直接更新 TECH_DESIGN/MVP_SPEC 的要求按 AGENTS 改为先交独立任务文档，由获授权维护者汇总。

本次仅进行 C0 设计与评审准备，不创建应用、数据库、执行环境、替代 UI 或新插件，不迁入旧学生记录。首发语言、检查规则、模型/数据预算、后台选型、资源及实施授权继续按 D-01～D-04 决定。

## 2. StudentIDE 参考核查

参考：[paher-din/XunJie-StudentIDE](https://github.com/paher-din/XunJie-StudentIDE)，读取提交 `0d95ba640d1ec6822797f24988e9b97107d97367`，package.json 为 0.6.0。结论来自该版本文档/源码阅读，不将旧通过数作为正式产品验收。

| 固定版本来源 | 观察到的事实 | 正式任务中的处理 |
| --- | --- | --- |
| [journal.mjs](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/src/journal.mjs) 的 append/accept | 完整批次带校验和，写完并 fsync 后确认；事件 ID 去重，基版本和约 30 秒写租约限制 | 沿用持久确认原则；正式去重核对账号/Attempt/请求摘要，按基线使用多页面乐观并发，不直接迁入单机租约 |
| 同文件 replay | 文本按事件 seq 回放，但 deleted 取当前 buffers 状态，仅按 path 选事件 | 合成内存断言复现“回收前回放也返回 deleted=true”；正式回放按 fileId/当时生命周期/seq，不原样复用 |
| [server.mjs](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/src/server.mjs) 的 run/文件路由 | 入口取确认缓冲区，其他源码取磁盘；暂停采集拒绝运行、新建/回收和保存 | 与 M-03/05 存在差异；正式多文件快照全部取确认作品，采集暂停仍允许必要功能数据和显式求助/运行/提交 |
| [runner.mjs](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/src/runner.mjs) | 参数数组/shell:false、源码目录、编译/运行分离；宿主 spawn；每路 64000 字符截断；Linux 超时 kill 直接子进程 | 参考阶段和来源，执行器另建独立节点/整单元取消；输出按全阶段累计 64 KiB UTF-8 字节计 |
| [shared.mjs](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/shared.mjs)、[integration.test.mjs](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/test/integration.test.mjs) | UTF-16 增量有整数/边界/重叠校验，有草稿/回收/重启/多光标测试 | 用于设计正式合成用例；未运行旧插件测试，未复制源码 |
| [架构](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/docs/ARCHITECTURE.md)、[数据与安全](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/docs/DATA_AND_SECURITY.md)、[语言契约](https://github.com/paher-din/XunJie-StudentIDE/blob/0d95ba640d1ec6822797f24988e9b97107d97367/docs/LANGUAGE_CONTRACT.md) | loopback/MCP/Hook 不是多人身份/宿主隔离；smoke 不等于课程检查 | 教学内核独立于 Codex；A 管会话/课程权限，C 管确认作品/原始事实/执行，B 无写作品/运行/正式评价工具 |

依赖核查：旧项目依赖 MCP SDK、Monaco、Zod，构建使用 esbuild；源码树未列仓库级 LICENSE，THIRD_PARTY_NOTICES 是第三方许可说明。本次只参考机制和差异。后续若迁用纯逻辑，另核对来源授权、必要依赖及正式验收，不把插件作为现成后台模块。

## 3. 工作区、文件与不可变引用

**基线：** Attempt 固定学生/课程/活动及政策、量规、资源、运行版本；作品操作由学生发起。50 个文本文件、源码合计 1 MiB。运行/提交绑定确认快照，路径/行号只在对应实例和版本内解释。

**字段细化提案：**

| 对象 | 必需内容 | 不变量 |
| --- | --- | --- |
| Attempt | id/courseId/studentId/assignmentId/activityVersionId/status/revision/workspaceRevision/decisionEpoch；路线、问题、返回位置 | 归属由服务端确认；revision 是业务状态，workspaceRevision 是作品批次，不替代学习状态 revision；实际命名由 A0 汇总 |
| ProjectFile | fileId/attemptId/path/documentVersion/contentHash/text/lifecycle=active或recycled | fileId 由服务端分配；内容或生命周期变化递增版本；恢复保留实例，同名重建生成新 fileId |
| ArtifactSnapshot | snapshotId/attemptId/activityVersionId/workspaceRevision/manifest/snapshotHash/hashFormat/createdAt | manifest 含当时全部 active 文件的 fileId/path/documentVersion/contentHash/text；正文可回取，不原地修改，不补入磁盘旧文件 |
| Submission | submissionId/attemptId/snapshotId/hash/submissionVersion/checkResultIds/说明引用 | 检查匹配该快照/规则；教师许可重开后新建提交版本，旧提交不改写 |

路径提案：项目内 `/` 相对路径，拒绝绝对路径、盘符/UNC、反斜杠、NUL、空段、`.`/`..`、符号链接和重复规范路径；新建/恢复/快照/执行物化均校验。恢复回收实例时路径已占用返回 409，不能覆盖新实例。回收是逻辑生命周期，实际删除仍按 AGENTS 另行授权。

正文按实际 UTF-8 字节计算 SHA-256，不在计算时转换换行、trim 或替换 Unicode。清单摘要提案 `hashFormat=sha256-manifest-v1`：按 path 的 UTF-8 字节序排序，将固定序列 `[fileId,path,documentVersion,contentHash]` 组成数组，以紧凑 JSON/UTF-8 编码计算 SHA-256。服务端重新计算摘要；相同内容 hash 不构成跨 Attempt 访问许可。

ObjectRef 沿用 TECH_DESIGN 4.1 的 code/run/resource/project。代码核对 attemptId/snapshotId/fileId/path/documentVersion/contentHash 全部关联；范围提案为一基 UTF-16 行列、起点包含/终点不包含，按快照正文校验，不把编译器字节偏移当编辑器列。resource 核对活动/角色可见的资料与段落版本，run 核对 runId/快照，project 核对活动版本。source.session/modelId/seq 只表来源，modelId 不是模型版本或权限。

冻结快照带 expectedWorkspaceRevision，在短事务内读取完整确认清单；冲突返回 409，不冻结“碰巧最新”的版本。学生显式保存/求助/运行/提交可触发冻结，模型和被动分析不能触发。采集暂停的自动 sync 只维护最新确认作品，不为每次同步建历史快照绕过暂停。

## 4. 同步、去重与命令接口

**基线：** clientSeq/基版本校验，落盘后 ACK；冲突保留本机草稿/服务器版本。权限来自服务端会话、课程成员与资源归属。

**同步提案（Q1 方向已确认，接口细节待会审）：** clientId 区分页面，clientSeq 由客户端递增产生、不复用，服务端只将其用于批次去重，不要求连续、不维护“下一期待序号”门禁。批次带 expectedWorkspaceRevision；如附带获准过程记录，另带服务端签发的 captureRevision。操作为 create（clientFileKey/path/text）、update（fileId/baseVersion 与 text 或 UTF-16 changes 二选一）、recycle/restore（fileId/baseVersion）；同批同实例最多一个操作。新建 ACK 返回 clientFileKey → fileId，后续编辑等待该 ACK；这些客户端标识均不是身份。

短事务校验整批状态/归属/路径/基版本及最终 active 文件数量、UTF-8 字节上限，部分失败整批不写。确认作品、必要记录、serverSeq 和 CommandReceipt 同事务持久提交后才 ACK，存储/commit 失败不能显示成功。ACK 返回 workspaceRevision、文件实例/版本/hash/lifecycle、serverSeq、receiptId。

第一轮已确认取消连续序号门禁，因此不再为“消费拒绝序号”设置持久拒绝回执、nextClientSeq 或重建序列协议。CAS 冲突整批不改作品/观察；学生比较后用新的批次标识/幂等键和正确基版本提交，序号跳过本身不构成错误。请求结果未知时仍按原标识/原载荷查询或重试，不能换键猜测是否成功。拒绝请求是否需要公共错误记录交 A0 的统一错误/审计契约处理，不承担同步序号推进职责。

同步去重键为账号/Attempt/clientId/clientSeq，另复用公共 Idempotency-Key；两者须指向同一摘要/回执。已成功请求同键同摘要返回原 ACK，即使当前基版本已前进；已登记同键异摘要 409。顺序为重新鉴权/归属与恢复代际 → 已有摘要/回执 → 新命令状态/CAS，避免成功后丢 ACK 被当成冲突。乱序的新请求仍按文件/作品基版本校验，确认顺序只使用 serverSeq；不能把 clientSeq 跳号直接解释成过程缺口或完整过程证明。

409 返回获准范围的服务器版本/hash/冲突实例；本机草稿按账号/Attempt 隔离保留，由学生比较后用新序号/幂等键确认。采集暂停期间断线队列只能恢复当前作品基线，不能补传空窗逐次过程。

下表均为输入输出提案，已有路径沿用 TECH_DESIGN 5，新增读取/快照路径待 A0 统一；不预定 UI 控件或调用编排。

| 接口 | 输入 → 输出 | 允许/拒绝边界 |
| --- | --- | --- |
| POST /api/assignments/:id/attempts | 路由分配 → 当前 Attempt/固定活动 | 所属学生；当前尝试不重复创建，后续任务用新分配/尝试 |
| POST /api/attempts/:id/sync | 上述批次 → 持久 ACK/冲突 | ready/active 可写；个人 paused/分配暂停仍可保存现有草稿；submitted/reviewed/closed 不改写作品，修订先获许可 |
| POST /api/attempts/:id/snapshots | expectedWorkspaceRevision → snapshotId/hash/清单 | 学生显式操作；也可在显式求助/运行/提交命令内冻结，不授权改文件 |
| POST /api/attempts/:id/runs | 快照/hash、批准 profile 版本、entryFileId、input、mode=run或check、检查规则版本 → runId/jobId | active 且分配未暂停；入口在快照内、配置固定；不能传镜像/shell/任意命令或放宽限额 |
| POST /api/attempts/:id/submissions | expectedAttemptRevision、快照、说明/匹配检查引用 → submissionId | active；固定提交/切换状态/失效待投递教学动作同事务；重试返回同一提交 |
| POST /api/attempts/:id/controls | expectedAttemptRevision、单项控制和值 → 新控制版本/epoch | 三种控制分别处理；学生不能解除教师分配暂停，尝试暂停取消进行中动作 |
| POST /api/jobs/:id/cancel | 作业/预期版本 → 取消或已终结状态 | 校验发起/资源范围，原有结果保留，终态不被迟到 worker 回滚 |
| POST /api/actions/:id/receipts | 内容版本/hash、回执/clientReceiptId → 记录状态 | 目标学生客户端，回执不证明阅读/掌握 |
| GET /api/attempts/:id/workspace | 所属尝试 → 确认作品/版本/epoch/最近结果/反馈/覆盖/游标 | 本人/任课教师按角色裁剪，不含其他账号本机草稿 |
| GET /api/attempts/:id/snapshots/:snapshotId；GET /api/jobs/:id | 对象 → 可见正文或状态/结果引用 | B 的内部读取也核验归属/版本，不能跨学生枚举 |
| GET /api/attempts/:id/events | 作用域/游标 → 获准事件 | SSE/分页过滤后的 seq 跳号不表示采集缺口 |
| GET /api/me/courses/:id/export | 本人课程 → 本人可见记录 | 与教师课程导出共用第 9 节裁剪/完整性规则 |

错误沿用基线：401 未登录、403 越权/路径逃逸、409 版本/摘要冲突、413 超限、422 输入/引用不成立、429 限流/预算、503 不可用。返回 requestId、稳定原因及恢复步骤，不回显越权正文/内部路径；不可见 ID 的统一展示策略交 A0 核对。

## 5. 公共 Job、CommandReceipt 与事件

**基线：** C 提供公共作业/回执/原始记录，A/B 不另建队列；重试不重复业务副作用，SSE 只是通知。

| 记录提案 | 必需内容与约束 |
| --- | --- |
| CommandReceipt | receiptId/actorId/资源作用域/command/幂等键/requestHash/resultRef/serverSeq/committedAt/recoveryGeneration；成功业务变更与回执同事务，异步重试返回同 jobId；无凭据/逐次源码正文，不额外承担同步序号消费 |
| Job | jobId/kind/scope/requestReceiptId/status/expectedRevision/decisionEpoch/recoveryGeneration/目标版本/attemptCount/deadline/leaseToken/leaseUntil/resultRef/failure；实际用量另关联，未知不记零 |
| Event | eventId/serverSeq/type/scope/occurredAt/payloadRef或ObjectRef/来源；正文在获准业务记录中可回取，提交后通知 |

状态提案：queued → running → succeeded/failed；非终态可转 cancelling → cancelled、stale 或 timed_out。运行事实无法确认时为 outcome_unknown，仅查询原 runId 核对实际终态，不能回到 queued 重放。

领取/续租/完成以当前 leaseToken 及有效 recoveryGeneration 条件更新，旧代际/过期 worker 不能覆盖当前记录。模型/辅导完成另验 revision/epoch/政策/ObjectRef；整轮 45 秒/最多 3 次调用不随重启/换 worker 重置。重启 queued 再授权，running 先查事实；模型恢复策略待 B0 核对，不能无限重新调用。

取消先持久保存意图，提交后中止外部工作；完成先提交则返回已完成，取消先提交则迟到结果归档不投递。执行事实与取消原因分别保存，不声称代码从未运行。通知失败靠游标恢复，不重复命令；客户端按 actionId/contentHash 去重展示，不承诺外部传输恰好一次。

## 6. 教学消息、回执与覆盖区间

**基线：** 生成/投递/展示/确认分开，缺回执未知；事实/候选/教师判断分开，空窗不回填。

TeachingAction 提案关联 messageId/jobId/attemptId/recipientId、原文/contentHash、ObjectRef、政策/模型/分析版本、expectedStateRevision/decisionEpoch。Message 的 authorKind 表示 student/model/teacher/system 来源组件，originChannel 表入口，均不证明现实操作者。B 产候选、A 管有效状态/教师判断、C 管实际消息/运行/原始引用。

ActionReceipt 提案含 actionId/contentHash/receiptKind/clientReceiptId/clientId/reportedAt/receivedAt/serverSeq，按基线四元组去重。received 表收到、displayed 仅在内容渲染且页面可见时报告、acknowledged 来自明确操作；缺阶段就保留未知，不能从下次编辑补造。迟到 displayed 追加并标失效冲突，不回滚 epoch 或抹掉展示事实。

CoverageInterval 提案为 attemptId、status=collecting或paused或gap、start/endServerSeq、start/endAt、reason/source；开关在服务端提交点生效，区间仅说明可收到数据范围。离线/缺序/存储拒绝/重启另记缺口，不凭焦点/停顿推测心理或能力。

暂停后不上传/持久化逐次编辑/焦点/粘贴及被动分析，保留最新确认作品、最小版本/去重元数据、显式保存/求助/运行/提交功能数据。既有事实不回写。服务端核验开关和迟到过程批次；恢复只建当前基线/收后续，不补传暂停期间过程。关闭主动提示只取消提醒，主动求助仍可用。

迟到过程的区分提案：每次暂停和恢复均递增服务端 captureRevision，过程批次绑定采集时已获确认的版本。只接收当前 collecting 区间且 captureRevision 完全匹配的过程部分；缺版本/旧版本一律不作观察。过程版本失效不阻止按文件 CAS 确认当前作品，ACK 分别表达作品已确认、过程未采集及原因，不伪造过程 ACK。恢复时建立新基线和新版本，客户端不能给暂停/旧区间的队列改贴新版本。captureRevision 与 decisionEpoch 分开，采集开关不因此取消学生显式辅导。此规则区分协议区间，不宣称识别真实操作者或抵御客户端伪造学习过程。

Q2 已确认这项保守取舍：即使旧版本的迟到过程确实发生于暂停之前，跨版本后仍不补录为原始观察，相关区间保留缺口；不靠客户端时间追认。作品确认和显式功能数据按原规则处理，不把被舍弃过程理解为学生未行动或能力不足。

## 7. 同数据库事务的 epoch/旧动作失效提案

接口提案：`records.invalidateInTransaction(tx, {courseId, studentId, attemptIds, expectedEpochs, reason, causeRef})`。

tx 必须是 A 当前业务数据库短事务，C 不自行提交/另开连接/HTTP 双写。A 先核验权限/expectedStateRevision 并选受影响尝试，C 再核范围/epoch CAS、递增 epoch、标旧非终态辅导/分析/提醒及未展示动作 stale，追加原因/引用/事件，返回新 epoch 与失效 job/action IDs。失败全部回滚，通知/model abort/执行器取消均在提交后。

| 调用来源 | 事务及影响 |
| --- | --- |
| A 教师纠正 | TeacherDecision、新 revision、相关 epoch 和待执行教学依赖失效一并提交；保留原始运行/展示，不能重生成候选恢复已撤回的同一主张 |
| B 新求助替换 | 经统一业务事务入口失效旧辅导并保存新请求，不直接写有效动作；每 Attempt 最多一个有效辅导 job |
| A/C 暂停、限定帮助政策生效、提交 | 状态/控制与教学失效同事务；需停止执行时另记 cancelling，提交后取消整个单元 |

完成接口以 jobId/leaseToken/expectedStateRevision/epoch 条件保存，投递和前端本地再核快照/文档/政策。取消/替换/过期输出仅归档，不成为当前提示/有效候选；已发生用量仍记录。纠正不改写当时帮助条件。

待 A/B 核对实际事务 handle、受影响 Attempt、版本字段、候选保存入口及替换/取消/超时完成接口；当前未会审，不把此签名写成已冻结 API。

## 8. 独立执行与可信课程检查

**基线：** 专用 Linux 节点/VM 每作业容器。模型无执行入口，应用宿主不运行学生代码；语言/规则未定不冻结镜像/命令。

### 8.1 控制面与结果提案

内部接口提案 submitRun/queryRun/cancelRun 仅向获认证的应用服务开放，入队/分派再核授权/活动/批准配置，凭据不入学生环境或输出，具体配置另行授权。

提交字段：runId/jobId、recoveryGeneration、Attempt/活动引用、snapshotId/hash/完整清单、runtimeProfileVersion/imageDigest、entryFileId、input/inputHash、mode=run或check、checkRuleVersion、固定限额。命令/参数数组来自受信配置；执行器重新校验正文/清单 hash、授权的恢复代际，runId 持久去重，同 ID 异摘要拒绝、同摘要返回原接受/结果。控制面 ACK 只表示作业接收。

取消先于提交的提案：cancelRun 带已授权的 runId/作用域及请求摘要，执行节点即使尚未接受该运行，也先持久记录取消意图；不能以 not_found 当作无需记录。submitRun 和启动隔离单元均核对此意图，迟到提交返回已取消，不能启动或复活同 runId。取消与本地启动必须由同一节点的原子状态迁移串行判定：若启动先取得执行权，取消负责终止该单元，确认整个单元已停后才能返回 cancelled；控制面失联保持 cancelling/outcome_unknown，不以应用保存了取消意图就释放槽位。原意图与启动事实保留，双向重试仍按原 runId 去重。

这里的状态仲裁不是 DB 提交和容器创建的共同事务。C1 仍须证明“取得启动权 → 尚未创建单元 → 取消看到不存在 → 迟到创建”不会在取消确认后留下运行单元，具体可靠机制依实际执行环境评审；在此窗口无法排除前保持 cancelling/outcome_unknown，不因暂时看不到容器就确认 cancelled。此项属于待实现/验收条件，不要求负责人用猜测代替环境事实。

RunRecord 提案记录接收/编译/执行阶段、各阶段 exitCode/signal/stdout/stderr、累计 UTF-8 输出字节/截断、配置/digest/hash、资源、failureKind/来源。退出 0 只表示程序正常退出，mode=run 不返回课程 passed。编译错不执行；环境 smoke 单独绑定配置/digest/样例 hash，只表环境就绪。

CheckResult 单列 runId/snapshotId/hash、inputHash、规则/验证器版本、digest、覆盖范围、verdict=passed或failed或incomplete、可见诊断。环境/启动/限额/取消/未知为 incomplete，不记知识错误或课程通过；正式评价由教师决定。执行错误、断言失败、工具故障分别表达。

可信验证器在学生进程之外处理受限输出/协议数据，不在应用宿主运行学生产物。私有答案/判定代码/完整私有日志不挂学生容器/快照、不入 B 上下文，公开诊断按帮助政策裁剪。运行测试输入可能对程序可见，不声称输入保密或能阻止外部帮助。

限定帮助检查的控制提案：接受检查作业时，在同一业务事务登记活动规定的检查帮助限制并失效不再允许的待投递辅导；检查进行中，B 的入口/读取/投递都核对限制，学生不能用另一页面解除。按课程规则在确认完成或取消后结束该检查限制，不能因执行失联自行放开。具体范围/触发点由课程负责人及 A/B 会审，不能临时改变原评分或帮助政策。

失败分类提案：compile_error、program_error、timeout（带阶段）、oom、process_limit、temp_limit、output_limit、cancelled、infrastructure_error；outcome_unknown 单列为事实未知。不能仅从退出码猜 OOM/资源原因，需隔离单元/控制面证据，未能判别时保留未知。

### 8.2 隔离与限额方案

| 基线要求 | C1 实施/核验提案 |
| --- | --- |
| digest/固定命令/非 root | 唯一语言预装；去 capabilities、no-new-privileges、受限 seccomp；禁止特权、host PID/network、引擎 socket、自定义配置 |
| 网络/路径/挂载 | network none；只读根/源码；不挂应用/DB/密钥/其他作业/私有资产；拒绝 symlink/逃逸，控制面单独认证 |
| 1 CPU/512 MiB | 显式 CPU 配额、memory=512 MiB、memory+swap=512 MiB；核实际 cgroup，不用容器内 free 推断；系统/控制面另留余量 |
| 64 进程/128 MiB 临时空间 | 显式 pids 上限；编译输出/临时文件共用合计 128 MiB 写区，无旁路卷；tmpfs 计入内存 |
| 编译 30 秒/执行 10 秒 | 整作业同阶段累计墙钟预算，不给每步骤/测试重置预算；超时取消整个单元 |
| 总输出 64 KiB | stdout+stderr+各阶段按 UTF-8 字节累计；到限停止整单元并记 output_limit，不能只截显示 |
| 每 Attempt 一个/全局两个 | 原子队列，重启对账槽位；失联/取消未确认终止前不能释放槽位让旧作业绕过并发 |
| 整单元取消 | 停止容器及全部进程，核无存活子进程后保存终止事实；直接 child.kill 不足 |

回源核对：[Docker 资源限制](https://docs.docker.com/engine/containers/resource_constraints/)说明资源需显式设置及 memory-swap 组合语义；[Docker 安全边界](https://docs.docker.com/engine/security/)说明共享内核/控制面权限风险。本文据此提出验证办法，不表示环境已通过。

### 8.3 D-03 资源与责任提案

| 条件 | 需求及责任 | 状态/阻塞 |
| --- | --- | --- |
| 应用节点 | A 负责单应用进程/本地持久磁盘/会话/DB，C 核对作业/备份/容量；按 10 会话实测，不虚构已分配机器 | 未登记，阻塞真实联调/恢复/性能验收 |
| 独立 Linux 节点/VM | C 核查 cgroup/seccomp/容器引擎/两槽/控制面；建议至少 2 vCPU/2 GiB 为核查起点，系统余量/工具链峰值须实测，非批准采购规格 | 未提供，阻塞 C1/真人运行，不回退宿主 |
| 唯一语言/profile | 课程负责人确认 D-01，C 提 digest/实际版本/入口/固定命令/白名单/smoke，A 纳入活动就绪 | 未定，不冻结镜像或占位 ready |
| 可信课程规则 | 课程负责人定检查/可见诊断，C 实现外部验证器，A/B 核私有资产/限定帮助 | 未定，阻塞课程规则冻结 |
| 控制面/备份 | A/C 提访问/认证/存储位置权限/容量/恢复人员，技术负责人确认；凭据/部署另行授权 | 未定，不能宣称部署/恢复已具备 |

## 9. 恢复、导出与一致性备份

**基线：** 重启不丢已 ACK 事务，不盲目重复执行；导出含可见引用/帮助/判断版本/缺口，备份恢复与正常重启分别表达。

恢复包提案包含账号/课程/Attempt、活动/资料/政策/配置、业务/作品 revision/文件、epoch、最近 run/check/submission、待处理问题/返回位置、有效反馈/引用、采集状态/区间/游标。客户端先恢复再比较独立本机草稿/冲突，再展示待投递动作；切换账号不能看前一账号草稿，存储不可用须提示，不依赖模型常驻。

执行掉线先查询同 runId；无法判断则 outcome_unknown，保留请求/最后事实，恢复后对账。学生明确新运行用新 runId，旧未知不抹掉；迟到结果标原版本，不成为新作品当前结果。应用恢复通过事务回执重取 ACK，失败不装成功。

学生可提出新运行请求，但原隔离单元尚未确认终止时仍须等待，不能绕过每 Attempt/全局槽位约束；维护者核验故障节点/单元终止后才能释放占用，未知结果本身不能充当终止证明。

导出在一致读取视图生成，记录 exportId、scope、角色/可见性版本、cutoffServerSeq、时间/文件校验摘要；教师限所属课程，学生限本人可见，维护者按数据处理授权，不代替教师评价。包括获准作品/快照、实际消息/帮助、运行/可见检查、候选/判断版本、支持/反证/未知、覆盖缺口。

引用裁剪不能带出私有资产，缺失/撤回/不可见标 unavailable/redacted，不补正文；私有正文/输出/内部路径/可能泄露内容的摘要均裁剪。下载再鉴权并审计，不导出会话/密码/token/控制面凭据，不新增永久公开下载链接。

备份采用一致性接口，不只复制活跃 DB；推荐 SQLite 时用驱动 backup API/等效方式，必要业务正文同库避免双写，若将来另加文件须评审统一恢复点。参考 [SQLite Backup API](https://www.sqlite.org/backup.html)。

恢复目标沿用 TECH_DESIGN 建议：正常重启不丢 ACK，备份 RPO 为最近一次成功备份、RTO 30 分钟，D-03 未批准前仍为目标。建议教学会话前后备份，清单含成功时间/数据格式版本/cutoffServerSeq/摘要/责任角色。A 管账号/DB/访问恢复，C 管备份/作业对账/引用完整性，教学/技术负责人定存储/保留/处理人员。

隔离恢复目标核完整性/外键/正文/hash/当前 revision/ACK 回执/runId 去重；先保持调度暂停并对账，不能把备份 running 直接重跑。报告实际损失窗口/RTO，磁盘毁损不称零损失；实际删除备份、覆盖正式 DB 或迁移须另行授权。

跨备份回退的幂等提案：恢复不仅查询备份里已有的 runId，还按作用域核对独立执行节点的完整接收账本，包括备份截止点之后的运行/取消；后者不能因应用 Job/Receipt 丢失而被遗漏。无法还原完整关联时记录缺口/未知，不重造回执或宣称已对账。

恢复旧备份时由 A/C 的授权恢复流程生成新的 recoveryGeneration，正常进程重启保持原代际；恢复包和变更命令携带服务端签发的代际。旧代际的重试返回 409 recovery_required，不创建新 Job/runId/提交；客户端先恢复、比较草稿和结果，只有学生明确发起的新操作才使用新代际/幂等键。RPO 允许备份截止点后的应用数据缺失，但不允许将旧请求静默当成新动作。执行节点账本也丢失时继续保留未知及槽位终止核验，不能许诺重构丢失事实。该共享代际字段/恢复入口待 A0 会审，未落实前不得解除恢复门禁。

Q3 已确认将恢复代际作为全应用统一候选：A 管应用恢复与代际登记，C 的公共记录/执行能力及 B 的作业完成/投递接入同一恢复边界，不能各模块独立生成代际。具体字段、持久化和恢复入口仍待 A/B 会审，方向记录见 [C0 ADR-0001](C0_ADR_0001_UNIFIED_RECOVERY.md)。恢复门禁也需覆盖执行节点迟到提交；执行节点尚未确认采用当前代际时，不得恢复新作业分派，不能只拦浏览器重试而放过旧控制面消息。第 2 轮 Q4/Q5 已明确旧作业续跑和账本范围，具体接口及实现仍未会审/验证。

Q4 已确认：只在回退旧备份后，旧代际尚未执行的异步作业不自动续跑，即使已证实未启动也保留原作业及恢复原因、标为 stale，待原发起者核对恢复后的内容并显式发起新操作；不自动创建替代 jobId/runId，不替学生改变 Attempt 状态。普通进程重启仍按基线续取有效作业。对于已经执行、可能执行或尚未确认终止的旧作业，继续查询原 runId/实际结果，不因放弃续跑就伪称已取消或释放未核实槽位。

Q5 已确认：长期执行账本只保存对账必要的作业事实、稳定原请求关联、摘要和结果引用，不额外长期复制学生源码与教学消息。元数据须能核对发起/归属范围、原命令与 runId 的对应、固定快照/输入/配置摘要，以及接受/启动/取消/终止事实和来源/覆盖缺口；不得含会话或控制面凭据。作品、消息和授权运行结果正文仍归应用的获准业务记录；运行必需的临时快照、待交付结果不因本决定省略，但其保留/处理由 D-03 和执行环境另行落实。本决定不授权自动删除或永久保留。

账本中的“完整”指相关作业事实和关联覆盖，不表示备份了作品正文。回退后丢失的源码/消息/输出或引用正文按声明的 RPO 保留 unavailable/缺口，不能靠摘要重建，也不能以旧运行元数据生成完整作品证据或课程通过结论。此处的缺失与采集暂停空窗分别说明，不能改写为学生没有行动。

## 10. 后续验证方案

以下为拟执行用例，当前均未执行。用新合成项目/隔离账号，禁止操作旧学生学习会话；每条保留输入、配置/digest、预期/实际、故障点、引用与失败，不只留成功截图。

| 用例 | 操作与通过条件 | 映射/责任/前置 |
| --- | --- | --- |
| C0-V01 持久 ACK | commit/ACK 前后中断；成功 ACK 作品/回执重启可取，未提交不报成功 | AC-03/12、NFR-01；C2/C5，真实 DB，浏览器等 UI |
| C0-V02 幂等 | 同摘要重发/已登记异摘要复用、ACK 丢失、clientSeq 跳号/乱序、CAS 拒绝后新批次；跳号不单独拒绝，基版本阻止覆盖，未知结果用原请求核对，同动作仅一次 | AC-06、NFR-04；C2/C3/A 事务 |
| C0-V03 文件/范围 | 双页冲突、回收/恢复/同名重建、历史 seq、中文/emoji/多光标；两份冲突保留，实例/UTF-16 正确 | AC-03/04、NFR-05；C2，实际 UI |
| C0-V04 多文件快照 | 多文件已 ACK 未传统落盘，冻结后编辑；运行/求助/提交仍绑定旧完整清单 | AC-04、NFR-03；C1/C2/B2，runner/UI 分别记录 |
| C0-V05 回执 | 重发事件/回执、缺 displayed、过期后迟到；一次有效展示、缺回执未知、迟到事实保留 | AC-06/08；C3/B2，真实 UI 回执 |
| C0-V06 纠正竞态 | A 纠正时 B 生成、事务失败/旧表单/旧 worker；全回滚或全提交，旧提示/候选不生效 | AC-08；A4/C3/B3，同 DB/真实模块 |
| C0-V07 暂停采集 | 暂停/恢复后延迟送达旧过程批次，包括暂停前产生的旧过程、多页面旧 captureRevision 与正常功能操作；跨版本过程拒收并留缺口，作品可确认，ACK 分开 | AC-11、NFR-05；C3/B2，UI/网络/存储 |
| C0-V08 授权 | 伪造身份/其他快照、跨课程/学生读写/事件/导出/模型读取；统一拒绝无泄露 | AC-02/15、NFR-04；A6/C5/B4 |
| C0-V09 路径/挂载 | 绝对/父目录/UNC/编码逃逸/重复/symlink，读应用/他人/私有合成 canary；拒绝且应用可用 | AC-10；C1/C5，独立 Linux，无真实密钥 |
| C0-V10 网络/权限 | 连外网/内网/控制面、读 socket/host namespace、提权；拒绝，核实际非 root/cap/seccomp/挂载 | AC-10；C1/C5，独立环境/配置和行为证据 |
| C0-V11 CPU/内存 | 两槽负载、超量内存/swap；CPU/memory+swap 限制生效，OOM 独立，应用不受影响 | AC-10、NFR-03；C1/C5，cgroup/监测 |
| C0-V12 进程/写区 | 受控过量进程/文件；64 进程/128 MiB 生效，无旁路写卷/遗留子进程 | AC-10、NFR-03；C1/C5，隔离资源环境 |
| C0-V13 超时/输出/取消 | 累计超时/死循环/中文双路输出/子进程/重复取消，cancel 先到、启动权已取得但单元未创建时取消/崩溃；迟到创建不越过取消确认，整单元终止后才确认 | AC-10/12、NFR-03；C1/C5，真实单元 |
| C0-V14 并发恢复 | 第三作业排队、同 Attempt 第二运行、普通重启/失联/取消；普通重启可续取有效 queued，未核实停止不释放槽位，不超两槽、不重放未知 | AC-06/10/12、NFR-03；C1/C2/C5 |
| C0-V15 可信检查 | stdout passed/退出 0 但不符规则，缺工具/编译错/私有命令/受限求助；运行/smoke/check/评价分开，私有资产不入载荷 | AC-15；C1/A6/B4，D-01 规则 |
| C0-V16 恢复未知 | 断网/重启/执行掉线/模型中断/旧结果；确认成果恢复、原 runId 对账、无伪造/重复，未知用量显式为 unknown，不填零或虚构非零值 | AC-06/12、NFR-05/06；C4/C5/B4 |
| C0-V17 导出/备份 | 写中备份/隔离恢复、跨角色/裁剪，回退后重试旧请求、已证实未启动旧作业及缺正文；不自动续跑/造替代作业，不改变 Attempt，账本覆盖并含必要关联，不长期复制源码/消息，缺口按 RPO 明示 | AC-12、NFR-04；C5/A6，D-03 条件；同时报告实测 cutoff/RPO/RTO |
| C0-V18 保存/键盘 | MVP 的 10 会话每 2 秒同步、至少 100 次；报 p50/p95/失败，保存 p95≤1秒，键盘完成恢复/冲突 | NFR-01/05；C5/A6，登记机器/实际 UI |

先核独立节点/有效配置，再做拒绝/限额/竞态；攻击及资源样例只在受限环境执行。启动容器、smoke、源码阅读、替身接口均不能通过 AC-10/15。严重越权/数据丢失/隔离缺失阻止真人运行。

## 11. 会审与待冻结事项

| 事项 | 准备/确认角色 | 当前结论/受阻 |
| --- | --- | --- |
| 身份/业务版本/快照引用 | C 提案，A 核授权/状态，B 核读取/ObjectRef | 待会审，不能冻结字段/路由；Q1～Q5 的讨论取舍已确认，captureRevision/recoveryGeneration 等具体接口仍需 A/B 核对 |
| Job/消息/回执/取消 | C 提案，A/B 核公共记录/候选保存/替换超时 | 待会审，未联调/未验收 |
| 同事务纠正/失效 | C 提签名，A 定事务/影响范围，B 定条件完成调用 | 待会审，不能双写或单方冻结 |
| D-01 语言/规则/profile | 课程负责人确认，C 核可执行性，A/B 核政策 | 未定，阻塞运行/规则冻结 |
| D-03 节点/备份/数据 | A/C 提清单，教学/技术负责人定资源/访问/保留/人员 | 未登记实际资源/目标批准，阻塞隔离/恢复/试点 |
| 后台选型/实际目录 | A 汇总 B/C，团队评审 | 未冻结，本文模块/字段不代表已有代码/表 |
| D-04 实施范围/排期 | A 汇总投入/依赖，总负责人确认具体方案 | 未登记，文档完成不自动授权 C1～C5 |

五处交界：身份/版本，作业/消息/取消，事实/候选/教师决定，运行/可信检查，恢复/覆盖/导出。C 的核对输入已备；A/B 意见、差异解决记录和确认日期尚缺，不替成员登记“通过”。

## 12. Issue 交付覆盖与关闭条件

| C0 #4 交付项 | 本文位置 | 状态 |
| --- | --- | --- |
| Attempt/文件/不可变快照/ObjectRef | 第 3 节 | 提案已写，待会审 |
| ACK/去重/冲突/回收/同名重建 | 第 3/4 节 | 提案已写，测试未执行 |
| Job/CommandReceipt/事件/动作/覆盖 | 第 5/6 节 | 提案已写，真实消息/回执未验收 |
| 同事务 epoch/旧动作失效 | 第 7 节 | 提案已写，待 A/B，事务测试未执行 |
| 独立节点/镜像/命令/资源 | 第 8 节 | 清单已写，语言/环境未冻结 |
| 运行/可信检查/失败分类 | 第 8.1 节 | 提案已写，执行未验收 |
| AC-10/15、NFR-03 隔离/限额方案 | 第 8.2/10 节 | 方案已写，环境测试未执行 |
| 断线/未知/迟到/导出/备份/D-03 | 第 9/11 节 | 提案已写，恢复未演练 |
| A/B 及 AC-03/04/06/08/11/12、NFR-01/05 | 第 4/7/10/11 节 | 核对输入已备，会审/浏览器未执行 |

PR 关联 #4，说明独立文档边界、来源版本、章节/参数、拒绝/失败及实际验证，不用自动关闭关键字提前关闭 Issue。关闭须有交付 PR、A/B 会审和差异解决记录；需合入受保护基线时另获明确授权。C0 完成只表示契约评审完成，不表示 G0～G4/产品验收通过。

## 13. 本次验证与基线汇总请求

| 检查 | 实际状态 |
| --- | --- |
| Issue 回读 | #4 Open，正文与仓库发布正文一致，无评审评论 |
| 参考读取 | 固定提交文档/关键源码已读；未安装依赖/启动旧服务/迁入代码 |
| 参考 replay 核验 | Node 合成内存断言通过，复现当前 deleted 污染历史；仅为参考风险核验，不是产品测试 |
| 文档链接/覆盖/边界检查 | `node --input-type=module` 内联检查通过：10 份 Markdown、68 处仓库文件/锚点引用、九项 C0 交付、18 个拟执行用例及 M/AC/NFR 映射；任务文档无个人路径/旧本地服务依赖。首轮计数脚本将表格分隔行误计为交付项，断言失败；修正检查脚本后通过，未放宽验收 |
| git diff --check | 通过；新增任务文档另检查末尾空白与文件编码 |
| 受保护文件 | 本任务误加 TECH_DESIGN 内容及恢复时引入的换行变化已撤回，字节与任务开始时版本一致；PRD 未改，product/planning/reference 无内容 diff；只同步本人任务文档和 README 导航 |
| 应用/隔离/资源/恢复/浏览器 | 未执行，无正式代码/环境，不计入 AC/NFR 通过数 |
| 交付 PR/A/B 会审 | 项目负责人已于 2026-10-09 明确授权提交 C0 文档 PR，正在提交；A/B 会审未完成，不能由 C 自行代签 |

待授权维护者汇总：MVP_SPEC 第 10 节登记“C0 独立任务文档交付稿已整理，接口/验证方案覆盖九项任务；无代码、业务及浏览器验收未执行，PR/会审/参数冻结待完成”；TEAM_WORK_PLAN/G0 跟踪登记同一真实状态。受保护基线的具体契约合并只在批准相应提案并授权写入后处理，本任务不直接修改这些文件。

PR 准备：标题 `docs: deliver C0 workspace, records and runner proposals`；提交范围为本文、C0_GLOSSARY、C0_ADR_0001_UNIFIED_RECOVERY 及 README 中的 C0 导航条目，关联 #4 而不自动关闭。不纳入并行技能安装/接入任务的文件或 README 改动。说明 C0 九项覆盖、参考提交/差异、18 个后续用例、五项已确认讨论决定与实际文档检查结果，明确 A/B 会审、D-01/D-03、基线汇总及业务验收尚未完成。工作规范已由仓库独立提交 `8a0e332` 更新，当前 C0 不重复提交或改写该规范。

## 14. 2026-10-09 自查记录

自查范围：当前 C0 文档及 README 导航，对照 Issue #4、MVP 的单课程/50 文件/10 会话负载、相关产品/技术/工程基线和固定版本 StudentIDE。仅修订 C 的待评审提案与测试输入，没有实施接口、改写基线或替 A/B 作决定。

| 编号/优先级 | 具体失败情境与后果 | 最小修订及验证去向 |
| --- | --- | --- |
| R-01 / P1：取消先于提交 | submitRun 在网络中延迟，cancelRun 先到且运行尚不存在；若只返回 not_found，迟到提交仍可启动，违背取消/限额边界 | 第 8.1 节补执行节点持久取消意图及启动/取消原子判定，确认终止前不返回取消完成；补入 C0-V13 |
| R-02 / P1：采集恢复后旧批次 | 暂停再恢复后服务器开关已为 collecting，旧页面/网络队列的过程批次迟到；仅检查当前开关不能判断所属区间，可能补入空窗 | 第 4/6 节补 captureRevision、旧过程拒收与功能 ACK 分离，保留客户端归因限制；补入 C0-V07 |
| R-03 / P1：备份回退后的旧请求 | 备份之后运行已被执行节点接受，应用回退后对应 Job/Receipt 不在库中；只查备份已有 runId 无法识别旧请求，新分配 ID 会重复运行 | 第 9 节补完整账本对账及恢复代际门禁，旧请求不得被当成新动作；新增字段仍待 A0 会审，补入 C0-V17 |
| R-04 / P2：冲突批次的序号 | 第一版要求连续 clientSeq，CAS 拒绝后新批次可能被当成缺序；自查曾提持久拒绝/消费序号方案 | grill 第 1 轮 Q1 已改选更小方案：取消连续序号门禁，保留去重/文件基版本/serverSeq，撤回序号消费方案；更新 C0-V02，未实施 |
| R-05 / P2：未知用量措辞 | C0-V16 的“未知用量非零”可能被实现成填一个正数，仍在伪造用量 | 改成显式 unknown，不填零或虚构非零值；与 TECH_DESIGN 10.3 保持一致 |

本次不把上述推演当作运行测试。第一版链接/项目数量检查通过，仅证明结构完整，未证明协议正确。上述缺口已写回提案并补入拟执行用例；修订后 `node --input-type=module` 内联检查通过：检查时 11 份 Markdown、76 处仓库链接/锚点、九项交付、18 个拟执行用例、五项自查与对应补充场景；编码/空白与 `git diff --check` 通过。对照检查前后的 SHA-256，九份既有基线/规范/README 文件字节未变，本次只维护 C0 任务文档；其他任务文件保持原样。真正协议、隔离与故障验收仍未执行，A/B 会审及实现批准仍缺。

检查范围说明：项目文档清单由 `rg --files AGENTS.md README.md docs -g '*.md'` 获取。复跑时，全仓库扫描曾纳入并行任务新安装的 skills 示例，将示例路径当作项目引用而失败；确认来源后按上述项目文档范围检查通过，未修改技能或关闭 C0 检查。

## 15. grill-with-docs：设计追问记录

日期：2026-10-09。按明确调用的 grill-with-docs，结合 grilling 与 domain-modeling 追问第 14 节报告；第 1 轮 Q1/Q2/Q3 由项目负责人“三项按推荐”确认，第 2 轮 Q4/Q5 由“全部接受”确认。针对本报告的五项讨论取舍已收敛，没有待回答的产品取舍；A/B 会审、资源/保留参数和技术实现验证另列门禁，不外推为整个产品方案已冻结。没有独立 Skill 调用工具，按技能文件正文直接应用两个流程。

已明确的领域用语摘录为独立 [C0_GLOSSARY](C0_GLOSSARY.md)，不包含接口字段或存储机制。Q3～Q5 的恢复作用范围、责任、续跑和数据取舍集中记录在 [C0 ADR-0001](C0_ADR_0001_UNIFIED_RECOVERY.md)，状态为负责人已确认讨论决定、具体共享契约待会审；Q1/Q2 留在任务决定记录，不为易调整的协议细节另建 ADR。本报告讨论确认不代替 A/B 会审或实施批准，不按候选方案直接实施，不更新受保护基线。

### 设计树与当前问题

| 分支 | 已知前提 | 当前待决定/核查 | 状态 |
| --- | --- | --- | --- |
| 同步与冲突 | 基线要求基版本校验、幂等和服务端顺序，未要求 clientSeq 连续 | Q1：取消同步批次连续序号门禁，仅保留去重/版本校验；serverSeq 表达确认顺序，过程缺口另外记录 | 第 1 轮方向已确认；第 4/5 节及 C0-V02 已同步，原序号消费方案已撤回，接口未实现/未会审 |
| 采集边界 | 暂停期间的逐次过程不能回填；功能数据仍可保存 | Q2：保守舍弃跨采集版本迟到过程，即使其中少量内容产生于暂停前；功能不受影响，缺口如实记录 | 第 1 轮取舍已确认；第 6 节/C0-V07 已同步，不声称过程完整 |
| 取消与终态 | 基线要求终止整个隔离单元；保存意图不证明已停，状态仲裁不等于容器启动的原子性 | 第 8.1 节尚需覆盖“取得启动权 → 取消看到容器不存在 → 迟到启动”的窗口；具体可靠机制须在执行资源/实现方案具备后继续核验 | 只读事实核查完成；R-01 只能记为提案已补充，不能记已解决 |
| 重启与恢复 | 正常重启不丢 ACK；备份回退允许 RPO 范围的数据缺失，仍不能盲目重复动作 | Q3：全应用统一恢复代际候选，A 管应用恢复，C 接入记录/执行；Q4/Q5 进一步确定旧作业行为及账本范围 | 第 1 轮方向已确认，ADR-0001 已记录；新增契约待 A/B，R-03 仍不能记已解决 |
| 回退后旧作业 | 普通重启可续取有效作业；未在账本找到记录不等于证实未启动 | Q4：旧备份恢复后停止自动续跑尚未执行的旧作业，保留理由，由原发起者核对后显式新发起；已执行/未知仍按事实对账 | 第 2 轮取舍已确认，第 9 节/C0-V14/17/ADR 已同步；实际行为未实现 |
| 执行账本范围 | 持久接受/结果去重已有基线，元数据不能重建正文 | Q5：必要作业事实/原请求关联/摘要/结果引用，不为对账长期复制源码或消息；缺失正文按 RPO 留缺口 | 第 2 轮取舍已确认，第 9 节/词汇表/ADR/C0-V17 已同步；保留期/人员/关联仍待 D-03 和会审 |
| 用量未知 | 基线已规定未知不记零，不补造用量 | 保留显式 unknown；这是既定边界，无需重新决策 | 已有依据，不新增问题 |

第一轮决定来源：项目负责人回复“三项按推荐”。确认原文对应为 Q1“取消。clientSeq 用于去重，文件基版本防止覆盖，serverSeq 表达确认顺序；过程缺口单独记录”；Q2“接受。明确记录缺口，作品保存和显式求助照常，不依赖客户端时间补齐历史”；Q3“统一处理。代价是恢复后旧页面和旧作业必须重新核对；仍需 A/B 会审”。这些决定已同步相应任务正文，不能外推为基线写入、代码/迁移或公开发布授权。

第二轮决定来源：项目负责人回复“全部接受”。Q4 推荐原文：“接受。原发起者核对恢复后的内容，再明确发起新操作；普通进程重启仍续取有效作业。”Q5 推荐原文：“接受。正文由应用保存；回退后丢失的内容明确标为缺失，不能靠元数据补造。”两项已同步到任务正文及恢复 ADR，不增加对基线、代码、数据库、凭据或发布的授权。

只读核查记录：TECH_DESIGN 8.1 已有 runId 接收/结果去重，10.1 区分正常重启与备份 RPO；第 8.1 节没有明说 DB 提交与容器启动同事务，因此不能将其直接判作已有事务违规。真正缺口是启动权取得后到外部单元创建之间尚无明确安全机制。R-01/R-03 现阶段是风险已识别、提案及验证输入已补充，不能登记为缺陷已修复或协议通过。

第二轮事实核查：TECH_DESIGN 7.4 的普通重启续取未决定旧备份恢复后的旧作业策略；账本无记录、过期或丢失不能证明未执行。运行接受/取消/终止的必要关联至少要能找到原发起范围、稳定业务请求与 runId、固定快照/输入/配置摘要及实际状态/来源/覆盖缺口。基线没有授权执行端长期冗余保存学生正文；必要元数据可辅助去重/占用核对，但不能称作恢复了丢失源码、消息或完整业务回执。

第 1 轮提问时的文档验证：`node --input-type=module` 内联检查通过，检查时 13 份项目 Markdown、88 处仓库文件/锚点引用，C0 新文档空白检查及 `git diff --check` 通过；product/planning/reference/AGENTS 无本轮差异。问题等待回答不是业务验证通过，未执行应用、执行隔离或恢复演练，未创建 PR 或公开发布。

第 1 轮回答同步与第 2 轮准备验证：同类内联检查通过，14 份项目 Markdown、92 处仓库文件/锚点引用、18 个拟执行用例；确认 Q1/Q2/Q3 已同步，Q4/Q5 仅为待回答问题，原同步序号消费不再作为当前方案。三个 C0 文档空白检查及 `git diff --check` 通过，受保护文档无差异；无实现/业务验收、无发布。

### 收敛后的边界与下一步

五项负责人取舍均已记录并同步，当前报告没有新增待回答问题。取消启动窗口、可靠恢复代际登记/传播、账本关联充分性和保留/资源参数仍是已显式列出的工程/会审门禁，不将未知实现细节伪装成已解决，也不凭空增加新产品选择。下一步由 A/B 会审公共接口，A/C 将恢复与资源条件纳入 G0；C1/C5 按对应失败场景做真实验证。未获授权的基线同步、迁移、配置和发布均不执行。

第 2 轮回答同步验证：`node --input-type=module` 内联检查通过，14 份项目 Markdown、92 处仓库文件/锚点引用、18 个拟执行用例；五项取舍全部有确认来源且已同步到相应正文/词汇表/ADR，设计树当前待回答项为零。三个 C0 文档空白检查及 `git diff --check` 通过，受保护文档无差异。此次收敛仅针对本报告的讨论，不代表 C0 Issue 已关闭、G0 已冻结或产品验证通过。

## 16. PR 交付记录

2026-10-09，项目负责人明确要求“提交pr吧”，授权公开提交当前 C0 文档 PR。范围为三份 C0 文档及 README 的 C0 导航条目；在独立工作树制作提交，不带入并行技能安装/接入的文件、配置或 README 变更。当前正在提交，后续记录实际 PR 身份及提交工作树的验证结果；此授权不包含合并 PR、关闭 Issue、改写产品基线或实施应用。

提交工作树验证：`node --input-type=module` 内联检查通过，12 份 Markdown、73 处仓库文件/锚点引用、18 个拟执行用例、五项已确认讨论取舍；三个 C0 文档编码/空白/本地路径依赖检查、`git diff --check` 通过。README 仅增加一条 C0 导航，AGENTS、product/planning/reference 和 .gitignore 无差异。此前源工作空间的 14 份/92 处检查包含并行任务文档，提交工作树仅包含当前 PR 范围，分别记录，不混算业务验收。
