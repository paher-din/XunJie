# I0-UI：客户端实施前置、准备运行与保存约束

日期：2026-10-11。状态：`document-revised`，未实施。本文是本批任务内的具体规划，配合 [SPEC](I0_UI_SPEC.md) 和 [任务索引](I0_UI_PREPARATION.md#6-本地-tickets-与交付顺序)阅读；不替代产品基线，不扩大编码、建库或 UI 授权。项目负责人要求整改原审查 8 项，任务粒度继续由规划 Agent 判断。

## 1. 文档状态与执行前置

`document-revised` 只说明规划已修改。ticket 的 `blocked` 表示至少一个必要执行条件未满足；`ready-for-agent` 只在对应编码范围已授权、前置 ticket 已交付且其他必要条件已落实时使用。不得把“文档可以阅读”标成可以编码。各前置分别记录，不能互相代替。

| 编号 | 具体条件 | 当前事实 | 影响 |
| --- | --- | --- | --- |
| P-01 | 对某个 ticket 发出编码指令，核初始 Git 差异与实际写集 | 当前只授权文档整改，没有实施指令 | 所有 ticket 尚未开工 |
| P-02 | 明确批准新本机 IndexedDB schema：新库 `xunjie-i0-workspace`、版本 1；草稿头/冲突候选、确认作品、实例映射、原命令与序号元数据。记录均带 mode/account/Attempt 归属；不迁移、清空旧库或改服务端 schema | 具体提案已补齐，实际建库未获单独批准 | 02 的持久化及其后续行为；02 可先做获授权的编辑器适配验证 |
| P-03 | 执行任务获准新增精确依赖：`monaco-editor` 运行依赖、`@playwright/test` 开发依赖；在来源 React/TS/Vite/Node 上核兼容并锁版本 | Monaco 路线已确认；测试方法已由本次规划选定。未安装，未把测试建议的未答复记成安装批准 | 01 建浏览器 harness 前须落实测试依赖范围；02 增编辑器依赖前须核对应授权 |
| P-04 | 对缺少的业务操作，UI 成员交付具体组件/槽位或确认对应的最小扩展（第 7 节逐项记录） | 已指出缺口，尚无这些新增操作的实际 UI 交付 | 只阻塞受影响的交互；可先接已有容器与客户端，不自行设计新页面 |

后续授权只消除对应条件；执行 Agent 不自动改其他文档状态或把其他 ticket 标成已完成。来源/版本的兼容核查是开工工作，不要求负责人再次选择 Monaco。数据库审批来自 [AGENTS 的红线](../../AGENTS.md#红线必须先说明操作理由风险并征得用户同意)，UI 扩展约束来自同文件的实现边界。

## 2. 准备模式必须能独立启动

选择**开发启动也可交互**的准备模式，不能只在自动化拦截中存在。01 交付独立学生工程的 `npm run dev:prep`；该命令启动已有 Vite，并仅在 preparation 模式启用本地开发 fixture middleware。普通 `npm run dev` 使用真实 transport，真实初始化不足时显示 unavailable；不能自动改用 fixture。`npm run build` 的正式产物不含准备 middleware、控制端点或合成账号材料。

工作区使用一个窄 HTTP 客户端；按显式模式选择 base URL。准备请求使用开发专用 `/__i0prep/api`，真实请求沿用同源 `/api`；路径、输入、信封和响应投影相同。fixture 从现有 C2 integration 样例取回执/错误形状，并记录来源。生产 bundle 不导入后台模块。

准备 authority 状态归 Vite 开发进程：固定合成 Session/Assignment/Activity/材料、文件确认头、快照、原请求回执和脚本化 Job/Run 结果。浏览器刷新/新标签读同一个进程状态；请求确认与后续 GET 一致。仅实现本批客户端场景的受控响应，不实现真实鉴权、GCC、调度、模型或完整后台。不能用其状态转换验证服务端业务正确性。

准备 bootstrap 元信息从开发专用 `/__i0prep/context` 读取：场景/epoch、合成受信代际、profile 和获准合成对象引用；只在准备 transport 中注入共同的工作区初始化边界。它是开发 fixture 配置入口，不是拟定的正式 API，不能把这些字段塞入真实 GET Session/Run 投影。真实初始化按 H-01～H-04 已交接来源取得，缺字段不可用，不使用准备常量。场景恢复脚本变代际后重新获取准备上下文，也必须走 loadEpoch 失效规则。

- fixture 接收真实客户端发出的原序列化请求，按场景推进确认文件/版本与快照；相同原命令返回相同回执，新命令不得复用原命令槽位。结果与诊断明确标合成，课程私有输出不补造。
- 开发进程重启后 authority 重置并换 preparation epoch/合成代际；本机草稿保留，旧“已确认”缓存不能当新 head。重读并提示重新比较，旧 outbox 不自动迁代际或补发。
- 测试默认也启动 `dev:prep`，使用同一 fixture 与 HTTP 客户端。故障入口仅在 loopback 开发/测试进程启用，用于延迟、丢 ACK、失败和恢复脚本；自动化可以拦截网络故障，不能另外造成功响应字段。
- 每个测试/浏览器上下文选独立合成场景 ID；同一场景的多标签共享 authority。实际 fixture 状态属于准备模式，不进入真实 Session、学习记录或学生资料。
- 模式固定在工作区上下文创建时；切换须失效旧上下文、清除其内存展示并重读。真实请求失败保持失败；准备 transport 不向真实服务或外部模型转发。

01 先交付 Session/固定活动/材料读取与可用 C 容器；03 扩展同一个 fixture 的保存/快照，06 扩展脚本运行。不能将这些分散成三套客户端或通过设置页另起假保存。

## 3. 当前上下文与异步接纳

每次打开工作区、重新认证、切换模式/账号/Attempt、主动重新加载或安装新受信 recoveryGeneration，都产生单调增加的本机 `loadEpoch`。当前上下文包含 mode、Session 身份、Attempt、loadEpoch、受信代际；准备模式还含 preparation epoch。任何 await 后更新 UI、确认头或当前工作区存储前，重新核对捕获上下文仍然有效。AbortController 只减少在途请求，不能作为正确性保证。

同一个上下文内，权威 head 的读取也有单调的 read request 序号；较早的 GET 不能覆盖较晚已接受的 GET/ACK。sync 单工作区按原命令串行发送；另一个标签仍可提交，但 CAS/冲突不能省略。Job 轮询同样核上下文、run/job 及读取轮次，迟到的 running 不能覆盖已接受的终态。

同一受信代际内，还必须核确认 head 的 workspaceRevision：旧 ACK/GET 比当前已接受 head 更旧时只记原回执历史，不能把当前 head 回退；其创建映射按当前权威文件清单核对后关联草稿。同版本正文/hash 冲突进入不可用/重读，不按到达顺序选一个。不同代际可能合法回退，不能跨代际取最大 revision。必测另一个标签推进 head 后旧 ACK 才到。

旧代际 ACK 可以在原隔离命令记录中保留“该旧请求曾有回执”的事实，但不得把该正文装到新代际的当前确认头、fileId 映射或 UI，不得宣称它在恢复后的服务上仍存在。原请求即使返回 `replayed`，也只能证明那个命令的旧结果；按当前获准 GET 核 head。首次代际缺失时不发送写命令。

必测：g1 保存成功但 ACK 延迟，g2 已重读回退 head 后再到 g1 ACK；同身份同 Attempt 两轮加载逆序返回；退出后以同身份重新进入；旧 Job poll 在新 poll/终态之后返回。全部必须保留当前权威状态和各自草稿，不靠“对象 ID 一样”放行。

## 4. 原文本权威与 Monaco 适配

**权威是草稿的原始有效 Unicode 字符串及其 UTF-8 字节，不是 `model.getValue()`。** 确认文本、草稿原文和快照各有独立值；BOM（开头 U+FEFF）、每个换行分隔符（LF/CRLF/CR）和末尾空行保留。仅打开、选择、切换或比较不改变原文/hash/dirty 状态。

Monaco 使用 LF 显示投影，适配层保存显示 UTF-16 offset 与原文 UTF-16 offset 的双向边界映射：CRLF、CR 投影为显示 LF，开头 BOM 保留于原文而不当作可编辑首字符。在每次内容变更前，用旧投影映射其范围，再对原文应用学生实际编辑；多处变更按原坐标逆序应用。未触及区域的分隔符不变。学生新增换行默认采用原文第一个分隔符，无分隔符则 LF；此规则仅作用于新增正文，不全篇规范化。

撤销/重做必须恢复原文和分隔符/BOM 元信息，不能把 Monaco 返回的规范化文本当逆操作。适配层为编辑历史保留原文前后态或等价的可逆原文补丁，与当前 model 的 undo/redo 状态对应；在锁定版本上证明跨行删除、撤销、重做及分支编辑可逆。中文组合输入只在真实内容变化时推进草稿，不从光标/焦点推断正文。

将显示选择转为代码引用时先映射到原快照 offset，再按**当前服务端范围语义**计算一基 UTF-16 行列：现实现以 LF 分行，CRLF 行尾 CR 不算可见列，裸 CR 不独立分行。不能直接发送 Monaco 的显示行列。映射碰到不可表达边界、代理项内部或信息缺失时，该引用不可用并保留原文；编辑/整段 text 保存不因此改原文。sync 初版发送完整原 text，不借 display changes 猜服务端补丁坐标。

02 的前置技术验证在所选 Monaco 精确版本上运行：LF、CRLF、混合 EOL、裸 CR、BOM、空文本/末尾空行、非 BMP/中文、多个编辑范围。每种验证“打开未编辑→序列化”“局部编辑→保存正文”“跨行删除→undo→redo”。03/05 再验证确认、快照摘要和只读比较。失败时保留原文并报告适配缺口，不改换编辑器、不规范化作品或改基线来过关。

官方 API 参考：[ITextModel](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ITextModel.html)、[内容变更事件](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.IModelContentChangedEvent.html)。这是本批适配方案；当前没有安装精确版本或证明其实现通过。

## 5. 原命令、ACK 事务与崩溃恢复

冻结请求先落盘，再发 POST。原命令保存完整业务输入、正文、clientId/clientSeq、预期版本、代际、业务键和归属；不能持久化密码、provider 凭据或 CSRF。重放取得当前有效 Session/CSRF，业务输入不变；身份/代际不符先停写。未落盘或本机存储失败时不得发请求并声称可安全恢复。

clientId/clientSeq 是 sync 的公开输入；snapshot、run、cancel 等按各自现有 schema 序列化，不附加不存在的协议字段。本机 outbox 的上下文/lease/来源元数据与 wire 正文分开，不能直接把整个本机记录作为请求发送。

clientId 为一次客户端实例生成的不可复用随机 ID；同一活跃标签/上下文的 clientSeq 在 IndexedDB 元数据事务中单调预留，绝不回退/复用，预留后中断可跳号。新标签/新实例用新 clientId；恢复 outbox 继续用**原命令**的 clientId/seq，不能重编号。原命令发送权限用有期限的本机事务 lease 协调；lease 只避免重复重放，同键重放仍须幂等，不能把本机 lease 当后台执行资格。

接受当前有效上下文 ACK 时，以下内容必须在**同一 IndexedDB readwrite 事务**提交：

1. 校验原命令与回执，冻结发送正文按返回 file 元数据形成确认基线。
2. 保存 clientFileKey→fileId 映射；更新相关草稿关联（不换实例的稳定本机身份）。
3. 以事务内最新 draftRevision 为准保留保存之后的编辑及冲突候选，不能回灌冻结正文覆盖它。
4. 保存确认头/回执与该 outbox 已确认状态；多次收到同 ACK 可重复接纳且不产生第二次创建。

事务 complete 后才更新可见“已确认”状态。事务中断/失败时所有这些本机写入一起回滚；页面保留正文与原待确认命令，显示“服务回执已收到，本机确认记录未完成”，刷新可核原命令。存储事务成功不等于浏览器/设备物理介质永久无故障；本批只承诺事务提交/中断与页面刷新可恢复的边界。[IndexedDB 事务参考](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction)。

必测：服务创建成功，ACK 本机事务在映射/确认头/草稿关联/outbox 各步骤之后被 abort；刷新只重放原命令并恢复同一 fileId；再次收到 ACK 不重复创建；保存后的草稿仍在。另测两标签同时发不同命令没有 clientId/seq 槽位碰撞，事务计数预留中断不复用。当前这些只是验收要求，未执行。

03 交付给后续任务的共同边界：带上下文的 bootstrap/read head；原文草稿+draftRevision 与稳定实例映射；冻结 outbox/原回执查询；确认头；不可变 snapshot 读取；当前 Attempt 权威重读。后续恢复、文件历史、运行调用这些边界，不能各建第二份确认状态或把 editor version 当服务版本。

## 6. Run 展示只能消费已有公开投影

当前 GET Run 不公开 entryFileId/input/inputHash。fixture 不增加这些字段；本批不提后台改契约作为必需条件。能展示的字段与缺项状态如下：

| 信息 | 权威来源 | 缺项时 |
| --- | --- | --- |
| runId/jobId、snapshotId/hash、mode、profile/image | 当前 GET Attempt/Run 公开投影；启动回执关联 ID | unavailable，不借当前选择控件补填 |
| Job 状态/停止意图/代际 | 当前 GET Job 与获准投影 | 读取未知保持原运行；不能解释成“未运行” |
| 入口/操作/参数/测试 fileIds | 本机冻结的原请求，且经原命令回执确认关联到这个 runId/jobId；标“本机请求记录” | 明确“历史运行参数不可回取”；另浏览器/缓存丢失后不猜、不禁读已有结果 |
| 诊断/stdout/stderr | GET Run diagnostics 的 available 分支 | unavailable 不是空输出成功；编译位置缺失则只读原信息 |
| 课程检查 | 公开 verdict/failureKind | 不补私有输入、期望答案或未公开 phase 输出；Job succeeded 不等于检查通过 |
| 产物 | `/files` available 的逐项 run/snapshot/hash/bytes/complete 校验 | redacted、unavailable、missing、incomplete 各自显示；不提供不存在的下载或补正文 |

两次比较允许某次参数 unavailable，保留各自来源标签、快照、状态与能取回的输出；不得把“必须完整比较输入”设为当前公开契约下的验收。Report 只在固定活动实际支持且公开产物 available 时开放；不借此扩课程。结果文本只读、安全呈现，不写回作品。

## 7. 现有 UI 能力差异与接入责任

来源固定提交的 CenterToolArea 仅有 design/board/wave；WorkspacePage 只对 counter 展开中心工具。复用页面与容器不能代替缺失能力。下表是对接清单，不是新的页面/视觉设计或 TEAM_WORK_PLAN 调整。

| 编号/能力 | 已有交付与差异 | 接入落点/负责 ticket | UI 条件 |
| --- | --- | --- | --- |
| U-01 C 中心容器 | counter 有胶囊、标签与分屏；其他任务为工具包占位 | 01 将明确 C 场景接到既有中心容器；design 内容按任务适配，board/wave 保留数字逻辑演示 | 复用实际结构；交付可聚焦的 C 容器和明确待接正文，01 不宣称已有编辑/保存 |
| U-02 多文件入口/新建 | 静态代码行，没有文件实例导航 | 02 接实际 editor 槽及文件操作组件 | UI 成员提供/确认文件操作的组件与既有槽位，尚未交付；不由 Agent 新造导航 |
| U-03 保存状态/快照 | 旧版本和构建为模拟 | 03 在现有作品/版本交互位置绑定真实确认状态 | UI 成员提供/确认保存、版本和冻结操作；不得把旧 v3/v4 当确认快照 |
| U-04 冲突比较/选择 | 无实际业务比较入口 | 04A 复用现有中心容器，只接对比/明确选择 | 新增操作的具体组件/槽位待 UI 交付；只读不能自动合并 |
| U-05 生命周期/历史 | 无实例回收恢复和真实历史 | 05 接文件操作与既有版本容器 | 具体入口待 UI 交付/确认；不造 rename 或强制覆盖 |
| U-06 运行/诊断 | 原 construct/toast 模拟，无 C 参数与结果 | 06 接现有构建/结果容器；06A 接取消/未知，06B 接历史/产物 | UI 成员提供/确认 C 参数、运行状态、停止与结果控件；不显示模拟构建为真实运行 |
| U-07 模式与身份 | 现有任务卡/设置昵称不等于 Session | 01 的 bootstrap 读取绑定现有身份/任务信息；03 接首次 Attempt 原命令 | 不自动新增登录页面；真实登录交互若无交付保持明确缺口 |
| U-08 活动与资料 | 现有要求/消息容器可展示文本，数据是假任务 | 01 窄读取客户端消费固定 Assignment/Activity、可见 Resource 及错误 | 复用已交付阅读位置，缺段落/不可见明确 unavailable/redacted，不造正文 |

前端接入成员记录 UI 实际来源版本和每项落实状态；缺项阻塞对应交互验收，不阻塞独立的读取/适配技术核查。P-04 只有具体项目已落实才消除，不能把规划 Agent 的槽位建议标成 UI 已交付。

## 8. 按能力交接真实服务

先交最小准备路径 01→02→03→06；04/04A/05/06A/06B 增强，07 收口全批。各 ticket 都有自己的浏览器检查，07 不成为真实读取/保存/运行的统一启动门槛。

| 真实接入能力 | 客户端责任 | 必需交接 | 无需等待 |
| --- | --- | --- | --- |
| Session/固定活动/资料读取 | 01 提供 POST sessions、GET session、POST logout 及按获准 ID 的 Assignment/Activity/Resource 读取客户端；Session/CSRF 不从昵称构造 | H-01；A 提供获准入口/分配引用（H-02，可列表或授权深链）；对应 H-06 读取样例及实际 UI 落点 | 新发现列表 API、运行 worker、全部历史增强 |
| 已有 Attempt 只读 | 03 使用已有 GET 读 head/文件/快照 | 读取身份与获准 Attempt 引用、读取样例 | 初次 create 所需代际、运行 readiness |
| 首次 Attempt/确认保存/快照 | 03 负责 POST attempts 回执、GET Attempt、sync/snapshot | H-01、H-03；H-05 版本/状态重读；对应 H-06 保存与快照样例；P-02/P-04 对应项 | H-04 执行、完整分配列表、06A/06B |
| 一次 Core 运行/基础结果 | 06 负责 run 命令/Job/Run 读取 | 保存链条件、H-04 readiness/profile/持续消费原 jobs、对应 H-06 运行样例 | 完整历史参数投影、Report、所有 H-06 产物样例 |
| 停止/原运行未知核对；历史/产物 | 06A/06B 分别负责 | 对应公开端点、状态/错误或产物裁剪样例 | 另一个增强 ticket 和不相关后台模块 |

H-02 的要求是“能合法找到本人分配”，不是预先决定必须新增列表 API。已获准引用可用于独立联调，不写真实 ID 常量、不猜遍历。H-06 按能力交样例即可；不因完整样例包未齐阻塞所有前端工作。真实接入范围及写指令仍须明确，不在本文私自派后台任务或改变共同排程。

## 9. 本文件验证记录

当前只完成文档整改。依赖安装、Vite fixture、Monaco 原文适配、IndexedDB 事务、浏览器和真实服务验证均**未执行**；不得用本文的描述声称已经实现。具体文档检查及 8 项闭环见 [审查记录第 6 节](I0_UI_ADVERSARIAL_REVIEW.md#6-整改与复核记录)。
