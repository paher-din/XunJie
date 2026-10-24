# 开发协作交付核查（#133）

日期：2026-10-24。本文记录本轮实际证据和未完成边界；工程、浏览器、真实模型/节点及教学效果分别判断。正式 main 的合并、发布与资源预算应用由负责人处理。

## 当前证据状态

| 范围 | 已核实结果 | 剩余边界 |
| --- | --- | --- |
| CA 与fresh Mac | fresh Chrome新profile正常TLS1.3/200，无HTTPS忽略/CDP绕过/注入anchor，actual根与保留F748 CA匹配；Mac本次证书及user trust已按精确SHA256加`-t`清除，main独立读回PASS | 辅助native SecTrust/security verify仍false，保留差异，不写成全部native工具通过；浏览器PASS不由备份恢复推导 |
| 工程与审查修复 | e03 最终组合：负责人独立 typecheck/build、teaching 556 pass/23 external skip/0 fail；此前9e7的xj-dev181 pass/1 platform skip和eb3专项25/25分别保留。基线、status、CA并发/恢复、gateway生命周期、教师消费者及payloadRef缺陷源码复核closed；40dcc stop guard亦closed | 不同树的重复覆盖不相加，skip不计通过；后续cold fetch/recovery及f8健康修复见下节，公开verify严格TLS修复和最终文档delta仍分别验收 |
| 加密备份与日备 | 已安装工具11/11；最终日备仅增补recoveryFiles，实际覆盖e03配置、9个dropin及24份helper，原formal scope/70d/c896回退均保留；live policy SHA为62997d3f…475d2a | 新策略未到下次timer触发，不把人工归档成功算作定时器再次执行；备份key自身不入包 |
| 云端及Mac隔离恢复 | final current密文90文件/6库，云端及main独立Mac恢复均通过全部SHA、integrity/FK、4key长度、模型/access AES、3对TLS/CA、9个dropin/e03配置/真实日备覆盖；9目标身份均retired、24helper对应；明文及payload已清 | 历史71/89/87文件归档保留原时点与原审计；各库一致不等于跨存储原子快照，独立设备副本不等于离线介质 |
| 实际产品隔离 | 89文件precleanup恢复中，e03实际CI产物5290项摘要通过，空HOME/最小env、无dev/OSS/account-control/modelnetwork，strict TLS的page/login/session/courses均200；ss16与/proc argv一致；final再次核对产物摘要未变 | 后续87/90文件关系恢复复用该未变化e03证据，不重复产品HTTP；不是新浏览器/真实节点/教学效果验收，也不代表正式main已发布e03 |
| fresh 成员与清理 | Mac107完整报告及main独立清理PASS，本地学生闭环、teacher云端draft/三模式/HMR/Cookie/CSRF边界通过；Windows原报告与UI topup分开保留。5容量、旧smoke、Mac及2个code-proof身份已精确退休，原key拒绝；两端自有环境/私密载荷清理及main release均完成 | Mac teacher-only云邀请未覆盖cloud student完整闭环，本地baseline完成该闭环；旧Windows bulk副本有未提交内容，继续保留 |
| Windows unpublished/dirty组合 | Testing6、f8健康修复与固定2c0cead公开strict verify均由main独立通过；同原ID/包SHA/841源码、真实200→409，全部3请求strict CA/TLS1.3 authorized；两轴TLS P2 closed。两身份/邀请revoked、close_ready=1、helper denied，原key拒绝；36项seal及两端清理已核 | 保留旧版两次use local误报、旧公开verify关闭TLS校验的失败历史，后者不计strict TLS通过；fixture源码未合integration/main |
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

e03激活及后续postflight回执中的active root为 `/opt/xunjie/candidates/133-e03a3c9`，显式argv `--max-semi-space-size=16`；candidate/access/formal PID为142780/142786/91972，NRestarts均0，strict TLS/static/source及新PID onResponse指标通过。激活前Backup API副本SHA256 `953751236860111f5e21d97e29eaf16b5e154e033685622b213ce0acbed8563c`与commonseed相同。planned restart单独记录；正式d07的PID/原argv未变。完整62779aba窗口之后才应用预算并分阶段采集下述归档，测量中未做手动snapshot或额外业务登录。此处PID是对应回执时点；final窗口已重新读取实际unit/proc并在postflight确认PID/argv/limits不变。

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

本机密文与manifest/关系/product/清理回执位于受限 `~/.config/xunjie-cloud/backup-recovery/precleanup-133-e03a3c9-20261024-be6e716e/`（目录0700、文件0600），main已独立Mac恢复通过89文件SHA、6库、4个key长度、3对TLS、9个dropin及e03配置，恢复明文已清理。操作脚本与摘要为 `~/.codex/artifacts/xj133-precleanup-e03-20261024-be6e716e/result-summary.json`、`postflight-readonly.json`；原71文件归档与c896隔离证据保持原样。该归档之后Mac实际验收、code-proof组合和双方精确清理均已完成，随后另取下述final快照；不倒改本归档审计。

### 五成员退休后的当前日备与新归档

2026-10-24北京时间07:55，lead在main明确放行的独占窗口仅更新 `/etc/xunjie/backup.json` 的 `recoveryFiles`，phase为 `current-precleanup`。更新前SHA256 `06d2282a5c1dc05132cbf3176bb3eeb7f08224b2ad426dbbb3d44ceeeb68fcb1`，更新后 `f6fb30a0e3834de9005b31bd5bcde6f066a1de23daa63f4e0bc9d5c22459d891`；原formal scope、数据库/模型目录、所有旧recovery entries和70d/c896回退配置保持，未登记不存在的1aa配置。新增actual e03配置、全部9个有效dropin（包括8个system.control预算文件）及重新枚举的22份helper回执。文件原有root:root/0600保留，原bytes在受限证据目录保留，低磁盘检查通过；没有重启或修改成员。

随后用安装版Backup API/AES工具新取 `postcap-b0503-20261023T235518Z-b0d8cb9c.xunjiebak`，2,506,489 bytes，SHA256 `c90033ef5b4f35016f8b730edd34b4634b5c294952632d1fda49de878e03e0c3`。它明确标为 `post-capacity-pre-Mac-as-of-current`、`isFinalCurrentSnapshot:false`、`MacAuthPending:true`，未传owner-cleanup-confirmed。87文件较旧89文件减少，是五个已退役SSH映射被删除、增加一份helper回执及本次独立操作证据，并非遗漏formal/rollback恢复范围；逐路径差异在独立回执保留。

云端新隔离目录及main独立Mac恢复均通过87个SHA、6库integrity/FK、4个32-byte key、3对TLS/CA链、9个dropin、e03配置与真实daily policy覆盖；模型凭据解密仍为3/0/2，access为19项，registry为1 active/12 deny，1组active SSH和21份已deny device回执对应。直接查恢复库确认五容量成员和file-only成员revoked、设备closed，五应用身份disabled；Mac是唯一active registry身份，3059条receipt、232条submission等历史保留。备份key不入包，使用Mac原有独立key，不从ECS取key。

本次未启动额外产品进程或重复HTTP/模型请求，沿用未变化e03产物在89文件恢复时的普通产品隔离证据。云端恢复明文和上传payload、main的Mac恢复明文均已精确清理；密文/manifest/回执仍保留在受限 `~/.config/xunjie-cloud/backup-recovery/postcapacity-133-e03a3c9-20261024-b05035df/`。操作与独立Mac回执为 `~/.codex/artifacts/xj133-postcapacity-e03-20261024-b05035df/result-summary.json`、`main-mac-independent-verification.json`；postflight确认三服务PID/argv/limits、e03配置及9个dropin未变，live policy与归档内正式policy副本摘要相同。原precleanup的liveDailyPolicyWillBeChanged:false审计保持字节不变。

这份归档记录五成员退休后、Mac认证前的采集状态。Mac正常浏览器流程及其精确撤销/清理现已独立通过，原87文件仍不改记为其后的final；code-proof双身份/环境清理及main全局release完成后，已另取下述final快照。Mac解密恢复通过不代表浏览器系统信任通过。日备policy覆盖已生效，未等待Mac认证，也未把人工归档成功冒称更新后的timer已再次运行。

### 最终清理后的加密归档与两端恢复

2026-10-24北京时间15:43，在main核实Mac完整验收、Testing6/固定公开strict verify、两端精确退休和私密载荷清理并释放独占窗口后，lead绑定真实`main-cleanup-independent-final.json`原字节SHA256 `e974caed83c83cdf7626b01917b741d2565875443cf42811cafbf2ad170c940b`，生成完整cleanup guard。安装版工具、源runtime/argv、实际unit/dropin、容量成功verdict及预算均先核对；没有使用模板或未完成事实填true。

真实`/etc/xunjie/backup.json`只增补两个新device的helper recoveryFiles，实际完整枚举24份回执；原formal scope、库/模型目录、全部旧recovery条目、e03配置及70d/c896回退均保持。policy由`f6fb30a0e3834de9005b31bd5bcde6f066a1de23daa63f4e0bc9d5c22459d891`变为`62997d3f3383f59c96fa1e769947de0ebfac796a22606c3b7aa12adfab475d2a`，root:root/0600保持。9个有效dropin按完整源路径归档，包括system.control预算与133-runtime；新配置SHA仍为14cd7c60…0a6567。低磁盘及共享维护锁检查通过，未重启或修改成员、source、limits。

新密文`closeout133final-20261024T074309Z-938cdde3.xunjiebak`为2,517,540 bytes，SHA256 `1782424acfa2cacb4f6f820d1c902ab12fe660cfaa1a659fde32b774e9ac1e13`；phase为`post-cleanup-final-current`、isFinalCurrentSnapshot=true。90文件/6库在云端隔离恢复及main独立Mac恢复中全部SHA、integrity/FK通过，4个key均32 bytes，模型凭据解密3/0/2、access凭据21项，3对TLS私钥及access CA链匹配。5容量、旧smoke、Mac和2个code-proof共9个精确身份均revoked/closed/helper denied；registry为0 active/13 deny，active SSH为0，24份helper关系成立。恢复的候选history保留3062条command_receipts、470 snapshots、232 submissions和232 feedback。

main使用本机既有独立32-byte backup.key，未从ECS取key，独立核验器exit0；`main-final-independent-verification.json`含recoveredPlaintextRemoved:true。两端恢复明文均按manifest/已知SQLite sidecars、无symlink和无open holder精确删除，远端11个payload文件及目录也已清除。密文与安全metadata保留于`~/.config/xunjie-cloud/backup-recovery/final-133-e03a3c9-20261024/`（0700/0600）；云端密文保留在`/var/lib/xunjie/backup-archives/`，key本身不入包。

操作证据为`~/.codex/artifacts/xj133-final-e03-20261024-774fb738/result-summary.json`及`postflight-readonly.json`；main独立回执为`~/.codex/artifacts/xj133-closeout/main-final-independent-verification.json`、`main-final-mac-restore.json`。控制器初次无权限存在性检查在任何创建前失败，沿用既有sudo后重试完成，原失败日志保留。postflight再次确认formal/candidate/access PID91972/142780/142786、ExecStart/limits、e03配置和9dropin不变，日备与归档中的policy摘要一致；全部自有SSH已结束，不启动产品子进程，不重复e03普通产品HTTP、容量、模型或教学效果。final只是该次采集时点的current，后续业务写入后自然成为历史；71/89/87文件快照保持原时点与原审计。

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

原始证据为 `~/.codex/artifacts/xj133-capacity/20261024-e03a3c9-62779aba/` 的请求/服务端指标、资源样本、`independent-db-audit.json`、`retained-history-audit.json` 和 `postflight-runtime.json`。lead仅离线重算requestId关联/p95、184样本内存/CPU/host最低值，并核对前轮base及API/DB审计关系，结果在 `~/.codex/artifacts/xj133-closeout/lead-e03-62779-evidence-recalculation.json`；没有由lead重新查询云DB。负责人独立raw gate亦通过，`main-independent-verdict.json`可直接满足最终scope的成功verdict契约；worker最终报告和33文件seal已收齐，main与lead逐项核对SHA。worker负载/采样/审计已停；预算实际读回、五actor精确退休和新post-capacity归档/两端恢复均已完成。Mac系统认证/实际浏览器流程、精确清理及之后的final快照现均已独立完成；各阶段证据分别保留。

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

## Fresh Mac完整验收与精确清理

fresh最终工作树、CLI和本地浏览器后端固定e03，精确Node24.21.0；公开CLI仅重启自有旧后端，保留同DB/home/CA。新Chrome profile在`ignoreHTTPSErrors:false`下取得TLS1.3/200，未发送CDP忽略证书指令、未注入anchor，实际Chrome argv无证书绕过flags，三个模式呈现根均与原F748 CA一致。证据为`~/.codex/artifacts/xj133-fresh-mac/71-new-profile-browser-tls-proof.json`及107最终报告，不把辅助native检查false机械视为浏览器失败。

实际业务覆盖：自有本地baseline完成学生保存、冻结、固定版本提交、教师正式反馈及学生UI读回；cloud-api/cloud使用teacher专用邀请，只写自己的blueprint draft并读回共享结果。三模式的source/数据/HTTPS、local/cloud Cookie隔离、浏览器CSRF负对照403和实际wire错误Origin403均有独立核验；HMR仅对应local和cloud-api的本地前端，deployed static不声称HMR。未保存draft保留在原来源，临时CSS marker已恢复。main独立`main-browser-business-mode-independent-verification.json`验证上述边界。

失败与未测继续保留：63/65/66/67的native SecTrust/security verify仍false；78辅助APIRequest在可用响应前失败，不计通过，浏览器Origin替换得到409也不当成实际错误Origin通过。早期依赖symlink干预曾导致better-sqlite3缺失，随后正常npm ci及ready baseline恢复，属于操作者介入，不能描述成无人工干预路径。新teacher项目发布需执行能力且返回RUNTIME_NOT_READY；teacher-only云邀请没有完成cloud student整套提交/反馈，完整闭环只在本地baseline验证。该Mac验收未调用真实模型/执行节点，教学效果未测；独立unit/protocol只在早期c896运行，不冒称重跑e03全套。

清理已完成：95/96精确device/member撤销，主会话核对denied、devicesClosed=1、applicationDisabled=true；98用原enrollment.deviceFile/原key真实refresh得到DEVICE_REVOKED，97猜测设备路径导致的失败不计通过。自有模式全部down/delete；101仅对本次新增的F748证书执行`security delete-certificate -Z <SHA256> -t login.keychain-db`，exit0；103读回证书absent、用户SecTrustSettings为-25300，未改其他domain。105私密载荷清理，只留永久guard/非秘密metadata；main独立确认8个guard目录inode逐一吻合，原邀请/secret载荷absent，自有Node/SSH/Chrome进程为0。

最终报告`107-final-freshmac-acceptance-report.json`、`106-freshmac-quiet-window-release.json`及`main-freshmac-cleanup-independent-verification.json`位于上述受限证据目录。Mac自身quiet release与main独立清理PASS均已确认，业务history/OSS/owner入口保持；它不释放并行code-proof身份或final备份窗口。

## Cold fetch与跨机unpublished/dirty组合当前进度

新组合使用独立producer/consumer file-only身份，经公开CLI传递稳定团队ID；包内带未推送提交的所选源码及选中的dirty差异，fixture不合integration/main。最初Windows冷fetch的size/CRC/SHA与inspect正确，却因schema fingerprint加载缺失better-sqlite3而返回TRANSFER_STATE_INVALID，此P2保留原诊断，不把手工私装依赖当作原流程通过。

fixed 1a21/a958分离fetch静态兼容与restore完整schema前置；后续7a1f3b6/d379纠正恢复指引为可信checkout `doctor`→显式`use local`。后者准备student/teaching依赖、启动本地服务，健康后切换本地入口，原云数据/已有页面/未保存草稿保留原目标；普通up沿用原选择模式，不能承诺在cloud/cloud-api准备本地NativeSQL。restore自身不安装、不切模式、不启动业务，目标发布前完整runtime/tool/lock/schema检查与包内交叉检查保留。

main已确认d379 exact push与双轴recovery P2 closed；针对该固定树的独立67 pass/1平台skip/0 fail，与先前a958完整196 pass/1平台skip分别记录，不相加。Mac真实cloud-api冷依赖经公开doctor/use local→restore通过，回执为`~/.codex/artifacts/xj133-cold-repro-fix/cloud-recovery-real-local.json`；不由此推定Windows恢复已通过，产品runtime仍e03，未重跑容量/model/node或既有产品HTTP。

Windows新的公开fetch已真实exit0：同`xjp_448487ec-3bea-4fa9-8ddd-4eacc3898798`、6,334,801 bytes、SHA256 `92c71def41e8046dd173e2523bb19e61a957fe95a824743e4d65a4329249b3f7`、CRC64/XZ `10716596408823187377`。结果为downloaded、restored=false、reproduction=unverified，compatibility中dependencies/schema=not-checked、runnable=unverified，cacheHit=false。证据为`~/.codex/artifacts/xj133-codeproof-20261024-54db6ec2/windows/command-fetch-fixed-cold.json`；不据下载结果推导已恢复、已运行或已重现，也不据cacheHit=false单独判断正文是否重传。

Windows后续cold restore准确返回`DEPENDENCIES_NOT_READY`，目标与依赖未变；公开doctor exit0。公开`use local`实际通过npm ci准备student/teaching依赖并启动gateway/backend/Vite，但首次和复用retry均exit1，返回page.serving=false、apiReady=true；两个回执中的三服务PID相同。独立新进程的公开status却exit0、page/API均true，strict TLS的`/`与`/health/ready`均200，期间没有源码、配置或信任改动。上述证据依次为该windows目录的`command-restore-cold-expected-failure.json`、`command-doctor-fixed-before-prepare.json`、`command-use-local-public-prepare.json`、`command-use-local-reuse-retry.json`、`command-status-after-public-prepare.json`和`command-prepare-tls-and-owned-log-readback.json`。两次失败是旧版真实误报，不改写为first-pass或仅冷启动等待。

随后真实Mac调用链对照确认：同步OS进程归属查询阻塞事件循环，超过连接池中gateway socket的idle生命周期，upLocal已等到页面200、紧跟modeStatus却复用旧连接，得到reusedSocket=true/ECONNRESET；仅等待response end仍失败。作者`151c8a9`、integration `f8e15f2`仅给共享HTTP/HTTPS probe设置agent:false，CA/严格TLS、HTTP200和5000ms超时条件均不变，没有增加请求重试。回执为`~/.codex/artifacts/xj133-cold-repro-fix/readiness-followup.json`；worker专项60 pass/1 Windows-only skip、main独立22 pass/1 skip分别记录，不相加。fixed Windows已独立补验：`command-use-local-fixed-f8.json`、`command-use-local-fixed-f8-reuse.json`及`command-status-fixed-f8.json`的公开use local首次、复用及status均exit0/ok=true、page/API ready，gateway/backend/Vite保持同三PID；main安全核验为`windows/main-fixed-readiness-independent-verification.json`。早期两次false仍按旧版失败保留，不冒称原流程first-pass。

Windows继续使用同一原包执行旧公开verify已exit0：`verification.restored=true`、reproduction=verified、evidence=real-local-business-https，两次sync分别200和409 VERSION_CONFLICT且matched=true，见`windows/command-verify-restored-public.json`。但该版本`repro-verify.mjs`的HTTP helper使用rejectUnauthorized:false；其HTTPS/verified字段只记录当时返回结果，不能据此宣称公开verify通过strict TLS。嵌套transfer仍保留下载阶段的兼容/未验证元数据，不据此覆盖verification。

独立`windows/command-strict-live-response.json`使用显式受管CA、rejectUnauthorized:true，登录及真实stale sync均TLS1.3/authorized；409正文为VERSION_CONFLICT，两个选中源码摘要匹配、41表bootstrap保持不变。`command-readonly-persistence-proof.json`另确认首次保存文件存在、被拒绝的第二文件未写入，检查本身只读。此业务/源码/持久化证据保留为通过；回执准确标记publicVerifyStrictTLSAccepted:false，不替代公开CLI的严格校验验收。

公开verify修复作者`8091f806`、integration `2c0cead60c322d3507898ed267f23bc0dd4c35e8`已由main push并核对ls-remote一致。登录和每一步均显式读取同一home的受管CA，rejectUnauthorized:true；保留独立连接、原业务请求条件，不生成CA、不改全局trust、无bypass fallback。缺失、无效、TLS不匹配分别报repro/CA_MISSING、CA_INVALID、GATEWAY_TLS_INVALID。worker44 pass/0 skip/0 fail、main独立16 pass/0 skip/0 fail分别保留：正确CA真实200→409，错误/缺失/无效CA均拒绝，sessions/业务revision/原receipt字节不变，见`~/.codex/artifacts/xj133-cold-repro-fix/verify-tls-followup.json`及main交接；两轴TLS P2复核closed。

Windows最终STRICT ACK已由main独立核验，见`main-final-strict-public-verify-independent-verification.json`：以2c0cead可信CLI显式指定新恢复target、保持原home和原fixture源码，使用同稳定ID、原ZIP SHA及841文件源码，公开verify真实200→409；登录和两步业务请求全部strict CA/TLS1.3 authorized。main另审观察器源码/摘要，确认请求参数原样转发、没有注入证书或信任绕过。该固定入口通过与旧版非strict verify分别保留，不改写早期失败或重跑容量/教学效果。

main独立`main-crossmachine-proof-independent-verification.json`确认Testing6跨机组合完成：Mac与Windows同一稳定ID/摘要及6,334,801 bytes，未推送提交与选中dirty源码均实际到达，841个源码文件摘要匹配，真实业务200→409正文与Mac一致，strict supplementary TLS和保存/拒绝持久化关系通过，源码Git bundle与业务ZIP分开。该回执07:00 UTC时仍写readiness待补，已由随后07:01 UTC的fixed readiness独立回执补齐；当时公开verify的strict TLS缺陷由后续2c0cead修复，07:14 UTC的最终独立STRICT ACK另证Windows公开入口通过，不由组合业务通过直接推导。

code-proof的Mac局部清理已完成，见`mac-local-cleanup.json`及`mac-local-cleanup-seal.json`：两个本地环境经公开down/delete，6个原自有PID已消失、6端口无listener，永久锁guard inode保持。4个本次node_modules链接精确unlink，共享target inode不变；仅本次dirty文件恢复HEAD，当时fixture工作树clean保留在未推送提交6e86a0b，恢复工作树正常移除。原ZIP、两patch及841文件源码证据保留，lead核对该局部seal的7项摘要全匹配；main另以`main-mac-local-cleanup-independent-verification.json`独立核实6PID/6端口、2guard inode、4链接gone且共享依赖保留、恢复工作树gone和fixture clean。该局部回执当时保留双方原key供拒绝验证，不表示全局quiet release。

随后producer/consumer两个精确file-only成员、device与invitation均实际revoked，device close_ready=1；对应helper denied=true、无SSH用户及授权key。双方原key经公开refresh均得到DEVICE_REVOKED，其他成员/device/invitation读回不变。安全证据为`server-access-retirement-readback.json`、`server-helper-retirement-readback.json`、`producer-original-key-refresh-denied.json`及`windows/command-refresh-original-key-after-revoke.json`；lead已离线核对精确ID、成员/device匹配、状态及摘要。Aquinas后续`mac-private-cleanup.json`记录清除34份自有私密载荷、仅留9个原inode永久guard；`fixture-worktree-cleanup.json`记录clean fixture正常移除，无force、无合并或push，另留793-byte窄bundle及原ZIP/两patch/841源码证据。

worker组合封存现已完成：`cleanup-final.json` SHA256为`28fd6a92d87c963c9f0705cc05965d61fec4a09ba9883a908e035f0dfaf4a1b0`，记录Windows三个环境公开down/delete、17原进程gone、9端口无listener、18永久guard保留、两个恢复工作树及自有private/cache/bootstrap精确清理；Mac/Windows云命令、受管进程和controller均0，SSH/SCP settled。lead离线逐项核对`cleanup-evidence-seal.json`的36文件和该报告22份receiptReferences摘要均匹配，精确两身份与最终guard契约一致。`cleanup-quiet-window-release.json`当时只释放worker工作流；main随后以`main-cleanup-independent-final.json`独立核对36份原始SHA、精确身份及两端清理并正式释放final窗口。

main安全报告已按原字节SHA绑定到最终归档，真实cleanup guard验证后才更新live日备并采集final；最终实际枚举24份helper、保留原scope/9dropin/e03/rollback，云端及main独立Mac关系恢复和明文清理均完成。完整归档数字与回执见上节，不再将已完成清理或备份列为pending。

## 旧入口核对与清理边界

活跃代码/文档扫描排除 `docs/archive/`、`node_modules/`、`dist/`。原 PowerShell 成员连接、旧本机宿主、源码构建 `sync-main.py` 与单元已退役；云端只读确认旧脚本不存在、`xunjie-main-sync.timer` 为 not-found。当前 `xunjie-release-deploy.timer`、备份 timers 与业务/接入服务保留。

`tools/i0-cloud` 的业务宿主、正式旧协议发布器、备份和节点准备仍有实际用途，保留；`connection.mjs` 对既有批准 owner 配置的只读适配继续用于维护兼容，不恢复手工成员接入流程。仓库外连接 README 已改为当前 invite/join/use 入口，只改 XunJie 说明；owner SSH、accounts.private.txt、backup-recovery 及其他项目未改。用户原 root.zcode、无关分支和已 stopped 的 robert QEMU/WSL 不在清理范围。

Nash 的旧 Windows 副本只读库存为 `~/.codex/artifacts/xj133-windows-residue-inventory.json`：`D:\xj126-shepherd-20261023\repo` 仍有24项已跟踪改动和19个未跟踪文件，未证明可丢，整个副本及依赖保留。Ubuntu 保持 Stopped，`/home/wubq/xj126-134-linux` 当前是否存在未知，未启动或挂载以补查。旧私有测试载荷的生命周期、目标 cwd/打开句柄覆盖仍有未知，独有日志及恢复证据已列出并在原位置保留；不能宣称 Windows 旧 bulk 测试副本已全部清干净。清理仅覆盖可证明属于本轮且已无用的对象，保留未提交内容符合当前范围。

库存本身遗留的 probe PID38920 经创建时间、可执行文件、父子关系和自有代码摘要核对后精确终止，launcher PID48992 随后也读回 gone；未触碰 parent PID47464、产品进程或 WSL，没有删除 Windows 文件。独立收尾回执 `~/.codex/artifacts/xj133-windows-residue-inventory-self-cleanup.json` 保留两次尝试及最终 gone 读回，原库存和证据未改。此处仅确认这两个库存进程的结束，不据此推断未知旧载荷或句柄已消失；通用 SSH、有效恢复材料、用户 root.zcode 和无关分支继续保留。

本轮隔离进程和明文恢复目录已清理。早期入口清理的file-only smoke证据为`post-cleanup-smoke.json`，按当时时点保留。e03容量结束后另做精确退休：五个原member/device及应用身份逐项核对后deny/closed/disabled，原key真实CLI refresh全部DEVICE_REVOKED，23444–23448 listener全部消失，四个attempt hash/version和五表历史保持。随后经同一持久入口，用全新file-only成员真实join/fetch原已发布编号，cacheHit:false、6,273,409 bytes、SHA256 `6af6feecd0bc5931a67ce51810282fa8f41fa320a3216520ca25f93cfa56eb8f`校验通过；无SSH/应用权限，不做restore/verify。smoke成员随后revoke/system deny，私钥/邀请/cache精确删除。合计清90个私密临时文件，只留10个永久锁guard，inode/hash保持；Mac身份/privatehome/CA与业务、模型、OSS、基线及owner入口保留。撤销时已签URL尚余296741ms，按已有有效期事实记录，未轮询到期，不宣称撤销立即使已发URL失效。证据为`~/.codex/artifacts/xj133-retirement-20261024/retirement-final-receipt.json`及`quiet-window-release.json`。

真实 daily timer 已在 2026-10-24 03:00:26–03:00:27 使用当时扩展的备份配置完成，`Result=success`、`ExecMainStatus=0`；它早于 70d 配置登记，不声称已包含后来的材料。周备 timer 保持 active，未额外制造第二次周备。e03容量已按固定口径通过，预算已持久读回，actual e03普通产品隔离及新的日备覆盖/post-capacity归档两端恢复通过。Mac实际正常浏览器/业务/三模式及精确清理、Windows Testing6与固定公开strict verify现均已main独立通过；两file-only身份撤销/原key拒绝、Windows三环境及剩余私密载荷清理、组合封存、main release与final快照两端恢复现均完成；已完成验收不列为pending。独占云窗口已结束；仅预取未激活的133-1aa9675已由main精确核对manifest/source归属、5290文件摘要及完整文件集、unit/config和所有进程引用后清除；[安全清理回执](/Users/robertwu/.codex/artifacts/xj133-closeout/main-unused-1aa-cleanup.json)确认无未知归属、额外文件或业务/私密材料，70d/c896/e03及恢复材料保持。
