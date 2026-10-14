# A6：A5 两项共享契约的 C 消费复核

日期：2026-10-14（Asia/Shanghai）。执行角色：本次 C 消费复核 Agent；属于 [A6 #61](https://github.com/paher-din/XunJie/issues/61) 的限定接缝批次，不代替完整 A6/C5。

状态：服务端消费复核通过。两项 A5 变更已有负责人确认，C4 消费与 B/UI 旧名接线检查已完成；专项 32/32 通过、类型检查通过。正常宿主与实际 UI 尚未接入 A5，不能据本批宣布跨域产品链验收完成；产品基线待授权维护者汇总，现有数据库未迁移。

## 1. 依据与授权

从 [README](../../README.md) 进入，检查 [AGENTS](../../AGENTS.md)、Git 状态与目录规范。原工作区已有不属于本任务的文档改动，全部保留。本批从 `origin/main@8b4130374289b71d737abe12ed4fc5e58adf55c5` 的干净独立工作树实施。

按 PRD → MVP_SPEC → TECH_DESIGN 阅读相关正文：

| 材料 | 已读章节与适用要求 |
| --- | --- |
| [PRD](../product/PRD.md) | §4.3、§5、§8；PRD-06/07/08/09/10，教师正式评价、学生控制与历史事实分别保存 |
| [MVP_SPEC](../product/MVP_SPEC.md) | M-07/08/09/10、§4、§6；AC-06/08/09/12，固定提交、追加反馈、恢复及旧版本拒绝 |
| [TECH_DESIGN](../product/TECH_DESIGN.md) | §4/4.1/4.3/4.4、§5/5.1、§7.1/7.2.1；快照来源、反馈版本、读取权限和同连接事务 |
| [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) | §2/2.1、§7 C4/A5、§8 A6；C 管恢复，A 管正式反馈，B/UI 按实际交付消费 |
| [A5](A5_FEEDBACK_REVISION_FOLLOWUP.md) | §4.6、§8.6、§10.2/10.3、§11.1/11.6；两项更名的批准范围、修复反例与待 C 复核 |
| [C4](C4_SUBMISSIONS_REOPEN_RECOVERY.md) | §1、§4.3、§5；只读恢复、未挂载时 unavailable、真实反馈接缝 |
| [P4 核心清单](P4_DEADLINE_CORE_VERIFICATION.md) | §2～5；只补变化影响的行为和接缝，未执行不计通过 |
| [I0 接入规格](I0_UI_SPEC.md)、[I0 客户端约束](I0_UI_CLIENT_CONTRACT.md)、[UI 来源](../../apps/student/IMPORT_SOURCE.md) | 正常 transport 不回退准备数据，沿实际 UI 交付，不新增替代界面 |

负责人本轮明确指令为处理所引 A6 待办；所引记录已确认范围按字面仅为：

1. `teacher_feedback.feedback_revision` → `thread_revision`；记录字段 `feedbackRevision` → `threadRevision`；`feedbackResultSchema` 与 `reopenResultSchema.feedback` 同时携带 `threadRevision` 与范围 `feedbackRevision`。C4 恢复视图中的 `feedbackRevision` 仍是范围版本。
2. `ReviewContext` 新增 `artifactSnapshotId`；`artifact` 为绑定快照清单；当前工作区清单为 `workspaceFiles`。

本批只复核现有实现并补消费接缝证据，不把授权扩展到其他字段、表、路由或数据迁移。C4 的既有 `entries[].revision` 是线程版本的投影名称，本批不另更名。

## 2. 写集、方案与验收

可写：本文、`apps/teaching/contracts/workspace/index.ts` 的版本语义注释、`apps/teaching/server/workspace/a5-consumption.test.ts`（消费接缝测试）、`docs/tasks/evidence/a6-c-contract-consumption/`（本批日志）。README 仅增加本任务导航。

只读：产品/规划/参考、规范、其他任务稿；A5/B/UI 实现、数据库/schema/配置、依赖/锁文件。复用既有精确锁依赖及 Node 24.21.0，不安装新依赖。

方案：核对 C4 在其已授权事务内调用 A5 读取，保留 `threadRevision → entries[].revision` 映射；补验多线程与许可内反馈的范围计数、重开数据库后的相同投影、以恢复范围版本续写及旧版本拒绝。第二项复用并在当前基线重跑 A5 旧提交快照反例，检查 B/UI 所有源码的旧名及接口消费。

验收：范围版本与线程版本出现不同数值仍消费正确；恢复条目能定位确切反馈修订；重开后历史不变；旧范围版本拒绝；旧提交只读绑定快照，当前清单单列；不存在遗漏旧名调用方。仅服务端隔离合成验证，不计真实执行、模型、浏览器或教学效果。

## 3. 消费核对与验证

### 3.1 实际消费与结论

| 对象 | 固定基线上的消费事实与复核结论 |
| --- | --- |
| C4 恢复反馈 | [RecoveryFeedback](../../apps/teaching/contracts/workspace/index.ts) 保留顶层 `feedbackRevision`（尝试范围 CAS）及条目 `revision`（线程内版本）；[A5 读取映射](../../apps/teaching/server/review/feedback.ts) 的 `readRecoveryFeedback` 将 `row.threadRevision` 映射为 `revision`。两者数值不同仍正确，不改 C4 已有字段。补两行注释避免再次混用 |
| A5 写响应与许可 | `feedbackResultSchema` 及 `reopenResultSchema.feedback` 已同时返回两个版本；消费者续写用范围版本，异议目标用确切线程版本，不以范围版本定位线程 |
| C4 同连接读取 | [工作区应用](../../apps/teaching/server/workspace/application.ts) 的 `recovery.readFeedback(tx, request, id)` 处于其获授权读取回调内；[A5 应用](../../apps/teaching/server/review/application.ts) 使用传入的同一个 `tx`，不再开启事务。未挂载仍返回 `unavailable`。本批核对了原待办的事务形参兼容性 |
| ReviewContext | [A5 反馈读取](../../apps/teaching/server/review/feedback.ts) 取 `chosen.snapshotId` 对应不可变快照，`artifactSnapshotId` 标来源；`artifact` 只含该快照文件标识/路径/版本/hash；当前确认清单单列 `workspaceFiles`（含 lifecycle）。没有选定提交时为 null/空清单；缺失绑定快照不回退工作区 |
| B | 扫描 `server/tutoring/**` 与 `contracts/tutoring/**` 的全部 TS 源码，未找到 `ReviewContext`、这两个 API 路径或更名字段消费者；B3 的 `feedbackDraft` 与蓝图 `artifact` 是其他既有对象，不属于本次更名 |
| UI | 扫描 `apps/student/**` 的 TS/TSX/MJS 源码、测试与开发 fixture，未找到这些字段或 `/feedback`、`/review-context` 消费。结论是当前没有旧名接线要修，不能写成正式反馈/教师审阅 UI 已完成 |

消费扫描命令（从仓库根执行，exit 1 表示本次目标没有匹配）：

```sh
rg -n 'threadRevision|feedbackRevision|feedback_revision|thread_revision|artifactSnapshotId|workspaceFiles|ReviewContext|/review-context|/feedback' apps/student apps/teaching/server/tutoring apps/teaching/contracts/tutoring -g '*.ts' -g '*.tsx' -g '*.mjs'
```

本批未改变 API、记录形状、SQL、表数、权限、阶段或路由。两项变更的负责人确认仍以 A5 §11.1 与本次指令为依据；完成后的 C 消费证据限定在本批固定版本，不代签 B/UI 接入或基线维护决定。

### 3.2 验证记录

环境：Windows、已存在的 Node `v24.21.0`；复用 C4 工作树已安装依赖，其 `package-lock.json` 与本批字节相同，已核 `zod=4.6.5`，未安装依赖、未修改包/锁或永久 PATH。只用既有工厂创建隔离合成库并保留；没有迁移既有库。

新增 [C4/A5 消费测试](../../apps/teaching/server/workspace/a5-consumption.test.ts)：三笔跨线程反馈得到范围版本 3、线程版本 1/1/2；许可内新增反馈后范围版本 4、线程版本 1/1/2/1；关闭并重开合成数据库，学生与教师恢复投影一致；用恢复的范围版本续写到 5 成功，旧 4 被 409 拒绝；用恢复条目的线程版本 1 提异议能定位该条正式反馈，范围版本保持 5。

第二项复用 A5 的旧提交快照反例，在本批当前集成基线重跑；不另写同义测试。其用例经历提交→反馈→许可→学生主动重开→同文件新版本，断言旧提交 `artifactSnapshotId`/`artifact` 不变，`workspaceFiles` 报新版本。

| 命令 | 实际结果 |
| --- | --- |
| `npm run typecheck`（批准 Node） | exit 0，包含新增消费测试与全部现有类型；[日志](evidence/a6-c-contract-consumption/typecheck.txt) |
| `node --test --test-concurrency=1 --test-reporter=tap server/workspace/a5-consumption.test.ts server/workspace/submissions.test.ts tests/a5-feedback.test.ts tests/a5-followup.test.ts`（`apps/teaching`） | exit 0，**32 通过、0 失败、0 跳过、0 取消**，约 62.3 秒；[TAP](evidence/a6-c-contract-consumption/targeted.tap.txt) |
| `node tools/a0-review/check.mjs` | 交付复查 exit 0，106 文档、1725 内链、`errors=[]`；[首次记录](evidence/a6-c-contract-consumption/docs-before.json)、[交付检查](evidence/a6-c-contract-consumption/docs-final.json) |
| `git diff --check` | 通过（exit 0） |

首次单独运行新增测试时，本地依赖 junction 建在了错误的相对目录，报 `ERR_MODULE_NOT_FOUND: zod`（用例尚未执行）；随后在正确的 `apps/teaching/node_modules` 复用原依赖，单项 1/1 通过。这是本次环境准备错误，未关闭检查或调整实现；多余的本地中间目录保留，不入提交。

首次交付文档检查因本记录先引用尚未生成的 `docs-final.json` 报一条 missing document；日志生成后复查通过（exit 0，`errors=[]`）。该失败属于本次证据生成顺序，非既有仓库失败，未调整检查规则。

### 3.3 未执行、接入边界与交接

正常 C 宿主 [i0.ts](../../apps/teaching/server/app/i0.ts) 和两课程宿主 [digital-logic.ts](../../apps/teaching/server/app/digital-logic.ts) 当前分别装配 workspace/tutoring 与 tutoring，均未调用 `createReviewApp`。A5 挂载是在其独立 review 应用工厂内；本批服务端接缝验证不能证明现场正常宿主已有 A5 路由或真实恢复反馈。后续由 A/C 按正常宿主与数据库组合授权接入，不在两项更名授权下擅自扩大表集合或修改现场库。

未执行：正常 HTTPS/生产宿主接入、真实节点/模型、浏览器、真人与教学效果、完整备份恢复/负载/复杂教师纠正。没有新建 UI；不宣布 A6/C5/P4 全面通过。A5 的其他未决产品项不在本批处理范围。

授权维护者汇总请求：TECH_DESIGN §4.3/§5.1 记录两个版本、恢复条目映射及审阅快照/当前工作区来源；MVP_SPEC §10 只记本批服务端复核结果及上述接入/未执行边界，不扩大产品验收。

回滚：本批只有版本语义注释、测试、任务与入口导航；需要撤回时按对应提交逆向恢复，删除/重置需另获授权。本批没有数据迁移需回滚。

首批本地交付：分支 `codex/a6-c-contract-consumption`、提交 `c4aa865`，仅提交本批写集。当时未推送、未合并、未发 Issue/PR 评论、未部署；后续负责人授权与公开交付见 §4。A5 原任务记录与其历史待办不覆盖，本记录提供当前消费复核结果。

## 4. 2026-10-14 PR 推送交付

负责人本轮明确指令“建立pr推送吧”，授权将本批分支推送并创建 PR，无需重复确认。已创建 [PR #71](https://github.com/paher-din/XunJie/pull/71)，目标 `main`，分支 `codex/a6-c-contract-consumption`；创建后核 `state=OPEN`、`isDraft=false`、`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`，远端 head 与本地 `c4aa86581d3f9cc6b03a9913816df62ad648513e` 完全一致。

常规 `git push` 报连接重置，单次禁用代理的重试报连接超时；GitHub API 可用，因此经 GitHub Git Database API 上传本地已提交 blob/tree/commit，并创建分支引用。每个 blob、完整 tree 与 commit SHA 均逐一核对与本地相同，没有改写提交内容或作者信息；未修改全局代理/凭据/配置。本文交付记录作为后续文档提交推送到同一 PR。

PR 正文记录版本映射、多线程/许可/重开/旧版本拒绝证据、32/32 专项结果，以及正常宿主/UI 尚未接入、未迁移数据库与未执行边界；不会自动关闭 #61。PR 已附加到当前 chat。未合并、未部署、未发布其他产物、未发 Issue/PR 评论；受保护基线仍待授权维护者汇总。

产品基线与 MVP_SPEC §10：待授权维护者汇总。
