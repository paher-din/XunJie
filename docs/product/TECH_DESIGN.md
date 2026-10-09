# TECH_DESIGN：独立 Web 教学应用

版本：0.3 · 初稿依据：2026-10-04 · G0 负责人统一裁决：2026-10-09（Asia/Shanghai）

状态：G0 技术契约和分段实施方案已获负责人统一批准；未创建应用、数据库或部署环境，业务/隔离/浏览器验收未执行。
上游：[PRD](PRD.md) → [MVP_SPEC](MVP_SPEC.md)

## 1. 架构结论与决策

**后台采用一个 TypeScript 模块化应用服务，统一教师设计、学生会话、学习状态和教师复核；Web UI 由团队成员交付，本工作项在其基础上接入后台与 Agent，学生代码交给独立执行环境。** 小规模试点先用单机 SQLite 和持久化作业记录，模型调用有界，课程资料按权限和目标检索。教学内核不依赖 Codex 宿主。

2026-10-09 项目负责人统一批准后台、模型、数据、共享契约与进入条件，并明确授权合入本文件，见 [裁决记录](../tasks/G0_CLOSURE_PROPOSAL.md#10-2026-10-09-负责人统一裁决及基线同步)。下表为批准方案；安装/兼容/性能/安全仍需真实核验。本文件不定义前端框架、页面、布局或视觉，不记为 A/B/C 逐人签认。

| ID | 决策 | 原因与取舍 | 改选条件 |
| --- | --- | --- | --- |
| TD-01 | 独立 Web 应用，应用自己管理教学消息和回执 | 用户已确认；补齐宿主 Hook 无法保证的完整消息链 | 若产品方向改变，先修订 PRD |
| TD-02 | Web UI 沿用成员交付；后台 Node.js 24 LTS + TypeScript + Fastify，精确版本见第 3.1 节 | 保持既定分工和单应用方案 | 实际组合失败先修复/提出差异，不要求前端更换框架 |
| TD-03 | SQLite + better-sqlite3；单应用进程负责业务数据库 | 1 位教师、小队列、单机部署；事务能表达版本和纠正一致性 | 多实例/多机写入成为必要，或批量同步后写竞争仍不达标，再迁 PostgreSQL |
| TD-04 | AI SDK Core 的有界调用；按职责隔离上下文 | 复用调用与工具循环能力，不造通用 Agent 平台 | 持久化分支/外部等待成为主要复杂度时再评估工作流框架 |
| TD-05 | 结构化状态 + 引用原文；无需向量库或外部记忆产品 | 首版课程材料小，课程/目标过滤后可做明确检索 | 固定查询评估证明召回不足，再加检索能力 |
| TD-06 | 复用确认快照/事件语义，编辑能力按团队 UI 实际需要接入 | 已有实验提供实现依据；复用逻辑不等于复制原界面 | 结合成员交付决定具体迁用模块，保持对象版本与记录语义 |
| TD-07 | 独立 Linux 执行节点/VM + 受限容器 | 原 runner 是本地进程执行，不是多人代码沙箱 | 当前环境不能落实隔离则阻止真人运行，不回退到应用宿主执行 |
| TD-08 | SQL 作业记录、HTTP 命令、SSE 通知 | 无多人共编，首版不需要 Redis、消息总线和 WebSocket 同步平台 | 实测推送/队列规模超出此结构再扩展 |

选择 SQLite 的依据是单机低写并发，而非“学生数量少就必然安全”：它仍只有一个并发写者，WAL 不能放在网络文件系统上。[SQLite 使用边界](https://www.sqlite.org/whentouse.html)、[WAL](https://www.sqlite.org/wal.html) 支持这些约束；适配本项目的结论是本文推断。

## 2. 部署与模块边界

```mermaid
flowchart TB
    T[团队交付的教师 Web UI] --> API[单一应用服务]
    S[团队交付的学生 Web UI] --> API
    API --> D[design：蓝图与活动版本]
    API --> W[workspace：作品与尝试]
    API --> A[tutoring：有界教学决策]
    API --> R[review：状态与教师反馈]
    D --> DB[(SQLite)]
    W --> DB
    A --> DB
    R --> DB
    A --> L[模型供应商 API]
    API --> Q[持久化运行作业]
    Q --> X[独立执行节点]
    X --> C[每作业受限容器]
    X --> API
```

图中的业务模块同进程部署，共用 access/records，不各自成为服务。独立执行节点是安全边界。模型调用和网络 I/O 异步进行，不能占住数据库事务或阻塞编辑确认。

| 模块 | 责任 | 禁止越过的边界 |
| --- | --- | --- |
| access | 登录、课程成员、资源归属、阶段与命令授权 | 不能信任请求体中的 role/studentId 来决定权限 |
| design | 材料版本、蓝图、局部建议、一致性检查、角色预览与分配 | 模型只能提议；确认活动来自教师命令 |
| workspace | Attempt、文件状态、确认快照、运行/提交、恢复位置 | 学生作品写入只能由本人授权操作；不接受模型写文件命令 |
| tutoring | 上下文装配、动作选择、输出校验、取消与投递 | 不持有学生文件写入、运行、正式评价或活动发布工具 |
| review | 候选证据、状态投影、异议、教师决定和后续任务 | 候选与正式判断分开；纠正必须使旧依赖失效 |
| records | 记录持久化、覆盖区间、幂等、作业、导出与审计 | 不从总结反向伪造原始记录；不接管教学判断 |
| runner | 固定镜像/快照执行，资源约束和可信验证结果 | 学生程序不能访问应用数据、凭据或验证器内部答案 |

后台目录冻结为 apps/teaching/：A 维护 package/锁文件/tsconfig、server/app/access/design/review/db/transaction、contracts/common/access/design/review；B 维护 server/tutoring、contracts/tutoring；C 维护 server/workspace/records、contracts/workspace/records/runner 和 runner。各领域维护对应测试，共享文件由 A 汇总 B/C 需求。前端保留实际工程/构建方式，最后接入，不预建 web 目录；contracts 的权限/版本语义不要求前后端同语言或校验库。

该目录本次不创建。本仓库尚无正式应用的启动与测试命令；后续按团队实际 UI 工程和后台结构设置，不将旧 IDE 实验的启动命令作为产品入口。

## 3. 技术栈与已有能力复用

### 3.1 最少依赖

已批准的首批精确版本：Node 24.21.0 LTS、TypeScript 7.0.2、Fastify 5.12.5、Zod 4.6.5、better-sqlite3 13.0.3、ai 7.0.136、@ai-sdk/deepseek 3.0.63。2026-10-09 的发布/engine/peer 与 SQLite 源码核查来源见 [版本证据](../tasks/G0_CLOSURE_PROPOSAL.md#5-后台与目录冻结提案)；ai/DeepSeek 适配包共同使用 provider 4.0.26/provider-utils 5.0.58，Zod/Node 声明条件相容。元数据不代替实际安装、typecheck 或模型测试。

| 位置 | 推荐 | 使用范围 |
| --- | --- | --- |
| Web UI | 沿用团队成员实际交付，不另作选型 | 对接数据、操作和状态；页面、组件、构建及渲染方式由 UI 工程决定 |
| API | Node.js 受支持 LTS、TypeScript、Fastify | 业务 API、鉴权和 SSE；通过同源入口与团队 UI 接入 |
| 数据校验 | Zod | 复用已有知识，定义应用维护的输入/模型结果 schema |
| 持久化 | better-sqlite3、SQLite WAL | 短事务、预编译参数查询、JSON 保存小型版本化文档 |
| 模型 | AI SDK Core + 一个供应商适配包 | 结构化候选、有限读取工具和取消；业务状态由应用保存 |
| 执行 | 固定 Linux 镜像、容器资源约束 | 仅首发语言；镜像和命令由维护者批准 |
| 验证 | Node 测试运行器、浏览器端到端工具 | 事务/权限/状态测试及真实 UI 流程；不先搭完整评测平台 |

A1 实施时在锁文件固定上述实际组合，验证 Node/Fastify/Zod/模型 schema/驱动；better-sqlite3 源码头文件为 SQLite 3.53.4，安装后仍须 SELECT sqlite_version() 核实际驱动及第 10.1 节要求。组合失败报告并修复，不静默换栈。前端依赖以交付为准，编辑器兼容另测。本工作项没有安装或升级依赖。

既有技术回源确认：Fastify 支持 schema 校验，但 schema 应作为应用代码，不能接受学生上传的可执行 schema；AI SDK 的循环控制提供停止条件和步骤上下文调整，不能替代业务授权。[Fastify 校验](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[AI SDK 循环控制](https://ai-sdk.dev/docs/agents/loop-control)

### 3.2 复用清单

| 本仓库中的复用参考 | 可迁用部分 | 必须改造/重新验收 |
| --- | --- | --- |
| [编辑与对象版本](../reference/ENGINEERING_HANDOFF.md#编辑与对象版本) | 编辑、选区、版本与草稿恢复的语义 | 按成员 UI 交付适配对象引用、认证资源路由与多标签冲突；不重做其页面 |
| [记录确认与回放](../reference/ENGINEERING_HANDOFF.md#记录确认与回放) | 文本变化、确认/去重、哈希与回放语义 | 实现课程/尝试作用域；状态/历史不能按全局路径混用 |
| [运行与语言环境](../reference/ENGINEERING_HANDOFF.md#运行与语言环境) | 源码快照、编译/运行阶段、环境指纹与失败分类 | 用隔离执行器替代宿主进程；命令白名单和结果来源重做验收 |
| [教师纠正与历史版本](../reference/ENGINEERING_HANDOFF.md#教师纠正与历史版本) | 活动版本、TeacherReview、revision 与原始/推断分离的业务经验 | 实现真实身份与事务；不导入模拟身份/能力记录 |
| [历史试验对开发的影响](../reference/ENGINEERING_HANDOFF.md#历史试验对开发的影响) | 有来源的回归风险与原能力边界 | 新 Web 集成独立验证，历史实验通过数不计入新应用通过数 |

上述契约已迁入本仓库，团队可直接依据正式接口实施。旧插件代码尚未作为本仓库依赖交付，不能假设原模块可直接导入；若后续决定迁用小范围纯逻辑，再评估源码、依赖与对应检查并保留来源，不把整个插件服务嵌入新应用。学生操作与模型权限按本文件和 AGENTS.md 的正式边界实现。

2026-10-06 的历史 student-ide 0.6.0 已有编辑时诊断的隔离验收记录；团队所需的[诊断契约与限制](../reference/ENGINEERING_HANDOFF.md#编辑时诊断)已收录。正式首版语言仍待冻结，是否迁用具体实现及如何呈现结合成员的 Web UI 决定，不把历史多语言覆盖作为首版必须实现的范围。

### 3.3 与团队 Web UI 对接

接入以成员实际交付的工程/原型为起点，先核对已有操作、状态、构建方式和接口约定，再把后台能力对应到这些操作。本轮未收到并审阅该交付，不推断其框架或完成程度。

对接需保留四类语义：用户与课程范围；当前对象及其版本；命令结果、错误与恢复方式；实际消息展示、取消和确认回执。接口路径/字段命名可按实际工程协商适配，权限、版本、幂等和记录含义不能静默丢失。

页面与组件由 UI 负责人维护，后台与 Agent 工作围绕其交付接入。未覆盖的必要业务能力先列出具体差异与最小调整建议，再与负责人对齐；不另建一套界面替代交付。UI 尚不可用时可先完成接口和状态测试，完整浏览器验收在实际集成后进行。

2026-10-08 按用户要求补充[三人分工与交付顺序](../planning/TEAM_WORK_PLAN.md)：前期三人按本文的业务/接口契约完成后台、Agent 与独立执行能力，UI 成员仅在最后实际接入阶段参与分工。届时再核对实际工程、操作、构建与适配，补齐浏览器和完整链路验收；不把前期核心开发变成等待 UI 交付，也不假设最终接口无需适配。此排程不改变模块、权限、版本或验收语义。

## 4. 核心数据模型

以下是新产品的逻辑数据设计，不是现有数据库变更，也没有执行建表或迁移。业务查询按 courseId、studentId、attemptId 缩小范围；原始学生内容默认不进入普通应用日志。

| 对象 | 核心内容 | 不变量 |
| --- | --- | --- |
| User / CourseMembership / Session | 账号、课程角色、有效登录会话 | 身份由服务端会话获得；角色按课程判断 |
| ResourceVersion | 材料正文、段落 ID、来源、可见范围、内容 hash | 内容版本固定；检索前先过滤角色 |
| BlueprintDraft | 目标/任务/证据/量规关系、资料、政策、revision | 修改用预期 revision；AI 提案不能覆盖并发编辑 |
| ActivityVersion / Assignment | 教师确认的完整活动与分配范围、各资源/政策/量规/运行版本 | 已确认内容不可变；Assignment 可暂停，新版本需显式分配 |
| Attempt | 学生、活动版本、状态、项目意图、路线、返回位置、decisionEpoch | 学生归属和活动版本固定；epoch 使过期动作失效 |
| ProjectFile / ArtifactSnapshot | 文件实例、内容版本、确认文本；不可变的多文件快照及 hash | 同名重建是新实例；运行/提交引用快照而非当前路径 |
| Message / TeachingAction / ActionReceipt | 实际内容、动作目的、依据、预期状态、生命周期与展示回执 | 生成不等于展示；内容不能只剩不可回取的 hash |
| Observation / CoverageInterval | 代码/解释/运行/实际帮助的引用、来源、时间、缺口 | 观察由采集或明确输入产生；模型不可伪造原始事实 |
| RunRecord / CheckResult / Submission | 环境、源码 hash、退出/资源状态、白名单文本产物引用；验证规则/来源/覆盖；固定提交 | 运行/产物事实、可信课程检查、正式评价分别保存，不自动写回作品 |
| LearnerStateRevision | 适用范围、三条能力线主张、帮助条件、支持/反证、未知 | 版本追加；被撤回主张不进入当前有效投影 |
| TeacherDecision / Feedback | 对哪个版本/主张的确认、纠正、暂缓，理由、引用、后续行动 | 教师身份可信；无证据时只能改变判断状态，不能补造观察 |
| Job / CommandReceipt / AuditEvent | 作业与租约、幂等键、请求摘要、结果、操作审计 | 重试不能重复业务副作用；审计不包含凭据或整段私有对话 |

目标拥有稳定 competencyId 和 domain/project/ai_collaboration 类别；任务、目标、证据要求为多对多关系。课程目标语义改变需新版本或显式对应关系，不能因复用 ID 将旧表现视为新目标证据。

首版可将小型蓝图、量规、状态主张放在版本记录的 JSON 字段中；权限键、关联 ID、revision 和幂等键有独立列、索引和约束。逻辑对象不要求全部拆成独立表，但必须能做所属范围与引用完整性检查。

### 4.1 共同对象引用

工作区对象引用包含下列已批准字段：

```typescript
type CodeObjectRef = {
  kind: "code";
  attemptId: string;
  snapshotId: string;
  fileId: string;
  path: string;
  documentVersion: number;
  contentHash: string;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  source?: {
    system: "student-ide";
    session: string;
    modelId: string;
    seq?: number;
  };
};

type ObjectRef =
  | CodeObjectRef
  | { kind: "run"; attemptId: string; runId: string; snapshotId: string }
  | { kind: "resource"; attemptId: string; resourceVersionId: string; paragraphId: string }
  | { kind: "project"; attemptId: string; activityVersionId: string };
```

路径和行号只在对应版本内解释。范围字段不得定位到另一个文件实例；服务端核验 snapshotId 与内容 hash。运行、资料和项目级问题各自绑定对应版本，不强迫“帮我找起点”的学生先选择一段不存在的代码。迁用历史引用时原 session/modelId/version/hash/seq 保留来源含义；其中 modelId 是文档实例，不是模型供应商版本。

range 使用一基 UTF-16 行列、起点包含/终点不包含，按快照文本校验；不把编译器字节偏移直接当编辑器列。快照包含当时全部 active 文件的实例/路径/版本/正文/hash，绑定 expectedWorkspaceRevision 冻结；正文按原 UTF-8 字节 SHA-256，不 trim/换行或 Unicode 转换。`hashFormat=sha256-manifest-v1` 按 path 的 UTF-8 字节序排序，对紧凑 JSON 数组 `[fileId,path,documentVersion,contentHash]` 清单计算摘要。路径只允许项目内 `/` 相对路径，拒绝绝对/盘符/UNC/反斜杠/NUL/空段/点段/重复路径/符号链接；恢复实例路径冲突不覆盖同名新实例。

### 4.2 学习主张

每条主张保存 competencyId、scope、statement、evidenceIds、counterEvidenceIds、assistanceStatus、unresolved、estimatorVersion 和 validity。state 取 insufficient / supported_with_assistance / supported_in_check / conflicting；validity 另取 active / contested / superseded / withdrawn。

assistanceStatus 至少区分 observed_help、none_observed_in_system、unknown。none_observed_in_system 只表达本系统范围，不等于没有外部帮助。采集缺口或缺展示证据影响解释时，使用 unknown，不升级为独立掌握。

模型总结引用原始材料，不作为新增的独立证据。同一次 Attempt 的关联观察按同一证据组处理；首版不计算重复事件累积的掌握概率。

### 4.3 公共身份、版本与结果信封

| 字段/对象 | 已批准含义与归属 |
| --- | --- |
| ActorContext/authorizedScope | A 从有效会话、课程成员及资源生成 userId/courseId/课程角色/授权用途；客户端/模型不能构造或扩大 |
| assignmentRevision/activityControlRevision | A 的分配/活动可用性并发版本；活动正文不可变，暂停只更新控制层 |
| attemptRevision/expectedAttemptRevision | C 的生命周期/路线/控制/许可 CAS；不随逐次文件编辑增加，已接纳输出按相关用途/阶段/epoch/对象守卫，不机械要求无关控制版本不变 |
| workspaceRevision/documentVersion/captureRevision | C 的作品批次/文件版本/采集代际分别保存；capture 不等于教学 epoch |
| contextRevision/feedbackRevision | A 的自述/正式反馈追加版本；未创建首次写入预期 0，能力状态与之分开 |
| learnerStateRevision/claimId+claimRevision | A 的同课程同学生有效状态头和确切主张版本；从未建立状态才读 0，撤回/清空不重置；目标含 competencyId/competencyVersion/domain 和适用 scope |
| commandId/receiptId/requestId | 业务请求、持久命令回执、单次 HTTP 追踪分别标识；重试 requestId 可新，原业务结果 ID 不新建；C 保存前两者明确关联 |
| Job | C 保存 jobId/kind/purpose/scope/requestReceiptId、停止/终态、expectedRevision/epoch/目标/政策、acceptedAt/deadline/调用计数、leaseToken/leaseUntil、recoveryGeneration、结果/失败引用 |
| purpose | teacher_design/student_help/reminder/explicit_analysis/passive_analysis/student_run/teacher_sample；任务 kind 与权限/取消用途分开，模型不能改用途 |
| 模型结果 | 信封可信 job/scope/政策/版本/租约/代际/inputRefs/assistanceRefs/coverageRefs 由 A/C 构造；B 只产生 body。resultHash 对持久的原 UTF-8 JSON 正文字节 SHA-256，不采信模型摘要或重序列化伪称原结果 |

教师生成使用 courseId/blueprintId（尚无草稿可 null）/baseRevision、获准 resourceVersionId/paragraphId/hash/visibility，不伪造学生 Attempt 或改变学生 ObjectRef 联合类型。结果分别为 candidates（1～3）、blueprint、patch、rubric_trial；保存为 A/design 提案，同 job/resultHash 返原 proposalId，异结果冲突；人工修改后旧提案可保留 applicability=stale，不自动采用。

学生教学 body 保存 actionType/content/rationale/expectedStudentAction/evidenceIds/resourceRefs/assistanceContext/unresolved，C 在守卫通过后保存 Message/Action 并返待投递引用；不表示展示/理解。候选信封另含 collectionPurpose 与模型/提示/schema/analysis 版本，claims/反证/帮助/未知和可选 feedbackDraft；C 保存原分析/拒绝原因，A 校验后接纳有效状态，教师反馈草稿不等于正式 Feedback。

### 4.4 角色/资源投影

学生限本人有效课程/分配/尝试、固定活动关联的可见资料、确认作品/运行/反馈/异议及个人导出；不读草稿、私有答案、他人数据或未采用反馈。教师限负责课程的设计/分配/审阅/正式决定/导出，不代学生操作作品。维护者仅获批准的账号/健康/备份权限，不自动获教学正文或教师判断权。

teacher_design 仅用 A 明确批准的资料；student_help/analysis 不含私有验证资产或其他学生。teacher_sample 只取负责课程的指定样例/配置，trusted validator 才取必要验证资产。预览 student/tutor/teacher-validator 仍以教师鉴权，填写 audience 不提权。检索、序列化、Job 结果、SSE、导出与引用读取前统一过滤，缺失/撤回/不可见明确表示 unavailable/redacted，不用 hash/总结补正文。

## 5. 命令、权限与外部接口

浏览器通过同源 HTTP 发命令，长任务返回 jobId，通过 SSE 接收状态和已审查结果。SSE 断线按服务端事件游标补取；消息内容在获准展示后才下发，不能先流式泄露未经检查的答案。

所有变更命令均校验认证会话、课程成员、资源归属、状态与预期版本。Idempotency-Key 按账号 + 路由/资源 + 命令范围唯一，保存请求摘要；同键同请求返回原结果，同键不同请求返回 409。

| 接口（已批准） | 发起者 | 行为与关键限制 |
| --- | --- | --- |
| POST /api/sessions；POST /api/logout | 账号本人 | 登录/退出；会话、CSRF 与登录限流，不能直接指定教师角色 |
| POST /api/courses/:id/resources | 教师 | 导入 TXT/Markdown/粘贴正文，创建材料版本，非任意 URL 抓取 |
| POST /api/courses/:id/blueprints | 教师 | manual/agent/copy；手工/复制建 revision=1，agent 创建根提案 Job，教师选中再建草稿；不要求完整机器配置 |
| PATCH /api/blueprints/:id | 教师 | expectedRevision + 局部变更，原子更新 |
| POST /api/blueprints/:id/proposals | 教师 | 提交局部 AI 修改要求；提案绑定基础 revision，采用仍走 PATCH |
| POST /api/blueprints/:id/checks | 教师 | expectedRevision，返回绑定该版本的配置错误/设计疑点/待验证项 |
| POST /api/blueprints/:id/releases | 教师 | 确认当前 revision 为不可变活动版本，阻断错误不可跳过 |
| POST /api/blueprints/:id/rubric-trials | 教师 | expectedRevision、获准样例和试评/歧义引用；只记录试评，改量规另走 PATCH，不造学生观察 |
| POST /api/blueprints/:id/sample-runs | 教师 | expectedRevision、课程/蓝图范围的 teacherSampleSnapshotId、批准 profile/参数；teacher_sample 独立用途，不借学生 Attempt；固定快照/配置与失败保留 |
| POST /api/activities/:id/assignments | 教师 | 分配已确认版本，限定课程成员 |
| POST /api/activities/:id/controls | 任课教师 | expectedActivityControlRevision、pause/resume、理由；更新可用性控制层，暂停时阻止新分配并同事务暂停相关分配/失效动作，不改活动正文或解除个人暂停 |
| POST /api/assignments/:id/controls | 任课教师 | expectedAssignmentRevision、pause/resume、理由；同事务控制/epoch/用途取消，恢复不重投旧动作 |
| POST /api/assignments/:id/attempts | 所属学生 | 创建或返回该任务的当前尝试 |
| POST /api/attempts/:id/sync | 所属学生 | ready/active 可 create/update/recycle/restore；paused 或分配暂停仅 update 既有 active 文件；expectedWorkspaceRevision、fileId/baseVersion/clientId/clientSeq，必要过程部分带 captureRevision；整批原子 ACK/冲突 |
| POST /api/attempts/:id/snapshots | 所属学生 | expectedWorkspaceRevision 冻结完整确认清单，返 snapshotId/hash；学生显式保存/求助/运行/提交也可同事务冻结，模型/被动分析不触发 |
| POST /api/attempts/:id/help | 所属学生 | ready/active、分配和政策允许；expectedAttemptRevision、ObjectRef/问题，ready 同事务激活并创建有界 Job |
| POST /api/attempts/:id/runs | 所属学生 | ready/active 且分配 active；expectedAttemptRevision、确认 snapshotId、批准 profile/操作参数/输入、mode=run 或 course_check；ready 同事务激活，固定 runId/jobId |
| POST /api/attempts/:id/controls | 所属学生 | expectedAttemptRevision；start=ready、pause=active、resume=paused、resume_revision=reviewed+有效许可；采集/提醒独立设值，不激活尝试或复活旧 Job |
| POST /api/jobs/:id/cancel | 有权发起该作业的用户 | 持久停止意图/事件/回执同事务；教学 Job 即使 succeeded 也停止关联未展示 Action，保留终态/生成/展示事实；运行取消按整个单元确认，未确认不释放槽位 |
| POST /api/attempts/:id/submissions | 所属学生 | ready/active、分配 active；expectedAttemptRevision、固定快照/说明/匹配检查引用，阶段/教学失效同事务，不要求作品必须答对 |
| POST /api/actions/:id/receipts | 所属学生客户端 | 回传实际展示/取消/确认状态，校验接收对象与 action 内容版本 |
| POST /api/attempts/:id/disputes | 所属学生 | targetRef 指确切 claim/feedback 版本及理由；改变有效投影时 expectedStateRevision，当前依据 contested/依赖失效同事务；历史异议不覆盖新判断 |
| PATCH /api/courses/:id/my-context | 所属学生 | expectedContextRevision，修改个人目标/约束自述；不写能力或教师字段，相关辅导上下文失效 |
| POST /api/attempts/:id/reviews | 任课教师 | expectedStateRevision + 决定、引用、理由；事务内纠正和失效 |
| POST /api/attempts/:id/reopen | 任课教师 | reviewed、expectedAttemptRevision/最新 submissionId/理由，保存许可仍是 reviewed；学生主动 resume_revision 消费许可，旧提交不变 |
| POST /api/attempts/:id/feedback | 任课教师 | kind=formative 或 submission_review；feedbackId（修订）/expectedFeedbackRevision/expectedStateRevision/固定对象或最新提交；改变阶段另核 expectedAttemptRevision，正式反馈/reviewed 同事务；B 只起草 |
| GET /api/attempts/:id/events | 所属学生/任课教师 | 经过角色裁剪的 SSE 或游标分页 |
| GET /api/courses/:id/exports | 任课教师 | 课程范围导出；学生通过个人导出入口仅获取自己的可见记录 |
| GET /api/my/exports | 所属学生 | 必需课程范围，仅本人可见内容与引用/帮助/版本/覆盖缺口；私有资产和凭据裁剪 |

读接口同样校验范围，不因 ID 难猜就放开。不存在用于模型直接发布活动、编辑学生文件、运行程序或写正式评价的公共工具。模型能调用的是当前已授权上下文中的少量读取函数，如读取指定快照、读取结果、检索获准资料；调用参数再由服务端校验。

### 5.1 请求摘要、响应与拒绝

除登录/退出外，幂等键为可信账号+稳定命令/目标 scope+Idempotency-Key；合法输入规范化对象键顺序，不改正文/换行，摘要包含目标和全部实质字段/预期版本。sync 的账号/Attempt/clientId/clientSeq 与公共回执指向同一摘要，序号只去重，不要求连续。认证/Origin 先检查；事务内重查当前授权，已成功同键同摘要返原业务 IDs/版本，不再用已前进版本 CAS；异摘要 409；新命令再核状态/版本，结果/回执/事件同提交，唯一约束处理并发。登录凭据不入摘要/缓存回执。

成功返回 requestId/data/相关版本及可选 commandId/replayed，异步接受返回 jobId/排队与可查引用。错误为 requestId/error.code/message/retryable/恢复说明，正文不含私有内容/堆栈/路径/凭据。400 INVALID_REQUEST（格式/必需字段）、401 UNAUTHENTICATED、403 FORBIDDEN、409 VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/STATE_CONFLICT/RECOVERY_REQUIRED、413 CONTENT_LIMIT、422 INVALID_REFERENCE/INVALID_CONFIGURATION/RUNTIME_NOT_READY、429 RATE_LIMITED/BUDGET_EXHAUSTED、503 DEPENDENCY_UNAVAILABLE/PERSISTENCE_UNAVAILABLE。已授权范围可重读冲突，未知结果核原请求，不自动换键重做；不可见 ID 不泄露存在性。

读取入口均返回确切版本/范围/缺口，GET 不激活学习、不排模型/运行。统一提供当前 Session/所属课程、角色裁剪的 ResourceVersion、教师蓝图/提案/三类预览、固定活动/进展、Attempt/工作区/快照/运行/提交/产物、教师 review-context、本人有效状态/自述/正式反馈、原 Job、事件与课程/个人导出。自述未建立为 null，反馈原依据争议/撤回时标注而不回写历史。结果文件读取再授权，游标/内容 hash 不授予权限。

## 6. 教学决策与上下文

### 6.1 一次求助的处理

1. 鉴权、幂等和帮助政策/限额校验；ready 的首次合法显式学习命令同事务激活后接纳，记录学生消息；读取本身不激活。
2. 代码对象先确认所选源码已同步；其他对象核验相应运行、资料或活动版本。读取 activityVersion、decisionEpoch 和 learnerStateRevision。
3. 构造最小上下文：当前问题/对象、必要运行结果、活动目标与政策、相关有效主张及反证、最近实际帮助、获准课程段落。
4. 确定性规则先处理无权限、限定检查、缺上下文、环境故障和已关闭提醒；其余由模型在有限动作中选择并生成内容。
5. 校验结构、引用、内容范围、帮助政策和版本。失败最多修复一次，且计入总调用/时限；仍不满足则安全结束并允许人工求助。
6. 投递前再次核验政策、epoch、主张有效性和目标版本，保存获准内容并发送通知。过时结果取消，不将旧选区批注到新代码。
7. 前端在本地再次比对当前文档版本，展示后回执。随后等待学生，不自动执行下一步或反复测验。

首版动作类型可用 plan、clarify、hint、explain、compare、verify_suggestion、reflect、extend、handoff_teacher、no_action。类似例子优先引用教师批准的相邻样例；不通过模型自由生成并执行 HTML/脚本。

上下文中保留可审阅的选择依据，如“上次在有提示条件下解释正确，迁移仍未知”；不需要存储或展示模型内部思维链。输出携带简短 rationale、evidenceIds 和 expectedStudentAction，便于审阅实际支持目的。

### 6.2 约束与降级

单次教学请求的模型调用总数 ≤ 3，包含工具循环和一次修复；从请求接受到终结含排队 ≤ 45 秒，使用独立超时/取消控制，不能只依赖 SDK 默认循环次数。每个 Attempt 同时最多一个有效辅导 job；新请求使旧请求取消或由学生明确继续。

队列满时明确排队位置/状态，超时结束；不存在为了凑结果无限重试。超预算或模型不可用时保留作品、问题和人工求助入口。

普通教学输出的语义边界无法靠 schema 或关键字证明。首版通过限制上下文、有限动作、获准例子、输出检查和教师抽查降低过度帮助；限定帮助检查直接关闭不允许的辅导入口。确定性权限拒绝与语义质量评审分别验收。

批准配置：DeepSeek `deepseek-flash`，AI SDK + @ai-sdk/deepseek，稳定 Chat Completions 入口 `https://api.deepseek.com`；三类任务显式 thinking.type=disabled、结构化对象+Zod/引用/政策校验、SDK maxRetries=0。每调用输入上限 16,000 tokens、输出上限 4,096 tokens，关键政策不截断；超限说明省略或请求补充/拆分。计费重试/工具循环/一次修复共享 3 次和接受起 45 秒，不因换 worker 重置，末次只获剩余时限。只保存正文/简短理由/实际或 unknown usage 与指纹/缓存/配置版本，不保存内部思维链。

模型没有联网/托管文件/代码执行/写文件/发布/正式评价工具，不启用 beta strict-tools 或自动换供应商。无账号/数据/付费授权时仅合成 provider 验证；真实语义和至少 30 次延迟样本由 B4 取得，批准配置不表示 NFR 已达标。

### 6.3 资料检索与状态提取

材料按教师给定标题/段落切分，先按课程、角色、活动版本与可见性过滤，再按目标关联及词项匹配选择少量段落。小材料可直接放入预算；上下文超限时明确省略范围，不无声截断关键规则。首版不共享跨学生的上下文缓存。

状态提取在学生主动求助后的有效结果、里程碑、提交和教师复核等低频节点异步进行。每次记录实际输入引用、模型/提示/规则版本和输出。原始编辑事件只聚合，不能每次编辑都触发模型。

提取结果需通过引用和来源校验后成为候选主张，再生成状态 revision；分析基于旧 revision 时拒绝直接写入，按最新有效证据重新计算。学生可继续操作，不等待画像更新。

## 7. 一致性、纠正传播与恢复

### 7.1 状态和版本

- BlueprintDraft 每次教师修改增加 revision；AI 提案绑定基础 revision。确认版本时同时冻结活动、量规、政策、资源和运行配置引用。
- Attempt 使用 ready → active → submitted → reviewed，首版不设 closed 操作；首次合法显式命令可同事务 ready→active，GET 不激活。active 可 paused/resume，暂停仍允许保存既有 active 文件内容，不 create/recycle/restore；submitted/reviewed 未获许可并主动重开前作品只读，原 Submission 不变。
- Assignment 的暂停优先于 Attempt。学生不能通过恢复尝试绕过教师暂停，模型也不能改变阶段。
- decisionEpoch 在新求助取代旧求助、控制权/帮助政策变化、任务暂停和相关教师纠正时递增。文件内容另外通过 snapshotId/documentVersion 检查。
- 功能数据同步、过程采集开关与主动提示开关分开保存。关闭过程采集不等于关闭显式消息/提交；关闭主动提示不等于拒绝学生自己求助。

分配暂停覆盖个人恢复；活动可用性暂停阻止新分配并覆盖既有分配，活动正文/学生集合仍固定。正式 feedback kind=submission_review 与 submitted→reviewed 同事务，主张复核不自动改变学习阶段；教师允许修订只保存最新提交上的 ReopenGrant，学生主动 resume_revision 校验/消费后才 active。相同控制设值在 CAS/权限通过后不多增 epoch 或造覆盖区间；开启采集/提醒不会激活学习或复活旧作业。

### 7.2 教师纠正事务

一次 POST reviews 在一个短事务中完成：

1. 校验教师课程权限和 expectedStateRevision。
2. 追加 TeacherDecision，保存引用、理由与被更正主张。
3. 生成新的 LearnerStateRevision，撤回/修订相关主张；对依赖被否定依据、尚未重算的主张标 contested，暂不用于强适应。
4. 对该学生、该课程内受影响的活动增加 decisionEpoch，将未完成/未展示的相关动作和分析 job 标为 stale。
5. 追加状态事件与必要的重算作业，提交后通知客户端。

首版采用“该学生在该课程内的相关待执行动作整体失效”的保守办法，不实现通用依赖图调度器。支持/反证引用仍保留，以便定位影响。重算读取有效教师决定，不能重新调用模型就恢复被教师明确撤回的同一主张。

旧模型请求即使无法及时中止，其完成结果也因 revision/epoch 不符而不能生效。已显示的帮助保持真实历史，另标其依据后来被修订，不能抹掉学生曾经收到的帮助。纠正判断不等于改变当时的帮助条件。

### 7.2.1 模块事务与候选接纳

A 提供 authorizeResource/withTransaction；C 提供同连接/同 tx 的 resolveCommandReceipt、finishCommand、enqueueJob、appendEvent、invalidateInTransaction、cancelByPurpose、transitionAttempt/grantReopen、原始引用/提交和运行就绪读取。C 不另开提交/HTTP 双写；网络/供应商/执行器取消与通知在提交后，失败只重试通知，不重做业务决定。C2 首批交基本 Job/Receipt/Event/tx 接缝，不等 C3 才首次可用。

候选信封来自已获准 Job，携带可信 scope/固定活动/政策、输入/帮助/覆盖引用、expectedStateRevision/epoch、purpose、模型/提示/schema/分析版本、租约/代际、body/resultHash。A 在短事务重查授权、原 Job/停止/用途开关/相关状态、引用存在/版本/范围和撤回约束；C 原分析/接受或拒绝原因、Job 结果和 A 的候选/新有效 revision 一并保存。任一步失败全回滚，不把旧结果改贴新版本；成功同结果重放返原 IDs/revision，异结果冲突。

教师先纠正则旧候选拒绝；候选先提交则旧教师表单 CAS 冲突。被撤回的同一依据不能换 claimId/措辞/分析版本复活。原始事实、模型候选、自述和正式教师判断分层；环境故障不是知识错误，缺数据保留未知。

失效按用途：教师纠正/当前依据争议使同课程同学生相关未展示教学/分析/反馈依赖失效，保留普通运行事实；新帮助替换旧帮助增 epoch；暂停/限定检查/提交控制相应用途和执行；关闭提醒仅停 reminder，暂停采集仅停过程/在途被动分析，不增加通用教学 epoch；相关自述/正式反馈变化使依赖的教学上下文失效。

### 7.3 投递与回执

TeachingAction 保存生成内容、策略/模型版本、来源引用、expectedStateRevision、decisionEpoch、目标版本和可展示内容 hash。通过校验后进入待投递；服务端写出 SSE 只算发送尝试。

| 回执 | 由谁产生 | 可据此说明 |
| --- | --- | --- |
| received | 已认证的目标客户端 | 客户端收到指定版本内容，产品可标“已投递” |
| displayed | 客户端确认目标消息已渲染且页面可见 | 本系统报告内容已展示，不证明学生阅读或理解 |
| acknowledged | 学生明确点击/回应 | 有一次明确确认，不自动代表采纳或掌握 |
| cancelled / stale / failed | 客户端或服务端相应状态机 | 取消、过时或失败，保留发生原因和已取得的其他回执 |

回执按 actionId + contentHash + receiptKind + clientReceiptId 去重，不根据重发次数增加帮助或能力权重。展示可以先于某个迟到网络回执到达，按事实追加，不强制伪造中间阶段。

投递前的服务端检查与前端本地版本检查共同阻止已知过时内容。断线时先重新同步 epoch 才显示待投递消息；迟到的旧展示回执标记与当前状态冲突，不回滚新判断。纠正发生在消息已显示之后时只能标注撤回依据，不能承诺让学生“没看见过”。

取消教学 Job 在同事务保存持久停止、关联未展示 Action cancelled、事件/回执；Job 即使 succeeded 也不跳过，终态/生成/已显示事实保留。完成/创建 Action/最终投递重查停止、租约/代际、相关阶段/政策/对象/状态，不能只检查开始时版本；迟到内容、重启/重连和开关再次开启不复活旧动作。同键停止不重复事件或增加通用 epoch，新帮助另用新 jobId；客户端本地停止阻止迟到展示，其他页面重连先同步控制，迟到真实 displayed 仍保留并标竞态。

### 7.4 编辑、断线和幂等

同步批次包含 expectedWorkspaceRevision/clientId/clientSeq，create 的 clientFileKey/path/text 或 update/recycle/restore 的 fileId/baseVersion；update 的 text/UTF-16 changes 二选一，同实例每批最多一个操作。整批核状态/范围/路径/最终数量与字节限制，原子保存作品、必要记录/serverSeq/回执后 ACK，返回文件 ID 映射/版本/hash/lifecycle、workspaceRevision/serverSeq/receiptId。失败不部分覆盖。clientSeq 仅去重且不复用，不要求连续或消费拒绝序号；同已成功请求先核权限/代际并返原 ACK，新请求再 CAS，顺序只用 serverSeq。

一个学生允许多个页面读取，但同一文件的并发写入使用乐观并发控制；冲突时保留本机草稿和服务器版本供比较，不首发 CRDT。文件回收是可恢复的生命周期状态，新建同名文件生成新 fileId。

浏览器 IndexedDB 保存本机未同步草稿，键包含账号与 attemptId；账号切换不能暴露前一用户草稿。存储不可用时明确提示。断网继续本机编辑，停止假装已同步的求助/运行；重连后先解决版本冲突。

过程采集关闭时，sync 仅维持必要的最新确认作品，不保留逐次编辑时间线、不排队被动分析；显式求助、运行和提交固定必要快照。重新开启不上传关闭期间的逐次编辑。服务器也检查开关，不能仅在 UI 隐藏日志。

每次采集暂停/恢复均增加服务端 captureRevision；只接收当前 collecting 区间且版本完全匹配的过程部分。缺/旧版本不记观察，即使迟到内容声称在暂停前；作品仍可按文件 CAS 独立确认，ACK 分别表达作品/过程及拒收原因，不以过程拒收阻塞保存。保留 CoverageInterval/缺口，不靠客户端时钟追认、不回填或给旧队列改贴新版本。被动分析暂停即持久停止，恢复不接纳旧 cancelled/stale 结果。

Job 记录 kind、scope、status、leaseUntil、expectedRevision、attemptCount、deadline 和结果引用。重启后续取未完成作业，过期作业先核对结果；不盲目重放外部副作用。模型请求重试可能再次产生供应商费用，费用记录与业务去重分别处理。

Job 状态统一 queued/running/succeeded/failed/cancelling/cancelled/stale/timed_out/outcome_unknown。领取/续租/完成核 leaseToken 和 recoveryGeneration；未知执行只按原 runId 对账，不回 queued 自动重跑或返还未知用量为 0。

### 7.5 旧备份恢复与导出

普通进程重启保持 recoveryGeneration、续取有效 queued；旧备份恢复由 A 的授权流程先停接纳/分派，从不随该备份回退的可靠登记点生成新代际，C 核完整执行账本和槽位并取得执行端新代际确认后再恢复分派。浏览器变更、Job 完成/候选/投递及执行控制消息均带受信代际；旧请求 409 RECOVERY_REQUIRED，原发起者重读/比较后显式新操作，不自动改键或造替代作业。

旧备份回退后尚未执行的旧异步作业保留原因/stale，不自动续跑；已执行/未知/终止未确认的继续对账原 runId，不伪称取消或释放槽位。长期执行账本只存必要事实、稳定原请求关联、摘要/结果引用和缺口，不额外长期复制源码/消息；临时运行正文/待交付结果仍按数据方案处理。丢失正文依 RPO 标 unavailable，不用元数据补造作品/观察/课程通过。

导出采用一致读取视图，包含 exportId/scope/角色可见性版本/cutoffServerSeq/时间/校验摘要，以及获准作品、运行/产物、消息/帮助、候选/判断版本和覆盖未知。下载再授权、私有正文/敏感摘要/凭据裁剪，缺失/撤回引用明确标 unavailable/redacted；没有永久公开下载链接。C 负责备份/对账/引用完整性，A 负责身份/授权恢复；实际恢复验收见 AC-12。

## 8. 代码执行与课程验证

### 8.1 执行请求

只有学生显式发起运行/检查，或教师在准备活动时发起样例验证。辅导模型没有执行入口。执行器接收 runId、不可变 snapshotId/hash、runtimeProfileVersion、入口、输入、限额与验证模式；命令和镜像来自批准配置，不接受用户任意 shell 字符串。

学生只在 Web 工作区编写/保存/选择课程操作和参数，后台为 C17/GCC。TextScope 操作映射固定可执行文件的参数数组，文件从本次快照的获准实例解析，不接受 shell/编译命令/镜像/宿主路径；未知命令/缺参等按课程批准错误参数样例测试。teacher_sample 使用课程/蓝图版本范围的独立不可变样例快照及相同内容/清单哈希，不构造学生 Attempt 或学习观察。

队列分派前重新校验活动状态和权限。每个 Attempt 最多一个运行作业、全局最多两个；学生能取消，排队/运行状态可见。运行节点按 runId 持久记录接收和结果，重复分派返回同一作业。

丢失连接时应用先查询同一 runId。若无法判断是否执行，标记 outcome_unknown，等待执行器恢复或学生明确新建运行；不能悄悄重复执行并伪装成同一次。

执行节点 submit/query/cancel 接收获认证作用域、runId/原请求摘要和 recoveryGeneration，同 ID 异摘要拒绝。取消早于提交也须在节点持久保存 intent；按 runId 串行取得启动/取消权，并核新代际。取消只有在所有 pending create 已结清且整个单元确认终止、不会迟到创建后才 ACK cancelled/释放槽位；仅“此刻看不到容器”不够。C1 选择并证明实际可靠机制，失败/失联保持 cancelling/outcome_unknown，不能用文档状态冒充实测。

### 8.2 隔离要求

首发代码在专用 Linux 执行节点/VM 的每作业容器中编译和运行。开发机可通过单独测试 VM 验收，不能因为 Windows 上已有 GCC 就在应用宿主直接运行学生代码。

- 镜像按 digest 固定，工具链预装，非 root；去除非必要 capabilities，启用 no-new-privileges 和受限 seccomp 配置；没有特权、宿主 PID/网络命名空间或容器引擎 socket。
- 网络默认关闭；只读根文件系统与源码，唯一可写临时空间受限，不挂载应用目录、数据库、密钥或其他作业目录。
- 路径规范化并校验全部文件清单；拒绝绝对路径、父目录逃逸和符号链接。入口必须在当前快照内。
- 限额使用 MVP_SPEC 的 NFR-03：1 CPU、512 MiB、64 进程、128 MiB 临时空间、64 KiB 总输出；编译 30 秒、执行 10 秒；内存与 swap 合并上限须一致落实。
- 超时/取消终止整个作业隔离单元，分别记录 timeout、cancelled、oom、output_limit、compile_error、program_error、infrastructure_error。
- runner 控制面只允许受认证的应用服务提交/查询已授权作业；其最小权限凭据不注入学生进程。

Docker 默认不会自动设置 CPU/内存限额，必须显式配置并实际核验；容器共享宿主内核，因此专用节点还要隔离应用数据和控制面。[资源限制](https://docs.docker.com/engine/containers/resource_constraints/)、[安全边界](https://docs.docker.com/engine/security/) 仅证明机制存在，不能代替本项目 AC-10 验收。首版不承诺可直接向匿名公众开放任意代码。

### 8.3 可信课程验证

RunRecord 是执行事实，CheckResult 是指定课程规则的判断。验证器在学生进程之外读取受限输出并比较，私有答案和判定逻辑不挂入学生容器；测试输入按运行需要提供，不能将“输入保密”当作抗作弊保证。

CheckResult 记录源码/输入 hash、规则版本、验证器版本、镜像 digest、结果来源和覆盖范围。学生 stdout 只能是被检查的数据，不能声明通过；环境 smoke 结果只支持环境就绪。

私有测试的完整输入/答案、日志和判定细节按角色裁剪，辅导端只获取政策允许的诊断。限定帮助检查从入口起禁用相应辅导；允许的解释/替代证据由活动配置，不临时改变评分要求。

接受 course_check 时同一业务事务登记限定帮助阶段并失效不允许的辅导，B 的入口/读取/投递均核该限制；确认结束/取消后按固定活动规则结束，执行失联不自行解除。错误处理用例可预期退出 1/2，可信规则比较实际退出、输出和覆盖；RunRecord 的非零退出不直接等于课程失败。

### 8.4 批准结果文件

RuntimeProfileVersion 列 approvedResultFiles，初版 TextScope Report 仅回取课程批准的报告文本。作业结束且整个隔离单元已终止后，C1 从独立临时区读取白名单普通文件，规范化/校验路径并拒绝符号链接/逃逸；每个产物含不可变 resultFileId、runId/snapshotId、相对名、正文/contentHash/字节数/来源。缺失或不可回取标 missing/incomplete，资源/工具故障不伪装成完整报告。

编译/运行 stdout+stderr 与回取文件合计 64 KiB，临时区仍 128 MiB；超限记 output_limit，不仅截显示。外部可信验证器核实际报告，C/records 保存 RunRecord 的产物引用，学生/教师按本人/课程/用途读取及导出；查看或下载不自动新建/覆盖 ProjectFile，写回作品必须学生显式操作。AC-04/10/12/15 验固定快照、限额/逃逸、恢复引用与可信报告，原数值门槛不变，实际 UI 最后接入只读呈现。

## 9. 身份、资料与数据治理

首版为课程内预置账户或受控邀请账户，不做公共注册、SSO 或复杂角色层级。使用维护中的会话组件，安全随机的服务端 Session、HttpOnly/Secure/SameSite cookie，以及变更请求的 Origin/CSRF 校验；不把长期登录凭据放在浏览器 localStorage。

批准采用维护者预置教师/学生账号、私有访问；会话最长 8 小时、空闲 30 分钟。A1 在真实账号发放前核成熟 scrypt 参数、登录失败窗口/限流和安全恢复，凭据通过批准通道发放。初始合成联调仅本机/受控测试网；真人访问前由 A/C 明确私有 HTTPS/校园网或 VPN 的实际入口/维护权限，不做公开注册。

密码使用成熟密码哈希方案，例如 Node crypto.scrypt 的逐账号随机 salt 配置，避免自创算法；参数和登录限流在实施时核验。开发中的临时账号与真人账号隔离，账号凭据不进入源码、导出、提示词或普通日志。

授权顺序为身份 → 课程成员 → 资源归属/可见性 → 当前阶段 → 命令范围。所有检索、下载、导出、SSE 和模型读取使用相同规则。前端隐藏按钮不构成权限边界；经认证的账号也不证明每个动作由同一自然人执行。

课程资料、学生代码和工具输出都作为不可信内容：不得修改系统政策或工具权限。Markdown 禁止执行原始脚本，输出渲染经过转义/净化；课程上传只有文本格式和大小限制，不加载远程代码。首版资料建议单文件 ≤ 256 KiB、课程总正文 ≤ 2 MiB，超出则要求拆分并明确提示。

原始事实由用户操作/受信服务写入；模型只能提交候选分析。采集开关变化记录时间区间及功能数据例外，学生可看到覆盖缺口。

数据规则已批准：开发仅合成数据，试点结束后 90 天复核去留，不自动删除；教师处理教学异议，A 管授权/数据请求，C 管备份/恢复与获授权处理。维护者正文排障限定对象/理由/时限与授权，备份/导出副本同样受范围约束。应用层“追加记录”不意味着永久保留或防篡改认证；实际移除须另行授权并使依赖引用失效，缺失不再用于能力判断。

主供应商/模型已批，但真实发送前仍由 B 核实际 API/账号/条款/处理与留存，教学/技术负责人确认告知和数据范围：当前学生必要代码/主动消息、获准课程段落和有效状态，不含身份凭据、他人信息或私有答案。不把选择 DeepSeek 当数据条件已落实；条件不足保持合成模型测试/人工辅导/保存，实际凭据或付费调用另授权。没有整本教材上传/自动抓取或托管文件。

## 10. 持久化、运维与成本

### 10.1 SQLite 基线

数据库放在应用节点本地持久磁盘，启用外键、WAL、合理 busy_timeout 和短事务；模型调用、编译和网络等待一律在事务外。内容以带权限归属的文本/小型二进制记录保存，避免首版额外引入对象存储和双写一致性问题。

短期 SQL 查询使用参数绑定和必要索引；高频编辑批量同步。同步驱动中不做大规模全量扫描或压缩操作，导出和重算按分页拆分，观察事件循环延迟。10 个活跃会话能否达标必须按 NFR 实测，不能仅凭 SQLite 选型推定。

SQLite 官方已记录 WAL-reset 问题及修复版本；冻结驱动时应实际查询内嵌 SQLite 版本，使用 3.51.3 或之后已修复版本，不能只看 npm 包版本。[WAL 修复说明](https://www.sqlite.org/wal.html) 这是一项版本检查要求，本轮未修改现有依赖。

运行时做一致性备份，不能只复制活跃主数据库文件而遗漏 WAL 状态。新应用备份与原实验证据分开。建议每次教学会话前后备份，故障恢复目标先设 RTO 30 分钟、备份恢复 RPO 为最近一次成功备份；正常进程重启不能丢失已经 ACK 的已提交事务。节点磁盘彻底损坏不在“零损失”承诺内。

上述备份频次/RPO/RTO 已作为 G0 进入方案批准；C5 演练前落实位置、访问/容量/清单和恢复操作条件，再报告实际 cutoff/损失窗口/恢复时间及引用完整性。真实数据库操作和覆盖恢复另获授权；未演练不承诺已达标。

### 10.2 最小运维

建议两个运行边界：一个持久应用节点，一个独立代码执行节点；受控网络和 HTTPS 前置入口按现有基础设施配置。无需 Kubernetes、多个业务微服务或全天运行的自主 Agent。

健康检查分别报告应用、数据库、模型供应商和执行器状态。模型/执行器故障允许降级，存储无法确认写入时不能显示保存成功。维护恢复不能替学生切换学习状态。

时间戳统一保存 UTC，展示按用户时区，当前项目默认 Asia/Shanghai。日志保留 requestId、jobId、事件类型、时延、失败分类、配置版本；正文与敏感内容仅在授权业务记录中按需查看。

部署密钥、CI/CD、数据库建表/迁移、删除和公开发布均为后续实际操作，按 AGENTS.md 另行获得所需授权。本次没有生成这些配置或执行脚本。

### 10.3 成本控制

记录每次模型输入/输出用量、供应商实际 usage 是否可得、重试和错误成本；未知用量标未知，不按零计。模型单价在实际选型时核对，计算每请求、每 Attempt 和试点总费用。

采用每账号/课程的调用配额、单轮次数/时间限制、有限上下文、提交节点批处理状态更新，以及执行队列限额。预算上限触发后暂停新的模型调用并给出清楚反馈，保存、已有反馈和教师人工审阅不受影响。

预算金额不写入项目文档。账号/课程实际配额和额度控制在获授权的运行配置中落实，unknown usage 保守占用、不退成 0；本文件不提供金额或凭据，也不授权付费调用。费用、用量与配置/失败事实按原 NFR-06 记录。

首版不引入自动跨模型降级，以免帮助行为和数据处理范围静默改变；要更换模型时显式记录新配置版本并跑必要回归。

## 11. 验证与实施约束

验收编号以 [MVP_SPEC 第 6 节](MVP_SPEC.md)为唯一清单，本节明确责任：

| 层次 | 必测内容 | 对应验收 |
| --- | --- | --- |
| 数据与权限 | 角色裁剪、跨课程拒绝、引用完整性、版本 CAS、幂等摘要、教师纠正事务 | AC-02、AC-06、AC-07、AC-08、AC-15 |
| 团队 Web UI 集成 | 实际交付上验证对象/保存/草稿/文件、课程运行参数、只读产物、停止/返回/采集与可访问操作 | AC-03、AC-04、AC-05、AC-11 |
| 运行 | 镜像/快照/参数绑定、路径/资源/网络/文件隔离、白名单产物/合计输出上限、可信 stdout/文件检查 | AC-04、AC-10、AC-15 |
| 恢复 | 应用/执行器重启与旧备份回退分别验证，租约/代际/账本/迟到/取消/产物引用、角色裁剪导出与一致性备份 | AC-06、AC-08、AC-09、AC-12 |
| 教学语义 | 草案一致性、提示适切、相关历史使用、帮助条件、未知/反证 | AC-01、AC-05、AC-07、AC-16 |
| 实际使用 | 教师从资料到再设计，学生探索、协作、修订与后续任务 | AC-13、AC-14 |

固定工程样例覆盖空历史、相关/无关历史、撤回、环境失败、资料指令注入、请求完整答案及限定帮助检查。样例不进入真实学生的状态；模型评阅可辅助发现问题，不能代替真人课程审阅或把多个模型一致当真值。

性能按 MVP 的同一负载口径验收。语义失败、缺回执和超时全部计入报告；不能只保存成功样例，也不能靠把所有状态写成 unknown 获得表面正确。

G0 方案已由负责人统一批准；按 G1 作品链、G2 教学消息、G3 复核闭环实现，每切片附必要测试。准备门禁批准与环境/业务验收分开，产品变更仍先更新上游文档，再实现。

## 12. 已批准方案与后置进入条件

| 参数/风险 | G0 已批准内容 | 落实角色/触发与受阻工作 |
| --- | --- | --- |
| 教学/资料 | C 程序设计/C，函数/数组/指针先备，Web 中 Core→反馈→Report；正式行为见 MVP §1.3 | 教师/A 在活动确认前准备获准 TXT/Markdown/段落引用、固定检查与实际蓝图；未就绪不开放活动 |
| 模型 | DeepSeek/deepseek-flash、第 6.2 节配置、无文档金额 | B 在真实验证前核账号/API/数据/配额，30 次性能与人工语义在 B4；凭据/付费/真实发送另授权 |
| 后台版本/目录 | 第 2/3.1 节的版本、文件责任、单应用/SQLite/HTTP/SSE | A1 固定锁文件并安装/typecheck/实际驱动验证；本次未实施。UI 依成员最后交付 |
| 独立执行 | 后台专用 Linux VM/节点、C17/GCC/固定 argv、结果白名单和完整 NFR-03 | C1 在资源/操作获准后定具体 GCC/image digest/启动取消机制，跑 AC-10/15；当前未具备就绪证据，阻止真实运行/活动开放 |
| 账号/数据/网络 | 预置账号、私有访问、8 小时/30 分钟会话、90 天复核/不自动删除及教师/A/C 责任 | A1 在发放前核认证参数/真实存储授权，真人试点前 A/C 落实入口/告知/处理/访问；C5 落备份恢复 |
| 性能/恢复 | 单机 SQLite、两个运行槽、会话前后备份/RPO 最近成功备份/RTO 30 分钟 | C5 按 NFR/AC-12 的实际环境负载/故障/备份测量；不把元数据或文档当实测 |
| 分工/首批进入 | 既定 A/B/C/UI，A1-P1/B1/C2 首批方案获批，UI 最后接入；不登记投入/日期 | 进入对应编码前建本人任务文档；其余任务按真实依赖，数据库/凭据/CI/删除/生产发布另授权 |

统一裁决范围为 G0-C01～15、TextScope TS-P01～06、上述技术/数据/资源与分段实施方案，正式契约已写入本文件各章；来源与未实施记录见 [G0 裁决](../tasks/G0_CLOSURE_PROPOSAL.md#10-2026-10-09-负责人统一裁决及基线同步)。首批为 A1-P1（工程/入口/校验/健康）、B1（合成独立 Agent 核心）、C2 首批（快照/公共记录/同 tx 核心）；A1-P2/P3 实存储另需授权及 C2，C1 实运行另需专用资源/配置。G0 准备条件通过不表示 G1～G4 或 AC/NFR 已通过。

## 13. 设计依据

影响本设计的研究结论见[产品研究依据](../reference/PRODUCT_RESEARCH.md)，可沿用的能力、版本契约与历史限制见[工程衔接说明](../reference/ENGINEERING_HANDOFF.md)，协作与操作边界见[工作空间规范](../../AGENTS.md)。必要内容均可在本仓库独立阅读，不依赖个人目录、旧本地服务或未交付源码。

沿用 2026-10-04 定点查阅的一手技术资料：[Node 发布与支持](https://nodejs.org/en/about/previous-releases)、[Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[SQLite 使用边界](https://www.sqlite.org/whentouse.html)、[WAL](https://www.sqlite.org/wal.html)、[AI SDK](https://ai-sdk.dev/docs/agents/loop-control)、[Docker 资源限制](https://docs.docker.com/engine/containers/resource_constraints/)与[安全说明](https://docs.docker.com/engine/security/)。它们用于核对推荐机制与限制，未完成新栈安装、性能测试、安全认证或教学有效性验证。2026-10-06 修订只同步 Web UI 分工及已有实验状态，未重新开展技术选型调研。

2026-10-08 的整理只更新团队可读的来源与复用说明，并修正原工作空间的启动入口描述；没有变更推荐技术架构、业务接口、数据模型或验收要求，也没有运行旧实验。
