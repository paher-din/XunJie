# A4：有效学习状态、异议与教师纠正事务

日期：2026-10-12（Asia/Shanghai）。主责：A；对应 [Issue #41](https://github.com/paher-din/XunJie/issues/41)。状态：2026-10-12 负责人已批准 §2～6 的具体实施、fresh-only 31 表与公共测试接缝；已完成获准服务端批次和两轴代码审查；最新专项 43/43 与类型/构建通过，全量仍有 1 个既有 Windows/Linux 环境失败；2026-10-13 最终结果见 §11，历史记录保留在 §8.3；不宣称完整产品验收。DL-A 前置准备见 [DL-A](DL-A_COURSE_BUSINESS_INTEGRATION.md)，等待 DL 批次时可推进本任务独立部分。

## 1. 基线、范围与现有接缝

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按 [PRD](../product/PRD.md) §4.3/5/6/8（PRD-06/07/08/09/10）→ [MVP_SPEC](../product/MVP_SPEC.md) M-06/08/09、AC-07/08/16、§4 → [TECH_DESIGN](../product/TECH_DESIGN.md) §4.1～4.4/5/7.1～7.2.1 的正文核对；分工依据 [TEAM](../planning/TEAM_WORK_PLAN.md) §7/10.1，C3 的已交接缝见 [C3 §4.1/11/13](C3_TEACHING_MESSAGES_RECEIPTS.md#41-b2--a4-的同事务入口)。

固定基线为 `origin/main=a4e54c70734ce37aca24feac6d106ea7d9f21b2d`。原 A1/A2 授权、固定活动/成员/目标版本、命令回执和 C2 原事实可复用；C3 已交 `invalidateTeachingInTransaction(tx, …)`，能同事务保存 Attempt JSON/epoch/revision、相关教学/分析 Job、未展示 Action 的失效及原因事件。普通 Run/快照不被此接口抹除，已显示帮助保留并标 basisRevised。

编码前尚无 A 的持久 LearnerStateRevision、TeacherDecision、自述/异议或 C 原分析表；B2 的 PreparationOptions 目前由调用方传 learnerStateRevision/learnerClaims，尚未自动读 A 的真实状态。本任务不得把客户端、候选 body 或任意调用方提供的 stateRevision 当有效状态。

| 预计可写 | 必要改动 |
| --- | --- |
| 本文、README | 本人提案/真实进度、任务导航/调用与验证入口 |
| `apps/teaching/contracts/review/`（新） | 自述/确切主张、教师决定/异议、候选信封/接纳结果和公共能力类型；版本与权限沿现有基线 |
| `apps/teaching/server/review/`（新） | 同事务有效投影、依据展开与守卫、授权 HTTP 组合和 B3 受控提交/查询能力 |
| `apps/teaching/server/db/review-schema.ts`（新）、`transaction.ts` | 仅新增独立 fresh review 工厂及下表五张表；旧工厂/旧数据库不变 |
| `apps/teaching/server/records/analysis.ts`（新）、`records/application.ts` / `records/teaching.ts`（最小同事务守卫接缝） | C 原分析/拒绝原因的同 tx 保存和原 Job/hash 重放；教学最终接纳/重投前的可选同 tx 状态版本读取守卫；A 汇总并交 C 审查 |
| `apps/teaching/server/tutoring/application.ts` | 最小集成：可选受信同 Transaction 状态读取能力；装配时覆盖任意 PreparationOptions 状态注入；不改 B 教学策略/模型格式 |
| `apps/teaching/tests/review*.test.ts`（新） | 下列批准后的公共 HTTP/worker/读取接缝和真实事务验证 |

product/planning/reference/AGENTS、他人任务稿只读；不改 UI、依赖/锁、凭据/CI、原 C 运行配置，不做 B3 候选分析或 C4 作品恢复，不发真实模型请求。基线写入与具体 schema 授权分别登记，本文本身不授权实施。

## 2. 分层模型与五表 fresh-only 提案

现有 Teaching 工厂共 26 表：Access 5 + Design 5 + Completion 7 + Workspace 5 + Teaching 4。提出 `createReviewDatabase()` 在全新系统临时 `xunjie-a12-completion-*/synthetic.sqlite` 初始化这 26 表及以下 5 表，共 **31 表**；沿既有安全路径、外键、WAL/FULL、同步 BEGIN IMMEDIATE 和禁止回调 DDL 的规则。旧 Access/Design/Completion/Workspace/TeacherDesign/Teaching 工厂不扩表，本批不加入 A3 两表；若后续正常共同宿主需要组合，另列准确范围，不在本批自动迁移。

| 新表 | 独立列/约束与 JSON 内容 | 语义 |
| --- | --- | --- |
| `learner_context_revisions` | course_id/student_id/context_revision 复合主键，账号/课程外键、revision>0、actor_id/created_at、context_json；按课程/学生读取最新版本 | 本人 goals/constraints 自述，预期首次 0；不是能力判断或原观察 |
| `learner_state_revisions` | course_id/student_id/state_revision 复合主键，revision>0、source_kind/source_id、created_at/state_json；按课程/学生读取最大 revision | 追加有效状态与依据失效标记；从未建立为 0，清空/撤回也递增不重置 |
| `teacher_decisions` | decision_id 主键、course_id/student_id/attempt_id、teacher_id、expected_state_revision/result_state_revision、decision_json、created_at；课程/账号/Attempt 外键 | 可信教师的确认/纠正/暂缓、确切目标版本、理由/引用；不覆盖旧决定，不补造事实 |
| `learner_disputes` | dispute_id 主键、course_id/student_id/attempt_id、target_kind/id/revision、dispute_json、created_at；相关外键 | 本人异议，保留历史目标/理由与本次是否改变投影；不覆盖新判断 |
| `analysis_results` | analysis_id 主键、job_id 唯一外键、course_id/student_id/attempt_id、raw_body_text 原文 TEXT（不要求合法 JSON）、result_hash、disposition/reason、result_json、created_at；hash 长度约束，json_valid 只用于结构化 result_json | C 原候选分析及接受/拒绝事实；同原 Job/hash 返回原 IDs，异结果冲突；无有效状态不强制伪造 revision |

各表只存合成数据；原观察仍从 C2 快照/Run/过程/覆盖及 C3 Message/Action/Receipt 读取，不创建另一份虚构 Observation。审计/回执沿已有表，在本次业务事务中引用新对象 ID，不包含私有正文、凭据或 leaseToken。保留全部测试库，不清理目录，不操作现有/生产库。

主张保留 claimId+claimRevision、competencyId+competencyVersion+domain、courseId/studentId、course 或 activity 的 applicability scope、statement、state、validity、evidenceIds/counterEvidenceIds、assistanceStatus、unresolved、estimatorVersion/analysisVersion。三条能力线独立，state 使用 insufficient/supported_with_assistance/supported_in_check/conflicting；validity 使用 active/contested/superseded/withdrawn；帮助条件使用 observed_help/none_observed_in_system/unknown。不增加掌握率或把 none_observed_in_system 写成没有外部帮助。

## 3. 受控接口与最小共享差异提案

| 公共入口 | 输入/行为 | 权限及并发 |
| --- | --- | --- |
| `PATCH /api/courses/:id/my-context`（既有批准路由，本批实现） | expectedContextRevision、个人 goals/constraints，自述追加版本；相关教学上下文失效 | 当前学生角色/本人；不接受 role/studentId/能力/教师字段；首次 0；幂等回执 |
| `GET /api/courses/:id/my-context`（新增只读提案） | 本人当前自述及 contextRevision | 当前课程学生；教师通过受控复核读取关联自述，无跨学生 GET 参数提权 |
| `GET /api/attempts/:id/learner-state`（新增只读提案） | learnerStateRevision、当前范围的确切主张、分层自述/判定引用；不可见或旧底层引用逐项 references.status=unavailable / basisAvailable=false，不补正文；B2 不消费此类主张 | 所属学生或任课教师，按固定活动目标/适用 scope 裁剪；原始未接纳模型正文不发给学生 |
| `POST /api/attempts/:id/disputes`（既有批准路由，本批实现） | targetRef=确切 claim/feedback 版本、reason，当前目标另核 expectedStateRevision；当前 basis contested 并传播依赖，历史异议仅追加 | 所属学生；不能修改教师决定/作品。Feedback 解析走 A5 受信 resolver 接缝，未落地对象返回 INVALID_REFERENCE，不虚构正式反馈 |
| `POST /api/attempts/:id/reviews`（既有批准路由，本批实现） | expectedStateRevision、确切 claimRef，confirm/correct/defer、reason/获准 evidence；correct 可撤回或给经核验 replacement | 任课教师；学生即使请求 body 带 teacher 也拒绝；新状态/决定/C3 失效/事件/回执同事务 |
| `review.readCurrentInTransaction(tx, scope)` | 真实最新 stateRevision、适用主张/依据有效性，给 B3/B2/A5/C4 | 非浏览器任意 scope 入口；宿主先经过 A 当前授权，服务再核课程/学生/目标/范围 |
| `review.queueAnalysis/claimAnalysis/completeAnalysis`（受信服务能力提案） | 原显式/被动分析 Job、有界 lease、固定活动/政策/版本/输入 refs；最终 exact bodyJson、leaseToken、generation | 不新增模型或浏览器发布正式评价的工具；作用域从已授权原 Job/Attempt 反查，B 只产生 body |
| B2 `studentHelp.readLearnerState(tx, scope)`（可选同 tx 能力提案） | 读取 A 的有效投影；初始授权、运行中 guard、最终接纳事务与重投前守卫四处使用真实 revision/claims | 工厂未装配仍沿已有 0/无历史；装配后 preparation/runtime 的手工 stateRevision 不能覆盖；C3 接纳/重投同 tx 回调比较 basis.relatedStateRevision 与真实 A 版本，旧帮助归档为 stale 且不可投递；原 Job/hash 重放仍返回原 IDs |

HTTP 输入严格结构验证；身份来自当前 Session 与课程成员，course/student/Attempt 不由候选 body 决定。教师 reviews 使用任课教师课程授权，不能扩大 Access 的 student_work 写权限去允许教师编辑作品。均保留 Origin/CSRF/Secure Cookie、错误信封和命令摘要/CAS规则；网络通知/取消在提交后，事务中无 await 或外部调用。

所需引用提案使用 kind+原对象 ID+确切版本/Attempt 定位（snapshot/run/message/action/coverage/context/claim/teacher_decision）；课程材料沿现有 ObjectRef 的 resourceVersionId/paragraphId。持久原 Job 输入列出获准描述符，body 的 evidenceIds/反证必须是此集合的子集；不把随机字符串、hash、私有验证资产或模型总结当原事实。Claim 只指 fixed Activity 中的目标版本，课程 scope 也不能借同名 ID 换目标语义。

## 4. 候选接纳与依据防复活

1. 受控分析排队先在真实授权/固定活动下冻结本次 learnerStateRevision、decisionEpoch、context/captureRevision、collectionPurpose、模型/提示/schema/analysis 版本、获准输入/帮助/覆盖引用；保留原 Job 的 expectedRevision、deadline 和用途。被动分析在采集暂停时不得排队；显式分析也不能解除 Attempt/Assignment 暂停或限定帮助政策。
2. 完成时从原 Job/Receipt 取 scope 和绑定，核原 purpose、停止/终态、即时 membership/可用性、leaseToken/leaseUntil、deadline、恢复 generation、固定活动/政策、expectedStateRevision/epoch 和原输入引用的范围/版本。B 仅交 bodyJson；SHA-256 对实际持久 UTF-8 原文字节计算，不重序列化后冒称原 hash。
3. 同一短事务保存 C 原分析/接受或拒绝 reason 与原 Job 结果，原文使用不受 json_valid 约束的 raw_body_text，非法 JSON 也保存原 UTF-8 hash 与拒绝原因；结构化 result_json 独立验证。接受才追加 A 新 LearnerStateRevision/候选 IDs；拒绝是可核查事实而不是先抛错回滚掉拒绝记录。无效结构/引用不进入学生投影。已完成同 Job/hash 返回原 analysisId/claimIds/revision/处置，无再次接纳；异 hash 返回 IDEMPOTENCY_CONFLICT，保留原结果。
4. 主张与教师判断引用解析到最底层原依据并保留依赖；新的 decisionId 不能成为独立观察，旧判断依据变更后不能继续作为当前依据。固定快照的依据指纹按同 Attempt 的文件路径/实际内容 hash 归一，重复 snapshotId 或仅改变 documentVersion 不产生不同原依据；原精确 snapshotId/版本仍作为 refs 保留。教师纠正/学生当前异议在新状态中标记确切依据的 invalidity；相关派生主张 contested/superseded/withdrawn，留理由与原 ID。新 claimId、措辞或 analysisVersion 仍引用同一被撤回/争议依据时拒绝接纳，不能只检查旧 claimId。真正不同的新获准依据可另提出候选，不无限封禁整个目标。
5. 同一 Attempt 的观察作为一组，重复运行或模型摘要不产生额外独立证明；Run 依据按该 Attempt 的固定作品内容、输入文件的实际路径/内容顺序、入口路径/模式/规则/指纹与实际输出/逐项判据归一，排除新 Run/命令 ID、时长和仅展示元数据；归一结果只存 hash，不把私有检查正文带入状态；帮助/空窗/工具故障/矛盾/unknown 保留，工具失败不推出知识错误，self-report 不自动成为 supported 主张。`supported_in_check` 要有真实匹配课程检查依据，stdout/exit=0 或自述不替代可信判据；匹配固定规则/validator 版本、预期 case 数与确切 Run/快照/input/image 的 trusted_validator 逐项结果，裸 verdict 不充分；帮助状态不因新分析被抹成独立掌握。

## 5. 教师纠正、自述与学生异议事务

教师命令先在当前事务重查任课教师权限、expectedStateRevision 和 exact claimRevision；构造新 decisionId，追加 reason/evidence/目标、必要 replacement 和新状态。无新证据时只能改判断/有效性，不补造观察。confirm/defer 也保留可回查决定，任何有效状态改变均单调递增 revision。

纠正/当前异议将同课程同学生的相关 Attempt 保守全部纳入失效范围，读取当前 expectedEpochs，再调用现有 `invalidateTeachingInTransaction`。教师决定/异议、新投影、所有相关 epoch/Attempt JSON、教学与分析 Job/未展示 Action、事件/命令回执一并提交；任一步失败全部回滚。普通 student_run/teacher_sample 与固定快照/原输出仍是事实；已显示帮助保留实际回执，并标依据后来修订，不重投。

自述变化使用 contextRevision CAS，保留旧内容和当前作者；影响教学上下文时调用同事务失效，不能把“新目标/约束”改为能力结论。历史目标异议允许追加而不覆盖最新有效判断；当前状态异议必须 CAS。被争议依据保留不确定性，不强解释。新帮助从 A 有效投影构造，不能继续使用撤回历史。B2 初始读取和运行中 guard 后，在 C3 最终 Message/Action/Job 接纳及重投前同一事务调用可选受信状态读取守卫，比较真实 learnerStateRevision 与原 basis；状态变化时归档为 stale/basisRevised 而不投递。该接缝只增加可选守卫，不改变未装配 A4 的原 C3 路径、原 Job/hash 重放或停止事实。

完成事务后返回 stoppedJobIds/affectedAttemptIds 供宿主通知；失败通知不能撤销已持久停止意图，恢复后按原身份补对账。A 不在 HTTP 回调中跨服务双写，C4/A5 消费相同 Transaction 能力，不提前实现其恢复/反馈业务。

## 6. 预先确认的验证接缝提案

本节需负责人确认后才按 TDD 写测试；依据项目 [tdd skill](../../skills/tdd/SKILL.md) 的“Test only at pre-agreed seams”。测试只通过下列公开 HTTP 或受控服务能力观察行为，合成账号/活动初始化沿现有 test fixture，SQL 只用于合成前置或明确故障注入，不用私有实现断言代替公共结果。

| 接缝 | 独立验收行为 | 对应条件 |
| --- | --- | --- |
| 真实登录 HTTP 自述/读投影 | 初始0、self-report 分层不等于能力；严格字段、跨课程/学生/私有引用拒绝，目标/版本/帮助/未知保留 | AC-07、NFR-04 |
| 原 Job 的公开 queue/claim/complete/read | exact raw/hash、同结果原 IDs 重放/异 hash 冲突；purpose/停止/lease/代际/政策/过期版本/refs 拒绝原因持久可查 | AC-07/08 |
| HTTP reviews + worker 完成 + 公开当前状态 | 教师先纠正→旧候选拒绝；候选先接纳→旧教师表单 VERSION_CONFLICT；state单调不重置 | AC-08 |
| 同 Transaction 公共能力 + 真实故障注入 | 状态/决定/原分析/Job/epoch/Action/Receipt 任一步失败全部回滚，重试返原 IDs不重复 revision/事件 | AC-08 |
| HTTP disputes/reviews + 新候选/新帮助读取 | 新 ID/措辞/analysisVersion 不复活原撤回依据；依赖主张传播；历史异议不覆盖新判断 | AC-08/16 |
| 真实 B2+C3 组合 | 新上下文自动读 A 实际 revision；旧帮助不投递；末次运行 guard 后、最终接纳前更新 A 状态的竞态仍被同 tx 守卫拒绝，重投前也重查；普通运行事实/显示回执保留并 basisRevised；暂停采集/工具故障保留缺口 | AC-07/08/16 |

候选工程样例明确标记 synthetic，模型调用为 0；真实 Fastify 登录/CSRF、SQLite Transaction 与原 Job/C3 持久能力不用替身。runner/provider 在不运行实际节点/模型的用例可用已有受控替身，不能把它计为 Linux隔离/实际模型通过。

获准 Node 24.21.0/既有 lock 依赖、获准 fresh-only 数据库环境中，工作目录 `apps/teaching`；下列是编码前计划命令，实际执行结果见 §8.3：

```powershell
node --test tests/review.test.ts
npm run typecheck
npm run build
npm test
```

仓库根目录的文档验证不创建数据库或发网络请求；README 同步后执行：

```powershell
node tools/a0-review/check.mjs
```

按单个公共行为 red→最小实现→green 推进，记录实际 red/green及代码固定提交；结束进行固定基线两轴审查和一次完整回归。现有 Windows/Linux RunControl 环境失败、节点/模型门禁跳过分别报告，不改检查强度或用跳过冒充通过。

## 7. 需要批准的具体实施批次

请求批准 §2 的 **新 fresh-only 31 表（现有 Teaching 26 + 上述5）**、§3～5 的受控接口/同事务接缝与 B2 最小状态读取集成，以及 §6 公共测试接缝。理由是现有基线仅定义逻辑对象，缺少 A4 持久化和正式消费实现；风险是新增合成库占磁盘、公共组合/状态版本守卫影响 B/C 消费，需要真实事务和原回归验证。

范围只用全新保留的合成库；不迁移已有/生产库，不改凭据/CI/UI，不装新依赖，不发真实模型请求。C 原分析文件与 B2 可选读取接缝是本批明确的最小共享增量，原内容格式/检查强度不变，待 C/B 依本人的消费批次复核。批准不能自动视为 product/planning/reference/AGENTS 写入许可、P2/DL/G3验收、真实数据/运行资源/公开部署许可。

批准事实将在此按日期与准确范围登记；截至本文创建，未获批准，不初始化新 schema 或按提案编码。DL-A 的正式评审仍依其进入条件，不用 A4 授权绕过。

## 8. 实际验证、收口与汇总

2026-10-12：基线/源码/远端 Issue 核查完成，A4 实现/数据库/业务测试/typecheck/build/完整回归均未执行，不关闭 #41。待批准后连续完成本批，实现→验证→任务记录→审查；任何真实依赖尚缺明确交 B3/A5/C4，不拿合成候选替代实际模型或人工语义。

待获授权维护者汇总：确认后的接口/数据/事务与 B2 当前性守卫进入 TECH；MVP 第10节只登记真实代码位置、命令/结果/失败和未执行。A4 不自行修改 protected 基线。B3真实候选/教师人工语义、Feedback目标的A5消费、C4恢复、浏览器/TLS/真人和完整G3继续后置并分别报告。

### 8.1 编码前验证与两轴方案审查

2026-10-12，同步基线的 typecheck/build 通过；此时无 A4 源码改动，结果不算 A4 实现验证。仓库根文档静态检查 39 份/575 内部引用/errors=[]；README 空白检查通过。数据库和业务测试未执行。

Standards 轴只读审查：硬违反 0、判断性建议 0，保护范围、README 固定结构、批准/未执行标记符合规范。Spec 轴只读审查发现 2 项 P2 方案缺口：非法 JSON 原文的保存约束歧义、末次 B2 guard 后到最终接纳之间缺真实状态 CAS。已在 §1～6 明确 raw_body_text 不要求合法 JSON，并补 C3 可选同 tx 守卫及竞态/重投验证；Spec 轴增量只读复核确认原两项明确解决，新增未解决问题 0；两轴方案审查未解决均为 0，不记为业务验收。审查范围是基于固定 main 的未提交任务提案及 README，不是代码交付。

### 8.2 负责人实施批准（2026-10-12）

负责人明确答复“批准该具体范围并继续”，批准 §2～6：全新保留的 31 表合成库（C3 原26+本任务5）、受控接口、C3 同事务纠正与可选最终状态守卫、B2 最小状态读取、真实登录 HTTP/原 Job/worker/真实事务的公共验证。既有库、凭据/CI/UI/真实模型/运行资源与受保护基线仍不在写入范围；无需为已批准范围重复确认。批准后先实施独立 A4；DL-A 提前评审的准确范围单独记载。
### 8.3 当前实现与工程验证（2026-10-12）

再次同步的 main 为 `37849f4fa2fd4cc1e058fb8559b33a89a60ceed2`，已正常合入本工作分支；编码前起点、未执行记录和 §8.1 方案审查保留其时点。§2～6 的批准已按 §8.2 实施。新增 Review 工厂仅初始化新的 31 表合成库，不扩旧工厂、不迁移旧库；所有测试库保留。

实现位置见 §9。当前已完成自述/有效状态/异议/教师复核的受控接口、原分析 Job 的接纳与拒绝事实、原文 hash/幂等、引用范围/版本/最底层依据防复活、C3 同事务失效及 B2 实际状态读取。学生读取不包含原分析正文；旧引用明确 unavailable，原观察/Run/已显示帮助回执保留。持久化故障回滚而不冒充模型拒绝；领取租约也复用原完整回执/事件校验。

| 实际命令（工作目录 `apps/teaching`，Node 24.21.0/锁定依赖） | 实际结果 | 边界 |
| --- | --- | --- |
| `node --test tests/review.test.ts` | 40 通过、0 失败、0 跳过 | 32 个顶层用例及 8 个当前性子用例；真实 Fastify 登录/路由处理链、原 Job/worker、SQLite 事务；runner/provider 用明确合成替身 |
| `npm run typecheck` | 通过 | 包含 A4 新源码/测试及原 B/C 接缝 |
| `npm test`（含 `pretest` 的 build） | build 通过；304 项，293 通过、2 失败、9 跳过 | 失败为既有 Windows/Linux `RunControl` 环境限制，以及并行全量中的启动子进程 5 秒超时；不宣称全量通过 |
| `node --test tests/startup.test.ts` | 4 通过、0 失败、0 跳过 | 原启动检查不改代码/超时；该次单独复跑未复现超时，不覆盖或抹去上一行失败 |

真实模型/真实 C 节点开关未开启，供应商调用为 0；9 项跳过涉及实际模型、Linux/隔离节点和真实 C 链门禁，分别保留原后置条件。socket/TLS/浏览器、真实学生/人工语义与教学效果未执行；Fastify inject 不能代替浏览器或真实 TLS 验收。

| 已验证行为 | 代码/公共接缝 | 对应条件 |
| --- | --- | --- |
| 自述独立 revision；严格身份字段、当前 Session/成员、跨课程/学生/教师权限与私有资料拒绝 | my-context / learner-state、queueAnalysis、真实登录 | AC-07、NFR-04 |
| 原 UTF-8 文本（含 CRLF/非法 JSON）与 SHA-256 保存；无效 UTF-16 标量输入拒绝；同 Job/hash/命令回执返原 IDs，异结果冲突、旧代际拒绝 | queue/claim/complete/readAnalysis | AC-07/08 |
| deadline、模型/提示/schema/analysis 配置、state/context/capture、Assignment、membership、generation 在完成时重查 | 原分析当前性 8 子用例 | AC-08 |
| 教师先纠正旧候选拒绝；候选先提交旧表单 CAS 拒绝；新确切证据可替换、暂缓保留 unknown | reviews / worker / learner-state | AC-08 |
| 教师事务 7 写入点、分析事务 5 写入点、自述回执和异议晚写入点故障；另核原证据读取故障/损坏原回执；公共状态/Job/epoch/Action/事件不半提交，可重试原身份 | 真实 SQLite Transaction + 显式故障注入 | AC-08 |
| 新 claimId/措辞/analysisVersion、重复快照、新 Run/文件 ID 不复活原争议/撤回依据；真正不同作品允许新候选；依赖主张传播且同 Attempt 不虚增观察组 | 原公开 C2 保存/快照/Run + 新分析/异议 | AC-07/08/16 |
| trusted_validator 的原 Run/快照/输入/镜像/规则/判据与 case 数；stdout/裸 passed、自述、旧目标版本不替代可信检查；工具故障/采集暂停/unknown 不抹平 | C2 原 processJob + 分析完成 | AC-07 |
| B2 初始/运行读取 A 实际 revision；末次 guard 后 C3 接纳前竞态与重投前守卫；旧帮助无投递，已显示帮助保留真实回执/标 basisRevised；普通 Run 原事实不撤销 | 真实 B2 executeStudentHelp + C3 /events/receipts | AC-08/16 |

TDD 按单个公共行为推进，实际 red→green 包括防旧依据复活、可信检查来源、工具故障缺口、原引用不可用、unknown 保留、context 返回停止身份、原证据存储故障、损坏原队列回执与新文件身份的 Run 归一。复用既有行为的验证直接 green，不把它们记为曾有红灯；类型错误与夹具可见性/错误码修正不算产品行为反例。编码结束固定源码后进行 Standards/Spec 两轴审查，实际结果另记。

## 9. 实际接口与分批交接

| 实际文件 | 已交能力 |
| --- | --- |
| [review contracts](../../apps/teaching/contracts/review/index.ts) | 严格输入、确切引用、主张/状态/决定/异议、分析绑定/结果和引用可用性结构 |
| [review application](../../apps/teaching/server/review/application.ts) | `createReviewApp(options)` 装配 HTTP/受信能力并与原 Tutoring/Teaching 工厂组合；身份来自 Access |
| [storage](../../apps/teaching/server/review/storage.ts)、[projection](../../apps/teaching/server/review/projection.ts)、[evidence](../../apps/teaching/server/review/evidence.ts) | 追加 revision、适用范围、引用有效性、最底层原依据/观察分组与帮助/缺口守卫 |
| [decisions](../../apps/teaching/server/review/decisions.ts)、[disputes](../../apps/teaching/server/review/disputes.ts) | 教师 confirm/correct/defer、本人当前/历史异议、依据传播、C3 同事务失效、A5 FeedbackTargetResolver 类型 |
| [analysis](../../apps/teaching/server/review/analysis.ts)、[C 原分析存储](../../apps/teaching/server/records/analysis.ts) | 原 Job/Receipt/租约/当前性、接受/拒绝与 exact raw/hash、原结果重放，拒绝不建立状态 |
| [review schema](../../apps/teaching/server/db/review-schema.ts)、[transaction](../../apps/teaching/server/db/transaction.ts) | 获准的 fresh-only 31 表 `createReviewDatabase()`；没有迁移命令 |
| [B2 application](../../apps/teaching/server/tutoring/application.ts)、[C3 application](../../apps/teaching/server/records/application.ts)、[C3 teaching](../../apps/teaching/server/records/teaching.ts) | 可选 trusted state reader / TeachingBasisCurrent、原接纳与重投前同 tx 守卫；未装配时原行为保留 |
| [A4 tests](../../apps/teaching/tests/review.test.ts)、[合成支持](../../apps/teaching/tests/review-support.ts) | 实际登录/公共能力、真实数据库与原 worker；`/fixture/*` 只存在于测试，未注册到产品路由 |

B3 使用工厂返回的 `review.queueAnalysis(request, attemptId, input)`，输入为 recoveryGeneration、expectedStateRevision、expectedAttemptRevision、purpose、inputRefs、assistanceRefs、coverageRefs。request 必须来自已有真实授权请求链；scope、固定活动/政策/分析版本、epoch/context/capture 与 45 秒 deadline 由服务反查/冻结，不由候选 body 赋权。显式/被动用途分开，采集暂停不允许新被动分析；本批没有无人授权的任意后台排队入口。

公共 `review.claimAnalysis(jobId)` 返回原 Job/binding/leaseToken；B 仅对 binding 指定的获准描述符产生候选。`review.completeAnalysis({jobId, leaseToken, recoveryGeneration, bodyJson})` 同事务提交原文本/结果和有效 revision；第一次需原有效租约，同 Job/hash 已提交后不要求新执行租约，不再生成模型结果。错误结构/当前性/引用拒绝被持久化为 rejected/reason；存储故障/恢复代际错误抛出并回滚。`review.readAnalysis(request, attemptId, jobId)` 在当前授权下查询，教师可见原文、学生仅 metadata。

B2 无需再次手工注入 learnerStateRevision：A4 组合自动安装 `studentHelp.readLearnerState(tx, scope)` 并返回实际有效投影。B2 原 DTO/策略/模型格式保持已有约定；完整分层主张与引用可用性供 B3/A5/C4 走 `review.readCurrentInTransaction(tx, scope)`。该能力的 tx/scope 必须来自宿主当前授权，不能在浏览器接受任意 courseId/studentId。C3 同 tx 状态守卫匹配原 basis.relatedStateRevision，旧 Action 标 stale/basisRevised，原 ID/hash 重放仍保持。

A5 可消费当前主张/教师 decisions/disputes，并实现 `review.feedbackTarget(tx, scope, exactFeedbackRef)`，返回 current 与确切 claimRefs；本批不造 Feedback，未装配返回 INVALID_REFERENCE。C4/A5 同事务消费 `review.readCurrentInTransaction` 与原控制/失效能力，reviews/disputes/context 的结果含 stoppedJobIds/affectedAttemptIds；宿主在提交成功后通知停止，网络失败不撤回已持久意图。正式 Feedback 采用、作品恢复和该两域完整业务未执行。

`createReviewApp` 是可组合服务端工厂；普通 `npm start` 仍为既有 health 宿主，本批没有把测试夹具当正常入口。DL-A 的共用正常宿主/完整表集合/消费者与实际 C/B/UI 接入仍按其独立提案/精确授权推进。产品/计划/参考/AGENTS 未修改；TECH 契约与 MVP 第10节真实实现/结果仍待获授权维护者汇总。

2026-10-12，专项汇总后新增教师决定引用防复活反例，先红后绿：该引用须继承当前确切教师主张的原依据/观察组，后续撤回时跨目标派生主张 contested，旧判断引用不可再排队。此时完整回归尚未复跑；上一段 40/40 与 304 项统计保留其测试源码时点。最终验证及固定源码两轴审查将另记，不提前将新增反例计入原通过数。独立新库诊断实际为 31 表、SQLite 3.53.4、WAL/FULL、外键开启、integrity=ok/外键错误0；这项 schema 诊断不代替公共业务测试。

## 10. 固定提交审查后的边界修复（2026-10-12）

固定提交 `0073fa6509445407b6e6060e3ce391021be948ea` 的 Spec 审查发现显式分析对 captureRevision 无条件比较，与 TECH §7.2.1 的“暂停采集仅停过程/在途被动分析”不符。在既有 §3～6 授权和公共接缝内补测并修正：被动分析继续核当前采集版本/开关；显式请求的固定引用与原 binding 保留，不因单独采集开关变化拒绝，最终仍读取当前真实覆盖空窗并保留 unknown/unresolved，不改贴原结果版本。

展示回执审查更正：C3 的 student 记录读取已过滤 displayed/acknowledged，pending 本来不算 observed_help；原“pending 被算作已观察”意见撤回。仍需验证已发送/received 但没有展示回执时的解释缺口，按 TECH §4.2 保留 unknown/unresolved；本批不据发送/received 推断学生阅读、理解或掌握。结果在下文按实际 red/green 追加。

### 10.1 反例与修复的实际结果

两个新增公共用例分别按 red→最小修复→green 验证：在途显式请求经历 capture off/on，原 Job 未停且 epoch 不变，修复前拒绝、修复后接受并保留原 capture binding 与 paused 覆盖区间；received 无 displayed 的真实 C3 帮助，原 observed_help 候选正确拒绝（审查原第一条为误报），但 none_observed_in_system/unresolved=false 修复前错误接受、修复后拒绝，unknown/unresolved=true 则接受，原 received 事实保留。

修复后 `node --test --test-reporter=tap tests/review.test.ts`：43 项（35 顶层+8 子用例），43 通过、0 失败、0 跳过；`npm run typecheck` 通过。未改既有检查阈值、平台门禁或产品/共享契约。修复前固定源码 `0073fa6` 的最终串行全量为 305 项、295 通过、1 失败、9 跳过，build 通过，41 项 A4 全通过，原启动 5 秒超时未复现；唯一失败为既有 Windows 的 Linux-only RunControl 配置。本段是该时点记录；修复后固定源码的全量和增量两轴结果随后追加。

## 11. 最终固定源码、验收证据与交付边界（2026-10-13）

源码固定为 `2f4114a4a08754f742295db0d193963e7414693c`，基线 `37849f4fa2fd4cc1e058fb8559b33a89a60ceed2`。获准 §2～6 的 A4 服务端批次已实现、验证并完成代码审查；实际公共能力和消费签名见 §9。#41 仍 Open，待公开交付和负责人接收；本文不代替受保护基线汇总或完整产品验收。DL-A 的 A 域提前评审准备已完成，正式跨域契约仍缺输入，#38 不关闭。

### 11.1 最终实际验证

以下已执行命令使用批准 Node 24.21.0/锁定依赖，目录为 `apps/teaching`。完整套件与 npm test 使用相同文件集合，只将文件并发设置为 1；各用例内部并发、原 5 秒启动阈值、平台/节点/模型门禁均未改，未删除或跳过失败用例。

| 实际命令 | 实际结果 | 可查记录 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 新 A4 及原 B/C 完整类型检查 |
| `npm run build` | 通过 | [build](../../apps/teaching/tests/evidence/a4/acceptance.a4-postreview-build.windows.txt) |
| `node --test --test-reporter=tap tests/review.test.ts` | 43 项，43 通过、0 失败、0 跳过；35 顶层+8 子用例 | [A4 专项](../../apps/teaching/tests/evidence/a4/acceptance.a4-postreview-targeted.windows.txt) |
| `node tools/check-runtime.mjs && node --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts server/records/*.test.ts server/workspace/*.test.ts server/tutoring/test/*.test.ts runner/*.test.ts` | 307 项，297 通过、1 失败、9 跳过；A4 43 项全部通过 | [最终全量](../../apps/teaching/tests/evidence/a4/acceptance.a4-postreview-full-serial.windows.txt) |

唯一失败仍为 `server/workspace/review.test.ts:118` 的真实 RunControl 准备失败用例，在 Windows 初始化 Linux-only control 时抛 `INVALID_CONFIGURATION: Linux and trusted control context required`。本批未改该用例或 runner/control；启动超时在两次文件串行全量均未复现，首轮并行失败仍保留。9 项实际模型、Linux/隔离节点及真实 C 链门禁跳过的名称见 [证据索引](../../apps/teaching/tests/evidence/a4/acceptance.a4.evidence.json)。WSL 中所需批准 Node/锁定依赖尚未配置；未安装或自动启动新资源，A4 Linux 全量未执行。

fresh 工厂实际检查为 31 表、SQLite 3.53.4、WAL、foreign_keys=1、synchronous=2、busy_timeout=1000，integrity_check=ok、foreign_key_check=0；该 schema 在边界修复前后未改变。全部合成库和原本机日志保留。验收记录只归一仓库/临时目录路径与 CRLF，保留原日志 SHA-256 及入库记录 SHA-256，团队不需个人目录即可核查。早期 [304 项并行回归](../../apps/teaching/tests/evidence/a4/acceptance.a4-initial-full.windows.txt) 和固定 `0073fa6` 的 [305 项串行回归](../../apps/teaching/tests/evidence/a4/acceptance.a4-prereview-full-serial.windows.txt) 单列历史，不改写通过数。

### 11.2 两轴审查收口

Standards：固定基线→`0073fa6` 发现 1 个 README 运行目录 P3；`0073fa6`→`2f4114a` 已修正并增量复核关闭，未解决硬规范问题 0、可操作判断建议 0。Spec：初报的“pending 被计 observed”已核 C3 过滤后撤回；实际核实的在途显式请求采集切换误拒绝和已发送/received 缺展示的 unknown 缺口各有公共 red→green，增量复核两项有效 P2 均关闭，未解决 0、新规格问题/范围扩大 0。两轴是独立只读代码审查，实际测试结果另在 §11.1 登记。

最终文档/证据增量 `2f4114a`→`034dc79f25596fa495df889902265e95e3629b03` 已分别只读复核：Standards 硬规范/可操作判断建议均 0，Spec 未解决/新增范围问题均 0。5 份入库日志的 SHA-256/字节数、首轮 spec 与后两轮 TAP 计数和 9 项跳过列表已逐项核对一致；仓库根目录 `node tools/a0-review/check.mjs` 为 39 文档/610 内链/errors=[]，`git diff --check` 通过。上述审查没有重复业务测试，也不扩大 §11.1 的验收范围。

### 11.3 明确未完成项与维护者汇总请求

真实 B3 模型候选与人工语义、A5 feedback 目标与教师正式反馈、C4 完整恢复/联合接入、正常共同业务宿主初始化、socket/TLS/实际 UI/真人与教学效果未执行。合成外部 provider/runner 不能记为实际模型或 Linux 隔离证据。本批没有产品监听入口；原 main 仍为健康入口，C4/A5 宿主按 §9 真实受控签名组合后另验。

2026-10-13 远端 main 未变；新增 Open [P2 PR #46](https://github.com/paher-din/XunJie/pull/46) 与 [C4 PR #47](https://github.com/paher-din/XunJie/pull/47)，均未合入本源码。#47 在 workspaceSchema 追加两表，若后续合入 A4 将形成 33 表（不含 A3 两表）；当前 31 表批准/验证不延伸为该联合 schema 或迁移许可，后续精确表集合、授权和联合回归须另行登记。本批不代 C 实现作品恢复，不因 B 报告真实调用而自动启用本机真实模型。

待获授权维护者汇总到 MVP 第 10 节：§9 的实际代码/受控接口、上述固定源码与真实命令/结果、唯一环境失败、9 跳过和本节后置项；到 TECH 汇总获准自述/状态/决定/异议/原分析持久化、确切引用可用性、原 Job 最终接纳/C3 同事务纠正/B2 trusted state reader 的实际签名与用途守卫。product/planning/reference/AGENTS 在本批保持只读，未宣称已完成该汇总。B3/C4/A5 各域依 §9 复核消费，原 G0～G4 和正式验收条件保留。

### 11.4 负责人批准的公开交付（2026-10-13）

负责人明确答复“批准推送并创建 PR”，批准公开交付已验证的 `codex/a4-learner-state-review` 分支（创建时 head=`2afff290ef96519f1cade819256aa7c4449b3734`）、A4 代码/合成验收证据与 DL-A 评审准备，#38/#41 保留 Open。已推送该分支并创建 [A4 PR #49](https://github.com/paher-din/XunJie/pull/49)，目标 main，创建后核对 state=OPEN、isDraft=false、mergeable=MERGEABLE、mergeStateStatus=CLEAN；未合并 PR、关闭 Issue 或执行部署。GitHub 连接器创建接口返回集成权限 403，改用本机已授权 GitHub CLI 的同一正文成功创建，PR 已附到任务。

本节及 README 为公开交付事实同步，不改变固定源码 `2f4114a`、§11.1 的测试结果或后置条件。#38/#41 的 Open 状态已从远端核对，DL-A 缺 C/B/UI 输入和其他实施门禁保留；无关工作未纳入提交。§11 首段“待公开交付”是本节创建之前的时点记录，现转为已公开交付、待负责人审阅接收。

## 12. PR #49 新审查意见修复（2026-10-13）

本次读取 [PR #49 的审查](https://github.com/paher-din/XunJie/pull/49)，固定作者 head=`6a4361b9e59227b8b5410c164656dc7dd7f178d8`、base=`37849f4`。审查为 CHANGES_REQUESTED，Standards 4项P2/6项P3、Spec 0项；独立复验307/297/1/9与作者一致。以下先记录方案再修复，旧§11事实原文保留，不能以历史审查0项覆盖新增发现。产品基线/其他成员任务稿/凭据/CI/UI保持只读。

| 意见 | 本批修正与验收 | 边界 |
| --- | --- | --- |
| P2-1/2 证据空白和Windows哈希漂移 | 入库现有证据blob原字节保存为gzip并记hash；显示日志仅去尾随空白/EOF空行，同步新摘要与保留旧摘要；本目录txt/json设置-text防自动换行，不关闭whitespace检查。核提交blob与Windows检出字节、完整base→HEAD diff --check | 原作者originalLogSha256保留其旧含义，不能把保留blob假称原作者未规范化原日志；旧验证声明在本节追加更正 |
| P2-3 C4联合范围漂移 | 保持批准的精确31表集合，初始化前核准表名集合，不一致时在建库前拒绝；公共工厂回归断言31表及关闭后保留。C4未来33表须另获准确批准，当前不合#47、不改变schema | 不将31改成自动跟随teaching表数的开放授权，不迁移旧库 |
| P2-4 热路径完整投影 | 增加可选同tx readLearnerStateRevision；A4实现只查真实最新revision；B2守卫优先廉价读取并与原额外守卫AND，未提供时回退旧完整读取；求助仍完整投影。原事件/投递/并发纠正用例验证，完整投影存储故障不能阻塞只需版本的事件轮询 | 负责人已明确批准该最小共享修复；不改模型格式、B教学策略或共享状态语义 |
| P3-1/3 记录和README格式 | 追加更正固定旧head静态内链611（原写610）、原diff --check失败；补围栏后空行，本轮计数另记 | 保留历史统计与日期 |
| P3-2 回执可辨 | reviews/disputes按原同key/hash回执预检，返回顶层replayed；相同结果/IDs与CAS/权限保留，异摘要冲突 | 仅加已有命令回执标志，不重复动作 |
| P3-4 宿主与受信服务说明 | 明确当前learner_analysis无人自动消费；queue/read需要真实请求授权，claim/complete属于受信宿主服务，原Job/成员/lease/代际守卫不能绕过；本批不接宿主或模型 | 正常消费者/B3/C4在其原批次交付 |
| P3-5/6 引用与重复展开 | run缺失输入/入口文件显式INVALID_REFERENCE；证据一次同步展开内复用同Attempt的Workspace，投影/主张校验共用，调用间无缓存，避免纠正后复用旧结果；保留原引用不可用/防复活/工具故障回归 | 不减少依据、权限或当前性核验 |

### 12.1 负责人批准与后续复核登记

2026-10-13，负责人答复“批准该最小共享修复并继续”，批准上述可选readLearnerStateRevision同tx能力，事件/投递只取真实版本，求助完整主张不变，未装配仍沿旧行为/原额外守卫。此前批准的§2～6、31表fresh-only和公共测试接缝继续有效；本轮不请求或执行C4联合33表初始化。

PR审查修订登记的负责人指派如下，仅同步A交接待办，不向成员发送消息，不把Pending改为通过：

| 域/责任人 | 挂靠与触发阶段 | 复核与证据要求 | 当前状态 |
| --- | --- | --- | --- |
| C / @paher-din | #43，C4/A4实际合并集成批次 | 原分析存储、Job幂等、状态版本守卫和同事务接纳/重投，不破坏C3原路径；给消费提交与真实验证 | Pending |
| B / @scy404 | #42，B3消费A4状态时 | tutoring最小状态读取、版本守卫、历史兼容和教学上下文；包含本轮已批准的廉价revision接缝，给消费提交与真实验证 | Pending |
| A / @czr112 | #41与本文；C/B交结论后协调 | 本节已登记责任/触发/要求；收到各域实际结论后核对收口，不能替其签收 | 登记已完成；跨域收口Pending |

A4独立合成批次与后续C/B消费验收分别计账，不自动关闭#41/#42/#43、不宣称完整G3。公开PR待办/Issue同步属于外部交付记录，实际更新另记，本文登记不冒充远端已更新。


### 12.2 追加 C 域试合并复核与本批处理

2026-10-13，再次读取 PR 审查时已有负责人追加的 C 域复核：对象是旧 A4 head `6a4361b` + C4 head `3f51da2` 的试合并树 `e1bef102`，不是已合并结果；C 四套件 29/29、组合 61 项为 60 通过/0失败/1跳过，review/teaching/workspace 实测33/28/24表。此为 C 提供的指定范围证据，本批不冒称自行执行；实际合并和批准表集合仍需落地后复确认。§12.1 原 Pending 是此前时点记录，现 C 已提前执行并提出1项C-P2/4项C-P3，正式触发后复确认仍Pending，B/A跨域收口仍Pending。

C-P2-1：原 `reconcileTeachingBasisInTransaction` 对非 pending Action 无条件覆盖 stopReason。按 C3 既有纪律补公共反例：真实学生求助/原worker完成/显式取消后接纳分析，再轮询事件，教师公开记录必须保留 cancelled/student_stopped 与原ID/hash/回执，仅 basisRevised 变 true；pending 才写 stale/learner_state_revised。这是原获准 C3 同事务接缝的事实保全修复，不加字段或改变共享格式。

C-P3-3/4：把 C3-V01/V05 注释放回完成函数；原分析读取/重放签名收窄为必含 attemptId，与两个实际调用方及存储侧一致。`server/records/analysis.ts` 是 C 原事实持久化接缝，调用方均在 A review；A 公共验收覆盖 admission/读取/幂等，C 后续集成负责原 Job/事务纪律复核，不据目录归属冒称已有 C 专用消费或用例。

C-P3-1（待裁决）：懒协调失效审计的 actor/time 目前记录实际轮询触发者/执行时刻，不能据此认定该人是导致状态改变者，也不是原修订时刻。建议由负责人确认归因语义：在原状态变更事务记录，或由受信服务标识并关联原 cause/time；需要与 C 统一审计约定，本轮不单方改字段或挪用教师身份，不将此判断项标已解决。

C-P3-2（消费说明）：轮询已将原 Job stopRequested 置 true 后，后续显式取消仍返回200并写原取消审计，但 invalidatedActionIds 可能为空、没有新的 teaching.stopped；空数组只代表本命令新增传播集合，不代表此前没有受影响Action。宿主/UI不得以该数组反推历史影响；本批不增加字段或额外事件，待实际消费方结合原 Action/Job/事件验证。


### 12.3 固定源码前已执行验证与历史勘误

2026-10-13，本批完成上述实现：公共事件守卫在原证据读取故障下不展开完整状态；reviews/disputes 原回执含 replayed；独立初始化在建库前对精确31表组成 fail closed；单次投影三条主张只读取一次工作区、下一次读取看见教师纠正；损坏 Run 输入/入口各从503修为422 INVALID_REFERENCE；已取消Action原停止原因从被覆盖修为保留。原输入/入口两子用例3/3、C停止原因1/1各有真实 red→green，最新 typecheck 通过；本轮全部专项、最终完整回归与两轴审查尚未执行，不把局部结果当收口。

历史勘误：固定旧head `6a4361b` 的静态检查为39文档/611内链，§11.2写610不准确；该head相对于base的 `git diff --check` 实际失败（尾随空白/EOF空行），§11.2“通过”声明不成立。旧声明原文保留供核查；本轮去显示日志空白、保留旧blob并使用-text，当前未提交差异对完整base的空白检查通过。五份压缩档解压后逐字等于旧head Git blob，当前显示记录及 files/reviewCorrection 索引SHA-256/字节数逐项一致；原作者未归一日志摘要与旧blob摘要分别保留，不混称。

A4廉价版本读取仍核真实 Attempt course/student 和真实状态记录的scope/revision一致性，解析状态记录而不解析引用可用性/展开workspace；不是信任请求体revision。完整求助继续使用获准投影，未装配revision能力回退完整reader并保留已有附加守卫AND；没有状态reader时保持原C3语义。

当前 learner_analysis 没有正常宿主自动消费者；排队/读取需原真实授权请求，claim/complete只供受信宿主服务调用，不能将其注册为客户端可直接调用的任意jobId/lease接口。宿主应保护能力引用/调用者，并遵守原成员、Job、lease、代际、用途/版本守卫；本批仅通过获准测试宿主消费，不宣称生产worker已装配。待授权维护者汇总MVP§10/TECH时同时纳入本轮revision接口、31表范围守卫、回执标志及引用/停止事实修复，产品基线仍只读。


### 12.4 修复源码两轴审查（2026-10-13）

固定 `6a4361b9e59227b8b5410c164656dc7dd7f178d8` → `80a2721815bdc9ba43a33bb85b39fd60ee0e8298`，Standards 独立只读审查：硬规范违反0、可操作异味0；Spec独立只读审查：缺失/部分、错误实现、范围扩大均0。两轴核对真实版本scope/旧fallback/附加AND守卫、单调用缓存、建库前精确31表守卫、非pending Action原停止原因事实保全；没有执行测试或节点，不代替以下最终回归。

固定该源码的 A4 公共专项51项（41顶层+10子用例）为51通过、0失败、0跳过，typecheck通过；正常 `npm test` 含build的全量正在执行。本轮审计归因C-P3-1待裁决、实际合并/C/B消费接收与正式产品后置项仍保留，不以两轴0项宣称全部跨域待办关闭。


2026-10-13，固定 `80a2721` 的默认 `npm test`（含build通过）实际315项：304通过、2失败、9跳过，A4的51项全部通过。除原Windows/Linux RunControl环境失败外，`server/tutoring/test/deepseek-sdk.test.ts:315` 的10ms截止时间用例预期calls=1实际0；timed_out断言已通过，未进入预期的延迟传输。该SDK/provider/核心文件本批未改，单独复跑整个SDK文件11/11通过；与并发负载下在调用前期限已过一致，不能将局部通过改写成首轮全量通过。保留本轮首轮失败，正对同一文件全集串行复验，原10ms/5秒阈值、平台门禁与用例均不变，最终结果另记。


## 13. PR #49 修复最终结果（2026-10-13）

修复源码固定 `80a2721815bdc9ba43a33bb85b39fd60ee0e8298`，原审查head `6a4361b`、产品代码基线 `37849f4`。本批原4项P2及追加C-P2-1已修，原6项P3按§12修复/澄清，C-P3-3/4代码/归属说明已处理；C-P3-1审计归因仍待负责人裁决，C-P3-2消费限制保留。此为A4独立31表修复批次，不是C4/A4已合并树，不合并其他PR、不关闭#41/#42/#43，不宣称完整G3。

| 已执行命令（apps/teaching，Node24.21.0） | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | [完整类型](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision-typecheck.windows.txt) |
| `node --test --test-reporter=tap tests/review.test.ts` | 51项（41顶层+10子用例），51通过/0失败/0跳过 | [A4专项](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision-targeted.windows.txt) |
| `npm test`（原默认文件并发，含build） | build通过；315项，304通过/2失败/9跳过；A4全部通过 | [默认全集](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision-full.windows.txt) |
| `node --test --test-reporter=tap server/tutoring/test/deepseek-sdk.test.ts` | 11通过/0失败/0跳过 | [SDK单文件](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision-sdk-isolated.windows.txt) |
| `node tools/check-runtime.mjs; node --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts server/records/*.test.ts server/workspace/*.test.ts server/tutoring/test/*.test.ts runner/*.test.ts` | 315项，305通过/1失败/9跳过；A4全部通过，SDK时间失败未复现 | [串行全集](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision-full-serial.windows.txt) |

默认完整失败原样保留：Windows/Linux RunControl既有环境失败，以及未改SDK的10ms时间敏感用例calls=0（timed_out断言通过）。单独SDK与串行完整均未复现后者；串行仅余原RunControl失败。未改用例、阈值、文件集合或平台/模型门禁；9个实际跳过及所有摘要见[新证据索引](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision.evidence.json)。不能把串行通过数回填到默认全集或宣称全部通过。

新验收与旧§11按源码时点分开，旧5份Git blob各已精确保留gzip。提交`80a2721`后验证5/5当前Windows工作树日志字节等于HEAD blob、与清单SHA-256/字节数一致，text属性均unset；完整base→HEAD空白检查通过。获准合成库保留；本轮工厂公共用例验证真实31表和关闭后可重新打开，未初始化C4联合33表。两轴固定修复源码未解决均0，后续文档/证据审查另记。

原正常learner_analysis消费者、C4联合提交/恢复、B真实消费与人工语义、A5正式反馈、Linux完整测试、真实节点/模型、浏览器/TLS/真人/教学效果未执行；C提前试合并结论须在实际合并并批准联合范围后重新确认。待授权维护者把§12～13真实实现/结果、已批准revision签名、回执标志和以上边界汇总MVP§10/TECH，当前受保护文档仍只读。修复交付沿用[A4 PR #49](https://github.com/paher-din/XunJie/pull/49)，源码与最终验收文档分开提交，PR继续交负责人复审。


最终文档静态检查 39文档/619内链/errors=[]，原检查器自测16/16；当前base→未提交修复差异空白检查通过。原源码时点静态记录612内链单列为历史；最终数按本段新检查，不回写旧610/611计数。[最终文档日志](../../apps/teaching/tests/evidence/a4/acceptance.a4-pr49-revision-final-documents.windows.txt)的文件入口追加后内链再验并在交付核对中登记。

最终文件入口追加后的交付再验：39文档/620内链/errors=[]；前述619是该入口追加前的实际时点，新索引分别保留两次结果。末次代码/证据差异空白检查及文档/证据两轴增量结果随后核对。
