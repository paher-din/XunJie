# I0-UI：12项浏览器失败续查

日期：2026-10-15。负责人：Robert。实施：当前 Agent。状态：诊断中。

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
