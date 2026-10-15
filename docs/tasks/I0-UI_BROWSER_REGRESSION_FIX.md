# I0-UI：12项浏览器失败续查

日期：2026-10-15。负责人：Robert。实施：当前 Agent。状态：修复与失败项复验完成，待主线推送回执。

## 1. 授权、依据与范围

负责人当前明确要求“那12项非板卡测试失败也继续排查修好”。沿用隔离工作树，在 `codex/ui-browser-regression-fixes` 续作；起点为 `4417e34`（包含板卡修复和编辑器 PR #91），开工时与 `origin/main` 一致。已读 README、AGENTS、PRD §3.2/4/5/8、MVP_SPEC M-03～M-10及§4～6、TECH_DESIGN §7.3/7.4、I0_UI_SPEC Implementation/Testing Decisions、I0_UI_CLIENT_CONTRACT §2～6、TEAM_WORK_PLAN §2、DESIGN、IMPORT_SOURCE 导入边界。适用 PRD-03/04/09、M-03/04/05/09、AC-03/04/05/07/11；维持原消息展示/回执、版本、原文、幂等和恢复契约。

可写：`apps/student` 内与12项失败有关的实现、fixture及测试，本任务和必要证据。只读：产品/计划/参考基线、AGENTS、他人任务及共享主工作区。无新增依赖、schema迁移、模型调用或真实学生操作；不占用3444服务。既有合成测试使用独立端口，复现与修复均沿同一真实UI/HTTP/IndexedDB链。

## 2. 方案与验收

先复现原七个spec的12项失败：fileHistory 1、prepRestart 1、runResults 1、tutoringControls 1、tutoringHelpStop 2、tutoringMessages 2、tutoringReturn 4。以原断言建立反馈环，区分产品缺陷、测试时序及开发服务器缓存隔离问题；不删用例、不放宽产品判据迁就实现。修复后跑受影响专项、类型/单元/构建，必要时再跑完整浏览器套件。保留跳过和未执行边界。

## 3. 诊断、验证与交付

初轮七个spec共68项，51通过、17失败（10.3分钟）；除原问题外还暴露PR #91只读诊断POST被旧写请求统计误判、回执pending→confirmed与命令租约释放中的取样竞态。未删除断言或降低产品门槛。

单项复现命令：`npx playwright test tutoringControls.spec.ts --grep '已收到但未展示' --workers=1` 在当前基线退出1，收到已确认但展示未发生。真实DOM探针：正文top=517.67px，滚动容器bottom=511px，IntersectionObserver不相交；显式滚动正文后同一消息产生真实displayed，未手工写事实或回执。修正测试为滚动正文，保留未滚入/后台/收起不报displayed的反例。

文件快照回执先展示，后续权威GET才恢复编辑；测试等待冻结操作重新可用后再输入。写请求统计复用现有trackBusinessWrites，排除原已批准、无业务写入的editor-diagnostics。轮询测试等待实际累计读到62次（2初始+60自动）而不是假定每次虚拟时钟推进都已完成异步IDB/权限检查，继续精确验证预算、隐藏频率、断网和显式恢复。

第二轮19项专项17通过、2失败：重启零写统计仍起始过早；资料返回命令的临时lease尚在释放。第三轮单worker三次重复：模型失败/仍可保存3/3通过，重启和返回各3/3稳定失败。重启明确出现Monaco动态import失败，URL为主准备与重启服务共用的node_modules/.vite-prep缓存；先隔离各服务缓存，再验证。原命令测试须等待真实requestfailed以及租约释放后开始前后比较，不排除租约字段迁就断言。

一次并发复测与自管理服务所有者存在生命周期重叠，主动终止该复测并另起干净串行重复，不将其中结果记为有效验收。所有生产业务契约保持；当前写集额外包含Vite/Playwright开发测试缓存隔离配置。产品基线变更如有需要另列请求；待授权维护者汇总。

缓存隔离单独不足：第二、第三次热重启仍出现Monaco依赖文件404。首版把缓存放在node_modules外还触发React插件再次处理预优化JS，已改为`.playwright/node_modules/.vite-角色-端口`；继续读安装的Vite源码`isFileLoadingAllowed`/`safeModulePaths`并检查真实请求，发现依赖junction指向工作树外的已安装node_modules，冷优化分析临时授权的文件在热重启后未必可读。仅追加该已安装依赖目录的realpath到Vite fs.allow，保留原工作空间默认允许范围、strict及deny规则，没有开放整个D盘或共享仓库。固定端口和同一浏览器重启用例`--repeat-each=3 --workers=1`由此前1通过/2失败变为3/3通过（49秒），涵盖冷启动、复用缓存和实际换epoch。

当前基线类型检查、53文件644项单元、生产build和A0检查通过；此后发现远端main新增聊天交互及教师模型设置交付（当前9664ca5），将保留这些并行提交后重新运行最终检查，前述统计不冒充整合后验收。

## 4. main组合版本的继续复验

已将`origin/main@9664ca5`无冲突合入本分支（组合提交`91fb61a`），保留其聊天与教师设置交付。组合后类型检查、53文件647项单元、build通过。Chrome全量共259项，运行中；原12项独立端口复验首轮9通过/3失败，按现场继续修正，不计最终通过。

全量额外复现的同类问题仍在本任务内窄修：draftConflict/runHistory复用已批准的业务写统计，保留真正的sync/run/cancel零写判据；共享typeIn等待Monaco 0.57原生aria-autocomplete从只读none变回both，仍允许保存请求在途与暂停但可编辑时输入；snapshot排序测试等待路由回调收尾，避免上一用例在下一用例报错；双标签停止在请求送达服务前暂缓，而非等待服务已停止后还期待另一标签保留停止按钮。新聊天UI的Job标识已进入title，改为验证真实title的新Job与原Job不同且核对后不变，不用不再含ID的状态文案作空比较。

运行轮询的假时钟在发起运行之前冻结，等待两次初始GET和停止控件可用；visibility/offline/online变更后先推进50ms虚拟帧让React提交环境状态，再开始原9秒/10秒和断网断言，未增加真实延时或放宽60次自动读取预算。对并发压力下仍“正在加载代码编辑器”的失败保留记录，未延长原10秒编辑器断言；最终在无并发服务所有者冲突的串行环境复测。

以上新增写集仅包含相关e2e文件和本任务。最终失败项复测、证据与主线交付待补；真实服务/模型与教学效果仍不在本批fixture验收范围。

组合版本首轮全量实际结果为196通过、23失败、40跳过（259项，29.8分钟）；不将其记作全量通过。运行期间对失败补了同类harness修正，最终另起固定代码串行重跑：包含原12项及本轮全部23失败的并集。额外观察的代码无快照求助用例已单独原样通过；原10秒编辑器门限保留，慢加载失败也纳入复验。

新增接收点：代码回答来源/教学历史已按main交付默认折叠，测试用真实summary展开后验证；正常模式protocol对现有`/api/agent/conversations`明确给空列表，避免未知路由默认401错误地退出已登录账号；纯教师账号先验证转入教师工作台，再以无课程账号验证学生空态；课程读取失败定位自身alert，不受会话列表toast影响。没有删除用例、关闭检查或引入真实模型/执行服务。

## 5. 最终验证与证据

最终32项并集固定代码串行复验为27通过/5失败；继续修正后，这5项全部通过（30.9秒）。故原12项12/12通过，本轮全量新增23个失败23/23都有最终通过记录，并集32个不同用例32/32解决。逐项名称、原12项/全量失败归属、最终通过日志及最终源码SHA见[验收矩阵](evidence/browser-regression-20261015/validation.json)。不得将多轮复验写成一次259项全绿：原全量仍保留196/23/40，40项受控服务/VM专项缺显式运行时而跳过，未执行实际模型、执行节点或教学效果验收。

最后5项进一步校准：输入同时等待页面只读提示消失和Monaco实际可编辑，避免React与编辑器过渡时读取旧标志；假时钟对长断网/预算窗口使用fastForward触发到期定时器，避免逐帧播放与断言无关的动画耗尽60秒测试时限，9秒/10秒、离线零读、精确62次总数和60次自动读取上限均保留；在Job title已经换成B且B确已取消后才捕获比较基线；更换课程角色后重新加载受信Session再进学生首页；会话protocol对已认证账号的未知资源返回404，仍对未认证和专门延迟的旧bootstrap返回原401，未把旧401负例改成成功。

组合版本的53文件647项单元、类型检查和生产build通过；最后e2e修正后再跑类型检查通过。全部命令、先前失败、被主动中断的重叠复测和最终通过输出均存入[脱敏日志归档](evidence/browser-regression-20261015/logs.json.gz)（gzip JSON，附原始文件SHA；Cookie/Authorization/CSRF请求头值脱敏）。未关闭检查、延长原10秒编辑器断言、改变生产业务门禁、添加依赖或迁移数据。

沿同会话此前main合入及推送的交付授权持续完成本次遗留修复；代码只在本任务隔离工作树，正常推送且不使用force。主线包含原板卡修复、编辑器、聊天和教师设置并行交付。最终提交、远端回读及清理回执待追加；产品基线无变化，待授权维护者汇总。

复现环境：在`apps/student`执行，Node24.15.0，Playwright1.64.0与已安装Chrome；设置`XUNJIE_E2E_BROWSER_CHANNEL=chrome`、`CI=1`、`XUNJIE_E2E_PREP_PORT=5861`、`XUNJIE_E2E_REAL_PORT=5862`、`XUNJIE_E2E_RESTART_PORT=5863`。工程检查为`npm run typecheck`、`npm test`、`npm run build`；首轮全量为`npx playwright test --workers=2`；32项串行名称见矩阵。最终五项命令为`npx playwright test --grep '重置布局 实际生效|没有学生课程|运行轮询|取消请求失效|替换help和旧Job' --workers=1`。仓库根A0检查`node tools/a0-review/check.mjs`与原生`git diff --check`通过。

交付前远端main追加`1767d1c`/`d58e3a9`，仅他人任务文档、证据与手工工具，没有apps源码变化；按原授权保留这些并行提交。

临时文件边界：自动审批拒绝本任务临时日志/追踪的删除，工具仅返回`blocked by policy`。没有重试删除或改用其他删除通道；在逐个核对源/目的绝对路径均位于本工作树、无链接且无目标覆盖之后，43个本次文件/目录留存到被Git忽略的`apps/student/.playwright/regression-retained/`。版本库仅交付脱敏归档与验收矩阵。矩阵对12/23/32项归属及21个当前apps文件的SHA重新核验一致。
