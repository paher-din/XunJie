# B1：教师生成与学生辅导合成核心

日期：2026-10-09（Asia/Shanghai）。任务编号：B1。主责：B。关联 [Issue #11](https://github.com/paher-din/XunJie/issues/11) 与 [G1 #9](https://github.com/paher-din/XunJie/issues/9)。

状态：**合成首批已实现并通过领域测试；真实 DeepSeek 调用、统一工程 typecheck、Zod/AI SDK 实包兼容、A3/B2/C2 联调、浏览器及人工语义验收未执行。** 本状态不表示完整教学链、B4 或 G1 已完成。

## 1. 依据、范围与文件边界

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按顺序核对 [PRD](../product/PRD.md)、[MVP_SPEC](../product/MVP_SPEC.md)、[TECH_DESIGN](../product/TECH_DESIGN.md)，并读取 [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md)、[B0 契约](B0_模型帮助分析契约.md)、[B0 合成样例](B0_TEACHING_EXAMPLES.md)、G1 #9 和 B1 #11。

本任务对应 M-01/M-04，重点覆盖 AC-01/05/07/15/16 的合成确定性部分及 NFR-02/06 的次数、时限和用量边界。G1 #9 明确 B1 可独立交付、按批次交接而非等待 A1 整项；#11 明确先用合成数据和测试 provider。

- 可写：`apps/teaching/contracts/tutoring/**`、`apps/teaching/server/tutoring/**`、本文和必要 README 说明。
- 只读：`AGENTS.md`、`docs/product/**`、`docs/planning/**`、`docs/reference/**` 和其他成员任务记录。
- 未修改：A 负责的 package/锁文件/tsconfig，C 负责的 Job/Receipt/Event/持久化，UI、数据库、凭据、CI/CD 和部署配置。
- 开发数据全部为合成内容；原有未跟踪 `.trae/` 不读取为基线、不纳入提交。

## 2. 实现与接口

### 2.1 公开契约

`contracts/tutoring/index.ts` 提供：

- `TeacherGenerationRequest/Body`：`candidates`、`blueprint`、`patch`、`rubric_trial`。
- `StudentHelpRequest/Body`：仅允许 TECH 已批准的教学动作。
- `TrustedModelContext`：可信 Job/purpose/scope、获准引用、接受/截止时间和模型/提示/schema/政策版本；模型正文不能覆盖这些字段。
- `TutoringOutcome`：区分 success、needs_input、rejected、stale、cancelled、timed_out、budget_exhausted 和 unavailable；usage 只能是 actual 或 unknown。

A3/B2 负责传入 A/C 构造的可信信封与获准正文。B 只产经校验的教师提案或学生教学 body，不返回发布、作品写入、运行、正式评价或持久化能力。

### 2.2 核心与 provider

`server/tutoring/core.ts` 实现教师生成和无历史学生辅导核心：

- 先核 purpose、预算、截止时间和引用授权，禁用帮助在 provider 调用前拒绝。
- 资料、问题和对象通过 `untrustedInput` 与固定系统政策分离，不能作为权限或工具指令。
- 模型结果执行结构、引用子集、帮助政策及禁止能力校验；失败最多修复一次。
- 单轮最多 3 次，接受起最长 45 秒；取消、过时与截止在调用前后核验，迟到结果不能成功返回。
- actual usage 聚合；任一次缺 usage 时整体保持 unknown，不按零计。

`server/tutoring/providers.ts` 提供确定性 `SyntheticProvider` 和注入式 DeepSeek adapter。适配器固定 `deepseek-flash`、`maxRetries=0`、显式 `thinking.type=disabled`、16,000 输入 token、4,096 输出 token，并透传 AbortSignal/剩余时限。实际 AI SDK invoker 与 token counter 由 A1 依赖到位后注入；当前测试供应商网络调用为零。

## 3. 合成样例与验证结果

领域测试取 B0 E1～E10 和 T1 中属于 B1 的场景，覆盖：教师候选数量/修复、patch 基础版本、空历史、缺输入、越权引用、资料指令注入、整份答案政策、禁用帮助、三次上限、取消、迟到、过时、超时、provider 故障、actual/unknown usage、预算耗尽，以及 DeepSeek 配置和输入上限。T2 候选学习状态分析属于 B3，未在本任务实现。

| 检查 | 实际结果 |
| --- | --- |
| `node --experimental-strip-types --test apps/teaching/server/tutoring/test/index.test.ts` | 22/22 通过；本机 Node v24.14.1 原生 type-stripping，合成 provider；真实网络调用 0。批准的精确 Node 24.21.0 仍待 A1 统一环境核验 |
| 同命令增加 `--experimental-test-coverage` | 22/22 通过；合计 line 98.15%、branch 85.14%、functions 100% |
| 首次领域测试 | 14/17，通过测试发现禁止能力扫描把值为 false 的政策声明误判为能力；修正为仅拒绝启用的禁止能力后复跑通过，并新增忽略 AbortSignal provider 的即时取消用例 |
| TypeScript 7 静态 typecheck | 未执行；仓库尚无 A1 package/锁文件/tsconfig，未伪造命令 |
| Zod/AI SDK/@ai-sdk/deepseek 实包兼容 | 未执行；依赖安装归 A1，共享文件未越权创建 |
| 真实 DeepSeek、30 次性能、人工语义 | 未执行；账号/API/条款/数据/凭据/付费条件未落实，B4 后置 |
| 服务端、浏览器、真人 | 未执行；等待 A3/B2/C2 与最终 UI 接入 |

## 4. 交接与剩余限制

- **给 A1：** 在共享 package/锁文件/tsconfig 中纳入批准版本，并以 TypeScript 7、Zod 4、AI SDK 7、DeepSeek provider 3 对本模块执行静态和实包兼容检查；若实际 API 不兼容，先报告差异，不静默换栈。
- **给 A3：** 调用 `generateTeacherProposal`，保存 proposal/applicability；采用仍走 A 的 PATCH/CAS，B 不覆盖蓝图或发布活动。
- **给 B2：** 调用 `generateStudentHelp`，接入真实 ObjectRef、帮助政策和有效状态；无历史不阻止求助。
- **给 C2/C3：** 提供可信上下文、当前性守卫、持久取消与 usage/Job/Action 保存；本模块不另造队列、回执或事件表。
- **验收边界：** schema/标志只能证明确定性结构约束，不能证明普通语言输出的教学适切性；人工语义审阅保留给 B4。

待授权维护者汇总：MVP_SPEC §10 和 TEAM 的当前状态可登记“B1 合成核心、公开契约、合成 provider 与注入式 DeepSeek 适配边界已实现，Node 原生领域测试 22/22；共享依赖/typecheck、真实模型和跨模块/浏览器/真人验收未执行”。本文不直接修改受保护基线。

## 5. Git 交付状态

- 实现提交：`cdc4ac4`（`feat: add B1 synthetic tutoring core`）。
- 分支：`codex/b1-agent-core`，已推送并回读确认 `fork/codex/b1-agent-core` 指向同一提交。
- 上游 PR：当前环境无 `gh`，GitHub 浏览器自动化连接超时，尚未创建；可从 fork 分支向 `paher-din/XunJie:main` 建立 PR，正文应关联 `Closes #11` 并保留本文的未执行项。
- `.trae/` 保持原有未跟踪状态，未暂存、提交或推送。
