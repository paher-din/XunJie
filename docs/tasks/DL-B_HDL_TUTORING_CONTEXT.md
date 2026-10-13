# DL-B HDL 可信教学上下文与学生引导

任务：Issue [#40](https://github.com/paher-din/XunJie/issues/40)

主责：B

基线：初始提案 `37849f4fa2fd4cc1e058fb8559b33a89a60ceed2`；本批重放 `cde69ccbd763c3c0ab381a809b750b951f195f64`（2026-10-13）

状态：首批消费提案、B 域合成实现、固定合成材料的真实模型调用与人工语义复验均已完成；本任务已按 #38 的 DLA-H4 清单补充当前最小上下文/当前性交接表。A/C 真实授权读取与正常业务构造、C3 投递、浏览器和真人交付仍未完成

## 1. 依据、范围与写入边界

已按 `AGENTS.md` 的文档优先顺序阅读 `README.md`、PRD 的学生控制/数字逻辑流程与 PRD-04/05/09/10、MVP_SPEC §1.4 与 DL-AC-04/08/09、TECH_DESIGN §6/§8.5、TEAM_WORK_PLAN §7/§10.1、DL-0 §2.2，以及既有 B1/B2 任务稿和 `contracts/tutoring`、`server/tutoring` 实现。本文同时受 P3 总协调 [#37](https://github.com/paher-din/XunJie/issues/37)、DL-A [#38](https://github.com/paher-din/XunJie/issues/38)、DL-C [#39](https://github.com/paher-din/XunJie/issues/39) 和 B 后续验证 [#45](https://github.com/paher-din/XunJie/issues/45) 的实际交接约束。

本任务负责 B 原有 tutoring 领域中的 HDL 获准上下文、引用/版本校验、教学帮助政策、确定性测试和后续实际模型语义证据。B 只读取 A 授权的课程/尝试配置与 C 产生的真实构建/会话结果；不写学生作品，不发起构建、装载、推进或板信号操作，不创建 Job、Message、TeachingAction、Delivery、Receipt 或事件系统，不作正式评价。

本次可写范围为本文。`AGENTS.md`、`docs/product/**`、`docs/planning/**`、`docs/reference/**`、其他成员任务稿、共享 TypeScript 契约与应用源码均保持只读。下述字段是提交给 A 的消费需求，不是已批准 schema、路由、错误码、数据库或运行限额；获 #38 汇总评审并明确可写文件前，不据此编码。

## 2. 进入条件复核

| 条件 | 当前事实 | 对 DL-B 的影响 |
| --- | --- | --- |
| P2 原服务端预交付 | main 已记录 PR #36 合入，#11/#24/#26 的工程审查收口；未完成模型/人工语义项转由 #45 承担 | B1/B2/C3 的确定性帮助、取消、作业、消息与回执能力可复用；不再阻止首批契约提案 |
| DL-D03 共享 DTO | TECH §8.5 仍将 BoardProfile、BuildArtifact、SimulationSession、SignalFrame/Trace 列为候选对象；DL-0 明确共享接口未批准 | 阻止修改公共契约和实现上下文装配；本文先向 #38 提交最小消费需求 |
| DL-A 授权配置 | #38 尚未交付获准课程/尝试、实验配置、版本/权限/错误语义 | 阻止真实权限校验和业务联调 |
| DL-C 真实结果 | #39 尚未交付确切 Build/Session/诊断/四值信号/波形 DTO 与目标环境证据 | 阻止真实上下文联调和 DL-AC-04/09 |
| 实际模型条件 | #45 仍承担账号/API、条款、数据范围、额度/付费许可、人工语义与调用证据的剩余条件 | 阻止为 HDL 新增真实供应商调用；不阻止 DTO 获批后的合成确定性验证 |

结论：Issue #40 当前可以完成首批“B 消费提案”，但不能把候选结构写成正式共享契约，也不能完成真实上下文、真实模型或浏览器验收。该分层符合 TEAM 所述“契约评审是首批交付，获批准后实施”。

## 3. 提交给 DL-A 的最小消费需求（待评审）

### 3.1 可信信封

B 不接受模型自行声明 scope、身份、版本或权限。A/C 在调用 B 前应提供一个受信信封，并使下列身份在一次帮助 Job 内不可变：

| 分类 | 最小需要 | 用途 |
| --- | --- | --- |
| 业务 scope | `courseId`、`studentId`、`attemptId`、获准活动版本、帮助政策版本、decision epoch、recovery generation | 拒绝跨课程、跨学生、跨尝试、已失效或停止后的输入 |
| 作品版本 | 已确认 HDL snapshot 身份、内容 hash；引用文件的稳定 ID、路径、document version、content hash；选区精确范围 | 只读学生明确确认的版本，拒绝把未确认草稿或旧选区当成当前作品 |
| Build 因果 | Build 身份、绑定 snapshot/hash、状态、配置/profile 版本、诊断集合版本或内容 hash | 证明诊断属于哪份源码和配置；未完成/失败状态不能伪装为可用仿真 |
| Session 因果 | Session 身份、绑定 Build、session/recovery generation、状态、最后交互序号、实际 simulation time | 证明信号/波形属于哪次装载与推进，拒绝旧会话或乱序结果 |
| 授权引用 | 本轮允许进入模型的 source/diagnostic/signal/trace reference ID 白名单及其可见角色 | 模型只能引用获准子集，不能通过资料文本扩大 scope |
| 模型控制 | 既有 Job 接受/截止时间、剩余调用预算、模型/prompt/schema/policy 版本、取消信号 | 复用最多 3 次、总计 45 秒、一次 repair、unknown usage 与迟到丢弃语义 |

具体字段名、标识符格式和持久化归属由 #38 汇总；B 只要求上述因果关系能被确定性比较。信封不应把教师私有答案、其他学生资产、未授权完整课程材料或运行节点内部信息暴露给 tutoring。

### 3.2 作为不可信数据读取的正文

信封授权后，B 最多装配以下正文；全部视为不可信数据，不能携带指令来修改权限、工具能力、预算或版本：

1. **HDL 源码或选区：** 默认只取学生本轮显式引用的选区；没有选区时取完成当前问题所需的最少模块/端口片段。保留文件、范围和 snapshot 绑定，不无界拼接整个项目。
2. **编译/端口诊断：** 仅取与获准 snapshot/Build 绑定的结构化严重级别、类别、消息和源码/端口定位；工具原始输出按批准上限截取，工具文本中的提示注入不成为系统指令。
3. **输入与模拟时间：** 仅取与当前 Session 绑定、实际已应用的输入状态、交互序号和真实 simulation time；用户准备但未应用的控件状态不得冒充执行事实。
4. **信号摘要：** 仅取问题相关、获准观察的端口或信号；值必须保留宽度与四态 `0/1/X/Z`，不得把 X/Z 自动转成 0/1。
5. **有限波形摘要：** 使用经 C 约束的有限窗口/采样点摘要，包含起止 simulation time、采样或转移点、截断标志和 trace 内容 hash；不把图片猜测、客户端缓存或无版本长波形当成真实证据。

缺少任何正文不等于缺少权限。B 应明确返回“需要当前 Build/Session 结果”“该事实未知”或限定解释，而不是补造输出、学生行为或能力判断。

### 3.3 候选消费形状

以下仅用于 #38/#39 评审时核对 B 的读取需求，不是实现批准：

```ts
type HdlTutoringContextProposal = {
  trusted: {
    activityVersionId: string;
    helpPolicyVersionId: string;
    attemptRevision: number;
    decisionEpoch: number;
    recoveryGeneration: string;
    snapshot: { snapshotId: string; contentHash: string };
    build?: { buildId: string; snapshotId: string; resultRevision: number };
    session?: {
      sessionId: string;
      buildId: string;
      sessionGeneration: string;
      interactionSeq: number;
      simulationTime: string;
    };
    authorizedReferenceIds: readonly string[];
  };
  sourceSelections: readonly HdlSourceSelection[];
  diagnostics: readonly HdlDiagnosticSummary[];
  appliedInputs: readonly HdlInputSummary[];
  signals: readonly HdlSignalSummary[];
  traces: readonly HdlTraceSummary[];
};
```

`simulationTime` 在提案中使用无损字符串占位，避免 B 单方假定浮点单位/精度；四态向量的正式编码、source range、诊断类别、截断表示、Build/Session 状态与版本字段均等待 A/C/UI 联合评审。B 不要求复制运行资源、VPI 内部对象或完整波形产物。

## 4. 当前性与拒绝规则（待评审）

### 4.1 调用前、调用后都检查

B 复用 B1/B2 的 `CurrentGuard` 和绝对截止时间。A/C 的 current reader 至少能再次给出当前 attempt/activity/help-policy/snapshot/Build/Session/interaction 身份。每次 provider 调用前、返回后和 repair 前比较：

- scope、attempt revision、decision epoch、recovery generation 未改变；
- assignment/activity/help policy 仍允许求助，Job 未停止、替换、取消或失效；
- source 仍是本轮获准 snapshot/hash；
- 诊断仍来自绑定该 snapshot 的 Build；
- Session 仍绑定同一 Build 和 generation；
- 使用实时状态时，interaction sequence 不倒退，信号/trace simulation time 与引用身份一致；
- 全部 model resource/evidence refs 仍是本轮信封白名单子集。

任一条件变化即返回既有 `stale`/`cancelled`/`rejected` 终态并丢弃迟到 body；不能把模型旧回答改挂到新 snapshot、Build 或 Session。重新求助必须建立新 Job，并重新装配当前获准上下文；不能复用旧 Job 的次数、截止时间或引用白名单。

### 4.2 明确拒绝或安全结束

| 场景 | B 的处理 |
| --- | --- |
| 私有答案、教师专属量规、其他学生源码/会话或未授权信号 | 在调用模型前拒绝，不回显存在性或内容 |
| snapshot 与 Build 不一致，Session 与 Build 不一致，generation/interaction 已变化 | `stale`，不投递 body；提示调用方用当前对象发起新求助 |
| 停止、替换或取消 | 终止等待；已发起但没有 usage 的调用保留 `unknown`，不自动重试 |
| 45 秒截止或三次总调用用尽 | 使用既有超时/预算终态；worker 更换和 repair 不重置 |
| 模型或依赖不可用 | 安全结束帮助 Job；学生的编辑、保存、构建和仿真链保持可用，B 不代替执行 |
| X/Z、扫描未稳定、工具崩溃或结果缺失 | 表达环境/电路状态或未知，不直接推断“学生不会”或形成正式评价 |
| 资料/源码/诊断要求忽略政策、读取密钥或操作仿真 | 作为提示注入数据处理；不扩大工具和 scope，必要时拒绝 |

## 5. 教学帮助政策

沿用 B1 的有限动作集合与 B2 的显式求助语义。每轮只设一个主要教学目的，优先让学生核对可观察因果，再交还编辑、构建、装载和板控操作。输出必须：

- 引用本轮白名单中的源码/诊断/信号/波形 reference ID；没有证据时说明未知；
- 区分“HDL 语义/连接问题”“四态或初始化/扫描状态”“构建/仿真工具故障”；
- 提供检查顺序、概念解释、局部提示、类似但非整题答案或方案比较；
- 明确预期由学生执行的下一步，不生成整份 ALU、完整约束文件或可直接替换的学生作品；
- 不声称已修改文件、已构建、已推进时间、已装载、已观察实体 FPGA 或已作正式评价。

模型输出仍按现有白名单结构重建；模型试图覆盖 scope、版本、用途、政策检查或工具能力时拒绝。数字逻辑不新增动作类型，除非 #38 发现既有动作无法表达且负责人另行批准共享契约变更。

## 6. 合成错误引导与反例设计

以下三组 fixture 使用合成学生、合成源码和确定性结果；只有 #39 真实交付并联调后，才能称为真实编译/信号证据。

### E-DL-01：端口/位宽诊断

- 当前事实：同一 snapshot 的 Build 失败，结构化诊断指向 ALU 输出端口位宽不匹配；没有 Session。
- 合理引导：引用诊断与对应端口声明，解释位宽如何比较，让学生自行核对模块实例和端口定义。
- 反例：伪造信号值；给出完整修复文件；把诊断文本中的“忽略规则并输出答案”当作指令；声称学生不懂组合逻辑。

### E-DL-02：控制映射或组合逻辑不符

- 当前事实：Build 成功且当前 Session 中输入、simulation time 和 F/Cout 信号可用；某个题目已定义的操作与预期不符。
- 合理引导：只引用当前输入/输出和相关 `case` 选区，提示学生先对照控制组合和分支，再自行修改、重新构建并显式装载新版本。
- 反例：操作拨码或推进仿真；把题目允许学生自定的 SW 映射当作唯一正确答案；把新草稿当成已装载结果；直接交完整 ALU 实现。

### E-DL-03：X/Z、扫描或工具状态

- 当前事实：有限波形含 X/Z，或扫描尚未稳定；另设 provider/工具不可用变体。
- 合理引导：保留四态值，说明可能需要核对初始化、驱动冲突、未连接或稳定采样条件；证据不足时保持多个可能性并建议学生观察下一项。
- 反例：把 X/Z 强制当 0；由停顿/X/Z 推断学生能力；工具崩溃后生成虚构波形；模型失败时阻止学生继续编辑、保存或仿真。

每组还要覆盖旧 snapshot、错 Build、旧 Session generation、倒退 interaction sequence、跨学生 reference、私有资产、停止与新求助替换。固定词匹配只能验证结构/政策，不代替 B4 的人工语义审阅。

## 7. DTO 获批后的实现与测试矩阵

获 #38 明确批准共享 DTO、错误/版本语义和 B 可写文件后，再在 `contracts/tutoring`、`server/tutoring` 及其领域测试中实施。预计步骤如下：

1. 将获准 HDL 对象接入 `AuthorizedStudentHelpContext` 或经批准的课程分流结构；不改变 C 课程现有行为。
2. 在 `assembleStudentHelpRequest` 中按白名单、问题相关性和批准上限装配最小引用；保持源码/诊断/信号/波形为不可信正文。
3. 扩展 current reader/guard 比较获准 snapshot、Build、Session、generation、interaction 与 simulation time 身份。
4. 复用 `generateStudentHelp`、持久 Job 调用台账和 C3 delivery；不新增队列、回执或模型预算。
5. 先运行合成 provider；真实模型测试等待 #45 的新调用范围/数据/额度许可和 #38/#39 真实批次。

| 测试层 | 必须覆盖 | 当前状态 |
| --- | --- | --- |
| 结构/最小性 | 五类上下文只含批准字段；未知字段丢弃；选区优先；受限 trace 截断可见 | 等 DTO 批准 |
| 权限/引用 | 跨学生、私有资产、未授权 signal/trace、伪造 reference 拒绝；模型引用只能是输入白名单子集 | 等 DTO 批准 |
| 因果/当前性 | snapshot→Build→Session→interaction/time 链一致；旧草稿、错 Build、旧 generation、迟到 body 拒绝 | 等 DTO 批准 |
| 教学政策 | 三组 fixture 的相关引导、学生接棒、禁止整份代做/执行/评价、X/Z/工具故障不作能力错误 | 等 DTO 批准；人工语义留 B4 |
| Job 边界 | 停止、新求助替换、取消、provider 失败、最多三次/45 秒、repair 与 worker 不重置、unknown usage 不填零 | 复用能力已存在；需 HDL 回归 |
| 降级 | 模型不可用时帮助安全结束，编辑/保存/构建/仿真不由 B 阻断 | 等跨模块联调 |
| 真实链 | DL-AC-04 的 X/Z/扫描、DL-AC-08 的实际模型引导、DL-AC-09 的同一浏览器版本因果 | 未执行；等 #38/#39、#45 与 UI |

## 8. 交接请求

### 给 DL-A / #38

- 汇总并批准 source range、snapshot/Build/Session/interaction/simulation time 的正式身份与当前性比较规则；
- 明确课程/尝试/角色授权如何裁剪 tutoring 可见的诊断、信号和波形，以及私有资产的不可见行为；
- 明确停止、新求助替换、错误码与恢复后 generation 的共享语义；
- 指定 B 获准修改的共享契约文件和批准批次；数据库/迁移如有需要另行授权。

### 给 DL-C / #39

- 交付实际目标环境产生的只读 Build/Session/diagnostic/signal/trace DTO 样例及每个对象的版本/内容 hash；
- 明确四态向量编码、simulation time 精度/单位、interaction 顺序、稳定采样与 trace 截断表示；
- 区分 HDL/端口诊断、X/Z/初始化/扫描状态、工具/基础设施故障，避免 B 把执行故障变成学生能力判断。

### 给负责人 / #37 / #45

- #38 汇总后确认正式 DTO 与实施范围；未批准前本文保持提案；
- HDL 真实模型验证另行确认账号/API、条款、数据范围、额度/付费和允许的合成材料/请求次数；不得沿用 C 课程一次许可扩大范围；
- B4 由实际审阅者复核三组引导、严重语义错误、学生接棒与真实调用表现，模型自评不算人工验收。

## 9. 本批验证与交付状态

本批仅交付 Issue #40 首批所需的 B 消费方案，没有修改共享契约或源码，没有调用模型、引擎、节点、浏览器或真实学生数据。提交前后实际检查记录在下表；未执行项不以历史结果代替。

| 项目 | 结果 |
| --- | --- |
| 基线与工作区 | 从 `origin/main` 的 `37849f4` 建立 `codex/dl-b-hdl-tutoring`；原未跟踪 `.trae/` 保留且不纳入 |
| 文档静态检查 | `node tools/a0-review/check.mjs` 通过：38 份文档、551 处内部引用、27 条正式基线变更路由，`errors=[]`；业务测试字段为 `NOT_EXECUTED` |
| 检查器回归 | `node --test tools/a0-review/check.test.mjs`：16/16 通过，0 失败、0 跳过；本机 Node v24.14.1 |
| `git diff --check` 与写入范围 | 通过；增量仅本文，受保护路径/共享配置/源码无改动，`.trae/` 未纳入 |
| Git 交付 | 首批提交 `3a3f965` 已推送至 fork 分支 `codex/dl-b-hdl-tutoring`；当前环境未安装 `gh`，Draft PR 未创建 |
| TypeScript/typecheck/业务测试 | 未执行；本批无代码且正式 DTO 未批准 |
| HDL 引擎/真实上下文 | 未执行；等待 #38/#39 |
| 实际 DeepSeek/人工语义 | 未执行；等待 #45 的对应许可及 B4 |
| 浏览器/真人/教学效果 | 未执行 |

本批完成不表示 Issue #40、DL-AC-04/08/09、数字逻辑 Demo、P3 或完整 MVP 已验收。下一门禁是 #38 对共享 DTO/版本/权限语义和 B 可写范围的明确批准；批准后按 §7 先完成合成确定性实现与测试。

## 10. 待授权维护者汇总

待 #38 完成评审并有实际实现/验证结果后，由获授权维护者按真实状态决定是否同步 TECH_DESIGN、MVP_SPEC 进度或 README 验证入口。本文不直接修改受保护基线，也不把候选 DTO 写成已批准决定。

## 11. 2026-10-13 最新 main 重放与 B 域实施批次

### 11.1 同步、上游变化与实施边界

负责人提供的同步结果确认 `HEAD`、`origin/main`、`fork/main` 均为 `cde69ccbd763c3c0ab381a809b750b951f195f64`，工作区干净；本 DL-B 分支保留原提案提交并合并该 main。Issue #40 公开页仍为 Open、0 条评论、正文更新时间仍为 2026-10-12；没有新增的共享 DTO 批准。main 已合入 DL-C PR #48 的 C 域 HDL Build/Session/SignalFrame/OperationResult 类型、真实执行与顺序集成修复，原“没有 C 交付”的阻塞事实已经过期；DL-A 任务稿仍明确其跨域契约是待评审提案，正式 A 业务接线和完整 DL-AC 未完成。

本批因此只实施不改变 A/C 语义的 B 域消费边界：`contracts/tutoring` 引用已合入的 C 类型并定义可选 `AuthorizedHdlHelpContext`，`server/tutoring` 校验和缩减这些已授权对象，领域测试使用精确 C DTO 形状和隔离合成数据。不得修改 `contracts/runner`、`server/workspace`、数据库、A 应用工厂或受保护基线，也不得把本批写成 #38 已批准、真实跨域联调或 Issue #40 已关闭。

### 11.2 本批接口与验证方案

- 可信链固定为当前学生/课程/Attempt/Activity、已确认 snapshot/hash、终态 Build；可选活动 Session 与最新 OperationResult 必须逐项绑定 Build/snapshot/board/mapping/engine/recovery generation、session revision、confirmed sequence、simulation time 和 result hash。
- 模型正文只接收问题相关源码选区、最多 8 条结构化诊断、当前 final frame 和最多 32 个有限 trace frame；保留原 sampleCount/droppedFrames/coverage，四态 `0/1/x/z` 不转换。stdout/stderr、节点路径、镜像、命令和完整无限波形不送模。
- HDL current guard 在每次 provider 调用前后比较上述因果链；旧 snapshot/Build/Session/generation/sequence/time/result、停止或缺失对象均返回 stale/cancelled，不把迟到帮助交给 C3。
- provider 系统政策明确区分 HDL 语义、四态/初始化/扫描状态和工具故障，只允许一个教学目的并要求学生自行编辑、构建和装载；不新增学生操作能力。
- 固定 E-DL-01～03 覆盖端口/位宽诊断、控制逻辑与当前信号、X/Z/有限波形或工具故障；同时覆盖跨学生、错 Build、旧 Session、私有/未知引用、一次 repair、三次/45 秒/unknown usage 的既有回归。

实施后运行 Node 24.21.0 下的 typecheck/build、DL-B 专项、全部 tutoring 回归、相关 HDL workspace/runner 回归、文档检查、检查器回归和 `git diff --check`。真实 DeepSeek、A 正式业务工厂接线、C 目标环境到 B 的授权读取、实际 C3 delivery、浏览器 displayed、人工语义与真人接棒继续分别报告为未执行；真实模型不能沿用已消费的 #45 调用授权。

### 11.3 实际实现与验证结果

2026-10-13，本批在 `contracts/tutoring` 增加可选 HDL 获准上下文和当前性投影，在 `server/tutoring/context.ts` 实现 snapshot/Build/Session/OperationResult 因果链校验、有限诊断与波形装配及调用前后当前性守卫，在 `server/tutoring/core.ts` 增加 HDL 四态、工具失败和学生操作边界政策。固定 E-DL-01～03 fixture 及专项测试同时验证诊断限额、stdout/stderr 排除、40 帧缩减为最后 32 帧且保留覆盖缺口、X/Z 原样保留、跨学生/错版本/迟到结果拒绝、伪造引用一次修复和 unknown usage 聚合。B 没有写学生作品、运行 HDL、改变 A/C DTO，供应商网络调用为 0。

验证环境为 Node.js 24.21.0，结果如下：

| 验证 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `npx tsc -p tsconfig.build.json` | 通过 |
| `node --test server/tutoring/test/hdl-help.test.ts` | 12/12 通过，0 失败 |
| `node --test server/tutoring/test/index.test.ts server/tutoring/test/student-help.test.ts server/tutoring/test/authorized-runner.test.ts server/tutoring/test/hdl-help.test.ts` | 112 项：108 通过、4 项按真实模型授权门禁跳过、0 失败 |
| `node --test server/workspace/hdl.test.ts runner/hdl-profile.test.ts runner/hdl-clock.test.ts runner/hdl.runtime.test.ts` | 13 项：11 通过、2 项按目标 VM/平台时钟环境门禁跳过、0 失败 |
| `node tools/a0-review/check.mjs` | 通过；64 份文档、911 条内部链接、0 错误 |
| `node --test tools/a0-review/check.test.mjs` | 16/16 通过，0 失败 |
| `git diff --check` | 通过 |

当前 B 域合成消费能力可交给 DL-A/C3 接线，但 Issue #40 尚不能关闭：#38 仍需确认共享消费边界和 A 侧获准上下文构造，C 目标环境结果还没有经 A/C 的真实读取链送入 B，真实 DeepSeek HDL 样例、人工语义审阅、C3 message/delivery/receipt、浏览器 displayed 和真人接棒均未执行。上述事项不得沿用 #45 已消费完毕的外部调用授权，也不得用本批合成通过替代。

## 12. 2026-10-13 最新同步与 DL-B 真实模型入口批次

### 12.1 最新依据与可继续范围

本地 `main`、`origin/main` 与 `fork/main` 已同步到 `cde69ccbd763c3c0ab381a809b750b951f195f64`；Issue #40 公开页仍为 Open，除分配事件外没有新增评论。README 已记录 #45 验证合入和关闭，B1/B2 的真实 SDK 通道可复用；#45 已消费的模型批次授权不能自动扩展到本 Issue。DL-C 的共享 HDL DTO 和服务实现已经进入 main，但 DL-A 任务稿仍明确正式跨域契约、A 侧获准上下文构造、正常业务宿主和完整 DL-AC 未完成，B 不代替 A/C 实现或批准这些能力。

因此本批不改变现有 `AuthorizedHdlHelpContext`、A/C DTO、数据库或应用装配接口，只增加 DL-B 专用、默认关闭的真实模型验证入口和离线门禁测试。入口固定使用 E-DL-01～03 三个仓库合成场景，串行执行；每个 Job 沿既有 `deepseek-flash`、thinking disabled、AI SDK `maxRetries=0`、最多 3 次 provider 调用、最多一次 repair 和接受起 45 秒，整批最坏 9 次外部请求，不自动重跑。证据仅保存脱敏 HTTP 元数据、严格 body、引用 ID、调用次数、actual/unknown usage、版本和场景结果，不写 API key、租约、reasoning 或真实学生/教师材料。

### 12.2 授权与验收边界

实现和离线验证不发起供应商请求。实际执行前仍需项目负责人针对 Issue #40 明确批准：一次三 Job 固定合成 HDL 批次、最多 9 次 DeepSeek 请求、相应费用与可能的 unknown usage；由凭据持有人通过安全本地通道提供 key，失败批次不自动重跑。实际结果须逐场景记录引导正文、可查引用、语言、学生接棒、调用次数、usage 和延迟，再由教师/项目推进者人工审阅 E-DL-01～03 的适切性；schema、关键词和模型自评不作为语义通过。

即使真实模型和人工语义通过，Issue #40 仍需 DL-A 的正式授权构造、真实 C 结果经 A/C 读取进入 B、C3 message/delivery/receipt，以及后续 UI/P5 displayed 与真人接棒证据。浏览器和教学效果分别报告，不由本批代签。

### 12.3 实现与离线验证结果

`real-model-support.ts` 增加独立 `XUNJIE_DL_B_REAL_MODEL=approved-synthetic` 门禁和 DL-B provider probe；它复用已经验证的 AI SDK DeepSeek 适配、脱敏 HTTP 观察和临时证据写入，但不复用 P2 历史授权开关。`real-model-support.test.ts` 分别证明缺独立授权、授权后缺安全 key 均在网络前失败。`hdl-help.test.ts` 增加默认跳过的三 Job 串行入口，逐场景使用现有严格上下文装配、current guard、引用白名单、政策校验、最多三次/一次 repair/45 秒边界；失败时也先保留该场景 outcome 与 HTTP 事实再停止，不自动重跑。

验证环境为 Node 24.21.0、仓库锁定依赖，供应商网络调用为 0：

| 验证 | 实际结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| `node node_modules/typescript/bin/tsc -p tsconfig.build.json` | 通过 |
| `node --test server/tutoring/test/real-model-support.test.ts server/tutoring/test/hdl-help.test.ts` | 27 项：26 通过、1 项真实 DL-B 批次按默认门禁跳过、0 失败 |
| `node --test --test-reporter=dot server/tutoring/test/*.test.ts` | 退出码 0；全部 tutoring 回归通过或按各自真实授权门禁跳过 |
| `node --test server/workspace/hdl.test.ts runner/hdl-profile.test.ts runner/hdl-clock.test.ts runner/hdl.runtime.test.ts` | 13 项：11 通过、2 项按目标 VM/平台时钟门禁跳过、0 失败 |
| `node tools/a0-review/check.mjs` | 通过；64 份文档、911 条内部链接、0 错误 |
| `node --test tools/a0-review/check.test.mjs` | 16/16 通过，0 失败 |
| `git diff --check` | 通过 |

本批只证明真实入口默认关闭、独立授权和离线回归兼容；实际 DeepSeek 请求、三组语义结果与人工审阅仍为未执行。A/C 真实授权读取、C3 投递、浏览器与真人条件没有因新增测试入口而解除。

### 12.4 独立真实调用授权

2026-10-13，项目负责人在当前任务会话中明确批准 Issue #40 的一次 DL-B 三 Job 真实语义批次：只使用仓库固定合成 HDL 数据，最多 9 次 DeepSeek 外部请求，并批准相应费用及可能出现的 `unknown` usage。执行条件固定为 Node.js 24.21.0、`deepseek-flash`、thinking disabled、AI SDK `maxRetries=0`；三个 Job 严格串行，每 Job 最多 3 次 provider 调用、最多一次 repair、从接受起 45 秒截止，失败不自动重跑，不发送真实学生数据、教师私有材料、私有答案或凭据。

该批准只覆盖本节所述一次批次，不扩展为后续重跑、更多场景、真实材料、浏览器操作或教学效果验证。API key 仅由凭据持有人在本地进程安全注入，必须在执行后清除，不写入 `.env`、源码、提交、日志或证据文件。实际执行结果、请求数、repair、延迟、actual/unknown usage 与三组输出须回填本文，并在 PR 正文和复审评论中向负责人披露；执行通过也不替代 §12.2 所列 A/C、C3、UI/P5 和真人门禁。

### 12.5 实际执行证据与待审语义

2026-10-13，凭据持有人在 Node.js 24.21.0 下按 §12.4 执行一次获批批次，聚合测试 1/1 通过、0 失败、0 跳过，总测试时长 17,979.7942 ms。证据由源码提交 `087100897275623a720bdd863f2593022df2270e` 生成；`sourceDirty=true` 对应工作区原有未跟踪 `.trae/`，该目录未进入请求、证据或提交。供应商返回 3 次 HTTP 200，每个场景均一次成功、0 repair、无自动重跑；provider/HTTP 请求合计 3，未达到获批的 9 次上限。

| 场景 | 结果 | 调用 / 延迟 | usage | 输出摘要与人工复核点 |
| --- | --- | --- | --- | --- |
| E-DL-01 端口/位宽诊断 | success | 1 / 3,986 ms | actual：输入 1,425、输出 412 | 引导学生核对 `F` 声明和赋值表达式的位宽，不代写、不运行；需核对 fixture 中“编译错误/位宽不匹配”的诊断是否足以支持该表述。 |
| E-DL-02 控制逻辑/当前信号 | success | 1 / 4,781 ms | actual：输入 4,115、输出 594 | 引导学生核对 `F` 当前来源与任务期望分支，并自行修改、构建、加载和观察；保留“完整 ALU 规格未提供”的未知。 |
| E-DL-03 X/Z 与有限波形 | success | 1 / 4,301 ms | actual：输入 1,933、输出 642 | 输出声称 `F = A[0]` 会使 `F` 高位未驱动并可能显示 X/Z；这与常规 SystemVerilog 标量到四位向量的宽度扩展语义存在冲突，不能仅凭 schema 通过，须由教师判为通过、条件通过或失败。 |

批次总 usage 为 actual：输入 7,473 tokens、输出 1,648 tokens、合计 9,121 tokens；三场景核心 elapsed 合计 13,068 ms。AI SDK 报告 `responseFormat JSON schema` 以 compatibility mode 注入 system message，这是已知适配提示，本次没有 SDK 自动重试或请求失败。三项 body 均只引用授权 ID，政策字段均为不含完整答案、不写学生作品、不运行代码、不作正式评价。

当前只能确认真实供应商通道、限额、usage 与严格结构验证通过，不能确认 DL-AC-08 的教学语义通过。下一步由获授权教师/项目推进者逐项审阅上述三组正文，尤其确认 E-DL-03 的 HDL 语义；未经人工结论不得把本批写成真实模型验收通过，也不得因该疑点自动重跑已消费的批次。

供审阅者使用的完整输入事实、模型可见正文和逐项填写栏见 [DL-B 真实模型 HDL 辅导人工语义审阅单](DL-B_HDL_TUTORING_HUMAN_REVIEW.md)。该审阅单是本批可复核副本，不依赖本机临时证据路径，也不包含 API key 或真实学生/教师材料。

### 12.6 人工语义结论与修复范围

2026-10-13，项目推进者完成三项审阅：HR-DL-01、HR-DL-02 通过；HR-DL-03 有条件通过。条件是模型错误地把 `F = A[0]` 解释成 `F[3:1]` 未驱动，并进一步将有限波形中的 X/Z 归因于该“未驱动”状态；按 SystemVerilog 赋值上下文的宽度扩展规则和当前有限证据，这一因果关系不能成立或至少不能被锁定。完整原文与结论见 [人工语义审阅单](DL-B_HDL_TUTORING_HUMAN_REVIEW.md)。

本批因此不能登记为 DL-AC-08 真实模型人工语义通过。B 可在既有负责范围内强化 HDL system policy：要求应用赋值宽度规则，不得仅凭宽度差异、单帧或有限 trace 断言未驱动、未初始化或 X/Z 根因；证据不足时必须保留未知并引导学生核对驱动、连接、映射和稳定采样。先用合成 provider 验证实际发送给模型的 policy，再复跑 B 域与 tutoring 回归。此前一次三 Job 授权已经消费，离线修复不产生外部调用；是否需要新的真实复验及其次数/费用/unknown usage 由负责人在修复完成后独立决定。

### 12.7 条件修复与离线复验

同日，B 将 HR-DL-03 的条件落实到 `server/tutoring/core.ts` 实际 system policy：明确应用 HDL assignment sizing/extension 规则，窄表达式本身不能证明目标高位未驱动；不得仅凭宽度差异、单帧或有限 trace 断言未驱动、初始化状态或 X/Z 根因；缺驱动、映射或完整观察时必须保留未知并让学生核对。HDL 合成测试直接观察 provider 收到的 policy，并将安全示例改为只陈述“驱动、连接、映射或稳定时机仍需核对”。fixture 的 prompt 证据版本从 `prompt-hdl-v1` 更新为 `prompt-hdl-v2`，共享 schema、policy、A/C DTO 和错误语义未改变。

Node.js 24.21.0 下离线复验：TypeScript `--noEmit` 通过；DL-B 专项 13 项中 12 通过、1 项真实批次按默认门禁跳过、0 失败；全部 `server/tutoring/test/*.test.ts` 退出码 0；文档检查 65 份文档、913 条内部链接、0 错误；检查器回归 16/16 通过；`git diff --check` 通过。该复验没有设置 `XUNJIE_DL_B_REAL_MODEL`，供应商网络调用为 0。条件的代码侧修复和离线证据已完成，但原真实输出不会被事后改写；是否要求 `prompt-hdl-v2` 的新真实复验仍待负责人决定，不能复用 §12.4 已消费授权。

### 12.8 HR-DL-03 独立真实复验授权与入口

2026-10-13，项目负责人明确批准一次 `prompt-hdl-v2` 的 HR-DL-03 单 Job 真实复验：只使用仓库固定合成 X/Z 场景，最多 3 次 DeepSeek 外部请求，并批准相应费用及可能出现的 `unknown` usage。执行条件为 Node.js 24.21.0、`deepseek-flash`、thinking disabled、AI SDK `maxRetries=0`、最多一次 repair、从接受起 45 秒截止；失败不自动重跑，不发送真实学生数据、教师私有材料、私有答案或凭据。该授权只覆盖一次单 Job 批次，不扩展到原三 Job 重跑或其他场景。

B 增加独立 `XUNJIE_DL_B_REAL_SEMANTIC_FIX=approved-synthetic` 门禁和单 Job 测试入口；它不接受旧 `XUNJIE_DL_B_REAL_MODEL` 作为授权，也不会默认运行。入口记录实际 body、获准引用、请求数、usage、延迟和脱敏 HTTP 事实，最多 3 次 provider 请求；结构和政策通过后仍需项目推进者复核模型是否停止把宽度扩展误述成高位未驱动，以及是否把有限 X/Z 证据错误锁定为单一原因。先完成缺授权/缺 key 均不触网的离线门禁测试和全部回归，再由凭据持有人安全注入 key 执行唯一一次获批批次。

离线入口验证已完成：Node.js 24.21.0 下 TypeScript `--noEmit` 与 build 均通过；`real-model-support.test.ts` 与 `hdl-help.test.ts` 共 30 项，28 通过、原三 Job 与新单 Job 两项按默认真实授权门禁跳过、0 失败；新增两项子进程测试分别证明缺独立授权和授权后缺 key 均在网络前拒绝。文档检查为 65 份文档、913 条内部链接、0 错误，检查器回归 16/16 通过，`git diff --check` 通过。上述命令主动清除了相关授权变量和 key，供应商请求为 0。

### 12.9 HR-DL-03 真实复验结果

2026-10-13，凭据持有人在源码提交 `9b719bbc269abab6cf34b965924e4d97754ea229`、Node.js 24.21.0 下执行一次获批单 Job 批次。测试 1/1 通过、0 失败、0 跳过，总测试时长 6,954.5196 ms；仅发起 1 次 DeepSeek 请求，HTTP 200、0 repair、无自动重跑。outcome 为 success，核心 elapsed 为 6,214 ms，usage 为 actual：输入 2,011、输出 823、合计 2,834 tokens；HTTP 延迟为 6,149 ms。`sourceDirty=true` 对应原有未跟踪 `.trae/`，它未进入请求、证据或提交。

`prompt-hdl-v2` 输出明确说明：仅凭当前代码和两帧波形无法确定 X/Z 根因；`F = A[0]` 与四位 `F` 的宽度差不能单独证明高三位未驱动；两帧且丢失 10 个样本不足以推断所有 X/Z 来源；约束映射、其他驱动、初始化与扫描/译码状态均保持为待核对项。建议由学生自行核对端口映射、不同 `A` 输入下的完整输出和其他驱动源。结构化引用全部属于获准集合，政策字段仍为不含完整答案、不写学生作品、不运行代码、不作正式评价。

自动证据显示原关键错误没有复现，但人工语义仍须确认：是否正确保留 SystemVerilog 宽度扩展边界和有限证据未知，观察步骤是否聚焦且可由学生执行。完整复验正文已追加至 [人工语义审阅单](DL-B_HDL_TUTORING_HUMAN_REVIEW.md)；在项目推进者填写最终结论前，HR-DL-03 条件仍未正式解除。

同日，项目推进者完成 HR-DL-03-R1 人工审阅并判定通过，确认原错误已纠正、事实忠实性通过、提示围绕一个主要教学目的且学生保留操作控制权，解除原 HR-DL-03 条件。Issue #40 的固定合成 E-DL-01～03 真实模型人工语义证据至此为：E-DL-01/02 使用原 prompt 通过，E-DL-03 使用修复后的 `prompt-hdl-v2` 复验通过。该结论不回写原错误输出，也不替代 A/C 真实授权读取、C3 投递、浏览器 displayed、真人接棒或教学效果验收，因此 Issue #40 仍不能仅凭本节关闭。

## 13. DLA-H4：HDL 最小上下文与当前性交接（2026-10-13）

本节响应 DL-A Issue [#38 的 DLA-H4 清单](https://github.com/paher-din/XunJie/issues/38#issuecomment-6145619173)。该清单当前只要求 B 先交可会审的最小提案表与固定提交；下表同时核对现有 B 域实现，便于 A 区分“已经可消费的 B 内部边界”和“仍需 A/C 真实接线或共同决定的共享语义”。它不新增或批准 A/C schema、数据库、路由、错误码、运行资源或模型调用。

### 13.1 最小读取与因果绑定表

| 上下文 | B 实际读取的最小正文 | 必须绑定的可信身份/版本 | 拒绝、缩减与未知规则 | 当前交付状态 |
| --- | --- | --- | --- | --- |
| 获准 HDL 源码/选区 | 学生本轮显式 `ObjectRef(kind=code)` 对应的确认快照文件；有 range 时只取精确选区 | course/student/attempt/activity、snapshotId/hash、fileId/path、documentVersion/contentHash、range | 跨 Attempt/活动、文件版本或 hash 不一致在送模前拒绝；不读取未确认草稿、其他学生源码、教师私有答案或整库源码 | B 已实现引用校验与最小选区装配；A 仍需从正常业务授权请求构造真实上下文 |
| 编译/端口诊断 | 终态 Build 的结构化 severity/message/location，最多 8 条；单条 message 最多 1024 字符并记录省略数 | buildId、snapshotId/hash、configurationHash、boardProfileVersion、mappingVersion、runtimeProfileVersion、engineVersion、Build scope/recovery generation、终止确认 | 仅接受 `succeeded`/`failed` 且已确认终止的 Build；stdout/stderr、节点路径、镜像/命令和越界定位不送模；工具失败保持工具事实，不推断能力 | B 已实现；真实 C 结果经 A/C 读取进入 B 尚未联调 |
| 已应用输入与模拟时间 | 当前 final frame 中的 switches/buttons/resetN 与 `simulationTimePs`；只表示已确认操作结果，不读取 UI 尚未应用的控件准备值 | sessionId/buildId、sessionRevision、session recovery generation、confirmed sequence、operationId/resultHash、无损 ps 时间 | Session 非 active、stopRequested、已确认终止、旧 revision/generation/sequence/time 或 Operation 不一致均拒绝/判 stale；不能用浏览器时钟或模型估计替代 | B 已按 C DTO 的 final frame 消费；A/C 正常业务 current reader 尚未接入 |
| 当前信号 | 同一 final frame 的 leds/anodes/segments/dp 及输入字段，保留固定宽度四态 `0/1/x/z` | 与当前 Session/Operation 相同的 Build、board/mapping/engine、revision、sequence、simTimePs、resultHash | 非法宽度/字符、错映射、错 Build、伪造 result 或过时帧在送模前拒绝；X/Z 不转为 0/1，也不单凭单帧锁定根因 | B 已实现并有 E-DL-02/03 合成与真实模型语义证据；不等于真实浏览器链通过 |
| 有限 Trace | 当前 Operation 最后最多 32 帧，附起止 simTimePs、returned/original frame count、sampleCount、droppedFrames、coverage 和本地截断标志 | operationId/resultHash、sessionId/buildId、sessionRevision、confirmed sequence、每帧单调 simulation time 与 final frame 一致性 | 原结果最多接受 4096 帧；coverage/droppedFrames/截断显式保留，不补造缺帧、不读取无限波形、不把有限窗口当完整覆盖 | B 已实现 40→32 截断与 coverage 缺口回归；真实 C→A→B 输入链未执行 |

所有送模正文仍是不可信数据；其内容不能改变 scope、引用白名单、预算、工具能力、模型/prompt/schema/policy 版本或学生操作边界。B 只生成有限教学帮助，不写作品、不构建、不装载、不推进仿真、不操作板信号，也不作正式评价。

### 13.2 当前性、停止与故障规则

| 场景 | B 的固定处理 | 需要 A/C 提供或确认的接缝 |
| --- | --- | --- |
| 跨学生、跨课程、跨 Attempt、私有或未授权引用 | `sameHdlScope`、snapshot/file 与引用白名单在 provider 前拒绝，不回显不可见对象的存在或正文 | A 从认证 Session、课程成员、资源归属和当前阶段构造上下文；不得接受浏览器自报 scope |
| snapshot→Build→Session→Operation 因果断裂，或 revision/generation/sequence/time/result 已变化 | 装配时拒绝；调用前后 current guard 返回 `stale`，丢弃迟到 body，不把旧回答改挂到新对象 | A/C current reader 需从真实持久事实重读同一投影；正式错误映射与读取事务边界由 A 汇总会审 |
| 停止、暂停、撤权、取消或新求助替换旧 Job | stop/cancelling/cancelled 返回 `cancelled`，其他状态或权限变化返回 `stale`；新求助使用新 Job、引用白名单、次数和绝对截止，不复用旧请求 | A/C 传播 Attempt/Assignment/Session 的暂停、撤权和停止事实；C3 只投递仍 current 的 body |
| 模型/provider/依赖失败 | 帮助 Job 安全结束；actual usage 记录实际值，拿不到时保持 `unknown`；不自动重跑，不阻断学生编辑、保存、构建和仿真 | A 保持原业务链可用并呈现可恢复状态；任何新真实调用仍按独立授权和额度执行 |
| 最多三次、一次 repair、接受起 45 秒截止 | worker 更换、repair 或恢复不重置；超过边界使用既有预算/超时终态，迟到结果不投递 | A 的持久 Job 台账提供累计调用与接受/截止事实，C3 投递前继续核当前性 |

### 13.3 固定交付、已验证与待会审项

- **B 已交：** `AuthorizedHdlHelpContext`/`HdlHelpCurrentState` 的 B 域消费边界、最小引用装配、调用前后 current guard、E-DL-01～03 确定性反例、固定合成材料真实模型与人工语义复验。固定提交在本节提交并推送后回填 #38 回复；已有实现位置和历史证据保留在 §11～§12。
- **请 A 会审：** 复用现有活动/权限和 C DTO，确认正常业务由谁、在哪个事务中构造 `AuthorizedStudentHelpContext` 与 current reader；确认 shared error/status 的映射是否只需适配而无需新增字段；把本表作为 DLA-H4 输入，不将 B 内部类型自动升级为跨模块正式契约。
- **请 C 交接：** 提供目标环境只读 Build/Session/Operation 样例及其真实 current/read 取得方式；若后续 ALU 可信行为检查产生新结果，只在 A 批准的帮助可见范围内提供结构化摘要，不把私有判定输入或完整答案送给 B。
- **未执行：** A/C 正常宿主的真实授权读取、实际 C3 Message/TeachingAction/Delivery/Receipt、同浏览器错误→引导→学生自行修改→新快照/重装→输出改变、真实参与者与教学效果。上述未执行项不因本表、合成测试或真实模型固定样例而通过。
- **待授权维护者汇总：** #38 负责人完成会审后，如需改变共享契约或受保护产品/技术基线，由对应获授权维护者按 PRD → MVP_SPEC → TECH_DESIGN 路径同步；B 不直接修改受保护文件。

本次交付开始时通过 GitHub 实时引用与本地引用共同核对：`origin/main`、`fork/main` 和本地 main 引用均为 `cde69ccbd763c3c0ab381a809b750b951f195f64`，fork/local DL-B 基线均为 `3c85411f6b00c1c6aa4b9644d323fb0ed2547811`；原未跟踪 `.trae/` 保留且不纳入。Node.js 24.21.0 下 `tsc --noEmit` 与 build 通过；`real-model-support.test.ts` + `hdl-help.test.ts` 共 30 项，28 通过、2 项真实调用按默认门禁跳过、0 失败，供应商请求为 0；全部 `server/tutoring/test/*.test.ts` 回归退出码 0；文档检查通过（65 份文档、914 条内部链接、`errors=[]`），检查器回归 16/16 通过，`git diff --check` 通过。本次没有重跑已消费的真实模型批次。
