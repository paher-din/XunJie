# UI30：本机真实 HDL 接线与浏览器回交

2026-10-15（Asia/Shanghai）；主责 UI / Robert。本轮完成正常页面的真实 HDL 接线及获准的本机合成浏览器闭环：错误源码→确认快照→真实失败诊断→真实模型提示可见展示→开发合成明确回应→显式修订→新成功 Build/装载→相同输入输出改变→确认停止。原 C 同源入口及普通运行保留。**这是合成工程验收，不是真人学习、教师语义评审或完整产品验收；#30/#38保持 Open。**

依据为[本轮实施与明确批准](../../I0-UI_HDL_REAL_BROWSER.md)、[原 UI30 回交](../../I0-UI30_COMMENT_CLOSEOUT.md)、[UDL 操作表](../../I0-UI30_HDL_OPERATION_MAP.md)、[H4 接线包](../../DLA_H4_UI_HANDOFF_20261014.md)。已按根 AGENTS、README 与上述正文核查；产品/规划/参考/规范未由本交付改动。原操作表的“尚未接线”属于旧时点，本文件以新源码和新证据补充，不改贴旧材料。

## 1. 精确源码、环境与入口

| 对象 | 本轮实际来源与结果 |
| --- | --- |
| 完整演示主体 | `bec2e3c250091969f59e233439debd307a6925c2`；此前 `464b33e` 的原 baseline/错误 Build 保留，辅导可见性与恢复守卫修复后完成主体闭环。[演示清单](ui-demo-manifest.json)：143文件，ZIP SHA256 `bdecee2b4d532468d3dd2b3a4c7709dd3f9317175a63e29fad09875736595fac`，入口 `index-D_j10q17.js`。 |
| 主线接纳与最终 UI | 普通 merge 接纳 main `0f246056`，中间点 `41563d9`保留主线读取拒绝守卫及本任务 HDL 来源守卫；最终 `8d613a7224d6e309500913277a10b024258fa82c`修复本人编辑器包裹层高度。[当前清单](ui-current-manifest.json)：143文件，ZIP 5,653,435bytes / SHA256 `4346d0a05308d0b73ebddc109be37dd5612ee86f71efd373d84baeb92e63ed5d`，入口 `index-Iq2DyhKA.js`；[当前严格静态增量](static-http-final.json)13变化文件逐字节/hash通过，124未变/6原MIME引用，双health200。最终包真实 C/HDL 只读编辑器复核见下节；没有重跑模型和完整演示，不把 bec2e3c 的原操作改贴成8d新操作。 |
| 正常浏览器 | Robert 本机 Windows用户h、Chrome155、既有已连接profile「您的 Chrome」，正常 `https://127.0.0.1:3444` 表单/Session/CSRF/bootstrap；磁盘profile目录未读取，不猜作Default。没有准备模式回退、Cookie注入或证书警告绕过。 |
| 信任与严格 TLS | 复用会话明确批准保留的用户 `CurrentUser\\Root` 确切本机叶子 SHA256 `8d663b4dba93b1fb61df544fe3fe17022e561d88a559576381abf1220b3ac52e`；Windows默认链/127.0.0.1校验、TLS1.3及严格health见[静态实读](static-http.json)。没有新根/LocalMachine变动。A组合签认不由UI代签。 |
| 新业务环境 | 原35表工厂的新本机合成库、3账号、2课程/3分配；新签名/初始化材料仅本机受限目录。原教师认证API发布/分配，不直接写SQL，不复制PAHER24/35表库、密码、密钥、Job账本或旧passed。旧PAHER `54bb4cfc-5d64-42a2-a1c9-58ea58458705` Attempt仅历史。 |
| 专用执行节点 | Ubuntu WSL内新2CPU/4GiB/20GiB专用VM；kernel6.8.0-142、Node24.21.0、Docker29.8.2/runc1.5.2、cgroup2/overlay2/swap0/AppArmor enforce，无9p/virtiofs/drvfs共享；学生程序在专用节点执行。原四OCI逐config/diffID核验，见[镜像收据](verified-images.json)。 |
| 原冻结源/新代际 | runner sourceHash `7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852`；新generation `synthetic-generation-c6772623-ba28-4c50-a853-337f77382452`；C指纹 `2ce8cb3324b8001a5e3929baf21e5b802b09b4aba82fa7c6ab2e93ecf67b9dcf` / HDL指纹 `ed41d6ee92874c8a96bdb9530e28f9735f9e80005079708f358382ee5785c99d`，见[本机原readiness](local-node-ready.json)。C runtime是实际 `765d51df…fe99`，旧候选 `e658…`已更正。 |
| 启停与保留入口 | [工具说明](../../../../tools/i0-hdl/README.md) / [PowerShell入口](../../../../tools/i0-hdl/xunjie-local.ps1)：`status/check/start/stop`；仅明确需要本人模型时 `start -EnableModel`。沿同库/磁盘/身份/代际，不重新初始化；`stop`只关所属业务宿主，保留VM和工具。并行3443及PAHER未由本轮修改。 |
| 模型与结束状态 | 本人既有key只进临时本机子进程env，教师模型始终关闭；仅本轮获准student_help启动时启用。两次真实HTTP200后正常停止模型宿主，[退出记录](model-enabled-host-stop.json)为activeJobs0/occupiedHdlSessions0，同库保留；[随后默认关闭启动](model-disabled-start.json)双health200。没有全天在线承诺，重启后先check当前就绪。 |

当前本机对象均由正常bootstrap/head和原收据核对，见[最终公开账本](browser-final-public.json)：

| 分配 / 学生 | Activity / Assignment / Attempt |
| --- | --- |
| C / `synthetic-robert-student-a` | Activity `e60dfec4-756b-4853-95e6-453911afd5d0`；Assignment `fb0983e4-81bc-487b-8b50-7ffe984c38bb`；Attempt `1e657276-83dd-4129-a1c5-fb8c66f1c21c` |
| HDL原公开映射 / `synthetic-robert-student-b` | Activity `813eeec7-d356-4e50-87ba-acd1b6fb3ebe`；Assignment `4c589f3c-18bc-447a-b6bb-6e3a86c442a7`；Attempt `c5d1cf8e-991b-431a-9d39-177260725964` |
| HDL全输入补充 / 同一student-b | Activity `34333404-d8a3-464f-8039-ab4fad8e6873`；Assignment `cb4e54cb-df5a-4198-bc91-1d8274a9cf64`；Attempt `bb20d32e-64de-4156-9fd0-9bda95364f60` |

正常深链是 `https://127.0.0.1:3444/#/task/<assignmentId>`；移机/重新初始化后读取自己的新分配，不能硬编码复用此库ID。公开仅loginName/受控领取方式，口令、Cookie、CSRF、签名、私钥和模型key不进入包/commit/日志。同一Host的Cookie不按端口隔离，使用与并行任务隔离的既有profile并退出本任务旧3443页面。

## 2. 同一实际浏览器闭环与原回执

| 实际操作 | 原对象/输出与证据 |
| --- | --- |
| 原错误设计基线 | 原baseline Build `9e2c8b08-92c1-4c64-aea3-3bcf734bdc8f` / Session `88c7960f-50f8-43d6-9e2b-04775e94dad9`，SW0=1而LED仍全0，seq1/time10000ps；UI没有修正错误设计。[基线截图](browser-hdl-baseline-sw0.png)。 |
| 显式错误编辑/保存/快照/诊断 | `top.sv` file `1ff729fe-3365-4cb0-8e07-2bc4a558783c` v2、snapshot `992df0be-69e1-47ea-a28b-436b55bbc22b` / workspace2；failed Build `2a28b361-05fa-4b35-bb92-4a57a7db208c`，真实iverilog第10/11行，line-only整行定位，不猜列。[真实失败](browser-hdl-error-build.png)。 |
| 同快照显式求助/原冻结basis | 原help选择该snapshot/Build和同快照code ObjectRef/filev2；原C3冻结workspaceRevision2、snapshotHash/buildResultHash、scope/generation/targetVersions。第二Job `70d697fc-0389-4cb5-a19b-9d68515db10d` succeeded，Message `92e9f7a9-dc89-4ee9-9f76-77242b10f013`。模型不是旁路脚本，也没有假的teaching.delivered。 |
| 真实正文可见与合成明确回应 | Action `5b918f49-a908-4b4a-864f-7b6d50f021c3`，Delivery `c4396c80-94c4-4828-9783-f3766b67fcb2`，正文hash `e0aded304a3a979c45ed00fc1dd0b5e6b0d2d5523e58a94d2d644958174bc0fd`；received seq46、displayed seq48、开发合成点击回应的acknowledged seq50，原client/delivery/receipt/source绑定匹配且无raceReason。[可见正文](browser-hdl-agent-body.png)、[分层回执](browser-hdl-agent-receipts.png)。**合成ack不是真人确认或学习证据。** |
| 显式修订/新构建/装载 | v3快照 `22273762-7ba5-4d7e-b5da-63425a3ccf14`，成功Build `ce1bc3d1-183c-487c-8a48-f1e18ccc5ac1`，Session `c40824e4-d9bd-45af-9542-16c7d1d67eb3`；相同SW0=1时真实LED变1。[修订后相同输入](browser-hdl-corrected-sw0.png)。旧提示在作品修订后变stale，原历史及回执保留。 |
| BTN/有限Trace/显式推进 | c408 seq2 BTN0=`00001`使AN=`11111100`（多位低有效），seq3release回`11111110`；seq4显式5cycles至80000ps，sampleCount5/droppedFrames0/coverage complete。[有限Trace](browser-hdl-finite-trace.png)。模拟时间、LED/AN/SEG/DP皆原帧，不从ALU/SEGMAP或本机计数代算。 |
| 刷新核原实例/确认停止 | [刷新前](browser-before-refresh.json)/[刷新后](browser-after-refresh.json)的同文件v3/hash、3Build/2Session/7Operation及原jobs/snapshots/IDs/版本集合完全一致；没有隐式创建执行。随后c408确认stopped/terminationConfirmed=true、seq4/time80000，最后结果保留。[确认停止](browser-hdl-corrected-stop.png)。 |
| 全输入新immutable补充 | 原配置缺resetN仍明确未绑定/disabled；按另获准的本机合成范围，通过原教师API新建 `synthetic-robert-hdl-full-input-config-v1` / `synthetic-robert-full-input-mapping-v1`，增加resetN→rst_n宽1，不替换旧配置/活动。新Build `df648a36-acaa-442c-95af-3977bd3df22f`、Session `a424a6b2-2ce3-4b94-a259-0eb407d21ffe`。 |
| 真低有效reset/五按钮 | a424 seq2 resetN0使LED0；seq3释放为1使LED1，[低有效复位](browser-hdl-reset-low.png)。BTN0–4依次`00001/00010/00100/01000/10000`及各release均收到原确认；BTN0多位AN、BTN1全灭AN=`11111111`保留，不纠正。 |
| 真X/Z与极性 | a424 seq14 SW15+SW0输出`1000000000000001`；seq15 SEG=`xxxxzzz`；seq16 LED=`xxxxxxxxzzzzzzzz` / SEG=`xxxxzzz` / time160000ps。AN/SEG/DP低有效、X/Z区别呈现，[真实四态](browser-hdl-real-xz.png)。实际操作SW0/1/2/15，另外12个SW未逐个真实点击，16位宽度/全部控制守卫由隔离测试补证，不冒称逐位现场完成。 |
| 显式替换/初值/终止 | 原command seq114 `shared.hdl.replace_stop`先核旧a424退出，seq115原program产生新Session `88afdc62-71d2-4cf8-8c6a-5bcafb048c48`，初始seq0/time0/LED0；最后新旧均确认stopped。[替换初值](browser-hdl-replacement-initial.png)。 |
| 真实换账号/未分配 | 正常退出/表单换student-a/b，A访问HDL分配、B访问C分配分别拒绝，无跨学生作品读取或静默落到demo。[A拒绝HDL](browser-student-a-unassigned-hdl.png)、[B拒绝C](browser-student-b-unassigned-c.png)。多标签完整矩阵仍未执行。 |
| 同机C普通运行/历史 | C仍有原Core入口，snapshot `4be2ecef-9c89-4031-8e2f-e6244aef5638`，Run `53e6cafd-fc28-434a-92ad-9cacc88cb6c1` / Job `2269a9cc-d052-4f7d-a34a-62d3470d3819`，compile/execute exit0、unitTerminated=true、stdout `Robert local C core`、report.txt missing；[普通运行](browser-c-core-real.png)/[原历史](browser-c-history.png)。`check_state=null`，**不称课程Core检查或Report下载通过**。 |
| 模型关闭仍可保存 | 恢复默认budgetoff后，HDL help Job `8d88a61e-30a9-4d6d-8ea9-3b27dfeebd93` failed，无新增model Message/Action或HTTP；同原HDL作品正常保存v4并冻结snapshot `f3e8643d-cda4-47df-9477-af99f49a0fe0`。[关闭后保存](browser-budget-off-save-v4.png)。 |
| 最终编辑器只读复核 | 原包裹层普通block造成Monaco仅5px的视觉失败已保留，最终8d613a7仅改纵向flex；同原C对象editor646px/完整5行/原stdout与history，HDL editor491.5px/完整15行含budgetoff注释/filev4，原ce1bc/c408已停seq4/time80000/LED1保持。[C最终编辑器](browser-c-editor-final.png)、[HDL最终编辑器](browser-hdl-editor-final.png)。不新增保存/运行/模型任务。 |

[模型transport原公开记录](model-transport-public.jsonl)只有两次student_help HTTP200：首轮actual input2933/output507，第二轮2704/466；它不代替显示证据。首Job `03f58f2d-080e-4074-b69f-26a63b44cbb8`虽succeeded/received seq34，但小滚动区可见性和恢复当前性缺陷造成未展示；未补displayed/ack，原Action后取消。第二轮正常新请求完成显示/回应，首失败与第二成功分开统计。

最终公开账本为35表、3分配/3Attempt/3文件/6快照、4Build、4已确认终止Session、25Operation、33终态Job（31succeeded/2failed）、5教学Message/2Action/4Receipt。[最终核对](browser-final-verification.json) `--require-settled`：246项一致性检查、failures=[]、missingEvidence=[]、刷新对象比较unchanged；校验原快照正文/hash、CommandIdentity/scope/provenance、原rawJSON内外resultHash、每Session序号/revision/time及教学message→action→delivery→receipt链。核对工具只读公开导出，不自行证明截图可见性、真人操作或教学效果。

最终8d包只读复核后的[公开重读](browser-postmerge-public.json)/[再次核对](browser-postmerge-verification.json)仍settled-consistent、failures=[]、missingEvidence=[]；分配、Attempt、文件、快照、Build、Session、Operation、Job、Run九组原ID/版本/数量完全unchanged。编辑器修复及静态接收没有新增模型或隐式执行。可复现导出/原契约核对命令见[工具只读证据入口](../../../../tools/i0-hdl/README.md)。

## 3. H-01～H-06 / UDL-01～UDL-08 覆盖

| 项 | 已接线与本机实际覆盖 | 隔离证据 / 未执行范围 |
| --- | --- | --- |
| H-01 身份/HTTPS/Session | 同源严格TLS、正常表单、退出重登、两学生换账号、刷新原Session | 原自然30分钟/8小时到期、其他机器/profile、真人未验；A组合实审不代签 |
| H-02 分配/活动/材料 | 原teacher check/release/assign、本人bootstrap/head；合法C/HDL和交叉未分配拒绝；公开资料显式student/tutor visibility | 本机教师暂停/撤权/submitted/reviewed的完整实际矩阵未执行；不增加分配列表或教师替代UI |
| H-03 受信代际/恢复 | 全部新库对象/原命令/节点同新代际；刷新文件/执行IDs与版本集合不变 | 实际换代际、旧备份、崩溃/RPO、WSL/guest重启恢复未执行；原故障隔离证据不迁现场 |
| H-04 原消费者/节点 | 真Build/Session/Trace和同机C Run由原消费者推进；新专用节点原验收及双ready | 未手工processJob补门禁；H3新worker/2800/course_check/完整AC/NFR不计通过 |
| H-05 权威head/保存/快照/控制 | `.sv` v1→v2→v3→v4；原ACK/hash/不可变快照与新草稿区别；停止/替换核权威状态 | `.v`实际编辑、版本冲突、实际教师暂停/提交/审阅、多标签故障未执行 |
| H-06 执行/停止/unknown/历史 | 原Run/Job/HDL执行投影、真实停止确认、替换初值、保留旧结果及C历史；产物missing不补正文 | unknown/失ACK/离线/长pending是隔离协议反例，非本机网络故障注入；Core普通运行非课程判分 |
| UDL-01 合法课程分流 | 原Activity.execution/config/hash选择真实HDL，保留C；实际两学生入口及拒绝 | missing execution/篡改配置/物理port重叠/`.sv`不能切C的单元与协议反例 |
| UDL-02 原文/ACK/快照 | 原编辑/确认客户端与成员工作区；真实`.sv`保存/快照/刷新，更晚草稿不污染旧Build | 旧快照/回收/同路径新实例/CRLF诊断保护由隔离单元；`.v`实际未跑 |
| UDL-03 Build/Job/诊断 | 真失败第10/11行整行定位、修订成功；null/waiting/unknown不当成功 | unavailable位置、不猜列/旧源码定位/伪hash拒绝等定向单元；非课程能力判断 |
| UDL-04 program/持续Session/替换 | 明确成功Build→原持续实例，真实replace_stop→program、seq0初值与最后退出 | 完整崩溃/双实例吞吐矩阵属C后续，已有节点两实例测试不等本机浏览器全矩阵 |
| UDL-05 输入/真帧/有限波形 | 16SW控件/5BTN press-release/resetN/推进，实际SW0/1/2/15与五按钮/新映射reset；真LED/AN/SEG/DP/XZ/time/coverage | 原未绑定reset仍disabled；其余12SW逐位现场未执行；超Number精度字符串/有限window/无数据不归零由单元验证 |
| UDL-06 pending/原键/Stop/恢复 | 真刷新不新增执行、Stop确认/替换；原wire/key/hash持久化及迟到guard | 隔离失ACK/60轮耗尽后明确续读/迟到Assignment/keyboard用例通过；不冒称实际断网/换代际矩阵 |
| UDL-07 明确求助/来源/过时/降级 | 同快照selection/ObjectRef/冻结basis，实际提示和作品修订后的stale；budgetoff失败仍保存 | 单元/协议确认错误basis/新草稿/Session变化/原预算拒绝；B语义/教师正式审阅未代跑 |
| UDL-08 真显示/回执/接棒 | 第二真实提示可见，原46/48/50分层回执；显式开发合成修订后同SW输出变0→1 | 首轮可见性失败保留；合成ack不能记真人确认，完整DL-AC/教学收益仍未通过 |

源码使用[原工作区](../../../../apps/student/src/pages/PrepWorkspacePage.tsx)、[HDL客户端](../../../../apps/student/src/workspace/hdlWorkspace.ts)/[持久原命令](../../../../apps/student/src/workspace/hdlStore.ts)/[状态协调](../../../../apps/student/src/workspace/useHdlWorkspace.ts)、[真实板卡/Trace](../../../../apps/student/src/components/workspace/HdlToolArea.tsx)、[同快照诊断](../../../../apps/student/src/workspace/hdlDiagnostic.ts)、[辅导来源](../../../../apps/student/src/workspace/tutoringHdl.ts)，注入原CenterToolArea/Tutoring位置，不另建整页。没有虚构Operation/current HTTP端点，原Session/Trace取得结果。

[正常模式隔离浏览器spec](../../../../apps/student/e2e/hdlRealWorkflow.spec.ts) / [显式协议替身](../../../../apps/student/e2e/hdlProtocolFixture.ts)共7独立用例分批通过，包含pending/失ACK/刷新原wire、长pending60轮与明确续读、迟到Assignment、键盘、预算关闭和C保留。它们不接prepared fallback、真实C1或模型，不当真实HTTP授权/执行证明。初始42文件555单元、optional输入受影响22项、可见性/恢复修正后43文件569项分批记录；bec2e3c/41563d9类型/单元/生产构建通过，最终8d613a7类型/构建及实际只读编辑器复核通过，不把不同批次重复相加。

## 4. 原节点、静态核对及失败保留

| 原验证批次 | 实际结果与证据 | 边界 |
| --- | --- | --- |
| 本机C原guest/SSH | [guest原日志](node-c-guest.txt)58总/55通过/0失败/3明确skip；[应用/维护SSH](node-c-ssh.txt)10/10；strict类型exit0 | 三skip是细时间RTL、HDL目标测试与guest内SSH入口；后两能力另由明确独立批次覆盖，不把skip洗成该批通过 |
| 本机HDL原工具 | [HDL](node-hdl.txt)10/10、0skip；[同工具C](node-hdl-c.txt)52总/51通过/0失败/1SSH skip；[汇总](node-acceptance-summary.json)绑定新fingerprint/validation | 不累计重复C用例，不算新H3镜像/worker/2800矩阵 |
| bec2e3c严格静态 | [static-http](static-http.json)143清单：137可服务文件逐字节/hash匹配，6JSON/OFL原MIME拒绝验证，双health200/TLS1.3 | 首次验证器API使用错误146失败保留在priorAttempts；修复只读验证器后补验，不放宽TLS/MIME。不是按钮链或教学验证 |
| 41563d9中间静态 | [增量static-http](static-http-postmerge.json)13变化可服务文件新核/13通过、124未变引用、6MIME引用，双新health200 | 明确`newFull143Verification=false/newBrowserAcceptance=false`；不说再次全143或完整新浏览器通过 |
| 8d613a7当前静态 | [最终增量static-http](static-http-final.json)13变化可服务文件逐HTTP字节/hash/13通过、124未变引用、6MIME引用、双新health200，默认Windows链/127.0.0.1/TLS1.3无绕过 | 当前源/入口与ui-current-manifest一致；`newFull143Verification=false/newBrowserAcceptance=false`，编辑器浏览器只读复核另有截图，不把静态计作新完整演示 |

失败与补验保持原时点：90秒OCI部分接收超时未加载；搬运漏原公开fixture、HDL准备目录及公有验收输入继承umask077，修对应准备后原验收子进程恢复022（秘密/config700/600不变）；seed首次resource POST200后本人旧扁平receipt解析失败，修原identity/scope/hash并同key核回，未重建资料；长pending轮询通知/续读禁用、布局横向裁切、Build.result求助接缝由本任务修根因，保留原隔离失败。

实际辅导79px滚动容器/1874px整卡的5%观察阈值导致received不等displayed，先改为只观察实际Markdown正文正面积交集；刷新idle/reading空Build使消息误持久过时，改为完整read ready才投影current、unknown保持null、原channel正常从0重新授权。首Job旧缓存不强行解锁，不补展示回执；第二次正常请求独立完成。最后编辑器5px视觉失败单列，最终纵向flex只读复核恢复原空间；上述失败没有借服务端200或模型HTTP掩盖。

## 5. 原评论覆盖与 A/B/C 回交

| 原评论要求 | 本轮回交落点 / 剩余原域 |
| --- | --- |
| [6155068633 §1](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633)：浏览器/版本/位置/profile、窗口/源/ready/启停、信任准确对象与许可、受控账号/正常登录、合法分配/拒绝 | §1精确本机方案与工具、§2实际入口/跨学生拒绝；A核组合权限，不由UI代签；沿最新明确批准的新本机35库，不重复旧I0初始化或材料 |
| 6155068633 §2：按身份→恢复→保存/ACK/head/快照→Run/Stop/历史分批，H01–06及错误/过时/unknown/刷新/多标签/账号/键盘、固定SHA/PR/原请求/版本/缺项 | §2原对象/回执/截图、§3 H六行与隔离/实际/未执行分别列出；旧C实际批次沿[原回交 §4–6](../../I0-UI30_COMMENT_CLOSEOUT.md)，不迁本机；完整AC/NFR/真人继续#22/#23 |
| 6155068633 §3：UI给A/C/B操作→真实请求/ID/版本/状态→已有/模拟/缺失/负责人表，覆盖保存/Build/诊断/装载替换/输入/输出/Trace/停止unknown/求助/回执 | 复用已交[操作表](../../I0-UI30_HDL_OPERATION_MAP.md)原接口与来源，§3 UDL八行给新接线/实际状态；C原H4/current样例直接引用H4包，不重制原20项 |
| 6155068633 §3：C补H3层级/稳定采样/独立check Session/command/result/准确写集/2800方案；共享确认、#38/#39固定链接回#30 | C继续其已有交付与未执行目标节点范围；本UI不接私有向量/新course_check。主Agent发布#38固定功能/证据链接，#30仅引用共用入口与状态，不在#53/#56重复整包日志 |
| [6161397303恢复评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6161397303)：用当批新ID、旧对象历史；浏览器信任/领取/正常登录/页面及重启核就绪；A审核/visibility/PR59ready补正分开 | 原C回交保持时点，旧503与后来ready200不互相覆盖，也不再把已完成A修复列为欠项；最新获准本机另建新ID/新代际，§1/2无旧PAHER对象改贴；完整重启/RPO未执行 |
| [6170192513立即接线](https://github.com/paher-din/XunJie/issues/30#issuecomment-6170192513)：#56合入后UDL01–08，不等H3、复用现有页面/C、原Build/Job/program/Session/Trace/停止/来源/C3；同浏览器错误→提示→显式修订→真输出 | §2真实完整合成链、§3每UDL及原C保留，真帧/原回执/冻结basis；源码/图/对象/版本/引擎/失败全部公开分层；合成回应不说真人学习 |
| 6170192513：旧学生A通路不能授B、新预算独立、历史提示不冒新AI、H3/教师绑定/course_check/镜像/2800后置/Issue保持Open | 新本机范围及本人key使用在任务§4.5明确批准；两次新实际模型请求保留首失败，结束恢复默认off；H3等继续后置、#30/#38不关闭 |
| [6170632785 C最终运行回执](https://github.com/paher-din/XunJie/issues/30#issuecomment-6170632785)：准确87edd51/3d053bf源、137首轮136+1dist失败后定向1/1、143静态/原MIME/同旧库/预算off、启停和等待UI显示真输出 | 已消费其准确原source/runtime/失败边界，不要求C重跑；本轮新本机源/产物/库/节点另有§1–4证据，不把C旧137/464单元/健康静态当本轮按钮链；UI本人真实displayed/修订输出回交如§2 |

交 A：正常入口/明确批准/公开资料visibility、原35表新对象及版本、原request/receipt/scope/hash/冻结basis，供组合实审；教师规则/正式教学判断/保护基线汇总仍归授权维护者。交 B：同快照失败诊断与有限真帧、原教学来源/当前性/降级/真实显示及合成回应证据；工程相关性不等于正式教师语义评审。交 C：新本机指纹/validation、真Build/Session/Trace/replace_stop/确认退出、刷新原ID与同key、实际输出问题；C主责后续H3/独立check Session及course_check，不重复其已交原20项和旧模型批次。

H3目标新镜像/worker部署、私有2800向量、教师活动绑定/course_check、独立检查Session占用/吞吐与完整双实例/停止/崩溃矩阵 **未执行**。本机原10项/公开Trace/普通C运行/两模型请求不能代替它们。完整DL-AC、原P4/P5/M/AC/NFR、真人门禁、正式教师语义评审和学习效果 **未完成/未执行**；产品基线及MVP_SPEC §10 **待授权维护者汇总**。

本文件及同目录证据已正常推送固定交付 `954f5613f8a3d9d1da0dd288cf8127fa010a0752`，创建并附当前任务 [PR79](https://github.com/paher-din/XunJie/pull/79)（Open、非Draft、CLEAN/MERGEABLE，hosted status checks为空，未合并）。main `3a6de704` 的H-05/C5已普通接纳；当前本机业务仍254e938，不把仓库合并计该现场已部署。

按原要求先发布 [#38固定回交6175218005](https://github.com/paher-din/XunJie/issues/38#issuecomment-6175218005)，再发布 [#30共用入口/逐项状态6175261812](https://github.com/paher-din/XunJie/issues/30#issuecomment-6175261812)，两份正文均独立GET逐字回读一致。#30首次GraphQL连接在发出前超时，先查专属标记无已有评论，再用原REST POST同正文完成，没有重复发布。两Issue仍Open；此前PR68已合入事实沿任务起点8ef9dc0保留，本PR没有被自动合并。A/B/C实审及保护基线汇总请求已经在原Issue交对应角色，不冒称他们已确认本批新本机证据。
