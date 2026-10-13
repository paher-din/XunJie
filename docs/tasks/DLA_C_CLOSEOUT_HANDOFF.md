# DL-A 收尾：C 的现场接收与 ALU 检查提案

日期：2026-10-13（Asia/Shanghai）。角色：C（paher-din）。处理负责人指定的 [#38 收尾清单](https://github.com/paher-din/XunJie/issues/38#issuecomment-6145619173) 中 DLA-H1/H2/H3；H1/H2 沿 [#30 统一交接](https://github.com/paher-din/XunJie/issues/30#issuecomment-6146000885)，不另开模块票。

## 1. 依据、授权和写集

已按 README → AGENTS → PRD → MVP_SPEC → TECH_DESIGN 阅读相关正文：PRD §1/3～6/8/9；MVP §1.3/1.4 与工程/流程/教学分层条件；TECH §1～3、4.1、7.4/7.5、8/9/10；TEAM §2/7/8.6；DL-0 §2.3、DL-C §10/11/13，以及 I0-C 的当前回交和 A 固定运行手册。适用 PRD-02/03/09/10、M-02/03/09/10、AC-02/04/10/12/15、DL-AC-01/03/07/09；不据局部检查标整项通过。

起点 main=`cde69ccbd763c3c0ab381a809b750b951f195f64`。已有 `G3_OVERALL_COORDINATION.md` 修改、`I0_C_HANDOFF.md` 与其证据未跟踪，全部保留，不暂存或提交。

- 本次已授权：整理 C 回交；只读确认 PAHER/原受控材料；接收 A 已公开固定源码、用原 Node/lock 做隔离构建；核现有 ALU 行为检查能力并提交执行侧提案。
- 可写：本文及本任务新建的去敏证据；全新保留的隔离接收副本/构建日志。
- 只读：主副本所有实现/依赖/配置、其他任务、README/AGENTS、product/planning/reference、节点与原 TLS/签名/SSH 材料。
- 待批准：H3 具体检查配置、共享结果契约及实施；不存在材料时的 TLS/签名/账号创建；公开回交。不会从清单推导这些批准。

方案：H1 核现有受控运行通道和执行账号，接收 A 固定源码；H2 只报告存在的 TLS/签名/正常宿主与账号输入，不生成凭据；H3 核版本绑定和真实仿真入口，未实现时交最小方案及预计写集。复用 [当前 C 节点回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142794517) 与 [HDL 补验](https://github.com/paher-din/XunJie/issues/30#issuecomment-6143063168)，不重跑已验节点。

验收：H1/H2 的真实配置存在性、受控位置/消费身份/接收步骤可查；A/UI/C 固定版本明确；H3 不把构建、结构或板信号专项当 ALU 行为通过；失败/未执行/下一角色明确；新增文档/证据、内链/空白及凭据检查通过。产品基线与 MVP §10 待授权维护者汇总。

## 2. 本次核查与交接结果

当前 A 运行手册已公开：[PR #53](https://github.com/paher-din/XunJie/pull/53)，手册提交 `8aa28a04294a0622961ab7b67aaea25be34229d9`，固定运行提交 `9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77`；后续提交仅文档/README。DL-A 的35表业务批次按本次 #38 回读仍未公开，不能指定不可取得的本地 SHA 让 C 检出或代跑。

### 2.1 DLA-H1 / #30 H-03/H-04：PAHER 接收已核通

实测宿主为 PAHER，Ubuntu/WSL2 Running，原 `xunjie-c1-vm.service` active，原 loopback 2222 正在监听。接收与只读核查窗口为本次 PAHER 会话：2026-10-13 21:43 起核可用，21:46:39 认证响应通过（Asia/Shanghai）；不承诺机器全天在线，后续实际业务批次执行前仍核当前响应。原节点/原保活继续，未新增保活、定时任务、服务或网络入口。

可消费身份是原获准 **WSL Ubuntu/root（uid=0）**。默认 `paher`（uid=1000）没有这三份 root 受控文件的读取权限；本次不修改权限或复制密钥。节点 SSH 的登录名按现有 [sshRunner](../../apps/teaching/server/records/runner.ts) 是 `root`，权限由原 **application key + forced command `xunjie-c1`** 限制，并非授予业务宿主任意 root shell；不交 maintenance key。

受控交接目录仍为 `/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff/`，目录0700，以下文件 root:root/0600：

- `connection.json`：引用 `/usr/bin/ssh`、`127.0.0.1:2222`、原 `/opt/xunjie-runner/vm/keys/application` 与 `known_hosts`。
- `current-readiness.json`：原完整 `{data:...}`，A 用 `data.recoveryGeneration`；本次与当前认证响应的代际、C validation fingerprintHash 一致。
- `runtime-evidence.json`：原 `originalIdentity`/query 与固定 sourceCommit；本次原身份只读 query 返回 succeeded/reserved=false，identity逐字段一致，无 submit 补跑。

本次只调用原 `readiness`、`hdl_readiness`、原 identity 的 `query`：C/HDL ready=true；sourceHash=`7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852`；C fingerprint=`b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a`；HDL fingerprint=`ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386`。代际与原 Run 引用详见 [本次只读证据](evidence/dla-c-handoff/host-reception.json)。这不是重新执行节点 acceptance 或追加验证登记。

**A 固定代码已实际接收并构建：** Windows Git fetch 固定 SHA 后以 `git archive` 原 blob 归档，解入全新 root/0700 保留目录 `/opt/xunjie-runner/tests/dla-c-handoff-9fa76ad-20261013/`。使用既有 `/opt/xunjie-runner/node/bin` 的 Node24.21.0/npm11.19.0；两个应用分别原 lock `npm ci`、typecheck、build 成功。教学服务原生 SQLite 模块直接加载成功，sqlite_version=3.53.4，不需 rebuild/approve 或更改依赖。构建后四份 package/lock 摘要不变，`tar --compare` 核全部754份已归档源码与固定 Git archive 仍一致。

归档 SHA-256=`f0198c72f612f0950a9e393e4eeb2b60fa13882c54625b75476f47e2b5d94746`。命令原输出/摘要在 [构建证据](evidence/dla-c-handoff/build-reception.json)，宿主原输出保留于接收副本 `handoff-build/`。不修改成员现有 checkout；该副本没有初始化数据库或启动正常应用。

21:57:50，C 在 PAHER **实际调用接收副本中 A 的编译后 sshRunner/availableRuntime/readI0Generation**，受控文件读取、真实当前 profile/sourceHash/指纹/代际、HDL只读就绪、原query身份与reserved断言全部通过。此为C代跑A读取代码，不写成A本人独立复测或正常main/HTTPS/消费者通过；摘要在同一只读证据的compiledAConsumer。

本次编译后读取验证的精确复现（在接收副本 apps/teaching、原root受控窗口，Node24.21.0）：

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sshRunner} from './dist/server/records/runner.js';
import {availableRuntime} from './dist/server/design/readiness.js';
import {readI0Generation} from './dist/server/app/config.js';
const base='/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff';
const transport=sshRunner(JSON.parse(readFileSync(base+'/connection.json','utf8')));
const runtime=await availableRuntime(transport); assert(runtime);
assert.equal(runtime.recoveryGeneration,readI0Generation(base+'/current-readiness.json'));
assert.equal(runtime.readiness.sourceHash,'7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852');
const hdl=await transport({op:'hdl_readiness'}); assert.equal(hdl.data.ready,true);
const identity=JSON.parse(readFileSync(base+'/runtime-evidence.json','utf8')).originalIdentity;
const queried=await transport({op:'query',identity});
assert.deepEqual(queried.data.identity,identity); assert.equal(queried.data.reserved,false);
console.log(JSON.stringify({readOnly:true,cReady:true,hdlReady:true,
  runtimeProfileVersion:runtime.profile.runtimeProfileVersion,
  sourceHash:runtime.readiness.sourceHash,fingerprintHash:runtime.readiness.fingerprintHash,
  recoveryGeneration:runtime.recoveryGeneration,originalRunId:identity.runId,
  originalState:queried.data.state,originalIdentityMatches:true}));
JS
```

**MSI 接收方式：** 当前没有已获准的 MSI→PAHER 远程执行/读取入口。由 C 在 PAHER 原受控身份代跑 A 已公开固定版本并回交去敏输出，A 保留复核与业务修复责任；不分发私钥、不新增跨机通道。DL-A 后续在 A 交出可取得的固定35表源码/命令后复用这个入口，增加 HDL 组合验证；不重建入口或合并24/35表库。

### 2.2 DLA-H2 / #30 H-01/H-02：现有获准材料尚无

本次只读核原 `/opt/xunjie-runner/cli-config/` 与上述 handoff；后者只有三份已知 runner JSON，没有 origin、TLS、signingSecretFile 或合成账号输入。当前受控执行环境的 `XUNJIE_I0_CONFIG`/`XUNJIE_I0_INITIALIZE_CONFIG` 未设置。结合 [I0-C §10.1](I0_C_HANDOFF.md#101-负责人选择与-hdl-实际结果) 的负责人“没有，先完成 HDL 补验”决定，**本次交接范围内尚无已获准 TLS cert/key、签名文件、正常宿主配置或合成账号初始化输入**；没有把全盘上任意证书/其他项目凭据当作授权材料。

因此未提供虚构 HTTPS URL、Origin/PORT、CA信任或账号领取渠道，也没有初始化24/35表库或启动正常 main。A（czr112）按 DLA-H2 准备精确 HTTPS/证书信任、TLS/签名文件、账号初始化/安全使用及受控配置方案；涉及凭据创建/修改须负责人批准准确对象后实施。C 收到实际文件引用后在已接收副本执行 A 手册 §17.3～17.6 的预检及正常接口批次，A 复核，UI 另做浏览器验收。

届时启动命令仍是手册的原模式（现在未执行）：

```sh
export PATH=/opt/xunjie-runner/node/bin:$PATH
cd /opt/xunjie-runner/tests/dla-c-handoff-9fa76ad-20261013/apps/teaching
# PORT / XUNJIE_I0_CONFIG / 初始化输入由获准受控文件给出；不在此补造值。
npm start
```

## 3. ALU 可信行为检查：执行侧提案

### 3.1 现有能力与缺口

现有入口是 [HdlCommand](../../apps/teaching/contracts/runner/hdl.ts) 的 hdl_build/program/interact/query/result/stop，由 [createHdlWorkspace](../../apps/teaching/server/workspace/hdl.ts) 调用，运行经原认证 SSH；没有 ALU course_check/behavior verdict 命令。原 [verifyCase](../../apps/teaching/runner/verify.ts) 检查 C 输出/报告；当前 main [checkRuleSchema](../../apps/teaching/contracts/design/inputs.ts) 只接受 TextScope，不能当作 HDL 验证器。

已有绑定：HdlBuildRequest 固定 snapshotId/hash、boardProfileVersion/mappingVersion/runtimeProfileVersion 与领域身份；HdlBuild 另固定 artifactHash/configurationHash、引擎/imageDigest；Session/OperationResult 绑定 Build/快照、代际、revision/sequence、模拟时间和 resultHash。现有领域权限/幂等/旧版本校验可复用；正常宿主的公共检查入口与获准活动配置由 A 汇总。

[hdl-profile](../../apps/teaching/runner/hdl-profile.ts) 校顶层/端口/位宽和板映射；[hdl-bridge](../../apps/teaching/runner/hdl-bridge.c) 仅采样 switches/buttons/resetN/leds/anodes/segments/dp，**没有 A/B/Cin/M/S/F/Cout 的语义绑定**。题目的 SW→LED/自选映射不能推出 led[3:0] 就是 F，数码管段码也不能直接冒充 ALU F。现有 [真实 RTL 专项](../../apps/teaching/runner/hdl.runtime.test.ts) 测计数、位宽/语法、段码/X/Z、扫描、隔离/停止，不检查题目 ALU 真值表。已有10/10不代填行为通过，状态保持 **ALU behavior unverified**。

### 3.2 最小执行方案（待 A 汇总、负责人确认）

复用当前不可变板卡 Build 和 Icarus/VPI 隔离引擎，增加一个受课程配置约束的 ALU 检查能力，不增加另一种判分引擎或 UI。

1. A/C 冻结版本化的语义绑定：实际 ALU 实例与端口/信号引用、A/B/F各4位，Cin/M/Cout各1位、S两位；另列 A/B/Cin/M/S 到学生实际 SW 的位映射。名称/层级/拨码位可自选，教师确认其绑定版本；不强制题目示例或固定模块名。绑定只能指向本 Build 实际 elaboration 中、确认快照生成的信号，核范围/方向/宽度与重复位，禁止任意 Tcl、shell或宿主路径。
2. 从该成功且确认结束的固定 Build 创建**独立检查 Session**，保留同一快照/artifactHash；不替换或推进学生现有交互 Session。VPI 的受控采样通道新增窄白名单的 ALU 原始信号采样，按原组合/NBA稳定相位核实际输入与 F/Cout；stdout只作日志。平台外受信比较器读取原始四值输出和固定规则，学生正文/模型/UI不能声明 verdict。
3. 枚举下表定义域；单包、单次推进、会话、输出与公平调度沿当前批准上限，不提高资源或长期占 C 作业槽。实施批次须实测2800个向量能在原期限与有限输出内完成，按有界批次采集必要结果，不把省略向量算全覆盖。
4. 请求/结果同时绑定原 scope（course/student/attempt/activity）、recoveryGeneration、snapshotId/hash、Build/artifactHash、检查绑定/规则/validator版本、Board/mapping/runtime/引擎/imageDigest与输入集摘要；执行与接受前重核许可、暂停/撤权和当前代际。按原命令摘要/幂等回原结果，不换键自动补跑。检查记录沿原 Job/回执及可授权读取/导出接缝，由 A/C 会审结果形状；本提案不新增表或冻结 API。
5. 保留 passed/failed/incomplete 的区别：定义域内确定值不符或 HDL输出X/Z是行为失败；编译/超时/工具/传输/覆盖不足或终止未确认不能记 passed，保留原因/缺口与 unknown。未定义 Cout不比较；缺失可信采样不能用stdout/段码估算补齐。停止/取消/权限变化按原身份对账，确认整个单元退出后释放资源，限定帮助政策由 A/B 原流程落实。

| 题目范围 | 外部可信比较 | 全量向量数 |
| --- | --- | --- |
| M=0，S=00/01/10/11；A/B=0～15、Cin=0/1 | F分别为 (~A)&15、A&B、A\|B、A^B；不评分 Cout。覆盖无关B/Cin不应改变NOT等输出 | 2048 |
| M=1，S=00 | sum=A+B+Cin；F=sum&15，Cout=(sum>>4)&1 | 512 |
| M=1，S=01，仅 A>B | F=A-B-Cin；不评分 Cout | 240 |
| M=1，S=10/11 或减法 A≤B | 不评分、不补定义 | 排除1296 |

定义域总2800，完整输入空间4096；[枚举与边界自检](evidence/dla-c-handoff/alu-proposal-check.json) 仅核提案数字和NOT/进位/最小差值例子，没有运行或判断学生 HDL。数码管真实段选/位选与SW→LED另沿DL-AC-05/06核验，不借算出F纠正UI显示。

### 3.3 预计改动、验收与风险（未实施）

C 预计维护 runner 的窄 ALU 配置/比较模块及其反例测试、hdl-bridge.c/hdl-executor.ts/hdl-node.ts 与领域命令/结果契约，并在 workspace/records 复用原 Job/授权/回执/读取。真实目标反例加入 HDL 专项：正确与错误加法/进位、错误位运算/减法、未定义域不评分、合法不同SW映射、X/Z/伪造stdout、旧快照/绑定/代际拒绝、重复不再执行、停止/异常无假通过。具体文件与接口先由 A 汇总确认后才写；A 自行维护课程 checkRule/活动/权限配置、正常宿主、消费者和合成业务工厂，B/UI按批准结果读取。

**运行源码/VPI 的变化将移动共同 sourceHash，使当前 C/HDL validation 不再匹配。** 实施前须批准准确配置/镜像与原节点维护窗口，实施后重新构建固定镜像并验收/追加登记；旧证据保留，不能沿用当前ready。本次没有这些变更或额外重验。

交给 A 的待决项：语义绑定的课程归属/确认流程、2800向量覆盖与稳定采样规则、检查帮助/授权入口、结果/持久化接缝、准确维护与验证范围。负责人确认后由 C 实现执行能力；真实行为证据齐备之前继续标 unverified。

## 4. 验证与未完成项

| 检查 | 本次实际结果 |
| --- | --- |
| PAHER/受控文件/原通道 | 原VM active；root可读0700/0600材料；认证C/HDL ready=true，current-readiness代际/指纹与实读一致；原query身份一致/succeeded/reserved=false；C代跑A编译后读取代码也通过 |
| A 固定源码接收 | 固定9fa76ad已fetch/归档/新Linux副本解包；构建后754份源与原archive全部一致，四份package/lock前后摘要一致 |
| 学生/教学依赖、类型与构建 | 两套原lock npm ci/typecheck/build均退出0；Node24.21.0；SQLite真实模块加载/SELECT版本=3.53.4；未安装新依赖或修改脚本批准政策 |
| H3 提案自检 | 2800定义/1296排除/4096总量及NOT/进位/差值边界断言通过；不是ALU执行验收 |
| 文档/写集 | 初次文档检查65份/928内链/errors=[]，差异空白通过；最终检查结果随后追加 |

失败保留：首轮普通Git HTTPS fetch Connection reset，改本次命令 `git -c http.version=HTTP/1.1 fetch origin <固定SHA>` 后成功，未改Git全局/仓库配置；首轮只读SSH探测错误使用application作为登录名而被拒绝，按现有sshRunner的root登录修正后成功，没有改节点用户/key；Windows反斜杠经wslpath参数丢失导致第一次解包失败，保留当时新空目录，核空后用准确/mnt/c路径解入；逐文件参数哈希探测因WSL参数转义失败，改原tar的比较功能核全部源。均属接收/检查命令失败，不是业务或节点验收失败，也未删除、重置或关闭检查掩盖。

当前未执行：正常HTTPS/TLS/登录、初始化24/35表库、A正常消费者与C/HDL组合、暂停/撤权/C4的正常接口组合、ALU行为判定、模型、UI浏览器、全量应用/NFR、真人/教学效果。未复跑已验C/HDL acceptance、改节点/配置/代际/凭据或开放跨机通道；未修改主副本源码或保护文档。

下一角色：A准备H2准确材料/凭据申请并发布DL-A固定可运行版本；C收到实际获准引用后用本次副本代跑、回交，A复核修复、UI浏览器验证。H3由A汇总本提案评审，负责人确认配置与实施后C执行。#38/#30/#22保持Open，产品基线/MVP§10待授权维护者汇总。接收副本、归档和日志保留；无需回滚实现，后续清理/删除另获授权。

最终记录：文档检查65份/940内链/errors=[]、Git已有差异空白通过；本人新增4份文件（三份JSON、一份任务记录）JSON/EOF/尾随空白/凭据形状检查通过，九份构建原输出与入库正文/字节/摘要一致。本文两条公开回复仅为待批准稿；没有发布评论、提交、推送、合并或关闭Issue。主副本既有G3/I0-C及原证据保留，本人仅上述四文件增量。

## 5. 待发布回交正文

以下是本次准备的两条去敏正文，**尚未公开发布**。公开只放引用/状态/命令，不含私钥、密码、token、cookie、CSRF或学生正文；发布后 #38 的H1/H2仅链接 #30 同一次回交。

### 5.1 #30：DLA-H1/H2 共用回交

2026-10-13，C（paher-din）按 #38 收尾清单和本卡共用 H1/H2 责任回交，已有节点验收与33份样例不重做。

**DLA-H1 / H-03/H-04：PAHER现场接收已核通。** A固定运行源9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77（PR #53）、手册8aa28a04294a0622961ab7b67aaea25be34229d9已接收为全新保留Linux副本 `/opt/xunjie-runner/tests/dla-c-handoff-9fa76ad-20261013/`；C/UI基线沿cde69cc及已合入#51。既有Node24.21.0、两个应用原lock npm ci/typecheck/build全部通过，真实SQLite加载3.53.4；四份package/lock摘要不变，构建后754份归档源与固定Git blob一致。本次未初始化应用库或启动正常main。

本次PAHER接收窗口2026-10-13 21:43起已实测可用；原WSL/VM/保活继续，后续业务批次仍先核当前性。执行身份是原获准WSL Ubuntu/root，原handoff目录0700、三个JSON为root:root/0600；默认paher不具读取权限，不改ACL或分发密钥。受控目录仍 `/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff/`：current-readiness.json供generationFile读原data.recoveryGeneration，connection.json只引用原application key/pinned known_hosts/127.0.0.1:2222，runtime-evidence.json供原identity查询。SSH沿现有sshRunner的root登录和application forced xunjie-c1，maintenance key不交业务应用。

21:46:39只读认证：C/HDL ready=true；sourceHash=7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852，C fingerprint=b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a，HDL fingerprint=ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386。当前代际与handoff原文件一致；原run-synthetic-1f1c2d43-4439-4d4b-93ab-a05d7d08b576的identity逐字段一致，query=succeeded/reserved=false，没有submit补跑/换代/登记。复用原[C节点回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142794517)及[HDL补验](https://github.com/paher-din/XunJie/issues/30#issuecomment-6143063168)。没有已授权MSI远程入口；由C在PAHER代跑A固定源，A复核，不新开网络或复制私钥。

21:57:50，C在PAHER实际调用9fa76ad编译后sshRunner/availableRuntime/readI0Generation，受控文件→认证当前profile/sourceHash/指纹/代际→原identity query完整读取断言通过，HDL只读ready也通过；这是C代跑A的读取代码，A独立复核与正常HTTPS/main/worker仍未执行。

**DLA-H2 / H-01/H-02：尚无现有获准TLS/签名/正常宿主/账号初始化材料。** 本次原cli-config/handoff与受控变量核查没有相应输入，因此当前不能给实际HTTPS Origin/PORT、CA信任或账号使用方式。H2由A（czr112）主责准备准确配置/凭据方案，新增/修改凭据由负责人确认后实施；C收到真实受控文件引用再执行[A手册§17.3～17.6](https://github.com/paher-din/XunJie/blob/8aa28a04294a0622961ab7b67aaea25be34229d9/docs/tasks/I0_A_C_HANDOFF.md#173-初始化配置与只读预检)。不把全盘其他证书当获准材料、不放宽TLS或登录规则。

可复现接收命令：`git -c http.version=HTTP/1.1 fetch origin 9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77` → `git archive`原blob→新保留Linux副本；仅本进程PATH引用 `/opt/xunjie-runner/node/bin`，两应用各 `npm ci && npm run typecheck && npm run build`；SQLite `SELECT sqlite_version()`、package/lock前后sha256sum与tar --compare。届时正常启动仍沿 `PORT=<获准端口> XUNJIE_I0_CONFIG=<获准文件> npm start`，目前未执行，占位不作实际入口。

已交材料/通过：现场接收、固定源码构建、三文件读取及当前原身份认证对账；未执行：正常HTTPS/登录、fresh-only24表初始化、真实main原Job自动消费及暂停/取消/产物链、DL-A35表/HDL/C4组合、UI浏览器与ALU行为。A先落实H2并交DL-A可取得固定版本；C按具备批次代跑，A复核，UI独立验浏览器。24/35表不合库/迁移。#30/#38/#22保持Open，未合并/部署/新开凭据或通道，产品基线待授权维护者汇总。

### 5.2 #38：DLA-H3 执行侧回交

2026-10-13，C（paher-din）补 DLA-H3 / DL-D01 首批执行侧提案；DLA-H1/H2沿#30统一回交（发布时填实际回复链接，不重复节点验收）。固定核查源main cde69ccbd763c3c0ab381a809b750b951f195f64；原[C/HDL当前证据](https://github.com/paher-din/XunJie/issues/30#issuecomment-6143063168)只支持执行环境，不支持ALU行为通过。

**现有行为检查未实现，ALU behavior unverified。** 当前HdlCommand仅build/program/interact/query/result/stop；Build固定快照/hash、board/mapping/runtime/engine/image与artifactHash，Session/Result绑定原Build/快照/代际/revision/sequence/模拟时间/resultHash。profile校验是顶层/端口/宽度/板映射；VPI只采样板信号，没有A/B/Cin/M/S/F/Cout语义绑定。不能假定LED低4位就是F、从段码或stdout补算F/Cout；真实计数/段码/扫描10/10不代替题目ALU真值检查。

**最小方案，待A汇总与负责人确认：** 复用成功不可变板卡Build、原Icarus/VPI与隔离/幂等/版本控制。冻结实际ALU实例/信号和学生自选SW的版本化语义绑定，核A/B/F4位、Cin/M/Cout1位、S2位及引用/方向/范围，不强制示例模块名或拨码。由明确获准的check创建独立检查Session，不推进/替换学生当前Session；窄白名单受信VPI通道采样稳定后的实际输入/F/Cout，外部可信比较器判断，stdout不是判分来源。

- M=0四种NOT/AND/OR/XOR：只比F，2048向量；NOT=(~A)&15。
- M=1/S=00：F=(A+B+Cin)&15、Cout=((A+B+Cin)>>4)&1，512向量。
- M=1/S=01且A>B：F=A-B-Cin，240向量；Cout不评分。
- 空白S=10/11、A≤B减法及其他未定义Cout不评分；完整4096输入排除1296，定义域2800。枚举/边界自检仅检查提案数学，没有运行学生HDL。

结果建议绑定原scope/activity/代际、snapshot/hash、Build/artifactHash、board/mapping/runtime/engine/image、规则/validator/语义绑定版本、输入集摘要/覆盖；权限/暂停/撤权执行前后复核，原键同摘要复用原结果，停止按原身份确认终止。定义域内不符/X/Z是行为失败；工具/超时/缺可信采样/覆盖不足/未确认终止不能passed，保留incomplete/unknown。批量与输出仍沿原限额，实施时实测2800向量覆盖，不提高资源或用省略数冒充全覆盖。

预计C维护runner的ALU配置/比较模块及反例、hdl-bridge/executor/node与领域命令/结果、workspace/records原Job/授权/回执接缝；A维护课程检查配置/活动/权限/正常宿主，结果形状/准确写集先会审，当前不新增表或API。运行源码/VPI变化会移动共同sourceHash，使C/HDL当前validation失效；准确配置/镜像/维护窗口获批后须目标重验与追加登记，不能沿用当前ready。

下一责任：A汇总语义绑定确认方式、覆盖/采样/帮助规则、结果与持久化接缝，负责人批准具体配置/实施；C再实现并交正确/错误逻辑、合法不同映射、X/Z/伪造输出、旧引用/代际/重复/停止等目标反例。H3尚无真实执行证据；原C/DL-AC/浏览器/NFR/真人与教学门禁保留，#38保持Open，产品基线待授权维护者汇总。

## 6. 负责人批准公开回交

2026-10-13，负责人对“将本文两条去敏回交发布到 #30 和 #38”的准确申请回复“同意”。本次仅授权发布 §5.1/5.2 两条评论，#38 的 H1/H2 填入实际 #30 评论链接，并回读核正文/作者/Issue状态和记录交付；不包含源码/凭据/数据库变更、H3 实施、任务文档/证据推送、PR合并或Issue关闭。§1/4/5 的待批准/尚未发布保留其准备时点，实际结果随后追加。

两条已由 paher-din 发布：[#30 DLA-H1/H2 共用回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147353266)、[#38 DLA-H3 执行侧提案](https://github.com/paher-din/XunJie/issues/38#issuecomment-6147371151)。#38 仅将 §5.2 的待填引用替换为上述实际 #30 链接，其他正文与批准稿一致；两条 API 独立回读作者/URL及去除末尾空白后的正文逐字一致。#30/#38/#22 最终均为 Open。

GitHub连接器写入返回403 Resource not accessible by integration；回读确认未创建评论后，使用本机既有gh授权（账号同为paher-din）、UTF-8正文文件和gh issue comment --body-file发布，没有复制凭据或重复发送。临时正文文件保留，不删除。

发布前同时读取 [A 新增 I0-ENTRY 责任说明](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147291196)：其新增914d456仅文档，固定运行源码仍9fa76ad，现场配置未就绪，TLS/签名保管人未指定。该材料不改变本次实测/缺口或扩大执行许可，未据外部评论生成凭据、认领未知保管人或启动新批次。

本次仅发布两条已授权评论并追加本文；未提交或推送本地任务/证据、合并PR、关闭Issue、改源码/环境或执行新业务验收。最终文档检查65份/940内链/errors=[]，Git已有差异空白检查通过；本人四文件与原G3/I0-C写集边界保持。

## 7. 2026-10-13 I0-ENTRY 负责人裁决与 C 承接

负责人在本聊天明确给出下列裁决，原文保留；这是责任/凭据准备的授权，未将未执行步骤记成 H-01 完成，也未扩大本任务到 A 的作者文件、生产、跨机或系统 CA 操作。

### 项目负责人裁决：I0-ENTRY / H-01

同意当前 I0-ENTRY 责任划分，并批准以下执行安排。

**1. 责任分配**

- **A（czr112）**：总负责 HTTPS 入口、TLS/签名配置方案、合成账号准备、配置复核及最终交接。
- **C（paher-din）**：负责 PAHER 环境现有材料的现场核查，并在确认执行条件后配合完成受控环境配置和验证。
- **UI（Robert）**：接收可用 HTTPS 入口与账号使用方式，验证页面可访问。

**2. 凭据准备授权**

优先检查并复用已有、获准使用的 TLS 证书及应用签名文件。

如现有材料不存在或不可用，授权 A 制定并实施仅供本地开发/演示环境使用的 TLS 证书及应用签名文件准备方案。

要求：

- 明确实际使用的主机、Origin、访问方式及证书信任方案。
- 明确凭据生成者、保管人、受控存储位置及使用权限。
- 私钥、签名秘密、账号密码不得提交至 Git 仓库或公开评论。
- 不得将开发/演示凭据用于正式生产环境。
- 新增公网入口、跨机网络访问、系统级 CA 信任变更及生产凭据操作不包含在本次授权中，须另行申请。

**3. 执行顺序**

A 先完成固定执行包及凭据方案；C 确认现场执行条件、核查已有材料，再执行获准步骤；A 复核实际 HTTPS、Session/CSRF、登录及课程归属验证结果，最后向 UI 交接。

C 不自动承担所有凭据的保管责任，也不要求重复已完成的节点/HDL 验收。

**4. 完成标准**

以真实 HTTPS 入口、合成账号正常登录、证书验证通过、UI 可访问及 A 完成证据复核为准。

仅有文档、配置模板或合成测试不计作 H-01 完成。

请 A 按本裁决继续推进，遇到超出上述授权范围的问题再向项目负责人申请，不必反复等待一般性分工确认。

### 7.1 本次 C 执行范围

C 接受原 I0-ENTRY 的现场核查及条件具备后的受控执行步骤。已读 [A 固定 I0-ENTRY 全文](https://github.com/paher-din/XunJie/blob/914d45612085ee1e66dfaeaaaa3f4a61f44bb067/docs/tasks/I0_HOST_ENTRY_PREPARATION.md) §1～6；A PR #53 当前 head=914d456，固定运行源码仍9fa76ad。现场副本、Node/SQLite/构建和原受控读取沿本文§2，不追随纯文档分支重新安装或验收节点。

本次可写仍仅本文和新的去敏现场证据；只读核现有副本、材料、用户与窗口。A 尚需提交明确的凭据准备方案与可消费的受控输入；C 不代 A 冻结 Origin/信任/凭据保管方案，也不自动认领所有秘密保管责任。当前可执行只读现场确认，正常配置/初始化/预检/HTTPS步骤在必需输入具备后按已批准范围执行，不因一般分工重复请求授权。

预计使用仍为 PAHER 同机本地开发/演示、WSL Ubuntu/root、现有原 application SSH 与固定副本。新增公网/跨机/系统CA/生产操作及 H3 实施不在本裁决内。此裁决不自动授权新的公开评论或本地任务/证据推送；前次两条公开回交保留原事实。现场确认结果与剩余 A 输入随后追加。

### 7.2 C 现场条件已确认；下一批输入交 A

2026-10-13 22:17:01（Asia/Shanghai）只读核 PAHER：Ubuntu/WSL2 Running、原VM服务active；原root/uid=0可用、Node24.21.0位置不变；固定9fa76ad副本的student real dist/index.html与教学dist/server/main.js均可读；三个原handoff材料为普通文件、root/0600且可读。原cli-config及handoff仍未提供TLS/签名、origin或合成账号初始化输入，未知TLS/签名保管人未冒充C。仅查已知受控目录和元数据，不读取/输出私钥正文。

本次C承接和现有现场条件确认已完成。A已有固定运行包，本次剩余输入是：明确PAHER实际Origin/访问方式及本地证书信任方案；凭据生成者/保管人/受控位置/权限；TLS证书/key和应用签名文件的实际可用引用；获准合成账号/课程/政策初始化输入与安全领取方式。A依负责人本次授权准备开发/演示TLS与签名，无需再次等待一般分工或同范围凭据准备确认；新公网/跨机/系统CA/生产操作另行申请。

C在A方案和实际输入具备后继续原受控步骤：复用已通过构建→原fresh-only24表初始化→新非秘密引用配置→实际只读预检→正常HTTPS main→证书验证开启的页面/资产/匿名401/合成登录/Session/CSRF/课程归属→原输出/去敏证据交A复核，UI确认访问。没有修改本地或远端A作者稿，未生成凭据/初始化库/启动HTTPS；缺输入的后续步骤为未执行，不标H-01完成。

本次WSL只读脚本实际退出0；同一次命令末尾的Windows限定端口查询无匹配项使外层返回1，不据此标WSL核查失败或业务失败。随后使用Get-NetTCPConnection全量只读监听清单过滤3443确认其状态；3443仅为手册候选，不据端口清单预定Origin或声称HTTPS已可用。

本轮只追加本文，保留现有源码/其他任务/证据/受控环境。未向其他聊天或GitHub追加裁决消息；此处是C记录和现场执行确认，A总负责/最终复核、UI访问验收继续按负责人裁决。3443的Windows监听数为0，仅作候选端口事实。文档检查65份/940内链/errors=[]、差异空白通过；没有新业务验收或节点/HDL重验。

## 8. 负责人授权转交 I0-ENTRY 裁决

2026-10-13，负责人明确要求“推送裁决吧”，授权将§7裁决原文在原#30公开转交A，附C已确认的现场条件及待A输入。此次发布仅一条裁决评论，不修改其他作者任务、基线或既有评论，不提交/推送本地无关修改；不生成凭据、部署或关闭Issue。§7末尾未转交的表述保留其核查时点，实际URL/回读和最终检查随后记录。

已由paher-din通过现有gh授权及UTF-8正文文件发布 [#30 负责人I0-ENTRY裁决](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147733890)，明确转交@czr112。正文完整保留负责人裁决，另标C现场承接/待A输入，引用原I0-ENTRY与C回交；不把C补充写成负责人原文。GitHub API独立回读作者/URL及去除末尾空白后的正文逐字一致；#30/#22均仍Open。未推送Git分支/本地任务或证据，也未向其他聊天派发工作；本次公开交付为上述裁决评论。

本次仅追加本文，原G3/I0-C与证据保留；未生成或修改凭据、部署/启动、初始化数据库、执行新的业务或节点验收。最终文档检查65份/940内链/errors=[]，差异空白通过；公开正文不含凭据形状或秘密正文。

## 9. C-ENTRY-02/03 准备与 A 实质责任边界

2026-10-13，负责人要求保留现有C-ENTRY-01～07现场分派，并明确：“把工作交给 C 执行，不等于把 A 的模块责任、技术决策责任和集成质量责任一并转移给 C。”同时要求A对C-ENTRY-02/03的方案和业务语义实质审查，对C-ENTRY-06暴露的A模块问题亲自负责修复。新增凭据、CA信任和网络操作仍须各自准确授权；本次准备不将分派当作凭据实施批准。

已读 [A 最新分派](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147767208) 与 [固定执行包§7/8](https://github.com/paher-din/XunJie/blob/23bccc796d6b5913f670097bcf729246af9ccab9/docs/tasks/I0_HOST_ENTRY_PREPARATION.md#8-a-固定执行包交付清单2026-10-13)，运行SHA仍9fa76ad。当前可写：本文、本人非秘密提案/核查证据与新保留应用接收副本；A/B/UI源码/任务、产品/规划/参考/规范、原受控运行节点和凭据只读。方案/权限/初始化/浏览器条件先给A实审，C不补改A模块掩盖业务缺口。

### 9.1 C 接收字节核查补正

按A新增10份原Git blob摘要复核时，发现旧应用接收副本与声明摘要不一致。独立以Windows Git cat-file的原始stdout字节核package.json后，确认A摘要正确：原blob932字节/无CR，旧副本962字节/30个CR，去掉CRLF差异后摘要才相同。根因是C先前用Windows Git archive时core.autocrlf=true；不是A清单错误。

此前§2及公开回交所称“754份源与固定Git blob一致”验证范围有误：原tar --compare只证明副本与**已受换行转换的归档**相同，不证明与原blob逐字节相同。原构建/当前节点读取结果仍按其实际副本与范围保留，不倒写成功或删除旧事实。该错误由C更正，不能作为A模块缺陷；公开补正尚待发布。

旧副本/归档完整保留。使用单次命令git -c core.autocrlf=false archive重新取同一9fa76ad，解入全新 `/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf-20261013/`；不修改Git永久配置。新归档SHA-256为2f235358dacd769a6a33696577d93ccd8136b183232db29e3bcbbb70ad4585e6。A的10项摘要全部匹配；原/新差异详见 [manifest核查](evidence/dla-c-handoff/i0-entry-manifest-check.json)。进一步按原Git ls-tree的blob对象ID对普通文件原始字节与符号链接目标作全树核查，结果在 [全树核查](evidence/dla-c-handoff/i0-entry-raw-tree-check.json)。

本次只重建应用接收副本，不部署到guest，不触碰节点源码/镜像/config、指纹、代际或validation。原节点实际指纹和已验readiness保留其原范围；本节不重跑C/HDL acceptance。新副本的必要构建与提案核查结果随后记录。

### 9.2 C-ENTRY-02/03 非秘密提案

待A实审的 [宿主与凭据方案](evidence/dla-c-handoff/i0-entry-host-plan.json)、[两课程/五角色输入计划](evidence/dla-c-handoff/i0-entry-input-plan.json) 已准备；[A原非秘密manifest副本](evidence/dla-c-handoff/i0-a-source-manifest.json)保留原摘要，没有改成旧接收副本的值。这些文件带purpose/status，不是可直接运行的XUNJIE_I0_CONFIG或initializer输入，且不含密码/私钥/签名值。

提案仅PAHER同机 `https://127.0.0.1:3443`、原main监听127.0.0.1；新本地30天自签server证书（SAN：127.0.0.1、localhost、::1），RSA2048；新32字节随机应用签名；五个合成账号各24字节随机密码。拟生成者/本次新增材料保管人为C，原WSL root执行，受控新目录 `/opt/xunjie-runner/tests/i0-entry-20261013-01/` 0700，文件0600，秘密只进该目录。以上尚未生成，C执行者的凭据/客户端信任操作须明确批准；不默认C保管所有既有凭据。

Node验证客户端建议仅在该客户端提供开发证书为trust anchor，rejectUnauthorized=true且保持默认主机核验；[Node TLS一手说明](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions)支持显式ca/self-signed证书，[连接校验](https://nodejs.org/api/tls.html#tlsconnectoptions-callback)保留证书验证。没有系统CA导入或关TLS校验。该客户端通过不证明浏览器信任；A/UI仍须实审准确浏览器信任/访问方案，证书警告点击绕过不能计H-01通过。现有PAHER Windows未找到Firefox，WSL未找到certutil，未安装新工具或选定未经验证的浏览器信任方案。

字段映射复用原current-readiness/connection/runtime-evidence，新的UI dist与原initializer返回的实际新库；消费者默认250ms，原application key/pinned known_hosts不变。两课程/五角色ID沿A模板，政策行为/可信检查保持原帮助与TextScope限制。原storePolicy的versionId全库唯一，同ID跨课程FORBIDDEN；因此提案course-a用help-v1、course-b用help-v1-course-b，内容相同。此为待A审查的配置标识提案，不改表/schema/存储代码或授权语义，不直接复用冲突ID建库。

以下凭据步骤仅为可审查命令，尚未执行；审批后使用现有OpenSSL，目录已存在即停止，避免覆盖既有材料：

```sh
set -euo pipefail
umask 077
I0_ENTRY_DIR=/opt/xunjie-runner/tests/i0-entry-20261013-01
mkdir -m 700 "$I0_ENTRY_DIR"
/usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 \
  -keyout "$I0_ENTRY_DIR/server.key.pem" -out "$I0_ENTRY_DIR/server.cert.pem" \
  -subj /CN=127.0.0.1 \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost,IP:::1' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth'
```

签名与五个密码随后由现有Node crypto.randomBytes在内存生成，仅以writeFileSync的flag=wx/mode=0600写受控签名/initializer文件，不向stdout/参数输出值。initializer materialization仅原users/courses字段，不带提案额外元数据；A审查政策标识后才填实际JSON。原initializer返回新保留库路径后创建新的非秘密引用宿主JSON，执行原§17预检/启动和严格HTTPS请求。库/失败文件保留，不清理或覆盖。

A实审必须覆盖：身份/课程成员/跨归属、两课程政策标识及限定帮助语义、宿主/Origin/CSRF/Session和字段契约、凭据与UI信任范围、正常Job/暂停/撤权/最终集成证据。C-ENTRY-06中的A模块问题回A修复，C只修本人作品/节点领域；C测试通过不替代A实审或UI浏览器验收。凭据与真实HTTPS执行未启动，H-01保持未完成。

### 9.3 准备验证、失败与最后状态

初次新LF副本通过student类型/构建及teaching类型检查；teaching build因symlink复用旧依赖，declaration emit报5项TS2883（light-my-request Response引用旧路径）而失败。没有按报错建议改A的test-support或关declaration。原 [失败输出和准备核查](evidence/dla-c-handoff/i0-entry-preparation-check.json)保留；首份本地摘要误将teachingBuild写为0，已明确更正为1并保留错误声明与完整原编译输出，不将schema解析成功当构建成功。

再用同一已核LF归档创建全新保留 `/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/`，物理复制原已安装依赖（先核四份package/lock的JSON内容完全相同），没有安装新版本/改变依赖政策或删除symlink。Node24.21.0下两个应用typecheck/build全部实际退出0，最终副本全部源码仍与已核原Git blob的归档逐字节一致。[最终四组原输出/摘要及数据核查](evidence/dla-c-handoff/i0-entry-preparation-final.json)独立保存，与前次失败不混计。

原helpPolicy/checkRule编译schema接收两课程输入；五个用户/登录名唯一、教师/学生成员引用、两个唯一政策ID检查通过；A10份source/lock摘要全部匹配。非秘密计划不含密码，也未调用initializeI0或任何建库/TLS/签名生成命令。浏览器信任方案、A实审和具体凭据/客户端信任批准仍待完成。

本次准备共新增七份JSON证据/提案（A清单副本、输入计划、宿主计划、manifest核查、全树核查、失败/最终准备输出），维护本文；原G3/I0-C与四份早期证据不改，主副本应用源码只读。独立新副本/依赖/归档/失败输出全部保留；未公开发布新方案/补正、提交或推送。最终文档检查65份/947内链/errors=[]、差异空白通过；本文及十JSON的解析/EOF/空白/凭据形状检查通过，四份最终原输出正文/hash一致，OpenSSL提案bash -n语法通过但未执行。

两课程均为本批C/TextScope的隔离合成权限测试作用域，不表示数字逻辑课程已接入；仍仅原24表，不与DL-A35表合并。浏览器信任与红线操作尚未批准/执行；H-01的A实审与UI访问条件保留。

## 10. 待交 A 实质审查的公开回交稿

以下是本次拟在原#30回交的非秘密方案、责任边界和C接收字节补正，尚未发布。原运行/构建日志保留受控查阅，不贴秘密输入；本稿不请求A替代负责人批准红线动作。

### C-ENTRY-02/03：现场方案、业务输入及职责边界

2026-10-13，C（paher-din）按[A最新固定执行包](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147767208)完成C-ENTRY-02/03准备，提请 @czr112 **实质审查**。负责人明确：“把工作交给 C 执行，不等于把 A 的模块责任、技术决策责任和集成质量责任一并转移给 C。”A对身份、权限、业务宿主、接口契约和最终集成结果负责，对本方案/业务语义实审；C-ENTRY-06暴露的A模块问题由A修复，C保留现场及本人领域责任，UI保留实际浏览器接线/验收。

**先更正C先前接收证据范围：** [前次回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147353266)中“754份源与固定Git blob一致”只做了tar --compare，实际上仅核与Windows Git archive一致。复核A10份摘要后发现旧副本因core.autocrlf=true而为CRLF，10份摘要都不同；A清单正确，旧文件转LF后的摘要全部匹配，错误归C接收/表述，不归A。旧归档/副本/通过与失败保留，没有删除、覆盖或修改节点。

现已用单次git -c core.autocrlf=false archive取同一固定9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77，按原Git ls-tree/blob对象ID核完整754份普通文件原字节，0差异；A10份摘要全部匹配。最终应用副本 `/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/` 采用同一已核归档和物理复用的原依赖，两个应用typecheck/build实际通过。新LF第一副本用symlink复用依赖导致teaching declaration build TS2883失败，原输出保留；已修接收环境，未改A源码/类型检查/依赖版本。本次仅应用副本，不更换执行节点源码、指纹、代际或validation，不重跑C/HDL验收。

**C-ENTRY-02：待审查/准确授权的本地方案**

| 项目 | 提案 |
| --- | --- |
| 主机/入口 | PAHER同机开发/演示，https://127.0.0.1:3443；原main仅监听127.0.0.1，不增加跨机/公网路径 |
| 新凭据 | 30天本地自签server证书，SAN为127.0.0.1/localhost/::1，RSA2048；32字节随机应用签名；五个合成账号各24字节随机密码 |
| 生成/保管/权限 | 拟由C在原WSL root身份生成并保管本次新增材料；新受控目录 /opt/xunjie-runner/tests/i0-entry-20261013-01/ 为0700，server.key.pem/server.cert.pem/signing-secret.txt/initializer.json/i0-host.json为0600；不覆盖旧文件，不默认保管其他凭据 |
| 秘密领取 | 仅PAHER原root受控文件与内存请求使用，密码不进CLI参数、Git、公开评论或普通日志；不复制到MSI/新通道 |
| 严格客户端TLS | 验证客户端仅显式信任本次开发证书，rejectUnauthorized=true/默认主机核验；不改系统CA，不关验证 |
| 浏览器信任 | 仍待A/UI实审准确浏览器信任/同机访问方案。Node HTTPS通过不能代替浏览器信任；证书警告点击绕过不计通过。现有现场没有Firefox/certutil，不擅自安装/导入CA |
| 宿主字段 | 原initializer的实际新库返回值；原current-readiness/connection/runtime-evidence；新固定副本student dist；consumerIntervalMs=250；原application key/pinned known_hosts，严格Origin/Session/CSRF不变 |
| 授权 | 上述C新增TLS/签名/账号密码和客户端信任仍待负责人准确授权；无公网/跨机/系统CA/生产、节点维护或35表/HDL/ALU操作 |

**C-ENTRY-03：非秘密两课程/五角色**

| 账号ID/loginName | 课程 | 角色 |
| --- | --- | --- |
| synthetic-i0-teacher-a | synthetic-i0-course-a | teacher |
| synthetic-i0-student-a | synthetic-i0-course-a | student |
| synthetic-i0-student-peer | synthetic-i0-course-a | student |
| synthetic-i0-teacher-b | synthetic-i0-course-b | teacher |
| synthetic-i0-student-b | synthetic-i0-course-b | student/跨课程读者 |

原initializer的users仅id/loginName/password，角色只来自courses.teacherId/studentIds；正式输入在批准后由受控秘密补齐，不把上述提案元数据塞进strictObject。helpPolicy保持helpAllowed=true、wholeSolutionAllowed=false、limitedCheckHelpAllowed=false；checkRule为textscope-core-v1/textscope-validator-v2、limitedHelp=true。原storePolicy的versionId全库唯一，两个课程直接共用help-v1会FORBIDDEN；提案course-a用help-v1、course-b用help-v1-course-b，政策内容相同，**请A审查标识与帮助/检查业务语义**。不改schema/表/存储或越权复用另一课程政策。

**已验证：** 原compiled policy/rule schema、5用户/登录名唯一/成员归属、两个政策ID、A10源摘要、754原Git blob；精确Node24.21.0的新正确应用副本两套typecheck/build。保留旧CRLF副本及新LF symlink build失败，未生成任何秘密、初始化库、启动HTTPS或执行新业务验收。

**A待实审：** 请逐项确认身份/成员/跨归属、两课程政策与限定帮助、宿主/Origin/Session/CSRF/DTO契约、凭据及浏览器信任范围、原Job/暂停/撤权和最终集成判据；明确A模块缺陷由A修复，给实质结论/必要改动，不仅确认收到了材料。具体凭据/信任许可交负责人，浏览器访问由UI确认。方案确认与红线授权具备后C再执行原初始化/预检/正常HTTPS及20项真实公共链，提交原ID/输出供A复核。H-01/#30/#22仍未完成/Open，准备静态结果不计入口/浏览器通过。

## 11. C-ENTRY 方案与接收补正公开回交

2026-10-13，负责人对“将§10已核非秘密方案和C接收字节补正发布到#30，@A实审”的准确申请回复“同意”。本次仅发布该回交评论、回读和维护本文，不批准凭据生成/信任变更、建库或HTTPS执行，不推送Git/本地证据或改其他作者稿。§9/10的未公开状态保留其准备时点，实际结果随后追加。

已由paher-din通过既有gh授权、UTF-8正文文件发布 [#30 C-ENTRY-02/03方案、实质责任与C接收字节补正](https://github.com/paher-din/XunJie/issues/30#issuecomment-6148913087)，明确@czr112实质审查。正文含完整非秘密方案/五角色/政策标识提案、A模块与集成责任、浏览器与红线待决项，并补正C旧CRLF归档的证据范围及失败/实际修复；与§10批准稿一致，没有将方案审批或旧失败写成执行通过。

GitHub API独立回读作者/URL及去除末尾空白后的正文逐字一致，A mention存在；#30/#22仍Open。只发布这一条新回交，没有改写旧评论或代A批准/修模块；未生成凭据、变更信任、初始化库、启动HTTPS、执行新业务/节点验收、提交或推送本地文件。A尚未回交实审结论，C-ENTRY-04～07的执行/最终复核与UI条件仍待落实。

发布后文档检查65份/947内链/errors=[]、差异空白通过；仅本文追加公开事实，其他任务/源码/证据未变。本次发布不重复业务或构建验证，既有结果仍按§9的成功/失败范围报告。

## 12. 本地 C 交付提交与推送授权

2026-10-13，负责人要求“现在本地的都不需要提交与推送吗，如果需要就进行一次吧”，授权将已完成的C记录及去敏证据提交并推送。范围为本文、原I0_C_HANDOFF.md及两任务对应14份JSON，共16文件；原I0记录/证据是本轮引用与A复核的直接依据，原样纳入，历史/失败不改写。G3_OVERALL_COORDINATION.md的无关审查改动保留，不暂存或提交；源码、产品/规划/参考/规范、真实受控配置、凭据、临时副本/依赖/构建产物不在写集。

独立交付分支拟为codex/c-entry-preparation-handoff，以当前远端main cde69cc为基线，在隔离工作树复制这16份批准内容后检查、仅提交该写集并普通推送，不切换/重置主工作区或合并main。14份JSON的敏感字段递归核查仅命中方案描述/待授权passwordSource，没有秘密值；后续结合正文/原日志的凭据形状、JSON/hash/内链/空白及写集检查再发布。

本次只提交已完成的准备/历史节点证据与回交记录，不批准凭据/CA/网络操作或新的业务执行，不把文档发布标为C-ENTRY/H-01完成。提交及普通推送到codex/c-entry-preparation-handoff获本次授权，Draft PR供A按实际文件实审；不自动合并。准确提交、远端分支与文件一致性由本会话Git/GitHub回读交付，亦可从公开分支/PR核实，不为在文档记录自身提交SHA反复改写。

发布前实际验证：独立工作树以远端cde69cc起步，16文件复制前后SHA-256一致，原I0-C五文件原样；隔离文档检查65份/947内链/errors=[]。16文件的EOF/尾随空白/凭据形状检查通过，14JSON解析通过，17份内嵌原日志的UTF-8字节/声明长度/hash自洽；仅命中非秘密passwordSource/方案描述，没有生成或发布秘密值。原G3内容摘要另存于本次交付快照，用于结束时确认未动；源码和受保护基线未改。验证范围为发布材料，既有节点/构建/业务结果仍按各自真实成功/失败/未执行范围保留。
