# I0-B：辅导链前端批次计划与 ticket 索引

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。状态：`prepared-verified / pending-real`，六票准备实现已整合并完成对应检查；真实范围仍受外部交接条件约束。入口：[I0-B SPEC](I0-B_UI_TUTOR_SPEC.md)、[完整30项清单](I0_REMAINING_WORK_CHECKLIST.md)。本文件记录范围、来源、写集与执行事实；不代替产品基线、A/B/C任务或成员交接。

## 1. 当前决定与授权

2026-10-13，Robert 要求修复 Git 连接，准备 UI-TUTOR-01～08，使用指定的 `to-spec` 落文档、`to-tickets` 拆分 tickets，并明确后续继续原 `i0/ui-frontend`。本次授权的是读取、连接修复、正常基线同步和本批规格/ticket 文档；没有把附件中的启动语、旧 I0-A 或历史提交/合并授权当作新辅导实现批准。

首稿完成后，2026-10-13，Robert明确指示“你来判断检查，没问题就定下来，然后提交”，将六票粒度、依赖与测试边界的核查/定稿委托规划Agent，并授权本批文档本地提交；随后提供原HTML清单，要求将完整清单落仓库。已完成该委托检查，最小UI接线与§7前端写集作为规划定稿，具体理由见§8.2，不再保留这几项待Robert答复。

本次交付为规划定稿与文档提交，未开始应用编码。后续实现继续原分支，依每票写集/前置执行；未交接对象关联、历史读取、限定检查状态以及真实环境仍分别处理，不把定稿当作共享契约或基线写入授权。真实模型许可均为已用历史批次，不发新请求。

本地Markdown tickets沿用[I0准备记录](I0_UI_PREPARATION.md)的一票一文件方式，存放在当前任务目录；不另建.scratch副本或远端票。本次未创建/修改GitHub Issue、标签或PR，父卡不关闭。首稿核查GitHub无ready-for-agent标签；后续如改用远端tracker再确认发布形态与标签。六票当前为planned，前置票/外部交接另列，未执行项目不标完成。

## 2. 已读正文与依据

2026-10-13，Robert明确要求“开始完成这批任务”，并要求为可并行部分建立工作树和分支。授权本批前端实施与隔离合成验证；整合分支仍为`i0/ui-frontend`。01/02及共享页面、HTTP、准备authority由主Agent串行负责；06在`codex/i0-b-06-controls`独立实现政策/控制，03在`codex/i0-b-03-code`独立实现快照/选区适配，04在`codex/i0-b-04-run`独立实现原运行引用/动作槽。03/04完整发送链等02接缝交付后集成，05等01正文接缝后开展。各工作树仅提交各自写集；主Agent复查后整合、统一运行浏览器检查。外部D-01/02/03/04继续保留，不授权共享后台契约、数据库schema、凭据、供应商请求或部署。

开工核对：原分支提交`ee95dcf`，工作区仅有原未跟踪`.zcodeignore`，不暂存它。远端回读PR #53仍为OPEN/Draft，head更新为`c071b4d0874c8cb1e8b83c95108fda2519a30cf0`；#30新增C的HDL节点回交，不能替代正常HTTPS和本批辅导浏览器验收。此处记录新时点，保留下文规划时点事实。

| 材料 | 已读章节/用途 | 本批依据 |
| --- | --- | --- |
| [PRD](../product/PRD.md) | §1、§3、§4.2、§5、§8 | C-02/C-05，PRD-03/04/05/07/09/10；学生控制、支持后接棒、记录用途 |
| [MVP_SPEC](../product/MVP_SPEC.md) | §2，M-03/04/05/09/10，§4/5/6/9 | 原对象/政策/回执/三控制；AC-02/04/05/06/07/11/12/15/16；NFR-01/02/04/05/06 |
| [TECH_DESIGN](../product/TECH_DESIGN.md) | §3.3、§4.1/4.3/4.4、§5/5.1、§6.1～6.3、§7.1～7.5、§9、§10.3、§11/12 | ObjectRef、公开投影、CAS/幂等、先审后展示、取消/回执/游标、代际与故障 |
| [TEAM](../planning/TEAM_WORK_PLAN.md) | §1/2/2.1、§6、§9/I1/I2/I3 | 既定 A/B/C/UI 责任、服务端/浏览器/真人分层、按必要批次交接 |
| [I0-A SPEC](I0_UI_SPEC.md)与[客户端约束](I0_UI_CLIENT_CONTRACT.md) | Problem/Solution/Implementation/Testing/Out of Scope；客户端 §1～9 | 现有共同 HTTP/存储/原文本/异步守卫；I0-A 不包含新辅导实现 |
| [前端术语](I0_UI_GLOSSARY.md)、[ADR](I0_UI_ADR_0001_DESIGN_IMPORT.md)和[IMPORT_SOURCE](../../apps/student/IMPORT_SOURCE.md) | 词汇、固定来源/选择性同步及交付边界 | 不改来源路线，不用 taskId/路径替代业务身份 |
| [B2](B2_STUDENT_HELP.md) | §1～10 | help/可信上下文/当前性与已交服务端链；开头旧状态按新记录核对 |
| [C3](C3_TEACHING_MESSAGES_RECEIPTS.md)与[工程衔接](../reference/ENGINEERING_HANDOFF.md) | C3 §1～6 的方案；工程衔接各节 | Message/Action/Receipt、取消/采集、旧能力不计新验收 |
| [I0 收尾](I0_UI_CLOSEOUT.md)与[07](I0_UI_07_BROWSER_HANDOFF.md) | 收尾 §4/5；07 逐能力交接/层次区分/未完成项 | H 按能力回交、准备结果与真实接线分开 |
| [B/P2-F](B_P2_MODEL_SEMANTIC_VERIFICATION.md)与[G2](G2_OVERALL_COORDINATION.md) | B §15.5/16/17/17.1/18/19；G2 §22 最新合并事实 | 语言/内部标识修复、历史真实与最新离线分开；不重复执行供应商批次 |
| [#30 正文及现有评论](https://github.com/paher-din/XunJie/issues/30) | 完整正文、UI 交付/协作说明、A 的 H 材料及最新实现回交 | 父卡 Open；没有代勾 H，A Draft 交付与真实节点/UI未验分列 |
| Robert补交的原HTML工作清单 | 全部业务正文与嵌入源稿，30个编号和逐项条件 | 本批01～08映射无缺项，09保持真实验收前置；完整来源快照与条件已保存至[仓库清单](I0_REMAINING_WORK_CHECKLIST.md) |

## 3. 固定基线与现状

| 对象 | 2026-10-13 核查结果 | 对本批的影响 |
| --- | --- | --- |
| Git | 开始在 i0/ui-frontend，HEAD=8fdea7e；无已跟踪差异，仅既有未跟踪 .zcodeignore。远端 main=cde69ccbd763c3c0ab381a809b750b951f195f64，UI 分支是其祖先 | 正常 fetch 后在原分支 --ff-only 到该 main；未新建分支、覆盖改动或提交无关文件 |
| 连接 | 全局 Git proxy=127.0.0.1:7890 未监听；命令级清空代理后 ls-remote 成功 | 仓库本地 http.proxy/https.proxy 覆盖为空；普通 fetch 成功，全局配置保留 |
| B | [PR #46](https://github.com/paher-din/XunJie/pull/46) 实时回读 MERGED，merge=344caec21a98f85fab0a50af6e9c90a65e7156c2；[#45](https://github.com/paher-din/XunJie/issues/45) CLOSED | 旧任务顶部的待审/未调用不是当前结论；真实浏览器/新调用仍未授权或未验 |
| A 正常宿主 | [PR #53](https://github.com/paher-din/XunJie/pull/53) 实时回读 OPEN/Draft，head=e3e3486d7ec636836c892433c953eb303a64eb6a，未合入当前 main | A 已交代码/合成验证材料；bootstrap 是该 PR 的交付，不写成当前 main 可调用 |
| UI real | [TaskRoute](../../apps/student/src/pages/TaskRoute.tsx) 的 C 入口受 PREP_BUILD 限制；[init](../../apps/student/src/workspace/init.ts) 的 real 初始化停在 discovery | 真实入口/身份/分配接线属于 I0-A 所需批次，不在辅导票顺带代做 |
| UI 教学演示 | [WorkspacePage](../../apps/student/src/pages/WorkspacePage.tsx) 用 TurnPlayer 剧本、自动队列/续发/覆盖重试；[useAgentTurn](../../apps/student/src/components/chat/useAgentTurn.ts) 走 mockAdapter | 复用其实际容器，不能把该状态机直接作为 B2 辅导协议 |
| 消息渲染 | [AgentMessage](../../apps/student/src/components/chat/AgentMessage.tsx) 有正文/动作槽但默认标模拟；[Markdown](../../apps/student/src/components/chat/Markdown.tsx) 采用 React 词法渲染，不注入原始 HTML | 按来源设置准确标识，复用安全呈现；不显示内部思维链或自由执行卡 |
| 存储 | [draftDb](../../apps/student/src/workspace/draftDb.ts) 已有 v2/outbox/metadata；[frozenCommand](../../apps/student/src/workspace/frozenCommand.ts) 与[confirmationDb](../../apps/student/src/workspace/confirmationDb.ts)有原命令与隔离边界 | 拟复用现有 store/原键机制；新增兼容记录形状不能丢弃旧作品命令 |

## 4. 当前公开 HTTP 能力映射

以下是当前 main 已读源码中的实际形状；不把后台内部函数当公共路由。

| 用户操作 | 已有公共来源/输入 | 不能擅自补充的内容 |
| --- | --- | --- |
| 显式求助 | POST /api/attempts/:id/help；question、expectedAttemptRevision、recoveryGeneration、可选 ObjectRef；返回 data.result 中 jobId/attemptRevision/decisionEpoch/replacedJobIds/acceptedInputHash | 不发送 C3 内部 acceptStudentQuestion 的 versions/inputRefs/deadlineSeconds |
| 状态读取 | GET /api/jobs/:id；公开 kind/purpose/scope/status/stopRequested/expectedRevision/decisionEpoch/generation/acceptedAt/deadline/attemptCount 等 | 没有正文、Action ID、ObjectRef、leaseToken 或可展示结果引用；Job succeeded 不算 displayed |
| 事件补取 | GET /api/attempts/:id/events；afterServerSeq、limit≤100、clientId、recoveryGeneration、decisionEpoch；data.control/resyncRequired/events/nextServerSeq/hasMore/coverage | 已实现 JSON 游标分页；没有 token 流、SSE 客户端协议、队列位置或完整历史对象列表 |
| 教学 payload | actionId/contentHash/disposition/createdAt/basisRevised，以及可选 actionType/content/rationale/expectedStudentAction/assistanceContext/evidenceIds/resourceRefs/unresolved/deliveryId | 不含 jobId/messageId/ObjectRef/basis/targetVersions；不能猜正文属于最近一个 Job |
| 三类回执 | POST /api/actions/:id/receipts；recoveryGeneration、clientId、contentHash、receiptKind、clientReceiptId；deliveryId/clientDeclaredAt/versions 可选；data 直接为回执结果 | 不按 sync 的 data.result 包装解析；versions 未获准来源时不制造模型/策略版本 |
| 停止帮助 | POST /api/jobs/:id/cancel；原 generation、可选 reason；教学分支保存停止及未展示 Action 失效，成功生成 Job 也可停止未展示内容 | 不能直接复用运行取消的结果判定或把 HTTP 接受当远端执行停止完成 |
| 控制/返回位置 | POST /api/attempts/:id/controls；原 expectedAttemptRevision/generation + pause/resume/capture/reminders/position 等既有联合形状 | 不新增动作、不猜 revision，不因查看页面或例子自动 start/写 position |
| 作品/运行 | 原 GET Attempt/快照/Run 与公开 diagnostics/files；固定活动给 helpPolicy | 不从当前控件填历史运行输入；限定检查实时状态不能从静态 helpPolicy 猜 |

源码依据：[B2 请求类型](../../apps/teaching/contracts/tutoring/index.ts)、[B2 路由](../../apps/teaching/server/tutoring/application.ts)、[C3 类型](../../apps/teaching/contracts/records/index.ts)、[C3 路由及输入](../../apps/teaching/server/records/application.ts)、[Workspace 路由](../../apps/teaching/server/workspace/application.ts)、[公开 Job 投影](../../apps/teaching/server/workspace/commands.ts)、[控制规则](../../apps/teaching/server/workspace/controls.ts)。事件 contentHash 是正文 content 原 UTF-8 SHA-256，不是 resultHash，按[C3 持久内容校验](../../apps/teaching/server/records/teaching.ts)核对。

## 5. 差异交接与落实状态

| 编号 | 依据与实际差异 | 阻塞的完成条件 | 最小建议与责任 |
| --- | --- | --- | --- |
| D-01 | TECH §4.1/6.1/7.3 要求前端再次核对象/版本；现有事件 payload 缺 Job/ObjectRef/basis/targetVersions，公开 Job 也不提供 Action 对应关系 | 代码/运行回答准确归属、版本当前性和针对某 Job 的 Action 关联；03/04 完整验收 | A 汇总 B/C 给出已有获准可读来源或评审最小公开投影；UI 不猜关联，不新增 wire 字段。01 先验证不绑定代码/运行位置的准备消息与三类回执 |
| D-02 | M-05/M-09、TECH §7.3 保留实际历史；现有学生事件过滤另一 clientId 的 Delivery，且失效 Action 不再附正文；readTeachingRecords 仅为内部调用接缝 | 换页面/客户端及已失效历史内容的服务端回取，真实跨设备恢复 | C 提供获准历史读取能力及成功/裁剪/缺项样例，A 核授权。原客户端已回取内容可本机保留；不能称它覆盖跨设备历史 |
| D-03 | M-04/AC-15 需要显示限定检查；Workspace readTutorContext 有 limitedCheck/helpAllowed 但仅内部接缝，固定活动 helpPolicy 不等于实时检查状态 | 限定检查实时 UI 提示/禁用与真实06验收 | 先核公开 checks 是否足以表达受限状态；不足由 A/B/C 交可信投影。服务端拒绝仍处理，不将前端隐藏按钮算授权边界 |
| D-04 | #30 最新 A 回交已有正常宿主/原消费者/新增 bootstrap 的 Draft #53，但未合入；当前前端 real 仍无合法入口 | 每票真实服务浏览器部分；代码/运行真实求助还需 I0-A 及对应节点样例 | 按能力消费 A/C 交付；未合入固定候选须由 A 协调组合验证，不在 UI 分支自动合并他人 PR。消息回执准备不等节点或新供应商调用 |
| D-05 | 现有C准备页未接工作区对话面板；CodeEditorHandle只给focus/saveViewState，没有公开选区/定位；三控制、显式确认与返回操作也未全部交付 | 实际操作落点、精确选区与返回交互，仍待实现验证 | 最小方案已在Robert委托核查范围内定稿：仅提取复用既有对话容器，当前编辑器增加最小只读选择/定位适配，在既有任务/消息槽接必要操作。不另造页面；实施与来源同步记录仍由相应票维护 |
| D-06 | 原 I0-A 已记 sync 推进 attemptRevision 与 TECH §4.3 的差异 | help/control 发起前权威版本来源 | UI 继续原 GET Attempt 重读，不计算 revision；差异待 C/授权维护者汇总，不在本批改基线 |

这些差异分别记录规划决定与实际交接，D-05已定最小前端方案，其余公共能力/环境及基线差异仍待对应角色落实，没有批准新共享契约。只阻塞对应行为；可独立完成的准备读取、收到/展示回执、控制、引用构造与失败展示继续纳入票内计划。未满足整张票AC时不把票标完成。

## 6. 六张本地 tickets

每票覆盖窄用户路径、同一客户端/准备 authority、实际 UI、必要反例和本票记录。编号 I0-B-01～06 是本批任务，不重命名 UI-TUTOR 清单或团队任务。

| 顺序/任务 | 对应清单 | 真正 ticket 阻塞边 | 独立交付 |
| --- | --- | --- | --- |
| [01 消息、游标补取与三类回执](I0-B-01_MESSAGES_RECEIPTS.md) | UI-TUTOR-04/05 | 无前置票；规划已定稿，完整历史仍受D-02约束 | 获准完整正文→收到→可见展示→明确确认；去重/重连/丢ACK，历史缺项保持不可回取 |
| [02 显式项目求助、停止与替换](I0-B-02_HELP_STOP_REPLACE.md) | UI-TUTOR-01/06 | 01 的消息/回执接缝 | 问题→原 help/Job→回答→本地挡迟到/远端停止；替换新命令，不自动队列 |
| [03 代码与选区求助](I0-B-03_CODE_SELECTION_HELP.md) | UI-TUTOR-02 | 02；完整链需D-01，D-05入口本票实现 | 已确认快照/精确选区→核对象→求助→继续编辑后的来源/过时呈现 |
| [04 原运行与诊断求助](I0-B-04_RUN_RESULT_HELP.md) | UI-TUTOR-03 | 02；D-01。不依赖03 | 原 run/snapshot/公开诊断→求助→原结果来源；缺参数/故障不补造、不重跑 |
| [05 获准例子与返回作品](I0-B-05_EXAMPLE_RETURN.md) | UI-TUTOR-07 | 01的正文/消息交互；D-05返回入口本票实现 | 只读相邻例子→保留草稿/原实例与视图→学生返回；独立使用获准合成材料，不等代码求助 |
| [06 政策与三个独立控制](I0-B-06_POLICY_CONTROLS.md) | UI-TUTOR-08 | 无前置票；完整限定检查UI仍需D-03，D-05控件本票实现 | 查看政策→独立设控制→权威重读→保存/功能数据/空窗/提醒边界 |

后续可从01和06不受未决差异影响的部分推进。02接01；03/04是独立对象切片；05不必等02/03/04。01/06无前置票不等于所有外部条件齐备，票内完整AC仍保留；共享C页面、fixture、outbox写入串行协调，不把依赖图当可多人同时改同一文件的许可。

UI-TUTOR-09 不建立实施票：两类真实求助→学生本人自主修订→新快照重跑需 I0-A、对应 B/C 批次、新调用许可及人工语义条件。真实供应商和真人学生不能以准备脚本替代。

## 7. 本次写集与拟实施写集

本次仅新增本文、SPEC、六票及[I0完整30项清单](I0_REMAINING_WORK_CHECKLIST.md)，共九份任务文档。README/AGENTS/product/planning/reference/他人任务及应用代码只读。既有未跟踪.zcodeignore保留；.git/config的仓库代理覆盖是前次连接修复，不是应用或CI变更。

以下为本次规划定稿的前端实施写集；新文件名是定位建议，最终票内记录实际文件，不能据此扩展到整个目录。后续实现须继续遵守每票交接前置，不扩展受保护对象权限。

| 票 | 拟新增模块/测试 | 允许适配的既有文件/边界 |
| --- | --- | --- |
| 01 | workspace/tutoringContracts、tutoringEvents、tutoringWorkspace；e2e/tutoringMessages；同名必要规则测试 | workspace/http/context/confirmationDb；components/chat/AgentMessage；从现有 WorkspacePage 提取其对话容器，PrepWorkspacePage 接入；现有 prep/plugin/workspace 只增合成事件/回执场景 |
| 02 | workspace/tutoringCommand、useTutoringWorkspace；e2e/tutoringHelpStop | workspace/frozenCommand/confirmationDb；01 对话与页面接线；同一 prep authority 的项目求助/Job/cancel |
| 03 | workspace/tutoringObject；e2e/tutoringCode | CodeEditorHost/CodeWorkspace/useProjectWorkspace 的只读选择与定位 props；originalText 既有映射优先复用；02 求助接线和同一 fixture |
| 04 | workspace/tutoringRun；e2e/tutoringRun | 既有 RunPanel/RunHistoryPanel 只增原运行求助动作；runResults/runHistory 只读投影复用；02接线和同一fixture |
| 05 | workspace/tutoringReturn；e2e/tutoringReturn | 既有消息、只读正文/概念槽、中心工具/文件实例视图与返回位置；精确返回与03可能共用的编辑器只读适配须协调 |
| 06 | workspace/tutoringControls；e2e/tutoringControls | 既有任务信息/工作区消息槽内政策和三个控制；confirmationWorkspace 的权威重读/保存边界、现有控制 wire 与同一fixture |

上表模块均位于 `apps/student/src/`，浏览器文件位于 `apps/student/e2e/`；文档只维护本票与本批索引。只有实际必要且批准的文件可写，不把“允许适配”当全文件重构。UI 操作范围仅 D-05 的最小接线。禁止写 apps/teaching、package/lock、Vite/CI 配置、DB_VERSION/store/index 或 protected 文档；发现必要变动先记录请求，不顺带处理。

元数据拟在现有 metadata 以明确 tutor 命名空间保存原客户端游标/已回取内容身份/回执事实，在原 outbox 扩展 help/receipt/control 类型和停止对象的兼容可选事实；不改既有键或回放语义。每票验证旧 kind 的过滤与读取不误消费新命令，本机事实始终按模式/账号/课程/Attempt/受信代际和 clientId 分隔。

## 8. 验收层次与执行记录

每票同时记录准备实现、准备浏览器、真实 HTTP、实际供应商、真人语义/接棒六层。真实服务只验已获准合成材料/受控身份；已有历史模型正文的渲染不算新模型生成。回执展示事实只说明本系统报告的可见展示，不说明阅读或能力。

2026-10-13，修改前从仓库根运行 `node tools/a0-review/check.mjs`，Node v24.15.0，63 文档/910 内链，errors=[]，退出码0。该静态工具没有应用精确 Node 24.21.0 门禁，不把它作为教学服务运行验证。

首稿修改后从仓库根再次运行同一静态工具：71 文档/977 内链，errors=[]，退出码0。八个新文件的空白、标题、六票模板、无误勾验收和无本机路径检查通过；逐项人工核对UI-TUTOR-01～08覆盖与依赖，六票依赖无环，D-01/D-02/D-03不被写成已交付。`git diff --check`退出码0，无已跟踪文件改动或已暂存文件。普通`git ls-remote`再次成功，远端main仍为上述固定基线；当时本地UI分支比旧远端UI分支领先68个来自main的提交，没有本批新提交。应用typecheck/test/build、Playwright、服务启动/建库、节点、供应商和真人验证均未执行；文档任务不重复跑108项旧浏览器检查或238项旧单测。

以上首稿检查结果保留原时点。当前拆分、测试接缝与最小UI写集已依负责人委托复核定稿，清单已补入仓库；未完成项为D-01/02/03/04的实际交接、D-05的实现、D-06的基线差异汇总，以及六票应用实现/验证。产品基线及MVP_SPEC§10仍为“待授权维护者汇总”。本次本地提交范围是§7九份文档；不推送、合并或发布。

### 8.1 后续实施检查入口

下列为待实施后的检查入口，本次未运行。在 `apps/student` 使用已批准的 Node 24 与原 lock 环境，实际版本记入对应票；不开真实模型开关、不新装依赖。浏览器命令以01拟新增spec为例，实施后换成对应新spec与受影响旧spec，不把示例文件当作已经存在。

```powershell
rtk npm run typecheck
rtk npm test -- tutoring
rtk npm run build
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
rtk npm run test:e2e -- tutoringMessages.spec.ts
```

### 8.2 2026-10-13 委托复核与定稿

Robert在可审阅规格和六票齐备后授权规划Agent判断检查、没有问题就定稿并提交，同时要求完整30项清单入仓库。本次直接读取新附件业务正文/源稿，逐项核对UI-TUTOR-01～08、进入条件和UI-TUTOR-09边界；来源SHA-256及完整30项保存在仓库清单，不再依赖Mac绝对路径。

复核结论：保持六票。01把消息、补取与三类回执组成一个可观察闭环；02基于它完成显式求助/停止/替换；03和04只依赖共同求助链，各有不同对象来源，不互相串联；05复用消息槽和既有编辑器视图，可独立核只读返回；06的控制/保存链不需要求助控件，主动求助许可由02用有来源的预置状态验证，两票交付后再补最小开关→求助组合。没有必要另拆纯API/状态/测试横向票，也不把整张I0-A或新供应商调用作为准备前置。

测试边界保持现有工作区→同一HTTP客户端→同一开发authority，以真实浏览器可见行为/请求/IndexedDB作为主证据。03/04完整对象当前性与06限定检查提示必须等待真实公开来源，01完整跨客户端/失效历史回取仍按D-02交接；缺项失败表达不是完整验收通过。

复核补清两项实施条件：教学clientId在原标签刷新时保持，游标按该通道保存，新通道不可携旧游标跳过自身Delivery；取消已成功教学Job时保留succeeded终态，依据持久stopRequested/invalidatedActionIds挡未展示内容，不一直等待cancelled。已显示事实不被删除。这两项分别补入SPEC与01/02验收。

最小UI接线按D-05/§7定稿，只提取复用现有对话容器、增加当前编辑器只读选择/定位适配及既有任务/消息槽的必要操作；导航、布局、框架、服务端契约、依赖和数据库schema不扩展。清单中的其他UI-PREP/UI-REAL/数字逻辑任务没有由本次定稿启动。

最终文档/编号/依赖/暂存范围检查完成后，将九份文档作为一条本地commit提交到i0/ui-frontend；实际commit由Git结果核对。本记录包含该提交的定稿依据，不写未来提交SHA，不宣称推送或应用验证。

最终检查实际结果：Node v24.15.0下，`node tools/a0-review/check.mjs`检查72份文档/1000条内链，errors=[]、退出码0；九份新文档空白/标题/无本机路径、六票模板/无误勾验收和完整30个唯一清单编号核对通过。六票依赖人工核查无环，未丢原清单进入条件。没有源码/依赖/受保护文档改动、供应商请求或应用测试；九份文档以外文件不纳入本地提交，既有.zcodeignore保留。

## 9. 2026-10-13 准备实现整合与实际交付

本节为Robert随后授权实施后的较新事实，§1～8保留规划交付历史。六票均已接入同一C准备工作区，状态为`prepared-verified`及各自真实/契约未完成边界；没有把未交D-01/02/03/04改成已解决，也没有勾选整票正式AC/NFR。

### 9.1 并行写集与整合

| 支线 | 独立提交 | `i0/ui-frontend`整合提交 | 实际责任 |
| --- | --- | --- | --- |
| `codex/i0-b-04-run` | `fedd0c3` | `5ee90ba` | [原运行引用](../../apps/student/src/workspace/tutoringRun.ts)、原结果/历史面板动作和3项浏览器检查 |
| `codex/i0-b-06-controls` | `43ee0c2` | `da443af` | [政策/控制](../../apps/student/src/workspace/tutoringControls.ts)、独立journal/租约、组件与同authority handler |
| `codex/i0-b-03-code` | `67507a2` | `76547ee` | [代码引用](../../apps/student/src/workspace/tutoringObject.ts)、精确原文映射及编辑器只读handle |
| `codex/i0-b-05-return` | `4eb02cf` | `8d21154` | [资料/返回规则](../../apps/student/src/workspace/tutoringReturn.ts)、安全只读槽及原实例校验 |

以上工作树从`ee95dcf`建立，复用已安装依赖，不安装或改锁文件。主Agent复查写集并逐提交cherry-pick到原UI分支；独立分支/工作树保留供追溯，子Agent已结束。主负责01/02、共享[页面](../../apps/student/src/pages/PrepWorkspacePage.tsx)、[同一准备插件](../../apps/student/prep/plugin.ts)、原authority接缝与组合浏览器验证，避免多人改这些共享文件。

主新增[教学状态机](../../apps/student/src/workspace/tutoringWorkspace.ts)、[原命令校验](../../apps/student/src/workspace/tutoringCommand.ts)、[事件核验](../../apps/student/src/workspace/tutoringEvents.ts)、[本机journal](../../apps/student/src/workspace/tutoringStore.ts)、[有界等待](../../apps/student/src/workspace/tutoringTransport.ts)和[对话槽](../../apps/student/src/components/workspace/TutoringPane.tsx)。journal写入原v2 metadata的命名空间记录；原保存outbox/旧kind过滤不变，不改DB_VERSION/store/index。CSRF只在原HTTP发送时取得，不落journal。

消息按完整正文hash/Action/Delivery核验、先落received事实和游标，再依据实际DOM/页面/区域可见性报告displayed；“我先试试”才产生acknowledged。收到、展示、回应分开，缓存仅代表原客户端历史。原标签身份通过浏览器原生同源锁独占，刷新延续；复制sessionStorage的标签领取新通道。锁不可用时作为新通道，不用旧游标补出历史。

问题与原help/cancel命令持久化后发送，回执核原scope/target/command/key/generation/摘要及acceptedInputHash。求助不自动保存、运行或排队。停止有同步展示屏障和本机停止代次，较早help的迟到ACK不能解除后来的停止；仅明确的新求助能重开。8秒本机连接等待超限保留未知/原键，不改写服务端45秒截止或Job终态。已succeeded仍可停止未展示内容，已发生展示保留。

代码入口只从明确选择的已核验快照/原实例构造ObjectRef；dirty/无快照/无选区拒绝且零写入，发送前再核当前原文。原运行入口核公开Job/Run/snapshot，缺本机参数不补控件、不重跑。D-01缺关联时正文保持本尝试来源，不猜回答归属或自动定位。相邻资料仅从当前活动公开投影取正文；合成温度阈值样例明确非真实教师审批，不含TextScope答案，原编辑器挂载、草稿与undo保留。

政策和三个控制在现有任务信息槽；回复/对象操作在原工作区对话与正文槽。组合布局回归发现顶栏挤压后，将新增辅导操作移到正文槽，保留原工具导航、状态徽标、运行/确认簇和布局判据。三个开关独立，控制权威重读；采集区间来自同一事件页coverage，缺项明确。后台采集/实际提醒/教师暂停的服务端证明仍由原C/A能力验收，UI准备handler不代替它们。

### 9.2 验证、失败修复与证据分层

实际环境：Node v24.15.0、TypeScript 5.9.3、Vitest 3.2.7、Vite 7.3.6、Playwright 1.64.0、Google Chrome 155.0.8059.40。仅证明学生工程检查，不作为教学服务精确Node版本的运行验收。

在学生目录执行：

```powershell
rtk npm run typecheck
rtk npm test
rtk npm run build
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
$env:XUNJIE_E2E_PREP_PORT = '5621'
$env:XUNJIE_E2E_REAL_PORT = '5622'
rtk npm run test:e2e -- tutoring prep.spec.ts editor.spec.ts confirmation.spec.ts runResults.spec.ts real-mode.spec.ts --workers=2
```

全量单测29文件/320项通过，零失败；typecheck与正式build退出0。组合浏览器最终75/75通过、零失败/跳过，约2.7分钟：原52项覆盖编辑/确认/C运行/准备隔离及原数字逻辑演示，新增23项覆盖本批六票。最后通道完善另跑82项辅导规则和7项消息浏览器检查，新增复制标签一项；受控可见性反例另通过。不同浏览器检查合计77项（重复运行不重复计数），其中可见性注入与教师暂停/拒绝/网络故障注入均按隔离反例记录，不当作后台或真人事实。

纯内存复核发现4个确定交错：停止跨旧页落盘、实际displayed排队后停止、已知新暂停跨旧页，以及替换help迟到ACK跨后续停止。主已按独立屏障、即时观察事实、最新控制/读轮次和停止代次修复；3项交错单测通过，实际Chrome补received迟到/暂停旧页/迟到help停止反例通过。此处区分模型复核、替身交错与真实浏览器HTTP/DOM事实。

中间失败如实保留：早期准备命令缺replayed标识，收紧回执校验后拒绝，已按公开响应补齐；素材空行不符合旧fixture段落断言，修正新合成材料而保留原规则；新按钮导致顶栏标签/徽标重叠，已修原布局而未降低断言；旧材料数量断言随新增合成材料同步为5条，原裁剪/泄露检查保留。中间未完成组合和受影响检查不计通过，最终上述独立组合完成后才记75项。

原生后台标签补验在本自动化Chrome中（含headed尝试）仍返回visibilityState=visible，未产生所需hidden条件；该实测尝试失败，不能标原生后台展示验收通过。另用明确的visibilityState/visibilitychange注入，在实际DOM、IntersectionObserver、同一HTTP正文和原回执请求上验证隐藏时零displayed、恢复后displayed。原生后台条件仍待可产生该状态的环境补验，不以注入结果替代。收起面板、滚动进入区域、明确回应和刷新/复制通道是实际UI操作证据。

构建保留既有大chunk提示；开发浏览器保留既有品牌public资源导入提示，不关闭检查或改Vite/依赖。RTK不能干净代理带管道符的正则筛选时，回退原npm运行，未把工具解析失败当应用检查通过。

### 9.3 尚未完成与继续入口

六票的准备实现/对应检查已交，不宣称真实host/browser服务链、实际模型、真人语义/自主接棒、整体AC/NFR或教学效果通过。完整任务仍需A汇总D-01公开Action到原Job/ObjectRef/版本的获准来源；C/A交D-02授权历史回取；A/B/C交D-03实时限定检查状态；I0-A及正常宿主/身份/TLS接线落实D-04。D-06继续权威重读，基线差异“待授权维护者汇总”。05真实资料仅为公开课程材料时不自动称教师批准例子；UI-TUTOR-09保持范围外。

继续开发在`i0/ui-frontend`；不得自动合并他人Draft PR、代实现共享后台契约或复用历史供应商许可。下一批收到对应能力后，在本票追加实际接线与反例，按原条件补真实验收。当前仅本地提交，未推送/合并PR/部署；原未跟踪`.zcodeignore`保留且不提交。本批不改受保护文档、AGENTS、apps/teaching、package/lock、凭据、CI或数据库schema。

文档检查在仓库根运行，静态工具可用当前 Node v24.15.0；这是本次已有实际结果的入口。空白检查同时覆盖新未跟踪文档，Git 检查不单独替代它。

```powershell
node tools/a0-review/check.mjs
git diff --check
rtk git status --short --branch
```

RTK 丢失必要诊断时改用原命令。应用检查不得采用默认 `npm test` 外的真实模型/故障探针历史入口；全部新业务检查均保持供应商请求为0。最终组合检查范围由实际改动和遗留疑点决定，未改变的服务端全量不重跑。

最终文档检查：仓库根 node tools/a0-review/check.mjs 为72份文档/1052条内链、errors=[]，差异空白检查通过。已清理本次临时命令日志；保留可复用源码、任务记录与原分支/工作树。
