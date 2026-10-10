# C2：学生工作区、固定快照与基础作业

日期：2026-10-10（Asia/Shanghai）。主责：C；Issue：[C2 #14](https://github.com/paher-din/XunJie/issues/14)。状态：完整 C2 服务端已实现并通过真实 A1/A2/SQLite/C1 作品链验收，最终记录见 §11；工作分支 `codex/c2-complete`，尚未推送新的 PR，Issue 保持 Open。浏览器、真人、业务负载与旧备份恢复分别后置，不计作完整产品/G1 通过。

最新推进状态：A1/A2 已经由 PR #18/#19 合入 main，本任务从 `ac96cf6083b8f7b8403896e2a505b53e94c20d58` 的独立干净工作树完成完整 C2。旧章节保留各自时点；准确存储/最小 A 接缝的批准前提案与负责人批准记录见 §10/10.4，当前交付以 §11 为准。

## 1. 依据、批准与写入范围

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按 PRD→MVP→TECH 阅读 [PRD](../product/PRD.md) §3.2/4.2/4.4/5/8/9、[MVP_SPEC](../product/MVP_SPEC.md) §1.3/M-03/M-05/M-07/M-09/M-10/4～6/8、[TECH_DESIGN](../product/TECH_DESIGN.md) §2～5/7/8/10～12；另读 [TEAM](../planning/TEAM_WORK_PLAN.md) C2/P1、[C0 来源稿](C0_WORKSPACE_RECORDS_RUNNER.md) §3～7、[工程衔接](../reference/ENGINEERING_HANDOFF.md)、[G0 批准记录](G0_CLOSURE_PROPOSAL.md#10-2026-10-09-负责人统一裁决及基线同步)、[C1 实际交付](C1_ISOLATED_RUNNER.md#14-2026-10-10-收口方案批准与执行)，以及 #14/#10/#13 全文。

G0 已批准 C2 首批快照/Job/CommandReceipt/Event/同事务核心；负责人本次要求进入 C2。沿用正式 v0.3 已确认的字段、状态、错误、权限和事务含义；无需重新批准这个首批范围。真实 SQL、A 的实际 tx/授权接入、共享工程及完整产品门禁保持有效。C0 的历史待审/closed/check/me-export 等差异不覆盖 v0.3。

可写：`apps/teaching/server/workspace/**`、`server/records/**`、`contracts/workspace/**`、`contracts/records/**`、本人测试、本文和 README。C1 原始证据不改写。只读：AGENTS、product/planning/reference、其他成员任务记录；A 的 package/lock/tsconfig、app/access/design/review/db/transaction、contracts/common/access/design/review 不代建；不建 UI、第二套业务队列或实际数据库。

开始 Git 状态：README、G1 总协调稿已有改动，apps/ 与 C1 任务稿未跟踪；保留全部，不回退/暂存/提交。当前目录只有 C1 模块，没有 A1 认证/公共事务或 A2 分配代码。A1/A2 Issues 均 Open；真实依赖不能用假登录或合成分配代替。

## 2. 本批最小实现与接缝

| 模块 | 按正式基线实施的核心 | 调用/验证 |
| --- | --- | --- |
| workspace | Attempt/确认文件的命令校验与变更计划；整批 create/update/recycle/restore、CAS/限制、UTF-16 changes；快照与 ObjectRef/历史实例校验；独立控制/路线/返回位置 | A1 在真实短事务内读取并授权当前范围，把计划写入同连接；内存合成测试仅验证规则，不返回真实持久 ACK |
| records | 合法载荷 canonical 摘要；账号/命令/目标/幂等键与 sync client 标识的同回执去重；Job 租约/代际/停止/完成、事件/原结果引用及用途失效变更计划 | C2 首批向 A3/B 提供领域核心；公共结构/实际 tx handle 仍由 A 汇总。核心不自行 commit，不执行网络、不复制全局队列 |
| runner 对接 | 使用 C1 已批准 wire/原 ID/固定快照/profile；受信运行请求与结果核对、unknown 查询原 ID、持久停止后完整终止确认；限定检查登记政策/原 Job 的阶段记录，确认结束前不释放 | 真实执行仅调用 C1；实际成员/分配/限定帮助与 Job 提交/接纳事务接 A1/A2 后验证 |

变更计划和内部测试状态不是 SQLite 存储实现、API ACK 或已确认共享 tx API；生产调用须由 A 的 withTransaction 原子保存作品/必要记录/回执/事件，commit 成功后才发送 ACK/通知。模块函数没有 HTTP 身份入口，不声明自己已实现 A1 的会话或课程成员授权。

字段、状态与业务不变量直接采用 TECH §4/5/7。纯核心只描述必要输入/输出，不冻结 A 的 ActorContext、数据库连接或 API 包装类型；缺少的实际适配在 §5 记录提案，未确认前不按提案建立公共工程/数据库。

实施细化：确认快照/运行结果仅保留必要引用；内部 CommandReceipt 的键别名计划把公共幂等键与 sync 标识指向原回执，不因换公共键后重用 clientSeq 产生第二次副作用。增量编辑核心使用已批准 UTF-16 Range 的内部表示，HTTP/实际 UI payload 仍由 A/UI 适配。限定检查阶段内部关联 jobId/runId/policyVersion，停止/失联不提前结束；这不是新增教师政策或外部帮助认证。上述均为已批准语义的 C 内部实现计划，实际数据库/公共 tx handle 仍待 A。

## 3. 实施顺序与验收

1. 先交 canonical/Receipt/Job/Event/同用途失效核心与测试，复用既有命名 resolveCommandReceipt、finishCommand、enqueueJob、appendEvent、invalidateInTransaction、cancelByPurpose 的含义。
2. 再实现学生文件整批变更、不可变快照与 ObjectRef；复用 C1 的 exact UTF-8/manifest-v1/path 校验。50 active 文件/1 MiB，回收同名重建新 fileId；恢复冲突不覆盖；paused 仅 update 既有 active 文件。
3. 补独立控制/采集代际/路线/返回位置与基本恢复读取；GET 不激活；首次合法显式命令 ready→active；采集暂停不保留逐次正文，缺/旧 captureRevision 不记过程但不阻塞作品。
4. 用合成范围连接 C1 验固定旧快照、实际 check/result/cancel/unknown 原 ID 对账；真实 A1/A2/SQL 仍单列未执行。
5. strict 类型检查、必要规则/失败/重放测试、文档检查；同步实际命令、代码位置与剩余依赖。

对应 AC-03/04/06/12 服务端规则，NFR-04 边界；覆盖同摘要原 IDs、异摘要/跨范围/代际拒绝、批次原子变更计划、版本冲突、旧实例/旧快照、UTF-16、超限、租约过期、停止/迟到完成/未知结果不重跑。实际 SQL 回滚/重启不丢 ACK、10 会话性能、真实成员/分配、UI/浏览器/真人没有替身通过数。

## 4. 当前真实依赖

| 缺口 | 影响与后续动作 |
| --- | --- |
| A1 共享工程、ActorContext/authorizeResource/withTransaction | 当前没有可导入提供者；C 不代建 A 目录。先交核心和字段需求，A 提供实际入口后接真实授权/事务 |
| A1 数据库/SQL 具体授权 | 尚无实际应用数据库；不建表、迁移或宣称持久 ACK/真实回滚。C 必需存储结构先提出，实际适配须具体授权及 A 的连接/迁移归属 |
| A2 Assignment/ActivityVersion/可用性/帮助政策 | 不用合成分配冒充真实教师确认；完整尝试→运行链待 A2 接入 |
| C1 | 专用节点实现/验收已完成；本批复用应用 key/固定入口，不新建密钥。运行时重读实际 ready，失联不回退宿主 |
| UI、真人与业务备份 | 按原阶段后置；不做替代页面，不声称完整 AC/G1 或教学效果通过 |

## 5. 实际接入提案（待 A/负责人确认）

A1 需要提供：受信身份/资源授权、同连接短事务、当前 recoveryGeneration/可信时间、ID 分配、当前 Assignment/ActivityVersion 的受控读取；C 提供本任务核心计划与 C 所有记录。共享字段/事务 handle 由 A 汇总，网络与 C1 取消必须在 commit 后。当前不新增公共事务类型或数据库 schema；具体表/索引/外键/迁移及授权申请在有可核查提供者后补齐，不凭 C 的测试内存状态自行定数据库。

| A 需接纳的具体需求 | C 当前交接与生产约束 |
| --- | --- |
| 命令身份/去重 | `CommandContext` 是 C 内部输入，不是新 ActorContext。A 从会话/Origin/成员/归属构造 identity/authorize；账号+command/target/key 的唯一绑定与账号+Attempt/clientId/clientSeq 指向同一原回执，别名同 tx 登记，异摘要拒绝 |
| 确认作品 | 同 tx 读 Attempt/全部当前文件、核 workspace/file CAS/路径/最终限额，再存变更计划和回执/事件；回收释放路径后再写 active 实例，避免中间唯一约束冲突；只有 commit 成功才能发 ACK |
| 不可变历史 | 当前确认作品与显式固定快照分开；采集暂停不自动保留逐次正文。Snapshot/RunRecord 按原 ID/引用追加、不更新旧正文；结果文件只读、不自动建 ProjectFile |
| Job/事件/停止 | scope/leaseToken/代际/deadline/调用计数与状态必须有原子条件更新；stopRequested 独立于终态。失效也标已生成教学 Job 的持久停止，供 C3 停止关联未展示 Action；已展示事实/普通运行事实保持 |
| 限定检查 | `checks` 的 jobId/runId/policyVersion/state 是 C 内部阶段计划；与 Job/epoch/用途失效同事务保存。A/B 读取该阶段拒绝不允许的辅导；unknown/cancelling 不提前结束，确认整个节点单元结束后再按活动固定规则结束 |
| 运行网络 | A 在实际队列分派前和最终短事务再核身份/分配/用途/停止。持久 Job 保存后，事务外使用 `dispatchOriginalRun` 查询原 ID；失联调用 markRunUnknown，不能换 ID 或回 queued。C1 容器槽位不是第二套业务 Job |
| 读取/模型 | 学生/教师 workspace 读取先授权；B2 使用 readConfirmedSnapshot/readRunDiagnostics 的受控入口，默认不给私有课程检查逐样例输出。资源正文/角色和适用活动由 A 再核，读接口不激活/运行 |

这里列的是必要逻辑记录、条件更新和调用次序，**没有已批准的物理表/索引/迁移脚本**。A 尚无实际入口时，不建立第二份 db/transaction、会话或课程分配。要由本对话补 A1/A2，需负责人明确调整文件责任并先审阅该范围方案；实际 SQL/账号凭据仍需具体对象/风险授权，不由“完成 C2”自动放行。

## 6. 验证与交付记录

编码前文档已建立，代码位于 C 所有目录，原有 C1/G1 工作保留。

| 代码 | 已实现与交接对象 |
| --- | --- |
| [contracts/records](../../apps/teaching/contracts/records/index.ts)、[records/commands.ts](../../apps/teaching/server/records/commands.ts) | 合法 JSON canonical 摘要、原 Receipt/Command/seq、双去重键/别名、事件与提交计划；登录凭据不进入摘要；A3 可先核调用字段，真实保存仍接 A 的 tx |
| [records/jobs.ts](../../apps/teaching/server/records/jobs.ts) | 单 Attempt/用途的未结束守卫、租约/代际/截止、三次调用、不因换 worker 重置、未知不回 queued、用途停止/同 tx 失效计划；教学 succeeded 仍可保存停止，事实/运行不改成新评价 |
| [contracts/workspace](../../apps/teaching/contracts/workspace/index.ts)、[workspace/files.ts](../../apps/teaching/server/workspace/files.ts) | 确认文件/生命周期、整批纯变更计划、50 active/1 MiB、CAS、最终路径占用、Unicode/UTF-16/CRLF、未获 ACK 新实例不能同批继续编辑、未批准字段与原型式 client key 拒绝/安全映射 |
| [workspace/snapshots.ts](../../apps/teaching/server/workspace/snapshots.ts)、[controls.ts](../../apps/teaching/server/workspace/controls.ts) | 固定学生/活动 Attempt、不可变完整快照及历史 ObjectRef、独立采集/提醒/生命周期/路线/返回位置；GET 不激活，首次合法显式操作激活；旧过程不补录，暂停可保存已有 active 文件 |
| [workspace/commands.ts](../../apps/teaching/server/workspace/commands.ts) | 已授权范围→原回执→新 CAS/整批计划，sync/snapshot/control/run/cancel 组合；确认检查前登记阶段，原 ID/快照/结果接纳与结束，scope/代际/当前对账租约、只读受控快照/诊断 |
| [records/runner.ts](../../apps/teaching/server/records/runner.ts) | 真实受认证 SSH/固定命令/host key 核查、动态实际 ready/profile、先 query 原 runId、已知事实不重发、最终结果原 hash 核对、取消 tombstone 与完整终止事实；不建立新 key 或开放任意 shell |
| [records 测试](../../apps/teaching/server/records/records.test.ts)、[workspace 测试](../../apps/teaching/server/workspace/workspace.test.ts)、[运行测试](../../apps/teaching/server/workspace/runs.test.ts) | 合成规则反例与真实 C1 实测；不把内存计划称 SQL 原子事务、真实登录或持久 ACK |

实际验证使用已批准 Node v24.21.0，复用 C1 的临时类型工具，不改 A package/锁文件/tsconfig、不新增依赖：

```bash
# 仓库根；无 runtime 参数时真实节点项明确跳过
/opt/xunjie-runner/node/bin/node --test apps/teaching/server/records/*.test.ts apps/teaching/server/workspace/*.test.ts
# 本机已准备、无真实业务作业的合成维护环境；含真实 C1 SSH/容器
XUNJIE_C2_RUNTIME=1 /opt/xunjie-runner/node/bin/node --test apps/teaching/server/records/*.test.ts apps/teaching/server/workspace/*.test.ts
# strict 检查；不使用 skipLibCheck/忽略错误
/opt/xunjie-runner/node/bin/node /opt/xunjie-runner/typecheck/node_modules/typescript/bin/tsc \
  --noEmit --strict --target es2023 --module esnext --moduleResolution bundler \
  --allowImportingTsExtensions --types node \
  --typeRoots /opt/xunjie-runner/typecheck/node_modules/@types \
  apps/teaching/server/records/*.ts apps/teaching/server/workspace/*.ts \
  apps/teaching/contracts/records/*.ts apps/teaching/contracts/workspace/*.ts
```

| 验证层 | 实际结果与边界 |
| --- | --- |
| 最终核心+真实 C1 | 16/16 通过，0 失败/0 跳过；[原始输出](../../apps/teaching/server/workspace/c2.acceptance.txt)。15 项合成核心检查+1 项组合的实际 C1 SSH/容器；每项含对应断言，不虚增统计 |
| 实际节点对接 | C2 计划的旧确认快照编译/运行，之后改当前文件仍得到旧源码输出；重复原 ID 返同 resultRef；stdout passed 在真实 course_check 得 failed；排队取消在节点保存 intent，后提交仍 cancelled；限定检查确认终止前保持 active |
| Unknown/恢复/边界 | 合成传输失联/租约过期仅查原 ID，unknown 不领取新执行；结果 hash/原作用域/过期 worker/代际拒绝；已完成事实后停止仍保留原终态；跨学生读取与私有 check detail 裁剪有反例 |
| 类型 | TypeScript 7.0.2 strict noEmit 通过；第一轮相对导入多一级导致失败，逐个修正 C 自有模块的路径后通过，没有关闭检查 |
| 文档/范围 | 本文与 README 同任务同步；25 份文档/258 处仓库引用/27 条正式变更接口检查通过，检查器回归 16/16；本人文件空白/冲突标记和 Git 保护范围检查通过 |

未执行：A1 实际会话/Origin/成员/资源、A2 教师确认/分配、真实 SQLite/同连接事务/唯一约束/回滚及重启不丢 ACK、跨 worker 持久调用/用量、真实限定帮助入口、10 会话保存性能、完整旧备份恢复、UI/浏览器/真人/教学效果。源码临时运行与原始节点事实仅为合成工程验证，不进入真实学习记录。

已完成的是 C2 获准首批领域核心与真实 C1 接缝，**不是整个 C2**。要通过 #14 的关闭条件仍需实际 A1/A2/SQL 完整链。基线进度待授权维护者汇总，不写 product/planning/reference；无提交/推送/远端 Issue 修改、成员消息、数据库/密钥/CI/删除或公开部署。

原始 C2 输出 SHA-256 为 `ddd0c5b5ff47395e3c7b36100f63cf69d9a9b0f5d4b860aac15746756f2e179d`。收尾 strict 类型检查再次通过；C1 原源码/验收信封和受保护基线保持原样，G1 总协调文档是其他工作项已有改动，未覆盖/暂存/提交。

## 7. 后续依赖决定与接入顺序

项目负责人明确选择“由 A 交付 A1/A2 后接入”。本任务保持 C 原文件责任，等待具体接口交付；不在本对话扩展到 A 的权限/公共工程/事务/分配模块。该决定不放宽数据库、凭据或完整 C2 的验收。

A1/A2 到位后按以下顺序继续同一 C2：

1. 读取 A 的实际任务稿/公共类型/授权和同连接事务入口，对照 §5 与 C 当前核心，记录必要适配差异，不直接改共享契约。
2. 实际存储方案/具体授权具备后，在同 tx 保存文件、快照、Job、原回执/别名、事件、限定检查阶段和结果；执行真实唯一约束/失败回滚/并发重放/重启保留 ACK 证据。
3. 接 A2 的不可变活动、分配/可用性/帮助政策，完成真实授权尝试→同步→快照→C1 run/course_check，并核暂停/限定帮助/停止/迟到/unknown 的最终守卫与政策投影。
4. 真实服务端全部关闭条件齐备再处理 #14；浏览器/IndexedDB/多标签/真人仍按原 UI 阶段补验。没有替代 UI、自动变更幂等键或静默重新运行。

当前 C 所有模块、可重复命令、原始证据和适配需求均已在仓库，首批可供 A3/B2/C3/C4 查阅/复用；没有向其他任务发送消息或自行安排定时跟进。

## 8. 2026-10-10 PR 交付授权与准备

项目负责人要求推送 C1/C2 两项 PR，授权本任务首批代码/测试/证据、本文和 README 的提交/非强制推送及创建 PR；不授予完整 C2 验收、A 模块代做、合并、数据库/凭据/CI 或生产部署。C2 PR 以 C1 分支为基线，仅审查 C2 增量，使用 Refs #14 保留完整 Issue Open；由 A 交 A1/A2 后接入的决定不变。

独立工作树保留远端 main 已合入 B1，不覆盖主工作副本或其他成员 G1 记录。C2 白名单为 server/workspace/records、contracts/workspace/records、本文及 C2 README 增量；C1 文件不在 C2 增量中。仅 C 自有目录增加 LF 属性，保证 Windows 检出/Linux 运行和原始证据字节一致，不写根共享配置。交付后追加提交/远端/PR 及范围核验结果。

PR 提交前独立工作树复验：C2 16/16（含真实 C1 SSH/容器）再次通过、0 跳过；strict TypeScript 7.0.2 noEmit、26 份文档/268 引用/27 正式接口、检查器 16/16、C2 白名单和暂存空白通过；原始代码/证据字节与 Git index 一致。C2 暂存增量 19 文件，仅本人领域、任务稿和 README，不含 C1/A/B/受保护基线或其他成员 G1 变更。

实际交付：正文提交 `fcb0cac7971c67f1a84de0523f1ee9f86c8d2760` 已普通推送 `codex/c2-workspace-core`；[C2 PR #17](https://github.com/paher-din/XunJie/pull/17) 已创建并附到本任务，base=codex/c1-isolated-runner，依赖 [C1 PR #16](https://github.com/paher-din/XunJie/pull/16)，Open/非 Draft。远端 head 与本地、标题/完整正文/19 文件白名单回读一致；C1 和 A/B/G1/受保护文件不在本 PR 增量中。Refs #14 保持完整 Issue Open，尚未合并；后续按原决定等 A1/A2，不将发布首批 PR 当作完整 C2 验收。

## 9. 2026-10-10 PR #17 审查修复

负责人要求按 PR #16/#17 审查修复，沿用两项分支推送授权；修复 C2 固定 HEAD 84545ec 的三项意见（共享账号 COMMENT 技术审查，不称独立批准）。已重读 PRD 学生操作/结果边界、MVP §1.3/M-03/M-07/M-10、TECH §4.4/7.3/8.1/8.3、当前源码/调用方和任务记录。本次只改 C-owned workspace/records、对应反例/本文/README 必要状态；受保护基线、A/B/G1、SQL/凭据/CI/UI 保持原边界。

| 意见 | 对应基线与修复计划 |
| --- | --- |
| [P1 私有检查输出泄漏](https://github.com/paher-din/XunJie/pull/17#discussion_r4236386161) | TECH §4.4/8.3：公开工作区运行仅返回原 ID/快照/profile/状态与已裁剪诊断，不透传内部 submission/result/phases/checkResults；内部原始结果/hash 保留，读取先授权。补同一私有 marker 的完整 workspace 载荷反例及普通 run 诊断可见 |
| [P2 queued 运行暂停提前终结](https://github.com/paher-din/XunJie/pull/17#discussion_r4236386164) | TECH §8.1：共享 cancelJob 对非终态 student_run/teacher_sample 一律保存 cancelling，包含 queued；所有暂停/按用途停止调用方复用，原节点 intent/pending/完整终止确认后才 cancelled，补 pause→resume 前禁止新运行 |
| [P2 再次停止复活 cancelled](https://github.com/paher-din/XunJie/pull/17#discussion_r4236386166) | TECH §7.3：去除显式运行停止的重复转换，已确认终态用新键停止仍保留；补已取消→再次停止→能创建新作业 |

先用审查反例验证旧源码失败，再修复根因；本批验证不冒充真实 A1/A2/SQL 或浏览器完成。父 PR #16 修复后通过普通 merge 同步实际父分支（不重写历史），在新基线上复验 C2/真实 C1。原 16/16 与历史证据保留；新增修复结果另行追加。

C2 反例结果：旧源码新增用例为 13 通过/4 失败/1 真实节点项跳过；失败分别为共享 queued 运行取消、完整工作区私有 marker、pause queued run、再次停止已确认 cancelled。修复后离线 17 通过/0 失败/1 跳过，strict TypeScript 7.0.2 noEmit 通过。共享取消统一处理运行用途，显式停止不再重复改变状态；公共运行投影复用裁剪诊断，内部原结果保持 hash/正文。父 C1 修复后的真实节点组合复验和新原始输出尚待后续执行，不把本次跳过计通过。

已普通 merge 新父 C1 1c3f73c 到 C2，未改 base=codex/c1-isolated-runner、未重写历史或混入 main。新基线下 C2 18/18、0 失败/0 跳过（包含真实 C1 validator-v2/SSH/容器）再次通过；[新原始输出](../../apps/teaching/server/workspace/c2.review1.acceptance.txt) 单独保存，原 c2.acceptance.txt 不覆盖。strict TypeScript 7.0.2 noEmit、文档静态/检查器 16/16及范围/空白通过。三个审查意见均有旧失败/新通过的反例，公开工作区仅序列化安全运行元数据与诊断，内部原记录/校验摘要保留；所有未终态运行取消等完整节点确认，已取消终态不复活。

真实 A1/A2/SQL/限定帮助入口、浏览器和真人仍未执行，C2 首批范围和 Issue #14 关闭条件保持；不以修复审查宣称全部 C2 或独立审核批准。实际推送、PR 正文/新 head 与文件范围回读将在发布后记录。

新 C2 输出 SHA-256：77f155386618af34cb2521f3f01818541f4f7920dce011f76a42f18820d14563。

审查修复实际发布：C2 根因修复 8bf2a5a、新父分支普通 merge 与新组合验证 `2bfaa65af90bc921b38d45b7451978e8b44c5f17` 已非强制推送 PR #17；最终正文/三项修复/18 项结果、base=codex/c1-isolated-runner 与远端 head/文件白名单逐项回读一致。仍只包含 C2 增量，未将父 C1、A/B/G1 或受保护基线作为 C2 差异。两个 PR/Issues 保持 Open，未合并或自签独立批准，审查线程留给原审查者复验；原“由 A 交 A1/A2 后接入”决定和完整 C2 关闭条件不变。

## 10. A1/A2 合入后的完整 C2 收口方案（准确存储与最小接缝待批准）

已重读当前 AGENTS/README、PRD §4.2/4.4/5/8、MVP M-03/M-05/M-07/M-09/M-10/§4～6、TECH §5/7.2.1/7.4/8、本文，核对 A1 的当前权限与同连接 Transaction、A2 固定活动/分配控制工厂及 [A2→C1 交接](A2_C1_INTEGRATION_HANDOFF.md)。验收对应 AC-03/04/06/12/15 的服务端部分与 NFR-04；浏览器、负载性能、旧备份恢复、真人和教学效果不提前计入。

现有 `createCompletionDatabase` 只批准十七表，`attempt_json` 的严格结构不接纳文件/快照/运行数据，`finishRecordCommand` 明确拒绝 sync。不能把正文塞进共享 Attempt/Receipt 的未约定字段来绕过建表授权。保留 A 已交授权/事务/分配/公共工程，不建立第二个应用基础、DB 驱动或业务队列。

### 10.1 最小准确存储提案

新增独立 `createWorkspaceDatabase`，只在系统临时目录创建全新的 `xunjie-a12-completion-*/synthetic.sqlite`，沿用 A 的目标检查、独占创建、WAL/FULL、同步短事务与关闭重开入口。一次初始化原十七表加下列五表，共二十二表；原五/十/十七表工厂保持各自范围。**不升级、迁移、导入、清理或复用任何已有库；全部合成库关闭后保留。**

| 新表 | 精确字段/约束与用途 |
| --- | --- |
| `workspace_files` | `file_id` 主键、`attempt_id` 外键、`path`、`document_version` 正整数、`lifecycle=active/recycled`、64 位 `content_hash`、合法 JSON `file_json`；同 Attempt 的 active path 部分唯一索引。当前确认文件可更新，回收不删除，快照保留历史正文 |
| `artifact_snapshots` | `snapshot_id` 主键、`attempt_id` 外键、非负 `workspace_revision`、64 位 `content_hash`、合法 JSON `snapshot_json`；只追加完整 manifest-v1 快照，读取重验内容与实例/活动归属，不更新历史 |
| `workspace_runs` | `run_id` 主键、`attempt_id` 外键、唯一 `job_id` 外键、`snapshot_id` 外键、合法 JSON `submission_json`；可空结果 JSON/hash；可空 `check_policy_version` 和 `check_state=active/ended`。原请求不可改，结果首次接纳后同 hash/引用，检查直到权威终止保持 active |
| `workspace_command_bindings` | `(kind,key_json)` 主键，kind 为 public/sync，`receipt_id` 外键、合法 JSON `identity_json`。public 键为账号/command/target/key；sync 键为账号/Attempt/clientId/clientSeq。多公共键可指原回执，绑定只追加、不同原回执拒绝，恢复代际与当前权限先查 |
| `workspace_process_records` | `receipt_id` 主键/外键、`attempt_id` 外键、非负 `capture_revision`、`kind=sync/coverage`、合法 JSON `record_json`。仅当前 collecting 区间接受同步过程正文；采集开关记录服务端覆盖边界/空窗；缺/旧 captureRevision 不写观察，不补造或重贴代际，功能作品正常保存 |

同事务顺序：当前 A1 Session/成员/资源授权与 A2 分配 → 原回执/双键 → 新请求 CAS/完整变更计划 → Attempt/确认作品/不可变快照 → 原共享 Event/Receipt/Job 与绑定/必要过程 → commit → ACK。文件先解除将回收的 active 路径再保存最终文件；任何失败，包括后段外键/唯一约束，整批回滚，Session 活跃时间也不提前确认。

### 10.2 最小接缝与实施文件提案

主要写入 C 所有 `server/workspace/**`、`server/records/**`、`contracts/workspace/**`、对应测试/子进程夹具、本文和 README。为复用 A 的实际连接与记录校验，申请仅允许两项 A 文件的最小接缝调整：

1. `server/db/transaction.ts`：新增上述新临时库工厂并引用 C 所有五表 schema，沿用已有目标/事务实现；旧工厂与事务权限不变。
2. `server/db/records-adapter.ts`：导出已有受校验记录读取、提取原 Event/Receipt 写入为可复用同 tx 计划保存入口；原 finishRecordCommand 行为兼容。C 保存绑定/文件/快照/运行，不自行复制 A 的 SQL 记录格式或绕过严格校验。

不改 A 的 Session/密码/分配算法、package/lock/tsconfig、公共状态/错误/基线或 UI。HTTP 工厂由 C 组合现有 createDesignApp，注册 TECH 已批准的 attempts/sync/snapshots/runs/controls/cancel 与受控读取；只接受当前登录身份，拒绝 body 冒充角色/学生、shell/profile 任意配置。工作区输入严格校验，UTF-8 字节/UTF-16 范围与首批核心保持一致。

持久 Job 消费使用原 jobs 表和 C 租约能力，提供宿主可调用的 worker 接缝；不另建队列或默认监听。分派前与最终接纳短事务核成员/分配/Attempt/停止/代际，网络始终在事务外。ordinary run 保存原事实；限定检查取固定活动规则/政策，B2 受控读取当前检查阶段与允许帮助，不透传私有测试输出/hash。停止先持久 intent，worker 对原 runId 取消/查询，unknown 与重启仅对账原 ID，不能自动新建或重新提交。

### 10.3 验证与操作风险

复用准确 lock 与已批准 Node 24.21.0，npm ci/typecheck/build/统一回归；无需新依赖、密钥或环境文件。合成登录凭据/签名只在测试内存与获准进程 IPC 中使用，不打印或持久保存原值。实际节点仅复用 C 已有 application SSH key/known_hosts，通过 readiness/submit/query/cancel/result 完成合成学生链，不改节点配置、执行代际/维护验收或密钥。

新增真实 SQLite 同事务成功/后段故障全回滚、双键原 ACK/异摘要/旧版本/跨范围、关库重开与子进程竞争/重启证据；A1/A2 实际教师登录确认/分配→学生创建 Attempt→整批同步→旧快照→C1 普通运行/可信课程检查，以及活动/个人/Attempt 暂停、采集空窗、停止、原 ID 失联对账反例。最终按层报告；未运行项保持未执行，受保护基线进度待授权维护者汇总。

风险：会新增并保留含合成数据的临时 SQLite 文件，占用本机磁盘；两个共享 A 文件增加最小导出/工厂，须全工程兼容回归；真实 C1 合成运行占用既有两槽和固定资源。方案不处理真实学生/生产库、旧库迁移、删除、凭据/CI 修改、公开部署或合并。AGENTS 的“数据库 schema 变更或数据迁移”和“大改动先提出方案，经用户确认后实施”要求此准确新增范围先确认。当前仅方案准备，新增 schema/工厂和整链编码尚未执行。

### 10.4 准确批准与实施起点

项目负责人明确答复“批准第 10 节全部方案，继续完成 C2”，批准 §10.1～10.3 的全新二十二表合成库、两个 A 文件的最小接缝与完整 C2 验证。受保护基线、旧库/生产库、删除、凭据/CI 和发布边界保持；原方案中的待批准是批准前状态。

接缝核查补充：A 的 saveAttempt 要求任何实际 Attempt JSON 变化递增 attemptRevision。C 同步递增 workspaceRevision 时同时推进 attemptRevision；active 的限定检查改变 decisionEpoch 时也推进 attemptRevision，保持同 tx CAS 单调而不修改 A 已交规则。普通执行事实仍绑定旧快照，后续文件编辑不改变原执行正文。实际实施/验证结果后续追加，不把本节计划写成通过。

首轮真实集成 6 项中 5 通过、1 失败：A 的 Zod JSON 解析在读回 ACK 时丢弃合法 `__proto__` clientFileKey，造成同请求重放的 ID 映射缺失。已在批准的 records-adapter 接缝范围保留 JSON 校验、去除该字段的有损转换，原结果按原 JSON 读取；不通过禁用校验或拒绝既有合法 client key 迁就缺陷。第一轮夹具还因私有材料未获 teacherDesignAllowed 正确触发 A2 阻断，已修正合成教师配置后再验证，产品规则不变。

## 11. 完整 C2 服务端交付与实际验收

### 11.1 实现与交接入口

| 位置 | 实际行为 |
| --- | --- |
| [application.ts](../../apps/teaching/server/workspace/application.ts) | createWorkspaceApp 组合真实 createDesignApp/A1；创建或返回当前 Attempt、sync/snapshot/run/control/cancel 与范围读取。账号/归属来自当前 Session/成员；提交前重查授权/分配/代际，不接受请求冒充教师/学生 |
| [inputs.ts](../../apps/teaching/server/workspace/inputs.ts)、[files.ts](../../apps/teaching/server/workspace/files.ts) | 严格入口 DTO、全部字段/整批 CAS、UTF-16 编辑、Unicode/UTF-8 hash、50 active/1 MiB、回收/恢复路径；同步同时推进 Attempt/workspace revision。sync HTTP 上限 8 MiB 容纳 JSON 转义，业务源码限额仍 1 MiB |
| [schema.ts](../../apps/teaching/server/workspace/schema.ts)、[storage.ts](../../apps/teaching/server/workspace/storage.ts) | 准确获准五表；文件/双键/不可变快照/原运行/限定阶段/过程与覆盖和 A 共享记录同 tx。只写变化文件，回收先释放路径；读回核 schema、正文 hash、实例/活动/Job/快照关联；不改历史快照/原请求/原结果 |
| [worker.ts](../../apps/teaching/server/workspace/worker.ts)、[commands.ts](../../apps/teaching/server/workspace/commands.ts) | 原 jobs 表的领取/当前成员与分配/停止/代际/租约守卫；持久进展与 Event/Receipt 同 tx；网络在事务外。queued 首次分派先 query，已领取/unknown/重启仅查原 ID，空事实也不 resubmit；节点确认整个单元后结束取消/检查 |
| [records/runner.ts](../../apps/teaching/server/records/runner.ts)、[result-files.ts](../../apps/teaching/server/workspace/result-files.ts) | 普通 application SSH/readiness/query/submit/cancel/readResult；旧快照/输入/profile/结果 hash 精确绑定。正常运行诊断和白名单只读产物按授权读取，私有 course_check stdout/文件/hash 不下发 |
| [transaction.ts](../../apps/teaching/server/db/transaction.ts)、[records-adapter.ts](../../apps/teaching/server/db/records-adapter.ts) | 仅批准的两个 A 接缝：独立 createWorkspaceDatabase（二十二表新合成库），既有受校验读取/身份/计划保存导出。原五/十/十七表工厂、同步事务规则、Session/分配算法不变；JSON 校验保留原 ACK client key |
| [integration.test.ts](../../apps/teaching/server/workspace/integration.test.ts)、[test-support.ts](../../apps/teaching/server/workspace/test-support.ts)、[test-child.ts](../../apps/teaching/server/workspace/test-child.ts) | 7 个真实 A1/A2/SQL/进程与确定性传输用例，1 个实际 C1 整链用例；独立合成数据、即时签名/密码与 IPC，关闭后保留库。夹具 policy/rule 通过 A2 当前教师授权，不进入产品路由 |

HTTP 路径沿 TECH §5：POST `/api/assignments/:id/attempts`、`/api/attempts/:id/sync|snapshots|runs|controls`、`/api/jobs/:id/cancel`；GET `/api/attempts/:id`、`/api/jobs/:id`、`/api/attempts/:id/snapshots/:snapshotId`、`/api/attempts/:id/runs/:runId` 与其 `/files`。当前 cancel 路由接纳本人 student_run；教学 Action 的最终停止/投递由 A3/C3 接入已交用途核心，不声明 Action 已实现。

调用方显式传 A 的实际 db/origin/signingSecret/currentGeneration 和 C RunnerTransport。该工厂不监听、不创建账号/长期凭据；默认 main 仍健康入口。A3 在获准业务宿主组装该工厂，按原 jobs 持续消费 `workspace.pendingJobs()` 并调用 `workspace.processJob(jobId)`；进展落库后，后续轮只对账原 ID。C1 的两个执行槽不是第二个业务队列。

B2 使用 `workspace.readSnapshot` / `readDiagnostics` / `readTutorContext`，读取仍先核当前授权。readTutorContext 返回固定活动的 tutor 投影和当前 limitedCheck/helpAllowed，限定检查直到权威结束均不允许辅导；B2 入口/生成/投递须消费同一限制。C3 使用 `readProcessRecords` 的同范围原始记录/覆盖边界；仅当前 captureRevision 收过程，必要 confirmedBasis 解释后续编辑范围，不重建空窗观察。记录只证明获认证通道提交，不推定实际操作者或能力。C4 可复用 loadWorkspace/persistWorkspace 的同 tx 入口和不可变 snapshotId，不另复制提交前作品。

### 11.2 验证命令、事实与证据

使用已批准 Node **24.21.0**、精确 package-lock，未增加依赖或放行原生安装脚本；better-sqlite3 实际预构建模块可加载。新库实际读回 SQLite **3.53.4**、WAL、foreign_keys=1、synchronous=2、busy_timeout=1000，共 **22 表**。所有测试只创建新的系统临时合成库，未改/迁移/清理旧库。

```bash
# 在 Linux 文件系统中的相同源码/精确 lock 副本；apps/teaching 目录
npm ci --no-audit --no-fund
npm run typecheck
npm test  # 含原 pretest build 和所有既有用例，未改变超时或跳过条件

# 已准备且获准的合成 C1 环境；配置 JSON 只包含 endpoint 与原密钥/known_hosts 路径
XUNJIE_C2_RUNTIME=1 XUNJIE_C2_SSH_CONFIG='<C 维护方提供的 SSH 配置 JSON>' \
  node --test --test-concurrency=1 server/records/*.test.ts server/workspace/*.test.ts
```

SSH JSON 字段为 binary/host/port/keyFile/knownHostsFile，交给既有 sshRunner；仅使用 application key 和固定 xunjie-c1 入口。没有新建/替换密钥、改变代际、recover、维护验收、Docker 配置或节点部署。本批仅正常合成运行，不把维护能力暴露给学生。

| 层次 | 最终实测与可核查入口 |
| --- | --- |
| 类型/build | 完整 TypeScript 7 strict typecheck 和 npm test 的 pretest build **通过**；[类型输出](../../apps/teaching/server/workspace/c2.complete-checks-native.txt) 与下行原日志。未关闭检查、忽略错误或改变 A 工程配置 |
| 统一回归 | 原 npm test **176 项：171 通过、0 失败、0 cancelled、5 跳过**；[原始日志](../../apps/teaching/server/workspace/c2.complete-regression-native.txt)。5 项是显式 C1 Docker/SSH、C2 两项节点、A2 节点门禁；不是通过数 |
| C2 最终组合 | **26/26 通过，0 失败/跳过**；[原始日志](../../apps/teaching/server/workspace/c2.complete-acceptance.txt)。其中 24 项确定性核心/真实授权/SQL/进程/受控故障，2 项实际 C1 SSH/容器；新 A1/A2/C1 完整链是其中 1 项，不虚增条数 |
| SQL/ACK/引用 | 公共键与 sync 键/新别名都回原 receiptId/commandId/serverSeq/正文；异摘要、旧版本/代际、路径、超 50/1 MiB 整批拒绝。实际 UTF-16/CRLF/emoji 编辑、回收同名新实例、冲突恢复及原 ID 恢复、旧快照/range 和返回位置关闭重开后可读 |
| 原子/恢复 | 同 tx 的文件/快照/Job/Receipt/Event/必要过程失败全回滚，Session 不先推进；尾段 SQL 失败无 ACK，原键可显式重试。两真实进程竞争不同公共键/同 clientSeq 回同 ACK；进程退出/再起和关闭重开读回原确认作品，不用内存计划计数 |
| 原 ID/权限/检查 | 实际当前 Session/课程成员、教师只读学生作品、跨学生/课程与伪 CSRF 拒绝；撤权后原回执也拒绝。queued 检查经 A2 个人暂停保存 cancelling，恢复不复活，节点确认前阶段 active。失联/空事实不重发，结果 SQL 失败重开后接纳原事实；租约过期需新对账租约，过期 worker 不能接纳 |
| 真实学生作品链 | 教师真实 A2 检查/确认/分配→学生正常登录创建 Attempt→完整同步/固定快照→后来改源码→C1 仍执行旧源码；同键返原 runId。真实 course_check 对自打印成功文本正确给 failed，私有 stdout/文件/hash 裁剪；停止未分派 run 节点确认 cancelled，未 submit。普通 Report 实际白名单文件正文/hash 可读，ProjectFile 仍两项、无自动写回；关闭重开仍保留原运行 |
| 来源一致性 | 验证复制前后 **108 个源码/配置文件字节摘要完全一致**；[机器可核查清单](../../apps/teaching/server/workspace/c2.complete-source.evidence.json)。源码 manifest hash 为 e82c488448f0641da991637c082b623ec1832d3f8bb805be242205d6e696320a；lock hash 为 7d93afc2441eceff0ccd26a9cae981557a9f789021b40f079a70d4ea356d548e。此摘要用于执行源码核对，不代替 C1 就绪证据 |

真实节点证据仍是 C1 已验收的 sourceHash `0869fdbeb71287d22cfecaf6424abf4ed79db9a98ef687de91f7ff6ad2520e36` / fingerprintHash `02351c15ef9683d19ebb6b2b8ed079a28e2f6e51f888e3e31a9cd99c3b14b42b`，固定 C17 profile/镜像与动态当前 generation 从正常 readiness 获得并在 A2 活动内冻结；原日志记录。当前 C2 代码没有改变 C1 指纹或拿历史其他指纹当当前 ready。

### 11.3 失败记录、交付范围与后续

保留失败事实：[Windows 挂载目录的原并行 npm test 日志](../../apps/teaching/server/workspace/c2.complete-regression.txt) 为 176 项、168 通过、1 失败、2 超时 cancelled、5 跳过，涉及 A 的原认证子进程 15 s 和入口 5/10 s 时限，C2 用例通过。相同源码/锁定依赖复制到 Linux 文件系统后，**原脚本、原并发、原时限**全部通过；启动从挂载目录的 5/10 s 超时降至原生目录约 0.5～0.6 s。验证处理的是本机文件系统开销，不通过调长时限、删用例或关闭检查收口。建议 WSL 下用 Linux 文件系统验证应用；不把这次合成测试耗时当 NFR 性能结果。

前次 [整链初验](../../apps/teaching/server/workspace/c2.complete-runtime.txt) 与 [报告文件复验](../../apps/teaching/server/workspace/c2.complete-runtime-final.txt) 原样保留；最终以 26 项新组合为准。代码、文档与证据已同步，C2 服务端关闭条件有实际链支撑。最终文档链接/检查器、Git 范围/空白与本地提交核对追加于交付记录；尚未推送新的 PR 或关闭 #14。

未执行：实际 Web UI/IndexedDB/账号切换/多标签/键盘、真实账号和私有 HTTPS/TLS、10 会话 NFR 负载、C5 业务备份/旧备份回退/RTO、真人/模型/教学效果。后续提交/正式评价/Action 与教师纠正仍由 C4/A4/C3/B 对应任务交付，不把这些范围列为 C2 已实现。临时合成库/验证副本保留，不执行删除或自动恢复旧实验。

需获授权维护者汇总 MVP_SPEC §10：C2 完整服务端、二十二表新合成库/两个 A 最小接缝、26 项含真实 A1/A2/C1 的作品链，以及统一回归结果与上述未验收层。**待授权维护者汇总**；本任务没有修改 product/planning/reference/AGENTS，保护基线未同步。主工作副本的 G1 既有改动及其他成员记录保留；完整应用/G1 完成条件不改变。

最终文档静态检查：30 份文档/355 处仓库引用/27 条正式变更接口，errors=[]；检查器回归 16/16，通过；Git 空白检查通过。C2 最终组合原始输出 SHA-256 为 `19b18e17eed2d768e8f72404b2a5e44bce4ec6893b7f9d415d86fc8474a0f0cb`，统一回归原始输出为 `f9d5a6356719284946ef2a65193ce1e41a31f803bdba1a14b325faeffbc29827`，LF 原字节保留。发布前的源清单/实际测试结果与范围复核一致；本地提交包含代码、反例、原始证据、本文和 README，无包/锁文件/CI/凭据或受保护基线改动。

原始 npm stdout 的尾部空行、失败诊断空白行属于归档数据，保留原字节。暂存核对首次在两份新日志提示空白：仅这两份原始输出在 C 目录 .gitattributes 声明相应数据空白属性；代码/测试/文档仍用原空白规则，业务检查和超时不变。最终全暂存空白检查通过；没有修剪诊断来改变原始证据。
