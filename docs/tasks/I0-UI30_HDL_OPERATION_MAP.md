# I0-UI30：现有 HDL 操作与真实契约对照

日期：2026-10-14（Asia/Shanghai）。执行角色：UI，接收方：C／B／A。

本次完成 [#30 指定评论第 3 项](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633)要求的操作对照与缺口交接。**已有 C 后端和目标节点证据；main 的数字逻辑中心仍是演示，真实 HDL UI 接线与浏览器验收未完成。** 本表不以服务端测试、HTTP 脚本、模拟板卡或模拟成功提示替代浏览器验收。

## 1. 范围、依据与固定来源

用户明确要求完成指定评论内分配给本人／UI 的工作。本记录负责操作表、已有交付的引用和缺项归属；只写本文件，不改变页面、布局、框架、共享契约、模型预算、运行环境或数据库。后续 UI 实现沿成员现有工程分批接入，具体写集和验收须由该执行任务记录，不从本表推导新接口或新增运行授权。

已读正文与适用判据：

| 材料 | 已读章节与应用 |
| --- | --- |
| [README](../../README.md)、[AGENTS](../../AGENTS.md) | 项目入口、任务导航、文档优先、权限边界、分层证据 |
| [PRD](../product/PRD.md) | §4.5、§5：真实 HDL 输入输出因果、PRD-03/04/05/09/10 |
| [MVP_SPEC](../product/MVP_SPEC.md) | §1.4、§2、M-03/04/05：DL-AC-01～09；确认作品、学生显式操作、帮助与实际回执 |
| [TECH_DESIGN](../product/TECH_DESIGN.md) | §8.5：Build／持续 Session／四态信号、模拟时间、限额与恢复；原 C 与完整验收保持 |
| [DL-0](DL-0_DIGITAL_LOGIC_ADDON.md) | §2.1～2.3、§3～4：PDF 定义 ALU、DDR Rev. C、极性、未定义域不判分、冻结与独立授权边界 |
| [I0_UI_SPEC](I0_UI_SPEC.md) | Problem／Solution、User Stories、Implementation／Testing Decisions、Out of Scope：真实与准备分开，原数字逻辑演示保留身份 |
| [客户端约束](I0_UI_CLIENT_CONTRACT.md) | §7～8：现有能力差异、按能力交接；本机草稿不是确认快照，准备通过不代表实际接线 |
| [IMPORT_SOURCE](../../apps/student/IMPORT_SOURCE.md) | §1、§4～5：固定 Design 导入与选择性同步；当前业务客户端由主仓库维护 |
| [TEAM](../planning/TEAM_WORK_PLAN.md)、[G3 当前转派](G3_OVERALL_COORDINATION.md#14-2026-10-14-a5-与-dl-a-剩余工作转派) | TEAM §2、G3 §14/14.1：C 接续 DL-A／共享宿主及 DL-E2E；B／UI 原域、A5 规则仍归各责任人 |

UI 取本工作树起点 `main@b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43`；后端读取 [PR #56 固定树 `7100ea6b6c9182f4c1b36fdc0ddccdca32b70754`](https://github.com/paher-din/XunJie/tree/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754)。该 PR 树的能力不写成 main 已交付或本轮已运行。

| 代号 | 可独立复核的代码／交付来源 |
| --- | --- |
| U1 | main 的 [CenterToolArea](../../apps/student/src/components/workspace/CenterToolArea.tsx)：`EditorPane` 静态正文，`WavePane` 固定 SVG，`BoardPane` 的本地 `count`／SW／`Seg7(SEGMAP)`；模拟构建与装载仍在此组件 |
| U2 | main 的 [TaskRoute](../../apps/student/src/pages/TaskRoute.tsx)、[实际工作区](../../apps/student/src/pages/PrepWorkspacePage.tsx)：非演示授权深链复用当前 C 工作区，尚无真实 HDL Build／Session／Trace 控制分支 |
| U3 | main 的 [冻结命令](../../apps/student/src/workspace/frozenCommand.ts)、[确认客户端](../../apps/student/src/workspace/confirmationWorkspace.ts)、[确认状态组件](../../apps/student/src/components/workspace/ConfirmationCluster.tsx)、[原文对象引用](../../apps/student/src/workspace/tutoringObject.ts) |
| U4 | main 的 [求助客户端](../../apps/student/src/workspace/tutoringWorkspace.ts)、[求助回执核验](../../apps/student/src/workspace/tutoringCommand.ts)、[教学类型](../../apps/student/src/workspace/tutoringContracts.ts)、[教学事件](../../apps/student/src/workspace/tutoringEvents.ts)：已有原消息／回执链；尚无 HDL selection、冻结 HDL basis 和对应当前性接线 |
| C1 | PR56 的 [数字逻辑 HTTP 路由与请求 schema](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/server/app/digital-logic.ts) |
| C2 | PR56 的 [Build／Session／Operation 存储与受约束读取](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/server/workspace/hdl.ts)、[返回数据 schema](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/server/workspace/hdl-inputs.ts) |
| C3 | PR56 的 [课程／板卡配置](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/contracts/design/hdl.ts)：`msb_first`、100 MHz、`low_phase`、段／位／DP 低有效及配置版本 |
| H4 | PR56 的 [真实 UI 接线包](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/docs/tasks/DLA_H4_UI_HANDOFF_20261014.md)、[selection／basis schema](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/contracts/workspace/hdl-help.ts)、[同事务授权读取](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/server/workspace/hdl-help.ts)、[帮助接纳／模型前后复核](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/server/tutoring/application.ts) |
| E1 | PR56 的 [真实 HDL／一次真实模型工程记录](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/docs/tasks/evidence/dla-continuation-20261014/real-hdl-model.json)：原 HTTP／对象／四态帧／投递和 `received`，`browser=not executed`、`aluBehavior=unverified` |
| E2 | PR56 的 [最终冻结守卫真实补验](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/docs/tasks/evidence/dla-continuation-20261014/real-hdl-final-frozen.json)：带 `workspaceRevision` 的 H4 basis，新增独立合成 Attempt、Build／Session／两操作／停止；额外模型请求 0，浏览器未执行 |
| E3 | PR56 的 [C 续作／授权／验证记录](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/docs/tasks/DLA_CONTINUATION_20261014.md)：真实模型单轮授权、H3 源码批准与尚未执行的目标节点验收、3444 保留宿主与继承 UI 的边界 |

本表中的「已有」分为**main 现有共用 UI 客户端**和**PR56 后端／真实节点交付**；「模拟」专指 U1 的演示；「缺失」指仍未实现或未验收的具体消费方，不把 C 已交 API 重新列为未交。

## 2. 共用 wire 与对象规则

`A` 为当前获准 `attemptId`，`B` 为学生明确选择的 `buildId`，`S` 为原 `sessionId`，`N` 为已确认 Trace 游标。它们不是代码常量。沿同源 Session、当前 CSRF、`Idempotency-Key` 与受信 `recoveryGeneration`；写请求先冻结完整原文／参数／键，未知时不换键重做。保存／快照后重读 `GET /api/attempts/A` 的 `attemptRevision`，不把 `workspaceRevision` 或本地编辑器版本代入 `expectedAttemptRevision`。

HDL 写命令的原 HTTP 信封为 `{requestId,data}`，命令回执结果在 `data.result`；写入接受不表示执行已成功。`GET /api/hdl/builds/B` 的 `data={request,result,status,jobId}`，`result` 可为 `null`；Session GET 的 `data` 直接是 Session；Trace GET 的 `data={operation,nextSequence}`，结果在 `data.operation.result`。教学 receipt 响应的回执直接在 `data`，没有嵌套 `result`。客户端须逐层按实际契约核验。

Build／Session／Operation 共同绑定快照 ID/hash、板型／映射／引擎／运行配置版本及 scope／代际。Session 的字段是 **`sessionRevision`、`confirmedSequence`、`simTimePs`**，不是 UI 自增的 `revision/time`。请求的 `expectedSequence=confirmedSequence+1`，首次装载结果 sequence 为 0；pending 不允许发下一条交互。PR56 的 `readHdlOperation` 是同事务服务端读取；浏览器当前通过 Trace 取得 Operation／result。**固定树没有公开 `GET /api/hdl/operations/:id` 或 `/current` 路由，本表不发明这两个接口。**

## 3. 操作对照：作品、构建与装载

| 现有操作／落点 | 真实方法、路径与请求字段 | 对象 ID 与版本 | 返回结果／显示语义 | 已有／模拟／缺失 | 缺项负责人与验收 |
| --- | --- | --- | --- | --- | --- |
| 确认保存；U3 已有 C 文件／保存位置，U1 HDL「设计」仍静态 | `POST /api/attempts/A/sync`：`recoveryGeneration,expectedWorkspaceRevision,clientId,clientSeq,operations`。create 带 `clientFileKey,path,text`；update 带 `fileId,baseVersion,text`；recycle／restore 带 `fileId,baseVersion` | 服务端 `fileId,documentVersion,contentHash,workspaceRevision`，新实例以 ACK 映射；`.sv/.v` 保存复用原文本接口 | 核原回执、正文 hash／实例映射后显示确认；更晚草稿仍是未同步。请求中途刷新／丢 ACK 显示待核对，不能回灌旧正文 | U3 共用真实保存已接 C；C 保存无 HDL 扩展名门槛；U1 不可编辑，也无确认保存。HDL 实际页面接入缺失 | **UI：UDL-01/02** 复用编辑／确认链；**C** 提供合法 HDL 分配／快照样例。DL-AC-01/02；AC-03/04；浏览器 HDL 保存未执行 |
| 冻结确认快照／比较作品版本 | `POST /api/attempts/A/snapshots`：`recoveryGeneration,expectedWorkspaceRevision`；`GET /api/attempts/A/snapshots/:snapshotId`，及 Attempt head 原读取 | `snapshotId,hash,workspaceRevision`、完整文件实例／正文／版本清单；不使用演示 `v3/v4` | POST 回执后 GET 全量核 hash、归属、正文；明确「确认快照」与新草稿不同，未同步草稿不改变既有 Build／Session | U3 共用快照／比较已在 main；E1/E2 有真实 HDL 快照。HDL 入口绑定缺失 | **UI：UDL-02**；**C** 保持原 ACK／快照契约。DL-AC-02/04，保存旧 ACK 与刷新恢复反例 |
| 「构建」按钮 | `POST /api/attempts/A/hdl/builds`：`recoveryGeneration,expectedAttemptRevision,snapshotId`；随后 `GET /api/hdl/builds/B`／原 `GET /api/jobs/:jobId` | ACK `buildId,jobId`；Build request 固定 snapshot、board、runtime／engine、配置 hash；Build result 的同对象绑定 | 显示 queued／running／succeeded／failed／cancelled／outcome_unknown；`result=null` 仍在等待。只有真实 succeeded、产物绑定及终止事实满足后才供装载 | C1/C2、E1/E2 已交真实构建；U1 `onBuild` 直接显示模拟成功 toast；main 没有 HDL 请求客户端 | **UI：UDL-03** 接原按钮；**C** 负责 runtime readiness／Job 消费与异常事实。DL-AC-03/07；模拟 toast 不计通过 |
| 构建诊断与定位源码 | `GET /api/hdl/builds/B` 的 `data.result.diagnostics`，原快照 GET；无另一个诊断 API | 固定 `buildId,snapshotId,hash,fileId,path,documentVersion`；diagnostic `severity,message,fileId?,path?,line?,location` | `location=line-only` 只定位该快照的整行，不猜列；`unavailable` 明示不能定位。warning 与 error 分开；构建失败不是课程能力结论；正文变后原诊断标旧版本 | C2/E1 有 `top.sv` 第 5 行真实错误；U1 只有静态 TODO／模拟结果，诊断定位缺失 | **UI：UDL-03** 原快照／当前草稿区别和定位；**C** 保留诊断精度／不可用状态；**B** 消费授权去敏诊断。DL-AC-03/08 |
| 「烧录到虚拟板」现有位置：显式虚拟装载 | `POST /api/attempts/A/hdl/programs`：`recoveryGeneration,expectedAttemptRevision,buildId`；随后 Session／Trace GET | ACK `sessionId,operationId,jobId`；Session 的 Build／snapshot/hash、板型／映射／运行／引擎／代际；初始 sequence 0 | 是装载仿真产物，不是实体 FPGA bitstream。先 starting／pending，真实 active 与初始结果后才能操作；不是本机把 loaded 标签改成草稿版本 | C1/C2、E1/E2 已有真实持续装载；U1 loaded 状态为模拟。真实 UI 装载缺失 | **UI：UDL-04** 绑定原 ID 与状态；**C** 保证成功 Build／生命周期／实例隔离。DL-AC-04/07 |
| 明确替换已装载 Session | 同一 programs POST，另带配对的 `replaceSessionId,expectedSessionRevision`；重读原 Session 直到 `terminationConfirmed`，再核新回执 | 保留旧 Session 身份、revision／终止结果及新 Session／Build，不能用新草稿污染旧实例 | 旧实例未确认终止时不显示替换成功，不隐式重发创建新 Session；冲突显示当前状态待重新核对。重新装载按固定初始化规则 | C1 请求 schema／C2 显式替换实现和 PR56 应用测试已有；E1/E2未记录替换浏览器。U1无真实替换状态 | **UI：UDL-04/06**；**C** 补准确替换／终止样例的固定链接及部署一致性。DL-AC-04/07；未执行的实际浏览器替换保留 |

## 4. 操作对照：输入、输出、时间与覆盖

| 现有操作／落点 | 真实方法、路径与请求字段 | 对象 ID 与版本 | 返回结果／显示语义 | 已有／模拟／缺失 | 缺项负责人与验收 |
| --- | --- | --- | --- | --- | --- |
| SW／按钮／reset／显式推进；U1 板卡现有位置 | `POST /api/attempts/A/hdl/interactions`：`recoveryGeneration,expectedAttemptRevision,sessionId,expectedSessionRevision,expectedSequence,inputs={switches,buttons,resetN},advanceCycles`。SW 为 **16 位** `01` 串，按钮 **5 位** `01` 串，resetN **1 位**；`advanceCycles` 整数 1～5,000,000 | ACK `sessionId,operationId,jobId`；请求冻结 Session revision、下一 sequence、输入、推进量；以返回 Session 与 Operation 更新确认状态 | 学生显式操作；按钮按下／松开分别表达，高有效；CPU reset 按下为低／松开为高，不等于 UI count 归零。相同输入持续推进仍走新明确操作；pending 仅显示等待，不能补造下一帧或排重复请求 | C1/C2/E1/E2 有真实交互；U1 SW 本地布尔、按钮增加本地 count、reset 设零；没有真实 16SW／5BTN／推进协议接线 | **UI：UDL-05** 复用板卡槽位／显示真实输入确认；**C** 提低相位与顺序约束、按钮／reset／pending 样例。DL-AC-04/06/07；计数与复位工程用例不新增 ALU 判分要求 |
| LED、段选／位选／DP | `GET /api/hdl/sessions/S/trace?afterSequence=N` 的 `data.operation.result.frames/finalFrame`；Session GET 查 confirmed 状态；板极性来自固定课程／运行配置 C3 | 每个结果带 `operationId,sessionId,buildId,snapshotId,snapshotHash,boardProfileVersion,mappingVersion,engineVersion,sequence,sessionRevision`。帧含 `leds[16],anodes[8],segments[7],dp[1]` | LED 高亮；AN／段／DP 低有效。按真实段位 bit 和有效极性绘制，不能从 ALU 值或本机 count 调 `SEGMAP` 代译码；多位选择／未选／错误段码如实呈现，保留当前采样窗口的限制 | C2/C3/E1/E2 已有原四态输出。U1 仅 4 LED 与单数字按 count 译码；8 位扫描、DP、真实错误表现接线缺失 | **UI：UDL-05** 真实位图与极性；**C** 真实输出／板映射来源；**A／课程负责人** 裁决新增教学要求。DL-AC-05/06；行为未验证不能标 ALU 正确 |
| 有限 Trace／波形与模拟时间 | Trace GET 每次返回下一条有限 Operation；`afterSequence=-1` 取装载初始 operation。只有 `result` 非 null 才采用 `nextSequence`；下一次沿该游标读取 | 帧 `simTimePs` 是十进制**字符串**、picoseconds；结果 `sampleCount,droppedFrames,coverage,resultHash`；schema `frames` 1～4096 | 用真实时间／sequence 绘有限窗口；不把页面 wall clock／计时器当 HDL 时间，不以 JS Number 丢大整数精度。`operation=null` 或 `result=null` 不代表零输出。上限内有界轮询／原 Job 事件等待，不无限补帧 | C2真实有限 Trace 已交，E1/E2各两批真实结果；U1为固定 SVG。浏览器真实波形／有界读取缺失 | **UI：UDL-05/06**；**C** 提采样／容量／边界来源，支持原协议。DL-AC-06/07；本次未执行波形浏览器或吞吐验收 |
| X/Z、无效段位、采样与覆盖缺口 | 同一 Trace 帧信号 schema 为 `01xz`；Session／Build 原状态；C3 fixed `stableSampling=low_phase`、`bitOrder=msb_first` | 原四态串、模拟时间、结果 hash／sequence；区分公开帧 coverage 与课程结构／行为验证状态 | X/Z 显式显示未知／高阻，不能转换为 0、补正确数码管或推断学生掌握。`coverage=incomplete`／`droppedFrames>0` 保留截断／缺口；`complete` 只描述本批帧覆盖，不能升格为全扫描、全部 ALU 定义域或 NFR 通过 | C1/C2应用反例已有如 `segments=x0z1010`；E1/E2此次真实帧只覆盖两次输入，ALU仍 unverified。U1不支持真实四态／容量／覆盖 | **UI：UDL-05** 四态和缺口展示；**C** H3稳定采样／层级引用／独立check Session占用与原限额内2800向量目标节点验收；**B** 引导保留未知；**A／负责人** 对新增契约／ALU检查确认。DL-AC-05/06/07，不为 UI 重做 C 已交提案 |

## 5. 操作对照：停止、恢复与 HDL 求助

| 现有操作／落点 | 真实方法、路径与请求字段 | 对象 ID 与版本 | 返回结果／显示语义 | 已有／模拟／缺失 | 缺项负责人与验收 |
| --- | --- | --- | --- | --- | --- |
| 停止 HDL 持续会话 | `POST /api/attempts/A/hdl/controls`：`recoveryGeneration,expectedAttemptRevision,action=stop,reason`；`reason` trim 后 1～1024 字符。Session GET 等退出；该 stop 属 **Attempt** 控制，不接受自造的 sessionId 参数 | 回执 `attemptId,stopRequested=true`；原 Session 的 `status,stopRequested,terminationConfirmed,pendingOperationId` | 请求停止／stopping 与已确认 stopped 分开；只有 `terminationConfirmed=true` 才宣称退出／释放。原 Run 的 cancel UI 不直接等同此 HDL stop | C1/C2、E1/E2有 stopped／terminationConfirmed 真事实；main已有 C Run停止，U1没有真实HDL停止 | **UI：UDL-06** 接适用 stop 并保留原Session；**C** 终止与资源释放／暂停撤权传播。DL-AC-07；未知不当成功 |
| unknown／断线／刷新恢复与旧响应 | 重读 `GET /api/attempts/A`、原 Build／Session／Trace／`GET /api/jobs/:jobId`；需要核原命令时仅沿同键／原请求重放已存在的端点，受原代际／权限约束 | 本机保存原 command key、完整 wire、账号／Attempt／代际、Build／Session／operation／游标；权威 Session revision／sequence来自GET，不能刷新重建 Session | `outcome_unknown`／服务不可达保持未知；旧加载／旧代际响应不能覆盖当前。刷新恢复后先核旧实例，不把重新装载写成恢复；旧代际、停止／替换后不自动执行积压操作 | C2后端读取／原键回执已有；U3/U4保存与C Run有原命令恢复方法可复用；**main未实现HDL命令持久化／恢复守卫**。不能把现有 C 通过数迁移计为 HDL 通过 | **UI：UDL-06** 窄适配、迟到守卫和真实刷新反例；**C** 运行源／代际／终止事实与恢复样例。DL-AC-07/09；新 schema 需求须单独列差异，不由表批准 |
| 选中真实 HDL 代码／Build诊断／Session／Operation求助 | 原 `POST /api/attempts/A/help`：`question,expectedAttemptRevision,recoveryGeneration,objectRef?` 加 `hdlSelection={snapshotId,buildId,sessionId?,operationId?}`；operationId 必配 sessionId，只问构建时省略两者 | code ObjectRef必须同快照：`kind=code,attemptId,snapshotId,fileId,path,documentVersion,contentHash,range?`；不能拿 runId 充 buildId、自动挑最新 Build 或本机草稿冒充快照 | C/H4在事务内冻结真实 Build／workspace／Session／Operation。失败Build可只问诊断；Session需active且无pending/停止，选Operation需对应当前确认sequence/revision/time。UI明确显示所指旧版本而不自动改作品／构建／装载 | H4已交选择DTO／授权读取／冻结current；E1真实B提示、第5行相关；E2验证最终workspace冻结。U4原help wire只有question/objectRef，未接HDLselection；原acceptedInputHash核验须在适配时沿新契约处理 | **UI：UDL-07** 选择／原请求／回执及接棒；**C** 当前授权事务／版本与公开读取；**B** 去敏上下文、有限最多32帧与提示／模型降级；A5教师正式判断仍归**A**。DL-AC-08 |
| HDL帮助展示、过时与模型不可用 | 原 `/api/attempts/A/events`／`/teaching-records`，消费已授权 `teaching.delivered`；原help Job查询。保留 `scope,jobId,messageId,generation,targetVersions,basis.objectRef,basis.hdl` | HDL basis含原 `snapshotId/hash,buildId,buildResultHash?,workspaceRevision?`，可选Session revision/status/generation／confirmedSequence／simTime／pending／stop／termination、operationId/resultHash；来自服务端冻结，不由UI补造 | 编辑／保存、pending、新sequence/revision、停止／替换、暂停撤权提交、代际变化后旧引导不能继续作为当前。旧记录留归属并标历史／过时；缺冻结basis的旧历史不能用当前值补全。模型关闭或失败显示不可用，保存／板卡仍可操作，不显示模拟AI正文代替 | H4/C3服务端多阶段current守卫已有；E1模型正文生成投递已验证；main U4虽有原教学生命周期，缺HDLbasis类型、选择与Session变化联动。实际HDL展示／过时浏览器未执行 | **UI：UDL-07/08** 保留完整来源并绑定当前对象；**C** 保持Delivery／Receipt事务复核；**B** 相关提示／语义与故障降级；DL-AC-08/09、AC-05/06/15/16 |
| 实际 received／displayed／acknowledged 回执 | 原 `POST /api/actions/:actionId/receipts`：`recoveryGeneration,deliveryId,clientId,contentHash,receiptKind,clientReceiptId`，可带真实 `clientDeclaredAt`；同原幂等键核回执 | 固定 action／delivery／正文hash、客户端与receipt身份；响应 `data.receiptId/actionId/receiptKind/serverSeq/replayed`，迟到保留 `raceReason` | received仅传输接收；真实可见渲染后才displayed；真人明确确认后才acknowledged。生成／投递／客户端接收不能代替后两者。失败先保留本机事实，不伪造服务确认 | U4已有C消息真实回执机制；E1仅测试客户端received，不是Chrome显示或真人确认。HDL渲染对应displayed／acknowledged验收缺失 | **UI：UDL-08** 实际渲染观察和原回执；**C** 原记录／事务复核；**B** 保持学生接棒。M-05、DL-AC-08/09 |

## 6. H4 current 的实际取得方式与可复用样例

浏览器先从获准 Attempt head 取得活动／尝试／作品版本，再读取**学生明确选中**的 Build、原 Session、有限 Trace。服务端 H4 `readAuthorizedHdlHelp` 复核所属、快照、Job终态、配置／引擎／代际；Session只能选择active、未停止／未终止、无pending的实例；Operation必须是同Session当前确认sequence/revision和simTime的成功结果。`projectHdlHelpCurrentState` 的冻结投影进入原问题／候选／Delivery／Receipt guard。UI不额外计算一个授权 `current=true`，也不从页面「最新对象」重建冻结basis。

E1 与 E2 的原日志只固定引用，不在本表复制整包；以下对象只作可回查样例，不是本轮账号配置或重新执行指令：

| 样例 | 固定对象／事实 | 证据边界 |
| --- | --- | --- |
| E1失败Build→真实提示 | Attempt `3c1c3e2c-1304-4d43-9398-c69c81a9c2a6`；snapshot `80feb233-1514-42c6-9005-89b5fccee005`；failed Build `a7209136-e257-4eae-92b1-3293310f37e0`；`top.sv` line5，`location=line-only` | 真实模型1次HTTP200、2615/388 tokens，C3投递及received；先于最终workspace冻结增强，不改旧日志补该字段；未浏览器展示、未教师语义审阅 |
| E1持续输出／停止 | Session `5aa272e9-cf7e-4222-b622-df746910a845`；operation `5b273589-ab9d-4c99-ab56-99e92815201b` sequence1/revision2，`ff804b8a-c486-48b6-805c-96043dbba10b` sequence2/revision3；LED分别 `0000000000001000`／`0000000000000110`，simTime40000／80000ps；stop `stopped,terminationConfirmed=true` | 同真实Session两批各4帧、`sampleCount=4,droppedFrames=0,coverage=complete`；仅这两批，不是全扫描／2800向量／ALU行为判定；browser未执行 |
| E2最终冻结守卫 | Attempt `54bb4cfc-5d64-42a2-a1c9-58ea58458705`；snapshot `15edf702-3bd7-4a2d-b58c-b01ef2359103`；Build `7fe97581-eef2-4614-a2a2-222a7bb0abd2` 的H4 basis含 `workspaceRevision=1`；Session `64313fc4-458c-4d89-85cc-bc6d078a13b0` sequence2/time80000ps，确认stopped | 验证最终workspace冻结与真实构建／会话；额外模型调用0，没有重复消费E1单轮预算；浏览器未执行、ALU unverified |
| pending／替换／旧序／四态／停止反例 | 固定 [PR56应用反例](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/tests/dl-a-app.test.ts)、[H4反例](https://github.com/paher-din/XunJie/blob/7100ea6b6c9182f4c1b36fdc0ddccdca32b70754/apps/teaching/tests/dl-a-hdl-help.test.ts) | 代码/隔离测试样例引用；本次未重跑，不能与真实节点或Chrome证据混记；C可回交相同固定来源，不重制首批材料 |

## 7. 缺项交接与后续验收

| 缺项 | 本次真实状态／责任 | 交付判据 |
| --- | --- | --- |
| UDL-01 HDL真实课程进入 | **UI主责**，C给统一宿主/获准分配/运行配置；main TaskRoute仍通往C页面。不会从演示counter卡片推定真实课程/Attempt | 沿既有入口合法进入同一两课程环境；C入口无回归，DL-AC-01；不新建替代页面或把演示ID改名 |
| UDL-02 HDL编辑/确认快照 | **UI主责**复用现有原文、文件/ACK/快照；**C**补实际对应对象样例，已交接口无需重做 | `.sv/.v`可编辑；ACK对应正文/版本/hash；更晚草稿及原快照区别；DL-AC-02/04 |
| UDL-03 构建/诊断定位 | **UI主责**，C运行/诊断事实；B只消费获准上下文 | 真实失败不显示成功；旧快照整行定位、未知位置保留；真实成功Build才供装载；DL-AC-03 |
| UDL-04 Session装载/替换 | **UI主责**绑定原ID，**C**保留停止/替换/初始化/权限事实及其样例 | 真实持续实例/旧设计隔离/显式替换；确认退出才完成替换；DL-AC-04/07 |
| UDL-05 输入/四态输出/波形 | **UI主责**；**C**负责真实引擎/采样/时序与限额；课程新裁决由A/负责人 | 按16SW/5按钮/resetN/显式推进，真实LED/段位/DP/X/Z、模拟时间/有限Trace/缺口；错误设计不被UI纠正；DL-AC-05/06 |
| UDL-06 停止/unknown/刷新 | **UI主责**原HDL请求持久化/上下文迟到守卫；**C**原回执/退出/代际/恢复 | 同键核旧命令、原Session读取，停止确认/不可确认区别；刷新不重建执行；DL-AC-07/09 |
| UDL-07 HDL求助/过时 | **UI主责**selection/basis/当前性/回执核验适配；**C**原授权/current守卫；**B**语义与有限去敏输入/故障降级 | 同快照/Build/Session/Operation；新版本或pending/停止使旧消息失去当前资格；模型不可用不阻作品；DL-AC-08 |
| UDL-08 真展示/回执/本地复现 | **UI主责**实际浏览器；**C组织DL-E2E**、B配合已有真实模型内容/语义边界 | 同一浏览器错误→真实帮助→学生自行修订→新构建/显式装载→同输入输出改变，并有真实displayed/acknowledged分层事实；DL-AC-08/09。本次全部未执行 |
| C H3后续，不阻已成熟H4 | **C主责**层级引用/稳定采样/独立check Session占用、command/result/准确写集与原限额内2800向量；已有提案/批准源码直接引用E3，不让UI重制 | E3记录的目标节点新镜像/worker/吞吐/停止/崩溃/双实例及活动绑定course_check仍未执行；共享协议/ALU检查沿准确批准。公开两批Trace不是私有2800向量检查结果 |

以上是已明确职责内的缺项记录，不是 UI 单方给 C/B/A 新增任务或改变排程。保护基线与正式验收汇总**待授权维护者汇总**。表／方案／新增证据回交 [DL-A #38](https://github.com/paher-din/XunJie/issues/38)或原 [DL-C #39](https://github.com/paher-din/XunJie/issues/39)，固定链接回填 [I0 #30](https://github.com/paher-din/XunJie/issues/30)的共用入口；不在 #53／#56 重复粘贴同一整包日志。

## 8. 本次核对与验证状态

实际只读核对：`git show 7100ea6…:<path>` 读取 C1/C2/C3/H4/E1/E2/E3 正文与schema，核所有列出的HTTP方法/路径、请求字段、信封、四态宽度、sequence/终止/current守卫；读取U1～U4确认现有UI是静态/模拟或已接的共用C能力。E1/E2从固定原JSON核对象、模型请求分母和明确未执行字段，不生成或补写原证据。

本次仅新增本操作表；不新增测试、不安装依赖、不运行真实构建/Session/模型、不改变PAHER或TLS/账号/数据库。`node tools/a0-review/check.mjs` 实际检查88份文档、1303处内部链接，`errors=[]`；`git diff --no-index --check -- NUL docs/tasks/I0-UI30_HDL_OPERATION_MAP.md` 无空白错误（新文件差异退出1不代表空白失败）。本批其他文档收口后由主执行者记录最终联合结果；未执行项保持如表。此文件交付表示**评论要求的对照与缺口交接材料已完成**，不表示HDL UI接线、DL-AC全项、正式M/AC/NFR或教学效果通过。
