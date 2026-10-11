# A3 教师 Agent、持久提案与显式采用

## 1. 依据、范围与状态

- 任务：[Issue #25](https://github.com/paher-din/XunJie/issues/25)，P2 父任务 [#24](https://github.com/paher-din/XunJie/issues/24)。
- 同步基线：`c42f356b6135ca9bb00c2e3c61c3d2aae713f602`（2026-10-11）；A2/C2 已合入。B1 #11 的真实 SDK/账号/模型调用及 D-02 仍未完成。
- 已读：[PRD](../product/PRD.md) §4.1、PRD-01/02；[MVP_SPEC](../product/MVP_SPEC.md) M-01/M-02、AC-01/02、NFR-04；[TECH_DESIGN](../product/TECH_DESIGN.md) §4.3/4.4/5/6.2/7.2.1/9；[TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) §6 A3；[G2](G2_OVERALL_COORDINATION.md)。
- 负责：`apps/teaching/contracts/design`、`server/design`、必要 A 调用方/数据库工厂、本人测试、README 和本文。B 生成核心与 C Job/Receipt/Event 使用既有公共接口；不改 B/C 公共字段和状态，不实现 B2/C3，不制作 UI。
- 当前状态：**§2–3 获准合成服务端已实现，专项20/20；完整回归保留1项已有C2平台失败；真实模型/人工/UI未验收**。受保护文档只读，进度及契约补充 **待授权维护者汇总**。

## 2. 实施提案（2026-10-11 获批）

### 2.1 HTTP 与采用

保持 A 的登录/CSRF/课程授权、Idempotency-Key、recoveryGeneration 和短事务。

1. 扩展 `POST /api/courses/:id/blueprints` 的 `mode=agent`：输入 generationMode=candidates/blueprint、request、教师选择的 references；返回持久 Job 回执，不创建草稿。manual/copy 保持原行为。
2. `POST /api/blueprints/:id/proposals`：输入 expectedRevision、mode=patch/blueprint、request、references、allowedFields；受理时保存完整 baseRevision/草稿快照。局部输出限于教师指定的字段。
3. `POST /api/blueprints/:id/rubric-trials`：输入 expectedRevision、request、references 与非空 sampleReferenceIds。样本必须是显式准许教师设计使用的课程资料段落，记录量规试评与歧义，不创建学生 Attempt、观察、运行或评价。
4. `GET /api/jobs/:id`、`POST /api/jobs/:id/cancel`：只处理本 A3 教师设计 Job；当前教师会话与原发起者、课程归属均复核。保留终态及原结果，停止意图/事件/回执同事务。未来通用 Job 路由由维护者统一分发，不抢占其他 purpose。
5. `GET /api/design-proposals/:id`：教师读取提案、baseRevision、diff、rationale、affectedReferences、原结果引用及结果 hash。适用性依据当前 revision/Job stop/generation 动态判断。
6. `POST /api/design-proposals/:id/adopt`：仅无现有蓝图的 candidates/blueprint 提案；教师显式选择 candidateIndex 或确认 blueprint，再以现有 createStoredDraft 创建可编辑草稿。可带教师确认的结构化 content；同键回放原草稿。
7. 扩展既有 `PATCH /api/blueprints/:id` 的可选 proposalId：仍由教师提交明确 patch 和 expectedRevision，复用 patchStoredDraft/CAS。提案必须同课程、同蓝图、同 baseRevision，未取消且当前 generation；patch 不超出已批准的 allowedFields。量规试评只授权 rubricCriteria 的显式修改。无 proposalId 的手动编辑照旧。

references 每项只接受 resourceVersionId/paragraphId/contentHash；服务端读取资料正文、可见性和 teacherDesignAllowed，生成稳定引用 ID。请求体不能指定 role/studentId/purpose/authorizedReferenceIds/预算/模型配置。使用教师明确授权的私有资料是教师设计权限，不赋予学生或 student_help 权限。

B 的候选/blueprint 使用文字数组，A 的能力/任务/观察/量规是版本化结构。提案完整保留这些建议和 unresolved；采用时只自动映射教师选择的 problem/audience/artifact/routes 与获准资源，结构化能力、任务、量规等由教师明确确认，不能替模型补造能力领域、证据关联或可发布状态。草稿允许缺项，由现有确定性检查报告缺口。

### 2.2 持久数据（仅批准新临时合成库）

现有 22 表 workspace 合成库没有教师请求或提案存储。提案需要跨重启查阅、不可变结果比对和与 Job/回执/审计同事务落库；不使用学生运行表或回执正文冒充独立提案存储。

新增独立 `createTeacherDesignDatabase()`，**仅创建全新临时合成 SQLite 数据库，共 24 表**：既有 22 表 + 以下 2 表。旧工厂不改变 schema，不迁移或修改已有/生产数据库；测试库保留。

- `teacher_design_requests`：job_id 主键/外键 jobs；course_id、actor_id 外键；blueprint_id 可空；base_revision；request_json 保存已验证输入、草稿和授权段落快照、服务端版本；预算许可由当前服务端钩子逐次复核；usage_json 保存按调用预留的 actual/unknown usage。Job.attemptCount 复用 C recordModelCall，调用前持久预留 unknown，收到实际 usage 才更新，不把 unknown 算作 0。
- `teacher_design_proposals`：proposal_id 主键；job_id 唯一/外键请求；course_id、blueprint_id、base_revision；result_hash；proposal_json 保存规范化提案/diff/理由/影响引用/原始结果引用；raw_result_json 保存 B 合法 body 首次序列化的原 UTF-8 JSON 正文字节；B 的调用/usage/版本保存在 proposal_json.modelResult，不保存 provider 附加字段或内部思维链；created_at_ms。JSON、revision、hash 长度及关联约束在 SQL/读取校验两层检查。

不新增队列表、重写 C Receipt/Job 或自动迁移入口。若之后需要正式数据库接入，另行评审授权。

### 2.3 异步调用与事务

- 提交事务只认证/校验/写请求、Job、回执、事件；B generateTeacherProposal/provider 在事务外运行。
- A 提供可信 worker 接缝 processJob 和结果接收；C claimJob/recordModelCall/finishJob/cancelJob/recoverJob 决定原 Job 状态。受理起 45 秒和同 Job 最多 3 次覆盖排队、修复和重启，换 worker 不重置。
- 每次调用和接收结果均复核原发起者启用状态/教师课程归属、generation、stop、lease、deadline、baseRevision 与授权资料 hash/用途。过期 lease 不重新调用，原任务变 outcome_unknown/超时；安全人工新请求保持新 Job。
- 当前草稿变更会令旧请求失效，不把旧结果覆盖新 revision；已保存旧提案可读并标记不可采用。
- 同 Job/结果 hash 重复投递回放原 proposalId；不同结果冲突。结果、提案、Job 终态、回执/事件在一个真实事务内提交，失败全部回滚。
- 模型失败、取消、超时或预算拒绝不阻断既有手动创建/保存。
- provider/版本/预算钩子仅由服务端注入。只接合成 provider，不读取凭据、发起真实付费调用或宣称 B1 完成。

## 3. 验证接缝与顺序（2026-10-11 获批）

沿用真实 Fastify app.inject 登录/CSRF 业务边界 + 新建合成 SQLite + 公共 worker processJob/结果接收接缝；不 mock 数据库、授权、事务或业务检查。SyntheticProvider 只替代外部模型。每条用例经过公开业务接口观察，重启重新打开保留库，失败注入位于数据库能力边界。

先逐条红→绿实现，再类型检查/构建、A3 专项及最终一次全套回归；最后并行标准/规格审查。

- 候选 1～3 →教师选择→草稿、blueprint、本地 patch、量规试评 →教师明确 PATCH；未齐机器配置可生成且不能直接发布。
- 手动编辑保留、旧 revision 拒绝采用、同键同载荷回放/冲突、同 Job 同/不同结果、取消/超时/迟到/恢复 generation。
- 学生/跨课程/非发起者拒绝、未批准资料/错误段落/hash/样本/模型扩权拒绝；私有资料不进入学生读取或学生记录。
- 并发 worker/失效 lease、3 次调用持久预算/unknown usage、45 秒覆盖排队、模型调用不占事务、结果保存失败原子回滚及重启可读。
- 现有 AC-01 确定性检查、量规/关联 traceability 回归。

## 4. 门禁与待完成

新增 schema、§2 的 A3 契约补充和 §3 的测试接缝已获项目负责人明确批准，准确范围与原答复见 §5。依据 [AGENTS.md](../../AGENTS.md) 的红线及保护规则，本批准不授权其他数据库、生产或基线写入。

真实模型调用、D-02 配额/数据许可、教师内容会审、浏览器/TLS 与完整 G2/G1：**未执行**。A3 服务端合成验证不能替代这些完成条件。本文方案不自行变成正式产品基线。


## 5. 已批准范围与当前实施记录

2026-10-11，项目负责人对 §2–3 的具体范围答复“批准该范围并继续”：24 表全新临时合成库、上述 A3 接口与真实 HTTP/公共 worker/事务测试获准。批准不延伸到现有数据库迁移、受保护基线写入、真实凭据/付费/数据、B/C 契约或 UI。

当前已实现四种生成模式、持久请求/提案、教师采用、量规试评、原回执/结果重放及预算/取消/版本/课程权限守卫，最终验证和审查结果见 §6。代码位置：

- `apps/teaching/contracts/design/proposals.ts`：A3 严格输入与提案 body；沿用 B 的四种输出结构。
- `apps/teaching/server/design/teacher-agent.ts`：A 会话路由、事务外 B 核心、C Job 生命周期、持久调用预留、结果同事务提交、显式采用。
- `apps/teaching/server/design/teacher-storage.ts`、`teacher-schema.ts`：A 拥有的请求/提案存储。
- `apps/teaching/server/db/transaction.ts`：独立 `createTeacherDesignDatabase`，仅新建临时 24 表；旧工厂不迁移。
- `apps/teaching/server/design/app.ts`：可选 `teacherAgent` 装配、agent 创建及带 proposalId 的原 PATCH；不改变既有未装配宿主。
- `apps/teaching/tests/design-agent.test.ts`：真实登录、app.inject、真实保留库及公共 worker。

服务端注入 teacherAgent={provider, versions, budgetAvailable}；预算钩子只接受服务端构造的 courseId/actorId/持久 usages，必须同步返回 boolean。没有预设正式配额、金额或真实 provider。业务宿主显式驱动 processJob，不新增后台监听或私自启动真实模型。公共结果接收 receiveResult 只供受信 worker，HTTP 不接受模型结果或 leaseToken。

持久 raw_result_json 保存 **B 合法 body 首次序列化的原 UTF-8 JSON 正文字节**；模型调用数、elapsedMs、usage 和版本在 proposal_json.modelResult 保存。worker 在拿到 B 对象后只序列化一次并把 bodyJson 纳入受信 delivery，接收端校验其合法结构与 B body 一致，直接对 bodyJson 字节计算 SHA-256 并原样保存。读取同时核验原字节摘要和解析 body 的对应关系，不对重排/重序列化的正文计算“原结果 hash”。rawResultRef 对应同库原 B 正文；同 Job 同摘要回放保留原版本/usage/提案 ID，不用重复投递改写。这里的原正文是 B 公共对象边界的首次持久序列化，不伪称上游 provider 的原始 HTTP 响应。B 的 candidates/blueprint/rubric_trial 没有独立 rationale 字段，A 保留为空表示原输出未提供；patch 原理由原样保存，不为模型补造解释。结构化 diff 中 suggestions.* 表示文字建议，不是可自动执行的 contentPatch。

结果落库失败时，worker 抛 TeacherResultCommitError，并仅向受信宿主附带原 delivery；宿主可在原 lease/deadline/generation 下调用 receiveResult 重试，不能重新付费生成。宿主丢失原 delivery 或 lease 过期时不能安全重发模型请求，C recoverJob 标记 outcome_unknown；由教师明确发起新请求。预算/失败不影响手动草稿。

验证进展：A3 专项前 14 项通过；新增事务回滚、原结果重试、教师撤权、预算撤回、模型故障专项 4/4 通过；typecheck 通过。这些为当时中间记录；最终全套、文档检查和两轴审查已执行，准确结果见 §6。最初候选/局部路由缺失、取消未即时结束、蓝图 diff 缺失及扩字段拒绝未收口到 Job 失败由用例揭示，已修正并复验；不将早期失败统计为最终通过。

待授权维护者汇总：MVP_SPEC §10、TECH_DESIGN 的 A3 请求/采用 DTO 和原结果接缝，以及 TEAM 当前交接状态。本文仅保存已批准任务实现与证据，不写入受保护目录。

## 6. 最终验证与审查（2026-10-11）

获准合成服务端范围已实现并验证，代码提交 `b2a9f8efb3d32dbf6bde9c640578c50553c69666`（前置实现 `c2ac727`）。没有完成真实模型、教师会审或浏览器/TLS；Issue #25 保持开放，不以合成结果自动关闭。

### 6.1 实际执行结果

工具环境：Windows、Node 24.21.0、npm 11.19.0、TypeScript 7.0.2。所有 A3 数据为合成，测试临时库全部保留。没有运行真实网络模型/SSH、没有初始化真实账号或生产迁移。

| 命令（apps/teaching，文档检查在根目录） | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过（最新代码含 A/B/C 全部 TypeScript）；未关闭或修改类型检查 |
| `npm run build` / `npm test` 的 pretest build | 通过；默认启动行为保持健康入口 |
| `node --test tests/design-agent.test.ts` | **20 通过、0 失败、0 跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-targeted.windows.txt) |
| 首轮 `npm test` | **199 项：191 通过、1 失败、7 跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-synthetic.windows.txt) |
| 时间/字节审查修复后 `npm test` | **201 项：193 通过、1 失败、7 跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-synthetic.final.windows.txt)；完整回归状态为失败，不能宣称全量通过 |
| `node --test --test-name-pattern='real RunControl preparation' server/workspace/review.test.ts` | **1 失败**；[单项复现](../../apps/teaching/tests/evidence/a3/acceptance.preexisting-c2-windows.txt) |
| `node tools/a0-review/check.mjs` | 通过；32 份文档、398 内部链接（首轮393，收口新增证据链接后398）、27 基线变更路径、errors=[]；此静态工具的 businessTests=NOT_EXECUTED 指它不执行业务测试，不覆盖本表真实业务结果 |
| `node --test tools/a0-review/check.test.mjs` | 16/16 通过 |
| `git diff --check` / 保护范围及远程基线检查 | 通过；未改 product/planning/reference/AGENTS、B/C 公共契约、凭据/CI/UI；原主副本未提交文件和独立工作副本旧 log 保留 |

唯一全套失败是基线已有 `server/workspace/review.test.ts:118` 的真实 RunControl 准备失败用例：在 Windows 调用 C 的 Linux-only 构造器，初始化时即被 `runner/control.ts:48` 拒绝，发生于 A 应用 fixture 启动之前。两文件与同步基线 `c42f356` 无差异，独立用例复现同一 INVALID_CONFIGURATION；A3 的20项均通过。没有改 C 源码、增加 skip、屏蔽失败或重跑统计伪称通过。现有 Linux/真实节点条件跳过保持事实；本机 WSL Ubuntu 无 Linux Node 运行时，未执行 Linux 复验。需 C/受信 Linux 环境复跑原检查，并与 #23 环境稳定性单独交接。

证据文件逐字节保存，目录内 .gitattributes 禁止换行转换；[证据清单](../../apps/teaching/tests/evidence/a3/acceptance.a3.evidence.json) 记录文件 SHA-256、命令、源码、结果和验收边界，不包含凭据。

### 6.2 两轴审查

#### Standards

首轮硬性问题 1 项，可操作异味 0 项：acceptedAt/deadline 分别取时，可能超过45秒。修复为一次 acceptedAtMs 加45000，递增时钟用例先失败后通过。增量复核：该 P2 已关闭，当前新增硬性违规0、可操作异味0。审查只读，审查方未运行测试。

#### Spec

首轮问题 2 项，未发现范围扩大：上述时间边界，以及结果摘要未对应持久原 JSON 字节。原正文修复为 delivery.bodyJson 首次序列化并原样保存、直接 UTF-8 SHA-256、读时核验原字节及 body 关联；正文换行变化亦冲突，原版本/usage/提案 ID 重放不重写。两个反例先失败，再修复，连同原结果冲突/commit重试专项4/4通过。增量复核：两项均关闭，新增未解决规格问题0。审查方未运行测试，实际结果以 §6.1 为准。

两轴分别收口：Standards 0 未解决；Spec 0 未解决。全套唯一既有 C2 平台失败仍保留。

## 7. 后续交接与完成边界

- A 的获准合成业务已交付：异步候选/蓝图/局部提案/量规试评、显式选择/PATCH-CAS、请求与原结果幂等、权限/资料/版本/停止/代际/租约/预算、短事务和回滚。
- B1/#11 与 D-02：仍需真实 invoker/token counter、获准账号/API/配额/数据与实际模型联调；没有调用真实模型，本交付不完成这些前置条件。
- 教师内容会审：候选适切性、量规歧义及教学意义仍未验证；B 候选文字不能直接替代 A 的三条版本化能力与证据关联，确认内容后现有确定性检查仍会报告缺口。
- C：复用原 Job 公共状态和事务计划，未改 C 控制器；上述 Windows 用例需其受信 Linux 环境验收。
- UI/#22、G2/#24：使用上述公共路由接实际界面，浏览器/TLS/人工以及完整 G1/G2/MVP 均未完成。
- 基线同步：本文及 README 是当前任务交付；MVP_SPEC §10、TECH/TEAM 对应 DTO/状态 **待授权维护者汇总**，不擅自修改。

PR 仅引用 #25，不使用 Closes #25，不合并/部署或删除源分支。最终 PR 链接和推送核验将在交付记录中补齐。

## 8. PR 交付

- 分支 `codex/a3-teacher-design-agent` 已普通推送，交付 [PR #28](https://github.com/paher-din/XunJie/pull/28)（Open，base=main）；已附加到 A 工作项。未合并、未关闭 Issue #25、未删除源分支。
- 创建 PR 时远端 head 为 `afbe070c5ba6e7ca660ef2382094c32dc545781a`，代码验证对应 `b2a9f8e`；其后仅补本文交付状态，不改变已验证源码。
- README、本文和四份原字节输出/证据 JSON 同任务提交；四份已暂存证据的 SHA-256 与长度均与清单一致。
- 原 Windows CRLF 字节通过目录 .gitattributes 的 -text 保留；日志路径仍启用 blank-at-eol、blank-at-eof、space-before-tab，另识别 cr-at-eol。初次原字节日志以默认行尾规则检查时将 CR 误报为末尾空白，调整为正确识别保留的 CRLF 后全差异检查通过；没有改写原日志，也没有关闭源码/文档空白检查。
- 主工作副本原有 README/product/planning/A_WORK_PLAN 未提交改动保持原状；独立副本旧 typecheck-a12-current.log 未暂存或提交。
