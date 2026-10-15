# I0-UI：跨浏览器工作区作品读取失败

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：本次演示会话的原内置浏览器故障已修复并复验；教学效果验收不在本次范围。

## 依据与范围

Robert 指出从 Agent 任务卡进入的内置浏览器工作区显示“作品没有读取成功”，追问是否已修复。本任务仅处理这条失败链路，保留既有作品、草稿、命令和其他工作树。开工基线 `origin/main@575ed9e28cfa7e0f4fe395163a227004c433c01d`，分支 `codex/workspace-attempt-recovery`。

已读 README §功能概览/开始使用；PRD §5 PRD-03/09/10；MVP_SPEC §3 M-03/04；TECH_DESIGN §5 的 Attempt/读取契约与 §7 恢复；`I0_UI_CLIENT_CONTRACT.md` §5 和 `I0_UI_03_CONFIRM_SNAPSHOT.md` 的学生显式创建、确认头、本机事务边界；`C0_ADR_0001_UNIFIED_RECOVERY.md` 的恢复代际候选。适用 M-03、PRD-09、AC-03/12；不把页面“就绪”当作作品读取成功。

可写：本任务记录、必要的学生工作区/服务端只读恢复接线及专项验证、实际使用方式变化时的 README。`docs/product/**`、`docs/planning/**`、`docs/reference/**`、AGENTS 规范和其他任务记录只读。新增共享接口/字段若确有必要，先写具体提案并取得负责人确认；不清除浏览器 IndexedDB、不代学生发起 Attempt 命令或修改真实作品。

## 已复现与边界

- 内置浏览器同一任务 `assignmentId=220b2dae-5070-42ff-a165-daaf681a0644`，“重新读取”后稳定回到 `phase=error`，提示“作品没有读取成功”；其 `loadEpoch` 从 15 增至 17。控制台 `workspace.read-failed` 记录了事件，但浏览器工具只返回折叠的 `Object`，未给出具体错误文本。
- 云端 `remoteCommit=deployedCommit=575ed9e2...`、`upToDate=true`、`serviceActive=true`。只读 SQLite 核对：此本人分配有 1 个 `submitted` Attempt、1 个文件、3 个快照、1 个提交；学生课程成员有效。所有文件/快照摘要与清单摘要一致。用当前部署源码、只读数据库句柄执行 `loadWorkspace` 和 `readWorkspace` 成功，返回相同数目和状态。
- 同一账号和同一 URL 在 Chrome 的独立浏览器存储中读出“作品只读、确认作品 v2、已冻结快照 v2、words.c”；保留该标签供核对。内置浏览器的错误由 `confirmationWorkspace.readHead` 的通用 catch 产生，确切异常尚未取得。现有“恢复 Attempt”在已有本机 attemptId 时只重复 `readHead`，因此不把它当成已验证的修复步骤。
- 之前 `I0_UI_AGENT_TASK_CARD_20261015.md` 中“工作区就绪”只证明任务路由与 bootstrap；本次发现其作品链验收不足。卡片指向正确任务，不能据此宣称内置浏览器可恢复作品。
- 诊断版本 `main@2b5980bc268be256e18e64effd31ea0344a282a3` 已由既有自动部署器部署，`remoteCommit=deployedCommit`、`upToDate=true`、`serviceActive=true`。原内置浏览器刷新后，`GET /api/attempts/1f1114ef-8b53-4629-8fcb-b6c6a7f23d51` 返回 `FORBIDDEN` 403；只读数据库查询确认这个旧 Attempt ID 当前不存在。该任务现存的本人 Attempt 是 `ba4db2e2-172a-4e9a-bc21-c05fd6ab9c7b`，Chrome 使用不同本机存储可读其已提交作品。根因是客户端只从 IndexedDB 拿 Attempt 引用，任务 bootstrap 明确不发现当前 Attempt；旧引用失效后没有只读恢复入口。

## 方案与验收

先把现有开发者控制台诊断的错误文本序列化为可读的一行；该字段原本就在控制台详情中，不能增加正文、凭据或敏感内容。取得内置浏览器的具体异常后，以最窄复现测试锁定失败边界。若问题在本机代际/确认头，修其判断并保留草稿与原命令；若需跨浏览器发现当前 Attempt，提出只读、本人授权、不创建/续期/激活的共享契约，请负责人确认后实施。

第一步仅修改 `apps/student/src/workspace/diagnostics.ts` 的 `workspace.read-failed` 控制台格式，原有详情字段与学生界面不变。`rtk npm run typecheck`、`rtk npm run build`、`rtk git diff --check` 均通过；构建只有既有的 chunk size 提示。此改动只是取回诊断，不记作故障修复。部署后再读内置浏览器同一错误的具体文本。

## 共享读取契约提案（已批准）

给现有 `GET /api/assignments/:id/bootstrap` 的学生本人响应增加 `currentAttemptId: string | null`。服务端在与任务授权相同的只读事务中查询该分配现存的本人 Attempt；没有则返回 `null`，不创建、不续期、不激活、不更改作品。教师响应不携带该字段。学生端先以这一服务端引用选择要读的 Attempt，再核验 `GET /api/attempts/:id` 的归属和作品；本机旧引用、草稿、原命令和快照继续保留且不重放。旧引用与服务端不同或服务端为 `null` 时，界面只转到当前服务事实；旧原命令仍按现有同 Attempt/代际规则核对，不冒充当前作品的命令。相应更新客户端契约、服务端 schema、必要的 TECH_DESIGN 验收汇总请求；产品基线仍交授权维护者。

不以一次 403 自动删除本机引用：403 同时可能表示权限变化，不能把它等同“旧 Attempt 不存在”。改用经授权的任务读取确定当前 ID，避免猜测与越权。此提案涉及共享字段，按工作空间规范先取得负责人对该字段及其读取范围的明确确认，再实施依赖此字段的代码。

## 批准、实现与验证

Robert 在本会话于 2026-10-15 明确批准上述 `currentAttemptId: string | null` 学生本人只读字段及不创建、不清除本机记录的范围。服务端 `apps/teaching/contracts/design/i0.ts` 与 `server/app/original-job-host.ts` 在原分配授权的同一只读事务查询本人的当前 Attempt，教师响应不带该字段；没有 Attempt 时返回 `null`。学生端 `workspace/contracts.ts`、`init.ts`、`confirmationWorkspace.ts` 以此字段选择当前读取目标，不以本机旧引用回退；服务端仍对 `GET /api/attempts/:id` 核归属，安装本机确认头前再核当前 bootstrap。旧草稿、原命令和快照不删除、不迁移、不自动重放。修复只改变读取路径，没有 schema 迁移和新写命令。

专项验证：

- `node --test server/app/i0.test.ts`：10/10 通过，包含首次读取 `null` 且数据库无 Attempt、学生显式创建后只读取得同一 ID、教师不获该字段、跨学生拒绝。
- `npm test -- src/workspace/init.test.ts src/workspace/confirmationWorkspace.test.ts`：28/28 通过，包含旧本机引用不覆盖服务端当前 ID、服务端为 `null` 时不恢复旧 ID、无自动写命令。
- `apps/student` 的 `npm run typecheck`、`npm run build` 通过；`apps/teaching` 用项目要求的 Linux Node 24.21 执行 `tsc --noEmit` 通过。学生构建只有既有 chunk-size 提示。
- `node tools/a0-review/check.mjs`：148 份文档、2008 条内链，`errors=[]`。

交付与原故障复验：修复经 [PR #107](https://github.com/paher-din/XunJie/pull/107) 合入 `main@0b8956eb6895fbcae938b7054cedfa29b94f5cdd`。既有云端同步器回报 `remoteCommit=deployedCommit=0b8956eb...`、`upToDate=true`、`serviceActive=true`。原内置浏览器、原账号和同一任务链接重载后，页面实际显示“作品只读、确认作品 v2、已冻结快照 v2”、`words.c` 及文件版本 v2；第二次刷新仍读出这些信息，不再显示“作品没有读取成功”。只读数据库复核仍为 1 个 `submitted` Attempt、1 个文件、3 个快照，读取未新建 Attempt。Chrome 独立浏览器此前已读出相同作品，但本次修复的关键证据是原内置浏览器恢复。

边界：本次使用已获准的合成演示会话观察，不代学生输入、保存或运行；不将工程读取复验表述成真人教学效果。旧本机草稿在界面仍标“已保护”，未清除；未执行旧原命令重放。产品基线与 MVP_SPEC §10 汇总：待授权维护者汇总。

未执行的扩大验证：并行标签和另一个真实学生浏览器、旧 Attempt 上实际未决原命令的核对流程；本次没有这些受控前提，不记作通过。专项测试已覆盖无本机引用、错误/旧引用、跨学生拒绝和无自动写入，原内置浏览器已覆盖终态只读与刷新。未清空浏览器存储来制造通过。
