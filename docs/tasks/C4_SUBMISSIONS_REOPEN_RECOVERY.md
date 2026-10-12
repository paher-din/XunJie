# C4：固定提交、学生修订与闭环恢复

任务编号：C4（[Issue #43](https://github.com/paher-din/XunJie/issues/43)）· 主责：C · 总协调：[G3/P3 #37](https://github.com/paher-din/XunJie/issues/37)

建立日期：2026-10-12（Asia/Shanghai）· 状态：服务端实现与确定性验证已完成并以 [PR #47](https://github.com/paher-din/XunJie/pull/47) 交付审查，实际代码位置、命令、结果、失败与未执行项见第 8 节；第 3 节的合成库 schema 追加与第 6 节四项解释与跨属提案已于 2026-10-12 经项目负责人批准，批准范围与落地含义见第 6 节的批准记录；同日负责人进一步授权基线汇总，已由本任务完成，实际只改 TECH_DESIGN 三处，PRD 与 MVP_SPEC 经核对无需改动，详见第 6 节末尾。

## 1. 依据、责任与写入范围

编码前已读正文：[AGENTS](../../AGENTS.md) 的文档优先、文档写入边界、学生操作与证据边界、红线各节；[README](../../README.md) 的当前进度、开发 Agent 边界与阶段状态记录；[PRD](../product/PRD.md) 第 3.2、4.3、5、8 节（PRD-03/07/08/09/10）；[MVP_SPEC](../product/MVP_SPEC.md) 第 1.3、3（M-03/M-07/M-09）、4、6（AC-06/08/09/12）、9 节；[TECH_DESIGN](../product/TECH_DESIGN.md) 第 4、4.1、4.3、5、5.1、7.1、7.2.1、7.4、7.5、8.3、8.4 节；[TEAM §7 C4 与 §10.1](../planning/TEAM_WORK_PLAN.md) 的依赖与个人顺序；[DL-0](DL-0_DIGITAL_LOGIC_ADDON.md) 已批范围与待评审事项。上游 C 属交付按 [C2](C2_WORKSPACE_JOBS.md)、[C3](C3_TEACHING_MESSAGES_RECEIPTS.md) 正文核对实际接缝。

本任务负责 C 属的提交、重开与恢复领域契约、存储、命令、读取投影与测试。A 属的授权、教师决定、正式反馈与许可路由由 A4/A5 实现，B 属的教学分析归 B。本任务不改变共享字段、状态、错误码、权限、版本或事务语义；需要的跨属差异在第 6 节列为提案，未确认前不按提案实现。

预计可写文件：本任务稿；`apps/teaching/contracts/workspace/index.ts`；`apps/teaching/server/workspace/` 下的 `schema.ts`、`inputs.ts`、`submissions.ts`（新增）、`controls.ts`、`commands.ts`、`storage.ts`、`application.ts`、`test-support.ts`、`integration.test.ts`、`submissions.test.ts`（新增）；[README](../../README.md) 的阶段状态记录追加一段。只读文件：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、他人任务稿、`apps/teaching/server/app|access|db|design|review|tutoring/**`、`apps/teaching/contracts/access|common|design|tutoring|runner/**`、`apps/teaching/runner/**`、`package.json`、`package-lock.json`、`tsconfig*.json`。

## 2. 现有实现与实际缺口

2026-10-12 在 `origin/main` 37849f4 上核对代码，不是按文件名或摘要推断。

已具备且可直接复用：`Attempt` 的五状态枚举含 `submitted`/`reviewed`（`contracts/workspace/index.ts`、`server/db/records-adapter.ts` 的持久化校验），但没有任何生产代码把尝试推进到这两个状态；`server/access/resource.ts` 的 `assertResourceUse` 已使学生在 `submitted`/`reviewed` 阶段的 `write`/`student_help` 用途返回 `STATE_CONFLICT`，`server/workspace/commands.ts` 的 `snapshotCommand` 与 `files.ts` 的 `syncFiles` 也已按同一阶段拒绝写入，即「未获许可且未主动重开前作品只读」的边界已由既有代码成立。`controlAttempt` 支持 `start`/`pause`/`resume`/`capture`/`reminders`/`position`，`returnPosition`、`route`、`question` 已完整实现并覆盖持久性测试。`recoveryGeneration` 与 `RECOVERY_REQUIRED` 已在全部命令路由、`recordCommandState`、作业租约与 `runner/control.ts` 落实；事件页 `readPage` 已有 `resyncRequired` 与 `control` 块。`finishRecordCommand`/`resolveCommandReceipt`/`requestHash` 提供同键同摘要返原结果、异摘要 409 的幂等语义。运行事实、可信检查阶段与产物引用由 `workspace_runs` 保存，`reconcileRun`/`markRunUnknown`/`confirmNodeCancellation`/`confirmNodeFailure` 已区分确认、未知与迟到结果。

实际缺口：没有固定提交对象、存储或命令；`POST /api/attempts/:id/submissions` 未实现；`ReopenGrant`、`grantReopen`、`transitionAttempt`、`resume_revision` 在整个仓库没有任何出现（`reopen` 的命中全部是测试夹具的数据库重开助手与证据文本）；没有恢复读取入口汇总活动版本、确认作品、最近运行、待处理问题、返回位置与有效反馈。TECH §5 的 `POST /api/attempts/:id/reopen` 与 `POST /api/attempts/:id/feedback` 也未实现，其中 `feedback` 仅作为 A0 契约检查的预期路由出现在 `tools/a0-review/check.mjs`。

## 3. 数据方案与数据库操作范围

延续 C2/C3 已批准的做法：只在临时目录新建合成数据库，不迁移既有库，不做真实存储操作。新增两张 C 属表，写入 C 属的 `apps/teaching/server/workspace/schema.ts`，由既有 `workspaceSchema` 字符串承载。

这样安排的直接理由是不触碰 A 属文件：`server/db/transaction.ts` 的 `createFreshDatabase` 已对 `workspace`、`teacher-design`、`teaching` 三种工厂执行 `workspaceSchema`，把新表放进该字符串即可让 C4 的测试夹具与 C3 的教学夹具同时具备提交与许可存储，而 `createFreshDatabase`、`validateSyntheticFile` 与工厂函数保持零改动。C3 当时在 A 属文件新增了 `teaching` 种类与工厂；C4 不需要重复该跨属改动。

`workspace_submissions` 保存 `submission_id` 主键、`attempt_id`/`course_id`/`student_id`/`snapshot_id` 外键、`workspace_revision`、`attempt_revision`、`receipt_id` 外键、`server_seq` 外键、`recovery_generation`、`submitted_at_ms` 与经 `json_valid` 约束的 `submission_json`，并按 `(attempt_id,server_seq)` 建索引以取得提交顺序。`workspace_reopen_grants` 保存 `grant_id` 主键、`attempt_id`/`submission_id`/`granted_by`/`consumed_receipt_id` 外键、`state` 限于 `valid`/`consumed`/`superseded`、`attempt_revision`、`reason`、`granted_at_ms`、`consumed_at_ms` 与 `grant_json`，并用 CHECK 约束把「已消费」与「存在消费回执」绑成同一事实，避免只改状态不留痕迹。

运行时仍受 `server/db/transaction.ts` 的语句白名单约束，只有 SELECT/INSERT/UPDATE，没有 DELETE，因此提交与许可一律追加或就地改状态列，不删除历史行。真实数据库建表、迁移与备份恢复操作不在本任务范围，按 [TECH §10.1](../product/TECH_DESIGN.md#101-sqlite-基线) 与红线另行授权，完整备份恢复由 [C5](../planning/TEAM_WORK_PLAN.md) 按声明的 RPO/RTO 验证。

受影响的既有断言：`server/workspace/integration.test.ts` 对合成工作区库的表数断言由 22 改为 24。该文件属 C，改动只反映本任务新增的两张表，不放宽任何既有检查。

## 4. 接口与领域契约

### 4.1 学生固定提交

`POST /api/attempts/:id/submissions`，发起者为所属学生，沿用 TECH §5 的已批准行为：`ready`/`active` 且分配 `active`，携带 `recoveryGeneration`、`expectedAttemptRevision`、确认 `snapshotId`、可选短反思与匹配可信检查引用，阶段变化与相应用途教学失效在同一短事务完成，不要求作品必须答对才能提交。

请求体经 `submissionInput` 严格校验，只接受 `recoveryGeneration`、`expectedAttemptRevision`、`snapshotId`、`reflection`、`checkRefs`；`reflection` 为不超过 4096 字符的可选文本并按 `validateText` 拒绝孤立代理对；`checkRefs` 为不超过 16 项的 `runId` 数组。领域层再核：命令身份与尝试的学生、课程、分配一致；`expectedAttemptRevision` 与当前值相等，否则 `VERSION_CONFLICT`；分配未暂停，否则 `STATE_CONFLICT`，分配暂停不能被个人提交绕过；`snapshotId` 必须是本尝试、本活动版本下已确认的快照，否则 `INVALID_REFERENCE`；每个检查引用必须指向本尝试的真实运行、其模式为课程检查、且绑定的快照正是本次提交的快照，否则 `INVALID_REFERENCE`。检查结论按运行事实原样记录，`verdict` 为失败或不完整同样接受提交，这直接落实「不要求作品必须答对」。

提交成功后尝试进入 `submitted`，`attemptRevision` 相对持久值恰好加一以满足 `saveAttempt` 的比较写，`decisionEpoch` 加一，并按用途取消 `student_help`/`reminder`/`explicit_analysis`/`passive_analysis`；取消经 C3 的 `teachingStop` 在同一事务持久化停止意图并把尚未展示的动作标为失效。普通运行作业不在此取消：其事实与原始引用必须保留，且 `beginExplicitOperation` 已使 `submitted` 阶段不能再发起新运行，在途运行继续按原有对账路径得到确认、未知或失败结论。该取舍在第 6 节列为需要 A5/C5 复核的解释项。

幂等沿用既有语义：同账号、同命令、同目标、同 `Idempotency-Key` 且请求摘要相同返回原提交与原回执并标 `replayed`；摘要不同返回 `IDEMPOTENCY_CONFLICT`；`recoveryGeneration` 过期返回 `RECOVERY_REQUIRED`。旧提交、旧作品快照、旧运行与旧检查引用一律不改写，新提交只追加新行。

### 4.2 教师许可与学生主动重开

C 提供两个同连接、同事务的能力供 A5 调用，与 [TECH §7.2.1](../product/TECH_DESIGN.md#721-模块事务与候选接纳) 列出的 `transitionAttempt/grantReopen` 对应：`transitionAttemptInTransaction` 把 `submitted` 推进到 `reviewed`，供 A5 的正式反馈在同一短事务内改变阶段；`grantReopenInTransaction` 在最新提交上保存 `ReopenGrant`。两者都核 `expectedAttemptRevision`，都在成功后把 `attemptRevision` 加一，都不删除或改写既有提交。保存许可后尝试仍是 `reviewed`，作品保持只读，这与 TECH §5 的 `POST /api/attempts/:id/reopen` 行为一致。许可只允许落在最新提交上：落在旧提交返回 `INVALID_REFERENCE`，同一提交上的新许可把旧许可标为 `superseded` 而不是删除。

学生侧新增 `resume_revision` 控制，经既有 `POST /api/attempts/:id/controls` 提交。领域层核：尝试处于 `reviewed`；`expectedAttemptRevision` 与当前值相等；分配未暂停，分配暂停覆盖个人恢复；存在状态为 `valid` 的许可，且该许可指向最新提交、其记录的 `attemptRevision` 等于当前值。全部通过后尝试回到 `active`，`attemptRevision` 加一，`decisionEpoch` 加一并按用途取消复核前的教学动作，许可就地改为 `consumed` 并记下消费该许可的命令回执与时间。系统不自动替学生继续：没有许可、许可已被消费或已被取代、许可指向旧提交、许可版本过期都拒绝，且不会自行改变学习阶段。

`resume_revision` 在 `reviewed` 阶段发起，而 `assertResourceUse` 对该阶段的 `write` 用途返回 `STATE_CONFLICT`，因此该控制经资源门的 `read` 用途授权，再由 C 的阶段与许可规则做精确判定。`read` 用途仍然强制课程一致与 `studentId` 等于当前账号，教师账号发起时由 `guardCommand` 的 `actorId` 比较返回 `FORBIDDEN`，学生归属没有被放宽。该做法沿用 C3 的既有先例：`acceptStudentQuestion` 先以 `read` 授权，再在事务内 `assertResourceUse` 精确用途。A 属的 `contracts/access` 与 `server/access/resource.ts` 零改动，是否需要为 `resume_revision` 增设专用用途在第 6 节列为提案。

### 4.3 闭环恢复读取

`GET /api/attempts/:id/recovery`，发起者为所属学生或任课教师，按角色裁剪。该入口只读，不激活学习、不排模型或运行作业、不改变阶段，符合 [TECH §5.1](../product/TECH_DESIGN.md#51-请求摘要响应与拒绝) 对读接口的要求。查询参数可带客户端持有的 `recoveryGeneration` 与 `decisionEpoch`；缺失或不等于服务端当前值时返回 `resyncRequired` 为真，客户端必须先重新同步再展示待投递内容。

返回内容覆盖 M-09 的恢复要求：活动版本与尝试的完整生命周期字段，含 `returnPosition`、`route`、`question`；确认作品的文件实例、路径、版本、内容哈希与生命周期，使服务器已确认版本与本机未同步草稿可区分；提交列表与其快照、哈希、检查引用和最新提交标识；重开许可状态；最近运行的运行标识、作业标识、模式、绑定快照、作业状态与结论分类；待处理问题；采集覆盖区间与缺口。

结论分类严格区分确认与未知：作业成功且运行已有结果哈希为 `confirmed`，作业成功但结果缺失为 `incomplete`，`outcome_unknown` 原样报 `unknown`，其余按 `failed`、`cancelled`、`in_flight`、`stale`、`timed_out` 表达。未知一律不折叠成成功，也不触发重跑或重复提交。

有效反馈归 A5。C4 只提供一个可挂载的读取接缝，未挂载时如实返回 `status` 为 `unavailable`，不用哈希、摘要或提交记录补造反馈正文。该做法沿用 C3 的先例：未挂载教学接缝的工作区不会谎报自己没做过的动作失效。

## 5. 与 A4/A5/B3/C5 的分批交接

按 [TEAM §7 的 P3 联调顺序](../planning/TEAM_WORK_PLAN.md)，C4 先交固定提交、许可消费与恢复读取，不等 A4/A5 整项完成。C4 交给 A5 的首批能力是 `transitionAttemptInTransaction`、`grantReopenInTransaction` 与恢复读取中的提交、许可、反馈接缝；A5 的 `POST /api/attempts/:id/reopen` 与 `POST /api/attempts/:id/feedback` 在自己的教师授权事务中调用这两个能力，双方按本节契约各自实现后再联合验证。A4 的教师纠正与状态失效经 C3 已交付的 `teachingStop` 与 `cancelByPurpose` 传播，C4 不新增失效通道，也不改写已有普通运行事实与历史引用。B3 的候选分析只读 C 保存的原始引用与覆盖区间，C4 的提交记录为其提供确切快照与检查引用。

交 C5 的未验项：完整备份恢复与实际 RPO/RTO、真实执行节点掉线与重启后的对账演练、真实负载下的保存与运行表现、以及本任务在第 6 节列出的解释项复核。上述项在本任务全部标为未执行，不以合成夹具的通过数替代。

## 6. 待确认的解释项与跨属提案

以下事项影响共享契约或产品结果，本任务按既有正文实现并在此记录，未获确认前不作为已批准契约。

第一项，提交时是否取消在途普通运行。issue 正文写「提交、阶段变化与相应用途教学/执行失效同一短事务」，[TECH §7.2.1](../product/TECH_DESIGN.md#721-模块事务与候选接纳) 写「暂停/限定检查/提交控制相应用途和执行」。本任务取消教学类用途，不取消在途 `student_run` 作业，理由是新运行已被阶段规则阻止、取消在途运行会销毁学生已发生的执行事实，而「保留旧提交/作品/运行/检查原始引用」要求这些事实可追溯。需要 A5/C5 复核该解释；若负责人认定提交必须同时终止在途运行，改动限于 `submitArtifact` 的取消用途列表。

第二项，短反思与可信检查引用是否强制。MVP M-07 写「仅对课程明确要求的目标补充短解释、预测或变式检查」，即强制性来自课程要求。当前活动版本契约没有承载「本活动要求反思」或「本活动要求课程检查」的字段，`readActivity` 返回的帮助政策、检查规则与运行配置都不含该语义。本任务校验两者的形状、边界与引用匹配，不把缺省当作违规；把强制性变成活动配置需要 A 属新增活动版本字段，属共享契约变更，列为对 A5/A6 的提案。

第三项，`resume_revision` 是否需要专用资源用途。本任务用 `read` 授权加 C 属阶段规则实现，A 属权限文件零改动。若负责人希望该命令在权限层显式可辨，需要在 `contracts/access` 的 `ResourceUse` 与 `assertResourceUse` 增列用途，属 A 属共享契约变更，本任务不自行实施。

第四项，`transitionAttemptInTransaction` 与 `grantReopenInTransaction` 的准确签名需要在 A5 开工时与 A 对齐。本任务按 C3 的 `*InTransaction` 约定给出同步、可在调用方事务内失败的形状，A5 若需要不同的参数编排，改动限于这两个函数与其测试。

2026-10-12，项目负责人在 C4 交付说明上明确批准两件事：第 3 节的合成库 schema 追加，以及本节四项解释与跨属提案。上文四项原文逐字保留，以下只追加批准事实与落地含义，不倒写原判断。批准范围按本节与第 3 节原文字面理解，只对该范围有效，不延伸到未列出的文件、任务或后续操作。

schema 追加据此收口：`workspace_submissions` 与 `workspace_reopen_grants` 两张表保留在 C 属 `apps/teaching/server/workspace/schema.ts` 的 `workspaceSchema` 字符串中，A 属 `server/db/transaction.ts` 的 `createFreshDatabase` 与工厂函数保持零改动，`integration.test.ts` 的表数断言 24 为已批准事实。该批准只覆盖合成库 DDL 追加，不覆盖真实数据库建表、迁移、备份恢复或生产部署，这些仍按红线与 [TECH §10.1](../product/TECH_DESIGN.md#101-sqlite-基线) 另行授权，完整备份恢复仍由 C5 验证。

第一项据此收口：提交只取消教学类用途（`student_help`、`reminder`、`explicit_analysis`、`passive_analysis`），不取消在途 `student_run` 作业，已实现的执行事实与其原始引用一律保留。原文写的「改动限于 `submitArtifact` 的取消用途列表」是笔误，仓库中没有该名称的函数；实际承载该决定的是 `server/workspace/submissions.ts:24` 的 `revisionCancelPurposes` 常量，由 `planSubmission` 与 `planResumeRevision` 一并返回，`submitCommand` 经 `stopJobs` 消费。若将来要改变该解释，改动限于这一个常量与其测试。

第二项据此收口：短反思与可信检查引用在 C4 不强制，两者只校验形状、边界与引用匹配，缺省不视为违规。**本批准不构成对 A 属新增活动版本字段的授权。** 原文列为对 A5/A6 的提案的部分——把强制性变成活动配置——仍只是提案；实施它需要在 A 属 `contracts/design` 与固定活动版本契约增列字段，属共享契约变更，必须由负责人另行明确文件与改动范围后才能动手，C4 不据此改任何 A 属文件。

第三项据此收口：`resume_revision` 保持 `read` 用途授权加 C 属阶段、分配与许可守卫的实现，A 属 `contracts/access` 的 `ResourceUse` 与 `assertResourceUse` 不增列用途，权限文件零改动。批准的是已实现的读法，不是新增权限用途。

第四项据此收口：`transitionAttemptInTransaction`、`planReopenGrant` 与 `writeReopenGrant` 的现有签名即为交 A5 的契约形状，A5 可直接按第 5 节的接缝接入；若 A5 需要不同的参数编排，按第 5 节协调，改动仍限于这几个函数与其测试。

基线汇总请求（本任务不自行修改产品文档）：第一项是对 [TECH §7.2.1](../product/TECH_DESIGN.md#721-模块事务与候选接纳) 中「暂停/限定检查/提交控制相应用途和执行」的读法，第二项是对 [MVP_SPEC](../product/MVP_SPEC.md) M-07 强制性来源的读法，第三项是对 [TECH §4.3](../product/TECH_DESIGN.md#43-公共身份版本与结果信封) 中 `ActorContext/authorizedScope` 授权用途一行在 `resume_revision` 上的读法。若负责人认为这三条读法需要写回产品基线，请授权维护者按 PRD → MVP_SPEC → TECH_DESIGN 顺序汇总，并同步受影响的验收；本任务稿的批准记录不自动取代产品基线，在汇总完成前状态为待授权维护者汇总。

本批准不改变第 8.6 节列出的任何未执行项，也不构成浏览器验收、真人师生验收、真实模型语义验收、真实执行节点对账或完整 G3 与产品验收的通过。

2026-10-12，项目负责人进一步授权本任务执行上述基线汇总，本任务据此以获授权维护者身份改动 `docs/product/**`。授权范围限于这三条读法，不延伸到产品文档的其他内容、其他任务或后续操作。

实际核对结果：[PRD](../product/PRD.md) 无需改动，三条读法都不改变产品结果；[MVP_SPEC](../product/MVP_SPEC.md) 无需改动，M-07 原文「仅对课程明确要求的目标补充短解释、预测或变式检查」本身已经就是第二项的读法，强制性来源没有变化，缺的是技术侧的活动版本字段而不是产品要求。因此改动只落在 [TECH_DESIGN](../product/TECH_DESIGN.md) 三处：第 5 节 controls 行补 `resume_revision` 的授权用途读法（第三项）；第 5 节 submissions 行补说明与检查引用的校验范围及活动版本字段缺口（第二项）；第 7.2.1 节「失效按用途」一段把原文「暂停/限定检查/提交控制相应用途和执行」拆开，明确暂停含 `student_run`，而提交与学生主动重开只控制教学类用途、不取消在途 `student_run`（第一项）。三处都是在既有行或既有段内追加文字，未改名任何标题、未增删任何路由、未放宽任何验收门槛。`node tools/a0-review/check.mjs` 退出码 0、`errors` 为空，`baselineMutationRoutes`（27）与 `internalLinks`（578）计数与改动前一致。受影响的验收无需改动：AC-06/08/09/12 的判据未变，C4 的实现与测试已按这三条读法验证通过。

另有一条 C4 验证中确认的行为**未**写入基线：分配暂停会加一 `attemptRevision` 与 `decisionEpoch`，因此使已发放的重开许可失效，且恢复分配不会让它复活。它不属于上述三条读法，超出本次授权范围，故只保留在第 8.5 节与 PR 正文作为交 A5/UI 的事实。若负责人认为它也需要写回 TECH 第 5 节的 reopen 行或第 7.2.1 节，请另行明确文件与范围。

基线改动后的文档验证补记：除 `node tools/a0-review/check.mjs` 外，README「文档验证」一节还要求单独运行 `node --test tools/a0-review/check.test.mjs`，该测试不在 `apps/teaching` 的 `npm test` glob 内，容易被漏跑。它在基线改动后 16 项全部通过、0 失败、0 跳过，其中「current repository passes structural checks」「existing repository directory links remain valid」「rejects missing approved route …」等用例直接依赖 `docs/product/**` 正文，因此这三处追加没有破坏文档检查器的任何断言。加入本任务稿与 README 的追加段落后，`check.mjs` 复跑退出码 0、`errors` 为空、`internalLinks` 为 585、`baselineMutationRoutes` 仍为 27、`additionalProposedRoutes` 仍为空数组。基线改动只涉及文档，未触碰任何源码，故 `npm run typecheck`、`npm test` 与第 8.3 节的全部通过统计不受影响，无需重跑。

## 7. 验证计划与分层完成条件

服务端确定性验证在本任务完成，使用隔离合成数据，不进入真实学生学习记录，不恢复 Round 0。实际 UI、真人教师与学生、真实模型语义、真实执行节点与完整备份恢复分别报告，本任务全部标未执行。

覆盖 AC-06：同键同摘要重放返回原提交与原回执，同键异摘要返回 `IDEMPOTENCY_CONFLICT`，`recoveryGeneration` 过期返回 `RECOVERY_REQUIRED`，重复提交不产生第二个提交行。覆盖 AC-08：`expectedAttemptRevision` 过期、许可指向旧提交、许可已消费或已取代、分配暂停、教师账号发起学生控制、跨课程与跨学生访问均被拒绝；提交与复核并发时旧动作不能恢复过期状态；在途作业迟到完成不改写已固定的提交引用。覆盖 AC-09：提交、教师许可、学生主动重开、修订后再次提交形成的链条中旧提交与旧快照原样保留，新提交绑定新快照。覆盖 AC-12：应用重启后提交、许可与恢复视图完整，执行器掉线的运行报 `unknown` 且不当成功，恢复读取不重复副作用、不切换学习阶段。

## 8. 实现记录

2026-10-12 在独立工作树 `codex/c4-submissions-recovery`（基线 `origin/main` 37849f4）完成实现与服务端验证，提交为 `7063fd2`，已普通推送并以 [PR #47](https://github.com/paher-din/XunJie/pull/47) 交付审查，尚未合并，[#43](https://github.com/paher-din/XunJie/issues/43) 保持 Open。合并由负责人执行，本任务不代签、不自行合并，也不把建立 PR 当作应用验收。主工作树的既有未提交改动与未跟踪文件全程未被触碰，本任务不使用个人目录作为文档、源码或证据入口。

### 8.1 实际代码位置

契约层 `apps/teaching/contracts/workspace/index.ts` 第 27～59 行新增 `SubmissionCheckRef`、`Submission`、`ReopenGrantState`、`ReopenGrant`、`RecoveryRunOutcome`、`RecoveryRun`、`RecoveryFeedback`、`AttemptRecovery`，只追加，不改写既有类型。

领域层新增 `apps/teaching/server/workspace/submissions.ts`（233 行）：`latestSubmission`、`reopenView` 为纯投影；`planSubmission`、`planResumeRevision` 为纯计划，只读 `SubmissionBasis` 切片，不接触事务、回执或 HTTP 请求；`readSubmissions`、`readGrants` 从持久化行还原并逐字段核对归属，任何不一致抛错而不是宽容读取；`transitionAttemptInTransaction`、`planReopenGrant`、`writeReopenGrant`、`grantReopenInTransaction` 是交 A5 的同步事务接缝。`planReopenGrant` 与 `writeReopenGrant` 拆开的原因是许可行的外键指向授权它的命令回执，而 `finishRecordCommand` 的 work 回调执行时该回执行尚不存在，因此计划与落盘分处 work 与 afterCommit，沿用 C3 教学问题与作业的同一做法。

命令层 `apps/teaching/server/workspace/commands.ts`：第 82～97 行 `submitCommand` 按 guardCommand → requestHash → resolveCommandReceipt 重放 → planSubmission → stopJobs → completeCommand 的顺序组织，事件类型 `submission_confirmed`；第 104～114 行 `controlCommand` 新增 `resume_revision` 分支；第 266～315 行 `recoveryOutcome`、`readRecovery`、`receiptSequence`、`latestSnapshot` 组成只读恢复投影。`WorkspaceState` 增加 `submissions` 与 `grants` 两个数组。

存储层 `apps/teaching/server/workspace/storage.ts`：第 67 行 `loadWorkspace` 载入两类新记录，并在运行循环之后交叉核对每个提交指向的快照确实存在、每个 `checkRefs` 指向同快照的真实 `check` 运行且结果哈希一致、每个许可指向真实提交；第 147 行起追加提交 INSERT（排在回执与审计事件写入之后，以取得 `server_seq`）；第 164 行起的许可消费 UPDATE 带前向 CAS，旧状态不是 `valid`、新状态不是 `consumed`、或任一不可变字段被改动都返回 `IDEMPOTENCY_CONFLICT`，且 `changes !== 1` 同样拒绝。

路由层 `apps/teaching/server/workspace/application.ts`：第 137 行 `POST /api/attempts/:id/submissions`；第 289 行 `GET /api/attempts/:id/recovery`；第 299～304 行 `recovery` 接缝（`readFeedback` 未挂载时如实返回 `status` 为 `unavailable`）；第 305～368 行 `reopen` 接缝（`markReviewed`、`grant` 两个教师能力，各自返回带 `replayed` 的回执，C4 不为二者发布任何替代产品路由）。`execute` 增加尾参 `use`，默认 `write`，只有 `resume_revision` 传 `read`。

输入层 `apps/teaching/server/workspace/inputs.ts` 新增 `artifactSubmissionInput`、`reopenGrantInput`、`reviewTransitionInput`、`recoveryQuery` 及对应持久化 schema 与领域转换；`control` 联合增加 `resume_revision` 字面量，`controls.ts` 的 `Control` 类型同步。测试支撑 `test-support.ts` 增加两个模拟 A5 教师路由与 `submit`、`markReviewed`、`grantReopen`、`resumeRevision`、`recovery`、`reviewed` 助手。

新增 `apps/teaching/server/workspace/submissions.test.ts`（672 行，C4-V01～C4-V10）。既有测试的最小同步改动：`integration.test.ts` 合成库表数断言 22 → 24，`workspace.test.ts` 与 `runs.test.ts` 的 `WorkspaceState` 字面量补 `submissions:[]`、`grants:[]`。

### 8.2 归属边界事实

`git diff --stat` 显示改动 11 个文件、新增 3 个文件，全部落在 C 属的 `apps/teaching/contracts/workspace/**` 与 `apps/teaching/server/workspace/**`。A 属（`server/app|access|db|design|review`、`contracts/common|access|design`）与 B 属（`server/tutoring`、`contracts/tutoring`）零改动，`docs/product/**`、`AGENTS.md`、`docs/planning/**`、`docs/reference/**`、他人任务稿、`package.json`、`package-lock.json`、`tsconfig*.json` 零改动。第 3 节说明的两张新表写进 C 属的 `workspaceSchema` 字符串，因此没有像 C3 那样在 A 属 `server/db/transaction.ts` 新增工厂种类；该改动是合成库 DDL 追加，无迁移、无真实数据库操作，按红线仍在此明示并报负责人复核。

### 8.3 验证命令与结果

运行目录 `apps/teaching`，Node v24.21.0，win32 x64，`node_modules` 由既有工作树复制，依赖清单与 tsconfig 未改。

`npm run typecheck` 通过，退出码 0。`npm test` 先执行 `npm run build`，构建通过；随后 274 项测试：264 通过、1 失败、9 跳过。`node --test server/records/*.test.ts server/workspace/*.test.ts` 单独运行 C 属模块：63 项，60 通过、1 失败、2 跳过。`node --test server/workspace/submissions.test.ts`：10 项全部通过。

同一命令在基线 37849f4 的独立临时工作树上实测：264 项，254 通过、1 失败、9 跳过；C 属模块基线为 53 项，50 通过、1 失败、2 跳过。即 C4 净增 10 项测试与 10 项通过，失败数与跳过数不变。

唯一失败项在两侧完全相同：`server/workspace/review.test.ts:118` 经 `runner/control.ts:48` 抛 `RunnerError: Linux and trusted control context required`（`INVALID_CONFIGURATION`）。C4 未修改这两个文件，该失败是 win32 平台的既有基线失败，不是本任务引入。9 项跳过全部来自既有的平台与环境门（如 `runs.test.ts` 中 `skip:process.platform!=='linux'||process.env.XUNJIE_C2_RUNTIME!=='1'` 的真实 C1 SSH 用例），C4 新增测试文件不含任何 `skip`。

按 README 编辑规范，改动 README 与本任务稿后从仓库根执行 `node tools/a0-review/check.mjs`，退出码 0，`errors` 为空数组，校验覆盖 38 份文档与 571 条行内引用；输出中的 `additionalProposedRoutes` 为空，说明本任务使用的 `POST /api/attempts/:id/submissions` 与 `GET /api/attempts/:id/recovery` 都在已批准路由集合内，没有引入未批准的新增路由提案。基线核对用的临时工作树与 `node_modules` 目录联接已在测量后删除，删除前先移除联接再删目录，复制来的真实 `node_modules` 经核对完整保留。

### 8.4 验证中发现并修正的实际缺陷

第一处，提交重放被误判为状态冲突。学生提交成功后尝试阶段已变为 `submitted`，A 属 `assertResourceUse` 在幂等重放解析之前就先拒绝学生的 `write` 用途，导致同键同摘要的重试返回 409 `STATE_CONFLICT` 而不是原提交与原回执，直接违反 AC-06「重试返原提交/回执」。修正限于 C 属 `application.ts`：提交路由先做一次只读预检，在 `read` 用途下解析已提交回执并原样返回，未命中才进入写入通道，与既有 `run.create` 路由的做法一致。A 属权限文件零改动。

第二处，恢复视图把不可执行的许可报成可执行。`reopenView` 原先只要存在 `valid` 许可就报 `state:'valid'`，但 `planResumeRevision` 还要求该许可指向最新提交且 `attemptRevision` 等于当前值；两者不一致时客户端会看到「可以继续修订」而实际命令必被拒绝。修正为只有真正可被消费的许可才报 `valid`，其余按已消费、已取代的历史事实报告。

### 8.5 验证中确认的跨属交互事实

第一，已完成的教学作业自身已带 `stopRequested:true`，因此 `cancelByPurpose` 会跳过它：提交的 `cancelledJobIds` 只列真正未结的作业，已结作业的事实一个字段都不被改写。C4-V08 用 `assert.deepEqual` 对比提交前后的整条作业记录来固定该行为，而不是只比对状态列。

第二，A 属 `invalidateAssignment`（`server/design/activities.ts:142`）在分配暂停时把每个尝试的 `attemptRevision` 与 `decisionEpoch` 各加一，而恢复分配不加。因此暂停会使此前发出的重开许可失效，且恢复分配不会让它复活，教师必须在当前版本上重新发放。C4-V07 固定了这条链条：暂停前发放的许可在暂停后与恢复后都返回 `STATE_CONFLICT`，许可行保持 `valid` 未被静默消费，重新发放后才可由学生本人消费。A5 与 UI 需要按此事实设计教师重开发放与失效提示。

第三，C3 的学生受众规则使未展示的教学动作对学生不可见，因此提交后学生侧读取返回空动作列表，教师侧才看到那条已失效记录及其非 `pending` 的处置。C4-V08 分别用两个受众断言，不把「学生看不到」误写成「动作已删除」。

第四，`resume_revision` 在阶段 `reviewed` 上必须绕过 A 属对学生 `write` 用途的拒绝。本任务用 `read` 用途授权（仍然强制课程成员身份与尝试归属），再由 C 属的阶段、分配与许可守卫决定，`guardCommand` 的 `actorId` 比对拒绝教师账号发起该学生控制。这是第 6 节第三项提案的实际实现方式，A 属 `contracts/access` 与 `assertResourceUse` 未改。

第五，恢复投影与工作区视图对短反思的暴露程度不同，A5 需要按此取用。`GET /api/attempts/:id/recovery` 只报 `hasReflection` 布尔值，不返回反思正文，因为恢复视图的职责是让客户端判断自己是否需要同步，不是承载评阅材料；学生本人的短反思正文由既有 `GET /api/attempts/:id` 的 `submissions[].reflection` 提供，课程教师同样可读。C4-V05 用两条断言分别固定：恢复响应中不存在 `reflection` 字段，教师读取工作区视图得到与提交时逐字相同的反思正文。A5 的正式反馈与评阅界面应从后者取正文，不用哈希或摘要反推。

### 8.6 未执行项

以下各项本任务全部标未执行，不以合成夹具通过数替代：真实浏览器与 UI 接入验收；真人教师与学生的实际使用与教学收益；真实模型语义与预算门禁；真实执行节点掉线、重启与迟到结果的对账演练（C2 的真实 SSH 用例在 win32 上跳过）；完整备份恢复与实际 RPO/RTO（交 C5）；真实数据库建表、迁移与生产部署（按红线另行授权）；A4/A5 实际路由接入后的联合验证（本任务只用 `test-support.ts` 中模拟 A5 的教师路由验证接缝）。

2026-10-12，第 3 节的合成库 schema 追加与第 6 节四项解释与跨属提案已经项目负责人批准，批准范围与逐项落地含义见第 6 节的批准记录。该批准不改变上述任何未执行项，上述分层验收仍全部未执行；批准也不构成对 A 属新增活动版本字段或新增权限用途的授权，那两部分仍只是提案。
