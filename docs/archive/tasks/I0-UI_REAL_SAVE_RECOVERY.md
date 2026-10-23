# I0-UI：真实保存与故障恢复（UI-REAL-05/06/07/12）

日期：2026-10-14（Asia/Shanghai）。主责：UI / Robert；实施：当前 Agent。父清单：[真实接入清单](https://github.com/paher-din/XunJie/blob/33a68baba5005c9a6433ed2bf9c99f01d89345b6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md) §3/§8；前置批次：[I0-UI 会话入口](I0-UI_AUTH_SESSION_ENTRY.md)、[I0-B 正常宿主](I0-B_HOST_COMPOSITION.md)。状态：`isolated-browser-verified`——本批实施及隔离合成 HTTPS/SQLite 浏览器验证完成，最终 48/48 通过；此为实施完成时快照，后续 Git 交付见 §11。完整部署、进程崩溃恢复和教学验收不在该结论内。

## 1. 依据与授权

Robert 于2026-10-14在会话中对「下一批做真实保存与故障恢复，对应清单 UI-REAL-05、06、07、12」明确批注“开始做”，并要求继续在 `i0/ui-frontend` 上推进。初始阶段仅核查依据、缺口并新增本记录；随后按“继续”实施完整批准批次，最终写集及结果见 §8～§10。不提交 Git、不推送。

已读正文：README（入口与任务导航）；AGENTS（文档优先、权限与红线）；`C:/Users/h/.codex/RTK.md`（命令前缀约定）；PRD §4.2/§4.3/§5/§8（PRD-03/09/10）；MVP_SPEC §2、§3 M-03/M-09/M-10、§4 状态与操作规则、§5（NFR-01/04/05）、§6（AC-03/06/12）；TECH_DESIGN §4.3（版本与信封）、§5/§5.1（命令与幂等/错误码）、§7.1（状态与版本）、§7.4（编辑、断线与幂等）、§7.5（代际与恢复）；I0_UI_SPEC（Implementation/Testing Decisions、Further Notes）；I0_UI_CLIENT_CONTRACT §2/§3/§4/§5/§8；I0_REMAINING_WORK_CHECKLIST §3/§8；I0-UI_AUTH_SESSION_ENTRY；I0-B_HOST_COMPOSITION；学生 README/IMPORT_SOURCE 的启动与来源边界。

搜索材料只用于定位：本步对 `C:/Users/h/.codex/memories` 做了一次轻量检索，`MEMORY.md` 无与本批直接相关的条目（仅一份 rollout 摘要提到分支名 `i0/ui-frontend`），未采用任何记忆内容，也未写记忆。

## 2. 初始 Git 与写集边界

初始现场（2026-10-14）：checkout `i0/ui-frontend`，HEAD `40db96c`，本地 `main`=远端 `origin/main`=`eea9623`，登录/会话批次 `ba89fe0` 仍在本分支祖先中；工作区除原有未跟踪 `.zcodeignore` 外干净。

开工核查阶段的历史写集：仅本文件 `docs/tasks/I0-UI_REAL_SAVE_RECOVERY.md`；源码、测试和其他文档当时只读核对。后续实施沿本批明确授权，不再把 §5 的阶段提案作为额外审批门禁。

2026-10-14 继续实施：上段为开工核查阶段的历史写集。当前批准批次的实施写集为本记录、`apps/student/e2e/saveRecoveryService.spec.ts`、`apps/student/e2e/saveStateService.spec.ts`、`apps/student/e2e/sessionHost.ts`、隔离测试驱动 `apps/teaching/server/app/i0-browser-fixture.ts`；实际场景暴露前端根因时允许最小修改 `apps/student/src/workspace/**` 及既有页面接线 `apps/student/src/pages/PrepWorkspacePage.tsx`，必要使用导航可同步 README。受保护文档和正常后端实现仍只读；不改 API/schema/依赖，不提交、推送或发布。主 Agent 负责保存/恢复验证和根因修复；宿主私有 IPC 与状态/版本专项分别独立实施，写集不重叠，最终由主 Agent 汇总验收。

## 3. 开工基线：UI-REAL-05/06/07/12 实现 / 证据 / 缺口

以下为开工核查时的历史事实，保留原缺口以便对照。本批最终证据与剩余边界见 §9/§10；“证据等级”仅指开工时仓库内可核对到的最高级别。

| 编号 | 已实现（源码位置） | 当前证据等级 | 真正缺口 |
| --- | --- | --- | --- |
| UI-REAL-05 | 真实 bootstrap 必须含受信代际，缺失即不可用；冻结任何写命令前再次要求代际（H-03） | 协议替身 + 单元测试；无实际宿主证据 | 实际 HTTPS/SQLite 上代际缺失/换代际的禁写与提示；随后重读后新键保存 |
| UI-REAL-06 | 确认保存/冻结快照的原命令、回执核验、确认头装订、字节权威 | 实际宿主有“保存正文相等 + 快照 UI 文本”；其余 17 项在准备 fixture | 实际服务上的版本/hash/manifest、刷新与重启读回、较新本机草稿保留 |
| UI-REAL-07 | 暂停只允许既有 active 文件 update；终态只读；VERSION_CONFLICT 单列并阻止自动覆盖；两 revision 分开读取 | 协议替身（暂停分配）+ 准备 fixture（暂停尝试/终态/版本冲突） | 实际服务上的暂停、submitted/reviewed、VERSION_CONFLICT 与 `attemptRevision`/`workspaceRevision` 分别核对 |
| UI-REAL-12 | 原命令核对、重放、本机重新接纳回执、租约、丢 ACK/断网/换代际结论 | 准备 fixture 8 项 + ACK 事务中断等 17 项；实际宿主仅“传输悬挂” | 实际服务上的丢 ACK 后重放、断网重连、双标签冲突、服务重启/换代际 |

### UI-REAL-05 缺首次代际时禁写

实现：真实模式从获准深链 bootstrap 取 `recoveryGeneration`，缺失即 `unavailable` 且不继续读取活动（[init.ts](../../apps/student/src/workspace/init.ts)）；冻结层对任何写命令要求 `trustedRecoveryGeneration`，否则抛出“缺少身份或受信代际，禁止写入（H-03）”（[frozenCommand.ts](../../apps/student/src/workspace/frozenCommand.ts)）；确认客户端把缺失代际写入控制台诊断并给出学生口径提示（[confirmationWorkspace.ts](../../apps/student/src/workspace/confirmationWorkspace.ts)）。服务端 bootstrap 在代际为空时直接返回 `RECOVERY_REQUIRED`（[i0.ts](../../apps/teaching/server/app/i0.ts)）。

现有证据：`real-mode.spec.ts` 的协议替身断言缺代际时 `data-status=unavailable`、零写请求、不读活动、不打准备端点（[real-mode.spec.ts](../../apps/student/e2e/real-mode.spec.ts)）；单元测试覆盖空代际分支（[init.test.ts](../../apps/student/src/workspace/init.test.ts)）。该替身只证明前端行为与请求形状，不是实际宿主验收。

缺口：实际正常宿主上的“源侧无代际”与“载入后换代际”两条路径都未跑。注意两者在真实后端落在不同代码路径：源侧缺失表现为 bootstrap 409 `RECOVERY_REQUIRED`（init 读取失败→不可用），而空字段分支只在 200 响应缺字段时触发；载入后换代际才走到“冻结/发送被拒→保留草稿→重读后新键保存”。

### UI-REAL-06 确认保存与冻结快照

实现：保存/快照的原命令冻结、事务落盘、租约、ACK 装订与重读在同一确认客户端（[confirmationWorkspace.ts](../../apps/student/src/workspace/confirmationWorkspace.ts)）；回执与快照清单/摘要核验、`workspaceRevision`/`documentVersion`/`contentHash`、manifest hash 在纯函数层（[frozenCommand.ts](../../apps/student/src/workspace/frozenCommand.ts)、[confirmation.ts](../../apps/student/src/workspace/confirmation.ts)）；本机草稿与确认头分开持久化（[confirmationDb.ts](../../apps/student/src/workspace/confirmationDb.ts)、[draftDb.ts](../../apps/student/src/workspace/draftDb.ts)）。

现有证据：实际 HTTPS/SQLite 上已走通“学生显式创建→编辑→确认保存→冻结快照”，但保存断言的只有服务端 `files[0].text` 等于冻结正文与 `limitedCheck=false`，冻结断言的只有界面出现“已冻结快照 v1”（[tutoringService.spec.ts](../../apps/student/e2e/tutoringService.spec.ts)）；`sessionService.spec.ts` 在一次换账号用例中悬挂了真实 `/sync` 响应，用于会话隔离，不构成保存/恢复结论（[sessionService.spec.ts](../../apps/student/e2e/sessionService.spec.ts)）。准备 fixture 有 17 项确认/快照回放，含 ACK 各阶段事务中断、刷新重放同 fileId、混合 EOL/BOM/非 BMP 字节不变、快照 GET 摘要不符、同 revision 异摘要、多标签逆序（[confirmation.spec.ts](../../apps/student/e2e/confirmation.spec.ts)）。

缺口：实际服务上没有逐字节比对“冻结正文 × `documentVersion` × `contentHash` × 快照 `hash`/manifest”；没有保存/冻结后刷新或重启的读回一致性；没有实际服务上“ACK 后较新本机草稿不被回灌”的断言（该断言目前只在准备 fixture 与换账号用例里以不同目的出现）。

### UI-REAL-07 版本与暂停/终态

实现：暂停时客户端先挡新建/回收/恢复，只放行既有 active 文件 update（[confirmationWorkspace.ts](../../apps/student/src/workspace/confirmationWorkspace.ts)、[frozenCommand.ts](../../apps/student/src/workspace/frozenCommand.ts)）；`submitted`/`reviewed` 只读；`VERSION_CONFLICT`/`RECOVERY_REQUIRED`/`IDEMPOTENCY_CONFLICT`/`STATE_CONFLICT` 各自单列结论并决定能否重放（[recovery.ts](../../apps/student/src/workspace/recovery.ts)）。`attemptRevision` 与 `workspaceRevision` 是两个字段，读取/冻结分别使用（[workspaceContracts.ts](../../apps/student/src/workspace/workspaceContracts.ts)、[confirmation.ts](../../apps/student/src/workspace/confirmation.ts)）。

现有证据：暂停与终态在准备 fixture 有专项——暂停下新建文件/Core 运行被挡且仍可保存既有 active 文件、`submitted`/`reviewed` 编辑器只读且零业务写（[stateGuards.spec.ts](../../apps/student/e2e/stateGuards.spec.ts)）；暂停下回收/恢复被整批拒绝（[fileHistory.spec.ts](../../apps/student/e2e/fileHistory.spec.ts)）；版本冲突比较与明确选择（[compare.spec.ts](../../apps/student/e2e/compare.spec.ts)、[recovery.spec.ts](../../apps/student/e2e/recovery.spec.ts)）。真实模式只有协议替身：暂停分配可读、不能首次创建（[real-mode.spec.ts](../../apps/student/e2e/real-mode.spec.ts)）。

缺口：实际服务上没有暂停尝试、没有 submitted/reviewed 终态、没有真实 `VERSION_CONFLICT`。两个 revision 在真实服务上的分离也没有专门断言；且 I0_UI_SPEC 已记录“当前 sync 会推进 attemptRevision，与 TECH §4.3 存在差异，不单方修改”，属需在实际服务上如实核对并保留的未决契约（见 §6）。

### UI-REAL-12 故障 / 冲突 / 恢复

实现：断网/丢 ACK 只核或重放同一原命令；`unresolved`/`local-failed`/`rejected`/`conflict`/`recovery-required`/`historical`/`superseded` 等结论决定重放或停止（[recovery.ts](../../apps/student/src/workspace/recovery.ts)）；本机 outbox、租约、ACK 原子装订与代际守卫（[confirmationDb.ts](../../apps/student/src/workspace/confirmationDb.ts)、[confirmationWorkspace.ts](../../apps/student/src/workspace/confirmationWorkspace.ts)）；换账号/退出时取消旧 HTTP 并拒收迟到成功与迟到 401（[http.ts](../../apps/student/src/workspace/http.ts)、[context.ts](../../apps/student/src/workspace/context.ts)、[session.ts](../../apps/student/src/workspace/session.ts)）。

现有证据：准备 fixture 8 项故障回放——丢 ACK 后继续编辑/刷新/重放同键只创建一次、浏览器离线、另一标签已确认、另一标签持租约、`RECOVERY_REQUIRED` 停旧重试并保留草稿、`VERSION_CONFLICT` 保留正文、暂时性 503 可重试、重放期间主动重读（[recovery.spec.ts](../../apps/student/e2e/recovery.spec.ts)）；准备进程重启与双标签 epoch（[prepRestart.spec.ts](../../apps/student/e2e/prepRestart.spec.ts)）；故障由 fixture 的 `drop-ack`/`fail-write` 驱动（[faults.ts](../../apps/student/prep/faults.ts)、[plugin.ts](../../apps/student/prep/plugin.ts)）。实际宿主上只有传输悬挂（`route.fetch()` 后按住 `/sync`、`/controls` 响应），没有保存恢复断言。

缺口：实际服务上的丢 ACK→刷新→重放同原命令、断网→重连、双标签冲突、服务重启/数据库重开、旧代际被拒，全部未跑。这些是 UI-REAL-12 的主体，不能由准备 fixture 结论替代。

## 4. 合成验证范围与所需私有测试控制

已有可复用能力（不新增依赖、不改共享契约）：[sessionHost.ts](../../apps/student/e2e/sessionHost.ts) 已能拉起正常 dist + 实际 HTTPS/Fastify/SQLite + 两个合成账号的隔离宿主，密码只走私有 stdin、临时 TLS 只在本用例、trace 关闭；[i0-browser-fixture.ts](../../apps/teaching/server/app/i0-browser-fixture.ts) 显式声明“仅隔离服务验证、正常启动不导入”，并已有教师/学生两账号与离线 provider；准备 fixture 的故障端点与场景隔离（`/__i0prep/fault`、`x-i0prep-scenario`）沿用原约定；传输类故障（延迟/断开/按住响应）由 Playwright `page.route` 注入，符合客户端契约“只延迟/拒绝传输”。

开工拟需的最小私有控制（只加到隔离测试驱动，用原工厂/公开路由，不注册业务 HTTP 路由、不改 schema/依赖；最终实现见 §8）：
- 代际控制：在隔离宿主用测试用 `currentGeneration` 覆盖来轮换/清空代际（原工厂已有 `restoreGeneration()`/`reopen()` 接缝）。
- 尝试状态控制：用原应用与既有教师/学生命令把指定尝试置为 paused / submitted / reviewed，供 07 使用。
- 越位写控制：以原学生公开 `sync`（或等价工厂写入）在带外推进 `workspaceRevision`，制造真实 `VERSION_CONFLICT`。
- 重启控制：用原工厂 `reopen()` 或重建子进程模拟服务重启并保留同一数据库文件，验证已确认版本与草稿。

明确不做的越界项：不改正常后端 `apps/teaching/server/app/i0.ts` 业务与路由、不改共享 API 字段/状态码/鉴权信封、不改 schema/迁移、不加依赖、不改真实配置/证书/凭据/CI、不推送/发布、不清空或迁移草稿库、不做真实学习操作、不调用真实节点或模型供应商。

## 5. 开工阶段提案（现已按批次授权实施）

### S1（建议先做）：实际服务上的代际闸 + 保存/快照完整性（05 + 06 主体，含 12 的丢失已确认风险）

范围只到“代际缺失/轮换禁写”和“保存/冻结/刷新/重启读回一致”，不碰暂停/终态/版本冲突（留给 S2）。

当时拟定写集：新增 `apps/student/e2e/saveRecoveryService.spec.ts`；扩展 `apps/student/e2e/sessionHost.ts` 的 IPC 控制助手；在 `apps/teaching/server/app/i0-browser-fixture.ts` 增加上述代际与重启控制；更新本记录。前端业务代码只在场景暴露根因时最小修复，实际变化在 §8 单列。

S1 场景与判据：
1. 05-源侧缺失：隔离宿主代际置空后走授权深链，界面如实不可用、零业务写请求、不读活动、不回落准备 fixture。
2. 05/12-载入后轮换：正常载入并保存成功后轮换代际，下一次保存被服务拒绝，界面提示“需要重新读取”、草稿保留、不自动改键重发；显式重读后用新键在同一实际服务上保存成功。
3. 06-保存完整性：创建多文件并确认保存，对照冻结正文逐字节与 `documentVersion`/`contentHash`/`workspaceRevision`；含混合 EOL/BOM/非 BMP 一份正文。
4. 06-快照完整性：冻结后对照 `snapshotId`/`hash`/manifest 与已确认清单，刷新读回同一结果。
5. 06/12-较新草稿与重启：ACK 后继续编辑，刷新与宿主重开（同一数据库文件）后确认版本不丢、较新本机草稿单独保留、不自动重发。

验收边界：只声明“实际隔离 HTTPS/SQLite 合成宿主”范围，不写成完整 AC/NFR、受控部署或真实教学验收；NFR-01 的 p95 时延不在此批采样范围内。

### S2（S1 之后）：状态/版本闸 + 真实故障回放（07 + 12 主体）

在原写集上补：暂停尝试只放行既有 active 文件 update（零新建/回收/恢复/运行写请求）；`submitted`/`reviewed` 只读且零业务写；用带外写制造真实 `VERSION_CONFLICT` 并核 `attemptRevision` 与 `workspaceRevision` 分别处理；传输层丢 ACK→刷新→重放同原命令只生效一次；浏览器离线→重连；双标签冲突与租约；旧代际被拒后不自动补发。任何需要改正常后端业务、共享契约或 schema 才能构造的场景，一律列差异交回，不越权代做。

## 6. 未决契约与风险（保留，不单方修改）

- sync 是否推进 `attemptRevision`：I0_UI_SPEC 已记录当前实现与 TECH_DESIGN §4.3 的差异；本批只如实核对 `attemptRevision`（控制 CAS）与 `workspaceRevision`（作品批次）两个字段的行为，不修改规则。
- 真实后端“无代际”是 409 `RECOVERY_REQUIRED`，不是 200 缺字段；S1 第 1 条按服务真实行为断言，不伪造空字段成功响应。
- 实际宿主状态控制属测试驱动私有 IPC；若必须改正常后端才能构造某场景，该场景保持未执行并交回。
- 准备 fixture 的 `drop-ack`/`fail-write` 不能作为实际服务结论；丢 ACK/断网类故障只在传输层注入（延迟/断开/按住响应），不改服务端响应正文。代际、状态、同库重开和时钟回拨条件由隔离驱动私有 IPC 设置，无新增业务 HTTP 故障路由。
- 既有宿主关闭超时经验（先关测试连接/context 再停宿主并核退出码 0）在 S1/S2 继续适用。

## 7. 开工核查验证记录（历史）

开工核查当时只新增本记录，未改源码/测试/Git 提交。执行根文档检查 `node tools/a0-review/check.mjs` 与 `git diff --check`，并核对工作区差异；当时业务/浏览器测试未执行。该历史阶段结果不替代 §9 的最终实施验证。

产品基线及 MVP_SPEC §10：待授权维护者汇总。开工计划本身不改变 UI-REAL 状态；后续实施证据见 §10，不据此关闭整项 I0 或宣称完整应用/教学效果通过。

## 8. 2026-10-14 实施与根因修复

本批按原方案继续实施 S1/S2；负责人批准的是这四项前端真实接入，不改变产品、后端或教学验收门禁。当前分支仍为 `i0/ui-frontend`，基线 HEAD `40db96c`；无本批提交或推送，原未跟踪 `.zcodeignore` 保留。

实现位置：

- `apps/student/src/workspace/confirmationDb.ts`：真实 bootstrap 不返回 Attempt 发现引用，原代码在代际变化时丢弃已有引用，导致重新读取无法回到原作品。现在保留原引用作为读取候选，经原公开 GET 校验归属后接纳，准备进程重启仍使用原空引用语义。
- 同文件及 `confirmationWorkspace.ts`：换代际安装前再次读取已获准 bootstrap，核代际、账号、分配和固定活动；写事务核引用未被另一标签替换，拒绝迟到、从未接纳过的旧代际反向退休新代际。opaque 代际不排序。确认头、引用、已明确拒绝的旧代际保存/快照退役同事务；只退役同账号、同分配、同 Attempt 的 `RECOVERY_REQUIRED` 拒绝，保留原命令/拒绝事实。未知命令、其他账号、运行/取消命令不被一并退役。
- `apps/student/e2e/sessionHost.ts`：在原私有 stdin/stdout 上按 requestId 对应 generation/state/reopen/inspect/clock-regress 控制；保持第一配置、ready 和 stop 兼容。首次启动和重开后均等待实际 `/health/live` 可达，避免 Windows→WSL loopback 转发尚未建立；TLS 例外仅在该探针请求上。截止时间、控制失败环节和关闭失败均明确，失败不输出原始异常或凭据，密码输入失败使用固定错误文本。
- `apps/teaching/server/app/i0-browser-fixture.ts`：只在隔离驱动增加私有控制，用原工厂和公开命令构造状态；onRequest 只观察业务写和活动读取，SQLite 原表只读计数证明效果。重开先关闭真实 listener/consumer，再关闭并重开同一原库，重新组装真实宿主，无旧 db 引用。已有 `now` 注入统一使用 epoch + `performance.now()` 的单调合成时间，重开保留同一时间域；每次私有辅助登录前同步推进原工厂固定时钟，避免会话时间与限流时间倒退。`clock-regress` 仅在隔离子进程回拨墙钟，正常启动没有导入或 HTTP 入口。未修改正常后端路由或 schema。
- 新增 [saveRecoveryService.spec.ts](../../apps/student/e2e/saveRecoveryService.spec.ts)、[saveStateService.spec.ts](../../apps/student/e2e/saveStateService.spec.ts)：正式 dist、实际登录表单、HTTPS/Fastify/SQLite、Chrome、真实 IndexedDB；丢 ACK/断网故障在传输层注入，代际/状态/重开/回拨为上述私有合成条件，成功正文来自真实服务。正文 hash 与 manifest hash 使用独立 Node SHA-256 对照原 UTF-8 字节。

实际验证边界：`reopen` 是**同一进程内关闭服务、重开同一 SQLite 文件并重组宿主**，不是 OS 进程崩溃、旧备份回退、实际 RPO 或执行节点恢复。缺代际、轮换代际与旧响应守卫验证使用隔离 supplier；不实现或替代生产恢复登记流程。submitted/reviewed 由原工厂正确业务转换构造合成条件，不代表真实教师复核。Core 只核状态下禁止写运行，实际运行/停止/产物仍属下一批 UI-REAL-09/10/11。

已读章节和映射沿 §1；sync 在实际服务推进两个 revision 的差异沿 §6 保留，不改变规则，控制操作继续重读权威 `attemptRevision`。本批未新增依赖、修改凭据配置、迁移浏览器库或服务库；产品与 MVP_SPEC §10 为待授权维护者汇总。

正常后端墙钟问题交接 A/C 负责者：本次观察 WSL 墙钟回拨 16.604 秒；使用原实际 Session/登录 HTTP 链的固定回拨探针可复现已创建会话变 401 `UNAUTHENTICATED`、再次登录 429 `RATE_LIMITED`。修复仅统一隔离宿主时钟，同一探针恢复为 200，并在浏览器回拨 20 秒后核会话、保存和另一 context 登录。正常后端仍采用其原时间来源，未修改；不得把该隔离修复写成生产墙钟回拨问题已解决。

## 9. 当前验证记录

运行环境：Windows Node 24.15.0（已有前端运行时）；Ubuntu WSL 的已登记教学 Node 24.21.0；Chrome 155.0.8059.40（`XUNJIE_E2E_BROWSER_CHANNEL=chrome`），端口 5671/5672/5673；`CI=1` 禁止复用旧 Vite 进程。`XUNJIE_E2E_SERVICE_NODE=/mnt/d/codex-tools/node-v24.21.0-linux-x64/bin/node` 仅在本次命令环境设置，不写配置或凭据文件。

已执行：`npm run typecheck` 通过；`npm test` 34 文件 **464/464** 通过；`npm run build` 通过；教学 Node 下 `node node_modules/typescript/bin/tsc --noEmit` 通过。现有 build chunk-size、public 品牌导入及测试 NO_COLOR/FORCE_COLOR 警告如实保留。

失败与修复保留：

1. 首轮 5 个入口因 WSL loopback 尚未可达失败、9 项未跑；首次启动增加 health/live 可达轮询，不改后端响应。
2. 下一轮 5 通过、5 失败、4 未跑，其中四个失败来自私有辅助登录使用工厂固定时钟，另一个为测试把冲突原因误当状态栏文字；先对齐辅助时钟，按原 title/本机失败状态和“这次没有发送”的零写事实核对冲突。
3. 定向轮换用例确认旧拒绝残留会误报最近保存，已修根因并保留刷新回归。
4. 真实专项随后 12 通过、2 失败，暴露早期会话失效及重开后 WSL 转发尚未可达；补重开后的可达轮询，并把空作品入口错误的“保存可用”等待改为“新建文件可用”。定向并发/字节读回 2/2 通过。
5. 合并 47 项回归仍出现 3 个实际会话 401/429 失败并提前停止，未跑项不计通过。短 HTTP/浏览器定位后观察到墙钟回拨；固定回拨探针先复现 401/429，再用统一单调合成时间使同一探针全部 200。移除临时诊断字段和三个探针文件，新增永久 20 秒回拨浏览器回归。
6. 最终同批及兼容回归 **48/48 通过（3.4 分钟，2 workers，无失败/跳过）**：新增实际服务 15 项（保存/恢复 11、状态/版本 4），原实际服务 5 项（会话 4、辅导 1），准备确认/恢复 28 项。`.last-run.json` 为 `passed`、`failedTests=[]`。

最终浏览器命令（在 `apps/student`；服务 Node 路径替换为本机已登记的精确 24.21.0 路径）：

```powershell
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
$env:XUNJIE_E2E_PREP_PORT = '5671'
$env:XUNJIE_E2E_REAL_PORT = '5672'
$env:XUNJIE_E2E_RESTART_PORT = '5673'
$env:XUNJIE_E2E_SERVICE_NODE = '/mnt/d/codex-tools/node-v24.21.0-linux-x64/bin/node'
$env:CI = '1'
rtk npm run test:e2e -- saveRecoveryService.spec.ts saveStateService.spec.ts confirmation.spec.ts recovery.spec.ts sessionService.spec.ts tutoringService.spec.ts --workers=2 --max-failures=3
```

常规检查在 `apps/student`：`rtk npm run typecheck`、`rtk npm test`、`rtk npm run build`。教学类型检查在精确 Node 24.21.0 的 `apps/teaching`：`node node_modules/typescript/bin/tsc --noEmit`。根目录交付检查：`node tools/a0-review/check.mjs`、`rtk git diff --check`。

根目录最终静态文档检查通过：80 documents / 1208 internalLinks，`errors=[]`；差异空白检查通过。该文档检查自身的 `businessTests=NOT_EXECUTED` 只说明它不运行业务测试，与上述独立执行的 48 项浏览器及 464 项单元结果分开记录。只读范围复核通过；复核建议仅修正测试顶部注释，使其准确区分传输故障与私有合成条件，无行为变化，未重复已通过的测试。

页面证据已人工读取：换代际后的确认作品 v2 状态（截图时编辑器仍在加载，仅作为状态栏证据）、确认 v2/冻结 v2 与较新未确认正文并列、双标签败方候选正文及“本机草稿未保护/这次没有发送”提示。文件在 Playwright `test-results` 各用例目录，均为合成正文，无账号凭据。截图和测试产物未加入写集；原工厂合成 SQLite 保留以遵守既有审计边界。

## 10. 本批验收与交接

| 清单项 | 本批实际服务结论 | 判据与证据 |
| --- | --- | --- |
| UI-REAL-05 | 隔离浏览器通过 | 缺代际真实 bootstrap 409，入口不可用、零业务写/活动读/准备回落；轮换代际拒绝旧命令、保留草稿，显式重读同 Attempt 后新键保存；迟到旧 bootstrap/ACK 不退休或覆盖较新代际 |
| UI-REAL-06 | 隔离浏览器通过 | 多文件 BOM/混合 EOL/非 BMP 原 UTF-8 字节；独立 SHA-256 核正文/manifest、版本与快照公开读回；刷新及同进程同库重开后确认作品/快照一致、较新草稿单列 |
| UI-REAL-07 | 隔离浏览器通过 | paused 仅既有 active update；submitted/reviewed 只读；请求与 DB 双计数核禁写；真实 VERSION_CONFLICT 保留拒绝/草稿，显式比较选择后新命令保存；两个 revision 分别读取、控制前重读权威 attemptRevision |
| UI-REAL-12 | 隔离浏览器通过，重启范围受限 | 服务已接受但丢 ACK 后明确重放原 key/body，单次效果；断网编辑/重连无自动写；双标签租约与草稿 CAS；换代际旧命令守卫；同进程关闭服务并重开原库读回。OS 进程崩溃/备份回退/执行节点恢复未执行 |

最终写集：本记录、README 的单条导航、两个新增真实服务 spec、`sessionHost.ts`、隔离 `i0-browser-fixture.ts`、`confirmationDb.ts`、`confirmationWorkspace.ts`。无保护文档、正常后端业务、API/schema/依赖/配置/凭据变更；原 `.zcodeignore` 未动。分支 `i0/ui-frontend`、HEAD `40db96c` 未变；未暂存、提交、推送、合并或发布。

本批不计 NFR-01 p95、生产 RPO、真实运行/停止/公开产物或教学效果，产品基线及 MVP_SPEC §10 **待授权维护者汇总**。下一前端范围为 UI-REAL-09/10/11：先核 H-04 当前指纹/代际/profile/持续消费者及对应 H-06 样例，再接真实 Core 运行/诊断、停止与未知核对、历史比较与公开产物；本批不提前替代这些条件。

## 11. 2026-10-14 PR 与合并交付授权

负责人明确要求“先把这批推 PR，合并进 main，然后开始下一批 09 10 11”，现据此提交本批八个文件，保留原 `.zcodeignore`。远端核对：`origin/main=f95488a`，本分支的前置登录 `ba89fe0` 和两条分支归属勘误尚未合入 main；本 PR 一并承载该已批准前置依赖和本批保存恢复，不把它们省略为已在 main。

交付顺序：先提交批准写集，正常 merge 最新 main 后核集成差异与必要检查，再推送 `i0/ui-frontend` 并创建 PR；核实际检查/合并状态后合入 main，不绕过分支保护、不删除分支。随后在原前端分支接上实际合并提交推进下一批。此段记录授权与顺序，不预先声明推送或合并成功；实际 PR/merge SHA 由后续任务的交付回读记录承接。

实际回读：[PR #64](https://github.com/paher-din/XunJie/pull/64) 于2026-10-14 19:16:22（Asia/Shanghai）MERGED，head `96da789`、merge `8e6d37d843a79c87bd223689746bd1aefff3bb2f`；本批提交 `b88694a`，前置登录及最新 main 正常组合后 48/48 Chrome 回归再次通过（3.7 分钟），464 单元/typecheck/build/教学类型/84文档1243内链/差异空白通过。远端当时未报告 CI 检查，未绕过保护；前端分支 fast-forward 到该 main，无分支删除或生产发布。下一批由 [UI-REAL-09/10/11 任务](I0-UI_REAL_RUN_CONTROL_HISTORY.md)承接；此回读在下一批记录更新时补入，不改写前面的实施完成快照。
