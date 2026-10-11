# A3 教师 Agent、持久提案与显式采用

## 1. 依据、范围与状态

- 任务：[Issue #25](https://github.com/paher-din/XunJie/issues/25)，P2 父任务 [#24](https://github.com/paher-din/XunJie/issues/24)。
- 同步基线：`c42f356b6135ca9bb00c2e3c61c3d2aae713f602`（2026-10-11）；A2/C2 已合入。B1 #11 的真实 SDK/账号/模型调用及 D-02 仍未完成。
- 已读：[PRD](../product/PRD.md) §4.1、PRD-01/02；[MVP_SPEC](../product/MVP_SPEC.md) M-01/M-02、AC-01/02、NFR-04；[TECH_DESIGN](../product/TECH_DESIGN.md) §4.3/4.4/5/6.2/7.2.1/9；[TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) §6 A3；[G2](G2_OVERALL_COORDINATION.md)。
- 负责：`apps/teaching/contracts/design`、`server/design`、必要 A 调用方/数据库工厂、本人测试、README 和本文。B 生成核心与 C Job/Receipt/Event 使用既有公共接口；不改 B/C 公共字段和状态，不实现 B2/C3，不制作 UI。
- 当前状态：**§2–3 获准合成服务端已实现，专项25/25；已同步PR #29并修复组合阻塞；完整217项209通过/1既有C2平台失败/7跳过；真实模型/人工/UI未验收**。受保护文档只读，进度及契约补充 **待授权维护者汇总**。

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

## 9. PR #28 外部审查修复（2026-10-11）

读取审查固定点 `9d470940` 的两条 P2 意见（[实际用量](https://github.com/paher-din/XunJie/pull/28#discussion_r4241172685)、[输入预检](https://github.com/paher-din/XunJie/pull/28#discussion_r4241172687)），核对 PRD §4.1、MVP M-01/M-02、TECH §6.2/10.3 与 B 的 InputLimitError 语义。远端 main 新增的五个提交均为其他任务/协调文档，不引入其未合并实现，本修复保持原代码基线。

沿用已批准 §2–3 的 HTTP 登录、公共 worker、保留的真实合成库接缝及两张表，不扩展 schema 或 B/C 契约。先用超时实际 usage 反例验证，再修正原调用 accounting：以原 Job/generation/lease/调用槽核验身份，终态/停止/截止不阻止成本记录，但仍拒绝迟到正文。仅 InputLimitError 明确证明未发送时，在同事务安全撤销当前末尾调用预留；其他异常继续 unknown 保守占用。补停止后迟到、重启、已有已发送调用及 generation 恢复边界，保留持久三次上限。完整验证后更新本文及 README，进度待授权维护者汇总。

### 9.1 实现与中间验证

teacher-agent.ts 的原 provider 包装器已修正：实际 usage 只核验原 generation/lease/调用槽，不依据正文有效性跳过 accounting；progress 同事务保存原 Job（保留 status/stop/result）与 usage。InputLimitError 仅撤销同 lease、当前末槽、unknown 的未发送预留；之前实际/未知调用保持，其他异常继续占用。B/C 源码、接口、schema 和凭据无改动。

两条外部反例分别先失败（超时实际 usage 被记成 unknown；零 outbound 的 attemptCount=1）后通过。新增停止后迟到 usage、第二次预检仅退末槽、旧恢复代际拒绝三项也通过；A3 全部 **25通过、0失败、0跳过**，typecheck通过。完整回归及两轴复核正在执行，最终结果将在 §9.2 补齐；原 §6 统计保留历史事实。

### 9.2 本次实际验证

源码固定为 `ff2f7da13c1a404916852aef750de6de63389ad9`；Windows / Node24.21.0 / npm11.19.0 / TypeScript7.0.2。

- `npm run typecheck`：通过；`npm test` 的 pretest build：通过。
- `node --test tests/design-agent.test.ts`：**25通过、0失败、0跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-review-targeted.windows.txt)。
- `npm test`：**206项：198通过、1失败、7原条件跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-review-full.windows.txt)。全套状态为失败；唯一失败仍为 §6.1 已记录的 C2 Windows/Linux-only 初始化用例，与 `c42f356` 比对该测试与 RunControl 源码无差异。没有降低检查、增加跳过或改动 C 实现。
- 新增独立[本次证据清单](../../apps/teaching/tests/evidence/a3/acceptance.a3-review.evidence.json)，记录固定源码、命令、实际结果和新日志原字节 hash；原四份输出及原证据清单保持不变。

本次只修正两条审查发现的 A accounting 问题，之前已发送/usage缺失的保守 unknown、三次上限、45秒窗口与正文停止/版本/权限守卫均保留。真实 B1/D-02、教师内容会审、Linux复验、浏览器/TLS及完整 A3/G2 的原未完成条件不变，Issue #25 保持开放。基线进度仍待授权维护者汇总。

### 9.3 作者侧两轴自审与交付状态

**Standards：** 固定 `9d470940...ff2f7da` 增量复核，硬性违规0、可操作异味0；未扩大 schema/B/C/凭据/UI 或基线写入范围，真实接缝用例和文档记录一致。

**Spec：** 两条外部 P2 均已修复，未解决0，范围扩大0；原身份/代际的 accounting 与正文有效性分开核验，仅证明未发送的末槽预留可释放。复核只读，没有运行测试；实际结果以 §9.2 为准。

文档检查32份/402内部链接/27基线变更路径，errors=[]；检查器自测16/16通过；完整差异空白与保护范围检查通过。原四份日志及历史清单不变，本次两份新日志与本次清单逐字节核验。修复已普通推送同一 PR #28，并更新 PR 说明；回读远端代码/证据提交 `d25857fe82d041a0ed7c935db9bce60a6550d2bd` 与本地一致，PR仍Open。随后仅补本段交付事实。不代替审查者批准，不自动解决会话或合并，不关闭 #25。

## 10. 已合并 B1 新预检接缝适配（2026-10-11）

项目负责人要求解决[新复审](https://github.com/paher-din/XunJie/pull/28#pullrequestreview-5483718569)的组合 P2：A3 两条测试仍注入已被 PR #29 删除的 countTokens，组合树 typecheck 与这两条测试失败。已读取 PRD §4.1、MVP M-01/M-02、TECH §6.2/10.3、B1 §2.2/3/4 和新 providers 正文；远端 main `83e528e` 已合并 #29，当前 A3 同步提交 `161ffb3` 无源码冲突。

修复仅属 A 的已批准 HTTP/公共 worker/provider 接缝：首次用真实长输入触发 B 的保守16K预检，invoker合成替身不得被调用；第二次用明确在发送前抛 InputLimitError 的 ModelProvider 替身证明末槽释放且首次 actual 保留（不伪称两次实际 B 请求会自然改变长度）。继续使用真实会话/事务/新24表保留合成库，不扩展 schema，不修改 B/C 契约或凭据。规格不变，先复现组合失败再适配、专项及全套验证。

P3处理：复用现有 gate helper；注释说明租约/槽不匹配时有意以 STATE_CONFLICT 覆盖输入错误，防止释放不属于该调用的额度；§9.3 标清作者侧两轴自审与外部复核区别。releaseModelCall 是 C 共享状态机 API 提案，记录待 A/C 会审，不擅自新增或修改 C 公共接口。产品基线进度待授权维护者汇总。

组合反例已实际执行：typecheck 两处 TS2353，两个预检用例均失败（success / unavailable 与期望 needs_input 不符），原始输出单独保留，不覆盖旧证据。

### 10.1 已实现与验证中

两条预检反例各自复现失败后修复并单项通过；同步 #29 后类型检查通过。first preflight 通过真实 B createDeepSeekProvider 接收实际长输入，读取公开 InputLimitError.inputTokens >16000，同时合成 invoker=0；second preflight 使用外部 provider 替身两次预检、一次合成 outbound，验证 A 原调用计数=1/actual保留，没有依赖被移除的 countTokens。运行完整 A3 专项及最终组合回归中，最终数字在后续记录。

P3中的 helper、故意替换错误注释、自审标注已处理。releaseModelCall 仍是待 A/C 会审的公共 API 建议，本批不实现：应只撤销可证明未发送且身份/代际/末槽/unknown一致的预留，保留 Job 终态和已发送调用；不能仅因失败/取消/超时退 unknown，不能放宽3次上限。C 接纳该提案后由其负责接口及模块验证，A再消费。

先前 §6/§9 的 invoker/token counter 未完成是各自提交时点事实；PR #29 已提供实际 SDK适配源码及保守输入上界，已在本分支同步。真实供应商网络/账号/数据/付费与教师语义仍未执行，不能据此宣称 #11 或完整 A3/G2 完成。

本次红态原始断言输出含原生缩进空白行，绿色 typecheck 原始输出有结尾空行；按源码空白规则检查时确实报错。为保留逐字节证据，三份预检/typecheck终端记录以目录内精确文件名的 -diff 标识为不可改写证据附件，不转换换行、修剪输出或更改源码/测试空白规则。原有证据、其他日志、源码与文档检查保持；失败输出仍入库并在清单核验字节/hash，实际红态不改成通过。

### 10.2 组合实际验证

源码固定 `803c10efd61824401a7ac0a9f69a6e7dada99da3`，同步基线 `161ffb3` 含 main `83e528e` / 已合并 PR #29，Windows / Node24.21.0 / npm11.19.0 / TypeScript7.0.2。

| 检查 | 实际结果 |
| --- | --- |
| 适配前 `npm run typecheck` | 失败，两处 TS2353；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-b1-compat-typecheck-red.windows.txt) |
| 适配前两条预检反例 | 0通过、2失败、0跳过；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-b1-compat-red.windows.txt) |
| 适配后 `npm run typecheck` | 通过；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-b1-compat-typecheck.windows.txt) |
| 适配后 `node --test tests/design-agent.test.ts` | **25通过、0失败、0跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-b1-compat-targeted.windows.txt) |
| 适配后 `npm test` / pretest build | build通过；**217项：209通过、1失败、7原条件跳过**；[原始输出](../../apps/teaching/tests/evidence/a3/acceptance.a3-b1-compat-full.windows.txt)；全套未通过 |

唯一失败仍是原 C2 `server/workspace/review.test.ts:118` 在 Windows 初始化 Linux-only RunControl，错误发生于 A 应用 fixture 前；同步后的 C 测试/控制器无本次改动。没有新增跳过或关闭运行/类型检查。原 §6/§9 统计和六份历史原始输出继续保留；五份新记录有独立[证据清单](../../apps/teaching/tests/evidence/a3/acceptance.a3-b1-compat.evidence.json)。仅合成 invoker/provider，无付费或供应商网络调用，测试库保留。

两条组合阻塞反例已恢复有效，真实模型/D-02、教师会审、Linux复验及浏览器/TLS的未执行条件保持。C releaseModelCall 待会审，不扩大共享接口；产品进度待授权维护者汇总。

### 10.3 作者侧两轴自审与交付

**Standards：** 固定同步提交 `161ffb3...803c10e` 增量自审，硬性违规0、可操作异味0。仅三份精确原生终端附件标为 -diff 保留字节，源码/测试规则及历史证据不变。

**Spec：** 未解决0、范围扩大0，两条测试分别证明实际新 B 预检与合成 provider 第二次预检的 A 记账边界，C 公共 API 仍为待会审提案。以上为作者侧两轴自审，不代替外部审查者批准；审查仅只读，实际执行结果见 §10.2。

文档检查33份/429内部链接/27基线路径，errors=[]；检查器自测16/16。全部11份已暂存原始记录与三个清单的 SHA-256/字节数一致，保护范围和空白检查通过。原独立副本 typecheck-a12-current.log 未暂存，主副本原有改动未触碰。本批将更新原 PR #28，由原审查者复审；不自动解决其意见、不合并、不关闭 #25。共享 releaseModelCall 提案等待 A/C 会审，真实模型/人工/UI及完整产品的未完成条件保留。
