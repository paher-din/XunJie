# I0-B：辅导链前端批次计划与 ticket 索引

日期：2026-10-13；更新：2026-10-14（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。**本批六票的获准前端工程已完成**：原67条逐项核对见§13.2，最终34文件464项规则、类型/build及169项Chrome全量通过见§13.3。发送/超限状态、当前运行许可、刷新/重建返回、原文撤销与迟到控制读取均已补齐。自动采集/分析/提醒调度、受控节点、真实模型/真人及完整产品验收另列，不作为Robert的本批前端欠交。§11/§13.1保留各历史候选、失败与修复，不混用版本或重复累加。入口：[I0-B SPEC](I0-B_UI_TUTOR_SPEC.md)、[完整30项清单](I0_REMAINING_WORK_CHECKLIST.md)。本文件记录范围、来源、写集与执行事实；不代替产品基线、A/B/C任务或成员交接。

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
- 06：已交的是政策/开关/权威结果与覆盖区间UI。学生客户端的`SyncInput`和`freezeSync`目前没有process/captureRevision上报字段，编辑草稿不会自动上传逐次过程；保存、求助、运行等功能记录另存。当前“开关开启”只能说明服务端许可，不能说明采集链在运行。
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

## 13. 2026-10-14 六票逐项收尾审查

Robert要求照既定说法完整完成本批tickets、不扩大范围，必要手动操作具体告知。当前Agent按README→PRD §1/3/4.2/5/8→MVP_SPEC §2/M-03～05/09/10/4～7→TECH_DESIGN §3.3/4.1/4.3/4.4/5/5.1/6/7.1～7.4，核对六票原验收、I0-A客户端/来源约束与§12较新决定；两组只读审查分别核01～03和04～06的实际接线/覆盖。保护基线/计划/参考/规范继续只读，原分支不变。

已取得当前提交`cc72891`的直接执行证据：`rtk npm test -- tutoring`为10文件202/202通过；Chrome本批`rtk npm run test:e2e -- tutoring --workers=2`为35/35通过，1.8分钟、零失败/跳过。其中正常dist→实际HTTPS/Session/CSRF/SQLite/原worker专项18.8秒，原生后台标签9.3秒；准备/真实协议替身与实际服务仍分开，不累加为全产品验收。使用CI新起准备/普通端口5641/5642，教学运行时为原已就绪24.21.0，未开供应商调用。

当前补验写集只包括本批浏览器文件`e2e/tutoringHelpStop.spec.ts`及对应02/06/批次记录：原02/06明确预算/超时故障仍保存，已有浏览器只直接验非法正文/模型failed，尚无BUDGET_EXHAUSTED与timed_out组合的直接页面事实。复用已有同authority脚本补此边界，不改API/fixture/后端或验收要求；先记录缺口，修复/执行结果随后补录。其余逐项审查结果与最终状态待收尾核定，不因35项通过直接宣称全部原AC覆盖。

两组逐AC审查随后确认：02发送中与未知混用、未显示公开Job截止已过而终态仍未知；06运行按钮仅看旧eligible、未结合当前暂停状态。01尚缺教学事务失败/回执丢ACK/多页/滚动边界/存储丢失反例，03缺重建文件后的旧回答呈现，04缺另一运行后的原回答来源，05缺实际刷新/重建返回与未确认作品命令保留。以上是原前端责任的实现/覆盖缺口，不以新后台采集或真人验收替代，也不据此提前关闭六票。

主写集追加原`tutoringWorkspace.ts`/`TutoringPane.tsx`的发送与等待说明、`PrepWorkspacePage.tsx`的当前运行许可及必要返回降级、对应helpStop/controls专项与02/06/本记录。独立工作复用既有干净工作树，均从`cc72891`新建临时协作分支，原分支继续作为整合分支：`codex/i0-b-closeout-messages`独占消息专项/必要`tutoringStore`与01记录；`codex/i0-b-closeout-code`独占代码专项与03记录；`codex/i0-b-closeout-results-return`独占运行/返回专项与04/05记录。不写保护文件或后台，不改变判据；原分支与历史提交保留，子工作树独立端口5661/5662、5681/5682、5671/5672，主5651/5652。

预算/超时补验首轮1项失败：第二次编辑helper是插入操作，测试误按替换整篇预期，因此真实保存保留了第一次正文及新增正文。此为测试操作组装错误，不是作品丢失；改成学生明确全选替换后仍核完整正文，不放松保存断言，后续结果另记。

06提醒消费补验需要一个尚未展示的`reminder`用途样例；原dev脚本只有student_help且stopPrepTutoring只匹配该用途，无法证明提醒取消。原前端准备写集允许同authority合成场景，主仅在`prep/tutoring.ts`和原`prep/plugin.ts`的现有开发脚本里提供明确合成的待展示提醒样例，复用已读C3公共字段/固定公开政策并按原purpose取消，浏览器验证关闭及再开启不展示旧动作。此为消费已交契约的测试材料，不新增生产接口、里程碑触发器、分析/提醒调度、数据库或真实学习记录；不将开发脚本计成实际后台行为。

06跨账号补验不虚构第二个准备身份。原实际HTTPS专项及其`server/app/i0-browser-fixture.ts`在原隔离工厂中复用已有合成`other`课程成员和教师分配接口，提供第二个获准分配引用及私有IPC测试口令；验证真实Session换账号后旧控制ACK不改新尝试，原账号作品/消息不可读。只扩隔离验证入口，不改正常宿主、生产身份权限、配置/凭据、schema或真实记录。原Node24.21.0/HTTPS/SQLite条件保持，正式dist须在本轮源码整合后重新构建再执行。

01补验`d89781f`以`b28f867`整合；03补验`de953eb`以`22b7df3`整合；04/05新增实际场景`17de077`以`1d024f5`整合，其中04为4/4，05仍有三项失败，未写通过。较新05写集：主在原页面按标签与完整当前作用域保存仅原文件ID/path/documentVersion的阅读标记，刷新不存/恢复坐标或正文，只保留原引用与“精确位置未保留”的可见说明；返回拒绝保留该原引用，不改贴重建文件。必要marker只用独立sessionStorage命名空间，不改IndexedDB/schema或学习记录。独立05工作者获追加`CodeEditorHost.tsx`与必要原文历史规则/单测写集，修Monaco一个undo group跨多个内容事件而原文只撤一步的根因；不清空undo或规范化原文，保留BOM/混合EOL/非BMP及原pending作品命令。完整前端工程关闭继续待这些失败修复和整合后复验。

### 13.1 根因修复与当前直接证据

- 02：原请求键有独立的sendingKey，发送中、未知、服务拒绝与已受理分别显示；确认原回执后清旧错误。公开deadline已过但原Job仍queued/running时只提示等待超限，保留远端状态，不编造timed_out、用量或新请求。成功键盘发/停/原键核对、预算拒绝/权威超时/模型failed后保存的8项专项通过，36.4秒。
- 06：canRun同时核当前Attempt阶段与权威Assignment，暂停立即禁用已配置运行，恢复只按现有许可开放。原控制8项同次通过，1.0分钟；独立提醒1/1通过15.7秒、旧代际ACK晚于新控制1/1通过、另一标签同值1/1通过7.2秒。实际HTTPS专项扩展真实other账号/获准分配后1/1通过29.1秒（用例23.7秒），旧控制ACK不改新账号尝试，旧作品读取403。新合成提醒只有dev样例及原purpose取消，零生产调度新增。
- 05：实际刷新/同名重建后保留本机原文件引用和持久可见缺位置说明，两项通过18.9秒，零作品/控制/新帮助副作用。原文撤销修复`2ed0b76`以`f3d2b7f`整合；主补CodeWorkspace的view/null转发与页面本机view捕获。模型直接内容订阅和alternativeVersionId仅用于本机原文历史，不成为服务端documentVersion；原生undo/redo/分支保持BOM、混合EOL和非BMP，视图不写入刷新marker。
- 整合源码的学生typecheck、33文件459/459规则及正式build退出0；教学新增隔离脚本在精确24.21.0 runtime gate及原tsc --noEmit下退出0。正式学生dist扫描准备端点、合成账号/相邻例子ID及pending-reminder无命中，保留原大chunk与品牌public资源提示。最终169项完整Chrome运行正在执行，未预记通过。

原失败/限制保留：主预算用例误把insert当replace导致首轮失败，改成实际全选替换；运行许可用例两轮失败为关闭动画尚未卸载便重开，改为等待真实组件卸载，不关闭动画/加sleep/force。提醒样例首轮未取得project模板，因为开放问题ObjectRef可省略，模板按原公共契约兼容缺省project后通过。跨标签首轮真正403来自新准备页自动登录轮换共享开发cookie，原页内存CSRF未更新；测试设置从实际GET session同步原页内存token再验同值，不伪造身份/请求，正常真实Session另由上述HTTPS两账号覆盖。曾并发两条主harness共用输出目录造成trace文件ENOENT，后续各独立output或串行；根因及用例失败不改记通过。RTK的Windows shim不能稳定转发含竖线的grep，回退原node CLI，不改测试配置/超时/断言。

独立节点、真实模型/语义、真人及自动采集/分析/提醒调度继续按§12分工；06控制消费补验不代实现该后台，也不将实际HTTPS离线合成服务称为真实模型或教学效果。产品基线/MVP_SPEC§10待授权维护者汇总。

首轮整合全量Chrome169项为167通过/2失败/0跳过、7.9分钟，本批辅导57项全通过；不能写全量通过。原compare“服务版本冲突保留本页”未取得冲突状态，原runResults“find/top输入修正”重读后运行按钮未恢复。定位共同根因是教学/控制后台轮询调用完整readHead：它能提前推进本机作品确认基线，也与学生明确运行重读争同一个读取轮次。本批为保证新增辅导不破坏原作品链，追加原ConfirmationWorkspace的仅控制读取选项及两教学调用方适配；仍同一GET/同一ContextGuard/原代际/版本守卫，只更新权威控制，保留作品/映射/快照/outbox和原冲突/ACK接纳。仅控制读用独立读取序列，不让后台轮询作废明确作品/运行读取；跨读取序列仍拒绝旧attempt/capture/epoch控制，不新建Guard或公开API。原两个回归断言保持，先窄复验，再按结果决定必要回归。

该修复先在CI/Chrome/5721/5722执行原两个失败用例：`node node_modules/@playwright/test/cli.js test compare.spec.ts runResults.spec.ts --grep '服务版本冲突：比较|find/top' --workers=1 --output=test-results/control-read-regression`，2/2通过、15.5秒、退出0；原断言/超时未改。随后完整typecheck退出0、33文件459/459规则通过（2.08秒）、正式build退出0（5.99秒）；新一轮全量Chrome在5731/5732、精确教学Node24.21.0环境运行，结果待终态，尚不能预记169/169。

上述5731/5732完整Chrome已结束：169/169、0失败/0跳过、7.3分钟，原生后台9.2秒、实际HTTPS两账号专项22.7秒，本批8文件57项包含其中，不重复累加。独立只读代码复核随后用原readHead/send/ContextGuard及受控HTTP/仓储边界复现两项未被这些浏览器覆盖的竞态：保存ACK仅退役workspace-head且清空展示attempt，旧workspace-controls读取可以绕过版本比较；另一序列新控制已接纳后，迟到读取失败仍可清attempt，并令更旧成功读回退。当前不能仅凭169项绿灯关闭工程票；主负责确认客户端内双读取屏障、独立控制版本水位和失败接纳守卫，复核Agent只追加`src/workspace/confirmationWorkspace.test.ts`以原公开操作固定这些反例，不加依赖/后台/契约。先保留红灯，再修实现并执行必要回归。

新规则5项先在缺陷版本运行，1通过/4失败、退出1：save与retry接纳ACK后旧控制读仍返回active/rev7；迟到失败清掉新暂停；当前完整读失败丢版本水位后又接纳旧控制。HTTP与仓储边界为受控替身，实际ContextGuard、公开readHead/save/retry、冻结/回执核验均保留，不调用私有send/publish。主修复只在原确认客户端：非null权威Attempt更新独立控制版本水位及成功发布计数，展示未知不丢水位；跨序列新成功发布后，旧失败只留诊断；send/acceptLocal的ACK均退休两条原读取序列；新Attempt/guard重置本机水位。修后原5项全部通过，709ms、退出0；完整类型/规则/build和最终Chrome候选门禁随后执行，结果仍按实际终态追加。

### 13.2 前端职责与逐项交付核对

Robert再次询问“我负责的是前端相关的，为什么会有这个采集工作”。当前Agent据[TEAM §8/9](../planning/TEAM_WORK_PLAN.md#9-p5最后接入实际-ui再完成-g4-真实试用)与较新§12核对：本批06的采集工作是开关、权威状态、覆盖区间/空窗、错误与功能数据说明；不是新建采集后台。原06验收第6条包含跨模块条件，UI控制交付、C的接收/持久化/旧过程拒收、B的分析/提醒及A的组合须分开报告，不能把后台未接入写成Robert的前端欠交，也不能将开关开启写成实际采集已运行。若未来另开逐次编辑上报的客户端票，须先有C/A交付的事件格式/入口/幂等/节流契约。本次核对不新增该票、不改写受保护TEAM/产品基线。

六票原验收共67条（01=12、02=13、03=10、04=10、05=10、06=12）。下面按原条目顺序列前端证据，结合§13.3最终门禁，六票获准前端责任均已交付；06第6条含跨模块全系统采集/分析条件，整条仍保留未勾，不宣称67条完整产品行为全部通过。准备authority、协议替身、实际HTTPS合成服务、受控节点/模型/真人分别记账。

| Ticket / 原验收条目 | 当前实现与直接证据 | 保留边界 |
| --- | --- | --- |
| 01 / 1～4 | 原AgentMessage安全正文、严格payload/hash/来源校验、原事件分页/control/resync及action/hash去重；messages的非法正文、同Action冲突、实际正向多页/跨序号缺口重取 | 不演token/队列/思维链，不用缺字段推断对象 |
| 01 / 5～7 | 原消息区域IntersectionObserver和原生visibility，隐藏/收起/未滚入不报displayed；明确“我先试试”才acknowledged；三类回执丢ACK均原clientReceiptId/键/正文重放 | 回执只记收到/展示/回应，不等同理解或采纳；原生后台实测在messages专项内，不额外重复计数 |
| 01 / 8～12 | 真实IDB abort保正文/游标/待回执原子性、help落盘失败零POST；丢ledger启新通道从零；刷新/独立标签、原代际/账号隔离及D-01/D-02授权历史 | 实际HTTPS/Session/CSRF/SQLite/原worker已有隔离合成证据；模型/真人不据此通过 |
| 02 / 1～5 | 开放项目问题、发送前权威读取、冻结/落盘/原键；独立sendingKey；未知/受理/公开Job终态及等待超限说明；原ACK丢失核对和原截止后仍running反例 | 本地等候超限不造timed_out/usage/新Job；读取/编辑零自动求助 |
| 02 / 6～11 | 原公开Action/Job来源；本地停止屏障和原Job取消/stopRequested/invalidatedActionIds；生成中、生成后未展示、双未知、迟到/替换/刷新及已展示历史 | 本地abort不是权威停止，停止/替换不删已展示事实，不自动续答 |
| 02 / 12～13 | 控制开关→显式求助组合、限定检查未知/true拒绝；模型failed、预算拒绝、权威timed_out后实际确认保存；键盘发/停/原键核对 | 故障保护原问题与草稿，供应商新增请求0 |
| 03 / 1～6 | 原文件/选区读取、获准快照清单/正文/hash与确切ObjectRef；草稿差异不自动保存；原文UTF-16/BOM/CRLF/CR/非BMP映射；复用01/02及D-01 | 缺快照、越界、hash/版本/权限缺项严格不可用；不增加help wire字段 |
| 03 / 7～10 | 实际改稿/回收/同名重建保原Action/ObjectRef；旧HTTP页跨Attempt/代际迟到不闪现/不补回执；实际HTTPS代码来源另列 | Chrome合成用户链不表述成Agent代学生操作或教学效果 |
| 04 / 1～6 | 原RunPanel/历史Run/Job→原runId/snapshotId；本机参数有来源、缺参数明确；公开diagnostics/failure/裁剪/检查语义；原Action→Job/Run及复用01/02 | 不补私有结果/当前控件参数，不把succeeded/退出0认作课程或能力通过 |
| 04 / 7～10 | 实际问原Run后自行改稿/确认/冻结/启动另一Run，以及原回答HTTP晚到；回答原Run/快照不改贴，求助/阅读零run/sync/snapshot副作用；缺参数/诊断仍能选择原结果 | D-01已交；受控C1节点/H-04、真实模型与完整AC-10未执行，前端合成Run不冒充这些验收 |
| 05 / 1～4 | 共同设计29/30/31相邻例子及真实模式公开引用资料；原只读槽；实际Monaco view与原实例分开保存；原editor/model/undo保挂载、显式返回 | 外部教师审批不再作为本批前置；例子来源和合成性质保留，不执行或写作品 |
| 05 / 5～10 | 实际刷新只留原引用/缺位置提示；另一标签回收重建拒绝旧定位；pending原wire字节保持；混合EOL/非BMP/折叠/滚动/逐组undo/redo/新分支及键盘返回 | 本机view不写刷新marker；本批无需服务端position写入；关闭/返回不新增acknowledged或自动续答/运行；真人接棒属范围外UI-TUTOR-09 |
| 06 / 1～5 | 固定政策、三个独立控制、原revision/generation/键、原ACK重读及同值不增epoch；当前Attempt/权威Assignment暂停禁新运行且保获准已有文件保存 | 后台轮询仅读控制，不能静默接受另一写者的新作品基线或作废明确运行读取 |
| 06 / 6～7 | UI准确说“允许采集区间”，覆盖空窗来自原公共页；暂停期间显式功能保存仍可；提醒默认关、关闭取消合成未展示提醒、再开不复活，主动求助保留 | **第6条的全系统逐次采集/被动分析行为证明仍由C/B/A交接，未执行；本批不新增上传器或调度器**。dev提醒仅消费样例，不是生产能力 |
| 06 / 8～12 | D-03同事务limitedCheck、发送前新GET与实际服务拒绝；原键/同值/跨标签/旧代际ACK、真实HTTPS换账号后旧ACK隔离/旧Attempt403；故障仍保存与键盘控制 | 按实际分层证据核前端工程，不宣布全AC/NFR/G门禁或教学效果通过；产品基线/MVP_SPEC§10待授权维护者汇总 |

### 13.3 最终候选验证与交付

2026-10-14，主Agent完成最新读取竞态修复后的同一源码候选，独立复核未发现新问题：原两处ACK均退休完整/控制读取、展示未知保控制版本水位、失败接纳核跨序列新成功、新guard重置水位；同版本控制轮询不作废明确作品读取，控制GET不安装作品基线/outbox。前述“待终态/不能关闭”为当时记录，以本节较新结果为准。

| 实际执行 | 最终结果 | 范围 |
| --- | --- | --- |
| 学生目录`rtk npm run typecheck` | src与Node配置均退出0 | 最新全部源码与浏览器/准备脚本 |
| `rtk npm test` | 34文件464/464、零失败、2.04秒、退出0 | 含新[公开操作控制竞态](../../apps/student/src/workspace/confirmationWorkspace.test.ts)5项及原文31项；纯规则/受控端口替身不冒充浏览器 |
| `rtk npm run build` | 退出0，Vite构建6.00秒 | 正常dist；准备端点、syntheticAccount、合成例子ID和pending-reminder扫描零命中，原大chunk提示保留 |
| `node node_modules/@playwright/test/cli.js test --workers=2 --output=test-results/i0-b-delivery` | **22文件169/169，0失败/0跳过/0retry，7.3分钟，退出0** | CI新起Chrome、5741/5742；精确教学Node24.21.0。原作品/运行/布局/数字逻辑保留，完整候选实际执行，非专项次数拼接 |
| 完整Chrome内的本批专项 | 8文件57/57，包含在169中 | code5、controls11、helpStop8、history5、messages19、return4、run4、service1；原生hidden→visible9.1秒在messages内 |
| 完整Chrome内的实际HTTPS | 1/1，23.6秒 | 正常dist→实际Session/CSRF/SQLite/原B2-C3持久worker；双求助、原来源/回执/历史及真实账号切换迟到控制ACK。仅离线合成provider、自签名测试TLS、合成账号/库；不是节点/供应商/真人验收 |

教学隔离脚本的精确24.21.0 runtime gate与原tsc --noEmit已退出0；本轮只追加验证用第二合成账号/分配，不改变正常宿主、权限、schema/迁移或配置/凭据。原首轮167/169失败、前一169/169后复核发现的4个规则红灯和其他失败均如实保留；最终通过没有删反例、增加retry、放宽断言/超时或关闭检查。静态文档/差异空白检查及Git实际交付在提交前核对，不把未执行检查记通过。

交付继续在原`i0/ui-frontend`，并行工作树支线的实现已由主核验整合；本轮本地提交仅当前学生源码/准备样例/浏览器与规则、隔离HTTPS验证脚本、学生README、六票/批次/清单记录，不包含无关`.zcodeignore`、ignored测试产物或受保护文件。只本地提交，不推送/合并/发布，不关闭父Issue；实际SHA由Git提交结果给出。未留下临时探针源码，ignored诊断仅保留工程证据用途。

**本批无需Robert另交教师材料、模型额度或执行手动验收才能完成前端交付。** 自动逐次编辑上传、后台被动分析/提醒调度应由后续明确客户端契约与C/B/A工作承接；原06全系统第6条、受控证书/SSH节点/H-04与AC-10、真实供应商语义/真人接棒/UI-TUTOR-09、全M/AC/NFR/G条件保持各自未执行/后置状态，不算本批六票前端未完成，也不被工程通过代替。产品基线及MVP_SPEC§10待授权维护者汇总。

提交前根`node tools/a0-review/check.mjs`检查77份文档/1164条内链、errors=[]、退出0，`git diff --check`退出0；按Git原稿逐条比较六票全部67条判据正文，仅维护完成勾选/责任说明，原条文未改，06跨模块第6条仍未勾。最终写集为22文件；无受保护产品/计划/参考/规范、依赖/配置/schema或无关文件变更。

末次文档勾选脚本的新增两行说明误用CRLF混入原LF正文，raw `git diff --cached --check`曾报六票共12处trailing whitespace、退出2；RTK过滤未呈现细节，已立即回退原Git定位。仅修本次新增换行，保持原67条判据和全部历史正文，未改Git检查配置；重新暂存后的原Git staged/unstaged空白检查均退出0。

## 14. 2026-10-14 远程主线整合、整体PR与清理

Robert明确要求检查远程main更新、必要整合、完成整体PR并合并main，随后清理本次创建的工作树和分支。本次授权覆盖原`i0/ui-frontend`推送/整体PR/合并与本会话I0-B协作工作树和分支清理；不扩成其他成员PR合并、部署/模型调用或无关工作删除。

当前fetch成功，远程main为`0e68325`（PR #52/B3），比本批共同基线多12条提交；本分支有18条独有I0-B提交，HEAD为`b680543`。main新增B3教学契约/core/analysis/provider/service及原任务记录共11文件，本批不覆盖这些上游改动。原PR #50已合并，本批新建以main为base的整体PR。已有A/C/DL #53～56保持原状态，不因本次请求顺带合并它们。

执行写集：原分支合入已发布main，必要冲突/兼容性只修本批已有接线；本任务记录授权、实际远端SHA、检查/失败与交付。产品/规划/参考/规范、其他成员任务、配置/凭据、依赖/schema保持原权限，不另造接口或修改其正式决定。优先核B3与现有B2/C3宿主兼容、前端类型/规则/build及实际HTTPS专项；只有新失败或未解兼容问题才扩大检查。已通过的纯前端169项不因仅上游服务更新而无理由全跑重算。

清理须在远程PR合并及main包含最终head已核实之后执行。只归档本会话attachments列出的8个I0-B工作树，检查未提交/未跟踪及ignored产物后保留必要可恢复快照；删除本批I0-B协作分支及已交付的`i0/ui-frontend`，主checkout转main并fast-forward。无关`.zcodeignore`保留；`c55-review-fixes`、`i0-a-c55-review`及其他会话/成员分支不纳入本次清理。实际结果随后追加，不预记推送/PR/合并/清理完成。

### 14.1 主线整合与验证结果

原分支用正常merge产生`1d0856d`，无冲突；完整保留远程B3新增11文件，学生源码/测试/依赖相对`b680543`无差异。独立只读审查只核这次上游增量与原B2/C3宿主的连接，确认student_help分派、原schema/字段、预算/调用计数和最终learner版本守卫兼容，未发现新增缺陷；不重复上游已经完成的B3审查或追加后台调度。

| 合并后实际检查 | 结果与边界 |
| --- | --- |
| 学生typecheck、`npm test`、build | 全部退出0；34文件464/464，2.32秒；正常dist构建6.30秒。前轮169/169仍对应完全相同的学生源码，不把本轮专项写成重新全跑169项 |
| 教学精确Node24.21.0 typecheck/build/默认`npm test` | 438项：425通过、0失败、13跳过，89.4秒。B3及原B2/C3/作品/分析守卫均在默认集；环境/真实模型等13项跳过不算通过 |
| 原I0与辅导宿主专项 | `node --test server/app/i0.test.ts server/app/i0-tutoring.test.ts`：16/16，16.5秒，零失败/跳过；不与默认集内投影/限定检查项重复相加 |
| 更新主线后的实际HTTPS Chrome | 原`tutoringService.spec.ts`1/1，29.4秒（用例22.6秒），零失败/跳过；正常dist、Session/CSRF/SQLite/原worker、双求助/历史和跨账号迟到控制ACK仍通。CI新起5761/5762，不调用真实供应商 |
| 根文档和原Git空白 | 78文档/1164内链、errors=[]、退出0；`git diff --check`退出0 |

教学检查的初次WSL命令因Windows参数转义展开含空格PATH而在启动前退出2，没有执行测试，不能记业务失败/通过。已改用临时`env PATH=<精确Node目录及Linux系统目录>`及原npm脚本成功执行；本进程明确移除P2/B3真实模型与C1/HDL外部运行授权标记，不修改.env/系统PATH/凭据或旧配置，新增供应商请求为0。

8个工作树均已提交源改动；projection/limited-check各仅多一个非源码`apps/teaching/node_modules`的WSL符号链接，实际目标是主仓库依赖，学生依赖为指向同主仓库的junction。归档前仅移除这些本次链接自身，主依赖目标保留；不把依赖链接/ignored浏览器产物当待交源代码。8个当前分支和另外3个初始I0-B支线共11条协作分支，连同已交付主分支共12条待清理；管理工具保留可恢复工作树快照，最终PR/清理事实由远程PR记录、任务attachments及本会话收尾结果核对，不预造合并SHA或完成状态。

### 14.2 整体PR与合并后交接

`88f7eac`已推送至原远程`i0/ui-frontend`；整体[PR #57](https://github.com/paher-din/XunJie/pull/57)已创建并附在本会话，base为main `0e68325`。GitHub在创建head上报告MERGEABLE/CLEAN，CI诊断checks/statuses均为空；这表示没有返回CI任务，不写“CI全部通过”。本节文档提交后再次核最新head、base与合并状态，依Robert明确授权用保留提交的merge方式合入，绑定实际head以防分支在等待期间被更新；不使用管理员绕过或合并其他开放PR。

合并完成后从远端再fetch，核main包含PR最终head及远端merge记录，主checkout转main并仅fast-forward。清理先保存8个管理工作树的可恢复快照，再删除本批11条协作分支及本地/远程交付分支；必要依赖链接只unlink自身，无关两工作树/其他成员分支和`.zcodeignore`保留。工作树归档状态由本任务attachments保存，合并SHA/时间由PR公开记录保存；本节不提前宣称合并或清理已经完成。

### 14.3 合并与清理的实际结果

整体[PR #57](https://github.com/paher-din/XunJie/pull/57)已于2026-10-14 13:13:16（Asia/Shanghai）正常merge，最终head为`dbe5bd377d9ab2d9784957fb9cb7e1864e776545`，合并提交为`657ec10b03f833d3a9891650a27ac2c60b645ece`。随后fetch确认远程main包含最终head，主checkout切main并fast-forward到同一提交；合并树与已验证head无差异。保留原本的本地检查结果与13项服务测试跳过，GitHub未返回CI任务，不将空状态写成CI通过。

§14.1～14.2记载的是归档清理方案，实际执行有如下偏差：8次管理工作树归档仅返回`queued`，复核attachments仍为工作树，没有可核实的归档快照；直接移除依赖链接及临时PR正文文件的命令被自动审批拒绝，返回理由仅为`blocked by policy`，均未执行。因此没有宣称管理归档或物理目录删除成功，也没有换工具执行被拒绝的链接/正文删除。

替代的Git清理先生成并用`git bundle verify`核实主仓库`.git/i0-b-worktrees-2026-10-14.bundle`，保存本批11条协作分支的完整历史。检查确认8个工作树没有未提交源码，projection/limited-check各仅有原WSL依赖链接；其余依赖与测试产物均不属于待交源码。核对本机Git for Windows 2.55.0对应的[一手源码](https://github.com/git-for-windows/git/blob/32c4f7689275d233577576630e1ac5b7eb354eb0/dir.c)后，确认`git worktree remove`会保留junction而不会遍历其目标，再移除8个已核对的Git工作树；仅上述两个有未跟踪链接的工作树使用`--force`。原主仓库学生/教学依赖均仍可读。

本批11条协作分支已在恢复bundle核实之后删除；`i0/ui-frontend`本地分支也已删除，远程分支用绑定最终head的lease删除成功。合计12条本地分支、1条远程分支；`git branch --list 'codex/i0-b-*' 'i0/ui-frontend'`与远程对应分支查询为空。`git worktree list`仅保留main，以及其他会话的`c55-review-fixes`、`i0-a-c55-review`、本轮期间新增的`i0-ui-real-browser`，未删除或改动它们。用户原未跟踪`.zcodeignore`保留；清理时主checkout除此文件外没有待交改动。

尚未完成的物理清理明确保留：`i0-b-controls`、`i0-b-code`、`i0-b-run`、`i0-b-return`、`i0-b-history`、`i0-b-projection`、`i0-b-limited-check`、`i0-b-real-entry`这8个原工作树根下均只剩`apps/student/node_modules`指向主仓库依赖的junction及其父目录，无`.git`或源文件；Codex附件仍显示旧工作树，不能称已归档。ignored的`apps/student/test-results/i0-b-overall-pr.md`临时正文也因相同审批拒绝保留。上述残留清理由平台允许的目录/附件清理操作承接，不算Git分支或工程交付未合并；恢复bundle保留用于必要恢复，不作为团队开工前置。

本节是合并后的事实补记，采用独立临时文档分支交付；只改本任务记录，根`node tools/a0-review/check.mjs`检查78份文档/1164内链、errors=[]、退出0，原Git差异空白检查退出0。不重复已通过且源码未变化的测试。补记合入后删除该临时分支，不新建工作树或改动受保护文档。
