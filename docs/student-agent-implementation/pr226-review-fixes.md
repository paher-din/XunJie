# PR #226 审查修复交付

- 仓库：`paher-din/XunJie`
- 分支：`feat/agent-runtime-v3-completion`
- 审查基线：`c65d93f5`（base `71a38e8f`）
- 审查包：`XunJie_PR226_repro_pack.zip`
- 结论：审查包列出的 37 项（28 P1、9 P2）均已按审查要求完成源码修复；原先用于展示缺陷的见证脚本已改写为断言正确行为的正式回归。桌面 Chrome 产品 UI 已完成真实手测；真实两机/独立 owner 也已用隔离部署完成数据面验收，剩余未闭合的边界在文末单列，不用源码测试冒充。
- 说明：本轮代码已推送到 `origin/feat/agent-runtime-v3-completion`（`f98abcf1`），PR #226 随分支更新；未在 PR 发表评论，未改动审查包或生产数据。源码主体修复在 `c7cf0d17`，验收补丁在 `6e7cf7bd`，设备接入 `incompatible`→409 修复在 `c77a212b`；本文档更新单独提交。

## 一、修复内容（逐 ID）

### K 系列：宿主所有权与终止

- **K01 已修复**：`runtime.ts` 统一 `acquireLock()`；正式 readOnly resume 也先取得并持续持有 `agent-host:<env>/<service>` 独占锁，完成 `recoverInterrupted` 后才开放 dispatch；`dispatchOpen` 必须持锁。回归：`repro-core-runtime.mjs` 第 1 例在真实 PG 上验证另一连接不能取得同一锁。
- **K02 已修复**：`tools.ts` 在 await 返回后、写结果前调用 `isActive()`；`store.ts` 的 `ownedTurn`/`assertOwner` 校验 owner、Turn 状态、Step 状态，保存结果和 `step-completed` 都在短事务中完成。回归：`repro-core-runtime.mjs` 第 2 例切断真实锁后端连接，旧宿主的迟到结果与 Step 完成均被拒绝。
- **K03 已修复**：`runtime.ts` 的 `armTurn/disarmTurn` 按 Turn deadline abort 同一个 signal；`tools.ts` 的 `bounded()` 超时取 `min(now+maxCallMs, budget.deadline)`；`model.ts` 的 receive/dispatch/progress/read 全部走 `raceAbort`，Stop 在轮询等待中也 cancel 上游。回归：`repro-core-runtime.mjs` 硬截止与轮询 Stop 两例。
- **K04 已修复**：`store.closeTurnCalls()` 闭合 Turn 失败/Stop 后所有开放 Step、ToolCall、问题；`recoverInterrupted` 修复终态 Turn 仍有开放子记录的崩溃窗口。回归：`repro-core-runtime.mjs` failed、Stop、重启修复三例。
- **K05 已修复**：启动修复先读取真实已答/未答结果，不再用 unknown 覆盖回答；`answeredResult` 与 `closeTurnCalls` 分离。回归：`repro-core-runtime.mjs` restart 参数化两例。
- **K06 已修复**：Stop 只对真实持久取消意图 deliver+wake；旧 completed Turn 的通知仍能唤醒空闲会话，空闲时 `openPendingTurn`。回归：`repro-core-runtime.mjs` 旧通知唤醒例。
- **K07（P2）已修复**：`registerNotification` 拒绝缺失来源的通知，避免新 Turn 被无 origin 的通知接纳。回归：`repro-core-runtime.mjs` missing origin 例。

### T 系列：任务、工作区与所有权

- **T1 已修复**：`store.workspaceInputs()` 读取 Session 中所有已 adopted 且有 action 的输入；`resolveWorkspace` 只要求至少一个合法 action，Step 2 不依赖新输入。回归：`repro-task-boundaries.mjs` 实际工作区 Step2 断言 `modelCalls=2`、Turn completed、2 Steps。
- **T2 已修复**：`AgentSessionDependencies.tools()` 不再返回空数组；wire context 转发 `sessionState`、inputIds；student/workspace 场景按唯一名合并远端工具与本地 `questions`/documents/skills，并修复 workspace 的 remote 分支只返回远端工具、丢掉本地 questions/documents/skills 的问题。回归：`repro-task-boundaries.mjs` 通过真实依赖协议 `tools.execute` 执行 `read_pdf` 并断言上下文转发；`repro-capability-regressions.mjs` 分别用 `createStudentAssistant`/`createWorkspaceAssistant` 的真实场景装配加载声明 `allowed-tools:[read_pdf]` 的 Skill。
- **T3 已修复**：`teachingDefinitions` 的每个 `course_operation` anyOf 分支 properties 均加入可选 `executionMode`，根 properties 同时保留；默认/ background/ foreground 均被真实 Gateway AJV 接受。回归：`repro-task-boundaries.mjs` 用实际 `compileOutputSchema` 三个断言。
- **T4 已修复**：产品 host 的 `poll()` 调用 `sessionAgent.observe()`；任务 owner storage 使用 `executionModule?.storage ?? data!.storage`；独立宿主新增远端任务 owner，通过 `tasks` dependency 的 read/list/cancel 访问认证学校 owner，并以 2s cadence 驱动通知桥。回归：`repro-task-boundaries.mjs` 的 T6 身份授权例与 `T4 remote task owner dependency` 例（read/list/cancel 均使用调用者自己的 Session，结果在依赖协议校验）；`workspace-agent-tasks.runtime.test.mjs` 9 例覆盖 poll cadence 自动发现终态、同 Turn 多任务通知、Stop 只取消当前 Turn 和重启补投。真实两机的数据 owner/Agent owner 身份与独立 PostgreSQL 已在下方验收中跑通；两机终态通知自动投递仍未单独证明。
- **T5 已修复**：Stop 的取消意图保持 pending 直至迟到受理被处理；`saveToolResult` 在真实 accepted 迟到受理时同事务把 cancel-turn 意图恢复为 pending，并允许替换 Stop 的 interrupted 占位；只有已观察集合投递后才 delivered。回归：`repro-cancellation-late.mjs`。
- **T6 已修复**：`WorkspaceTaskOwner.read(taskId, requester)` 以调用者 session+identity 全字段比较，不匹配返回 null；`taskFacts.relevant` 传入 `{sessionId, input.identity}`；扫描通知也传 registration 的真实 Session/identity。回归：`repro-task-boundaries.mjs` 跨身份秘密不进入调用者模型输入、ownerQueries=0。
- **T7 已修复**：`waitTerminal` 不再只等父 Execution 终态，而是轮询该 operation 的 control receipt/start_session 状态；control applied 即返回 completed，父 session 仍 running 时不发 stop；control taskId 使用本 operation 的 `controlId`，任务 owner 按 control receipt 读取终态；前台等待受 Turn deadline 和 AbortSignal 约束；Stop 时通过幂等 `storage.request` 把 `agent_execution_commands.cancelled=true`、写 `stop_body`，`fact()` 返回 `cancelled`，绝不调用 `executions.agent.stop` 取消父 session。回归：`repro-native-operation.mjs` 断言 receiptReads=2、cancelCalls=0、result completed，两个 background control taskId 不同且均不是父 requestId；`repro-task-boundaries.mjs` 的 `T7 control task owner` 例断言 control 从自身 receipt 得到 succeeded、独立取消得到 cancelled、parentStops=0。真实 native owner 的物理停止仍是部署验收边界。
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
- **F-CAP-5 已修复**：`ToolContext.segmentId` 贯穿 loop/module；workspace `imageOutcome` 在 upload 前读取原 segment 的 imageRoute，按 `modelAllowsImages` 校验，不可用返回 `image-capability-unverified` 且不 upload；PDF 在禁图路线同样拦截。回归：`repro-capability-regressions.mjs` PNG image-enabled 成功、PDF image-enabled 上传 1 张、imageInput:false PDF 返回 error 且 uploads=0；工具产生后用户改变 selection、跨 session/owner 借用 segment 与 text-only 组合仍未逐一跑。
- **F-DOC-2 已修复**：`packages/agents/README.md`、`student-agent-architecture.md`、`engineering-entrypoints.md`、`agent-runtime-refactor-plan.md` 已改为 Turn/Step v3、sessions v3/dependencies v2，删除已删除 API/旧测试入口的当前引用，并明确历史计划不是 PR #226 验收。

## 二、正式回归与验证

环境：Node 24.21.0（`/Users/robertwu/.local/node/node-v24.21.0-darwin-arm64/bin`），PostgreSQL 18.6（`/opt/homebrew/opt/postgresql@18/bin`）。

已执行并通过：

```bash
node scripts/build.mjs typecheck                         # 0
node --test packages/agent-runtime/test/loop.runtime.test.mjs   # 20/20 pass
node --test scripts/switch-agent-runtime-data.runtime.test.mjs  # 4/4 pass
node --test scripts/pr226-regressions/repro-core-runtime.mjs           # 10/10 pass
node --test scripts/pr226-regressions/repro-model-context.mjs          # 1/1 pass
node --test scripts/pr226-regressions/repro-real-gateway-boundaries.mjs # 1/1 pass
node --test scripts/pr226-regressions/repro-task-boundaries.mjs        # 1/1 pass
node --test scripts/pr226-regressions/repro-cancellation-late.mjs      # 1/1 pass
node --test scripts/pr226-regressions/repro-native-operation.mjs       # 1/1 pass
node --test scripts/pr226-regressions/repro-migration-and-answer.mjs   # 1/1 pass
node --test scripts/pr226-regressions/repro-capability-regressions.mjs # 1/1 pass
node --test packages/product-runtime/test/workspace-agent-tasks.runtime.test.mjs # 9/9 pass
node --test packages/product-runtime/test/school-device-setup.runtime.test.mjs # 1/1 pass（incompatible→409）
cd apps/web && npx vitest run src/product/useAgentSession.test.tsx # 9/9 pass
```

回归脚本位于 `scripts/pr226-regressions/`，均使用正式产品 factory/真实 PG/真实 Gateway 边界或实际函数，不再把“缺陷仍存在”当作通过。关键输出包括：K01 锁竞争、K02 失锁拒写、T1 Step2 实际模型调用=2、T4 read/list/cancel 依赖调用、T6 ownerQueries=0、T7 cancelCalls=0、taskIds 独立、control 自身 receipt/独立取消且 parentStops=0、F-CAP-1 大结果 Turn completed、F-CAP-5 PNG success/PDF image-enabled 上传=1/imageInput:false uploads=0。

## 三、真实产品 UI 与两机数据面验收（2026-11-16）

环境：本机默认产品环境复制到 `/tmp/xunjie-pr226-ui`，使用 `npm run dev:product -- --root /tmp/xunjie-pr226-ui`；浏览器为真实桌面 Chrome，Playwright `channel: 'chrome'`、`headless: false`。未在默认环境上写入。

已实际观察：

1. 打开 `http://127.0.0.1:57417/`，真实模型 `deepseek-flash` 可用，发送“请先不要创建项目。请调用 student_ask 工具……”后收到回复；页面出现固定三选项“现在建立 / 暂不建立 / 继续讨论”、输入框、“发送回应 / 跳过”、“等待回应或原操作结果。”与“停止回答”（`/tmp/xunjie-ui-ask.png`）。这是 F-UI-1 pending 文案的真实产品证据。
2. 点击“停止回答”，页面显示“你已停止这次回答，原问题和内容已保留。”与“继续回答”（`/tmp/xunjie-ui-stop2.png`）。这是 F-UI-2 stopped 标签的真实产品证据。
3. 点击“继续回答”，真实进入下一轮并显示“本次回答已达到预算上限，原问题和内容已保留；可以继续回答。”（`/tmp/xunjie-ui-resume.png`）。这是预算耗尽/继续文案的真实产品证据。

### 两机数据面

在远程 Ubuntu 24.04.5 主机安装当前分支的隔离学校 `pr226-school`：environment `c0d79ce7-d780-4052-a074-24cbf103d600`，仅部署 `space-course` + `learning-data`，独立 PostgreSQL systemIdentifier `7708437421697903045`（端口 32971）。本机产品以独立 device（一次运行 environment `c800205e-e95e-47fb-a9d8-0e30cabb2649`，部署 `space-course` + `teaching-agent` + `model-connection` + `tool-execution`，独立 PostgreSQL systemIdentifier `7708439358694848249`，端口 58171）通过真实 SSH 隧道连接学校，完成：

- 学校成员创建、登录与设备连接批准；
- `client/start` → `connections/approve` → `client/complete`，`setupPending=false`；
- 学校 owner 创建 activity，`agent-sessions/workspace` 返回 session `920eead9-aa4b-4262-9524-e90250c3adcb`；
- 该 session 的 `identity` 属于远程学校环境，`owner.target` 指向本机 `teaching-agent`，`deviceModules` 在本机 `space-course` 等单元。

这证明数据 owner（远程学校）与 Agent/执行 owner（本机设备）真实分属两机、两个独立 PostgreSQL 数据库；不是本机同一环境或 mock。本文将“真实两机数据面已通过”和“两机终态通知仍未证明”分开记录。


## 四、未执行或未完全覆盖（不冒充通过）

- **T4 两机终态通知未验收**：上述两机数据面已通过，但两条真实终端任务终态由产品 host 自动产生一次通知（未手工 scan）、restart 只一次、前台不通知仍未在真实两机部署证明；仅有 9 例单机真实 PG 回归（含 poll cadence 自动发现终态）。
- **T7 dispatching control 的物理取消未验收**：代码已实现执行账本 `cancelled=true`/`stop_body`/`fact()` cancel 且不取消父 session；真实 native owner 是否物理停止、native operation 状态枚举是否新增 cancelled，尚未在部署上验证。
- **F-CAP-1 通用 reader 未恢复**：以 `read_work` 的 `offset/nextOffset` 范围读取和结构化摘要满足等价能力；`read_tool_result` 通用入口、错误 digest/越界/跨 session/撤权的通用 reader 断言未做。
- **F-CAP-2 未连真实学校 data-owner 的 tools 路径**：student/workspace 真实场景装配与 Skill 加载已测，且已建立真实学校 data-owner 的 workspace session；但通过 dependencyChannel 从学校 owner 取得 tools/descriptors 并在两机执行尚未单独断言。
- **F-CAP-4/5 边界未逐一跑**：历史显式版本、撤权、未读取 PDF 不被当已搜索；工具产生后用户改变 selection、跨 session/owner segment、text-only work 等组合未逐一覆盖。
- **T2 未做完整独立 Agent 部署**：依赖协议 `tools.execute` 已在真实 `read_pdf` 调用上验证，且已建立本机 device 到学校 data-owner 的 workspace session；但没有用 `createStandaloneAgentApplication` 独立 agent profile 跑通全部业务工具，wrongidentity/wrongworkspace/wrongpermit 未分别端到端。
- 分支已推送至 `origin/feat/agent-runtime-v3-completion`（`f98abcf1`），PR #226 已随分支更新；本轮未在 PR 发表评论，也不代表审查报告授权合并或发布。
