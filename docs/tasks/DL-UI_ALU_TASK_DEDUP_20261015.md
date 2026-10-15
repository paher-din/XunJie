# DL-UI：ALU 任务去重与虚拟板流程核对

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：当前 Agent。状态：分支实现及专项验证完成，待合并与部署。

## 1. 依据、范围与授权

Robert 要求解释课程任务列表中的重复卡片，只保留不重复的任务，并确保“四位算术逻辑单元”能完成编码、确认保存、构建、虚拟装载和板卡操作等流程；要求从新分支实施并恰当使用子 Agent。截图显示“合成联动验证”一条和同名 ALU 四条。当前工作树从 `origin/main@5989b96` 建立分支 `codex/alu-task-dedupe-flow`，开工时干净；其他工作树及本机运行服务不改动。

已从 README 进入，检查 Git 状态；按顺序阅读 PRD §1.1、§4.2～4.5、§5、§8～9（PRD-02～05、09～10），MVP_SPEC §1.4、§2、M-03～05、§4～7、§9（DL-AC-01～09，AC-02～07/10/12，NFR-01/03/05），TECH_DESIGN §4.3～5.1、§8.1～8.5、§11～12；并阅读 TEAM_WORK_PLAN §7、§8.6、§9、§11，DL-0 §1～2、I0_UI_SPEC、I0_UI_CLIENT_CONTRACT、IMPORT_SOURCE、DESIGN 的 Overview/Components，以及既有板卡任务 DL-UI_BOARD_INTERACTION_FIX。任务目标限于同一课程任务入口的去重和现有 HDL 操作链的缺陷修复、调用方、专项验证；不改变题目、板型、活动版本、共享字段/状态/权限、实体 FPGA 承诺或真人试点判据。

可写：`apps/student/src/workspace/home.ts`、`apps/student/src/pages/HomePage.tsx`、现有 HDL 工作区/板卡接线中经复现确认的缺陷、相应专项测试、`apps/student/README.md` 的实际使用说明及本文。若证据显示根因在重复发布/分配工具，可窄修该工具及其专项测试并在本文补写精确写集。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、其他任务记录、用户数据/服务配置/凭据及无关工作树。任何数据库 schema 或迁移、受保护文件、密钥/CI、删除文件/目录/历史或公开部署均不在本次默认写集；需要时按对应范围单独处理。

当前授权允许在新分支修复和使用隔离合成数据验证；真实学生编辑、保存、构建、装载和板卡操作只能由学生本人发起。本任务的开发验证不记为真人学习行为。

## 2. 诊断、决定与改动

两名只读子 Agent 分别追溯了重复数据与 HDL 链路，主 Agent 核对证据并实现。截图中的四张“四位算术逻辑单元”不是单条数据重复渲染；它们分别是旧验证批次生成的 `d36d8430…`、`d44eb578…`、`e6d99397…`、`f4caed76…` Assignment，每批使用新幂等键发布内容相同的 Blueprint/Activity 并分配给同一合成学生。来源是 `docs/tasks/evidence/dla-continuation-20261014/real-hdl.mjs`；现有后端课程列表逐条返回全部分配，前端原样逐条展示。另一个“合成联动验证：教师下发 HDL 任务”是独立分配，保留。

在 `apps/student/src/workspace/home.ts` 只对学生可见列表做语义去重：同一课程、学生、执行类型、展示标题、完整活动正文/材料、帮助政策与运行配置一致时显示一个入口。活动控制仍按原 Assignment 生效；有效分配优先，同状态以当前服务列表最后一项作为入口。上述四条中落在 `f4caed76…`，其历史收据包含成功 Build、Session、板卡输入及确认停止（`docs/tasks/evidence/dla-continuation-20261014/real-hdl-final-frozen.json`）。不同活动内容或目标仍单列。没有更改服务端记录、Attempt、Build、Session、原深链或权限。当前列表接口不暴露各分配的作品进度，故通用规则不能声称总能选择作品进度最高的一条；需要时学生仍可沿旧深链访问原记录。

`apps/student/e2e/homeEntry.spec.ts` 增加截图场景：四条相同 ALU 只出现一张卡，独立教师验证卡仍在，点击进入选定分配，旧 ID 仍走原 bootstrap，目标不同的 ALU 版本不被合并。修复前该用例因五张卡而失败。`apps/student/README.md` 同步列表行为与记录入口。

首次修复后专项中，该新用例因在旧深链页面初始化完成前断言请求而失败；改为等待工作区显示不可用状态再核对 bootstrap，复跑通过。此处是测试异步时序问题，未修改业务服务。

## 3. 验证与边界

| 层次 | 实际结果 |
| --- | --- |
| 首页和工作区浏览器专项 | `XUNJIE_E2E_BROWSER_CHANNEL=chrome`、独立端口 5861/5862/5863 下，`rtk npm run test:e2e -- homeEntry.spec.ts hdlRealWorkflow.spec.ts --workers=2`：16/16 通过。涵盖编辑 `.sv`、确认保存 ACK、冻结快照、错误诊断、成功 Build、显式装载、16 SW、5 BTN、RESET_N、LED/AN/SEG/DP、推进、Trace、刷新、停止与重装；服务端为隔离协议替身。 |
| 类型与产物 | `rtk npm run typecheck` 通过；`rtk npm run build` 通过，Vite 既有资源引用和大 chunk 提示。 |
| HDL 单元 | `rtk npm test -- src/workspace/hdlWorkspace.test.ts src/workspace/home.test.ts`：实际执行既有 `hdlWorkspace.test.ts` 15/15；仓库无 `home.test.ts`，该参数未产生额外测试。 |
| 现有真实引擎依据 | `real-hdl-final-frozen.json` 记录 2026-10-14 隔离合成 ALU 成功构建、装载、实际输出与确认停止；`docs/tasks/DL-UI_BOARD_INTERACTION_FIX.md` 记录既有专用 VM 全板输入 27/27。2026-10-15 只读 `pwsh -NoProfile -File tools/i0-hdl/xunjie-local.ps1 status` 显示本机 VM ready、HTTPS live/ready 均 200；本次未向该服务发送学生写操作，也未重跑目标 VM 的真实 ALU 构建。 |
| 文档及写集 | 根目录 `node tools/a0-review/check.mjs`：`errors: []`，其中 `businessTests: NOT_EXECUTED`；`git diff --check`：通过。完整学生端 e2e 未执行，本次只跑关联两个 spec。 |

本次浏览器通过证明分支前端操作链在协议替身下可达；昨日的真实节点收据证明彼时的合成 ALU 运行。二者不能合写为“本分支已在当前真实节点完成端到端验收”。教师自动判分的 ALU 行为仍标为 `unverified`，不能声称真值表已自动验收；真人学习与教学效果没有执行。本分支尚未部署到截图中的运行服务，所以该服务当前仍可能显示旧列表。

## 4. 交付

本次只提交 `apps/student/src/workspace/home.ts`、`apps/student/e2e/homeEntry.spec.ts`、`apps/student/README.md` 与本文。分支 `codex/alu-task-dedupe-flow` 以 `origin/main@5989b96` 为基线，未更改截图中的运行服务。产品基线及 MVP_SPEC §10 如需汇总，待授权维护者汇总。
