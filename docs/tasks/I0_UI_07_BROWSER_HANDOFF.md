# 07：完整准备链浏览器验证与交接

**What to build:** 验收成员在实际准备启动中回放正常与增强故障链，交付可复核证据，并按读取/保存/运行分别说明真实接入状态。

**Blocked by:** [04 网络恢复](I0_UI_04_RECOVERY_CONFLICTS.md)、[04A 冲突选择](I0_UI_04A_LOCAL_CONFLICTS.md)、[05 文件历史](I0_UI_05_FILE_HISTORY.md)、[06A 运行控制](I0_UI_06A_RUN_CONTROL.md)、[06B 运行历史](I0_UI_06B_RUN_HISTORY.md)。

**Document status:** `implemented-and-verified`（准备范围收口，2026-10-13）。

**Status:** `preparation-delivered`：五个前置 ticket 均已于 2026-10-12 交付（见各自状态行），P-01 由项目负责人 2026-10-13 的「/implement 开始 I0_UI_07_BROWSER_HANDOFF.md」指令落实。本票只收口**准备范围**：工程检查、真实 Chrome 手动回放、Playwright 全量、故障回放矩阵与逐能力交接证据；真实服务/节点/模型/全产品/教学效果一律未执行，见「层次区分」。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[准备记录](I0_UI_PREPARATION.md) §5～8、[客户端约束](I0_UI_CLIENT_CONTRACT.md)。M/AC/NFR 原阈值不变，准备与 I0/产品验收分开。

负责本批必要集成/回归、启动/验证文档、交接证据及本文；不顺带重构，不改后台/CI/Design 工作副本、其他任务或受保护基线。

**实际写集（开工登记，2026-10-13，起点 `f975b4203897a2449e90340cffe57bf3d4508b67`，分支 `i0/ui-frontend`）：**

| 文件 | 改动 |
| --- | --- |
| `apps/student/e2e/stateGuards.spec.ts` | 新增：07 补的「暂停/终态」状态闸回放（暂停下不能新建、不能发起 Core 运行；`submitted`/`reviewed` 终态编辑器只读且确认保存不可用） |
| `apps/student/e2e/prepRestart.spec.ts` | 新增：真实杀掉并重新拉起 dev:prep，回放换 epoch 后旧确认缓存不装成新 head、草稿保留、原命令不自动迁代际 |
| `apps/student/e2e/env.ts` | 新增 `RESTART_PORT`（默认 5611）与 `RESTART_URL`；三端口互不相同校验 |
| `apps/student/e2e/helpers.ts` | 新增共享 `trackBusinessWrites`（零业务写命令断言，供状态闸与重启用例共用） |
| `apps/student/playwright.config.ts` | 新增 `XUNJIE_E2E_BROWSER_CHANNEL` 环境变量，可在真实安装的 Chrome 上取证；默认仍是自带 Chromium |
| `apps/student/README.md` | 同步上述两个环境变量与重启用例的端口说明 |
| `docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md` | 仅修一处失效锚点（`#L77` → `#5-原命令ack-事务与崩溃恢复`） |
| `docs/tasks/I0_UI_05_FILE_HISTORY.md` | 仅修一处失效路径（`src/components/workspace/../workspace/frozenCommand.ts` → `src/workspace/frozenCommand.ts`，并去掉检查器无法解析的行号片段） |
| 本文 | 收口记录 |

只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、`apps/teaching/**`、服务端与 CI/CD、密钥。未跟踪的 `.zcodeignore` 不属于本任务，不暂存、不提交。

## 实际执行记录（2026-10-13）

### AC1 无 Design checkout 的按 lock 构建

用 `git archive HEAD apps/student` 导出**已提交树**到 `/tmp/i0-07-clean`（314 个文件、无 `node_modules`），在该目录独立安装与构建，证明既不依赖设计仓库 checkout，也不依赖工作区已有 `node_modules`：

```sh
git archive HEAD apps/student | tar -x -C /tmp/i0-07-clean
cd /tmp/i0-07-clean/apps/student
npm ci          # added 145 packages, and audited 146 packages in 2s
npm run build   # ✓ built in 3.00s
```

| 项 | 值 |
| --- | --- |
| 源（设计导入）commit | `a9bb1dd016489d3e60e0b45933e440296c1194d8`（见 [IMPORT_SOURCE §1](../../apps/student/IMPORT_SOURCE.md)） |
| 目标（本仓库）commit | `f975b4203897a2449e90340cffe57bf3d4508b67` |
| Node / npm | v24.18.0 / 11.16.0 |
| 浏览器（取证） | Google Chrome **154.0.8037.98**（`/Applications/Google Chrome.app`，经 `XUNJIE_E2E_BROWSER_CHANNEL=chrome`） |
| 浏览器（默认门禁） | Playwright 自带 Chromium 156.0.8078.4 |
| 精确依赖 | monaco-editor 0.57.0、@playwright/test 1.64.0、@types/node 24.19.2、react/react-dom 19.3.0、react-router-dom 7.18.4、@tanstack/react-query 5.104.0、@radix-ui/react-dialog 1.1.23、marked 18.1.0、remend 1.4.0、vite 7.3.6、typescript 5.9.3、vitest 3.2.7、@vitejs/plugin-react 5.2.0 |

正式产物不带 fixture：对 `dist/` 全量 `grep`，`__i0prep`、`i0-prep-textscope-c`、`run-script`、`history-sample` 均 0 命中；`synthetic` 的 7 处命中全部是 Monaco 内部字符串，`preparation` 的 1 处是 `blocked-preparation`——准备模式下**阻止**外发供应商请求的客户端守卫文案，不是合成材料。

`npm audit` 报 6 个漏洞（2 low / 1 moderate / 1 high / 2 critical）。**只登记不处理**：依赖增改属 P-03 授权范围，本任务不自行升级。

### AC2 真实 Chrome 手动回放（无测试拦截）

在真实安装的 Chrome（user-agent 无 Electron、brands 含 `Google Chrome 154`）上，对 `npm run dev:prep`（epoch `prep-epoch-13657cdddcf1`）走完整链，全程不注入任何故障：

1. 首页「准备场景（合成）」卡片进入 `/#/task/i0-prep-textscope-c`，顶栏徽章 `data-status=ready`，明示「合成场景：材料与身份都是模拟的，不会写入学习记录」。
2. 「开始 Attempt」→ 新建 `main.c` → 真实键盘/编辑管线输入 C 源码 → 状态栏 `本机草稿已保护`，IndexedDB 草稿与输入一致（Monaco 自动缩进如实保留）。
3. 「确认保存」→ 顶栏 `确认作品 v1 · 与草稿一致`；GET 权威 Attempt 得 `workspaceRevision=1`、`main.c` contentHash `9c8d61180855`、103 字节。
4. 「冻结确认作品」→ `已冻结快照 v1`（snapshot `1b7ad62a-…`）；GET 快照清单与 head 的 contentHash 完全一致。
5. **刷新后重读**：`确认作品 v1 · 与草稿一致`、`已冻结快照 v1` 不变；本机确认头 revision/hash（1 / `9c8d61180855`）与服务端 GET 一致；快照 GET 清单仍与 head 一致（103 字节、同 hash）。
6. 新建 `sample.txt` 作为输入 → 确认保存 v2 → 冻结 v2（snapshot `481d4eaf-…`，`attemptRevision=3`）。
7. 「Core 运行」选快照 v2 + 入口 `main.c` + 操作 `stats` + 输入 `sample.txt` → 「运行此快照」→ 结果区 `快照作品 v2 的结果 / 运行完成 / 本机请求记录 · 入口 main.c · stats · 输入 sample.txt`，stdout 标 `SYNTHETIC`，并明示「合成准备运行 · 不编译或执行真实 C 程序」「结果只读，供你修订作品；不作为课程通过或能力评价」。
8. **修订**：运行后回到编辑器追加注释 → 顶栏变 `1 个文件未确认 ▸ 确认作品 v2`，服务端仍 `workspaceRevision=2`、快照仍 `[1,2]`；再开 Core 运行，结果仍绑定 `快照作品 v2 的结果`——改稿只进草稿，不动旧快照与旧结果。
9. **原数字逻辑演示保留**：`/#/task/counter` 仍有入场任务卡（进行中 60%）、虚拟板 SW0-3/KEY0/KEY1、引导层与「板卡行为由界面脚本模拟，未接仿真器」标识；点「计数」交互正常。
10. **真实 dev 不回退**：`http://127.0.0.1:5180`（`npm run dev`）上准备入口不出现、准备任务路径显示「没有找到这个任务」；`GET /__i0prep/context` 返回的是 Vite SPA 回退的 `text/html`（index.html），**不是** fixture 的 JSON——fixture 未挂载，也没有回退到 Mock 成功。

### AC3 / AC6 工程与浏览器检查

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`tsc --noEmit` + `tsc --noEmit -p tsconfig.node.json`） |
| `npm test` | 22 文件 / **238 例**通过 |
| `npm run build` | 通过（`✓ built in 2.98s`） |
| `XUNJIE_E2E_BROWSER_CHANNEL=chrome npm run test:e2e` | **102 例通过（5.9m）**，0 失败；浏览器为真实 Chrome 154.0.8037.98（code-review 修复后的最终一轮） |
| `node tools/a0-review/check.mjs` | 49 文档 / 598 内链，**errors: []** |

e2e 断言落在可见正文/状态、真实 IndexedDB 与实际请求上：全套件仅 2 处 `page.screenshot`（`runHistory.spec.ts:64-68`、`runResults.spec.ts:33-41`），都是在真实断言之后另存的附录产物；没有任何 `toHaveScreenshot`/视觉比对。

### AC4 / AC5 故障回放覆盖矩阵

| # | 场景 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | ACK 本机事务各阶段中断后刷新重放 | 已覆盖 | `confirmation.spec.ts:60-126`（mapping/head/drafts/outbox 四阶段循环）；取消变体 `runControl.spec.ts:261-282` |
| 2 | g2 重读后 g1 ACK | 已覆盖 | `confirmation.spec.ts:200-229`、`:401-431`、`:433-456` |
| 3 | 同对象逆序加载 / 迟到 poll | 已覆盖 | `confirmation.spec.ts:310-342`；`runResults.spec.ts:146-170,172-211`；`runControl.spec.ts:210-230` |
| 4 | 原文 EOL/BOM/undo | 已覆盖 | `confirmation.spec.ts:128-161`（BOM+中文+非 BMP+CRLF+裸 CR+尾空行字节不变）；`editor.spec.ts:47-69`（真实键盘 undo/redo）；`src/lib/originalText.test.ts` |
| 5 | 网络恢复 | 已覆盖 | `recovery.spec.ts:13-93,95-125,217-277,321-347,349-379` |
| 6 | 冲突选择 | 已覆盖 | `compare.spec.ts:45-92,94-112,114-198,217-275`；`draftConflict.spec.ts`；IDEMPOTENCY_CONFLICT 为 Vitest 覆盖（`recovery.test.ts`、`prep/workspace.test.ts`），无浏览器回放——登记为已知深度差 |
| 7 | 暂停/终态 | **本票补齐** | 原有 `fileHistory.spec.ts:125-151,250-296`；本票新增 `stateGuards.spec.ts`：暂停下新建与 Core 运行被挡（零业务 POST）、`submitted`/`reviewed` 终态编辑器只读且确认保存不可用 |
| 8 | 同名恢复 | 已覆盖 | `fileHistory.spec.ts:55-123,204-248` |
| 9 | 取消未确认 | 已覆盖 | `runControl.spec.ts:5-39,165-189,191-208,284-310,312-335,337-357,359-390` |
| 10 | 缺历史参数与产物裁剪 | 已覆盖 | `runHistory.spec.ts:77-95,97-118,120-134,136-145,147-170,197-232` |
| 11 | 准备进程重启/换 epoch | **本票补齐** | `prepRestart.spec.ts`：真实杀进程重启，断言新 epoch 下本机确认头为空、界面回到「开始 Attempt」、`reference()` 报 `changed`、零业务写命令、旧草稿与旧原命令按旧上下文仍可读回 |

场景/命名空间隔离：每个 e2e 用例独立浏览器上下文（`workers:1`、`fullyParallel:false`），scenario ID 每用例 `crypto.randomUUID()`（`helpers.ts:16`），fixture 状态按 scenario 分桶（`prep/workspace.ts:66-69`），IndexedDB 记录键含 scenarioId（`confirmationDb.ts:41-49`）。不外发模型、不进真实学习记录：`prep.spec.ts:219-237` 断言全部请求 URL 为 loopback，界面明示不写入学习记录。

### 本批新增代码

- `e2e/stateGuards.spec.ts`：2 例。
- `e2e/prepRestart.spec.ts`：1 例。直接 `spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode','prep', …])` 独占 `RESTART_PORT`，`SIGTERM` 后超时 `SIGKILL` 兜底；`finally` 回收**全部**已拉起的实例（断言失败也不留占端口的孤儿进程）。不新增任何 dev-only 控制端点。
- `e2e/helpers.ts`：新增共享的 `trackBusinessWrites`（状态闸与重启用例共用「零业务写命令」断言，避免两份拷贝）。
- `e2e/env.ts`：`RESTART_PORT`/`RESTART_URL` 与三端口互异校验。
- `playwright.config.ts`：`XUNJIE_E2E_BROWSER_CHANNEL`（默认空 = 自带 Chromium）。

## 逐能力交接证据（AC8）

| 能力 | 客户端责任 | 准备范围已接入证据 | 真实接入仍缺（H） | 不阻塞 |
| --- | --- | --- | --- | --- |
| Session/固定活动/资料读取 | 01 | `prep.spec.ts` 全量；真实 Chrome 手动进入与读取 | H-01、H-02 | 新列表 API、运行 worker |
| 已有 Attempt 只读 | 03 | `confirmation.spec.ts` 读回；手动刷新 GET 一致 | 读取身份与获准 Attempt 引用样例（H-06） | 首次 create 代际、运行 readiness |
| 首次 Attempt/确认保存/快照 | 03 | `confirmation.spec.ts`、`prepRestart.spec.ts`；手动 v1/v2 + 快照清单核验 | H-01、H-03、H-05、H-06 保存样例 | H-04、06A/06B |
| 一次 Core 运行/基础结果 | 06 | `runResults.spec.ts`；手动运行 v2 与结果绑定 | H-04 readiness/profile、H-06 运行样例 | 完整历史参数、Report |
| 停止/原运行未知核对 | 06A | `runControl.spec.ts` 全量 | H-04/H-06 停止样例 | 06B 与不相关后台 |
| 历史/公开产物 | 06B | `runHistory.spec.ts` 全量 | H-06 产物/裁剪样例 | 另一增强票 |

H-05（sync 推进 attemptRevision 的基线差异）此前在十票里**从未以编号出现**，实质内容登记在 [03](I0_UI_03_CONFIRM_SNAPSHOT.md) 的「待授权维护者汇总」。本票在此以编号补记归属，不修改 TECH_DESIGN。

## 层次区分（AC9）

| 层次 | 本票结论 |
| --- | --- |
| 准备实现 | 通过（typecheck/test/build） |
| 准备浏览器 | 通过（真实 Chrome 手动 + Playwright 102 例） |
| 真实服务联调 | **未执行**（H-01～H-06 全开） |
| 真实节点/执行 | **未执行**（不启动 GCC、不连 runner） |
| 全产品验收 | **未执行**，不由本票声明 |
| 教学效果 | **未执行**，不由本票声明 |

不提前关闭父 Issue、不宣告 G0～G4 完成；基线进度与 §4.3 差异**待授权维护者汇总**。

## 十张票状态与差异登记（AC7）

| 票 | 状态行 | 代码/验证/未完成 | 本票动作 |
| --- | --- | --- | --- |
| 01 | delivered | 齐 | 无 |
| 02 | implemented | 齐 | 顶部 `Document status` 原为「document-revised，未实施」，与自身状态行矛盾，已改为 `implemented`；10 个 AC 复选框原全未勾，现按「本票验证事实 + 07 全量 e2e」勾 8 项，留 2 项未勾并在票内指名缺口（折叠状态保留未浏览器验证、布局/缓存重置未验证） |
| 03 | implemented | 齐 | 12 个 AC 复选框原全未勾，现按同一口径勾 11 项，留 1 项未勾并指名缺口（「没有首次代际时禁写且说明 H-03」依赖真实服务路径，准备 fixture 无法行使） |
| 04 | implemented | 齐 | 仅修失效锚点；其「截图见 04 交付说明」的指向在文内无对应产物，登记为证据缺口（不伪造） |
| 04A | implemented | 齐 | `Document status` 记号统一为 `implemented` |
| 05 | implemented | 齐 | 仅修失效路径；文内设计仓 `npm test` 一处记 106 例、一处记 104 例，两数不一致，登记待核（不擅自择一） |
| 06 | preparation-delivered | 齐 | 无 |
| 06A | preparation-delivered | 齐 | 无 |
| 06B | preparation-delivered | 齐 | 无 |
| 07 | preparation-delivered | 本文 | 收口 |

未把依赖安装或 UI 交付写成规划已自动授权：P-02/P-03/P-04 的落实均指向具体批准记录，本票不新增授权。

## 未完成项与交接

- 真实服务 H-01～H-06 全部未交接；本票证据不替代任何真实联调。
- IDEMPOTENCY_CONFLICT 缺浏览器回放（仅 Vitest）；多次独立冷启动重复采样未做。
- 04 的截图证据指针、05 的 104/106 计数不一致，待相应负责人核对。
- `npm audit` 6 个漏洞待 P-03 授权后处理。

## 交接与状态

起止 Git 差异仅含上表写集，未触碰他人在途工作（开工时工作区除未跟踪 `.zcodeignore` 外干净）。本次临时材料（`/tmp/i0-07-clean`、`test-results/`、手动回放起的两个 dev server）在收口时清理；持久证据为本文与两张新 spec。提交/推送/删除按对应授权执行，本票不自行推送。
