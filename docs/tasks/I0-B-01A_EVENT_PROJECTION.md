# I0-B-01A：首次投递事件的原 Action 关联投影

记录日期：2026-10-14（Asia/Shanghai；授权来源为2026-10-13，实施/验证跨日）。状态：implemented-verified / pending-integration；普通构建在共享依赖软链环境失败，命令级保留软链解析构建通过，详见下方。主责：D-01 投影子任务 Agent；父票由主 Agent 统一整合。本记录是 [I0-B-01](I0-B-01_MESSAGES_RECEIPTS.md) 的实施补充，不新增第七张 ticket。

## 依据与授权

- 已读 [README](../../README.md)、[AGENTS](../../AGENTS.md) 的文档优先、授权对象、协作与验证边界。
- 已读 [PRD §5](../product/PRD.md#5-产品需求)，适用 PRD-04/09/10：同版本就地帮助、学生控制与授权隔离。
- 已读 [MVP_SPEC M-04/M-05](../product/MVP_SPEC.md#m-05-教学消息自然记录与覆盖说明)：就地对象、实际内容/来源/政策版本，生成、投递、展示与确认分别记账。
- 已读 [TECH_DESIGN §4.3/4.4](../product/TECH_DESIGN.md#43-公共身份版本与结果信封)、[§7.3](../product/TECH_DESIGN.md#73-投递与回执)：可信信封、角色投影、相关用途/阶段/epoch/对象守卫，不能机械比较所有 revision；保留已发生展示事实。
- 已读父票正文及主工作区 [I0-B_UI_TUTOR_PLAN §10.3](I0-B_UI_TUTOR_PLAN.md)。主工作区是本次授权来源，当前工作树中的旧版本不替代该新授权。
- Robert 最新明确授权：“如果是真的需要做的你就做”，并指定在 `codex/i0-b-projection`、基线 `cbb5824` 独立实施 D-01 的限定跨模块写集。§10.3 后段保存较新授权，前段“尚未批准”保留原提案时点。本次不把授权扩展到其他 backend、UI、受保护文档、依赖、schema、worker 或供应商调用。
- Robert 另明确允许本独立任务记录先落文档并随本地代码提交；父票、主 PLAN 和清单由主 Agent 整合，本 Agent 只读。

已核对实际接缝：`contracts/records/index.ts` 的 `TeachingEventPayload`；`server/records/application.ts` 的 `eventPayload/readPage`；`teaching.ts` 的持久读/正文校验、`teachingActionIsCurrent`、Delivery 与展示回执守卫；现有 C3 合成工厂和专项。

## 写集与方案

可写：

- `apps/teaching/contracts/records/index.ts`
- `apps/teaching/server/records/application.ts`
- 同目录新建 `apps/teaching/server/records/teaching-projection.test.ts`
- 本记录 `docs/tasks/I0-B-01A_EVENT_PROJECTION.md`

其余文件只读，包括主工作区全部文件、父票/PLAN、前端和 fixture、产品/计划/参考/规范、锁文件与配置。

方案：只在已有获准正文分支，从原持久 Action 投影 `scope/jobId/messageId/generation/targetVersions`。`basis` 只含 `attemptRevision/decisionEpoch/captureRevision/relatedStateRevision` 以及原本存在时的 `objectRef`；不透传 `inputRefs/assistanceRefs/coverageRefs`、lease、模型原 JSON 或调用信息。无正文分支保留原元字段，不增加关联身份。

不新增路由或存储。保持原 Session/成员/本人 Attempt、clientId/Delivery、代际、停止、相关 epoch/对象/状态守卫。当前已获准动作允许无关 capture/control revision 前进；投影保留原依据，而不是改贴当前版本。历史读取原 route 和展示事实不改变。

## 验收与检查入口

专项覆盖：首次投递无需 displayed 即可核对原关联；相同正文/同 hash 的不同 Job 不混绑；代码与原运行 ObjectRef 不合成；停止/旧 epoch/换代际/代码变化/同名新实例/错 client/跨用户不给旧 payload；无关 capture revision 前进不阻断合法正文；相关学习状态改变仍拒绝旧正文；已有显示历史不受改变，私有与内部字段不出现在事件投影。

原精确 Node/lock 依赖由主 Agent 准备，本 Agent 不安装。依赖就绪后入口（在 `apps/teaching`）：

```sh
node tools/check-runtime.mjs
node --test server/records/teaching-projection.test.ts
node --test server/records/teaching.test.ts server/records/teaching-review.test.ts
npm run typecheck
npm run build
```

开工时点：工作树为 `codex/i0-b-projection`，基线 HEAD `cbb5824`，无改动，教学 `node_modules` 尚未存在，检查未执行。随后主 Agent 在 WSL2 Ubuntu 用原 lock 完成依赖准备及原 bundled node-gyp 重建，并把本工作树 `node_modules` 软链到主依赖；本 Agent 没有安装或改 package/lock。此软链是本机依赖，不属于提交写集。

2026-10-14 实际执行环境：WSL2 Ubuntu，Node `v24.21.0`，npm `11.19.0`，原精确 TypeScript/SQLite 依赖。命令共同前置：

```sh
export PATH=/mnt/d/codex-tools/node-v24.21.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
cd /mnt/c/Users/h/.codex/worktrees/i0-b-projection/XunJie/apps/teaching
```

| 实际命令 | 结果与范围 |
| --- | --- |
| `npm run typecheck` | 退出0；原运行时检查及完整教学TypeScript无输出错误 |
| `node --test server/records/teaching-projection.test.ts server/records/teaching.test.ts server/records/teaching-review.test.ts` | 29/29通过，0失败/取消/跳过，17.262秒；其中新D-01投影9项、原C3回归20项 |
| `npm run build` | 退出1；未改的 `server/workspace/test-support.ts` 中 `command/submit/markReviewed/grantReopen/resumeRevision` 声明推导报TS2883，引用软链实际跨盘 `light-my-request/types/index.js` 路径。helper、package、lock和构建配置无差异；不把此命令记通过 |
| `npm run build -- --preserveSymlinks` | 退出0；仅命令参数保留当前工作树软链路径，证明构建声明错误来自共享依赖解析。本次不修改配置或只读helper；主整合环境需核对普通构建 |
| 根目录 `node tools/a0-review/check.mjs` | 最终73文档、1063内部引用，errors=[]；静态检查不算业务验收 |
| `git diff --check` | 通过 |

9项专项通过实际合成Session/授权HTTP与原C3 SQLite工厂：原代码range/snapshot绑定、相同正文不同Job/Message/Action及原Run、替换旧epoch、停止已succeeded作业、换代际、跨用户/教师元页、代码编辑/同名同正文新实例、原Delivery通道与已显示历史、原同事务related-state守卫、无关采集/提醒控制版本前进。错client指不能复用原Delivery；同一学生另一获准通道取得当前合法新Delivery的原语义未变。related-state专项使用原 `isTeachingBasisCurrent` 回调的合成反例，不宣称真实A4组合已验。

未执行：前端统一消费与浏览器整合、正常业务宿主/TLS/执行节点/模型/真人及完整M/AC/NFR。未调用供应商或运行worker，不写真实学习记录。

## 交付记录

实现位置：[公开类型](../../apps/teaching/contracts/records/index.ts)、[已有事件正文投影](../../apps/teaching/server/records/application.ts)、[9项投影专项](../../apps/teaching/server/records/teaching-projection.test.ts)。生产改动只补公开可投递body的原Action身份及basis精选，不改readPage/teachingActionIsCurrent/Delivery守卫、历史route、schema、依赖或权限。

本记录与上述代码同次本地提交，SHA由Git及交付回复提供。仅提交四文件限定写集；不推送、不创建PR。主Agent接收后统一整合父票/PLAN/清单，消费 `payload.scope/jobId/messageId/generation/targetVersions/basis`，没有正文的事件仍保持原元字段。主整合需在自身依赖布局复核普通build，不能用本次软链诊断参数覆盖原失败事实。受保护基线及MVP_SPEC§10：待授权维护者汇总。
