# 开发协作交付核查（#133）

日期：2026-10-24。本文记录本轮实际证据和未完成边界；工程、浏览器、真实模型/节点及教学效果分别判断。正式 main 的合并、发布与资源预算应用由负责人处理。

## 当前证据状态

| 范围 | 已核实结果 | 剩余边界 |
| --- | --- | --- |
| CA 使用说明 | Mac 用户 login keychain、Windows LocalMachine Root 的权限/系统确认、指纹读回与精确移除已入现行说明；跳过 HTTPS 校验不计通过 | fresh Mac 的实际系统认证/正常 Chromium TLS 仍 pending，不以备份 Mac 恢复通过代替 |
| 工程与审查修复 | e03 最终组合：负责人独立 typecheck/build、teaching 556 pass/23 external skip/0 fail；此前9e7的xj-dev181 pass/1 platform skip和eb3专项25/25分别保留。基线、status、CA并发/恢复、gateway生命周期、教师消费者及payloadRef缺陷源码复核closed；40dcc stop guard亦closed | 不同树的重复覆盖不相加，skip不计通过；8f→4288文档两轴复核均无新增确证P1/P2，新文档delta另审 |
| 加密备份与日备 | 已安装工具11/11；真实日备policy仅更新recoveryFiles，保留formal scope/旧回退，覆盖actual e03 cfg、全部9个dropin和22份helper回执 | 更新后的定时任务尚未到下一触发时间；人工新归档/恢复已通过，不冒称新timer已运行 |
| 云端及Mac隔离恢复 | post-capacity/pre-Mac新归档87文件/6库，两端SHA、integrity/FK、4个key长度、3对TLS/CA链、配置/日备覆盖通过；恢复关系为1 active/12 deny、1组active SSH、21份deny device回执，5个容量身份及file-only身份确已revoked/closed | 明确isFinalCurrentSnapshot:false；Mac系统认证/精确撤销后仍须新final快照，各库一致不等于跨存储原子快照 |
| 实际产品隔离 | 先前89文件precleanup恢复中，e03实际CI产物5290项摘要通过，空HOME/最小env、无dev/OSS/account-control/modelnetwork，strict TLS的page/login/session/courses均200；ss16与/proc argv一致 | 本次87文件关系恢复复用该未变化e03证据，未重复产品HTTP；不是新浏览器/真实节点/教学效果验收，也不代表正式main已发布e03 |
| fresh 成员与清理 | Mac已真实join、三模式、编号restore/verify及基线隔离；Windows原报告与独立topup分开，后者真实云端CRUD/UI反馈/active revoke及自有清理通过。5容量身份和file-only smoke身份均已撤销，原key DEVICE_REVOKED，自有listener/私密载荷已清 | Mac正常系统认证及其身份/CA/privatehome清理待完成；旧Windows bulk副本有未提交内容，保持保留 |
| 默认源码采集与签名 | e03默认collectCode 841文件/6,276,679 bytes，guard不变；Windows签名修复worker Mac21/21、Win7/7，lead client/signer18/18，真实原key join成功 | 工程采集通过不替代平台业务验收；源码范围未缩小 |
| 容量与资源 | e03+ss16完整62779aba：3097/3097匹配、普通API3089项p95 262.266ms，按固定500ms口径通过；预算已持久应用/读回，PID/argv未变 | 仅对应固定源码、数据规模和本轮负载；c896/70d失败仍保留，正式d07未重启未发布 |
| 真实模型 | e03两项DeepSeek settled/exactOK、各calls1，actual usage83/14、83/12；历史Mimo认证失败与70d结果分别保留，原正式store未改 | 模型可用不替代真实执行节点或教学效果 |
| 真实执行节点 | 候选未登记execution node，运行/检查正确拒绝未就绪能力；原robert QEMU/WSL保持stopped | 本轮未做真实执行节点互操作 |
| 教学效果 | 未测 | 不由工程或模型可调用性推导 |

## Attempt scope 补丁的固定树验证

70d 延迟失败后，新增显式 attempt scope 读取以减少无关 receipt 水合。默认全课程读取保留；后续 `3d3d3ca` 补齐 event.payloadRef 指向同课程另一 attempt receipt 时的完整校验，避免 scoped 误走对象 fallback。Spec对该P2的最小复核已closed，Standards对固定3d两文件delta亦确认无新增确证P1/P2；均适用于e03组合，不代替其后容量实测。

负责人独立工程 gate 分别对应以下固定源码树；三次是重复验证不同树，计数不能相加，skip 不算通过：

| 固定源码 | 组成与边界 | teaching pass / skip / fail |
| --- | --- | --- |
| `9c7f48818b8d31625c9bbac21a3dadfe1a08569f` | worker 单分支，尚不含 integration 已有 S3 教师消费者修复 | 545 / 23 / 0 |
| `d55e94d2e6118e9557e3a0cbfbf49498b8f17e85` | 吸收 9c 后的组合树，保留 S3；当时 payloadRef P2 尚未关闭 | 554 / 23 / 0 |
| `e03a3c9035282683c1fdcba0d5b5746b8c256587` | 吸收 3d3 后的最终组合树，保留 S3，Spec P2 closed | 556 / 23 / 0 |

e03最终树的typecheck/build、diffcheck和默认collectCode（841文件、6,276,679 bytes、原guard）由负责人独立通过；lead定点gate为13/13，三个S3文件相对d55无差异。以上是源码工程证据，容量结论另见下文。

部署时序已完成：exact e03 CI `40035400632`成功，strictprefetch核对4,787 runtime/503 static文件及Linux x64 Node24.21/native SQLite；随后prepare新配置 `/var/lib/xunjie/capacity-133/application-e03a3c9.json`（0600/xunjie），SHA256 `14cd7c609a1656d558558e18b37a50da1f266f76a841e9575d86e26d2d0a6567`，只改staticDirectory，旧70d配置保留。顺序是strictprefetch/review → prepare → 使用实际cfg SHA的same512 mixed短测 → planned activation，prepare不是短测之后的动作。

实际active root为 `/opt/xunjie/candidates/133-e03a3c9`，显式argv `--max-semi-space-size=16`；candidate/access/formal PID为142780/142786/91972，NRestarts均0，strict TLS/static/source及新PID onResponse指标通过。激活前Backup API副本SHA256 `953751236860111f5e21d97e29eaf16b5e154e033685622b213ce0acbed8563c`与commonseed相同。planned restart单独记录；正式d07的PID/原argv未变。完整62779aba窗口之后才应用预算和采集下述两个新归档，测量中未做手动snapshot或额外业务登录。

## 备份与恢复实测

新增配置保留原正式课程库、原个人模型及签名/TLS/执行连接恢复材料，额外登记 candidate 课程库、原候选/新候选个人模型 store 与 key、account-control registry/config、access SQLite/credential.key、服务与系统配置、TLS/公开 CA、受管 SSH 公钥映射与固定 helper 回执。完整字段契约见[备份说明](../../tools/i0-cloud/README.md#加密备份与隔离恢复)。

云端归档 `closeout133-20261023T185305Z-204247a0.xunjiebak` 为 558,241 bytes，SHA256 `907024a2cbe131db2b47d9ca7b5253289aee2d9a04b52c2371bd5e34e512a154`。它包含 71 个文件、6 个经 Backup API 复制并校验的 SQLite 库；加密 key 本身不在归档中。独立恢复使用新的目录、业务端口 18444 和 account socket，模型网络调用关闭、执行节点为空；实际 `/health/ready`、登录、session、课程读取均 200，所属进程已停止。

3 个模型存储的凭据解密计数为原正式 3、原候选 0、新候选 2。access 对应 key 能解密 15 个成员凭据，核对 6 个 active account-control 身份及 5 个 deny 状态；这些是该次采集的观察数，不是永久成员清单。6 个 active SSH 映射与 helper 回执核对，TLS 私钥/证书匹配且 access CA 验签通过。每个库独立一致，配置/公钥映射分别采集；这些关系在该次恢复中通过，不等于跨存储原子快照。

负责人 Mac 已独立验证同一归档：71 个文件 SHA 全匹配，6 库 integrity/FK、4 个凭据 key 长度和 3 对 TLS key/cert 通过，明文已清理。加密归档与独立受限 key 副本保留在 backup-recovery；证据为 `main-mac-independent-verification.json`、`main-mac-independent-restore.json`。

这份归档采集于切换前，业务 source 为 `fb5830e`；新 capacity 模型是当时的准备材料，不据目录存在宣称已激活。之后新建的 `133-runtime.conf` 与最终容量 budget dropin 尚未在此归档中。最终 scope 必须从运行中 unit 的 effective ExecStart/DropInPaths、实际配置、source 与 limits 读回，连同 dropin 原路径映射再采集新归档；不得用旧归档声称恢复了新 runtime/预算。

在70d阶段，live backup配置已登记`133-runtime.conf`，并将当时实际存在的 `/var/lib/xunjie/capacity-133/application-70d170a.json` 独立映射为 `candidate/capacity/application-70d170a.json`；旧 `application.json` 保留为 c896 回退材料，未创建的 1aa 配置未登记。新配置为 0600/xunjie，摘要 `5720f0e3cceca68386f1c0075f6ab09bed2616ba69167b3facd5ef63dd0dc4b0`，该阶段模型目录/key为capacity独立store，T/S1已是DeepSeek revision2。该次操作只更新覆盖范围，当时尚未取新归档。之后e03容量通过和预算持久读回均已完成，真实日备覆盖及新恢复结果见下节。未创建的1aa配置始终未登记。

e03激活及905测量期间未改live policy；预算应用后的89文件precleanup仍使用独立policy副本。五容量身份退休和file-only smoke结束后，main开放独占窗口，才实际补齐daily policy并取87文件post-capacity/pre-Mac归档。这两个归档的时点与policy变更审计分别保留，不倒写旧快照。

成员私钥仅在成员设备。access CA signing key 留在 owner 本机受限目录，不在服务器归档；服务器归档包含现行公开 CA、TLS leaf 私钥和证书。保留 owner 独立受限副本或重新签发/邀请的恢复策略，不能声称从服务器备份恢复了成员私钥或 owner CA signing key。

脱敏证据集中在负责人本机 `~/.codex/artifacts/xj133-closeout/`：`cloud-backup-configuration.json`、`cloud-encrypted-backup.json`、`cloud-restore.json`、`cloud-restore-relations.json`、`product-isolation.json`。进度入口为 `~/.codex/artifacts/xj133-closeout-progress.json`。证据不含 key/token/password；实际归档与恢复材料走受限管理路径。

### e03 预算应用后的 precleanup 归档

该次独立操作明确为 `precleanup-as-of-now`，采集时Mac系统认证及五个临时成员/端口清理尚未完成，`currentSnapshotCleanupConfirmedByOwner:false`、`isFinalCurrentSnapshot:false`。final脚本及其cleanup guard字节未改；precleanup使用独立scope/config副本、归档label、恢复目录和回执。global日备policy未改，也未撤销任何成员。之后撤销或新业务写入会使本归档成为历史状态，不能直接改名冒称final current。

密文 `precleanup-be6e7-20261023T233033Z-b2609e78.xunjiebak` 为2,503,704 bytes，SHA256 `dbbe16c144c33ee597c697879e508bd2bb64816b5daf8b02abc70554ff54dcdb`。原正式scope、70d/c896回退配置与模型材料保留，新增实际e03 cfg、133-runtime及8个system.control budget dropin；89文件、6库均经安装版Backup API/AES工具处理。备份key本身不入包，未复制服务器key。

独立恢复核对89文件摘要、6库integrity/FK；原正式/原候选/当前候选模型凭据分别解密3/0/2项，access key可解密18项成员凭据，registry对应6个active和7个deny账号；6组active SSH公钥映射、21份helper回执及3对TLS关系通过。这是采集时状态，不是永久成员清单，也不等于跨存储原子快照。

同一恢复中启动actual e03 artifact：5290项runtime/static摘要、禁止路径检查通过，空HOME、仅PATH/HOME/NODE_ENV，恢复的正式DB与签名/TLS、无dev/OSS/account-control/modelstore/执行节点。批准owner-local现行普通账号仅经内存stdin，strict TLS的ready/page/login/session/courses全部200，返回e03 source，零模型网络调用。自有子进程146516已停、18446端口释放；三个私有明文目录、临时app cfg及远端payload精确清理。只读postflight确认原三个live unit/PID/ExecStart/limits、e03 cfg和9个dropin及global日备policy均未变。

本机密文与manifest/关系/product/清理回执位于受限 `~/.config/xunjie-cloud/backup-recovery/precleanup-133-e03a3c9-20261024-be6e716e/`（目录0700、文件0600），main已独立Mac恢复通过89文件SHA、6库、4个key长度、3对TLS、9个dropin及e03配置，恢复明文已清理。操作脚本与摘要为 `~/.codex/artifacts/xj133-precleanup-e03-20261024-be6e716e/result-summary.json`、`postflight-readonly.json`；原71文件归档与c896隔离证据保持原样。最终仍待Mac认证、精确撤销和清理后重新采集final snapshot。

### 五成员退休后的当前日备与新归档

2026-10-24北京时间07:55，lead在main明确放行的独占窗口仅更新 `/etc/xunjie/backup.json` 的 `recoveryFiles`，phase为 `current-precleanup`。更新前SHA256 `06d2282a5c1dc05132cbf3176bb3eeb7f08224b2ad426dbbb3d44ceeeb68fcb1`，更新后 `f6fb30a0e3834de9005b31bd5bcde6f066a1de23daa63f4e0bc9d5c22459d891`；原formal scope、数据库/模型目录、所有旧recovery entries和70d/c896回退配置保持，未登记不存在的1aa配置。新增actual e03配置、全部9个有效dropin（包括8个system.control预算文件）及重新枚举的22份helper回执。文件原有root:root/0600保留，原bytes在受限证据目录保留，低磁盘检查通过；没有重启或修改成员。

随后用安装版Backup API/AES工具新取 `postcap-b0503-20261023T235518Z-b0d8cb9c.xunjiebak`，2,506,489 bytes，SHA256 `c90033ef5b4f35016f8b730edd34b4634b5c294952632d1fda49de878e03e0c3`。它明确标为 `post-capacity-pre-Mac-as-of-current`、`isFinalCurrentSnapshot:false`、`MacAuthPending:true`，未传owner-cleanup-confirmed。87文件较旧89文件减少，是五个已退役SSH映射被删除、增加一份helper回执及本次独立操作证据，并非遗漏formal/rollback恢复范围；逐路径差异在独立回执保留。

云端新隔离目录及main独立Mac恢复均通过87个SHA、6库integrity/FK、4个32-byte key、3对TLS/CA链、9个dropin、e03配置与真实daily policy覆盖；模型凭据解密仍为3/0/2，access为19项，registry为1 active/12 deny，1组active SSH和21份已deny device回执对应。直接查恢复库确认五容量成员和file-only成员revoked、设备closed，五应用身份disabled；Mac是唯一active registry身份，3059条receipt、232条submission等历史保留。备份key不入包，使用Mac原有独立key，不从ECS取key。

本次未启动额外产品进程或重复HTTP/模型请求，沿用未变化e03产物在89文件恢复时的普通产品隔离证据。云端恢复明文和上传payload、main的Mac恢复明文均已精确清理；密文/manifest/回执仍保留在受限 `~/.config/xunjie-cloud/backup-recovery/postcapacity-133-e03a3c9-20261024-b05035df/`。操作与独立Mac回执为 `~/.codex/artifacts/xj133-postcapacity-e03-20261024-b05035df/result-summary.json`、`main-mac-independent-verification.json`；postflight确认三服务PID/argv/limits、e03配置及9个dropin未变，live policy与归档内正式policy副本摘要相同。原precleanup的liveDailyPolicyWillBeChanged:false审计保持字节不变。

这份新归档是五成员退休后、Mac认证前的当前状态。Mac系统认证及其精确撤销/清理仍pending，之后必须再取新final快照；Mac解密恢复通过不代表浏览器系统信任通过。日备policy覆盖已生效，未等待Mac认证，也未把人工归档成功冒称更新后的timer已再次运行。

## 产品产物与运行态边界

初次产品隔离采用已严格预取验证的不可变目录 `/opt/xunjie/candidates/133-c896c52`，核对 4,787 个 runtime 和 503 个静态文件摘要。测试子进程仅获得 PATH、空的独立 HOME、NODE_ENV；不读取成员 connection/邀请、OSS 配置或 access account-control socket。测试操作者从隔离备份取得既有身份用于实际登录，产品子进程只使用普通应用配置与隔离业务库，未调用接入服务取得登录权限。

70d 窗口使用的实际候选为 `/opt/xunjie/candidates/133-70d170a`，source `70d170ab6a7665a973d514b28eedb5a0532d17ee`；负责人已核对 CI binding、摘要、native SQLite、静态及健康接口。当时计划切换后 candidate/access/formal PID 分别为 131947/131948/91972，restart 读回均为 0。与原 capacity 配置相比，新配置只更改 staticDirectory，复用同 DB/TLS/Origin/model store。后续 CLI、harness 和文档至 55ed 的产品运行文件相对 70d 零差异；harness 也不进入 runtime 装配清单。6e9a 窗口固定这份产物与原历史数据，不能将其结果改记为后续 e03。

正式 d07 旧产物实例与兼容部署器继续保留；首个 bound main Release 尚未由负责人发布，不能提前用 strict candidate 部署器覆盖正式部署器。现行 access source `3825f98d20ae470e8ee3febaa7cc0bbb51c38382` 与私有 OSS 目录作为团队入口保留，不能为了清场删除唯一可用服务或已发布包/基线。资源预算现已依据e03完整实测持久应用/读回，不以历史MemoryPeak或空闲采样代替；正式d07没有因此重新发布。

## 容量证据与预算边界

e03 完整窗口 `62779aba-a131-476b-ab7b-bf5fdedd3de2` 已完成；北京时间2026-10-24 06:56:09.246 steady 至07:11:23.691完成收束，914.445秒，`executionDrained:true`。实际source `e03a3c9`、harness `capacity-run.mjs` SHA前缀 `5198feda`、cfg `14cd7c60…`、ss16起终一致；candidate/access/formal PID仍142780/142786/91972，restart均0。后面的70d/c896失败证据保持历史来源，不改记为本次成功。

| e03 测量 | 实际结果 | 判断边界 |
| --- | --- | --- |
| 服务端普通API | 3089项（含5次正常登录和完整workbench），p95 262.266ms；3097总请求全部200，missing/duplicate均0 | 按原500ms总体p95口径通过；129条workbench p95为401.488ms，登录单独p95仍879.646ms，不声称每次请求都低于500ms |
| 业务读回与历史 | 新增436次save、45次幂等重放、71次submit/feedback；API与独立只读DB审计的base+delta、hash/version吻合，integrity ok/FK0 | 旧2124条receipt/audit、326 snapshot、161 submission/feedback逐行摘要missing/changed均0；增长至3059/3059/470/232/232，历史未清空 |
| 模型与传输 | 两项真实DeepSeek settled/exactOK、各calls1，actual usage83/14、83/12；两次OSS 6,273,409/6,274,156 bytes均published，3.651/3.221秒 | 实际产品调用与传输结果，不替代真实执行节点/教学效果 |
| candidate资源 | 184个窗口采样覆盖登录和收束；sampled memory.current最大169.93MiB，cgroup lifetime peak从201.19增至329.15MiB；平均CPU48.986%单核 | 短scrypt峰值会被采样遗漏，使用cgroup peak保留；测量时MemoryHigh仍infinity、MemoryMax512MiB |
| access与宿主 | access sampled最大43,728,896 bytes、peak44,814,336 bytes；host MemAvailable最低953,126,912 bytes（908.973MiB）；PID/restart/OOM/max/high均无增量 | 测量时access MemoryMax256MiB；worker初始预算建议与负责人最终选择分开记录，不能据建议声称已应用 |

原始证据为 `~/.codex/artifacts/xj133-capacity/20261024-e03a3c9-62779aba/` 的请求/服务端指标、资源样本、`independent-db-audit.json`、`retained-history-audit.json` 和 `postflight-runtime.json`。lead仅离线重算requestId关联/p95、184样本内存/CPU/host最低值，并核对前轮base及API/DB审计关系，结果在 `~/.codex/artifacts/xj133-closeout/lead-e03-62779-evidence-recalculation.json`；没有由lead重新查询云DB。负责人独立raw gate亦通过，`main-independent-verdict.json`可直接满足最终scope的成功verdict契约；worker最终报告和33文件seal已收齐，main与lead逐项核对SHA。worker负载/采样/审计已停；预算实际读回、五actor精确退休和新post-capacity归档/两端恢复均已完成。Mac系统认证/其身份清理及之后的final快照仍单独pending。

负责人据本轮实测确定：正式shared模板在`[Service]`内启用CPUWeight200/MemoryHigh512M/MemoryMax768M，access模板High128M/Max256M并保持TasksMax64。该依据是candidate本轮含登录的329.152MiB cgroup peak与真实五人负载，不用formal旧283MB idle峰。现行formal仍旧d07、PID91972/原argv，未重启未发布；负责人已以持久`systemctl set-property`应用正式512/768+CPU200，没有安装替换formal unit或发布器。当前candidate仍使用更严格Max512M，High448M/CPU200；access为High128M/Max256M、Tasks64。实际properties与内核memory.high/max/cpu.weight一致，high/max/oom/oom_kill累积均0，所有PID/ExecStart不变；回执为 `~/.codex/artifacts/xj133-resource-budgets-20261024/applied.json`，有效预算dropins位于 `/etc/systemd/system.control/<unit>.d/50-*.conf`，最终scope必须完整收录。

下一次安装shared新模板，ExecStart才默认采用已在e03验证的`--max-semi-space-size=16`；正式现行argv没有据此改变，candidate实际已使用ss16。这两个unit模板不在产品runtime清单内，本次更新不重建e03产物。

完整来源、业务基数/增量审计、模型与 OSS、失败和隔离诊断见[容量 worker 报告](../../tools/i0-cloud/capacity-133-report.md)。`adc8ab2` harness 原 8/8 通过后，两轴分别确认上传错误独立记录与异步失败收束两项 P2；`4e79a80` 修复已合入 `55ed4dd`，lead 与负责人各自 11/11，包含 3 个真实业务工厂加受控外部依赖的故障用例。Spec 原 P2 已复核 closed；Standards 另确认 await pause 返回后、publish 前须再检查 stop。Aquinas 在本次实测结束后以 `40dcc9e` 补此 guard，运行中的文件未修改；确定性交错测试证明等待已 fulfilled 后 fatal 先到时不会 publish，失败首因与终态不变。worker全harness12/12、lead四项故障回归4/4，Standards已在固定40dcc最小复核确认最后stop边界closed。该guard随后包含在e03本轮harness中，不倒写旧6e9a的4e79实际hash。18 个原 JS 与 1 个 Python 语法通过，20 个原新增文件及 4e/40dcc 的改动文件通过原秘密扫描。

Windows 补验和清理完成后，负责人放行的实际 run 为 `6e9a5416-e0b1-4866-8f5d-a4513687dee7`，steady T0 为 2026-10-23 21:14:32.768 UTC（北京时间 2026-10-24 05:14:32.768），21:29:56.575 UTC 完成；905 秒业务窗口连同 drain/audit 共 923.807 秒。实际 harness 为 `4e79a80`；lead 从 run.json 核对三个 harness 文件均与该固定提交摘要一致，并从原请求和服务端记录重算得到同样的汇总。该轮无 fatal，未触发上述晚到 pause 的失败分支，后续 guard 不冒称是本轮已运行版本。

新窗口 3227/3227 个 requestId 匹配，missing/non2xx/5xx 均为 0；普通 API 3219 项 p95 **1053.110ms，仍超过 500ms 目标**。四个原自有 attempt 按 base 加 delta 增加 465 次保存、48 次保存幂等重放、77 次提交及反馈；worker 的独立只读 DB 审计通过 exact version/hash/receipt，integrity ok、FK 0。两次真实 OSS 分别为 6,273,409/6,274,156 bytes，耗时 4.534/3.159 秒，均 published。两项 DeepSeek 实际产品 turn 均 settled/exactOK、calls1，各为 actual usage 83 input/2 output。`completed/executionDrained:true` 与这些正向结果不能抵消延迟失败。

资源摘要覆盖执行起止附近的 184 个采样、927.448 秒；最后摘要采样比执行完成早 2.119 秒，完整 192 行含完成后的点并另行保留，不声称连续覆盖每一瞬间。candidate 平均 CPU 125.58%（单核百分比），5 秒采样 `memory.current` 最大 165.781MiB；lifetime peak 从 245.027MiB 增至 339.930MiB，包含本轮正常登录峰，不能用稀疏采样最大值替代它。access current 最大 42.961MiB，host available 最低 913.531MiB。candidate/access/formal PID 均保持 131947/131948/91972，restart 0，OOM/max/high 增量 0，配置摘要保持 `5720f0e3…`。该轮结束时负载及sampler已停止，因延迟失败而没有应用预算或提前snapshot；之后e03成功窗口/预算/归档另记，不能倒写为70d通过。

本轮证据目录为 `~/.codex/artifacts/xj133-capacity/20261024-70d170a-6e9a5416/`，包括 `run.json`、`server-summary.json`、`resource-summary.json`、`independent-db-audit.json`；`sealed-evidence-sha256.json` 封存 16 项原始文件，lead 已逐项核对长度与 SHA。lead 的本地原始记录重算与固定 hash 核对为 `~/.codex/artifacts/xj133-closeout/lead-70d-6e9a-evidence-recalculation.json`，封存核对为同目录 `lead-6e9a-seal-verification.json`。后续诊断或复测须保留这次失败、原历史规模和统计口径。

下表只引用旧 c896 完整窗口，不能替代新 70d 验收：

| 测量 | 旧完整窗口结果 | 解释 |
| --- | --- | --- |
| 普通 API 延迟 | 3484 项，p95 1090.234ms | 超过 500ms 目标；3503 项总请求含模型，并全部匹配服务端 requestId |
| candidate CPU | 平均 116.34%、最高 5 秒段 154.24%（单核百分比） | 同步读取/重复验证及 GC 热点另有隔离 CPU profile |
| candidate 内存 | 采样 `memory.current` 最大 143.88MiB；lifetime peak 326.88MiB | lifetime 值包含窗口前历史，不当作本次峰值 |
| access/host 内存 | access current 最大 40.68MiB；host available 最低 892.25MiB | 该旧窗口host available高于512MiB；其后各轮重新采样，e03数据另列 |
| 进程与 OOM | PID/restart 无变化；OOM/max/high 增量 0 | 计划的产物切换在窗口外单独记录 |

保留原 1103 receipt 一致副本的两次 40 秒诊断都为 212/212 服务端记录、零 non2xx/5xx。a8 单项补丁普通 API p95 460.129ms、workbench 中位数 499.312ms/五并发尖峰 1182.841ms；加 2b hydration 后分别为 332.875ms、169.010ms/782.469ms。它们支持严格构建/激活后的完整复测，尖峰与来源继续保留。这两次短预检时沿用业务512MiB/access256MiB，access High128MiB当时只是建议；后续实测及实际持久预算见e03部分，不把当时建议当作已经应用。

原 Windows 已撤销成员通过原 key refresh 实际得到 `DEVICE_REVOKED`；当时六个环境已 down/delete，因此原 partial 报告没有活隧道/Session 失效覆盖，原报告与其摘要保持不变。

新增 Windows topup 使用独立 home/member、自有云任务，client `eb3d5fc`、实际 server `70d170a`。真实 Edge 严格 TLS 下完成保存 200、冻结 200、显式固定版本提交 200，并从学生 UI 读取教师反馈 revision 1。2026-10-23 20:52:57 UTC 在 gateway/Vite/SSH/Session 仍存活时发出 ready，负责人 20:54:35–20:54:37 UTC 撤销；原浏览器 Session 与自有 attempt 请求实际返回 `503 PERMISSION_REVOKED`，原 SSH 退出、supervisor stopped/retryable=false，重试计数 2 在后续 196.556 秒内稳定；原 key refresh 得到 `DEVICE_REVOKED`。没有观察到直接 backend 401；缓存页面和已显示反馈仍可读，云端数据访问已阻断。所有拒绝读回完成后才 teardown，未重放浏览器写入。

Windows topup 最终 21:01:46 UTC 读回：本次 topup 自有进程、新增 CA trust、DB 载荷和敏感材料均为 0；专属 clone/邀请/identity/CA 目录已移除，永久锁守卫和共享历史保留。这只覆盖 topup 专属范围，不包含旧 bulk 测试副本。完整补验与 35 个引用证据校验见仓库外 `~/.codex/artifacts/xj133-windows-topup-20261024/topup-report.json`、`evidence-validation.json`；它们补充原报告，未重跑或改写原完整验收。真实节点、模型及教学效果不在该补验范围。`CLOUD-UI-01`（个人资料静态身份/本地来源文案与云首页不一致）作为 fresh 报告的未修观察保留，没有据此证明服务端泄漏。

## 旧入口核对与清理边界

活跃代码/文档扫描排除 `docs/archive/`、`node_modules/`、`dist/`。原 PowerShell 成员连接、旧本机宿主、源码构建 `sync-main.py` 与单元已退役；云端只读确认旧脚本不存在、`xunjie-main-sync.timer` 为 not-found。当前 `xunjie-release-deploy.timer`、备份 timers 与业务/接入服务保留。

`tools/i0-cloud` 的业务宿主、正式旧协议发布器、备份和节点准备仍有实际用途，保留；`connection.mjs` 对既有批准 owner 配置的只读适配继续用于维护兼容，不恢复手工成员接入流程。仓库外连接 README 已改为当前 invite/join/use 入口，只改 XunJie 说明；owner SSH、accounts.private.txt、backup-recovery 及其他项目未改。用户原 root.zcode、无关分支和已 stopped 的 robert QEMU/WSL 不在清理范围。

Nash 的旧 Windows 副本只读库存为 `~/.codex/artifacts/xj133-windows-residue-inventory.json`：`D:\xj126-shepherd-20261023\repo` 仍有24项已跟踪改动和19个未跟踪文件，未证明可丢，整个副本及依赖保留。Ubuntu 保持 Stopped，`/home/wubq/xj126-134-linux` 当前是否存在未知，未启动或挂载以补查。旧私有测试载荷的生命周期、目标 cwd/打开句柄覆盖仍有未知，独有日志及恢复证据已列出并在原位置保留；不能宣称 Windows 旧 bulk 测试副本已全部清干净。清理仅覆盖可证明属于本轮且已无用的对象，保留未提交内容符合当前范围。

库存本身遗留的 probe PID38920 经创建时间、可执行文件、父子关系和自有代码摘要核对后精确终止，launcher PID48992 随后也读回 gone；未触碰 parent PID47464、产品进程或 WSL，没有删除 Windows 文件。独立收尾回执 `~/.codex/artifacts/xj133-windows-residue-inventory-self-cleanup.json` 保留两次尝试及最终 gone 读回，原库存和证据未改。此处仅确认这两个库存进程的结束，不据此推断未知旧载荷或句柄已消失；通用 SSH、有效恢复材料、用户 root.zcode 和无关分支继续保留。

本轮隔离进程和明文恢复目录已清理。早期入口清理的file-only smoke证据为`post-cleanup-smoke.json`，按当时时点保留。e03容量结束后另做精确退休：五个原member/device及应用身份逐项核对后deny/closed/disabled，原key真实CLI refresh全部DEVICE_REVOKED，23444–23448 listener全部消失，四个attempt hash/version和五表历史保持。随后经同一持久入口，用全新file-only成员真实join/fetch原已发布编号，cacheHit:false、6,273,409 bytes、SHA256 `6af6feecd0bc5931a67ce51810282fa8f41fa320a3216520ca25f93cfa56eb8f`校验通过；无SSH/应用权限，不做restore/verify。smoke成员随后revoke/system deny，私钥/邀请/cache精确删除。合计清90个私密临时文件，只留10个永久锁guard，inode/hash保持；Mac身份/privatehome/CA与业务、模型、OSS、基线及owner入口保留。撤销时已签URL尚余296741ms，按已有有效期事实记录，未轮询到期，不宣称撤销立即使已发URL失效。证据为`~/.codex/artifacts/xj133-retirement-20261024/retirement-final-receipt.json`及`quiet-window-release.json`。

真实 daily timer 已在 2026-10-24 03:00:26–03:00:27 使用当时扩展的备份配置完成，`Result=success`、`ExecMainStatus=0`；它早于 70d 配置登记，不声称已包含后来的材料。周备 timer 保持 active，未额外制造第二次周备。e03容量已按固定口径通过，预算已持久读回，actual e03普通产品隔离及新的日备覆盖/post-capacity归档两端恢复通过。当前只剩Mac正常系统认证/精确撤销及其后新final快照等明确边界，不再把已完成预算与恢复列为待收齐。独占云窗口已结束；仅预取未激活的133-1aa9675精确归属/引用核查及有条件删除另待main协调下一窗口，未因清场扩大删除70d/c896/e03或恢复材料。
