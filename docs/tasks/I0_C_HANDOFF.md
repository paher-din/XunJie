# I0-C：Issue #30 按 H 编号回交

日期：2026-10-13（Asia/Shanghai）。角色：C，负责人 GitHub 账号 paher-din。当前任务只处理 [czr112 的交接评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6139828933) 所列四项，不重开 Issue。

## 1. 授权、依据与写集

负责人本次明确要求回交 H-03/H-04、H-01/H-04、H-05、H-06，并在 #30 回复固定链接及材料/联调/失败/未执行/下一角色。该指令授权整理证据、只读核查和发布本次回复；不扩大节点维护、凭据分发或跨模块实施。

已按顺序阅读相关正文：PRD §1、3～6、8；MVP_SPEC §1.3、M-02/03/09/10、§4～8；TECH_DESIGN §2～5、7.1～7.5、8～12；TEAM_WORK_PLAN §2、C1/C2、§8.5；I0_UI_SPEC、I0_UI_CLIENT_CONTRACT §3～6/8、IMPORT_SOURCE §1；I0_UI_PREPARATION §5、I0_UI_CLOSEOUT §8.1；C1 §14/17/18、C2 §11、DL-C §13.2 与顺序集成的实际交付边界。适用：PRD-02/03/09/10，M-02/03/09/10，AC-02/03/04/06/10/12/15，NFR-01/03/04/05 的相关部分，不能据此记整项通过。

固定核查源码：`cde69ccbd763c3c0ab381a809b750b951f195f64`（GitHub 已核存在）。工作区原有 `docs/tasks/G3_OVERALL_COORDINATION.md` 未提交修改保留。

- 可写：本文；本机新建的去敏样例/验证输出；#30 本次 C 回复。
- 只读：全部实现/测试/依赖/配置、其他任务、README/AGENTS、product/planning/reference、节点/连接材料。
- 方案：只读检查当前环境和原 readiness/身份对账入口；执行既有 C 合成测试并采集实际公开投影；按 H 回交已有固定源码与缺失条件，不新增契约或修正版本基线。
- 验收：四项有固定来源、可复现命令与实测/合成/未执行区分；公开文本无凭据/私有答案；#30 回复回读一致，#30/#22 保持 Open。

## 2. 当前节点事实

只读 `wsl --list --verbose`：Ubuntu / WSL2 为 Stopped。原已批准入口 `127.0.0.1:2222` 的 TCP 连接不可达。未启动 WSL/VM、未维护节点。

因此本次不能实读节点 readiness、部署源码、profile、validation、recoveryGeneration 或原 RunIdentity；连接不可达不等于节点返回 ready=false。历史 ready 不作为当前事实，最新部署/重验/登记均未执行。

## 3. H-03 / H-04：源码、profile、validation 与代际

候选源码为上述固定 SHA；按 [fingerprint.ts](../../apps/teaching/runner/fingerprint.ts) 原输入顺序计算的候选 `sourceHash=7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852`。这只核仓库源清单，不是节点完整 fingerprint、部署 SHA 或当前 ready。本次部署 SHA、当前代际与最新登记均未知/未执行。

[历史 c-validation](../../apps/teaching/runner/hdl.evidence/c-validation.json)：validatedAt=`2026-10-12T16:01:59.037Z`，sourceHash=`5ff1d2257ec5164e3e6deef503df44c2c55362dd240e5e2a44dfb4e663278d6f`，fingerprintHash=`1dbbf2dbb9730b0121518d114a457f27282baad1e391253c93804c57e831edba`。已被 [DL-C §13.2](DL-C_HDL_BUILD_SIMULATION.md#132-裁决-2既有-c-指纹失效接受) 及 [顺序集成](ORDERED_C4_A4_DL_C_INTEGRATION.md#43-dl-c-当前源码完整验证与合并结论) 标为过期/待目标重验；不能拿它开放当前运行。

历史批准 profile（本次未从节点读回）：`c17-gcc15.3.0-textscope-v1`；imageDigest=`sha256:980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5`，compilerImage=`sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa`，runtimeImage=`sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99`，approvedResultFiles=`["report.txt"]`；C validator=`textscope-validator-v2`，课程规则 Core/Report v1。镜像/profile/validation/currentGeneration 要分别核，不从 tag 推导 ID。

只读复现沿 [C1 §14.3](C1_ISOLATED_RUNNER.md#143-复验与操作说明) 的应用 SSH `{"op":"readiness"}`；原身份对账用 `{"op":"query","identity":<原完整 RunIdentity>}`。只能用已获准合成作业在持久 submission 中的原 runId/commandId/requestHash/引用/作用域，不构造新身份、不 submit/cancel/recover/advanceGeneration。完整 fingerprint 在节点重新计算并与最新 validation 精确比较。

当前代际来源是 [controller](../../apps/teaching/runner/controller.ts) 的 `control.currentGeneration()`；[readRuntime](../../apps/teaching/server/records/runner.ts) 核受认证 readiness 中的 profile/镜像/代际，A 宿主的受控 generationFile 读取原 `data.recoveryGeneration`。首次 Attempt 由 A 的授权 bootstrap 暴露；已有 Attempt 从 recovery 重读。Session、旧 Job、发布时 readiness、本机随机值均不能替代。**本次未交付当前 generationFile；不能用历史响应或本次合成 generation 填补。**

状态：已交固定源/历史来源/只读命令；只读连接失败；当前节点联调、重验与最新登记未执行。下一角色：C/负责人按原维护边界决定运行窗口，C 在节点可达后交当前实读；A 核实来源后再联调。当前任务不扩展维护授权。

## 4. H-01 / H-04：连接与正常宿主

[C1 §17](C1_ISOLATED_RUNNER.md#17-2026-10-10-a2-连接交接与节点实时核对) 已批准路径仍是 PAHER 维护机的 WSL loopback `127.0.0.1:2222`，application key / pinned known_hosts 由该维护机本地受控文件引用；只允许 forced command `xunjie-c1`，不交 maintenance key，不发密钥正文、不添加跨机/公网入口。另一台工作机的 localhost 不是本节点地址。

A 正常宿主交付为 [Draft PR #53](https://github.com/paher-din/XunJie/pull/53)，回读 head=`e3e3486d7ec636836c892433c953eb303a64eb6a`、Open/Draft；[固定运行交接 §12](https://github.com/paher-din/XunJie/blob/e3e3486d7ec636836c892433c953eb303a64eb6a/docs/tasks/I0_A_C_HANDOFF.md#12-本批实现与运行交接) 引用现有受控 JSON 中的 origin、TLS/signing 文件、ssh 路径和 generationFile。

```sh
# 仅在已具备配置的获准应用宿主；这里不是实际可访问网址
PORT=3443 XUNJIE_I0_CONFIG=/controlled/i0-host.json npm start
```

配置路径只由原受控通道在获准宿主本地交接；配置模板不等于存在的联调入口。当前没有可验证的正常 HTTPS 地址/合成账号/当前代际文件，不能填写虚构地址或复制本地私钥。A 的 bootstrap 已实现但仍需当前受信来源，原消费者已有实现但不能据其合成测试宣布当前节点联调通过。

状态：已交来源/运行命令；实际 HTTPS/连接材料核验和当前节点联调未执行。下一角色：A 用其获准入口/配置完成宿主组合，C 只回交当前节点事实，UI 接获准入口。

## 5. H-05：版本、暂停及恢复反例

当前 [syncFiles](../../apps/teaching/server/workspace/files.ts) 每个新同步推进 attemptRevision/workspaceRevision，不推进 decisionEpoch。新 Attempt `1/0/0` → 首次 create `2/1/0` → 再次 update `3/2/0`（顺序为 attemptRevision/workspaceRevision/decisionEpoch）。本次直接调用既有领域函数断言通过；不是 HTTP/SQLite 或真实学生行为。

sync ACK 为 `requestId → data(CommandReceipt) → result`；[syncCommand](../../apps/teaching/server/workspace/commands.ts) 的 result 只含 workspaceRevision/files/created/process。后续 Run/Control 必须 GET Attempt 重读 data.attempt 的三个版本；旧 workspaceRevision 或旧 expectedAttemptRevision 分别 VERSION_CONFLICT，重读失败不猜版本。同键/同 clientSeq 原摘要重放返旧回执，异摘要 IDEMPOTENCY_CONFLICT；旧回执不证明当前 head 未前进。

暂停 Assignment 的公开契约示例（模板，本次未执行 HTTP）：

```json
{"data":{"assignmentId":"<authorized-assignment>","activityVersionId":"<fixed-activity>","assignmentRevision":2,"active":false,"status":"paused","reasons":{"individual":"","activity":"<public-pause-reason>"},"activityControlRevision":2}}
```

暂停仍允许 update 既有 active 文件，禁止 create/recycle/restore、新运行及覆盖教师暂停的 resume。本次直接领域反例验证暂停后更新通过、create/resume/new explicit operation 返回 STATE_CONFLICT；这是个人 pause + assignmentActive=false 的领域输入，**未执行 A 分配暂停事务或 GET Assignment**。对应 HTTP 反例在 [integration.test](../../apps/teaching/server/workspace/integration.test.ts) 第 112 行与第 261 行；A PR #53 §13 已交实际合成 bootstrap active=false / assignmentRevision=2，属 A 的实测，未冒充本次 C 运行。

已有 Attempt 的只读 `GET /api/attempts/:id/recovery?recoveryGeneration=<last-trusted>&decisionEpoch=<last-read>` 返回当前 recoveryGeneration/resyncRequired/attempt 与受限恢复投影；不同代际/epoch 要同步，GET 不激活、改文件、排 Job 或重跑。新代际后旧写入包括旧键重放返回 RECOVERY_REQUIRED；完整反例见 integration 第 16/205 行、[C4-V04/V09](../../apps/teaching/server/workspace/submissions.test.ts)。首次无 Attempt 用 A bootstrap，不先调用不存在 Attempt 的 recovery。

TECH §4.3 与当前 sync 的版本推进差异保留：现阶段用权威重读兼容，不单方改 C 实现或受保护基线；待授权维护者汇总。

## 6. H-06：分批公开样例与来源

以下 HTTP 输入/输出为固定实现支持的**公开模板**，本次 HTTP 验证因依赖失败未执行；不是虚构实测响应。请求中的身份/Origin/CSRF 从正常受控会话取得，不附值。所有测试数据与 profile 均为合成，不能供当前真实运行使用。

| 批次 | 公开输入/投影及反例 | 固定验证入口 |
| --- | --- | --- |
| 读取/保存 | GET Attempt；POST sync `{recoveryGeneration:<trusted>,expectedWorkspaceRevision:0,clientId:<stable>,clientSeq:1,operations:[{kind:"create",clientFileKey:"source",path:"main.c",text:"int main(void){return 0;}\n"}]}`；ACK result.workspaceRevision=1、fileId/hash；原键/双键重放回原 ACK，异正文冲突、跨学生拒绝 | integration 第 16/72/112 行；records.test 4 项本次通过 |
| 快照 | POST snapshots `{recoveryGeneration:<trusted>,expectedWorkspaceRevision:<confirmed>}` → result.snapshotId/snapshotHash/workspaceRevision；再 GET 快照核文件正文/hash/清单；新草稿不混入旧快照 | integration 第 16 行；本次 freezeSnapshot 直接断言通过 |
| 原运行/停止/未知 | POST runs `{recoveryGeneration:<trusted>,expectedAttemptRevision:<GET head>,snapshotId:<fixed>,runtimeProfileVersion:<activity>,entryFileId:<snapshot file>,input:{operation:"stats",fileIds:[<snapshot ASCII>]},mode:"run"}` → result.jobId/runId；GET 原 Job/Run；POST jobs/:id/cancel `{recoveryGeneration:<trusted>}` 只受理停止意图，cancelling/outcome_unknown 保原 ID/槽位，不自动补跑 | integration 第 205/232/261 行；runs.test 第 49/65/92/142 行；正常自动消费由 A PR #53 交，测试手动 processJob 不算生产消费者 |
| 历史/产物 | GET runs/:runId 与 /files；diagnostics 与 Job 状态/课程 verdict 分开。GET Run 不公开 entryFileId/input/inputHash；只能显示已回执关联的本机原请求并标来源，无缓存为参数不可回取 | result-files.ts；integration 第 285 行的真实节点开关及裁剪断言本次未执行 |

产物外层示例分别为 `{status:"available",files:[...]}`、`{status:"redacted"}`（course_check），`{status:"unavailable"}`（无确认结果）。available 内每个文件的 status 为 complete/missing/incomplete，不能把 missing/incomplete 改成外层状态，或称 available 等于完整。现有代码核白名单、原 run/snapshot、稳定 resultFileId、hash/bytes；正文不自动写回作品。

本次 [collectResultFiles](../../apps/teaching/runner/result-files.ts) 的合成文件实测节选（节点回取函数层，**不是 /files HTTP 响应**）：

```json
[
  {"relativeName":"report.txt","status":"complete","text":"TOTAL\t4\t11\t51\n","contentHash":"a712e934544c90229ac74e3f1dd495ff23209961c5bc11430d46e6da233ed335","bytes":14},
  {"relativeName":"missing.txt","status":"missing"},
  {"relativeName":"directory","status":"incomplete"}
]
```

directory/missing.txt 只作收集器反例；TextScope 批准白名单仍只有 report.txt，不据反例扩大批准产物。HTTP redacted/unavailable/available 包装本次未执行，不能把纯函数输出冒充当前业务端点响应。

## 7. 本次验证、失败与未执行

Windows x64，精确 Node 24.21.0 portable 官方 win-x64/node.exe，按同版本 SHASUMS256 核对；未改全局 Node。主副本原默认 Node 24.15.0、原 node_modules 缺 zod，本次未覆盖或清理它。git archive 固定 SHA 创建新的隔离源副本，依赖按原 lock 准备，无包/锁或业务源码改动，合成文件与临时输出保留。

apps/teaching 可复现的既有测试：

```sh
node --test --test-concurrency=1 --test-reporter=tap runner/snapshot.test.ts runner/result-files.test.ts runner/verify.test.ts runner/course.test.ts runner/report.test.ts
node --test --test-reporter=tap server/records/records.test.ts
node --test --test-concurrency=1 --test-reporter=tap server/workspace/integration.test.ts server/workspace/runs.test.ts server/workspace/submissions.test.ts runner/result-files.test.ts
```

- 第一组：20 总，19 通过/0 失败/1 Linux symlink 用例跳过；跳过不算通过。第二组：4/4。
- 第三组失败：7 个 TAP 条目，3 通过/3 测试文件加载失败/1 跳过；三个 C workspace 文件均因缺 zod 未加载，不写成业务断言失败或通过。
- 安装失败保留：首次 npm launcher 使用系统 Node 24.15.0，被 engine-strict 拒绝；改用精确 Node 执行 npm-cli 后，原 lock 的 better-sqlite3 13.0.3 因缺 Windows MSVC 构建工具失败；没有关闭 engine 检查、换依赖版本或安装全局编译工具。尝试官方同版本 Windows 预编译产物返回 404，未得到或使用该产物。原 HTTP collect 脚本准备但未执行；未产生 HTTP 实测样例。
- 既有 syncFiles/freezeSnapshot/controlAttempt/collectResultFiles 直接断言通过，结果见 §5/6；领域输入为合成，不计真实 Session/SQLite/分配事务。
- C-owned workspace/records/runner 与历史 `26e5b840270cbf489cb21e23d1d4ee2f3ad30998` 比较无差异。可参考 [历史 Linux 完整证据](evidence/ordered-c4-a4-dl-c/manifest.json) 的 360 总/352 通过/8 跳过；这是历史全应用组合，不作为本次重跑或节点就绪。
- 本次未执行：当前节点 readiness/原 RunIdentity 实读、部署/重验/登记、HTTPS/UI/真实 C1 整链、HTTP/SQLite 样例采集、全应用回归、NFR 负载/旧备份恢复、模型/真人/教学效果。

公开回交只链接已在 GitHub 存在的固定源码、原测试/历史证据与 A PR；本文本地新增未公开推送，不给虚构远端链接。不提交或推送，不合并/关闭卡，不改 README/保护文件/其他任务/凭据/CI，不维护节点或迁移库。产品基线及 MVP_SPEC §10：待授权维护者汇总。

2026-10-13，已用 paher-din 账号发布 [#30 C 回交评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142231833)，API 回读正文与准备文件逐字一致（仅统一换行/末尾换行比较），作者/URL 已核；#30/#22 再读均 Open。评论完整包含上述四项固定来源、公开模板/实测区分、失败与下一角色。没有把当前节点、HTTP 或正式产品记为通过。

文档静态检查 64 份/924 内链、errors=[]；Git 已有差异空白检查通过。本文未跟踪文件另核末尾换行、尾随空白与敏感值形状，无异常。写集最终仅本文新增；原 G3 修改不动，未提交或推送。回退如涉及删除本文仍须负责人明确授权；临时合成文件/输出保留。

## 8. 2026-10-13 继续处理运行阻塞：范围与方案

负责人针对“节点不可达、HTTP 复验受依赖阻塞，当前 readiness/代际及最新指纹登记仍未验证”明确要求“处理一下这个吧”。该后续指令将当前范围从只读回交扩展为恢复既有获准专属 WSL/VM、修复隔离验证依赖、按当前固定源码实际重验并登记指纹/代际及补 HTTP 证据；沿 C1 §14、DL-C §10/13.2 的既有专属环境、配置与验收机制。不新建节点、扩大资源、换依赖/运行契约或触碰真实数据。

可写增量：本文、本任务新的隔离 Linux 源码/原 lock 依赖/合成验证输出，既有专属 guest 内当前 C 运行源码的版本化副本及非密钥运行配置、当前验证账本的追加记录、去敏 readiness 交接文件；沿原 #30 回复追加实际结果。密钥/known_hosts/签名/证书、.env/CI、旧应用库与受保护文件保持只读；不删除旧文件/镜像/配置/验证记录或 Git 历史，不公开推送/部署。

本人证据写集补充为 `docs/tasks/evidence/i0-c-revalidation/`：只保存去敏 runtime/原身份查询、合成公开 HTTP 样例和实际测试输出/摘要，以便从仓库独立核查；不新增业务实现或测试契约。

执行顺序：恢复 Ubuntu 并核原专属 VM/SSH；核现有配置、部署版本和原账本的作业数量/来源，无真实或未结业务作业后才做维护验证；复用 Linux 精确 Node/已安装构建工具及原 lock，先通过 C HTTP/SQLite 专项与严格类型检查；保留旧部署，版本化同步固定 C 源码/契约，按实际节点环境运行原 guest/认证 SSH/类型验收；三组成功才用原 record-validation 追加登记，读取认证 readiness 与代际并核原身份；最后补真实 C1 的合成 HTTP 链和 #30 状态。任一步失败保留事实，不写通过、不沿旧 ready。

已复现的失败信号：Ubuntu Stopped、原端口不可达；原 Windows HTTP 测试缺 zod/原 lock 原生安装失败；历史指纹与当前候选 sourceHash 不同。优先用原 Linux 环境，不为验证新装 Windows 全局编译工具。若后续触及删除、凭据、schema/迁移、公开发布或扩大既有维护范围，先列具体对象/风险请求负责人决定。

## 9. 运行阻塞实际修复与当前交接

### 9.1 依赖与节点恢复

恢复原 Ubuntu 和 `xunjie-c1-vm.service`，原 KVM/2 vCPU/4 GiB/持久盘/SSH/镜像复用；未调整全局 WSL 网络/防火墙。用隐藏 WSL 保活进程 PID 40680 维持本机联调生命周期，不新增定时任务。维护前原 C 181 个事实无 reserved/pending/queued/running/cancelling/outcome_unknown，归属只有原测试的 synthetic-student/synthetic-course 和 student/course；53 个 HDL 会话均终止。原配置/源码/账本保留。

固定 `cde69ccbd763c3c0ab381a809b750b951f195f64` 归档到全新 Linux 原生测试目录；Node 24.21.0/npm 11.19.0、原 lock 的 npm ci 成功，audit=0。npm 的安装脚本政策提示 better-sqlite3 原生步骤尚未覆盖，使用原 npm 内置 node-gyp 在该新目录、原 13.0.3 包上执行 rebuild，成功；未改 allowScripts、engine-strict、版本/锁或安装全局编译工具。原 Linux make/g++/Python 和原 Node 已存在。随后 typecheck/build 通过。此前 Windows 缺 zod/MSVC 的失败保留为历史，不改成 Windows 环境已修好。

guest 当前部署：新增 `/opt/xunjie-runner/source-i0-c-cde69cc/` 保存 runner/、contracts/runner 与原 HDL 测试 fixture；新非密钥配置 `/opt/xunjie-runner/config.dlc-i0-c-cde69cc.json` 来自原 hdl-prepare，复用原 state/镜像/profile，sourceHash 与固定仓库的 7f4ec4f3… 精确相同。新增 systemd `i0-c.conf` 只切换 ExecStart 到这份版本化源码/配置，旧 dlc.conf/配置/源码不覆盖；原应用 SSH wrapper 与新版本逐字相同，未改 SSH/known_hosts/密钥。

恢复后旧部署返回 ready=true/sourceHash=5ff1d225…，只支持旧部署事实；切换当前源码后 ready=false/sourceHash=7f4ec4f3…，旧验证正确失效。通过下述三组实际执行后才用原 record-validation 追加/fsync 登记，再经应用身份读回 ready=true。没有旧指纹兼容或手写 passed。

### 9.2 本次实际验证与证据

独立证据：[runtime](evidence/i0-c-revalidation/runtime.json)、[命令/原输出/验证摘要](evidence/i0-c-revalidation/verification.json)、[33 份公开 HTTP 样例](evidence/i0-c-revalidation/http-samples.json)。三个登记证据的原输出 SHA-256 与验证账本逐项一致；正文/凭据形状扫描通过，所有作品/账户为隔离合成数据。

| 验证 | 本次结果与边界 |
| --- | --- |
| Node/原 lock/Linux 原生 SQLite | npm ci/native rebuild/typecheck/build 均退出 0；主工作副本原 node_modules 和全局 Node 不动 |
| 当前版本 guest runner 全部 tests、开启 XUNJIE_C1_RUNTIME | 58 总/55 通过/0 失败/0 取消/3 跳过；HDL runtime、HDL toolchain clock 与 guest 内宿主 SSH 开关未启用，不算通过 |
| 宿主认证 SSH、原 node.rpc.test | 10/10，0 失败/跳过；包含真实 Core/Report/可信检查/资源累计、取消/进程故障/Engine 恢复/代际守卫，当前源码与原认证入口 |
| 本次严格全应用 typecheck（登记的 types 组） | 退出 0；不使用缺失的旧独立 typecheck 安装路径，不造该旧命令成功 |
| C HTTP/SQLite 专项 integration/runs/submissions/result-files | 36 总/34 通过/0 失败/2 真实 C1 开关跳过；包括实际登录/授权/原事务/ACK/恢复，runner 部分使用合成 transport |
| 此后开启 XUNJIE_C2_RUNTIME，精确匹配两项真实 C1 联调 | 2/2，0 失败/跳过；真实 A1/A2/C1 链及 C2 原固定快照/结果/检查/取消/重启对账。两项原跳过范围实际补齐，不把两轮总数重复加成一套全量 |
| 公开 HTTP 样例采集 | 33 份，全部断言通过；实际 app.inject + Session/SQLite，运行未知/产物故障由受控合成 RunnerTransport 提供，不冒充物理故障实测 |
| 原身份只读对账 | 应用身份 query 原持久 identity；原 runId=`run-synthetic-1f1c2d43-4439-4d4b-93ab-a05d7d08b576`，state=succeeded/reserved=false；原 identity 与返回逐字匹配、代际与 readiness 一致，无重投 |

精确命令在 verification 的每组保存。guest 改为当前版本化 runner 路径；SSH 在隔离 apps/teaching 执行 `XUNJIE_C1_SSH=1 node --test --test-reporter=tap runner/node.rpc.test.ts`；types 用原工程 `npm run typecheck`。真实 C1 的两项用 `XUNJIE_C2_RUNTIME=1` 和只引用原 application/known_hosts 的受控 SSH JSON，运行 integration/runs 中对应固定 test-name-pattern；不在文档或日志写登录/CSRF/密码。

### 9.3 H-03 / H-04 当前实读与 H-01 受控交接

2026-10-13 17:29:47.600（Asia/Shanghai）追加登记当前 C 验收；应用身份后续读回：

```json
{
  "ready": true,
  "sourceHash": "7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852",
  "fingerprintHash": "b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a",
  "validatedAt": "2026-10-13T09:29:47.600Z",
  "recoveryGeneration": "synthetic-generation-5944e790-6182-4807-bf21-52534b16271b",
  "runtimeProfileVersion": "c17-gcc15.3.0-textscope-v1"
}
```

profile/镜像/白名单保持 §3 的批准值，本次从当前节点核实；C validator/rule 按固定源码。新的代际是原 SSH 故障验收经受控 advanceGeneration 追加的 synthetic-generation，来源为原控制账本，不是 UI/文件随机值；普通恢复节点先保持旧代际，完成合成恢复验收后登记此新值。当前业务调用须重读这个代际，不沿旧页面/旧 Job。

原维护宿主新增受控目录 `/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff/`，目录 0700/文件 0600：

- `current-readiness.json`：原受认证 `{data:...}` 完整响应，可供 A 已授权宿主配置的 generationFile 读取 `data.recoveryGeneration`；同时保留精确 profile/指纹/validation。
- `connection.json`：只引用原 `/usr/bin/ssh`、application key/known_hosts 路径、loopback/2222，不含私钥正文。仅原受控通道/该获准宿主消费，不新发凭据或开跨机入口。
- `runtime-evidence.json`：当前只读响应及原 identity/query；正文来源与命令关联可核。

这些路径是本任务固定的部署/交接位置，不是仓库/个人工作副本前置。节点继续运行供 A 接收；该 snapshot 不在恢复后自动刷新，后续维护改变代际必须重新实读、核来源并交接，旧文件不能作为永远当前的值。A 的正常 HTTPS/真实浏览器入口仍沿 PR #53 由 A/UI 组装；本次不改其配置或代替其正常消费者验收。

HDL 当前只读 ready=false，新 fingerprint=`ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386` 与旧 HDL validation 不同；本次 C 重验不登记 HDL passed、不冒充 DL-C 最新运行验收。其配置/账本/旧证据保留，后续仍需 DL-C 对当前部署完成 HDL 专项。

### 9.4 H-05 / H-06 实测补交

33 份公开响应保留完整 requestId/业务 IDs/回执/归属。以下为实际节选，不再仅是 §5/6 的模板；全量在 http-samples：

- 首次 sync 后 GET head：attemptRevision/workspaceRevision/decisionEpoch=`2/1/0`；ACK 仍不含 attemptRevision/decisionEpoch。旧 workspace/attempt CAS 分别拒绝；同键重放原 receiptId、replayed=true，异正文 IDEMPOTENCY_CONFLICT。
- 本批先做 course_check、随后 Assignment pause：GET Assignment active=false/status=paused/assignmentRevision=2/activityControlRevision=1；原因为 individual 的 Synthetic handoff pause。当前 head=`4/1/2`，不是仅由 pause 一步造成的数值（其中先有 course_check 激活的版本/epoch）。暂停后 update 既有文件成功，head=`5/2/2`，新文件/新运行 STATE_CONFLICT。
- 合成恢复换代后旧键重放 RECOVERY_REQUIRED；GET recovery 实际返回 new-generation/resyncRequired=true 和 `5/2/2`。这里的 generation/new-generation 仅是隔离测试 transport/应用，不作为 §9.3 真实节点代际。
- 原 unknown Job 与取消确认保同 runId/jobId：outcome_unknown → cancelled/stopRequested=true；未知后重装/对账没有 submit，原键取消重放同回执。
- files-unavailable 外层 unavailable；files-complete/missing/incomplete 外层 available，逐文件 status 分别 complete/missing/incomplete；course_check 的 files-redacted 外层 redacted。成功/拒绝/重放/裁剪均采集真实公开 HTTP 投影，合成 transport 输出与真实节点联调证据分开。

新的本次结论：C 节点可达、C readiness/代际/最新指纹已实读并登记；依赖阻塞在原 Linux 隔离环境解除，HTTP/SQLite 复验及两项真实 C1 服务端链通过。仍未执行正常 HTTPS/TLS、UI 浏览器/自动消费最终组合、全应用全量回归/NFR、旧备份 RPO/RTO、最新 HDL 专项、模型/真人/教学效果。#30/#22 保持 Open；受保护基线与 MVP §10 待授权维护者汇总。

本次新增三个本人证据 JSON 与本文；实际修改仅原专属节点的版本化 C 源码/非密钥配置/一个服务 override/追加验证记录和新的本机隔离输出，未改仓库业务源码/依赖/锁/保护文件/其他任务或凭据。公开补交、文档/写集最终核查完成后追加结果。

2026-10-13，已用 paher-din 发布 [#30 当前运行补验回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142794517)；API 回读作者/URL 和正文逐字一致。该评论明确替代前次三项阻塞的当前状态，保留前次失败事实，附当前指纹/代际/原ID、受控文件、33份HTTP样例节选、实际命令/结果及下一角色。#30/#22 均再次核为 Open。

最终文档静态检查64份/927内链、errors=[]；四个本任务文件的JSON/末尾换行/尾随空白/凭据形状检查与Git已有差异空白检查通过。最终仓库写集为本文和三个证据JSON，G3原修改保留；未提交或推送。C节点/保活继续运行供已获准联调，不设自动重验/变代际/清理任务。停止节点或变更运行条件后A必须重新核当前readiness；删除旧文件/回滚删除override仍须负责人明确授权，不在本次执行。

## 10. 2026-10-13 剩余验收进入核查与 HDL 补验

负责人问“为什么未验，现在可以做吗”。按请求继续补现有条件具备的验证：C 的原 HDL 目标环境/固定镜像/维护机制已批准，本次用当前版本化源码、非密钥配置与原 HDL acceptance 做专项及追加登记；不改变共享字段/运行限额/课程/UI。HTTPS与浏览器先只读核进入条件，不借该问题扩大凭据创建或前端实施授权。

实际前置核查：节点/WSL保持运行；原受控目录只交 SSH/readiness 材料，没有 TLS cert/key/signing 或正常宿主 JSON。A PR #53 当前 head 已更新为 c071b4d0874c8cb1e8b83c95108fda2519a30cf0，仍 Open/Draft，固定交接仍要求引用现有 TLS/signing 文件，不提供实际已部署 HTTPS 入口。main 学生 `src/workspace/init.ts` 第165～171行在 real 模式即使读到 Session，仍无条件返回 discovery/unavailable；没有消费 A 新 bootstrap/合法 Assignment 引用。重复 dev:prep 浏览器检查不能验证这条真实产品链。

HDL执行计划：只读确认未结C/HDL与运行单元为空；核当前源码/配置/原generation；重新加载同一份获准 AppArmor policy，实际 enforce 后运行原 hdl-acceptance（HDL真实构建/持续仿真/四值/重复/顺序/终止/隔离及原C回归）；两组成功才追加记录，认证 hdl_readiness 和 C readiness分别读回。若失败保留新失败输出，不登记通过、不修改判据；不进行真实学习/模型操作。

HTTPS/UI仍缺决定/材料：优先由A交实际获准HTTPS地址、受控TLS/signing/正常宿主配置文件路径，UI交登录/合法分配/bootstrap真实接线。若需本任务代做，只能先批准准确A/UI写集与新凭据/证书创建（含信任范围）；本次不生成密钥或关闭浏览器证书验证、不创建替代UI，不改变受保护规格。后续结果与准确申请在本节追加。

### 10.1 负责人选择与 HDL 实际结果

负责人重读问题后明确选择“没有，先完成 HDL 补验”。此前误选“已有”不作为配置已存在或凭据创建授权；正常 HTTPS/TLS、UI 接线暂不执行。被中断的原验收进程已自然完成，回读退出0，没有重复执行。

本次只重新加载当前源码中的同一获准 `xunjie-dlc-v1` AppArmor policy，目标内核读回 `xunjie-dlc-v1 (enforce)`；未新增policy规则/运行镜像/限额。原 hdl-acceptance 两组结果：HDL 10/10、0失败/跳过；原C 52总/51通过/0失败/1宿主SSH入口在guest未启用的跳过。此跳过不算通过，前批同源码的独立认证宿主SSH10/10保持其原范围，本批没有重复计数为新增通过。

HDL专项覆盖真实构建、持久状态、重复与顺序、四值/扫描/错误显示、停止和异常资源释放、两实例隔离/配额、原身份/旧代际拒绝及有限采样/零时间循环终止，按原固定测试判据。两个真实子进程退出0后由原验收代码追加/fsync HDL validation；不是手写passed。原始两组输出与登记outputHash逐一核对一致，保留在 [本次HDL证据](evidence/i0-c-revalidation/hdl-current.json)。

登记时间2026-10-13 17:51:51.930（Asia/Shanghai），随后经原 application SSH 分别只读核 C/HDL：

```json
{
  "hdlReady": true,
  "cReady": true,
  "sourceHash": "7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852",
  "hdlFingerprintHash": "ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386",
  "hdlValidatedAt": "2026-10-13T09:51:51.930Z",
  "recoveryGeneration": "synthetic-generation-5944e790-6182-4807-bf21-52534b16271b"
}
```

两者代际相同，C原验证/代际未被HDL补验更改；结束后Docker运行容器0，节点继续运行供获准联调。§9的HDL ready=false为此前时点，在此被当前实读替代，旧记录不改贴新通过。策略在节点重启/环境变更后仍须重新核enforce和readiness，不凭本文历史状态开放。

本批新增一个本人证据JSON，追加本文与#30回交；未更改仓库实现/依赖/锁、TLS/签名/SSH凭据、UI或受保护文件。此次目标为当前HDL节点验证/新指纹登记，不表示完整DL-C/UI/Demo、NFR/长测/备份恢复或教学验收完成。HTTPS/UI未执行按负责人此次选择保留；产品基线与MVP§10待授权维护者汇总。发布回读与文档检查结果在完成后追加。

2026-10-13，已由paher-din发布 [#30 HDL当前指纹补交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6143063168)，API回读作者/URL及正文一致；#30/#22再次核为Open。文档检查64份/928内链、errors=[]；本任务五个文件的JSON/换行/空白/凭据形状检查通过，原输出hash与新登记记录匹配。最终仅本文与四个证据JSON为本人仓库增量，G3原修改保留；无提交/推送或其他验收扩张。
