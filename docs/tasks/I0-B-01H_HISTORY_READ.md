# I0-B-01H：已有授权教学历史读取实施补充

开工日期：2026-10-13；验证及交付日期：2026-10-14（Asia/Shanghai）。这是[I0-B-01](I0-B-01_MESSAGES_RECEIPTS.md)的实施补充，不是第七张票。状态：prepared-verified / pending-real。主责：UI / Robert；独立实施 Agent，主 Agent 复查整合父票及清单。

## 依据、授权与基线

工作树 `codex/i0-b-history` 开始于 `cbb5824270c7216714b7cd1f0ec7c4deb8e15c8f`，跟踪和未跟踪差异为空。用户最新明确授权在此工作树实施 D02，消费已有公开 `GET /api/attempts/:id/teaching-records`，并授权本文；主仓库批次 PLAN §10.2 只读，所有其他文档和原消息浏览器 spec 由主 Agent 维护。

本会话已读：README、根 AGENTS、RTK；PRD §3.2/4.2/5/8（PRD-04/09/10）；MVP_SPEC M-04/05/09/10、§4、AC-02/04/06/07/12；TECH_DESIGN §4.1/4.3/4.4、§5/5.1、§6.1、§7.1～7.5、§9；父票01、03/04、本批SPEC/PLAN；I0_UI_SPEC与客户端约束§2/3/6、IMPORT_SOURCE来源/许可/选择性同步及TEAM§2/2.1。没有目录附加AGENTS。

源码依据：原[路由](../../apps/teaching/server/workspace/application.ts)、[C3组合](../../apps/teaching/server/records/application.ts)、[学生过滤及原正文校验](../../apps/teaching/server/records/teaching.ts)、[原类型](../../apps/teaching/contracts/records/index.ts)。学生投影返回本人问题与有 displayed 或 acknowledged 回执的 Action/模型正文；clientId不限制历史读取。正文、Action/messageId/jobId/hash、basis和targetVersions可权威关联历史；received-only/未shown模型正文不下发。bodyJsonText/resultHash/requestReceiptId有可选情形，不要求它们始终存在，也不把已shown的失效或旧代际历史当当前建议。

## 写集与方案

可写：本文；新增 `apps/student/src/workspace/tutoringHistory.ts` 与必要规则测试；`tutoringContracts.ts`、`tutoringStore.ts`、`tutoringWorkspace.ts`；原 `TutoringPane.tsx` 的最小只读历史槽；原 `prep/tutoring.ts`、`prep/plugin.ts` 扩展同一authority的已有公开响应；新增 `e2e/tutoringHistory.spec.ts`。其他共享src适配须先报告。服务端、依赖/lock/config/schema、受保护文档、主PLAN/父票及原 `tutoringMessages.spec.ts` 只读；不安装、不调用供应商、不用真实数据或发布。

历史只由本轮合法HTTP读取与完整验证产生可见状态；本机另存于既有metadata命名空间，缓存不作授权、不放行候选、不推进事件游标、不使用旧Delivery报新回执。失败清空本轮可见历史，换上下文及迟到结果拒绝。原事件正文缺Job/对象字段仍不绑定，不新增共享字段或读取路径。历史使用既有安全Markdown，仅展示原来源、帮助条件、状态和原回执事实，没有确认/运行/保存动作。

## 验证计划与未验

先执行窄typecheck及历史规则/相关状态机单测；实际Chrome专项使用独立端口5631/5632与现有Playwright配置，不和主5601/5621共用fixture。覆盖跨client只读shown历史且无新received/displayed/ack、失效shown保留、received-only不可取、shape/hash/scope和原关联反例、刷新缓存重新授权、拒绝及迟到上下文不泄露。

尚未执行以上检查，结果后续追加。正常业务host/B2-C3 HTTP宿主、TLS/节点、真实供应商/真人与完整AC/NFR未验；准备authority不替代它们。产品基线及MVP_SPEC §10待授权维护者汇总。本地提交仅本票写集；主Agent复查后cherry-pick，未推送/合并/发布。

## 2026-10-14 实际交付与检查

上节“尚未执行”为开工时点。已完成上述十文件写集，未增加其他共享src适配。历史校验按原scope、Action→Message/job/hash、原question对象/版本、body原文与可选原JSON、basis/targetVersions、Delivery及receipt关联核对；本人问题可以独立存在，缺问题不补造。未知usage、缺可选原字节/摘要/命令回执、receipt可选deliveryId及旧代际/旧政策/已失效历史保持原公开语义；没有虚构control、cutoff或当前许可。

历史在原对话正文中单独只读呈现，原问题/Job/Message/对象、帮助政策、epoch及原展示/明确回应事实可核对；本人已接纳问题在没有可回取回答时也独立呈现，不补造回答。不会在当前代码定位，没有“我先试试”或例子/运行/保存操作，没有IntersectionObserver或receipt调用。原事件消息仍不绑定D01尚缺的字段。每轮历史读取清空先前可见内容后重新GET；上下文/读取轮次及本机代际守卫核对后才保存独立metadata副本，失败不回退缓存。原客户端即时消息与历史各自保留来源，前者的展示事实不被历史读取替代。

准备authority复用实际显式help创建的原问题/Job/回执身份和原对象；实际events产生Delivery，实际receipt记录shown。新的GET仅按原学生投影过滤、读回原正文和关系，不分配Delivery、不推进Job、不造回执。dev-only原tutor-script增添`history-revised`合成反例（沿已有schema/路由），不是教师正式决定或新公共契约。

实际环境：Node v24.15.0，TypeScript 5.9.3，Vitest 3.2.7，Vite 7.3.6，Playwright 1.64.0，Google Chrome 155.0.8059.40。沿已批准依赖junction，没有安装、lock/config/schema变化。教学服务精确Node门禁与正常host未验，不由此环境结果替代。

在`apps/student`执行：

```powershell
rtk npm run typecheck
rtk npm test -- src/workspace/tutoringHistory.test.ts src/workspace/tutoringWorkspace.test.ts src/workspace/tutoringEvents.test.ts prep/contract.test.ts
$env:XUNJIE_E2E_PREP_PORT='5631'
$env:XUNJIE_E2E_REAL_PORT='5632'
$env:XUNJIE_E2E_BROWSER_CHANNEL='chrome'
$env:CI='1'
rtk npm run test:e2e -- e2e/tutoringHistory.spec.ts --workers=1
rtk npm run build
```

typecheck（浏览器与Node/e2e两套配置）退出0；最终相关规则/既有authority检查4文件43/43通过（历史26、原状态机3、事件2、prep契约12）；Chrome专项5/5通过，无skip/retry，35.2秒，独立5631/5632进程由Playwright启动/停止。验证新client合法读shown原文/原Job且Delivery与receipts完全不变，失效shown仍可读，received-only后停止不下发正文，实际authority响应shape/hash/scope/job/received反例拒绝，刷新缓存等待重新授权，退出后实际401清空历史。账号/上下文变动中的迟到读取、较新失败覆盖旧成功以及dispose清空另有规则反例。没有调用供应商或使用真实账号/学习数据。

首次typecheck发现校验器never箭头函数的控制流收窄问题，改为明确函数声明后通过；初次文件读取误用相对根导致路径错误，按工作目录纠正。一次多文件patch校验失败，未落任何部分改动，按实际import行重做。后续原JSON错误改为通用拒绝，新增反例确保错误不回显未校验原文，最终43项通过。构建退出0，保留既有大chunk警告；开发已有public品牌资产导入警告不在本票改动范围。未修改检查或使用skip掩盖失败。

最终补上独立原问题展示后，Chrome对received-only、非法响应及刷新/退出三项窄复核再次3/3通过，22.3秒，独立用例总数仍为5；命令为上述专项追加`-g 'received-only且停止|负例|刷新缓存'`，使用原npm避免RTK误解析管道正则。收尾一次误在仓库根执行typecheck报告Missing script，随后在`apps/student`正确重跑两套typecheck退出0。

新增源码：[历史校验](../../apps/student/src/workspace/tutoringHistory.ts)、[规则及生命周期反例](../../apps/student/src/workspace/tutoringHistory.test.ts)、[浏览器专项](../../apps/student/e2e/tutoringHistory.spec.ts)。其他七个文件见上方写集（含本文）；主PLAN、原父票、原消息spec、后端与受保护材料未改。正常B2/C3宿主、真实HTTPS/节点/模型、真人/教学效果和整票正式验收仍未通过。没有本次临时脚本或日志；ignored构建/浏览器结果保留作为可核查产物。只做本地工作分支提交，SHA由实际Git结果回交，主复查后cherry-pick整合。

仓库根`node tools/a0-review/check.mjs`：73份文档、1060条内链，errors=[]；`git diff --check`通过。静态结果不算业务/浏览器通过。提交前再次核查完整写集，包含本文，不提交构建产物或其他任务文件。
