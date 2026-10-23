# 开发协作交付核查（#133）

日期：2026-10-24。本文记录本轮实际证据和未完成边界；工程、浏览器、真实模型/节点及教学效果分别判断。正式 main 的合并、发布与资源预算应用由负责人处理。

## 当前证据状态

| 范围 | 已核实结果 | 待完成项 |
| --- | --- | --- |
| CA 使用说明 | `eaa60ca`：Mac 用户 login keychain、Windows LocalMachine Root 的权限/系统确认、指纹读回与精确移除；跳过 HTTPS 校验不计通过 | fresh Mac 的实际系统信任确认仍在处理；不以证书存在代替正常 Chromium TLS |
| 工程与审查修复 | 负责人独立 9e7：xj-dev 181 pass/1 platform skip，teaching 542 pass/23 external skip；eb3 证书/delete/remote TLS 25/25；原基线、CA 并发、gateway 生命周期、status 与教师消费者缺陷均经定点源码复核 closed | closed 指已定位源码缺陷，不替代平台/业务/容量验收；harness delta 独立复核继续 |
| 加密备份工具 | `2393b66`、`72b3250`、`6e9e52a`：11/11，含活跃 WAL、命名多库、同名配置、凭据解密、密钥排除、损坏库拒绝与版本 1 归档恢复；新脚本已安装，Linux 跨文件系统实际恢复 71 文件/6 库通过并清理 | 最终 scope、新归档与恢复等完整新窗口及预算完成 |
| 云端隔离恢复 | 71 文件、6 库 integrity/FK 通过；5 个模型凭据、15 个 access 凭据、6 个 active SSH 映射与 3 对 TLS key/cert 核对通过；独立端口真实登录/课程读取通过 | 最终 runtime/config 稳定后的新归档及独立设备复核 |
| 实际产品隔离 | 初次 CI `40006389514`、source `c896c52`：5,290 文件摘要通过，无开发服务/OSS SDK/团队凭据路径；空 HOME、无开发/OSS/account-control 接线，严格 TLS 下页面/登录/课程均 200。当前实际候选已严格激活 `70d170a` | 最新 70d 产物的隔离业务读回纳入最终恢复；不以旧 c896 结果冒称已测新产物，不代表未发布的普通用户安装包 |
| fresh 成员 | Mac 已真实 join、三模式、按团队编号恢复并验证 `200 → 409 VERSION_CONFLICT`、新基线隔离与显式停止/删除；原 Windows 已完成严格 TLS、双角色闭环、新基线独立副本、团队编号真实 restore/verify 和自有 SSH 中断恢复 | Mac 正常系统信任仍待确认；Windows 新独立 member 已用 eb3 join，云任务写入与 active revoke 补验进行中 |
| 采集默认源码 | 静态 canary 已由 `2e23535` 改为运行时生成，guard 未改；负责人独立 0ea 默认 `collectCode` 840 文件/约 6.27MB 通过，根范围未缩小；Windows 原 context 默认 baseline publish 通过 | 最终交付 SHA 及新的平台补验回执继续对应记录 |
| Windows 签名 | `496493a`：worker Mac 21/21、Windows 默认 PATH 7/7；lead 独立 client/signer 18/18；实际旧 client 失败后 fixed CLI 原 key join 成功，无 PATH 修改；fresh Windows 原邀请/home/key join 亦通过 | 不修改 Linux access 服务；完整成员流程单独记录 |
| 容量与资源 | c896 完整 905 秒的 3503/3503 请求匹配服务端指标、零 non2xx/5xx；普通 API p95 1090.234ms，延迟失败保留。70d 的两项读取优化有隔离短预检与工程回归 | 新 70d 完整窗口尚无 T0；短预检不算正式通过，资源预算尚未应用 |
| 真实模型 | c896 窗口中两项 Mimo 产品 turn 认证失败；另获授权切换后，两项 DeepSeek 产品 turn 均 settled/exactOK、calls1，actual usage 分别 82/16 与 82/33；原正式 store 未改 | 下一窗口使用已准备的 revision 2，再记录实际产品调用与 OSS；transport 成功和 controlled transport 不替代产品 E2E |
| 真实执行节点 | 候选未登记 execution node，运行/检查正确拒绝未就绪能力；原 robert QEMU/WSL 保持 stopped | 本轮未做真实执行节点互操作 |
| 教学效果 | 未测 | 不由工程或模型可调用性推导 |

## 备份与恢复实测

新增配置保留原正式课程库、原个人模型及签名/TLS/执行连接恢复材料，额外登记 candidate 课程库、原候选/新候选个人模型 store 与 key、account-control registry/config、access SQLite/credential.key、服务与系统配置、TLS/公开 CA、受管 SSH 公钥映射与固定 helper 回执。完整字段契约见[备份说明](../../tools/i0-cloud/README.md#加密备份与隔离恢复)。

云端归档 `closeout133-20261023T185305Z-204247a0.xunjiebak` 为 558,241 bytes，SHA256 `907024a2cbe131db2b47d9ca7b5253289aee2d9a04b52c2371bd5e34e512a154`。它包含 71 个文件、6 个经 Backup API 复制并校验的 SQLite 库；加密 key 本身不在归档中。独立恢复使用新的目录、业务端口 18444 和 account socket，模型网络调用关闭、执行节点为空；实际 `/health/ready`、登录、session、课程读取均 200，所属进程已停止。

3 个模型存储的凭据解密计数为原正式 3、原候选 0、新候选 2。access 对应 key 能解密 15 个成员凭据，核对 6 个 active account-control 身份及 5 个 deny 状态；这些是该次采集的观察数，不是永久成员清单。6 个 active SSH 映射与 helper 回执核对，TLS 私钥/证书匹配且 access CA 验签通过。每个库独立一致，配置/公钥映射分别采集；这些关系在该次恢复中通过，不等于跨存储原子快照。

负责人 Mac 已独立验证同一归档：71 个文件 SHA 全匹配，6 库 integrity/FK、4 个凭据 key 长度和 3 对 TLS key/cert 通过，明文已清理。加密归档与独立受限 key 副本保留在 backup-recovery；证据为 `main-mac-independent-verification.json`、`main-mac-independent-restore.json`。

这份归档采集于切换前，业务 source 为 `fb5830e`；新 capacity 模型是当时的准备材料，不据目录存在宣称已激活。之后新建的 `133-runtime.conf` 与最终容量 budget dropin 尚未在此归档中。最终 scope 必须从运行中 unit 的 effective ExecStart/DropInPaths、实际配置、source 与 limits 读回，连同 dropin 原路径映射再采集新归档；不得用旧归档声称恢复了新 runtime/预算。

live backup 配置现已登记 `133-runtime.conf`，并将实际存在的 `/var/lib/xunjie/capacity-133/application-70d170a.json` 独立映射为 `candidate/capacity/application-70d170a.json`；旧 `application.json` 保留为 c896 回退材料，未创建的 1aa 配置未登记。新配置为 0600/xunjie，摘要 `5720f0e3cceca68386f1c0075f6ab09bed2616ba69167b3facd5ef63dd0dc4b0`，当前模型目录/key 仍为 capacity 独立 store，T/S1 已是 DeepSeek revision 2。此处只更新覆盖范围，尚未生成包含它们的新归档。测量窗口内不手工 snapshot；最终 budget dropin 由负责人应用后再登记、采集并隔离恢复。

成员私钥仅在成员设备。access CA signing key 留在 owner 本机受限目录，不在服务器归档；服务器归档包含现行公开 CA、TLS leaf 私钥和证书。保留 owner 独立受限副本或重新签发/邀请的恢复策略，不能声称从服务器备份恢复了成员私钥或 owner CA signing key。

脱敏证据集中在负责人本机 `~/.codex/artifacts/xj133-closeout/`：`cloud-backup-configuration.json`、`cloud-encrypted-backup.json`、`cloud-restore.json`、`cloud-restore-relations.json`、`product-isolation.json`。进度入口为 `~/.codex/artifacts/xj133-closeout-progress.json`。证据不含 key/token/password；实际归档与恢复材料走受限管理路径。

## 产品产物与运行态边界

初次产品隔离采用已严格预取验证的不可变目录 `/opt/xunjie/candidates/133-c896c52`，核对 4,787 个 runtime 和 503 个静态文件摘要。测试子进程仅获得 PATH、空的独立 HOME、NODE_ENV；不读取成员 connection/邀请、OSS 配置或 access account-control socket。测试操作者从隔离备份取得既有身份用于实际登录，产品子进程只使用普通应用配置与隔离业务库，未调用接入服务取得登录权限。

当前实际候选为 `/opt/xunjie/candidates/133-70d170a`，source `70d170ab6a7665a973d514b28eedb5a0532d17ee`；负责人已核对 CI binding、摘要、native SQLite、静态及健康接口。计划切换后 candidate/access/formal PID 分别为 131947/131948/91972，restart 读回均为 0。与原 capacity 配置相比，新配置只更改 staticDirectory，复用同 DB/TLS/Origin/model store。后续 eb3 CLI 与 0ea harness 的产品运行文件相对 70d 零差异；harness 也不进入 runtime 装配清单。下一正式窗口固定这份产物与原历史数据。

正式 d07 旧产物实例与兼容部署器继续保留；首个 bound main Release 尚未由负责人发布，不能提前用 strict candidate 部署器覆盖正式部署器。现行 access source `3825f98d20ae470e8ee3febaa7cc0bbb51c38382` 与私有 OSS 目录作为团队入口保留，不能为了清场删除唯一可用服务或已发布包/基线。资源预算待真实容量数据后由负责人决定，不以历史 MemoryPeak 或空闲采样代替。

## 容量证据与预算边界

完整来源、业务基数/增量审计、模型与 OSS、失败和隔离诊断见[容量 worker 报告](../../tools/i0-cloud/capacity-133-report.md)。`adc8ab2` harness 独立 8/8，负责人同样 8/8；18 个 JS 与 1 个 Python 语法通过，20 个新增文件通过原秘密扫描。下一 run `6e9a5416` 已准备，尚无 T0、`windowApproved=false`，等待 Windows 补验后由负责人安排。

下表只引用旧 c896 完整窗口，不能替代新 70d 验收：

| 测量 | 旧完整窗口结果 | 解释 |
| --- | --- | --- |
| 普通 API 延迟 | 3484 项，p95 1090.234ms | 超过 500ms 目标；3503 项总请求含模型，并全部匹配服务端 requestId |
| candidate CPU | 平均 116.34%、最高 5 秒段 154.24%（单核百分比） | 同步读取/重复验证及 GC 热点另有隔离 CPU profile |
| candidate 内存 | 采样 `memory.current` 最大 143.88MiB；lifetime peak 326.88MiB | lifetime 值包含窗口前历史，不当作本次峰值 |
| access/host 内存 | access current 最大 40.68MiB；host available 最低 892.25MiB | 旧窗口 host available 高于 512MiB；新窗口仍须重新采样 |
| 进程与 OOM | PID/restart 无变化；OOM/max/high 增量 0 | 计划的产物切换在窗口外单独记录 |

保留原 1103 receipt 一致副本的两次 40 秒诊断都为 212/212 服务端记录、零 non2xx/5xx。a8 单项补丁普通 API p95 460.129ms、workbench 中位数 499.312ms/五并发尖峰 1182.841ms；加 2b hydration 后分别为 332.875ms、169.010ms/782.469ms。它们支持严格构建/激活后的完整复测，尖峰与来源继续保留。当前业务 512MiB/access 256MiB 沿用原参数；access 128MiB 仅为未应用、未压限验收的候选，最终预算及 dropin 仍由负责人依据新完整窗口决定。

原 Windows 已撤销成员通过原 key refresh 实际得到 `DEVICE_REVOKED`；当时六个环境已 down/delete，因此没有测活隧道/Session 失效。新的 Windows 补验使用独立 home、member 和自有云任务；须在进程/Session 保持存活并明确 ready 后再由负责人撤销，尚不预报结果。`CLOUD-UI-01`（个人资料静态身份/本地来源文案与云首页不一致）作为 fresh 报告的未修观察保留，没有据此证明服务端泄漏。

## 旧入口核对与清理边界

活跃代码/文档扫描排除 `docs/archive/`、`node_modules/`、`dist/`。原 PowerShell 成员连接、旧本机宿主、源码构建 `sync-main.py` 与单元已退役；云端只读确认旧脚本不存在、`xunjie-main-sync.timer` 为 not-found。当前 `xunjie-release-deploy.timer`、备份 timers 与业务/接入服务保留。

`tools/i0-cloud` 的业务宿主、正式旧协议发布器、备份和节点准备仍有实际用途，保留；`connection.mjs` 对既有批准 owner 配置的只读适配继续用于维护兼容，不恢复手工成员接入流程。仓库外连接 README 已改为当前 invite/join/use 入口，只改 XunJie 说明；owner SSH、accounts.private.txt、backup-recovery 及其他项目未改。用户原 root.zcode、无关分支和已 stopped 的 robert QEMU/WSL 不在清理范围。

本轮已清理自己创建的隔离进程和明文恢复目录。之后以全新 file-only 临时成员经同一持久服务完成公开 CLI invite/join，再真实 fetch 原已发布编号；`cacheHit:false`、6,273,409 bytes、完整摘要与原包一致，未手传 ZIP。该 smoke 不创建 SSH/应用账号或受管后台进程，不执行 restore/verify；结束只撤销自己新建的成员并删除专属私有 home/下载缓存。证据为 `post-cleanup-smoke.json`，共享包和基线保留。

真实 daily timer 已在 2026-10-24 03:00:26–03:00:27 使用当时扩展的备份配置完成，`Result=success`、`ExecMainStatus=0`；它早于 70d 配置登记，不声称已包含后来的材料。周备 timer 保持 active，未额外制造第二次周备。新完整容量窗口、fresh 补验、最终稳定配置归档/独立恢复与最新产物隔离读回仍需补齐，本文不预报通过。
