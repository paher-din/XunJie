# I0-UI：PR69 新产物接收与真实浏览器复验

日期：2026-10-14（Asia/Shanghai）；主责：UI / Robert；实施：当前Agent。状态：`in-progress`。分支`i0/ui-frontend`，初始HEAD `8b4130374289b71d737abe12ed4fc5e58adf55c5`，原未跟踪`.zcodeignore`保留。

## 1. 依据与授权

Robert明确要求“继续接收这批新产物包，切换本机网关，用现有SSH工具完成真实浏览器复验，继续在i0/ui-frontend分支推进，发现问题就修复并更新清单”。承接[PR69补验](I0-UI_PREP_VERIFICATION_CLOSEOUT.md)、[A/C交接](I0-UI_AC_HANDOFF_20261014.md)、[UI30实际结果](I0-UI30_COMMENT_CLOSEOUT.md)及[完整清单](I0_REMAINING_WORK_CHECKLIST.md)。PR #69/#70已合main，当前Git学生树与冻结包源一致，不因文档head变化重建或改贴产物。

本轮已读README、PRD §4.2～4.4、MVP M-03/M-10/§4～6、TECH §4.3/8.1/8.2、TEAM §9、I0_UI_SPEC用户场景、客户端§3～6及IMPORT_SOURCE许可/后续同步；复用前轮已读的具体契约正文。适用M-03/10、AC-03/04/06/12与NFR-05的本批工程范围，不计整项通过。

已批准对象：本机`i0-ui55-connection`现成工具；新ZIP及新增独立静态目录/适配清单；`local-relay/gateway.config.json`仅`staticDirectory`和`active-dist.json`仅清单引用；本人gateway/SSH进程正常stop/start；原已获准`synthetic-i0-student-a`、Assignment `a2533386-4923-4dee-83bd-2d7a99fb06e9`、Attempt `c9166463-5f46-4dc6-82c3-96456f394258`的开发合成浏览器操作。凭据仅沿已有加密通道在进程内存消费，trace/HAR不启用，不写口令/Cookie/CSRF/私钥。

不修改：PAHER宿主源/服务/受控配置、原24/35表schema/库恢复、账号/信任/host pin/签名/节点冻结/代际/模型预算、保护文档/规范或他人任务。本轮真实指正常Chrome、严格TLS、原HTTP/SQLite/消费者/C1；仍是开发合成验证，不代真人学习。

## 2. 写集、方案与验收

仓库可写本记录/本任务公开合成摘要和已授权清单、README必要导航；只有现场反例证明必要时窄修`apps/student`现有调用方并补受影响检查。不改共享API/字段/框架/依赖；源修复后重新固定正常包并验证，不把旧包记成新修复已交付。

当前143文件包`student-real-dist.zip` SHA256=`722e5d425506e0eb4275a7f5fa6de19c86360b73f57352c230c928de027779cb`，源`4a0bdbb`，入口`/assets/index-k3K5KOqC.js`。[原manifest](evidence/i0-ui-prep-closeout/student-real-dist-manifest.json)保留；本机清单只映射原archive字段到工具需要的顶层artifact/sha256/bytes/staticFiles/normalBuild，不重新打ZIP或改sourceCommit。

先验ZIP每entry及路径、复制到新目录逐bytes/hash校核；在原受保护relay内备份两份选择文件，只stop本人且归属匹配的进程，核端口释放，再写选择/start/check。接收或启动失败时停本人新进程，恢复两份选择原字节并核旧包；归属未知时停止该部分，不强杀他人。

| 项目 | 本轮实际操作与判据 |
| --- | --- |
| 静态来源/通道 | 新目录/ZIP/清单143逐项匹配；正常TLS、SSH归属/ready200；浏览器实际入口JS与新包相符 |
| 登录/原对象 | 正常表单登录原账号，读回原Attempt/v8/材料/历史；初始化不自动保存/冻结/Run |
| 新焦点修复 | 实际键盘文件菜单Esc、只读比较/运行返回；焦点回原入口/编辑器，正文/光标/undo保留，读取零写 |
| 保存/冻结 | 只加唯一合成注释后明确保存/冻结；原fileId、原UTF-8/hash及manifest相符，旧v8不变 |
| 新快照/Core | 明确一次Core，原回执/Job/Run/快照/代际/profile关联；真实stdout/诊断不补造，无自动重复 |
| 停止 | 明确独立已知v4运行，再停止原Job；区分cancelling/cancelled，确认才计通过，已终态的点击竞态如实保留 |
| 刷新/历史/产物 | 原新旧ID/快照/hash保持；参数仅原本机回执；只能对已获准available+complete产物核bytes/hash并下载，缺项不补 |
| 辅导只读 | 读取已有历史，不发新help/模型；自然失败才计错误提示现场，否则保留该分支未执行 |

两个子Agent独立只读核清单适配/回退与浏览器判据；主Agent唯一持有gateway/SSH/browser。第二账号、撤权/终态、真实丢ACK/旧代际/库恢复、HDL、模型语义/真人及完整AC/NFR不由本轮局部结果替代。

## 3. 实际过程、失败与结果

### 3.1 原冻结包接收与严格TLS入口

原ZIP逐143 entry的路径、bytes/SHA-256与公开manifest核对后，原字节复制为本机`ui-pr69-4a0bdbb-dist.zip`，展开到独立`dist/pr69-4a0bdbb`。工具清单只增加扁平字段适配，保留原sourceCommit/studentTree/archive/files；源学生树与初始HEAD一致，没有重建或重新压缩原ZIP。

在原受保护relay内保留`gateway.before-pr69-20261014.json`与`active-dist.before-pr69-20261014.json`原字节，原入口正常stop后确认端口释放，仅切staticDirectory/manifestFile，再正常start。`xunjie-ui55.ps1 check`实际16/16、0失败/未执行：新143文件、ZIP/hash/源、固定SSH、本机严格TLS、live/ready200与匿名session401均符合；原工具快照、证书路径/信任和ACL不变。

Chrome155正常有头浏览器、严格TLS表单登录获准A。新本机浏览器无Attempt记录时，明确点击“开始Attempt”经原公共POST返回已存在的原Attempt（没有生成替代作品），随后GET读回原v8/两活动文件与回收scratch；初始化没有sync/snapshot/Run/help POST。旧v8正文与manifest未改。凭据封装只经过已有合成账号工具与临时RSA-OAEP进程内消费，不记录认证正文。

### 3.2 真实反例与窄修范围

1. **首次默认选择回收文件。** 原服务器文件顺序为回收`scratch.txt`、活动`input.txt/main.c`；无本机UI记录时默认首项，实际没有Monaco编辑器。手动文件菜单打开main.c后正常。新增公开流程的Chrome反例先RED（预期main.c、实际scratch.txt），修复仅在`storedUi===null`时选择首个active；已有open/active选择不覆盖，全回收保留首项提示。新增1/1及原fileHistory7/7分别GREEN、retries=0；原正文/生命周期与只读零业务POST通过。
2. **明确拒绝后仍自动读辅导。** 现场`GET /api/attempts/<原ID>/events`返回400、`INVALID_REQUEST/retryable=false`，旧页面仍每2.5秒读取。源核对确认当前正常24表C-only宿主未组合C3路由，原查询/网关转发正确，不是C1或SSH故障。新增真实默认24表HTTPS/SQLite专项先RED：6秒预期1次实际3次。只在当前有效读遇到明确nonretryable API拒绝后暂停定时读取，保留显式重读/原online重连；成功后恢复轮询，保留原诊断、命令、授权/代际守卫及编辑保存。不向远端启用辅导、改schema或发新help/模型。

源写集精确为`useProjectWorkspace.ts`、`tutoringWorkspace.ts`、`tutoringNotice.ts`；回归写集为`fileHistory.spec.ts`和新`tutoringCapabilityService.spec.ts`。两条独立反例分别交子Agent验证，gateway/SSH/browser由主Agent持有。

原包实际键盘文件菜单Enter/Esc回入口与只读比较Esc回原编辑器通过，零额外POST。首轮工具选择器把隐藏首页当工作区返回、把“文件2”当“文件”以及默认30秒导致REPL重启的失败均保留为自动化启动/定位失败；改用实际可见“返回”/文件菜单入口与8秒locator默认、45秒工具上限继续，不计产品通过。没有强制点击或伪造业务响应。

### 3.3 当前本地验证与剩余执行

两修复合并工作树后，`rtk npm run typecheck`、`rtk npm test -- --reporter=dot`（34文件464/464）、`rtk npm run build`均退出0。正常新dist入口`/assets/index-DmeUPG54.js`；既有大chunk构建提示保留，未调整阈值/栈/依赖。新实际服务专项2/2 GREEN（49.6秒、Chrome/Node24.21.0、1worker、retries=0、0skip/flaky/failure）：24表首次400后6秒只有1请求，明确重读后3秒只有2请求、无help、原问题保留且保存v1/GET正文成功；28表一次传输abort后至少两个真实200并继续poll。受影响辅导兼容正在验证；后续固定源码、单独冻结新修复包/manifest，再用原归属入口切换，完成真实保存/冻结/Core/原Job停止和刷新关联。旧包和接收结果保留，不把旧源的初步操作算修复包最终通过。

产品基线/MVP_SPEC §10待授权维护者汇总。
