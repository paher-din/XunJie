# I0-UI：独立 Agent 对话读取本人课程任务

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：代码实现并完成隔离验证；共享云端实例待交付。

## 依据、范围与授权

Robert 在循阶侧边栏「Agent 对话」询问“我现在有什么任务还没完成”时，收到“没有任务列表”的回复，明确要求把相关信息链路接通。本次授权范围为该独立聊天对本人课程任务的只读查询与回答；不推导课程进度写入、完成判定、页面重设计或真实学生数据发送许可。

已读 README 当前入口；PRD §3/5/8 的学生进入、角色可见和数据边界（PRD-02/04/10）；MVP_SPEC §2、M-02/05/09/10 与 AC-02/06；TECH_DESIGN §4.3/4.4、§5、§6.1/6.2、§9 的身份、投影、上下文与权限；I0_UI_SPEC 的真实/准备模式约束、I0_UI_CLIENT_CONTRACT §2/3、apps/student/IMPORT_SOURCE.md；现有个人模型与独立聊天任务、首页真实任务入口和看板数据核查。

开工基线为 `origin/main@956f527be82fd0e9ea591a8c72a7d1280e58f243`，本次独立工作树干净，分支 `codex/agent-task-context`。交付前重放到 `origin/main@68f5ae91244bcfa52bc4493c284590e91c8cc3df`；仅 `apps/student/README.md` 相邻段落冲突，保留首页吉祥物入口说明与本任务上下文说明。原工作树及其他会话在途内容不动。

可写：本任务记录；`apps/teaching/server/personal-agent/**` 的任务上下文读取与生成接线、对应测试；`apps/teaching/server/app/personal-models.ts`、`app/i0.ts`、`app/digital-logic.ts` 的必要接线；实际使用方式若改变可同步 README。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、其他任务与设计仓库。无需数据库 schema、凭据、CI/CD 或 UI 布局改动。

## 问题与实施方案

真实模式的前端 `RealAgentApi.listTasks()` 固定返回 `[]`；独立聊天服务的模型输入只有本会话历史。首页已能从本人 Session 读取课程分配与固定活动标题，但这些值没有进入独立聊天。现有分配 `active/paused` 仅表示开放状态，没有任务完成字段；Attempt 的 submitted/reviewed 也不等于任务完成，见 [看板数据核查](I0-UI_DASHBOARD_DISPLAY_DATA.md)。

在独立聊天明确询问本人课程任务时，服务端按已认证账号读取**当前本人作为学生的有效课程成员关系**、本人分配、固定活动公开标题和开放/暂停状态；仅把这个有界摘要交给本轮模型。非任务问题不读取或发送任务数据。模型上下文注明这不是完成清单，不能把分配、提交或审阅推断为完成；无分配和读取失败分别处理。新聊天与后续明确任务提问都从当前库重读，不能依赖先前会话。身份只取服务端 Session，不接受用户文本里的账号/课程 ID 作为权限依据。

验收：以截图原句复现此前模型输入缺少任务数据；修复后合成账号 A/B 分别只得到本人公开任务，教师或别的学生任务、教师私有材料不进入模型输入；暂停与空列表准确；普通闲聊不发送任务数据；读取失败不能伪称“没有任务”；完成状态保持未知。运行相称的服务端专项、类型检查和仓库文档检查。

## 待决定事项

若要**精确列出未完成任务**，需由负责人和对应模块明确业务完成判据及授权的状态来源。当前只交付可核查的本人分配与开放状态，并在回复中说明完成状态未知。产品基线及 MVP_SPEC §10：待授权维护者汇总。

## 实施与验证记录

- `server/personal-agent/student-tasks.ts` 只读本人有效学生成员关系、分配和固定活动公开标题；41 表显示列存在时优先使用分配标题和课程名，旧库没有显示列时仍可读。返回上限 100 项，更多项明确标记部分列表。
- `server/personal-agent/service.ts` 只在本人任务提问及承接追问时读取快照，作为本轮模型系统上下文；原句“我现在有什么任务还没完成”已覆盖。读取失败拒绝本轮并回滚新问题，避免模型错误声称无任务。`app/personal-models.ts` 和两个宿主工厂接入原认证账号与业务库。没有修改 UI、schema、密钥或模型配置。
- Windows Node 24.15：`rtk proxy node --test server/personal-agent/integration.test.ts server/personal-agent/student-tasks.test.ts server/app/personal-models.test.ts`，重放前后均 26/26 通过。曾先用原句新增红测，旧代码未读取任务，随后接线转绿。Linux Node 24.21：`tsc --noEmit` 重放前后通过。仓库根 `node tools/a0-review/check.mjs`：重放后 142 篇文档、2069 条链接、错误 0；`git diff --check origin/main...HEAD` 通过。
- 一次试图在合成测试的业务事务中用 `ALTER TABLE` 扩展显示列，被数据库的“Approved data statements only”守卫按设计拒绝；测试中的该尝试已撤销，随后原专项 1/1 通过。共享数据没有变更 schema。C 工作树经跨盘 `node_modules` 联接执行 `tsc -p tsconfig.build.json` 曾在 declaration 生成阶段因跨盘引用失败；无输出类型检查通过，本机宿主的 build 配置类型检查也通过。
- 本机 `https://127.0.0.1:3444` 属独立合成数据宿主；先核实无在途工作并备份原服务文件，更新服务端源文件后，原工厂的 `tsc -p tsconfig.build.json --noEmit`、`/health/live` 和 `/health/ready` 通过。该检查没有调用真实供应商模型，也不代表共享云端验收。
- 用户截图对应 `https://localhost:3445`，由本机 SSH 转发至共享云端循阶。浏览器确认同一登录账号首页可见 7 个真实分配，而原独立聊天仍答复“没有任务列表”；此运行实例尚未接收本次代码。共享实例的模型回答、真实浏览器回合及真人学习均未计通过。

交付剩余：代码合入共享服务的正式来源并同步运行实例后，以该账号重新询问原句，核对回复确实列出本人分配、没有臆称完成状态，并核对运行版本。产品基线及 MVP_SPEC §10：待授权维护者汇总。
