# I0-UI：真实运行、停止与历史产物（UI-REAL-09/10/11）

日期：2026-10-14（Asia/Shanghai）。主责：UI / Robert；实施：当前 Agent。状态：`isolated-service-verified`。本批前端接线及隔离服务验证完成：新增17项实际服务与60项兼容检查分别通过，具体失败/复验见 §5/§6；真实节点/现场浏览器/完整验收未执行。父清单：[真实接入清单](https://github.com/paher-din/XunJie/blob/33a68baba5005c9a6433ed2bf9c99f01d89345b6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md) §3；前置：[登录会话](I0-UI_AUTH_SESSION_ENTRY.md)、[真实保存恢复](I0-UI_REAL_SAVE_RECOVERY.md)。本任务记录实施和依赖，不改产品基线、A/B/C 分工或验收阈值。

## 1. 批次授权与 Git 基线

负责人明确要求“先把这批推 PR，合并进 main，然后开始下一批 09 10 11”。前批 [PR #64](https://github.com/paher-din/XunJie/pull/64) 已实际 MERGED，2026-10-14 19:16:22（Asia/Shanghai），merge SHA `8e6d37d843a79c87bd223689746bd1aefff3bb2f`，head `96da789ba6f731512fa840c96e3cd5668b417fe7`。保存恢复提交 `b88694a`，前置登录 `ba89fe0` 一并合入；正常 merge 最新 main 无冲突，合并前集成检查：前端 typecheck/build、464/464 单元、教学 Node 24.21.0 typecheck、48/48 Chrome（3.7 分钟）、静态文档 84 份/1243 内链、差异空白均通过。GitHub 当时无配置的检查项，未将其写成 CI 通过；合并是正常 merge、核固定 head，不绕过保护或删除分支。

当前仍在 `i0/ui-frontend`，已 fast-forward 到实际 main `8e6d37d`；原未跟踪 `.zcodeignore` 保留。下一批仅获实施授权，未预先宣布推送/合并成功。

负责人另外明确允许接纳 A 的固定 `964abb4` 中 `apps/teaching/server/app.ts`、`apps/teaching/server/app/i0.ts`、`apps/teaching/server/app/i0-readiness.test.ts` 三处既有就绪修复，并保留当前辅导消费者。随后负责人提示来源已集成 #56；进一步核查见 §3，不重复开发正常宿主。当前 main 在这三处与 `964abb4` 的父提交原字节相同，因此沿已授权范围接收三文件原样修复供本批 C/辅导链使用；#56 的 HDL 共用宿主整体接纳仍是独立集成步骤。

## 2. 已读依据、责任与写集

已读正文按 README → PRD → MVP_SPEC → TECH_DESIGN → 当前交接顺序：PRD §4.2～4.4/5/8；MVP_SPEC M-03/07/09/10、§4～6；TECH §4.3/4.4/5/5.1/7.4/7.5/8.1～8.4；TEAM §10.1/10.2 的 A/C/UI 分工；I0_UI_SPEC 的 Implementation/Testing/Further Notes；I0_UI_CLIENT_CONTRACT §3/5/6/7/8；I0_UI_06/06A/06B 的正文与实际交付；I0_UI_CLOSEOUT；ENGINEERING_HANDOFF 的编辑、运行与旧宿主边界；apps/student/IMPORT_SOURCE 与 README；父清单 §3/§8；前批真实保存恢复。相关映射：PRD-03/09/10，M-03/07/09/10，AC-04/06/10/12/15、NFR-03/04/05 的前端部分；不计整项通过。

批准实施写集：本记录、README 导航/必要学生启动说明，既有 `apps/student/src/workspace` 的运行门禁/结果/历史窄客户端及必要页面接线，`apps/student/e2e` 的本批实际服务 spec/共用 helper，隔离 `apps/teaching/server/app/i0-browser-fixture.ts` 及仅该驱动导入的合成 runner helper。复用原容器/组件/IndexedDB/outbox，不换 UI、不增依赖/schema/API 字段，不发模型请求，不在应用宿主编译或执行学生 C。

只读：产品/规划/参考/所有 AGENTS、其他作者任务、正常 runner/workspace/records/contracts、凭据/真实配置/CI。上述三处 A 就绪代码仅获“接纳既有修复”的窄授权，不扩为改写两课程宿主/消费者、接纳 #56 全部 HDL 业务或合并 #56 的授权。

## 3. H-04/H-06 与替代 PR 链

开工源码 `useRunWorkspace.ts` 只将 preparation capabilities 当作 verified，真实模式始终为 false；当前隔离 driver 未向正常宿主传 runner，仅能保存/辅导。因此不能把既有 Core 按钮或活动 profile 当成执行就绪。

A 的 [PR #59](https://github.com/paher-din/XunJie/pull/59) 固定 `964abb4277c2cf58e81d6686f6349b6ef0fa2e39` 已交真实就绪代码与作者 37 项回归；C 的[现场接收记录](https://github.com/paher-din/XunJie/blob/279f2145a33b0526f394f97739a204a1e5f0016c/docs/tasks/DLA_C_CLOSEOUT_HANDOFF.md#18-2026-10-14-批准执行-pr59-的-paher-定向接入)记载 PAHER 严格 TLS ready=200 与原对象不变。本次仅读材料，没有访问 PAHER、取得秘密、调整信任或重部署；有日期的历史现场不等于此刻窗口可用，现场旧 student dist 也不等于本批页面已验。

负责人提示后核实际来源：#59 → #53 → [#56 集成回交](https://github.com/paher-din/XunJie/pull/56#issuecomment-6166286437)。#59 于2026-10-14 18:15:28关闭且未合并，#53接纳其就绪修复后再接入 #56；#56 `25608e6` 保留唯一共享 bootstrap/worker/静态/关停，将 C readiness 接到 existing original-job-host，同时保留 boolean `checkReadiness` 健康路由和 HDL probe。#56 head `246451e423f5d792ebd93ad64d30b55794e41584` 当前 Open/Draft、未合入 main。原 `964abb4` 不是 main 祖先不能单独证明代码丢失，因为接纳采用适配提交；实际 main 文件仍无有效 readiness 才是当前缺口证据。

#56 作者集成结果 230 项/224 通过/6 模型门禁跳过，是其固定版本证据，不是本批重跑。#56 共用宿主结构与当前 main 的辅导组合不同，接纳须保留原辅导消费者；本 UI 票不静默覆盖正常宿主，也不把来源关闭解释为改动被放弃。

H-06 原公开 Job/Run/files 已有实现与 C 样例，细节沿 CLIENT_CONTRACT §6：GET 不公开入口/输入，本机原回执关联才显示参数；check 与 run 分层，产物 redacted/unavailable/missing/incomplete 不补正文。真实 PAHER 当前指纹/代际、浏览器信任和安全账号通道未在本次核验。独立隔离合成服务测试与真实节点、完整 NFR/教学验收分开。

## 4. 实施方案与验收

1. 真实模式用原同源 `/health/ready` 的成功信封核就绪，与当前授权 bootstrap 代际、固定活动 profile 和上下文绑定；失败只阻止新运行，编辑/保存及已有历史读取继续可用。每次学生新运行前重核，后台仍逐次校验权限/profile/代际，不从 Activity 独自推定节点 ready。
2. 复用 RunWorkspace、RunHistory、原 v2 outbox/lease/ACK 与 Run/files 校验；不新增运行/检查/Report 控件、不自动重跑。Core 只创建 stats/find/top，Report/check 只读合法历史。
3. 隔离 runner 保存服务端原完整 RunIdentity 与不可变结果；私有 IPC 只控制 transport 的 readiness、running/结果、停止待确认/确认、失联等条件和计数，不 SQL 改 Job/Run、不手动消费 processJob。原正常消费者推进原 Job，原表只读计数作效果证据。
4. UI-REAL-09：实际登录/创建/多文件保存/冻结→Core，核原字节/版本/参数/receipt/Job/Run，运行中改稿与旧结果分开；ready 不可用禁写；程序/编译/限额诊断与基础设施不可回取分层。
5. UI-REAL-10：停止受理和确认分开，未知保原 ID/原 key/body；丢 ACK、刷新、离线、迟到及双标签无自动替代运行；同进程重开只核原身份，不计节点持久账本或 OS 崩溃。
6. UI-REAL-11：两运行独立来源比较、第二浏览器参数不可回取；完整产物 hash/bytes/稳定 ID/原字节下载；check 和缺失产物不泄露/下载；选择逆序及只读零业务写/零草稿覆盖。

上述为开工安排；随后按已确认三文件接纳消除了本批 C 合成宿主就绪依赖，没有整批合并 #56 或扩大 HDL 实施。通过后执行相称前端 typecheck/test/build、教学精确 Node typecheck、实际服务专项和运行/停止/历史准备兼容回归；失败修根因、不关检查、不以跳过充通过。

## 5. 实施与验证记录

实现位置：

- `useRunWorkspace.ts` 与 `runWorkspace.ts`：复用原 apiGet 的同源绝对路径，6500ms 有界读取 ready 信封；与当前获准身份、分配、活动、课程、受信代际与固定 profile 绑定，每次新运行重核。健康失败不落盘伪造拒绝，继续原 head/Job/Run 读取；统一夹紧 eligible，终态读回不绕过最新就绪失败；停止/原命令核对沿原授权路径。
- A 的三文件与 `964abb4` 原 Git blob 一致（未重写业务）。接收前已核当前 main 的对应源码与其父提交相同，保留原运行/辅导消费者。其健康回调核实际短数据库事务、原消费者扫描、经 availableRuntime 验当前 fingerprint/validation/代际的 transport，并在外部等待后重核本地条件；无新共享字段、SQL schema 或第二健康路由。
- 隔离 `i0-browser-runner.ts`：只在 opt-in driver 导入，保存原完整 RunIdentity 和严格相同 submission；验证固定快照/参数摘要/批准 profile，结果 clone/hash 后不可改；终态不被 finish/confirm-stop 复活。失联接收原 run 后 outcome_unknown，只 query 原身份；取消未确认保留 units/pending/reserved。逐 run 调用计数与 submitEffects 只证明合成 transport 的接收效果，不证明实际容器执行。
- `i0-browser-fixture.ts` / `sessionHost.ts`：`startSessionHost({runs:true})` 使用同一 transport 给原 factory 与真实 createI0App，默认旧保存/会话 driver 无行为改变。新私有 runner/history IPC 不注册 HTTP 故障端点；历史经 owner 正常会话、既有 public POST runs 和原消费者建立，不 SQL 改 Job/Run、未手工 processJob。IPC 有界等原 fact/stop intent，不自行制造确认。map 在同进程同库 reopen 保留。
- 新增 [runService.spec.ts](../../apps/student/e2e/runService.spec.ts)、[runControlService.spec.ts](../../apps/student/e2e/runControlService.spec.ts)、[runHistoryService.spec.ts](../../apps/student/e2e/runHistoryService.spec.ts) 及共用 [runServiceHelpers.ts](../../apps/student/e2e/runServiceHelpers.ts)：真实表单、dist、Chrome、HTTPS/Fastify/SQLite/IndexedDB/原消费者；浏览器只延迟/拒绝原传输，执行结果来自严格合成 runner。正常角色投影仍由真实 server 裁剪，未伪造成功 GET。

只读复核未发现可确认的严重/中等问题；另发现私有 helper 的基础设施 failed 终态可被后续 finish/confirm-stop 改写，已限制到 running/outcome_unknown 的结果完成和已有停止意图的 cancelling/outcome_unknown/cancelled 确认，不改变正常 Job 状态机。

已执行检查与失败：

1. 隔离 helper 首次教学类型检查因 optional 字段的 undefined 与 exactOptionalPropertyTypes 冲突失败；在 IPC 边界仅序列化确有值的字段，教学/学生类型检查恢复通过。实际 HTTP 烟测首轮“停止确认早于 consumer 看到 node cancel”失败；改为有界等待原 fact/intent，最终 Core、五类历史、unknown→待确认停止→确认→同库重开通过，unknown submitEffects=1。未将其计入浏览器数。
2. A 接纳后的真实宿主/就绪/辅导消费者回归：教学精确 Node 24.21.0，`node --test --test-concurrency=1 --test-reporter=tap server/app/i0-readiness.test.ts server/app/i0.test.ts server/app/i0-tutoring.test.ts`，**24/24 通过、0失败/跳过**（57.4秒）；保留正常合成库，不启动实际模型/节点。
3. 前端 typecheck/build 通过；本批完整单元 **34文件/464项通过**（3.34秒）。既有 Monaco chunk/public 品牌/NO_COLOR 警告保留。增加两个传输等待用例后类型检查指出可选 release 回调需明确已赋值；修正纯类型标注，再次 typecheck 通过，无运行行为变化。
4. 新增实际服务首轮 **15项/14通过/1失败**（2.3分钟）：失败是测试把 edit 的插入语义当作替换，与预期完整正文不符；明确 Control+A 后再输入，原单例定向 **1/1 通过**（27.8秒），未改产品代码或放宽正文断言。历史7项/停止3项均通过；随后将历史等待加强为新 runId→完成，并增加实际双标签停止与迟到 Job 读取两项，共17项。
5. 77项组合回归实际 **76通过/1失败**（7.6分钟、2 workers、无跳过）：失败仅新增双标签用例，真实consumer已更新另一页停止状态，测试却等待过时“停止此运行”按钮；60项既有兼容和另外16项新增均通过。按当前公开状态读取原停止意图，再用同一原命令/lease显式核对，未放宽零重复POST/零替代run断言；修复后仅复跑两张受影响运行/控制spec，**10/10通过**（1.7分钟、2 workers、无失败/跳过）。历史7项在组合批通过且之后未改，最终独立覆盖为新增17项+兼容60项，不把不同轮次重复计入或写成一次77/77绿色运行。

## 6. 最终结果与范围

最终命令（`apps/student`；教学精确 Node 路径替换为本机已登记路径）：

```powershell
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
$env:XUNJIE_E2E_PREP_PORT = '5681'
$env:XUNJIE_E2E_REAL_PORT = '5682'
$env:XUNJIE_E2E_RESTART_PORT = '5683'
$env:XUNJIE_E2E_SERVICE_NODE = '/mnt/d/codex-tools/node-v24.21.0-linux-x64/bin/node'
$env:CI = '1'
rtk npm run test:e2e -- runService.spec.ts runControlService.spec.ts runHistoryService.spec.ts runResults.spec.ts runControl.spec.ts runHistory.spec.ts saveRecoveryService.spec.ts saveStateService.spec.ts sessionService.spec.ts tutoringService.spec.ts --workers=2 --max-failures=3
```

77项后的修复复验：同一环境 `rtk npm run test:e2e -- runService.spec.ts runControlService.spec.ts --workers=2 --max-failures=2`，10/10通过，最新 `.last-run.json` 为 passed/failedTests=[]，该文件只表示这10项。前端 `rtk npm run typecheck`、`rtk npm test`、`rtk npm run build` 和教学精确 Node 的 `node node_modules/typescript/bin/tsc --noEmit` 均通过。根文档检查85份/1252内链/errors=[]，差异空白通过；静态检查的 businessTests=NOT_EXECUTED 与独立实际测试分开。

| 项目 | 已完成的前端/隔离证据 | 保留边界 |
| --- | --- | --- |
| UI-REAL-09 | ready信封与当前授权绑定、失效零新run命令且保存可用；stats/find/top、先落盘/权威版本/固定snapshot/hash；改稿不改贴旧结果，编译/程序/时间/输出/基础设施公开状态分层，迟到Job不回退 | 不证明实际GCC/容器执行、当前节点指纹或NFR限额 |
| UI-REAL-10 | 停止受理/确认、ready失败仍可停止而不解禁新run；run/cancel丢ACK仅明确同key/body重放；outcome_unknown原ID查询不重submit；双标签lease零重复POST；同库重开保原未确认停止 | 合成runner的单位/槽位事实，不替代真实节点整个单元终止与持久账本/OS恢复 |
| UI-REAL-11 | 两运行独立快照/原请求参数、第二浏览器不猜；85-byte BOM/混合EOL/非BMP Report独立hash/ID/下载；check真实角色投影裁剪，missing/incomplete/unavailable禁下载；迟到files与零业务写/零草稿覆盖 | 合法合成历史，不新增Core Report/check创建控件，不计课程检查/教学效果 |

页面证据：历史专项Agent实际读取浅/深双列及Report下载截图，来源/摘要无横向溢出，Report的script文本安全只读；主Agent读取最终Core较新草稿与停止后的新操作截图，结果仍标固定作品v1且输出明确合成。停止截图位于确认后学生明确新run的状态，仅作后续操作证据；停止中/取消确认的判据来自HTTP/UI行为断言。后续专项会覆盖Playwright test-results，截图/下载不入Git；已清理PR正文临时文件，原合成数据库继续保留。

范围：实际 HTTP/SQLite/原 Job 消费者加合成外部 runner；TLS 忽略仅在测试 context，未修改系统/正常浏览器信任或领取现场秘密。Report/check 是合法公开历史种子，本批 Core UI 仍只创建 stats/find/top；不新增 Report/check 控件、不凭 Job succeeded 认课程通过。重开只核同进程同库、持续内存 runner，不计 OS 崩溃、真实节点持久账本、旧备份/RPO/NFR 或教学效果。PAHER 当前窗口/指纹/代际、真实编译/取消/隔离及真人验收未执行。

最终写集16文件：README导航、学生README用法、前批保存记录的实际PR64回读、本记录；两个前端运行文件、sessionHost、三张新增service spec与共用helper；隔离browser fixture/runner；A固定修复三文件。A三处Git blob与964原源一致；受保护文档、正常runner/workspace/records/contracts、schema、依赖/lock、真实配置/凭据/CI均未变，原 `.zcodeignore` 保留。

实现完成时的交付快照：原 `i0/ui-frontend`，基线为前批merge `8e6d37d`，本批本地提交 `e0dabe534398e9e57031aa33b07c54e1d892ceec`；当时未推送/创建本批PR/合并或发布。该时点GitHub回读：#64仍MERGED、merge8e6d37d；#56仍Open/Draft、head246451e，未合main。本批只接纳明确批准的三处既有C就绪代码，其完整HDL/共享宿主接纳独立；产品基线/MVP§10待授权维护者汇总。后续交付见 §7。

## 7. 2026-10-14 PR 与 main 合并交付

负责人在会话中对“下一批09/10/11”明确批注“把我们这次完成的这一批也推动，建PR，然后合并到main”，授权推送本批、创建PR并正常合并。交付分支继续使用 `i0/ui-frontend`，保留来源分支和原 `.zcodeignore`，不扩大到 #56 整批合并或生产发布。

交付前实际核查：远端 `main=8e6d37d`，本批 `e0dabe5` 以其为直接父提交，没有新主线差异；写集16文件，三处A源blob与964逐项一致，无保护文档/配置/依赖/秘密越界。源码与上轮已验证版本相同，本轮仅补交付记录，不重复通过检查或将既有不同批次数合并称一次77/77。沿原本地464单元、24宿主、17新增实际服务与60兼容的准确证据边界交付；静态文档与差异空白复核通过。#56在本轮核查时仍Open/Draft、head246451e，未合main。

已普通推送原 `i0/ui-frontend` 并创建 [PR #66](https://github.com/paher-din/XunJie/pull/66)。创建时回读快照：head `36adbf5efdaa8004343352b4226e2e5e6c2c164f`，base `8e6d37d`，Open/non-Draft、MERGEABLE/CLEAN；GitHub未报告配置的检查项，不称CI通过。本轮新增提交仅本记录，运行实现仍为已验证的 `e0dabe5`；来源三blob及16文件写集不变。

负责人已明确批准本PR正常合入main，使用固定head核对，不加admin绕过、不删除来源分支、不部署。创建快照不是预报合并成功；实际mergedAt/merge SHA保留在上述PR及main Git记录，交付最终回读同时回报负责人。本节历史阶段和§5/§6测试失败/修复事实保留，产品/MVP§10待授权维护者汇总。
