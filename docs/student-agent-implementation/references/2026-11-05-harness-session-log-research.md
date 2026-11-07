# DeepSeek Harness session log 研究与 WP07 取舍

**结论：WP07 将 session log 纳入运行底座，保存跨 Run 的追加历史和每次模型请求的可重建依据。** Harness 最有价值的设计是区分完整事件、模型当前上下文与人看到的对话，明确持久屏障，并在恢复时保留未知效果。循阶沿用 PostgreSQL、WP06 原生模型记录和 WP03 执行事实，补足最终答复/终态持久确认；无需为这些收益改换既定 RunDriver 或引入整套框架。以上取舍已随 [WP07：持久 Agent 与学习对话](https://github.com/paher-din/XunJie/issues/196)于 2026-11-05 经 Robert 确认并发布，尚未实施。

研究日：2026-11-05；目标提交时间 2026-11-04 16:40 +08:00，合并 release 0.2.2-rc.1 到 master。官方仓库固定提交 [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)。GitHub connector 读取官方 README、session/agent-loop README 和 persistence 文档后，以临时浅检出的实际源码与测试交叉核实；检出 HEAD 与目标 SHA 完全一致。以下 **F 为上游事实，I 为给 XunJie 的建议或推论**。

## 1. Session 是追加历史，模型消息由它派生

**F：SessionEvent 是可扩展的有序事件流，`seq` 连续，事件内容必须可无损 JSON 序列化。** append 校验、复制并冻结内容，避免调用方之后修改输入而篡改日志；Session 层的 append 同步提交到内存，真正落盘另由持久层负责。[C1] · [C2] 测试验证事件派生、seed 恢复一致、输入隔离、连续序号及非 JSON 数据拒绝。[CT1] · [CT4]

| 记录 | F：上游保存的事实 | 对 WP07 的意义（I） |
| --- | --- | --- |
| `turn/start/end`、`step/start/end` | 一次 turn 与模型/工具步骤的边界和结束原因。 | 学习活动跨多个 Run；保留各 Run 的边界，不能只留下最后一份 messages。 |
| `system/message`、`developer/message`、`user/message` | 实际系统提示、增量指令、用户消息或带来源的注入内容。 | 记录实际装配内容和来源，不把系统注入伪装成学生输入。 |
| `request/header` | 调用配置、adapter 生效默认值与完整工具 schema；不变时可复用最近快照。 | 固定每次请求采用的配置/工具版本，重启不重新读当前设置冒充旧请求。 |
| `assistant/message`、`assistant/attempt` | 已结算消息及带时序的 adapter 流；没有提交模型可见消息的失败/重试等 attempt 单独留存。 | 完整结果、中断片段与失败尝试分开；不完整参数不能派发工具。 |
| `tool/call`、`tool/result` | 工具开始记录与配对结果；结果可带工具私有展示 metadata。 | 将模型反馈、学生卡片和真实执行结果稳定关联；实际副作用仍由执行器回执确认。 |

以上事件定义见 [C1]；`tool/call` 的实际写入时机见第 4 节。当前 assistant 流嵌在一次结算事件中，不代表每个 live delta 都已经独立落盘。[C1]

## 2. 模型上下文、原生记录与压缩

**F：`surface` 表示当前参与模型消息装配的有序事件节点，`deriveMessages()` 按它派生历史。** turn/step 边界、失败 attempt 等不直接成为模型消息。`surfaceOp: replace` 通过新增事件替换视图中的范围，并保存来源，不修改原事件；代码明确人类 transcript 应取 append-origin 内容，否则压缩会抹掉用户已经看过的交流。[C3] · [C4] 对应测试覆盖 replacement 派生与 append/replacement 来源区分。[CT2]

**F：请求恢复使用同一日志前缀中的消息投影和最近完整 `request/header`。** header 保存 config、adapter defaults、tool schemas，系统提示属于消息事件；`foldRequestHeader` 是独立纯读取函数。developer 工具增量还引用当时 header 的 seq，恢复不能重新按当前工具名查定义；测试保留旧定义穿过 replacement、restore 和 fork。[C5] · [C6] · [CT3]

**F：日志内的“原始流”是 adapter 输出的 `StreamChunk`，不等于供应商全部 HTTP/SSE 字节。** `ReplayEnvelope` 另留 adapter 私有 JSON 状态，分 response 与可选逐块 metadata；逐块数量不符时丢弃 envelope。是否完整保留某供应商原生字段仍取决于 adapter，不能仅凭 SessionEvent 的无损 JSON 承诺三协议原件保真。[C7] **I：循阶继续由 WP06 保存并校验实际协议 payload、原生结果、reasoning/签名与工具身份，session log 保存构造依据和可靠关联。**[X1]

**F：compaction 追加 `compaction/start`、摘要、带替换范围/来源的 checkpoint 消息及 `compaction/end`。** 摘要记录 provider/model、usage 和被遮蔽事件；只替换模型视图，原日志保留。选择范围需满足工具配对与步骤边界，摘要返回后再确认选中内容未变化；它不是简单将 `messages` 截短后覆盖磁盘。[C8] **I：WP07 先建立可重建记录，压缩策略与摘要生成仍由 WP08 实现；采用摘要时保留来源并沿 WP06 的新段规则。**[X1]

**F：另有 `session-log-deepseek` 插件，将日志增量放进官方 DeepSeek 请求的 `dsh_session_log` 扩展字段。** 插件配置默认 enabled，按 accepted seq 水位续传、默认每次上限 8 MiB，接受水位也追加进日志；尚未持久确认的尾部可能重传。这是独立于 messages 的上传功能，不能把采用本地 session log 理解成必须启用它。[C9] **I：WP07 不引入全量日志第三方上传；WP13 继续按既定可选观测边界实施。**[X2]

## 3. append、后台写入与持久屏障

- **F：三层不能混为一谈。** Session 内存追加产生同步事件；持久层 `SessionHandle.append()` 的通用契约只保证接受、排序和本 backend 实例可见，只有成功的 `flush()` 承诺抗崩溃及对其他进程物化。当前 JSONL 实现更强：每批 append 执行文件写入与 `sync()`；但 Session 事件先进入后台缓冲，不能把此保证反推给 `session.append()`。[P1] · [P2] · [P3]
- **F：JSONL 后台批窗口为 200 ms，从首个 pending event 起计，后续事件不重置。** `session/flush` 先 `drainLive()` 再 handle flush；drain 经同一 mutation chain 串行执行，并发 drain 共用一个 Promise，写入期间新增事件继续排空。后台失败保留原顺序、暂停自动重试并告警；显式 flush 重试，失败向调用方抛出。200 ms 只限制主动批等待，不保证磁盘延迟上限。[P2] · [P4] · [P21] 测试检查窗口路由、失败留队、暂停及恢复后无重复 seq；其中“exactly once”只指日志批重试。[T1]
- **F：`ctx.sessions.flush(session)` 等所有持久 listener 结算，失败后抛出首个注册 listener 的错误；无 listener 时返回 false。** 所以单独调用该 API 不证明配置了持久存储；policy 明确依赖 `sessionPersistence` 服务。[P5] · [P6]

## 4. 模型请求及工具副作用之前的屏障

| 位置 | F：实际顺序与覆盖范围 | 源码 / 测试 |
| --- | --- | --- |
| 模型请求 | 对存在的 live `sessionId`，async generator 先 await session flush，之后才构造/迭代下游 stream；失败不调用 adapter。无 sessionId 或 id 已脱离 live store 时直接放行。 | [P6] / [T2] |
| 顶层工具 | batch 先 append `tool/call`，再 prepare，之后经过 `tools/execute` wrapper：先 flush，再复查取消，最后进入工具体；flush 失败转换为工具错误结果，工具体不运行。 | [P6] · [P7] · [P22] / [T3] |
| 嵌套及无 Agent 工具 | `exec.parent !== undefined` 或无 `exec.agent` 时跳过此 policy 屏障；嵌套复用外层持久记录，不逐条保存内部业务命令的 intent。 | [P6] / [T3] |
| 后续步骤 | `agent/pre-step` 先 flush 再继续，覆盖此前已追加的 response/result/step 记录；当前请求装配后还会经过模型 stream 前屏障。 | [P6] / [T3] |

**F：持久 backend 与 checkpoint policy 是两个部件，仅挂 JSONL 不自动获得副作用前屏障。** policy 的监听点也不是通用事务：`tool/call` 是调度开始记录，写在 prepare/approval 之前；存在 start 记录不等于工具体确实执行。[P6] · [P7]

**I：WP07 可以借鉴“完整请求 / 工具 intent → 持久确认 → 派发”的顺序，但应把所需 policy 与 backend 组合列为运行契约。** 对嵌套实验命令或独立执行节点，需要业务自己的 command ID、intent、回执和状态查询；不能用外层 tool/call 代替。

## 5. turn 结束、idle 与 shutdown 的裁决

**F：当前 loop 不在 turn 边界 await flush。** driver 在 `finally` 仅 append `turn/end`；`types.ts` 明确消费者在 `whenIdle()` 后读存储时应自行 flush。policy 的“完成步骤检查点”实际位于下一次 `agent/pre-step`，不能解释成最终 turn/end 的同步持久确认。[P8] · [P9] · [P6]

**F：正常关闭会尝试 drain，但不能据此把活跃根关闭写成持久承诺。** handle close 在释放写锁前排空已路由缓冲，backend teardown 也 close 所有 handle；`session/disposed` 的 close 失败只告警。shutdown 回归测试的两个挂载顺序均先等待 idle 再关闭，核实 completed turn/end 保存；它没有覆盖活跃请求中直接 root shutdown。当前 agent-loop README 仍明确后者的最终 turn/end 可能只在内存。[P4] · [P10] · [T4]

**I：如果 XunJie 的“运行完成”回执要求可恢复，应显式等待最终结果和终态的持久屏障，再对外确认完成；idle、取消结束或 Agent teardown 本身不足以充当这张回执。**

## 6. 单写者与并发的真实边界

- **F：已有 session 的 write open 先取得进程内 claim，再取得跨进程锁，之后读/迁移；resume 使用这个 write handle 直到其生命周期结束。** 同 id 第二个写者报 `SessionAlreadyOwnedError`，read handle 不拿写锁；同 handle 变更通过 Promise chain 串行。[P11] · [P12] · [P13] 测试同时覆盖 live agent 不可被 resume 修复，以及另一进程持锁时写拒绝、读正常、SIGKILL 后可接管。[T5] · [T6]
- **F：JSONL 跨进程排他依赖本机内核。** POSIX 使用非阻塞 flock 并校验锁文件 inode；Windows 使用路径派生命名内核 semaphore。没有按时间到期的租约抢占；进程死亡释放锁，活着但卡住的写者持续持有。新建但未物化 session 先只有进程内 claim，首次物化才获取跨进程锁。[P12] · [P14]
- **F：读一致性没有被夸大为线性一致的分布式数据库。** 契约保证同 backend 实例中，append/flush 成功后才开始的读取至少看到此前缀；并发读写只保证有效连续前缀，同 handle 已观察的前缀不倒退。[P1]

**I：多副本 XunJie 需要自己的会话执行所有权与 fencing/事务机制；不能把本机 flock/semaphore 推广成跨机器数据库或外部执行器的防重保证。**

## 7. 物理尾部与语义恢复分层

**F：persistence 保留未完成 turn 的有效前缀，不按最后 turn/end 回滚工作，也不自行补语义终态。** raw JSONL 未结束行不返回；首次新 append 才在写锁下截去坏尾。压缩路径还会从 torn Zstandard 最后一帧提取完整 JSONL records，写路径先截帧，再持久重写这些完整记录，最后写新批次；完整帧包含不完整 JSONL record 则拒绝。[P13] · [P15] · [P16] · [T7] · [T8]

**F：恢复读取不只是“忽略半行”。** 当前 recoverable scanner 对末尾部分 JSON 解析失败、decode 失败或 seq gap 保留其之前的连续前缀；若坏记录后出现 `turn/end`，按已提交区域损坏拒绝。结构准入检查先于此容错，某些畸形 message/tool-result 即便在尾部也直接拒绝。不能概括成“任何损坏都自动修好”或“只丢未换行字节”。这里 `turn/end` 用于判断损坏范围，不代表 loop await 了磁盘持久化。[P15] · [T9]

**F：resume 的顺序为 `open(write) → read → interruptedTurnClosers → handle.append(closers) → prepare/publish`。** closers 是普通追加批，不覆盖旧记录；JSONL 的 append 成功即持久，使修复先于发布落盘。resume 本身调用的是 handle append，未额外调用通用 flush，故不能仅凭此实现向任意第三方 backend 推定修复已抗崩溃。[P1] · [P3] · [P13] 集成测试确认缺失 result/step/end/turn/end 连续写入、torn tail 后继续，以及二次 resume 不重复追加已有修复后缀。[T5] · [T17]

**F：语义恢复关闭中断的旧 turn，不从旧 Promise / 工具调用指令处自动继续执行。** 对未回答 assistant tool request，先补 error tool/result，再补仍开放的 step/end，最后 turn/end `{ kind: 'interrupted' }`；seq 接续，time 复用最后真实事件，合成身份确定。已经 closed 的 step/turn 不追溯修复；空或平衡日志返回空 closers。[P17] · [T10]

| 持久前缀中的事实 | F：补写结果 | 能确认 / 不能确认 |
| --- | --- | --- |
| assistant 请求了工具，无对应 tool/call | `TOOL_NOT_STARTED` | 仅确认没有 start 记录；有完整顶层屏障的路径才可据此推断工具体未派发。缺少 policy 或绕过该路径时，不可证明外部无效果。 |
| 有 tool/call，无对应 tool/result | `TOOL_OUTCOME_UNKNOWN` | 可能尚未进入工具体、正在执行或已完成但结果未保存；上游提示只读/幂等可考虑重试，有副作用需先核验外部状态，不能盲重试。 |
| 同 step/turn 已有 append tool/result | 保留已有结果 | 不替换成 synthetic error；错误 step/turn 或 replacement result 不会消除 pending。 |

表中上游行为及判别源码：[P17]；单测：[T10]。硬崩溃 E2E 在 mock adapter 派发或工具副作用 marker 后 SIGKILL，确认请求前缀/工具 intent 可读且未返回结果归为 unknown；该 E2E 在 Windows 跳过。[T11]

**I：这提供的是日志一致性恢复与不确定性表达，不是外部副作用 exactly-once。** WP07 应把 unknown 保留为可查证状态，结合业务幂等键和执行器回执决定查询、等待或重试；恢复提示语不能替代服务端决策。

## 8. 格式升级与拒绝读取

- **F：当前逻辑格式是 V4，静态 catalog 装配 V0→V1→V2→V3→V4 codec/迁移链，不依赖动态挂载历史插件。** 历史只读 open 可返回内存迁移结果，不发布新文件；write open 持写锁后发布当前 generation，保留历史源。stat/list 只分类并翻译 header，不扫 body 触发迁移。[P11] · [P18] · [T12] · [T14]
- **F：选最高 canonical generation；存在未来版本时不回退读取旧文件。** 定向 open/stat 报 `SessionFormatUnsupportedError`，测试中的 list 会过滤该不支持项；这不是“文件不存在”。实际 parse/validation 损坏另报 `SessionPersistenceCorruptionError` 并附 raw path。[P19] · [T15]
- **F：当前格式保留 unknown `ignorable: true` 记录，其 payload 不参与已知事件语义解释；unknown required type 拒绝。** 已知类型即便标 ignorable 仍需校验。历史迁移不是无限前向兼容：例如 V0 unknown 即便 ignorable 仍拒绝且保留源文件。[P20] · [T13] · [T16]

**I：WP07 应分别处理“需要较新 reader / 不可迁移”与“数据损坏”，不要静默回退较旧日志、忽略必要事件或就地覆盖原件。**

## 9. WP07 的具体落点

以下均为 **I：基于研究形成的规划取舍，已纳入负责人确认的 [WP07 规范母票](https://github.com/paher-din/XunJie/issues/196)，尚未实施**。

| 决策 | WP07 方案与可观察验收 |
| --- | --- |
| 所属记录 | 一个活动一份跨 Run 的 session log，Agent owner 使用 PostgreSQL；状态、输入消费、事件与待发工作同事务，原生结果和执行事实继续由各 owner 持有。 |
| 请求重建 | 保存实际提示、帮助策略、工具定义、固定输入、选中事件顺序、模型配置及装配版本；正文或不可变资源可读取，hash/路径/当前配置指针不足。与受控 transport 实际收到的请求及 WP06 原件核对。 |
| 三种读取 | 完整事件、学生对话、模型上下文按职责派生；本轮历史选择、steering/queue、换段不抹旧对话，不将未消费消息提前发给模型。 |
| 持久屏障 | 请求快照/待发项提交后发模型；完整原生结果关联与意图提交后发工具；最终答复/终态提交后确认完成。提交失败或回包丢失均按原身份核对。 |
| 恢复 | 只读重建不触发模型/工具；RunDriver 凭状态、代际、预算和业务 command 回执决定继续。unknown 等待核验，晚结果归原操作，不照搬 Harness 的“关闭旧 turn”为本项目续跑语义。 |
| 后续边界 | WP07 实现记录与快照；WP08 实现压缩/上下文策略，摘要不删除来源；WP13 实现可选观测/调试包，运行事实不依赖它。 |

上述检验继续走 WP07 的生产接收/RunDriver/查询与既有模型 transport 边界，不增加内部日志类的独立验收入口。真实模型/工具、Windows/Mac Chrome、跨机与教学效果仍分别报告。

## 10. 与 2026-10-27 研究的关系及验证记录

此前[内核复用研究](2026-10-27-agent-kernel-reuse-research.md)固定的是 `22ddee3…`。其中“backend 与 policy 分离、未知工具效果、root shutdown 最终事件限制”的结论与本次核实一致。本次补足了 200 ms 后台窗口、handle/跨进程所有权、V4 generation、坏尾准入和具体测试证据；没有逐提交比较，不能把这些全称为 10-27 后新增。任何“turn 结束即 await flush”的描述均应按当前 driver / types 裁决为不成立。[P8] · [P9]

已读：官方文档、Session event/surface/header、compaction、adapter replay 类型、日志上传插件，以及持久化、checkpoint、工具派发屏障、resume、repair、scanner、format catalog 源码；下列测试的相关用例与断言。未运行：全部上游测试、真实 SIGKILL 实验、模型调用、XunJie 工程/浏览器/教学效果测试；未安装依赖。测试存在与源码吻合不等于本机执行通过。本次创建的临时公开仓库检出已清理。

## 固定提交证据索引

[C1]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L239-L411
[C2]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L787-L836
[C3]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/surface.ts#L78-L150
[C4]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L981-L1017
[C5]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/request-header.ts#L14-L68
[C6]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/surface.ts#L367-L394
[C7]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/types.ts#L467-L507
[C8]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/region.ts#L179-L509
[C9]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-log-deepseek/src/index.ts#L47-L291
[CT1]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/tests/session.spec.ts#L34-L158
[CT2]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/tests/surface.spec.ts#L690-L879
[CT3]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/tests/developer-header.spec.ts#L23-L61
[CT4]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/tests/session.spec.ts#L589-L705
[X1]: ../specs/wp06-model-connections.md#6-原生结果的持久保存与恢复
[X2]: 2026-10-27-agent-evaluation-integration.md
[P1]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence/src/handle.ts#L45-L116
[P2]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/storage.ts#L35-L36
[P3]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/index.ts#L1409-L1462
[P4]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/storage.ts#L223-L315
[P5]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L1335-L1358
[P6]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-checkpoint-policy/src/index.ts#L17-L82
[P7]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/batch.ts#L154-L265
[P8]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L374-L426
[P9]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L295-L303
[P10]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/README.md#L216-L216
[P11]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/index.ts#L388-L445
[P12]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/storage.ts#L345-L431
[P13]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/index.ts#L784-L824
[P14]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/lease.ts#L1-L105
[P15]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/format.ts#L398-L535
[P16]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/storage.ts#L318-L342
[P17]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/repair.ts#L14-L210
[P18]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-format-catalog/src/generated.ts#L10-L48
[P19]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/index.ts#L846-L862
[P20]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence/src/storage-contract.ts#L55-L103
[T1]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence/tests/live-write-contract.ts#L55-L295
[T2]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-checkpoint-policy/tests/session-checkpoint-policy.spec.ts#L55-L109
[T3]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-checkpoint-policy/tests/session-checkpoint-policy.spec.ts#L112-L237
[T4]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/tests/shutdown-drain.spec.ts#L31-L71
[T5]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/tests/resume.spec.ts#L493-L604
[T6]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/lease.two-process.e2e.ts#L33-L68
[T7]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L1747-L1791
[T8]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/zstd.spec.ts#L596-L750
[T9]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L2321-L2417
[T10]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/tests/repair.spec.ts#L53-L283
[T11]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts#L39-L119
[T12]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L772-L820
[T13]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-format-v3-to-v4/tests/open-vocabulary.spec.ts#L10-L47
[T14]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L1095-L1114
[T15]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L1258-L1282
[T16]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L1368-L1385
[T17]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/tests/resume.spec.ts#L716-L735
[P21]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence-jsonl/src/storage.ts#L535-L567
[P22]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/pipeline.ts#L266-L302
