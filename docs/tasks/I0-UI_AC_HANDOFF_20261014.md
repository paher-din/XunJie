# I0-UI：PR69 后给 A/C 的交接与 PAHER 直接核查

日期：2026-10-14（Asia/Shanghai）。主责：UI / Robert。来源：[本批工程记录](I0-UI_PREP_VERIFICATION_CLOSEOUT.md)、[剩余清单](I0_REMAINING_WORK_CHECKLIST.md)。状态：本批 PR 已合 main，现成 SSH/网关只读核查完成；本批新静态包尚未替换到本机网关。

## 1. 负责人要求与固定交付

Robert明确要求“先把这批推PR并合并到main，再整理给A、C的交接说明”，并提供本机`i0-ui55-connection`工具目录，询问哪些PAHER操作可直接完成。已按顺序完成[PR #69](https://github.com/paher-din/XunJie/pull/69)，head `1f7d9f0c2833285a1cfc6bcedf162bf815012e1e`，2026-10-14 **21:58:34**正常合并，merge `87edd51e165b2bab660d73a551864ff8db0bed86`。没有删除分支或强推，继续`i0/ui-frontend`；原`.zcodeignore`未暂存。

本轮只写本人交接/工程记录、已授权清单和公开去敏摘要；读取README、PRD §4.2～4.4、MVP M-03/M-10/§4～6、TECH §4.3/8.1/8.2、TEAM §9、I0客户端§8及原C/工具/UI30交接正文。受保护规范、产品/规划/参考、A/C作者记录、配置/秘密/数据库/节点不修改；只读现场结果不算新学生操作、Run或模型证据。

| 交付物 | 给成员的用途 |
| --- | --- |
| PR #69 / 上述固定main | UI-PREP-01/03/05/06，幂等真实409、连续键盘/焦点、独立冷启动及契约差异表；正常接收Git成果，不重做已完成实现 |
| [工程/验证记录](I0-UI_PREP_VERIFICATION_CLOSEOUT.md) | 实现、实际命令、分轮失败/修复/结果、当前依赖与未执行项；不写一次90/90或完整AC/NFR通过 |
| [正式dist manifest](evidence/i0-ui-prep-closeout/student-real-dist-manifest.json) | 143个网页资源、逐文件bytes/SHA-256，ZIP SHA256 `722e5d425506e0eb4275a7f5fa6de19c86360b73f57352c230c928de027779cb`；包名`student-real-dist.zip`、5,632,388 bytes。用于本机网关接收/校核，不含后台、数据库、配置或凭据 |
| [公开契约核对](I0-UI_PREP_VERIFICATION_CLOSEOUT.md#5-ui-prep-06当前公开契约核对) / [A-C原交接](I0_A_C_HANDOFF.md) | H-05差异的具体依据；控制/作品revision分别重读，不靠UI猜版本 |
| [已有SSH/HTTPS工具](../../tools/i0-ui55/README.md) / [C固定现场交接](DLA_PR67_RUNTIME_HANDOFF_20261014.md) | 复用主机公钥、严格TLS、指定合成账号通道、原24表/35表、当前单位/停止责任；不索取首次H-04/H-06材料 |

ZIP冻结源`4a0bdbb`的学生树为`c957eda726b0b2f00a2b7cd28a060aceac4007d1`，与PR #69合并后的学生树相同；后续任务文档提交不改变已验证生产输入。ZIP留Robert本机，团队可按固定源、Node24/原lock与学生README重建，不能要求其他电脑拥有Robert个人工具路径。旧候选补丁不叠加正式前端。

## 2. 我们已直接完成的 PAHER 核查

2026-10-14 **21:59起**，通过负责人指定的现成工具进行只读核查，没有领取密码、Session或CSRF，没有更换产物/配置、启停服务、写库、改代际/信任或发新运行/模型请求。[去敏摘要](evidence/i0-ui-prep-closeout/paher-direct-readonly-20261014.json)保留各观察及边界。

| 核查 | 本次实际结果 |
| --- | --- |
| 维护SSH `xunjie-paher.ps1 probe` | 公钥/固定host认证成功、`whoami=paher\p3148`；旧`xunjie-i0-entry-recovered-20261014.service`已inactive、VM active，故该旧目标probe总退出1。不是SSH断连，不将两个服务状态等同ready |
| 本机`xunjie-ui55.ps1 status/check` | 已有SSH隧道和gateway进程归属通过，当前提供main `b7e73c5`的UI30正式包；143文件摘要一致，严格TLS/原信任通过；匿名Session401按预期、live/ready各200；**16通过/0失败/0未执行** |
| 两个当前应用unit | 通过同一维护入口显式只读`systemctl show`：`xunjie-i0-entry-pr56-f761dcd-20261014.service`与`xunjie-dla-ui-f761dcd-20261014.service`均active/running。当前固定记录源为f761dcd；不把PR #56/#65/#69合main记作这些服务已更新到87edd51，未重新校核全部运行源码文件 |
| C1只读readiness | ready=true、原146内核、profile=`c17-gcc15.3.0-textscope-v1`；指纹`b07cddf9…`匹配既有验证、差异为空、代际与原宿主声明匹配；退出0。脚本使用旧归档transport，它的source字段不是当前运行应用版本 |
| UI30原获准作品 | 原24表合成库的v8快照，2文件的原UTF-8内容摘要与manifest重算全部一致；sync/snapshot/run原回执可读。退出0、正文和认证材料未输出；没有新保存/冻结/运行 |

维护脚本有WSL stderr告警；保留存在事实，不从告警或乱码推断服务失败。首次GitHub PR56 GraphQL读取超时，随后REST回读合并事实成功，网络失败不作为PR状态判断。

最新C交付已合[PR #56](https://github.com/paher-din/XunJie/pull/56)（21:58:33，merge `b03b1b4`），A5已合[PR #65](https://github.com/paher-din/XunJie/pull/65)（21:58:09，merge `e12c944`）。旧PR #67现场的ready503是旧应用/候选时点，现在不能再派“首次接ready修复”。[PR #68](https://github.com/paher-din/XunJie/pull/68)仍Open/Draft，固定head `e4370f2`；其正式b7e73c5 UI30保存/冻结/Core/停止/历史等证据已有回交，完整范围按该作者记录，不由本次只读重计浏览器通过。

## 3. 给 A 的可执行交接

可将本节链接直接交给A，不需要转交Robert的本机工具或秘密。

1. **接收现有成果。** PR #69已合main；登录/授权/Session/CSRF、宿主ready和已批准错误信封均沿现有接口。本批没有新API或身份需求，不要求再做正式登录/首次就绪修复。
2. **联合C处理H-05。** TECH §4.3规定`attemptRevision`不随逐次编辑增加，现`workspace/files.ts`每个新接纳sync仍同时增加`attemptRevision/workspaceRevision`。请协调C给出原反例、生命周期/控制CAS与作品CAS影响，以及“实现按基线修正”或“提请批准修改基线”的具体建议。负责人确认后，由获授权维护者同步需要变化的基线/验收；不直接把差异改写成已解决。
3. **明确回交。** 返回建议/决定依据、影响的接口/调用方/测试范围；若接纳实现修复，给固定提交及受影响原行为的验证。当前UI继续ACK后GET head读取两个revision，H-05不阻塞无关读取/当前可用C窗口。

## 4. 给 C 的可执行交接

1. **正常接收包含PR #69的main。** 保留当前独立工作树/无关改动、24表C与35表HDL库、旧对象/运行源/停止回退。此次前端改动无需C重建runner、首次交H-04/H-06、重做SSH/TLS/账号通道或代操作Robert本机gateway。
2. **提供H-05技术依据。** 与A核`syncFiles`的生命周期激活/每次sync递增行为、控制CAS/运行/帮助调用方，以及反例和修复/兼容影响；共享语义须经原决定路径，不单方扩大UI字段或改基线。
3. **只处理剩余的模块/环境问题。** 当前f761dcd服务已ready、入口材料已交；后续要接收新宿主源码时，区分main源与运行源，按已授权对象/窗口执行，给固定源、原消费者、HTTP与节点分别的结果和回退责任。PR56新增消费者健康修复已合main、有作者70/70证据；不要把正常merge自动记成PAHER已部署。本轮不要求无变化的整套节点重验。
4. **下一批HDL协作材料沿现有包。** [H4最新顺序](DLA_H4_UI_HANDOFF_20261014.md#5-最新负责人顺序与-ui-立即接线批次)已交，真实HDL UI现在可分批接，不等后置H3。当前Robert工具只转发3443；3444/35表与指定学生B的同源/身份差异应沿既有准确方案核对。H3教师binding/course_check、新镜像/节点和完整故障/隔离属于C原后置任务，不借本轮交接另加范围或再次耗用旧模型许可。

## 5. UI直接承担的部分与给成员的方式

UI可直接用既有工具做SSH身份/当前unit、公开HTTP ready、节点只读ready和已获准合成对象核查，本轮已完成，不转给C重复执行。本机正式dist接收、逐文件校验、本人gateway切换/启停和实际Chrome复验由UI在既有准确授权内推进；SSH工具可连接不改变A/C代码归属，也不自动授权配置/库/节点冻结环境或秘密变更。

本批新ZIP尚未切到gateway，当前仍是b7e73c5 UI30包。下一步UI接新包后核登录/账号隔离、保存/冻结、原Job/Run、历史与可用产物等实际差异；已有UI30结果按原版本复用，正向下载和真实丢ACK/恢复等缺口分列。需要新模型或真实学生阶段时另沿原门禁，不把合成开发行为算学生接棒。

**交付渠道：** 本文与公开摘要放共享Git，A/C拉取包含交接文档的main后分别按§3/§4执行；文档PR正文提供固定记录链接及实际合并回执。负责人可把各节链接交给对应成员的对话/DeepSeek Harness。当前没有自动给其他聊天或成员发送消息、没有另发重复Issue评论；文档不依赖本机附件。产品基线/MVP_SPEC §10仍待授权维护者汇总。

## 6. 当前共享宿主兼容验证与文档交付

PR #56/#65的main增量没有修改学生生产输入。除复用作者已有宿主70/70与源码审查外，本轮在`87edd51`执行正常HTTPS/SQLite的运行/取消/历史/Session/辅导五份service spec：**22/22通过**，195.6秒，两个Chrome worker，retries=0，skip/flaky/failure全0。[公开摘要](evidence/i0-ui-prep-closeout/shared-host-compatibility-20261014.json)保留命令、版本及原JSON指纹；runner/provider仍为隔离合成，不能替PAHER或模型验收，也不与之前17项重复累计。

文档维护前main静态检查为102份/1641内链、errors=[]；本轮维护后103份/1658内链、errors=[]，差异空白通过。清单30个唯一编号仍为PREP9/REAL12/TUTOR9，学生源树与冻结产物不变；独立只读复核仅发现“公网关”容易误解，已改“本机网关”，其余计数/范围/成员责任无问题。

本轮仅本交接/本任务/清单与两份去敏摘要共5文件，正常推送原`i0/ui-frontend`并通过仅文档PR交付；确切head/main/合并结果以该PR的公开Git回执为准，合并回执亦写PR正文，不把文档commit称为新部署。原PR67证据CRLF告警及其他作者历史保留。产品基线/MVP_SPEC §10待授权维护者汇总。

## 7. 新包真实复验后追加交接（2026-10-14）

本节更新§2/§5之前时点的“PR68仍Draft/尚未切新包”：PR68已于22:14:50合main `8ef9dc0`，本交接PR70于22:15:55合main `8b41303`。随后Robert明确授权直接接收/本机切换/真实浏览器/必要UI修复，本轮实际结果以[新记录](I0-UI_PR69_REAL_BROWSER_RECHECK.md)和[清单§12](I0_REMAINING_WORK_CHECKLIST.md#12-2026-10-14-新包真实浏览器复验与现场修复)为准。

UI已自行完成原4a包接收与本机严格TLS/SSH复验，并修真实暴露的首次选择回收文件、明确拒绝后重复辅导读取；新本地提交`b50918a`的143文件正常包已切入gateway，16/16。原合成A/原Attempt新v9保存冻结、真实C1成功、独立v4停止确认、刷新/退出重登录/固定历史通过；已有v3完整report.txt实际下载21 bytes/hash匹配。PAHER应用仍`f761dcd`、24表C-only，远端配置/库/节点未变；当前新UI修复尚未新建PR或合main，不把它写成共享main已经交付。

**给A/C的实际剩余项：** §3/§4的H-05差异与决定/实现依据继续有效。C1/SSH/TLS/本机包接收和完整产物正向下载已有本轮证据，不再要求C重复首次接线或提供替代文件。

现场还确认当前24表C-only未组合C3的events/history路由，正常请求返回400/INVALID_REQUEST；UI现正确停止定时poll并保留手动重读，作品不受阻。这是当前运行组合事实，不是共享接口字段改变或C1ready故障。若下一批进入真实辅导，由A/C/B按原宿主与数据/预算许可提供相应组合环境及固定源/当次窗口、授权对象/代际/profile，仍沿已交原消费者/通道；不要在当前24表库就地加表或把旧许可自动当新模型调用授权。UI本轮没有启用服务、新help或模型，也不要求为了当前C1复验先做该后续任务。

交付方式仍为共享Git文档与负责人给对应成员的节链接；本轮未自动私信/发送其他聊天或新增Issue评论。产品基线/MVP_SPEC §10待授权维护者汇总。
