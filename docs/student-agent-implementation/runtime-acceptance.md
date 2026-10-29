# WP01 产品运行候选与接入交接

本页对应 [#143](https://github.com/paher-din/XunJie/issues/143)及[母规范](specs/wp01-product-runtime-and-data.md)，记录产品实现、可重复验证入口与仍需实际运行的项目。2026-10-29 负责人明确：本日已通过现有 `win` SSH 入口完成记录的 Windows 11 原生包验收，Chrome/Edge 基础页面由负责人实机确认。签名、公证现在不做，移出本轮执行范围。未签名是包的实际状态，不阻塞本轮开发。负责人随后明确：浏览器验收仅要求桌面 Chrome；本轮取消完整干净 OS 虚拟机验收，采用实际分发包、隔离 PATH 与原生依赖审计。下表已完成的 Edge 人工检查保留为历史结果。

## 产品入口与事实边界

[apps/local-runtime](../../apps/local-runtime/README.md)提供 `prepare / install / launch / start / status / stop / uninstall / delete / connect / authorize / revoke`，通过 `@xunjie/product-runtime` 消费同一套实现。产品包内含 Node 24.21.0、完整 PostgreSQL 18.6 工具、生产 CLI/daemon 及来自 `apps/web` 的独立运行状态网页；网页没有课程、成员或 Agent 演示数据，不加载旧业务 store、SQLite、IndexedDB 或 outbox。网页关闭不会停止服务。

环境、安装与服务身份均持久保存，新环境获得独立客户端命名空间、凭据、目录和端口。数据库与应用使用用户私有目录，PG 只监听回环。实例操作用独立进程锁协调，存活判断不依赖超时，睡眠本身不会成为清理进程锁的依据。停止 PG 前通过 SQL 核对 cluster identity 和实际 PGDATA；不删除已有数据库锁文件，不杀占用端口的外来进程。卸载保留数据，删除必须提供当前环境身份。

`remote` 组合不准备 PG；`school` 可使用已有 PG，运行管理只检查连接与版本，不获得其进程启停权。学校对外监听需维护者提供 TLS 与公共入口，浏览器用户无需设置数据库和端口。六个逻辑部署单元的 wire 类型已经定义；当前运行宿主只声明真实存在的 `client / runtime.status`，其他业务 owner 随各自工作包接入。

## 供 #144、#145 消费的公开边界

| 边界 | 当前公开能力 |
| --- | --- |
| `@xunjie/contracts/product-runtime` | 环境、服务、六种逻辑部署单元、连接目标/能力/凭据引用、readiness 和维护参与者描述；不依赖 Node 或 implementation |
| `@xunjie/product-runtime` | `openProductRuntime({root, resources})` 的依赖准备、安装、运行、状态、环境隔离和数据库配置；`install/start` 在写入前执行同一准备检查，待人工安装以 `ProductInstallationRequiredError.result` 返回；`database()` 返回连接参数与 `credentialRef`，`resolveCredential(root, ref)` 仅在可信宿主中解析秘密 |
| `createProductRuntimeHost({root, participants})` | 本机和学校宿主复用同一生命周期；所属服务注入真实维护参与者。包不反向导入 app、开发工具或验收宿主 |
| `@xunjie/product-runtime/connections` | 持久范围授权/撤销、认证握手及已登记能力调用；连接核对目标环境、服务、协议和必要能力；主动出站连接，无回连学生私网端口的要求 |
| `@xunjie/product-runtime/maintenance` | 登记 owner 的 closeWrites、closeDispatch、drain、validate、resume；必需参与者缺失或动作失败保持封闭；记录回调交由可信宿主持久保存 |

PG 初始化条件固定为 engine **18.6**、UTF8、libc `C` collation、UTC；未额外要求扩展。资源下载来源、确切摘要、架构、许可和运行依赖见[资源清单](runtime-resources.md)。`database()` 的管理凭据用于底座装配；#144 负责按所属服务创建 schema/角色及正常业务凭据，不应让业务 owner 共用管理者权限。事务、资源发布与持久 outbox 仍由 #144 实现，完整备份升级与接管由 #145 实现。

调用方先按自身环境/服务登记授权，把 token 经私密文件传入本机，公开连接配置只保存 `credentialRef`。重连沿用原目标，不回退数据库、服务或模型。只有显式登记且实际实现的能力可授权；基础测试消费者不冒充课程、Agent 或业务接收回执。

## 可重复验证

仓库根使用指定 Node 版本：

```sh
npm ci
npm run verify
npm run test:product-runtime:native
npm run package:product -- --platform darwin-arm64
npm run package:product -- --platform win32-x64
```

原生集成测试需把 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向清单固定的完整 PG 18.6 `bin`。缺少资源明确失败；常规 `npm test` 运行真实 HTTP、维护参与及无 PG 组合的进程测试，原生 PG 文件归入单独的 external 组。类型检查和构建先生成 contracts / product-runtime，再检查消费者；测试与产品分发各自发现输入，验收宿主不进入生产依赖图。

[PG 工具探针](../../scripts/probe-product-postgres.mjs)可用 `--help` 查看版本路径参数，实际证据见 [minor / major 迁移结果](evidence/wp01-postgres-upgrade.json)。它验证工具与选定路径可执行，不提供完整产品备份、更新器或恢复接管。实际分发包的独立路径验收由[包探针](../../scripts/probe-product-package.mjs)执行，输出记录自身平台和阶段结果。

## 验收边界与后续

2026-10-29 本轮实际结果：

| 范围 | 结果与证据 |
| --- | --- |
| 工程门禁 | `npm run verify` 五阶段全部通过，包含产品运行本地行为回归；5 项原生 PG 回归单独完成。完整日志保留在 `.verification/`。 |
| Mac 已验收包 | 在仓库外中文/空格路径、隔离 PATH 中完成 13 阶段；包括双环境、重复启动、正常退出、卸载保留数据、SIGKILL 事务恢复及实际 dump/restore。[包证据](evidence/wp01-package-macos.json) |
| Mac 原生依赖 | 10 个入口、20 个 Mach-O 文件、62 条传递动态库依赖均解析到包内或 macOS 系统库；未发现 Homebrew 等外部依赖。[链接审计](evidence/wp01-macos-linkage.json) |
| Windows 已验收 r3 包 | Windows 11 Home China x64 / build 26200，非提升令牌、隔离 PATH、仓库外中文/空格路径，r3 实际 ZIP 校验后解包，19/19 阶段通过；包括 A/B 隔离、重复启停、卸载重装保留数据、端口/目录占用、启动中断、残留进程、强杀事务恢复及 dump/restore。[Windows 包证据](evidence/wp01-package-windows.json) |
| Windows 新增依赖准备 | 共享 API 和 CLI 都先验证环境，再检查 managed PG 的 VC++ 依赖；缺项时只准备微软安装器并返回人工安装入口，坏缓存给出路径和重下方法。实际非提升 Windows 检查与回归见[依赖证据](evidence/wp01-clean-windows.json)，不沿用 r3 的 19 阶段为新候选背书。 |
| 实际 ZIP | 已验收 Mac ZIP 解包后首次安装、启动和卸载保留数据往返；Windows r3 从校验后的原始 ZIP 展开执行完整包探针；[归档验证](evidence/wp01-archive-roundtrip.json)。三平台归档及摘要索引位于仓库根 `dist/`，每个归档的验证范围按其记录，未发布。 |
| PG 工具与迁移 | 17.10→17.11 同目录 minor、17.11→18.6 独立目录逻辑迁移，15 阶段通过；保留角色、约束、序列与数据的核对。[升级证据](evidence/wp01-postgres-upgrade.json) |
| 学校 Linux | Ubuntu 24.04.5 x64 / glibc 2.39，普通用户从独立包启停、重启、查询 PG；同机及 Mac 到学校的真实公网 HTTPS 身份/能力、断连重连与撤销通过。[网络证据](evidence/wp01-network-macos-linux.json) |
| Mac Chrome 页面 | 实际包网页、手动刷新、环境身份、停止后清除旧 ready、恢复后原身份就绪、关闭页面不停止服务均已核对。[截图](evidence/wp01-runtime-chrome.png)。工具安全策略禁止内部版本页，具体 Chrome 版本未读取。 |
| Windows Chrome / Edge | 负责人在两款桌面浏览器实际打开本轮状态页，确认 ready、环境身份一致及“重新检查”正常；属于人工确认，未冒充自动化桌面控制。验证后临时服务、PG 及环境目录均已停止清理。[确认范围及清理](evidence/wp01-package-windows.json) |
| Windows 电源恢复 | 实际系统事件 `42/107` 的 `EffectiveState=5`，验证到 S4 休眠恢复；原 daemon、PG postmaster、环境身份和已提交数据均保持一致。唤醒计时器仅属于外部验收工具，没有进入产品。[实际范围](evidence/wp01-windows-sleep.json) |

跨机公网 HTTPS 已通过。读取云机实际安全组后确认：原规则只允许 TCP 22/8443 和 ICMP，未放行临时 38195 端口，因此请求在 guest OS 之前超时。临时为实际客户端 IPv4 `/32` 放行 TCP 38195 后，Mac 独立包主动直连学校 Linux 独立包，真实认证、环境/服务身份、协议与必需/可选能力检查、断连报错、重连恢复及撤销后的 HTTP 401 均通过；来源环境身份和归属保持不变。SSH 仅用于部署和观察，没有产品隧道。数据库全程仅回环监听。验收后停止并移除双方测试服务、数据库、临时凭据和测试目录，撤销本次安全组规则，并读回确认原规则集合不变。该证据不表示已发布长期公共服务；今后学校部署仍需为选定的 HTTPS 入口设置对应网络策略。

Windows 实测发现并修复了三个发布阻塞：中文路径下的 PG 进程代码页、Windows 空 Unix socket 参数，以及 PG 子进程继承输出句柄造成的启动等待。r3 ZIP 为 86,075,517 bytes；A/B 首次安装约 7.85/6.02 秒、首次 start 命令约 4.38/4.48 秒，所属进程树空闲 working-set 求和约 181 MiB/环境，约 5.7 秒采样窗口内 CPU 增量为 0。共享页可能重复计数，短窗口的 0 不代表持续无 CPU 开销。该机已安装并实际加载 VC++ 14.50.35719；干净机上的 Runtime 准备没有执行，不将已有依赖冒充产品已提供。源码修复后的 `npm run verify` 五阶段及 5 项 Mac 原生 PG 回归通过，原始记录在 `.verification/2026-10-29T11-52-11-512Z-KxGjQD/`。

本轮没有把干净 OS 虚拟机、完整电源状态或浏览器故障矩阵扩成门禁。Tart VM、26.6 GB 系统镜像和 Windows QEMU/ISO 准备已取消并清理；记录见 [Mac 清理](evidence/wp01-clean-macos.json) 与 [Windows 清理及依赖准备](evidence/wp01-clean-windows.json)。S0 人工观察时，探针的等待窗口提前结束并停止服务，使负责人看到页面失联；该轮不作产品恢复通过结论，也不把脚本行为归为产品故障。原 Windows 环境已由非提升交互任务恢复，状态页暂保留供负责人检查，实际路径、任务和状态见电源证据中的 `modernStandbyAttempt.pageRecovery`。

微软安装器的许可/UAC及安装后就绪尚未执行；已完成的是固定版本的检测、官方直接下载、摘要与签名验证、旧版本/坏缓存和产品调用路径检查。具体结果以当前分发元数据与证据为准。当前跨机证据仅覆盖记录的 Mac→学校 Linux 组合及 `runtime.status`，资源样本属于隔离底座实例；均不推导业务、容量或教学效果。

依赖修复后的最终工程检查为 `.verification/2026-10-29T13-54-56-719Z-TfbDzn/summary.json`，五阶段通过；产品运行本地回归 44/44。Standards / Spec 定向复核均确认已发现问题修复，无剩余发现。新 Windows 候选 `dist/XunJie-runtime-2026-10-29-windows-x64-r5.zip` 为 86,082,153 bytes，SHA-256 `928faca45e1e02e3f71bcefcf7a2ff1dbbe56558d6922e01ca8744665e442092`，归档内 40 项程序/资源摘要均核对一致；完整原生运行的历史证据仍对应 r3。
