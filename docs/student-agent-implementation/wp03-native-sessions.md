# #173 本机有状态实验会话

日期：2026-11-03。本文记录本机原生有状态会话的实现、原验收与已知限制。设计与边界见 [specs/wp03-native-sessions.md](specs/wp03-native-sessions.md)，范围以 [#173](https://github.com/paher-din/XunJie/issues/173) 为准。

## 依据与授权

- [实施票 #173](https://github.com/paher-din/XunJie/issues/173)、[WP03 公开执行规范](specs/wp03-course-components-and-execution.md) §10 与 Testing Decisions、[#170 交付记录](wp03-execution.md)、[#171 组件准备](specs/wp03-component-preparation.md)。
- 实施基线：`wp03` 的 `6e7d13e`（远端同步后）。写集：contracts 的执行与组件声明、learning-space 的 native session owner 与 HTTP 入口、product-runtime 的启动/维护接线、Web 会话面板与样例组件、工程测试、证据与本文。
- 本票只交付建立、连续输入、查询、停止和普通重启后的恢复边界。暂停/单步/复位/检查点与跨所有者接管（#174）、远端节点（#175）不在本票。

## 平台选型与隔离

首条路径选在 **Windows 11 x64 的产品本机进程**：

- 执行器是产品自带 Node 24.21.0 启动的真实子进程；适配器源码固定在产品源码中，组件只能按标识和版本选择，不能提供命令、路径或环境。
- 每次会话使用独立临时目录、最小环境（不继承数据库口令、开发加载器或无关凭据），stdout/stderr 有字节上限，单次输入、空闲、最长持续、内存（V8 堆上限）、并发会话分别受限。
- 停止先发协议停止；未退出时用 Windows `taskkill /T /F` 结束受管子进程树。POSIX 路径使用独立进程组和组信号，但本机未实测。
- 普通产品重启后旧 `supervisorEpoch` 的未终态会话标为 `unknown`，不新建进程重放；维护停机时先停止并回收会话，已确认观察保留。

**未满足的隔离门槛**：当前没有独立受限执行身份、Job Object 或 OS 级文件/网络沙箱。适配器是产品固定代码，未授予任意程序或网络能力，但这不是设计文档要求的强制隔离证据。macOS 与 OS 级隔离实测仍待完成，本记录不宣称双平台隔离已验收。

## 实现与接口

- `@xunjie/contracts/execution`：`executionPlan` 增加 `location:'native'` + `kind:'session'`，只允许与 `effect:'input'` 组合；新增 `nativeSessionLimits`、`executionControl`（稳定 `controlId`、`expectedSeq`）和查询中的 `session` 视图（适配器、节点、安装代际、监督器代际、执行器实例、已确认序号、观察历史）。浏览器 job 的 wire、计划摘要和状态推进保持不变。
- `@xunjie/contracts/components`：格式 1 清单可声明 `session`（适配器标识/版本、创建参数、输入/观察结构和预算）；会话组件不得同时声明浏览器算法，必须声明 `execution.submit`。
- learning-data owner 迁移 7 `native-stateful-sessions`：`native_sessions`（命令、原始依据、适配器、节点/安装/监督器/启动实例、状态、确认序号、已应用序号、观察历史）、`native_session_operations`（稳定 `control_id`、序号、输入摘要、派发中/已应用/未知/拒绝）、`native_session_stops`。命令与派发标记先于写入子进程；已确认终态不接受旧实例推进。
- HTTP 复用既有公开执行语义：`POST executions/<activityId>` 接受会话（服务端生成回执与 `executionRef`）、`GET executions/<activityId>/sessions` 按原引用重开、`POST executions/<activityId>/<requestId>/control` 连续输入、`GET .../<requestId>` 查询、`POST .../<requestId>/stop` 停止。浏览器 job 的 accept/report/result 路径不变。
- 原生适配器 `four-state-accumulator@1`：`state ← (state + input) mod 4`，内部保存 `value`、`total`、`applied` 和最近 64 条操作身份；同一 `controlId` 重放返回原观察，错序拒绝，不把界面变量当会话状态。
- 产品接线：中心工具区在组件视图下方新增「本机会话」面板，提供启动、连续输入、已确认观察、核对和停止；切换工具或整页刷新只重读原执行引用。停止受理与实际退出分开显示，未知状态明确标为待核实。输入待确认时锁定再次输入。
- 维护：恢复在所属存储写入门打开后执行并允许失败重试；`drain` 在存储关闭前停止并回收会话；结果事实只有在真实进程退出后才写为终态。

## 样例与可重复入口

[`components/state-accumulator`](../../components/state-accumulator/README.md)：从 0 开始依次输入 1、2、2，确认观察 1、3、1；另开会话从 0 独立开始。

```sh
node components/state-accumulator/package.mjs
XUNJIE_PRODUCT_POSTGRES_BIN=<产品自带 PostgreSQL bin> node --test apps/server/tests/native-session.runtime.test.mjs
XUNJIE_PRODUCT_POSTGRES_BIN=<产品自带 PostgreSQL bin> XUNJIE_E2E_BROWSER_CHANNEL=chrome \
  node node_modules/@playwright/test/cli.js test apps/web/e2e/nativeSession.spec.ts
```

## 验收记录

### 工程

- `node --test apps/server/tests/native-session.test.mjs`：2/2。真实子进程跨输入保持状态；同一 `controlId` 重放不重复推进；错序被拒绝；空闲时限由真实进程退出生效。
- `apps/web/src/tool-execution/session.test.ts`：4/4。原生计划、预算、适配器和 `expectedSeq` 由宿主装配；停止/未知状态不再接受输入。
- `apps/server/tests/native-session.runtime.test.mjs`：1/1。真实产品运行时、原生 PostgreSQL 18.6.1、真实子进程：建立 → 输入 1、2、2 → 观察 1、3、1 → 重放同一控制 → 错序 409 → 停止确认 → 停止后输入拒绝 → 第二个会话独立从 0 开始 → 普通重启后旧实例不可推进。
- 回归：`apps/server/tests/execution.runtime.test.mjs` 1/1、`component-host.runtime.test.mjs` 2/2，覆盖浏览器 job 与组件宿主原有链路。
- `node scripts/build.mjs typecheck`：通过（contracts、storage、learning-space、server、product-runtime、local-runtime、web:src、web:node）。
- `node scripts/check-doc-links.mjs`：通过。

### 真实原生运行

环境：Windows 11 家庭中文版 `10.0.26200` x64、Node 24.21.0、产品自带 PostgreSQL 18.6.1、桌面 Google Chrome 156.0.8078.76（headed，非 headless）。会话由产品本机进程启动，观察来自子进程写回，不是页面变量或预制输出。一次实测：输入 1 → 状态 1；输入 2 → 状态 3；输入 2 → 状态 1；累计 5、已确认 3 次。第二个会话从 0 开始。

### 浏览器

`apps/web/e2e/nativeSession.spec.ts`：1/1（headed Chrome，非 headless）。覆盖选择课程组件、启动会话、连续输入 1/2/2、观察 1/3/1、切换「作品」再返回仍看到原引用、整页刷新后从原会话恢复、深色与 900×900 窄桌面截图、停止后输入禁用、开始新会话从 0 开始。

截图：`evidence/wp03-173-native-session-light.png`、`-dark.png`、`-narrow.png`。原始报告与同批截图在 `.verification/wp03-173/`。

## 未执行与已知限制

- **Apple Silicon macOS**：POSIX 组停止路径已实现但未在 Mac 上运行，双平台验收未完成。
- **OS 级隔离**：没有受限执行身份、Job Object、文件/网络强制隔离的实测证据；当前只执行产品固定适配器。设计文档的隔离门槛尚未全部满足。
- **排队**：适配器声明 `queuedSessions: 0`；达到并发上限直接拒绝，没有实现排队。
- **保留与容量**：会话/操作行当前没有按时间或容量的清理策略；只登记了 schema、维护排空与恢复校验，长期容量与保留策略留给维护票。
- **检查点与恢复**：没有进程内检查点；重启后旧会话只保留已确认观察并标为待核实/终态，不恢复内部状态（#174）。
- **远端与跨所有者**：未执行（#175）；学校/远程 profile 不启用本机会话能力。
- **教学效果**：未评估，不产生结论。
- **界面前后对照**：本次为在既有中心工具区下方增加面板。交付附实际运行后的浅色/深色/窄桌面截图；修改前采用既有中心工具区的 #170 证据，没有重新构建修改前基线。
- 自动浏览器测试使用 Playwright 驱动的独立 Chrome 窗口，不是人手操作；进程、PostgreSQL、组件资源与页面流量均为真实。

## #173 收口方案（待确认）

按隔离探针、正式接入、双平台验收三个阶段推进。平台候选通过前，现有会话仅作为功能基线，验收记录维持部分通过。

1. 先做独立探针。Windows 候选验证受限身份与 Job Object，子进程在执行入口前完成归组，监督器退出时终止整组。Apple Silicon 候选验证可签名分发的沙盒 helper 与进程监督。两边用真实越界读写、出站连接、父进程先退出、监督器崩溃、内存/输出超限等探针，记录权限、版本、退出和资源证据。文件和网络限制须由平台强制。现有停止路径以直接子进程退出作为确认，正式接入应改为由监督器确认受管执行单元已退出。
2. 探针通过后，接入产品打包和共同准备机制。锁定每个平台的 helper、模拟器、摘要、权限要求与独立自检；准备失败按权限待确认、可重试故障或能力不可用投影。复核安装/恢复代际、启动实例、心跳和撤权，并用真实数据库验证接受回包丢失、进程消费后丢确认、停止竞争、排空超时与重启查询。未确认的操作保留原身份与待核实状态。
3. 在执行所有者登记保留规则。优先验证能否用现有表、资源引用及维护入口实现容量和时间上限。仅处理超期且已确认终态、没有未处理命令或有效引用的记录；活动中和待核实的记录继续保留。实施前单列保留期限、引用影响和清理方案供负责人确认，任何 schema 变更或数据迁移单独确认。
4. 固定同一候选提交，在两台干净目标设备用产品包、真实 PostgreSQL 与 headed Chrome 验收。分别记录准备、状态序列、跨会话隔离、异常回收、重开核对与相关回归；采用同一布局和活动取得实际前后界面证据。Apple Silicon 需要可执行验收的设备或交接窗口。

### Windows Job Object 探针

在 Windows 11 10.0.26200 x64、Python 3.14.4 运行 `python scripts/probe-native-windows-job.py`，退出码 0。128 MiB Job 提交内存上限拒绝了 256 MiB 的 VirtualAlloc 请求（1455）。直接子进程退出后，持有真实进程句柄确认其后代仍在运行；关闭最后一个 Job 句柄后，5 秒内观察到该后代退出。

探针用受信子进程等待准入信号来建立测试顺序。正式 helper 必须在运行第一条子进程指令前完成归组，并验证监督器异常退出、受管单元终止确认、受限身份、文件和网络访问。该次探针只覆盖 Job 内存与后代回收，尚不能通过平台选型门槛。Windows 文件和网络候选使用零网络能力 AppContainer 配合明确目录授权，仍需验证实际产品二进制可加载、可通信并可清理。

第二轮用 C helper 直接调用 CreateProcessW（CREATE_SUSPENDED），归组后才 ResumeThread。驱动保留监督器、直接子进程和后代的真实进程句柄，先确认直接子进程已退出且后代仍活着，再强制终止监督器。Windows 11 10.0.26200 x64 实测通过，监督器和后代均在检查时限内退出。复跑命令如下，在既有 `.tmp` 目录生成开发探针二进制。

```powershell
gcc -municode -Wall -Wextra -Werror scripts/probe-native-windows-crash.c -o .tmp/probe-native-windows-crash.exe
python scripts/probe-native-windows-job.py --crash-probe .tmp/probe-native-windows-crash.exe
```

该证据覆盖挂起归组和监督器崩溃回收。候选产品 helper 的 AppContainer 文件与网络隔离、运行时终止确认、打包与共同准备仍待实测，Apple Silicon 尚未验收。

### Windows AppContainer 与 Job Object 组合探针

Windows 11 10.0.26200 x64 上，使用零网络能力 AppContainer 创建挂起进程，加入带内存上限和关闭回收的 Job 后才恢复执行。普通身份和受限身份使用相同测试可执行文件。普通身份可打开两个文件并连接监听器；受限身份的 token 确认为 AppContainer，可以读写授权文件，对未授权文件的读和写均被系统拒绝。loopback 和本机非 loopback IPv4 的 TCP 连接在 1 秒内未建立，两个监听器均无受限进程连接。结果只覆盖本次 TCP 对照及测试资源，正式 Node/IPC 与产品包仍需单独验收。

```powershell
gcc -municode -Wall -Wextra -Werror scripts/probe-native-windows-appcontainer.c -o .tmp/probe-native-windows-appcontainer.exe -luserenv -ladvapi32 -lws2_32
python scripts/probe-native-windows-appcontainer.py .tmp/probe-native-windows-appcontainer.exe <本机非-loopback-IPv4>
```

探针会登记可重复使用的本机测试 AppContainer profile，并在 .tmp 下留下隔离的测试 fixture。Apple Silicon 真机工作由 [Apple Silicon 原生会话隔离与产品包验收](https://github.com/paher-din/XunJie/issues/184) 承接。

固定 Node 24.21.0 复验通过。第二个测试 profile 独占授权另一会话目录，首个 profile 对其文件的读写仍被拒绝。用受控的 stdin/stdout/stderr 句柄白名单启动现有四态适配器，真实回包依次为 ready、1、3、1、stopped。Windows 上直接用脚本文件作为 Node 入口遇到盘根 lstat EPERM；现有产品使用的 module eval 入口通过。创建 AppContainer 时启动器需要系统用户目录信息，实验只传入探针所需环境，未继承服务凭据。

```powershell
python scripts/probe-native-windows-appcontainer.py .tmp/probe-native-windows-appcontainer.exe <本机非-loopback-IPv4> --node <产品固定的node.exe>
```

正式 helper 可用受控身份槽位实现会话目录隔离。每个活跃槽位有独立身份，目录 ACL 只授予对应槽位，身份仅在进程树已确认退出且上一份资源已隔离后才可复用。会话观察仍由持久执行所有者保存。helper 接口应固定可执行文件、参数、资源摘要和标准流句柄，安装和启动自检失败时拒绝启用；停止确认以受管 Job 内活动进程数为零为条件。当前探针包含开发用命令行入口，正式安装包需使用收窄后的入口。

保留策略待决项集中在可查询窗口与稳定请求身份。建议以 30 天作为可确认终态观察与结果的初始窗口，未确认执行、仍有引用或未投递的操作不进入清理。窗口到期后仍需保留足够的原身份与摘要事实，旧请求不得因结果已过期而被重新接受。实际容量阈值、引用清单及清理方式须先通过维护和恢复演练，再单独确认。
