# G2：P2 总协调与教学支持交付跟踪

日期：2026-10-11（Asia/Shanghai）。任务编号：G2，对应 TEAM 的 P2。主责：P2 总协调。

关联：[总协调 #24](https://github.com/paher-din/XunJie/issues/24)、[A3 #25](https://github.com/paher-din/XunJie/issues/25)、[B2 #26](https://github.com/paher-din/XunJie/issues/26)、[C3 #27](https://github.com/paher-din/XunJie/issues/27)。

**项目负责人已明确进入 P2，并指定本工作项负责阶段总协调。阶段协调已启动；A3/B2/C3 尚无本次交付或验收结果，P2 服务端预交付与完整 G2 均未完成。** 本文汇总既定范围、依赖和证据，不新增产品或共享技术契约。

## 1. 依据、职责与写入范围

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按 PRD → MVP_SPEC → TECH_DESIGN 顺序核对：

- [PRD](../product/PRD.md) 第 3～5/8/9 节：教师共同设计、学生控制作品、就地支持、记录与数据边界；对应 PRD-01/02/04/05/09/10。
- [MVP_SPEC](../product/MVP_SPEC.md) M-01/M-04/M-05、第 4～8 节：G2 完整出口 AC-01/05/06/11；相关 AC-02/04/07/08/12/15/16 与 NFR-02/04/06 不省略。
- [TECH_DESIGN](../product/TECH_DESIGN.md) 第 2～7/9～12 节：模块责任、可信信封、教师提案、ObjectRef、上下文、作业、回执、采集与恢复。
- [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) 第 2/3/6/8 节，以及 [G1 当前收口](G1_OVERALL_COORDINATION.md#19-2026-10-11-执行-issue-关闭与本地全部工作整合)、[B1 交接](B1_AGENT_CORE.md)、[工程衔接说明](../reference/ENGINEERING_HANDOFF.md)。B1 作者稿中的旧未执行状态按日期保留，较新组合验证以 G1 记录为准。

总协调负责阶段状态、依赖与阻塞、跨模块契约核对、集成审查、授权需求及验收汇总；模块实现、测试、任务文档和修复仍由 A/B/C 各自负责。A 在 TEAM 第 2 节的公共契约汇总、共享文件和应用集成职责保持有效。

本任务可写本文及 README 的 P2 真实状态/导航；`AGENTS.md`、`docs/product/**`、`docs/planning/**`、`docs/reference/**`、其他成员任务稿和应用源码只读。阶段进入不自动授权共享契约变更、具体大规模实现或红线操作；基线差异在任务稿提出，待项目负责人确认。

## 2. P1 交接与进入状态

2026-10-11 启动核对：本地 main 与 origin/main 均为 `33cc4abddb47063a1f6dbdae976b716f01bb3bc1`，开始时工作区干净。GitHub Issue 列表回读如下；这是管理状态核查，不是新增业务验证。

| 上游/条件 | 已有交付与当前状态 | 对 P2 的影响 |
| --- | --- | --- |
| A1/A2/C1/C2 | #10/#13/#12/#14 已 Closed；服务端成果与修复已合入 main，交接依据见 G1 第 17～19 节 | A3 可复用草稿/权限/短事务与基础作业；B2/C3 可复用固定活动/政策、确认快照/结果与公共记录 |
| [B1 #11](https://github.com/paher-din/XunJie/issues/11) | Open；合成核心与注入式适配接口已交付，较新工程/typecheck/36 项用例和 SDK smoke 见 G1；实际 SDK invoker/token counter 业务映射与真实模型未完成 | 合成开发可继续；真实教师生成、真实学生求助联调需 B 补齐对应接入与授权条件，不用替身算真实模型通过 |
| [完整 G1 #22](https://github.com/paher-din/XunJie/issues/22) | Open；实际 UI 与原 AC/NFR 未验收 | 不阻塞既定 P2 服务端开发；完整产品条件仍保留，最后接入团队实际 UI |
| [环境稳定性 #23](https://github.com/paher-din/XunJie/issues/23) | Open；此前 Linux 完整回归仍有墙钟/认证失败 | 使用稳定环境验证并如实报告；不把历史专项通过写成 Linux 全套通过，不自行调整时钟/VM/节点 |
| 数据与实际环境 | 开发仅合成数据；D-02、真人数据/访问、具体凭据与付费、当前执行 ready 仍按各自门禁 | 只阻塞依赖该条件的工作；历史节点证据不代表当前实时 ready |

P2 无需提前完成浏览器 G1，但 P1 的行政收口不能替代完整 G1/MVP 验收。既有数据库初始化授权不自动延伸到 P2 新 schema 或迁移。

## 3. 既定任务、依赖与交接

以下沿用 TEAM 第 6 节，不重分职责、不另定排期。

| 任务 | 主责与范围 | 依赖/可开始部分 | 向总协调交付 |
| --- | --- | --- | --- |
| A3 | A：教师生成/局部建议异步命令、提案与基础 revision、差异/影响/引用、教师采用 PATCH、量规试评 | A2 草稿 + B1 + C2 基础作业；不等 C1、B2 或 C3 全部完成 | 真实接口链、人工编辑并发反例、提案持久化与采用证据、教师内容审阅待办 |
| B2 | B：help、真实 ObjectRef/上下文/政策、空历史降级、旧对象/epoch 守卫、取消/替换、默认关闭提醒 | B1 + A2 版本/政策 + C2 快照/结果；无学习状态时按空状态工作；完整投递接 C3 | 获准引用与上下文、帮助/限定检查反例、一次有效辅导与取消/替换证据、实际模型与语义边界 |
| C3 | C：教学原文、分层回执/去重、获准事件/游标补取、采集控制/覆盖空窗、通用取消/同事务失效 | C2；按正式动作契约开发，不等 B2 产出真实消息才开始 | 消息/回执/事件/采集接口、持久取消与恢复反例、A4 可调用的同事务失效接缝 |

A3 教师链与 B2/C3 学生链分别推进；B2/C3 按契约并行，真实投递联调等双方交付。各模块执行前建立本人任务文档，明确方案、可写文件、上游批次和验证；接口或 schema 补充先评审，未批准部分不实施。

集成核对顺序：

1. **教师链：** A3 接纳命令/持久 Job → B1 生成 body → A 保存绑定 baseRevision 的提案 → 教师明确采用并走 PATCH/CAS。旧提案保留 stale，不能覆盖并发人工编辑或自动确认活动；量规试评不伪造学生观察。
2. **学生链：** B2 鉴权/政策/ObjectRef/有效上下文 → C 保存问题与有界 Job → 模型输出校验 → 当前政策/对象/epoch/租约/代际重查 → C 保存 Message/Action → 获准事件与实际客户端回执。模型不改作品、不运行、不写正式评价。
3. **控制与恢复：** 取消、替换、尝试/分配暂停、限定检查、关闭提醒与暂停采集分别按用途处理；生成成功但未展示的 Action 也可停止。迟到/重启/重连不复活旧动作；缺回执保持未知。
4. **采集：** 暂停停止逐次过程与被动分析，显式保存/求助/运行/提交仍保存必要功能数据；captureRevision 与 decisionEpoch 分开，不补传或回填空窗。

共用 A 的授权/短事务与 C 的 Job/Receipt/Event；模型和网络等待在事务外。可信 scope、版本、租约/代际和结果 hash 由受信服务构造，B 只产 body。调用/修复/换 worker 共享单轮最多 3 次与接受起含排队 45 秒；unknown usage 不写成零，成本耗尽不阻塞保存或人工操作。

## 4. 验收账目与 P2 出口

| 项目 | P2 核对内容 | 当前验证状态/仍须等待 |
| --- | --- | --- |
| AC-01 / M-01 | 教师起草、局部建议、人工修改保留、受影响项、量规试评与修订 | 服务端未执行；实际教师内容审阅与界面操作未执行 |
| AC-05 / M-04 | 提示/相邻例子、停止、“我先试试”、新求助替换、提醒取消 | 服务端/政策未执行；语义抽查、实际停止/返回未执行 |
| AC-06 / M-05 | 命令/结果/回执幂等、断线补取、生成/投递/展示/确认分离 | 服务端未执行；测试客户端不算真实学生展示 |
| AC-11 / M-05 | 采集暂停/恢复、功能数据例外、空窗与迟到过程拒收 | 服务端未执行；实际网络上传与 UI 说明未执行 |
| AC-02/04/15 | 权限/私有资料、固定版本与过时定位、限定检查禁用帮助 | P2 新接入部分未执行；P1 历史证据不计本次新通过 |
| AC-07/16 | 空历史、相关/无关/撤回依据、反证、环境失败与未知 | P2 上下文部分未执行；完整状态/分析依赖 A4/B3，不提前宣称 G3 通过 |
| AC-08/12 | 同事务失效、取消竞态、应用重启/旧代际拒绝 | P2 接缝未执行；完整纠正/备份恢复按 A4/C4/C5 原阶段验收 |
| NFR-02/04/06 | 排队/响应/45 秒、确定性边界、次数/用量/故障与降级 | 未执行；10 会话/至少 30 次模型样本与真实语义按 B4/P4；最终响应计入实际展示链 |

**P2 服务端预交付出口**沿 TEAM 第 6 节：教师真实生成/局部采用与学生真实求助/取消链路接通，内容、政策、版本、引用、Job 和回执可回查；确定性拒绝/并发/故障证据及各模块交接包齐备。合成与实际模型结果分别报告。

**完整 G2 出口**沿 MVP_SPEC 第 8 节：M-01/M-04/M-05 可用，AC-01/05/06/11 原条件通过；实际展示、停止、例子返回、采集开关及教师内容审阅仍须执行。服务端阶段完成、GitHub 关闭或文档交付均不自动满足完整出口。

## 5. 本次交付、验证与下一步

首次建立总协调记录时，仅同步本文与 README，没有模块实现、任务委派或 GitHub 写入，当时 Issue 列表未见 G2/A3/B2/C3。负责人随后授权的任务发布与推送另列第 6 节；本节保留首次文档核查结果，不计业务验收。

| 核查 | 本次结果 |
| --- | --- |
| Git 与上游状态 | 本地/跟踪 main 一致、开始时干净；#11/#22/#23 Open，A1/A2/C1/C2 Closed |
| 文档链接/锚点与基线接口检查 | `node tools/a0-review/check.mjs` 通过：31 份文档、386 处内部引用、27 条正式路由，`errors=[]`；本机 Node v24.15.0，仅文档检查，不计批准应用环境验证 |
| 空白与写入范围检查 | `git diff --check` 与新任务稿尾随空白/末尾换行检查通过；Git 状态仅 README 修改和本文新增，受保护基线/作者稿/源码无增量 |
| 业务/数据库/模型/节点/浏览器/真人验收 | 未执行；本次没有对应实现或授权操作 |

下一步：按既定 A3/B2/C3 任务接收方案与交接，先核共享接缝和红线授权范围；并行跟踪 B1 实际接入条件，按第 3 节汇总两条真实链的集成证据、差异和阻塞。阶段进入只记已确认的协调范围，不代替各成员的具体实施方案确认。

待授权维护者汇总：MVP_SPEC §10 与 TEAM 当前进展可记录“2026-10-11 P2/G2 总协调已启动，原职责与验收不变，A3/B2/C3 尚无本次验收结果，#11/#22/#23 保留”。本文不直接改写受保护基线。

## 6. 2026-10-11 Issue 发布与文档推送

项目负责人明确要求建立 Issue 并推送，授权公开创建 G2/P2 总协调与 A3/B2/C3 三项执行任务、补齐新任务间的依赖链接，以及提交并普通推送本文和 README 到 main。该授权不包含成员消息、受保护基线修改、模块实现或其他红线操作。

发布前回读仓库全部 Issue，未发现 G2/A3/B2/C3 重复任务，#11/#22/#23 仍 Open。本地与远端 main 起点均为 `33cc4ab`，未提交文件只有本文和 README。发布正文先引用已在远端 main 的产品/分工基线；本地总协调稿完成推送后再补公开文档入口。标题/正文、双向任务关联、状态和远端提交按实际执行结果追加，不提前登记完成。

### 6.1 已发布任务与回读

| 任务 | 主责 | Issue 与实际状态 |
| --- | --- | --- |
| G2/P2 | 总协调 | [#24：总协调、教学支持集成与阶段验收](https://github.com/paher-din/XunJie/issues/24)，Open |
| A3 | A | [#25：教师 Agent 业务接入、提案采用与量规试评](https://github.com/paher-din/XunJie/issues/25)，Open |
| B2 | B | [#26：真实上下文、学生辅导与控制权](https://github.com/paher-din/XunJie/issues/26)，Open |
| C3 | C | [#27：教学消息、回执、采集控制与作业失效](https://github.com/paher-din/XunJie/issues/27)，Open |

实际使用已登录的 `gh issue create --body-file` 按四份 UTF-8 正文创建，再用 `gh issue edit --body-file` 补齐总/子与 B2/C3 交接链接。`gh issue list --state all --limit 100 --json number,title,state,url,body,assignees` 回读：四份标题和正文逐字一致、均 Open、无 assignee、无已勾选任务或占位符；总/子双向及学生链依赖链接齐全，#11/#22/#23 仍 Open。未新增评论、成员消息、排期、金额或未知账号分配。

总 Issue 分开列 P2 服务端里程碑与完整 G2 出口，执行 Issue 保留各模块的范围和具体门禁；真实模型、实际 UI/教师审阅、完整状态/恢复与原 NFR 不记作已通过。README 已同步四项任务入口。文档静态验证与实际推送结果在第 6.2 节追加。

### 6.2 文档验证与普通推送

推送前验证：`node tools/a0-review/check.mjs` 通过，31 份文档、386 处内部引用、27 条正式路由，`errors=[]`；`git diff --check`、新增稿尾随空白/末尾换行和精确文件集合检查通过。仅本文与 README 有增量，无既有暂存文件；应用源码、受保护基线、作者任务稿和依赖/配置不变。纯文档变化不重复无关业务回归，业务/模型/节点/浏览器/真人验收均未执行。

首次发布提交为 `df83fd41e73024836395c66acb10f53e332a4918`（`docs: launch P2 coordination and publish stage issues`），仅本文与 README，共 117 行新增；已从 `33cc4ab` 普通推送至远端 main。GitHub API 回读远端 main SHA 与本地 HEAD 相同，两份远端文档的 Git blob SHA 分别与本地提交完全一致，工作区干净。推送仅使用单次命令生效的 OpenSSL/HTTP 1.1/低速超时参数，未修改永久 Git/网络配置，无强制推送、历史改写或删除。

确认总协调稿在 main 可访问后，四个 Issue 均补上仓库跟踪入口。最终再次回读标题/完整正文，与四份发布文件逐字一致，均 Open/无 assignee/无已勾选项/无占位符，总/子和 B2/C3 关联、公开文档入口齐全；#11/#22/#23 仍 Open。完整发布正文可从各 Issue 独立查阅，临时正文与回读快照留存，不作为团队访问前提。

本条实际发布记录随本文再次普通提交/推送，最终 SHA 以 main 的本地、origin/main 与远端引用回读为准；仅补充发布事实，不新增业务实现或验收通过项。受保护进度仍待授权维护者汇总。

## 7. 2026-10-11 PR #28/#29 固定提交审查

项目负责人要求处理当前两项 PR。本次按总协调职责完成只读两轴审查、原专项/组合复验和新增边界复现，不代 A/B 修代码，不合并或关闭任务。主副本处于 C3 分支且有其他成员未提交改动，完整保留；本文是本次主副本唯一写入的任务记录，README 不覆盖他人工作。

### 7.1 范围与审查点

| 对象 | 固定基线/候选 | 本批范围与保留条件 |
| --- | --- | --- |
| [PR #28](https://github.com/paher-din/XunJie/pull/28) | base `c42f356`，head `9d470940fd5eeff5ad7c0536a6152d57dcc54e00` | A3 教师命令/提案/明确采用的获准合成服务端；作者任务 §2～3/5 记录负责人批准 24 表全新临时合成库与验证接缝，未改既有库。真实模型、教师内容会审、UI/TLS 及 #25 完整条件保留 |
| [PR #29](https://github.com/paher-din/XunJie/pull/29) | base `c42f356`，head `6f32c38dfe47a62f220ab12141045bde8b38caa0` | B1 实际 SDK/provider/Zod 适配、保守输入上限、修复及离线传输；真实 D-02/付费调用与 #11 关闭条件仍未完成 |

依据为 PRD/MVP/TECH、TEAM 与 #25/#11 当前正文，作者批准方案仅适用于准确范围。按 code-review 的 Standards/Spec 两轴分别只读审查；原明确后置条件不算本批新增缺陷。两 PR 开始时 Open/Mergeable、无 CI 检查结果或现有审查意见，发布审查前再次核 head 未变。两个固定树与组合验证树均单独建立并附加到总协调工作项，不切换主副本分支或应用其他成员未提交代码。

### 7.2 Standards

PR #28：新增硬性规范问题 0，可操作异味 0。

PR #29：新增硬性规范问题 1 项 P2，可操作异味 0。`server/tutoring/deepseek-sdk.ts:69～72` 在实际 SDK 的 `NoObjectGeneratedError` 带有已知 usage 时，因 JSON 正文不能解析而重抛，核心只保留 unknown，违反 TECH §10.3 对实际用量及错误成本的记录要求。实际受控响应为 HTTP 200、正文 `{"kind":`、usage=(23,11)，结果 unknown；SDK 源码与离线复现均核实该错误携带 usage。此根因同时涉及下方 Spec 修复路径，两轴分别计算，实际仅一处结构错误桥接问题。

### 7.3 Spec

| 编号/优先级 | 新增位置 | 具体复现与影响 | 修正边界 |
| --- | --- | --- | --- |
| A3-R01 / P2 | `server/design/teacher-agent.ts:290～294` | 合成 provider 将服务端时钟推进 45001ms 后返回 actual(10,4)；B outcome 为 timed_out 且含 actual，原 Job 为 timed_out 但 usages 仍 unknown。已得到的失败成本丢失 | 核原调用身份/代际后保存已知用量，保持 Job 终态并继续拒绝迟到教学正文 |
| A3-R02 / P2 | `server/design/teacher-agent.ts:286～289` | provider 在真实发送前抛 InputLimitError(16001)；B 返回 needs_input/calls=0、outbound=0，Job 却 attemptCount=1/usages=[unknown]。未发送调用被扣占预算，持久计数与 B 结果不同 | 在预检前不扣计费调用，或对可证实未发送的原预留安全释放；不削弱跨 worker/已发起调用的持久上限 |
| B1-R01 / P2 | `server/tutoring/deepseek-sdk.ts:69～72` | 实际 SDK 的内存 transport 第一次返回非法 JSON，第二次预设合法 body；只调用一次并返回 unavailable/unknown，未使用已承诺的格式修复 | 结构化生成失败返回无效 body 与错误携带的 usage，交既有核心在原 3 次/45 秒内执行一次修复；真实网络故障保留独立错误路径 |
| B1-R02 / P3 | `server/tutoring/deepseek-sdk.ts:98` | 实际 SDK 接受合法教学 body 与 prompt_tokens=-23/completion_tokens=11，核心返回 success/actual(-23,11)。安全整数校验未排除非法负数，成本/配额与 A3 非负持久校验不能正确消费 | 两个 token 字段同时校验非负，非法用量保持 unknown |

PR #28 的 blueprint/allowedFields 提案存在语义歧义，采用仍严格限字段，未作为确定阻塞发现；没有擅自修改批准接口。两轴汇总：Standards 1（最高 P2）；Spec 4（最高 P2，#28 两项 P2，#29 一项 P2/一项 P3），四个独立代码缺口。结论为先修正再复审，不合并。

### 7.4 实际验证与交付状态

| 检查 | 本次真实结果 |
| --- | --- |
| 精确 Node/依赖 | 使用已校验的 Node 24.21.0、原锁版本 TypeScript 7.0.2/ai 7.0.136/DeepSeek 3.0.63；复用既有批准 Windows 依赖，无新增依赖或 package/lock 修改 |
| PR #28 typecheck/build、原 A3 专项 | 通过；20 通过、0 失败、0 跳过 |
| PR #29 typecheck/build、原 B1 专项 | 通过；45 通过、0 失败、0 跳过；真实已安装 SDK/provider，供应商网络调用 0 |
| 两 PR 本地组合 | 自动预合并无源码冲突，README 自动保留两侧；typecheck/build 通过，未提交该预合并或合入远端 |
| 原完整组合 `npm test` | 210 项：202 通过、1 失败、7 原条件跳过；唯一失败为基线 `server/workspace/review.test.ts:118` 在 Windows 初始化 Linux-only RunControl，`runner/control.ts:48` 拒绝；两文件与 c42f356 无差异。未加 skip 或改检查，不宣称完整回归通过 |
| 新增 A3 边界断言 | 2 项均失败：late usage 与 input preflight，均达到 §7.3 所列错误状态；新增合成库保留，不计原回归通过 |
| 新增 SDK 边界断言 | 2 项均失败：malformed JSON 与 negative usage，均达到 §7.3 所列错误状态；只用内存 transport，无供应商网络 |
| 初始复验环境失败 | Linux 布局缓存导致 tsc 入口不可用；外部 Windows 缓存 junction 导致既有 test-support 声明路径不可移植。均保留失败输出，随后把同版本依赖复制到各验证树，原命令通过；未改源码或关闭类型/声明检查 |
| 当前文档/范围检查 | 主副本文档检查 33 份/446 处内部引用/27 条正式路由通过，`errors=[]`；本文增量空白通过。两个固定 PR 审查树的跟踪文件干净，未改变作者源码；主副本其他成员修改保留 |
| 真实模型/节点/Linux/浏览器/真人 | 未执行；不发送真实学生或教师私有数据，不改凭据/CI/VM/节点，不扩大数据库操作授权 |

四条行内意见与两份 Request Changes 正文已按固定 commit/新 diff 行号准备，并核公开 PR head 未变。本节记录授权前状态：当时仅本地审查稿，未提交 GitHub 审查、合并 PR、关闭 #25/#11 或推送记录；后续授权与发布事实见第 8 节。原文档/专项/组合结果和新增反例分别保存，不把已有测试通过或评审稿当完整 G2 验收。验证工作树、依赖副本、临时正文/反例/输出保留；团队核查入口为上述固定 PR、行号、输入与结果，无需访问个人临时目录。

## 8. 2026-10-11 授权发布 PR 审查与总记录

项目负责人在四个缺口、完整审查稿与验证结果可审阅后，明确选择“提交审查并推送总记录”。准确授权范围为向 PR #28/#29 公开提交两份 Request Changes 及四条行内意见，并仅提交/普通推送本文；两 PR 暂不合并，不代作者修复，不关闭任务，不提交主副本 README/C3/I0 等其他成员修改，不改受保护基线、凭据/CI、数据库或执行环境。

### 8.1 已发布评审与回读

| PR | 实际评审 | 固定 commit / 行内意见 |
| --- | --- | --- |
| #28 | [Review 5482880804](https://github.com/paher-din/XunJie/pull/28#pullrequestreview-5482880804)，CHANGES_REQUESTED | `9d470940`；[超时实际用量](https://github.com/paher-din/XunJie/pull/28#discussion_r4241172685)（teacher-agent.ts:290～294）、[预检调用预留](https://github.com/paher-din/XunJie/pull/28#discussion_r4241172687)（286～289） |
| #29 | [Review 5482880928](https://github.com/paher-din/XunJie/pull/29#pullrequestreview-5482880928)，CHANGES_REQUESTED | `6f32c38d`；[结构错误修复/用量](https://github.com/paher-din/XunJie/pull/29#discussion_r4241172791)（deepseek-sdk.ts:69～72）、[非负 token](https://github.com/paher-din/XunJie/pull/29#discussion_r4241172794)（98） |

发布前重新回读两 PR 的 Open/head/审查列表，固定 head 均未变、无既有评审；使用结构化 UTF-8 JSON 与 `gh api POST .../reviews --input` 分别提交，没有重复请求、额外评论或成员消息。发布身份为 paher-din，两 PR 作者为其他账号；实际平台状态为 CHANGES_REQUESTED，不伪称 Approved。

独立回读两个 review：完整正文、commit_id、状态和发布账号均与准备稿一致。通过 PR 全量 comments 按 review ID 过滤，四条正文、path、RIGHT、line/start_line、commit_id 逐项一致，每份准确两条。首轮使用 review 专属 comments 接口缺 line/side，位置断言未通过；确认其返回字段范围后改用完整 PR comments 核对，不降低断言、不修改或重复发布意见。两 PR 仍 Open，reviewDecision=CHANGES_REQUESTED，head 仍为上述固定候选，原问题待作者修复/复审。

### 8.2 单文件文档发布范围

发布时远端 main 已由其他已授权任务更新为 `10281827164a1e61cb08c75c43a505476f4ee4ec`，其中本文与 c42f356 的原版本无差异。独立文档工作树以该最新 main 建立，仅复制本人第 7～8 节记录；保留新 main 的 README/I0 等既有交付，不将旧主副本覆盖远端新内容。验证后只暂存本文、普通提交/推送到 main；实际提交与远端回读结果随后追加。

独立发布树实际静态检查通过：32 份文档、406 处内部引用、27 条正式路由，`errors=[]`；本文增量/末尾空白及精确单文件范围检查通过。主副本第 7 节的 33/446 统计包括其他成员未提交任务稿，不冒充本次远端交付树的文档数量。

实际首次记录提交 `6619e65724740f57327c68739f82ea2ff884aa55`（`docs: publish P2 PR28 and PR29 review findings`）已从 `1028182` 普通推送到远端 main，仅本文 70 行新增。GitHub API 回读远端 main SHA 与独立树 HEAD 一致，本文远端 Git blob SHA 与本地提交一致，精确提交范围只有本文，独立树干净。主副本分支与其他成员未提交工作未暂存/提交；I0 及新 main 其他交付保留。

发布后两 PR 再次回读仍 Open/CHANGES_REQUESTED，固定 head 未变；未合并、关闭任务或解决尚未修复的审查线程。本条真实发布记录随本文再次单文件普通提交/推送，最终 SHA 以独立树 HEAD、origin/main 与远端 main 回读为准，不新增业务/基线/配置改动。

核对记录提交 `85bec2351c31f2268e4e1146ddae6e7d8fac2fa3` 的首次推送因 GitHub 443 连接失败（约 21 秒）未成功；API 确认远端仍为 6619e65 后，按相同单次网络参数普通重试成功，远端快进至 85bec23。失败保留，不伪称首次通过；未重复发布评审、改永久配置或强制推送。本段补充该真实网络结果，仍仅发布本文。

本次不重复第 7 节业务测试，不将审查发布记为修复通过或产品验收。第 7 节原失败/跳过和真实模型/节点/UI/真人未执行继续保持；基线进度待授权维护者汇总。

## 9. 2026-10-11 PR #28/#29 修复复审与 PR #32 首审

项目负责人要求处理当前三项 PR，并明确授权两项范围：安装批准运行时后执行真实验证；发布 PR review 并写本文记录。**未授权合并任何 PR、关闭 Issue、改动受保护基线、凭据/CI、schema 或他人文件**，本节全部动作均在该范围内。

### 9.1 主副本状态与工作树隔离

开始时主副本 `D:/XunJie` 处于 `main`，落后 `origin/main` 5 个提交，且索引含 11 条未合并项（`UU` 6 条、`DU` 5 条），来自一次在 `main` 上失败应用的 `git stash apply`；`stash@{0}`（`On codex/c3-teaching-records: Qoder 检出分支临时保存`，13 改 + 2 未跟踪）仍完整。该状态与本次任务无关，**未重置、未清理、未 drop**，C3 在制品保持可恢复。

本轮全部工作在独立工作树完成，未切换主副本分支、未应用其他成员未提交改动：

| 工作树 | 固定提交 | 用途 |
| --- | --- | --- |
| `p3-pr28-rereview` | `21a1b09` | PR #28 复审 |
| `p3-pr29-rereview` | `de794ba` | PR #29 复审 |
| `p3-pr32-review` | `fdec49d` | PR #32 首审 |
| `p3-combined-2829` | `21a1b09` + `de794ba` 试合并 | 精确两两预合并 |
| `p3-combined` | `21a1b09` + `fdec49d` 试合并 | 含 B2 的组合预合并 |
| `p3-review-publication` | `origin/main 0afd008` | 本文单文件发布 |

三个 PR 与 `origin/main` 的 merge-base 均为 `c42f356`，全部使用三点 diff；GitHub 报的 PR #32 base 为 `0afd008`，两点 diff 会把 main 独有的 I0/G2 文档误显示为删除，已避开。

### 9.2 审查点与两轴结论

| 对象 | 上轮固定 head → 本次 head | Standards | Spec |
| --- | --- | --- | --- |
| [PR #28](https://github.com/paher-din/XunJie/pull/28) | `9d470940` → `21a1b093`（3 提交、7 文件） | 硬性违规 0，P3 判断项 4 | 上轮 A3-R01/A3-R02 两项 P2 **均已按原边界真实修复**；新增 1 项 P2 合并阻塞（见 §9.3） |
| [PR #29](https://github.com/paher-din/XunJie/pull/29) | `6f32c38` → `de794ba3`（2 提交、3 文件） | 硬性违规 0，原 §10.3 P2 已解决，P3 判断项 3 | 上轮 B1-R01（两轴同根因）与 B1-R02 **均已按根因修复**；无新增缺陷 |
| [PR #32](https://github.com/paher-din/XunJie/pull/32) | 首审，基点 `de794ba` → `fdec49d`（8 文件、+1767） | 硬性违规 0，P2 1 项、P3 判断项多项 | 声明已完成项基本真实实现且有测试；P2 2 项（跨 worker 调用上限接缝、资料侧注入反例缺失） |

A3-R01 修复实测边界正确：`teacher-agent.ts` 的用量守卫由 `status!=='running' || stopRequested || now>=deadline → return` 改为只核 `leaseToken` 与调用槽，用当前已持久 Job 保存用量、不改终态；迟到正文仍由 `receiveResult` 的 lease/status/stopRequested 与 deadline 分支拒绝，结果未被复活。A3-R02 修复只在 `leaseToken` 一致、`attemptCount === callIndex+1`、`usages[callIndex].status === 'unknown'` 三者同时成立时释放末槽，`records/jobs.ts` 的 3 次持久上限未改，已发送调用保留预留。

B1 三项修复实测：`deepseek-sdk.ts` 删除 `if (body === undefined) throw error;`，`NoObjectGeneratedError` 不再在读取 usage 前重抛；`parseInvalidStructuredBody` 解析失败返回原文、无 text 返回 `null`，无效 body 交核心走修复路径；至多一次修复由 `core.ts:160～163` 的 `repairUsed || call === MAX_CALLS` 保证；`toModelUsage` 拒绝 `undefined`、非安全整数与负数。

PR #32 的三项 P2：`service.ts:25～34` 的 `executeAuthorizedStudentHelp` 未读取 `input.job.attemptCount`，`core.ts` 每次从 `usages=[]`、`call=1..MAX_CALLS` 重新起算，C3 换 worker 重试会重获完整 3 次配额，与 #26「单轮/一次修复/换 worker 共用最多 3 次」冲突，且该缺口不能靠延后给 C3 自动解决（接缝既不接受先前调用数也不逐次回报用量）；`application.ts:176` 抛裸 `Error` 绕过错误码契约（同函数其余路径为 `ApiError("FORBIDDEN"/"STATE_CONFLICT"/"RECOVERY_REQUIRED")`）；`context.ts:215` 把资料段落原文送入模型，但 10 项测试的注入文本全在学生 question 内，缺 #26 明确要求的「资料指令注入 / 资料内容不能扩权」反例。

### 9.3 新增合并阻塞：PR #28 与 PR #29 组合破坏 main 的 typecheck

PR #29 首个提交 `fdd0c12` 把 `createDeepSeekProvider` 从 `{ invoke, countTokens }` 收窄为 `{ invoke }` 并移除 `TokenCounter` 导出，输入上限改由内部 `estimateDeepSeekInputTokenUpperBound(invocation) > 16_000 → throw InputLimitError`（`providers.ts:86～89`）强制。PR #28 为证明 A3-R02 新增的两条反例仍按旧签名注入计数器（`tests/design-agent.test.ts:427`、`:464`）。

`21a1b09 + de794ba` 独立预合并实测：自动合并 0 源码冲突，但

- `npm run typecheck` **失败**：`tests/design-agent.test.ts(427,44)` 与 `(464,44)` 各报 `TS2353: 'countTokens' does not exist in type '{ invoke: DeepSeekInvoker; }'`
- `node --test tests/design-agent.test.ts` 25 项中 **2 项失败**：`input preflight rejection…` 实得 `success`、期望 `needs_input`；`a second call rejected by preflight…` 实得 `unavailable`、期望 `needs_input`
- `npm test` 217 项：207 通过、**3 失败**、7 跳过（第 3 项为既有基线失败）
- `npm run build` 仍通过（`tsconfig.build.json` 不含 tests），破坏只在 typecheck 与测试暴露
- `21a1b09 + fdec49d`（含 B2）组合同样 0 冲突、同两处 `TS2353`，`npm test` 227 项：217 通过、3 失败、7 跳过，文档检查 `errors=[]`

根因是 `countTokens` 被忽略后 `InputLimitError` 不再抛出，**A3-R02 的修复在代码层正确，但其证据会随 #29 落地而失效**。组合树中 `countTokens` 的残留依赖只有上述两行测试，无生产源码依赖。两个 PR 各自在自己的 base 上均干净，谁都看不到对方，属排序问题而非任一方实现错误。

**修正边界与顺序：** 该两行属 A 的测试文件，B 不应修改。A 需按新机制重写——构造保守上界确实超过 16000 的实际输入（`estimateDeepSeekInputTokenUpperBound` 已导出），或注入发送前抛 `InputLimitError` 的 provider 替身，使 `needs_input`/`outbound=0`/`attemptCount=0` 与「首次已发送则保留 actual」两侧继续可证。**先合 #29，#28 适配复验后再合**；反序会把同样的 typecheck 失败留在 main。#32 堆叠在 #29 上且作者已声明不可先合，顺序不变。

### 9.4 运行时环境处置与工程发现

本机 PATH 上的 Node 为 v24.15.0，不符 `apps/teaching/tools/check-runtime.mjs` 要求的 v24.21.0；仓库既有 `node_modules` 只安装了 `@typescript/typescript-linux-x64`（7.0.2），Windows 上 `tsc` 根本无法启动（`Unable to resolve @typescript/typescript-win32-x64`）。按负责人授权处置如下，**未修改或绕过 `check-runtime.mjs`，未改任何被跟踪文件**：

- 官方 `node-v24.21.0-win-x64.zip` 下载后按 nodejs.org `SHASUMS256.txt` 校验 SHA-256 `158f7685…f75de9e541` 通过，解压到用户本地目录；未覆盖 `D:/nodejs`、未改永久 PATH 或系统配置。
- npm registry 取 `@typescript/typescript-win32-x64@7.0.2`，registry sha1 `cf3b7b0d…47ec3c` 与 SRI sha512 `0BQ3HkAH…ETMC4g==` 双验通过，仅解压进各审查工作树的 `node_modules` 副本；`package.json`、`package-lock.json`、`tsconfig` 零改动。
- `better-sqlite3` 自带 `win32-x64` 预编译，测试原生运行；`.bin` 符号链接在 Windows 无法用 `cp -r` 复制，改写 npm 风格 shim（junction 与 `mklink` 两条路径均失败并保留记录）。

**工程发现（交 A1/A 与 [#23](https://github.com/paher-din/XunJie/issues/23)）：** 当前锁定的安装对 TypeScript 7 只落 Linux 原生包，任何 Windows 侧验证都跑不了 typecheck/build。这解释了历史证据里 Windows 与 Linux 结果不一致的部分来源，建议在环境稳定性任务中明确 Windows 验证所需的平台包策略，不由本次审查单方改动依赖。

### 9.5 实际验证结果

全部在 Node v24.21.0 / TypeScript 7.0.2 / win32 下本机真实执行：

| 检查 | PR #28 `21a1b09` | PR #29 `de794ba` | PR #32 `fdec49d` |
| --- | --- | --- | --- |
| `npm run typecheck` / `npm run build` / `git diff --check` | 通过 / 通过 / 通过 | 通过 / 通过 / 通过 | 通过 / 通过 / 通过 |
| 模块专项 | `tests/design-agent.test.ts` 25 通过、0 失败、0 跳过 | `server/tutoring/test/*.test.ts` 47 通过、0 失败 | `student-help.test.ts` 10/10；`server/tutoring/test/*.test.ts` 57/57 |
| 覆盖率 | 未声明，未单独执行 | all files line 98.38%、branch 87.05%、functions 100.00% | application 90.60、commands 95.87、service 100.00 与任务稿一致；**context.ts 实测 line 97.80，任务稿写 96.95** |
| `npm test` | 206 项：198 通过、1 失败、7 跳过 | 192 项：184 通过、1 失败、7 跳过 | 202 项：194 通过、1 失败、7 跳过 |
| 文档检查 / 检查器自测 | `errors=[]`，32 份、27 路由；16/16 | `errors=[]`，31 份；16/16 | `errors=[]`，32 份；16/16 |

三者的唯一失败均为同一既有基线问题：`server/workspace/review.test.ts:120` → `runner/control.ts:48` 抛 `Linux and trusted control context required`；`git diff c42f356 <head> -- server/workspace/review.test.ts runner/control.ts` 在三个 head 上均为空，确非本轮任一 PR 引入。未加 `.skip`、未放宽断言、未改阈值。

作者声明数字逐项核对结果：PR #28 的 25/25 与 206/198/1/7 **完全一致**，两份 `.txt` 的 SHA-256 与字节数（2794 / 21908）与 `acceptance.a3-review.evidence.json` 相符；PR #29 任务稿的 47/47、98.38/87.05/100、192=184+1+7 **完全一致**，但 **PR 正文仍写 45/45 与 98.17/86.16，已过期**（P3，建议同步）；PR #32 任务稿的 10/10、57/57、202=194+1+7 一致，覆盖率仅 context.ts 一处差异（P3，建议核对来源）。供应商网络调用实测为 0：SDK 测试全部注入内存 fetch、`baseURL=offline.invalid`；未发现凭据或 token 字面量进入代码与文档。

真实 provider 调用、D-02 账号/条款/数据/配额与凭据付费授权、Linux 复验、教师内容会审、30 次性能、人工教学语义（B4）、浏览器/TLS 与完整 G1/G2/MVP **均未执行**；合成结果与离线 transport 不替代这些验收。

### 9.6 已发布评审与回读

| PR | 评审 | 平台状态 | 固定 commit | 行内意见 |
| --- | --- | --- | --- | --- |
| #28 | [5483718569](https://github.com/paher-din/XunJie/pull/28#pullrequestreview-5483718569) | CHANGES_REQUESTED | `21a1b09378` | [design-agent.test.ts:427](https://github.com/paher-din/XunJie/pull/28#discussion_r4241983436)、[:464](https://github.com/paher-din/XunJie/pull/28#discussion_r4241983442) |
| #29 | [5483718753](https://github.com/paher-din/XunJie/pull/29#pullrequestreview-5483718753) | APPROVED | `de794ba38e` | 无 |
| #32 | [5483718927](https://github.com/paher-din/XunJie/pull/32#pullrequestreview-5483718927) | COMMENTED | `fdec49d86d` | [service.ts:30](https://github.com/paher-din/XunJie/pull/32#discussion_r4241983813)、[application.ts:176](https://github.com/paher-din/XunJie/pull/32#discussion_r4241983816)、[context.ts:215](https://github.com/paher-din/XunJie/pull/32#discussion_r4241983820) |

提交前后各回读一次 head，三个 PR 的 head 均未变。发布身份 `paher-din`，#28 作者 `czr112`、#29/#32 作者 `scy404`，均为其他账号。用结构化 UTF-8 JSON 经 `gh api POST .../reviews --input` 提交，无重复请求、无额外评论、无成员消息。独立回读三份 review 的 body 长度、`commit_id`、`state` 与发布账号，以及经完整 PR comments 接口逐条核对 5 条行内意见的 `path`、`line`、`side=RIGHT`、`commit_id`，全部与准备稿一致。

发布后平台状态：#28 OPEN / reviewDecision=CHANGES_REQUESTED，#29 OPEN / reviewDecision=APPROVED，#32 OPEN / Draft（COMMENTED 不设 decision）。**三个 PR 均未合并，#25/#26/#11/#27 均未关闭，未解决任何审查线程，未代作者修改代码。**

#29 转 Approve 的依据是其自身三项原发现已按根因修复且全部声明数字本机复现一致；该批准**不构成合并授权**，合并顺序按 §9.3 执行，且需负责人另行授权。#28 保留 Request Changes 是因为存在 §9.3 的合并阻塞项，非上轮两项未修复。#32 为 Draft、上游 #29 未合并、#27 未交付，作者已声明不可合并，故只记录发现不请求变更也不批准。

本次不将审查发布记为修复通过或产品验收。第 7 节的原失败/跳过与真实模型/节点/UI/真人未执行继续保持；MVP_SPEC §10 与 TEAM 的基线进度待授权维护者汇总，本文不直接修改受保护基线。

### 9.7 发布后状态变化：PR #29 已合并，§9.3 阻塞项已生效

§9.6 的「三个 PR 均未合并」描述的是发布时刻（14:45Z）。**发布约两分钟后，项目负责人于 2026-10-11T14:47:35Z 合并了 PR #29**，合并提交 `83e528ecd3d3de7a13e6addc57ba9111860b06f7`（parents `0afd008` + `de794ba`），合并人 `paher-din`，平台状态 MERGED / reviewDecision=APPROVED。这与 §9.3 建议的顺序一致；合并由负责人执行，本次审查未合并任何 PR。

对合并后的真实 main 重新实测（同一批准运行时，独立工作树）：

| 检查 | main `83e528e` 本体 | main `83e528e` + PR #28 head `21a1b09` 试合并 |
| --- | --- | --- |
| 工作树 | 0 个被跟踪文件修改 | 自动合并 0 源码冲突（README 自动保留两侧） |
| `npm run typecheck` | 通过 | **失败**：`tests/design-agent.test.ts(427,44)` 与 `(464,44)` 各报 `TS2353: 'countTokens' does not exist in type '{ invoke: DeepSeekInvoker; }'` |
| `npm run build` | 通过 | 通过（`tsconfig.build.json` 不含 tests） |
| 模块专项 | B1 `server/tutoring/test/*.test.ts` 47/47 | A3 `tests/design-agent.test.ts` 25 项：23 通过、**2 失败**（两条预检反例实得 `success` / `unavailable`，期望 `needs_input`） |
| `npm test` | 192 项：184 通过、1 失败、7 跳过 | 217 项：207 通过、**3 失败**、7 跳过 |
| 文档检查 | `errors=[]`，32 份 | 试合并后已 `git merge --abort`，工作树回到 `83e528e` |

两侧的唯一既有失败仍为 `server/workspace/review.test.ts:120` → `runner/control.ts:48` 的 Linux-only RunControl，与 `c42f356` 无差异。**结论：main 本体健康；§9.3 的阻塞项已不再是推演，PR #28 按当前 head 合入即会让 main 的 typecheck 失败并使 A3-R02 的两条反例失效，必须先由 A 适配那两行再合并。**

测量口径说明：本节 typecheck 结果以打印的 `TS2353` 错误行为准；该脚本把输出经管道交给 `tail`，`$?` 捕获的是 `tail` 而非 `npm` 的退出码，故不引用其 `EXIT_TYPECHECK`。§9.3 中 `21a1b09 + de794ba` 预合并树为无管道运行，捕获到 `EXIT_TYPECHECK=1`，与错误行一致。

PR #29 合并后，PR #32 的堆叠父已进入 main：三点对比 `origin/main...fdec49d` 现为 8 文件、+1767 行，即纯 B2 增量，B1 部分不再重复计入。GitHub 侧 base 仍显示 `0afd008`、`mergeable=UNKNOWN`（平台重算中），文件计数 14/+2458/-52 属重算前的旧值；本节结论以本地三点对比为准。#32 仍为 Draft、未合并，§9.2 的 3 项 P2 与 #27 依赖不变。

本节不改变 §9.2～§9.6 的审查结论，只补充发布后的真实平台状态与对 main 的复验；#25/#26/#11/#27 均未关闭，未解决任何审查线程，未代作者修改代码。

## 10. 2026-10-11 PR #33 首审发布与 PR #28 阻塞解除后合并

本节记录负责人两项指令的执行结果：先发布 PR #33 的 COMMENT 审查，再复审 PR #28；并在「如果 #28 做好了可以直接合并了」这一条件授权下，经复验确认条件成立后执行合并。全部事件发生在 2026-10-11（UTC），本文写于 2026-10-11T16:00Z（Asia/Shanghai 2026-10-12 00:00）。

### 10.1 审查点与工作树

| 对象 | 固定审查点 | 工作树 |
| --- | --- | --- |
| PR #33（C3 教学消息与回执） | merge-base `83e528e` → head `9fc9fae3`，19 文件 +2378/-56 | `p3-pr33-review` |
| PR #28 复审 | 上轮 head `21a1b093` → 本次 head `26f37c52`，增量 4 提交（`161ffb3` 合并 main、`803c10e` 适配、`3b934c6`/`26f37c5` 记录） | `p3-pr28-v2`（head 单独）、`p3-pr28-onmain`（预合并到 main） |

期间 main 两次前移：`83e528e` → `5901a8a` → `8a6c70cf`（`docs: integrate digital logic into post-P2 assignments`）。`8a6c70cf` 相对 `5901a8a` 只改 6 份文档（AGENTS.md、README.md、TEAM_WORK_PLAN.md、MVP_SPEC.md、TECH_DESIGN.md、DL-0），`git diff --stat 5901a8a 8a6c70cf -- apps/` 为空，且其正文明确「当前 P2 的 A3/B2/C3、任务记录与退出条件保持不变」，故 A3 的 M/AC 义务与本轮审查结论对新基线继续成立。主副本 `D:/XunJie` 未被本工作项改动；所有验证在独立工作树内进行。

### 10.2 PR #33 首次人工审查与发布

已发布评审 `5483853761`，state=COMMENTED，2026-10-11T15:30:34Z，账号 `paher-din`；行内意见 5 条：`4242122568`（`server/records/teaching.ts:414`）、`4242122569`（`server/records/application.ts:282`）、`4242122570`（任务稿:236）、`4242122573`（任务稿:237）、`4242122574`（任务稿:201）。发布后回读 PR #33 仍为 OPEN、非 Draft、head `9fc9fae3` 未变、reviewDecision 为空（COMMENT 不设决定）。

**评审形式限制已如实写明：** PR #33 作者是 `paher-din`，与审查发布身份同一账号，GitHub 不允许对自己的 PR 提 APPROVE 或 REQUEST_CHANGES，因此只能以 COMMENT 记录。C3 是目前唯一由负责人账号交付的线（#28 作者 `czr112`、#29/#32 作者 `scy404`），**这条线结构上缺少独立审查**；该 COMMENT 不构成批准，合并决定与责任仍在负责人。

结论要点：Standards 硬性违规 0；Spec 侧 5 项 P2、9 项 P3。5 项 P2 为（1）学生教学路径 3 次调用预算无人执行、`attemptCount` 以 `Math.max` 落库且持久 schema 封顶 3，跨 worker 累计计账结构上不可能；（2）`leaseToken` 可选且默认回填当前持有者 token，使 #27 要求的租约复查在省略字段时空转；（3）任务稿 §8.4 关于 `better-sqlite3@13.0.3` 无 Windows 预编译产物的断言不实（实测 `prebuilds/win32-x64.node` 存在，1,989,632 字节）且该断言承重；（4）§8.4「不是 C3 代码路径」的归因未被证明，其对照基线 `e13f12d` 本身已含 C3；（5）§8.2 三处描述了交付中不存在的改动（`access/app.ts`、事务白名单加 DELETE、公开 `invalidatedActionIds`）。

其中第 1 项与 §9 记录的 A 侧发现是**同一个跨模块缺口，现已从 A 与 C 两侧同时确认**：上限只由 `records/jobs.ts` 的 `recordModelCall` 持有，而它在 main 上没有生产调用方；`db/records-adapter.ts:21` 把 `attemptCount` 约束为 `natural.max(3)`；`contracts/records` 未定义 `calls` 语义。需 A/B/C 共同裁定，不因任何单个 PR 合并而关闭。

审查中也修正了自动子代理的两项过度断言：其声称的两项 P1 经核实存在缓解（`assertLease` 仍强制 `leaseUntil > now`、`claimJob` 要求 `status==='queued'`、`recoverJob` 只处理过期租约、`completeTeaching` 在 main 上无生产 HTTP 路由，只有 `test-support.ts:52` 的 `/fixture/complete/:id`），故降为 P2；其称 §11.2「全回滚」超出证据也不成立——`teaching-review.test.ts:44～47` 的 `snapshot()` 确实抓取并 `deepEqual` 比对全部 9 张表且要求 503，窄的只是 3 个注入点。

未合并 PR #33、未关闭 #27、未解决任何审查线程、未代 C 改代码。

### 10.3 PR #28 阻塞项解除与复验

§9.3/§9.7 的合并阻塞项（#29 收窄 `createDeepSeekProvider` 为 `{ invoke }` 并移除 `TokenCounter`，使本 PR 两条 A3-R02 反例注入的 `countTokens` 报 `TS2353` 且 `InputLimitError` 不再抛出）已由 A 在 `803c10e` 按建议顺序（#29 先合）自行适配。改动仅限 A 的边界：`server/design/teacher-agent.ts` +1 行注释（即上轮 P3-2 建议的有意行为说明）与 `tests/design-agent.test.ts` 两条反例改为在外部 provider 边界脚本化预检失败；未触碰 B/C 源码、共享契约、受保护文档、凭据、CI 或 schema。

反例证明力未被弱化：`input preflight rejection…` 改用真实输入使保守上界确实超限，断言 `rejectedInputTokens > 16000`、`outbound === 0`、`attemptCount === 0`、`usages` 为空、`proposalId` 未定义，并在 `f.reopen()` 后复验跨重启保持；`a second call rejected by preflight…` 断言 `preflights === 2`、`outbound === 1`、`calls === 1`，首次已发送调用的 `{status:'actual',inputTokens:10,outputTokens:4}` 完整保留。`records/jobs.ts` 的 `attemptCount >= 3` 上限、`receiveResult` 的迟到正文拒绝与过期 `timed_out/deadline` 均未放宽，A3-R01/A3-R02 本体代码未回退。新增 `acceptance.a3-b1-compat-red.windows.txt`（52 行）如实留档适配前的红运行；`acceptance.a3-b1-compat.evidence.json` 的 `boundary` 段明确写 `secondPreflight: "Scripted external ModelProvider preflight error after one synthetic sent call; no claim of two actual provider input sizes"`、`sharedReleaseApi: "Proposal only; pending A/C review"`，未把替身证明冒充真实 provider 证明。

实际验证（Windows / Node 24.21.0 / TypeScript 7.0.2，两个独立工作树）：

| 检查 | head `26f37c52` 单独 | 预合并到 main `8a6c70cf` |
| --- | --- | --- |
| 自动合并 | — | 0 冲突，README 自动合并，24 文件 +2683/-7 |
| `npm run typecheck` / `npm run build` | 通过 / 通过 | 通过 / 通过（`EXIT_TYPECHECK=0`、`EXIT_BUILD=0`） |
| `node --test tests/design-agent.test.ts` | 25 通过 / 0 失败 / 0 跳过 | 25 通过 / 0 失败 / 0 跳过 |
| `npm test` | 217 项：209 通过 / 1 失败 / 7 跳过 | 第 1 次 217：208 通过 / **2 失败** / 7 跳过；第 2 次（同一棵树未改动）217：209 通过 / 1 失败 / 7 跳过 |
| 文档检查 / 自测 | `errors=[]`，33 份 / 16 通过 | `errors=[]`，34 份、27 条正式路由 / 16 通过 |
| 证据完整性 | 5 份 `.txt` 的 SHA-256 与字节数与清单逐一相符 | 同左 |

对照 §9.7 组合树的 3 失败，本次稳定为 1 失败，2 项差值正是被修好的两条反例；`217/209/1/7` 与作者在 `acceptance.a3-b1-compat.evidence.json` 中声明的全量结果逐项一致（作者如实把全量标为 `status: failed`，因存在既有基线失败项）。

### 10.4 合并授权、批准与合并结果

负责人指令原文为「两个都做，如果#28做好了可以直接合并了」，即合并以「#28 做好了」为条件。§10.3 的复验确认该条件成立后执行合并，未扩大授权范围。

- 合并前再次回读：head 仍为 `26f37c52b845f755b0afd5594b14b6523857b6e4`、`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`。
- 提交 APPROVE 评审 `5483933168`（2026-10-11T15:55:50Z，`paher-din`），reviewDecision 由 `CHANGES_REQUESTED`（`5483718569`，14:45:28Z）转为 `APPROVED`。
- 合并于 2026-10-11T15:56:08Z 由 `paher-din` 执行，PR #28 状态 MERGED，合并提交 `347dde1555f8635e9f5dae80aaa2a018f33e79c4`，parents 为 `8a6c70cfa582ef0f7a574a66729a97bc332f737a` + `26f37c52b845f755b0afd5594b14b6523857b6e4`，与 §9 建议的 merge commit 方式一致（对照 #29 的 `83e528e`）。
- 远端 main 回读为 `347dde1`，`git fetch` 快进 `8a6c70c..347dde1`，未使用强制推送。
- **树同一性核验：** 合并提交的 tree 为 `ba94c6681eb7229578990603943221e185edadab`，与我在 `p3-pr28-onmain` 中预合并后 `git write-tree` 得到的树哈希逐字节相同，即实际落地内容与我复验过的内容完全一致。

### 10.5 合并后 main 复验

在独立工作树检出真实合并提交 `347dde1`（tree `ba94c668`、0 个被跟踪文件修改、0 未合并项）后实测：

| 检查 | main `347dde1` 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`EXIT_TYPECHECK=0`） |
| `npm run build` | 通过（`EXIT_BUILD=0`） |
| `node --test tests/design-agent.test.ts` | 25 通过 / 0 失败 / 0 跳过 |
| `npm test` | 217 项：209 通过 / 1 失败 / 7 跳过（60.6s） |
| 唯一失败 | `review: real RunControl preparation failure ends check without fabricating a RunRecord` → `runner/control.ts:48` `Linux and trusted control context required`，Windows 上的既有基线项，与 §9.7 记录的 main 本体失败为同一条 |
| `git diff --check 8a6c70cf 347dde1` | 无空白问题 |
| 文档检查 / 自测 | `errors=[]`，34 份文档、27 条正式路由；检查器自测 16/16 |

结论：**合并后 main 健康**，typecheck 阻塞已消除，唯一失败为既有的 Linux-only 基线项，非本次合并引入。

### 10.6 新发现：既有 flaky 计时断言（属 B，本次未修）

§10.3 预合并树的第 1 次全量运行多出 1 项失败：`server/tutoring/test/index.test.ts:361` `cancellation interrupts a provider that ignores AbortSignal`，失败点是 `:373` 的 `assert.ok(Date.now() - startedAt < 80)`，实测 105.04ms。**两条功能断言 `:371 result.outcome === "cancelled"` 与 `:372 result.calls === 1` 均通过**，即取消语义正确，只有墙钟阈值被突破。

判定为负载敏感的既有 flaky，依据四点：该测试用 `setTimeout(() => controller.abort(), 5)` 对 `setTimeout(resolve, 100)` 的 provider 计时并断言总耗时 `< 80ms`，而同批全量运行中并发着多个 2.4s～7.5s 的真实 SQLite 用例，5ms 定时器被事件循环延后即可越界；`git diff --cached 8a6c70cf -- apps/teaching/server/tutoring apps/teaching/contracts/tutoring` 为空，预合并树的 tutoring 代码与新 main 逐字节相同，PR #28 只改 README、`contracts/design/proposals.ts`、`server/db/transaction.ts`、`server/design/*`、`tests/design-agent.test.ts`、`tests/evidence/a3/*` 与 A3 任务稿；`git blame` 显示该断言自 `cdc4ac4b`（2026-10-09，B 侧）即在 main 上，早于 PR #28 全部改动；单独运行该文件 6 次全部通过（14.5～15.9ms），随后在未改动的同一棵预合并树上重跑全量即回到 217/209/1/7。

建议（属 B，不由 A 的 PR 修）：该断言把「取消是否抢在 provider 返回前」这一语义事实用墙钟阈值表达，在全量并发下不可靠，宜改为断言语义结果并用可控时钟或更宽阈值，或把计时断言移到隔离运行。此项应作为 main 基线的独立待办登记，不因 PR #28 合并而关闭；本次未修改该测试，也未通过跳过、注释或放宽断言掩盖它。

### 10.7 边界与未执行

本次未修改任何受保护文档（`docs/product/**`、`AGENTS.md`、`docs/planning/**`、`docs/reference/**`），未改 `.env`/密钥/CI/schema，未删除文件或 Git 历史，未强制推送，未代任何作者修改业务代码。本文是本轮唯一被提交的文件。

未合并 PR #33、未合并 PR #32（仍为 Draft，§9.2 的 3 项 P2 与 #27 依赖不变）；#24/#25/#26/#27/#11 均未关闭；PR #28 的合并只关闭该 PR 本身，未解决 #33 的任何审查线程，也未关闭 A3 的后续义务。真实 provider 调用 / D-02 / 真实模型 / Linux 复验 / 教师内容会审 / 浏览器与实际 UI / 真人与负载 / C5 备份恢复 / 完整 G1～G4 与 MVP 验收均保持未执行；服务端通过、文档交付与本次合并均不构成产品验收或教学效果证据。MVP_SPEC §10 与 TEAM 的基线进度仍待授权维护者汇总，本文不直接修改受保护基线。
