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

服务器不再构建源码。发布链路是：CI 在 `main` 每次推送后用 ubuntu-24.04 x64 + Node 24.21.0 构建（[cloud-release workflow](../../.github/workflows/cloud-release.yml)），`build-runtime-artifact.mjs` 装配与运行目录相同布局的产物（前端 dist 含 `.gz`/`.br` 预压缩与 `asset-digests.json` 摘要表、teaching 生产依赖含 linux-x64 原生模块、后端运行源码），写出 `manifest.json`（来源提交、git tree、平台、Node 版本、逐文件 sha256 与字节数、入口摘要、tarball 摘要）并作为 `cloud-<commit>` 标签的 GitHub Release 资产发布（先 draft 后发布，保证原子可见）；同一产物还 force-push 到 `cloud-artifacts` 孤儿分支，供服务器经 codeload 拉取（Release 资产 CDN 在服务器所在地域不可达，codeload 通道实测满速；孤儿分支每次整体替换，仓库不累积产物历史）。CI 侧只保留最近 5 个 `cloud-*` Release。

`deploy-artifact.py` 在服务器上只做校验、备份、装配与切换：

1. 经 GitHub API 核对 `main` HEAD 提交与 tree，按 `cloud-<commit>` 查找已发布 Release；产物未就绪时返回 `blocked`/`ARTIFACT_PENDING`，业务保持现状。
2. 从 `codeload.github.com` 流式拉取 `artifactBranch` 分支 tarball（总量上限 1 GiB + 8 MiB），解出 manifest 与 runtime tarball，核对 tarball 摘要后解包到受控 staging（仅允许 `apps/student`、`apps/teaching`、`tools/i0-cloud/cloud-host.mjs` 路径），逐文件重算 sha256 与 manifest 精确比对，入口 HTML/JS 规则与静态摘要表也必须一致。
3. 磁盘可用空间低于 `minimumFreeBytes`（建议 5 GiB）时拒绝下载与装配（`blocked`/`LOW_DISK`），低于 `warningFreeBytes`（建议 10 GiB）只告警；已有业务不受影响。
4. SQLite 一致备份当前库（保留最近 `keepBackups` 份部署备份），切换 `current` 符号链接、重启服务，并用 `/health/live`、`/health/ready` 与实际返回的 index/入口 JS 摘要做健康探测；失败自动切回上一个 release 并重启、复测。
5. 成功后按保留策略清理发布目录：当前版本 + 最近 `keepReleases - 1` 个可回退版本 + 带 `.pinned` 标记的固定版本；清理只作用于部署脚本拥有的 `main-<commit>` 目录，不触碰业务数据、备份目录或外来文件。发布与清理由同一 flock 串行，备份单元复用同一把锁（见下）。

每 5 分钟的定时运行在已是最新时不重新哈希整个运行目录：只按 manifest 逐文件记录的路径与字节数做 stat 形状比对，再探测健康；内容级校验发生在每次下载装配新产物时（逐文件 sha256）与健康探测（实际返回的 index/入口 JS 摘要）。

发布信任边界：Release 发布权限与 `main` 推送权限等同（GitHub contents:write），摘要校验防护传输与装配损坏，不改变来源信任；构建成功不等于发布成功——只有健康探测通过才算部署完成。发布不初始化或迁移业务数据，不合并代码。

服务器迁移（替换旧 `sync-main.py` 源码构建路径）：复制 `deploy-artifact.py` 与 `backup-retained.mjs` 到 `/usr/local/lib/xunjie/`（两者都是服务器基础设施，不随业务产物分发），部署配置改为下表字段（删除 `buildUser`），安装 `xunjie-release-deploy.service/.timer` 与备份单元后 `systemctl disable --now xunjie-main-sync.timer` 并删除旧单元与 `/usr/local/lib/xunjie/sync-main.py`；脚本会自动清掉工作目录里旧构建残留（`source-*.tar.gz`、`npm-cache`、`sync-main.lock`）。合并本分支的 `main` 推送需先等一次 `cloud-release` workflow 产出 `cloud-<commit>` Release，再切换服务器单元。

| `deploy-artifact.py` 配置字段（仓库外 `/etc/xunjie/deployment.json`） | 说明 |
| --- | --- |
| `repositoryUrl` / `releasesDirectory` / `currentLink` / `workDirectory` / `nodeBinDirectory` / `applicationConfigFile` / `applicationService` / `healthUrl` / `statusFile` / `backupDirectory` | 与原部署配置同义；`nodeBinDirectory` 仍用于部署前 SQLite 一致备份 |
| `artifactTagPrefix` / `artifactBranch` | CI Release 标签前缀与产物镜像分支名，当前为 `cloud` / `cloud-artifacts` |
| `minimumFreeBytes` / `warningFreeBytes` | 低磁盘拒绝/预警阈值（字节） |
| `keepReleases` / `keepBackups` | 可回退发布目录数（含当前）与部署备份数 |

`--status` 输出远端/已部署提交、健康、磁盘与内存水位、CPU 核数与负载、发布与备份清单、上次部署结果和 `actions` 维护建议；接到既有云监控即可（建议告警：发布单元失败、`status=failed`、磁盘越过两级阈值、`MemAvailable` 低于 384 MiB、负载持续超过两倍核数、业务服务非 active）。低磁盘恢复动作用 `--prune` 只执行清理。

## 加密备份与隔离恢复

`backup-retained.mjs` 把课程库（SQLite Backup API 一致副本，前后做 integrity/外键检查）、个人模型存储目录（库文件一致副本 + 密钥材料原样复制）和 `extraFiles`（签名密钥、TLS 材料、应用配置）打成 tar 后以 AES-256-GCM 加密写入 `outputDirectory`，文件名 `<label>-<时间>-<随机>.xunjiebak`（0600）。密钥取自维护者独享的 key file（`openssl rand 32` 生成，保存在仓库与备份目标之外），私钥与密钥内容不进入日志或输出。

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
