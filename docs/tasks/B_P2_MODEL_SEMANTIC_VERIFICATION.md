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
| D-02 本机凭据存在性 | 未满足：进程/用户/系统均无 key；未读取值、未修改 `.env`、供应商请求 0 |
| 官方型号/计费/条款核对 | 已核公开页面；账号接受、余额/配额及本项目数据处理许可仍待账号负责人确认 |
| 证据观测与安全回归 | 8/8 通过：响应元数据/延迟、网络失败、取消、超时、递归敏感字段拒绝及精确运行时门禁；纯内存，供应商请求 0 |
| typecheck/build/教师与学生专项 | typecheck/build 通过；修复后 66 通过、0 失败、2 个真实模型入口按门禁跳过 |
| `npm test` 完整回归 | 修复后 build 通过；270 项中 260 通过、1 个既有 Windows/Linux `RunControl` 环境失败、9 跳过。新增证据/可信提示/运行时门禁测试通过；两个真实模型用例默认跳过 |
| 真实教师/学生接口验证 | 教师链在修复提交 `a2acba0`、Node 24.21.0 下通过；学生链因调用者使用了不存在的旧路径而未启动，供应商请求 0，待用正式入口执行 |
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
