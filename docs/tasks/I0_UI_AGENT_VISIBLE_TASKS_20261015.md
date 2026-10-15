# I0-UI：独立 Agent 与首页使用一致的可见任务

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：PR #109 待审查；共享实例尚未运行本次代码。

## 依据、授权与范围

Robert 报告：课程首页「四位算术逻辑单元」只有一张任务卡，独立 Agent 却回答四条同名分配，回复底部也没有可进入工作区的卡。当前指令授权修复这条已接通的本人任务读取及入口链路，不改变任务正文、作品、分配记录或完成状态判据。

开工从 README 进入；当前工作树 `origin/main@575ed9e`，干净、独立，创建 `codex/agent-visible-task-cards`。已按顺序阅读 PRD §1.1、§3.2、§4.2/4.5、§5、§8～9（PRD-02/03/04/09/10），MVP_SPEC §1.4、§2、M-02/03/04/09/10、§4、§6～7（DL-AC-01/08、AC-02/05/06），TECH_DESIGN §3.3、§4.1/4.3/4.4、§5、§6.1/6.2；并读现有 [Agent 上下文](I0_UI_AGENT_TASK_CONTEXT_20261015.md)、[任务卡](I0_UI_AGENT_TASK_CARD_20261015.md)、[ALU 首页去重](DL-UI_ALU_TASK_DEDUP_20261015.md)、I0_UI_SPEC、I0_UI_CLIENT_CONTRACT 与学生端 IMPORT_SOURCE 的相关正文。前次用户决定保留：只有明确指向单项本人任务才出现一张卡，多项真实任务不能随机挑选。

可写：本任务记录、`apps/teaching/server/personal-agent/student-tasks.ts`、`service.ts` 与 `integration.test.ts`、使用方式变更所需的 `apps/student/README.md`。集成测试是必要接缝：只有真实本人分配快照同时进入模型上下文和回复卡核验，才能复现本次两个症状；单测一个标题匹配函数不足以验证。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、其他任务记录、真实课程数据、服务配置及其他工作树。本次不更改数据库 schema、共享字段、权限、模型供应商配置、CI 或部署。

## 诊断与方案

现有首页按本人、同课程、展示标题、学生可见活动正文及材料、帮助政策和运行配置，把历次内容相同的分配折成一个入口；开放项优先，同状态取稳定列表末项，旧 Assignment/Attempt 和深链保留。此前四个 ALU ID 是四次合成验证产生的不同分配，首页代表项为 `f4caed76-39b5-461a-bc5f-2325d8495d69`。独立 Agent 的 `readStudentTasks` 返回原始分配，模型据此说“四条”；回复核验要求标题只命中一条，四条同名因歧义而不附卡。这是两个可见投影的口径差异，不是凭空生成的任务。

方案：服务端任务快照复用现有获准的学生活动投影，按首页同一内容键与代表分配规则折叠后，再交给模型和回复卡片核验。按折叠后的可见任务计 100 项上限及 `hasMore`。同名但正文/材料/政策/运行配置不同的活动继续分开；多项回复、部分列表、失败或无唯一标题继续不出卡。卡的目标 ID 仍由服务端本人分配给出，点击后工作区照常重新验权。现有历史消息保持原持久结果，不回填或改写过去回答。

验收：用四条相同活动分配复现首页一项而 Agent 原先四项/无卡；修复后 Agent 上下文只含一个可见 ALU，单项回复产生与首页同 ID 的卡且历史保留。同名不同内容不被合并；暂停与可用优先、跨课程/账号隔离、部分清单和未知完成状态继续正确。记录实际执行的专项、类型/构建、浏览器及文档检查，分别说明未执行项。

## 实施与验证

- `apps/teaching/server/personal-agent/student-tasks.ts` 使用现有 `activityView` 学生公开投影，按首页的 `studentId/executionKind/displayTitle/content/helpPolicy/runtimeProfileVersionId/execution` 内容键在课程内折叠历史分配；开放项优先，同状态取稳定 ID 列表末项。只把代表分配交给模型及服务端任务卡核验，折叠之后再计算 100 项上限和 `hasMore`。为避免同步事务无上限读取，单次最多扫描 1000 条原始分配；超过时明确返回读取失败，不向模型提交可能选错代表项的部分结果。该规模边界需要后续业务量达到前再设计分页或持久投影，不作为本次教学验收通过。保留有效学生成员、账号与原工作区的权限检查，不修改任何历史 Assignment、Attempt 或深链。
- `service.ts` 在已触发的本人任务上下文中明确提示：旧回复可能按历史原始分配计数，本轮以当前可见任务快照为准；旧历史消息本身不改写。
- `integration.test.ts` 新增四次发布同一 HDL 活动并设置与活动标题不同的 ALU 展示标题的正式应用夹具：改动前 23/24 通过，首版新用例准确复现原始四条而预期一条的失败；修复后 24/24 通过，验证 `hdl_board` 学生分配、本轮模型上下文只含一个 ALU 分配 ID、成功落定及历史消息的卡指向该 ID、该 ID 的授权工作区 bootstrap 可读、暂停代表后选择另一开放分配，以及同名不同正文继续分开。既有 `student-tasks.test.ts` 1/1 通过，仍覆盖跨账号、非学生成员、私有内容和暂停不等于完成。`apps/teaching` 的本地 `tsc --noEmit` 通过。
- Windows 本机 Node 为 24.15，低于项目固定的 24.21；包脚本运行时门禁未跳过。专项测试由 `node --input-type=module -e` 注册只对缺失包回退到同锁文件 D 盘教学目录的依赖解析，再导入上述测试文件执行。当前工作树运行 `npm ci --ignore-scripts --engine-strict=false --no-audit --no-fund` 后，直接运行 `node node_modules/typescript/bin/tsc --noEmit` 通过。这里是本机离线合成验证，不是正式包脚本门禁、真实模型或共享云端验收。
- 共享 HTTPS 页面的新 Chrome 标签在修复前读到本账号数字逻辑课程只有一个 ALU 卡；点击进入 `/#/task/f4caed76-39b5-461a-bc5f-2325d8495d69`，工作区显示就绪，未开始 Attempt。用户随后确认首页现为一张卡。本次服务端代码尚未在该实例运行，Agent 新回复和卡片的浏览器复验待代码交付后进行；旧历史消息不会自动改写。
- `apps/student/README.md` 同步独立对话的可见任务折叠、卡片与旧深链行为。合并最新 `origin/main@514a4cd9f6ae128e01ec874571e5d7036355166f` 后，服务端专项 25/25、本地 `tsc --noEmit`、仓库根 `node tools/a0-review/check.mjs`（149 篇文档、2011 条链接、`errors=[]`）和 `git diff --check origin/main...HEAD` 均通过；主线同期新增的工作区 Attempt 恢复文件无本任务写集重叠。

交付：本任务提交 `e10f515` 与最新主线合并后推送到 `codex/agent-visible-task-cards`，创建 [PR #109](https://github.com/paher-din/XunJie/pull/109)。PR 可合并，检查列表为空，不计 CI 通过；尚未合并。主线合并会触发共享实例自动部署，依工作空间的生产部署红线须取得覆盖范围的负责人同意。获同意后再确认部署版本，并在合成账号下分别复验真实模型新会话与旧会话追问。旧历史消息仍保留原回复，不回填。

产品基线及 MVP_SPEC §10：待授权维护者汇总。
