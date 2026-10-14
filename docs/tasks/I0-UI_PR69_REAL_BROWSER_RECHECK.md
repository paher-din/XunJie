# I0-UI：PR69 新产物接收与真实浏览器复验

日期：2026-10-14（Asia/Shanghai）；主责：UI / Robert；实施：当前Agent。状态：`completed-in-approved-synthetic-scope`。分支`i0/ui-frontend`，初始HEAD `8b4130374289b71d737abe12ed4fc5e58adf55c5`，原未跟踪`.zcodeignore`保留。

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

两条独立源反例及回归分别委派子Agent按上述精确写集执行；主Agent唯一持有gateway/SSH/browser。第二账号、撤权/终态、真实丢ACK/旧代际/库恢复、HDL、模型语义/真人及完整AC/NFR不由本轮局部结果替代。

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

两修复合并工作树后，`rtk npm run typecheck`、`rtk npm test -- --reporter=dot`（34文件464/464）、`rtk npm run build`均退出0。正常新dist入口`/assets/index-DmeUPG54.js`；既有大chunk构建提示保留，未调整阈值/栈/依赖。新实际服务专项2/2 GREEN（49.6秒、Chrome/Node24.21.0、1worker、retries=0、0skip/flaky/failure）：24表首次400后6秒只有1请求，明确重读后3秒只有2请求、无help、原问题保留且保存v1/GET正文成功；28表一次传输abort后至少两个真实200并继续poll。受影响四份辅导兼容33/33通过（2.1分钟、2workers、retries=0、0failure/skip/flaky），未因通过重复整批169项。旧包和接收结果保留，不把旧源的初步操作算修复包最终通过。

可复现浏览器命令在`apps/student`：设置`XUNJIE_E2E_BROWSER_CHANNEL=chrome`，独立prep/real/restart端口与`CI=1`；新服务专项另设`XUNJIE_E2E_SERVICE_NODE=/mnt/d/codex-tools/node-v24.21.0-linux-x64/bin/node`，正常build完成后`npx playwright test e2e/tutoringCapabilityService.spec.ts --workers=1`；兼容`npx playwright test e2e/tutoringFailure.spec.ts e2e/tutoringHelpStop.spec.ts e2e/tutoringHistory.spec.ts e2e/tutoringMessages.spec.ts`。文件专项`npx playwright test e2e/fileHistory.spec.ts`。本机实际分别使用5821/5822/5823和5831/5832/5833，结束均无监听，隔离宿主/TLS资源正常退出清理。[验证摘要](evidence/i0-ui-pr69-real-recheck/validation.json)保留原命令、各次红/绿边界和日志指纹。

## 4. 修复包冻结与最终现场结果

### 4.1 精确来源与本机接收

源码固定本地提交`b50918ae17ae3a961f8c4cabac4cc9ad529b51ae`，学生树`7fb690a787ac813b026838bd5d93123602233a17`；正常build发生在提交前，生产输入已核未变。[新manifest](evidence/i0-ui-pr69-real-recheck/student-real-dist-manifest.json)为143文件，ZIP `ui-real-recheck-b50918a-dist.zip` 5,632,527 bytes，SHA256=`f23f40f0e341808d5bb65faba531ddcc9a538a232453bc58d608752159eb2599`，入口`/assets/index-DmeUPG54.js`。

新包独立放本机工具根，目录`dist/real-recheck-b50918a`；第二次接收的原选择备份为`gateway.before-b50918a-20261014.json`、`active-dist.before-b50918a-20261014.json`。原工具stop确认本人进程退出及3443/14443释放；仅切两选择字段再start，新网关PID49736/SSH23240，固定源新143文件/TLS/ready **16/16**。这些PID仅本时点，后续必须由工具归属校验，不复制数值强杀。PAHER运行源仍`f761dcd`，没有把本地源码或main合并称为远端新部署。

最后通过原生浏览器同源匿名fetch（`credentials:omit`，严格TLS）实际读取入口1,269,910 bytes，SHA256=`8f401f35209eb5460acebe5bfbd3ba55d8ba9a88521861e7394c8a4b610dc103`，与冻结manifest一致；不只核文件名或本机目录。

本机已接收原4a包及新b509修复包；两个冻结ZIP、旧b7目录和两轮备份都保留。未执行回退演练；需要回退时先原工具stop并核端口/归属，再恢复相应选择文件原字节、原start/check，不删旧包或替换受信材料。

### 4.2 真正浏览器操作与公共结果

[最终浏览器摘要](evidence/i0-ui-pr69-real-recheck/fixed-package-browser.json)记录Chrome155有头、严格TLS、正常真实production页面，无fixture、Session注入或响应替身；[原包初步结果](evidence/i0-ui-pr69-real-recheck/original-package-browser.json)分开保留。全部主动写入为原获准合成A/原Attempt的学生操作，模型/help为0。

| 行为 | 现场结果与原关联 |
| --- | --- |
| 登录/首次选择/退出重登录 | 新独立浏览器正常表单登录，明确开始返回原Attempt/v8，首个active为input.txt且有编辑器；没有seed UI元数据或新Attempt。原浏览器已存main选择保留。最终退出200、正常重登录回原v9/正文/hash |
| 辅导明确拒绝 | 新包首次400后6.5秒只1次events，手动重读后3.5秒只新增1次；中文说明自动读取暂停，help=0。24表当前未组合C3不改成辅导已验，通过仅指正确处理这个真实拒绝 |
| 键盘/只读返回 | 菜单Esc回原入口、比较Esc/运行返回回原编辑器；唯一合成注释的undo/redo与正文保留，比较/历史/刷新零业务POST |
| 保存v9 | 只追加`// synthetic PR69 recheck 2026-10-14 b50918a`后明确保存，原main fileId不变，documentVersion6→7、144 UTF-8 bytes，hash=`dd116ed6…`；其余文件/生命周期与旧v8不变。sync回执`ff00bb7f…`/命令`d04248f8…` |
| 冻结v9 | 原快照`39495a9c-0c61-4a96-8dc5-50a1ac43a840`，manifest hash=`9c39861e4da1fb6b2fae5920abf1deec868cc6e9c7c67c084928cc52424ac54b`；两文件正文/hash与排序manifest重算符合，冻结回执`720bec5f…` |
| 真实C1新v9 | 明确一次Core：Run `e695b290-bdcd-47f0-bc0c-a73d3e965b99`/Job `51701919-06c3-4022-9747-2de2fdf710f3`，原回执/快照/gen/profile关联；GET确认succeeded，stdout为`new snapshot`、stderr空。没有自动再Run |
| 原Job停止 | 独立选已知无限程序v4，Run `b3f6d609-bb67-409d-9a7b-1c6e17874d0d`/Job `ddf13610-4ff1-4acb-9349-bc4229dfc043`；公开GET先确认running，明确停止回执`f1b4e589…`为cancelling/stopRequested=true，后GET cancelled才显示已停止。刚收到HTTP时客户端尚在接纳、短暂仍显示运行中，未冒称已经停止 |
| 历史/刷新 | 明确只读新v9/旧v8/停止v4，原Job/Run/snapshotHash/profile不改贴，参数只来自本机经校核原命令；刷新及重登录保持v9，旧10条运行不变 |
| 完整公开产物下载 | 只读已有v3 Run `7682a282-a51d-4e1a-995b-fb9234c649f0`，`report.txt` available/complete，21 UTF-8 bytes，SHA256=`3105a39fba2d6ddf5e48f95ff264f0f8e23f2fd107da03b17c6a3943415c7c36`。页面查看并实际下载，磁盘原字节/文本/摘要全部匹配；没有新建Report或补造文件。其他missing/redacted正确不给下载 |

[历史与下载截图](evidence/i0-ui-pr69-real-recheck/history-and-download.png)、[重登录v9](evidence/i0-ui-pr69-real-recheck/restored-v9.png)只含批准合成公开内容。[SSH/SQLite运行投影](evidence/i0-ui-pr69-real-recheck/server-run-projection.json)独立确认runCount10→12、旧10条完整不变、两个新运行各7项原关联为true、最终无queued/running/cancelling/outcome_unknown；[v8/v9实读](evidence/i0-ui-pr69-real-recheck/workspace-v8-v9.json)为24表、原v8与新v9各2文件bytes/hash/manifest均一致。v9复用原只读reader的本人定向副本，未改变留存工具/配置/库；原reader与SSH身份/pin不变。

最终业务POST精确为1 sync + 1 snapshot + 2 runs + 1 cancel，help=0、新Assignment/Attempt=0。正常Session登录/退出与“开始Attempt”领取原对象回执另列，不计新学习对象。网页操作与SSH只读交叉核对，不拿SQLite查询代替浏览器输入或学习行为。

### 4.3 失败、未执行与交接

历史RED不覆盖；新ZIP首轮校验把单项OrderedDictionary的`.Count`误当匹配数而中止，改为显式数组后原ZIP143逐项一致，没有重新压缩掩盖失败。首次把本机SSH reader当远端script执行失败，改为原本机入口读取成功。凭据seal的managed脚本没有原生`LASTEXITCODE`，首次判空值误报；按脚本异常/返回schema校验后正常，不重置凭据。保存验证首次读到了捕获队列里旧v8 GET，等待v9新鲜GET后正文/hash正确；没有为消除断言失败再保存或改作品。选择器歧义均改为实际可见控件；不把这些自动化失败列产品通过。

补验静态字节时错误使用Playwright的独立APIRequestContext：它没有继承Windows浏览器信任，TLS失败的工具错误输出意外带出当次合成会话Cookie。已立即通过真实页面正常logout200使该会话失效，原浏览器匿名Session实读401并清理本人context Cookie；随后改用原生浏览器匿名fetch完成严格TLS/hash校验。没有改信任或绕过TLS，没有复制该认证值到公开任务/证据；公开写集敏感项扫描无命中。当前浏览器结束时保持退出，原获准作品/运行与gateway保留。

第二账号/真实会话过期或撤权、真实丢ACK/旧代际/库恢复、真实暂停/终态写入拒绝、HDL3444、新模型/真人和完整M/AC/NFR未执行。本轮完成获准合成PAHER C1工程复验及正向完整产物下载，UI-TUTOR-09仍未开展。H-05版本差异仍联合A/C与授权维护者处理，不在本前端窄修范围内。

当前24表未组合C3的事实已回[同一A/C交接](I0-UI_AC_HANDOFF_20261014.md#7-新包真实复验后追加交接2026-10-14)；正常C3的28表隔离专项已证自动恢复，但不是PAHER辅导现场验收。若下一批要真实辅导，应由原宿主维护者按已批准通道/预算范围提供组合环境；本轮不派C重复当前C1/SSH或授权新模型。

仅更新当前任务、清单、本人交接和README导航；源码/测试固定`b50918a`。后续文档提交不改变该学生树或新ZIP源。结束保留当前新网关正常运行供Robert复查，凭据临时公共PEM/密文及本轮临时reader清理，必要ZIP/回退备份、浏览器保护profile与去敏证据保留。当前新修复为本地分支提交，未自动新建PR或合main；后续Git交付记录以实际命令回执更新。

## 5. 收尾检查与交付状态

独立只读复核确认实网/隔离边界、原v8与新v9/两个Run/5业务POST/21字节下载/来源及敏感项一致；发现清单“零读写”措辞不准确，已改为“只读且零业务写”，没有源代码变化或重跑无关测试。`node tools/a0-review/check.mjs`最终106文档/1719内链、errors=[]，差异空白通过；清单原30编号及顺序完全保留，PREP9/REAL12/TUTOR9。学生树仍`7fb690a…`；原受保护文档、后端/schema、依赖和`.zcodeignore`未改。

精确仓库写集17文件：3生产源、2浏览器spec、README及3任务/清单、6去敏JSON与2合成截图。本机清理了8个本轮公共PEM/密文叶文件及1个临时reader；只关闭本人已正常退出的验证Chrome，保护profile/草稿、两轮备份及原工具/全部冻结包保留，本机gateway/SSH仍归本人记录并监听。另有本机补充说明`PR69_RECHECK_20261014.zh-CN.md`说明当前选包、原命令及回退，未改已固定工具快照或source-manifest。

本轮为两个本地提交：源码`b50918a`及随后的最终文档/证据提交（确切HEAD用`git rev-parse HEAD`核对）。尚未推送、新建PR或合main；不将现有PR69/70的合并回执当成新修复交付。产品基线/MVP_SPEC §10待授权维护者汇总。

产品基线/MVP_SPEC §10待授权维护者汇总。
