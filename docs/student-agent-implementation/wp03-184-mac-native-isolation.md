# #184 Apple Silicon 原生会话隔离与产品包验收

日期：2026-11-03。本文是 [#184](https://github.com/paher-din/XunJie/issues/184)（母票 [#173](https://github.com/paher-din/XunJie/issues/173)）的 Apple Silicon 验收记录。设计边界见 [specs/wp03-native-sessions.md](specs/wp03-native-sessions.md)，Windows 对照实现见 [wp03-native-sessions.md](wp03-native-sessions.md)。

## 依据与授权

- [实施票 #184](https://github.com/paher-din/XunJie/issues/184)、[#173 本机有状态实验会话](wp03-native-sessions.md)、[WP03 公开执行规范](specs/wp03-course-components-and-execution.md) §10 与 Testing Decisions。
- 实施基线：`wp03` 的 `b288410`（Windows 候选收口）。本票提交 `c4789c4`（隔离实现）与本文所在提交（探针、资源校验修正、证据）。
- 写集：`packages/learning-space/src/learning-data/native-sandbox.ts`（新增）、`native-process.ts`、`native-sessions.ts`、`learning-entry/index.ts`、`apps/local-runtime/src/cli.ts`、`scripts/probe-native-macos-isolation.mjs`、`scripts/probe-native-macos-product.mjs`、`package.json`、证据与本文。
- 本票不交付：签名与公证、干净机器验收、Windows 真机复验、教学效果、排队、保留策略、远端与跨所有者（#175）。

## 平台与环境（记录项）

| 项 | 实测值 |
| --- | --- |
| 机型 / 架构 | `Mac17,3`（Apple Silicon）/ `arm64` |
| macOS | 27.2（`26B123`），内核 `27.2.0` |
| 沙盒启动器 | `/usr/bin/sandbox-exec`，SHA-256 `10cf4a46a575e4747d2419cf343800db0d11ae6e6e9b8415998d3d8f336b2a92` |
| 会话运行时 | 候选内置 Node `v24.21.0`（`resources/node/bin/node`） |
| 数据库 | 候选内置 PostgreSQL `18.6` |
| 桌面浏览器 | Google Chrome `156.0.8078.80`（headed） |
| 候选 | `dist/product-darwin-arm64-wp03-r3`，`createdAt 2026-11-03T14:09:57.620Z` |
| `distribution.json` SHA-256 | `ed619ba6003a62b807ef0ff818c70f95ac642c95f9f81189a6deb81671139fd5` |
| `resources.json` SHA-256 | `54e3bfca6394b6d600a77eff946427123f2bbbf095a9563e6c731bd5b0159469` |
| 签名 | `unsigned-candidate`；`codesign -dv` 对 `xunjie` 返回 `code object is not signed at all` |

签名与公证沿用既定决策 `deferred-by-user`，Gatekeeper 未验证。候选自带 `distribution.json` 的 `verification` 是**打包期检查的声明**，不是候选的验收结论：`archiveChecksums: passed`、`productionDependencyGraph: passed`、`workspacePathsInBundles: absent` 由打包器在构建时自行执行；`nativeProcessProbes`、`backupUpgradeProbes`、`gatekeeper` 需要真实运行，打包器一律记 `not-run`；`cleanMachineAcceptance: cancelled-by-owner` 与 `productSigning`/`notarization: deferred-by-user` 是负责人声明。本票的原生探针与产品包结果因此记录在本文件与 `evidence/` 中，不回写候选包：候选已按内容摘要封存，回写会与 `entryHashes` 不一致，也会把「构建时检查了什么」与「这个包被验收过」混为一谈。

## 隔离选型与实现

**选定候选：系统 `sandbox-exec` + 运行时生成的 Seatbelt profile（`xunjie-native-session-v1`）。** 它不需要签名 `.app` bundle、不需要 container、不需要随包原生 helper，与当前分发形态（未签名目录启动器）一致。

**App Sandbox 对照被排除。** 对带 `com.apple.security.app-sandbox` 的 entitlement 做 ad-hoc 签名后运行，进程以 `SIGTRAP` 退出、无 stderr。App Sandbox 要求签名 `.app` bundle 与 container；本轮候选是无签名目录启动器，故不作为可分发候选。原始结论见证据文件 `sources.appSandbox`。

profile 的形状（`packages/learning-space/src/learning-data/native-sandbox.ts`）：

- `(deny default)` 起步；`(allow process-exec (literal <固定 node>))`、`(allow process-fork)`、`(allow sysctl-read)`、`(allow mach-lookup)`。
- 读：先 `(allow file-read*)`，再 `(deny file-read* (subpath /Users) (subpath /Volumes) (subpath /private/tmp) (subpath /private/var) (subpath <会话根>))`，最后按需 `(allow file-read* (subpath <运行库>) (subpath <会话目录>))`。Seatbelt 以最后匹配为准。
- 写：仅 `(subpath <会话目录>)` 与 `(literal "/dev/null")`。
- 网络：`(deny network*)`。信号：`(allow signal (target same-sandbox))`。
- 会话以 `detached: true` 启动，独占进程组；第 4 个 fd 作为「死亡管道」，监督器退出即 EOF。

**为什么是「宽读 + 显式 deny + 具体放行」而不是读白名单。** 在 macOS 27.2 上，严格读白名单下所有 Node 启动都以 `rc=134` 结束且 stdout/stderr 全空；crash report 显示 dyld4 在 `boot_boot`/`ignition_halt` 阶段 abort，`(debug deny)` 与 `log show` 都拿不到拒绝项。逐项 `deny file-read*` 均可正常启动，因此改为「宽读 + 显式 deny 受保护根 + 具体放行」。代价是 `/etc`、`/Library`、`/System`、`/usr`、`/opt` 等系统路径仍可读；受保护根（`/Users`、`/Volumes`、`/private/tmp`、`/private/var`）与会话目录之外的用户数据不可读。这是本票明确的已知边界，不是「整个文件系统不可读」。

**监督器死亡与回收。** 会话内注入看门狗：`process.stdin.once('end')` 与 fd 3 的 `end`/`error` 触发自杀，另有 `process.ppid` 每 250ms 轮询兜底；任一触发即 `process.kill(-process.pid, 'SIGKILL')`。退出后先落 `confirmed: false`，再对进程组 `SIGKILL` 并轮询 `kill(-pid, 0)` 至 `ESRCH`（上限 `groupReapMs = 3000`），确认组为空才写终态。

**预算。** V8 堆上限用 `--max-old-space-size=<memoryMiB>`；工作集用 `ps -axo pgid=,rss=` 每 400ms 采样的 RSS 看门狗；输出字节、空闲时限、最长持续时间由监督器计时。macOS 上 `ulimit -v` / `ulimit -d` 均返回 `setrlimit failed: invalid argument`，因此不使用 rlimit 做内存上限。

**顺带修复的分支缺陷。** `apps/local-runtime/src/cli.ts` 曾把 Windows 专用 `windowsSessionHelper` 当作必填资源，导致任何 darwin/linux 候选都无法 `install`（`resources 缺少有效的 windowsSessionHelper`）。该缺陷同时是分支上 `packages/product-runtime/test/prerequisites-cli.test.mjs` 既有失败的成因。现按平台可选处理：缺失合法、空值仍报错。

## 验收 1：安装与独立自检（无开发工具链）

```sh
node scripts/package-product.mjs --platform darwin-arm64 --out dist/product-darwin-arm64-wp03-r3
dist/product-darwin-arm64-wp03-r3/resources/node/bin/node \
  dist/product-darwin-arm64-wp03-r3/app/cli.js install \
  --root <临时根目录> --json
```

探针在 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`、只保留 `HOME`/`LANG`/`TMPDIR` 的环境里执行包内 CLI，不继承开发工具链、`NODE_OPTIONS` 或仓库路径：

- `install` → `{"state":"installed"}`，生成 `environmentId`、`installationId`、`clientNamespace` 与 client 服务 endpoint（本次 `http://127.0.0.1:61858`）。
- `status` → `stopped`；`start` → endpoint 就绪；再次 `status` → `ready`。
- 包内 Node 自报 `v24.21.0`；`PATH` 实测为 `["/usr/bin","/bin","/usr/sbin","/sbin"]`，会话不使用系统 Node（`nodeUsedForSessions` 指向候选内路径）。

## 验收 2：文件与网络的受控边界（正向对照 + 真实系统错误）

在同一台机器、同一批路径上先跑**不启用沙盒**的基线（`macosSandbox: false`，仅进程组），再跑 seatbelt 会话。基线全部允许，说明被测路径、接收端和外来进程都是可用的，空结果不会冒充隔离成功。

基线：目录内读写成功、HOME 读、候选目录读、越界读、HOME 写、越界写、loopback 连接、外部连接、`/bin/cp` 执行、对外来进程发信号**全部成功**；loopback 接收端接受 1 次连接。

seatbelt 会话：允许目录内读写成功，其余全部被系统拒绝，原始错误如下（`EPERM` 来自内核，不是探针自造的返回值）：

| 动作 | 结果 |
| --- | --- |
| 会话目录内写 / 读 | 成功（读回 6 字节） |
| 读 `~/.xj-isolation-*.txt` | `EPERM: operation not permitted, open '/Users/robertwu/.xj-isolation-fac5f82f-…txt'` |
| 读候选 `dist/product-darwin-arm64-wp03-r3/resources.json` | `EPERM: operation not permitted, open '/Users/robertwu/Documents/Projects/…/dist/product-darwin-arm64-wp03-r3/resources.json'` |
| 读越界目录 `secret.txt` | `EPERM: operation not permitted, open '/var/folders/…/xj-outside-iHczBw/secret.txt'` |
| 写 `~/.xj-isolation-*.txt` | `EPERM: operation not permitted, open '/Users/robertwu/.xj-isolation-…txt'` |
| 写越界目录 `written.txt` | `EPERM: operation not permitted, open '/var/folders/…/xj-outside-iHczBw/written.txt'` |
| loopback 出站 `127.0.0.1:61839` | `connect EPERM 127.0.0.1:61839 - Local (0.0.0.0:0)` |
| 非 loopback 出站 `1.1.1.1:443` | `connect EPERM 1.1.1.1:443 - Local (0.0.0.0:0)` |
| 执行 `/bin/cp` | `spawnSync /bin/cp EPERM` |
| 对外来进程发信号 | `kill EPERM` |

同一接收端在接受计数上从基线的 1 降为受约束会话的 **0**：出站不是「连上但没人处理」，而是根本没建立。

## 验收 3：回收、外来进程与运行时预算

| 场景 | 实测 |
| --- | --- |
| 直接子进程先退 | 会话确认退出（`confirmed: true`），后代已回收（`descendantGone: true`） |
| 监督器异常退出（对监督器 `SIGKILL`） | 52ms 内受管会话进程与后代全部退出（`sessionGone/descendantGone: true`） |
| 停止竞争（会话忽略停止事件，800ms 后强杀） | 809ms 确认，组内后代退出 |
| 外来进程 | 全程存活，未被误杀；沙盒内对它发信号本身就是 `EPERM` |
| 内存预算 | 真实退出，`expired: "memory"` |
| 输出预算 | 真实退出，`expired: "output"` |
| 空闲预算 | 真实退出，`expired: "idle"` |
| 最长持续时间 | 真实退出，`expired: "max"` |

内存与进程约束的边界：V8 堆上限由 `--max-old-space-size` 强制，工作集由 400ms 采样的 RSS 看门狗约束，**不是内核级硬上限**；两次采样之间的瞬时超额不会立刻终止会话。macOS 不提供可用的地址空间 rlimit（`ulimit -v`/`-d` 报 `invalid argument`），`ulimit -u`（本机 2666）与 `-n` 未用于会话约束。

## 验收 4：产品包 + 真实 PostgreSQL + 真实执行器 + 桌面 Chrome

```sh
node scripts/probe-native-macos-product.mjs --package dist/product-darwin-arm64-wp03-r3
```

探针用候选自己的 CLI 安装并启动（真实 PostgreSQL 18.6、真实 daemon），导入真实组件清单、建课、建成员、登录、授权、建活动，然后用**桌面 Chrome（headed，`channel: 'chrome'`）**走学生路径，其余故障注入走同一持久 owner 的公开 HTTP 语义。12 项检查全部 `true`：

| 检查 | 实测事实 |
| --- | --- |
| `install` | `installed` → `ready`，endpoint 就绪 |
| `sequence` | 启动后 `0`；输入 1 → `1`、2 → `3`、2 → `1`；历史 3 条 |
| `reopen` | 切换「作品」→ 回组件、整页 reload 后仍读同一执行引用：状态 `1`，历史 3 条 |
| `isolation` | 会话进程独占进程组（`pgid == pid`）；cwd 为 `session-*` 目录；该目录有 `session.sb`（1002 字节，SHA-256 `1ab7c091a5a1…`，含 `(deny default)`/`(deny network*)`/本会话写放行）；进程**无任何网络 socket** |
| `outOfOrder` | `expectedSeq = applied+5` → `409 identity-conflict`，`appliedSeq` 保持 3 |
| `lostReply` | 控制请求送达服务端后客户端丢弃回包（收到 1708 字节即断开）；`appliedSeq` 3 → 4，用同一 `controlId` 重放返回 200 且仍为 4，观察 `applied: 4` |
| `stop` | 桌面 Chrome 点「停止会话」→ 标题 `四态累加模拟 · 已取消`，输入框禁用，剩余会话进程 0 |
| `crash` / `crashStopsInput` | 从 Chrome 新开会话后 `SIGKILL` 会话进程 → `failed` + `statusKnowledge: confirmed`，原因「本机会话进程意外结束…」；随后 control 返回 400 |
| `concurrency` | 声明并发 2：第 2、3 个接受 200，第 4 个 400（`invalid`） |
| `cleanup` | 收尾后会话进程 0 |
| `noPageErrors` | 页面无 JS 异常 |

截图（浅色 / 深色 / 900×900 窄桌面）：`evidence/wp03-184-product-light.png`、`-dark.png`、`-narrow.png`。页面显示「当前状态 1；累计输入 5；已确认 3 次」与三条历史（第 3 次状态 1、第 2 次状态 3、第 1 次状态 1）。

## 验收 5：运行命令、原始结果与限制

### 工程

全部在 Node `v24.21.0` 下执行：

- `node scripts/build.mjs typecheck`：通过（contracts、storage、learning-space、server、product-runtime、local-runtime、web:src、web:node）。
- `node --test apps/server/tests/native-session.test.mjs apps/server/tests/native-isolation.test.mjs`：5/5。含 seatbelt profile 单元断言、真实 macOS 会话被约束并确认空组、`macosSandbox: false` 的进程组基线、适配器跨输入保持状态且同一 `controlId` 不重复推进、空闲时限由真实退出生效。
- `node scripts/verify.mjs --group server --jobs 2`：80/80（161.6s）。
- `node scripts/verify.mjs --group unit --jobs 3`：25/25（28.8s）。
- `node scripts/verify.mjs --group tools --jobs 2`：45/45（102.5s）。首次运行因冷 `npm ci` 超过 10s 超时失败，复跑通过；该用例与本次改动无关。
- `packages/product-runtime/test/prerequisites-cli.test.mjs`：3/3。修复前在分支上失败，成因即上文「顺带修复的分支缺陷」。
- 未跑：Web 端 e2e 套件（组件宿主、IME、学校生命周期等，与本票无交集）、Windows 侧复验（本机无 Windows 环境）。

### 原生执行（隔离探针）

```sh
node scripts/probe-native-macos-isolation.mjs --package dist/product-darwin-arm64-wp03-r3
```

结果 `{"status":"passed","failed":[]}`；`isolation` 声明为 `kind: seatbelt`、`launcher: /usr/bin/sandbox-exec`、`profileVersion: xunjie-native-session-v1`、`profileDigest: 2355c8fb…`、`network: denied`、`writes: session-directory`、`exec: fixed-node-only`、`signals: same-sandbox-only`、`memory: heap-cap-and-rss-watchdog`、`processes: supervisor-group-confirmed`、`supervisorDeath: session-watchdog`。原始报告：[evidence/wp03-184-isolation.json](evidence/wp03-184-isolation.json)。

### Chrome 与产品包

原始报告：[evidence/wp03-184-product.json](evidence/wp03-184-product.json)；同批截图见上。运行目录 `.verification/wp03-184-isolation/`、`.verification/wp03-184-product/` 为本地临时产物，不入库。

### 未执行与已知限制

1. **签名、公证、Gatekeeper**：未做，候选 `unsigned-candidate`，`xunjie` 启动器未签名。分发前必须补。
2. **干净机器验收**：未做。本次是同一台开发机，只用受限 `PATH`/环境变量证明不依赖开发工具链；候选清单自记 `cleanMachineAcceptance: cancelled-by-owner`。
3. **读模型是宽读**：`/etc`、`/Library`、`/System`、`/usr`、`/opt` 等系统路径可读；只保证 `/Users`、`/Volumes`、`/private/tmp`、`/private/var`、会话根之外的用户数据不可读写，以及无网络、无法执行非固定二进制、无法向沙盒外发信号。
4. **内存不是内核级硬限制**：V8 堆上限 + 400ms RSS 看门狗，采样间隙内的瞬时超限不会立即终止。Darwin 不提供可设的地址空间上限：`ulimit -v` 返回 `Invalid argument`，`setrlimit(RLIMIT_AS)` 抛 `ValueError: current limit exceeds maximum limit`；进程侧相反是内核行为（`RLIMIT_NPROC` 为 `(2666, 4000)`，可降）。
5. **Windows 真机复验**：本机无 Windows 环境，Windows 侧证据沿用 #173 记录，未在本票重跑。
6. **排队**：适配器声明 `queuedSessions: 0`，达到并发上限直接拒绝。
7. **保留与清理**：会话/操作行无时间或容量清理策略。
8. **检查点与跨所有者**：重启后只保留已确认观察并标为终态/待核实，不恢复进程内状态（#174）；远端与跨所有者未做（#175）。
9. **教学效果**：未评估，不产生结论。
10. **自动浏览器测试**：由 Playwright 驱动独立 Chrome 窗口，不是人手操作；进程、PostgreSQL、组件资源与页面流量均为真实。
