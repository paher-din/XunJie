# PR #226 审查修复交付

- 仓库：`paher-din/XunJie`；分支：`feat/agent-runtime-v3-completion`。
- 上一轮审查基线：`c65d93f5`；本轮复审基线：`0e064316`（业务源码与 `f98abcf1` 相同）。
- 本文保留 37 项问题的修复映射，并记录本轮复审发现的两个 P1 及验证时进一步发现的边界。工程测试、桌面 Chrome 与真实两机部署分别报告。
- 原始 PLAN 与架构图是实现规格；验证结论以当前源码和下方实际执行结果为准。

## 一、修复内容（逐 ID）

### K 系列：宿主所有权与终止

- **K01 已修复**：`runtime.ts` 统一 `acquireLock()`；正式 readOnly resume 也先取得并持续持有 `agent-host:<env>/<service>` 独占锁，完成 `recoverInterrupted` 后才开放 dispatch；`dispatchOpen` 必须持锁。回归：`repro-core-runtime.mjs` 第 1 例在真实 PG 上验证另一连接不能取得同一锁。
- **K02 已修复**：`tools.ts` 在 await 返回后、写结果前调用 `isActive()`；`store.ts` 的 `ownedTurn`/`assertOwner` 校验 owner、Turn 状态、Step 状态，保存结果和 `step-completed` 都在短事务中完成。回归：`repro-core-runtime.mjs` 切断真实锁后端连接，旧宿主的迟到结果、Step 完成与 Turn 终态均被拒绝；事务末尾失锁会回滚整个闭合，再由新宿主修复。
- **K03 已修复**：`runtime.ts` 的 `armTurn/disarmTurn` 按 Turn deadline abort 同一个 signal；`tools.ts` 为每次调用建立独立 signal，普通工具取 `min(now+maxCallMs, budget.deadline)`，提问与课程长任务按业务 deadline 等待；`model.ts` 的 receive/dispatch/progress/read 全部走 `raceAbort`，Stop 在轮询等待中也 cancel 上游。回归：`repro-core-runtime.mjs` 硬截止与轮询 Stop 两例。
- **K04 已修复**：`store.closeTurnCalls()` 闭合 Turn 失败/Stop 后所有开放 Step、ToolCall、问题；`recoverInterrupted` 修复终态 Turn 仍有开放子记录的崩溃窗口。回归：`repro-core-runtime.mjs` failed、Stop、重启修复三例。
- **K05 已修复**：启动修复先读取真实已答/未答结果，不再用 unknown 覆盖回答；`answeredResult` 与 `closeTurnCalls` 分离。回归：`repro-core-runtime.mjs` restart 参数化两例。
- **K06 已修复**：Stop 只对真实持久取消意图 deliver+wake；旧 completed Turn 的通知仍能唤醒空闲会话，空闲时 `openPendingTurn`。回归：`repro-core-runtime.mjs` 旧通知唤醒例。
- **K07（P2）已修复**：`registerNotification` 拒绝缺失来源的通知，避免新 Turn 被无 origin 的通知接纳。回归：`repro-core-runtime.mjs` missing origin 例。

### T 系列：任务、工作区与所有权

- **T1 已修复**：`store.workspaceInputs()` 读取 Session 中所有已 adopted 且有 action 的输入；`resolveWorkspace` 只要求至少一个合法 action，Step 2 不依赖新输入。回归：`repro-task-boundaries.mjs` 实际工作区 Step2 断言 `modelCalls=2`、Turn completed、2 Steps。
- **T2 已修复**：`AgentSessionDependencies.tools()` 不再返回空数组；wire context 转发 `sessionState`、inputIds；student/workspace 场景按唯一名合并远端工具与本地 `questions`/documents/skills，并修复 workspace 的 remote 分支只返回远端工具、丢掉本地 questions/documents/skills 的问题。回归：`repro-task-boundaries.mjs` 通过真实依赖协议 `tools.execute` 执行 `read_pdf` 并断言上下文转发；`repro-capability-regressions.mjs` 分别用 `createStudentAssistant`/`createWorkspaceAssistant` 的真实场景装配加载声明 `allowed-tools:[read_pdf]` 的 Skill。
- **T3 已修复**：`teachingDefinitions` 的每个 `course_operation` anyOf 分支 properties 均加入可选 `executionMode`，根 properties 同时保留；默认/ background/ foreground 均被真实 Gateway AJV 接受。回归：`repro-task-boundaries.mjs` 用实际 `compileOutputSchema` 三个断言。
- **T4 已修复**：产品 host 的 `poll()` 调用 `sessionAgent.observe()`；任务 owner storage 使用 `executionModule?.storage ?? data!.storage`；独立宿主新增远端任务 owner，通过 `tasks` dependency 的 read/list/cancel 访问认证学校 owner，并以 2s cadence 驱动通知桥。回归：`repro-task-boundaries.mjs` 的 T6 身份授权例与 `T4 remote task owner dependency` 例（read/list/cancel 均使用调用者自己的 Session，结果在依赖协议校验）；`workspace-agent-tasks.runtime.test.mjs` 9 例覆盖 poll cadence 自动发现终态、同 Turn 多任务通知、Stop 只取消当前 Turn 和重启补投。两机产品部署通过 `repro-deployed-owners.mjs` 验证，结果见下方本轮验收。
- **T5 已修复**：Stop 的取消意图保持 pending 直至迟到受理被处理；`saveToolResult` 在真实 accepted 迟到受理时同事务把 cancel-turn 意图恢复为 pending，并允许替换 Stop 的 interrupted 占位；只有已观察集合投递后才 delivered。回归：`repro-cancellation-late.mjs`。
- **T6 已修复**：`WorkspaceTaskOwner.read(taskId, requester)` 以调用者 session+identity 全字段比较，不匹配返回 null；`taskFacts.relevant` 传入 `{sessionId, input.identity}`；扫描通知也传 registration 的真实 Session/identity。回归：`repro-task-boundaries.mjs` 跨身份秘密不进入调用者模型输入、ownerQueries=0。
- **T7 已修复**：`waitTerminal` 不再只等父 Execution 终态，而是轮询该 operation 的 control receipt/start_session 状态；control applied 即返回 completed，父 session 仍 running 时不发 stop；control taskId 使用本 operation 的 `controlId`，任务 owner 按 control receipt 读取终态；前台等待受 Turn deadline 和 AbortSignal 约束；Stop 时通过幂等 `storage.request` 把 `agent_execution_commands.cancelled=true`、写 `stop_body`；这只是取消意图，只有真实 control receipt 确认后才报告 cancelled，绝不调用 `executions.agent.stop` 取消父 session。回归：`repro-native-operation.mjs` 断言 receiptReads=2、cancelCalls=0、result completed，两个 background control taskId 不同且均不是父 requestId；`repro-task-boundaries.mjs` 的 `T7 control task owner` 例断言 control 从自身 receipt 得到 succeeded、独立取消得到 cancelled、parentStops=0。真实 native owner 的取消确认与父 Session 存活由下方部署验收记录，已生效操作不声称可以撤回。
- **T8 已修复**：`execution-routing.ts` 的跨 Turn original 校验改为 `association.commandId === request.requestId` 与同 scope；`validateAgentExecutionCommands` 不再要求 control 与父 submit 的 runId 相等，改为父 association commandId 等于 control 的 request_id。回归：`repro-capability-regressions.mjs` 与 `repro-migration-and-answer.mjs` 的 validator 检查通过。
- **T9 已修复**：新增 `workspaceAuthority.assertTaskDispatch`：同 activity/session、Turn 为 active/completed、background、已 closed、result accepted 才放行；browser claim 不再要求原 Step 仍 executing。回归：`repro-capability-regressions.mjs` 的 browser 后台受理例。

### MC 系列：模型、预算、压缩与创建

- **MC-01 已修复**：每次 Attempt 前重读 `budgetOf` 重新预留；`attemptUsage` final 精确、unknown 保留 reservation；预算原因归一 `budget_exhausted`；失败重试可容纳两个 unknown 预留。回归：`loop.runtime.test.mjs` 与 `repro-core-runtime.mjs`。
- **MC-02 已修复**：429 后不再使用已关闭 segment；`ensureSegment` 在新 Attempt 前重建，可重试 `upstream-http`。回归：`repro-real-gateway-boundaries.mjs` 验证真实第二次 HTTP 请求与 Attempt 2 completed。
- **MC-03 已修复**：新 Turn 换前缀前先 `settleRecovered` 旧 pendingTools；只在真实存在 pendingTools 时结算，避免 close 带 pending 的 segment 触发 conflict。回归：`repro-real-gateway-boundaries.mjs`。
- **MC-04 已修复**：`runCompaction` 重写计费、Compaction 计数、预算预留、signal/cancel、Turn deadline、`maxPerTurn`，完成但 parse 失败仍记费用，采用前校验 historyDigest。回归：`repro-model-context.mjs`。
- **MC-05 已修复**：通知先按完整 `renderFact` JSON 计数预算再决定裁剪；`registerNotification` 抑制同 task 旧 pending；consumed 通知按 taskId 选最大 `taskVersion`，旧版本不覆盖新版本。回归：`repro-model-context.mjs`。
- **MC-06 已修复**：`store.visibleInputs()` 把已 adopted 但未进入 history 的输入并入 buildContext，并持久化 `setSessionState`，后续完成不覆盖原请求。回归：`repro-model-context.mjs`。
- **MC-07 已修复**：`student_ask` purpose=create 时覆盖为固定确认问题与固定选项；`agent_questions` 新增 `proposal_key`/`content_digest` 与唯一索引；verify 检查 proposalKey 绑定内容、同 key 多个问题视为歧义、固定选项标签、缺失 source/answer 一律拒绝。回归：`repro-capability-regressions.mjs`。
- **MC-08 已修复**：`ToolContext` 增加 `originInputId`/`visibleAnswerInputIds`；`openStep` 把回答输入写入 `answerInbox`；`student_ask` 使用 `ctx.originInputId ?? ctx.inputIds.at(-1)`；verify 接受当前 inputs 或持久可见答案。回归：`repro-capability-regressions.mjs`。
- **MC-09 已修复**：workspace receipt 非 ready 时在同一显式写调用里用固定 requestId 重新 ensure；ensure/adopt 异常返回已完成 projectId/operationId/阶段/state/error；未采纳资料摘要明确写“资料尚未采纳”。回归：`repro-capability-regressions.mjs`。
- **MC-10 已修复**：`create_personal_project` 在 verify、receipt、create、ensure、adopt 前多次 `stopped()`，Stop 后只返回真实已完成部分。回归：`repro-capability-regressions.mjs`。
- **MC-11 已修复**：`model.generate()` 合并 `input.images` 与 history 中全部 images，按 `imageId:version` 去重；`runCompaction` 把 source.messages + remainder 的 images 挂到摘要条目，换 segment/压缩后保留原图与授权来源。回归：`repro-real-gateway-boundaries.mjs` 换 segment 后 payload 仍含 `image_url`/`input_image`。

### 数据、反馈与能力

- **F-MIG-1 已修复**：service 1..9 真实 legacy 布局可升级到 v9（`agent-turn-loop` 替换、1..8 保留）；`displacedTail` 要求 checksum 精确匹配与显式 `formerVersion`。回归：`switch-agent-runtime-data.runtime.test.mjs` 4/4；`repro-migration-and-answer.mjs`。
- **F-DATA-1 已修复**：回答输入专用来源闭包校验（同 session、answered/skipped、answer_request_id、version、固定 operationId、回执匹配）；真实回答后 `validateAgentRuntime` 与 `validateAgentServiceStorage` 通过。回归：`repro-migration-and-answer.mjs`。
- **F-UI-1 已修复**：`agentInputReceiptSchema` 新增动态 `state`/`currentTurnId`（不进入 fingerprint）；`submitInput`/`request`（包括真实 answer 分支）投影当前输入状态；`SessionConversation.tsx` 显示 pending/deferred 文案与样式。回归：`repro-migration-and-answer.mjs` 同时断言首次 submit、Stop 后重复 request、`request` 查询、手动继续后的状态，重复不产生新 Turn 且不清预算阻断；`useAgentSession.test.tsx` 断言 deferred 文案、刷新后仍显示，以及继续后的标签更新。
- **F-UI-2 已修复**：`turnStatusLabel(turn)` 按 state/reason 区分 stopped、interrupted、failed 的 budget/deadline/model-unavailable/protocol-error，替代统一“回答尚未完成”。回归：`useAgentSession.test.tsx` 对 stopped 与 failed budget_exhausted 的 React 组件断言；真实 Chrome 产品 UI 已实际触发 stopped 标签与继续后的预算文案，见下方“真实产品 UI 验收”。
- **F-CAP-1 已修复**：`read_work` 手写 JSON Schema 仅 required `objectId/contentId`，新增可选 `offset/length`；文本 work 返回固定版本切片与 `nextOffset`；`outcomeToResult` 对 summary 8192 截断、outcome_unknown.reason 500 截断，data 保留完整结果；超限时摘要改为结构化 `{state,...data}`，只缩短 `file.value`，保留 `offset/length/total/nextOffset`，不再输出不可读取的假 `result:<sha256>` 引用。回归：`repro-capability-regressions.mjs` 100KB ASCII/中文范围重建、末字符还原、同 Step 双 callId、summary schema、真实 Turn completed、projectResult 完整 data 均断言；通用 `read_tool_result` 没有恢复，仍以 `read_work` 范围读取满足等价能力。
- **F-CAP-2 已修复**：`skills.current()` 同时返回 names；`loadSession` 的 resolve/load 使用同一 toolNames 与 selectionDigest；student 用 `learningToolNames + documents + student_ask`，workspace 用 `workspaceToolNames + documents + student_ask`。回归：`repro-capability-regressions.mjs` 导入声明 `allowed-tools:[read_pdf]` 的 Skill 后 resolve/load 成功，并分别真实装配 student/workspace 场景；未连接真实学校 data-owner 部署。
- **F-CAP-3 已修复**：deferred 输入迁入新 Turn 后 student facts 接受 `input-adopted`，`runId=String(body.turnId)`；不再 corrupt。回归：`repro-capability-regressions.mjs`。
- **F-CAP-4 已修复**：`search_materials` 在 `personalReferences === undefined` 时使用当前授权 `files.personal` 的 currentVersion/sha256 生成 `personalSelections`，同时用于 scope 与 searchReference；显式引用先经 `materials.personal.original` 核对 scope/materialId/version/sha256，`removedAt` 非空或错 sha 抛 `forbidden`；显式 `[]` 仍为空范围。回归：`repro-capability-regressions.mjs` 显示 omitted/显式/显式[]、错 sha/removed 拒绝及 owner 查询隔离；历史显式版本、撤权与“未读取 PDF”仍属未逐一覆盖边界。
- **F-CAP-5 已修复**：`ToolContext.segmentId` 贯穿 loop/module；workspace `imageOutcome` 在 upload 前读取原 segment 的 imageRoute，按 `modelAllowsImages` 校验，不可用返回 `image-capability-unverified` 且不 upload；PDF 在禁图路线同样拦截。回归：`repro-capability-regressions.mjs` PNG image-enabled 成功、PDF image-enabled 上传 1 张、imageInput:false PDF 返回 error 且 uploads=0；新增 `repro-capability-boundaries.mjs` 覆盖 selection 改变、跨 session/owner/identity segment、缺少 Session 与 text-only 组合；上传前必须验证原 segment 的真实 Session。
- **F-DOC-2 已修复**：`packages/agents/README.md`、`student-agent-architecture.md`、`engineering-entrypoints.md`、`agent-runtime-refactor-plan.md` 已改为 Turn/Step v3、sessions v3/dependencies v2，删除已删除 API/旧测试入口的当前引用，并明确历史计划不是 PR #226 验收。

## 二、本轮复审整改

### 失锁后的 Turn 终态

`finishTurn()` 同时校验 Turn owner 与真实宿主锁。在读完待处理事实、写入终态前以及闭合子记录与事件之后再次检查；事务中途失锁抛出 `stale-generation` 并整笔回滚。旧宿主不能把 Turn 写为 completed/failed，新宿主持锁后才将旧 owner 的活跃 Turn 修复为 interrupted。

真实 PG 回归终止 advisory-lock 后端连接，覆盖旧宿主 completed/failed 拒写、新宿主接管，以及 failed 闭合事务末尾失锁时 Turn、Step、Attempt、ToolCall、Question、待处理输入、预算唤醒阻断和事件共同回滚。

### 工具超时与取消

每次工具调用有独立 AbortSignal，向真实执行端传递超时；已进入执行的调用超时保存 `outcome_unknown`，保留真实 taskId/requestRef 与查询提示。只有能证明未进入执行的调用保存 `not_started`。迟到的 accepted 仅补充取消依据，不覆盖已保存的未知结果，也不启用后台完成通知。

复用 `agent_controls` 保存单次调用的持久 `cancel-call` 意图，按 Session/Turn/ToolCall 精确投递到真实 task owner；owner 尚无记录、取消未确认或投递失败时保持 pending，重启后幂等续投。提问和课程操作使用各自业务 deadline，并受 Turn 总预算约束。单次超时、Turn 到期、用户 Stop 与宿主中断使用明确的 signal reason；宿主中断不自动取消已受理的独立任务。

远端工具协议转发 deadline、segment、真实回答来源及 signal；已有 owner 引用取得后停止观察 handle，避免长时间忙轮询。取消可以先于 execute 到达，执行端保留取消标记并在派发前校验。

### 两机验证带出的边界

独立宿主重启时先持锁，暂停阶段不写修复事实；等维护协调器重新开放数据库写闸门，再执行 interrupted 修复和取消续投。真实 PG 回归修复前报 `maintenance`、修复后通过，覆盖暂停时排空、持锁与恢复后正常完成新 Turn。

执行关联持久保存可信 `sessionId`，旧记录才通过真实 Turn 反查 Session；跨机任务 read/cancel 都校验真实 Session 与身份，不能把请求者 Session 当任务来源。独立 Agent profile 的 task owner 接线不依赖学校同机运行 Agent 模块；宿主 poll 会驱动任务观察，避免只有组合部署才能自动投递通知。同一工作区有多个 Session 时，执行授权按持久 Session 精确选择，旧记录按真实 Turn 定位。

真实两机测试还发现控制任务按自身 commandId 关联身份来源会返回空值：只有父提交持有 origin。已改为通过父 requestId 取真实身份，同时保留控制操作自身的 Session/Turn 关联；真实学习数据库结构回归修复前返回空、修复后通过，且保留跨身份/Session 拒绝与 applied 优先断言。

任务在后台 accepted 保存前已经 applied/rejected/cancelled 时，仍保存单个 accepted 回执，终态只经通知进入模型；`repro-native-operation.mjs` 覆盖三种提前终态。

单个 native control 的 `cancel_requested` 与 owner 确认的 `cancelled` 分开；已生效的 control 保留 applied，不以取消意图伪造物理终态。只有 native channel 已持久确认取消的未派发 control 才释放原 expectedSeq，pending、仅有取消意图和未知回执继续占位；补充真实 PG/native 回归，覆盖取消后父进程继续接收输入。图片路由在任何上传前验证 segment 的真实 Session；缺少 Session 时拒绝使用图片能力。

此外修正旧创建确认测试夹具和 Chrome E2E 的 v3 契约/已确认文案，保留原行为断言。native channel 旧验收改为公开 execute 接口及显式幂等重试，保留只读不派发、停止回执丢失、真实进程退出和 ACK 前保持 unknown 的断言。新增 CI `agent-runtime-native` 作业，在校验下载摘要的 PostgreSQL 上运行本轮及既有 PR226 回归。

## 三、本轮验证（2026-11-16）

环境：Node 24.21.0、PostgreSQL 18.6、桌面 Google Chrome。

| 验证 | 实际结果 |
|---|---|
| `node scripts/build.mjs product-runtime:test` | exit 0 |
| `npm run verify` | exit 0；prepare、unit、server、tools 全部通过 |
| 完整门禁用例 | unit 58/59、server 99/100、tools 44/45；各有 1 个既有 skip，不计通过 |
| PR226 工程专项 | 100/100 通过，0 skip；使用 CI 相同清单对最终工程源码整批执行 |
| `repro-tool-timeout.mjs` | 22/22，覆盖迟到外部写入、父 deadline 竞态、远端 signal、真实引用与宿主中断 |
| `repro-call-cancellation.mjs` | 3/3，真实 PG runtime/store/runner/bridge；owner 与 Gateway 为受控 double |
| `repro-capability-boundaries.mjs` | 9/9，真实 PG 与 Gateway/HTTP supplier 边界 |
| `repro-workspace-authority.mjs` | 1/1；修复前 forbidden，修复后精确 Session/旧记录定位及负向断言通过 |
| `native-channel-cancellation.runtime.test.mjs` | 2/2；真实 PG/native，取消意图与 owner 确认、释放序号与父进程隔离 |
| `channel-executions.runtime.test.mjs` | 11/11；真实 PG/native，含停止前后回执丢失与同一原始进程确认 |
| 桌面 Chrome `sessionControl.spec.ts` | 3/3；Stop/继续、同批提问、后台通知；真实 React，HTTP 边界 mock |

本轮专项与既有 PR226 回归的完整文件清单位于 `.github/workflows/verify.yml` 的 `agent-runtime-native` 作业。两份旧夹具不再以取消意图冒充终态；远端工具夹具对齐真实 Step/ToolCall permit，取消与 applied 竞态保留独立断言。

### 真实两机部署

`repro-deployed-owners.mjs` 使用 macOS arm64 与 Linux x64 两机真实产品 host、各自独立 PostgreSQL 18.6、Linux 学校 data/task owner、本机独立 `agent` profile 与 macOS native owner。脚本 exit 0、failures 为空，两机运行同一份最终工程 bundle（SHA-256 `bf60963bc400f9a748e70bbb991afa86ded9cd7ccee82f2ed372d29a412f147f`）。模型供应商为确定性 HTTP fixture，仅控制工具选择，不用于声称真实付费模型或教学效果验收。

| 场景 | 实际结果 |
|---|---|
| 独立 Agent 跨机 tools/descriptors | 真实 `read_teaching_artifact` 成功；错误身份/工作区拒绝，错误 Step permit 返回 stale-generation |
| 同 Turn 两个后台 control | 两个独立 taskId，真实 native 按 seq 1/2 生效；任务 read/list 均确认成功 |
| 跨工作区与旧关联记录 | 无权读返回空、取消拒绝；移除 sessionId 后从独立 Agent 的真实 Turn 反查来源成功；已 applied 回执优先于取消意图 |
| 终态自动投递 | 产品宿主自动为两个后台任务各投递一次通知；没有直接调用 scan/observe 代替产品轮询 |
| 前台与宿主重启 | 前台 seq 3 生效且不增加通知；真实宿主 stop/start 成功，通知 ID 不重复 |
| 排队 control 取消 | 重复取消先保留 running/unknown，未通知终态；恢复领取后真实 owner 确认 cancelled，claimId 仍为空，父进程保持 running、appliedSeq 仍为 3 |
| 取消后继续执行 | 同一个 native PID 接受新操作，appliedSeq 从 3 到 4 |
| 显式取消运行中根任务 | 重复请求后真实 owner 确认 cancelled/confirmed，OS 检查原 PID 已退出 |
| 清理 | native worker、独立 Agent 和学校 host 均停止，本机及远端隔离目录均删除 |

领取故障注入只暂时阻断 claim 请求，真实 register/heartbeat 继续到达 owner，避免验收脚本阻塞 tick 导致父任务租约到期。

回归入口保留为 `scripts/pr226-regressions/repro-deployed-owners.mjs`，一次性数据库、日志、包和截图不作为仓库交付物保留。
