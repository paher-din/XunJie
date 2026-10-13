# B3：有依据的候选分析与反馈草稿

日期：2026-10-13（Asia/Shanghai）。任务编号：B3。主责：B。关联 [Issue #42](https://github.com/paher-din/XunJie/issues/42)、[P3 总协调 #37](https://github.com/paher-din/XunJie/issues/37)、[A4 #41](https://github.com/paher-din/XunJie/issues/41) 与 [C4 #43](https://github.com/paher-din/XunJie/issues/43)。

状态：**独立合成核心、固定 fixture、Issue 评论指定的 A4/B2 接缝复核、一次固定合成材料的真实 DeepSeek 候选及教师角色人工语义审阅均已实现或验证通过；已从最新 `main`（`cde69cc`，A4 #49 / C4 #47 / DL-C #48 / PR #46 等已合入）重放并通过。C2/C3/C4 实际引用链、A5 消费交接及 P5 浏览器/真人验收仍待后续批次。** 本分支原显式堆叠于 A4 PR #49 固定 head；#49 已合入 `main`，本批已 rebase 到 `main` 顶端（`9aa4e83`）并复验。Issue #42 评论新增的 B2 可选状态读取接缝复核已纳入并留下实际命令/结果。

## 1. 基线、依据与边界

已按 `AGENTS.md` 的文档优先顺序阅读 `README.md`、PRD 的三条能力线及 PRD-06/07/08、MVP_SPEC M-06/07/08/09 与 AC-07/08/16、TECH_DESIGN §4.2/4.3/6.3/7.2.1、TEAM_WORK_PLAN B3/P3、G3 总协调记录、B0 候选分析提案、B1/B2 任务记录、Issue #42 正文及 2026-10-13 负责人评论，并核对 A4 PR #49 的实际接口和任务记录 §3/§7/§9。

本任务负责 B 所属的候选生成核心、反馈草稿、合成 fixture、领域测试，以及实际消费 A4 接缝的复核。B 只产生严格校验的 `learner_analysis` body；A/C 负责从真实授权请求反查 scope、冻结版本/引用、持久 Job/租约/原文/接纳或拒绝，A 负责有效状态与教师决定。B 不直接写 LearnerState、Feedback、作品或正式评价，不新建 HTTP 路由、数据库、Job、Message、Receipt、事件或 UI。

预计可写文件：

- `apps/teaching/contracts/tutoring/**`：B3 生成请求、可信目标/引用和结果类型；复用 A4 已批准的 `AnalysisBinding`/`ClaimBody`，不复制或改变其共享语义。
- `apps/teaching/server/tutoring/**`：候选上下文最小化、结构/引用/政策校验、最多三次/一次修复/45 秒执行边界，以及供受信 worker 调用的组合函数。
- `apps/teaching/server/tutoring/test/**`：固定合成场景、A4/B2 真实事务接缝复核和 B3 领域反例。
- 本文；若新增独立验证命令，再按真实结果同步 README。

`AGENTS.md`、`docs/product/**`、`docs/planning/**`、`docs/reference/**`、A4/C4 等他人任务稿、package/锁文件/tsconfig、数据库 schema 与 UI 保持只读。开发只使用隔离合成账号和内容；不调用真实模型，不读取真实学生或教师私有材料，不修改 `.env`、密钥、CI/CD 或部署。

## 2. 接口与实现方案

### 2.1 可信输入与不可信正文

A4 `review.queueAnalysis` 继续从真实已授权请求冻结 course/student/attempt、固定活动/政策、state/attempt/epoch/context/capture、分析版本、用途和 45 秒 deadline；`claimAnalysis` 返回绑定及租约。B3 不接受候选 body 自报这些字段。

B3 请求由受信宿主提供：A4 原 `job`/`binding`、固定活动的三条能力目标、与 binding 描述符一一对应的最少正文，以及从 binding 派生的 input/assistance/coverage 引用角色。源码、运行、消息、帮助、覆盖和资料正文全部是不可信数据；它们不能扩大 scope、目标、用途、引用白名单、引用角色、工具或权限。反馈草稿只作为可选草稿正文返回，不是正式 Feedback。

### 2.2 输出与校验

输出沿用 A4 `analysisBodySchema`：`kind=learner_analysis`、0～64 条 claims 和可选 `feedbackDraft`。每条 claim 必须：

- 只指向当前固定活动/课程内获准的 competencyId/version/domain/scope；
- evidenceIds/counterEvidenceIds 只取本 Job 获准引用，支持与反证不得重叠；
- 保留 `insufficient | supported_with_assistance | supported_in_check | conflicting`、帮助条件、unknown 和 unresolved；
- 工具故障、覆盖空窗、缺消息或缺独立检查只能形成未知/未解决，不直接形成知识错误或独立掌握；
- 不输出掌握百分比、正式分数、教师决定、作品修改或执行动作。

模型返回的根级、claim 级未知字段拒绝，不进入已校验 body。成功结果只携带重建后的 body、调用次数、延迟、actual/unknown usage 和 A4 固定版本。

### 2.3 有界执行与当前性

复用 B1 的统一执行边界：从原 Job 接受时间起最多 45 秒，最多 3 次 provider 调用，最多一次结构/政策修复；worker 更换、repair 和 SDK 重试不得重置。每次调用前后使用 A4 实际 current reader 检查 Job/停止、租约/恢复代际、state/attempt/epoch/context/capture、活动/政策和分析版本。迟到、过时、取消、超时或失败结果不得交给 `completeAnalysis`。

合成首批提供确定性 provider；实际 DeepSeek 适配复用 B1 固定配置并留到获准真实模型批次。模型不可用时只安全结束候选 Job，不阻止教师直接读取原始依据、人工复核和反馈。

## 3. 固定合成 fixture 与验收矩阵

固定场景覆盖三条能力线及共同边界：

| 场景 | 可信事实 | 必须保留的结论 |
| --- | --- | --- |
| E-B3-01 空历史/缺消息 | 只有当前作品快照，没有帮助或限定检查 | 可输出证据不足/unknown；不得补造独立掌握或失败 |
| E-B3-02 受助表现 | 当前作品表现与已 displayed/acknowledged 帮助同组 | 可输出 `supported_with_assistance`；不得抹去帮助条件 |
| E-B3-03 限定检查 | 可信课程检查与固定目标匹配 | 可输出 `supported_in_check`；stdout、自述 passed 或普通运行不可替代 |
| E-B3-04 工具故障/覆盖空窗 | 编译或执行基础设施失败，或采集暂停/拒收 | 记录 unknown/unresolved；不得当作知识错误或补传空窗 |
| E-B3-05 冲突/反证 | 同一证据组内有支持与反证 | 保留 `conflicting`；不平均成掌握率 |
| E-B3-06 无关/撤回历史 | 目标版本或活动不适用，或依据已 contested/withdrawn | 不进入新候选；不得换 claimId/措辞/analysisVersion 复活 |
| E-B3-07 重复运行 | 同 Attempt 同证据组重复运行 | 不累积为多次独立观察或掌握率 |
| E-B3-08 反馈草稿 | 作品结果、三条能力线、帮助/反证/未知齐备 | 只产 `draft` 语义，不冒充教师正式评价 |

自动验证还覆盖：越权/未知引用、错目标、重复支持/反证、未知字段、一次修复、三次上限、取消、截止、provider 失败、旧 state/epoch/generation/lease、actual/unknown usage，以及 A4 拒绝/回滚/幂等由真实 `queue/claim/complete/readCurrentInTransaction` 保持。

## 4. Issue #42 评论指派：A4/B2 接缝复核

负责人要求在 B3 消费 A4 状态能力时复核 `apps/teaching/server/tutoring/application.ts` 的可选 `readLearnerState`，不采信作者声明。复核必须使用 A4 PR #49 固定提交、真实临时 SQLite 事务和真实 B2 `executeStudentHelp`：

1. 工厂未装配 reader 时仍兼容 revision 0/空历史。
2. `createReviewApp` 自动装配后，preparation/runtime 手工 `learnerStateRevision` 与 claims 不能覆盖 A4 当前有效投影。
3. 初始装配、provider 前后 current guard、C3 接纳前以及重投前均使用真实 revision；状态改变后旧帮助不得投递。
4. 已显示帮助保留历史并标 `basisRevised`；未显示帮助不得冒充已观察。
5. B3 通过真实授权 request 调用 `review.queueAnalysis`，再以真实租约 `claimAnalysis`、`completeAnalysis` 接纳严格 body，并在同一事务能力 `readCurrentInTransaction` 中读到新 revision；浏览器不能传任意 courseId/studentId 提权。

复核结论必须记录命令、通过/失败数量和未执行项。发现 B 域问题只提交最小修复；需要改变 A4/C4 共享契约时停止并请求对应授权。

## 5. 依赖、交付与未完成项

- 本分支原基于当时尚未合入的 A4 PR #49；#49（含 C4 #47、DL-C #48）现已合入 `main`，本批随后两次重放到 `main`（见 §6.5～6.6），后续 PR 不再声明堆叠依赖。
- C2/C3 已提供实际引用/覆盖基础，C4/A4/DL-C 顺序集成也已进入 `main`；当前未完成的是用真实授权 input/assistance/coverage 正文贯通该链并形成实际验收证据，不是等待这些分支合入。
- B3 合成核心、fixture 和 A4/B2 接缝可在本批完成；真实 DeepSeek 候选、真实学生/教师材料、教师人工语义、浏览器与真人反馈分别等待明确条件和授权。
- #40 的首批 HDL 消费提案已在独立分支交付；共享 DTO 未经 #38 冻结前不编码。等待 #40 上游期间推进 #42 符合 TEAM 个人顺序例外，不表示 DL-B 已完成。
- 待实现与验证后，向 A4/A5/B4 交严格 body、引用/版本接缝、命令结果与未执行项；需要同步受保护基线时仅在本文提出“待授权维护者汇总”。

## 6. 实际结果

### 6.1 实现位置

- `contracts/tutoring/index.ts`：新增 `learner_analysis` purpose、严格候选/目标/请求类型，直接复用 A4 的 `AnalysisBinding`/`ClaimBody`。
- `server/tutoring/core.ts`：新增候选生成入口；核可信 scope/版本/目标与“送模正文 = 可引用白名单”，拒绝 provider claimId、未知字段、重复目标、伪造/重叠引用、缺依据支持、无反证冲突、帮助条件错配和丢弃 unknown。
- `server/tutoring/analysis.ts`：把 A4 的真实 Job/binding/lease 组装为 B 请求；调用前后核 state/attempt/epoch/context/capture/活动/政策/配置/租约；显式分析不因单独 capture 变化失效，被动分析保持 capture 守卫；动态预算、跨 worker 累计次数和未发送输入预检释放均由持久 callback 明确处理。
- `server/tutoring/providers.ts`、`schemas.ts`：实际 AI SDK/DeepSeek 注入边界支持严格 `learner_analysis` schema，仍固定 `deepseek-flash`、thinking disabled、`maxRetries=0`、16K 输入预检和 4096 输出。
- `server/tutoring/test/learner-analysis.fixtures.ts`：E-B3-01～08 固定合成工程样例。
- `server/tutoring/test/learner-analysis.test.ts`：B3 核心、A4 真实事务、B2 可选状态读取评论复核、调用/故障边界与离线 SDK 参数测试。

### 6.2 实际验证

运行环境均为 Node 24.21.0、仓库锁定依赖；供应商网络调用为 0。

| 命令/检查 | 实际结果 |
| --- | --- |
| `node tools/check-runtime.mjs` | 通过 |
| `tsc --noEmit` | 通过 |
| `tsc -p tsconfig.build.json` | 通过 |
| `node --test server/tutoring/test/learner-analysis.test.ts` | 17/17 通过，0 失败、0 跳过；含八组 fixture、一次 repair、动态预算、三次累计上限、取消/过时/租约、unknown usage、16K 预检释放及 DeepSeek 离线 invoker |
| `node --test --test-reporter=dot server/tutoring/test/*.test.ts` | 退出码 0；B1/B2/B3 tutoring 回归全部通过 |
| `node --test --test-reporter=dot tests/review.test.ts` | 退出码 0；A4 专项回归全部通过 |
| 应用统一测试集合 | 退出码 1：仅 3 项环境失败；1 项是 Windows 缺 Linux/trusted `RunControl` 的既有限制，2 项是沙箱拒绝 127.0.0.1 loopback |
| 沙箱外复跑 `node --test tests/startup.test.ts tests/app.test.ts` | 7/7 通过，证明上述 2 项 loopback 为沙箱限制；Linux 专用项仍失败并保留 |
| `node tools/a0-review/check.mjs` | 通过：40 份文档、613 处内部引用、`errors=[]`；业务测试字段仍为 `NOT_EXECUTED` |
| `node --test tools/a0-review/check.test.mjs` | 16/16 通过 |
| `git diff --check`、相对 A4 固定 head 的写入范围 | 通过；没有修改 product/planning/reference/AGENTS、数据库、package/锁文件/tsconfig/CI/CD，`.trae/` 未纳入 |

### 6.3 Issue #42 评论指派复核结论

复核结论为 **通过（限 A4 PR #49 固定 head 与本次合成事务）**：

- 真实授权学生 Session 通过 A4 `review.queueAnalysis` 冻结 scope/版本/引用，真实 `claimAnalysis` 取得租约；B3 只产严格 body，`completeAnalysis` 在真实 SQLite 事务接纳，`readCurrentInTransaction` 读到 revision 1 的 `model_candidate`。
- A4 工厂装配后，向 B2 preparation 手工注入 revision 900/空 claims 无法覆盖真实 revision 1/当前 claim；获准引用来自真实投影。
- provider 返回期间 A4 状态推进后，B2 运行守卫返回 `stale`，没有 delivery；原 A4 回归继续覆盖最终接纳与重投前同事务守卫、已显示历史的 `basisRevised`。
- 未装配 A4 reader 的 B1/B2 原路径由完整 tutoring 回归保持兼容；本批没有修改 B2 DTO、策略或模型格式。

这项通过只描述当时固定 head 上的合成事务结果；A4 PR #49 后续已经合并，但该历史结果仍不替代 A4 作者独立验收、C 域接缝复核、真实模型候选或教师人工语义。

### 6.4 未完成与下一步

- A4 PR #49 合入后的重放已于 2026-10-13 完成（见 §6.5）：从 `main` 顶端 rebase、typecheck 与完整测试套件复验通过，A4 `80a2721` 接口差异经 typecheck 核无漂移。
- 接 C2/C3/C4 的实际原始分析/提交/覆盖引用，验证 E-B3-02～07 对真实引用语义的 A4 接纳；当前只有 E-B3-01 经真实 A4 事务接纳，其余为严格合成策略/反例。
- 一次固定合成材料的真实 DeepSeek 候选、actual usage 和教师角色人工语义审阅已于 2026-10-13 完成，见 §6.8～6.9；provider 失败、取消、预算、过时和 unknown usage 仍由合成自动测试覆盖，不把本次单次成功调用扩大成所有真实故障路径均已外部触发。
- 与 A5 的反馈草稿实际消费交接尚未执行；浏览器 displayed、真人学生接棒和教学收益等待 UI/P5 与真实参与者条件，不在本批创建替代 UI 或代签。
- 待授权维护者汇总：可记录“B3 合成核心、固定 fixture、A4/B2 消费接缝、一次固定合成材料的真实 DeepSeek 候选及教师角色人工语义审阅已完成，并从最新 `main`（A4 #49 已合入）重放通过；C2/C3/C4 实际引用链、A5 消费交接和 UI/P5 真人验收仍未完成”。本文不直接修改产品/计划基线。

### 6.5 A4 #49 合入后的重放（2026-10-13）

A4 PR #49（含 C4 #47、DL-C #48）已合入上游 `main`（`1cd43f8`）。本分支由固定 head `6a4361b` rebase 到 `main` 顶端，提交 `17e61ae`；README 导航表冲突按“B3 行紧跟 B2、保留 I0_UI 行”双向合并，无内容丢失。重放结果（Node 24.21.0、仓库锁定依赖、供应商网络调用 0）：

| 命令/检查 | 实际结果 |
| --- | --- |
| `git rebase main` | 成功，唯一冲突为 `README.md`（B3 行与 I0_UI 行同点插入），已双向保留 |
| `tsc --noEmit` | 通过；A4 `80a2721` 对 `server/tutoring/application.ts` 等接缝的修复未破坏 B3 类型 |
| 完整测试套件（`npm test`） | 362 tests：348 pass / 1 fail / 13 skipped |
| 唯一失败 `server/workspace/review.test.ts:118` | `review: real RunControl preparation failure ends check without fabricating a RunRecord`；`RunControl` 构造器要求 `process.platform === 'linux'`（`runner/control.ts:46-48`），Windows 下必然失败，属 A4 引入的 Linux 专属测试，非 B3 回归 |

重放未引入新的 B3 失败；真实输入链、真实模型、人工语义与浏览器/真人验收保持 §6.4 的待办口径。

### 6.6 上游再次推进后的重放（2026-10-13）

上游 `main` 在首次重放后继续推进到 `cde69cc`（含 PR #46「B/P2 模型语义验证」与 W4「仓库入口与规则重写」等 26 个提交）。本分支再次 rebase 到该 `main` 顶端，提交重放为 `89e0f91`（feat）与 `9aa4e83`（docs）。重放结果（Node 24.21.0、仓库锁定依赖、供应商网络调用 0）：

| 命令/检查 | 实际结果 |
| --- | --- |
| `git rebase main` | 成功；冲突为 `README.md` 与 `server/tutoring/core.ts` 两处 |
| `README.md` 冲突 | main 已由 W4 重构（删除「文档」表格与「文档验证」章节，改为「任务与交接入口」），B3 原两处 README 改动针对已删除旧结构，故采用 main 版本（`git checkout --ours`），B3 任务文档入口经 G3 与「全部任务记录」可达 |
| `server/tutoring/core.ts` 冲突 | 两处均为「main 与 B3 在同一位置各自新增函数」：`trustedReferencePolicy` 与 `generateLearnerAnalysis`，以及 `containsCompleteReferenceId` 等与 `validAnalysisEnvelope`/`validateLearnerAnalysisBody`/`suppliedReferenceIds` 等，均双向保留并补全闭括号 |
| `tsc --noEmit` | 通过；main 新增的 P2 语义校验函数与 B3 候选校验函数共存，无类型漂移 |
| B3 专项 `node --test server/tutoring/test/learner-analysis.test.ts` | 17/17 通过 |
| 完整测试套件（`npm test`） | 372 pass / 2 fail / 16 skipped |

两项失败均为环境相关、非 B3 回归：

- `server/workspace/review.test.ts:118`（Linux 专属 `RunControl`）：`process.platform === 'linux'` 强制，Windows 下必然失败。
- `server/tutoring/test/index.test.ts:503`「cancellation interrupts a provider that ignores AbortSignal」：完整套件高负载下的时序 flaky（断言 80ms 内取消），单独运行该文件 47/47 通过，非 B3 回归。

重放未引入新的 B3 失败；真实输入链、真实模型、人工语义与浏览器/真人验收保持 §6.4 的待办口径。

### 6.7 PR #52 首轮审查修复（2026-10-13）

负责人 A 在 PR #52 固定 head `f8855d3` 提出两项 P2 和一项 P3。修复在已重放到 `cde69cc` 的本地 B3 分支完成：

- `R52-R01`：持久 `recordModelCall` 预留完成后、真实 provider 发送前，再次检查共享取消信号、45 秒绝对截止、A4 current guard 和动态预算。取消、过时、超时或预算撤回均使用独立清理信号释放对应未发送预留，实际 provider 调用数保持为 0；输入上限预检继续复用同一释放路径。
- `R52-R02`：送模引用 ID 现在必须与 binding 冻结的 input/assistance/coverage 引用 ID 一一相等，重复、缺失和额外引用均在预留及 provider 调用前拒绝，不再把缺失角色静默过滤。
- `R52-S01`：当前依赖说明改为 A4 #49、C4 #47 和 DL-C #48 已进入 `main`；保留 §6.5～6.6 的有日期重放历史，并继续区分“代码已合入”和“真实授权输入链未验收”。当前 README 已采用 `cde69cc` 的入口结构，不再包含审查所指的旧堆叠说明。
- 同时把原接缝测试中对整段随机 JSON 搜索 `900` 的宽泛断言收窄为结构化检查 `learnerStateRevision === 900`，避免随机哈希片段导致误报，不改变业务行为。

修复后的验证环境为 Node 24.21.0、仓库锁定依赖，供应商网络调用为 0：`tsc --noEmit` 与 `tsc -p tsconfig.build.json` 通过；B3 专项 23/23 通过；B1/B2/B3 tutoring 聚合回归退出码 0；A4 `tests/review.test.ts` 51/51 通过；文档检查通过（64 份文档、910 条内部链接、`errors=[]`）；检查器回归 16/16 通过；`git diff --check` 通过。真实模型与后置人工验收仍不计入本次审查修复。

### 6.8 B3 真实模型与真人后置验收入口（2026-10-13）

项目负责人明确批准继续执行 B3 的真实 DeepSeek 调用及相应费用和可能出现的 `unknown usage`。为避免把概括性授权变成无界请求，本批固定为仓库合成材料的 1 个串行 `learner_analysis` Job，最多 3 次外部请求、最多一次 repair、从 Job 接受起 45 秒、AI SDK `maxRetries=0`、不自动重跑；不沿用或消耗 #45 已使用的历史授权。授权和真实结果需要在后续 PR 正文/评论中原样告知负责人。

`real-model-support.ts` 新增独立 `XUNJIE_B3_REAL_MODEL=approved-synthetic` 门禁，与 P2 历史开关分离；`learner-analysis.test.ts` 新增默认跳过的真实候选入口。入口走真实 A4 queue/claim/current/complete 事务、固定合成 snapshot、B3 严格 schema 和真实 AI SDK DeepSeek provider，并只把脱敏 HTTP 元数据、候选 body、调用次数、usage、版本及接纳结果写到权限收紧的临时证据文件。未设置独立授权或安全 `DEEPSEEK_API_KEY` 时在网络前失败。

入口实现时的受控进程已确认 Node 24.21.0，但当时 `DEEPSEEK_API_KEY` 和 `XUNJIE_B3_REAL_MODEL` 均未设置，因此该阶段真实请求数为 0。代码与离线门禁验证完成后，由持有凭据的负责人只运行一次下述名称匹配测试；实际执行结果见 §6.9：

```powershell
$env:XUNJIE_B3_REAL_MODEL = 'approved-synthetic'
node --test --test-name-pattern='B3 authorized real-model' server/tutoring/test/learner-analysis.test.ts
```

入口实现后的离线结果：`tsc --noEmit` 与 build 通过；B3/真实门禁组合 38 项中 37 通过、1 项真实模型用例按默认门禁跳过、0 失败；B1/B2/B3 tutoring 聚合回归退出码 0；文档检查 64 份/910 条内部链接/`errors=[]`，检查器回归 16/16，`git diff --check` 通过。该结果只证明默认关闭和离线兼容，不是实际模型通过。

真人语义审阅使用该次真实候选，审阅者逐项记录：目标/版本是否匹配；每个结论是否能回指获准证据；帮助、限定检查、反证、工具故障和覆盖缺口是否保留；三条能力线是否分开；unknown/unresolved 是否忠实；`feedbackDraft` 是否只是草稿且可供教师采用。任一项不能由模型自评替代。

本次调用授权仍不足以发送真实学生或教师私有材料。PRD §8/§9 与 MVP_SPEC §5 明确开发仅用合成数据、真实用户项由真人完成；发送真实材料前仍需确定材料来源、参与者同意/告知、去标识结果、教师/A/C 的访问与处理范围以及 DeepSeek 外发范围。当前仓库也没有 B3 的浏览器界面；A4 只有服务端 learner-state/review API，B 不得越权创建替代 UI。因此浏览器 displayed、真人教师决定、学生接棒及教学效果观察必须由 P5 实际 UI、获准账号和真实参与者完成，当前只能保留验收表，不能由本测试代签或宣称通过。

### 6.9 B3 真实模型执行与人工审阅结果（2026-10-13）

项目负责人按 §6.8 的固定边界使用 Node 24.21.0 完成一次真实 DeepSeek 调用。临时证据记录的源码提交为 `84572022ea2bbf2b151219846313ffb5b74a0eb5`；执行时 `sourceDirty=true`，执行后仓库状态复核只发现既有未跟踪 `.trae/`，未将其纳入 B3 交付。证据仍明确标记 `synthetic-only`、`realStudentOrTeacherMaterial=false`，因此本次结果不能表述为真实学生或教师私有材料验证。

本次批次实际发起 1 次 provider/HTTP 请求，状态 200，无 SDK retry、自动重跑或 repair；模型为 `deepseek-flash`，响应指纹为 `aeb56401ca74e127821c4f9126dcb669`，HTTP 延迟 3283 ms。usage 为 `actual`：输入 903 tokens、输出 511 tokens、合计 1414 tokens，其中 cache hit 0、cache miss 903。测试摘要为 1 项通过、0 失败，测试耗时 6128.9913 ms、总进程耗时 7060.7401 ms。

严格解析后的 `learner_analysis` 包含 domain、project、ai_collaboration 三条分离能力线，均引用同一条获准合成 snapshot，状态均为 `insufficient`、`assistanceStatus=unknown`、`unresolved=true`；模型明确保留缺少独立解释、课程检查、snapshot 内容描述以及 AI 协作线缺少 assistance 记录等未知项，没有输出正式评价或 `feedbackDraft`。A4 事务把该候选接纳为 revision 1，并生成 3 个 claim；这里的 `accepted` 只表示候选通过结构、引用和当前性边界进入 A4 learner-state，不等于教师正式采用或教学效果成立。

项目负责人已指定由本人以教师审阅角色完成该候选的人工语义审阅，并确认浏览器界面等待 UI/P5 接入，本批不创建替代 UI、不执行浏览器 displayed 或真人接棒。2026-10-13，项目负责人依据临时证据文件中 `data.outcome.body.claims` 的完整候选完成审阅，结果如下：

| 审阅项 | 结果 | 审阅范围 |
| --- | --- | --- |
| B3-HR-01 学科知识候选 | 通过 | 学科知识候选与目标/版本匹配，有限证据结论可接受 |
| B3-HR-02 项目能力候选 | 通过 | 项目能力候选保持独立能力线，未扩张证据含义 |
| B3-HR-03 AI 协作候选 | 通过 | 缺少 assistance 记录时保持 unknown/insufficient，未作猜测 |
| B3-HR-04 证据与未知项忠实性 | 通过 | 引用限制在获准 snapshot，unknown/unresolved 表达可接受 |
| B3-HR-05 教师可读性和可采用性 | 通过 | 候选内容可供教师理解并决定后续证据收集 |
| B3-HR-06 非正式评价边界 | 通过 | 未把证据不足改写为能力结论，未输出正式评价 |

人工整体结论为“通过”，没有提出条件或修改项。至此，本批固定合成材料上的 B3 真实 DeepSeek 候选已完成技术调用、严格解析、A4 候选接纳及教师角色人工语义审阅。该结论不扩展为真实参与者材料、浏览器 displayed、学生接棒或教学效果通过；真实参与者材料与教学效果仍需要参与者同意、去标识、处理范围、观察周期和教师判断，浏览器链等待 UI/P5 接入。
