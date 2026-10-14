# DL-A：统一 PR56 后的 C 续作

日期：2026-10-14（Asia/Shanghai）；执行角色：C。

## 1. 依据与负责人指令

负责人本会话明确指令：以 PR #56 `25608e6` 为统一集成基础，不再分别处理 #53/#54/#55/#59；优先与最新 main 集成验证、在获准环境完成真实 HDL 构建/装载/操作/结果读取；立即接通 H4 真实上下文交 B/UI；H3 继续推进但不得阻塞成熟演示。

已读 README/AGENTS、PRD §1/3–8（PRD-03/04/05/09/10）、MVP_SPEC §1.4/M-03–05/5–6（DL-AC-01–09、AC-02/04/05/06/07/10/11/12/15/16）、TECH_DESIGN §4.1/5–7/8.5、TEAM 的 P3–P5 与职责、DL-0、DL-A §15–20、C 原交接 H3/H4 和 PAHER 当前现场记录。原始作者记录只引用，保留历史结论；产品/MVP_SPEC §10 待授权维护者汇总。

## 2. 写集与实施方案

独立工作树起点为 `25608e6`；远端 `246451e` 仅补原集成交付记录，先快进保留，再正常 merge `origin/main@35307e0`。根工作区无关改动不动。

可写：本记录、本次去敏证据；集成冲突涉及 README、contracts/tutoring/index.ts、server/app.ts、app/config.ts、app/i0.ts、app/i0-initialize.ts、main.ts、tutoring/test/real-model-support.ts 与对应测试。保留 DL-A 的双课程/HDL正常宿主、唯一原 Job 消费者/关停/readiness，以及 main 的 I0-B/C3/学习分析能力。

H4 沿 DL-A §18.3 已列最小接线方案，使用显式 hdlSelection、同事务真实授权与固定对象读取、readOperation/current、C3 原问题/候选/投递/回执守卫；预计追加写集为 contracts/tutoring、workspace/hdl 与 inputs、records 原问题冻结和 current 接缝、tutoring/context 与 application、app/digital-logic/original-job-host 及其相关测试。编码前核准确调用链，不改 B 模型核心/教学判断，不另建 UI。

只读：AGENTS、docs/product/planning/reference、其他任务正文、A5规则、UI视觉/页面、依赖/lock、runner现有协议/镜像、凭据/CI、schema/迁移。自动 merge 接纳 main 已批准变更不作额外编辑。真实环境沿原批准 PAHER/合成账号；只在准确批准环境内运行，不创建未经批准的数据库/schema或修改秘密配置。H3 优先推进原精确提案/无副作用校核；需要共享协议/运行配置/DDL决定时单独记录，不阻塞 H4。

## 3. 验收与交接

验证 Node24.21.0 类型/构建、双课程/I0-B/readiness/原Job/C4/HDL/tutoring专项及必要全量，保留失败和真实门禁跳过。真实证据绑定快照/hash/Build/Session/Operation/配置/引擎/代际；错误构建与成功构建、持续输入/结果读取分别记录。H4 验证跨scope/hash、pending/停止/迟到/新sequence、重复冲突及模型故障；送 UI 真实请求/响应与去敏错误、unknown、停止/恢复样例。

服务端工程、真实执行节点、实际模型、浏览器、真人/教学效果分别记账。现有 UI 暂无 HDL 页面时交材料，不伪称浏览器通过。PR/main远端更新及公开协作按具体授权，未获授权不发布。回滚使用保留旧副本/新revert，不删文件、不重置历史。

## 4. 准备时点状态

准备时main merge出现上述九个文件冲突，当时尚无本轮新增通过结果；后续实际状态见下方实现/验证章节。

## 5. 单轮模型调用与凭据授权

负责人本会话明确批准“批准这一轮有界调用”：只用本轮合成数据、DeepSeek/deepseek-flash、一轮 student_help、最多3次供应商请求（含修复），费用按本轮授权。随后负责人提供密钥并明确要求由本 Agent 处理。具体保存对象为 PAHER 本轮独占工作目录的 `deepseek.key`，仓库外 root/0600；不写 .env、源码、Git或证据，不修改原TLS/签名/账号凭据。仅本轮脚本读此文件；任何其他调用或扩大预算仍需独立授权。

在首个外部请求前建立独占使用回执，防止重跑消费同一授权；SDK retries=0，模型与应用同享45秒截止，实际HTTP计数不超过3。模型输出、usage、HTTP事实与C3接纳分别保留；生成不代表投递或学生独立修复。本轮不改变原B语义审阅结论。

## 6. 第一批实际实现和验证

九个合并冲突已解；保留main的学习分析/教学路由和I0-B辅导消费者，复用PR56唯一运行宿主。辅导消费者移为共享 `original-teaching-host.ts`，使用独立调度循环，避免C编译派发阻塞新求助；退出同事务停止原教学Job并abort在途调用。readiness/原bootstrap/静态服务及原C4/HDL控制保留。

H4 新增 `contracts/workspace/hdl-help.ts`、`workspace/hdl-help.ts`；HDL精确Operation读取复核请求/回执/所属/嵌入hash和原字节hash，Trace复用该检查。正常help接受显式hdlSelection，同事务冻结Build可见投影hash、workspaceRevision与选中Session/Operation；C3原问题JSON和acceptedInputHash绑定该冻结basis。B调用前后、候选保存、Delivery和Receipt均读真实当前性，不选“最新”替代原对象；旧缺冻结basis的HDL历史只作历史。宿主配置可选tutoring复用I0已有受控字段，实际配置/密钥和默认关闭状态没有被静默改开。

实际命令与结果：

| 范围 | 实际结果 |
| --- | --- |
| Node24.21.0/Linux teaching typecheck/build | 通过；原lock依赖复用，不安装新依赖 |
| 继承main的student构建 | npm run build通过；现有大chunk警告保留，不做无关UI/性能重构 |
| 联合完整测试（含server/app） | 510项，495通过、0失败、15受控节点/模型门禁跳过；[原日志](evidence/dla-continuation-20261014/full-first.tap) |
| 最后追加workspace冻结及Receipt守卫定向回归 | 37项，35通过、0失败、2真实模型门禁跳过；[原日志](evidence/dla-continuation-20261014/freeze-regression.tap)。不是把两轮累计成547项 |
| PAHER原节点只读就绪 | C/HDL均ready，当前代际/镜像/34文件sourceHash与原批准指纹一致；[原证据](evidence/dla-continuation-20261014/runtime-probe-first.json) |
| 真实HDL/模型一次闭环 | [工程记录](evidence/dla-continuation-20261014/real-hdl-model.json)：新35表合成库、严格TLS、真实失败/成功Build、真实持续Session/两操作/Trace、确认停止。DeepSeek 1次HTTP200，input2615/output388、Job succeeded、C3投递和received回执；未报告displayed/acknowledged/真人。该记录先于最后workspace冻结增强，后者由上述定向回归独立验证，原记录不改写 |
| H3无副作用预检 | [原脚本](evidence/dla-continuation-20261014/h3-preflight.mjs)断言通过；定义域/tupleSetHash与原提案一致。8400私有样本不适用4096公开帧上限，需要私有紧凑协议；88×2秒上界176秒超过120秒整Job，吞吐未验证 |
| 最终冻结守卫版本的现场补验 | [原记录](evidence/dla-continuation-20261014/real-hdl-final-frozen.json)：复用同35表，新增独立合成Attempt，真实错误/获准冻结上下文/修正构建/持续装载/两操作/确认停止通过，额外模型请求0。未重复消费已经结束的单轮模型授权 |

失败保留：第一次联合专项发现辅导串行扫描阻塞C派发，已改独立原Job循环并通过原反例；部分早期合成登录出现RATE_LIMITED/UNAUTHENTICATED，独立复验及最终510无失败，未放宽认证/时钟守卫。真实现场第一轮3443端口占用，原服务保留并改同机3444；第二轮验证器把单账号授权课程数误写为全库课程数，修正为真实成员列表，同时核全库2课程；第三轮操作轮询发生401并保留，后续完整真实轮次通过。早期H4测试中的权限调用/字段层级/故障枚举期望错误已修正，未绕过产品检查。各失败文件与时点在同证据目录保留，不累计旧通过统计，不推定瞬态401的根因已定位。

UI交接为 [真实接线包](DLA_H4_UI_HANDOFF_20261014.md)。本轮未修改UI页面/布局；当前原数字逻辑中心仍有静态/模拟路径，UI按包接真实请求/诊断/板信号/有限Trace/B消息和展示回执，浏览器完整链未执行。原3443/24表/凭据/CI/保护基线保留；本轮35表在原获准retained TMPDIR创建并留存，不迁移旧库。

## 7. H3后续源码批准

负责人对本轮精确问题回复“批准这一批 H3 源码实现”：沿原 [C §14.5](DLA_C_CLOSEOUT_HANDOFF.md#145-dla-h3层级采样占用和2800向量的精确执行提案) 的真实ALU结构化绑定、私有2800向量、三次稳定采样、原120秒及资源限额；保留每Attempt一个未终止Session，学生先显式停止板卡再发起独立检查，不改DDL/旧库，不自动替换或重装板卡。批准runner共享命令/VPI及对应原Job/绑定/读取的源码实现；新镜像、节点换版、维护和新指纹登记**尚未批准**，产物备齐后另交具体方案确认。现有Demo继续使用旧批准节点，不等待H3。

H3按C原明确写集及A课程/绑定确认接缝维护，补 `contracts/design/hdl.ts` 的可选行为检查与绑定契约、design/hdl-configurations 的确认/固定配置、workspace与app原Job调用方及必要测试；节点侧独立check保持停止/代际/配额/私有资产边界。受保护产品/计划/参考与UI保持只读，产品/MVP§10待授权维护者汇总。实际H3源码、离线测试、未执行真实2800及下一轮节点提案将在后续章节记录，不把此次批准或数学预检记成ALU行为通过。

### 7.1 最新范围裁决：仅 runner 内核

实现前发现“把学生Build绑定提前冻结进活动”与“活动发布后才有学生Build”顺序冲突，提出每Build独立教师确认版本的建议。负责人明确选择 **“H3 先只实现 runner 内核”**。该最新选择缩小第7节的本批源码写集：不改design/活动发布、教师确认、workspace业务Job接纳或UI；这些调用方保留待明确接口设计，不从此前广义批准自行实现。节点运行配置/镜像/部署仍未批准。

### 7.2 runner 内核实际源码

- `contracts/runner/alu.ts` 和原 `hdl.ts`：受限 hdl_alu_probe/check/result；固定原scope/Build/artifact/snapshot/board配置/绑定/规则/向量/采样/runtime/images/source/generation。probe仅返回确认元数据，原query/stop复用同身份。
- `runner/alu-check.ts`：结构化同实例端口绑定/宽度/方向/升降序/S拆分及自选SW无重叠校验；固定2800定义域与私有比较器；逐向量真实输入匹配、三次20/30/40ns低相位、评分X/Z/不稳定/缺样本区分，完整覆盖且确认终止才passed。非加法Cout/未定义域保持不判分；120秒整检查、2秒批次、64KiB/1MiB限额保留。
- `hdl-ports.c`/`hdl-executor.ts`：已有ports模式兼容；新构建可生成绑定artifactHash的真实有限层级端口元数据。旧Build没有metadata时probe明确拒绝，不能拿人工名字补造解析结果。
- `hdl-bridge.c`/`alu-simulation.ts`：受信通道的窄绑定/批次协议，SW真实施加、VPI只读低相位采集A/B/Cin/M/S/F/Cout；原板卡Frame/时钟路径兼容。私有协议与stdout分开，原始样本/失败向量只留节点受控资产。
- `hdl-alu-worker.ts`/`hdl-node.ts`/`hdl-ledger.ts`/`ssh-control.ts`/`fingerprint.ts`：独立check使用原Session配额/同Attempt占用/原flock公平调度、原限制与确认停止，不替换板卡。查询只返回去敏summary/hash，拒绝用hdl_result读check私有帧。停止/worker退出未知不pass；新contract与内核文件纳入fingerprint，旧节点不能因为新应用源就被称作已更新。

使用官方 Icarus v12 接口正文核对解析与回调：[ivl_target.h](https://raw.githubusercontent.com/steveicarus/iverilog/v12_0/ivl_target.h)、[vpi_user.h](https://raw.githubusercontent.com/steveicarus/iverilog/v12_0/vpi_user.h)。本机CLI使用与已批准镜像一致的[Ubuntu iverilog 12.0-2build2包](https://archive.ubuntu.com/ubuntu/pool/universe/i/iverilog/iverilog_12.0-2build2_amd64.deb)解包到独立H3目录，不安装系统依赖、不建新镜像、不改节点。

### 7.3 已执行与后置

H3 Node24.21.0 typecheck通过；gcc -Wall -Wextra -Werror 两个C模块通过。第一次C编译发现两处misleading-indentation并修正，不关闭warning。内核/原时钟第一轮12项全通过；新增节点probe/配额/隐私/错scope/旧代际后H3专项8/8通过。隔离Icarus CLI实际2800向量/8400样本完全比较通过，故意错误取反被检出；细于1ps的原时钟反例保持通过。初次联合runner/HDL/H4回归71项68通过/0失败/3受控真实门禁跳过；最后小改动的针对性结果另列，不累计。

未执行：获准VM中的新镜像/H3 worker真实2800吞吐与停止/崩溃/双实例限额；活动绑定确认和业务course_check接线；浏览器和真人。CLI结果不满足DL-AC全项，不声称目标节点H3验收通过；公开运行仍用原sourceHash与镜像，H4/已成熟Demo不被H3等待阻塞。

## 8. 统一 PR56 发布与现场交接

main集成与H4提交为 `5b78684`（保留PR56与main35307e0父提交）、`4a24849`（保留同期main f95488a父提交）。第二次merge仅接纳已在PR56的B历史及最新main交付记录，冲突保留本轮冻结增强；重复插入的DL-B模型门禁测试恢复为单份。受保护产品/计划/参考与main逐blob一致，不作额外修改。

普通Git推送两次因GitHub连接reset/timeout失败；改用现有gh认证Git API上传**相同Git树与原merge父提交**，force=false。API生成SHA与本地两提交完全一致；远端原PR56分支回读 `4a24849afa601d53559bca2f3ac4ab5ba830cec9`，最新已接纳main为其祖先。未合并远端PR/main、未关闭Issue、未删除分支或Git历史。发布脚本留在本人证据目录；API非秘密准备文件保留仓库外。

早期原tap日志含测试输出尾空格；第一提交的检查有此新增失败但提交已发生，后续保留原始gzip字节与sha，并仅去掉可读tap的行尾空格，复验通过。不重写/删除第一提交，失败如实记录。

PAHER保留联调宿主 `xunjie-dla-ui-handoff-20261014.service`：同机3444、同35表、原TLS/签名/合成账号、继承main UI构建；模型预算关闭且不读取本轮密钥，不新增自动开机或跨机路由。停止命令：`wsl -d Ubuntu -u root -- systemctl stop xunjie-dla-ui-handoff-20261014.service`；原3443服务与24表不动。H3代码另在 `dla-h3-source-20261014` 副本验证，不覆盖这个正在运行的旧runner契约宿主。实际存活就绪结果见后续smoke证据，长期在线不作保证。

### 8.1 main 同期 UI 批次接纳

最新main又前进至 `5c8c60ec93e00bc1782a534a88b696ae98c76c37`（PR64/66的正式会话、保存恢复和C运行UI）。本轮正常merge接纳；已读其本人任务依据/写集与真实验收边界，只处理 app.ts/i0.ts/i0-readiness.test.ts 三处冲突，UI源码原样接纳、不新增页面设计。main的void checkReady与PR56 boolean checkReadiness使用同一个健康路由兼容，双hook同时装配明确拒绝，防止另一hook绕过依赖故障；I0消费者健康同时覆盖原运行扫描和辅导扫描。保留PR56的HDLprobe、共用bootstrap/静态/关停、B原Job与唯一独立辅导调度，不把main旧monolithic宿主覆盖回来。latest main新增的预算关闭也能ready回归原样保留。

新UI npm run build通过（既有大chunk警告）、34文件464单元测试全部通过；teaching最新类型/构建通过，受影响宿主/权限/C4/HDL/H4专项首轮65/65通过。随后补void/boolean互斥适配反例的最终专项结果另列，不累计。全部510与最新main专项属于不同指纹/层级，分别留证；本轮没有重跑作者浏览器、真实模型、负载/性能或真人。

现场最新 [smoke原结果](evidence/dla-continuation-20261014/ui-host-smoke-first.json)：六次严格TLSGET，3444 live/ready/静态均200，3443 live/静态200、ready503，联合“全部200”判据失败。保留此失败，不更改原3443服务或声称全现场通过；本轮3444独立就绪可交UI。原第三轮401的根因仍未确定；最终真实/离线验证通过不反写其失败。

最新main融合最终66/66专项通过、0失败/跳过，包含唯一健康路由兼容反例和main新增I0预算关闭/扫描健康用例；[原日志](evidence/dla-main-latest-20261014/main-latest-final.tap)。UI的[最新构建](evidence/dla-main-latest-20261014/student-latest-build.txt)与[464项单元测试](evidence/dla-main-latest-20261014/student-latest-tests.txt)分别保留。H3最后17/17专项及72/69/3联合回归见[核验清单](evidence/dla-h3-kernel-20261014/verification.json)，不是跨批累计统计。

原3444临时host已正常停止；切至保留新副本的 `xunjie-dla-ui-integrated-20261014.service`，相同原35表/3444/TLS/签名/账号、最新main继承UI dist与应用服务。模型预算继续关闭，不读本轮key，runner节点仍原获准sourceHash/镜像，**应用源码换版不是H3节点部署**。严格TLS三次GET的 [最终smoke](evidence/dla-continuation-20261014/ui-host-integrated-smoke.json)均200；未改系统信任/旧3443/24表，也没有浏览器验收。

当前停止命令：`wsl -d Ubuntu -u root -- systemctl stop xunjie-dla-ui-integrated-20261014.service`。回滚可停止当前unit，再沿§8原serve-hdl argv在旧副本启动；目录/库/原对象保留，恢复不重放已结束模型批次。WSL本轮保活是有界进程，不承诺自动开机或长期在线。

### 8.2 最终公开回执与剩余工作

H3内核提交 `b556d75`，接纳latest main及66项专项的merge为 `2e0245c2c9a1ef85828b935924b55baac7243e3a`，包含 `5c8c60e` main父历史。Git API exact tree/非强制更新回读均一致，见 [发布回执](evidence/dla-continuation-20261014/publication-final.json)。原PR56 head已更新且仍Open/Draft；标题/正文重写为本轮最终范围，不再沿早期H3/H4未接线摘要描述已完成代码。未合并到远端main或关闭#38。

[UI #30实际回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6168625583)已发布且正文逐字回读一致，包含统一PR56、真实模型/HDL证据、3444入口/停止/安全账号与信任边界，以及UI同浏览器接线验收清单；未代UI勾通过。主副本原未提交/未跟踪文件完整保持本轮开工状态，不暂存/覆盖/提交。

最终静态97份/1483内部引用/errors=[]（随回执链接增长，以最后工具实际输出为准），差异空白通过；stage曾因原student unit日志尾空行失败，保留原gzip后仅规范可读文本并通过，不更改测试事实。密钥实际值对本轮源码/证据扫描0命中，保存仅在PAHER仓库外0600文件；单轮实际1次请求授权已消费，现有联调host不读该文件。

本轮明确完成：固定main集成/回归、真实HDL Build/Session/Operation/读取/确认停止、H4正常获准冻结/B实际模型/C3传输交接、UI真实包和保留同机入口、H3已批准runner内核及隔离CLI2800采样。尚未完成：UI真实HDL同浏览器展示/学生修复链；H3新镜像/节点部署与真实worker2800/故障/隔离验收、活动binding/course_check接线；原3443就绪缺口归其现场维护者；完整P4/P5/真人/教学效果沿原后置安排。产品基线/MVP§10待授权维护者汇总。
