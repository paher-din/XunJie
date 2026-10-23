# 开发协作交付核查（#133）

日期：2026-10-24。本文记录本轮实际证据和未完成边界；工程、浏览器、真实模型/节点及教学效果分别判断。正式 main 的合并、发布与资源预算应用由负责人处理。

## 当前证据状态

| 范围 | 已核实结果 | 待完成项 |
| --- | --- | --- |
| CA 使用说明 | `eaa60ca`：Mac 用户 login keychain、Windows LocalMachine Root 的权限/系统确认、指纹读回与精确移除；跳过 HTTPS 校验不计通过 | fresh Mac 的实际系统信任确认仍在处理；不以证书存在代替正常 Chromium TLS |
| 工程与审查修复 | 负责人独立 9e7：xj-dev 181 pass/1 platform skip，teaching 542 pass/23 external skip；eb3 证书/delete/remote TLS 25/25；原基线、CA 并发、gateway 生命周期、status 与教师消费者缺陷均经定点源码复核 closed；55ed harness 两项失败边界修复由 lead 与负责人分别验证 11/11，Spec 原 P2 closed；40dcc 后续 stop guard 的 worker 全 harness 12/12、lead 故障专项 4/4 | closed 指已定位源码缺陷，不替代平台/业务/容量验收；40dcc 的最终审查回执待补 |
| 加密备份工具 | `2393b66`、`72b3250`、`6e9e52a`：11/11，含活跃 WAL、命名多库、同名配置、凭据解密、密钥排除、损坏库拒绝与版本 1 归档恢复；新脚本已安装，Linux 跨文件系统实际恢复 71 文件/6 库通过并清理 | 最终 scope、新归档与恢复等完整新窗口及预算完成 |
| 云端隔离恢复 | 71 文件、6 库 integrity/FK 通过；5 个模型凭据、15 个 access 凭据、6 个 active SSH 映射与 3 对 TLS key/cert 核对通过；独立端口真实登录/课程读取通过 | 最终 runtime/config 稳定后的新归档及独立设备复核 |
| 实际产品隔离 | 初次 CI `40006389514`、source `c896c52`：5,290 文件摘要通过，无开发服务/OSS SDK/团队凭据路径；空 HOME、无开发/OSS/account-control 接线，严格 TLS 下页面/登录/课程均 200。当前实际候选已严格激活 `e03a3c9`、显式 ss16 | 最终实际产物的隔离业务读回纳入最终恢复；不以旧 c896 结果冒称已测 70d/e03，不代表未发布的普通用户安装包 |
| fresh 成员 | Mac 已真实 join、三模式、按团队编号恢复并验证 `200 → 409 VERSION_CONFLICT`、新基线隔离与显式停止/删除；原 Windows 已完成严格 TLS、双角色闭环、新基线独立副本、团队编号真实 restore/verify 和自有 SSH 中断恢复；新的 Windows 补验完成真实云端保存/冻结/固定提交、教师反馈 UI 读回及拆除前 active revoke，专属进程/CA trust/敏感材料已清理 | Mac 正常系统信任仍待确认；Windows 原 partial 回执保留，新覆盖以独立 topup 报告补充 |
| 采集默认源码 | 静态 canary 已由 `2e23535` 改为运行时生成，guard 未改；负责人独立 0ea 默认 `collectCode` 840 文件/约 6.27MB 通过，根范围未缩小；Windows 原 context 默认 baseline publish 通过 | 最终交付 SHA 及新的平台补验回执继续对应记录 |
| Windows 签名 | `496493a`：worker Mac 21/21、Windows 默认 PATH 7/7；lead 独立 client/signer 18/18；实际旧 client 失败后 fixed CLI 原 key join 成功，无 PATH 修改；fresh Windows 原邀请/home/key join 亦通过 | 不修改 Linux access 服务；完整成员流程单独记录 |
| 容量与资源 | c896 p95 1090.234ms、70d p95 1053.110ms 两次失败保留；e03+ss16 的62779aba完整窗口3097/3097匹配、零missing/duplicate/non2xx/5xx，普通API3089项p95 262.266ms，按固定500ms口径通过；lead从原始记录重算一致，main已持久应用预算并读回 | 仅对应这轮固定源码、数据规模和负载；Mac认证、精确撤销、最终current归档仍分别验收 |
| 真实模型 | c896 两项 Mimo 认证失败保留；70d 两项 DeepSeek settled/exactOK、calls1、actual usage各83/2；e03两项亦settled/exactOK、calls1，actual usage为83/14和83/12；原正式store未改 | 模型互操作成功不替代真实执行节点或教学效果验收；各轮结果分别保留 |
| 真实执行节点 | 候选未登记 execution node，运行/检查正确拒绝未就绪能力；原 robert QEMU/WSL 保持 stopped | 本轮未做真实执行节点互操作 |
| 教学效果 | 未测 | 不由工程或模型可调用性推导 |

## Attempt scope 补丁的固定树验证

70d 延迟失败后，新增显式 attempt scope 读取以减少无关 receipt 水合。默认全课程读取保留；后续 `3d3d3ca` 补齐 event.payloadRef 指向同课程另一 attempt receipt 时的完整校验，避免 scoped 误走对象 fallback。Spec 对该 P2 的最小复核已 closed，Standards 最后两文件 delta 回执仍待负责人收齐。

负责人独立工程 gate 分别对应以下固定源码树；三次是重复验证不同树，计数不能相加，skip 不算通过：

| 固定源码 | 组成与边界 | teaching pass / skip / fail |
| --- | --- | --- |
| `9c7f48818b8d31625c9bbac21a3dadfe1a08569f` | worker 单分支，尚不含 integration 已有 S3 教师消费者修复 | 545 / 23 / 0 |
| `d55e94d2e6118e9557e3a0cbfbf49498b8f17e85` | 吸收 9c 后的组合树，保留 S3；当时 payloadRef P2 尚未关闭 | 554 / 23 / 0 |
| `e03a3c9035282683c1fdcba0d5b5746b8c256587` | 吸收 3d3 后的最终组合树，保留 S3，Spec P2 closed | 556 / 23 / 0 |

e03 的 typecheck/build、diffcheck 和默认 `collectCode`（841 文件、6,276,679 bytes、原 guard）由负责人独立通过，push 后 remote 一致，已开始 dispatch exact e03 cloud-release；这不表示 CI 已成功或候选已激活。lead 的最终组合定点 gate 为 13/13，且三个 S3 文件相对 d55 无差异。e03 尚未生成新的 active cfg，也未替换云端 70d。后续须核对 actual CI artifact，并在同 512MiB mixed 短预检有充分余量后，才由负责人协调 planned activation 和完整容量复测；工程 green 不抵消前述真实容量失败。

后续回执：exact e03 CI `40035400632` 成功，strictprefetch 核对 4,787 runtime/503 static 文件及 Linux x64 Node24.21/native SQLite，target 为 `/opt/xunjie/candidates/133-e03a3c9`。负责人仅执行 prepare，新配置 `/var/lib/xunjie/capacity-133/application-e03a3c9.json` 为 0600/xunjie，SHA256 `14cd7c609a1656d558558e18b37a50da1f266f76a841e9575d86e26d2d0a6567`，只改 staticDirectory，旧70d cfg SHA不变。顺序为 strictprefetch/review → prepare → 使用实际 cfg SHA 的 same512 mixed 短测 → 有充分余量后 activate；短测依赖新 cfg，因此不是 prepare 的前置条件。prepare 回执为 `activated:false`，live 仍70d/空 Node flags/PID131947、131948、91972，未因配置已存在将其登记为 active snapshot。

再后续 actual activation 回执：负责人已完成 e03 的计划内激活，显式 argv `--max-semi-space-size=16`；candidate/access/formal PID 为142780/142786/91972，NRestarts均0，strict TLS/static/source及本次 ready 请求对应的新PID onResponse指标通过，formal PID未变。激活前 Backup API 一致副本 SHA256 `953751236860111f5e21d97e29eaf16b5e154e033685622b213ce0acbed8563c` 与 commonseed 相同。依据本机 `~/.codex/artifacts/xj133-ci-e03a3c9/activation-result.json`，lead只读该回执，未访问云端。负责人已开放下一905窗口；planned restart 不算意外 restart，也不代表容量达标。窗口内冻结 backup/deploy/unit/config/limits/额外登录及额外server，未采最终snapshot、未应用预算。

## 备份与恢复实测

新增配置保留原正式课程库、原个人模型及签名/TLS/执行连接恢复材料，额外登记 candidate 课程库、原候选/新候选个人模型 store 与 key、account-control registry/config、access SQLite/credential.key、服务与系统配置、TLS/公开 CA、受管 SSH 公钥映射与固定 helper 回执。完整字段契约见[备份说明](../../tools/i0-cloud/README.md#加密备份与隔离恢复)。

云端归档 `closeout133-20261023T185305Z-204247a0.xunjiebak` 为 558,241 bytes，SHA256 `907024a2cbe131db2b47d9ca7b5253289aee2d9a04b52c2371bd5e34e512a154`。它包含 71 个文件、6 个经 Backup API 复制并校验的 SQLite 库；加密 key 本身不在归档中。独立恢复使用新的目录、业务端口 18444 和 account socket，模型网络调用关闭、执行节点为空；实际 `/health/ready`、登录、session、课程读取均 200，所属进程已停止。

3 个模型存储的凭据解密计数为原正式 3、原候选 0、新候选 2。access 对应 key 能解密 15 个成员凭据，核对 6 个 active account-control 身份及 5 个 deny 状态；这些是该次采集的观察数，不是永久成员清单。6 个 active SSH 映射与 helper 回执核对，TLS 私钥/证书匹配且 access CA 验签通过。每个库独立一致，配置/公钥映射分别采集；这些关系在该次恢复中通过，不等于跨存储原子快照。

负责人 Mac 已独立验证同一归档：71 个文件 SHA 全匹配，6 库 integrity/FK、4 个凭据 key 长度和 3 对 TLS key/cert 通过，明文已清理。加密归档与独立受限 key 副本保留在 backup-recovery；证据为 `main-mac-independent-verification.json`、`main-mac-independent-restore.json`。

这份归档采集于切换前，业务 source 为 `fb5830e`；新 capacity 模型是当时的准备材料，不据目录存在宣称已激活。之后新建的 `133-runtime.conf` 与最终容量 budget dropin 尚未在此归档中。最终 scope 必须从运行中 unit 的 effective ExecStart/DropInPaths、实际配置、source 与 limits 读回，连同 dropin 原路径映射再采集新归档；不得用旧归档声称恢复了新 runtime/预算。

live backup 配置现已登记 `133-runtime.conf`，并将实际存在的 `/var/lib/xunjie/capacity-133/application-70d170a.json` 独立映射为 `candidate/capacity/application-70d170a.json`；旧 `application.json` 保留为 c896 回退材料，未创建的 1aa 配置未登记。新配置为 0600/xunjie，摘要 `5720f0e3cceca68386f1c0075f6ab09bed2616ba69167b3facd5ef63dd0dc4b0`，当前模型目录/key 仍为 capacity 独立 store，T/S1 已是 DeepSeek revision 2。此处只更新覆盖范围，尚未生成包含它们的新归档。测量窗口内不手工 snapshot；最终 budget dropin 由负责人应用后再登记、采集并隔离恢复。

e03 激活后的当前窗口不修改上述 live policy。最终依赖完成后，scope 必须再加入实际 active `application-e03a3c9.json` 的独立 archive 路径并保留70d/c896回退配置，收录最终实际 DropInPaths 后重新加密采集；现在的离线映射不冒称已改定时备份或已有最终current归档。

成员私钥仅在成员设备。access CA signing key 留在 owner 本机受限目录，不在服务器归档；服务器归档包含现行公开 CA、TLS leaf 私钥和证书。保留 owner 独立受限副本或重新签发/邀请的恢复策略，不能声称从服务器备份恢复了成员私钥或 owner CA signing key。

脱敏证据集中在负责人本机 `~/.codex/artifacts/xj133-closeout/`：`cloud-backup-configuration.json`、`cloud-encrypted-backup.json`、`cloud-restore.json`、`cloud-restore-relations.json`、`product-isolation.json`。进度入口为 `~/.codex/artifacts/xj133-closeout-progress.json`。证据不含 key/token/password；实际归档与恢复材料走受限管理路径。

## 产品产物与运行态边界

初次产品隔离采用已严格预取验证的不可变目录 `/opt/xunjie/candidates/133-c896c52`，核对 4,787 个 runtime 和 503 个静态文件摘要。测试子进程仅获得 PATH、空的独立 HOME、NODE_ENV；不读取成员 connection/邀请、OSS 配置或 access account-control socket。测试操作者从隔离备份取得既有身份用于实际登录，产品子进程只使用普通应用配置与隔离业务库，未调用接入服务取得登录权限。

70d 窗口使用的实际候选为 `/opt/xunjie/candidates/133-70d170a`，source `70d170ab6a7665a973d514b28eedb5a0532d17ee`；负责人已核对 CI binding、摘要、native SQLite、静态及健康接口。当时计划切换后 candidate/access/formal PID 分别为 131947/131948/91972，restart 读回均为 0。与原 capacity 配置相比，新配置只更改 staticDirectory，复用同 DB/TLS/Origin/model store。后续 CLI、harness 和文档至 55ed 的产品运行文件相对 70d 零差异；harness 也不进入 runtime 装配清单。6e9a 窗口固定这份产物与原历史数据，不能将其结果改记为后续 e03。

正式 d07 旧产物实例与兼容部署器继续保留；首个 bound main Release 尚未由负责人发布，不能提前用 strict candidate 部署器覆盖正式部署器。现行 access source `3825f98d20ae470e8ee3febaa7cc0bbb51c38382` 与私有 OSS 目录作为团队入口保留，不能为了清场删除唯一可用服务或已发布包/基线。资源预算待真实容量数据后由负责人决定，不以历史 MemoryPeak 或空闲采样代替。

## 容量证据与预算边界

e03 完整窗口 `62779aba-a131-476b-ab7b-bf5fdedd3de2` 已完成；北京时间2026-10-24 06:56:09.246 steady 至07:11:23.691完成收束，914.445秒，`executionDrained:true`。实际source `e03a3c9`、harness `capacity-run.mjs` SHA前缀 `5198feda`、cfg `14cd7c60…`、ss16起终一致；candidate/access/formal PID仍142780/142786/91972，restart均0。后面的70d/c896失败证据保持历史来源，不改记为本次成功。

| e03 测量 | 实际结果 | 判断边界 |
| --- | --- | --- |
| 服务端普通API | 3089项（含5次正常登录和完整workbench），p95 262.266ms；3097总请求全部200，missing/duplicate均0 | 按原500ms总体p95口径通过；129条workbench p95为401.488ms，登录单独p95仍879.646ms，不声称每次请求都低于500ms |
| 业务读回与历史 | 新增436次save、45次幂等重放、71次submit/feedback；API与独立只读DB审计的base+delta、hash/version吻合，integrity ok/FK0 | 旧2124条receipt/audit、326 snapshot、161 submission/feedback逐行摘要missing/changed均0；增长至3059/3059/470/232/232，历史未清空 |
| 模型与传输 | 两项真实DeepSeek settled/exactOK、各calls1，actual usage83/14、83/12；两次OSS 6,273,409/6,274,156 bytes均published，3.651/3.221秒 | 实际产品调用与传输结果，不替代真实执行节点/教学效果 |
| candidate资源 | 184个窗口采样覆盖登录和收束；sampled memory.current最大169.93MiB，cgroup lifetime peak从201.19增至329.15MiB；平均CPU48.986%单核 | 短scrypt峰值会被采样遗漏，使用cgroup peak保留；测量时MemoryHigh仍infinity、MemoryMax512MiB |
| access与宿主 | access sampled最大43,728,896 bytes、peak44,814,336 bytes；host MemAvailable最低953,126,912 bytes（908.973MiB）；PID/restart/OOM/max/high均无增量 | 测量时access MemoryMax256MiB；worker初始预算建议与负责人最终选择分开记录，不能据建议声称已应用 |

原始证据为 `~/.codex/artifacts/xj133-capacity/20261024-e03a3c9-62779aba/` 的请求/服务端指标、资源样本、`independent-db-audit.json`、`retained-history-audit.json` 和 `postflight-runtime.json`。lead仅离线重算requestId关联/p95、184样本内存/CPU/host最低值，并核对前轮base及API/DB审计关系，结果在 `~/.codex/artifacts/xj133-closeout/lead-e03-62779-evidence-recalculation.json`；没有由lead重新查询云DB。负责人独立raw gate亦通过，`main-independent-verdict.json`可直接满足最终scope的成功verdict契约；worker最终报告和29文件seal已收齐，lead逐项核对SHA。worker负载/采样/审计已停，五actor及隧道仍留给负责人精确收尾。完整capacity通过不等于预算实际读回、Mac系统认证、精确撤销、最终加密snapshot/隔离恢复已完成。

负责人据本轮实测确定：正式shared模板在`[Service]`内启用CPUWeight200/MemoryHigh512M/MemoryMax768M，access模板High128M/Max256M并保持TasksMax64。该依据是candidate本轮含登录的329.152MiB cgroup peak与真实五人负载，不用formal旧283MB idle峰。现行formal仍旧d07、PID91972/原argv，未重启未发布；负责人已以持久`systemctl set-property`应用正式512/768+CPU200，没有安装替换formal unit或发布器。当前candidate仍使用更严格Max512M，High448M/CPU200；access为High128M/Max256M、Tasks64。实际properties与内核memory.high/max/cpu.weight一致，high/max/oom/oom_kill累积均0，所有PID/ExecStart不变；回执为 `~/.codex/artifacts/xj133-resource-budgets-20261024/applied.json`，有效预算dropins位于 `/etc/systemd/system.control/<unit>.d/50-*.conf`，最终scope必须完整收录。

下一次安装shared新模板，ExecStart才默认采用已在e03验证的`--max-semi-space-size=16`；正式现行argv没有据此改变，candidate实际已使用ss16。这两个unit模板不在产品runtime清单内，本次更新不重建e03产物。

完整来源、业务基数/增量审计、模型与 OSS、失败和隔离诊断见[容量 worker 报告](../../tools/i0-cloud/capacity-133-report.md)。`adc8ab2` harness 原 8/8 通过后，两轴分别确认上传错误独立记录与异步失败收束两项 P2；`4e79a80` 修复已合入 `55ed4dd`，lead 与负责人各自 11/11，包含 3 个真实业务工厂加受控外部依赖的故障用例。Spec 原 P2 已复核 closed；Standards 另确认 await pause 返回后、publish 前须再检查 stop。Aquinas 在本次实测结束后以 `40dcc9e` 补此 guard，运行中的文件未修改；确定性交错测试证明等待已 fulfilled 后 fatal 先到时不会 publish，失败首因与终态不变。worker 全 harness 12/12、lead 四项故障回归 4/4，最终审查回执另行核对。18 个原 JS 与 1 个 Python 语法通过，20 个原新增文件及 4e/40dcc 的改动文件通过原秘密扫描。

Windows 补验和清理完成后，负责人放行的实际 run 为 `6e9a5416-e0b1-4866-8f5d-a4513687dee7`，steady T0 为 2026-10-23 21:14:32.768 UTC（北京时间 2026-10-24 05:14:32.768），21:29:56.575 UTC 完成；905 秒业务窗口连同 drain/audit 共 923.807 秒。实际 harness 为 `4e79a80`；lead 从 run.json 核对三个 harness 文件均与该固定提交摘要一致，并从原请求和服务端记录重算得到同样的汇总。该轮无 fatal，未触发上述晚到 pause 的失败分支，后续 guard 不冒称是本轮已运行版本。

新窗口 3227/3227 个 requestId 匹配，missing/non2xx/5xx 均为 0；普通 API 3219 项 p95 **1053.110ms，仍超过 500ms 目标**。四个原自有 attempt 按 base 加 delta 增加 465 次保存、48 次保存幂等重放、77 次提交及反馈；worker 的独立只读 DB 审计通过 exact version/hash/receipt，integrity ok、FK 0。两次真实 OSS 分别为 6,273,409/6,274,156 bytes，耗时 4.534/3.159 秒，均 published。两项 DeepSeek 实际产品 turn 均 settled/exactOK、calls1，各为 actual usage 83 input/2 output。`completed/executionDrained:true` 与这些正向结果不能抵消延迟失败。

资源摘要覆盖执行起止附近的 184 个采样、927.448 秒；最后摘要采样比执行完成早 2.119 秒，完整 192 行含完成后的点并另行保留，不声称连续覆盖每一瞬间。candidate 平均 CPU 125.58%（单核百分比），5 秒采样 `memory.current` 最大 165.781MiB；lifetime peak 从 245.027MiB 增至 339.930MiB，包含本轮正常登录峰，不能用稀疏采样最大值替代它。access current 最大 42.961MiB，host available 最低 913.531MiB。candidate/access/formal PID 均保持 131947/131948/91972，restart 0，OOM/max/high 增量 0，配置摘要保持 `5720f0e3…`。负载及本次 sampler 已停止，最终预算、runtime 和归档时点等负责人安排；没有因执行成功应用预算或提前 snapshot。

本轮证据目录为 `~/.codex/artifacts/xj133-capacity/20261024-70d170a-6e9a5416/`，包括 `run.json`、`server-summary.json`、`resource-summary.json`、`independent-db-audit.json`；`sealed-evidence-sha256.json` 封存 16 项原始文件，lead 已逐项核对长度与 SHA。lead 的本地原始记录重算与固定 hash 核对为 `~/.codex/artifacts/xj133-closeout/lead-70d-6e9a-evidence-recalculation.json`，封存核对为同目录 `lead-6e9a-seal-verification.json`。后续诊断或复测须保留这次失败、原历史规模和统计口径。

下表只引用旧 c896 完整窗口，不能替代新 70d 验收：

| 测量 | 旧完整窗口结果 | 解释 |
| --- | --- | --- |
| 普通 API 延迟 | 3484 项，p95 1090.234ms | 超过 500ms 目标；3503 项总请求含模型，并全部匹配服务端 requestId |
| candidate CPU | 平均 116.34%、最高 5 秒段 154.24%（单核百分比） | 同步读取/重复验证及 GC 热点另有隔离 CPU profile |
| candidate 内存 | 采样 `memory.current` 最大 143.88MiB；lifetime peak 326.88MiB | lifetime 值包含窗口前历史，不当作本次峰值 |
| access/host 内存 | access current 最大 40.68MiB；host available 最低 892.25MiB | 旧窗口 host available 高于 512MiB；新窗口仍须重新采样 |
| 进程与 OOM | PID/restart 无变化；OOM/max/high 增量 0 | 计划的产物切换在窗口外单独记录 |

保留原 1103 receipt 一致副本的两次 40 秒诊断都为 212/212 服务端记录、零 non2xx/5xx。a8 单项补丁普通 API p95 460.129ms、workbench 中位数 499.312ms/五并发尖峰 1182.841ms；加 2b hydration 后分别为 332.875ms、169.010ms/782.469ms。它们支持严格构建/激活后的完整复测，尖峰与来源继续保留。当前业务 512MiB/access 256MiB 沿用原参数；access 128MiB 仅为未应用、未压限验收的候选，最终预算及 dropin 仍由负责人依据新完整窗口决定。

原 Windows 已撤销成员通过原 key refresh 实际得到 `DEVICE_REVOKED`；当时六个环境已 down/delete，因此原 partial 报告没有活隧道/Session 失效覆盖，原报告与其摘要保持不变。

新增 Windows topup 使用独立 home/member、自有云任务，client `eb3d5fc`、实际 server `70d170a`。真实 Edge 严格 TLS 下完成保存 200、冻结 200、显式固定版本提交 200，并从学生 UI 读取教师反馈 revision 1。2026-10-23 20:52:57 UTC 在 gateway/Vite/SSH/Session 仍存活时发出 ready，负责人 20:54:35–20:54:37 UTC 撤销；原浏览器 Session 与自有 attempt 请求实际返回 `503 PERMISSION_REVOKED`，原 SSH 退出、supervisor stopped/retryable=false，重试计数 2 在后续 196.556 秒内稳定；原 key refresh 得到 `DEVICE_REVOKED`。没有观察到直接 backend 401；缓存页面和已显示反馈仍可读，云端数据访问已阻断。所有拒绝读回完成后才 teardown，未重放浏览器写入。

Windows topup 最终 21:01:46 UTC 读回：本次 topup 自有进程、新增 CA trust、DB 载荷和敏感材料均为 0；专属 clone/邀请/identity/CA 目录已移除，永久锁守卫和共享历史保留。这只覆盖 topup 专属范围，不包含旧 bulk 测试副本。完整补验与 35 个引用证据校验见仓库外 `~/.codex/artifacts/xj133-windows-topup-20261024/topup-report.json`、`evidence-validation.json`；它们补充原报告，未重跑或改写原完整验收。真实节点、模型及教学效果不在该补验范围。`CLOUD-UI-01`（个人资料静态身份/本地来源文案与云首页不一致）作为 fresh 报告的未修观察保留，没有据此证明服务端泄漏。

## 旧入口核对与清理边界

活跃代码/文档扫描排除 `docs/archive/`、`node_modules/`、`dist/`。原 PowerShell 成员连接、旧本机宿主、源码构建 `sync-main.py` 与单元已退役；云端只读确认旧脚本不存在、`xunjie-main-sync.timer` 为 not-found。当前 `xunjie-release-deploy.timer`、备份 timers 与业务/接入服务保留。

`tools/i0-cloud` 的业务宿主、正式旧协议发布器、备份和节点准备仍有实际用途，保留；`connection.mjs` 对既有批准 owner 配置的只读适配继续用于维护兼容，不恢复手工成员接入流程。仓库外连接 README 已改为当前 invite/join/use 入口，只改 XunJie 说明；owner SSH、accounts.private.txt、backup-recovery 及其他项目未改。用户原 root.zcode、无关分支和已 stopped 的 robert QEMU/WSL 不在清理范围。

Nash 的旧 Windows 副本只读库存为 `~/.codex/artifacts/xj133-windows-residue-inventory.json`：`D:\xj126-shepherd-20261023\repo` 仍有24项已跟踪改动和19个未跟踪文件，未证明可丢，整个副本及依赖保留。Ubuntu 保持 Stopped，`/home/wubq/xj126-134-linux` 当前是否存在未知，未启动或挂载以补查。旧私有测试载荷的生命周期、目标 cwd/打开句柄覆盖仍有未知，独有日志及恢复证据已列出并在原位置保留；不能宣称 Windows 旧 bulk 测试副本已全部清干净。清理仅覆盖可证明属于本轮且已无用的对象，保留未提交内容符合当前范围。

库存本身遗留的 probe PID38920 经创建时间、可执行文件、父子关系和自有代码摘要核对后精确终止，launcher PID48992 随后也读回 gone；未触碰 parent PID47464、产品进程或 WSL，没有删除 Windows 文件。独立收尾回执 `~/.codex/artifacts/xj133-windows-residue-inventory-self-cleanup.json` 保留两次尝试及最终 gone 读回，原库存和证据未改。此处仅确认这两个库存进程的结束，不据此推断未知旧载荷或句柄已消失；通用 SSH、有效恢复材料、用户 root.zcode 和无关分支继续保留。

本轮已清理自己创建的隔离进程和明文恢复目录。之后以全新 file-only 临时成员经同一持久服务完成公开 CLI invite/join，再真实 fetch 原已发布编号；`cacheHit:false`、6,273,409 bytes、完整摘要与原包一致，未手传 ZIP。该 smoke 不创建 SSH/应用账号或受管后台进程，不执行 restore/verify；结束只撤销自己新建的成员并删除专属私有 home/下载缓存。证据为 `post-cleanup-smoke.json`，共享包和基线保留。

真实 daily timer 已在 2026-10-24 03:00:26–03:00:27 使用当时扩展的备份配置完成，`Result=success`、`ExecMainStatus=0`；它早于 70d 配置登记，不声称已包含后来的材料。周备 timer 保持 active，未额外制造第二次周备。e03本轮容量已按固定口径通过；预算持久读回、fresh Mac正常系统认证与精确撤销、最终稳定配置归档/独立恢复及最新产物隔离读回仍需补齐，本文不预报这些步骤通过。
