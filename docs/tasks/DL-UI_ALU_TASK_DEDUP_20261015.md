# DL-UI：ALU 任务去重与虚拟板流程核对

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：当前 Agent。状态：分支实现、专项验证及现节点合成复核完成，待合并与部署。

## 1. 依据、范围与授权

Robert 要求解释课程任务列表中的重复卡片，只保留不重复的任务，并确保“四位算术逻辑单元”能完成编码、确认保存、构建、虚拟装载和板卡操作等流程；要求从新分支实施并恰当使用子 Agent。截图显示“合成联动验证”一条和同名 ALU 四条。当前工作树从 `origin/main@5989b96` 建立分支 `codex/alu-task-dedupe-flow`，开工时干净；其他工作树及本机运行服务不改动。

已从 README 进入，检查 Git 状态；按顺序阅读 PRD §1.1、§4.2～4.5、§5、§8～9（PRD-02～05、09～10），MVP_SPEC §1.4、§2、M-03～05、§4～7、§9（DL-AC-01～09，AC-02～07/10/12，NFR-01/03/05），TECH_DESIGN §4.3～5.1、§8.1～8.5、§11～12；并阅读 TEAM_WORK_PLAN §7、§8.6、§9、§11，DL-0 §1～2、I0_UI_SPEC、I0_UI_CLIENT_CONTRACT、IMPORT_SOURCE、DESIGN 的 Overview/Components，以及既有板卡任务 DL-UI_BOARD_INTERACTION_FIX。任务目标限于同一课程任务入口的去重和现有 HDL 操作链的缺陷修复、调用方、专项验证；不改变题目、板型、活动版本、共享字段/状态/权限、实体 FPGA 承诺或真人试点判据。

可写：`apps/student/src/workspace/home.ts`、`apps/student/src/pages/HomePage.tsx`、现有 HDL 工作区/板卡接线中经复现确认的缺陷、相应专项测试、`apps/student/README.md` 的实际使用说明及本文。若证据显示根因在重复发布/分配工具，可窄修该工具及其专项测试并在本文补写精确写集。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、其他任务记录、用户数据/服务配置/凭据及无关工作树。任何数据库 schema 或迁移、受保护文件、密钥/CI、删除文件/目录/历史或公开部署均不在本次默认写集；需要时按对应范围单独处理。

当前授权允许在新分支修复和使用隔离合成数据验证；真实学生编辑、保存、构建、装载和板卡操作只能由学生本人发起。本任务的开发验证不记为真人学习行为。

后续 Robert 明确当前服务为云端共享服务的本地转发 `3445`，并授权删除旧 `3444` 隔离宿主的整个 `/opt/xunjie-ui-local`（含数据和证据）。此项授权不包含专用执行 VM `/opt/xunjie-runner`、云端服务或仓库外 D 盘留存材料。为记录现节点复核与实际使用方式，本任务追加可写 `docs/tasks/evidence/alu-current-node-20261015/**`、`README.md`、`apps/student/README.md`、`tools/i0-hdl/README.md`；原产品、规划、参考和其他任务记录仍只读。

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
| 现有真实引擎依据 | `real-hdl-final-frozen.json` 记录 2026-10-14 隔离合成 ALU 成功构建、装载、实际输出与确认停止；`docs/tasks/DL-UI_BOARD_INTERACTION_FIX.md` 记录既有专用 VM 全板输入 27/27。初次交付时只读检查过旧 3444 环境，本分支未重跑真实 ALU；后续现节点复核见下节。 |
| 文档及写集 | 根目录 `node tools/a0-review/check.mjs`：`errors: []`，其中 `businessTests: NOT_EXECUTED`；`git diff --check`：通过。完整学生端 e2e 未执行，本次只跑关联两个 spec。 |

本次浏览器通过证明分支前端操作链在协议替身下可达；昨日的真实节点收据证明彼时的合成 ALU 运行。教师自动判分的 ALU 行为仍标为 `unverified`，不能声称真值表已自动验收；真人学习与教学效果没有执行。本分支尚未部署到截图中的运行服务，所以该服务当前仍可能显示旧列表。

### 2026-10-15 现节点复核与旧宿主清理

在 Robert 指定的 `https://localhost:3445` 已登录页面，只读 `/api/execution-nodes` 返回 `robert` 的 `cReady=true`、`hdlReady=true`。不代替学生在共享页面创建 Attempt 或操作作品。使用 [合成 ALU 脚本](evidence/alu-current-node-20261015/run.mjs)在同一专用 VM 以新的合成 scope、独立临时账本调用真实 HDL runner；原节点配置只读。客机执行 `/opt/xunjie-runner/node/bin/node /tmp/xunjie-alu-current-node-20261015.mjs /opt/xunjie-runner/config.dlc.robert.json`：真实编译 `succeeded` 且终止确认，显式装载进入 `active`；输入 `0x0943` 得 LED `8`，输入 `0x0635` 得 LED `6`，两次有限 Trace 均覆盖四个 AN/SEG 位选与段码且 `coverage=complete`；Session `stopped` 且终止确认。[结果摘录](evidence/alu-current-node-20261015/result.json)记录逐位输出。客机临时脚本和独立状态目录随后已核对无嵌套挂载并清除。

旧 3444 服务进程已停止，`/opt/xunjie-ui-local` 在确认真实路径、非符号链接、无嵌套挂载及无 3444 监听后按 Robert 明确范围删除；复查目录不存在，3444 健康入口不可达。删除后 WSL 曾随旧宿主退出，导致专用 VM 暂停、云端节点暂时离线；已改用隐藏的独立 WSL 保活进程（本次 PID `48000`）维持 WSL，复用原冻结 `vm.sh start` 启动原 VM，未重建磁盘或身份。随后再次只读确认 3445 的 `robert` C/HDL 都就绪，VM 服务 `active`、本机 `2222` 监听。该保活进程是当前会话的运行状态，Windows 重启后需按私下云端连接手册重新启动成员执行节点；不能把本次恢复说成永久自启配置。

现节点合成测试证明当前专用 VM 的 ALU 源码、真实编译、装载、板卡输入输出与停止链路；它没有经过 3445 的学生保存/构建 API 或浏览器页面。本分支前端协议替身浏览器测试和现节点 runner 测试分层记账，尚不能合称云端共享应用的完整浏览器端到端验收。

追加记录后，`node --check docs/tasks/evidence/alu-current-node-20261015/run.mjs`、结果 JSON 解析、根目录 `node tools/a0-review/check.mjs`（`errors: []`，`businessTests: NOT_EXECUTED`）及 `git diff --check` 均通过；未重复运行已通过且未受代码修改影响的前端专项。

## 4. 交付

初次交付提交 `apps/student/src/workspace/home.ts`、`apps/student/e2e/homeEntry.spec.ts`、`apps/student/README.md` 与本文；后续现节点复核追加上述证据与当前入口文档。分支 `codex/alu-task-dedupe-flow` 以 `origin/main@5989b96` 为基线，未更改截图中的运行服务。产品基线及 MVP_SPEC §10 如需汇总，待授权维护者汇总。
