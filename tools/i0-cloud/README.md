# 共享云基础设施模板

本目录保存共享应用部署与成员本机执行的通用基础设施。共享页面、API 和课程数据库运行在同一业务宿主；C/HDL 在成员各自已准备的独立执行节点运行。连接工具不初始化账号、课程、数据库、VM 或节点 ledger。

实际服务地址、SSH 身份、成员节点、端口、主机公钥 pin 与 HTTPS 证书只保存在仓库外的私下交接材料中，由负责人单独发送给获准成员。下文说明公开接口，不包含可直接连接的配置。新的统一工具状态与替换计划见[开发工具说明](../../docs/development-tooling.md)，不要把设计中的 `xj-dev` 当作当前已有命令。

| 文件 | 用途 |
| --- | --- |
| `cloud-host.mjs` | 组合既有业务应用、消费者及正常关停，HTTPS 仅监听回环；不迁移课程库 |
| `xunjie-shared.service` | 单进程业务服务的部署约定、持久目录、文件权限及候选资源预算模板 |
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

## 按产物发布：CI 构建与云端切换

服务器不再构建源码。CI 使用 ubuntu-24.04 x64 + Node 24.21.0，产出含逐文件摘要的 `manifest.json` 和 `runtime.tar.gz`。两文件先写入孤儿提交，由 `cloud-artifact-<manifest sha256>` 不可变 tag 保持可达，再公开 `cloud-<source commit>` Release。Release 正文的 `xunjie-artifact-v1` JSON 绑定来源提交、产物提交、manifest 与 archive 摘要；Release asset API 的摘要和字节数必须与之匹配。相同来源提交的已绑定公开 Release 不被重跑替换。

服务器经 codeload 的**完整产物提交 SHA**下载，完全不使用可变镜像分支。`main` 推送与 integration 的 `workflow_dispatch` 都可产生精确来源版本的候选，但只有部署器读取到的精确 main HEAD 能进入共享业务发布；候选构建不移动 main 或共享镜像引用。同一 ref 只构建最新提交，取消旧运行时最多留下不可变 tag 或未公开 draft；同一 SHA 的跨 ref 运行串行。中断重跑发现同名 tag 时，先核对远端提交的 tree 与本次两文件完全一致，再复用原 SHA，避免提交时间不同造成 tag 冲突。远端候选 workflow 由维护者同步 integration 后触发，构建通过不代表 main 已发布。CI 保留最近 5 份 Release，并额外保护 main 与当前 integration HEAD；无引用产物 tag 和未完成 draft 经过 24 小时宽限后清理，仍被 Release 引用的 tag 始终保留。

`deploy-artifact.py` 在服务器上只做校验、备份、装配与切换：

1. 经 GitHub API 核对 `main` HEAD 提交与 tree，按 `cloud-<commit>` 查找已发布 Release；产物未就绪时返回 `blocked`/`ARTIFACT_PENDING`，业务保持现状。
2. 从 `codeload.github.com` 按 Release 绑定的不可变产物提交流式拉取 tarball（总量上限 1 GiB + 8 MiB），解出 manifest 与 runtime tarball，先核对两者与 Release asset 的摘要和字节数，再核对 manifest 内 archive 摘要后解包到受控 staging（仅允许 `apps/student`、`apps/teaching`、`tools/i0-cloud/cloud-host.mjs` 路径），逐文件重算 sha256 与 manifest 精确比对，入口 HTML/JS 规则与静态摘要表也必须一致。
3. 磁盘可用空间低于 `minimumFreeBytes`（建议 5 GiB）时拒绝下载与装配（`blocked`/`LOW_DISK`），低于 `warningFreeBytes`（建议 10 GiB）只告警；已有业务不受影响。
4. SQLite 一致备份当前库（保留最近 `keepBackups` 份部署备份），切换 `current` 符号链接、重启服务，并用 `/health/live`、`/health/ready` 与实际返回的 index/入口 JS 摘要做健康探测；失败自动切回上一个 release 并重启、复测。
5. 成功后按保留策略清理发布目录：当前版本 + 最近 `keepReleases - 1` 个带 `health-verified.json` 成功记录的可回退版本 + 带 `.pinned` 标记的固定版本；清理只作用于部署脚本拥有的 `main-<commit>` 目录，不触碰业务数据、备份目录或外来文件。失败候选不会取得成功记录，并在回退完成后清除；当前旧版仅在进程、文件形状及实际返回资源健康核对成功后补记成功状态。首次迁移应先在隔离宿主验证需要保留的旧回退版本，不能将未验收目录直接标成成功。发布与清理由同一 flock 串行，备份单元复用同一把锁（见下）。

每 5 分钟的定时运行在已是最新时不重新哈希整个运行目录：只按 manifest 逐文件记录的路径与字节数做 stat 形状比对，再探测健康；内容级校验发生在每次下载装配新产物时（逐文件 sha256）与健康探测（实际返回的 index/入口 JS 摘要）。

发布信任边界：Release 发布权限与 `main` 推送权限等同（GitHub contents:write），摘要校验防护传输与装配损坏，不改变来源信任；构建成功不等于发布成功——只有健康探测通过才算部署完成。发布不初始化或迁移业务数据，不合并代码。

服务器迁移（替换旧 `sync-main.py` 源码构建路径）：复制 `deploy-artifact.py` 与 `backup-retained.mjs` 到 `/usr/local/lib/xunjie/`（两者都是服务器基础设施，不随业务产物分发），部署配置改为下表字段（删除 `buildUser`、`artifactBranch`），安装 `xunjie-release-deploy.service/.timer` 与备份单元后 `systemctl disable --now xunjie-main-sync.timer` 并删除旧单元与 `/usr/local/lib/xunjie/sync-main.py`；脚本会自动清掉工作目录里旧构建残留（`source-*.tar.gz`、`npm-cache`、`sync-main.lock`）。合并本分支的 `main` 推送需先等一次 `cloud-release` workflow 产出 `cloud-<commit>` Release，再切换服务器单元。

| `deploy-artifact.py` 配置字段（仓库外 `/etc/xunjie/deployment.json`） | 说明 |
| --- | --- |
| `repositoryUrl` / `releasesDirectory` / `currentLink` / `workDirectory` / `nodeBinDirectory` / `applicationConfigFile` / `applicationService` / `healthUrl` / `statusFile` / `backupDirectory` | 与原部署配置同义；`nodeBinDirectory` 仍用于部署前 SQLite 一致备份 |
| `artifactTagPrefix` | CI Release 标签前缀，当前为 `cloud`；产物 tag 为此前缀 + `-artifact-<manifest sha256>` |
| `minimumFreeBytes` / `warningFreeBytes` | 低磁盘拒绝/预警阈值（字节） |
| `keepReleases` / `keepBackups` | 可回退发布目录数（含当前）与部署备份数 |

`--status` 输出远端/已部署提交、健康、磁盘与内存水位、CPU 核数与负载、发布与备份清单、上次部署结果和 `actions` 维护建议；接到既有云监控即可（建议告警：发布单元失败、`status=failed`、磁盘越过两级阈值、`MemAvailable` 低于 384 MiB、负载持续超过两倍核数、业务服务非 active）。低磁盘恢复动作用 `--prune` 只执行清理。

## 持续监控

`xunjie-monitor.service/.timer` 每 5 分钟独立调用只读状态采集，向既有阿里云 CMS 上报应用健康、上次发布失败、磁盘可用字节、可用内存、每核负载与 GitHub 可达性；稳态发布 timer 的 `unchanged` 输出不能替代采样。GitHub 请求失败时仍报告本机健康与资源。`monitoring.example.json` 是配置模板；`credentialsFile` 使用仓库外 0600 文件，仅含 `accessKeyId` / `accessKeySecret`，对应独立 RAM 上报身份，只允许 `cms:PutCustomMetric`，不复制管理员凭据。当前上报端点是北京地域 CMS API。

安装标准 C++ 云监控 agent 采集 OS 指标，并在 CMS 配置资源阈值及自定义健康/发布结果告警。按 [官方安装说明](https://help.aliyun.com/zh/cms/cloudmonitor-1-0/user-guide/install-and-uninstall-the-cloudmonitor-agent-for-cpp/) 选择当前脚本，勿复用失效 URL；若无需日志采集，安装时设置 `INSTALL_LOONGCOLLECTOR=false`。采样器只写受限监控状态文件，不修改应用数据或触发部署。以下 dry-run 既不上报指标，也不发送通知：

```sh
sudo python3 /usr/local/lib/xunjie/deploy-artifact.py --config /etc/xunjie/deployment.json --monitor-config /etc/xunjie/monitoring.json --dry-run
```

验收分别记录 agent 运行、CMS 可查询到的新鲜指标、规则阈值/维度/联系组及正常状态；不以创建规则代替指标入库，不主动制造生产故障或发送测试通知。维护者负责受限凭据的轮换与撤销。

## 加密备份与隔离恢复

`backup-retained.mjs` 把课程库（SQLite Backup API 一致副本，前后做 integrity/外键检查）、个人模型存储目录（库文件一致副本 + 密钥材料原样复制，排除源库 WAL/SHM/journal）和 `extraFiles`（签名密钥、TLS 材料、应用配置）打成 tar 后以 AES-256-GCM 加密写入 `outputDirectory`，文件名 `<label>-<时间>-<随机>.xunjiebak`（0600）。密钥应另存独立设备的受限副本（例如负责人 Mac 的 `~/.config/xunjie-cloud/backup-recovery/`，目录 0700、文件 0600）；这不等于已保存离线介质。仅保存在同一服务器不能支持整机丢失后的恢复。密钥取自维护者独享的 key file（`openssl rand 32` 生成，保存在仓库与备份目标之外），私钥与密钥内容不进入日志或输出。

恢复必须指向空的隔离目录：`--restore <archive> --key-file <file> --target <empty-dir> --teaching-root <dir>`，脚本解密验签、解包后逐文件核对摘要，并对每个库文件做只读 integrity/外键检查，全部通过才报告 `restored`。密钥错误或归档被篡改时认证失败且目标目录不被写入。接入服务尚未交付，其数据不在本备份范围内，本票不声称全链路备份验收。

日常运行由 `xunjie-backup-daily.timer`（03:00，保留 7 份）与 `xunjie-backup-weekly.timer`（周日 03:30，保留 4 份）触发；按 label 分别清理，只删除本脚本命名的归档。两个备份单元的 `ExecStart` 用 `flock` 持有部署脚本同一把锁（`<workDirectory>/deploy-artifact.lock`），部署与备份、备份与备份互不重叠；换部署配置时需同步单元里的锁路径。恢复演练应在隔离环境（独立目录、无生产配置）执行一次并记录结果，不要在生产数据目录上直接演练。

## 静态资源与资源预算

前端构建产物在 CI 阶段预压缩（`.br`/`.gz` 边车，仅小于原文件时生成），宿主静态处理器按 `Accept-Encoding` 选择边车，不做请求期压缩；带内容摘要的 `/assets/**` 返回 `immutable` 一年缓存，入口 HTML 返回 `no-cache` 并带构建期摘要 ETag，新版本与回退各自引用独立发布目录，不会混用资源。2 MiB 以内的小产物一次写出，更大的文件流式转发，不在业务进程整体读入。回环访问的成员页面转发沿用既有 HTTPS 链路。

资源预算候选值见 `xunjie-shared.service` 注释与[运行策略](../../docs/development-access-operations.md)：业务单元预算需先实测五人峰值再启用；维护单元（发布、备份）已按低 CPU/IO 权重与内存上限配置。部署与备份共用同一把 flock 维护锁串行，业务优先。

## 成员连接入口

页面、API 与原登记节点连接已统一迁入 [xj-dev 模式与受管连接](../xj-dev/README.md#模式与受管连接)。原 PowerShell 连接入口、重复配置解析器和旧 JSON 示例已删除。使用现有获准配置调用 `xj-dev use cloud-api/cloud --connection <file>` 或 `xj-dev node connect --connection <file>`；身份不在配置时传 `--identity <私钥路径>`。

新入口管理隧道监督、严格 SSH pin、HTTPS CA、固定数据目标与隔离 Cookie；节点传输、真实执行业务和模型调用分别报告。它不初始化账号、课程、数据库、VM 或节点 ledger。本目录保留业务宿主、发布、备份及 SSH 服务端权限模板。

维护者按私下部署记录核定实际路径、服务用户、节点绑定和访问权限。应用沿现有35表或显式启用的41表课程库及登记节点启动；两种模式均复用原组合并核对精确表结构；个人模型存储按获准配置启用，不复制旧个人模型库或 Key。运行时配置、机密、数据库、真实公钥 pin 和证书均不随源码分发。

迁移使用 SQLite 一致备份，保留原 ID、账号资料和旧作品；不直接复制活跃主库而遗漏 WAL。最终切换保持唯一业务写库，前后核对完整性、外键及原记录。数据库继续遵守原普通文件与 `TMPDIR` 路径门禁，不在启动时自动迁移。开发环境可通过私有 `allowedLoginUserIds` 将登录限制在获准的教师与学生；虚拟成员仍使用真实课程关系，但不获得登录资格。

成员连接只允许预登记的回环转发；页面身份与执行回连身份分开，禁密码、PTY、agent/X11 和普通远端命令。所有目的地、身份与端口取自获准私有配置，严格验证预先核定的 SSH 主机 pin；不首次自动接受主机，不读取私钥正文，不改全局 SSH。页面本机端口已占用时立即拒绝，不停止或接管已有服务。

业务宿主与执行器可用性分别报告。执行器离线时仍可登录、查看和保存；新运行需当前节点就绪，旧结果、取消及 HDL 后续操作沿原节点绑定核对，不静默改派。当前连接工具与配置模板的删除条件见[替换清理设计](../../docs/development-tooling.md#旧连接实现配置与说明的替换清理)。
