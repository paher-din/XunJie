# 04：断线与原保存请求恢复

**What to build:** 学生断线继续编辑，刷新后保留草稿；重连只核或重放原保存命令，准确识别未知、拒绝与旧代际。

**Blocked by:** [03 确认保存与不可变快照](I0_UI_03_CONFIRM_SNAPSHOT.md)。

**Document status:** `implemented`（2026-10-12 准备范围交付）。

**Status:** `implemented`（准备范围）：03 已交付（`68a7711`），P-01 由项目负责人 2026-10-12 的「/implement 开始 docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md」指令落实。
**未落实项如实保留在这里，不等同已确认**：P-04（缺 UI 成员对新增恢复交互的组件/槽位确认，本次只在 03 已交付的受控组件上做最小扩展）；U-04/冲突比较（属 [04A](I0_UI_04A_LOCAL_CONFLICTS.md)，本任务在 VERSION_CONFLICT 后只保留正文并阻止自动覆盖）；真实服务联调（H-01～H-04）。下面「待决策项」列了本次引入的两处增量。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §3/5；M-09/10、AC-03/06/12、NFR-04。沿用 03 的 outbox/确认头，不另造恢复状态。可写前端对应恢复交互、fixture 故障/测试及本文；后台和受保护文件只读。

旧文件名保留以维持链接。原多标签/服务版本比较职责移至 [04A](I0_UI_04A_LOCAL_CONFLICTS.md)，本任务不以它为前置。

## 2026-10-12 开工核对与实施范围

- 项目负责人指令开始本任务，P-01 落实。起点 `68a7711`（I0-03 交付），交付在分支 `i0/ui-frontend` 上以本次任务提交收口（未推送）；开工时已有未跟踪 `.zcodeignore` 不属于本任务，未暂存、未提交。
- 设计仓库同步基准为 `e933b69`（见 [IMPORT_SOURCE §4](../../apps/student/IMPORT_SOURCE.md)），其前一个提交 `7c0cd64` 一并审阅。
- 已读：本仓库 `AGENTS.md`、`README.md`；[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §2/3/5、[03 交付记录](I0_UI_03_CONFIRM_SNAPSHOT.md)、[04A](I0_UI_04A_LOCAL_CONFLICTS.md)、[准备记录](I0_UI_PREPARATION.md) 相关节；实际实现 `src/workspace/{confirmationWorkspace,confirmationDb,frozenCommand,confirmation,http,context,useConfirmationWorkspace,init}`、`prep/{plugin,workspace,authority,scenario}`、`src/components/workspace/{ConfirmationCluster,useProjectWorkspace}` 与 03 的 e2e。
- 实际写集：`apps/student/src/workspace/{recovery.ts,recovery.test.ts,projectSeed.test.ts,confirmationWorkspace.ts,confirmationDb.ts,frozenCommand.ts,useConfirmationWorkspace.ts}`、`apps/student/src/components/workspace/ConfirmationCluster.tsx`、`apps/student/src/pages/PrepWorkspacePage.tsx`、`apps/student/prep/{faults.ts,plugin.ts,contract.test.ts}`、`apps/student/e2e/{recovery.spec.ts,confirmation.spec.ts}`、`apps/student/IMPORT_SOURCE.md`、`README.md` 与本文。受保护文档、后台代码、共享字段只读；未新增依赖。
- 恢复交互按 03 已记录的设计仓库先行流程交付：设计仓库提交 `7c0cd64`（结论态与只读原请求事实）、`e933b69`（把详情收进运行簇浮层，修 1280px 顶栏溢出）；主仓库接收的 `ConfirmationCluster.tsx` 与 `e933b69` 逐字节一致（同步记录见 [IMPORT_SOURCE §4](../../apps/student/IMPORT_SOURCE.md)），页面绑定与业务逻辑留在主仓库。
- P-04 状态如实记录：本次没有 UI 成员的新交付，也没有对「新增操作组件/槽位」的单独确认；实现只扩展现有已交付组件的受控属性（新增 `rejected`/`conflict`/`recovery-required` 三种结论态、原请求详情开合、`canRetry` 开关），未新增页面/导航/布局。若负责人要求先由 UI 成员确认这批文案与结构，按本文件顶部状态回退即可。

## Acceptance criteria

- [x] 断线编辑/刷新仍有原文草稿；未发草稿、在途未知命令、已确认正文分开，不把超时当拒绝/成功。`recovery.ts` 把「没拿到信封」定级为 `unresolved`（未知），只有拿到服务端错误信封才定级为拒绝；`useConfirmationWorkspace.projectSeedOf` 让确认头已含服务端实例、但本机映射尚未落库时，同一路径的未映射本机实例仍继续承载草稿；e2e 覆盖丢 ACK 与浏览器离线两条路径。
- [x] ACK 丢失后核或重放原完整业务输入，键/seq/代际/正文不变；新编辑不能挂旧键。重放只发送冻结的 `wireJson` 与 `commandKey`；`原请求详情` 展示冻结命令的键、clientId/clientSeq、代际、预期版本与逐文件字节数/摘要；存在未决原命令时不允许发起新保存；e2e 逐条断言请求身份（键+正文）完全相同、未自动补发。
- [x] 多标签抢原命令 lease 不导致新命令，重复重放仍是同键同正文；原命令已确认时停止重发，当前 head 需重读。发送租约仍由本机事务（`claim`）执行，抢租约只是拒绝本次发送且不产生任何命令；`reconcileStoredCommand` 发现记录已确认时走 `accept-local`：只在本机重新接纳同一回执并重读 head，不发请求。
- [x] RECOVERY_REQUIRED 停旧重试，重读受信上下文；保持草稿并提示比较，不换代际/业务键续写。这两种终态结论下 `canReplay` 为假、重放按钮消失，重读按钮显示为「重读受信上下文」（复用 `init.reload` 的同一动作），并在原命令上留下拒绝事实，刷新后结论不变。VERSION_CONFLICT 转 04A 的明确选择，未交付时保留正文且阻止自动覆盖：`conflict` 态不提供重放、不允许新保存，服务端正文不被覆盖。非终态拒绝（限流/依赖或持久化不可用/未认证等）保留原命令与事实，但仍允许学生明确重试，不把暂时不可用变成永久封禁。
- [x] 复用 03 的 loadEpoch/代际守卫；账号/模式/Attempt 切换后旧重连结果不回灌。`valid(guard)`、`sameGeneration` 与既有权威重核全部保留；`reconcileStoredCommand` 对换账号/模式/Assignment/Attempt 的旧记录一律 `stop`（新增单测），且当前工作区选未决原命令时只认同一 Attempt（同代际优先，其次同 Attempt 的旧代际），不回退到别处的工作区（两轴审查发现后修复）。暂停/终态仍按权威 Attempt 状态只读，不上传编辑过程（`sync` 输入不含 `process`）。
- [x] 在普通 dev:prep 和实际浏览器测试复现丢 ACK→继续编辑→刷新→原请求重放，检查请求身份/数量、同 fileId 和正文保留；旧代际/存储失败也保留事实。fixture 新增开发专用 `POST /__i0prep/fault`：`drop-ack`（命令提交但不下发响应）与 `fail-write`（命令不提交、返回 503 `PERSISTENCE_UNAVAILABLE`），浏览器用例走同一 HTTP 与 IndexedDB；旧代际事实、终态拒绝事实、暂时拒绝事实、历史事实分别有断言。
- [x] 跑相应工程及浏览器检查，记录准备范围；真实恢复没有执行就保持未执行。见下方验证记录；真实服务交接与 04A 比较仍未执行。

## 实际实现（2026-10-12）

| 边界 | 代码与实际行为 |
| --- | --- |
| 核对结论（纯函数） | `src/workspace/recovery.ts`：`classifyWriteFailure` 把写失败分成未知/本机未确认/拒绝/版本冲突/代际已变/租约占用/已确认；`reconcileStoredCommand` 只按落盘事实（回执、状态、代际、已记录拒绝）决定重放 / 本机重新接纳 / 停止；`canReplay` 允许未知、本机未确认、租约占用与**可重试**拒绝，终态拒绝（VERSION_CONFLICT / RECOVERY_REQUIRED / IDEMPOTENCY_CONFLICT，规则在 `frozenCommand.isTerminalRejection`）才停手；`outcomeMessage` 给出面向学生的下一步 |
| 拒绝的分流 | 只有「重放不能解决」的拒绝才停止重放并在原命令上留永久事实；限流、依赖/持久化不可用、未认证等按服务端 recovery 提示处理为「保留原命令 + 学生明确重试」，不把暂时不可用变成永久封禁（服务端未在 `retryable` 之外给出更细的语义，客户端不自行猜测它） |
| 原命令事实 | `summarizeOriginalRequest` 只读 `wireJson` 与冻结 `drafts` 生成键/序号/代际/预期版本/逐文件字节数与 sha256；不重新序列化业务输入，也不带 Session/CSRF。UI 用 `ws-request-detail` 只读呈现 |
| 拒绝事实 | `OutboxRecord.rejected?: { code, at }`：同一 outbox 记录的可选字段，不新增 store、不升库版本；`confirmationRepository.noteRejection` 只在没有回执时写入；`claim` 对已确认或已拒绝的原命令一律拒绝发送 |
| 客户端 | `confirmationWorkspace` 新增 `outcome`/`original` 状态与 `rejected`/`conflict`/`recovery-required` 阶段；`send` 失败按结论分类并落盘事实；`retry` 先按落盘记录判定（已确认→本机重新接纳、已拒绝/换代→停止、租约被占→不发送、否则原样重放）；`refreshPending` 在另一标签通知后只刷新原命令事实 |
| 草稿与实例关联 | `useConfirmationWorkspace.projectSeedOf`：fileId 映射优先；没有映射时，同一路径、尚未映射的活动本机实例继续作为该正文来源（只影响可见性，不建立映射，原请求仍待核对） |
| 恢复交互 UI | `ConfirmationCluster.tsx`（设计仓库 `e933b69` 先行、主仓库逐字节一致）：三种新结论态标签；不可重放时不显示重放按钮；代际态下重读按钮文案为「重读受信上下文」；「原请求详情」开合放在已有浮动说明卡内（不占顶栏宽度）。页面只传 `state.outcome/original` 与 `canReplay` |
| fixture 故障 | `prep/faults.ts` + `prep/plugin.ts`：`POST /__i0prep/fault`（按场景、需 CSRF、仅 prep 开发进程）；`drop-ack` 让写命令照常提交但不写响应并断开连接；`fail-write` 不提交命令并返回 503 `PERSISTENCE_UNAVAILABLE`。错误响应（401/403/409/503）照常下发，避免把服务拒绝伪装成丢失 |
| 测试 | `recovery.test.ts`（17 例）、`projectSeed.test.ts`（5 例）、`prep/contract.test.ts` 新增 3 例、`e2e/recovery.spec.ts` 8 例；`e2e/confirmation.spec.ts` 1 处定位改为两种文案之一（动作与断言不变，见下） |

03 用例的唯一改动：`confirmation.spec.ts` 的「首次创建 ACK 未绑定 Attempt」用例点击重读按钮时，旧代际原命令现在属于 04 的结论态，按钮文案在该态显示为「重读受信上下文」，定位改成 `/^(重新读取|重读受信上下文)$/`；点击后的断言（v0、无告警）与其余步骤未改。

## 审查与纠正（2026-10-12，两轴独立审查）

按 Standards / Spec 两轴独立审查本任务相对 `68a7711` 的改动（只读 subagent，事实以公开接口与文件字节核对）。主 Agent 复核后逐条处理：

- **Spec P1（已修复）**：除两个特定码外，任何错误信封都被写成永久拒绝（`noteRejection` → `claim` 抛错 → `canReplay=false`），刷新后同一 Attempt 再无写入路径。修复：把「重放不能解决」的终态拒绝限定为 `VERSION_CONFLICT` / `RECOVERY_REQUIRED` / `IDEMPOTENCY_CONFLICT`（规则集中在 `frozenCommand.isTerminalRejection`），其余拒绝保留原命令与事实但允许明确重试；新增 `fail-write` 故障与浏览器用例验证 503 后工作区仍可用、重试仍只创建一次。
- **Spec P1（已修复）**：`commands()` 只按 owner 过滤，`initialize`/`refreshPending` 在没有同代际行时回退 `pendingRows[0]`，会把别的 Attempt 的原命令当成当前未决请求并锁住新工作区。修复：新增 `currentPendingRow`，先同代际、再同 Attempt，绝不跨 Attempt 回退。
- **Spec P2（已修复）**：未映射实例按路径取首个候选，同路径多实例（回收后同名重建）可能把确认正文挂到错误实例。修复：只有唯一候选才关联，否则该确认文件按服务端 fileId 打开，两个本机实例仍各自保留（新增单测）。
- **Spec P2（已修复）**：租约被占时重放入口消失且租约到期不自行恢复；`retry` 先置 `confirmed` 再失败会留下误导提示。修复：`canReplay` 允许租约占用（拦截仍在 `claim`），`retry` 用真实租约结论展示，且不再发瞬时的「已确认」提示。
- **Spec (a)/(b)（保留为待决策项，未自行认定）**：P-04 缺口与两处增量见下。
- **Standards 硬性（已修复）**：同步记录只写了 `7c0cd64`，实际接收字节来自 `e933b69`；验证数字与实测不符。均已按实际更正（见 [IMPORT_SOURCE §4](../../apps/student/IMPORT_SOURCE.md) 与下方验证事实）。
- **Standards 质量项（已处理）**：结论映射统一为 `outcomeOfCode`/`codeOfOutcome`（原为三处）；未决原命令的展示收敛为 `publishPending`/`currentPendingRow`（原为两段重复）；`localFileIdOf` 与 `localInstanceOf` 收拢到存储层，视图不再自行重推映射规则；`noteRejection` 的租约门与 `phaseFor` 的完备分支已写明理由；fixture 去掉 `res.end` 猴补，改为显式 `respond()`。
- **Standards 未处理项（记录为后续）**：e2e 的 `localState`/`holdAck` 在多个 spec 中各有副本；提取共享 helper 需要改动 03 的测试文件，超出本任务写集，留给后续收口任务。

## 待决策项（需项目负责人确认，本任务不自行认定）

1. **P-04**：恢复交互涉及 03 已交付组件的新文案与结构（三结论态、原请求详情、重放开关）。本任务按「只扩展现有受控组件、不新增页面/导航/视觉」实现；若要求先由 UI 成员确认，按文件顶部状态回退这批 UI 文案。
2. **outbox 增量字段**：`OutboxRecord.rejected?: { code, at }`。它落在 03 已批准的同名 v2 库、同一 `outbox` 记录上，**不新增 store、不改版本、不迁移**，属 P-02 批准范围的记录内增量；若负责人认为这仍需单列批准，去掉该字段即可退回「拒绝只存在内存」的行为（代价是刷新后无法复现拒绝结论）。
3. **终态/可重试的划分**：客户端把 `IDEMPOTENCY_CONFLICT` 与两个特定码视为终态，其余按可重试处理，依据是服务端错误定义里的 `recovery` 提示。服务端若希望客户端用 `retryable` 细分，需要在契约里给出更明确的语义。

## 交接与状态

交付可独立演示的网络恢复路径；服务/本机冲突的选择由 04A 增强。04/04A/05/06 继续复用同一客户端、原 outbox 与确认/快照读取，不各建第二份确认状态。

## 验证记录与基线汇总请求

### 验证事实（2026-10-12，两轴审查与修复之后的最终一轮）

- `npm run typecheck`（`tsc --noEmit` 与 `tsc --noEmit -p tsconfig.node.json`）：通过。
- `npm test`（vitest）：15 文件 184 例通过。其中 `recovery.test.ts` 17 例（写失败分类、重试许可的终态与可重试划分、已确认/已拒绝/换代/租约/历史结论、账号与 Attempt 切换、冻结事实摘要）、`projectSeed.test.ts` 5 例（丢 ACK 后同路径未映射实例仍可打开草稿、已映射优先、无服务端文件时不丢实例、同路径多实例不猜、回收实例不抢身份）、`prep/contract.test.ts` 12 例（含丢 ACK 已提交但无信封、同键同正文重放幂等且不重复创建、改正文复用同键被拒、fail-write 不提交且返回真实错误码、故障按场景隔离且拒绝不被伪装）。
- `npm run build`：成功（Monaco 分块大小为既有提示）；构建后核对 `dist/` 不含 `__i0prep`/`drop-ack`/`fail-write`/合成账号字符串。
- `CI=1 npm run test:e2e`：47 例全部通过（原 39 例回归 + `e2e/recovery.spec.ts` 8 例）。新增用例覆盖：丢 ACK→继续编辑→刷新→同键同正文重放（含请求身份、同 fileId、草稿保留、无自动补发）、浏览器离线、另一标签已确认时只重读不发请求、租约占用不产生新命令、RECOVERY_REQUIRED 停止旧重试与重读受信上下文、VERSION_CONFLICT 保留正文并阻止自动覆盖、暂时性拒绝（503）不封死工作区且重试仍只创建一次、重放期间主动重读后旧回执不回灌。
- 1280×800 视口人工核对（修复顶栏溢出前后各测一次）：未决原请求下顶栏 `scrollWidth` 与 `clientWidth` 同为 1278px，打开「原请求详情」不改变顶栏宽度（修正前为 1363/1278）。

### 未执行

- 真实业务宿主/同源 HTTPS/本人 Assignment 发现与首次受信代际（H-01～H-04）的联调；真实后端保存失败、真实 RECOVERY_REQUIRED 与真实 VERSION_CONFLICT 的浏览器验证。
- 04A 的冲突比较与明确选择（本任务在 VERSION_CONFLICT 后只保留正文并阻止自动覆盖）。
- 准备通过不计真实读写交接、正式 AC/NFR、G0～G4 或教学效果通过。

### 基线汇总请求

产品基线与受保护文档未改。请获授权维护者在 [MVP_SPEC §10](I0_UI_SPEC.md) 汇总本批准备范围进度时纳入 04：原命令核对结论与拒绝事实的分流、`dev:prep` 丢 ACK 故障入口、以及 04A 未交付前 VERSION_CONFLICT 只保留正文的处理方式。本任务不修改 `docs/product/**`、`docs/planning/**` 或 03 的记录。
