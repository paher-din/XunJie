# 06A：运行取消与未知原请求核对

**What to build:** 学生请求取消或遇到运行结果未知时核对原 run/job，看到真实停止进度，避免重复执行。

**Blocked by:** [06 一次固定快照 Core 运行与基础结果](I0_UI_06_RUN_RESULTS.md)。

**Document status:** `implemented-and-verified`，准备模式交付。

**Status:** `preparation-delivered`：06 与 P-01/P-04/U-06 已落实；停止/原请求核对、工程及全量浏览器准备检查通过；真实 H-04/H-06 仍未交接。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §3/6/8；M-10、AC-10/12/15、NFR-03/04，已有 cancel/Job 契约。可写对应前端、故障 fixture/浏览器测试和本文；不改后台停止/槽位/代际语义。

## 2026-10-12 开工核对与最小扩展提案（已批准）

- 项目负责人已要求开始 06A，P-01 已落实；起点 `75dc89e364164d4d4e5c97875117f86b57a6b818`，分支 `i0/ui-frontend`。06 已准备交付，旧 blocked 中的 06 条件已解除；未跟踪 `.zcodeignore` 排除本任务。
- 已读 AGENTS、README、PRD §3～5/8、MVP_SPEC M-09/10/AC-10/12/15/NFR-03/04、TECH_DESIGN §4.3/5/7.4/8、工程交接、接入规格、客户端约束及 06 交付。复用确认客户端、唯一 v2 outbox、RunWorkspace 和窄 HTTP，不新建数据库或安装依赖。
- 可写学生运行客户端、必要的现有组件绑定、同一 preparation fixture/测试、README/IMPORT_SOURCE 与本文；服务端、产品/参考/分工/规范、密钥和 CI/CD 只读。06B 历史/产物不在范围。
- P-04/U-06 具体提案：沿用已交付 RunPanel 的操作区增加“停止此运行”和“核对原运行请求”两个受控按钮；仅在可停止/存在未决原请求时显示，进行中禁用重复操作。notice 展示“停止请求已受理，等待确认”或“停止请求结果未知，已保留原请求”。权威 GET Job 才改变运行状态；读取不发写命令、核对不生成替代业务键，终态后仍由学生点击新运行。
- 项目负责人明确回复“批准，按方案完成并本地提交”，批准上述最小 UI 扩展及既有测试接缝；沿用设计仓库先交纯 props 组件、检查并本地提交，再选择性同步主仓库的流程。不新建页面、导航或样式体系，不推送或发布。
- 验证接缝沿用已选定的实际 `dev:prep` 浏览器、HTTP wire 和 IndexedDB；TDD 核先落盘、原键/正文、停止受理/未确认、ACK 丢失、刷新核对、原运行未知、旧代际及迟到 poll/cancel。测试不触及 hook 私有状态，真实 H-04/H-06 未交接不启动 C/模型。
- 后台没有独立 GET 命令回执端点；同代际未知创建/取消只能在学生明确核对时原样 POST，取得原回执再 GET 原 Job/Run。不同代际不迁移原请求、不换键补做，保持恢复核对不可用；cancel wire 仅 `recoveryGeneration`，摘要按已有后台 `{jobId}` 语义核验。

## Acceptance criteria

以下勾选仅代表本切片前端准备责任，不代表真实节点停止、调度限额或完整 AC/NFR 已验收。

- [x] 取消由学生明确发起，使用原 jobId、当前有效身份/受信代际与业务键；取消响应未知保存原请求，不换键补做。
- [x] cancelling 是待确认；poll 的 cancelled 等权威状态才更新结束。网络 timeout 不假装已停、不释放执行资格。
- [x] outcome_unknown/stale/断线时核原命令回执、run/job 与受信上下文，不自动执行新 run；缺原服务/恢复交接保持明确不可用。
- [x] 重读到终态后仍服从服务状态/每 Attempt 单作业/全局槽位；前端按钮不替代服务调度。新运行必须由学生发起。
- [x] 当前上下文与 poll 轮次守卫沿用 06；迟到 cancel/poll 不覆盖其他 run 或新代际。
- [x] 浏览器复现取消受理但未确认、取消响应丢失、原运行未知、旧代际拒绝与迟到 poll；核没有自动第二次 run，状态/请求身份准确。
- [x] 工程及本切片检查记录准备/真实范围，未执行不填通过。

## 交接与状态

不等 06B 历史/产物；实际停止验收需相应 H-04/H-06 停止样例与真实环境。准备模式已实现并完成全量验证；真实停止/恢复交接、真实节点与模型验证**未执行**。产品基线进度**待授权维护者汇总**，未改受保护文档。

### 实际代码与验证范围

- 设计来源为 `XunJie_Design@a124fee8422bf2ca940ddc807344ae7936d7dac7` 的 `RunPanel.tsx`，设计 typecheck/build 通过并仅本地提交；主仓库选择性接收同名纯 props 组件，不回写业务客户端。
- `runControl.ts` 冻结原停止对象和现有 wire，按后台 `{jobId}` 摘要核验回执；`runWorkspace.ts` 接显式取消/原请求核对，复用 Session、authority、原 outbox 租约和 ACK 事务。只有 GET Job/Run 更新公开结果，网络或回执 status 不冒充停止确认。
- `confirmationDb.ts` 在同一原 outbox 阻止两标签新建重复未决取消，以及未决取消期间新运行。重放核对被拒保留此前未知事实；不同代际不换键、不重贴当前代际。`confirmationWorkspace.ts` 排除运行/取消，保存核对不会误处理它们；库版本和 stores 未变。
- `useRunWorkspace.ts` 沿用 06 的有界轮询，在停止/核对发送期间暂停自动 poll；选择 epoch、原 run/job、读取轮次和当前 authority 阻止旧 poll/cancel 接纳。`PrepWorkspacePage.tsx` 只提供业务 props。
- `prep/workspace.ts`/`plugin.ts` 在同一 loopback fixture 增加既有 cancel 端点和停止/未知/过期脚本，不实现真实取消或调度。`runHelpers.ts` 收拢 06 与 06A 的公开浏览器操作。
- 增量纯函数反例先失败后通过（取消 wire/摘要/回执归属）；浏览器停止入口未接时失败，接线后通过。取消未确认、丢 ACK 刷新原样重放、创建未知核对、outcome_unknown/stale/断线、旧代际拒绝、迟到 poll/cancel、本机 ACK 事务 abort、未落盘禁止 POST、两标签并发分别已通过。最终全量结果见下。

### 两轴审查与修正

#### Standards

只读规范轴审查未发现可操作硬违规或值得报告的代码味道；设计组件来源、写入边界与 schema/依赖保持核对通过。

#### Spec

规格轴发现两项 P2：核对会重新选择另一浏览器的新运行；读取 Session 与领取租约之间，另一标签已确认原命令却被显示为未知。分别新增真实浏览器反例，先失败后通过：停止/核对按点击时对象或核验回执固定原 run/job，缺原记录不退回最新；`CommandConfirmedError` 重读并核验同一落盘回执，不 POST，也不重新标未知。独立只读复核确认这两项关闭。

复核另发现一项相邻 P2：确认已落盘后，循环内 release 事务失败仍进入发送失败分支、把已确认请求展示为未知。先补浏览器故障反例，确认落盘但核对按钮持续显示的断言失败；`releaseLease` 隔离清理异常后，该反例通过并继续 GET 原对象，不改变确认事务、回执或共享契约。最后独立只读复核确认这项关闭，邻近上下文/并发守卫未发现新增可操作问题。Spec 累计三项 P2 均已修复并复核关闭，未解决项为零。

首次全量浏览器为 85 通过、1 失败（86 总数）：旧代际核对被拒后，初次结果绑定改变 selectionEpoch，遮掉拒绝提示。固定原对象的修正同时避免这次选择变化；该用例单独重跑通过，增加两项审查反例后全量 88/88 通过。之后新增租约清理反例并修复，最终结果见下。未修改或放宽断言。

### 最终验证记录

2026-10-12，学生工程 `apps/student/`：typecheck 通过；`npm test` 21 文件/234 例通过、0 失败；build 通过，既有 Monaco 大分块提示保留。设计工程 typecheck/build 通过，`npm test` 10 文件/106 例通过。未安装新依赖。`CI=1 XUNJIE_E2E_PREP_PORT=5651 XUNJIE_E2E_REAL_PORT=5652 npm run test:e2e` 最终 Chromium 全量 **89 例通过、0 失败**（4.7 分钟），其中 06A 15 例；真实 Vite 页面、HTTP、IndexedDB、刷新/跨标签与独立浏览器。修正后单文件/两项审查反例通过；全量使用新进程和独立场景，没有重试或降低阈值。

最终生产构建中没有 dev-only run-script、合成结果正文或 prep-gen 标记；真实模式无 fixture/无回退浏览器检查通过。四份交付文档相对链接、设计来源 RunPanel 逐字节、`git diff --check` 核对通过。产品/参考/分工/规范、服务端、依赖/lock 和 schema 未改；既有 `.zcodeignore` 未纳入。Vite public 资产与 Node localStorage/颜色变量等既有警告保留，不计作业务通过或失败。

README、学生 README 与 IMPORT_SOURCE 已同步操作和来源范围；本文包含实际实现、审查与验证事实。只本地提交，不推送或部署；基线进度待授权维护者汇总，真实 H-04/H-06 停止/恢复、节点与模型验证未执行。
