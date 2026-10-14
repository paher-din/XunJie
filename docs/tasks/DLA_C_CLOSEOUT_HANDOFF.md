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

发布前实际验证：独立工作树以远端cde69cc起步，16文件复制前后SHA-256一致，原I0-C五文件原样；隔离文档检查65份/947内链/errors=[]。16文件的EOF/尾随空白/凭据形状检查通过，14JSON解析通过；当时内嵌日志核查选择三份接收/准备JSON中的17个logs条目，UTF-8字节/声明长度/hash自洽，这不是全部证据条目总量；全量口径见§13。仅命中非秘密passwordSource/方案描述，没有生成或发布秘密值。原G3内容摘要另存于本次交付快照，用于结束时确认未动；源码和受保护基线未改。验证范围为发布材料，既有节点/构建/业务结果仍按各自真实成功/失败/未执行范围保留。

## 13. 2026-10-14 A 实审接收、计数澄清与 C 连续执行

已读取 [A实质审查](https://github.com/paher-din/XunJie/pull/55#issuecomment-6150093231)、[精确授权转交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6150203466)，以及固定fe6d301的I0-ENTRY §9/10和更新后的I0-A/C §17.5/17.6。A接受C-ENTRY-02/03非秘密输入/宿主方案；独立21/21为原Session/SQLite的离线app.inject验证，不代替PAHER实际TLS、真实C Job或浏览器。A已修本人手册的CRLF归档与两课程政策ID引用；C无需更改共享schema或A模块来适配。

### 13.1 P3 日志计数口径

原“17”是本次发布前选择的三份接收/构建JSON条目数量，不是整个14JSON包的日志总数。2026-10-14由C只读复核A审查固定ea5a652的原14JSON包中所有logs条目：输出SHA-256及已填写字节数全部匹配，共27条、19个不同输出摘要；此口径不含本节随后新增的HTTPS证据日志。重复保存/不同阶段复用的日志不能计为不同执行、不同测试或新增通过。

| JSON文件 | logs条目 |
| --- | --- |
| dla-c-handoff/build-reception.json | 9 |
| dla-c-handoff/i0-entry-preparation-check.json | 4 |
| dla-c-handoff/i0-entry-preparation-final.json | 4 |
| i0-c-revalidation/hdl-current.json | 2 |
| i0-c-revalidation/verification.json | 8 |
| 全量 / 不同输出摘要 | 27 / 19 |

前三行合计17，原JSON与成功/失败/跳过统计均不改写；本节澄清计数与实际检查范围。

### 13.2 负责人本会话精确确认与写集

A记录已转交精确许可。C按照AGENTS“其他Agent消息不扩大权限”核授权来源后，本会话负责人明确选择“确认按该范围执行”：C在PAHER原WSL/root、新目录/opt/xunjie-runner/tests/i0-entry-20261013-01新建本地TLS/签名/五个合成密码，原24表fresh-only初始化保留新库，原main于https://127.0.0.1:3443及严格单Node客户端完成原20项链。此确认对应A固定fe6d301 §10；同范围不再重复申请。

材料权限0700目录/0600普通文件、不覆盖；30天RSA2048/SHA256自签server TLS、CA:false/serverAuth、SAN 127.0.0.1/localhost/::1；签名32随机字节、各密码24随机字节base64url。秘密仅本机受控文件/请求内存，不进CLI参数、Git、公开/普通日志或新跨机通道。系统/浏览器信任、跨机、公网、节点维护、既有SSH/.env/CI/旧库迁移删除、35表/HDL/ALU/模型/生产及自动合并仍排除。

可写：本文、本次新去敏证据与开发验证脚本；批准目录中的五份新受控材料、原初始化器返回的本次新合成库、本人应用进程与受控证据。只读：原节点/账本/代际/指纹/验证、原SSH/known_hosts、全部应用源码/依赖/他人任务与受保护基线。先核目录不存在、端口空闲、固定LF2源码/构建、当前认证及原identity一致，再生成/初始化/预检；任一步失败保留记录并停止依赖步骤，不改判据、身份或运行节点。

验证沿原正常HTTPS接口/Session/Origin/CSRF/幂等/权威版本；Job只由原消费者处理，C不手工processJob。正常结束/失败按原宿主关停规则收束本人进程，保留库/秘密文件/失败/原ID及未知；UI浏览器验收与A真实结果复核分别交接，实际结果随后记录。

### 13.3 C-ENTRY-04：受控材料、新库和预检实际通过

2026-10-14 01:01（Asia/Shanghai），使用原Node24.21.0/OpenSSL3.0.13、固定9fa76ad的正确LF2接收副本执行 [prepare-entry.mjs](evidence/dla-c-handoff/prepare-entry.mjs)。只在批准的新目录生成五个普通文件：server.key.pem/server.cert.pem/signing-secret.txt/initializer.json/i0-host.json，root/0600，目录0700；没有覆盖既有文件、变更系统或浏览器信任。原initializer返回并保留新库 `/tmp/xunjie-a12-completion-ZfUn7m/synthetic.sqlite`，SQLite3.53.4、24表、五用户、两课程，初始Assignment/Attempt/Job均0；不是预造学习对象。

证书CA=false/serverAuth、SAN匹配127.0.0.1/localhost/::1、私钥配对及30天期限通过；公开SHA-256指纹C3:F8:ED:37:E0:7C:34:1B:0F:CC:55:58:D0:FC:12:FA:B4:79:13:EF:71:D1:EC:80:77:A0:E0:84:44:47:51:73。有效期UTC2026-10-13 17:01:01～2026-11-12 17:01:01；开发演示用途保留。实际新材料/新库/当前原指纹与代际摘要在 [准备证据](evidence/c-entry-https/preparation.json)，没有公开私钥、签名值、密码、Session或CSRF。

生成前及启动前均经原application SSH/compiled availableRuntime核当前C1、validation、代际与handoff一致，原identity query相同/reserved=false；预检TLS与config原读取器通过。本次不维护节点、不换镜像或登记新指纹，原C/HDL验收不重复运行。

### 13.4 三轮真实HTTPS、两个验证错误与输入补正

实际执行器为 [verify-entry-https.mjs](evidence/dla-c-handoff/verify-entry-https.mjs)，仅spawn固定dist/server/main.js、监听127.0.0.1:3443、原自动消费者250ms；请求经过真实TLS/HTTP、原Session/Origin/CSRF和SQLite。Node客户端显式ca且rejectUnauthorized=true/默认主机验证，每个已记录响应均核socket.authorized及证书公开指纹；没有app.inject、fixture transport、手工processJob或Node维护。启动/退出原日志与原/去敏文件摘要见 [证据清单](evidence/c-entry-https/manifest.json)。

| 执行 | 实际结果 | 失败/范围与证据 |
| --- | --- | --- |
| 第一轮，01:11:56～01:12:08 | 第1～11项通过，第12项验证失败，第13～20项未执行；45个严格TLS响应；宿主正常SIGTERM/退出0 | [第一轮](evidence/c-entry-https/verification-first.json)、[HTTP](evidence/c-entry-https/http-first.json)。验证器把原对账期间短暂outcome_unknown当永久终态，过早关闭本人宿主并取消原Run。旧Run4aa7da80-5d21-4221-8274-5103d0d69e37/Job0e122937-dbb5-48b6-a223-e784b2d2fbdd保留，不改成成功 |
| 只读归因及第二轮，01:36:28～01:36:59 | 原同ID节点取消/result校验通过，再由原消费者确认应用cancelled；明确新合成Run继续第12～19项通过，第20项失败；155个TLS响应；正常退出0 | [第二轮](evidence/c-entry-https/verification-resume.json)、[HTTP](evidence/c-entry-https/http-resume.json)。修验证器同ID轮询至确认终态/150秒，不重发未知Run。第20项暴露“公开TXT”模板缺显式visibility，实际安全默认学生/辅导不可见，403正确 |
| 显式公开资源的新版本完整轮，01:47:01～01:47:34 | 原20项全部通过，20/20、0失败/跳过；174个TLS响应；正常退出0 | [完整轮](evidence/c-entry-https/verification-final.json)、[HTTP](evidence/c-entry-https/http-final.json)。原教师接口新建visibility.student/tutor=true的合成ASCII资源、新活动/分配/尝试；原已固定版本、失败与Run保留。后端默认保护不改，A需补本人手册“公开TXT”的明示visibility |

第一轮“terminal=outcome_unknown”是当时验证器的错误标签，不是已确认执行终态。原C worker claimRunReconciliation在异步查询同一执行身份期间临时呈现unknown；修正只在C验证脚本，真实后续轨迹显示running→unknown→running→succeeded。脚本两条状态序列自检在--self-check下通过：未知不能结束成功/取消轮询；恢复在原消费者确认旧取消后才明确新运行，原键/身份不被改贴或自动重发。

第二轮“公开TXT”来自A手册§17.5省略visibility的模板，原prepareMaterial安全默认false/false；C输入也未核明示分享。没有把403改成200预期或放宽保护；按原教师显式分享接口新建合成资源和新的固定版本后再完整验证。旧资源不可见事实与两个旧失败验证器版本保留在受控目录，A模块源码/契约未改，A手册补正及结果实审交A。

完整轮覆盖五真实登录/角色归属、页面/实际资产与匿名401、教师创建/检查/确认/分配、无副作用bootstrap/跨归属拒绝、学生显式创建、sync重放/冲突/旧revision、ACK后权威head/固定快照、原Job自动真实C1、旧快照因果、原run键重放、可信失败及私有产物redacted、真实报告正文/bytes/hash、取消确认/原键重放、教师暂停/已有保存/快照及新操作拒绝、旧代际拒绝/恢复GET无副作用、Origin/CSRF/私有/跨归属/static拒绝。程序为获准合成工程输入；course_check按TextScope真实返回failed，这一预期通过不表示课程作品或学生能力通过。

不把三轮通过相加计新用例。原先第一轮真实传输断线/未知故障未注入；本批unknown源自正常同ID对账，不冒充节点故障。B模型、HDL/ALU、NFR负载/备份、真人与教学效果仍未执行。

### 13.5 C-ENTRY-07：保留、主动入口及停止状态

通过 [prepare-ui-handoff.mjs](evidence/dla-c-handoff/prepare-ui-handoff.mjs)用同一正常教师接口显式resume本次合成分配，原暂停证据保留。最终合法Assignment为9906a7af-a43e-44da-a395-db8491c4cbbf，Activity为ef2137d8-641d-480f-b1c1-9c60d3c5975a，Attempt为e284d4ab-29b3-49fb-ac3e-5d2b35e2fb17；assignmentRevision=3、active=true。受信bootstrap/API入口及启动/领取方法在 [UI交接](evidence/c-entry-https/ui-handoff.json)，UI自有hash路由/登录接线仍待实现，不填虚构前端深链。

首轮UI交接验证器仅等1秒，进程尚在启动时ECONNREFUSED；保留 [首次失败](evidence/c-entry-https/ui-handoff-first.json)及代码/原日志。改为只读live探测就绪后正常登录/teacher resume/学生bootstrap通过，没有重建库/凭据或绕过TLS。最终本人HTTPS进程正常SIGTERM/退出0，stopConfirmed=true，当前serviceRunning=false；不宣称入口持续在线。原九个student_run Job最终为6 succeeded/3 cancelled、queued/running/cancelling/outcome_unknown共0，未SQL强改状态。

后续获准启动仍在固定LF2 apps/teaching，用原Node24.21.0、PORT=3443、XUNJIE_I0_CONFIG=/opt/xunjie-runner/tests/i0-entry-20261013-01/i0-host.json执行原main。五账号秘密仅由PAHER原WSL/root受控进程在内存消费initializer.json选定账户字段；公开只给loginName和引用，未发送密码、复制到跨机新通道或给浏览器导CA。C只保管本批新增材料，TLS和登录已由严格Node客户端实测，不表示UI浏览器已可用。

原JSON/日志/失败/验证器代码/库/九个Run与私密文件全部保留。公开HTTP版本删除生成资产rawBody、保留其实际字节/hash；auth和私有资料正文只在请求内存/原业务库，不存入公开输出，缺原正文摘要处明确标省略，不能以去敏hash冒充原hash。清单分别标原受控文件与公开文件的字节/hash和投影。以五个实际生成密码、签名值、私钥正文对新公开文件及五份服务原日志作值匹配检查：未发现秘密值；受控配置/初始化器/SQLite文件不入Git。

### 13.6 当前交接结论

C-ENTRY-04～06的获准服务端批次已实测通过，07的C证据与操作材料已备；需向A回交复核、由A修手册并核原结果。A仍负责身份/权限/宿主/契约和最终集成质量；UI负责准确同机访问/浏览器信任方案及实际接线/验收。本批未获系统/浏览器信任、跨机/安装工具/节点维护/生产权限，未自动合并PR或关闭#30/#22。H-01/G1及完整UI/AC/NFR仍未完成；产品基线及MVP§10待授权维护者汇总。

本轮发布写集限本文、三份本人验证脚本和十份新去敏HTTPS JSON；既有14JSON与I0-C历史原文不改。原source/secret/config/database/.env/CI、A/B/UI代码与作者稿、product/planning/reference/AGENTS只读或按明确排除项保留，G3无关改动不暂存。验证脚本syntax/未知状态序列、清单字节/hash、HTTP原JSON一致性及实际秘密值扫描、内链/空白均核后提交；普通推送本PR并按H交A复核，实际URL/提交回读在本会话交付。

## 14. 2026-10-14 C 配合浏览器方案与 HDL H3/H4 补交

### 14.1 本批依据、范围与实施前记录

负责人要求完成 [#30 当前安排](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633) 的 C 部分。本批复用 §13 的真实20项、库、账号及对象，不重跑整包，不重新初始化或生成秘密。已读 README/AGENTS，PRD §1.1/4.5/5/6/8，MVP_SPEC §1.4/2/M-03/M-09/M-10/4～7，TECH_DESIGN §1～2/4.3～5/7.4～9，TEAM §2/7 的 DL-C/8.5～8.6/9，DL-0 §2.3，I0_UI_SPEC、I0_UI_CLIENT_CONTRACT 与 IMPORT_SOURCE；契约依据为原 H-01～06、DL-AC-03～09、AC-02～04/06/10/12/15、NFR-03/04，完整验收门槛不变。

计划：只读核 PAHER 浏览器候选/位置/profile、WSL/端口/保留文件元数据及原认证 readiness；交 C 侧运行窗口、精确信任与账号最小领取提案给 A/UI。接收 PR #56 固定运行源 89c85ed 和原始字节清单，只核源/归档，不安装依赖、组装35表配置或启动新宿主。基于该固定源补 H4 真实只读接口/当前性取得与缺口、H3 层级/采样/占用/command-result/准确写集和2800向量预算；共享接缝仍是提案，不实现 ALU。

可写仅本文、本人 evidence/dla-c-handoff/ 下本批核查脚本及 evidence/c-entry-followup/ 的去敏输出/固定源接收副本。受控现有配置/密钥/密码/数据库只读，原 I0 24 表库保留；A/B/UI 源码与作者稿、product/planning/reference/AGENTS 只读。使用现有工作树/PR #55，完成检查后普通提交/推送并向 #30/#38 回交，不合并或关闭 Issue。

原批准覆盖 WSL/root、既有 I0 宿主与单 Node 严格客户端，不覆盖 Windows 浏览器信任/账号交付通道、35表现场、ALU/节点维护或模型。只读信息不代替 UI 双方确认；尚缺浏览器/profile/时间或新操作授权时标明确责任人与未执行，不假定认可或到期视为批准。

### 14.2 PAHER 当前现场：原临时库已缺失，节点未运行

2026-10-14 12:23（Asia/Shanghai）实查，见 [现场只读输出](evidence/c-entry-followup/onsite-readonly.json)、[VM状态](evidence/c-entry-followup/service-state.json) 与 [Windows浏览器条件](evidence/c-entry-followup/windows-browser-conditions.json)。核查命令为 WSL/root、Node24.21.0 执行 [只读脚本](evidence/dla-c-handoff/inspect-entry-followup.mjs)；服务状态另用 `systemctl show xunjie-c1-vm.service --property=ActiveState,SubState,Result,ExecMainStatus`，没有 start/restart。

| 对象 | 本次实读事实 | 当前影响 |
| --- | --- | --- |
| 既有I0秘密/配置 | §13原五个文件仍为root/0600；证书公开指纹、SAN与有效期一致 | 可保留复用；没有输出私钥、密码或签名值 |
| 既有I0库 | 配置所指 `/tmp/xunjie-a12-completion-ZfUn7m/synthetic.sqlite` 当前不存在，父目录也不存在；首次只读打开因此失败 | 旧Assignment/Attempt/Run仅有§13历史证据，不能宣称现仍可读或新建同ID代替；没有重建库/改配置 |
| 原节点 | `xunjie-c1-vm.service` 为inactive/dead，ExecMainStatus=0；原认证readiness与hdl_readiness均DEPENDENCY_UNAVAILABLE | 当前ready/profile/validation/代际不能确认；不能沿历史true开放运行，未维护节点 |
| 入口/WSL | Windows与WSL的127.0.0.1:3443均未监听；WSL启动时间为2026-10-14 12:21:08 | 两侧端口空不证明Windows→WSL HTTPS可通；库缺失原因未查明，不能把启动时间当作删除原因证据 |
| 浏览器位置 | PAHER Windows/p3148；Chrome155.0.8059.40、Edge155.0.4283.45；WSL无google-chrome/chromium/firefox | 使用Windows现有浏览器作为候选，不安装新浏览器 |
| profile/信任 | 两浏览器默认User Data下均有Default；Windows CurrentUser/Root、LocalMachine/Root均无本证书相同DER摘要 | UI尚未选定profile；没有读取cookie/历史/账号库，没有浏览器握手、证书导入或警告绕过；store检查不等于完整浏览器信任判定 |

本节更新此前“库保留”的当前可用性，保留§13完成时点的事实与原证据。缺失不补造，不改旧结果；需要A/负责人确定原库恢复来源/范围，若无获准可恢复副本，再由A提出fresh-only新库及新对象方案。本批没有自动改为重新初始化，也不把恢复/重建纳入原单Node授权。

### 14.3 交 A/UI 的浏览器、账号与运行窗口方案（C侧已核；待双方核对）

**固定来源：** I0服务端仍9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77/LF2；其中apps/student tree为35e190c6101a6172c171a5f8756836f61509aefe，与89c85ed及0e68325中的学生树相同。这是现已交静态产物的源，不代替UI随后接线的源码SHA；UI回交实际接线SHA后再核组合。

| 项目 | C提供的具体方案/条件 | 待确认角色与权限 |
| --- | --- | --- |
| 浏览器/profile | 首选现有Windows Chrome155；已存在 `C:\Users\p3148\AppData\Local\Google\Chrome\User Data\Default`，只读核存在。建议UI联调改用独占新目录 `C:\Users\p3148\AppData\Local\XunJie\CEntry-UiProfile-20261014`，避免写入日常profile；该目录未创建 | UI确认Chrome、p3148及具体profile，回交实际版本/目录。若选Edge须另给准确同机profile；不能将C候选写为双方已同意 |
| 同机访问 | 仅原Origin https://127.0.0.1:3443，WSL原main只监听127.0.0.1；现 `.wslconfig` 的networkingMode=NAT | 恢复获准且readiness通过后，先WSL严格Node GET health，再Windows不登录TCP/严格TLS核SAN/指纹，最后所选浏览器无警告正常访问。失败回交，不添加portproxy/0.0.0.0/跨机入口 |
| 精确信任提案 | 只复用现有CA:false自签server证书；先核DER SHA256 `c3f8ed37e07c341b0fcc5558d0fc12fab47913ef71d1ec8077a0e08444475173`、SAN、有效期。若UI确认缺信任，候选为仅Windows用户p3148的CurrentUser/Root中显式添加这一张公开证书；不导私钥、不改LocalMachine/Root | A先核现有CA:false证书在实际Chrome的可用性及方案；负责人须明确批准该用户信任库写入。独占profile并不将Windows用户信任隔离到该profile。若当前证书不适用，另提准确证书方案，不能自动生成CA或关闭验证 |
| 拟执行信任步骤 | 获准后C仅导出现有公开证书到获准Windows本机路径，前后核上述DER摘要；UI/执行人通过Windows用户证书管理器或原 `certutil -user -addstore Root <public-cert>` 添加精确对象，再在所选浏览器核无警告TLS。全过程尚未执行 | 原授权明确排除系统/浏览器信任。信任将影响该Windows用户的其他消费方；后续移除同一证书/临时文件也须覆盖删除对象的授权，不擅自操作 |
| 账号领取 | 公开仅synthetic-i0-student-a及原initializer.json引用，默认只领该学生；教师/其他四账号按具体用例另限定。原root受控进程内存消费不等于浏览器已经领到密码 | 最小新增通道提案：UI已有获准的PAHER本地浏览器自动化进程以匿名管道从WSL/root读取**所选一条**loginName/password，仅在进程内存填UI正常登录字段，不经CLI参数/终端/剪贴板/文件/聊天/日志，不传整份initializer。该跨WSL/Windows秘密消费对象须A核对并获负责人许可；未实现、未发送秘密、未假定已有此自动化能力 |
| 正常登录/合法入口 | 原POST /api/sessions→GET /api/session→原Assignment/bootstrap。固定历史对象和URL直接引用 [§13 UI材料](evidence/c-entry-https/ui-handoff.json)，不另造ID或深链 | 当前旧库缺失，原对象不可用。恢复前不登录；恢复后正常Session/Origin/CSRF，不能预填cookie绕过登录。UI必须给正常登录交互及分配选择/空态的实际接线 |
| 页面缺口 | 固定UI main.tsx有task/:taskId；TaskRoute仅PREP_BUILD+准备ID进入I0准备页，正式构建走原WorkspacePage。准备ID不代表合法Assignment；未见正式Assignment到该页面的已交接线 | UI补正常登录、本人分配→现有页面、未分配与暂停显示；有403/未知如实显示，不把bootstrap API URL声称为前端深链，不由C新增页面 |
| 运行窗口 | 提议在恢复/操作批准、A核配置、UI回交profile和接线SHA后，由UI确认一个30分钟同机窗口；C执行启动、就绪及停止，UI操作浏览器；未约定具体起止，不表示入口在线 | A协调确认条件；UI确认实际时间。窗口末C只SIGTERM本人进程、核原Job/Session终止；未确认保持cancelling/outcome_unknown，不停节点、不删除保留材料 |

信任依据为 [Chromium当前官方说明](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)：Windows Chrome消费显式用户信任，CurrentUser/Root属于其读取范围；[certutil官方说明](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil)给出用户store/addstore能力。这些说明不证明当前CA:false证书已经被实际浏览器接受。本批只读核与提案无需等待A完成全部历史证据实审，实际写入/恢复/启动依对应门禁。

分批运行沿评论次序：身份/合法入口/空态→bootstrap/恢复读取→保存/ACK/head/快照→原运行/停止/历史产物；C只响应具体workspace/records/runner问题、原对象同ID查询及输出。无具体新增代码/失败不重跑20项。浏览器未执行不能代填H-01～06通过；A继续负责本人实审/visibility手册修正与模块修复。

### 14.4 DLA-H4：已有读取、current规则及样例缺口

本节以 [PR56固定源](https://github.com/paher-din/XunJie/tree/89c85ed04db5a55ddebdc95c27303f0ff76fa31c/apps/teaching) 为准，完整字段/代码摘要与**说明性投影**见 [H4读取清单](evidence/c-entry-followup/h4-read-contract.json)。说明性投影不是实际节点输出、完整DTO或新增验收；本批节点未运行且35表正常组合未执行，无法补真实目标Build/Session/Operation/current样例，明确保留该缺项。

| 已有真实接口/读法 | 返回与使用限制 |
| --- | --- |
| GET /api/hdl/builds/:id；hdl.readBuild(tx,actor,buildId) | 原request/result/status/jobId；result可为null。核snapshot所属/hash、scope、配置/版本、持久原结果hash。request含快照源码，不能整包送B；仅A授权投影必要源码/去敏诊断 |
| GET /api/hdl/sessions/:id；hdl.readSession(tx,actor,sessionId) | 原Session身份、Build/快照/版本、revision/confirmedSequence/simTimePs、pendingOperationId、stopRequested、terminationConfirmed。GET只读不推进，不替代当前授权 |
| GET /api/hdl/sessions/:id/trace?afterSequence=-1；hdl.readTrace(tx,actor,id,afterSequence) | 单页返回一个后继Operation及nextSequence；不是operationId精确读。无记录operation=null；pending时result=null、nextSequence不推进，调用方停止忙循环，等原Job/原操作再查 |
| 原节点hdl_query / hdl_result | 仅应用受控SSH原identity；program的初始结果operationId=sessionId，后续为原Operation identity.id。不能从浏览器/模型直连SSH或用另一个ID代查 |

供UI操作表核对的已有写入口均为正常Session/Origin/CSRF与原idempotency-key接纳；公共body含recoveryGeneration和expectedAttemptRevision，不由页面构造ActorContext：

| 操作/已有POST | 其余固定输入及回执 |
| --- | --- |
| 构建 /api/attempts/:id/hdl/builds | snapshotId；返回原receipt/result中的buildId/jobId，后续读原Build，构建成功且terminationConfirmed才可装载 |
| 装载/替换 /api/attempts/:id/hdl/programs | buildId；替换须同时replaceSessionId/expectedSessionRevision；回sessionId/operationId/jobId，不把受理当active |
| SW/按钮/reset/推进 /api/attempts/:id/hdl/interactions | sessionId/expectedSessionRevision/expectedSequence、inputs={switches:16位二值串,buttons:5位二值串,resetN:1位二值串}、advanceCycles；同一命令施加输入并显式推进，按下/松开分别发起；回原Operation/Job，不用UI定时器产生模拟时间 |
| 停止 /api/attempts/:id/hdl/controls | action=stop及reason；回stopRequested=true，只表示受理。查同一原Session/Job至terminationConfirmed，不补发program或把超时当已停 |

保存/快照沿既有C2与H-05接口；HDL求助当前不可用，不能把B静态提案或fixture消息填成真实回执。诊断位置只给确认快照的有效file/line，未知保持unavailable。UI独立列已有/模拟/缺失与实际按钮消费，不由本表宣告页面已接。

**状态消费样例：** pending的active Session+旧confirmedSequence只表示旧帧，不能当新输入已应用；stopping+terminationConfirmed=false表示停止未确认；stopped+true才释放原占用。替换是显式replaceSessionId+expectedSessionRevision、原Session确认终止后新Session revision=1/sequence=0，旧结果保留；outcome_unknown仅同原身份查询，不能新建Session重发。新草稿不改变旧Build；换快照/Build/Session/sequence/代际后旧帮助均不可作为当前。数码管低有效、X/Z与Trace dropped/coverage照实消费，不从ALU数值补正确板输出。

**同事务current取得提案：** A从正常Session授权，在一个SQL事务内读课程成员/账号、Assignment/活动控制、本人Attempt/decisionEpoch/learnerStateRevision/代际、原Help Job/冻结选择，再调用以上C reader。显式核同course/student/attempt/activity、snapshotId/hash、buildId/artifactHash/configurationHash、board/mapping/runtime/engine与Session/Operation所属、sequence/revision、finalFrame模拟时间/resultHash。pending、停止、替换、过时与终止不明拒绝作为当前；事务外才调模型/网络。调用前/返回后/候选提交/Delivery/Receipt接纳各复核原冻结链，不自动改成最新对象。

**尚未实现、请A汇总确认的最小C接缝：** `readOperation(tx,actor,operationId)` 精确读，先复用Session/Build授权，核request_json的identity/请求摘要、row与result原字节hash、Session/Build/快照/sequence/revision/finalFrame绑定；pending结果保留null。`readTrace`现有校验不能冒充此完整校验。`readHdlCurrent(tx,actor,selection)`只作同步事务投影，不自建公开路由、查询节点或替A作身份授权；返回原字段与明确当前性原因，具体status/error映射经A/B确认。旧ObjectRef不能把runId充buildId；新hdlSelection及C3输入hash/投递接线仍是A §18.3待确认提案。

未来C可写范围为workspace/hdl.ts、hdl.test.ts、必要hdl-inputs.ts及records已有student_question冻结/accepted-input hash对应实现与测试；由A先固定新增字段/函数/投影和准确调用方清单。A负责正常授权/宿主装配，B负责内部上下文适配，UI负责操作表/页面。当前fixed digital-logic.ts故意把help置DEPENDENCY_UNAVAILABLE，不在本批放开；不调用模型。

### 14.5 DLA-H3：层级、采样、占用和2800向量的精确执行提案

沿用 [首批H3](https://github.com/paher-din/XunJie/issues/38#issuecomment-6147371151) 与 [A固定会审§18.2](https://github.com/paher-din/XunJie/blob/87a3b795b0e457445edbcd40ecf985e3a0dac012/docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md#182-h3alu可信行为检查的a会审结论与待确认提案)，不重新制作节点材料。下列都是待A会审/负责人确认的新增方案，未实现、未冻结共享契约。

1. **层级语法/解析：** 绑定用结构化 `{instanceSegments:string[],signal:string,offset:number,width:number}`，每段沿原identifier白名单 `[A-Za-z_][A-Za-z0-9_]{0,127}` 且不以xunjie_开头；最多16段、拼接后1024字符。路径锚定受信wrapper的 `xunjie_board.dut`，只解析这一Build的elaboration；拒绝点号嵌入段、转义标识符、斜线、通配符、任意索引表达式/宿主路径、系统任务、任意VPI脚本。S允许同一2位端口或两个显式1位引用，逐bit冻结顺序，不假设S0/S1命名。须为同一显式ALU实例的真实输入端口A/B/Cin/M/S与输出F/Cout，宽度4/4/1/1/2/4/1；拒绝inout/别名跨实例/重复位，核真实direction及左右界，按right+方向映射offset。普通命名/嵌套层级可自选；生成块/escaped名称本版先明确不支持并报配置不可用，不误判学生功能错。教师确认bindingVersion/hash只确认可定位，不确认功能正确；板SW映射仍由学生选择、逐bit无重叠。
2. **稳定采样提案alu-lowphase-3samples-v1：** 沿现有100MHz、5000ps半周期、全局1ps～1fs精度换算及VPI只读同步回调；输入在低相位+1ps施加，先弃第一低相位，再取第2/3/4个低相位的只读样本（20/30/40ns）。三次实际A/B/Cin/M/S必须和该向量一致；被评分F及加法Cout须为确定值且三次相同，才比较。输入不符为绑定/未完成；有已核输入而评分输出X/Z为行为失败；三次输出改变、缺样本、时间不符/零时死循环为incomplete/unknown，不passed。固定采样窗是待批准的可观察稳定条件，不证明任意RTL以后永不改变；不能自动扩等待时间或反复取到一次正确值。未定义Cout可X/Z而不评分，公开板卡Trace仍独立按真实输出绘制。
3. **占用约束的最小选择：** 原SQL索引 `hdl_occupied_attempt` 对每个Attempt、termination_confirmed=0唯一；原hdl-node.program也拒绝同Attempt第二个未终止Session，全节点最多2个。建议本版**保持这两个约束不变**：学生交互Session未确认终止时拒绝/标检查尚不可用，学生显式停止并确认后再显式发起独立check Session；不自动停止、替换、排队重发或恢复学生Session。检查结束后也不自动装载。这样不必DDL/扩大并发；若负责人要求边交互边独立检查，则须另审purpose占用索引、节点配额/控制接缝及schema，不能仅绕过SQL约束。
4. **command/result提案：** 新受限 `hdl_alu_check` request冻结原identity/scope、checkId/jobId、成功buildId/artifactHash/snapshotId/hash/configurationHash、bindingVersion/hash、rule/validator/vectorSetHash/samplingProfileVersion、board/mapping/runtime/engine/images/sourceHash、代际/decisionEpoch。仅获准配置派发；新purpose/命令联合类型先确认，不把它塞成现有interact或TextScope course_check。一个原Job/独立Session内部有界批次执行，按原身份查询/取消，重放返回同Job，不新建check补未知。对外结果只给绑定/版本、状态/coverage/去敏类别、terminationConfirmed/resultHash和私有证据引用；原四态样本及比较器结果留受控资产，不进入学生/B上下文。passed须2800完整比较、规则/绑定一致且确认终止；failed指明确题目域不符；incomplete/unknown/cancelled与原Job的精确映射由A/C确认，不扩原公共status集合。
5. **限额/向量：** [预算自检](evidence/c-entry-followup/h3-budget.json)重新核4096=2800+1296；逻辑2048、加法512（F/Cout）、A>B减法240（仅F）。按M/S/A/B/Cin升序枚举定义域，32向量一批，共88批，每向量4周期，11200周期/112000000ps。每批96个被比较样本≤4096；内部紧凑私有行 `[index,simTimePs,17位四态观察值]` 上限70字节，batch信封上限2048字节，含全部8400样本、88信封与初始化/结束预算774368字节<1MiB，单包8768字节<64KiB。必须在编码/落盘前检查真实字节，不能照用现有完整SignalFrame/OperationResult重复字段后仍声称该预算成立。保持step≤2秒、cycles≤500万、Session≤30分钟/idle≤5分钟、总2Session及原资源/公平调度；建议检查Job整轮≤原120秒。88×2秒上界超过整轮期限，因此数学预算不保证吞吐，实际2800必须实测同时满足两者；未完成即incomplete，不加时/删向量记通过。

**准确待确认写集：** C新增 `runner/alu-check.ts`（窄校验/比较与反例）、`runner/alu-check.test.ts`；修改 `contracts/runner/hdl.ts`（受限命令/结果/purpose）、`runner/hdl-profile.ts`（结构化绑定/版本/预算验证）、`hdl-ports.c`（编译后层级/端口解析）、`hdl-bridge.c`（只读原始语义采样，不接受学生VPI）、`hdl-executor.ts`、`hdl-session-worker.ts`、`hdl-node.ts`、`hdl-ledger.ts`（专用受控检查/私有结果与原停止）；`server/workspace/hdl.ts`、`hdl-inputs.ts`及 `hdl.test.ts`（原Job/回执、授权钩子、purpose与读取投影）。若需要额外记录事件，只复用原records命令/Job函数，不预先改其全域语义。原hdl-schema.ts/DDL/旧库保持不改；JSON strict schema新增字段也须作为共享变更确认，不因“无DDL”跳过评审。

A负责design课程/活动/教师binding确认、checkRule、权限/正常宿主/自动消费者及其测试；B/UI仅接获准投影。C计划反例覆盖合法不同层级/SW、错宽度/伪路径/别名、正确及错误六操作/加法进位/A>B边界、未定义域不评分、评分X/Z/非稳定/伪stdout、私有资产不泄露、重复/冲突/错Build/hash/旧代际、占用拒绝、暂停/撤权/提交/迟到/停止不明、真实2800限额。本批只做枚举/预算，不执行该矩阵。runner/VPI变化会移动共同sourceHash与镜像，必须独立批准节点维护/重验/登记范围；现ready不可用更不能沿旧validation启用。

### 14.6 PR56接收与本批交付状态

[固定源接收](evidence/c-entry-followup/source-reception.json)：已从PR56发布提交87a3b795b0e457445edbcd40ecf985e3a0dac012取得运行源89c85ed04db5a55ddebdc95c27303f0ff76fa31c和A原773项manifest（SHA256=7abd074f5fd1b79e197dec30ff4166dadfe07e6f10de9129c0d05c6bbfb57b7c）。PAHER新目录 `/opt/xunjie-runner/tests/dla-source-89c85ed-20261014` 中773个文件的Git blob/SHA256/字节/mode均一致；[runner34文件离线指纹](evidence/c-entry-followup/runner-source-alignment.json)仍匹配历史sourceHash。首次C新tar默认mode0664/0775与Git不符，保留失败包；新包仅指定tar.umask=0022、core.autocrlf=false后全部一致。C tar不冒充A原zip或其zip摘要；未安装依赖、建35表库、启动HDL宿主或维护节点。

| 交付 | C本批状态 | 后续责任/进入条件 |
| --- | --- | --- |
| 现场条件、运行/信任/账号方案 | C侧已核并提出准确方案；没有UI共同确认或实际浏览器结果 | UI回浏览器/profile/时间/接线SHA；A核组合及最小新增秘密/信任通道；负责人只审批未覆盖对象 |
| 原I0运行配合 | 当前阻塞，未启动；不重跑20项 | A/负责人明确原库恢复/无备份时新库新对象方案及节点原服务启动范围；C获准后先核当前readiness/profile/代际，再逐能力运行 |
| H4 | 固定源已有读法/当前性/状态说明已补；目标真实样例仍缺 | A确认readOperation/current/hdlSelection及C3接缝；对应35表现场门禁齐后C交真实样例，B/UI各接消费 |
| H3 | 原首批引用与精确层级/稳定采样/占用/command-result/写集/2800预算已补 | A会审，负责人确认共享与实施/运行范围；未批准前不实现ALU、不改节点 |
| PR56固定源/原字节清单 | 已实际接收，773/773匹配 | 35表现场输入与配置另交A审查，原I024表不能扩权或被迁移/覆盖 |

历史20/20与已有C/HDL验收不累计。#30/#38/#22/#23保持原状态；产品基线及MVP_SPEC §10待授权维护者汇总。没有把C准备完成写成双方方案确认、浏览器/H-01通过或完整C-ENTRY再次完成。

### 14.7 本批验证与交付

[核验记录](evidence/c-entry-followup/validation.json)列8份去敏证据/脚本的实际字节与SHA256；本任务正文与核验记录自身不循环自签。773文件接收及34文件runner源匹配通过，2800定义域/88批/实际编码预算上限断言通过；它们不计真实HDL执行。只读脚本syntax通过，现场实跑在库不存在分支完成，readiness不可用和VM inactive如实记录；库存在时的SQL读取分支本批未执行。Windows浏览器/系统信任只读探测完成，没有浏览器操作。

文档静态检查65份/970内链/errors=[]，git diff --check通过。按实际五密码/签名/私钥共7个秘密值在原WSL/root内存比对本批写集，matchedFiles=[]，没有输出秘密。新源码接收首次mode不符与首次只读开库失败的原因/保留位置均记入证据，未绕过检查或重建库掩盖。

交付沿原PR55普通提交/推送，按#30回共用现场条件/当前阻塞、按#38回H3/H4与固定源链接，不重复贴整包日志，不合并PR、不关闭Issue。主副本G3等其他成员改动不纳入。当前只完成本批可独立的C核查/方案/接收，UI共同确认、A实审及新授权后的现场/浏览器/35表真实样例仍待对应责任人；未实施部分不能因本次推送变成已通过。

发布前检查：三脚本Node24.21.0语法通过，原ID unknown→确认成功/取消序列自检通过；九份公开结果/HTTP文件的原文件与公开字节/hash、五份服务日志正文/hash匹配。十JSON的解析/EOF/尾随空白及私钥/token形状检查通过；以实际生成的五密码、签名秘密和私钥对全部新公开材料/脚本及服务日志匹配，秘密值均未出现。文档65份/960内链/errors=[]，差异空白通过；没有为发布重复执行已通过业务链。A审查固定ea5a652原包的27 logs/19摘要口径与随后新增五服务日志分开，不累计为测试通过数量。

## 15. 2026-10-14 I0 现场恢复

### 15.1 当前请求、诊断与操作范围

负责人本轮要求修复“原I0临时库不存在、执行节点已停止、readiness不可用”。沿本文§14已读基线，补读PRD §8、MVP M-09/M-10/§4、TECH §7.4/7.5/10.1/10.2、C0_GLOSSARY与C0 ADR-0001、原C1 vm.sh及I0初始化/配置/数据库守卫；目标为恢复同机开发联调，不改产品/共享契约。采用diagnosing-bugs：只读复现命令核原配置库存在及原VM active，两个条件均false、退出2，见 [故障复现](evidence/c-entry-recovery/diagnosis-before.json)。

排序假设：①WSL生命周期结束，瞬态VM单元消失且开机临时清理移除库；②持久服务存在但未自启；③VM/节点启动失败。只读结果 [存储/服务](evidence/c-entry-recovery/diagnosis-storage-service.json) 为LoadState=not-found/无FragmentPath及unit文件；原8.8GB qcow2仍在；vm.sh本来以systemd-run创建瞬态单元。宿主启动执行systemd-tmpfiles --create --remove --boot，规则为D /tmp；原root受控目录和/opt下未找到.sqlite备份。前两次诊断的WSL启动时间不同，没有原保活wsl.exe。证据支持①，未见③的启动失败日志；没有审计记录能逐文件证明过去删除者，不补造因果。

本轮可写本文、本人recovery证据与恢复脚本。用户明确要求修复所指原节点，按原vm.sh start复用同一qcow2/KVM/2vCPU/4GiB/loopback2222，恢复原本机隐藏WSL保活和原应用身份只读readiness；不安装、换镜像/源码/指纹、改密钥、开新网络、重验/登记或新增开机任务。只恢复原服务运行属于本次明确请求；若现有指纹/代际不符或有未结作业则停止后续并回交。

**数据库尚待红线确认：** 受控根目录内没有原库副本，不能从HTTP日志补造旧库/原ID。建议用原9fa76ad初始化器、原五账号密码/TLS/签名创建全新24表合成库，将TMPDIR限定到原root/0700根目录下的新retained-tmp（初始化和宿主同设，沿原tmpdir目标守卫），新建i0-host-recovered-20261014.json只指向原初始化器实际返回的新库。保留旧配置/历史/ID，正常教师/学生API建立新对象并给新交接，不宣称恢复原记录。无旧库迁移、无删除、新秘密/35表/浏览器信任或生产。创建schema须按AGENTS红线说明对象/风险后由负责人确认，未确认不执行该部分。

数据库恢复方案将先备成可审查脚本，核语法/只读prepare；准备、批准、实际执行与验收分开。重新可用后须严格HTTPS、会话/授权、原自动消费者/C1运行及有界停止查询验证；历史20项不拿来代新环境通过。产品基线与MVP§10待授权维护者汇总。

### 15.2 原节点恢复与 HDL 策略持久加载

恢复原隐藏WSL保活后，用9fa LF2原vm.sh start成功启动同一VM；C认证readiness=true、原sourceHash/指纹/代际匹配。首轮HDL仍ready=false，实际响应与首次断言失败说明保留在 [启动后探测](evidence/c-entry-recovery/node-start-probe.json)，不改成第一次全部通过。

[AppArmor只读核查](evidence/c-entry-recovery/apparmor-before.json)确认服务active，但内核无xunjie-dlc-v1，/etc/apparmor.d无该策略。原hdl-install仅apparmor_parser加载源码文件，没有将其安装到持久自动加载目录；重启会丢内核加载状态。原策略源SHA256=27ccaf139da03c3102e9f05e783c84c230fb8eeee5bbc2bfed1df2e91f878d44，与固定9fa原blob完全相同。

本次针对负责人明确要求的readiness修复，仅在原guest独占新建/etc/apparmor.d/xunjie-dlc-v1（原策略逐字节，root/0644；目标存在则停止），由原apparmor_parser装载并核enforce；沿现有apparmor.service的启动扫描持久加载，不增加新服务/任务、不改规则、源码/镜像/指纹或validation登记。原SSH维护身份仅用于本次节点恢复，不交给应用。恢复后再经原application key严格认证读取两种readiness并核当前指纹/代际。

实际结果见 [策略恢复](evidence/c-entry-recovery/apparmor-after.json)、[当前节点](evidence/c-entry-recovery/node-after.json)：2026-10-14 12:45两种ready均true，C指纹b07cddf9…、HDL指纹ea84f8d5…及原代际一致，无需重验/改写登记。本次没有执行新C/HDL作业；旧库仍缺失、HTTPS仍未启动。原节点保持本机运行、隐藏保活PID见 [运行引用](evidence/c-entry-recovery/keepalive.json)。不承诺跨Windows重启持续在线，也不通过重启原guest来测试持久加载；现策略文件/字节及内核enforce已实核。

根因依据：[微软WSL官方说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)明确systemd服务不维持WSL实例生命周期；[systemd官方手册源码](https://raw.githubusercontent.com/systemd/systemd/main/man/tmpfiles.d.xml)的D类型在--remove时清目录内容。结合现场D /tmp和开机命令，旧库位于会被清理的存储；这说明原部署存在可复现的持久化缺陷，不证明某次具体删除事件。C此前把仅保留于/tmp的合成库当作后续可复用交付，没有落实耐久存储/备份，属于本次需要纠正的交接缺口。

### 15.3 已准备、尚待批准的新24表库

可审查 [恢复脚本](evidence/dla-c-handoff/prepare-entry-recovery.mjs) 与 [只读准备结果](evidence/c-entry-recovery/database-plan.json)。`--self-check`核新库目标允许/拒绝边界；默认或`--prepare`仅核root/Node、现有五份0600材料、TLS指纹/配对、两种当前ready/原指纹/代际，确认原库仍缺失且新目标不存在，没有创建目录/库/配置。`--apply`才执行以下动作，尚未运行：

1. 新建原受控根下retained-tmp-20261014（root/0700），仅该初始化/宿主进程设置TMPDIR至此。用原9fa初始化器与原initializer.json建全新24表/5账号/2课程库，检查实际返回路径、表数、空Assignment/Attempt/Job和integrity_check。原密码/TLS/签名复用，不生成秘密；不修改旧库或原配置。
2. 新建i0-host-recovered-20261014.json（root/0600）仅改新库引用，保留其余原Origin/TLS/签名/SSH/静态目录/消费者设置；新建recovery-preparation-20261014.json存去敏实际路径。初始化器和应用继续执行原tmpdir父级/命名/非symlink守卫；不搬库、绑旧路径或关闭检查。明确不是从旧备份恢复，旧对象ID不能被冒充复原，不改执行节点原代际来掩盖新合成应用数据。
3. 获准后正常启动原127.0.0.1:3443 HTTPS，以原严格Node客户端验证登录/课程/Session与真实C1自动消费，原教师/学生API创建新合法Assignment/Activity/Attempt及运行记录，交新ID/版本/当前证据。新进程必须同设TMPDIR与XUNJIE_I0_CONFIG为上述路径；提供同机启动/停止引用。真实浏览器信任、35表/ALU、模型及生产仍不在本次范围。

原因与风险：当前已查原受控目录内未找到可恢复副本，继续使用原配置必然失败；新库会建立schema并产生新合成业务ID，不能保住原学习记录或把历史通过搬为本轮通过。耐久目录可避免系统/tmp开机清理，但Windows/WSL生命周期和手工损坏仍须靠运行约定/后续备份处理，不能宣传完整AC-12/RPO恢复。此处“数据库schema变更/迁移”的红线覆盖fresh建表，须取得负责人针对该24表范围的明确同意，当前为待批准，不执行apply。

### 15.4 当前结果与交接

已完成：原VM/隐藏保活恢复、原AppArmor策略持久加载及enforce、两种严格认证ready与原指纹/代际实核。恢复脚本语法与目标路径正/反例自检通过，只读prepare实际通过，databaseCreated=false。当前HTTPS仍停、旧库仍缺；数据库建表/配置/新对象及新HTTPS业务验证未执行，不写为修复完成。

本批文档与空白检查通过；去敏证据、脚本和任务记录按实际7个既有秘密值扫描后普通推送原PR55，并向#30回交节点已恢复/24表重建待负责人确认，不合并PR或关闭Issue。主副本G3及其他作者改动保留。没有删除原文件、修改密钥/CI/产品基线或编造旧对象；恢复后的新库方案不能代替原AC-12旧备份恢复验收。
