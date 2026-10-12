# DL-C：隔离 HDL 构建、持续仿真会话与板信号

日期：2026-10-12（Asia/Shanghai）。主责：C。执行 Issue：[DL-C #39](https://github.com/paher-din/XunJie/issues/39)；协调：[P3 #37](https://github.com/paher-din/XunJie/issues/37)。个人顺序 DL-C → C4，本次先准备 DL-C，未开始 C4。

状态：负责人已批准 C 侧方案、三表新合成库和节点维护范围；C 侧独立引擎与合成服务端已实现，目标 VM 的 HDL 14 项、C 节点 50 项及受认证 SSH 10 项通过，应用 typecheck/build 通过。DL-A 的课程/共享业务契约与实际 UI 尚未接入，完整 DL-AC-02～07 与 Issue #39 未关闭。第 1～9 节保留首批准备/提案时点，批准与实际交付以第 10～11 节为准，不代写产品基线。

## 1. 已读依据、边界与起点

已按顺序阅读 [AGENTS](../../AGENTS.md)、[README](../../README.md)、[PRD](../product/PRD.md) §1～6/8/9（C-09/C-10、PRD-03/04/05/09/10）、[MVP_SPEC](../product/MVP_SPEC.md) §1.4、M-02/03/04/05/09/10、§4～6（DL-AC-02～07、AC-02/04/06/07/10/12/15、NFR-03/04/06）、[TECH_DESIGN](../product/TECH_DESIGN.md) §1～5/7/8/11/12，以及 [TEAM](../planning/TEAM_WORK_PLAN.md) §7/10.1、[DL-0](DL-0_DIGITAL_LOGIC_ADDON.md) §2/3、[工程衔接](../reference/ENGINEERING_HANDOFF.md)、C1/C2/C3 的相关接缝与授权记录。

起点 main=`37849f4`，开始时暂存区与工作区干净，无目录内额外 AGENTS。只读回读 #39/#38/#43：均 Open，无新增评审评论；#24 已 Closed。Issue 初发时的 P2 未收口表述保留其日期，较新事实以 [G2 §18.4](G2_OVERALL_COORDINATION.md#184-已完成收口与最终交付) 为准：P2 工程审查通过，B 的真实模型/人工语义余项由 #45 承接，完整 G2、环境与 UI 验收仍保留。该工程收口不批准具体 HDL 配置、共享协议、运行资源或 schema。

当前可写仅本文和 README 的任务导航/真实准备状态。规范、product/planning/reference、其他作者任务稿、课程原材料默认只读。本次没有安装依赖、写应用源码、建库、启动专用 VM、修改凭据、发真实模型请求或公开推送。

## 2. 已核实的复用点与实际环境

| 对象 | 当前事实 | DL-C 所需最小增量 |
| --- | --- | --- |
| [文件保存](../../apps/teaching/server/workspace/files.ts)、[快照](../../apps/teaching/runner/snapshot.ts)、[存储](../../apps/teaching/server/workspace/storage.ts) | 不按 `.c` 限制文件保存；确认清单保留 fileId/version/原文/hash，50 文件/1 MiB，快照不可变 | 直接复用 `.sv/.v` 保存、ACK 和冻结，不另建 HDL 作品库；端到端保存仍需真实接口测试 |
| [C 编译](../../apps/teaching/runner/snapshot.ts)、[隔离执行](../../apps/teaching/runner/docker.ts) | compilerArgs 固定 C17；DockerExecutor 固定 GCC/textscope 入口和一次性 phase，执行上限 10 秒 | 新增独立 HDL 构建/持续交互实现；保留原 C 编译入口和全部限额，不能只换编译命令 |
| [节点控制](../../apps/teaching/runner/controller.ts)、[不可变节点文件](../../apps/teaching/runner/node-files.ts) | 同一受认证控制入口、代际、原 ID/摘要、取消/未知对账、持久账本和 fsync 语义已有实现 | 在同一执行边界增加 HDL 操作分流/账本，长期实例不伪装成 C RunControl 两槽之一 |
| [业务 Job](../../apps/teaching/contracts/records/index.ts)、[队列](../../apps/teaching/server/records/jobs.ts)、[workspace worker](../../apps/teaching/server/workspace/worker.ts) | kind 可为字符串，但 student_run 必须有 runId；原 worker 要求 workspace_runs，按用途计两个有限作业槽 | 提案复用有限 Job/Receipt/Event，按 kind 分派 HDL；不得把 HDL Job 交给要求 C RunRecord 的旧处理器 |
| [readiness](../../apps/teaching/server/design/readiness.ts)、[节点指纹](../../apps/teaching/runner/fingerprint.ts) | 当前只核 C profile，变更 sourceHash 会使旧验收失效 | HDL readiness 单列；受触及的 C 节点源码更新后重新验证 C，不能沿用旧 passed |
| [数据库工厂](../../apps/teaching/server/db/transaction.ts)、[workspace schema](../../apps/teaching/server/workspace/schema.ts) | 原工厂只建获准新临时合成库；C3 工厂为 26 表；短事务只允许 SELECT/INSERT/UPDATE | 三表增量先评审；新合成工厂另授权，不修改旧工厂表集合、不迁移现有库 |
| [板卡来源](../../course_matrial/data_logic/Nexys4DDR_Master.xdc)、[材料裁决](DL-0_DIGITAL_LOGIC_ADDON.md#23-课程材料核对与具体裁决提案) | DDR Rev. C、100 MHz、16 SW/LED、8 AN、CA～CG/DP、5 按钮和 CPU_RESETN；拨码运算映射允许学生选择 | 板卡电气映射与 ALU 语义映射分开版本化；不执行 XDC/Tcl，不补题目空白域 |

2026-10-12，只读核查本机 Ubuntu WSL 为 x86_64 / Ubuntu 24.04.4，KVM 存在；以 root 只读确认 C1 专属 qcow2 和 maintenance key 文件仍在。原目录 0700，因此默认非特权账号的文件存在性探测不能证明文件缺失。C1 VM 服务当前 LoadState=not-found / ActiveState=inactive；其瞬态启动单元不在运行，本次未调用启动脚本，未读取私钥内容。专用 guest 的当前系统、Docker、剩余空间、工具链和 ready 尚未复查；[C1 历史节点记录](C1_ISOLATED_RUNNER.md#141-专用节点与实际版本)仅作准备依据。

宿主未装 Icarus，现有 apt 缓存列出的 amd64 候选为 `iverilog=12.0-2build2`，包 SHA-256 为 `f19394cee05ad526e0eb3873bc6c17a5828f56df17fbe2db40cb66513a2d4667`。这是包元数据，不是 guest 已安装或构建通过。本机默认 Node 为 24.15.0，仅用于文档检查；批准的应用 Node 24.21.0 在实施前独立核对，不能用默认版本代替应用验收。

## 3. 引擎、镜像与可信构建提案（DL-D02）

建议继续使用现有 C1 的专用 QEMU/KVM Linux VM。应用/SQLite、宿主目录及密钥不挂入学生容器。批准后先按 [现有 vm.sh](../../apps/teaching/runner/vm.sh) 启动原专属盘，再通过原 maintenance/known_hosts 身份核当前节点；不新建 VM/密钥或改变全局 WSL 配置，原 C 数据与镜像保留。

| 项目 | 建议固定值与验收要求 |
| --- | --- |
| 引擎 | Icarus Verilog 12.0，Ubuntu `12.0-2build2` amd64 包；iverilog/vvp/iverilog-vpi 同源同版本，记录实际 `-V`、包及二进制 hash。选择 Noble 已有稳定包以减少安装范围，不声称它是最新版 |
| 上游追溯 | [v12_0](https://github.com/steveicarus/iverilog/releases/tag/v12_0) 的解引用源码 commit=`4fd5291632232fbe1ba49b2c26bb6b2bf1c6c9cf`；发行包含 Debian/Ubuntu 补丁，不能把 tag hash 当成包字节 hash |
| 基镜像 | Docker Official Image Ubuntu 24.04 的 linux/amd64 manifest=`sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b`。2026-10-12 从 [官方 Registry](https://hub.docker.com/_/ubuntu) 只读解析 index=`sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55`；使用平台 manifest 固定 FROM，未拉取 layer |
| 派生镜像 | 构建阶段安装上述固定 Icarus 包及编译平台自有 C bridge 所需工具；运行阶段仅带 vvp、匹配 VPI 与实际动态库，不带 shell、编译器或学生可装插件入口。记录所有实际包版本/hash、VPI 源码/hash和派生 image ID；派生 ID 尚未生成，生成并验收后才允许 ready |
| 语法 | 固定 `-g2012` 的课程 RTL 子集：module、组合逻辑、always_ff/always_comb、寄存器、计数、case、位运算、多文件和快照内 include。逐项目标环境测试；不承诺全部 SystemVerilog、UVM、DPI、厂商 IP 或实体 FPGA 时序 |
| 构建输入 | 只编译确认快照的 `.v/.sv`，`.vh/.svh` 仅作快照内 include；固定 argv、顶层与受信目录。拒绝任意 flags/命令/插件、路径逃逸、外部 include 与保留桥接模块名；预处理依赖清单核全部来源属于本次快照/平台固定资产 |
| 端口校验 | 平台自有、匹配该版 Icarus 的编译期 target API 提取已 elaboration 的顶层端口名/方向/位宽；再校获准板卡映射。不能只用正则解析源码或将端口补齐/截断警告当成功；提取/校验失败不产生可装载 Build |
| 诊断 | 保留真实 compile stdout/stderr 的限量原文和结构化文件/一基行号；只将已确认的源文件映射回 fileId/version/hash。无列号不猜列，标 line-only，避免编译器字节列冒充 UTF-16；平台/工具错误与学生语法错误分开 |

[官方编译选项](https://steveicarus.github.io/iverilog/usage/command_line_flags.html)和 [ivl_target API](https://steveicarus.github.io/iverilog/developer/guide/ivl/ivl_target.html)支持上述工具选择；其文档说明不证明本项目样例、隔离或协议已通过。编译成功、板卡绑定有效、ALU 课程行为与正式评价四者分别表达。

## 4. 板卡、初始化与模拟推进提案（DL-D01）

`BoardProfile` 建议包含 boardProfileVersion、mappingVersion、contentHash、topModule、顶层输入/输出的命名位映射、极性、时钟、初始化与采样规则。顶层及端口名使用受限 HDL identifier，向量明确逐位对应，不接受任意层级表达式/可执行映射。C 校核方向、宽度、重复绑定和存在性；A 负责批准并冻结活动配置，UI 消费同一版本。允许等价端口命名/向量组织，不强制题目示例 SW→M/S/A/B/Cin 分配。首批平台板卡范围为 SW16、LED16、AN8、CA～CG/DP、五按钮及 CPU_RESETN；未使用按钮/复位可不绑定，但明确 unavailable，不能伪造输出。

电平沿板卡事实：LED 高亮，五按钮按下/松开为 1/0，CPU_RESETN 按下/松开为 0/1，AN/CA～CG/DP 低有效。段位序明确为 a～g 和 dp；帧传原始逻辑，不从 F 数值补译码。多 AN 同时有效、全关闭、段码异常、X/Z 均保留；显示扫描摘要附每位有效时间/覆盖和原始帧引用，不强行改为单个位选或正确十六进制。

建议时基 1 ps，100 MHz 时钟周期 10000 ps / 半周期 5000 ps。初始 CLK=0、SW=0、五按钮=0、CPU_RESETN=1；不强行把学生内部寄存器置零。学生 HDL 中声明的初值按引擎执行，未初始化仍为 X。ALU 不增加复位判分要求；状态保持/重装工程夹具可在其已声明复位端口明确配置一个两周期复位序列，规则与 hash 固定，不能应用到其他实验。

引擎只在学生显式交互后批量推进，页面定时器不驱动 HDL 时钟。输入于 CLK 低相位施加，随后按固定半周期推进；用平台 VPI 在当前时间片组合/NBA 逻辑完成后的只读相位采样，起始帧和每个完整周期的稳定帧可核。采样时间、边沿顺序和无进展行为在实际 v12 引擎验证；若回调规则不成立，停止该批并提出差异，不能退回随机延迟采样。

输出使用 MSB-first 固定宽度 `0/1/x/z` 字符串，时间用十进制 `simTimePs` 字符串，避免 JSON 浮点截断。VPI 只采已绑定真实端口；[VPI 官方说明](https://steveicarus.github.io/iverilog/usage/vpi.html)仅说明机制。协议与学生 stdout/stderr 分通道，不注册可由学生任意调用来提交结果的系统任务；运行镜像禁止非平台 VPI/DPI/宿主路径。独立管道、文件描述符可达性、`$fopen`/`$system` 伪造与退出反例必须目标实测，未证明来源隔离前不能将帧标可信或开放 ready。

## 5. Build/Session、顺序与恢复提案（DL-D03）

下表是交 DL-A #38 汇总的 C 侧最小领域协议。公共 HTTP 路径、A 的课程/活动/runtime 分流、授权投影与 B/UI 的 ObjectRef 扩展尚未批准，不在本任务单方冻结。原 Purpose、JobStatus、C RunRecord、TextScope 参数与错误码不改义。

| 对象/命令 | 最小字段与行为 |
| --- | --- |
| 共同执行身份 | 服务端构造 courseId/studentId/attemptId/activityVersionId、commandId/receiptId/requestHash、recoveryGeneration；客户端只提交预期版本/幂等键与获准对象 ID。节点再核原身份/摘要，ID 或 hash 本身不授予权限 |
| `BuildArtifact` | buildId/jobId/runId、snapshotId/hash、boardProfileVersion/mappingVersion/runtimeProfileVersion/engineVersion、imageDigest、配置/产物 hash、诊断、status 与 terminationConfirmed。`Job.kind=hdl_build,purpose=student_run`，runId 保留有限执行关联。只有真实构建和顶层校验成功的不可变产物可 program；新构建不改变原装载 |
| `program` | 指成功 buildId、expectedAttemptRevision/代际；新 sessionId 绑定固定 Build/源码/板卡/映射/引擎，按 §4 初始化。已有会话时显式给 replaceSessionId/expectedSessionRevision，先确认旧实例终止再新装载；旧状态/结果保留，装载失败不谎称旧实例仍活跃 |
| `SimulationSession` | sessionId、Build/快照/配置引用、sessionRevision、confirmedSequence、simTimePs、原节点身份、状态、停止意图、创建/截止/最后操作时间、已确认帧引用。建议状态 starting/active/stopping/stopped/failed/outcome_unknown；失联不是 stopped |
| `interact` | sessionId、expectedSessionRevision、expectedSequence、代际、完整输入 SW/按钮/复位电平及 advanceCycles；按下/松开是两次独立操作。每个 Session 只允许一个在途命令；事务中先占原 operationId/sequence，再做网络推进，最后同事务核租约/身份/版本并接纳原结果 |
| `SignalFrame/Trace` | sessionId/buildId/snapshotId/hash、board/mapping/engine 版本、operationId/sequence、simTimePs、原始四值 SW/按钮/LED/AN/segments/DP 与覆盖。Trace 是已确认操作的有限波形窗口，游标含原会话/序号/内容 hash；GET 不推进、不触发运行或续空闲期限 |
| `stop`/取消 | 原 sessionId/Build 或 operationId、预期版本/代际；短事务保存持久停止意图与事件，提交后发节点控制。停止须能取消正在等待/推进的操作，不能被其串行锁卡住；确认进程/容器/控制管道全部退出后才释放资源 |
| `query`/对账 | 仅查原 buildId/sessionId/operationId 与摘要。重连先同步代际/停止/当前序号；丢响应只查询原操作，禁止换键重新推进。相同键/摘要返回原接纳 IDs，异摘要为 IDEMPOTENCY_CONFLICT，旧序号/版本拒绝 |

有限 Build 和装载/推进操作复用现有 Job、租约、CommandReceipt 与 AuditEvent；持久 Session 本身不是长期 running 的 C Job。HDL 操作 kind 分派与 GET Job/cancel 的领域定位要覆盖所有调用方，避免旧 workspace worker 或取消处理器要求 workspace_runs 而误拒/误执行。单个 student_run 在途限制保留，Session 空闲不占该 Job 限制；具体 runtime 关联由 A 冻结后再接正常宿主。

同事务接缝建议为：读取确认快照/活动获准配置，保存 Build/Session/操作，按 attemptId 保存 HDL stop 意图，以及读取获准结果投影。复用 `loadWorkspace/persistWorkspace`、A 的 `withAuthorizedResource/withTransaction` 和 C3 原事件/回执，网络/容器控制不放进 SQLite 短事务。活动/分配/个人暂停、提交或权限撤回应同事务停止对应 HDL 接纳并登记取消；采集暂停只停过程数据，显式仿真操作仍是功能记录。A 的控制事务通过 C 接缝调用，不能另开库双写或仅靠 UI 停按钮。

应用进程重启维持原代际，查询节点原 Session/operation；节点存活且原 worker/容器/身份完整才继续。节点/controller/engine 重启导致状态无法证明时标 outcome_unknown，对账并确认原资源退出；不重启 vvp 冒充旧寄存器或重演按钮。停止容器不能完整恢复寄存器状态；重新装载必须学生新命令、新 sessionId，明确初始化。旧备份恢复由 A 提供可靠新代际屏障，C 继续对账旧原 ID，旧 queued/迟到帧不能复活。操作已执行而应用未收结果时，保留原结果可补取；正文丢失保持 unavailable。

Build 错误、无进展、输出/资源超限、引擎异常是领域 failureKind/缺口，通过现有 INVALID_REQUEST/INVALID_REFERENCE/INVALID_CONFIGURATION/STATE_CONFLICT/VERSION_CONFLICT/RECOVERY_REQUIRED/RUNTIME_NOT_READY/CONTENT_LIMIT/DEPENDENCY_UNAVAILABLE 等信封返回，不新增未评审公共错误码，不把执行结果未知记成课程通过。

### 5.1 待授权的三表合成存储

建议只新增三张 C 领域表，板卡/runtime 配置从 A 的不可变活动版本读取；不为第二课程另建账号、活动、工作区、教学或回执表。

| 表 | 必需独立列与约束；其余确切正文保存 JSON/hash |
| --- | --- |
| `hdl_builds` | build_id PK、attempt_id FK、job_id UNIQUE FK、run_id UNIQUE、snapshot_id FK、配置版本、status、artifact_hash、build_json；绑定源码/作用域列与 JSON 一致；成功产物关联不可回写 |
| `hdl_sessions` | session_id PK、attempt_id FK、build_id FK、request_receipt_id FK、generation、revision>0、status、confirmed_sequence>=0、pending_operation_id、session_json；同 Attempt 最多一个未确认终止 Session（含 stopping/unknown），确认退出后才能解除唯一占用 |
| `hdl_operations` | operation_id PK、session_id FK、job_id UNIQUE FK、request_receipt_id UNIQUE FK、sequence、request_hash、status、result_json/result_hash；UNIQUE(session_id,sequence)，序号 0 留给 program、1 起为后续输入/推进；结果与 hash 同空/同存，确认结果不可替换；stop 意图保存在 Session，不等待推进序号锁 |

Build/Session/操作结果追加可核审计，保留旧装载与波形引用；有上限的窗口不是无限采集完整内部节点。确认输出存在 operations 原结果中，不增第四张逐信号/逐时钟事件表，AuditEvent 只保存操作引用。波形持久容量达到上限时明确停止后续 trace 接纳并终止/报限，不改写已引用帧以腾空间。

数据库操作需明确批准：由 A 提供或授权 C 对 [transaction.ts](../../apps/teaching/server/db/transaction.ts) 作仅新增 `createDigitalLogicDatabase` 的工厂接缝，基于原 26 表教学合成库增加上述三表，共 29 表；仅新建系统临时目录中保留的 `synthetic.sqlite`。旧六种工厂/已有库不变，不做 ALTER/迁移/删除，不合并 A 的 teacher-design 表。统一业务宿主/schema 整合留给 DL-A 评审，不因本三表方案自动获得生产建库授权。

## 6. 会话限额与 C 公平调度提案（DL-D04）

以下仅为单个本地演示实验的保守起点，获批并目标测量后才采用；任何需要更改这些数值的发现记录差异再确认。原 C 两槽、编译 30 秒/执行 10 秒、1 CPU/512 MiB/64 进程/128 MiB/64 KiB 全部保留。

| 范围 | 建议上限与处理 |
| --- | --- |
| HDL Build | 全节点并发 1，排队到终态 120 秒，实际编译/端口校验累计墙钟 30 秒；0.5 CPU、512 MiB、64 进程、128 MiB 临时空间、stdout+stderr 64 KiB；无 VPI 成功自报代替外部校验 |
| Session 数量 | 全节点最多 2，同学生/Attempt 最多 1（starting/stopping/unknown 均占位）；每实例 0.5 CPU、256 MiB、32 进程、32 MiB 临时空间。空闲时 vvp 等输入，不自由推进时钟 |
| HDL 执行调度 | Build 和推进共享一个 HDL 活跃令牌，Session 空闲不占 C 两槽；C 保留原两槽与优先 CPU 权重，HDL CPU 权重较低。令牌持有、候选等待和超时在受信节点监督，不能只由浏览器配合；C 连续作业/HDL 连续操作负载下各自饥饿/限时实际测量 |
| 每次推进 | 1～5,000,000 个完整周期（最多 50 ms 模拟时间）；墙钟 2 秒，无进展或超时终止该 Session/操作并核资源退出，不将复杂学生电路超时当答案错误。该周期规模能否支撑实际八位扫描必须测量，不能预先声明通过 |
| 生命周期 | 原 Session 墙钟总寿命 30 分钟；连续 5 分钟无已接纳显式操作回收，GET/前端刷新不续命。暂停终止会话；本人恢复 Attempt 不自动重新装载，旧原 Session 只读历史 |
| 波形/输出 | 每操作返回最多 4096 个稳定变化帧、64 KiB 协议正文；超出的中间变化明确标 incomplete/dropped 并保留完整采样计数与最终帧，不将抽样当全量覆盖。每 Session 累计持久 trace 上限 1 MiB、学生日志累计 64 KiB；达到容量/输出上限明确结束，不无限积存 |
| 隔离和退出 | UID 65534、只读 rootfs、无网络/capabilities、no-new-privileges、匹配 cgroup 内存+swap/PID/CPU 限额；固定快照只读，临时空间独立。独立 watchdog 即使应用/controller 消失仍执行生命周期、输出和终止守卫；未确认退出不释放配额 |

对关闭容器/停止服务的“清理”只指终止资源并保存确认，不含删除文件、容器对象、镜像、账本或 Git 历史。测试残留和盘占用先登记，不触发自动 prune。原节点 2 vCPU/4 GiB 能否满足 C 与 HDL 混合负载是待验项；未达目标先报告，不能自行扩 VM、删旧数据或降低 C NFR。

## 7. 预计写入范围、交接和实施顺序

本表是批准后才可执行的范围，新增模块名可在对应目录确定；不创建表中列出的目录/文件来绕过待批门禁。

| 归属 | 最小实现/调用方范围 |
| --- | --- |
| C runner | 在 [runner/](../../apps/teaching/runner/) 新增 HDL profile/端口校验、有限构建、平台 VPI bridge、Session/操作监督、持久原身份对账、受限波形、镜像/验收；controller、ssh-control、fingerprint、install-node 仅作同一认证入口和安装/readiness 必需分流。原 C compilerArgs/DockerExecutor/RunControl 行为不更改 |
| C 契约 | 在 [contracts/runner/](../../apps/teaching/contracts/runner/) 新增批准的 HDL 领域协议并扩展节点命令；[contracts/workspace/](../../apps/teaching/contracts/workspace/)及 records 只作已评审 C 投影/接缝。ObjectRef/课程/runtime 联合字段由 A 汇总，不单方扩 B 的输入 |
| C 服务端 | [workspace/](../../apps/teaching/server/workspace/)的 Build/Session/operations 存储与受控方法/测试；[records/](../../apps/teaching/server/records/)的原 Job kind 分流/事件/取消/节点结果核验；workspace application/worker/commands 和控制停止需兼容旧 C 并保留唯一公共路由 |
| A 最小接缝 | transaction 新合成工厂仅按 §5.1 的明确文件授权处理；A 负责 design/common 课程/BoardProfile/runtime 关联、授权定位、控制事务和正常宿主分流，具体 DL-A 批次批准后再联合对接，不接管 A 的完整任务 |
| 测试/夹具 | runner、workspace、records 既有 test glob 内增加真实 HDL 和领域回归，合成账号/数据；沿原 Node/lock/build，不加 npm 包。夹具允许不同 RTL/映射，不作为给学生的 ALU答案模板 |
| 文档 | 本文维护实现位置/授权/失败/验证/交接；README 更新批准后的真实运行与验证说明。产品/规划基线仍待授权维护者汇总 |

顺序：负责人批准本 C 侧方案/运行与合成存储范围 → A 汇总冻结跨模块 DTO/活动配置及接缝 → C 在独立分支/工作树先完成目标引擎/真实结果和停止恢复 → 按 A 当前交付分批接授权/业务层 → 交 B/UI 精确结果/诊断，不等待模型或 UI 美化 → 保存分层证据并交 C5。A/B/UI 未交的批次保持未完成，不能用 C 的夹具签收对方评审。若负责人仅批准独立引擎批次，则仅实施该批次，公共接口/schema 继续等待。

## 8. 验证计划与本次准备结果

| 验收/编号 | 批准后必须实际验证 |
| --- | --- |
| DL-C-V01 / DL-AC-02 | 真实 HTTP 保存 `.sv/.v`，ACK/hash/多标签 CAS/进程重启；新草稿和新快照不改变原 Build/Session；跨学生/课程/私有对象拒绝 |
| DL-C-V02 / DL-AC-03 | 目标镜像/工具/VPI 指纹、支持语法；语法/缺 module/方向/位宽/重复映射/非法 include 失败及定位；编译成功而端口失败不可 program；伪造 stdout passed 无效 |
| DL-C-V03 / DL-AC-04 | 同一 vvp PID/容器多次输入保持计数/寄存器，按下和松开顺序可核；重复交互只有一次推进，丢 ACK 原操作可补取；重装产生新身份和明确初始化，不重演旧输入 |
| DL-C-V04 / DL-AC-05/06 | 错误译码/错误 AN 与修订后同输入产生真实不同帧；NBA/组合稳定相位、100 MHz/八位扫描、时间与采样覆盖；X/Z/多位/全关闭保留；波形/输出满额不装作完整 |
| DL-C-V05 / DL-AC-07、AC-10/12 | 两实例无共享状态/文件、无网络/应用密钥/他人源码；无限循环/无进展/OOM/PID/临时区/输出限制；取消在途、空闲/总寿命、引擎退出/VM重启/失联/重连/旧代际；独立 watchdog 和确认退出后释放；协议帧伪造反例 |
| DL-C-V06 / 原 C 回归 | 原 C 编译/运行/检查、SSH 身份/两槽/取消/未知/结果文件和 A2 readiness 无回归；节点源码改变后重做 C 指纹匹配；C+HDL 混合负载报告实际延迟/超时/饥饿，不改 NFR 数值 |
| DL-C-V07 / 交接 | 向 A 交当前 readiness/指纹与同事务控制；B/UI 获准精确 snapshot/Build/Session/时间/波形及诊断，读接口不驱动模拟。向 C5 列备份 RPO/RTO、控制/VM故障与资源负载未验项；真实模型、实际 UI/Demo 不计成本地引擎通过 |

2026-10-12，本次准备验证仅做文档/范围核查，默认 Node 24.15.0；仓库根执行下列只读命令，无数据库/节点操作授权要求，不安装依赖：

```powershell
node tools/a0-review/check.mjs
git diff --check
```

| 本次检查 | 实际结果 |
| --- | --- |
| 文档静态检查 | 通过，退出码 0；38 份文档、586 处内部引用、27 条正式变更路由，errors=[] |
| 空白与范围 | `git diff --check` 通过；另以只读 Node assert 核 README 原有非标题内容逐行保留、固定 H2 不变、新任务无尾随空格且有末尾换行、待批/未实现/未验状态齐全。当前仅 README 与本文有改动 |
| Issue/环境/供应链只读核对 | #39/#38/#43 Open、#24 Closed；WSL/KVM/专属盘及原认证文件存在性、VM 非运行状态、apt 包 hash、上游 tag 解引用、Registry 平台 manifest 已核，无节点/层拉取或凭据值输出 |
| 应用/目标环境/教学验收 | 未执行：目标 guest/HDL、合成数据库、应用 typecheck/业务回归、真实模型、浏览器/真人与教学收益。环境历史结果不计新增通过 |
| 提交/推送/Issue 管理 | 未执行；#39 保持 Open，C4 未开始，产品/计划进度待授权维护者汇总 |

P3/DL-C 尚未完成；批准后的实际代码位置、验证命令/结果、失败及交接继续维护本任务记录。

## 9. 需要负责人决定的准确范围与风险

建议批准 §3～6 的 C 侧引擎/板卡运行/生命周期与限额方案，允许 §7 的 C 领域实现；公共字段/HTTP/课程接入仍经 DL-A #38 汇总确认。同时单独授权 §5.1 三表/29 表新临时合成工厂和 transaction 的最小新增接缝，以及启动/停止现有专属 VM、在 guest 内新建 HDL 镜像/隔离容器与合成故障验收所需的具体维护操作。节点同步保留原配置/数据；若过程中必须改认证密钥、删除、扩 VM 或处理真实库，另报准确对象，不从本授权推导。

理由：持续实例的模拟时间、寄存器和幂等操作不能用原 C 一次性 RunRecord 或只存内存实现；新三表用于固定关联/原请求对账，目标 VM/VPI 用于验证真实来源和资源边界。风险：节点源码/指纹更新会使旧 ready 失效，VM/容器测试占内存和磁盘，维护重启可能中断节点作业；schema 是新增合成结构，仍属于 AGENTS 红线。实施前查无真实业务作业，再保留旧事实复验，不删库/盘/结果换取通过。

申请不包含修改 AGENTS/product/planning/reference、A/B/UI 完整任务、生产/旧库迁移、文件/历史删除、`.env`/密钥/token/CI/CD、真实学生/教师私有数据发送、付费模型、公开推送/PR或生产部署。获准后另追加明确批准原文、范围与时间；当前全为待批准。

## 10. 2026-10-12 批准与实施记录

负责人对第 9 节准确申请直接回复“批准，并授权”。本次实施据此批准第 3～7 节 C 侧方案、三表/29 表新临时合成库与 transaction 最小工厂接缝、现有专属 VM 维护和 HDL 镜像/故障验收；不重复询问已批准范围。公共 HTTP/课程/runtime/ObjectRef 与正常宿主仍由 DL-A 汇总确认，受保护基线、其他作者任务、凭据/删除/公开发布等排除范围继续生效。

执行状态：开始实施；下文随实际代码和验证更新，未完成项不提前计通过。

目标实测的实现调整：runc 的 proc-safety 检查拒绝以 tmpfs 替代整个 `/proc`，改为专属 AppArmor 规则禁止 `/proc` 和 `/dev/fd` 等文件描述符路径，仍保留 seccomp、无网络、只读根与全部资源上限；规则未启用/未验收时不能开放 HDL。新会话频繁查询还复现原 writeImmutable 在不同进程间暴露未写完 JSON 的窗口，已按原不可变/fsync 语义改为完成写入后原子硬链接发布，pending inode 保留，旧事实不覆盖；相应 C 共享调用方需回归。

## 11. C 侧实际实现、验证与交接

### 11.1 实现位置与边界

实现分支为 `codex/dl-c-hdl`，起点保持 `37849f4`。准备阶段 README/本文复制到独立工作树，主副本既有准备改动保留，没有覆盖他人改动。未修改 AGENTS、product/planning/reference、课程原材料、依赖/锁文件、凭据或 CI/CD；未公开推送、建 PR 或关闭 Issue，C4 未开始。

| 位置 | 实际交付 |
| --- | --- |
| [C 领域协议](../../apps/teaching/contracts/runner/hdl.ts) | Build/Session/原身份/顺序/四值帧/有限波形类型与节点命令；原 Purpose、JobStatus、C RunRecord 含义不变，未新建公共 HTTP 路径或扩 B ObjectRef |
| [profile/映射](../../apps/teaching/runner/hdl-profile.ts)、[构建/通道](../../apps/teaching/runner/hdl-executor.ts) | 快照/路径/顶层/位绑定校验，端口元数据后生成平台连接；有限构建、真实诊断、原始四值帧与独立日志通道。原 compilerArgs/DockerExecutor 的 C 语义不变 |
| [端口 target](../../apps/teaching/runner/hdl-ports.c)、[VPI](../../apps/teaching/runner/hdl-bridge.c)、[进程代理](../../apps/teaching/runner/hdl-host.c) | Icarus elaboration 元数据、运行 RW 相位初始化、完整周期 NBA/组合稳定后 RO 采样、平台输入与真实 HDL 输出。代理将学生 stdout 导向日志，协议用匿名 fd；AppArmor 阻断 proc/dev fd 路径，未注册学生可任意提交帧的系统任务 |
| [节点分流](../../apps/teaching/runner/hdl-node.ts)、[会话 worker](../../apps/teaching/runner/hdl-session-worker.ts)、[账本](../../apps/teaching/runner/hdl-ledger.ts) | 同一认证入口、有限 Build 与长期 Session 分开，HDL 全局活跃令牌、两实例配额、原操作/摘要与代际、独立单调时钟生命/空闲守卫、停止/异常与原身份对账，不自动重启 vvp 重建寄存器 |
| [构建 worker](../../apps/teaching/runner/hdl-build-worker.ts)、[退出监督](../../apps/teaching/runner/hdl-stop-worker.ts)、[维护屏障](../../apps/teaching/runner/hdl-maintenance.ts) | 创建意图/实际 container ID 分别持久化，确认整个单元退出后释放；无法证明保留 unknown。Engine/PID 屏障追加终止事实，保留原结果文件，不删除账本/镜像/容器对象 |
| [同事务业务](../../apps/teaching/server/workspace/hdl.ts)、[输入/持久核验](../../apps/teaching/server/workspace/hdl-inputs.ts)、[三表](../../apps/teaching/server/workspace/hdl-schema.ts) | createHdlWorkspace、Build/显式 program/interact、CAS/幂等、固定源码、原操作丢响应对账、原结果/波形读取、stopInTransaction/reconcileStops；Job/回执/审计复用原表，不建第二条教学链 |
| [合成工厂](../../apps/teaching/server/db/transaction.ts)、[已有宿主接缝](../../apps/teaching/server/workspace/application.ts)、[C worker](../../apps/teaching/server/workspace/worker.ts) | 新 createDigitalLogicDatabase 仅建 29 表临时合成库，旧工厂不增表、不迁移；显式 hdl 选项须同库，原 Job 路径按 kind 分流/鉴权/取消，个人暂停同事务停止 HDL；C worker 不误领 HDL。无替代 UI 或自动账号/业务监听 |
| [原子持久文件](../../apps/teaching/runner/node-files.ts)、[并发回归](../../apps/teaching/runner/node-files.test.ts) | 同一原 helper 修正跨进程半写窗口；完整 inode fsync 后原子发布，拒绝覆盖，保留 pending 硬链接；共享 C 调用方已纳入回归 |
| [镜像](../../apps/teaching/runner/hdl.Dockerfile)、[策略](../../apps/teaching/runner/hdl.apparmor)、[准备](../../apps/teaching/runner/hdl-prepare.ts)、[安装](../../apps/teaching/runner/hdl-install.sh)、[验收](../../apps/teaching/runner/hdl-acceptance.ts) | 原 VM/认证材料复用；只新增非密钥配置、专属 policy 和单一控制服务的代码路径 override。readiness 核源码/镜像/平台/策略强制执行与当前验收，不能用历史 passed 开放 |

实现中进一步核实：Icarus v12 在 StartOfSim 已清空初始化队列，此时直接写入平台输入会留下未传播的 functor 初始化；改到运行的 RW 相位再驱动，真实计数与段码随输入变化的原断言通过。依据为 [v12 schedule.cc](https://github.com/steveicarus/iverilog/blob/v12_0/vvp/schedule.cc)及目标反例，不从输出数值补造显示。未使用按钮/复位的输入寄存器仍由平台初始驱动显式保留，学生内部寄存器未强制归零。

启动容器的确认阶段单独最多 30 秒，确认 Running 后首次稳定帧/学生零时间循环与每次推进均按 2 秒墙钟守卫，未延长推进限额。readonly 稳定采样、真实扫描/X/Z、190 个变化帧的保守实现上限与最终帧、sampleCount/droppedFrames/incomplete 一并交付，仍不超过批准的 4096 帧/64 KiB；1 MiB 累计波形含初始帧。后续扩大窗口需实际测量，不将抽样写成全量覆盖。

首次镜像构建误沿用 Docker 默认删除中间构建容器的行为，与准备方案的保留约定不符；已如实说明，后续统一使用 `--rm=false`，没有删除专属盘、原 C 镜像、源码、业务结果、库或 Git 历史。原始层/派生镜像/导入缓存保留，不执行 prune。Registry 在 guest 超时后使用 [固定基镜像导入](../../apps/teaching/runner/import-hdl-base.ps1)，manifest/config/压缩层/diff_id 全部 SHA-256 校核；不修改代理、TLS 或凭据。

### 11.2 实际环境与可重复验证

目标 guest 为 Linux amd64、kernel `6.8.0-146-generic`、Node `24.21.0`、Docker `29.8.2`、cgroup v2/seccomp、`xunjie-dlc-v1` AppArmor enforce；与原历史 kernel 差异保留，按本次实际环境核，不沿用旧指纹。固定 Icarus `12.0-2build2`；基镜像源 manifest 仍为第 3 节值。构建 image ID=`sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d`，运行 image ID=`sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5`。

已安装的受认证应用通道读回 HDL ready=true：sourceHash=`5ff1d2257ec5164e3e6deef503df44c2c55362dd240e5e2a44dfb4e663278d6f`，HDL fingerprint=`7e6a49546cf1b65e58199c33c26e642c73c4b7582c0abd8f58af34b28f6fb612`。current generation 必须每次从当前控制面读取；测试维护会登记新 synthetic-generation，不把配置初值写成当前业务授权。验证记录追加于专属节点 `state/hdl/validation.jsonl`，只表示执行环境事实，不是课程/业务/UI 开放许可。

批准 Node 24.21.0、原 lock 依赖的 `apps/teaching` 目录，可复验如下；仅用新临时合成库，不启动节点或模型：

```bash
npm run typecheck
npm run build
node --test runner/node-files.test.ts runner/hdl-profile.test.ts server/workspace/hdl.test.ts
node --test server/records/*.test.ts server/workspace/*.test.ts
```

在已准备且获准、无真实业务作业的专属 guest 维护窗口，使用上述 Node 与实际非密钥配置；所有结果/原 ID 保留，物理节点配置由 C 维护方交接：

```bash
/opt/xunjie-runner/node/bin/node /opt/xunjie-runner/source-dlc/runner/hdl-acceptance.ts /opt/xunjie-runner/config.dlc-final.json
```

原 SSH 专项从持有原 application/maintenance/known_hosts 的已授权 Linux 宿主，在 `apps/teaching`、Node 24.21.0 下执行；包含合成故障与代际登记，不能在真实学习窗口运行：

```bash
XUNJIE_C1_SSH=1 node --test runner/node.rpc.test.ts
```

| 实际检查 | 结果与覆盖 |
| --- | --- |
| typecheck/build | 通过，精确 Node 24.21.0 / TypeScript 7.0.2 / 原 lock；没有忽略类型、关闭检查或更换依赖 |
| C 侧最终 workspace/records | 61 项：59 通过、0 失败、2 项真实节点开关未启用而跳过；含新合成库/HTTP ACK、幂等、固定源码、丢响应/重装、权限/代际/停止及唯一公共 Job 接入 |
| 新接口专项 | 8/8 通过（四项 profile/四项领域）；另一次并发文件＋领域组合 8/8 通过。这里的合成 node transport 不算真实 RTL/浏览器通过 |
| 目标 HDL | 14/14、0 跳过；真实计数状态、同操作不重复推进、位宽/语法失败位置、错段码与修订/X/Z、stdout/proc fd/不支持 shell 伪造、双实例与配额、稳定扫描/明确丢帧、零时间无进展终止 |
| 目标原 C 节点 | 51 项：50 通过、0 失败、1 个宿主 SSH 入口在 guest 跳过；原 C 编译/运行/可信 Core/Report/退出/限额/路径/产物与不可变文件保留 |
| 宿主实际认证 SSH | 10/10、0 跳过；角色/任意 shell/未知凭据拒绝，可信 Core/Report、累计 10 秒/64 KiB、取消、controller/worker 故障/原 ID/Engine 屏障及新代际；不是 C2/UI 或教学验收 |
| 普通 WSL 全量 | 291=274 通过＋9 失败＋8 跳过，完整回归未通过；失败集中在认证/原教学与 A2 样例，不宣称修好 #23。固定未修改 HEAD 在同环境全量亦为 275=264 通过＋4 失败＋7 跳过，含原认证失败；原认证/记录两文件单跑 24=23 通过＋1 跳过。未逐项证明九项同根因，不修改认证/时限迁就结果 |
| 模型/浏览器/真人 | 未执行，供应商网络调用为 0；不计 DL-E2E、G3、教学收益或 P4/P5 通过 |

新目标测试初期的 mount 参数、proc-safety、SV `$unit` 根、Unix socket 长度、VPI 初始化相位及启动/无进展计时反例已保留于准备记录和节点验收；修复根因后原真实计数/错误/四值断言通过。维护保活到期曾使原 VM 停止，本次重新启动原专属盘并重新核对/验收，未丢弃旧 ID/元数据或冒充原寄存器继续。

### 11.3 给 DL-A/B/UI/C5 的交接与整卡未完成项

DL-A 显式提供获准、固定活动上的 BoardProfile/HdlRuntime 和当前代际，调用 `createHdlWorkspace({db,currentGeneration,transport,approvedProfile})`；使用新授权合成工厂可验证 C 领域，长期业务库整合仍由 A 提案/授权，不自动迁移。已有 `createWorkspaceApp` 显式传同库 `hdl` 即可复用原 Job 查询/取消与消费分流；normal host 仍需 A 装配，默认 main 未改成新应用入口。

有限 Job 由 `pendingJobs/processJob` 消费；A 的活动/分配/权限撤回/提交事务调用 `stopInTransaction`，事务提交后正常消费者调用 `reconcileStops` 传递停止并对账。个人暂停与 Job/cancel 已接 C 自有路径，跨模块控制不能仅靠关闭 UI。B/UI 从 `readBuild/readSession/readTrace` 及 C2 的确切快照读取真实原文/诊断/模拟时间/四值与覆盖；GET 不推进或续空闲，当前对象不沿用新草稿行号，客户端先同步代际/停止/版本。

交接仍须完成：DL-A 的课程/活动/runtime/公开路径/资源定位与事务接入、B/UI 共享消费和 ObjectRef 评审、两课程正常入口；实际浏览器的编辑/按下松开/停止/新草稿隔离/同输入修复重装与恢复。没有这些证据不勾整条 DL-AC-02～07，不关闭 #39；C 本域真实结果可先交接，不等待模型或 UI 美化。

C5 继续验证真实并发负载下 C 公平调度/NFR 完整口径、30 分钟/5 分钟长测、资源极值/OOM/PID/临时区/输出全套、故障中并发权限撤回/旧备份代际与完整 RPO/RTO/导出、现场应用丢响应/掉线与恢复。当前目标故障和静态边界证据不能代替这些系统/应用层验收。原 C 与完整 M/AC/NFR 条件保留；产品/规划进度待授权维护者汇总。

### 11.4 2026-10-13 原始证据与最终核对

最后复核新增了“成员权限撤回后用户不能读/操作，但受信 worker 仍可终止原资源”的反例，修正内部清理错误复用用户读取守卫的问题；[接口最终 9/9](../../apps/teaching/runner/hdl.evidence/hdl-service.txt)通过（四项 profile/五项领域），typecheck/build 再次通过。前表的 8/8 和 61 项是各自已执行时点范围，未改写为新增后全套统计。

原始日志：[目标 HDL 14/14](../../apps/teaching/runner/hdl.evidence/target-hdl.txt)、[目标 C 50/51](../../apps/teaching/runner/hdl.evidence/target-c.txt)、[认证 SSH 10/10](../../apps/teaching/runner/hdl.evidence/authenticated-ssh.txt)、[C/workspace/records 59/61](../../apps/teaching/runner/hdl.evidence/c-domain.txt)、[typecheck](../../apps/teaching/runner/hdl.evidence/typecheck.txt)、[build](../../apps/teaching/runner/hdl.evidence/build.txt)、[WSL 全量失败](../../apps/teaching/runner/hdl.evidence/wsl-full-failed.txt)与[未修改基线全量失败](../../apps/teaching/runner/hdl.evidence/baseline-full-failed.txt)均保留，不只保留成功样例。日志内历史运行目录只是执行事实，团队入口是这些仓库相对文件，不要求访问个人工作目录。

Node 测试失败输出自带空格行与命令输出的 EOF 空行会触发 Git 空白检查；对应五份日志/JSON 的原字节先以同名 `.gz` 保留，显示文本仅规范化尾随空白/EOF 空行，内容与通过/失败统计不变。[原始/显示 SHA-256 清单](../../apps/teaching/runner/hdl.evidence/original-manifest.json)列出精确压缩附件与摘要，未关闭空白检查或改写失败事实。

2026-10-13，同一源码下原 C 的 guest/SSH/实际全应用 strict 类型检查三个执行结果均为退出 0，以原 `record-validation` 维护入口追加[当前 C 验收记录](../../apps/teaching/runner/hdl.evidence/c-validation.json)，经 application SSH 读回 C ready=true、HDL ready=true。C fingerprint=`1dbbf2dbb9730b0121518d114a457f27282baad1e391253c93804c57e831edba`，sourceHash 与第 11.2 节相同。guest 历史 typecheck 安装路径当前缺失的首次尝试失败也已确认；使用本次精确 Node/lock/相同源码的已执行 WSL 全应用 strict 类型检查证据，不伪造该 guest 命令成功。

本地分支可审阅，发布仍未授权；Issue #39 保持 Open，DL-A/B/UI 与 C5 未完成条件按第 11.3 节交接。当前没有修改受保护文档或安排自动跟进，也没有以本域验收关闭原 C、P2/P3、#22/#23/#45 或正式产品条件。
