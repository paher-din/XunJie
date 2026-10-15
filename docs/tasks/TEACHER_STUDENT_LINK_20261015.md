# 教师分配与学生接收联动复验

日期：2026-10-15（Asia/Shanghai）。执行：当前Agent。

## 依据、范围及授权

负责人要求拉取最新远程，跑一遍教师端与学生端联动，核实教师下发任务学生能否接收。开工已读README/AGENTS、PRD §4.1～4.3、MVP M-01～03、TECH §5及§9，TEAM固定职责；教师任务I1-TEACHER §1～3/6～7、teacher-workflow说明、共享入口说明及对应真实接线实现。判据：教师正常登录手工设计→检查/预览→固定发布→明确分配给合成学生→学生正常登录首页发现同一Assignment→进入/主动开始同一固定活动；未分配账号拒绝读取。分配不自动创建学生Attempt，GET不触发写入，保留原权限/CSRF/CAS/幂等/受信代际。

主checkout main4fdf2f0存在编辑器等大量并行未提交工作，未覆盖/暂存/提交。已通过现有本机代理fetch至origin/main9664ca5646b969cde0ccff4f4b8d5c7ea2da547d；新建并附本任务管理工作树teacher-student-link，准确基线为该远程HEAD，未强行更新脏主checkout。该独立目录作为本轮最新源码，不把旧工作区/旧服务称作最新已部署。

可写本任务、本人联调/只读准备工具及公开去敏证据；复用原教师/学生正常UI与服务API，不新建替代界面、改产品/共享契约或安装新依赖。规范、产品/规划/参考与他人记录只读。模型无需参与手工分配，本轮不发送教师/学生模型请求；既有个人设置/key不改。

## 环境事实与待批准提案

当前3444由Linux Node24.21 PID1852的host-shared.mjs提供，引用editor-final-20261015-ktx1xE业务副本和PAHER原持久合成库；账号为synthetic-i0教师a/b、学生a/peer/b，课程a/b，学生b同时属于两课。共享metadata列已存在。现库精确35业务表，未包含review六表。最新代码只有options.review启用时才注册teacher-workbench，且assert精确41表；因此直接部署前端或运行35表宿主不能完成正常教师工作台验证。历史Robert41表批准/结果不能套用到当前PAHER对象。

待负责人批准的准确动作：停止当前共享宿主接纳/原Job消费者、核pending Job与未终止HDL；SQLite一致性独立备份并核完整性/SHA；仅对`/opt/xunjie-runner/tests/i0-entry-20261013-01/retained-tmp-20261014/xunjie-a12-completion-dZlbr9/synthetic.sqlite`追加原reviewSchema的analysis_results、learner_context_revisions、learner_disputes、learner_state_revisions、teacher_decisions、teacher_feedback六表及原四索引，从35到41；保持原35表schema和每行摘要不变、control代际不变，不动24表、节点身份、密钥/配置或个人库。用最新完整源码启用既有review组合，手工教师模型保持关闭；新旧源码/备份/回执保留，失败停止，不覆盖旧库/重置代际。

风险：41表库不能交原35表宿主启动，维护窗口短暂停共享服务；回退必须另行协调，不能直接拿旧备份覆盖产生了新记录的库。当前提案尚未批准，不执行schema写入；独立新源码/构建/只读检查继续。验收与执行结果后续分层追加，未宣称真实联动已通过。

## 批准前已完成准备

已完成最新9664ca5独立源码/静态准备：前端独占构建`D:/tmp/xunjie-teacher-link-20261015/ui-9664ca5`，入口index-BJIEyGZQ.js，tsc/Vite退出0（保留原chunk提示）；`npm test -- --maxWorkers=2`53文件647/647通过，无跳过。新Linux业务Git archive位于`/opt/xunjie-runner/tests/teacher-student-link-9664ca5-20261015`，Node24.21.0类型检查退出0，依赖沿原native安装，原安装锁与当前锁逐字一致，未安装依赖。首轮对editor副本的lock路径不存在，未据此判匹配，改核原webui-main-4fdf2f0完整副本后cmp退出0。

迁移提案复用已交enable-review工具，仅将目标/五个synthetic-i0账号及两课程改为本机准确对象，并追加无在途任务/会话、无其他数据库FD、原行逐字摘要/备份逐行核验守卫：[限定工具](evidence/teacher-student-link-20261015/enable-review-paher.mjs)。默认--check只读；实际check返回35→41计划、完整性ok、FK0、六表/四索引、reviewSchema SHA256=7d498423167679a1f52e1feef5170f8284d27fb1f19f5be0a489046bd937316c，applied=false。--apply尚未获准/执行；没有停止当前PID1852或变更库、配置、key、节点代际。批准后须再次核对现场，因为准备时状态不代表执行时状态。

已通过异步问题向负责人提交准确迁移对象、动作与风险，待明确选择。未执行教师手工发布/分配或学生接收，不将最新源码中的其他机器历史通过数代为本轮通过。产品基线及MVP_SPEC §10如需汇总，待授权维护者汇总。

## 负责人明确批准与实施窗口

负责人答复“批准上述升级与联调”，准确覆盖前述PAHER原库、停止/对账、一致性独立备份与SHA/完整性、原六表四索引追加、原数据/代际保持及新版教师宿主/真实页面分配验证。本会话沿该批准执行，不再重复确认；没有授权个人库/凭据/24表、节点代际/镜像或生产变更。执行前再次核源与当前在途状态，检查通过后只按方案切换。

## 实际迁移和页面联动

2026-10-15 15:25北京时间，准确旧PID1852/source校验、pending Job0/未终止HDL0，正常SIGTERM确认退出后，执行限定迁移。独立一致性备份为原受限根`teacher-link-review-2026-10-15T07-25-40-619Z/before.sqlite`，SHA256 f5c4a2fe4bfaf8023af050a344b5829c672cbcca680dfd1384959a046b85b27d；备份/当前完整性ok、FK0，原35表schema和每行摘要不变，追加六表四索引为41表。[迁移收据](evidence/teacher-student-link-20261015/migration-public.json)。同一代际96fc2f60/control2未改；用户显示名/账号停用状态、原24表、个人库与key均未改。不是重建或恢复旧库。

最新9664ca5宿主仅启用原review组合，不初始化个人四表；教师模型关闭，旧学生env通道仅运行时继承。首次新PID3652 ready200，[切换收据](evidence/teacher-student-link-20261015/switch-public.json)。原源码/静态/脚本保留；当前41表不能交旧35表宿主直接启动，也不能在已产生新记录后盲目覆盖旧备份，回退须另行协调。

所有下列业务写入均由真实页面控件发起：Chrome独立教师会话，应用内浏览器独立学生会话；严格TLS、原表单/Session/CSRF/幂等/revision，没有Cookie注入、协议替身、SQL写业务行或模型调用。凭据从受限initializer读入内存，经RSA-OAEP-SHA256密文通道传给表单，未输出/落盘明文。

### HDL 教师B → 共享学生 Robert

手工以本课已有合成范例新建“合成联动验证：教师下发 HDL 任务 20261015-1528”，保存蓝图4b8c99cb-3c15-4c0e-9250-b075858e0b53/v1，真实结构检查blocking0，逐一查看学生/辅导/教师验证器真实投影后确认固定活动224c955b-a5b9-4553-9257-2878f7635cf0。教师明确只选synthetic-i0-student-b（显示Robert）并分配，原Assignment b81973b2-dde4-4019-98d9-b4f26b036b13/v1，页面显示已分配给1位学生。

学生正常首页→数字逻辑课程→本轮实际任务卡→同Assignment深链，任务信息显示同固定活动/课程/学生。教师分配后及学生仅GET页面后，两次只读核库Attempt0；明确点“开始Attempt”后恰有1个Attempt aaa73cb7-9aaa-44c2-8b74-87b423b93414、status ready、workspace0。未输入、保存、运行或提交，不能称为已开始学习。教师“学生与审阅”实际能看到该新尝试并标“尚未提交/尚未开始”。[教师回执截图](evidence/teacher-student-link-20261015/teacher-assigned.png)、[学生任务卡](evidence/teacher-student-link-20261015/student-task-list.png)、[学生任务信息](evidence/teacher-student-link-20261015/student-entered-task.png)、[教师进展列表](evidence/teacher-student-link-20261015/teacher-sees-student.png)。

### C 教师A → 同一共享学生 Robert

当前课程名单只有Robert为启用状态，旧student-a/peer保留原disabled_at_ms=1792040518254，未为测试启用或更改账号。新增“合成联动验证：教师下发 C 任务 20261015-1540”，蓝图72eee86e-ec91-49bb-8e9b-67270bd0e66b/v1；真实检查blocking0、三角色预览后固定活动eaeb74d5-1256-43f1-8d0b-0ba1bcb1d82d。明确分配给Robert，Assignment a60e1238-d9a7-4658-8f54-882b61ebf3c6/v1。

在分配前，另建短时测试Session用同一活跃学生、同一课程、同一活动做严格HTTPS GET，返回403 FORBIDDEN；分配后同GET返回200及同activityId。学生访问teacher-workbench始终403。均正常登录/注销独占测试Session，未动浏览器会话，无payload或凭据导出。[分配前拒绝](evidence/teacher-student-link-20261015/c-unassigned-denied.json)、[分配后允许](evidence/teacher-student-link-20261015/c-assigned-allowed.json)。未将“同课程其他活跃学生反例”写成通过，因为没有第二名启用学生；本轮用同一学生前后对照代替，不扩身份权限。

学生首页C课程列表实际出现该新任务；进入同分配深链仅GET时Attempt0，明确开始后唯一Attempt46f6dd83-1906-4b86-8dda-0bd4a1d8741d，刷新恢复同一ready/workspace0。教师列表亦可见该尝试的尚未提交/尚未开始状态。[C教师分配](evidence/teacher-student-link-20261015/c-teacher-assigned.png)、[C学生任务列表](evidence/teacher-student-link-20261015/c-student-task-list.png)、[C学生任务信息](evidence/teacher-student-link-20261015/c-student-entered-task.png)、[C教师尝试列表](evidence/teacher-student-link-20261015/c-teacher-sees-student.png)。

### 数据复核及运行异常

[最终联动账本](evidence/teacher-student-link-20261015/final-link-result.json)：两课均Assignment→Activity→唯一Attempt精确匹配，新Attempt各0文件/0 Job；旧账号/课程/成员/control/固定活动/分配/尝试/快照/源码/Job/Build/Session/Operation/教学消息及回执的原行逐字段保持，完整性ok、FK0、41表、pending Job0/未终止HDL0；新宿主model-http计数0。不能把本次任务接收验证称为代码运行/提交反馈闭环、真人学习或教学效果。

最后Windows健康检查出现连接拒绝；进一步实核首次新PID3652及执行VM均已退出，host-review.log只有此前ready行，无错误/退出原因。保留失败，不把一次ready当作持续可用；不凭此归因到其它会话。正在以明确隐藏Windows WSL保活（PID28884）和原VM start恢复相同身份，重新启动同一review宿主；不重跑迁移、验收或推进代际。恢复与最终页面回执后续追加。

## 最终运行与交付

原VM正常start后，C/HDL均ready=true、原受信代际96fc2f60、C指纹cb9e202c…/HDL29eb3ba3…保持，无重验/登记/节点升级。以Windows隐藏wsl子进程直接运行同一最新host-link.mjs（WindowsPID15272、LinuxPID464），另保活PID28884。key从既有本人User/Process环境只传该子进程WSLENV，未写key文件、argv或全局配置，教师模型保持关闭。之后多次独立工具/浏览器调用及末次健康均通过；不宣称跨Windows重启全天在线。

恢复后教师与学生正常刷新，原登录/课程/同一任务和尝试均保留；[恢复后只读检查](evidence/teacher-student-link-20261015/after-host-recovery.json)确认两课各原唯一Attempt、pending Job0/未终止HDL0、完整性ok/FK0、控制不变、model-http0。Windows严格TLS健康200；`/assets/index-BJIEyGZQ.js`1,413,233bytes，SHA256 e1bbcb9eefffc73f588a494c3a880a5e0a85d5f9ae634f74a38a608d10beffea，HTTP字节与9664ca5本轮构建逐字匹配。[最终运行回执](evidence/teacher-student-link-20261015/final-runtime.json)。本机备份、新旧脚本/源码/日志均保留；未自动回退或删除任何数据。

结论：本轮最新远程9664ca5的**C与HDL教师手工设计→真实检查与三角色预览→固定活动→明确分配→学生首页发现→同一分配工作区→显式唯一ready尝试→教师列表可见**均通过。已新增两项明确合成任务和各一个空ready尝试，保留给负责人复查；没有编辑学生代码、运行/模型Job、提交作品或发正式反馈，不把任务接收等同学习开始、完成或掌握。

旁路缺口：正常学生页仍显示“会话列表读取失败，请刷新后重试”。当前PAHER自定义宿主沿原配置未组合personalModels，独立聊天API不在本轮迁移/分配范围；没有为了消除提示擅自建个人四表、读写个人Key或伪造会话。教师分配/学生课程/工作区读写链未受该提示阻断；该提示和未执行的独立聊天/模型验证另记，不将本轮成功扩大到完整应用。

实际验证汇总：前端53文件647/647、正式build及后端类型检查通过；真实双端操作与严格HTTPS同课程未分配403→分配后200、学生教师角色拒绝403通过；迁移前后原结构/原35表全行不变、最终旧业务原行复核、刷新不重复Attempt、故障恢复后持久数据复核通过。未运行全量Playwright/正式AC-NFR/真人/教学效果验收，未跑回退故障分支。文档检查136文档/2048内链/errors=[]、空白检查通过；本次收尾后再核。任务全部留在附属独立工作树，原D盘脏checkout未覆盖/暂存/提交；无提交、推送、PR或公开发布。产品基线及MVP_SPEC §10如需汇总，待授权维护者汇总。

负责人后续要求“继续”后，最终收尾再次确认Windows隐藏宿主PID15272/WSL保活PID28884仍存活、严格TLS ready200；保留学生端实际C任务列表与教师工作台。首次最终截图保存时页面尚未完整绘制，已在实际内容绘制完成后重新保存[完整学生任务列表](evidence/teacher-student-link-20261015/final-student-task-list.png)，不将空白图作为成功证据。末次文档检查136文档/2050内链/errors=[]、差异空白和工具语法检查通过，任务与证据key/私钥形态扫描无命中；密文桥接引用已释放。本次联调范围完成，未追加模型/代码执行或修改其他模块处理旁路聊天提示。

## 推送授权与交付范围

2026-10-15，负责人明确要求“推送吧”。本次交付分支为 `codex/teacher-student-link-verification`，仅提交本任务记录及同名证据目录中的去敏收据、截图与限定验证工具。原 `D:/XunJie` 并行改动不纳入提交；此前“无提交、推送”的记录保留为当时状态。本次授权用于推送该任务分支，不包含合并主分支、生产部署或继续扩大数据库与模型联调范围。推送前复核文档内链、差异空白、工具语法和密钥形态；完成后核对远程分支与本地提交一致。
