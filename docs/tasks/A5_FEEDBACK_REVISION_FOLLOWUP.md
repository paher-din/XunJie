# A5：教师反馈、个人修订与后续活动

日期：2026-10-14（Asia/Shanghai）。主责：A；对应 [Issue #42](https://github.com/paher-din/XunJie/issues/42) 相邻的 A 属切片由本文承载，[TEAM §A5](../planning/TEAM_WORK_PLAN.md#a5教师反馈个人修订与后续活动) 与 [A_WORK_PLAN §10](../planning/A_WORK_PLAN.md) 为范围依据。

状态：2026-10-14 负责人批准 §3～§6 并完成 A5 第一批（A5.1～A5.3）的服务端实现、11 项专项与完整回归，另经独立两轴代码审查并修正其发现（见 §8.1～§8.5）；A5.4/A5.5 仍为第二批，未实现。真实模型、真实执行节点、浏览器/UI 与真人验收未执行；本文不代替完整产品验收。§1 中原「提案、尚未获批准」的时点记录保留在 §8.1 之前，本节为其后的当前状态。

## 1. 依据、范围与写集

已读正文：[AGENTS](../../AGENTS.md) 全文（文档优先、文档写入边界、共享契约先提案、学生操作与证据边界、红线）；[README](../../README.md) 全文；[PRD](../product/PRD.md) 第 4.3、5、8 节（PRD-06/07/08/09/10）；[MVP_SPEC](../product/MVP_SPEC.md) M-07/M-08/M-09、AC-08/09/16、第 4 节状态与操作规则、第 10 节；[TECH_DESIGN](../product/TECH_DESIGN.md) 第 4/4.2/4.3/4.4/5/5.1/7.1/7.2.1/7.3 节；[TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) §A5 与 P3 联调顺序；[A_WORK_PLAN](../planning/A_WORK_PLAN.md) §10/§12/§13；上游已交付接缝按 [A4](A4_LEARNER_STATE_REVIEW.md) §9/§11、[C4](C4_SUBMISSIONS_REOPEN_RECOVERY.md) §4/§5/§8、[A0 契约复核](A0_BUSINESS_CONTRACT_REVIEW.md) READ-11/READ-14 正文核对。

本任务负责 A 属的正式反馈契约、存储、命令、读取投影与测试，以及 A5.4/A5.5 的业务链接通。学习主张纠正与有效状态仍归 A4；作品、提交、许可与恢复归 C；候选分析与反馈草稿归 B。本任务不改写 A4 的状态语义、C4 的提交/许可语义或 B 的模型格式；需要的跨属差异在 §6 列为提案，未确认前不按提案实现。

| 预计可写 | 必要改动 |
| --- | --- |
| 本文、[README](../../README.md) | 本人任务依据、方案、验证与交接；任务导航与调用/验证入口 |
| `apps/teaching/contracts/review/index.ts` | 追加正式反馈输入、反馈记录/视图、审阅上下文与许可输入类型；不改既有类型 |
| `apps/teaching/server/review/feedback.ts`（新） | 反馈追加版本、CAS、复核阶段迁移、许可同事务编排、反馈目标解析器与审阅上下文聚合 |
| `apps/teaching/server/review/application.ts` | 实现 `POST/GET /api/attempts/:id/feedback`、`POST /api/attempts/:id/reopen`、`GET /api/attempts/:id/review-context`；装配 `feedbackTarget` 与本域反馈读取 |
| `apps/teaching/server/db/review-schema.ts` | 新增 1 张 A 属反馈修订表（见 §3） |
| `apps/teaching/server/db/transaction.ts` | `createReviewDatabase` 的精确表集合守卫 33 → 34，并按同一 fail-closed 形式登记 |
| `apps/teaching/tests/a5-feedback.test.ts`（新）、`tests/review-support.ts` | A5 公共接缝用例与本批所需夹具助手 |
| `apps/teaching/tests/evidence/a5/` | 实际命令/结果日志与摘要 |
| `apps/teaching/server/workspace/application.ts` | **唯一 C 属触碰（须单独确认）**：给 C4 已声明交 A5 的 `readFeedback` 挂载点补一个可选 option，仍是 2 行以内的加性改动，未提供时保持原 `unavailable` |

只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、他人任务稿；`apps/teaching` 下 B 属（`server/tutoring/**`、`contracts/tutoring/**`）与其他 C 属文件；`apps/student/**`；依赖清单、锁文件、`tsconfig*.json`、凭据/CI。本任务不新建前端界面、不改共享权限用途、不发真实模型请求、不做真实数据库建表/迁移。

## 2. 现有实现与实际缺口

2026-10-14 在 `origin/main`（HEAD 祖先，工作分支 `codex/i0-host-readiness` 为其 +1 提交）上按代码正文核对，不按文件名或摘要推断。已确认 `origin/main` 含 A4（[PR #49](https://github.com/paher-din/XunJie/pull/49) 已合入）与 C4（[PR #47](https://github.com/paher-din/XunJie/pull/47) 已合入）及 33 表合并范围。

**已具备可直接复用：**

- A4 已实现 `learner_context_revisions`、`learner_state_revisions`、`teacher_decisions`、`learner_disputes`、`analysis_results` 五表，`createReviewDatabase()` 以精确 33 表集合 fail-closed 初始化，`readCurrentInTransaction` 供受控读取有效状态。
- A4 在 `server/review/disputes.ts:9` 已定义并消费 `FeedbackTargetResolver`，`application.ts:112` 把它作为 `options.review.feedbackTarget` 传入；**当前没有任何调用方提供该解析器**，因此学生针对 feedback 的异议一律返回 `INVALID_REFERENCE`，这是 A4 §9 明确留给 A5 的接缝。
- C4 已交 `transitionAttemptInTransaction`（`workspace/submissions.ts:190`，`submitted`→`reviewed`，CAS `expectedAttemptRevision`，同事务 `attemptRevision`/`decisionEpoch` 各加一）与 `planReopenGrant`/`writeReopenGrant`（`:201`/`:227`，`reviewed` 阶段、只允许最新提交、旧许可标 `superseded`、发放同时递增两个版本），并在 `workspace/application.ts:348` 以 `markReviewed`/`grant` 两个受信接缝暴露，**C4 明确不为其发布替代产品路由**。
- C4 已在 `workspace/application.ts:336` 定义 `WorkspaceRecoverySurface = { readFeedback }`，默认返回 `{status:'unavailable'}`，注释写明「A5 owns formal feedback」，但该 surface **只能由文件内的常量替换，不能从外部注入**（路由闭包捕获了常量 `recovery`，覆盖返回对象上的属性无效）。
- C4 的提交/许可/恢复读取与 `workspace_submissions`、`workspace_reopen_grants` 两表已就绪；`readWorkspace` 投影含含反思正文的完整 `submissions` 与 `reopen` 视图。
- A2 已实现 `POST /api/courses/:id/blueprints` 的 `mode:'copy'`（`server/design/app.ts:32`、`draft.ts:27`），复制产生 `revision=1` 的新草稿并保存 `source:{courseId,blueprintId,revision}` 来源关联，旧要求不被修改。
- C2 已实现 `POST /api/assignments/:id/attempts`（创建或返回当前尝试），A5.5 的「新尝试」不需要新命令。

**实际缺口：**

1. 没有正式反馈的存储、契约或命令：仓库中 `Feedback` 只作为 `disputes` 的目标类型与 C4 的 `RecoveryFeedback` 投影存在，`POST /api/attempts/:id/feedback` 与 `GET /api/attempts/:id/feedback`（[A0 READ-14](A0_BUSINESS_CONTRACT_REVIEW.md)）完全没有实现，`POST /api/attempts/:id/reopen`（[A0 READ-11](A0_BUSINESS_CONTRACT_REVIEW.md) 相邻的 `POST /api/attempts/:id/reopen`）也没有产品路由——C4 只提供接缝。
2. `GET /api/attempts/:id/review-context`（READ-11）未实现：教师目前只能分别调用 `GET /api/attempts/:id`、`/teaching-records`、`/coverage`、`/learner-state` 拼装，没有把「作品结果」与「三条能力线」分开、并绑定确切提交版本的聚合读取。
3. `TeacherDecision` 与 `Feedback` 在当前持久化中被混在同一张 `teacher_decisions` 表的语义里没有承载点：`decision` 枚举只有 `confirm/correct/defer` 且目标固定为 `claimRef`，无法表达绑定提交的作品评价；A4 §1 已明确要求把「学习主张纠正」与「作品评价/反馈保存」区分开。
4. `feedbackRevision` 只有 [TECH §4.3](../product/TECH_DESIGN.md#43-公共身份版本与结果信封) 的定义，没有任何实现或作用域约定。
5. 学生侧无可读的正式反馈入口，`GET /api/attempts/:id/recovery` 的 `feedback` 恒为 `unavailable`。

## 3. 数据方案与数据库操作范围

按 A4 已批准的做法：只在全新保留的合成库中初始化，不迁移既有库、不做真实存储操作，不删除测试库。新增 **1 张 A 属表**，写入 A 属的 `apps/teaching/server/db/review-schema.ts`，由 `createReviewDatabase()` 承载；精确表集合 33 → **34**。

```sql
CREATE TABLE teacher_feedback (
 feedback_id TEXT NOT NULL, feedback_revision INTEGER NOT NULL CHECK(feedback_revision>0),
 course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 submission_id TEXT NOT NULL REFERENCES workspace_submissions(submission_id),
 teacher_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('formative','submission_review')),
 expected_state_revision INTEGER NOT NULL CHECK(expected_state_revision>=0),
 feedback_json TEXT NOT NULL CHECK(json_valid(feedback_json)), created_at TEXT NOT NULL,
 PRIMARY KEY(feedback_id,feedback_revision));
CREATE INDEX teacher_feedback_scope ON teacher_feedback(course_id,student_id,attempt_id);
```

- **只追加，不改写**：每次修订写新行，`(feedback_id,feedback_revision)` 为主键，旧行与其目标提交版本永久保留，符合 TECH §4.3「追加版本」与 MVP M-08「不覆盖历史」。
- **作用域**：反馈绑定 `course_id/student_id/attempt_id/submission_id` 四个外键，读取与写入都必须先经 A4 同款授权与归属核对，任一层不匹配即抛错而不是宽容读取。
- **`feedbackRevision` 语义（提案，见 §6）**：定义为该 Attempt 范围内已保存的反馈修订条数，未创建为 0，追加单调递增、撤回/修订不重置，与 `contextRevision`/`learnerStateRevision` 的既有约定一致。
- 表内不保存模型草稿正文，不保存凭据或私有验证资产；`json_valid` 只约束结构化 `feedback_json`。
- 表数守卫按 A4 §12 已批准的 fail-closed 形式：初始化前核准精确表名集合，不一致在建库前拒绝；不改成自动跟随其他工厂表数的开放授权。
- 真实数据库建表、迁移与备份恢复不在本任务范围，按 [TECH §10.1](../product/TECH_DESIGN.md#101-sqlite-基线) 与红线另行授权。

## 4. 接口与领域契约（提案）

三条路由全部来自已批准基线：`POST /api/attempts/:id/feedback` 与 `POST /api/attempts/:id/reopen` 已在 [TECH §5 命令表](../product/TECH_DESIGN.md#5-命令权限与外部接口) 内，`GET /api/attempts/:id/feedback`（READ-14）与 `GET /api/attempts/:id/review-context`（READ-11）已在 [A0 读取矩阵](A0_BUSINESS_CONTRACT_REVIEW.md) 内，`/review-context` 亦被 [TECH §5.1](../product/TECH_DESIGN.md#51-请求摘要响应与拒绝) 列为统一读取入口之一。本任务不新增基线外路由、不改任何既有路由语义。

### 4.1 A5.1 教师审阅业务读取

`GET /api/attempts/:id/review-context`，发起者限**任课教师**（学生即使请求也被拒），只读，不激活学习、不排模型/运行。

可选查询参数 `submissionId` 指定要审阅的固定提交，缺省为最新提交；指定的提交不属于本尝试时返回 `INVALID_REFERENCE`。返回内容把三类事实**分开**表达，不合并成单一结论：

| 分组 | 内容 | 来源 |
| --- | --- | --- |
| `attempt` | 状态、`attemptRevision`、`decisionEpoch`、`workspaceRevision`、`captureRevision`、`activityVersionId`、`assignmentId` | C 工作区投影 |
| `submission` | 确切 `submissionId`、`snapshotId`/`snapshotHash`、`workspaceRevision`、`attemptRevision`、`submittedAt`、反思正文、`checkRefs`（只读、不改写） | C4 固定提交 |
| `artifact` | 确认快照的文件实例/路径/`documentVersion`/`contentHash`/生命周期；不含运行诊断正文 | C 工作区投影 |
| `runs` | 运行/检查标识、模式、绑定快照、作业状态与结论分类（`unknown` 不折叠成成功） | C4 恢复投影 |
| `help` | 教学消息/动作与展示回执、覆盖区间与缺口 | C3 读取 |
| `competencies` | 三条能力线（`domain`/`project`/`ai_collaboration`）分组的当前有效主张、`references` 可用性、反证、`unresolved`、帮助条件 | A4 `readCurrentInTransaction` |
| `decisions` | 该尝试的教师决定（确认/纠正/暂缓）与其确切目标版本 | A4 |
| `disputes` | 学生异议及其是否改变当前投影 | A4 |
| `feedback` | 该尝试的正式反馈修订与当前版本 | A5 本任务 |
| `reopen` | 许可自身持久状态与此刻可否被学生消费（`state` + `actionable`） | C4 `ReopenView` |

私有验证资产、其他学生内容与原始模型正文不下发；缺失/撤回/不可见的引用逐项表达 `unavailable`，不补正文。

### 4.2 A5.2 正式反馈保存

`POST /api/attempts/:id/feedback`，发起者限**任课教师**。请求字段：

`recoveryGeneration`、`kind`（`formative` | `submission_review`）、`feedbackId`（可选，提供即为对既有反馈线程的修订）、`expectedFeedbackRevision`、`expectedStateRevision`、`submissionId`（可选，缺省为最新提交）、`summary`（教师给出的正式评价正文，必填、有界）、`reason`（必填理由）、`evidenceRefs`（获准引用，最多 64）、`expectedAttemptRevision`（`kind=submission_review` 时必填）。

领域行为：

1. 教师课程权限来自当前 Session 与课程成员，学生请求一律 `FORBIDDEN`；`courseId/studentId/attemptId` 不由请求体决定。
2. `expectedFeedbackRevision` 与当前范围值相等，否则 `VERSION_CONFLICT`；首次写入预期 0。
3. `expectedStateRevision` 与当前 `learnerStateRevision` 相等，否则 `VERSION_CONFLICT`；反馈不改变学习主张，只记录正式评价。
4. `submissionId` 必须是本尝试的真实固定提交，否则 `INVALID_REFERENCE`；`kind=submission_review` 还必须是最新提交、尝试处于 `submitted`，并核 `expectedAttemptRevision`，然后**在同一短事务内**调用 C4 `transitionAttemptInTransaction` 把尝试推进到 `reviewed`（TECH §7.1「正式 feedback kind=submission_review 与 submitted→reviewed 同事务」）。`kind=formative` 不改变学习阶段。
5. 追加一行 `teacher_feedback`，返回 `feedbackId/feedbackRevision/submissionId/kind` 与阶段迁移结果；任一步失败整笔回滚，不留下半条反馈或半次阶段变化。
6. 幂等沿用公共回执：同账号+同命令+同目标+同 `Idempotency-Key` 且请求摘要相同返回原反馈与阶段结果并标 `replayed`；摘要不同 `IDEMPOTENCY_CONFLICT`；代际过期 `RECOVERY_REQUIRED`。
7. **B3 草稿可选**：模型不可用、B3 未交付或未提供草稿时本命令完全可用；未采用的模型草稿永远不写入本表，也不下发给学生。

### 4.3 A5.3 教师修订许可

`POST /api/attempts/:id/reopen`，发起者限**任课教师**。请求字段：`recoveryGeneration`、`expectedAttemptRevision`、`submissionId`（必须是最新提交）、`reason`，以及可选的 `feedback`（4.2 的反馈字段子集）。

领域行为：

1. 教师课程权限同上；尝试必须已处于 `reviewed`，`expectedAttemptRevision` 必须与当前值相等，否则 `VERSION_CONFLICT`；`submissionId` 不是最新提交返回 `INVALID_REFERENCE`。
2. 在同一条命令事务内按 C4 已批准的两段式编排许可：`work` 回调调用 `planReopenGrant` 完成守卫与计算，`afterCommit` 回调用既有 `writeReopenGrant` 落盘（许可行的外键指向授权它的命令回执，回执行在 `afterCommit` 前尚不存在）。
3. `feedback` 存在时，用与 4.2 相同的追加函数在同一事务内保存，并绑定同一个 `submissionId`，落实 A5.3「对明确旧提交保存许可与反馈」。
4. 保存许可后尝试**仍是 `reviewed`**，作品保持只读；系统不替学生继续，只有学生本人的 `resume_revision` 消费许可后才回到 `active`（C4 §4.2 已固定）。分配暂停使已发放许可失效且恢复不使其复活，UI 据 C4 的 `actionable=false` 区分「从未发放」与「发放过但已作废」；本任务不改该事实。
5. 幂等同上；重复许可不重复状态转换，旧许可标 `superseded` 而不是删除。

### 4.4 A5.2 配套读取

`GET /api/attempts/:id/feedback`，发起者为所属学生**或**任课教师：

- 学生只读本人尝试；返回正式反馈的追加修订、确切版本、目标提交、依据有效性/争议标记，以及 C4 的许可视图（`state` + `actionable`）。未采用的模型草稿、私有验证资产与其他学生内容不出现。
- 教师读同一门课内的尝试；返回内容与结构相同，不额外下发未采用草稿。
- 未建立反馈时返回 `feedbackRevision: 0` 与空列表，不伪造正文，不用哈希/摘要补造。
- 只读，不激活学习、不排作业、不改变阶段。

### 4.5 接缝装配

- `createReviewApp` 内用本域存储实现 A4 的 `FeedbackTargetResolver`（`disputes.ts:9`）：对 `{kind:'feedback',id,revision}` 解析出 `current` 与该反馈实际引用的 `claimRefs`；未落地或版本不匹配返回 `undefined`，由 A4 现有代码转成 `INVALID_REFERENCE`，不伪造正式反馈。学生由此获得针对正式反馈提出异议的能力。
- 把本域 `readFeedback` 挂到 C4 声明的恢复读取接缝，使 `GET /api/attempts/:id/recovery` 的 `feedback` 从 `unavailable` 变为真实可用；未装配时保持原 `unavailable` 行为不变。这是 C4 §4.3 已声明「归 A5」的挂载点。

### 4.6 实际实现与 §4.1～4.4 的差异（2026-10-14 两轴审查后修正）

本节原文按批准时点逐字保留，以下只追加实际落地与原文不一致、或原文未说明的部分；每项都是修正后的实际代码行为。

1. **`review-context` 的分组与裁剪收紧（§4.1）**：`reopen` 改为顶层分组而非嵌在 `feedback` 内；`submissions[]` 与 `submission` 复用 C4 的 `Submission` 形状并只追加 `latest`，不再逐字段重拼；`decisions`/`disputes` 由 A4 的课程+学生切片**收窄到本尝试**（依据 M-08「围绕一次学生尝试」），不再把同一学生其他尝试的历史当成本次的；能力线列出 `active`/`contested` 的全部主张，**不再因 `basisAvailable=false` 丢弃整条主张**，改为逐引用表达 `unavailable`，符合 §4.1「缺失/撤回/不可见引用逐项表达 unavailable」。
2. **反馈读取补充依据有效性与争议标记（§4.4）**：`FeedbackEntry` 增 `disputed`（是否有异议指向该确切修订）与 `basis[]`（每条被评价主张现在的状态：`current`/`revised`/`withdrawn`/`superseded`/`unavailable`）。原文只写「依据有效性/争议标记」而未定字段，这里定形；读者据此能区分仍然有效的评价与依据已被修订/撤回/不可达的旧评价。
3. **修订只能发生在拥有该线程的作用域内（§3）**：按 `feedback_id` 回查上一修订时同时核 `course_id/student_id/attempt_id`。仅按 ID 回查会让教师把修订追加到别的作用域的线程上，并把每线程版本变成全局最大值。越界引用返回 `INVALID_REFERENCE`。
4. **`kind=submission_review` 的阶段规则原文表述过窄（§4.2 第 4 项）**：实际规则是——必须指向最新固定提交；尝试处于 `submitted` 时必须携带 `expectedAttemptRevision` 并在同一事务推进到 `reviewed`；尝试已是 `reviewed` 时追加一条评价修订而不迁移阶段（教师可修订已给出的正式评价，符合 M-08「不覆盖历史」）；其他阶段返回 `STATE_CONFLICT`。原文「尝试处于 submitted」把最后两种情形压成了一种，实际实现按上述三分支。§4.3 第 3 项要求许可与反馈同事务保存，其中的反馈必然发生在 `reviewed`，因此这条澄清是该项可行的前提。
5. **失效范围（§4.2 第 6 项、TECH §7.2.1）**：实际调用的 `invalidateLearnerTeaching` 以**课程+学生**为范围（A4 既有实现，`storage.ts:61`），不是只针对本尝试。因此任一尝试上的正式反馈都会让该学生在该课程内的相关未展示教学/分析动作失效，并使各尝试的 `attemptRevision`/`decisionEpoch` 递增。这是沿用的保守做法，不是本批新增语义；原文「相关…使依赖的教学上下文失效」未说明该宽度，此处如实补记，交 C/A 在联合集成时确认是否需要收窄。
6. **反馈条目的排序依据**：按表中 `rowid`（真实插入顺序），不按调用方给出的毫秒级 `created_at`；同一毫秒保存的两条修订不会退化成按随机 UUID 排序。

## 5. 与 C4/A4/B3 的交接

- **C4 → A5**：`transitionAttemptInTransaction`、`planReopenGrant`/`writeReopenGrant` 与 `ReopenView` 按 C4 §6 第四项的批准事实直接接入，本任务不改其签名；若确需不同参数编排，按 C4 第 5 节协调，改动仍限于这几个函数与其测试。A5 不自行实现提交、许可存储或学生 `resume_revision`。
- **A4 → A5**：`readCurrentInTransaction`、`TeacherDecision`、`Dispute` 与 `FeedbackTargetResolver` 按 A4 §9 直接消费；A5 不重新实现有效状态或纠正传播。
- **A5 → C4**：正式反馈记录与 `GET /api/attempts/:id/feedback` 提供 C4 恢复视图所需的反馈修订；C4 不需要反向依赖 A5 的表结构。
- **B3 → A5**：反馈草稿为可选输入，未交付不影响人工反馈链；A5 不调用模型、不保存未采用草稿。
- **A5.4/A5.5（第二批）**：复制蓝图复用 A2 已交付的 `mode:'copy'` 与来源关联，再走 A2 既有检查/确认/分配；新尝试复用 C2 既有 `POST /api/assignments/:id/attempts`；B 读取同课程/适用目标的有效状态走 A4 既有读取。第二批只在第一批验证通过后按当时实际缺口补最小增量，不预先扩大第一批写集。

每次交接给出规格/任务编号、实际代码位置、请求/响应与恢复方式、依赖版本、验证命令与结果、替身边界、失败/未执行与下游可开工项。

## 6. 待确认的解释项与提案

以下事项影响共享契约或产品结果，**未获确认前不实施**。

1. **新增 1 张 A 属表 `teacher_feedback` 与精确 34 表集合。** 这是数据库 schema 变更，按红线须明确对象与范围的同意；沿用 A4 已批准的做法：只建全新保留的合成库、不迁移既有库、不扩其他工厂。替代方案是把反馈塞进既有 `teacher_decisions`，但那会把「学习主张纠正」与「作品评价」混成一张表，与 A4 §1 与 TECH §4.2 的分层要求冲突，故列为不采纳。
2. **`feedbackRevision` 的作用域定义为「该 Attempt 已保存的反馈修订条数，未创建为 0」。** TECH §4.3 只写「A 的自述/正式反馈追加版本」，未定作用域。备选是课程/学生范围。选 Attempt 范围的理由是反馈必须绑定确切提交，学生读的是本尝试的反馈。
3. **`kind=submission_review` 才能触发 `submitted`→`reviewed`，`kind=formative` 不改变学习阶段。** 依据 TECH §7.1 与 §5 反馈行；把 formative 也做成阶段迁移会让「主张复核不自动改变学习阶段」失效。
4. **`POST /api/attempts/:id/reopen` 接受可选内嵌 `feedback`。** 目的是落实 A5.3「保存许可与反馈」。备选是强制两次独立调用；缺点是教师必须记住先反馈后许可，且两次写入不在同一事务。此提案不新增 C4 侧字段，也不改 C4 的许可守卫。
5. **`kind=submission_review` 限定最新提交。** 依据 C4 已批准事实「许可只允许落在最新提交上」（C4 §4.2）。若负责人希望反馈可以针对任意历史提交，需要区分「反馈目标可以是旧提交」与「许可只能落在最新提交」，本任务按前者从宽、后者从严实现时应改为：`formative` 与 `submission_review` 都允许历史提交，只有 `submission_review` 触发阶段迁移时要求最新提交。
6. **C 属 `apps/teaching/server/workspace/application.ts` 的 2 行加性改动。** 目的只是让 C4 已声明归 A5 的 `readFeedback` 可被外部挂载；不改 C4 的任何判定、不改 `unavailable` 默认行为。若负责人希望保持该文件零改动，本任务可放弃恢复视图接线，只保留 `GET /api/attempts/:id/feedback` 作为正式反馈读取入口，并在 §8 记为未完成项。
7. **`GET /api/attempts/:id/review-context` 的角色范围是「任课教师」，学生不可读。** 依据 READ-11 与 TECH §4.4；学生读自己的反馈走 READ-14，读自己的有效状态走既有 `/learner-state`。
8. **A5.4/A5.5 列入第二批，不随第一批一起实施。** 理由是 A5.4 复用 A2 已交付能力、A5.5 复用 C2/A4 已交付能力，先核对第一批实际落地的缺口再补最小增量，避免重复实现或扩大共享契约。

## 7. 验证计划

编码前先获得 §3～§6 的批准；批准后按单个公共行为 red→最小实现→green 推进，只下列已约定接缝观察行为（依据项目 [tdd skill](../../skills/tdd/SKILL.md) 的「Test only at pre-agreed seams」）：

| 接缝 | 独立验收行为 | 对应条件 |
| --- | --- | --- |
| 真实登录 HTTP `POST feedback` + `GET feedback` | 教师保存正式评价并可回读，学生得到同一版本；学生发起写入被拒；未采用草稿不出现在任何投影 | M-07、AC-09 |
| `submission_review` 与阶段迁移 | 提交后教师反馈使尝试进入 `reviewed` 且同事务；重复同键返原结果；旧表单 `VERSION_CONFLICT` | M-07/M-08、AC-08 |
| 反馈修订链 | 同一 `feedbackId` 追加修订，旧修订与其目标提交原样保留；`expectedFeedbackRevision` 过期冲突；重放不重复行 | M-08、AC-09/12 |
| `POST reopen` + 学生 `resume_revision` | 许可保存后尝试仍是 `reviewed`、作品只读；无许可/许可被消费/许可被取代/分配暂停/教师代学生发起一律拒绝；学生显式消费后才 `active` | M-09、AC-08/09 |
| `GET review-context` | 三条能力线与作品结果分组表达；`unknown` 不折叠；私有资产与其他学生内容不出现；学生请求被拒 | M-08、AC-16 |
| 学生异议指向正式反馈 | 解析器给出确切 `claimRefs`；未落地/版本不匹配返回 `INVALID_REFERENCE`；争议改变当前投影并传播失效 | M-06、AC-08/16 |
| 真实事务故障注入 | 反馈行、阶段迁移、许可行、事件与回执任一步失败全部回滚，无半笔反馈或半次状态转换 | NFR-04、AC-08 |
| `GET /api/attempts/:id/recovery` 反馈接缝 | 挂载后返回真实反馈修订；未挂载时仍为 `unavailable`，不用哈希补造 | M-09、AC-12 |

获准 Node 24.21.0 与既有 lock 依赖、获准 fresh-only 数据库环境，工作目录 `apps/teaching`：

```powershell
node --test tests/a5-feedback.test.ts
npm run typecheck
npm run build
npm test
```

仓库根目录在同步 README 后执行 `node tools/a0-review/check.mjs`。真实模型、Linux/隔离节点、浏览器/TLS 与真人门禁分别报告，不用替身通过数替代。既有 Windows `server/workspace/review.test.ts:118` 的 Linux-only 环境失败按原样保留，不改判据。

## 8. 执行记录（随实际结果追加）

2026-10-14：完成依据核对与现状核查，确认 `origin/main` 已含 A4/C4/B3 与 33 表合并范围，确认 `POST /api/attempts/:id/feedback`、`POST /api/attempts/:id/reopen`、`GET /api/attempts/:id/review-context`、`GET /api/attempts/:id/feedback` 均未实现，确认 C4 已交同事务接缝与恢复读取挂载点但无产品路由，确认 A4 的 `FeedbackTargetResolver` 尚无调用方。

本文此时为**提案**：未获 §3～§6 批准，未初始化新表、未改任何源码、未运行任何业务测试。批准事实与后续实现/验证结果按日期追加在本节之后，原文保留。

**未完成项（本时点全部）：** A5.1～A5.5 全部未实现；未执行 typecheck/build/专项/完整回归；未执行浏览器、TLS、真人师生与教学效果验收；未修改产品/规划/参考/AGENTS 基线；未推送或合并任何分支。

### 8.1 负责人实施批准（2026-10-14）

负责人明确答复「批准 §3～§6 全部提案」，批准本批的以下具体范围：

1. 新增 1 张 A 属表 `teacher_feedback`，`createReviewDatabase()` 精确表集合 33 → **34**，只建全新保留的合成库，不迁移既有/生产库、不扩其他工厂。
2. §4 的四条路由：`POST /api/attempts/:id/feedback`、`GET /api/attempts/:id/feedback`、`POST /api/attempts/:id/reopen`、`GET /api/attempts/:id/review-context`，全部落在已批准基线内，不新增基线外路由。
3. §4.5 的接缝装配：以本域存储实现 A4 的 `FeedbackTargetResolver`，并挂载 C4 声明归 A5 的 `readFeedback` 读取点。
4. §6 提案 6 的 C 属加性改动：`apps/teaching/server/workspace/application.ts` 增加可选 `recovery.readFeedback` 注入点，未提供时保持原 `unavailable` 默认行为，不改 C4 任何判定。
5. §6 提案 5 按负责人选择收口：**`kind=submission_review` 限最新提交并触发 `submitted`→`reviewed`；`kind=formative` 允许引用本尝试的任意真实固定提交且不改变学习阶段。**
6. §6 提案 2 收口：`feedbackRevision` 作用域为该 Attempt 已保存的反馈修订条数，未创建为 0，追加单调递增、修订不重置。
7. §6 提案 7 收口：`GET /api/attempts/:id/review-context` 限任课教师，学生不可读。

批准范围按 §3～§6 原文字面理解，只对该范围有效，不延伸到未列出的文件、任务或后续操作。A5.4/A5.5 仍按 §6 提案 8 列第二批，需第一批验证后再核实际缺口。批准不构成产品/规划/参考/AGENTS 写入许可，不构成真实数据库建表/迁移、真实模型、浏览器/真人验收或公开发布许可。

### 8.2 实际实现（2026-10-14）

按 §3～§6 与 §8.1 实施 A5 第一批 A5.1～A5.3。实现位置：

| 实际文件 | 已交能力 |
| --- | --- |
| [review contracts](../../apps/teaching/contracts/review/index.ts) | `feedbackKindSchema`、`feedbackBodySchema`、`feedbackInput`、`reopenInput`、`reviewContextQuery`、`feedbackSchema`/`TeacherFeedback`、`feedbackResultSchema`、`reopenResultSchema`、`reopenViewSchema`、`feedbackEntrySchema`/`FeedbackEntry`、`FeedbackThread`/`FeedbackView`、`ReviewContext`；既有类型零改写 |
| [feedback application](../../apps/teaching/server/review/feedback.ts)（新） | `readFeedbackScopeRevision`、`readFeedbackRevisions`、`readFeedbackEntries`、`readFeedbackView`、`appendFeedbackInTransaction`、`planReopenInTransaction`、`feedbackTargetResolver`、`readRecoveryFeedback`、`reviewContextInTransaction` |
| [review application](../../apps/teaching/server/review/application.ts) | `GET /api/attempts/:id/review-context`、`GET/POST /api/attempts/:id/feedback`、`POST /api/attempts/:id/reopen`；默认装配 `feedbackTargetResolver()` 与 C4 恢复读取接缝 |
| [review schema](../../apps/teaching/server/db/review-schema.ts)、[transaction](../../apps/teaching/server/db/transaction.ts) | 新增 `teacher_feedback` 表；`createReviewDatabase()` 精确集合守卫 33 → 34，仍为建库前 fail-closed |
| [workspace application](../../apps/teaching/server/workspace/application.ts) | 可选 `recovery.readFeedback` 注入点；**该 C 属共享接缝的签名被本批改动**，见下方第 1 项 |
| [A5 tests](../../apps/teaching/tests/a5-feedback.test.ts)（新）、[review-support](../../apps/teaching/tests/review-support.ts) | 11 项 A5 公共接缝用例与 `submit`/`feedback`/`feedbackView`/`reopenGrant`/`reviewContext` 夹具助手 |

实现中的四点事实需要 C/UI 与维护者知道：

1. **C4 挂载点的签名改动超出了批准的字面范围（负责人已决定保留，待 C 复核）**：C4 声明的 `readFeedback` 形参只有 `(request, attemptId)`，没有事务。`WorkspaceAppOptions` 的数据库入口只提供 `withTransaction`，而该入口明确禁止嵌套事务（`transaction.ts:93` 在 `db.inTransaction` 时抛错），C4 自己的恢复路由又已经在一个授权事务里调用它，因此原签名无法接一个真实持久化的 A5 读取。实际改动是把接缝形参补成 `(tx, request, attemptId)`，并同步三处：`WorkspaceAppOptions` 的 `recovery` 选项类型、`recovery` 常量的默认实现、以及恢复路由的调用点。默认 `unavailable` 行为与 C4 的任何判定均未变。
   **这不止是「2 行以内的加性改动」**：选项类型与调用点都变了，属于 §8.1 第 4 项批准的「加性挂载点」之外的事务契约改动，且是在实现中决定、事后才登记的，不符合 AGENTS「共享字段、状态、错误码、版本、权限和事务语义先提案并确认」。
   2026-10-14 负责人已在了解该偏离后明确选择**保留该改动**（备选是回退到「C 属文件零改动」，代价是 `GET /api/attempts/:id/recovery` 的反馈继续报 `unavailable`，该备选不采纳）。保留事实不等于 C 已复核：**本项仍交 C 在其消费批次复核**，在 C 给出结论前不写作跨域共享契约已批准。
2. **反馈历史的排序依据**：初版按 `created_at, feedback_id` 排序，同一毫秒内保存的两条修订会退化成按随机 UUID 排序，导致「最新一条」在投影中不可靠。首个反例（同一次 reopen 内嵌反馈与先前反馈的 `created_at` 相同）暴露该缺陷，改为按表中 `rowid`（真实插入顺序）排序后转绿。`created_at` 仍逐行记录，但不作为顺序依据。
3. **一次 `kind=submission_review` 反馈对尝试版本的合成影响**：该命令在同一事务内跑完 C4 的 `submitted`→`reviewed` 迁移与 C3 的教学依据失效，实测 `attemptRevision` 与 `decisionEpoch` 各前进 **2**（迁移一步 + 失效一步），命令返回的是真实终态而不是中间值。这是 A4/C3 已批准链条的既有行为，不是本批新增语义；UI 按 `resyncRequired`/`actionable` 处理即可，不要假设「一次反馈只前进一版」。失效范围见 §4.6 第 5 项。
4. **`feedbackRevision` 线程回查必须限定作用域**：两轴审查发现初版仅按 `feedback_id` 回查上一修订，教师可借此把修订追加到别的作用域的线程上并使每线程版本变成全局最大值；已改为同时核 `course_id/student_id/attempt_id`，越界返回 `INVALID_REFERENCE`，并有对应反例。

小范围既有断言同步：`tests/review.test.ts` 的表数断言按批准的新表集合由 33 改为 34，并把 `teacher_feedback` 加入断言的表名列表；该断言仍为精确集合检查，未放宽。

### 8.3 实际验证（2026-10-14）

获准 Node `v24.21.0`（Windows x64）与既有 `package-lock.json` 锁依赖，工作目录 `apps/teaching`。依赖按既有原锁包复用，未装新包、未改清单或 `tsconfig`。

| 实际命令 | 实际结果 | 边界 |
| --- | --- | --- |
| `npm run typecheck` | 通过（exit 0） | 含 A5 新源码/测试与全部既有 B/C 接缝 |
| `node --test tests/a5-feedback.test.ts` | 11 项，11 通过、0 失败、0 跳过 | 真实 Fastify 登录/路由链、真实 SQLite 事务、C4 提交/许可与 C3 失效接缝；runner/provider 沿用 A4 的显式合成替身。计数演进：8 → 9（形成性反例）→ 11（两轴审查后追加作用域与依据可用性反例） |
| `node --test tests/review.test.ts tests/a5-feedback.test.ts` | 62 项，62 通过、0 失败、0 跳过 | A4 原 51 项全部保持通过 |
| `node --test tests/review.test.ts server/workspace/submissions.test.ts` | 首轮 66 项，65 通过、1 失败 | 该唯一失败是 A4 原 33 表断言（本批已批准变更为 34），修正后见 §8.4；保留首轮结果 |
| `npm test`（含 `pretest` 的 build） | 见 §8.4 | 默认文件并发；不改用例、阈值、文件集合或平台/模型门禁 |

真实模型调用为 0；真实执行节点、Linux 隔离、socket/TLS、浏览器与真人师生验收均未执行，分别保留原后置条件。Fastify inject 不能代替浏览器或真实 TLS 验收；服务端闭环通过不等于教学效果或完整应用验收。

### 8.4 收口结果与未完成项

2026-10-14 最终验证（获准 Node `v24.21.0`，工作目录 `apps/teaching`，与 §8.3 同环境）。服务端源码与测试固定为本地提交 `e61252fae39283f08436256577669d07d2ce1b5c`（本任务文件、未推送未合并；本任务记录与证据随后单独提交，故该提交号只标识代码与测试）。基线用隔离树实测：由 `git archive origin/main` 解出（`origin/main = eea962322ace4a1fd3dc86ce531adf5711552da9`），复用同一份锁依赖，不切分支、不覆盖工作区。工作分支在既有 `964abb4`（I0 宿主健康修复）之上，该提交不改任何 A5 文件。

| 实际命令 | 基线（`origin/main`） | 本批工作树 | 净变化 |
| --- | --- | --- | --- |
| `npm test`（默认文件并发，含 `pretest` 的 build） | 427 项：409 通过、1 失败、17 跳过 | **438 项：419 通过、2 失败、17 跳过** | +11 项、+11 通过、失败数含下述未复现的时序抖动 |
| `node --test --test-concurrency=1 …`（同文件集合串行） | 未执行 | **438 项：420 通过、1 失败、17 跳过** | 只剩环境失败 |
| `node --test server/tutoring/test/index.test.ts` | 未执行 | 47 项全通过 | 默认全集里那次失败未复现 |
| `node --test --test-reporter=tap tests/a5-feedback.test.ts` | 文件不存在 | **11 项：11 通过、0 失败、0 跳过，exit 0** | A5 专项 |
| `npm run typecheck` | — | 通过（exit 0） | — |
| 合成库 schema 冒烟 | — | 34 表、`teacher_feedback` 存在、`integrity_check=ok`、外键违规 0、关闭后重开仍 34 表；SQLite 3.53.4、WAL、`foreign_keys=1`、`synchronous=2`、`busy_timeout=1000` | 建库前仍有精确表集合 fail-closed 守卫；只读 `sqlite_master`/`pragma_*`，不读账号或业务行 |
| `node tools/a0-review/check.mjs` | — | 88 文档、`errors=[]`、exit 0 | 另 `node --test tools/a0-review/check.test.mjs` 16/16 |
| `git diff --check` | — | 通过（exit 0） | — |

默认全集与串行全集两次运行分别如实保留。两次共同的唯一失败是 `server/workspace/review.test.ts:118` 在 win32 初始化 Linux-only 控制上下文时抛 `INVALID_CONFIGURATION: Linux and trusted control context required`；本批未改该用例、runner 或判据。默认全集另有 1 项 `server/tutoring/test/index.test.ts` 的 deadline 用例失败（慢 provider 在 31.9ms 内未按期限中止），该文件单独运行 47/47 通过、串行全集也未复现，与 A4 记录的同一类时间敏感抖动一致；保留首轮失败，不改写为串行通过数。基线首次运行是在本批 A5 用例并发执行时进行的，另出现 2 项同类 deadline/cancellation 失败；该树在无并发负载下复跑只剩 1 项，故按负载引起的时序抖动记录，不写作基线失败，也不回填首次结果。

一次**无效中间运行**如实保留：本轮曾在 `npm test` 执行期间修改源文件（`feedbackQuery` 改名），导致两个测试文件在模块加载时读到不一致导出，`tests/review.test.ts` 与 `tests/a5-feedback.test.ts` 文件级失败、`durability.test.ts` 15 秒超时，套件提前结束（378 项、1 取消）。这是本次操作的失误而非产品缺陷；在无并发编辑的干净复跑即为上表结果。教训：验证运行期间不得改动被测源码。

证据入口：[A5 证据索引](../../apps/teaching/tests/evidence/a5/acceptance.a5.evidence.json)，含专项 TAP、默认全集、串行全集、基线、文档检查与 schema 冒烟六份记录及其 SHA-256/字节数。控制台原日志为 UTF-16LE，入库记录统一解码为 UTF-8 并归一绝对路径/ANSI/CRLF 与行尾空白；归一前的原始字节未作为 blob 入库，故索引中的 `rawLogSha256` 只标识本批本地原始日志，不冒充未规范化原件。

A5 专项 11 项与 §7 约定接缝一一对应：

| §7 约定接缝 | 用例 |
| --- | --- |
| HTTP `POST/GET feedback` 真实登录读写 | 5「形成性反馈不改阶段」、6「正式反馈与阶段迁移」、7「修订链」 |
| `submission_review` 与阶段迁移同事务 | 6 |
| 反馈修订链与重放/冲突 | 7 |
| 许可保存与作品只读、学生主动重开 | 8「修订许可保持作品只读直到学生消费」 |
| `GET review-context` 分组与角色边界 | 4「教师审阅上下文」、3「不可解主张仍列出、历史收窄到本尝试」 |
| 学生异议指向正式反馈 | 9「异议针对确切反馈」 |
| 真实事务故障注入 | 10「反馈与阶段一起回滚」 |
| 恢复视图反馈接缝 | 11「恢复视图与端到端链」 |
| 审查后新增：线程作用域与许可同事务反馈 | 2「线程只能在其所属作用域内修订」、1「许可同事务保存反馈」 |

全部用例经真实 Fastify 登录/路由链与真实 SQLite 事务；runner/provider 沿用 A4 的显式合成替身，模型调用为 0。

**本批完成：** A5.1 教师审阅业务读取、A5.2 正式反馈保存与读取、A5.3 教师修订许可，含 A4 `FeedbackTargetResolver` 与 C4 恢复读取接缝的实际装配，并已按 §8.5 的两轴审查修正其发现。

**仍未完成（分别报告，不随本批通过）：** A5.4 复制蓝图与新活动、A5.5 至少一个相关后续任务（§6 提案 8 列第二批）；真实模型（本批 0 次调用）、真实执行节点/Linux 隔离、socket/TLS、实际 UI/浏览器、真人师生与教学效果验收；C 对 §8.2 第 1 项接缝的复核（保留决定已作，复核未作）。未修改 `docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、B/C/UI 源码、依赖清单/锁、凭据/CI；未推送、未合并、未创建或评论 PR、未关闭 Issue。

### 8.5 独立两轴代码审查与修正（2026-10-14）

审查对象为本批未提交工作树（`git diff HEAD` 加两个新文件），固定点 `HEAD = 964abb4`。两个独立子 Agent 分别只读执行 Standards 与 Spec 轴，均未运行测试、未修改文件；父 Agent 另跑验证（§8.4）。审查范围与依据、发现逐项如下，原文结论保留。

**Standards 轴**（依据 AGENTS、README、A4/C4 任务稿模板、相邻 `review/` 模块惯例与嗅觉基线）：

| 发现 | 严重度 | 处置 |
| --- | --- | --- |
| 任务稿状态行仍写「提案、尚未获批准、未改源码」，与同文件 §8.1～§8.4 矛盾 | 硬 | 已改为当前状态并保留原时点记录位置（见本节首段与文件头） |
| §8.2 记为已交付的 `feedbackQuery` 实际不存在（真实导出为 `reviewContextQuery`）；且把「2 行以内」的出处误记为 §8.1 第 4 项 | 硬 | 已改名为 `reviewContextQuery`，出处改为 §1 写入范围行与 §6 提案 6 |
| §8.4 把 10 条行为说成「专项 9 项」，其中两条指向同一用例 | 硬 | 已改为「§7 接缝 ↔ 用例」一一对应的表格并按实际计数 |
| C 属共享接缝的事务语义在实现中决定、事后登记，且超出批准的字面范围 | 硬 | 已按实际改动（三处）如实改写，标为**须负责人裁决与 C 复核**，并给出回退选项；见 §8.2 第 1 项 |
| `POST reopen` 的编排与 C4 的 `reopen.grant` 接缝形状重复；`writeReopenInTransaction` 是纯转发；`fixed()` 与内联 `submissions` 重复八个字段；`actionableAssignment` 复述 C4 私有判定；`readRecovery` 仅为取 `.runs` | 判断项 | `writeReopenInTransaction` 已删除，路由直接调用 C 的 `writeReopenGrant`；`submissions` 改为复用同一形状；`actionableAssignment` 与 `readRecovery` 的复用原因已就地注释（前者需 C 导出后才可消除，后者复用 C4 的结果分类而不复述规则），并在 §8.6 记为待 C 协调项 |
| 证据索引与 A4 模板不一致（缺 `commands[]`、缺 schema 冒烟、缺逐文件归一说明） | 判断项 | 已按 A4 结构重建索引，补 schema 冒烟记录与逐文件归一说明 |
| 注释密度高于相邻 `review/` 模块 | 判断项 | 保留：本批注释承载跨域理由，`workspace/` 有同样先例 |

**Spec 轴**（依据本任务稿 §3～§8.1 与 TECH/MVP/C4/A4 正文）：

| 发现 | 处置 |
| --- | --- |
| 反馈读取缺「依据有效性/争议标记」 | 已补 `disputed` 与 `basis[]`（`current`/`revised`/`withdrawn`/`superseded`/`unavailable`），并有异议前后两个反例 |
| `review-context` 丢弃 `basisAvailable=false` 的主张，与 §4.1「逐项表达 unavailable」不符 | 已改为列出全部 `active`/`contested` 主张并逐引用表达 `unavailable`，新增「不可解主张仍列出」反例 |
| §4.1 把 `reopen` 列为独立分组，实际嵌在 `feedback` 内 | 已提升为 `ReviewContext.reopen` 顶层分组 |
| `kind=submission_review` 在已 `reviewed` 的尝试上返回 200 而非 `STATE_CONFLICT`，与 §4.2 第 4 项字面不符 | 判定为记录表述过窄而非代码缺陷：三分支规则见 §4.6 第 4 项，原文保留、差异补记；仍需负责人确认该澄清 |
| 初版仅按 `feedback_id` 回查上一修订，未核作用域，教师可把修订追加到别的作用域的线程 | **真实缺陷，已修**：回查同时核 `course_id/student_id/attempt_id`，越界 `INVALID_REFERENCE`，新增反例 |
| 未披露：`invalidateLearnerTeaching` 以课程+学生为范围，任一尝试的反馈都会影响该学生其他尝试的版本与在途动作 | 已如实补记于 §4.6 第 5 项，标为沿用 A4 的保守做法并交 C/A 确认是否收窄 |
| 父 Agent 自查另发现：`review-context` 的 `decisions`/`disputes` 用的是 A4 的课程+学生切片，未收窄到本尝试 | 已收窄到本尝试并有反例断言 |

审查另确认通过的项：`kind=formative` 不调用任何阶段迁移；`submission_review` 在同一事务内调用 C4 迁移；故障注入下反馈与阶段一起回滚；`feedbackRevision` 为尝试范围计数、首次预期 0、不重置；异议按确切 `feedbackId+revision` 解析、未落地为 `INVALID_REFERENCE`；`review-context` 限任课教师、学生 403；三组事实分组表达；无 A5 路径读取模型草稿，私有资产与其他学生内容不进入投影。

两轴最严重项分别为：Standards 为 C 属共享接缝的事务语义事后变更（须负责人裁决）；Spec 为反馈线程回查缺作用域限制（已修）。两轴不合并、不跨轴重排。修正后的增量复核结论见 §8.6。

### 8.6 修正后的增量复核与待协调项

修正 `964abb4` 工作树后重跑：`npm run typecheck` exit 0；A4 51 项 + A5 11 项共 62 项全通过；默认 `npm test` 438 项、419 通过、2 失败（环境失败 + 未复现的 deadline 抖动），串行同集合 438 项、420 通过、1 失败，详见 §8.4；`node tools/a0-review/check.mjs` exit 0、`errors=[]`；`git diff --check` exit 0。§8.5 表格中的硬发现与真实缺陷均已关闭。

仍需外部输入的项：

| 事项 | 需要谁 | 原因 |
| --- | --- | --- |
| `workspace/application.ts` 的 `readFeedback` 事务形参改动交由 C 复核 | C | 负责人已决定保留该改动（§8.2 第 1 项）；C 复核的是它在其消费批次中的可用性，不是是否保留 |
| 把 `actionableAssignment` 的判定从 C4 导出为公共 helper，消除 A5 侧复述 | C | 属 C 域判定，A5 不宜再定义一份 |
| `invalidateLearnerTeaching` 的课程+学生失效宽度是否需要收窄到本尝试 | C/A 联合集成时确认 | §4.6 第 5 项：影响同一学生其他尝试的版本与在途动作 |
| `kind=submission_review` 在已 `reviewed` 尝试上追加评价修订是否符合产品意图 | 项目负责人确认 | §4.6 第 4 项：原文表述过窄，实际按三分支实现 |

以上四项均不阻塞本批已实现能力的服务端验证，但在裁决/确认前不写作共享契约已批准，也不据此扩大后续批次范围。

## 9. 第二批（A5.4/A5.5）开工前的缺口核对（2026-10-14，只读）

按 §6 提案 8，第一批验证后才核第二批的实际缺口。下面是在 `e61252f` 提交的树上的只读核对结果，**未写任何代码、未改任何契约**。

| 第二批要求 | 现有能力 | 实际缺口 |
| --- | --- | --- |
| A5.4 复制蓝图与新活动、保留来源关联、旧要求不被修改 | A2 已有 `POST /api/courses/:id/blueprints` 的 `mode:'copy'`：产生 `revision=1` 的新草稿并保存 `source:{courseId,blueprintId,revision}`（[draft.ts](../../apps/teaching/server/design/draft.ts)）。复核/确认/分配走 A2 既有链 | **只有一处**：`ActivityVersion` 内部已持久化并校验 `sourceBlueprintId`（[activities.ts](../../apps/teaching/server/design/activities.ts) 的 `blueprint_id` 列与读取交叉核对），但公开的 `activityViewSchema`（[results.ts](../../apps/teaching/contracts/design/results.ts)）只投影 `sourceRevision`，**没有 `sourceBlueprintId`**。因此从「一次已复核尝试的 `activityVersionId`」无法经公共读取反查来源蓝图。补一个可选字段即可 |
| A5.5 至少一个相关后续任务、新尝试读取同课程适用目标的有效状态、撤回与无关历史排除、缺迁移证据保持未知 | C2 已有 `POST /api/assignments/:id/attempts`（创建/返回当前尝试）；A4 已有 `readCurrentInTransaction`，按活动目标与 `scope` 过滤主张、`withdrawn/superseded` 不进有效投影、`basisAvailable=false` 标 `unavailable`（§4.6 第 1 项已在 `review-context` 固化） | 未发现需要新增生产代码的能力缺口；缺的是**端到端验证**：复制蓝图 → 检查 → 确认 → 分配 → 新尝试 → 读取适用有效状态，并证明撤回主张不回带、未知不被补造 |

结论：第二批的代码增量是**一处 A 属只读投影字段**（`activityViewSchema` 加 `sourceBlueprintId`），其余为复用既有 A2/C2/A4 能力加一条端到端验证。`contracts/design` 是 B/C/UI 共同消费的共享契约，按 AGENTS「共享字段…先提案并确认」，该字段与第二批写集需负责人另行确认后再实施；本任务不据本节自行修改契约。

第二批拟写集（待确认）：`docs/tasks/A5_FEEDBACK_REVISION_FOLLOWUP.md`（本节及后续执行记录）、`README.md`、`apps/teaching/contracts/design/results.ts`（+1 可选字段）、`apps/teaching/tests/a5-feedback.test.ts` 或新增 `tests/a5-followup.test.ts`、`apps/teaching/tests/evidence/a5/`。不新增路由、不改表结构、不改 A2/C4 判定。

待获授权维护者汇总：批准后的实际代码位置、受控接口签名、验证命令与结果、失败/跳过/未执行项，按 A4 先例汇总至 MVP_SPEC 第 10 节与 TECH 对应契约段；本任务不自行修改受保护基线。
