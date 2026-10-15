# I0-UI：独立 Agent 回复的课程任务卡与工作区入口

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：实施中。

## 依据与授权

Robert 要求从 `D:\XunJie_Project\XunJie_Design` 核对既有设计，在正式项目接通“涉及课程任务的 Agent 回复 → 回复底部任务卡 → 对应任务工作区”。本次明确选择：一条回复只有**明确指向单项本人任务**时显示一张卡；涉及多项任务的回复不任意挑选一项或自行扩展多卡。设计仓库 `8df47963ebf9d4b27a4c3b084c8c5304f3d6e23c` 的 `docs/home-design.md` §全局 Agent 对话页、`docs/agent-page-design.md` §消息内块及 `app/src/pages/AgentPage.tsx` 已读：卡在回复正文下，卡内「进入任务」直接去 `/task/:taskId`，留在历史；丝滑展开过渡、多任务卡尚未交付。正式项目 `docs/DESIGN.md` §Layout/Components 和 `apps/student/IMPORT_SOURCE.md` §4 说明已同步的样式与选择性来源边界。

项目正文已读：README 当前入口；PRD §1、§3.2、§4、§5、§8（PRD-02/03/04/09/10）；MVP_SPEC §2、§3 M-02/03/04/05/09/10；TECH_DESIGN §3.3、§4.1/4.3/4.4、§5、§6.1/6.2；`I0_UI_SPEC.md` 的 Problem/Solution/实施决定、`I0_UI_CLIENT_CONTRACT.md` §7/8。现有本人任务上下文见 `I0_UI_AGENT_TASK_CONTEXT_20261015.md`。工作区由学生选择进入，课程与分配权限由服务端会话校验；未确认的完成状态不能推断。

## 范围、现状与方案

开工基线：`origin/main@179fde64ea596b4f3135b5ed3bb859819ed14b10`，分支 `codex/agent-task-workspace-cards`，工作树干净。可写：本任务记录，`apps/teaching/server/personal-agent/**` 的任务引用与专项测试，`apps/student/src/pages/AgentPage.tsx`、`bridge/agentApi.ts`、`bridge/types.ts` 的卡片接线及必要测试，真实使用方式变化时的 README。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、根/目录 `AGENTS.md`、其他任务记录和 Design 仓库。

当前正式服务只把本人分配的 `assignmentId/courseId/title/availability` 注入模型提示；回合消息没有可信任务引用。真实前端 `listTasks()` 固定返回空列表，且消息适配器会丢弃演示 `taskId`，所以现有 `TaskEntryCard` 从不出现在真实 Agent 回复。首页已有 `/task/:assignmentId` 的正式入口，工作区 `TaskRoute` 已按真实分配 ID 分流。

复用现有卡片与工作区路由。服务端在回复成功落定后，从**已认证本人当前有效学生分配快照**核对最终回复中唯一出现的完整任务标题；不采用模型声称的 ID、用户声称的课程 ID 或未经核验的链接。普通闲聊的任务快照仅用于服务端核对回复，不发给模型；任务提问仍按需把只读摘要发给模型。只有唯一匹配且清单完整时才随历史消息持久化这个引用；停止、失败、多匹配、同名、无匹配及部分清单不显示卡。真实卡只展示有来源的课程名、任务标题、开放/暂停，完成状态保持未知；进度、阶段、截止时间当前无真实来源，不复用演示值。进入按钮使用编码后的 assignmentId，工作区照常重新验权，旧历史引用不授予访问权。保留准备模式的原卡片与生成卡行为。

验收：单一本人任务问题在真实回合终态及历史读取均有卡；点击进入同一分配工作区。多任务、同名歧义、无任务、其他学生/教师、普通闲聊、停止/失败均不冒出错误卡；读取失败不误称没有任务。现有 UI 和后端专项、类型检查、构建与合成浏览器验证按实际改动执行，真实云端/模型/真人分开记录。

## 实施与验证记录

- 服务端：`apps/teaching/server/personal-agent/service.ts` 在回复落定时核对本人任务标题，写入结构化 `taskCard`，随回合轮询和会话历史返回；`types.ts` 定义卡片字段。任务快照读取失败时保留已成功的正文，不造入口。多项或同名均不猜测。`integration.test.ts` 覆盖本人唯一命中、历史保留、跨账号拒读、多项/同名/部分清单、无关回复、无任务词问题和供应商失败。
- 客户端：`apps/student/src/bridge/agentApi.ts` 验证并保留服务端卡片字段，`types.ts` 声明契约；`pages/AgentPage.tsx` 在真实 Agent 回复底部使用既有卡片样式，按钮进入 `/task/<encoded assignmentId>`。真实卡不展示演示进度/阶段/截止时间；准备模式原卡保留。`agentApi.test.ts` 覆盖回合与历史适配及非落定卡拒绝；`e2e/personalAgent.spec.ts` 用隔离协议替身验证历史卡点击后读取同一分配的授权 bootstrap、工作区就绪及重开历史仍有卡。
- `node --test apps/teaching/server/personal-agent/integration.test.ts`：23/23 通过；首次因提问分类漏掉“同步计数器怎么做”而失败，扩展问题识别后通过。
- Node 24.21 Linux `tsc --noEmit`（`apps/teaching`）：通过；Windows Node 24.15 执行包脚本先被固定运行时门禁拒绝，未当作代码失败。
- `apps/student`：`rtk npm test -- agentApi.test.ts` 7/7；`rtk npm run typecheck` 通过；`rtk npm run build` 通过（仅既有 chunk size 提示）。首次测试把连接恢复错误当成直接解析错误，改从历史读取断言后通过。
- Chrome `rtk npm run test:e2e -- e2e/personalAgent.spec.ts --grep 单项任务回复卡`：1/1 通过。默认 Playwright Chromium 浏览器包未安装，首次启动失败；改用已安装 Chrome 同一用例通过。该项是本机合成 HTTP/browser 接线验证，不代表共享云端、真实模型或教学效果验收。
- 根目录 `node tools/a0-review/check.mjs`：145 篇文档、2077 条内部链接、`errors=[]`；`git diff --check` 通过。README 与学生使用说明已同步。

真实共享云端与真实模型下的卡片尚未验收；发布状态需按本任务交付结果补记。产品基线及 MVP_SPEC §10：待授权维护者汇总。
