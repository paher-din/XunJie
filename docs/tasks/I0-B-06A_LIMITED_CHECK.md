# I0-B-06A：限定检查公开状态实施补充

日期：2026-10-14（Asia/Shanghai）；2026-10-13的审计/授权事实保留来源时点。执行角色：UI / D-03实施Agent。状态：`isolated-verified / pending-main-integration`。本文是[I0-B-06父票](I0-B-06_POLICY_CONTROLS.md)的窄实施记录，不是第七张ticket；主Agent统一整合[批次计划](I0-B_UI_TUTOR_PLAN.md)和[完整清单](https://github.com/paher-din/XunJie/blob/33a68baba5005c9a6433ed2bf9c99f01d89345b6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md)。

## 依据与授权

本次从README/AGENTS进入，已按PRD → MVP_SPEC → TECH_DESIGN阅读相关正文，并在同一`cbb5824`源码基线完成D-03只读审计。相关已读正文：

| 依据 | 已读章节与适用编号 |
| --- | --- |
| [PRD](../product/PRD.md) | §3.2、§4.2、§5、§8；PRD-04/09/10，学生控制、课程帮助政策、故障与证据边界 |
| [MVP_SPEC](../product/MVP_SPEC.md) | M-03/04/05/07、§4/5/6；AC-06/11/12/15，NFR-01/04/05，限定帮助与原保存边界 |
| [TECH_DESIGN](../product/TECH_DESIGN.md) | §4.3/4.4、§5/5.1、§6.1、§7.1/7.2.1/7.3、§8.3；角色投影、同事务限制、失联不解除、实际回执及服务端守卫 |
| [I0_UI_SPEC](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md)、[导入来源](../../apps/student/IMPORT_SOURCE.md) | 有来源公开读取、原确认客户端/上下文/读取轮次、隔离准备与真实服务的区分、原UI来源 |
| [父票06](I0-B-06_POLICY_CONTROLS.md)、[本批SPEC](I0-B_UI_TUTOR_SPEC.md)、[本批PLAN](I0-B_UI_TUTOR_PLAN.md) | 06全部验收正文，SPEC政策/独立控制边界，PLAN D-03及§10.3的必要跨模块方案 |

2026-10-13，主工作区PLAN §10.3较新记录载明Robert对具体方案表示“你自己看吧。如果是真的需要做的你就做”。本会话随后明确指定D-03实施工作树、文件范围、最小字段和反例；最新指令另授权本文独立实施记录并要求先记录再实现。按该明确授权实施，不把旧“尚未批准”历史状态作为新的阻塞，也不扩大到其他受保护对象。

工作树`codex/i0-b-limited-check`从`cbb5824270c7216714b7cd1f0ec7c4deb8e15c8f`开始。初始Git工作区干净。主PLAN/父票只读；不改产品/规划/参考/AGENTS，不安装依赖、不改配置/lock/schema/凭据、不连接供应商或执行节点。

## 负责模块、写集与方案

| 可写对象 | 限定变更 |
| --- | --- |
| [教学工作区读取](../../apps/teaching/server/workspace/application.ts) | 在原GET Attempt获准事务内，从固定`checkRule.limitedHelp`及持久`checks.state === active`计算根级`limitedCheck:boolean`；原鉴权和帮助拒绝不变 |
| `apps/teaching/server/workspace/limited-check.test.ts`及必要公开type | 受限/非受限active、无检查、执行失联、取消未确认、权威ended、paused可读及跨学生拒绝的原HTTP/SQLite隔离反例 |
| [客户端公开类型](../../apps/student/src/workspace/workspaceContracts.ts) | 记录GET Attempt新增字段，兼容缺字段响应，缺失不得视为false |
| [独立控制模块](../../apps/student/src/workspace/tutoringControls.ts)及同名规则测试 | 直接消费已授权head布尔字段；未知/读取失败/旧上下文不能宣称解除限制；不推断raw active或固定policy |
| [原控制槽](../../apps/student/src/components/workspace/TutoringControls.tsx) | 展示当前受限/不受限/未知；false仍须独立核对政策、阶段及分配；按原公共读取更新，不改变三个控制语义 |
| 本文 | 实际检查、失败/未验、适配交接与本地提交 |

其他代码只读。尤其不写`prep/workspace`、`prep/tutoring`、`prep/plugin`、`tutoringContracts`、`tutoringWorkspace`、Pane/History及主页面；准备fixture、发送禁用及发送前守卫由主Agent统一组合。本票给出确切适配接口，不提交模拟数据为真实记录。

字段含义严格为`limitedCheck = fixedActivity.checkRule.limitedHelp && persistentChecks.some(check => check.state === 'active')`。`false`不表示总帮助许可。取消ACK、Job终态、deadline、到达顺序或新代际不替代持久`ended`；执行结果仍未知时保留原检查限制。GET不激活尝试、不排作业或模型；原帮助入口/上下文/完成/投递守卫不放宽。

## 验证计划与当前事实

学生依赖已由主Agent以junction提供，沿用原lock；可运行本票窄Vitest/typecheck。开始时教学依赖缺失；2026-10-14主Agent回交WSL2 Ubuntu、精确Node24.21.0、原lock安装和原node-gyp SQLite重建成功，并以Linux软链向本工作树提供依赖。本Agent不安装或绕过教学版本门禁。检查后在此补实际命令、版本、通过/失败/未执行。

必要检查：公开响应同源状态与静态规则组合；未知字段不回落false；确认结束同Attempt版本仍能重新读出false；失联/取消未确认保持true；paused读取仍返回检查状态且不解除暂停；跨学生拒绝；原服务端禁用帮助拒绝不被新字段绕过。学生规则证明客户端消费，实际教学HTTP/SQLite检查证明服务公开投影，两者均不代替真实执行节点、正常TLS浏览器、实际模型、真人或整体AC/NFR验收。

## 2026-10-14 实现、实际检查与交接

实际实现仅涉及上表七份文件（五份既有代码、新工作区反例、本文）。GET Attempt新增根级`limitedCheck`，同原鉴权事务重读固定活动；不暴露检查规则正文、私有结果、租约或新接口。旧服务端帮助拒绝/用途取消/取消确认/节点失联规则保持。

客户端`WorkspaceHead.limitedCheck?: boolean`兼容旧响应，`limitedCheckFromHead(head): boolean | null`严格接受布尔值，其余为null。ControlsState追加同名nullable事实；开始重读及不可用时清除当前判断，按原确认客户端/上下文读取。Assignment先读、Head最后读，避免等待分配时把已结束/新生效检查的旧标志贴到相同Attempt revision/epoch。控制槽以`limited/not-limited/unknown`三个状态展示；每2.5秒只重读原公共状态，结束不依赖Attempt revision变化，不把时间流逝当结束证据。读取失败与未知字段不阻断本票独立控制的合法命令，保存/采集/提醒原权限不变。

实际环境与结果：

| 检查 | 实际结果与范围 |
| --- | --- |
| 学生目录`rtk npm test -- tutoringControls.test.ts` | Windows Node24.15.0、Vitest3.2.7；最终22/22通过，0失败。新增7项覆盖显式false与raw active、字段缺失/非法、同版本结束、延迟分配跨状态、读失败、暂停优先、旧上下文 |
| 学生目录`rtk npm run typecheck` | 退出0；原前端/Node两份TS配置通过 |
| 教学目录`npm run typecheck` | WSL2 Ubuntu、Node24.21.0原lock依赖、原node-gyp重建SQLite；退出0，原运行时检查及全教学TS类型通过 |
| 教学目录`node --test server/workspace/limited-check.test.ts server/workspace/runs.test.ts` | 15项：14通过、0失败、1跳过。新增D-03六项全部通过；原运行规则8项通过；原真实C1 SSH选项未启用，1项跳过，不算通过 |
| 根目录`node tools/a0-review/check.mjs` | Windows Node24.15.0，73文档/1068内链，errors=[]、退出0；仅静态文档检查，不作为教学服务精确运行环境证据 |
| `git diff --check` | 退出0；新增测试/记录还在提交前按实际暂存集检查空白，不用仅tracked diff替代新增文件检查 |

教学新增反例走原Fastify HTTP注入、Session/课程成员/本人Attempt授权及原SQLite持久事务。Runner是明确隔离的内存协议替身，不运行进程或联系节点；两类active使用同一固定helpPolicy、仅固定规则limitedHelp不同，真实原B2 `/help`分别拒绝/接纳（只创建Job，不执行模型）。未知执行跨重启保持true，原结果确认或完整停止确认后才false；检查结束时Attempt revision/epoch确实未变；paused/教师暂停仍能读取true，另一学生403；false下暂停尝试的原/help仍409且零新Job。公开响应不带私有检查stdout/答案。

本次无失败的应用检查；较早21项学生规则已通过，新增延迟分配反例后最终窄规则/typecheck再次22项通过。教学typecheck后仅补学生测试，不涉及教学源码变化，未重复全教学检查。没有执行教学默认全量测试、真实模型开关或SSH节点选项。

### 主Agent确切适配

1. 同一准备authority的GET Attempt响应在根级给出真实布尔`limitedCheck`。正常C准备无检查场景应为false；受限/非受限active及失联/取消未确认/ended须按已批准公式模拟。缺字段/非法字段专门保留未知反例，不能一律`?? false`。本支线没有修改`prep/workspace`、`prep/tutoring`或`prep/plugin`。
2. 主求助UI/发送前读取可复用`limitedCheckFromHead`；仅确切false排除限定检查这一项。null/true不能当作允许求助；还须独立核当前受信代际/已同步上下文、固定helpPolicy、ready/active阶段、Assignment/活动可用性、对象当前性及原待确认命令。不要把本Controls的展示缓存当作发送时权威许可，发送前仍从原客户端重读head。服务端拒绝原样处理，禁用按钮不替代鉴权。
3. 控制槽无需新props即可从原ConfirmationWorkspace读取新增字段；浏览器可用`data-testid="limited-check-state"`的`data-state=limited/not-limited/unknown`核可见状态。组件轮询只做原读接口；若主统一分享当前head，保留相同版本结束的重读能力和旧响应防护，不因revision没变停止更新。
4. 原事件Control没有新增该字段，本支线不写`tutoringContracts/tutoringWorkspace/Pane/History`。主统一组合发送禁用、发送前守卫与消息投递状态，不从事件到达顺序、Job status或历史缓存补造当前限定检查判断。

### 未验与交付边界

尚未执行本支线的准备/真实服务浏览器组合、正常HTTPS/TLS、真实执行节点、实际供应商、真人或整体AC/NFR；原SSH项跳过保留。主Agent整合后补Controls呈现/同版本结束/断线重连/原发送守卫组合与必要build/browser检查，本文不重复宿主审计、不声称完整父票已验收。产品基线及MVP_SPEC §10仍为“待授权维护者汇总”。

只提交本支线七份写集及记录，不推送/合并/发布。主提供的`apps/teaching/node_modules`Linux软链在Windows Git显示为未跟踪对象，属于机器环境，不暂存/修改/删除。
