# I0-UI：跨浏览器工作区作品读取失败

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：诊断中，未宣布修复。

## 依据与范围

Robert 指出从 Agent 任务卡进入的内置浏览器工作区显示“作品没有读取成功”，追问是否已修复。本任务仅处理这条失败链路，保留既有作品、草稿、命令和其他工作树。开工基线 `origin/main@575ed9e28cfa7e0f4fe395163a227004c433c01d`，分支 `codex/workspace-attempt-recovery`。

已读 README §功能概览/开始使用；PRD §5 PRD-03/09/10；MVP_SPEC §3 M-03/04；TECH_DESIGN §5 的 Attempt/读取契约与 §7 恢复；`I0_UI_CLIENT_CONTRACT.md` §5 和 `I0_UI_03_CONFIRM_SNAPSHOT.md` 的学生显式创建、确认头、本机事务边界；`C0_ADR_0001_UNIFIED_RECOVERY.md` 的恢复代际候选。适用 M-03、PRD-09、AC-03/12；不把页面“就绪”当作作品读取成功。

可写：本任务记录、必要的学生工作区/服务端只读恢复接线及专项验证、实际使用方式变化时的 README。`docs/product/**`、`docs/planning/**`、`docs/reference/**`、AGENTS 规范和其他任务记录只读。新增共享接口/字段若确有必要，先写具体提案并取得负责人确认；不清除浏览器 IndexedDB、不代学生发起 Attempt 命令或修改真实作品。

## 已复现与边界

- 内置浏览器同一任务 `assignmentId=220b2dae-5070-42ff-a165-daaf681a0644`，“重新读取”后稳定回到 `phase=error`，提示“作品没有读取成功”；其 `loadEpoch` 从 15 增至 17。控制台 `workspace.read-failed` 记录了事件，但浏览器工具只返回折叠的 `Object`，未给出具体错误文本。
- 云端 `remoteCommit=deployedCommit=575ed9e2...`、`upToDate=true`、`serviceActive=true`。只读 SQLite 核对：此本人分配有 1 个 `submitted` Attempt、1 个文件、3 个快照、1 个提交；学生课程成员有效。所有文件/快照摘要与清单摘要一致。用当前部署源码、只读数据库句柄执行 `loadWorkspace` 和 `readWorkspace` 成功，返回相同数目和状态。
- 同一账号和同一 URL 在 Chrome 的独立浏览器存储中读出“作品只读、确认作品 v2、已冻结快照 v2、words.c”；保留该标签供核对。内置浏览器的错误由 `confirmationWorkspace.readHead` 的通用 catch 产生，确切异常尚未取得。现有“恢复 Attempt”在已有本机 attemptId 时只重复 `readHead`，因此不把它当成已验证的修复步骤。
- 之前 `I0_UI_AGENT_TASK_CARD_20261015.md` 中“工作区就绪”只证明任务路由与 bootstrap；本次发现其作品链验收不足。卡片指向正确任务，不能据此宣称内置浏览器可恢复作品。

## 方案与验收

先把现有开发者控制台诊断的错误文本序列化为可读的一行；该字段原本就在控制台详情中，不能增加正文、凭据或敏感内容。取得内置浏览器的具体异常后，以最窄复现测试锁定失败边界。若问题在本机代际/确认头，修其判断并保留草稿与原命令；若需跨浏览器发现当前 Attempt，提出只读、本人授权、不创建/续期/激活的共享契约，请负责人确认后实施。

第一步仅修改 `apps/student/src/workspace/diagnostics.ts` 的 `workspace.read-failed` 控制台格式，原有详情字段与学生界面不变。`rtk npm run typecheck`、`rtk npm run build`、`rtk git diff --check` 均通过；构建只有既有的 chunk size 提示。此改动只是取回诊断，不记作故障修复。部署后再读内置浏览器同一错误的具体文本。

验收需在原内置浏览器同一任务中重试：实际显示已提交的 Attempt、确认作品 v2、快照和文件；刷新仍可读。另测没有本机引用、错误/旧引用、并行标签、不同学生/课程、未决原命令和终态只读，不从浏览器清空状态来制造通过。Chrome 结果、隔离测试与内置浏览器真实恢复分别报告。

产品基线与 MVP_SPEC §10 汇总：待授权维护者汇总。
