# I0-B-01：教学消息、游标补取与三类回执

**What to build:** 学生在现有工作区对话容器收到一条获准完整教学内容，查看主要下一步并明确回应；收到、可见展示和明确回应分别记账。断线补取及重复投递不重复呈现，缺项与历史不可回取准确表达。

**Blocked by:** 当前代码前置已满足：D-01原关联投影与D-02已有授权历史接线已交，原生后台专项已补验。受控部署、模型与真人的完整验收条件另列，不把准备或隔离服务通过计作全AC。

**Status:** implemented / engineering-verified（准备、授权历史、原生后台及实际HTTPS合成服务已验证；完整受控真实验收分列）。

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。依据：[本批规格](I0-B_UI_TUTOR_SPEC.md)、[计划/写集/缺口](I0-B_UI_TUTOR_PLAN.md)。覆盖 UI-TUTOR-04/05，M-05/相关 M-09，AC-06/07/12、NFR-04/05；对象版本部分须连同03/04验收，不能称整项通过。

## Acceptance criteria

- [ ] 复用实际工作区对话/消息容器和安全 Markdown 呈现；可辨合成与真实来源，主要下一步、帮助条件和未知按公开字段显示，不补结构化卡片、私有来源标题或内部思维链。
- [ ] 只消费通过检查的完整正文，不演 token、SSE、排队位置或假思考；payload 缺正文/类型非法/hash 不匹配保留不可用，不发 displayed。
- [ ] 使用已有事件 JSON 页；先同步 control/generation/epoch，resyncRequired 时不展示正文。分页 hasMore、游标、无连续 serverSeq 和读轮次守卫正确，旧页不更新当前状态。
- [ ] 按 actionId/contentHash 去重，事件重复/多页/React 重渲染只显示一次；相同身份不同正文不得按到达顺序静默覆盖。
- [ ] 收到且核验指定版本后产生 received；正文渲染完成、页面和该消息区域实际可见后才产生 displayed；隐藏页、收起面板和未滚入可见区域不报展示。
- [ ] acknowledged 只由学生明确确认/回应；渲染、复制、聚焦不产生确认，不将“我先试试”解释为采纳或掌握，不连发新回答。
- [ ] 回执保留原 action/hash/clientReceiptId/幂等键，丢 ACK 后核或重发原命令，重复不新增事实；业务回执形状按各端点解包，不复用错误的 data.result 假设。
- [ ] 事件正文/身份、待回执事实与持久游标一致保存；中断/存储失败后不会越过未保存内容。刷新恢复原客户端的已回取历史与原回执，不能把缓存当当前授权或服务有效性。
- [ ] 教学clientId在原标签刷新时保持，其他标签保持独立通道；游标与原通道绑定，存储丢失/新通道不复用旧游标跳过未取得Delivery。覆盖刷新/新标签/丢本机状态，不捏造跨设备历史。
- [ ] 账号/Attempt/模式/代际切换隔离内容和回执；旧响应及跨客户端 Delivery 不被当前页面消费。重连先同步控制，已失效内容不复活。
- [ ] D-01/D-02 缺口有真实响应反例：不猜对象绑定，不在代码定位，不补另一客户端或失效历史正文；此范围未交接时明确列未完成，不勾完整历史回取通过。
- [ ] typecheck、相关 Vitest、build 和本票真实浏览器检查通过，实际请求/可见状态/存储/失败事实可回放；无供应商请求、不写真实学习记录。

## Testing Decisions

主接缝为现有工作区→同一 HTTP 客户端→既有准备 authority→消息区域及实际回执。准备样例只使用无代码/运行定位的项目支持内容，字段完全来自 C3 当前公开页。复用现有刷新、多标签与传输故障方法，测试隐藏/收起/滚动、StrictMode、重复页、存储中断和迟到。

不得以直接调用回执函数代替 displayed 浏览器证据，不用给 fixture 加 jobId/ObjectRef 来“证明”真实公开关联。范围之外的历史能力保持 D-02 待交接。

## 交付与未完成

写集按批次计划01，服务端/基线/依赖/schema只读。实现后记录固定commit、实际文件、命令/版本、准备/真实/失败/未执行，保留原I0-A作品边界。当前规划已定稿；真实宿主/身份、公共历史能力和本票所有应用验证未执行。

## 2026-10-13 主整合结果

上述为规划交付时点。后续Robert授权实施，主Agent在原UI分支接入[状态机](../../apps/student/src/workspace/tutoringWorkspace.ts)、[事件](../../apps/student/src/workspace/tutoringEvents.ts)、[metadata journal](../../apps/student/src/workspace/tutoringStore.ts)和[原对话槽](../../apps/student/src/components/workspace/TutoringPane.tsx)。完整正文/hash、分页控制、收到/展示/明确回应、原回执核对、缓存历史与新通道缺项均在同一authority验证，不演token或补Job/对象关联。

[消息浏览器检查](../../apps/student/e2e/tutoringMessages.spec.ts)累计8项通过，包含实际收起/滚动、刷新、另一标签、复制sessionStorage的通道、丢ACK及已观察displayed迟到后停止；最后一项为明确的可见性注入反例。原生后台标签实测未产生hidden条件，失败已在[批次记录](I0-B_UI_TUTOR_PLAN.md#92-验证失败修复与证据分层)保存，不能计原生后台通过。3项纯内存交错规则与实际迟到页/新暂停反例通过。

正式build/typecheck、320项全量规则及77项不同浏览器检查的分层/重复计数见批次记录。D-01/02、真实宿主和原生后台环境补验仍未完成；本票完整AC不因准备交付勾成通过。受保护基线与MVP_SPEC§10“待授权维护者汇总”。

## 2026-10-14 补齐与收尾

上述未完成为旧时点。D-01首次投递原关联已按追加授权交付，并严格核原scope/Job/Message/代际/版本/basis，不猜最近Job；[D-02](I0-B-01H_HISTORY_READ.md)消费已有公开授权历史，另一client只读shown记录，不生成新Delivery/三类回执，失败清可见缓存。原生native hidden→visible1项通过，受控可见性反例另列。

[实际HTTPS专项](../../apps/student/e2e/tutoringService.spec.ts)正常dist/Session/CSRF/SQLite/原worker验证双求助、原对象/回执、跨标签只读历史；offline合成provider与测试自签名TLS明确。最终33文件456项规则、类型/build及91项不同浏览器检查的精确范围/失败修复见[批次§11](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)。本票代码与已授权工程检查完成；受控节点、真实模型/真人及全AC不自动勾过，基线待授权维护者汇总。

## 2026-10-14 逐项审查后的消息专项补齐

负责人明确授权消息补齐 Agent 复用原干净工作树，在 `codex/i0-b-closeout-messages`、基线 `cc72891` 实施；开工 Git 无差异。可写仅本文件、学生 `e2e/tutoringMessages.spec.ts`，以及确实必要的 `src/workspace/tutoringStore.ts`。主 Agent 独占状态机、消息组件、工作区页面及 helpStop/controls 检查；本 Agent 不修改这些文件、共享 authority、产品/规划/参考/规范、依赖/锁文件/配置/schema，不建分支或工作树，不推送。

已按 README 入口读当前 AGENTS；PRD §3.2/4.2/8（PRD-04/09/10）；MVP M-03/04/05/09/10、AC-04/05/06/07/12；TECH §3.3/4.1/5.1/6.1/7.3/7.4；本批 PLAN §10.3/11/12、SPEC 实现/验证/范围正文、01 全票，以及本会话已核的 I0-A 客户端约束与来源边界。当前验证接缝由负责人具体授权：原工作区 UI→同一准备 HTTP authority→真实 IndexedDB/刷新→公开回执与历史；允许对浏览器存储事务和网络传输注入明确故障，不用内部 fact() 调用冒充可见展示，不增加 fixture 成功字段或第二后台。

范围内验收目标：真实教学 journal 事务中断时正文/身份/待回执与游标一起回滚，刷新重新回取；help 落盘失败零 POST；received/displayed/acknowledged 丢 ACK 后原键/原文重发且服务事实去重；展开 visible 面板中消息未滚入区域零 displayed；同 Action 内容冲突保留旧文；既有公开页的正向多页与 resync 重取；只丢教学本机 ledger 后新通道从零补取、授权历史不伪报新回执。先写行为反例再按失败证据修根因；若必须改主文件，回交具体最小建议，不越写集。

执行计划：复用既有 node_modules junction，不安装依赖。使用 CI 新启动的 Chrome、独立端口 5661/5662，仅跑消息 spec；失败后仅复验受影响项，收尾跑本票专项及类型/差异/文档静态检查。准备、浏览器、实际服务、模型和真人证据分别报告；结果尚未执行，不预记通过。产品基线及 MVP_SPEC §10 待授权维护者汇总。

### 本次实现与直接证据

上述“尚未执行”为开工时点。消息浏览器 spec 新增10项，仍走原可交互 authority、真实 DOM/IndexedDB 和公开请求，不调用私有状态机方法。

| 对应本票判据 | 本次直接检查 |
| --- | --- |
| AC3：多页/控制重同步 | 向原事件入口转发合法 `limit=1`；一次转发旧 epoch 让原 authority 实际返回 `resyncRequired`，然后按当前 control 从零取得三页。核有序游标、非连续 serverSeq、hasMore 与去重；不自造分页/control/正文成功字段 |
| AC4：同Action冲突 | 对原网络页明确注入同 Action 的另一正文及其合法摘要，其他原关联保留；校验冲突原因、原正文/原回执不变、零新回执。该负例只证明拒绝矛盾传输，不当作 authority 成功生成 |
| AC5：未滚入区域 | 学生明确发送较长合成问题，让真实回答位于原滚动区域之外；核页面 visible、面板展开和实际几何，跨一个真实轮询保持零 displayed；实际滚入后才有一个 displayed，无 acknowledged |
| AC7：三类回执丢ACK | received/displayed/acknowledged 各一项：原 authority 先提交、传输再丢ACK；本机 pending 保留原 clientReceiptId/键/原文，重读沿原请求确认；公开历史回执对象完全不变，刷新不新增服务事实 |
| AC8：页事务中断 | 只在教学 ledger 的原生 IDB put success 后、transaction complete 前 abort；核正文/游标/待received一起回滚、零回执，刷新回取原 Action/hash/Delivery，原 help 仍仅一次。不是内存 mock 或原作品 ACK 事务替代 |
| 相关02 AC2：help落盘失败 | 对原教学命令 put 的原生事务 abort；输入问题仍可见，持久 commands 无待发问题、实际 help POST=0；刷新不补发失败意图 |
| AC9：本机ledger丢失 | 已shown与received-only各一项：只丢当前合成 ledger，保留 Session/确认作品/sessionStorage；刷新使用新client从零读。已shown只读获准历史、零新help/回执；未shown原Action在当前合法新通道取得新Delivery/received，不冒用旧通道身份 |

根因修复只在 [tutoringStore](../../apps/student/src/workspace/tutoringStore.ts)：sessionStorage 身份必须有同 scope/key/clientId 的持久 ledger 才延续；不存在时新建通道，真实 IDB 读取失败仍向上报告不可用，不用新通道规避失败。保留原 Web Locks、复制标签独立通道与正常刷新延续语义；未改 schema、旧记录、主状态机/组件/页面或 fixture。

### 实际执行、失败与范围

环境：Node v24.15.0、原 TypeScript/Vite/Playwright 依赖、已安装 Chrome channel、原 node_modules junction。每轮均 `CI=1`，准备/真实开发端口5661/5662；没有安装依赖、改配置或使用模型/节点。学生目录执行：

```powershell
$env:CI='1'
$env:XUNJIE_E2E_BROWSER_CHANNEL='chrome'
$env:XUNJIE_E2E_PREP_PORT='5661'
$env:XUNJIE_E2E_REAL_PORT='5662'
rtk npm run test:e2e -- tutoringMessages.spec.ts --workers=1
```

新通道反例先在原代码实际失败（刷新仍用旧client）；Store修复后通过。一次检查在新 ledger 已落盘但首次 events 请求尚未出现时提前断言，已改为等待实际请求，不降低新通道/零游标判据。新增类型引用曾将浏览器声明链引入 Node 侧检查，改为本 spec 的观察投影类型后，两套 typecheck 退出0。两项事务专项初次未能载入页面，trace为依赖预优化chunk的504 Outdated Optimize Dep；未改配置/依赖/超时，原两项窄复验2/2通过（13.3秒）。正向多页/冲突2/2通过（20.1秒），三类丢ACK/未滚入区域4/4通过（31.1秒）。

完整消息专项19项实际为17通过/2失败/零skip（1.8分钟）：received丢ACK用例未取得可见展示，原生后台用例在开始时worker异常退出（code=3221226505，未执行判据）。回执恢复专项现先实际滚入消息，保留原正文/幂等/回执全部断言；原生专项原判据未改。以原npm（RTK不能干净代理含`|`的筛选）执行 `npm run test:e2e -- tutoringMessages.spec.ts -g 'received回执丢ACK|原生后台' --workers=1`，2/2通过、20.8秒（native实际hidden/visible9.1秒）；其余两种回执也按同一新增滚动操作窄复验，结果收尾追加。不同用例共19项，不把重复运行累加，不写成一次19/19全量通过。

本次专项是准备/浏览器工程验证，实际HTTPS服务、其他tutoring specs、全量规则/build、实际模型/运行节点/真人均未重跑；主Agent在其原分支另记组合证据。本次授权要求未发现需改主文件的实现缺口，不请求 fixture 扩展。产品基线/MVP_SPEC §10待授权维护者汇总。提交仅上述三个文件；主整合后复核其当前状态机/组件及新dev提醒样例的兼容，不将此独立分支结果提前写成已合入。

收尾结果：`npm run test:e2e -- tutoringMessages.spec.ts -g 'displayed回执丢ACK|acknowledged回执丢ACK' --workers=1` 为2/2通过、16.8秒，零skip/retry；最终19个不同消息用例已有通过证据（新增10、原9），受影响检查均已复验，不累计重复执行。`rtk npm run typecheck`两套配置退出0，`git diff --check`通过；根`node tools/a0-review/check.mjs`检查77份文档/1141条内链，errors=[]、退出0。没有需要保留的临时脚本/日志或额外源文件，只保留现有harness生成的ignored结果；未执行的整合/完整系统验收继续由主记录。
