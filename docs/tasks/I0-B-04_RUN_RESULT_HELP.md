# I0-B-04：原运行与公开诊断求助

**What to build:** 学生对选定的原运行及其公开结果提出问题，回答指向原run/snapshot；历史参数缺失和环境故障明确表达，求助不重新运行也不引用当前控件冒充原输入。

**Blocked by:** [I0-B-02 求助与停止](I0-B-02_HELP_STOP_REPLACE.md)；完整回答关联依赖D-01。与03独立，无需先交代码选区票。真实运行求助另需I0-A对应运行/结果交接，准备链可消费已有合成Run。

**Status:** implemented / engineering-verified（D-01原Job/Run/snapshot来源已接入并通过准备浏览器；实际节点/模型/真人仍分层验收，结果见批次§11）。

2026-10-14较新收尾：[D-01](I0-B-01A_EVENT_PROJECTION.md)投影与页面校验已交，准备浏览器明确核回复原runId/snapshotId，不从当前控件或最近Job推断来源；原结果未知/诊断缺项仍可只读核对象，求助不重跑。正常C/教学消费者已组合，物理SSH节点与真实模型运行求助仍需原受控条件。相关3项运行浏览器在组合中通过，精确统计与分层见[批次§11](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)；后文D-01未交为历史时点。

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。依据：[规格](I0-B_UI_TUTOR_SPEC.md)、[计划](I0-B_UI_TUTOR_PLAN.md)、[Run公开约束](I0_UI_CLIENT_CONTRACT.md)。覆盖UI-TUTOR-03，M-04/相关M-03，AC-02/04/06/07/15、NFR-04。

## Acceptance criteria

- [ ] 复用现有运行/历史结果区的最小求助动作，学生明确选择原runId及其snapshotId，核当前Attempt归属；不借当前文件、最新快照或控件值改写引用。
- [ ] run ObjectRef只带现有attempt/run/snapshot字段，必要公开诊断由既有B2上下文读取；客户端不发额外私有工具结果或猜inputHash。
- [ ] 本机原命令经回执关联的参数标本机来源；无缓存时显示历史参数不可回取，合法公开结果仍可读和求助，不以当前运行控件补填。
- [ ] diagnostics unavailable、裁剪、课程检查结果、stdout/stderr、基础设施failure分别表达；Job succeeded/退出码0/打印passed不当课程或能力通过。
- [ ] 模型失败、运行未知或诊断缺失保留相应状态，不把环境故障标学生知识错，不补正文或私有答案。
- [ ] 复用02冻结原问题/幂等与01回执；实际Action→原Job/Run关系来自D-01获准来源，缺关联不可强绑最近运行，fixture不补隐藏字段。
- [ ] 学生继续编辑、启动另一运行或换上下文后，回答仍显示原Run/快照来源或过时状态，不改贴新结果；停止与替换沿02规则。
- [ ] 点击求助只产生help及其必要读取/回执，零新增run命令、零文件写入；若原诊断不可用不能自动重跑。
- [ ] 浏览器完成原结果→提问→回答来源→另一运行/草稿变化的链，覆盖缺历史参数/裁剪/旧Run/越界对象/晚到；typecheck、相关Vitest/build/专项有实际结果。
- [ ] D-01或真实运行交接未齐时保留完整回答/真实联调未通过，不把准备Run当C1节点/AC-10或完整课程验收。

## Testing Decisions

主接缝为已交RunPanel/历史公开投影→同一helpHTTP→01消息。复用已有运行结果/裁剪/未知/原参数缺项场景，不在测试内构造另一个运行器。检查实际网络请求，确认求助没有run副作用，验证消息原来源与当下结果区分。

## 交付与未完成

写集按计划04；不改变RunGET公开字段、执行配置、可信检查或服务端上下文。当前D-01、02组合接入及浏览器验证未完成，真实节点样例按H-04/对应H-06进入，新的供应商调用许可不从B已合并事实推出。

## 2026-10-13 独立实现与并行交接

Robert明确授权本批实现/并行，并将04可独立部分分配至`codex/i0-b-04-run`工作树。开工Git已跟踪/未跟踪差异均为空。UI实施Agent只修改下表六个文件；主Agent独占PrepWorkspacePage、fixture、HTTP、storage与求助表单/发送链。受保护文档、apps/teaching、依赖/锁文件、Vite、环境/CI、数据库schema只读；没有安装依赖、供应商请求或真实学习操作。

### 已读依据与本次验收范围

已读README/根AGENTS与RTK约定；PRD§1、§3、§4.2/4.4、§5/8的学生控制与对象来源；MVP_SPEC的M-04正文、M-05/06/07/09/10、状态与AC-04/相关AC-02/06/07/15；TECH_DESIGN§4.1完整ObjectRef/快照语义；本批SPEC的运行引用/消息关联/测试边界及PLAN的职责、D-01～06、04写集；04票全文、I0_UI_SPEC、客户端约束§2/3/5/6与IMPORT_SOURCE来源/许可/选择性同步正文。TEAM§2、§9的UI/A/B/C职责保持不变。未发现改动目录内其他AGENTS。

本次仅交引用纯规则、可选结果操作props与待主Agent页面接入的浏览器检查。主页面/冻结问题/幂等发送/回执/D-01关联仍按02与本票原验收完成，不把可独立规则检查等同于整票AC-04通过。

### 实际文件与接口

| 文件 | 本次交付 |
| --- | --- |
| [tutoringRun.ts](../../apps/student/src/workspace/tutoringRun.ts) | `RunHelpTarget={runId,snapshotId}`；`createRunHelpObjectRef(context,target,jobValue,runValue)`复用verifyJob/verifyRun，核当前Attempt/课程/学生、Job/Run、原快照与运行/检查模式，返回仅有`kind/attemptId/runId/snapshotId`的run ObjectRef |
| [tutoringRun.test.ts](../../apps/student/src/workspace/tutoringRun.test.ts) | 7项规则反例：跨课程/学生/Attempt、错Run/Job/快照/诊断、检查模式错配；缺参数/旧来源代际/未知/unavailable/环境故障仍可引用；不带私有字段，不修改原对象 |
| [RunPanel.tsx](../../apps/student/src/components/workspace/RunPanel.tsx) | 新增可选`onHelp?: (target: RunHelpTarget) => void`，只在原结果区且提供callback时显示“就这次运行求助”；读取/提交忙时禁用，回调来自result，不能取selection控件 |
| [RunHistoryPanel.tsx](../../apps/student/src/components/workspace/RunHistoryPanel.tsx) | 同一可选onHelp接口，各侧按钮只回调该侧result身份；读取忙、侧通知、侧选择与结果不符时禁用，缺本机参数/diagnostics不禁用合法原引用 |
| [tutoringRun.spec.ts](../../apps/student/e2e/tutoringRun.spec.ts) | 3项待统一执行检查：当前控件已变时原结果动作无写请求；新浏览器缺本机参数/节点失败/诊断不可回取仍可选择历史求助且不重跑；同一authority公开Run/Job构造原引用与快照错配拒绝 |
| 本文 | 实施依据、接口、实际检查及尚未完成的组合边界 |

两个组件保持纯受控，只引入类型，不引入教学运行时、HTTP或存储。既有参数来源标签、公开stdout/stderr/verdict、诊断缺项与失败状态保持现有投影；没有借当前控件补历史输入，也没有扩展RunGET/wire或更改生成与展示事实。

### 主页面接入建议与测试契约

主Agent为两个组件传同一`onHelp(target)`，点击后在当前确认客户端上下文核`isCurrent`；从`run.state.job/run`或历史两侧`detail.job/run`查找与target完全相符的原结果，调用`createRunHelpObjectRef`。没有对应公开原结果时明确不可用，不能用最新Run顶替。将返回的ObjectRef交02求助表单核对，保留原Run/快照；先显示选择再等待学生显式发送。该函数只构造对象，不授权发送；主Agent发送前按02权威重读Attempt、检查当前身份/loadEpoch/代际与求助许可，跨上下文的旧选择不能继续发送。

浏览器spec复用现有fixedProject/selectRun和同一dev authority，没有新的响应fixture或供应商模拟。前两项需要主页面实际传入onHelp，当前工作树主页面尚未接入，测试没有skip或假装通过。它们核选择本身零新增help/run/sync等写请求及原命令不变；第三项在浏览器从当前authority取得公开Run/Job核引用。主Agent接入02后还须补求助表单实际所选ObjectRef、显式发送wire/冻结问题、另一运行/草稿变化/换上下文及晚到消息边界；现有三项不覆盖这些未实现链路。D-01未交时回答必须保留对象关联未核实，不能把通用教学正文强绑此Run或最近Job。

### 实际验证与限制

2026-10-13，沿用已有Node v24.15.0和node_modules junction，未安装依赖。学生工程中`rtk npm test -- tutoringRun.test.ts runResults.test.ts runRequest.test.ts`：3文件、12/12通过（新规则7项、既有结果3项、既有原请求2项）。`rtk npm run typecheck`首次发现新e2e误取ServerHead helper未公开的attemptId，修正为当前fixture context返回的原Attempt后重跑退出码0，前端与Node侧tsconfig均通过。没有改既有helper或放宽类型。

Playwright按分工暂未运行，build、真实HTTP/节点、模型供应商、真人语义/学生接棒均未执行。Node v24.15.0不作为教学服务精确运行门禁验证。完整AC、应用浏览器验收、教学效果与整票状态不宣称通过；产品基线及MVP_SPEC§10为“待授权维护者汇总”。

仓库根`node tools/a0-review/check.mjs`检查72份文档/1005条内链，errors=[]、退出码0；`git diff --check`通过。只对上述六文件进行本地提交，未推送/合并/发布；实际SHA由最终Git结果回交，不在自身提交正文写未来SHA。没有本次无用临时文件。

## 2026-10-13 主页面组合结果

独立提交`fedd0c3`已以`5ee90ba`整合回原UI分支。主页面从当前Run或历史所选detail的公开Job/Run核引用，打开明确原run/snapshot表单，再由学生发送02原help；不是从当前运行控件推参数，也不因选原运行创建新run/sync。

[本票浏览器](../../apps/student/e2e/tutoringRun.spec.ts)3项通过：改运行控件后原结果选择零写入、新浏览器缺参数/环境诊断仍能选择原结果、公开Job/Run构造与快照错配拒绝。主最后扩展第一项，实际从核对表单发送原run/snapshot ObjectRef，获准合成正文出现，验证没有新run/sync/snapshot副作用；3项重新通过。原运行14项回归通过，原诊断/未知/取消/来源语义保留。实际build/typecheck与[组合记录](I0-B_UI_TUTOR_PLAN.md#92-验证失败修复与证据分层)另列。准备发送不冒充D-01回答归属或真实节点/模型/真人接棒；完整票及正式AC-04仍未完成。
