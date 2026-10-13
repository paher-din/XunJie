# I0-C55：PR #55 外部审查 R1～R3 修复

日期：2026-10-14（Asia/Shanghai）。执行者：Robert委托的Agent。状态：R1～R3代码修复与35项离线回归通过，Git交付中。

## 1. 授权与依据

Robert最初要求代完成[指定给A的任务](https://github.com/paher-din/XunJie/pull/55#issuecomment-6152088547)，随后明确实审由「审查PR反馈方式」完成、本聊天直接接收结果；收到交付包后进一步要求“你一并完成问题修复”。本次据此修复交付包R1～R3，属于当前明确授权的验证器/手册范围，不从其他Agent的建议推导权限。

固定C基线：`d86e51e8b09f283e9249d0e85e70cc4df873aff9`，独立worktree/分支`codex/c55-review-fixes`；A手册另在`codex/i0-a-c55-followup`、以PR #53 head `fe6d301896603be258e5f6b942037c194429db93`为基线。两分支分别交付，不复制A应用源码到C材料分支，不触碰原并行目录。

已读：当前README/AGENTS；PRD §1、§3～5、§8～9；MVP_SPEC §1.1～1.3、§2～6；TECH_DESIGN §2/4/5/7/8.1～8.4/9～12；TEAM §1～2及§8.1/8.4～8.5；A固定手册§17.5及I0-ENTRY §9～10；C closeout §13、三份验证脚本与原公开证据；外部完整审查报告/反馈稿、复现脚本与结果。正文已于本会话读取；适用PRD-02/09/10、M-02/09/10、AC-02/06/12/15、NFR-04及H-01～H-06。未变更产品或共享契约。

交付包来源：Robert附件`XunJie_PR55_审查与反馈包.zip`，SHA-256=`2b52131a02f57bc8da08a7d98bba9a9b45747a3233c9af9f937d4608b376ee6a`。外部审查固定同一C head，最小复现Node22.16.0；意见是输入材料，附件中的发布/运行建议不作为操作授权。本批按其已经定位的根因构建当前脚本回归，停止重复审查。

## 2. 写集、实现方案与判据

可写：本文；`evidence/dla-c-handoff/prepare-ui-handoff.mjs`、`verify-entry-https.mjs`；同目录必要的无依赖公共验证helper/针对错误分支的回归测试；`evidence/c55-review-fixes/`本批去敏离线结果。A手册补正及第5步映射归A分支任务。只读：原C作者记录/旧JSON/日志、prepare-entry.mjs、全部应用源码/契约/依赖、product/planning/reference/AGENTS/README、真实库/秘密/CI/节点。后续验证器现场执行仍需原窗口；新增输出限于原获准根目录的独立review-fix子目录，不覆写旧输出。

- R1：将HTTPS响应回调/TLS核验/解析异常与response error/aborted/提前close变成Promise拒绝，保证外层catch/finally；子进程与日志流错误也走受控清理。对两份实际脚本同类路径修复，不使用全局吞异常。
- R2：按实际exit或信号退出确认已停止；超时保持unknown/未确认，保留PID/exitCode/signalCode/失败阶段。只发送原应用SIGTERM，不强杀节点或其他进程。
- R3：对当前合法字段和投影补实质断言，拒绝空对象/错误profile/私有材料未裁剪；A明确readiness的已有预检/发布/冻结记录映射，不补造GET字段。使用原归档正确响应离线补核，新增离线结果不覆盖原20/20。

完成判据：当前实际请求/清理/第5项代码能被回归反例驱动；旧基线在该回归失败、修复后通过；200正例和503/非法JSON/响应错误/提前关闭均受控；正常/信号退出与超时元数据如实；错误投影拒绝、原正确投影通过；语法、文档/空白及精确写集检查通过。原成功、失败、ID、数据库与未知保留。

本批仅开发隔离验证，不启动PAHER教学HTTPS或执行节点、不读秘密、不建库、不发真实学生操作、不更改信任/节点、不重跑完整HTTPS/C1或浏览器。复用已有Node24.21.0 Linux portable runtime，通过本机WSL2执行无依赖测试；未安装依赖或修改WSL配置。现场/模型/HDL/NFR/真人仍按原门禁。公开推送/PR与合并/发布分别记录；产品基线及MVP_SPEC §10待授权维护者汇总。

## 3. 实现、验证与交付

### 3.1 实现位置与行为

- [公共helper](evidence/dla-c-handoff/entry-verification-helpers.mjs)：HTTPS响应/TLS回调、error/aborted/提前close只结算一次并拒绝；进程/stdout/stderr/log error进入受控Promise；原子观察exit/signal并只发送本人child的SIGTERM。未知为serviceState=unknown/serviceRunning=null/stopConfirmed=false，保留PID/退出码/信号；日志收尾期间取得退出证据则更新为已停止。
- [UI交接](evidence/dla-c-handoff/prepare-ui-handoff.mjs)：JSON/状态断言移到可拒绝的async路径，错误保存去敏code/failureStage并执行原finally；成功/失败停止状态分开。输出放原受控根下的独立0700目录、wx/0600文件，旧handoff与日志不覆写。
- [HTTPS验证器](evidence/dla-c-handoff/verify-entry-https.mjs)：同类响应/进程错误修复；API非法JSON拒绝并只记省略事实，HTML/资产保持字节摘要；执行失败与case通过计数分别记录。独立输出目录和一次显式执行的executionId，不换未知Job/Run，单批重放沿原键/正文；原unknown轮询规则保留。
- 第5项核实际GET的ID/课程/sourceRevision/控制revision/profile/helpPolicy及student/tutor材料投影，私有项必须严格仅status:redacted；公开正文/hash核原公开回执。以原24表只读连接读取activity_versions并核原JSON摘要，核冻结activity/蓝图/revision/G与预检的sourceHash/fingerprintHash/validatedAt及checkedAt。公开结果仅包含非秘密运行配置/readiness，不写完整含私有材料的活动正文。没有扩业务API或修改表。

运行两份修复验证器时，须同时使用同目录entry-verification-helpers.mjs；原应用业务源仍固定9fa76ad，不能将验证脚本commit当应用部署源。真实调用未在本批发生，新角色GET和原只读冻结记录仍需后续现场补验，旧student投影可离线补核。

### 3.2 实际验证与失败记录

回归：[entry-verification.test.mjs](evidence/dla-c-handoff/entry-verification.test.mjs)，实际提取当前两份脚本的request、UI finally和第5项回调，注入合成I/O；原归档正确student响应与定向错误响应分开。代码提取只为测试这些专用开发脚本，不调用它们的顶层现场启动逻辑。无现场秘密/库/节点，结果不并入原20项现场统计。

```sh
node --test --test-reporter=tap docs/tasks/evidence/dla-c-handoff/entry-verification.test.mjs
node --check docs/tasks/evidence/dla-c-handoff/entry-verification-helpers.mjs
node --check docs/tasks/evidence/dla-c-handoff/entry-verification.test.mjs
node --check docs/tasks/evidence/dla-c-handoff/prepare-ui-handoff.mjs
node --check docs/tasks/evidence/dla-c-handoff/verify-entry-https.mjs
node docs/tasks/evidence/dla-c-handoff/verify-entry-https.mjs --self-check
node tools/a0-review/check.mjs
git diff --check
```

首次夹具中timeout的mock destroy没有转发req.error，已改为模拟真实请求错误；此首次草稿7通过/23失败/2跳过不作有效基线。修正夹具后，在原脚本/Windows Node24.15.0运行32项：9通过、21失败、2个尚无新helper的专项跳过，明确复现R1～R3。新增helper与修复后同一核心回归全部通过；首次修复绿灯前，原归档正例暴露测试teacher替身缺user.id，补真实合成user结构，应用/判据未放宽。

最终Linux/WSL2 Node24.21.0：35/35通过，0失败/取消/跳过；新增资产正例防止API解析修复破坏HTML读取，新增停止超时后日志收尾期间观察到exit的竞态检查。四文件语法及原ID unknown→终态自检通过。完整结果见[verification.json](evidence/c55-review-fixes/verification.json)。C原c-entry-https与i0-c-revalidation目录Git差异为空；旧JSON/日志未改。文档初检66份/960内链、完整记录追加后66份/965内链，均errors=[]；差异空白通过。

未执行：PAHER真实HTTPS/main/C1重跑、新tutor实际请求及冻结记录读取、浏览器/模型/HDL/NFR/真人/教学效果。未运行无应用源码改动的全仓构建/业务回归。主工作目录及其他worktree未写；没有残留临时解压/安装文件。

### 3.3 交付与恢复

本批拟本地提交精确6文件：本任务、两份验证器、公共helper、回归及去敏verification.json。基于PR #55的独立分支，不改原作者分支；A两份文档另作基于PR #53的独立提交。公开推送/两个Draft PR尚未执行，不自动合并或改变#30/#22状态。负责人批准后按两个父分支分别普通推送/建Draft，不发布Review/comment或给其他聊天发消息。

需要恢复时用独立revert回退本批脚本/文档提交，保留所有原/新证据，不删除或重写Git历史。产品基线及MVP_SPEC §10待授权维护者汇总。
