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
