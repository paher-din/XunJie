# C2：学生工作区、固定快照与基础作业

日期：2026-10-10（Asia/Shanghai）。主责：C；Issue：[C2 #14](https://github.com/paher-din/XunJie/issues/14)。状态：批准的首批核心与实际 C1 对接验证已完成；真实 A1/A2/SQL 提供者尚未接入，完整 C2 未完成，Issue 保持 Open。

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
