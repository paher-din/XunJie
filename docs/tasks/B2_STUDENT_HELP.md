# B2：真实上下文、学生辅导与控制权

日期：2026-10-11（Asia/Shanghai）。任务编号：B2。主责：B。关联 [Issue #26](https://github.com/paher-din/XunJie/issues/26)、[P2 总协调 #24](https://github.com/paher-din/XunJie/issues/24)、[B1 #11](https://github.com/paher-din/XunJie/issues/11) 与 [C3 #27](https://github.com/paher-din/XunJie/issues/27)。

状态：**PR #32 首审的三项 P2 已修复，C3 服务端持久链已完成合成联调并通过专项验证；等待复审与合并。** 已完成显式 help 接纳、原请求绑定、真实 ObjectRef/获准上下文、无历史降级、跨 worker 三次调用台账、B1 执行、双侧当前性守卫，以及成功正文经 C3 Message/TeachingAction/Delivery/Receipt 的持久接纳与补取。真实模型、实际浏览器、真人接棒和教学语义仍分别未执行，不能据此宣称完整产品或教学效果验收。

## 1. 基线、范围与权限

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，并按 PRD → MVP_SPEC → TECH_DESIGN 顺序核对 PRD-04/05/09/10、M-04、AC-04/05/07/15/16、NFR-02/06、TECH 第 4～7/9/10.3 节；另读 [TEAM 第 6 节](../planning/TEAM_WORK_PLAN.md#6-p2接通教师-agent-与学生辅导)、[G2 总协调](G2_OVERALL_COORDINATION.md)、[B1 任务记录](B1_AGENT_CORE.md)、Issue #26 与现有 A2/C2 接口。

本批次可写：

- `apps/teaching/contracts/tutoring/**`：B2 请求、可信上下文与交接类型；不改变公共状态、错误码或 C 的记录语义。
- `apps/teaching/server/tutoring/**`：显式求助接纳、上下文装配、当前性守卫、B1 调用和 C3 交接边界。
- 本文与必要 README 验证说明。

保持只读：`AGENTS.md`、`docs/product/**`、`docs/planning/**`、`docs/reference/**`、其他成员任务稿，以及 A/C 所属源码。不得建立替代消息表、回执、队列或 UI；不得修改 package/锁文件/tsconfig、数据库 schema、密钥、CI/CD 或部署。开发只使用合成数据，原有 `.trae/` 不纳入交付。

## 2. 本批次接口方案

方案完全沿用已批准契约，不新增产品决定：

1. 显式 `help` 输入只接受问题、`expectedAttemptRevision`、可选 ObjectRef 和恢复代际；身份、课程、学生、Attempt、活动、政策与版本由 A/C 服务端读取，不能由客户端或模型提供。
2. 接纳在调用方已有短事务内完成：核授权/活动/阶段/政策/ObjectRef，`ready` 时激活 Attempt；新求助增加 `decisionEpoch` 并停止同 Attempt 的旧 `student_help`/`reminder`，保存问题、CommandReceipt 和新 Job。回执保存原问题/ObjectRef 的独立绑定 hash，不复制整段对话；后续装配先核当前保存值仍匹配该绑定。GET 不激活。
3. B2 上下文装配只接收已授权的活动投影、确认快照/运行诊断、获准资料段落、相关有效状态/反证/未知及实际帮助。资料、代码、诊断和消息正文均标作不可信数据；授权范围、用途、版本、截止和政策仍来自可信信封。
4. ObjectRef 必须精确匹配 Attempt 和固定活动；代码/运行引用由 C2 的不可变快照/运行记录验证，资料引用必须出现在 tutor 可见的活动材料中。无 ObjectRef 的开放问题允许继续，但不伪造代码或运行上下文。
5. B1 `generateStudentHelp` 继续负责有限动作、一次主要目的、结构/引用/政策校验、最多一次修复、最多三次调用和接受起 45 秒。B2 当前性守卫在调用前后核 decisionEpoch、固定活动/政策、学习状态 revision、精确对象可用性、分配/阶段、Job 停止与代际。普通保存、采集或提醒开关只增加 Attempt revision 时不误杀主动求助；问题/ObjectRef 改变会因绑定 hash 不符拒绝装配，旧对象不会改贴新位置。
6. `executeAuthorizedStudentHelp` 把可信上下文、B1 生成和双侧守卫组合为 `StudentHelpExecutionResult`，携带 Job/回执、scope、固定活动/政策/学习状态 revision、对象、获准引用、模型配置版本及 outcome/calls/usage。成功正文只通过 C3 已批准的 `completeTeaching` 接缝保存 Message/TeachingAction；B 不建立替代消息表、回执或队列。

本方案不改变 TECH 的字段、状态、权限或事务语义，因此可直接实现 B 所属范围。若 C3 实际接口需要新增共享字段或 schema，先把差异记录在本文并交 A/C 评审，不在本分支实施。

## 3. 验证计划

- 显式求助：ready 激活、active 保持、GET/读取不激活、缺问题/缺版本/暂停或禁用帮助拒绝。
- ObjectRef：合法代码/运行/资料/项目引用；不存在、其他 Attempt、旧快照/hash/version、不可见资料拒绝。
- 上下文：只包含授权段落和选中对象；资料指令注入不能扩大 purpose/scope；无历史/缺资料/环境失败保留 unknown 并可解释降级。
- 控制权：新求助替换旧求助并增加 epoch；一个 Attempt 最多一个有效帮助 Job；停止、版本变化、代际变化、迟到、超时和模型故障不产出可投递交接。
- 策略：限定检查直接拒绝；普通帮助不整份代做、不写文件、不运行、不发布、不正式评价；提醒默认关闭，关闭提醒不阻止主动求助。
- 记录：调用次数、actual/unknown usage、配置版本和失败状态进入交接；不把 unknown 写成零。
- 回归：B2 专项、B1 全部领域测试、TypeScript typecheck、统一测试、文档检查、`git diff --check` 和保护范围检查。

## 4. 已知依赖与未完成项

- B1 SDK 收口位于 [PR #29](https://github.com/paher-din/XunJie/pull/29)；本分支已合并其首轮审查修复提交 `5aa77a0`/`de794ba`。PR #29 合并前，B2 交付是显式堆叠依赖。
- A2/C2 已合入 main，可提供固定活动/政策、确认快照/诊断、ObjectRef、Job/Receipt/Event 和短事务基础。
- C3 PR #33 已合入 main；本轮已经按其租约、累计 `attemptCount`、本次 `calls` 与 `completeTeaching` 语义完成服务端合成联调。实际浏览器展示、真人操作和生产 worker 编排仍属于独立验收层。
- A4/B3 尚未交付时，无学习状态按空状态工作；相关/无关/撤回/反证使用固定可信 fixture 验证筛选，不能冒充真实状态链联调。
- D-02 的真实 API/账号/条款/数据/配额、凭据与付费授权尚未落实；当前不发送真实学生材料、不执行真实 DeepSeek 调用。30 次延迟和最终人工教学语义收尾属于 B4。
- 浏览器显示、学生接棒、停止交互、例子返回、采集开关和真人验收留待团队 UI/P5。

## 5. 实际实现

- `contracts/tutoring/index.ts`：B2 help 命令/结果、获准上下文、学习状态/实际帮助输入和 C3 可消费的执行结果信封。
- `server/tutoring/commands.ts`：保留早期纯函数接纳测试辅助；生产路由已改用 C3 的同事务接纳入口，未删除文件以避免未经授权的删除操作。
- `server/tutoring/application.ts`：组合正式 C3 records app；在当前 Session/课程/学生授权与同一 SQL 事务内注册 `POST /api/attempts/:id/help`，通过 C3 接纳原始问题、Receipt/Event/Job，并从 C3 原始消息装配后续上下文。持久绑定损坏统一返回 `STATE_CONFLICT`。
- `server/tutoring/context.ts`：只装配固定活动、选中对象、获准段落、相关 active/contested 状态与反证、未知和最近实际显示/确认的帮助；当前性守卫区分取消与过时。
- `server/tutoring/service.ts`：持有同一 C3 租约执行 B1；每次实际 provider 请求前用 `recordModelCall` 持久预留，跨 worker 累计最多三次；成功后用同一租约调用 `completeTeaching`，保存 body、usage、版本与 basis。B 不写学生作品、不运行或直接投递。
- `server/tutoring/test/student-help.test.ts`：使用新临时合成数据库和内存 provider 覆盖服务端/策略反例；新增跨 worker 台账、输入预检回退、损坏绑定、资料正文注入，以及 Message/Action/Delivery/displayed Receipt 的完整合成链，不读取真实学生数据或调用供应商网络。

## 6. 当前验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（Node 24.21.0 / TypeScript 7.0.2） | 通过 |
| `node --test server/tutoring/test/student-help.test.ts` | 16/16 通过 |
| `node --test server/tutoring/test/*.test.ts server/records/teaching.test.ts server/records/teaching-review.test.ts` | B1+B2+C3 83/83 通过；供应商网络调用 0 |
| `node --test --experimental-test-coverage server/tutoring/test/*.test.ts` | B1+B2 63/63 通过；line：application 95.18%、context 97.90%、core 93.95%、service 90.27% |
| `npm test` | typecheck/build 通过；统一回归 253 项中 243 通过、3 失败、7 跳过。失败为既有 Windows 缺 Linux/trusted runner context 1 项及当前环境禁止回环端口连接 2 项；B1/B2/C3 相关测试全部通过 |
| `node tools/a0-review/check.mjs` / `node --test tools/a0-review/check.test.mjs` | 文档检查 `errors=[]`；检查器回归 16/16 通过 |
| `git diff --check` / 范围检查 | 通过；未修改 product/planning/reference/AGENTS、package/锁文件/tsconfig、数据库 schema 或 CI/CD，`.trae/` 未纳入 |
| help 接纳/幂等/替换 | ready 激活、问题/绑定/Receipt/Event/Job 原子保存；重放不重复；新求助取消旧 help 并递增 epoch |
| 权限/政策/ObjectRef | 当前学生/课程/分配、禁用帮助、限定检查、旧 hash/外部 Attempt、代码/运行/资料/项目精确引用均有正反例 |
| 上下文 | 私有资料不进入模型；相关 active/contested、反证、无关/withdrawn、unknown、实际显示帮助和环境 unavailable 分层 |
| 控制权/当前性 | reminder/capture 不误杀主动求助；问题变更拒绝旧绑定；停止、新 epoch、政策、对象、状态 revision、代际在模型前后守卫 |
| B1→C3 接缝 | 成功信封记录 scope/回执/版本/引用/actual usage；Message/Action/Delivery/displayed Receipt 可由教师侧重读；模型后状态变化返回 stale 且不产生可消费 body |

真实 DeepSeek、30 次性能、人工教学语义、浏览器和真人均保持未执行；离线 provider 与合成客户端不能替代这些验收。

## 7. C3 联调结果与剩余边界

- 已复用 C3 的 Job claim、`recordModelCall`、Message/TeachingAction 完成、Delivery 游标补取和 ActionReceipt 接口；成功链在真实临时数据库中完成持久化重读，没有替代实现。
- 失败、取消、过时与超时仍由 B1 返回明确 outcome 且不产生可投递正文；本轮没有扩展 C3 的共享 Job 终结契约。生产 worker 如何调度重试及何时把这些 outcome 映射为终态由 A/C 统一编排，不能由 B 单方新增状态语义。
- 合成 `displayed` 回执只证明服务端接缝；测试客户端不等于学生实际收到、看到或理解。浏览器显示、断线恢复、真人接棒和人工教学语义仍需 P5/B4 分层验收。
- A4/B3 有效状态尚未交付时继续按 revision 0/unknown 工作；后续接入不得让空状态阻止主动求助。

待授权维护者汇总：MVP_SPEC §10 与 TEAM 可记录“B2 help 接纳、真实上下文、跨 worker 调用预算、B1 执行及 C3 Message/Action/Delivery/Receipt 服务端合成链已实现并完成专项验证；实际浏览器、真人和教学语义仍分别验收”。本文不直接修改受保护基线。

## 8. Git 交付状态

- B2 实现提交：`97aa6a6`（`feat: add B2 student help service seam`）。
- B1 PR #29 审查修复已通过合并提交 `c74f3ab` 纳入当前 `codex/b2-student-help`。
- B2 上下文运行时校验与暂停/缺输入反例提交：`cf6f2c7`（`test: harden B2 context validation`）。
- README 已同步最新合成联调范围；`.trae/` 保持未跟踪，不纳入交付。
- PR #32 继续使用 `Refs #26`，等待负责人复审并确认 Issue #26 的服务端交付关闭条件；不由本任务自行关闭 Issue。

## 9. PR #32 首审与 C3 合并后的修复方案

2026-10-12 回读确认：B1 [PR #29](https://github.com/paher-din/XunJie/pull/29) 已在固定 head `de794ba` 获 Approve 并合入 main；C3 [PR #33](https://github.com/paher-din/XunJie/pull/33) 已合入 main。当前分支已合并最新 `origin/main` `6914fb9`，C3 已批准并实现的接缝语义现为正式实现依据：

- `Job.attemptCount` 是跨 worker 的累计 provider 调用台账；B2 每次实际 provider 请求前必须在持有租约的短事务中调用公共 `recordModelCall`，既有累计达到 3 次时不得再次调用。
- `TeachingMessageEnvelope.calls` 只记录产生当前正文的本次执行调用数；C3 完成接纳以 `Math.max(job.attemptCount, calls)` 对账，不对两者求和。
- B2 调用 C3 完成接缝时必须显式携带同一 `leaseToken`；queued Job 由该 token 领取有界租约，running Job 必须保持同一持有者，不能由 C3 回填或伪造 token。

PR #32 首审的三项 P2 均在本轮处理：

1. B2 执行接缝从持久 `attemptCount` 继续剩余调用预算，并在每次 provider 请求前持久预留；只有 provider 明确在实际 invoker 前以 `InputLimitError` 拒绝时，才允许释放本次未发送预留。停止、过期、换代或租约不匹配时不调用 provider。
2. 持久请求绑定损坏改为既有 `ApiError("STATE_CONFLICT")`，不再泄漏为裸 500。
3. 新增“获准课程资料段落本身包含越权指令”的直接反例，证明正文仍作为不可信数据，不能扩大引用、动作、工具或整份代做权限。

同时推进 C3 联调：B2 只通过已合入的 C3 Message/TeachingAction 完成接缝保存成功正文、实际或 unknown usage、单次 calls、版本与 basis；不另建消息、回执或队列。实际浏览器投递/展示/确认和真人语义仍分别验收。首审 P3 中与本轮直接相关的 JobStatus 复用、非空 scope 收窄、GET 不激活专项、缺资料显式降级、覆盖率数字和过期表述一并核对；其他非阻塞重构不扩大本轮范围。
