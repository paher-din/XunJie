# I0-B：辅导链前端批次计划与 ticket 索引

日期：2026-10-13；更新：2026-10-14（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。当前实现已补齐六票及获准公共投影、历史、正常宿主和真实入口；准备/实际HTTPS合成服务、受控节点/模型/真人检查分列，最终检查结果见§11。入口：[I0-B SPEC](I0-B_UI_TUTOR_SPEC.md)、[完整30项清单](I0_REMAINING_WORK_CHECKLIST.md)。本文件记录范围、来源、写集与执行事实；不代替产品基线、A/B/C任务或成员交接。

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

以下保留2026-10-13规划时点 main 已读形状；D-01/02/03的后续核查、纠正、授权及实现见§10–11，不把该历史表当当前未完成状态。

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

此表为原规划差异：D-02“仅内部接缝”判断已由§10.2纠正；D-01/03和D-04代码组合已获§10.3较新授权并实施，最终结果见§11。受控运行环境、真人与基线汇总仍分开记录；未满足完整AC不标整体验收通过。

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

## 10. 2026-10-13 继续核查真实验收缺口

Robert针对上次交付中的未完成项询问“为什么不完成？”。主Agent继续原六票，不将准备检查等同真实验收，也不将旧计划中的“待交接”作为停止调查的理由。本次原生后台标签补验与D-01/02/03公开能力审计可独立进行；正常宿主/入口组合由主Agent核查。只读审计不代发成员消息；实际追加实现仍在原UI写集内，不扩大共享字段、受保护文档、后台/数据库或凭据权限。

本轮开工：`i0/ui-frontend@cbb5824270c7216714b7cd1f0ec7c4deb8e15c8f`，跟踪文件无差异，仅原有未跟踪`.zcodeignore`。正常fetch后`origin/main=cde69ccbd763c3c0ab381a809b750b951f195f64`；[PR #53](https://github.com/paher-din/XunJie/pull/53)仍OPEN/Draft，head=`c071b4d0874c8cb1e8b83c95108fda2519a30cf0`。按仓库入口、当前AGENTS、PRD §4.2/5/8、MVP_SPEC M-04/M-05与TECH §7.3/7.5正文重新核对相关要求；C在#30回交的当前HDL/节点证据不等于已提供正常HTTPS或本批辅导入口。

### 10.1 D-04宿主的具体缺口

已只读核查[固定A任务§12](https://github.com/paher-din/XunJie/blob/c071b4d0874c8cb1e8b83c95108fda2519a30cf0/docs/tasks/I0_A_C_HANDOFF.md#12-本批实现与运行交接)及其源码。候选`createI0App`组合的是原`createWorkspaceApp`，精确要求原24表；其消费者仅调用原C `pendingJobs/processJob`。候选没有组合本仓库已交的`createTutoringApp`、C3事件/回执路由或B2教学worker，任务也明确不装配模型队列。因而不能把“合入PR #53”写成“六票辅导真实宿主已就绪”。B2沿`createTeachingRecordsApp`/`createTutoringApp`运行，原`createTeachingDatabase`比作品工厂多四个已有教学表；共享正常宿主的组合需要对应批准与A/B/C协作，不由UI暗中更换库。

当前前端实际限制是[TaskRoute](../../apps/student/src/pages/TaskRoute.tsx)仅在准备构建进入C页面、[init](../../apps/student/src/workspace/init.ts)真实读取到Session后停在discovery。A已交的合法分配深链和bootstrap可以作为后续接线依据，不需要先新增分配列表；但其bootstrap当前只存在于上述Draft候选。新接口、正常入口和受控运行环境三项分别核对，不以fixture或客户端随机代际替代。

后续组合方案（提案，未批准/未实现）：A从固定候选组合原B2/C3服务和原worker；原教学工厂仅用于独立合成新库，不迁移或重置旧库，不新增schema。UI在原任务深链读取合法Assignment bootstrap，复用原Session/CSRF/确认/作品/运行/辅导客户端，不新建替代界面、不自动创建Attempt。环境维护者交现有HTTPS Origin、配置文件引用、合成账号安全入口和当前C代际来源；不在文档/代码记录密码或签名内容，不复用已用历史模型许可。现有后端服务本机没有`apps/teaching/node_modules`，当前Node v24.15.0也不符合教学服务固定24.21.0；这些是本机运行准备事实，不能绕过版本/lock门禁。

本节为真实原因与可审查组合方案；不自动合并他人Draft、启动受控宿主、安装服务依赖、初始化数据库、写配置/凭据或调用供应商。没有把该提案登记为正式架构决定，产品基线及MVP_SPEC §10仍为“待授权维护者汇总”。

若负责人批准补入真实入口，UI拟写集限定为`TaskRoute.tsx`、现有`PrepWorkspacePage.tsx`、`TextScopePanes.tsx`、`workspace/init.ts`、`useWorkspaceInit.ts`、`contracts.ts`及对应初始化/真实入口检查：保留原任务路由与数字逻辑演示，把获准深链引用交给原初始化，准备场景标识按实际模式显示；不写静态正式ID或合成身份。先验证匿名/跨学生/暂停/无代际/迟到初始化拒绝，再验证学生显式创建与原保存/求助。正常host未实际可用时仍报告不可用，不能用路由拦截成功标真实服务通过。首次创建与已有Attempt恢复分开；bootstrap不含Attempt引用，不据此承诺跨设备恢复，已有Attempt必须沿获准交接/原可信引用读取，缺项单列。

### 10.2 公开能力审计纠正与继续写集

D-02规划判断有误：`GET /api/attempts/:id/teaching-records`已在[原作品路由](../../apps/teaching/server/workspace/application.ts)注册，[C3组合](../../apps/teaching/server/records/application.ts)保留它。学生投影返回本人问题及存在`displayed`或`acknowledged`回执的Action/模型正文，不按clientId过滤，不因Action后来失效删除已展示历史。此前“readTeachingRecords仅内部接缝”的说法不能继续作为阻塞依据；§5/§9中的旧判断以本节源码核查为准。

现有六票授权足以补接此已有公共读取。01拟新增`workspace/tutoringHistory.ts`及必要测试，适配原`tutoringContracts/tutoringStore/tutoringWorkspace/TutoringPane`与同一`prep/tutoring/plugin`合成反例；只消费公开字段、不新增共享字段/读路由。历史按原Action→messageId/jobId→Message/basis ObjectRef关联，作为历史单独呈现，不能放行当前投递、生成新Delivery或用另一通道旧deliveryId补报回执。仅received、未展示/未明确回应的内容仍不允许跨通道回取。当前响应没有control/generation/cutoff信封，历史不当作当前建议；重新授权失败时清除本轮可见历史，缓存不冒充许可。主Agent负责整合验证与本票记录，独立工作树负责该窄读取实现。

D-03审计确认`checks`只有jobId/runId/policyVersion/state，而服务端限制条件是`activity.checkRule.limitedHelp && checks.some(state==='active')`；公开Activity没有limitedHelp。不能把所有active检查当受限检查。最小提案为在现有GET Attempt中同事务增加`limitedCheck:boolean`，仍由现有固定helpPolicy、阶段与分配守卫独立判断许可。字段待负责人批准；至少验证受限/非受限active、执行失联保持限制、权威ended后解除，以及直接HTTP绕过按钮仍拒绝。

原生后台补验采用实际Chrome同一原生窗口和标签切换，通过`chromium.launchServer`/`connectOverCDP(...,{noDefaults:true})`避免Playwright默认焦点模拟；不覆盖visibilityState或注入visibilitychange。主Agent将在原消息spec追加一个独立窄检查，保留先前受控反例与失败历史，不修改Playwright全局配置/依赖。探针已观察可信hidden→visible事件与原始HTTP回执，正式测试结果随后记录。

### 10.3 需要负责人确认的最小跨模块方案

以下为可审查提案，尚未批准。已有历史读取与原生后台检查无需扩大授权，继续实施；首次展示前关联与限定检查字段不绕过当前AGENTS“共享字段、状态、错误码、版本、权限和事务语义先提案并确认”的要求。

| 对象/拟写集 | 具体变更 | 保持的边界与验收 |
| --- | --- | --- |
| D-01：`apps/teaching/contracts/records/index.ts`、`server/records/application.ts`与相关C3投影反例 | 仅在已有事件正文可投递分支，附原持久Action的`scope/jobId/messageId/generation/targetVersions`和`basis`中的`attemptRevision/decisionEpoch/captureRevision/relatedStateRevision/objectRef`。不新增读路由，不猜关联 | 当前Session/成员/本人Attempt/Delivery/代际/epoch/对象/停止守卫不放宽；不暴露lease、模型原JSON或私有材料。两个求助正文相同仍按原Job/Action分开，编辑/同名重建/换Run/停止/纠正/换代际均不误绑或复活。不能先伪报displayed解锁关联 |
| D-03：`apps/teaching/server/workspace/application.ts`、对应公开类型及工作区/辅导反例 | 在已有GET Attempt中，同授权事务根据原固定checkRule和持久checks返回`limitedCheck:boolean`；不把固定政策或active检查单独当答案 | false不表示所有帮助都许可；阶段/分配暂停/固定helpPolicy继续独立核对。受限和非受限active、失联/取消未确认、确实ended与直接HTTP拒绝分开验 |
| D-04：固定PR #53候选的`server/app/i0.ts`及其配置/初始化/专项，原`server/tutoring/application.ts`和`server/records/application.ts`必要组合接缝与专项 | 从原B2/C3工厂组合正常业务路由、原教学worker与原C运行消费者，共用既有Session/授权/事务；只使用已有精确依赖和原教学28表工厂进行独立合成验证 | 不新增schema/迁移/重置旧库，不自动合并他人Draft或main，不改受保护文档/凭据/CI，不自动调用供应商。消费者沿原Job/停止意图/代际，不用学生会话伪造worker身份；需要核清受信worker入口后才实施 |
| UI：§10.1真实入口写集，以及已有01/03/04/06辅导模块及必要反例 | 消费已获准投影，保留原作品/消息容器，准确区分历史与当前候选。真实请求仅同源`/api` | 不更换UI/导航/框架；授权前不编造字段。准备、真实HTTP、正常TLS/节点、模型/真人分别计数。环境维护者交原受控配置文件引用，缺环境仍列具体未验，不以合成回放冒充真实服务 |

建议批准上述限定代码范围由当前Agent实施，并由A负责最终共享契约汇总；受保护产品/计划/参考仍只读。若正常宿主必须补新worker授权接口、产生新schema或改变事务/权限规则，先记录新差异再请求该具体决定，不将本提案视为无限后台授权。真实供应商新增请求、配置/密钥/证书写入、旧库变更、节点维护、公开发布仍未列入提案。

2026-10-13，Robert对本节具体方案表示“你自己看吧。如果是真的需要做的你就做”，将必要性判断及上述限定补齐实施委托当前Agent。主Agent核查认为D-01首次展示前对象来源、D-03实时检查限制、D-04原服务/消费者及真实入口组合均为完整辅导链所必需，按本节限定写集继续。此为较新授权，前文提案状态保留原时点；已授权项不重复请求。受保护基线/计划/参考、凭据/CI、旧库/schema变更、真实供应商新增请求及公开部署仍未扩大。

## 11. 授权后实施与验证记录

主负责原生后台专项、正常宿主组合、真实入口和最终整合；D-02历史读取在`codex/i0-b-history`，D-01公共关联在`codex/i0-b-projection`，D-03同事务投影在`codex/i0-b-limited-check`分别实施。独立补充记录随各自commit提交，仍属于原六票，不增加横向tickets。当前实现结果逐项追加，不预写完成。

原生后台正式Chrome专项已通过1/1：`npm run test:e2e -- tutoringMessages.spec.ts -g 原生后台 --workers=1`，准备/普通开发端口5601/5602。沿同一实际DOM、HTTP authority、IndexedDB与原回执，可信隐藏事件后持续超过一个轮询间隔，received确认且displayed=0；实际切回前台后仅一个displayed确认，无acknowledged。测试随结果附可见性/正文身份/去敏回执JSON，不覆盖原生API。早期普通Playwright连接无法产生hidden的失败仍保留§9.2；不再把原生补验列未完成。

教学服务运行检查拟使用本机既有WSL2 Ubuntu与校验官方SHA-256的Node24.21.0，运行时和npm缓存放D盘，只按原lock安装教学应用已有精确依赖；不改package/lock/系统Node。该安装是已批准技术栈的本机运行准备，不当作业务或节点验证。实际命令结果随后补录。

### 11.1 当前代码交付与差异落实

2026-10-14，原UI分支基线`cb652c6`已整合真实入口`6194e63`、D-01投影`cad0126`、D-03投影/控制`96f4b2a`和D-02历史`c50cc5a`/授权失败清理`cb652c6`。独立工作树/分支保留，当前主负责最后页面消费、正常宿主、失败根因与最终验证，不重开六票或迁移整合分支。

| 差异 | 当前交付 | 验证边界 |
| --- | --- | --- |
| D-01 | [公共关联](I0-B-01A_EVENT_PROJECTION.md)来自原持久Action；客户端严格核scope、原Job/Message、代际、固定版本和basis对象，同动作来源冲突拒绝，旧缺关联保持未知 | 原正文/hash/Job不同即使内容相同也分开；代码页显示原快照/版本/选区，本机改稿或同名重建不承接旧位置；原Run/snapshot来源只读 |
| D-02 | [已有授权历史](I0-B-01H_HISTORY_READ.md)GET接线；另client合法只读shown记录，不分配Delivery、不补回执；取消或依据修订仍保留原历史 | received-only正文不跨通道回取；每次重新授权，失败清可见历史/作废旧读，不用缓存冒充许可。send的head失败也沿同一清理边界 |
| D-03 | [同事务limitedCheck](I0-B-06A_LIMITED_CHECK.md)由固定checkRule及持久check状态计算；页面与发送前新GET都守卫，unknown/true不放行 | false只排除这一项限制，固定政策/阶段/分配仍独立；失联/取消未确认不解除，服务端直接HTTP绕过仍拒绝 |
| D-04代码 | [正常宿主](I0-B_HOST_COMPOSITION.md)选择性复用固定A交付，组合原B2/C3/28表/消费者及[真实分配深链](I0-B_REAL_ENTRY.md) | 不Git merge他人Draft、不新建schema/HTTP执行接口/模拟学生Session；受控部署证书/节点/真实模型/真人另列 |
| D-05/06 | 原工作区容器、editor只读选择与返回、任务信息三个控制已交；求助/control继续权威重读revision | 公开引用资料不自动叫教师批准例子；不改保护基线，原sync版本差异“待授权维护者汇总” |

当前源码：[消息状态机](../../apps/student/src/workspace/tutoringWorkspace.ts)、[关联/历史校验](../../apps/student/src/workspace/tutoringHistory.ts)、[消息槽](../../apps/student/src/components/workspace/TutoringPane.tsx)、[原工作区](../../apps/student/src/pages/PrepWorkspacePage.tsx)、[确认客户端](../../apps/student/src/workspace/confirmationWorkspace.ts)、[正常宿主](../../apps/teaching/server/app/i0.ts)、[受信worker](../../apps/teaching/server/tutoring/application.ts)。真实模式仍同源`/api`，载入零业务写入，学生显式创建/保存/冻结/求助。分配列表和跨设备Attempt发现未扩范围。

### 11.2 组合复核发现与修复

记录确定问题及根因，不删历史失败、不迁就断言：

- C运行在途等待阻塞教学消费者，以及内部worker最后完成遗漏组合learner revision守卫，已按宿主记录修复；新增两项宿主专项通过。
- B2 help回执hash包含验证输入的recoveryGeneration，原客户端错误应用workspace的删代际规则，导致实际服务虽接纳并生成正文，本机help仍pending。客户端与准备摘要现按原B2契约核，取消继续原C摘要；固定后端向量3项与实际HTTPS双求助通过。
- 新限定检查控制轮询读到远端已提交作品，会在原sync ACK原子接纳中断时提前install较新确认头，3项旧浏览器断言实际失败（mapping/drafts/outbox的本机revision 1而非0）。确认客户端现同时核当前已绑定pending及其落盘原命令，保持原作品/映射/草稿/outbox基线，仍接纳当前暂停、epoch及limitedCheck；新的授权初始化先合法GET，不拿上一加载的请求阻断读取。原四项断言保持，通过原“重读学习控制”的真实GET与完成后DOM状态核验；原键刷新恢复和迟到读序仍验。
- 求助在队列/head读取或落盘等待中遭明确停止、上下文退役，较旧意图不得发新POST或解除屏障；已捕获操作发起时stopVersion，发送前再次核上下文，独立微任务反例通过。
- 未知help尚无Job时只屏蔽展示不足以落实远端停止。现保留同一停止意图，原键核对取得原Job后先发该Job取消再读投递；未确认时只报未知，不编造已停、不创建替代help。实际dev HTTP反例核同原key、一个原Job取消、零正文/displayed。
- 替换help(B)与旧cancel(A)都丢ACK时，核对B后的当前Job已变；A的合法取消回执须按自身命令原路径确认，不与最新B比较或覆盖B。已按原命令校验，避免旧cancel永久pending阻塞新求助；同一实际authority下保留原A读响应并丢两类ACK的反例另补。

原单测整头fixture和控制浏览器文案断言曾不匹配获准新limitedCheck投影，已按新真实契约补false/unknown判据；没有把所有active检查当受限检查。原生后台早期焦点模拟失败、受控可见性注入和后来实际native hidden检查仍分层保存。

### 11.3 验证入口与证据层次

学生仍用Node24.15.0 / TS5.9.3 / Vitest3.2.7 / Vite7.3.6 / Playwright1.64.0 / Chrome155.0.8059.40；教学使用WSL2 Ubuntu与固定Node24.21.0、原lock/native依赖。新的本机运行时/缓存只放D盘，不入commit；包/lock、配置、凭据与系统Node未改。官方Linux Node包SHA-256 `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` 已核。

学生目录实际命令：

```powershell
rtk npm run typecheck
rtk npm test
rtk npm run build
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
$env:XUNJIE_E2E_PREP_PORT = '5601'
$env:XUNJIE_E2E_REAL_PORT = '5602'
# 指向执行环境中已就绪的 Node 24.21.0；Windows harness使用WSL2 Ubuntu路径。
$env:XUNJIE_E2E_SERVICE_NODE = '<执行环境内的 Node 24.21.0 可执行路径>'
npm run test:e2e -- tutoring prep.spec.ts editor.spec.ts confirmation.spec.ts runResults.spec.ts real-mode.spec.ts --workers=2
```

类型检查与正式build退出0；全量规则33文件/456项通过、零失败。正式dist逐项扫描准备端点、合成账号/固定对象ID和syntheticAccount无命中。新增DEV守卫仅保护合成准备引用，正常产物不含准备authority、材料或凭据。既有大chunk与品牌public资源导入提示保留，没有改依赖/构建配置来掩盖。

教学目录在精确24.21.0环境执行`npm run typecheck`、`npm run build`和默认`npm test`均退出0；默认399项中387通过/12跳过/零失败。宿主原10项与新增6项另为16/16；同次加投影9/limitedCheck6共31/31，后两组已在默认集内不重复累计。节点/VM/容器、真实SDK/模型门禁的skip不计通过。首次默认集有一次startup 5秒超时，原限时/断言未改，main先校验端口再载入HTTP宿主后重建/专项/默认集通过，细节见宿主记录。

Chrome检查过程：前次89项组合85通过/4失败（上述原ACK回滚3项和help digest服务专项1项），失败未记通过。下一轮90项为85通过/5失败：四项新原型观察counter未取得实际客户端、以及新守卫过严导致同身份退出后合法GET未接纳；改用原控制UI实际读取核验，并将守卫限定到当前已绑定的原pending。没有删除原回滚/退出/迟到断言，失败均保留。实际HTTPS双求助扩展专项修digest后独立1/1通过，90项中该项又通过（18.5秒）；正常dist→实际Session/CSRF/SQLite/原worker→原Job/对象/回执/历史，离线合成provider及临时自签名TLS条件明确。native后台1项与可见性注入1项分别记录；协议替身4项不等同实际服务。

收尾只复跑受影响原`confirmation.spec.ts`和`tutoringHelpStop.spec.ts`，新增双未知Job反例后26/26通过、59.6秒，零失败/跳过；其中20项原确认与6项求助/停止。保留前轮未受影响的65项通过证据，最终不同浏览器检查合计91项通过，不把重复运行累加，也不声称一次91项全量运行。原四阶段ACK回滚、同身份退出后新读、两代际/旧页顺序、停止/原键/原Job与新增限定检查均已验。

```powershell
npm run test:e2e -- confirmation.spec.ts tutoringHelpStop.spec.ts --workers=2
```

末次源码收尾后重新typecheck、33文件456项规则及正式build退出0；根文档检查与差异空白结果在提交前核，实际值追加于交付段。

### 11.4 交付与外部验收边界

本批六票的代码、调用方、反例与可复用服务检查已补齐；完整真实教学验收的未执行项是受控部署证书/实际SSH节点与隔离运行、新供应商语义批次、真实教师例子批准、真实学生自主修改/保存/重跑和UI-TUTOR-09，不是继续声称D-01/02/03公共能力缺失。没有使用真实学生数据或教师私有材料，供应商新增请求为0；工程/合成验证不写成教学效果、完整AC/NFR或G阶段通过，不关闭父Issue。

最终本地提交仍在`i0/ui-frontend`，写集包括本记录/六票/清单及必要源码/专项/真实入口说明；原`.zcodeignore`不暂存，不推送、合并或发布。生成探针在正式检查和文档保留证据后清理，独立分支/工作树和原工厂合成库保留；回退需按提交顺序审查，不重置、删除历史或覆盖他人记录。产品基线与MVP_SPEC§10“待授权维护者汇总”。

提交前仓库根`node tools/a0-review/check.mjs`：77份文档/1137条内链、errors=[]；差异空白检查退出0。静态输出的businessTests标签不代替上文实际运行证据。已移除本次临时`.i0-b-visibility-probe.cjs`，正式native专项和结果记录保留；写集不含规范、产品/计划/参考、包/lock、真实凭据/配置、CI、数据库schema或合成库产物。

## 12. 2026-10-14 负责人纠正与前端职责复核

Robert明确本批例子“我们一起设计就行，不需要真正经过教师”；随后询问采集如何实施、是否已能采集，并提醒自己负责前端。当前Agent之前把外部教师确认当本票前置，以及把未接入的后台调度笼统说成只差实际验收，都不准确。新决定仅适用于本批例子与前端任务边界，不写入受保护产品/TEAM文档。

### 当前决定、实际缺口与职责

- 05：沿用仓库已批准的温度阈值29/30/31边界例子，来源校正为Robert与Agent共同设计的合成教学材料；不再等待外部教师，保持学生原作、权限、只读返回和不自动保存/运行。此内容已经有完整浏览器准备证据，不代表真人教学效果。
- 06：已交的是政策/开关/权威结果与覆盖区间UI。`SyncInput`和`freezeSync`目前没有process/captureRevision上报字段，编辑草稿不会自动上传逐次过程；保存、求助、运行等功能记录另存。当前“开关开启”只能说明服务端许可，不能说明采集链在运行。
- 正常I0宿主只扫描`purpose='student_help'`，没有自动被动分析或里程碑提醒调度；A4已有分析队列/完成能力不等于当前28表宿主自动接入。前次“没有已确认代码缺口、剩余主要验收”只可用于已交控制接线，不能覆盖这些系统能力。

| 工作 | UI职责 | 其他模块职责/前置 |
| --- | --- | --- |
| 采集控制 | 原开关、状态/空窗、错误与功能数据说明；已交 | C：控制事务、接收/存储与旧captureRevision拒收 |
| 逐次编辑过程 | 若另开客户端接入，观察客观操作、暂停即停止上报、恢复不回填；当前未接入 | C/A先交事件格式/入口/幂等/节流边界；不可用自动确认作品替代过程采集 |
| 被动分析 | 未来按公开投影展示候选和未知，不制造能力结论 | C供原始引用，B生成候选，A管理有效状态与授权，后台调度另交 |
| 里程碑提醒 | 开关、可忽略正文、关闭后不展示旧提醒；已有控制/消息接缝 | B/C/A：显式里程碑触发、每个里程碑一次、原Job取消/版本/授权，不按停顿猜测 |

当前写集仅本任务/05/06/SPEC/仓库清单及学生`TutoringControls`说明、既有共同设计例子标识/准备正文与原对应断言；不改后台、协议/schema、身份、模型配置/调用或受保护文档，不自行把分析/提醒调度追加到Robert的前端职责。后续完整系统采集需跨模块交付，不继续把它列成“UI没做完后台”。

### 本次验证与交付

学生目录`rtk npm run typecheck`、`rtk npm test -- tutoringControls tutoringReturn prep/contract.test.ts`、`rtk npm run build`全部退出0；复用控制22项、返回25项、准备契约12项，共59/59通过。当前改动为说明/来源文案，未新增复述实现的测试，保留原权限、原实例/草稿/undo和零自动操作断言。

Chrome使用`CI=1`、`XUNJIE_E2E_BROWSER_CHANNEL=chrome`及独立准备/真实端口5631/5632执行`rtk npm run test:e2e -- tutoringControls.spec.ts tutoringReturn.spec.ts --workers=2`，9/9通过，43.6秒。该运行是准备/公开投影接入验证，不证明未接入的自动采集、分析或提醒已运行。既有品牌public资源提示与大chunk提示保留，未调整构建配置或依赖来屏蔽。

仓库根`node tools/a0-review/check.mjs`检查77份文档/1140条内链，errors=[]；`git diff --check`退出0。只在原`i0/ui-frontend`提交上述10文件，保留原未跟踪`.zcodeignore`；没有推送、合并或发布。产品基线与MVP_SPEC§10仍为“待授权维护者汇总”。
