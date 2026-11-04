# #175：课程运行方案、执行位置与真实原生执行

日期：2026-11-04（Asia/Shanghai）。分支 `wp03`，审查基点 `e5b3743`。
依据：[实施票 #175](https://github.com/paher-din/XunJie/issues/175)、[WP03 规范](specs/wp03-course-components-and-execution.md)、[课程执行方案 ADR](adr/0001-teacher-owned-course-execution-plan.md)。

## 产品行为

教师发布的 `CourseExecutionPlan` 固定方案版本与摘要、组件定义与配置摘要、操作、能力、预算、执行位置和远端条件。活动保留打开时的快照，后续发布不改写旧活动。旧发布继续原有浏览器或本机路径，不自动取得远端资格。

按操作判定浏览器满足、原生必需、缺安装、待授权、准备失败和设备不满足。只有确实不支持、匹配课程远端声明并且学校能力实际可用时，才允许学校执行。缺安装、权限、下载失败和失联不能触发换位置重跑。接受时由执行所有者重新计算，并核对实际节点角色、HTTPS、产品适配器平台兼容性及当前课程资格。

`execution.device` 是已认证请求携带的调度观测，不是新授权或硬件证明。浏览器用 Chrome UAData 高熵接口读取架构与位宽，取不到保持未知；学校的产品适配器登记用于核对平台限制。本机可用性来自实际受限启动和退出自检，不能仅凭操作系统名称宣称就绪。

`four-state-accumulator` 同时支持三种产品平台，Mac/Windows 缺安装不能借它声称设备不支持。另一个固定产品适配器 `linux-proc-accumulator@1` 每次从 Linux `/proc/self/status` 读取真实 PID 与线程数，其平台集合只有 `linux-x64`；两端远端验收采用此真实平台限制。

## 两条原生链路

1. **本机入口或学校网页使用学校 Linux 能力**：沿原认证 HTTPS 请求访问学校执行所有者；固定学校节点、安装代际、监督周期、执行器实例和请求身份。
2. **学校网页调用获准本机能力**：本机产品主动连接学校。现有成员批准连接后，本机经该连接登记实测平台和适配器，持续领取命令；学校无需访问学生私网端口。学校账本是唯一执行权威，本机只有固定快照、执行进程和领取日志，不需要活动数据库。

学校网页的浏览器作业不要求本机产品或数据库。`remote` 客户端组合不创建 PostgreSQL；它既可访问学校，也可在现有批准连接上提供本机原生能力。

### 认证领取与恢复

`native-channel.ts` 保留节点、命令、领取、报告、租约和固定目标。`channel-executions.ts` 将公共 submit/query/control/stop 接入该账本；本机执行器使用同一 `SupervisedSession` 与固定产品适配器。

命令和待派发事实先持久化再返回接受。已经领取的命令不重新派给新实例；原目标节点、监督周期和代际随原请求保留。设备重启可沿原批准连接登记新监督周期，供新会话使用，旧动作仍不迁移。旧安装或失权连接不能领取、报告或推进；迟到报告仅归档，不复活旧运行。

节点可用性受真实心跳和声明租约约束。资格撤销立即拒绝新动作；本机失联到期清理进程，学校不能确认退出时保留未知。结果读取继续检查当前成员和课程资格。执行所有者的维护回收不依赖学生仍有资格。

### 浏览器可靠意图

`session-controller.ts` 在发送前将启动、输入和停止的稳定身份及固定输入写入工作区存储。重载后核对原请求；待确认输入不能被新输入越过。查询按确认序号合并，终态不倒退；同序号迟到响应不能覆盖较新的执行知识，也不能改变当前选择。面板提供沿原身份核对与重试，未知能力明确禁用启动。

## Linux 强制隔离

入口：`scripts/linux/native-session-entry`；安装：`scripts/install-linux-native-entry.sh`。
安装后以产品运行身份通过同一 sudoers 入口自检。配置从 root 拥有、不可由其他用户写入的 `/etc/xunjie/native-session.conf` 读取，不执行配置中的任意脚本。

系统级 systemd 单元固定使用动态非特权用户、`ProtectProc=invisible`、`ProcSubset=pid`、私有网络、仅 AF_UNIX、严格只读系统、隐藏学校状态根和 home、私有工作根并只绑定本会话目录、只读 `/tmp`、`/var/tmp`、`/dev/shm`、cgroup 内存与任务数上限、运行时间上限和整个控制组回收。停止与状态核验还校验执行器实例。自检未通过就拒绝原生执行，浏览器工作仍可用。

实测自检包含：宿主先证明 loopback 监听可达，单元内连接得到 `EAFNOSUPPORT`；root 创建的 0666 哨兵在单元内写入得到 `EROFS`；本会话可写、兄弟会话和学校状态不可读；宿主进程环境不可读；三个临时目录只读；`memory.max=268435456`、`pids.max=64`。移除关键隔离属性的负对照会真实失败，不把超时或缺失夹具算作禁网证据。

最终入口的系统日志进一步证实：64 MiB 下触碰超额分配触发 `oom-kill`；1000 ms 的运行预算触发 `timeout`。单元已被 collect 后 `systemctl show` 的默认 `Result=success` 不能证明退出原因，证据以对应单元系统日志为准。入口预算统一使用毫秒，最大会话预算额外留 5 秒收尾。

当前事实不宣称 Linux 具备仅单一可执行文件白名单；实际隔离字段对未实施的 exec/signal 限制保持保守。

## 迁移与维护

| 版本 | 内容 |
| --- | --- |
| 8 | 认证原生领取通道、固定节点与租约 |
| 9 | 浏览器和原生执行的命令原文列 |
| 10 | 学校侧本机执行投影、固定原文和待派发意图 |
| 11 | 固定领取目标代际、监督周期与迟到报告归档 |
| 12 | 原会话心跳观测与无输入退出传播，保留接受原文和终态 |
| 13 | 未领取启动的持久取消；停止先于领取时不会启动原进程 |
| 14 | 原实例退出确认的独立审计表；撤权、断网重连和恢复后的清理证明 |

JSONB 会重排对象键，不能代替原始命令字节。新命令额外保存原文，校验原文字节摘要及其与结构化投影的内容一致性；不改写既有命令摘要。旧记录没有原文时只沿旧规则校验，无法证明的记录不能被无条件放行。

普通重开使用原受限存储凭据；仅确认缺少迁移后缀时调用既有受维护闸保护的升级入口，逐条核对已记录的迁移校验和并失效旧句柄。领取工作进程接入宿主维护暂停、恢复和关闭；清理未确认不能进入安全停止状态。

清理证明先写入原启动 journal 的 `pendingCleanup`，断网、重启或原连接文件删除后仍向原学校补报。`native-channel/cleanup` 只接受原随机 claim capability 和完整所有者、节点、代际、实例身份；成员、课程或连接撤权后仍可确认原进程退出，但不能借此读取结果、领取命令或推进观察。已确认的同一证明在关闭写入后仍可只读幂等确认。维护先关闭派发，等待学校侧与本机通道的真实退出确认，再关闭存储写入；失联、停止返回 false 或缺少确认均保留未知并阻止安全停止。

回归发现并修正两处恢复问题：完成后的停止审计不应把保持 `succeeded` 的合法记录判坏；自有 PostgreSQL 崩溃后需先关闭公开派发入口并恢复原数据库，再持久化所有者停止闸和排空。外部数据库不由产品启动或替换。

## 实测与证据

证据保存在忽略目录 `.verification/wp03-175/`；账号、口令和本机批准凭据不进入提交，下面列出的报告与截图需与工程测试分别解读。

| 证据 | 已核实内容 |
| --- | --- |
| `mac-arm64/remote-school.json`、`win32-x64/remote-school.json` | 两端 Chrome 学校网页浏览器作业、严格 HTTPS、真实 TCP 断链、原节点查询/停止、撤权拒读与恢复后原引用 |
| `native-macos-arm64/remote-native.json`、`handoff-native-macos-arm64/remote-native.json` | Mac 真实平台观测、Linux 专属适配器、输入 1/2/2 得到 1/3/1、固定 PID/节点/代际/实例、真实断链重连和确认停止；接手续跑通过 |
| `native-windows-x64/remote-native.json`、`handoff-native-windows-x64/remote-native.json` | 前者保留旧失败（控制返回 403）；后者接手续跑通过，覆盖 Windows 真实平台观测、Linux 专属适配器、1/3/1 观察、固定身份、真实断链重连和确认停止 |
| `channel-macos-arm64/channel-report.json`、`channel-windows-x64/channel-report.json` | 学校网页沿批准连接调用两端本机、无本机数据库、真实进程推进、刷新后原身份恢复、停止确认及连接撤销后回收；两端通过 |
| `handoff-school-macos-arm64/remote-school.json`、`handoff-school-windows-x64/remote-school.json` | 接手续跑两端学校网页浏览器作业、真实 TCP 断链、原节点查询/停止和课程撤权；通过 |
| `handoff-execution-regression/browser-report.json`、`handoff-execution-sync/execution-sync-report.json` | 正式 Chrome 计算、下载、编辑、页面重载、切换工具、跨页停止、预算终止及离线恰好一次续传；14＋6 项通过 |
| `handoff-local-entry-macos-arm64/mixed-fallback.json` | 无数据库本机产品页面经真实 `school-client`、认证 HTTPS 调用学校 Linux；启动、输入、停止在所有者实际生效后丢回包，重载和核对仍保留原引用、PID、代际及 1/3/1 观察 |
| `final-local-entry-macos-arm64/channel-report.json`、`mixed-fallback.json` | 最终客户端和最终 Linux 包重新验收，8 项通过；包含学校网页调用本机、本机入口调用学校、三类实际生效后的回包丢失、刷新恢复、撤销回收及无本机数据库 |
| `final-local-entry-windows-x64/channel-report.json`、`mixed-fallback.json` | 同一最终应用在 Windows 非提升交互桌面复验，7 项通过（复用已导入课程）；覆盖同样双向原生链路、submit/control/stop 生效后丢回包、原身份与 PID、1/3/1、撤销回收及无本机数据库 |
| `remote-withdrawal-state.json` | 成员与课程两轴撤权、恢复资格、执行所有者回收为 `cancelled/confirmed` |
| `linux-isolation-positive.json`、`linux-isolation-negative.json`、`linux-limits.json` | 正/负对照、隔离边界、OOM 和运行时超限系统日志 |
| `linux-strengthening-final.json` | 64 KiB 输出超过 2 KiB 预算后确认整个单元退出；强杀监督器后原进程及脱离进程组的子、孙进程全部退出；并发上限 2 时拒绝第 3 次启动，原两会话保持运行，最后确认停止 |
| `final-engineering-*` | 接手前编译、测试日志、失败与定向复测；不是最终全量门禁通过证明 |

学校节点：Ubuntu 24.04.5 x64、kernel 6.8.0-139、systemd 255.4、2 vCPU、1740 MiB；产品 Node 24.21.0、PostgreSQL 18.6。Mac 为 macOS 27.2（26B123）arm64；Windows 为 Windows 11 x64 10.0.26200；两端 Chrome 均为 156.0.8078.80。实际路径为客户端桌面 Chrome → HTTPS 学校入口；获准本机路径另由本机产品主动发起出站 HTTPS。证书验证仅对指定 SPKI 例外，未关闭全局证书校验。

Windows 本机领取验收使用已登录用户的非提升桌面进程。相同产品包在 OpenSSH 非交互宿主内的 AppContainer 自检失败（子进程退出 `0xc0000142`），因此不登记适配器；桌面运行未修改隔离规则，完整通过。对照与临时计划任务清理记录见 `channel-windows-x64/noninteractive-diagnostic.json`。接手时 Windows `192.168.3.8` 曾不可达；负责人恢复网络后，17:44 的学校原生链路及 17:49 的学校浏览器作业均补验通过。两项接续验收均通过临时计划任务在已登录桌面运行，完成后已删除对应计划任务。

最终 `rtk bypass npm run verify` 于 2026-11-04 18:32（Asia/Shanghai）通过，包含类型检查、普通与产品构建、浏览器契约检查、文档链接检查及 153 个测试任务；日志为 `.verification/2026-11-04T10-29-32-425Z-cGYJIV/`。另以真实 PostgreSQL 18.6 和原生进程执行课程方案、公共执行、领取取消与清理生命周期、维护及备份恢复的 31 项定向回归，全部通过、无跳过；日志为 `handoff-final-native-tests.log`。恢复检查核对原命令字节、固定执行目标及清理审计，不重放原动作。

最终 Linux 候选 `product-linux-x64-wp03-175-final3` 修复了打包临时目录默认 0700 导致 DynamicUser 无法遍历产品根和 Node 根的问题；生成包直接以 0755 发布这两个目录，无需部署后改权限。打包脚本单测通过，Ubuntu 按包原始权限安装后真实隔离自检全部通过，证据为 `final-linux-package-deploy.log`。部署重启时曾误用 root 导致 PostgreSQL 拒绝启动；随后恢复原运行用户，此失败不计为产品运行通过。

最终 Linux 包、Mac `product-darwin-arm64-wp03-175-remote-final` 及 Windows 本次 `handoff-final/app` 使用同一构建的应用与 Web；两端报告分别保存实际应用 SHA-256。`product-runtime.js` 为 `080988c4c870791e243ab214c0aab845c1530dad03e25ff3c9a8ee9567c8f2b4`，`daemon.js` 为 `f76836d79fe4fa8f9031bf119ed856483020ec9f673061da5f947483693d774e`。Windows 受限启动 helper 固定为 `7aa60b8a7931c498e9b2d055e20e87e3f91763d6e6991bafc6887a9435034d2f`。

最终本机入口分别为 Mac `http://127.0.0.1:51895` 与 Windows `http://127.0.0.1:61652`，原生动作只请求本机产品，再由真实 `school-client` 经认证 HTTPS 转发学校。Mac 本机入口验收 8 项、Windows 复用课程验收 7 项均通过；实际结果核对到 submit/control/stop 三种回包被丢弃、同一 PID 与 1/3/1 观察。Windows 首次复验夹具漏复制产品根 `package.json`，造成模块加载失败，补齐包元数据后重新完整通过；不以首次失败计为通过。

两端最终连接均已撤销、客户端正常关闭。最终隔离学校实例 `/var/lib/xunjie-175-final` 已正常停止，数据与最终候选保留；原 `/var/lib/xunjie-175` 数据保留，其他业务实例未改动。已恢复验收前的 Linux 入口配置，清除本轮临时上传包、旧候选及启动脚本；Windows 临时计划任务数为 0，Linux 无剩余运行中的 `xj-session-*` 单元。证据为 `final-linux-stop.log`、`final-linux-cleanup.log` 与 `final-windows-cleanup.log`。

学校浏览器断链脚本显式关闭 Chrome 代理和 QUIC，确保请求经过受控 TCP 中继。接续验收确实切断 6 条连接，离线请求失败，恢复后仍读取原执行引用；代理绕过中继的早期失败保留为失败，不充作断网证据。

原有正式活动工作区、组件视图和样式继续使用；新增的是执行位置解释、未知/待确认操作门禁和真实进程观察。截图保留现有布局、输入历史、运行/停止与撤销状态，不是设计稿。工程验收不等于教学效果评估；本轮未开展学生教学效果试验。

## 最终审查

### Standards

已关闭清理未确认仍返回成功、停止输入校验不一致两项发现。最终复核持久 journal、确认后提示清理及打包目录权限，未发现剩余交付阻塞；保留既有模块与产品工作区，不另建并行 UI。

### Spec

已关闭未领取启动仍执行、维护遗漏本机通道、断网终态丢失、撤权后无法确认退出及无执行组件被错误排除等发现。真实回包丢失、Linux 输出/并发/监督器后代回收及新增事实的备份恢复均已有独立证据。最终 scoped cleanup、migration 14 与持久补报复核未发现剩余代码阻塞；#174 组合验收仍按下一节条件开展。

## #174 汇合后的组合

原方案要求“和 #174 汇合后补测实际支持的控制与检查点组合”。当前公共协议支持固定 input 顺序、同 controlId 重放、错序拒绝、原节点查询与停止；这些已纳入真实链路和回归。检查点/恢复协议尚不在本分支，不伪造该能力或记作通过。

#174 汇合后应补：原会话推进到 seq=2 后保存真实检查点，以检查点引用创建不同的新执行实例，核对观察、环境与摘要，继续输入后得到正确后继状态；原会话与新实例仍可追溯，控制重放不重复推进。

## 复现入口

```sh
node scripts/prepare-remote-native.mjs --linux-proc
sh scripts/install-linux-native-entry.sh --help
node scripts/probe-execution-remote-school.mjs --state=STATE --endpoint=HTTPS --spki=HASH --label=LABEL --control=TOKEN_FILE
node scripts/probe-execution-remote-native.mjs --state=STATE --endpoint=HTTPS --spki=HASH --platform=macos-arm64
node scripts/probe-execution-native-channel.mjs --endpoint=HTTPS --spki=HASH --payload=PAYLOAD --control=TOKEN_FILE --app=APP_DIR --web=WEB_DIR --product=PRODUCT_DIR
```

节点侧主验收、撤权与代际脚本分别为 `scripts/probe-remote-native-node.mjs`、`scripts/probe-remote-withdrawal-node.mjs`、`scripts/probe-remote-stale-install-node.mjs`；参数校验会打印所需选项。部署和检查使用 SSH，执行、领取、控制和授权沿产品公共接口。

本机入口与真实原生回包丢失使用领取验收脚本的 `--remote-native-state=STATE --local-entry-native --lose-native-replies` 组合。脚本在学校已返回真实结果后丢弃 HTTP 回包，并核对原请求、确认次数和真实 PID；它不会用另一个实现模拟计算。Linux 补充预算和回收检查位于 `scripts/probe-linux-native-limits.mjs`，需先以 esbuild 的 `--bundle --platform=node --format=esm` 打成单文件再部署到学校节点，使用产品 Node 和已安装的受限入口执行。
