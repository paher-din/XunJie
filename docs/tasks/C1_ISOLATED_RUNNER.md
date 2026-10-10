# C1：独立隔离执行、可信检查与安全验收

日期：2026-10-09（Asia/Shanghai）。任务编号：C1。主责：C。Issue：[C1 #12](https://github.com/paher-din/XunJie/issues/12)；下游：[A2 #13](https://github.com/paher-din/XunJie/issues/13)、[C2 #14](https://github.com/paher-din/XunJie/issues/14)。

**当前状态：C1 节点实现与独立验收完成。第 13 节已获完整批准，专用 QEMU/KVM Ubuntu VM、受认证控制面、可信 Core/Report、全部 NFR-03 限额与真实进程/VM 恢复通过，应用入口实际 ready=true。最终源码结果与 A2/C2 交接见第 14 节；第 2～13 节保留其当时事实。** C1 #12 尚未执行远端关闭；本机批准不授予基线写入、删除、业务数据库或公开发布权限。

## 1. 已读依据、范围与文件责任

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按顺序阅读 [PRD](../product/PRD.md) 第 3.2/4.4/5/8/9 节、[MVP_SPEC](../product/MVP_SPEC.md) 第 1.3 节、M-02/03/07/10、第 4～6 节，以及 [TECH_DESIGN](../product/TECH_DESIGN.md) 第 1～3/4.1/4.3/5.1/7.5/8/11/12 节。另读 [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) 第 2/4/5/8.5 节、[工程衔接](../reference/ENGINEERING_HANDOFF.md)、[C0 来源稿](C0_WORKSPACE_RECORDS_RUNNER.md) 第 8 节及 [G0 裁决](G0_CLOSURE_PROPOSAL.md#10-2026-10-09-负责人统一裁决及基线同步)、[G1 门禁](G1_OVERALL_COORDINATION.md#4-当前进入门禁与阻塞)。正式产品 v0.3 优先于旧作者稿的历史待审状态。

| 对应基线 | C1 负责交付 | 边界 |
| --- | --- | --- |
| PRD-07/10、M-07/10 | 固定快照的独立编译/运行、可信检查及失败事实 | stdout、课程判定和个人能力分别表达 |
| M-02、TECH 8/12 | 实际 profile/镜像/环境指纹与就绪证据 | 未通过安全验收时不开放活动，不占位 ready |
| AC-10、NFR-03 | 路径、挂载、网络、权限、资源和整个单元终止实测 | 宿主 smoke、文档与替身不能代替 |
| AC-15 的执行/验证器部分 | 禁止任意命令；私有资产隔离；伪造 passed 无效 | 辅导入口/限定帮助事务接 A/B/C2，不由 C1 单独宣告整个 AC-15 通过 |
| TECH 7.5/8.1 | 原 runId 对账、持久取消、恢复代际及未知状态 | 不重复运行，不因失联释放槽位 |

前置资源提案阶段仅写本文及 README；本机实现与收口批准分别见第 11/14 节，源码位于 `apps/teaching/runner/`，批准的节点接缝位于 `apps/teaching/contracts/runner/`。AGENTS、product/planning/reference、其他成员任务稿只读。未另建公共 ActorContext/业务 Job 定义。A 负责 package/锁文件/tsconfig、公共契约和应用入口，C 不另建共享工程或私自替换运行时。调用方包括 A2 的 profile 就绪读取、C2 的提交/查询/取消及结果接纳；B 仅通过获准投影读取诊断。A1/C2 的真实业务授权/事务接入仍待对应任务，不由节点的服务身份代替；UI、生产部署不纳入本次 C1 实现。

## 2. 本次实际资源核查

以下结果在本次 C1 中重新只读核查；没有启动 WSL、修改系统、安装软件或运行学生程序。

| 对象/命令 | 实际结果 | 结论 |
| --- | --- | --- |
| Git 状态与 remote | 开始时 `main` 工作区干净；origin 为本项目 GitHub 仓库 | 无已有改动需要覆盖；未提交或推送 |
| Windows 系统/CIM | Windows 11 家庭版 x64，10.0.26200；16 个逻辑处理器，33,601,966,080 字节内存；虚拟化已启用 | 可作为准备本地测试 VM 的硬件起点，不是执行安全证明 |
| `wsl --list --verbose` | 仅 Ubuntu，WSL2，Stopped | 现有个人发行版未启动，内容/工具链/挂载未知 |
| `Get-Command` | 未发现 docker、podman、qemu-system-x86_64、VBoxManage、vmrun、multipass、Get-VM；存在 wsl/ssh | 仅证明 PATH 中未发现，不能断言机器上绝无其他安装；无可直接使用的专用节点 |
| `node --version` | v24.15.0 | 与批准的 24.21.0 不同；未升级，不将本机版本用于正式应用验收 |
| C1 Issue 与 comments | #12 为 Open，正文已读，无评论 | 资源门禁/实测退出条件保持有效 |
| 官方 GCC manifest 只读请求 | 读取候选 index、linux/amd64 manifest 和层元数据成功；未下载镜像层 | 仅证明候选已发布，不证明实际 GCC/运行/安全就绪 |

现有 Ubuntu WSL2 不直接充当专用节点：Microsoft 说明 WSL2 发行版运行在管理 VM 内，并提供 Windows 文件访问/互操作；本次未核查其数据与边界，因此不能把“已有 Ubuntu”写成独立执行就绪。[WSL 架构](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)、[WSL 文件访问与配置](https://learn.microsoft.com/en-us/windows/wsl/faq)

## 3. 专用节点与操作提案（待负责人确认）

推荐先使用一台专用 Linux 测试 VM，只用于 C1 合成数据和两槽执行。若已有可用专用节点，优先复用；没有现成节点时，需先确定本地独立 VM 的承载软件与操作范围，不在既有 Ubuntu 内直接安装并假定隔离成立。

| 项目 | 推荐值/操作 | 当前状态与影响 |
| --- | --- | --- |
| 系统/资源 | Ubuntu 24.04 LTS，linux/amd64；2 vCPU、4 GiB 内存、20 GiB 磁盘作为测试起点 | 无实际节点；规格是 C 的建议，峰值和磁盘余量须实测，不授权采购 |
| 专用边界 | VM 不承载应用/数据库/个人开发；不共享宿主盘、剪贴板、个人 home、其他 VM 或学生目录 | 需核实际 VM 配置，不能仅依赖每作业容器 |
| 容器引擎 | 在获准节点按官方 Ubuntu 方式安装 Docker Engine/containerd，记录实际精确版本和有效 seccomp/cgroup | 尚未安装；如存在冲突包，不按安装指南自动卸载，删除另行确认 |
| 控制面 | runner 仅监听节点 loopback；应用通过受控 SSH 隧道接入，节点身份/应用服务身份分别核验；Docker socket 仅节点控制进程可访问 | 节点地址/已有认证方式未知；密钥、token、账号和隧道配置另获具体授权，不写入本文/日志 |
| 持久存储 | 节点本地持久盘保存最小执行账本；每作业独立源码 staging 和 128 MiB 有界工作区 | 不挂业务 DB；存储结构及写入操作待批准；不自动删除临时数据 |
| 出网 | 准备阶段仅获取批准的软件/镜像；作业容器始终 network none，控制面不公开映射端口 | 节点出网/私网访问由负责人确认；不能把节点安装所需出网授给学生作业 |

Docker 官方支持 Ubuntu 24.04，但安装、权限、端口及有效内核能力仍需实际检查。[安装说明](https://docs.docker.com/engine/install/ubuntu/)、[控制面与容器安全](https://docs.docker.com/engine/security/)

## 4. 固定 C profile 提案（待批准及实测）

候选编译镜像为 Docker Official Image `gcc:15.3.0-trixie`，由官方清单和 Registry 元数据核对。[官方 GCC 清单](https://raw.githubusercontent.com/docker-library/official-images/master/library/gcc)、[打包源码](https://github.com/docker-library/gcc)

| 指纹 | 2026-10-09 只读取得的候选值 |
| --- | --- |
| index digest | `sha256:1fdcd041afad61e21d4ca0f8046e36f8da61baaa815f5ba290e39a15c487926a` |
| linux/amd64 manifest digest | `sha256:980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5` |
| image config digest | `sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa` |
| 压缩层合计 | 8 层，552,569,745 字节；实际解包空间未测 |

获准后按 linux/amd64 manifest digest 拉取并核实际 GCC、libc、静态库、Engine/kernel/cgroup/seccomp 指纹；不依赖可变 tag 或 `latest`。GCC 的 C17 模式支持由官方文档核对，实际工具链编译兼容仍未执行。[GCC 标准模式](https://gcc.gnu.org/onlinedocs/gcc/Standards.html)

拟固定编译器 argv 为 `gcc -std=c17 -O0 -Wall -Wextra -pedantic -static <approved absolute source paths> -o /work/textscope`，由快照中 `.c` 清单按 UTF-8 路径排序生成；头文件/公开 ASCII 数据只读挂载到 `/snapshot`。不使用 `-Werror` 把普通警告变成阻断，不执行学生 Makefile，不接受编译 flags/命令/镜像/宿主路径。各文件正文/hash/清单和总量遵守 TECH 4.1 与 M-03，C2 确认后 C1 再核。

运行阶段拟采用独立最小 `scratch` 镜像及静态产物，只启动 `/work/textscope`，避免把编译器和 shell 工具带入运行阶段。**这是待审的 profile 实现选择，尚未构建，最终运行镜像 digest/静态链接兼容性未知。** 编译阶段仍置于受限容器内；一个作业的所有编译/测试容器纳入同一终止/限额账目。若静态链接不可行，先记录实际原因并提交替代提案，不自行换编译方案。

Core 的 stats/find/top 与 Report 参数映射由课程配置生成固定数组，数据路径从本快照解析；错误参数只用批准的固定样例。Report 输出名暂建议 `report.txt`，由教师/A 的固定活动版本确认 `approvedResultFiles` 后才能使用，不擅自把文件名建议写成课程规则。

## 5. 隔离与限额落实方案

两阶段均非 root（候选 UID/GID 65534）、只读根、只读源码、无网络、cap-drop ALL、no-new-privileges、启用并记录有效 seccomp；不使用 privileged、host PID/network、引擎 socket 或不受限配置。编译所需暂存、二进制和 Report 共享本作业有界工作区；TMPDIR 指向其中，不能另开无上限的可写卷。工作区在节点侧有界挂载，容器全部终止后仍可安全读取白名单产物，不依赖停止即消失的容器 tmpfs 回取。

| NFR-03 约束 | 实施与实测判据 |
| --- | --- |
| 1 CPU | 显式 `--cpus=1`，核有效 cgroup CPU 配额并测负载 |
| 512 MiB 含 swap | 显式 memory=512m、memory-swap=512m；核有效 cgroup，保留 OOM 事实，不从普通退出码猜测 |
| 64 进程 | 显式 pids-limit=64，核 pids 事件和终止后整个 cgroup 无存活进程 |
| 128 MiB 临时空间 | 每作业唯一 128 MiB 工作区，核真实写满拒绝及所有可写路径；编译/执行不能各取得一份独立预算 |
| 编译 30 秒/执行 10 秒 | 阶段累计墙钟预算，包括同作业各次测试，不能为每步骤重置；超限终止整个作业单元 |
| 总输出 64 KiB | 编译/执行 stdout、stderr 与回取产物累计原始字节；超限终止/分类，不能只截展示或每阶段重置 |
| 全局最多两个作业 | 单一节点调度器持久保留两个槽；取消/失联未确认终止仍占槽；同 Attempt 仅一项由 C2 与节点守卫对齐 |

Docker 需显式设置资源，memory 与 memory-swap 相等禁止容器 swap；默认 seccomp 是机制起点，需核实际生效和拒绝行为，不关闭以通过 GCC 测试。[资源约束](https://docs.docker.com/engine/containers/resource_constraints/)、[seccomp](https://docs.docker.com/engine/security/seccomp/)

## 6. runId、持久账本与启动/取消提案

以下细化 TECH 7.5/8.1，属于待审实施机制，不新设公共字段/错误码。C 的 contracts/runner 复用基线的 runId、原请求摘要、可信 authorizedScope、recoveryGeneration、固定快照/输入/profile 与模式；teacher_sample 绑定独立课程样例，不伪造学生 Attempt。A 汇总需要细化的公共定义。

1. 单一节点控制进程先校验可信身份/范围/当前代际，再持久记录接受或取消事实，持久化失败不 ACK。相同 runId/原摘要/归属返回原事实，异摘要用既有冲突语义拒绝；query 不新建作业。
2. 账本只长期保存原命令/runId 关联、归属、摘要、配置/快照/输入 hash、接受/启动/取消/终止、结果引用和缺口。不得把控制面凭据、学生源码、私有答案或消息全文复制进长期账本。实际落盘机制/结构先评审，不创建 SQLite schema 或实际文件账本。
3. 取消可早于 submit，先持久保存 intent。每个 runId 的创建/启动/取消决策串行；发起 Docker create/start 前持久记操作意图与确定性容器身份，取消后不再发起新阶段。
4. 将已发出的每一项 create/start 都登记为 pending。取消过程中停止所有已知容器，同时等待 pending 操作取得可对账的确定终结；迟到创建取得 ID 后仍必须停止，不能再启动。整单元包含编译及每次检查的所有容器/子进程。
5. 只有 pending 全部结清且整单元确认停止、无迟到创建可能，才持久 ACK cancelled 并释放槽。CLI 断线、超时、404 或“此刻不存在容器”均不能证明该条件。无法排除 Docker daemon 内待处理操作时保持 cancelling/outcome_unknown 与槽位，待对账或获准的节点停机/引擎恢复解决，不自动换 runId 重跑。
6. 普通 runner 重启保留代际、先对账账本/容器再接新作业；旧备份恢复由 A 的可靠登记点颁发新代际，C 确认旧单元及 pending 状态后接纳新代际。旧消息拒绝，不能回退节点账本或补造缺失正文。完整备份演练后续与 C5/A 协作。

实现前需针对“持久意图后/daemon 接受前后/响应丢失/取消先于提交/worker 重启”注入故障，验证串行决策和 Docker 副作用之间的空窗。仅状态机替身通过不能证明上述真实机制成立。

## 7. 可信检查、失败与结果文件

RunRecord 保存固定版本及编译/执行事实；CheckResult 在学生进程外由受信验证器比较批准规则、预期退出/输出/覆盖。`mode=run` 不产生课程 passed，stdout 中的 passed 没有授权意义。错误样例可预期退出 1/2；资源、取消、启动/工具故障与未知返回 incomplete，不能写成知识错误。沿用基线/C0 失败来源，包括 compile_error、program_error、带阶段 timeout、oom、process_limit、temp_limit、output_limit、cancelled、infrastructure_error；不足以分类时保留未知，不自行新增公共枚举。

私有答案/验证器规则/完整私有日志只在可信侧；学生容器仅获所需测试输入与批准文件，不挂应用 DB、密钥或他人目录。课程规则、可见诊断与限定帮助事务依教师/A/B/C2 交付，合成固定规则只计工程验证。

所有容器/进程终止且 pending 已结清后，可信侧按 approvedResultFiles 打开节点工作区文件；逐路径组件拒绝 symlink、逃逸、目录/设备/FIFO 等非普通文件，不用字符串前缀代替路径边界。读取过程核来源、字节数和内容 hash，将产物计入合计输出预算；缺失/不可回取标 missing/incomplete。交 C2 的引用含不可变 resultFileId、runId/snapshotId、相对名、正文/contentHash/字节数/来源；读取再次授权，绝不自动回写 ProjectFile。整个单元未确认停止时不回取或声明报告完整。

## 8. 验证计划与关闭条件

以下均尚未执行；合成攻击/耗资源样例只在实际专用节点安全约束生效后运行。每项保存环境指纹、固定输入/源码 hash、命令、实际结果和失败，测试产物不进入真实学生记录。

| 用例 | 必需证据/判据 | 对应 |
| --- | --- | --- |
| C1-V01 profile 与普通编译/运行 | 固定 digest、C17/static/多文件/头文件/ASCII 文件可用；事实绑定旧快照，不读当前草稿 | M-07/10、AC-04 |
| C1-V02 路径与来源 | 绝对/父目录/反斜杠/重复路径/symlink/hash 不符及非法 source 被拒；无任意 Makefile/flags/shell | AC-10/15 |
| C1-V03 权限/挂载/网络 | 非 root、cap/seccomp/no-new-privileges 实效；访问外网/控制面/socket/宿主及合成他人/应用 canary 被拒 | AC-10 |
| C1-V04 编译/执行超时 | 30 秒/10 秒阶段累计限制，所有子进程终止，应用可用，无孤儿单元 | NFR-03、AC-10 |
| C1-V05 内存/进程/临时区 | 512 MiB 含 swap、64 pids、128 MiB 真实生效；分类有 cgroup/文件错误事实支撑 | NFR-03、AC-10 |
| C1-V06 输出累计 | 跨编译/执行/stdout/stderr/多字节/产物，64 KiB 边界与超限实际终止，不只截显示 | NFR-03、AC-10 |
| C1-V07 并发/未知槽位 | 最多两个作业；第三项排队；同 Attempt 一项；取消失联保留槽，不能产生第三个实际单元 | NFR-03 |
| C1-V08 幂等/认证/代际 | 同 runId 原作业/异摘要拒绝；越权 query/cancel 拒绝；普通重启保留代际、旧代际拒绝 | TECH 7.5/8.1 |
| C1-V09 取消与迟到创建 | cancel-before-submit、pending create/start、daemon 响应丢失、节点重启；确认后绝无迟到单元，未知时不 ACK/释放槽 | AC-10/12 |
| C1-V10 可信验证 | 自印 passed 不通过；批准退出 1/2 可判正确；编译/工具/资源故障保持不完整；私有答案不可读 | AC-15 执行/验证器部分 |
| C1-V11 产物 | 普通白名单文件及 hash/来源；symlink/逃逸/FIFO/超限/缺失拒绝或标缺口；终止前不回取；不写回作品 | TECH 8.4、AC-10/15 |
| C1-V12 交接 | A2 真实 profile 就绪引用、C2 submit/query/cancel/RunRecord/CheckResult/产物/失败映射；接口/版本核对 | TEAM C1 |

C1 关闭须实际专用环境、批准 profile/最终镜像、可靠账本/认证/取消机制、全部对应实测及任务记录齐备。浏览器、完整帮助限制、真实服务端链、完整备份恢复和教学效果按原依赖另计，不降低阈值、不把本文或合成替身计作 AC/NFR 通过。

## 9. 操作顺序、所需决定与风险

1. 负责人提供可用专用 Linux 节点或选择准备本地独立 VM；明确节点标识/承载方式与允许操作。当前没有实际地址/VM，不能编造资源指纹。
2. 核查所选节点（OS/kernel、CPU/内存/磁盘、既有数据/软件/挂载、网络与 cgroup/seccomp），将实际对象补入本文；给出精确安装/配置操作。现成节点有冲突时先记录，不删除或覆盖。
3. 获准安装/配置 Docker、拉取固定 GCC 镜像、构建最小运行镜像、设置有界作业工作区后，记录最终 digest/配置；本次提案批准不包含任何密钥、.env、CI、数据库迁移或公开发布。Docker 管理权限很高，节点必须专用；镜像下载/VM 会占磁盘、内存和网络，限额测试会主动耗用约束内资源。
4. 审定本页 profile 与启动/取消/账本机制，和 A 对齐公共结构；只在 C 所有代码位置实施并补必要测试。A 负责批准版本的共享工程入口，当前本机 Node 差异不得静默覆盖。
5. 凭据/账号/认证配置、文件/容器/工作区清理涉及红线，另说明具体对象与范围并取得授权；不自动 prune、删除旧 Ubuntu、修改应用配置或推送公开仓库。
6. 实测第 8 节，失败修根因；A2/C2 交接真实就绪与限制。当前先完成 C1 准备提案，不越过节点门禁；C2 后续按首批已批准范围建立本人任务，不能因 C1 未就绪伪造运行结果。

请求确认的是实际执行资源与本页 C1 实施提案，基线写入权限仍独立。无产品结果变更；GCC/static/scratch、节点规格、控制面/账本细节及建议产物名均保持待批准/待核，不能据本文宣告正式配置已冻结。

## 10. 当前交付、验证与汇总请求

已交付本文及 README 导航。只读环境和公开 Registry 元数据核查完成；Registry 读取初次因响应字节未解码导致平台选择失败，修正 UTF-8 解码后成功，不记录认证 token，不将失败隐藏为一次通过。未拉取层、安装软件、创建/启动 VM/容器、编译执行、写凭据或账本；无正式 runner/契约/测试代码。

实际验证：`node tools/a0-review/check.mjs` 通过，24 份项目文档、198 处内部引用、27 条正式变更接口，errors=[]；`node --test tools/a0-review/check.test.mjs` 16/16 通过；`git diff --check` 通过。Git 状态确认仅 README 一行导航和本新建任务稿，受保护文件、旧作者任务与工具无差异；新稿末尾空白、候选摘要格式和限额/用例覆盖另以只读断言核对通过。以上只计静态验证，不计执行或业务通过。

AC-10/15、NFR-03、服务端/浏览器/真人与恢复验收均未执行，Issue #12 保持 Open。C1 进度与环境门禁待授权维护者汇总到 MVP 第 10 节/TECH/TEAM，本任务不修改这些受保护文件，不发送成员消息、不公开发布。

## 11. 本机 WSL2 开发执行记录

2026-10-09，项目负责人明确指定“用本机的开始做”，承接此前 WSL2 开发/合成验证与专用环境验收分别记录的说明。C 开始现有 Ubuntu 的只读检查和本地开发准备；不把这一选择解释成修改 TECH 8.2 的专用节点门禁。

实际检查：WSL 2.6.1.0，kernel 6.6.87.2-microsoft-standard-WSL2；Ubuntu 24.04.4 LTS、systemd、cgroup v2，cpu/memory/pids 控制器及 seccomp 可用。默认账号为非 root paher，维护命令可通过 WSL 的 root 用户执行。Node v22.22.1、GCC 13.3.0；未发现 Docker/Podman/runc/containerd。Windows 盘挂载存在，不能当作专用环境已隔离。Ubuntu 虚拟盘位于本机 D 盘，D 盘实际剩余约 330 GiB；Linux 内部报告的约 1 TiB 虚拟盘容量不当作 Windows 实际余量。没有搬迁/删除发行版。

编码/配置前的本批范围：在 C 所有的 `apps/teaching/runner/` 与 `apps/teaching/contracts/runner/` 交付固定配置、输入/来源校验、受限执行适配与必要测试；不修改 A 的 package/锁文件/tsconfig 或建立替代 UI。按正式字段/错误语义实现，新增共享结构/控制面接入细节留作提案，不能抢占 A 的定义。运行/源码/产物/失败与测试必须按基线完整覆盖，真实集成与未知项单列。

本地环境准备采用 Docker 官方测试用静态二进制 29.8.2，安装在节点 `/opt/xunjie-runner/` 的专属目录；批准的 Node 24.21.0 作为同目录便携运行时，不替换既有系统 Node/GCC。使用独立 Docker Unix socket、data-root/exec-root 和瞬态 systemd 服务，关闭 bridge/iptables/ip-forward/ip-masq，不增加普通账号 Docker 管理权限或公开端口。先记录精确版本/配置，再运行受限合成容器。不修改 `.wslconfig`、`/etc/wsl.conf`、.env、凭据或既有应用配置，不卸载冲突包、不自动清理容器/镜像/文件。静态 Engine 不自动获得安全升级，只用于本地测试，不成为生产部署方案。[Docker 二进制安装边界](https://docs.docker.com/engine/install/binaries/)

实际下载先核官方 HTTPS 和 Node 发布 SHA-256；软件包解包仅写新建专属目录，存在同名对象则停止核对，不覆盖既有工具。初次 WSL 显示 localhost 代理警告，但只读 HTTPS HEAD 最终均返回 200；本次未修改代理或网络配置。镜像/静态编译、资源/取消/产物和课程验证的实际结果后续在本节登记，未执行项不得计为通过。

## 12. 本机实验实现、验证及剩余门禁

### 12.1 实际交付

本机阶段跨 2026-10-09～10（Asia/Shanghai）；下表和最终结果为本次当前源码，不外推为正式产品验收。

| 代码位置 | 已实现范围 |
| --- | --- |
| [snapshot.ts](../../apps/teaching/runner/snapshot.ts) | 完整 UTF-8 正文/清单 SHA-256、路径/实例/数量/字节校验；固定 C17/static 编译参数，不执行 Makefile |
| [docker.ts](../../apps/teaching/runner/docker.ts) | 固定非 root/只读/无网络/无 capabilities/限额容器，流式合计输出、超时/取消、OOM/进程/写区事实；启动取消窗口持续停止，不能用一次“不在运行”放行 |
| [control.ts](../../apps/teaching/runner/control.ts) | 节点本地 append/fsync/校验链账本、原 ID/请求/归属/快照/输入/profile 去重；两槽/单 Attempt、取消早于提交、pending 保槽、原始结果 hash；注册授权的代际接纳、旧代际/回退拒绝 |
| [run-snapshot.ts](../../apps/teaching/runner/run-snapshot.ts) | 复制冻结载荷、从文件实例解析候选课程 argv、独立源码和有界写区、编译/执行/产物流程，保存真实镜像 ID；该内部参数类型不作为团队 UI 公共契约 |
| [result-files.ts](../../apps/teaching/runner/result-files.ts) | 终止后逐组件拒绝链接/非普通文件/逃逸、UTF-8/字节/hash/缺口、合计产物预算；不回写作品 |
| [verify.ts](../../apps/teaching/runner/verify.ts) | 受信配置中的单样例退出/输出比较，run 不产生课程通过；工具/资源/未终止均 incomplete；报告正文未验证时明确 incomplete |
| [runtime.Dockerfile](../../apps/teaching/runner/runtime.Dockerfile)、[import-gcc.ps1](../../apps/teaching/runner/import-gcc.ps1) | 无 shell/工具的最小运行镜像；WSL Registry 不可达时通过 Windows 逐层校验导入，匿名凭据不写文件/日志，无新第三方依赖 |
| [runner 目录](../../apps/teaching/runner/) | 六份对应 `.test.ts`，纯契约/文件与控制核心测试、真实本地容器测试分开；测试为合成数据，无学习记录/真实身份 |

控制类为 C 模块内部实现，`authorize` 必须由受信调用方提供，`authorizeRecovery` 默认拒绝；真实 A1 认证/授权、C2 原请求接纳与 A 的可靠代际登记未接入。原请求摘要由受信调用方构造，快照/实际 argv/profile 摘要另校验；不能直接把客户端身份/摘要当作认证。节点本地账本不取代应用 SQLite 的 Job/Receipt/Event 与同 tx 接缝，公共定义交由 A 汇总。

Core 正常参数的本机候选为 stats、find WORD、top -n N、report -o OUTPUT；原参考提供了这种语法，但产品基线只冻结行为和固定 argv 原则。候选映射须随实际活动/profile 经教师/A/C 确认，不能让实验 helper 单方冻结 UI/共享参数。错误样例运输、完整多样例累计预算及报告语义解析尚未交付，不通过当前单样例原语宣称完整课程检查完成。

### 12.2 环境及指纹

实际 Docker Engine 29.8.2、runc 1.5.2/libseccomp 2.6.0，overlay2、cgroup v2、seccomp builtin，memory/swap/pids 能力均 true。独立 Unix socket 与专属 data-root 正常，未开放 TCP/Docker bridge；Node v24.21.0 的官方发布校验和通过。Docker 归档本次 SHA-256 为 `995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f`，来源为官方 HTTPS，并非另有签名认证。

编译镜像已逐层验证 manifest/config/压缩层/解压 diff_id，导入后实际 image ID 为第 4 节的 config digest；命令始终使用内容 ID，保存原 Registry manifest 关联。运行镜像本次实际 ID 为 `sha256:e658256304c8484cf20c0e49a1b5a49178e9fa48fba7da85cff9368c38bae09e`。重建镜像会产生新的记录 ID，测试要求显式传入新建环境的固定 ID，不依赖可变 tag 或个人旧镜像。

首次瞬态服务启动后，WSL 自动停止造成 socket 不存在；检查专属日志后使用本次会话的 `tail -f /dev/null` 保持测试会话，再启动同一瞬态服务。没有改全局 WSL 设置、代理、系统 Node/GCC 或既有服务。Docker Registry 直连超时，通过仓库内导入脚本核对全部 8 层成功；本地下载缓存已被既有 node_modules 规则忽略。

### 12.3 可重复命令与实际结果

先在已准备的 Linux/WSL root 维护环境、仓库根目录运行：

```bash
# 核记录的 Engine/image ID；不使用 tag 作为运行载荷
/opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock image inspect xunjie-c1/runtime:local

# 从上一条核实的 ID 设置，仅是此测试进程的参数，不创建 .env
XUNJIE_C1_RUNTIME=1 XUNJIE_C1_RUNTIME_IMAGE=sha256:e658256304c8484cf20c0e49a1b5a49178e9fa48fba7da85cff9368c38bae09e \
  /opt/xunjie-runner/node/bin/node --test apps/teaching/runner/*.test.ts
```

镜像首次准备使用上述 Dockerfile，在专属引擎执行 `docker build --rm=false --force-rm=false --tag xunjie-c1/runtime:local --file apps/teaching/runner/runtime.Dockerfile apps/teaching/runner`；构建前确认源文件与许可范围，记录新 ID 后显式传给测试。所需的维护权限/软件准备已在第 11 节登记，其他节点不能假定同一路径已经安装或已获得操作授权。Windows fallback 为 `powershell -File apps/teaching/runner/import-gcc.ps1`，只写新建且被忽略的专属 cache，故障留存数据、不自动删除。

| 验证 | 本次实际结果与覆盖边界 |
| --- | --- |
| WSL 全套合成测试 | 2026-10-10 最终当前源码 36/36 通过，0 失败/0 跳过；10 项控制核心、12 项实际容器与组合流程、6 项快照、3 项文件、2 项参数、3 项可信比较（含两个父用例） |
| 实际容器 | 非 root、固定 C17/static/输入、根/源码/Windows 路径/socket/外网拒绝、10 秒超时、64 KiB 输出终止、OOM、128 MiB 实际写满、64 pids 拒绝、取消前置/启动窗口、产物链接拒绝及真实组合流程/重复 ID |
| 实际 cgroup | 运行期间从宿主读取 cpu.max=100000 100000、memory.max=536870912、memory.swap.max=0、pids.max=64，不用容器自报代替 |
| 控制核心 | 异步 ACL 并发去重、同 Attempt/两槽、pending 创建取消保槽、节点进程崩溃、journal 部分记录/损坏拒绝、结果 hash/再授权、可信注册代际及旧代际拒绝；其中授权/创建延迟替身属于隔离测试 |
| 可信比较原语 | stdout passed 不授予通过，批准的退出 1/2 可通过单样例比较，编译/资源/工具/报告未验证为 incomplete；真实课程资产/Report 完整验证未执行 |
| Windows 单元前测 | 8/9 通过，Linux symlink 一项明确跳过；其后 WSL 同项执行通过，不以 Windows 跳过代替 |
| 失败与修复 | 首轮 mount 缺 bind-propagation=rprivate 导致 10 项失败，补正确组合；第二轮 Report 合成源码缺 POSIX 声明导致 2 项失败，修正样例；startup/stop 单次竞态改持续停止，复测通过；未关闭安全检查或改编译阈值 |
| 类型检查 | Node 原生 TS loader 实际执行通过；单独 node --check 未解析 TS export，不作为类型检查。A 共享工程/tsconfig/依赖未交付，正式 TypeScript 7.0.2 typecheck 未执行 |

Windows 可从仓库根调用同一组测试：用 `$c1RepositoryPath = (Get-Location).Path`，再调用 `wsl -d Ubuntu -u root --cd $c1RepositoryPath --exec env XUNJIE_C1_RUNTIME=1 XUNJIE_C1_RUNTIME_IMAGE=<已核固定ID> /opt/xunjie-runner/node/bin/node --test` 并传入六份测试文件的仓库相对路径。初次 `--cd .` 被 WSL 拒绝，未执行任何用例；改为上述动态绝对路径后完整通过，不在文档写个人仓库路径。

最终文档校验 24 份/209 处仓库引用/27 条正式变更接口通过，检查器回归 16/16，Git 空白与本人新增文件检查通过。最终 Git 状态另有其他工作项维护的 G1 总协调文档，原样保留、不暂存/提交；本人修改为 README、C1 任务稿及 C 所有的 runner 文件，受保护基线无差异。

### 12.4 操作差异与剩余条件

镜像首次构建使用了默认 builder，实际移除了其新建的三个中间容器，和先前“不自动清理”记录不一致，已说明；没有删除既有目录、个人发行版、原容器或 Git 历史。后续构建显式 `--rm=false --force-rm=false`；本次测试生成的容器、缓存、文件不自动清理。最终本次 label 下 99 个容器，运行数为 0；节点 data/downloads/runtime 等约 2 GiB，实验写区/源码前次约 544 MiB，Windows 层导入 cache 为 3,688,474,399 字节（约 3.44 GiB）。tmpfs 的实验内容只在本次 WSL 生命周期保留，不能当团队证据入口；代码、命令、指纹及结果记录在仓库供复验。

仍未完成：

- **C1 正式资源门禁：** 个人 Ubuntu 仍挂载 Windows 盘并使用 WSL 共享内核，不是已批准/验证的专用节点；本地受限合成通过不自动通过 AC-10 或提供 A2 ready。
- **实际控制面/身份/恢复：** 真实服务认证、A1/A2/C2 对接及可靠注册位置、普通重启的真实活动对账、旧备份演练未执行。当前控制核心只按单一节点控制进程使用；跨进程单写者部署约束和 controller 消失后的独立 deadline/output 保障还需在专用方案中落实。
- **完整课程检查：** 私有固定错误样例、Report 文件格式/语义规则与教师审阅未具备；多测试累计 10 秒及编译 30 秒边界压力验证未执行。当前报告只交事实回取，比较原语遇报告一律 incomplete，不伪造课程通过。
- **正式工程检查：** A 的公共身份/版本/契约与实际 typecheck；C 的本地字段/参数/状态需交 A/C 对齐后才能成为共享接口。浏览器/真人/教学收益未执行。
- **基线/公开交付：** product/planning/reference/AGENTS 未写；待授权维护者汇总，未提交、推送、改 Issue 或向其他成员发送消息。C2 尚未开始，不把 C1 局部交付算作两个 Issue 完成。

上述缺口保持原门禁，继续处理已授权的独立工作；涉及共享行为/profile/权限/节点或清理红线时，以具体提案及相应授权进入下一步。

收尾核验：实际引擎内所有运行容器为 0，已仅停止本次 `xunjie-c1-docker` 瞬态服务（is-active=inactive）；核对同一保活启动时间与父子进程后，仅结束本次 WSL 保活 launcher/子进程。未执行 WSL shutdown、注销/迁移发行版或删除缓存/镜像/容器/持久目录；其他工作项的 G1 改动保持原样。本机测试环境再次使用需按上述瞬态配置启动并重新核指纹，不假定引擎常驻。

## 13. 2026-10-10 C1 收口方案（待负责人确认）

负责人要求继续完成 C1。重新读取 #12 和产品 v0.3 后，正式关闭仍需专用环境、实际认证/对账、完整可信验证及类型检查，不能沿用个人 Ubuntu 的局部通过直接关闭。以下是具体进入方案，不是已批准决定，也不授予基线写入权限。

### 13.1 专用 VM 与认证

本次实际检查发现 WSL2 的 `/dev/kvm` 存在（root/kvm、0660），QEMU 尚未安装；Ubuntu 本地包索引候选 qemu-system-x86/qemu-utils 为 `1:8.2.2+ds-0ubuntu1.18`，cloud-image-utils 为 `0.33-1`。设备存在只证明准备起点，KVM 启动、guest 内核、有效限额和安全行为仍需实测。[QEMU/KVM 官方机制](https://www.qemu.org/docs/master/system/introduction.html)

推荐在现有 WSL2 内新建 QEMU/KVM 独立 Ubuntu 24.04 guest：2 vCPU、4 GiB 内存、20 GiB 动态磁盘。它具有独立 guest 内核，仅挂自己的虚拟盘，不配置 9p/virtiofs/宿主磁盘/应用数据共享；不替换或迁移现有 Ubuntu。镜像从 [Ubuntu 官方源](https://cloud-images.ubuntu.com/noble/current/) 获取并按已登记 SHA-256 核对，固定实际版本。仅 localhost 映射 SSH 控制端口，QEMU monitor 为专属 Unix socket；guest 容器继续 network none，软件准备出网不授给学生代码。

申请的具体操作范围：在本机 WSL2 新增上述 QEMU/cloud-image 组件（apt 明确禁止移除包）、下载镜像、新建专属 guest 磁盘/启动配置并启动/停止本任务 VM，guest 内准备批准 Node/Docker/GCC/运行镜像。运行时与镜像只写本任务专属目录；遇既有同名对象不覆盖，旧 WSL/Windows 配置、CI、应用数据库和个人材料不动。风险为软件安装及下载占磁盘、运行时使用约 4 GiB 内存和最多 2 vCPU；KVM 不可用时停止并报告，不静默切软件模拟并降低验收阈值。

认证申请：仅在本任务专属、权限受限的 WSL 数据目录新建两套 Ed25519 SSH 密钥：维护密钥用于 guest 准备/恢复；应用服务密钥在 guest 中绑定固定 Node 控制入口（forced command、禁止 PTY/端口转发/任意 shell）。私钥不入仓库、不进日志，不改既有密钥；普通应用服务无恢复权限。首次 guest host-key 身份须从本机持有的控制通道核对，不关闭 host-key 检查。控制入口只接 submit/query/cancel/获准结果读取，scope/原摘要/代际按基线校验；客户端不能用 body 中的角色或 actor 冒充身份。真实学生课程授权仍由 A1/C2 负责，C1 验证应用服务身份与权限分离，不代做 A 的成员系统。

### 13.2 固定课程 profile 与 Report 格式

推荐确认本机已验证的 C17/GCC 15.3.0、`-O0 -Wall -Wextra -pedantic -static`、固定 source 清单/argv，运行镜像不含 shell/工具。最终 guest 镜像及监督机制发生变化时登记新 digest，不复用旧就绪；控制进程消失时的独立限额保障、单写者/两槽及迟到创建对账须补实测。正常命令采用 §12.1 候选形式，错误参数仅来自固定受信课程样例。

Report 建议采用下列 UTF-8 文本格式（路径用 JSON 字符串表示，避免空格/转义歧义）：

```text
FILE "a.txt" 3 8 37
FILE "b.txt" 1 3 14
TOTAL 4 11 51
UNIQUE 7
TOP c 3
TOP is 2
TOP memory 2
TOP and 1
TOP fast 1
TOP fun 1
TOP matters 1
```

FILE 行同时提供完整文件清单及同列统计；文件顺序可调整，TOP 必须符合次数降序/词字典序升序且覆盖前 10 个词（不足则全部）。记录间空行、字段间非语义空白和末尾换行可变；JSON 路径内部内容不能 trim 或改变。路径只接受本次获准输入的逻辑名或对应 `/snapshot/` 名，并绑定文件实例/hash；不得用 basename 匹配其他路径。拒绝重复/未知记录、缺失文件、错数值/词/排序/覆盖。该格式补充 MVP 1.3 的具体课程配置，须负责人确认后实现，不自行把示例写成正式规格。

结果文件本版确认 `report.txt` 为白名单；可信比较在学生进程外，stdout passed 不授予通过，预期退出 1/2 和系统故障分别处理；错误样例资产不挂学生容器。仅合成安全/课程样例，仍不操作真人会话。

### 13.3 类型检查及共享接缝

TypeScript 7.0.2 已在 TECH 3.1 批准，其 npm 元数据为平台原生编译器；本机没有现成 tsc/Node 类型声明。申请临时类型检查工具：TypeScript 7.0.2 及其 linux-x64 平台包、`@types/node@24.10.9`、其元数据依赖 `undici-types@~7.16.0`，从官方 npm 元数据固定实际 tarball/integrity后只写被忽略的 C1 工具缓存；不改 A 的 package/锁文件/tsconfig，不安装到系统全局。它们仅校验 C 模块，不成为自行冻结的应用依赖。

node-local 类型继续基于 TECH 7.5/8 的既有含义，具体 wire/schema、RunRecord/CheckResult/产物/失败与真实 ready 入口交 C 的 contracts/runner；先列字段/权限/错误/代际对应，按此次收口内容确认后实施。A 的 ActorContext、业务 Job/Receipt/Event、同数据库 tx 和 UI 不修改；正式 A/C 接入仍须核实际提供者，不能以本节点的测试服务替代真实学生登录。

### 13.4 不依赖新决定的修复

按既有 NFR-03，产物只要实际读取了字节，就必须消耗累计预算，不因 UTF-8 错误/文件变化而退回预算。本次先修正 result-files 中这条实现偏差并补反例，不新增额度或公共语义；其余原契约下的错误处理、去重及输入边界可以继续，§13.1～13.3 未确认前不执行其依赖操作。

## 14. 2026-10-10 收口方案批准与执行

项目负责人明确选择“批准第 13 节全部方案，继续完成 C1”。批准范围为 §13 的专用 QEMU/KVM guest、所列组件/节点准备、两套专属 SSH 密钥、固定 C profile/Report 格式和白名单、临时类型检查工具、监督/控制面/契约与对应验证。该批准允许按上述内容推进，不包括受保护基线写入、删除/历史改写、CI/实际业务数据库或公开发布。实际版本、镜像、命令和通过/失败/未执行结果在本节追加，不把批准本身计作验收。

实施细化：节点单写者由专属 systemd 服务及 flock 保障；已认证应用 SSH key 的 forced command 仅转发受限 JSON 命令，actor 从密钥绑定入口产生，不接受请求体角色。维护 key 的恢复入口另行授权。wire 请求包含既有 RunIdentity（runId/commandId/原摘要/作用域/代际/快照/输入/profile/digest）及 submit 的确认 Snapshot、entryFileId、课程 input、mode/checkRuleVersion；命令为 submit/query/cancel/readResult/readiness，恢复为维护入口 recover/advanceGeneration。原请求字段/版本/错误含义沿用 TECH；传输/内部 actor 标签不扩展 A 的公共 ActorContext。

运行由独立的 systemd 作业工作进程执行，保存临时固定载荷和不可变结果；控制进程重启不会杀掉作业的截止/输出守卫。普通取消先保存 intent，由工作进程等待其所有创建/启动操作结清后确认完整单元终止；工作进程异常时保留 unknown/槽位，维护恢复先停止工作进程和旧 Engine，确认原 Engine 已退出，再在新 Engine 对账所有原单元。这一实际进程边界用于排除旧 pending RPC 的迟到创建/启动，未完成对账不确认 cancelled。普通重启读取原 ID 的已有结果，不重跑；旧备份代际接纳必须通过维护身份，旧 queued 变 stale。

课程检查在一个作业内只编译一次，执行/产物共用 10 秒累计预算，stdout/stderr/产物共用 64 KiB；各样例写区隔开但共用一个 128 MiB 挂载。规则/预期结果只留在受信 Node 配置，学生容器只得到必要输入。RunRecord/CheckResult/产物引用绑定原 ID、快照/输入/profile/镜像与规则/验证器版本，actor 与故障事实不来自 stdout。

### 14.1 专用节点与实际版本

| 对象 | 本次实际值与边界 |
| --- | --- |
| 宿主准备 | 现有 Ubuntu WSL2 内安装 QEMU 8.2.2（包 1:8.2.2+ds-0ubuntu1.18）、cloud-image-utils 0.33；apt 0 升级/30 新增/0 移除；未改全局 WSL 设置或个人发行版 |
| VM | Q35/KVM、host CPU、2 vCPU、4096 MiB、20 GiB qcow2 动态盘；专属盘，不配置 9p/virtiofs/Windows 或应用目录共享；QEMU 进程额外不可访问 /mnt 和专属私钥目录 |
| Ubuntu 镜像 | 官方 noble/20260926 固定 daily amd64 cloud image；SHA-256 `6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`，按官方 SHA256SUMS 核对；guest Ubuntu 24.04.5、kernel 6.8.0-142-generic |
| Node / Engine | v24.21.0 / Docker 29.8.2、runc 1.5.2/libseccomp 2.6.0；overlay2、cgroup v2、builtin seccomp；guest swap=0 |
| 编译镜像 | GCC 15.3.0；Registry linux/amd64 manifest `sha256:980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5`，实际 config/image ID `sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa`；8 层及 diff_id 全部核对 |
| 运行镜像 | guest 实际 ID `sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99`；scratch，无 shell/编译器；构建保留中间容器，不清理旧对象 |
| SSH 身份 | localhost:2222，独立 maintenance/application 两套 Ed25519 key，父目录 0700/私钥 0600；guest host key 从本地 QEMU serial 通道核对后固定 known_hosts；application 强制单一入口、无 PTY/转发/任意 shell |
| 数据与控制 | guest `/opt/xunjie-runner` 是本方案固定的节点安装前缀，非个人工作副本入口；Docker 仅专属 Unix socket/data-root，控制 socket 0600；systemd+flock 单写者；账本/结果持久落盘，临时目录与测试数据保留 |
| 资源占用观察 | guest 可见 3915 MiB 内存，系统盘约 19 GiB、约 14 GiB 可用；宿主动态 guest 盘本次约 6.6 GiB。测试缓存/停止容器保留，没有自动清理 |

来源为 [Ubuntu 固定 daily 目录](https://cloud-images.ubuntu.com/noble/20260926/)及本次实际命令，不把官方机制说明当作安全通过。宿主 WSL 曾因没有前台会话自动停止，随后使用本任务隐藏保活进程维持 VM；它只维持本机测试生命周期，不改变全局 WSL 设置。最初 guest Engine 瞬态单元遮蔽持久单元，停止该瞬态服务、daemon-reload 后成功启用持久 Engine/socket；未删除或覆盖既有服务、目录或私钥。

### 14.2 实际模块与接口交接

| 位置 | 收口实现与调用方 |
| --- | --- |
| [contracts/runner](../../apps/teaching/contracts/runner/index.ts) | SubmitRun/RunnerCommand、RunIdentity/Snapshot/Profile、RunFact/RunRecord/PhaseResult/ResultFile 的节点类型；不定义 A 的 Session、ActorContext、业务 Job/Receipt/Event |
| [controller.ts](../../apps/teaching/runner/controller.ts)、[control.ts](../../apps/teaching/runner/control.ts) | 原 ID/摘要/作用域/引用及代际守卫、持久两槽/取消、独立作业监督、重启后的 queued 续取及原结果对账；unknown 保槽，维护恢复先停止原工作进程、排空旧 Engine，再核原容器 |
| [ssh-control.ts](../../apps/teaching/runner/ssh-control.ts)、[install-node.sh](../../apps/teaching/runner/install-node.sh) | 固定 forced-command 与私有 socket/systemd 安装；请求体角色/任意 shell/未获身份拒绝；应用服务没有 recover/advanceGeneration 权限 |
| [job-worker.ts](../../apps/teaching/runner/job-worker.ts)、[job-stop.ts](../../apps/teaching/runner/job-stop.ts) | 独立进程持续执行阶段时间/输出守卫，持久停止 intent/phase journal/outcome checksum；controller 消失不使限额失效；工作进程消失时不能凭此刻没有容器释放槽 |
| [course.ts](../../apps/teaching/runner/course.ts)、[report.ts](../../apps/teaching/runner/report.ts)、[stdout-records.ts](../../apps/teaching/runner/stdout-records.ts)、[verify.ts](../../apps/teaching/runner/verify.ts) | 输入实例绑定的 Core/Report 预期、stats/find/top/Report 语义比较、四个固定错误用例；规则只留受信进程，不挂入容器；stdout passed 无效，预期退出 1/2 可通过，资源/工具故障 incomplete |
| [run-snapshot.ts](../../apps/teaching/runner/run-snapshot.ts)、[result-files.ts](../../apps/teaching/runner/result-files.ts) | 编译一次、多检查累计 10 秒和 64 KiB、一个 128 MiB 挂载；每样例单独子目录但不重置预算；invalid UTF-8 已读字节仍扣预算；只读取白名单终止后普通文件，返回不可变产物、不写回作品 |
| [fingerprint.ts](../../apps/teaching/runner/fingerprint.ts)、[record-validation.ts](../../apps/teaching/runner/record-validation.ts)、[acceptance.ts](../../apps/teaching/runner/acceptance.ts) | 实际 guest、认证 SSH、strict 类型检查顺序执行；失败留日志且不写 passed；维护通道 append/fsync 验收记录，ready 核当前源码/契约/内核/Node/Engine/cgroup/seccomp/profile 指纹和实际镜像能力 |
| [vm.sh](../../apps/teaching/runner/vm.sh) | 仅启动/停止已批准准备的本任务 VM；核 KVM/专属盘/known_hosts，不创建密钥、安装软件、覆盖配置或删除数据 |

应用 SSH 入口的 stdin 为一个 UTF-8 JSON 命令，远端命令必须为空或固定 `xunjie-c1`，stdout 为一行 `{data:...}` 或 `{error:{code,message}}`。支持：

```json
{"op":"readiness"}
```

- `submit`：`{op,submission:{identity,snapshot,entryFileId,input,mode,checkRuleVersion?}}`。identity 的原 runId/commandId/requestHash/snapshot/input/profile/digest/scope 与代际需由受信 C2 调用方构造，不能从学生 body 直接当授权。input 仅 stats/find/top/report 的获准文件实例及课程参数；不接受任意命令、flags、镜像或宿主路径。
- `query`、`cancel`、`readResult`：`{op,identity}`；都重新核原关联与 scope。重复提交返原事实/引用，异摘要 409 含义 `IDEMPOTENCY_CONFLICT`、异 scope `FORBIDDEN`、旧代际 `RECOVERY_REQUIRED`；不知道是否终止时保留 cancelling/outcome_unknown/reserved。
- `readiness`：A2 核 `ready`、runtimeProfileVersion/imageDigest/compilerImage/runtimeImage、recoveryGeneration、fingerprint 和验收摘要；失联或 fingerprint 变化不能沿用历史 ready。它是环境事实，不授予课程开放、学生授权或教学通过。
- 仅维护入口：`recover`，以及可靠外部登记新代际后 `advanceGeneration`。A 的可靠登记点不随业务备份回退；C1 不自行接纳任意客户端新代际。普通重启维持当前代际/原 ID；旧 queued 在新代际下 stale，不能静默重跑。

RunFact 是节点控制事实；state=succeeded 只表示收齐已确认执行结果，不等于程序或课程通过。课程判定读取 RunRecord.verdict/CheckResult，执行诊断读取 phases/failureKind，恢复屏障结果另有 executionOutcome=outcome_unknown。节点内部 process_limit/temp_limit 是限额事实，C2 对外映射既有系统失败及相应限额，不单方增加共享业务错误码。维护恢复的未知结果只证明隔离单元已停止，不补造退出/报告/课程结果。

A1/C2 仍须在队列分派/最终接纳/结果读取重查真实成员、活动/Attempt 状态、限定帮助、停止/租约/代际，并在既有业务事务保存 Job/Receipt/Event/RunRecord。B 仅通过业务端政策投影读取诊断，不获得 SSH key、私有测试资产或节点原始结果的无限读取权限。teacher_sample 用独立快照/课程用途范围，不能造学生 Attempt/学习事件。下游未接入不影响 C1 独立节点验收，但不得宣称 A2/C2/完整 G1 已通过。

### 14.3 复验与操作说明

下面的 `/opt/xunjie-runner` 为方案的 Linux 安装前缀；仓库命令从任一工作副本根目录执行，不把个人 Windows 路径写入交付。

已准备宿主、同一专属盘/密钥/known_hosts 的维护环境运行：

```bash
sh apps/teaching/runner/vm.sh start
# guest SSH 启动就绪后，同步当前 C 所有源码；不传私钥
scp -i /opt/xunjie-runner/vm/keys/maintenance \
  -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts \
  -o StrictHostKeyChecking=yes -o BatchMode=yes -P 2222 \
  apps/teaching/runner/*.ts root@127.0.0.1:/opt/xunjie-runner/source/runner/
scp -i /opt/xunjie-runner/vm/keys/maintenance \
  -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts \
  -o StrictHostKeyChecking=yes -o BatchMode=yes -P 2222 \
  apps/teaching/contracts/runner/index.ts root@127.0.0.1:/opt/xunjie-runner/source/contracts/runner/
# 先核无真实作业；仅本任务合成维护条件下重启 controller
ssh -i /opt/xunjie-runner/vm/keys/maintenance \
  -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts \
  -o StrictHostKeyChecking=yes -o BatchMode=yes -p 2222 root@127.0.0.1 \
  systemctl restart xunjie-c1.service
/opt/xunjie-runner/node/bin/node apps/teaching/runner/acceptance.ts
```

acceptance 会故障注入、取消合成作业、重启专属 Engine 和注册新的测试代际，**只在无真人/业务作业的获准合成维护窗口运行**。依次执行 guest 容器/单元检查、宿主认证 SSH 检查、独立 strict noEmit 类型检查，原输出留在被忽略的新 cache；任一步失败不写新 passed。guest 内 SSH 测试入口主动跳过一项，因为宿主私钥不复制进 guest；对应全部真实 SSH 用例随后在宿主执行，不能把这个跳过当作通过。

应用服务读取真实就绪：

```bash
printf '%s' '{"op":"readiness"}' | ssh \
  -i /opt/xunjie-runner/vm/keys/application \
  -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts \
  -o StrictHostKeyChecking=yes -o BatchMode=yes -p 2222 root@127.0.0.1 xunjie-c1
```

独立类型检查工具位于获准的本任务 host 缓存：TypeScript 7.0.2/platform linux-x64、@types/node 24.10.9、undici-types 7.16.0；官方包 integrity 核对通过，不修改 A 的工程文件。安装/配置首次使用 install-node.sh，遇已有配置明确拒绝覆盖；源部署、host key 与密钥分发只能由获准维护者进行，不把 prepared 本机当其他开发者已有环境。

停止专属 VM 使用 `sh apps/teaching/runner/vm.sh stop`。停止不会删除镜像、持久盘、key、账本或已回取结果；内存临时区随 VM 停止消失，未回取正文不能从元数据补造。停止/失联后 A2 必须重新读取真实 ready；不能凭本文历史通过开放活动。本机当前保活 launcher 只用于此次 VM 生命周期，不建立自动定时任务。

### 14.4 验证事实与完成边界

2026-10-10，最终源码完整复验通过。专用 guest 45 通过/0 失败/1 guest 内 SSH 入口跳过；宿主完整认证/监督 8/8、0 跳过；独立 strict TypeScript noEmit 通过。原始成功输出与验收信封已纳入仓库：[guest](../../apps/teaching/runner/acceptance.guest.txt)、[SSH](../../apps/teaching/runner/acceptance.ssh.txt)、[指纹/三组输出摘要](../../apps/teaching/runner/acceptance.evidence.json)、[整台 VM 重启证据](../../apps/teaching/runner/acceptance.vm-restart.json)。不依赖个人 cache 才能核验交付。

| 最终验收 | 实际结果 |
| --- | --- |
| VM 与认证 | KVM/2 vCPU、无 9p/virtiofs/drvfs；主进程单写者锁有效；无凭据登录、应用任意 shell/角色 body/维护命令/畸形 body 拒绝 |
| 有效隔离 | 非 root、cgroup 配额实际观察、CapEff=0/NoNewPrivs=1/Seccomp=2、unshare 拒绝；根/源码写、外网、Engine socket、宿主路径/keys/私有验证器/其他作业目录拒绝 |
| 全部限额 | 1 CPU、512 MiB 含 swap、64 pids、128 MiB 共用写区、64 KiB stdout+stderr+产物；真实 GCC FIFO 阻塞在约 30.53 秒终止；执行 10 秒、多样例累计 10 秒、跨输出/产物预算超限均有实际证据 |
| 可信检查 | stats/find/top/report 正常输出和固定错误退出 0/2/2/2/1；Report 文本/hash/产物引用、空白/路径绑定/排序/数值反例、stdout passed 拒绝、编译/资源错误 incomplete；这些是合成工程验证，不是教学量规/学习成效验收 |
| 原作业/取消/恢复 | 重复原 ID 不重跑、异摘要/归属/代际拒绝；取消先于提交持久生效、启动窗口持续停止；真实两槽/单 Attempt、controller SIGKILL 后独立超时及 queued 续取；worker SIGKILL 保留 unknown/槽位直到维护 Engine 屏障 |
| 就绪与整机重启 | 应用 key 实读 ready=true；从无活动容器状态正常关闭 guest、用仓库 vm.sh 重启后 ready=true、代际不变、原 resultRef/结果 hash 不变；启动期间连接拒绝/超时如实等待，不关闭 host-key 核查 |
| 工程验证 | strict TypeScript 7.0.2 noEmit 通过，sh -n 两份脚本通过；文档静态检查/16 项回归通过，本人范围 Git 空白检查通过；A 的共享 package/锁文件/tsconfig 未修改 |

最终验收记录时间为 2026-10-09T18:38:14.054Z（Asia/Shanghai 为 2026-10-10 02:38），fingerprintHash=`b9cb9b0d3eb89b961a60e8e48cea984d2e2d13bc087c4aa05abffaaa2ce9351a`，sourceHash=`68b36737174c3f5ca1988b7d70f2bbd86878fb5ba910b7d81f571c483087826c`。guest/SSH 输出 SHA-256 分别为 `f90a72c7f81fe3793957bb31b7911cf4f929b37408b683563968e05492accc63` / `06a05e9b5d83d5066f2987edf747c06a7c8b35d1e4e981b56e738e4089328371`；类型检查成功空输出摘要为标准空字节 SHA-256。信封只支持该固定环境/源码通过，不是永久授权或任意机器 ready。

实际失败与修复：持久 Engine 切换最初被同名瞬态单元遮蔽；向整个服务组发 SIGKILL 的 CLI 因 auxiliary processes 返回错误，故障注入改为定向 main 并重测；维护恢复最初在 Engine 初始化完成前执行 info，改为有界等待实际可用；类型检查曾发现验收脚本 evidence 数组隐式 any，明确字段类型后通过。未关闭 seccomp、降低时间/资源阈值或跳过失败用例。

C1 完成判据为已批准专用节点、真实受认证控制/取消/对账、全部 NFR-03 限额、可信 Core/Report/产物及真实 ready 的节点验收。C2 业务工作区/公共作业/限定帮助事务、A1/A2 真实账号与开放检查、完整旧业务备份恢复、浏览器/真人/教学效果仍由对应任务验收。产品/规划/参考/AGENTS 保持只读，进度与技术结果**待授权维护者汇总**；本任务没有提交/推送/远端 Issue 关闭、部署或向其他任务发送消息。

最终本任务 VM 保持运行供后续 C2 本机接入，当前运行容器数为 0，资源约 4 GiB/最多 2 vCPU。测试目录、停止容器和下载缓存保留；128 MiB 临时挂载内容随正常整机重启释放，持久验收结果保留。其他工作项 G1 文档改动原样保留。本任务不自动清理数据、不部署公网；C2 前重读实际 ready/当前测试代际，不沿用聊天中的旧代际字符串。

交付前最终核对：24 份文档、231 处仓库引用、27 条正式变更接口的只读检查通过；检查器回归 16/16，本人文件无尾空白/冲突标记，仓库原始 guest/SSH 证据摘要与验收信封一致。受保护的 product/planning/reference/AGENTS 无 Git 差异；G1 总协调文档为其他工作项已有改动，未覆盖、暂存或提交。整机重启后专属 Engine/socket/controller 均 active、运行容器 0、实际 ready=true；VM 留运行用于后续本机 C2。

## 15. 2026-10-10 PR 交付授权与准备

项目负责人明确要求推送 C1、C2 的 PR，授权提交/非强制推送这两个任务已交付的代码、测试、证据、任务文档和 README，以及创建两项 PR；不包含合并、其他成员改动、受保护基线、数据库/凭据/CI 或生产部署。C1 目标 main，C2 依赖 C1 分支以保持独立审查范围；两项只关联 Issue，实际关闭仍按各自条件。

推送使用独立工作树，基于已回读远端 main `54ca54c6f2d01d2875b80404a525ec5505da2eb1`，保留已合入 B1 的文件/入口；主工作副本 HEAD/README/G1/未跟踪代码均保留。只复制本人 C1 白名单，不暂存 G1 或 C2 实现。Windows core.autocrlf=true，会让 Linux shell 与源码指纹在检出时变化；仅在 C 所有的 runner/contracts/runner 目录增加 LF 属性，原已验证源码和证据字节不变，不改根共享配置。

PR 以当前范围/原始证据及实际限制描述，不自动安装节点、发账号或开放真人执行。提交/远端分支/PR 正文和文件范围回读结果在交付后追加。

PR 提交前在独立工作树复验：C1 核心 31 通过/0 失败/2 专用环境入口明确跳过，strict TypeScript 7.0.2 noEmit 通过；专用 guest 45/SSH 8/VM 重启使用前述原始实际证据，不把此次跳过计通过。文档检查 25 份/241 引用/27 正式接口及回归 16/16、暂存空白/白名单通过；Git index 中源码/证据字节与原验收完全一致，sourceHash 和两组原始输出摘要核对通过；只增加 LF 属性、文档及 README 交付说明，执行逻辑未变。

实际交付：正文提交 `83f6086d6706f38bc1008af54a78b903c999c3d0` 已普通推送 `codex/c1-isolated-runner`；[C1 PR #16](https://github.com/paher-din/XunJie/pull/16) 已创建并附到本任务，base=main、Open/非 Draft。远端 head 与本地、标题/完整正文/39 文件白名单逐项回读一致；无受保护基线/A/B/G1/C2 实现差异。未合并或关闭 #12。最初 fetch 因 TLS 连接 reset 失败，但 GitHub API 回读 main 与已存在本地 origin/main 同为上述基点；没有把失败称成功，未改全局 Git/网络设置。

## 16. 2026-10-10 PR #16 审查修复与 N 范围补充

负责人要求按 PR #16/#17 审查修复，沿用两个 PR 的推送范围。C1 审查固定 HEAD 7e4ef73，有两项可信比较错误；已重读 MVP §1.3、TECH §4.1/8.1/8.3、批准 §13/14、源码及全部调用方。本次修改限 C-owned runner/tests/本文及真实新指纹验收，不改受保护基线、节点凭据、SQL 或其他成员记录。

- [溢出 N 误判](https://github.com/paher-din/XunJie/pull/16#discussion_r4236385877)：当前无界正数字符串原样作为正常 top 参数，正常规则期待退出 0，符合课程溢出退出 2 的实现会被误判。原契约尚未明确 N 的 C 类型；推荐确认 C int 的 1～2,147,483,647，另一选择为 64 位 size_t。正常参数以精确整数比较拒绝超过已确认上限，受信溢出错误样例预期退出 2；待负责人确认范围后实施，不从平台宏自动推定批准。
- [缺失文件错例碰撞](https://github.com/paher-din/XunJie/pull/16#discussion_r4236385879)：从完整快照所有路径及其目录前缀选择保证不存在的候选；不新增学生保留名称、不仅检查选中输入。补完整快照同名文件/目录碰撞反例，并通过可信比较/实际容器核对错误退出 1。

原验收源码指纹和证据保持其历史事实；源码改变后旧 passed 不适用于新版本。新 guest/SSH/typecheck/ready 证据另存新文件，并 append 节点验收登记；不将旧日志改贴新指纹。原 AC/NFR、C17 镜像、两槽、整单元取消与后置 A1/A2/SQL/浏览器边界不降低。

缺失输入反例已实际复现：旧源码 course 测试 2 通过/1 失败；保证不存在的完整路径选择修复后 3/3。当前 C1 离线 32 通过/0 失败/2 专用入口跳过，strict noEmit 通过；新增实际 SSH 同名文件/目录碰撞用例。N 类型确认仍待负责人回复；当前未实施任意范围，不写新整体 passed 或声称两项审查都已完成。

项目负责人已明确选择“采用 C int 范围（推荐）”，确认本 profile 正常 top N 为 1～2,147,483,647。批准针对本项类型补充/正常输入边界/溢出退出 2 的修复，不授予产品基线写入权限；请求授权维护者后续汇总到 MVP §1.3/TECH §8 及对应验收。实现采用精确整数界限，argv 保留原十进制文本；更新 validatorVersion 为 textscope-validator-v2 区分本次实现/新增溢出覆盖，既有 course rule v1 的业务含义和旧结果不改写。原错误样例加一项上限+1，共六项，退出序列 0/2/2/2/2/1。

四项独立修复阶段已有真实验证：同名文件/目录碰撞的实际 C1 SSH 检查通过，当前 RPC 全套 9/9；C2 在原父节点指纹上 18/18（含真实节点）通过。当前部署 collision 修复后旧 passed 与新源码不匹配，ready 应为 false；N 修复后再运行完整 guest/SSH/types 验收登记新指纹并复验 C2，不给原证据改贴版本。

修复后完整新验收：专用 guest 48 通过/0 失败/1 guest 内 SSH 入口跳过；宿主真实 SSH 10/10（包括合法同名文件/目录碰撞、C int 最大值/溢出、原有 SIGKILL/恢复/限额）通过；strict noEmit 通过。GCC 固定镜像实际编译通过 `_Static_assert(INT_MAX==2147483647)`，未将平台宏当授权。新原始 [guest](../../apps/teaching/runner/acceptance.review1.guest.txt)、[SSH](../../apps/teaching/runner/acceptance.review1.ssh.txt)、[验收信封](../../apps/teaching/runner/acceptance.review1.evidence.json) 单独保存；原 acceptance.* 的历史证据字节保持。

新登记时间 2026-10-10T06:58:22.323Z（Asia/Shanghai 2026-10-10 14:58），sourceHash=`0869fdbeb71287d22cfecaf6424abf4ed79db9a98ef687de91f7ff6ad2520e36`，fingerprintHash=`842fcd209bbb68503b7ff836be9e39a1df1269e97d002f336e31f7161a2acec9`。guest/SSH 输出 SHA-256 为 `783e279b23062168d856822b39831202579ae547cc7c32a8a2a7eb37c439eb3f` / `33b8eee93e934474ee338ddcb24c16517f7cc7c5b5e6c6c5e27a5872f7d7c812`。正常上限/明显溢出反例旧源码 5 通过/2 失败，修复后相同 7 项全部通过；缺失路径反例旧失败/新通过。两项审查根因均修正，不按 Number 的舍入或新增保留名称规避。

审查修复实际发布：C1 碰撞修复 e49a79e 与 N/新指纹修复 `1c3f73cb0172ad445189908e28157e3ff3c9434d` 已非强制推送 PR #16；PR 正文按最终修复/48 guest/10 SSH/原始证据与后置范围重写，并与本地正文逐字回读一致。C2 已普通 merge 该父分支并在新指纹下 18/18 通过。两个 PR 均 Open，未合并/关闭 Issue/自签审查批准或替原审查者解决线程；五项作者修复完成，待原审查者复验。保护范围与新证据摘要检查通过，代码/截图/旧验收事实不覆盖。
