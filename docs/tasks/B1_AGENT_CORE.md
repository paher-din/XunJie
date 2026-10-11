# B1：教师生成与学生辅导合成核心

日期：2026-10-09（Asia/Shanghai），2026-10-11 按 Issue #11 最新收口要求补齐实际 SDK 适配。任务编号：B1。主责：B。关联 [Issue #11](https://github.com/paher-din/XunJie/issues/11)、[G1 #9](https://github.com/paher-din/XunJie/issues/9) 与已合并 [PR #15](https://github.com/paher-din/XunJie/pull/15)。

状态：**合成核心、PR #15 审查修复、实际 AI SDK/DeepSeek provider/Zod 适配、最终请求输入上界、repair 指令和零供应商网络的受控 transport 测试已实现。** 共享锁定依赖的 TypeScript 7 类型检查已通过。D-02 实际 API/账号/条款/数据/配额、凭据与付费调用尚未授权，因此真实 DeepSeek 记录未执行，Issue #11 仍不能关闭；30 次性能和人工教学语义仍属 B4。

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
- 模型结果执行结构、引用子集、帮助政策及禁止能力校验；成功 body 按公开契约白名单重新构造，不携带模型附加的未知字段；失败最多修复一次。
- 单轮最多 3 次，接受起最长 45 秒；provider 与当前性守卫共享取消信号和绝对截止边界，守卫完成后再次核验取消与截止，迟到结果不能成功返回。
- 每次已发起 provider 调用先预留 unknown usage，只有收到实际 usage 才更新；任一次已发起调用缺 usage 时整轮保持 unknown，不按零计。输入超限发生在实际 invoker 前，不计为已发送调用。

`server/tutoring/providers.ts` 提供确定性 `SyntheticProvider` 和 DeepSeek 调用边界；`schemas.ts` 为四种教师模式及学生辅导定义 Zod 结构；`deepseek-sdk.ts` 实际调用锁定的 `ai@7.0.136` 与 `@ai-sdk/deepseek@3.0.63`。适配器固定 `deepseek-flash`、`maxRetries=0`、显式 `thinking.type=disabled`、4,096 输出 token，透传 AbortSignal/剩余时限，不注册 tool、联网、文件、代码执行、发布或评价能力。

输入限制不再使用测试计数器或未说明的字符长度。代码重建实际 SDK/provider 最终线上投影（包含 JSON Schema 兼容系统消息、固定政策、不可信输入、repair 指令及消息模板），以 UTF-8 字节数加 256 个模板 token 保留位作为保守 token 上界。普通 tokenizer token 不会多于对应 UTF-8 字节数，因此该方案只会提前拒绝，不会低估后发送；超限不静默截断。供应商返回 usage 仍是实际计费 token 的权威值，缺失时保持 `unknown`。

repair 不只是内部布尔值：首次结构/引用/政策校验失败后，第二次实际 SDK 系统指令会明确要求修复这三类问题；它与其他 provider 调用共享最多 3 次和接受起 45 秒。

## 3. 合成样例与验证结果

领域测试取 B0 E1～E10 和 T1 中属于 B1 的场景，覆盖：教师候选数量/修复、patch 基础版本、空历史、缺输入、越权引用、资料指令注入、整份答案政策、禁用帮助、三次上限、取消、迟到、过时、超时、provider 故障、actual/unknown usage、预算耗尽，以及 DeepSeek 配置和输入上限。PR #15 审查修复另覆盖教师四种模式与学生 body 的未知字段剥离、挂起守卫的取消/截止、守卫返回后的取消复查、第二次调用失败/取消/超时的 unknown usage，以及后续输入超限不计实际调用。T2 候选学习状态分析属于 B3，未在本任务实现。

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过；精确 Node 24.21.0、TypeScript 7.0.2，包含实际 Zod/AI SDK/DeepSeek 适配源码 |
| `node --test server/tutoring/test/*.test.ts` | 45/45 通过；其中 9 项通过实际 SDK/provider 的受控 transport，供应商网络调用 0 |
| 同命令增加 `--experimental-test-coverage` | 45/45 通过；合计 line 98.17%、branch 86.16%、functions 100% |
| `npm test` | build 通过；统一回归 188 项中 178 通过、3 失败、7 跳过。三项失败均不在 B1：Windows 缺 Linux/trusted runner context 1 项，当前受限环境本机 loopback `EACCES` 2 项；B1 45 项在同一回归内全部通过。后两项在获准宿主环境单独复跑 `tests/startup.test.ts` 为 4/4 通过，证实为沙箱 loopback 限制 |
| 首次领域测试 | 14/17，通过测试发现禁止能力扫描把值为 false 的政策声明误判为能力；修正为仅拒绝启用的禁止能力后复跑通过，并新增忽略 AbortSignal provider 的即时取消用例 |
| PR #15 首轮审查修复 | 负责人在固定提交 `d82f540` 提出 2 项 P1、2 项 P2；已修复守卫边界、逐调用 usage、未知字段重建和 Issue 关联语义，新增反例均通过，等待复审 |
| Zod/AI SDK/@ai-sdk/deepseek 实包兼容 | 通过；验证模型构造、JSON 对象兼容模式/Zod 解析、实际请求映射、repair、引用白名单、usage/故障/取消/迟到/上限，自定义 transport 调用 10 次均在内存中完成 |
| 真实 DeepSeek、30 次性能、人工语义 | 未执行；账号/API/条款/数据/凭据/付费条件未落实，B4 后置 |
| 服务端、浏览器、真人 | 未执行；等待 A3/B2/C2 与最终 UI 接入 |

## 4. A3/B2/C 接入样例与交接

业务调用方从已授权的运行配置取得凭据（不写入源码、日志或 Job），构造一个 provider，再与 C 提供的当前性守卫一起传给核心：

```ts
const provider = createAiSdkDeepSeekProvider({ apiKey, baseURL });

const teacher = await generateTeacherProposal(trustedTeacherRequest, {
  provider,
  checkCurrent: currentGenerationGuard,
});
const student = await generateStudentHelp(trustedStudentRequest, {
  provider,
  checkCurrent: currentAttemptGuard,
});
```

A3/B2 只在 `outcome === "success"` 时消费已校验 body；C 保存该结果携带的 calls/usage/版本与可信 Job 信封。`stale/cancelled/timed_out` 及迟到完成不得投递。实际路由、作业持久化、回执/事件与消息保存仍归 A/C，B 不建立替代实现。

## 5. 剩余限制

- **A1 交接已消费：** 本次没有修改 A 负责的 package/锁文件/tsconfig；使用现有精确版本完成了静态和离线 SDK 兼容检查。
- **给 A3：** 调用 `generateTeacherProposal`，保存 proposal/applicability；采用仍走 A 的 PATCH/CAS，B 不覆盖蓝图或发布活动。
- **给 B2：** 调用 `generateStudentHelp`，接入真实 ObjectRef、帮助政策和有效状态；无历史不阻止求助。
- **给 C2/C3：** 提供可信上下文、当前性守卫、持久取消与 usage/Job/Action 保存；本模块不另造队列、回执或事件表。
- **验收边界：** schema/标志只能证明确定性结构约束，不能证明普通语言输出的教学适切性；人工语义审阅保留给 B4。

待授权维护者汇总：MVP_SPEC §10 和 TEAM 可登记“B1 合成核心、实际 SDK/DeepSeek/Zod 适配、保守 16K 输入上界、repair 指令与零供应商网络离线验证已完成，B1 领域测试 45/45、typecheck 通过；真实 DeepSeek 因 D-02/凭据/付费授权未执行，Issue #11 保持开放”。本文不直接修改受保护基线。

## 6. Git 交付状态

- 实现提交：`cdc4ac4`（`feat: add B1 synthetic tutoring core`）。
- 分支：`codex/b1-agent-core`；首轮审查修复提交 `52b8800`（`fix: address B1 review feedback`）已推送到 fork。
- 上游 [PR #15](https://github.com/paher-din/XunJie/pull/15) 已审查合并；其 `Refs #11` 语义正确，合成首批交接没有提前关闭 Issue #11。
- `.trae/` 保持原有未跟踪状态，未暂存、提交或推送。
- 2026-10-11 的 SDK 收口提交为 `fdd0c12`，分支 `codex/b1-sdk-adapter` 已推送到 fork，并建立上游 [PR #29](https://github.com/paher-din/XunJie/pull/29)。PR 正文使用 `Refs #11`，不在真实模型关闭条件缺失时使用 `Closes #11`。
