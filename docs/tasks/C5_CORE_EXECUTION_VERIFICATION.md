# C5：两课程执行核心验证

日期：2026-10-15（Asia/Shanghai）；角色：C；Issue：[C5 #63](https://github.com/paher-din/XunJie/issues/63)。

## 1. 依据、授权与固定版本

负责人本次指令：完成 issue C5。执行范围按 [P4 决定](P4_DEADLINE_CORE_VERIFICATION.md) §2–5 和 #63；不是完整 P4/P5、真人或教学效果验收。

按 README → AGENTS → PRD → MVP_SPEC → TECH_DESIGN 阅读：PRD §3–8（PRD-03/05/07/09/10）；MVP §1.4、M-03/07/09/10、§4–6/8（AC-04/06/10/12/15，NFR-03/04，DL-AC-02–07）；TECH §4.1/4.3–5.1、§7.1–7.5、§8.1–8.5、§10–12。另读 TEAM §7–8、DL-0 §1–2、DL-C §3–11、顺序集成记录、工程衔接、I0-C §9–10、DL-A 续作 §1–10、PR56 集成/现场交接、UI_SPEC/CLIENT_CONTRACT 与 IMPORT_SOURCE 的接入和证据边界。

原工作区 HEAD 为 `0e683251031f28b3d2458e9f9093c8d92aa859b3`，已有 README、planning/product/G3、DLA/I0 记录和证据改动。保留，不覆盖、暂存或提交。只读 fetch 后固定远端 main=`37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`，独立 managed worktree / `codex/c5-core-verification` 实施。

可写：本文、`docs/tasks/evidence/c5-core/` 的本批验证脚本/去敏原始证据、README 的 C5 导航；如出现本域根因缺陷，先记录最小源码/调用方写集再修复。规范、product/planning/reference、他人任务、UI 源码、依赖/锁与配置只读。

沿既有批准的 Node24.21.0/原 lock、PAHER 应用 SSH/known_hosts、专属 VM 和合成测试资源执行。复用 DL-A §15.7 已批准的 fresh-only 精确35表工厂，仅新建并保留隔离合成库，不迁移既有库；不操作正在学习的账号/会话。仅复用现有受控配置/账号材料于内存，不输出认证正文/秘密，不编辑凭据，不调用模型。当前 H3 源码已获准，节点/镜像换版尚未批准：本次不部署 H3，也不把旧节点 fingerprint 写成当前未部署 runner 的通过。

公开推送、发布 PR/Issue 评论或关闭 Issue 尚未执行；成品验证齐备后按 AGENTS 红线申请准确发布范围。产品/MVP §10：待授权维护者汇总。

## 2. 最小补验方案与判据

复用历史证据前核原 SHA、命令、环境/配置/原输出 hash；对照当前源码、契约与调用方差异。现场节点当前 C/HDL readiness、指纹、代际及空闲状态只读核查；当前应用通过公开 HTTP 命令、真实35表事务、原消费者和受认证真实节点补验，`app.inject` 仅代替网络传输，不代替 runner。

| 核心项 | 必需补验/复用 |
| --- | --- |
| C5-CORE-01 | 当前应用真实 C 编译/运行/检查，确认快照/hash/profile；stdout passed 不能冒充课程通过；复用节点限额/隔离已核证据 |
| C5-CORE-02 | 当前应用真实 HDL Build/持续 Session；LED/段选/位选、X/Z、有限波形/模拟时间来自原节点；错误/修订同输入有真实差异 |
| C5-CORE-03 | ACK/不可变快照、运行期间新保存不污染旧对象；新构建/显式替换绑定新版本并初始化；原操作重复/丢响应保持原身份 |
| C5-CORE-04 | 两真实 Session 独立状态且 C 作业仍可运行；跨scope/旧版本拒绝；停止确认退出后再释放，必要语法错误/未知对账；复用真实路径/网络/资源边界证据并列限制 |

服务端、节点、浏览器证据分列。当前实际 UI 的 HDL 页面缺口仍归 UI；不新建替代页面，不从 Node/TAP 结果勾浏览器表现。完整负载/性能分布、大规模故障矩阵、长时稳定性、完整备份恢复/导出矩阵、H3真实2800向量、模型/人工语义、真人按原任务后续验收，未执行不记通过。

## 3. 实施、失败与验证

本批服务端/真实节点核心验证完成，未修改生产实现；完整浏览器与后续验收保持未执行。固定应用 `37b628b`、旧批准节点 `sourceHash=7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852` 为两个不同部署边界，不把仓库 H3 新 runner 计入目标验收。

### 3.1 本轮环境与命令

隔离副本由固定 main 的 `git archive` 原 blob 展开到新 Linux 原生目录，原应用 lock 相对现场 `87edd51` 没有差异，复用其已批准依赖。实际 Node `v24.21.0`、SQLite `3.53.4`、TypeScript `7.0.2`。无新依赖、schema 变更/旧库迁移或节点安装；fresh-only 原35表工厂、原合成账号与内存认证材料按§1使用。所有新合成库关闭后保留。

从隔离副本 `apps/teaching` 实际执行：

```sh
npm run typecheck
npm run build
node --test --test-concurrency=1 --test-reporter=tap tests/dl-a-app.test.ts tests/dl-a-hdl-help.test.ts server/workspace/integration.test.ts server/workspace/runs.test.ts server/workspace/hdl.test.ts runner/hdl-profile.test.ts runner/control.test.ts runner/snapshot.test.ts
```

类型/构建退出0。专项73项：71通过、0失败/取消、2真实C1开关未启用的跳过；跳过不计通过。原始 [TAP](evidence/c5-core/targeted.tap.gz)、[可读TAP](evidence/c5-core/targeted.tap)、[类型](evidence/c5-core/typecheck.txt)、[构建](evidence/c5-core/build.txt) 与原字节/显示摘要见 [汇总](evidence/c5-core/summary.json)。此为受影响接缝专项，没有重跑全仓/浏览器或负载统计。

真实节点补验命令（`sourceRoot` 是固定应用副本，`outputFile` 为新输出路径；不得在真实学习会话运行）：

```sh
node docs/tasks/evidence/c5-core/verify-real.mjs "$sourceRoot" "$outputFile"
```

[验证脚本](evidence/c5-core/verify-real.mjs) 仅在原PAHER/root受控身份运行，复用现有账号/签名/SSH引用；不监听或换版现场服务，不请求模型。通过 `app.inject` 的公开正常HTTP命令、真实认证/35表事务、原消费者与受认证真实VM执行；472份非登录公开HTTP响应是轮询/业务事实，不能当作472个独立测试或NFR性能样本。完整 [原结果](evidence/c5-core/real-fourth.json) 记录固定快照、hash/配置、真实帧/模拟时间、Job、诊断与退出；没有 cookie/CSRF/密码/私钥正文。实际命令的第四版与入库脚本只差未使用 import 的移除，执行逻辑/断言不变。

### 3.2 核心逐项裁定

| 项目 | 本轮实测/复用结果 | 边界 |
| --- | --- | --- |
| C5-CORE-01 / AC-04/10/15 | 本轮真实 C 编译执行 `passed`，运行中保存非法新草稿仍执行旧确认快照；同旧快照课程检查明确 `failed`。真实 C Job 在两条 HDL 会话活跃时成功，固定 profile/镜像/输入/hash 与结果对应；原节点全部 C 限额/隔离证据复用 | stdout、执行成功和课程判定分开；不是完整负载/公平调度统计 |
| C5-CORE-02 / DL-AC-03–06 | 同Session连续3周期→2周期保持计数3→5，重复原操作不推进；新 RTL 同输入计数6，段码由 `0000011` 变 `1111100`；真实AN动态扫描、X/Z=`x0z1010`；400次采样保留丢帧/incomplete与真实模拟时间 | 原始引擎信号/有限Trace通过；实际UI绘制、同浏览器修复链未执行，不宣称整项DL-AC通过 |
| C5-CORE-03 / AC-04/12、DL-AC-02/04/06 | 保存ACK后新快照/hash不同，原Session/Operation/Trace仍绑定旧快照；新Build/显式replace先确认旧Session终止，再创建新身份，初始LED为0；同键交互返回原operationId/sequence；当前专项补在途Trace、未知原身份对账/丢响应与授权守卫 | 本轮真实持久因果通过；整项浏览器刷新/本机草稿/全部恢复未执行 |
| C5-CORE-04 / AC-06/10/12、NFR-03/04、DL-AC-07 | 两条真实Session寄存器/Trace互不污染，C可并行推进；跨学生403、旧交互409、真实语法错误带top.sv行号；全部3个创建的Session（含replace旧实例）终止确认后无未终止会话。原节点路径/网络/他人数据/CPU/内存/PID/临时区/输出/取消/未知/Engine屏障证据复用，当前专项保持原身份与停止守卫 | 必要节点核心通过；未新注入全故障矩阵，未将H3新节点、长测/统计/RPO/RTO或浏览器计为通过 |

当前关键接口：`POST /api/attempts/:id/sync`、`snapshots`、`runs`、`hdl/builds`、`hdl/programs`、`hdl/interactions`、`hdl/controls`；`GET /api/jobs/:id`、`/api/attempts/:id/runs/:runId`、`/api/hdl/builds/:id`、`/api/hdl/sessions/:id`、`trace`。实际调用方为本批公开HTTP验证器 → 原 `createDigitalLogicApplication`/workspace/records消费者 → 原 `executionTransports` → 固定节点；没有替代UI或执行系统。

### 3.3 旧证据复用与源码适用性

[复用裁定](evidence/c5-core/reuse.json) 和 [复核脚本](evidence/c5-core/verify-reuse.mjs) 对两份原证据逐日志核UTF-8 SHA-256/已声明长度，并与当前受认证登记核验：

- [I0-C验证](evidence/i0-c-revalidation/verification.json)：固定应用/节点来源 `cde69ccbd763c3c0ab381a809b750b951f195f64`；guest真实限额/路径/网络/私有数据/两槽/停止、认证SSH未知/原ID/监督边界按原结果复用。原跳过和独立层次保持，不累计历史通过数。
- [I0-C HDL补验](evidence/i0-c-revalidation/hdl-current.json)：真实持续实例/语法宽度/错段码/X/Z/扫描/零时间终止/双实例/协议伪造与C回归，按原批准AppArmor enforce/引擎/镜像/配置及hash复用。原guest宿主SSH跳过仍是跳过，独立SSH仅按其旧记录引用。

当前应用源码相对原证据已变化，因此原HTTP结果不单独替代当前接缝，本批专项及真实应用链补验。`cde69cc → 37b628b` 的runner/contract变动逐路径登记：H3 ALU协议、VPI/执行器/节点等已在仓库，**尚未部署**；当前实际普通Build/Session消费旧批准协议由本轮证明。C执行/限额/可信比较/原控制、HDL限额及原目标测试等9份核心文件差异为空；此断言不声称整个新runner未变。

[前读](evidence/c5-core/runtime-before.json) / [后读](evidence/c5-core/runtime-after.json) 的受认证C/HDL payload逐字段一致：kernel `6.8.0-146-generic`、Node24.21.0、Docker29.8.2、cgroup2；C fingerprint=`b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a`，HDL=`ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386`，原登记时间分别2026-10-13T09:29:47.600Z/09:51:51.930Z；代际=`synthetic-generation-5944e790-6182-4807-bf21-52534b16271b`。本次未追加节点validation或改代际；后续换环境仍须新核，历史ready不永久授权。

### 3.4 失败、未执行与收尾

本批准备失败保留，不写成产品修复：第一轮finally尝试通过仅允许SELECT/INSERT/UPDATE的事务调用PRAGMA，被正确拒绝，未保存JSON/不计通过；第二轮夹具漏project/ai_collaboration两类目标，checks正确返回两条missing_domain，见 [第二轮失败](evidence/c5-core/real-second.json)；第三轮脚本误读外层Build的snapshotHash，实际位于result，见 [第三轮失败](evidence/c5-core/real-third.json)。仅修正本人脚本/夹具，原产品校验/门限不改，最终第四轮6组断言通过。复用工具首次错误要求所有历史日志都有bytes字段，改为只核原已声明长度，所有原outputHash仍严格核；未改原材料。

未执行及承接：UI/P5负责真实HDL同浏览器保存/显示/波形/错误→修复→重装，当前 [UI真实C浏览器证据](I0-UI_PR69_REAL_BROWSER_RECHECK.md) 仅覆盖原24表/C、不能升级成HDL通过；C/DL-A继续H3新镜像/节点授权及2800向量/course_check接线；C5后续完整故障矩阵、负载/性能分布、30分钟/5分钟长测、备份恢复与导出/RPO/RTO；A6/B4各自业务/真实模型语义，正式真人/教学效果仍后置。未演练不承诺RPO/RTO。

本批结束正常关闭独立host/库，节点继续供原获准联调，前后readiness/指纹/代际不变；原应用现场服务、数据库、凭据与旧工作区保持。所有新库/节点账本/已停止容器保留，无删除或迁移；无需回滚生产实现。后续不再使用这些合成记录冒充真实学习事件，清理另须授权。

## 4. 本地交付与公开待授权

本地写集仅 README导航、本文、本人C5脚本/证据；文件摘要见 [manifest](evidence/c5-core/manifest.json)，完整结果与失败/跳过/后续分层记录。当前方案无新共享契约/产品结果或大改动，生产源码无修复；规范/product/planning/reference/他人任务不修改。产品基线/MVP §10：**待授权维护者汇总**。

本地提交后可交审查；推送公开分支、建C5证据PR、向#63回交并按本批结果关闭须负责人批准准确公开范围。PR只交服务端/节点核心验证，不以关闭本批Issue宣称正式P4全面完成/完整MVP/G4/教学效果或补齐尚未完成的HDL UI。未获公开授权时停止该依赖部分，保留本地成品。

最终本地检查：静态109文档/1778内链/errors=[]，JSON均可解析，manifest的16项文件逐字节/hash通过，Git差异空白通过。主工作区HEAD仍0e68325；其planning/product/G3期间有后续未提交差异，未由本任务覆盖、暂存或提交。本人写集以独立分支的Git提交为准，含任务记录及原失败/未执行项。公开交付准确申请只覆盖这份C5材料，不包含main合并、节点/H3部署或其他任务的受保护文件。

### 4.1 2026-10-15 公开交付授权

负责人对准确19文件/分支/证据PR/#63回交及关闭申请回复：**“同意公开交付并关闭 C5”**。授权普通推送 `codex/c5-core-verification`、创建证据PR、公开去敏合成证据、向#63回交并关闭本批Issue；不包含main合并、生产发布、H3节点换版或受保护文档维护。沿此范围完成最后交付，不重复申请。

核心结果提交为 `4ecd1584238f6fc5c25067b0ae1a822e641baf35`，后续授权/回执仅改本文，不移动固定应用/节点验证版本。公开PR及Issue关闭状态由Git/GitHub实际回读确认；结果附后，不将待执行动作提前记成成功。

### 4.2 公开交付与关闭回执

普通推送 `codex/c5-core-verification` 成功，首次远端head=`0f347c03856a2741ea06d3ed28651790ec1e918f`，与本地相同；[证据PR #78](https://github.com/paher-din/XunJie/pull/78) 已创建并附到本chat，base=main、Open/非Draft/CLEAN。19文件清单和完整正文逐字回读一致；GitHub `statusCheckRollup=[]`，没有CI检查报告，不宣称CI通过。尚未合并main。

由paher-din发布 [#63回交](https://github.com/paher-din/XunJie/issues/63#issuecomment-6174566168)，作者/URL/正文回读与准备稿逐字一致。随后按负责人授权关闭#63，API实读 **CLOSED / COMPLETED**，closedAt=`2026-10-14T17:43:01Z`（Asia/Shanghai **2026-10-15 01:43:01**）。关闭的是本次C5核心批次；§3.4浏览器/长测/完整故障/备份/H3/真人后续项不升级为通过。

最后回执提交仅更新本文；后续PR head以实际Git回读为准，不把文档提交当成新实测应用/节点源码。原19文件写集、固定结果/失败证据与manifest不变；生产源码/配置/保护文档/其他任务不改，不删除分支或工作树。公开交付已完成，产品基线/MVP§10仍待授权维护者汇总。

### 4.3 2026-10-15 PR #78 合并授权

负责人后续明确要求“合并pr吧”，本chat对应的证据PR为#78；据此批准将本19文件证据/导航/记录按普通merge合入main，不删除远端分支、不使用强推或管理员旁路。§4.2“尚未合并”保留其交付时点；最终mergedAt/mergeCommit由PR实际回执核实。

合并前实读head仍为9a89aa4，19文件写集一致、Open/非Draft/MERGEABLE/CLEAN；未报告CI检查，无已提交的变更请求。Copilot在0f347c0上的COMMENTED记录说明请求者review配额耗尽，未完成审查；不将其称为审查通过或自动审批拒绝。源码/证据没有新改动，不重复已完成真实业务测试；合并树文档/空白及证据hash核对后执行。

本轮两次fetch遇Git传输connection reset，失败保留；GitHub/远端main实读为 `0f24605654f923cf41927d3fb4e2c48219a8d585`，该准确commit已在本机，未因fetch失败使用猜测版本。以此main与9a89aa4的 `git merge-tree --write-tree` 得到无冲突树 `0037777843cef36b1d60e0e253f458eac77410ad`。Windows tar.exe将中文文件名解成乱码导致7条missing document；同一原始归档在新WSL目录按UTF-8展开后，合并树静态114文档/1763内链/errors=[]。未改正文、路径引用或关闭检查迁就错误，两个临时副本/归档均保留。C5分支静态109文档/1778内链、差异空白及16项证据hash也通过；原业务实测结果保持其固定版本。
