# I0-UI-BV：编辑器状态与本机作品保护浏览器补验

日期：2026-10-13（Asia/Shanghai）。负责角色：UI / 前端接入成员 Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。状态：两项补验与测试耗时优化已验证，准备本地提交；尚未推送/合并。

## 1. 范围、授权与依据

负责人 Robert 明确要求开始完成[收尾记录](I0_UI_CLOSEOUT.md)所列的两项 02 浏览器缺口：折叠/切换后的状态保留，以及布局重置/清缓存不清草稿和确认记录。基线为已合并准备工程 `main@c98f7cea632f9718556ecdfcfcb46646d0beb6f3`，工作分支 `codex/i0-editor-browser-verification`；初始已跟踪工作区干净，仅既有未跟踪 .zcodeignore 保留。

已读：根 AGENTS/README 的边界、前端入口与合并结果；PRD §1、§3.2、§4.2、§5；MVP_SPEC §2、M-03/M-09、§4～6；TECH_DESIGN §3.3、§7.4、§11；I0_UI_SPEC 的 User Stories/Implementation Decisions/Testing Decisions；CLIENT_CONTRACT §2～5、§7～8；02 正文、验收与缺口；学生 README 运行/模式/测试，IMPORT_SOURCE 的固定来源与主仓库业务维护边界。

验收依据：PRD-03/09、M-03/09、AC-03/12、NFR-01/05 的相关前端责任；02 的第 1/9 项验收、SPEC User Stories 7/11 与 Implementation Decisions 的布局/缓存保护要求。本次不声称整项 AC/NFR、真实服务或教学效果通过。

可写：本记录、README 本任务导航/验证结果、新增 `apps/student/e2e/editorProtection.spec.ts`；若复现原规格偏差，限编辑器视图保存/恢复或现有设置清理路径的最小修复（`CodeEditorHost.tsx` / `CodeWorkspace.tsx` / `lib/settings.ts`），来源记录仅在实际业务修复时同步。只读：其他作者任务、product/planning/reference、规范、Design、后台、schema、依赖/lock、CI 与凭据。保留原页面/布局/控件，不新建功能，不改存储 schema，不启动真实服务或外部模型。

## 2. 验收方案

- 启动现有 dev:prep 与真实 Google Chrome，每个用例独立合成场景/浏览器上下文；复用已有 start/create/edit/localState/serverHead 等 helper。
- 通过真实 Monaco 操作折叠代码，切到另一文件再返回；核对折叠、光标、滚动及正文。另核现有中心标签切换造成卸载/重挂后的状态，避免只验保存调用。
- 从现有设置页分别执行清除缓存、重置布局及其确认按钮；设置哨兵键验证动作确实生效，并在动作前后读取同源 IndexedDB 全部 store 的落盘事实。
- 回到同一准备场景并刷新，分别核未确认草稿、已确认版本/原文/实例、冻结快照和原 outbox 记录；核对无额外业务写请求。不通过直接调用清理函数或注入假成功代替操作。
- 先跑新增针对用例。出现真实缺陷时保留失败证据、修根因并按影响补相关回归；仅测试改动做 typecheck 和文档/空白检查，既有 238/104 结果不充当本次新运行。

## 3. 实现与验证

首轮四项失败均未走完目标行为：两个折叠用例的快捷键按 runner macOS 而浏览器 UA 为 Windows；两个清理用例的中文场景名不符合请求头要求。修正 ASCII 场景名/浏览器平台快捷键后，两项实际设置清理通过；折叠用例暴露批量 insertText 自动缩进/括号补全改变输入，改为真实系统剪贴板粘贴，并先逐字核原文。

随后两项折叠检查：文件切换用例因已存在文件时新建按钮位于菜单中而未进入切换（测试操作修正）；中心工具卸载/重挂用例真实失败，预期“行 105，列 13”，实际“行 —，列 —”。根因是 CodeEditorHost 在 restoreViewState 后无条件调用 cursorRef(null)，抹去已恢复位置的可见状态。最小修复限定在该恢复路径：从已挂 model 的当前位置映射原文服务端行列并报告，不改变正文、model 身份、折叠/布局、存储或共享契约。符合原 02 状态保留范围，无额外产品决定。

修复后中心工具卸载/重挂用例通过；文件切换用例仍因沿用“新建文件”button 查找而未进入操作，实际菜单入口的 role 是 menuitem，已修正测试操作。最终新增四项及七项原有相关回归 **11/11 通过（1.0m，0 失败/跳过）**：折叠/光标/滚动与原文保留、中心工具卸载/重挂、清除缓存、重置布局；原有多文件/中文/键盘/刷新、新建、写失败、确认/快照、保存期间继续编辑、混合 EOL/BOM/非 BMP 原文保真。新增四项均使用同一准备开发进程与真实 Chrome，没有新增成功响应或写业务库替身。

清理用例分别从现有设置按钮与确认按钮执行；哨兵键证实清理生效，动作前后 IndexedDB 全部七 store 记录逐项一致。回到原场景再刷新后，未确认草稿与确认作品仍分离，确认 head/实例/原 outbox 记录不变，冻结快照与 fixture 权威 head 不变，业务写请求新增为 0。折叠用例通过系统剪贴板粘贴精确多行 C，逐字核输入，再走真实 gutter 与平台快捷键；没有调用内部 Monaco 方法伪造视图。

执行环境：Node 24.18.0 / npm 11.16.0，`XUNJIE_E2E_BROWSER_CHANNEL=chrome`；本机 Chrome CLI 回读为 Google Chrome 155.0.8059.40。浏览器为自动化运行的隔离上下文，记录不是实际学生行为。apps/student 目录的最终相关检查：

```sh
CI=1 XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_E2E_PREP_PORT=5671 XUNJIE_E2E_REAL_PORT=5672 XUNJIE_E2E_RESTART_PORT=5673 npm run test:e2e -- editorProtection.spec.ts editor.spec.ts confirmation.spec.ts --grep '折叠|切换标签|多文件编辑|新建文件|写失败|清除缓存|重置布局|学生主动创建、保存|保存等待期间|混合 EOL'
npm run typecheck
npm test
npm run build
```

Vitest 22 文件/238 项通过（4.80s），typecheck 通过，build 通过（6.73s）。既有大 chunk 提示，以及开发运行中品牌 JSON 的 public asset 提示保留，未改构建阈值。只运行与本修复相关的 11 项浏览器检查，未重跑全部 108 项；旧 104 全量结果仍是原源码的有日期记录，不能当作本次 108 全量通过。完整键盘流程、真实后台/节点/模型、完整 AC/NFR 和真人/教学效果未在此验证。

代码位置：[CodeEditorHost](../../apps/student/src/components/workspace/CodeEditorHost.tsx)恢复后报告当前原文行列；[editorProtection.spec.ts](../../apps/student/e2e/editorProtection.spec.ts)四项行为回归；[来源记录](../../apps/student/IMPORT_SOURCE.md)保留主仓库修复边界。已有 [02](I0_UI_02_EDITOR_DRAFTS.md)与收尾历史记录未覆盖；本记录明确补齐这两个具体缺口，不自动将完整 AC 复选框或产品基线标成通过。

## 4. 交接与未完成项

真实读取/保存/运行仍按 #30 的 H-01～H-06 交接；A/C 的职责和父卡关闭条件不变。本次补验事实在本人记录中承载；MVP_SPEC §10 的进度请求待授权维护者汇总，其他作者记录由原维护者按本记录证据更新。

两项补验完成时点的收尾：文档静态检查 56 文档/760 内链、errors=[]；已跟踪差异的 `git diff --check` 退出 0，两个新增文件的 `git diff --no-index --check /dev/null <file>` 无空白错误输出（退出 1 表示新增文件存在差异）。最终 typecheck 再次通过；`playwright test --list` 为 108 项/14 文件，当时只将实际执行的 11 项记通过。当时生成的 dist/test-results 已清理，5671/5672/5673 无残留监听；既有未跟踪 .zcodeignore 保留。当时写集仅 README、本文、IMPORT_SOURCE、CodeEditorHost 和新增 editorProtection.spec.ts 五文件，均为本地未提交改动，没有推送、PR、合并或 Issue 评论更新。后续负责人追加的测试耗时审查、全量结果与当前交付状态见第 5 节。

## 5. 测试耗时审查与精简（2026-10-13）

负责人 Robert 追加要求：从第一性原理审查当前测试，在不影响相关验证的前提下精简，完成后提交并核对能否合并。原两项浏览器补验与修复继续包含在同一交付中。

本节扩展写集至 `apps/student/playwright.config.ts`、`apps/student/e2e/**` 的必要 harness/等待调整及学生 README 的运行说明；保留全部原行为、错误/重启/并发分支、真实浏览器/IndexedDB 与请求证据。产品基线、共享业务契约、依赖、CI 和其他作者任务仍只读。

审查原则：测试的价值是独立发现用户可见错误，不以数量少为目标。Vitest 238 项约 5 秒，暂不删；浏览器测试先测量 108 项基线，按真实共享资源判断能否并行，再删除可用状态证据替代的固定等待。重启端口和系统剪贴板保持同文件顺序执行，每项继续独立浏览器上下文/场景；不共享已登录页面或直接灌入成功存储缩短业务链。

验证方案：同一 Node/Chrome、端口和 `CI=1` 下记录调整前后全量总耗时、逐项耗时及 108 项名称对应；默认调度全量通过，必要时对失败或疑点定向复验。保留 retries=0 与原 timeout/expect 门槛；typecheck、Vitest、build、文档/空白检查完成后仅提交本任务文件。提交后检查最新 main、冲突与 GitHub 合并条件；实际推送/PR/合并事实另记。

### 5.1 审查判断与实际改动

- 238 项 Vitest 已在秒级完成；删除规则/协议反例不能显著缩短本次等待，全部保留。
- 浏览器的创建/保存/冻结重复主要是各场景的独立前置。回执中断、跨标签/加载/代际逆序、刷新重放、停止和历史文件校验分别约束不同路径；不合并成一个长流程，也不复制成功 IndexedDB 作为 setup。
- 默认 worker 从 1 改为 2，`fullyParallel=false` 保留。每项新浏览器 context 与 UUID 写场景使不同 spec 可以并行；同文件内的三项独占端口重启、两项系统剪贴板折叠操作仍顺序执行。`--workers=1` 保留资源受限时的串行方式。
- `confirmation.spec.ts` 正常保存/冻结用例，刷新前的固定 550ms 改为轮询真实 IndexedDB 新草稿正文；旧保护提示或已确认正文不会让等待提前成功。其他迟到响应/只读输入/轮询预算的时序等待本次保留。
- 学生 README 明确“开发先跑相关 spec，最终候选跑全量”，专项与全量结果分别记录；不把未运行分支当作通过。

串行实测基线：同样包含新增四项与行列修复，1 worker、108/108 通过，0 失败/跳过/flaky，JSON 总耗时 439681.43ms（7 分 19.68 秒）。最大三个文件为 runResults 15 项/89.78s、runControl 15 项/78.22s、runHistory 10 项/46.75s；单项最长 8.24s，成本分散在各项完整浏览器业务链，未发现单个超长阻塞可直接删除。

### 5.2 失败运行与修正依据

首次 2 worker 全量为 90 通过/18 失败/0 跳过，JSON 总耗时 3091034.444ms（51.5m），不是优化通过。12:35:35 起的 macOS `pmset -g log` 明确记录 Clamshell Sleep 及多次 Maintenance/Sleep Service 休眠；955/927/468 秒的休眠与测试实耗 957/927/468 秒的超时重合。其余失败集中在进入休眠后；这轮不能用于有效耗时比较，也不把失败全部自动归为环境问题，仍须重跑验证。

12:35:27、休眠前发生的独立失败是准备设置页“无外发”检查：实际 URL 为 `blob:http://127.0.0.1:5671/<uuid>`，本机 blob 被 env.ts 的 hostname 判定误算成外发。修正范围为检查 blob 的来源 origin，外部来源、无来源和非法 URL 仍拒绝；在原 provider 用例加入本机 blob/外部 blob/无来源 blob 三个断言，保留实际请求零外发断言，不跳过检查、不过滤全部 blob。全部 108 项仍保留。重跑时仅通过命令生命周期内的 `caffeinate -i` 防空闲休眠，不改系统电源设置，人工合盖仍由操作系统处理。

### 5.3 最终全量结果与覆盖核对

本节耗时对照使用系统 CLI（最终回读 Node 26.0.0 / npm 11.12.1）、Playwright 1.64.0 / Google Chrome 155.0.8059.40；未安装或调整依赖，未改 lock。第 3 节 Node 24.18.0 与 11 项专项结果为更早的独立运行，未拿其耗时参与本节对照。两侧均 `CI=1`、相同 prep/real/restart 三端口、真实 Chrome、retries=0，完整 108 项；有效的串行基线与最终并行运行均无失败/跳过/flaky。

| 检查 | 调整前 | 调整后 |
| --- | --- | --- |
| 浏览器用例/文件 | 108 / 14 | 108 / 14 |
| workers；文件内执行 | 1；顺序 | 2；顺序 |
| JSON 总耗时 | 439681.43ms（7:19.68） | 218631.37ms（3:38.63） |
| 通过/失败/跳过/flaky | 108 / 0 / 0 / 0 | 108 / 0 / 0 / 0 |

本机这两次有效全量运行节省 221.05 秒（50.28%）；是实际单轮对照，不推广为其他设备/平台的保证。前后 `file::title::projectName` 排序后逐项一致，108 项名单 SHA-256 为 `060c332bd1e6202ca61993f413d37078db764bf22aafe73cf6715039052877b7`。涵盖 compare 5、confirmation 20、draftConflict 2、editor 4、editorProtection 4、fileHistory 7、prep 10、prepRestart 3、real-mode 3、recovery 8、runControl 15、runHistory 10、runResults 15、stateGuards 2 项。没有删用例、缩断言、加重试或跳过。

复现命令（apps/student；macOS 的 caffeinate 仅防本次命令运行期间空闲休眠，其他环境无需该包装）：

```sh
CI=1 XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_E2E_PREP_PORT=5671 XUNJIE_E2E_REAL_PORT=5672 XUNJIE_E2E_RESTART_PORT=5673 npm run test:e2e -- --workers=1 --reporter=json
CI=1 XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_E2E_PREP_PORT=5671 XUNJIE_E2E_REAL_PORT=5672 XUNJIE_E2E_RESTART_PORT=5673 caffeinate -i npm run test:e2e -- --reporter=json
npm test
npm run typecheck
npm run build
```

最终 Vitest 22 文件/238 项通过（926ms）、typecheck 通过、build 通过（2.64s）。既有大 chunk 提示与开发 public JSON 提示保留；Node 26 的 localStorage ExperimentalWarning 如实保留，未关闭检查或改构建阈值。真实服务、执行节点、模型、完整 AC/NFR、真人与教学效果仍未验证；本节是准备工程的完整浏览器回归。
