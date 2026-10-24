# #132 发布、监控与恢复复核

日期：2026-10-23。范围以 [#132](https://github.com/paher-din/XunJie/issues/132) 和负责人本轮授权为准。本文不包含账号 ID、分组 ID、联系人、地址或凭据正文；敏感配置仅记录路径、权限和能力范围。

## 发布状态与边界

| 层次 | 已核实状态 |
| --- | --- |
| 工程补丁 | `6587a54` 修复不可变产物绑定、成功回退保留和源 SQLite sidecar；`f752751` 修复中断重跑与最新构建取消语义；分别合入 integration `69cb95d` / `2222188` |
| 托管候选 CI | [run 39959686727](https://github.com/paher-din/XunJie/actions/runs/39959686727)，head `22221889626d69f781b5e40a249ed1a8844519ca`，首次构建和第二次重跑均成功；主会话独立核实 Release ID `421864023`、assets ID `669182885` / `669182883` 及两个 digest 不变 |
| 真实候选业务 | 由 #128 使用上述候选包在 ECS 独立数据、端口与受管目录验收；本文的部署器故障演练不冒认该业务验收 |
| 正式业务 | `current` 仍指向 `main-d07dc339d4c2074d2729de7e6f662da0b86a7236`；业务 active、`NRestarts=0`、启动时间 `2026-10-23 20:28:35 CST`；没有用候选源码修改运行产物 |
| 正式发布器 | 仍保留兼容旧 unbound Release 的版本与 `artifactBranch`；已核对脚本 SHA256 为 `2aeb44f1487d7fe3ec0d409bbc55a930aeb2b8a2e5ad8a66adf8fe8cd2891a8d`，发布 timer active |
| 正式维护 | WAL 排除修复和独立 CMS 监控已应用；它们不要求 main 已采用新 Release 格式 |

严格绑定协议尚未切换正式 main。退出过渡的条件是负责人决定合 main、首个 bound main Release 就绪并核对摘要，然后在维护锁下升级正式部署器/配置并做健康发布与回退验收。届时删除旧 `artifactBranch` 和镜像引用；此前不能提前覆盖正式发布器。旧源码构建脚本 `/usr/local/lib/xunjie/sync-main.py` 和 `xunjie-main-sync` 单元已实际删除，无源码构建服务与产物服务并跑。

## 缺陷修复与故障验收

| 原缺陷 | 修复与可重复证据 |
| --- | --- |
| 可变 codeload 分支可能取到并行发布/回退的错误产物，且缺少可信外部摘要绑定 | CI 先推 content tag、最后公开 Release；Release 绑定 source SHA、artifact commit 和两文件摘要。部署器仅按完整 artifact SHA 下载，同时比较 Release asset digest/size、manifest 和逐文件摘要。测试拒绝不匹配、异常路径/文件类型、超限及不允许的下载来源 |
| 失败候选按新旧时间参与保留，挤占已成功回退版本 | 只保留当前、带 `health-verified.json` 的成功回退版本与显式 pin；失败候选在成功回退后删除。测试覆盖旧成功版本保留、pin、失败候选和清理边界 |
| 一致备份混入源库 WAL/SHM/journal | 已排除个人模型源 sidecar；活跃 WAL 测试确认已提交写入进入 Backup API 副本，恢复不依赖源 WAL |
| 稳态部署不采样、资源告警缺项 | 独立 timer 每 5 分钟只读采样，CMS 规则覆盖健康、发布结果、内存与两级磁盘，CPU 沿用原规则；实际读回证据见下 |

真实部署器故障演练使用单独 `132-deploy-*` 临时目录、独立 systemd 单元、随机回环 TLS 端口和仅含 sentinel 的 SQLite。运行文件取只读副本，上游产物为受控 fixture；未碰正式或 #128 候选业务数据。执行真实 SQLite backup、systemctl restart、符号链接切换和 HTTPS 探测：

- 将隔离配置磁盘门槛设为实际 `statvfs` 可用量以上，返回 `LOW_DISK`，未下载/备份，既有隔离服务仍 active。没有填满共享磁盘。
- 新候选真实 HTTPS ready 返回 503，经过健康等待后返回 `APPLICATION_HEALTH_FAILED`、`rollback=previous_release_restarted`；旧版健康与静态摘要恢复，失败候选目录删除，fixture DB 摘要不变。
- 移除隔离故障后再次部署，返回 `deployed`，新旧两版有成功记录、旧成功回退版保留，部署备份 sentinel 匹配，fixture DB 不变。
- 临时服务、目录、数据和本机验收脚本已清理。该演练不模拟物理磁盘耗尽，也不声称完成五人容量测试。

CI 查询错误路径另有回归：只将明确 HTTP 404 当作不存在；明确读取 draft/旧 unbound Release 才允许替换。403、503、网络中断和异常 200 响应均失败，mock 记录确认没有 delete/create/edit，原公开 Release 字节不变。中断测试执行实际 workflow shell 与真实本地 bare Git：tag 已推、draft 创建后取消，换提交时间重跑复用同一 tag SHA；同 tag 下不同 archive 被拒绝。没有为该测试写入 GitHub。

## 实际备份与独立设备恢复

正式备份脚本已应用源 sidecar 排除；在原维护 flock 下采集当前课程库、个人模型库及密钥材料、签名/TLS/节点恢复材料和应用配置。两库分别经 SQLite Backup API 一致复制，不构成跨库及额外文件同一时刻的原子快照。

| 证据 | 结果 |
| --- | --- |
| 新加密 daily 备份 | 10 文件，366884 bytes；不含源 WAL/SHM/journal。旧 12 文件样本不能替代这次修复后的证据 |
| 维护样本 | 峰值 RSS 64596 KiB、耗时 0.28 秒；仅是本次备份样本，不作为业务峰值预算依据 |
| 负责人 Mac 副本 | `~/.config/xunjie-cloud/backup-recovery/` 0700；`backup.key` 与加密 archive 0600；archive 摘要与服务器一致，未输出密钥 |
| Mac 实际恢复 | 使用该设备密钥、Node 24 和本机 SQLite driver，在新隔离目录恢复 10 文件；两库 integrity/FK 均通过，解密临时文件已清理 |
| 受限回执 | `~/.config/xunjie-cloud/backup-recovery/132-backup-restore-evidence.json`，0600 |
| 定时任务 | daily/weekly timer active；下次分别为 `2026-10-24 03:00 CST` / `2026-10-25 03:30 CST`，保留数分别 7 / 4，共用部署维护锁 |

这是独立设备副本，不是离线介质；未执行整机重建。新增接入数据由 #133 在接入服务完成后纳入，不声称本票完成全链路恢复。

## CMS 运行、凭据和读回

标准 C++ agent 4.0.0 已通过当前官方脚本安装，`cloudmonitor.service active`，argusagent 两进程。安装时关闭 LoongCollector，未另建日志/监控平台。安装脚本 SHA256 为 `2b789c7088b562a454145c3363b4d7dabc43665892a271f985f9a5259f0f8f82`，安装缓存已清理。官方安装入口见 [CMS agent 文档](https://help.aliyun.com/zh/cms/cloudmonitor-1-0/user-guide/install-and-uninstall-the-cloudmonitor-agent-for-cpp/)。

`xunjie-monitor.timer active`；oneshot 完成后 service 为 inactive 是正常状态，最近读回 `Result=success` / `ExecMainStatus=0`。主会话亦独立核实 timer 与最近执行结果。采样器只读正式业务状态，写受限监控回执；不触发部署、不修改业务库。

| 配置与身份 | 范围 |
| --- | --- |
| `/usr/local/lib/xunjie/deploy-artifact-candidate.py` | 本版独立 helper，仅以 monitor 参数使用；正式 deployer 保持旧协议 |
| `/etc/xunjie/monitoring-deployment.json` | 正式部署配置的只读采样副本，去掉 `artifactBranch`；含正式路径/服务名、资源阈值，0600、root 所有 |
| `/etc/xunjie/monitoring.json` | 仅 `credentialsFile`、`groupId`、`dimensions`、`statusFile`；0600、root 所有；维度 `application=xunjie-shared` |
| `/etc/xunjie/monitoring-credentials.json` | 仅 `accessKeyId` / `accessKeySecret`；0600、root 所有；不含管理员凭据 |
| RAM 用户 `xunjie-cms-reporter` | 无用户组；只挂载 `XunJieCloudMetricsWrite`，`Allow cms:PutCustomMetric`、`Resource: "*"`。该 API 不支持更细资源授权，权限可上报本账号指标，分组配置不是 IAM 范围限制 |
| `/var/lib/xunjie/maintenance/monitoring.json` | 采样结果、时间、水位与维护建议；0600、root 所有 |

未绑定 ECS RAM Role、未开 OSS，不在本票重复实施 #131。上报身份没有查询或管理规则、通知、ECS、OSS 权限；轮换和撤销由维护者执行。权限模型参考 [PutCustomMetric 官方文档](https://help.aliyun.com/zh/cms/cloudmonitor-1-0/developer-reference/api-cms-2019-01-01-putcustommetric)。

CMS 实际读回（2026-10-23 13:52Z）：`DescribeMetricList` 按实际 account namespace、数字 `groupId` 和 `dimension=application=xunjie-shared`、period 300 查询；namespace/分组 ID 未输出。应用及发布健康各有 3 点，内存和两级磁盘健康各有 1 点，最新点均为 **13:45Z、Average=1**。这是数据点读回，独立于 `PutCustomMetric` 的 200/success 和 metadata 注册记录。原生 CPU 也读回 6 点，13:45Z Average=7.23%、Maximum=8.791%。原始字节与负载另保留在每轮本机采样回执，不将一次样本当容量测试。

2026-10-23 **13:54Z** 实际读回六条规则均为 `EnableState=true`、`AlertState=OK`：`xunjie-health-failed`、`xunjie-deployment-unhealthy`、`xunjie-memory-low`、`xunjie-disk-warning`、`xunjie-disk-floor`、`xunjie-cpu-high`。自定义规则资源维度与采样器匹配，CPU 规则绑定目标 ECS，联系组已配置；使用既有 CPU 规则联系组，未展示联系人。自定义指标均为 `<1`、Average、period 300、连续 2 次、Critical；CPU 为 `>=85%`、period 300、连续 3 次。两级磁盘当前都使用 Critical，不能把名字中的 warning 当作已配置 Warn 级别。首次入库前出现过 `INSUFFICIENT_DATA`，已在实际数据到达后收敛为 `OK`。

本轮 CMS 查询通过的是上述五个健康指标与原生 CPU；原始字节、每核负载及 GitHub 可达性虽随正常采样上报，但查询尚未取得可读数据证据，不算 CMS 图表验收通过。这些诊断值可从本机采样回执及 `--status` 读取，现有内存/磁盘规则依赖已验收的健康指标。

不主动制造真实故障或调用通知测试 API；正常指标采样、配置和读取不等于端到端通知投递测试。

## 工程验证与剩余交付

- 针对性 Python 回归 33/33、Node 加密备份回归 5/5 通过。workflow Bash 与内联 Node 语法、diff 空白检查按本轮修改复核。
- 本轮未改 student/teaching 生产源码或依赖锁；引用前轮完整工程 gate，不重复跑无关全量测试。没有冒认浏览器、Windows 模式或教学效果验收。
- 本轮查询错误补丁和监控/文档收尾仅形成本地票分支提交，待主会话安排 integration 合并；不 push、不合 main、不关闭 #132。
- 正式 strict 协议切换等待负责人 main 发布决定；五人 15 分钟混合负载、业务预算应用与新增接入备份属于 #133。#132 的 CMS 必需健康/资源规则已读回正常状态，未扩称原始诊断图表和通知投递测试通过。
