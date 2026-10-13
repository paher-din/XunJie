# I0-B-06：帮助政策与三个独立控制

**What to build:** 学生查看固定帮助政策，并分别暂停/恢复尝试、暂停/恢复过程采集、开关里程碑提醒；每项以权威结果为准，功能数据例外、覆盖空窗、平台暂停和模型故障不阻断保存清楚可见。

**Blocked by:** 无代码前置；D-03已按追加授权交同事务limitedCheck投影和客户端守卫。实际节点、被动分析/提醒效果与真人的完整验收另列，保存和独立控制仍按各自原权限。

**Status:** implemented / engineering-verified（政策、三个独立控制、覆盖和D-03实时限定检查已接入并验证；分层结果见批次§11）。

2026-10-14较新收尾：[D-03](I0-B-06A_LIMITED_CHECK.md)同事务limitedCheck已交，不把active检查或固定helpPolicy单独当受限状态；未知/true均阻止按钮及Enter，发送前新GET再核，false仍须固定政策/阶段/分配许可。实际服务端6项覆盖受限/非受限、失联/取消未确认、阶段与直接HTTP拒绝；准备浏览器核旧页面发送前重读、unknown不放行、确实解除后显式求助。新轮询跨保存ACK中断的根因已在确认客户端修复，原四事务回滚/刷新恢复/退出/迟到断言保留并通过。最终22项控制规则、91项不同浏览器及失败过程见[批次§11](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)。后文D-03未完成为历史时点，真实提醒/被动分析/节点/真人及全AC未自动勾过。

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。依据：[规格](I0-B_UI_TUTOR_SPEC.md)、[计划/D-03/D-05/D-06](I0-B_UI_TUTOR_PLAN.md)。覆盖UI-TUTOR-08，M-04/M-05/相关M-03，AC-05/07/11/12/15、NFR-01/04/05/06。

## Acceptance criteria

- [ ] 固定活动公开helpPolicy/版本/说明在现有任务或消息槽可查；不显示“允许整份代做”，不把模型输出、设计设置或学生肖像当政策。
- [ ] 暂停尝试、过程采集与提醒分别展示，默认提醒关闭；一个开关不代替另两个，状态来自当前获准Attempt/control投影。
- [ ] 每个明确设值/恢复动作先重读权威attemptRevision/generation、冻结原命令，回执后重读；网络失败/版本冲突/旧代际保留原状态与未知，不猜revision或换键重做。
- [ ] 重复设值/原键重放不产生额外通用epoch/覆盖区间；不因GET、显示开关或模型建议激活学习、解除教师暂停或复活旧Job。
- [ ] 尝试/分配暂停优先规则准确：已有active文件update与获准保存保留，新文件/回收/恢复/新运行/新帮助受阻；学生恢复不能绕过平台暂停。
- [ ] 关闭采集后停止逐次过程上传/被动分析，显式保存的必要作品与功能数据例外清楚说明；覆盖interval/缺口有来源，恢复只采后续，不补发暂停期事件或改captureRevision追认旧队列。
- [ ] 关闭提醒不关闭主动求助许可，已取消提醒不能因再开启复活；主动求助的实际发送/消息浏览器组合由02验证，本票独立验控制结果/用途许可与已有保存行为，不依赖02组件才能开工。
- [ ] 限定检查的实时状态由D-03落实的公开依据提供；静态helpPolicy不足时不猜。遇到服务端拒绝准确展示，按钮禁用不作为服务端授权已验证。
- [ ] 模型/预算/依赖故障不阻断获准确认保存，原作品/草稿保护不被控制/设置清理影响；功能数据仍保存不能表述成“所有数据停止”。
- [ ] 控制可键盘完成，采集/提醒同值与迟到回执、跨标签/代际/账号、教师暂停和旧过程拒收有浏览器请求/存储事实。
- [ ] typecheck、相关Vitest/build/本票浏览器专项有实际结果；政策语义、真实记录/模型和全AC/NFR不由准备开关通过代替。
- [ ] D-03未交清时将限定检查实时提示保留未完成，不通过改服务端契约或fixture补字段把整票标通过。

## Testing Decisions

主接缝为现有工作区控制操作→原controls/GETAttempt或事件control→可见状态及原保存链。复用已有暂停保存/旧代际/原键测试，使用有来源合成场景验证功能数据与覆盖空窗。服务端取消/后台不采集的证明由C现有实际集成承担，准备authority行为只验证前端消费。

本票独立交付开关及保存边界，02用预置控制状态验证求助许可；两票交付后补最小实际开关→显式求助组合，不重跑无关完整套件。

## 交付与未完成

写集按计划06，前端不改捕获协议、帮助政策模型或服务端控制状态。2026-10-13的独立实现与验证见下方记录；D-03、D-05实际主接线/浏览器与完整覆盖读取尚未完成。D-06继续权威重读，基线差异为待授权维护者汇总。

## 2026-10-13 独立实现与主接线交接

Robert授权本批六票并行开发，06执行Agent在独立工作树与`codex/i0-b-06-controls`分支只交付本票模块、测试和记录，不推送。已读仓库README/AGENTS、PRD§3/4.2/8、MVP_SPEC M-03/04/05及§4/5/6、TECH_DESIGN§4.3/5/5.1/7.1/7.2.1/7.3/7.4，I0_UI_SPEC与客户端约束正文、IMPORT_SOURCE、本批SPEC/PLAN与本票正文；控制wire与实际语义回源`server/workspace/inputs.ts`、`controls.ts`、`commands.ts`、`application.ts`、`server/records/jobs.ts`、`commands.ts`。适用PRD-09、M-03/04/05、AC-05/07/11/12/15及NFR-01/04/05/06，原判据不降低。

写集限定下表五份新增源码/测试与本记录。主Agent独占PrepWorkspacePage、prep/plugin/workspace、公共http/storage；apps/teaching、产品/排程/参考/规范、package/lock/Vite/DB_VERSION/store/index/.env/CI均只读。未安装依赖，沿用主仓既有依赖的工作树junction；未修改旧原命令或创建另一服务器/authority/回放账本。

| 文件 | 实际交付 |
| --- | --- |
| [控制模块](../../apps/student/src/workspace/tutoringControls.ts) | 固定政策说明；四种原wire操作；权威Attempt/Assignment读取、冻结/落盘/原HTTP/回执核验/重读；独立metadata namespace的原命令及标签发送租约，不混入旧保存outbox |
| [控制组件](../../apps/student/src/components/workspace/TutoringControls.tsx) | 既有任务/消息槽中的固定政策、暂停/恢复尝试、采集与提醒；键盘原生按钮/switch、未知/拒绝/重读/原键核对；不建立页面、模型调用或采集队列 |
| [同authority fixture扩展](../../apps/student/prep/tutoringControls.ts) | 严格解析本票四种控制；按原控制规则计算版本与用途取消；调用主提供的prepTeachingCommand，使用原head/回执/代际/原键重放 |
| [规则反例](../../apps/student/src/workspace/tutoringControls.test.ts) | 15项：落盘顺序、存储失败零发送、缺代际、丢ACK原键、CAS拒绝、教师暂停、迟到旧账号、旧代际不重放、错回执、确认后读失败、命名空间、同值/独立epoch、暂停用途、严格wire、内部摘要与Job终态 |
| [浏览器专项](../../apps/student/e2e/tutoringControls.spec.ts) | 6项已编写未执行：默认提醒/键盘、不激活ready、采集与保存/旧过程拒收、尝试暂停保留保存、丢ACK刷新原键重放、教师暂停公开投影、服务拒绝仍保存；后两类响应注入只证明UI消费，不替代服务授权证明 |

原命令记录放在v2既有`metadata`的`tutor-controls:`命名空间，按mode/account/course/Assignment/activity/Attempt/scenario隔离，原记录保留受信generation/preparationEpoch；loadEpoch只作当前页面守卫，不改变刷新后的业务身份。原JSON与键先完成事务再发送，CSRF仍由原HTTP层在发送时内存取得。未知只允许明确原键核对，不自动排队、改revision、换键重做或给旧队列贴新代际；控制存储失败不接触草稿与保存outbox。

每次操作重读权威Attempt与分配；本次控制ACK不直接翻开关，而是核actor/scope/target/key/generation/hash/result后重读。旧响应不能覆盖失效页面；另一标签发送由metadata事务租约协调。确认后的读失败保留已确认事实；控制或模型故障不清理草稿、不禁用原获准保存。固定政策不推断限定检查，三控制不互相代替；相同设值不增通用epoch或采集代际，采集/提醒不激活ready，教师暂停优先。

### 主Agent接线步骤

组件导出`TutoringControls`及`TutoringControlsProps`：`confirmation: ConfirmationWorkspace | null`、`activity: ActivityView`、`assignment: AssignmentView`，可选`onAssignmentChange: (assignment: AssignmentView) => void`。主页面放入现有taskInfo/消息槽；使用回调中重读的权威分配更新现有文件/保存/新建/运行/求助守卫，不能持续用旧init.assignment.active。原ConfirmationWorkspace的权威head更新会触发控制重读，跨标签控制广播只通知重读，不发送命令或广播政策正文。

fixture导出`createPrepControlHandler(ports)`，返回`(scenario, session, attemptId, value, key) => Receipt`。ports为主同authority的`prepTeachingCommand`、`assignmentActive(scenario, session, attemptId): boolean`及`stopTeaching(scenario, attemptId, purposes): string[]`。stopTeaching接主已有教学Job/未展示Action的用途取消，保留已生成/已展示/原终态；未接该回调不能把教学取消标通过。插件接原`POST /api/attempts/:id/controls`，保留session/Origin/CSRF/错误信封与故障注入；不得把开发脚本的直接status设置冒充控制。

HTTP正文仍为`{recoveryGeneration, expectedAttemptRevision, control}`；内部handler传给共享helper的摘要对象为`{recoveryGeneration, expectedRevision, control}`，共享helper去generation后的canonical摘要与真实controlCommand一致。这一转换仅在fixture内部，不增加公共字段。主共享helper返回真实`replayed: true/false`（原键命中/首次完成分别返回），与现有控制HTTP实际投影一致；当前主未提交helper早期正文尚不返回该标记，主接线须补齐，本模块不伪造重放事实。

当前教学事件分页已有公共coverage来源，完整采集区间详情由主组合时消费该页，沿用原事件客户端/控制来源，不增加endpoint或用客户端时间补造区间。本组件目前仅展示服务已读collecting状态、功能数据例外及恢复不回填规则，并明确详情未回取；尚未把完整覆盖读取标验收通过。

### 实际检查与限制

2026-10-13，在学生目录沿用现有Node v24.15.0运行`rtk npm run typecheck`（src及node配置）退出码0；`rtk npm test -- tutoringControls`为1文件/15项通过、零失败。`rtk npm run build`退出码0（Vite既有大chunk提示保留，不改构建配置）；该构建在最后的确认客户端订阅适配前执行，末次适配另完成typecheck与15项专项，不把尚未挂主页面的模块计成浏览器接线证明。

未运行Playwright、真实教学HTTP/数据库/节点、供应商或真人。六项浏览器专项统一交主Agent组合接线后执行；当前脚本的教师暂停投影和拒绝信封注入不代表真实教师权限/控制传播已验证。限定检查D-03仍未完成；覆盖详情、真实活动/分配暂停传播、后台被动分析取消/不回填、实际提醒与02求助组合、跨标签/账号/换代浏览器事实与全AC/NFR均未计通过。产品基线及MVP_SPEC§10为“待授权维护者汇总”。本地提交仅本票六文件，Git实际SHA由提交后的交接报告给出；未推送、合并或发布。

2026-10-13，末次源码适配后typecheck与15项专项再次退出码0；仓库根`node tools/a0-review/check.mjs`为72份文档/1005条内链/errors=[]，`git diff --check`退出码0。提交前复查只暂存本票六文件，不夹带主Agent未提交接缝、依赖junction或构建产物。

## 2026-10-13 主页面组合结果

独立`43ee0c2`已以`da443af`整合。主在现有任务信息槽接三个控制、固定政策、权威分配回读和已有作品守卫，原authority handler返回正确replayed/摘要并取消未展示教学动作。原事件页coverage经同一教学客户端校验归属/控制版本后展示，空窗不按浏览器时钟补造。所有源码/handler仅准备/客户端范围，真实后台事实不由fixture证明。

[控制浏览器](../../apps/student/e2e/tutoringControls.spec.ts)7项通过：键盘/ready不激活、采集暂停仍确认保存/旧过程拒收、尝试暂停允许已有文件保存及独立恢复、丢ACK刷新沿原键、教师暂停公开投影、明确服务拒绝仍保存、实际关闭采集/提醒后仍主动求助。最后这项与02实际组件组合，覆盖区间读取含真实HTTP来源的合成空窗。教师暂停/拒绝为明确注入反例，不宣称真实教师授权已验。

15项规则及[build/typecheck/全批组合](I0-B_UI_TUTOR_PLAN.md#92-验证失败修复与证据分层)通过。D-03限定检查当前公开状态、真实后台采集/提醒取消、全部跨账号/代际真实控制与整票AC/NFR仍未完成；不把禁用按钮当服务端安全边界，产品基线及MVP_SPEC§10“待授权维护者汇总”。
