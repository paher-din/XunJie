# B2：真实上下文、学生辅导与控制权

日期：2026-10-11（Asia/Shanghai）。任务编号：B2。主责：B。关联 [Issue #26](https://github.com/paher-din/XunJie/issues/26)、[P2 总协调 #24](https://github.com/paher-din/XunJie/issues/24)、[B1 #11](https://github.com/paher-din/XunJie/issues/11) 与 [C3 #27](https://github.com/paher-din/XunJie/issues/27)。

状态：**不依赖 C3 的 B2 服务端批次已实现并通过专项验证；C3 联调部分待交接。** 已完成显式 help 接纳、原请求绑定、真实 ObjectRef/获准上下文、无历史降级、B1 执行和投递前当前性守卫。Message/TeachingAction/ActionReceipt 持久化、实际投递、回执、持久取消与重启恢复仍等待 C3，不能据此关闭 Issue #26。

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
6. `executeAuthorizedStudentHelp` 把可信上下文、B1 生成和双侧守卫组合为 `StudentHelpExecutionResult`，携带 Job/回执、scope、固定活动/政策/学习状态 revision、对象、获准引用、模型配置版本及 outcome/calls/usage。当前批次不保存 Message/Action，不声称投递或展示；C3 交付后由其在同事务重查并持久接纳，B 不建立替代实现。

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
- C3 #27 尚未交付，阻塞 Message/Action 持久化、实际取消投递、回执/补取和重启代际联调；本批次只提供可复用接缝和隔离证据。
- A4/B3 尚未交付时，无学习状态按空状态工作；相关/无关/撤回/反证使用固定可信 fixture 验证筛选，不能冒充真实状态链联调。
- D-02 的真实 API/账号/条款/数据/配额、凭据与付费授权尚未落实；当前不发送真实学生材料、不执行真实 DeepSeek 调用。30 次延迟和最终人工教学语义收尾属于 B4。
- 浏览器显示、学生接棒、停止交互、例子返回、采集开关和真人验收留待团队 UI/P5。

## 5. 实际实现

- `contracts/tutoring/index.ts`：B2 help 命令/结果、获准上下文、学习状态/实际帮助输入和 C3 可消费的执行结果信封。
- `server/tutoring/commands.ts`：复用 C2 同事务 Receipt/Event/Job，接纳显式求助、激活 ready Attempt、递增 epoch、替换旧 help/reminder，并以 hash 固定原问题/ObjectRef。
- `server/tutoring/application.ts`：在 A 的当前 Session/课程/学生授权和同一 SQL 事务内注册 `POST /api/attempts/:id/help`；提供获准上下文、准备请求和执行接缝，不暴露替代 worker 或消息路由。
- `server/tutoring/context.ts`：只装配固定活动、选中对象、获准段落、相关 active/contested 状态与反证、未知和最近实际显示/确认的帮助；当前性守卫区分取消与过时。
- `server/tutoring/service.ts`：调用 B1 有限动作核心并返回带可信版本/引用/usage 的执行结果；不写学生作品、不运行、不持久化或投递。
- `server/tutoring/test/student-help.test.ts`：使用新临时合成数据库和内存 provider 覆盖服务端/策略反例，不读取真实学生数据或调用供应商网络。

## 6. 当前验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（Node 24.21.0 / TypeScript 7.0.2） | 通过 |
| `node --test server/tutoring/test/student-help.test.ts` | 10/10 通过 |
| `node --test server/tutoring/test/*.test.ts` | B1+B2 57/57 通过；供应商网络调用 0 |
| 同命令增加 `--experimental-test-coverage` | 57/57 通过；B2 line：application 90.60%、commands 95.87%、context 96.95%、service 100% |
| `npm test` | build 通过；统一回归 202 项中 194 通过、1 失败、7 跳过。唯一失败为既有 Windows 缺 Linux/trusted runner context；B1/B2 57 项全部通过 |
| `node tools/a0-review/check.mjs` / `node --test tools/a0-review/check.test.mjs` | 文档检查 `errors=[]`；检查器回归 16/16 通过 |
| `git diff --check` / 范围检查 | 通过；未修改 product/planning/reference/AGENTS、package/锁文件/tsconfig、数据库 schema 或 CI/CD，`.trae/` 未纳入 |
| help 接纳/幂等/替换 | ready 激活、问题/绑定/Receipt/Event/Job 原子保存；重放不重复；新求助取消旧 help 并递增 epoch |
| 权限/政策/ObjectRef | 当前学生/课程/分配、禁用帮助、限定检查、旧 hash/外部 Attempt、代码/运行/资料/项目精确引用均有正反例 |
| 上下文 | 私有资料不进入模型；相关 active/contested、反证、无关/withdrawn、unknown、实际显示帮助和环境 unavailable 分层 |
| 控制权/当前性 | reminder/capture 不误杀主动求助；问题变更拒绝旧绑定；停止、新 epoch、政策、对象、状态 revision、代际在模型前后守卫 |
| B1→C3 接缝 | 成功信封记录 scope/回执/版本/引用/actual usage；模型后状态变化返回 stale 且不产生可消费 body |

真实 DeepSeek、30 次性能、人工教学语义、C3 联调、浏览器和真人均保持未执行；离线 provider 与测试客户端不能替代这些验收。

## 7. C3 交接与剩余阻塞

- C3 需提供带当前租约/代际的 Job claim、`StudentHelpCurrentState` 读取、Message/TeachingAction/ActionReceipt 同事务接纳、持久停止/替换通知及重启恢复；B2 执行结果不得绕过这些入口直接投递。
- C3 接纳时应重查原 `requestReceiptId`、Job/停止、decisionEpoch、活动/政策、learnerStateRevision、ObjectRef/引用与结果 hash，保存 actual 或 `unknown` usage；失败/过时结果也需按正式记录语义终结 Job。
- 真实接口链、取消投递、received/displayed/acknowledged、游标补取与重启竞态等待 #27。测试客户端和本批次执行信封不等于学生实际收到、看到或理解。
- A4/B3 有效状态尚未交付时继续按 revision 0/unknown 工作；后续接入不得让空状态阻止主动求助。

待授权维护者汇总：MVP_SPEC §10 与 TEAM 可记录“B2 不依赖 C3 的 help 接纳、真实上下文、B1 执行与当前性守卫批次已实现并完成合成专项验证；C3 Message/Action/回执/持久取消及真实投递链仍未联调，Issue #26 保持 Open”。本文不直接修改受保护基线。

## 8. Git 交付状态

- B2 实现提交：`97aa6a6`（`feat: add B2 student help service seam`）。
- B1 PR #29 审查修复已通过合并提交 `c74f3ab` 纳入当前 `codex/b2-student-help`。
- B2 上下文运行时校验与暂停/缺输入反例提交：`cf6f2c7`（`test: harden B2 context validation`）。
- README 已随实现提交；本文最终验证记录待作为独立文档提交。`.trae/` 保持未跟踪，不纳入交付。
- PR 正文应使用 `Refs #26`：当前是可独立交接批次，C3 真实消息/取消/投递链未完成，不使用 `Closes #26`。
