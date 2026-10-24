# 共享云基础设施模板

本目录保存共享应用部署与成员本机执行的通用基础设施。共享页面、API 和课程数据库运行在同一业务宿主；C/HDL 在成员各自已准备的独立执行节点运行。连接工具不初始化账号、课程、数据库、VM 或节点 ledger。

实际服务地址、SSH 身份、成员节点、端口、主机公钥 pin 与 HTTPS 证书只保存在仓库外的私下交接材料中，由负责人单独发送给获准成员。下文说明公开接口，不包含可直接连接的配置。现有 `xj-dev` 接入、模式、基线与复现入口见[开发工具说明](../../docs/development-tooling.md)；本目录保留云端宿主、发布、备份和容量工具。

| 文件 | 用途 |
| --- | --- |
| `cloud-host.mjs` | 组合既有业务应用、消费者及正常关停，HTTPS 仅监听回环；不迁移课程库 |
| `xunjie-shared.service` | 单进程业务服务的部署约定、持久目录、文件权限及资源预算模板 |
| `application-config.example.json` | 部署配置字段示例；占位内容不可运行 |
| `prepare-demo-data.mjs` | 对已备份共享合成库追加教学班、成员和发布前置；不新建表、不造学习记录 |
| `publish-demo-projects.mjs` | 按私有计划通过原教师 API 固定版本并分配，保留幂等回执 |
| `sshd-members.example.conf` | 页面与执行身份分离的 Match 结构示例，含不可直接安装的占位项 |
| `build-runtime-artifact.mjs` | CI 内装配 Linux 生产运行产物：预压缩静态资源、逐文件摘要与 manifest；不在服务器上运行 |
| `deploy-artifact.py` | 服务器下载并校验 CI 产物、备份、装配、切换与失败回退；`--status` 只读、`--prune` 只清理 |
| `xunjie-release-deploy.service` / `.timer` | 服务器每 5 分钟按产物发布的低权重维护服务模板 |
| `backup-retained.mjs` | 课程库、个人模型存储与恢复材料的 AES-256-GCM 加密备份及隔离恢复 |
| `backup.example.json` | 加密备份配置字段示例；密钥文件路径由维护者在仓库外持有 |
| `xunjie-backup-daily/weekly.service` / `.timer` | 日备保留 7 份、周备保留 4 份的定时加密备份模板 |
| `xunjie-monitor.service` / `.timer` / `monitoring.example.json` | 独立只读采样、CMS 自定义指标上报与受限凭据路径模板 |
| `capacity-run.mjs` / `capacity-workflow.mjs` | 五个独立成员的真实业务负载、既有自有历史复用及 base/delta 审计 |
| `capacity-collect.mjs` / `capacity-sample.py` / `capacity-analysis.mjs` | 服务端 requestId 延迟匹配、资源采样与 CPU/IO/内存归因 |
| [capacity-133-report.md](capacity-133-report.md) | 完整窗口、模型、隔离诊断与短预检的分项证据，保留失败及未测边界 |

## 按产物发布：CI 构建与云端切换

服务器不再构建源码。CI 使用 ubuntu-24.04 x64 + Node 24.21.0，产出含逐文件摘要的 `manifest.json` 和 `runtime.tar.gz`。两文件先写入孤儿提交，由 `cloud-artifact-<manifest sha256>` 不可变 tag 保持可达，再公开 `cloud-<source commit>` Release。Release 正文的 `xunjie-artifact-v1` JSON 绑定来源提交、产物提交、manifest 与 archive 摘要；Release asset API 的摘要和字节数必须与之匹配。相同来源提交的已绑定公开 Release 不被重跑替换。

本版部署器经 codeload 的**完整产物提交 SHA**下载，完全不使用可变镜像分支。`main` 推送与 integration 的 `workflow_dispatch` 都可产生精确来源版本的候选，但只有部署器读取到的精确 main HEAD 能进入共享业务发布；候选构建不移动 main 或共享镜像引用。同一 ref 只构建最新提交，取消旧运行时最多留下不可变 tag 或未公开 draft；同一 SHA 的跨 ref 运行串行。中断重跑发现同名 tag 时，先核对远端提交的 tree 与本次两文件完全一致，再复用原 SHA，避免提交时间不同造成 tag 冲突。Release 查询只有明确 HTTP 404 才按不存在创建；明确读到 draft 或旧 unbound Release 才允许替换，权限、网络、5xx 和异常响应一律失败并保留已有 Release。远端候选 workflow 由维护者同步 integration 后触发，构建通过不代表 main 已发布。CI 保留最近 5 份 Release，并额外保护 main 与当前 integration HEAD；无引用产物 tag 和未完成 draft 经过 24 小时宽限后清理，仍被 Release 引用的 tag 始终保留。

`deploy-artifact.py` 在服务器上只做校验、备份、装配与切换：

1. 经 GitHub API 核对 `main` HEAD 提交与 tree，按 `cloud-<commit>` 查找已发布 Release；产物未就绪时返回 `blocked`/`ARTIFACT_PENDING`，业务保持现状。
2. 从 `codeload.github.com` 按 Release 绑定的不可变产物提交流式拉取 tarball（总量上限 1 GiB + 8 MiB），解出 manifest 与 runtime tarball，先核对两者与 Release asset 的摘要和字节数，再核对 manifest 内 archive 摘要后解包到受控 staging（仅允许 `apps/student`、`apps/teaching`、`tools/i0-cloud/cloud-host.mjs` 路径），逐文件重算 sha256 与 manifest 精确比对，入口 HTML/JS 规则与静态摘要表也必须一致。
3. 磁盘可用空间低于 `minimumFreeBytes`（建议 5 GiB）时拒绝下载与装配（`blocked`/`LOW_DISK`），低于 `warningFreeBytes`（建议 10 GiB）只告警；已有业务不受影响。
4. SQLite 一致备份当前库（保留最近 `keepBackups` 份部署备份），切换 `current` 符号链接、重启服务，并用 `/health/live`、`/health/ready` 与实际返回的 index/入口 JS 摘要做健康探测；失败自动切回上一个 release 并重启、复测。
5. 成功后按保留策略清理发布目录：当前版本 + 最近 `keepReleases - 1` 个带 `health-verified.json` 成功记录的可回退版本 + 带 `.pinned` 标记的固定版本；清理只作用于部署脚本拥有的 `main-<commit>` 目录，不触碰业务数据、备份目录或外来文件。失败候选不会取得成功记录，并在回退完成后清除；当前旧版仅在进程、文件形状及实际返回资源健康核对成功后补记成功状态。首次迁移应先在隔离宿主验证需要保留的旧回退版本，不能将未验收目录直接标成成功。发布与清理由同一 flock 串行，备份单元复用同一把锁（见下）。

每 5 分钟的定时运行在已是最新时不重新哈希整个运行目录：只按 manifest 逐文件记录的路径与字节数做 stat 形状比对，再探测健康；内容级校验发生在每次下载装配新产物时（逐文件 sha256）与健康探测（实际返回的 index/入口 JS 摘要）。

发布信任边界：Release 发布权限与 `main` 推送权限等同（GitHub contents:write），摘要校验防护传输与装配损坏，不改变来源信任；构建成功不等于发布成功——只有健康探测通过才算部署完成。发布不初始化或迁移业务数据，不合并代码。

2026-10-23 的正式实例已完成源码构建→旧产物协议迁移：`sync-main.py` 及旧 `xunjie-main-sync` 单元已删除，工作目录不再保留源码构建路径。正式业务仍运行 `d07dc339`，其 main workflow 产生 unbound Release，正式部署器与 `deployment.json` 的 `artifactBranch` 因兼容需要暂时保留。不能先安装本版 strict 部署器或删掉该字段，否则下次旧 workflow 发布会被拒绝。

本版 strict 协议的切换顺序：先由负责人决定合 main，等待该 main 的首个 bound `cloud-<commit>` Release 就绪并核实 asset 摘要；在维护锁下更新正式部署器和配置（删除 `artifactBranch`，字段见下表），完成健康发布及回退核对后再清理旧镜像分支。此前仅在独立 candidate 使用本版部署器和隔离配置、端口与数据副本，不能修改 `current` 下的业务产物来绕过 main。`backup-retained.mjs` 的 WAL 修复与独立监控不依赖新 Release 格式，可以先应用。服务器基础设施脚本不随业务产物分发。

| `deploy-artifact.py` 配置字段（仓库外 `/etc/xunjie/deployment.json`） | 说明 |
| --- | --- |
| `repositoryUrl` / `releasesDirectory` / `currentLink` / `workDirectory` / `nodeBinDirectory` / `applicationConfigFile` / `applicationService` / `healthUrl` / `statusFile` / `backupDirectory` | 与原部署配置同义；`nodeBinDirectory` 仍用于部署前 SQLite 一致备份 |
| `artifactTagPrefix` | CI Release 标签前缀，当前为 `cloud`；产物 tag 为此前缀 + `-artifact-<manifest sha256>` |
| `minimumFreeBytes` / `warningFreeBytes` | 低磁盘拒绝/预警阈值（字节） |
| `keepReleases` / `keepBackups` | 可回退发布目录数（含当前）与部署备份数 |

`--status` 输出远端/已部署提交、健康、磁盘与内存水位、CPU 核数与负载、发布与备份清单、上次部署结果和 `actions` 维护建议；接到既有云监控即可（建议告警：发布单元失败、`status=failed`、磁盘越过两级阈值、`MemAvailable` 低于 384 MiB、负载持续超过两倍核数、业务服务非 active）。低磁盘恢复动作用 `--prune` 只执行清理。

## 持续监控

`xunjie-monitor.service/.timer` 每 5 分钟独立调用只读状态采集，向既有阿里云 CMS 上报应用健康、发布健康、磁盘可用字节、可用内存、每核负载与 GitHub 可达性，以及内存/两级磁盘健康标记。健康标记正常为 1，低于阈值或发布失败为 0；规则以 `< 1` 评估。内存阈值为 384 MiB，磁盘阈值沿部署配置的 10/5 GiB。稳态发布 timer 的 `unchanged` 输出不能替代采样。GitHub 请求失败时仍报告本机健康与资源。

安装监控单元前，将本版 `deploy-artifact.py` 另存为 `/usr/local/lib/xunjie/deploy-artifact-candidate.py`，将正式部署配置复制到 `/etc/xunjie/monitoring-deployment.json` 并仅从副本删除 `artifactBranch`；保留其中正式业务路径供只读探测。单元固定使用该独立 helper/config，只传 `--monitor-config`，不执行部署。这样正式发布器仍兼容旧 main。将 `monitoring.example.json` 配置为 `/etc/xunjie/monitoring.json`，填既有 CMS 分组和 `application=xunjie-shared` 维度；配置、凭据与状态文件均为 root 所有、0600。

`credentialsFile` 当前是 `/etc/xunjie/monitoring-credentials.json`，仅含 `accessKeyId` / `accessKeySecret`。独立 RAM 用户 `xunjie-cms-reporter` 只挂载自定义策略 `XunJieCloudMetricsWrite`：`Allow cms:PutCustomMetric`、`Resource: "*"`；该 API 不支持更细资源级授权，故凭据可上报本账号的自定义指标，配置中的分组不是 IAM 限制。身份没有查询/修改告警、通知、ECS 或 OSS 权限，也未复制管理员凭据。上报端点为北京地域 CMS API，授权范围见 [官方 API 文档](https://help.aliyun.com/zh/cms/cloudmonitor-1-0/developer-reference/api-cms-2019-01-01-putcustommetric)。轮换或撤销使用维护者身份管理 RAM，原子替换受限凭据文件后核实下一轮上报。

安装标准 C++ 云监控 agent 采集 OS 指标，并在 CMS 配置资源阈值及自定义健康/发布结果告警。按 [官方安装说明](https://help.aliyun.com/zh/cms/cloudmonitor-1-0/user-guide/install-and-uninstall-the-cloudmonitor-agent-for-cpp/) 选择当前脚本，勿复用失效 URL；若无需日志采集，安装时设置 `INSTALL_LOONGCOLLECTOR=false`。采样器只写受限监控状态文件，不修改应用数据或触发部署。以下 dry-run 既不上报指标，也不发送通知：

```sh
sudo python3 /usr/local/lib/xunjie/deploy-artifact-candidate.py --config /etc/xunjie/monitoring-deployment.json --monitor-config /etc/xunjie/monitoring.json --dry-run
```

验收分别记录 agent 运行、CMS 可查询到的新鲜指标、规则阈值/维度/联系组及正常状态；不以创建规则或上报 200 代替指标入库，不主动制造生产故障或发送测试通知。查自定义数据时先用 `DescribeCustomMetricList` 取得受限的实际 namespace，再按 metadata 的 `groupId,dimension` 查询：`groupId` 为 JSON 数字、`dimension` 为 `application=xunjie-shared`，不要展开为 `application` 维度。namespace 内账号标识、分组 ID 与联系人不进入公开验收输出。告警时先看 `--status` 的 `actions`：业务失败核对 live/ready 与 systemd；发布失败看部署状态与回退结果；低内存定位进程；低磁盘先执行部署器 `--prune`，不手删业务库或恢复材料。真实证据及未完成边界见[本轮验收记录](../../docs/references/2026-10-23-cloud-release-review-fixes.md)。

## 加密备份与隔离恢复

`backup-retained.mjs` 把课程库（SQLite Backup API 一致副本，前后做 integrity/外键检查）、个人模型存储目录（库文件一致副本 + 密钥材料原样复制，排除源库 WAL/SHM/journal）和 `extraFiles`（签名密钥、TLS 材料、应用配置）打成 tar 后以 AES-256-GCM 加密写入 `outputDirectory`，文件名 `<label>-<时间>-<随机>.xunjiebak`（0600）。密钥应另存独立设备的受限副本（例如负责人 Mac 的 `~/.config/xunjie-cloud/backup-recovery/`，目录 0700、文件 0600）；这不等于已保存离线介质。仅保存在同一服务器不能支持整机丢失后的恢复。密钥取自维护者独享的 key file（`openssl rand 32` 生成，保存在仓库与备份目标之外），私钥与密钥内容不进入日志或输出。

现有配置字段保持兼容；[配置示例](backup.example.json)新增 `databases`、`directories`、`recoveryFiles`，每项为 `{ "source": "绝对源路径", "path": "归档内相对路径" }`。它们分别用于显式登记活跃库、带模型 store/key 的目录及非数据库恢复材料；不同服务的同名 `service.json`/`application.json` 应放在不同归档路径，重复或越界路径拒绝。目录内按 SQLite 文件头与 `.sqlite/.sqlite3/.db` 后缀识别数据库，统一使用 Backup API 并排除 WAL/SHM/journal；损坏或创建中的库明确失败，不降为普通文件。`extraFiles`/`recoveryFiles` 不允许裸复制数据库或日志。symlink/特殊对象拒绝，备份加密 key 本身及其硬链接禁止进入归档。目录只列维护者核定的恢复材料，不递归打包整个 `/etc` 或成员 home。

完整恢复清单应包括：正式课程库/原个人模型、活跃候选业务库/个人模型 store 与对应 key、account-control registry/config、access SQLite 与对应 `credential.key`、应用签名/TLS/CA 配置、服务单元、受管 SSH 映射与固定 helper/回执。实际路径按当前持久服务核定，示例不是可直接部署配置。成员设备私钥只在成员本机，服务器归档不包含它；服务器持有的受管公钥映射可备份。短期签名 URL、当前 socket/PID、活跃 WAL 不作为恢复材料。

恢复必须指向空的隔离目录：`--restore <archive> --key-file <file> --target <empty-dir> --teaching-root <dir>`，脚本先解密认证、逐文件核对摘要并对每个库做只读 integrity/外键检查，全部通过才移入目标并报告 `restored`；版本 1 归档仍可恢复。密钥错误或归档被篡改时目标不被写入。再将恢复配置中的路径、端口、socket 改为新的隔离目录，核对 TLS key/cert、模型/账号凭据解密关系与实际业务读回；不能仅凭文件数宣称全链路可恢复，也不能用原服务配置启动第二个写同库的实例。

每个 SQLite 副本各自一致，多个库与额外文件按顺序采集，不构成跨存储原子快照。版本 2 的加密 manifest 记录逐项来源、采集方法与起止时间；这些路径及秘密仍只存在加密归档中。先前正式业务备份曾在负责人 Mac 独立恢复 10 文件、核验两库；新增接入/候选范围的实际恢复证据另行记录，不沿用旧计数冒充验收，也不等于整机重建或离线介质。

日常运行由 `xunjie-backup-daily.timer`（03:00，保留 7 份）与 `xunjie-backup-weekly.timer`（周日 03:30，保留 4 份）触发；按 label 分别清理，只删除本脚本命名的归档。两个备份单元的 `ExecStart` 用 `flock` 持有部署脚本同一把锁（`<workDirectory>/deploy-artifact.lock`），部署与备份、备份与备份互不重叠；换部署配置时需同步单元里的锁路径。恢复演练应在隔离环境（独立目录、无生产配置）执行一次并记录结果，不要在生产数据目录上直接演练。

#133当前恢复范围已在真实daily policy补齐actual e03配置、全部9个有效dropin及22份helper回执，formal scope和70d/c896回退材料保留，未登记不存在的1aa配置。五个容量身份及file-only smoke身份退休后，另取post-capacity/pre-Mac归档：87文件/6库，云端与main独立Mac恢复的摘要、integrity/FK、key/TLS、active/deny/SSH关系均通过，恢复明文已清。它标记isFinalCurrentSnapshot:false；Mac系统认证/精确清理后仍取新final快照，不能把Mac解密恢复通过当作系统信任完成。更新后的定时策略已实际写入，但未到下一timer触发时间；当前/历史归档及密文摘要见[交付核查](../../docs/references/2026-10-24-development-delivery-closeout.md#五成员退休后的当前日备与新归档)。

## 静态资源与资源预算

前端构建产物在 CI 阶段预压缩（`.br`/`.gz` 边车，仅小于原文件时生成），宿主静态处理器按 `Accept-Encoding` 选择边车，不做请求期压缩；带内容摘要的 `/assets/**` 返回 `immutable` 一年缓存，入口 HTML 返回 `no-cache` 并带构建期摘要 ETag，新版本与回退各自引用独立发布目录，不会混用资源。2 MiB 以内的小产物一次写出，更大的文件流式转发，不在业务进程整体读入。回环访问的成员页面转发沿用既有 HTTPS 链路。

资源预算依据为 #133 的 e03+ss16 五成员完整窗口：普通 API（含登录）p95 262.266ms，candidate cgroup peak 329.152MiB（含登录峰），access peak 42.738MiB，host最低可用908.973MiB，无OOM/restart；不以正式服务旧idle峰作为五人峰值。[shared模板](xunjie-shared.service) 的 `[Service]` 已设 `CPUWeight=200`、`MemoryHigh=512M`、`MemoryMax=768M`，下次安装该模板的 `ExecStart` 默认显式 `--max-semi-space-size=16`；[access模板](../xj-dev-access/xunjie-dev-access-candidate129.service) 为High128M/Max256M、TasksMax64。

当前正式服务仍运行旧d07、PID91972及原argv，未重启、未发布，也不能据模板变更声称它已有ss16。负责人已用持久 `systemctl set-property` 应用正式CPU200/High512M/Max768M；已测candidate保留更严格Max512M，设High448M/CPU200，access为High128M/Max256M、Tasks64。实际properties、内核cgroup值及所有PID/ExecStart不变均已读回，回执为仓库外 `xj133-resource-budgets-20261024/applied.json`；预算dropins位于 `/etc/systemd/system.control/<unit>.d/`，没有安装替换formal unit或发布器。这些unit模板不在产品runtime清单内，不需重建e03产物。完整来源和边界见[#133交付核查](../../docs/references/2026-10-24-development-delivery-closeout.md)。

维护单元（发布、备份）继续使用低CPU/IO权重与内存上限；部署与备份共用同一把flock维护锁串行，业务优先。后续调整按[运行策略](../../docs/development-access-operations.md)核对实测与实际生效配置。

## 容量负载与回执

维护者使用 Node 24.21.0，在负责人明确安排的窗口运行 `node tools/i0-cloud/capacity-run.mjs <private-run-config.json>`。私有配置引用五个不同 member/device 的身份文件，固定已核验的 `expectedSource`、905 秒窗口及证据目录；收到明确 T0 后才设置 `windowApproved:true` 并启动。配置、账号和 key 不进入 Git 或命令参数正文。版本、端口、TLS、Session 和原自有项目归属均由实际接口复核。

重复验收通过 `previousAuditFile` 复用原四个自有 assignment/attempt，核对身份、起点 hash/version、旧提交和反馈，并按原基数加本轮增量审计；保留原数据规模与失败证据。`run.json` 记录 PID、阶段、请求数及进度；工具调用超时后先核对进程和进度，已有 run 不重复启动。服务切换、预算变更、备份快照和其他业务写入由负责人安排在窗口之外。

每次计划上传分别记录 actor、计划字节数、耗时及成功或安全失败码；OSS 失败保留为失败，继续普通业务窗口及第二次上传。业务致命失败进入 `draining`，停止新请求、等待所有已发分支收束后写入 `executionDrained:true` 和稳定终态，保留首个失败原因。`completed` 表示执行收束；外部能力失败仍以退出码 1 和 `executionPassed:false` 报告。执行成功时 `overallPassed:null`，等待服务端延迟、资源与独立数据库审计后再判断容量是否通过。

完成后用 `node tools/i0-cloud/capacity-collect.mjs <private-run-config.json>` 匹配服务器生成的 requestId，普通 API p95 使用服务端耗时并包含正常登录；客户端 RTT、真实模型、OSS 和 controlled transport 结果分别报告。资源报告区分窗口采样的 `memory.current` 与包含历史的 lifetime peak，核对 PID/restart/OOM 增量与 host available。`capacity-profile*.mjs` / `capacity-hydration-patch.mjs` / `capacity-precheck.mjs` 用于隔离副本诊断；微基准与短预检保留各自来源，完整新 CI 产物的正式窗口另行验收。产品 runtime 的装配清单只包含本目录的 `cloud-host.mjs`，这些容量工具不随产品产物分发。

## 成员连接入口

页面、API 与原登记节点连接已统一迁入 [xj-dev 模式与受管连接](../xj-dev/README.md#模式与受管连接)。原 PowerShell 连接入口、重复配置解析器和旧 JSON 示例已删除。使用现有获准配置调用 `xj-dev use cloud-api/cloud --connection <file>` 或 `xj-dev node connect --connection <file>`；身份不在配置时传 `--identity <私钥路径>`。

新入口管理隧道监督、严格 SSH pin、HTTPS CA、固定数据目标与隔离 Cookie；节点传输、真实执行业务和模型调用分别报告。它不初始化账号、课程、数据库、VM 或节点 ledger。本目录保留业务宿主、发布、备份及 SSH 服务端权限模板。

维护者按私下部署记录核定实际路径、服务用户、节点绑定和访问权限。应用沿现有35表或显式启用的41表课程库及登记节点启动；两种模式均复用原组合并核对精确表结构；个人模型存储按获准配置启用，不复制旧个人模型库或 Key。运行时配置、机密、数据库、真实公钥 pin 和证书均不随源码分发。

迁移使用 SQLite 一致备份，保留原 ID、账号资料和旧作品；不直接复制活跃主库而遗漏 WAL。最终切换保持唯一业务写库，前后核对完整性、外键及原记录。数据库继续遵守原普通文件与 `TMPDIR` 路径门禁，不在启动时自动迁移。开发环境可通过私有 `allowedLoginUserIds` 将登录限制在获准的教师与学生；虚拟成员仍使用真实课程关系，但不获得登录资格。

成员连接只允许预登记的回环转发；页面身份与执行回连身份分开，禁密码、PTY、agent/X11 和普通远端命令。所有目的地、身份与端口取自获准私有配置，严格验证预先核定的 SSH 主机 pin；不首次自动接受主机，不读取私钥正文，不改全局 SSH。页面本机端口已占用时立即拒绝，不停止或接管已有服务。

业务宿主与执行器可用性分别报告。执行器离线时仍可登录、查看和保存；新运行需当前节点就绪，旧结果、取消及 HDL 后续操作沿原节点绑定核对，不静默改派。当前连接工具与配置模板的删除条件见[替换清理设计](../../docs/development-tooling.md#旧连接实现配置与说明的替换清理)。
