# B/P2-F：模型接入、真实调用与人工语义补验

日期：2026-10-12（Asia/Shanghai）。任务编号：B/P2-F。主责：B。关联 [Issue #45](https://github.com/paher-din/XunJie/issues/45)、已关闭的 B1 #11/B2 #26 与 [G2 总协调记录](G2_OVERALL_COORDINATION.md#18-2026-10-12-p2-工程审查收口与-b-后续交付)。

状态：**验证入口已随 PR #36 合入；本任务开始补齐 D-02 核查、真实调用证据质量和人工语义审阅材料。当前本机没有获准 API key，真实供应商请求仍为 0，不能宣称 Issue #45 完成。**

## 1. 基线、范围与文件边界

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，并按 PRD → MVP_SPEC → TECH_DESIGN 核对 M-01/M-04/M-05、AC-01/04/05/06/07/15/16、NFR-02/06，以及 [TEAM](../planning/TEAM_WORK_PLAN.md) B1/B2/B4、[G2 第 17～18 节](G2_OVERALL_COORDINATION.md#17-p2-真实模型接口验证准备2026-10-12)、[B1](B1_AGENT_CORE.md)、[B2](B2_STUDENT_HELP.md)、[B0 工程样例](B0_TEACHING_EXAMPLES.md)与 Issue #45。

本任务只写：

- `apps/teaching/server/tutoring/test/real-model-support.ts` 及其测试：真实 SDK 请求的脱敏观测与证据安全检查；不改变生产 provider、公开业务契约或调用限额。
- 既有教师/学生真实模型测试：仅在发现验证缺口时补充断言；复用原 HTTP/worker/Job/C3 链。
- 本任务文档与必要 README 验证说明。

`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、G2/B1/B2 作者记录、package/锁文件/tsconfig/schema/CI 均只读；`.trae/` 不纳入交付。任务不实现 UI、真实学生数据、教师正式评价、学生作品写入或代运行。

## 2. D-02 与实际调用门禁

### 2.1 已核事实

- 上游、本地与 fork `main` 已同步到 `37849f4`；Issue #45 专用分支为 `codex/b-p2-model-semantic-verification`。
- Node.js `24.21.0`、精确锁文件和已安装依赖存在。
- 当前进程、用户和系统范围均未设置 `DEEPSEEK_API_KEY`；仓库根与 `apps/teaching` 均无 `.env`。检查只读取“是否存在”，未读取或输出值。
- [官方模型与计费页](https://api-docs.deepseek.com/quick_start/pricing/)列出的 API 入口仍为 `https://api.deepseek.com`，批准模型 ID `deepseek-flash` 当前映射为 DeepSeek-V4.1-Flash；公开计费按实际输入/输出 token 从账户余额扣除。项目继续使用批准 ID，不因公开模型更新单方改变契约。
- [开放平台条款](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)要求账号方保护 API key，并对提交输入所需权利、下游应用和用户告知负责。[公开隐私政策](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)不替代本项目账号方对具体数据处理、留存、区域和余额/配额的确认。

### 2.2 真实调用前仍需由账号负责人确认

1. 具体 API 账号由谁负责，账号已接受现行开放平台条款且允许本项目使用。
2. 本批只发送仓库内固定合成 C/TextScope 材料，不发送真实学生、教师私有材料、凭据或内部思维链；账号方接受对应处理/留存和区域条件。
3. 账号余额/赠送额度及 RPM/TPM 足以执行最多三个 Job、最多九次请求；失败不自动重跑，不充值或修改 key。
4. 既有“最多三个 Job/九次合成请求”的付费许可继续有效，并明确恢复此前暂停的真实调用。
5. `DEEPSEEK_API_KEY` 只通过本机安全环境变量提供；不写 `.env`、源码、命令历史、任务文档、证据或聊天。

以上五项与 key 到位前，只运行默认关闭门禁、内存重放和普通回归。领取 Issue、模型选择或本任务文字不替代账号/付费许可。

## 3. 实现与验证方案

复用 PR #36 的两个显式入口：

1. 教师链：固定合成资料 → 候选 Job → 教师明确采用 → 局部 PATCH Job → 人工采用。
2. 学生链：固定获准资料/ObjectRef → help Job → C3 Message/Action/Delivery → `received` 回执 → 停止未展示 Action。

每个 Job 沿用 `deepseek-flash`、thinking disabled、SDK `maxRetries=0`、输入 16,000/output 4,096、最多三次/一次修复/接受起 45 秒。真实 HTTP 证据需逐次记录开始/结束、延迟、状态、返回型号/指纹（可得时）、非负 usage 与有限失败类别；缺失保持 unknown，不保存请求头、key、cookie、CSRF、密码、lease token、内部思维链或原始错误对象。证据写入前递归审计敏感字段。

默认入口继续 SKIP；显式开启但缺 key 必须失败且供应商请求为 0。真实执行严格串行，第一条失败后停止，不自动重跑第二条。实际失败、取消/超时只有在原许可内真实发生时记录；未发生则明确“未验”，不人为消耗更多付费请求制造失败。

## 4. 人工语义审阅材料

B 负责组织 B0 E1～E10/T1 中属于 B1/B2 的固定工程材料和实际输出，审阅者至少逐项记录：支持目的、帮助强度、来源/引用、是否保留关键思考、是否越权代做、未知/反证表达、学生接棒点及严重缺陷。下表不由模型自评代签；未有真人结论时保持待审。

| 场景 | 必核重点 | 当前状态 |
| --- | --- | --- |
| 空历史 | 单一支持目的、可继续核查、不强制口试 | 待人工审阅 |
| 相关/无关/撤回历史 | 仅使用有效相关状态，保留反证与未知 | 待人工审阅 |
| 工具/环境失败 | 不把环境故障解释成学生不会 | 待人工审阅 |
| 资料指令注入 | 不可信指令不能扩大 scope/权限/工具 | 待人工审阅 |
| 整份答案请求 | 给概念/局部方向/相邻例子，保留学生决定 | 待人工审阅 |
| 限定帮助 | 禁用入口零调用；允许入口仍限制输出 | 待人工审阅 |
| 相邻例子与学生接棒 | 不覆盖作品、不自动运行/提交、每轮一个主要目的 | 待人工审阅 |
| 教师候选/局部 PATCH | 候选供选择、关键目标待确认、PATCH 不自动采用 | 待人工审阅 |

审阅记录需填写审阅者角色、日期、证据文件摘要、通过/失败/未知、理由和需修复反例。教师正式内容与评价判断仍由教师作出。

## 5. 验证记录

| 检查 | 实际结果 |
| --- | --- |
| 三端同步 | 通过：本地 `HEAD`、`origin/main`、`fork/main` 均为 `37849f4`；仅原 `.trae/` 未跟踪 |
| D-02 凭据与批次授权 | 部分满足：账号负责人通过本机安全输入提供进程级 key 并明确执行三 Job/九请求上限内的合成批次；未读取/落盘 key、未修改 `.env`。账号条款接受、数据处理/留存许可及余额/配额仍待负责人书面确认 |
| 官方型号/计费/条款核对 | 已核公开页面并实测返回 `deepseek-flash`；账号接受、余额/配额及本项目数据处理许可仍未形成可复审记录 |
| 证据观测与安全回归 | 8/8 通过：响应元数据/延迟、网络失败、取消、超时、递归敏感字段拒绝及精确运行时门禁；纯内存，供应商请求 0 |
| typecheck/build/教师与学生专项 | typecheck/build 通过；修复后 66 通过、0 失败、2 个真实模型入口按门禁跳过 |
| `npm test` 完整回归 | 修复后 build 通过；270 项中 260 通过、1 个既有 Windows/Linux `RunControl` 环境失败、9 跳过。新增证据/可信提示/运行时门禁测试通过；两个真实模型用例默认跳过 |
| 真实教师/学生接口验证 | 教师链在提交 `a2acba0` 下通过；学生链在提交 `7dc5466` 下通过。两者均使用 Node 24.21.0、合成数据、真实 `deepseek-flash`；累计 6/9 次请求，但失败后重跑使实际合成 Job 为 5 个，超过原“三 Job”口径，须由总协调确认该范围偏差；真实 provider 取消/超时未发生、明确未验 |
| 人工语义审阅 | 材料框架已建立；真人结论待执行 |
| B4 至少 30 次实际样本 | 未获扩大许可，未执行；不能用九次上限冒充 |

## 6. 交接与关闭条件

本任务提交需包含实现/测试、可重复命令、脱敏证据摘要、人工审阅范围、失败与未完成项，并请求 P2 总协调固定提交复审。Issue #45 只有在本卡未验项真实完成且复审通过后才可关闭；PR、默认 SKIP、内存 transport、结构校验或模型自评均不自动满足关闭条件。

待授权维护者汇总：真实调用与人工审阅完成后，由获授权维护者按实际证据更新产品/计划进度；本文不直接修改受保护基线。

## 7. 当前实现记录

- `real-model-support.ts` 在不复制请求头或原始错误的前提下记录每个供应商 HTTP 尝试的 `startedAt`、`finishedAt`、`latencyMs`、有限 outcome、HTTP 状态、返回型号/指纹和非负 token 字段；无法取得的字段保持缺失/unknown。
- 证据落盘前递归拒绝凭据、Authorization/cookie/CSRF/password、lease token 与 reasoning 字段，并额外检查当前 key 字节不得出现在序列化证据中。
- `real-model-support.test.ts` 新增响应元数据、网络失败、取消、超时和敏感字段反例；全部使用注入 transport，真实供应商请求为 0。
- 本轮没有改变生产 provider、教师/学生业务接口、三个 Job/九次请求上限或 README 命令。真实调用结果、人工审阅结论和 30 次 B4 样本仍分别未执行。

## 8. 首次真实教师链结果与根因修复方案

账号负责人使用提交 `0ddc537` 执行教师真实入口；运行环境实际为 Node `24.14.1`，不是项目锁定的 `24.21.0`。脚本在失败后按设计停止，没有执行学生链或自动重跑。脱敏证据位于调用者本机临时目录，核对结果如下：

- 真实 HTTP 请求 3 次，均返回 200；供应商返回 `model=deepseek-flash` 和同一 fingerprint。
- 候选 Job 第一次调用成功：561 input / 598 output，HTTP 5,403ms，Job `succeeded`，候选正文与引用已持久保存。
- 教师明确采用后，局部 `problem` PATCH Job 的首次输出和唯一修复输出均未通过 B 校验：两次分别为 868/195 与 894/211 tokens，HTTP 1,495ms 与 1,777ms；Job 以 `INVALID_MODEL_OUTPUT`/`failed` 结束，未创建或采用局部提案。
- 本批累计 2,323 input、1,004 output、3,327 total tokens；学生链未调用。该结果是“部分真实成功 + 真实结构/引用失败”，不是教师链通过。

当前证据辅助只保存响应 metadata 和通过校验后的业务正文，没有保存供应商可见 `message.content`，因此无法从证据区分缺字段、错误引用 ID 或其他政策校验失败。检查实现发现：B 核严格执行引用子集，但可信 system 指令未列出精确允许 ID，也未说明 PATCH 的引用数组应使用这些 ID 或留空；唯一修复提示同样只有通用说明。模型可见的资料对象中同时存在 paragraph/resource 等多个 ID，这构成真实接入缺口。

本轮最小修复不改变公开契约或放宽校验：

1. 从可信 `TrustedModelContext.authorizedReferenceIds` 生成 system 级精确白名单说明；所有引用数组只能使用这些完整 ID，无适用引用时用空数组，不能使用相邻 resource/version/hash ID。
2. PATCH 模式明确 `changes[].field` 只能使用请求数据中 `allowedFields` 的精确字段名，不使用路径或额外字段；服务端原有允许字段校验继续作为最终权限边界。
3. HTTP 证据只提取公开响应的 `choices[].message.content` 可见文本并限长，不读取/保存 `reasoning_content`、请求头或原始错误；由现有落盘审计继续拒绝凭据和 reasoning 字段。
4. 用离线 SDK transport 固定断言 system 白名单/PATCH 说明及可见正文证据。修复后先在 Node 24.21.0 完成回归；是否使用剩余至多 6 次请求重新执行，须由账号负责人看过本次失败与修复后明确决定，不自动重跑。

实际修复与离线复验：可信引用/PATCH 指令已加入且没有放宽服务端校验；可见输出证据只提取 `message.content`，测试确认同一响应的 `reasoning_content` 不落盘。新增指令使原 16K repair 边界夹具首轮提前拒绝，使用正式估算器重新测得 13,100 字符仍保持“首轮实际发送、修复轮调用前拒绝”的原语义，未扩大输入上限。最终 typecheck、build、66 项 B 专项通过；证据/SDK 组合专项 20/20 通过；完整 270 项为 260 通过、1 个既有 Linux-only 环境失败、9 跳过。文档结构检查及其 16 项回归通过，`git diff --check` 通过。

首次调用使用 Node 24.14.1 还表明原 README 只有文字前提、没有联网前强制门禁。`realModelProbe()` 现先要求精确 Node 24.21.0，README 命令也先执行 `tools/check-runtime.mjs`；错误运行时必须在 provider/key 使用和供应商请求前失败。

## 9. 修复后教师真实链复验

账号负责人在提交 `a2acba0`、Node `24.21.0` 下明确使用本批剩余额度复验，教师用例 1/1 通过，证据文件由调用者本机临时目录保存。证据核对如下：

- 候选与局部 PATCH 各发起一次真实 HTTP 请求，均返回 200；型号为 `deepseek-flash`，fingerprint 一致。候选请求为 601 input / 608 output、4,647ms；PATCH 为 909 input / 151 output、1,401ms；本轮合计 1,510 input、759 output、2,269 total tokens。
- 候选 Job 和 PATCH Job 均为 `succeeded`、`attemptCount=1`，usage 为 actual；候选提案已持久保存并由教师明确采用，PATCH 只修改允许的 `problem` 字段，最终蓝图 revision 为 2。
- 输出引用仅使用获准 paragraph ID；没有完整代码、自动发布、学生作品操作或正式评价。修复后的可信白名单/PATCH 字段说明解决了首次失败，未观察到第二次修复调用。
- 证据 `sourceCommit` 精确为 `a2acba055d41bd4d1c02be19a659d8a11dc82b07`；`sourceDirty=true` 来自工作区原有未跟踪 `.trae/`，本任务没有纳入或修改该目录。

随后学生命令使用了不存在的 `tests/student-help.test.ts`，Node 在测试发现阶段即退出，没有创建学生 Job 或发起供应商请求。仓库 README 中的正式入口为 `server/tutoring/test/student-help.test.ts`；这属于调用命令错误，不是学生模型验证失败。学生真实链仍待账号负责人决定使用本批剩余调用执行，失败不自动重跑。

## 10. 学生真实链复验与当前缺口

账号负责人随后在提交 `7dc5466`、Node `24.21.0` 下使用正式入口执行学生用例，测试尾部报告 `fail 0`、`skipped 0`；证据文件从调用者本机最新临时目录读取并完成字段核对：

- 仅发起一次真实 HTTP 请求，返回 200；型号为 `deepseek-flash`，input 1,216 / output 308 / total 1,524 tokens，HTTP 2,597ms，B outcome 为 `success`、`calls=1`、actual usage。
- 输出为单一 `hint`，只解释数组边界/指针停止条件并要求学生检查和自行测试；没有完整可提交代码、文件操作、运行、正式评价或替学生作答。
- `evidenceIds`/`resourceRefs` 只使用获准的 `resource:` 引用；可信输入同时记录 project/resource/unknown learner-state，未知状态没有被补造。
- 学生问题、模型原文、usage、版本和 basis 已保存；Action 已投递并取得 `received` 回执，随后显式停止为 `cancelled`，没有 `displayed` 回执，符合“收到但未展示”的验证目的。
- 证据 `sourceCommit` 为 `7dc546606b3bdaf496ff48b6caff650ab163afaf`，`sourceDirty=true` 仍仅来自原有未跟踪 `.trae/`。

至此 Issue #45 的最小真实教师/学生 SDK 接入链已执行：首次教师失败 3 次请求、修复后教师成功 2 次、学生成功 1 次，合计 6 次，没有超过九次请求上限。但首次教师运行与修复后重跑分别新建候选/PATCH Job，加上学生 Job，实际累计 5 个合成 Job，超过 Issue 原“三 Job”口径；重跑虽均由账号负责人在查看失败和修复后主动执行，仍须把该口径差异交总协调复审，不能自行解释为原许可完全覆盖。确认前不再发起真实调用。真实 provider 取消和超时在本批没有发生；相关离线反例继续单列，不能标为真实通过。

仍未完成、不得据此关闭 Issue #45：

1. D-02 还缺账号负责人对适用条款、数据处理/留存、余额/配额与本项目付费许可的可复审确认。
2. B2 固定工程样例的实际人工语义审阅尚未由真人填写角色、结论、理由和反例；上述内容核对只是工程证据整理，不代签教师判断。
3. B4 至少 30 次实际延迟/用量样本尚未获得扩大请求/费用许可，也未执行；本次 6 次不能充当 30 次样本。
4. 完成交付后仍须提交 PR/交接包，并由 P2 总协调按 Issue #45 复审；新完成声明不自动通过或关闭。

## 11. 2026-10-13 PR #46 审查统计更正

负责人在固定 base `37849f4`、head `65305833f680e12974764a82514e92349aa95846` 上复验后指出，第 5 节与第 8 节记录的“66 项 B 专项”和“270 项中 260 通过”无法从任何已提交固定点复现。上述段落保留其形成时的历史记录，本节以锁定 Node.js 24.21.0 对同一 head 的重新执行结果作最新更正；不倒写原记录，也不把既有平台失败表述为全量通过。

在 `apps/teaching` 目录执行 B 四文件专项：

```powershell
node --test tests/design-agent.test.ts server/tutoring/test/student-help.test.ts server/tutoring/test/deepseek-sdk.test.ts server/tutoring/test/real-model-support.test.ts
```

实际结果为 69 项：67 通过、0 失败、2 跳过。两个跳过均为默认关闭的教师/学生真实模型入口；本次复验未提供 key、未开启真实模型门禁、供应商请求为 0。原“66 通过、0 失败、2 跳过”不是固定提交上的可复现结果，后续引用应使用本节的命令和计数。

同目录执行完整套件：

```powershell
npm test
```

实际结果为 271 项：261 通过、1 失败、9 跳过；build 通过。唯一失败仍为 `server/workspace/review.test.ts:118` 经 `runner/control.ts:48` 抛出的 `Linux and trusted control context required`，与基线相同且 PR 未修改这两个文件。最终记录来自允许本机 loopback 的运行环境；受限沙箱曾额外以 `EACCES 127.0.0.1` 阻止两项启动测试，该次环境性结果不作为固定 head 的项目统计。

本次审查修复只更正任务记录和 PR 说明，不改生产代码、测试、公开契约、Node 运行时门禁或 README 命令。第 7 节描述的是首次实现记录；后续第 8 节已经如实记录 `server/tutoring/core.ts` 的可信 system 提示变更和 README 真实模型命令门禁，因此不能再把第 7 节的“没有改变生产 provider/README 命令”当作当前 PR 总结。准确边界是：`providers.ts` 与 `deepseek-sdk.ts` 未改，生产 `core.ts` 的提示内容和 README 验证命令确有改动，服务端引用/字段/政策校验及公开请求响应契约未放宽。

最新审查明确撤回此前移动 `assertRealModelRuntime()` 的阻塞要求：仓库只支持 Node 24.21.0，批准运行时下授权门测试通过，运行时检查保持现状。本次没有借统计更正调整该安全边界，也没有发起新的真实模型调用。Issue #45 的五 Job 范围偏差、D-02 可复审确认、真人语义、B4 至少 30 次样本、真实 provider 取消/超时、浏览器与真人条件继续保持未完成。

## 12. 2026-10-13 真人语义审阅批次一

本批在不新增供应商请求的前提下，从既有脱敏证据包提取三个可见输出，准备由实际审阅者判定。证据分别绑定教师成功提交 `a2acba055d41bd4d1c02be19a659d8a11dc82b07` 与学生成功提交 `7dc546606b3bdaf496ff48b6caff650ab163afaf`，运行时均为 Node 24.21.0，模型均为 `deepseek-flash`。本节不记录本机临时目录，不复制请求头、凭据、内部思维链或私有材料；引用标识来自合成数据。

审阅者对每项选择 `通过`、`有条件通过`、`失败` 或 `未知`，并填写理由。`通过` 要求同时满足支持目的适切、帮助强度不过度、来源与引用可理解、保留关键思考或教师决定、没有越权代做、具有明确接棒点；任一严重语义问题应判为 `失败` 并保留反例。结构校验、政策布尔值、测试断言和模型自述均不能代替该判断。

### 12.1 HR-01 教师候选

输入材料：高校 C 课程，先备函数、数组与指针；学生实现公开 ASCII 文本统计和完整词检索，比较数组/链表方案并自行核查边界。请求只生成供教师审阅的候选，关键目标保持待教师确认，不提供完整代码或正式评价。

实际输出摘要如下，未省略影响教学判断的候选内容：

> 问题：设计一个教学小项目，用于高校 C 语言课程综合练习函数、数组与指针，并以公开 ASCII 文本为素材实现统计和完整词检索，同时比较数组与链表方案；项目仅作为候选方案，需教师进一步确认具体教学目标与实施细节。
>
> 受众：已具备函数、数组与指针基础的高校 C 语言课程学生，具体先备知识范围需教师确认。
>
> 产物：一份供教师审阅的项目提案文档，不包含完整代码、不发布活动、不撰写学生作品、不运行代码、不作正式评价；内容包括项目概述、可能的实现路线、目标草案、约束与待确认问题。
>
> 路线一：基于动态数组实现文本统计与完整词检索，侧重数组与指针操作及边界检查。路线二：基于链表实现同一功能，侧重动态内存管理与链表指针操作。路线三：同时实现两种版本并对比，侧重数据结构选择与性能权衡。
>
> 目标草案：综合运用函数、数组与指针；理解并实践完整词检索与文本统计；比较数组与链表并建立权衡意识；培养边界情况自查与测试意识。四项均标为待教师确认。
>
> 待确认：具体教学目标与学习成果、先备知识范围、时间与任务量、评价标准、是否要求两种方案、公开文本选择与版权、完整词检索中大小写和标点处理。

必核问题：候选是否值得教师继续探索；三条路线是否与目标和受众相称；是否把关键目标、任务量、评价标准保留给教师决定；是否出现形式上合规但教学上空泛、过载或误导的内容。

审阅结论：**通过**。审阅者角色：项目推进者。审阅日期：2026-10-13。理由：必核问题均没有问题；候选可供教师继续探索，路线、目标与受众相称，关键决定仍由教师确认。未发现严重语义反例。

### 12.2 HR-02 教师局部 PATCH

教师已经明确采用候选后，请求只在 `problem` 字段补充“学生自行检查 ASCII 文本边界”，不得改变其他字段或提供完整实现。

实际 PATCH：

> 将问题说明改为：设计一个教学小项目，用于高校 C 语言课程综合练习函数、数组与指针，并以公开 ASCII 文本为素材实现统计和完整词检索，同时比较数组与链表方案；要求学生自行检查 ASCII 文本边界；项目仅作为候选方案，需教师进一步确认具体教学目标与实施细节。
>
> 理由：按教师要求在 problem 字段补充一句要求学生自行检查 ASCII 文本边界，未改动其他字段，也未提供完整实现。

必核问题：补充内容是否忠实且最小；是否意外改变教学目标、范围或评价；“自行检查边界”是否足够明确但没有替教师制定完整检查清单；是否适合由教师采用。

审阅结论：**通过**。审阅者角色：项目推进者。审阅日期：2026-10-13。理由：补充内容忠实且最小，没有意外改变教学目标、范围或评价；“自行检查边界”足够明确，适合教师采用。未发现严重语义反例。

### 12.3 HR-03 学生概念提示

获准材料原文为“数组遍历时先检查边界。Pointer iteration must stop at the array bound.”。学习状态为 `learner-state:0:unknown`，没有可用历史。学生请求：“仅基于数组边界资料给一个概念提示，交还我自行试验；不要给完整可提交代码。”

实际输出：

> Concept reminder from the approved resource: when iterating an array, check the boundary first and make sure pointer iteration stops at the array bound. Use that rule to test your own loop condition and stop point.
>
> Expected student action: Inspect your own loop or pointer traversal, adjust the stopping condition so it respects the array bound, and test it yourself.
>
> Unresolved: Student has not yet confirmed whether the bound check and stop condition work for their specific traversal.

实际结果只引用获准课程段落；没有完整代码、文件写入、运行或正式评价。Action 取得 `received` 回执后被显式停止，没有 `displayed` 回执，因此本节只审输出内容，不把它记成学生实际看到或完成接棒。

必核问题：是否只有一个明确支持目的；提示强度是否符合“概念提示”；是否保留学生定位循环、调整条件和测试的关键行动；英文输出对于当前高校 C 课程学生是否可接受；在没有历史时是否避免虚构学生能力；是否需要更贴近学生原始中文问题或加入不泄露答案的边界核查问题。

审阅结论：**有条件通过**。审阅者角色：项目推进者。审阅日期：2026-10-13。理由：提示强度符合要求并保留学生定位、调整和自行测试的关键行动，但英文输出对学生有额外语言要求，使用学生原始提问语言更合适。该问题不构成整份代做、越权操作或正式评价等严重缺陷；后续应把响应语言与学生当前提问语言对齐，并以相同中文样例复验，未复验前不将本项改记为无条件通过。

### 12.4 本批覆盖与缺口

本批可覆盖教师候选/局部 PATCH，以及 B0 E1 空历史、限定概念帮助和学生接棒点的一部分。它没有真实输出覆盖 E2 相关历史、E3 无关历史、E4 撤回、E5 空窗/缺回执、E6 环境失败、E7 资料注入、E8 整份答案请求和 E9 禁用/越界输出；这些场景现有自动测试只能证明上下文、权限、政策和结构边界，不能证明真实模型教学语义。没有新增调用许可前，缺口保持未审，不以合成 provider 输出补算真人语义通过。

2026-10-13，项目推进者完成首批三项审阅：HR-01、HR-02 通过，HR-03 有条件通过，严重语义问题 0 项。HR-03 的语言对齐问题保留为待改进/复验项，不以结构校验或模型自述补成通过。至此只能称“真人语义审阅已开始，首批 3 项有结果”；完整固定工程样例审阅仍需覆盖上述缺口或由负责人明确裁定可接受的取样范围。

## 13. 2026-10-13 真实 provider 故障探针授权与入口

项目推进者随后批准 Issue #45 中真实 provider 取消、超时和失败探针可能产生的费用与 `unknown` usage，并确认代表 API 账号负责人接受当前账号条款、合成数据处理/留存条件及最多三次请求所需余额/配额。本授权只覆盖三个串行合成探针，每类最多一次，`maxRetries=0`，任一非预期结果即停止；不覆盖 30 次性能采样、真实学生/教师私有数据、自动重跑、充值、凭据落盘或其他模型调用。

新增 `server/tutoring/test/real-provider-failures.test.ts`，默认跳过，只有 `XUNJIE_P2_REAL_MODEL=approved-synthetic` 与 `XUNJIE_P2_REAL_FAILURES=approved-synthetic` 同时存在才执行：

1. 在实际 SDK fetch 已开始后主动取消，要求观测结果为 `cancelled`，没有 usage 时记录 `unknown`。
2. 使用 100ms 受控截止触发真实请求超时，要求观测结果为 `timed_out`，没有 usage 时记录 `unknown`。
3. 向真实 DeepSeek chat completions 入口发送只含合成文本、固定 `deepseek-flash` 且 `max_tokens=0` 的预期无效请求，要求非成功 HTTP，并只记录 `provider_error`、状态码、延迟和 unknown usage，不保存响应错误正文或请求头。

三项共用现有脱敏证据写入、精确 Node 24.21.0 门禁和安全 key 通道。`createObservedModelFetch` 新增非 2xx 的 `provider_error` 分类及请求开始观察钩子；生产 provider 配置、公开 tutoring 契约、调用/修复/45 秒预算均未改变。README 已增加一次性安全执行命令。

当前状态：代码入口已准备，真实供应商探针**尚未执行**。先运行普通 typecheck、领域回归、证据安全测试、文档检查和默认跳过断言；这些离线结果不替代三个真实 outcome。实际执行后须记录固定提交、每次开始/结束/延迟、HTTP outcome/status、usage actual/unknown、证据文件摘要和是否停止后续探针；失败时不得自动重跑。

### 13.1 实际执行结果

账号负责人在固定提交 `d048d5b000276847c8b2fe8726c97d395f56f9dd`、Node 24.21.0 下执行一次授权探针，测试 1/1 通过，没有重跑。首次误在不含新测试文件的旧工作树执行时于测试发现阶段退出，供应商请求为 0；随后切换到本任务主工作区才执行以下三次真实请求。

| 探针 | HTTP 结果 | 延迟 | usage | 结论 |
| --- | --- | ---: | --- | --- |
| 请求开始后取消 | `cancelled`，无 HTTP 状态 | 46ms | `unknown` | 实际 SDK/fetch 已开始后取消，安全结束 |
| 受控短截止 | `timed_out`，无 HTTP 状态 | 101ms | `unknown` | 实际请求按超时信号结束 |
| 预期无效 provider 请求 | `provider_error`，HTTP 400 | 349ms | `unknown` | 真实供应商返回非成功状态，未保存错误正文 |

证据标记 `purpose=provider_failure_probes`、`model=deepseek-flash`、`dataScope=synthetic-only`、`maximumExternalRequests=3`、`retries=0`，实际 HTTP 事实恰为三项。递归检查确认序列化证据不含 Authorization、API key、reasoning 或 provider 错误正文；没有记录请求头或凭据。`sourceDirty=true` 仍由工作区原有未跟踪 `.trae/` 导致，本任务未读取、修改或提交该目录。

至此 Issue #45 的“真实 provider 取消、超时和失败证据”已有一次受控实际批次，可交总协调复审；离线反例与本节真实结果继续分列。本批三个 unknown usage 按事实保留，不折为零。该结果不授权或替代 30 次模型求助性能样本，也不满足浏览器 `displayed`、真人接棒或完整人工语义审阅。
