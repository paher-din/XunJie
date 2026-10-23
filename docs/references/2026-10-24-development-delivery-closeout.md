# 开发协作交付核查（#133）

日期：2026-10-24。本文记录本轮实际证据和未完成边界；工程、浏览器、真实模型/节点及教学效果分别判断。正式 main 的合并、发布与资源预算应用由负责人处理。

## 当前证据状态

| 范围 | 已核实结果 | 待完成项 |
| --- | --- | --- |
| CA 使用说明 | `eaa60ca`：Mac 用户 login keychain、Windows LocalMachine Root 的权限/系统确认、指纹读回与精确移除；跳过 HTTPS 校验不计通过 | fresh Mac 的实际系统信任确认仍在处理；不以证书存在代替正常 Chromium TLS |
| 工程观测 | `c0225bc`：已有日志 sink 启用时，仅记录服务端 requestId/method/注册 route 模板/status/durationMs；metrics/errors 9/9 | 五人持续负载与延迟结论由容量报告提供 |
| 加密备份工具 | `2393b66`：10/10，含活跃 WAL、命名多库、同名配置、凭据解密、密钥排除、错误输入与版本 1 归档恢复 | 本轮新归档的负责人 Mac 独立恢复 |
| 云端隔离恢复 | 71 文件、6 库 integrity/FK 通过；5 个模型凭据、15 个 access 凭据、6 个 active SSH 映射与 3 对 TLS key/cert 核对通过；独立端口真实登录/课程读取通过 | 最终 runtime/config 稳定后的新归档及独立设备复核 |
| 实际产品隔离 | CI `40006389514`、source `c896c520a64a40b6860dce279692be5f0481115c`：5,290 文件摘要通过，无开发服务/OSS SDK/团队凭据路径；空 HOME、无开发/OSS/account-control 接线，严格 TLS 下页面/登录/课程均 200 | 这验证 Linux CI runtime；不代表另一个未发布的普通用户安装包 |
| fresh 成员 | Mac 已真实 join、三模式、按团队编号恢复并验证 `200 → 409 VERSION_CONFLICT`、新基线隔离与显式停止/删除；Windows 严格 TLS 本地页面与双角色登录通过 | Windows 默认 OpenSSH 签名已交专属修复会话；完整跨机最终结果待修复后验收 |
| 采集默认源码 | 新 metrics 测试中的静态秘密字段 canary 被现有 guard 拒绝，Mac 直接扫描与 Windows baseline publish 均复现 | 交 metrics 作者修测试 fixture，保留原秘密拒绝规则；不能以缩小 roots 计默认路径通过 |
| 真实模型/执行 | 新候选模型 store/key 已独立准备，原个人配置保持 | 两次真实模型调用、五人 ≥900 秒与传输/故障边界由容量验收记录；本票未启动原 robert QEMU/WSL 节点 |
| 教学效果 | 未测 | 不由工程或模型可调用性推导 |

## 备份与恢复实测

新增配置保留原正式课程库、原个人模型及签名/TLS/执行连接恢复材料，额外登记 candidate 课程库、原候选/新候选个人模型 store 与 key、account-control registry/config、access SQLite/credential.key、服务与系统配置、TLS/公开 CA、受管 SSH 公钥映射与固定 helper 回执。完整字段契约见[备份说明](../../tools/i0-cloud/README.md#加密备份与隔离恢复)。

云端归档 `closeout133-20261023T185305Z-204247a0.xunjiebak` 为 558,241 bytes，SHA256 `907024a2cbe131db2b47d9ca7b5253289aee2d9a04b52c2371bd5e34e512a154`。它包含 71 个文件、6 个经 Backup API 复制并校验的 SQLite 库；加密 key 本身不在归档中。独立恢复使用新的目录、业务端口 18444 和 account socket，模型网络调用关闭、执行节点为空；实际 `/health/ready`、登录、session、课程读取均 200，所属进程已停止。

3 个模型存储的凭据解密计数为原正式 3、原候选 0、新候选 2。access 对应 key 能解密 15 个成员凭据，核对 6 个 active account-control 身份及 5 个 deny 状态；这些是该次采集的观察数，不是永久成员清单。6 个 active SSH 映射与 helper 回执核对，TLS 私钥/证书匹配且 access CA 验签通过。每个库独立一致，配置/公钥映射分别采集；这些关系在该次恢复中通过，不等于跨存储原子快照。

成员私钥仅在成员设备。access CA signing key 留在 owner 本机受限目录，不在服务器归档；服务器归档包含现行公开 CA、TLS leaf 私钥和证书。保留 owner 独立受限副本或重新签发/邀请的恢复策略，不能声称从服务器备份恢复了成员私钥或 owner CA signing key。

脱敏证据集中在负责人本机 `~/.codex/artifacts/xj133-closeout/`：`cloud-backup-configuration.json`、`cloud-encrypted-backup.json`、`cloud-restore.json`、`cloud-restore-relations.json`、`product-isolation.json`。进度入口为 `~/.codex/artifacts/xj133-closeout-progress.json`。证据不含 key/token/password；实际归档与恢复材料走受限管理路径。

## 产品产物与运行态边界

产品隔离采用已严格预取验证的不可变目录 `/opt/xunjie/candidates/133-c896c52`，核对 4,787 个 runtime 和 503 个静态文件摘要。测试子进程仅获得 PATH、空的独立 HOME、NODE_ENV；不读取成员 connection/邀请、OSS 配置或 access account-control socket。测试操作者从隔离备份取得既有身份用于实际登录，产品子进程只使用普通应用配置与隔离业务库，未调用接入服务取得登录权限。

正式 d07 旧产物实例与兼容部署器继续保留；首个 bound main Release 尚未由负责人发布，不能提前用 strict candidate 部署器覆盖正式部署器。现行 access source `3825f98d20ae470e8ee3febaa7cc0bbb51c38382` 与私有 OSS 目录作为团队入口保留，不能为了清场删除唯一可用服务或已发布包/基线。资源预算待真实容量数据后由负责人决定，不以历史 MemoryPeak 或空闲采样代替。

## 旧入口核对与清理边界

活跃代码/文档扫描排除 `docs/archive/`、`node_modules/`、`dist/`。原 PowerShell 成员连接、旧本机宿主、源码构建 `sync-main.py` 与单元已退役；云端只读确认旧脚本不存在、`xunjie-main-sync.timer` 为 not-found。当前 `xunjie-release-deploy.timer`、备份 timers 与业务/接入服务保留。

`tools/i0-cloud` 的业务宿主、正式旧协议发布器、备份和节点准备仍有实际用途，保留；`connection.mjs` 对既有批准 owner 配置的只读适配继续用于维护兼容，不恢复手工成员接入流程。仓库外连接 README 已改为当前 invite/join/use 入口，只改 XunJie 说明；owner SSH、accounts.private.txt、backup-recovery 及其他项目未改。用户原 root.zcode、无关分支和已 stopped 的 robert QEMU/WSL 不在清理范围。

本轮已清理自己创建的隔离进程和明文恢复目录。之后以全新 file-only 临时成员经同一持久服务完成公开 CLI invite/join，再真实 fetch 原已发布编号；`cacheHit:false`、6,273,409 bytes、完整摘要与原包一致，未手传 ZIP。该 smoke 不创建 SSH/应用账号或受管后台进程，不执行 restore/verify；结束只撤销自己新建的成员并删除专属私有 home/下载缓存。证据为 `post-cleanup-smoke.json`，共享包和基线保留。

真实 daily timer 已在 2026-10-24 03:00:26–03:00:27 使用扩展后的现行备份配置完成，`Result=success`、`ExecMainStatus=0`。周备 timer 保持 active，未额外制造第二次周备。fresh 平台最终回执、最终稳定配置归档与容量报告仍需补齐，本文不预报通过。
