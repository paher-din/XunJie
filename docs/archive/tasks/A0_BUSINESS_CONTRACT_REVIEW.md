# A0：业务权限与公共契约评审提案

任务：[Issue #2](https://github.com/paher-din/XunJie/issues/2)。主责：A。关联：[G0 #1](https://github.com/paher-din/XunJie/issues/1)、[B0 #3](https://github.com/paher-din/XunJie/issues/3)、[C0 #4](https://github.com/paher-din/XunJie/issues/4)。
日期：2026-10-08（Asia/Shanghai）。基线提交：8a0e3325eaa456e903bd31532ce2a5eef8d8736a。
状态：**A 的评审稿已准备，待 B/C 会审与负责人决定；A0 未通过，G0 未冻结，无正式应用实现。**

## 1. 依据、写入边界与提案性质

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)、[PRD](../product/PRD.md) 第 5/8/9 节、[MVP_SPEC](../product/MVP_SPEC.md) 第 2～8 节、[TECH_DESIGN](../product/TECH_DESIGN.md) 第 2～10/12 节、[TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) A0 与第 4.1 节，以及两份 [研究](../reference/PRODUCT_RESEARCH.md)/[工程参考](../reference/ENGINEERING_HANDOFF.md)。任务依据为 PRD-02/06/08/09/10，M-01/02/05/06/07/08/09/10，重点 AC-02/06/08/15 与 NFR-04；不改变原 M/AC/NFR 和 G0～G4 条件。

Issue 发布正文要求直接补充 TECH_DESIGN 和 MVP_SPEC 第 10 节；最新 AGENTS 的“授权与冲突处理”明确优先约束历史 Issue 修改要求。因此本次可写范围为本文、README 任务导航/验证入口和第 19 节的只读检查工具 tools/a0-review/check.mjs；产品、规划、规范与参考正文均只读。下文是供汇总的待评审提案，**不成为正式契约或编码授权**；文档批准与基线写入授权需要分别记录。与 B/C 的字段或行为差异收敛后，由获授权维护者合入基线；不平行维护第二份已批准规格。

原工作区的 A 方案和技术草案保持原状，本次不提交这些旧改动。当前工作区从上述最新远程提交独立建立，无旧实验源码、个人目录或本地服务依赖。本文不配置凭据、CI、数据库、执行环境或替代 UI。

| 交付项 | 基线位置 | 本提案位置 | 当前状态 |
| --- | --- | --- | --- |
| 角色与资源授权 | TECH 第 2/5/9 节、M-10 | 第 2/3/7 节 | 已起草，待会审 |
| 四类对象状态、暂停优先级 | TECH 第 4/7 节、MVP 第 4 节 | 第 4 节 | 已起草；差异登记 A0-R01～03 |
| 逐命令身份/版本/幂等/恢复 | TECH 第 5 节 | 第 5/6 节 | 24 项提案；新增接口待确认 |
| 选型/目录/逻辑结构/短事务 | TECH 第 2/3/4/10 节 | 第 2.1/8/9 节 | 推荐方案，未冻结/未建表 |
| D-03 账号/访问/数据/资源 | PRD D-03、TECH 第 9/10 节 | 第 10 节 | 已起草；未与 C 核对 |
| B 候选与 C 作业/失效接入 | TECH 第 6/7 节 | 第 8 节 | 保存归属与事务提案，实际联调未执行 |
| B/C 会审、差异与决定 | TEAM 第 4.1 节 | 第 12 节 | 五处交界待评审；不得勾选完成 |

## 2. 公共身份、范围与版本提案

字段命名与含义由 A 汇总；各领域仍由其负责人实现。浏览器输入是待验证的请求，不是可信身份或记录来源。表中 revision 为非负安全整数，创建时的预期版本 `0` 只表示尚无该对象；已经创建的版本从 `1` 开始。只有从未建立学习状态时允许读取 learnerStateRevision=0；已有状态即使有效主张全为空也保留当前 revision，不重置为 0。自述/反馈尚未创建时读取 null，首次写入的 expectedContextRevision/expectedFeedbackRevision=0。

| 字段/对象 | 含义与核验 | 维护责任 |
| --- | --- | --- |
| userId / courseId / studentId / attemptId | 公共 ID 为不含路径语义的非空字符串；资源关联以服务端记录为准。studentId 指课程中学生账号，不作为真实操作者认证 | A 定义范围；各领域保存关联 |
| ActorContext | 从有效 Session 和课程成员产生的 userId、courseId、课程角色；内部调用额外携带已授权用途/资源范围。客户端或模型不能构造/扩大此上下文 | A；B/C 只能消费 |
| resourceVersionId / activityVersionId | 不可变内容版本 ID；资料段落、量规、政策、规则及运行配置通过活动绑定读取，不解析“最新同名资源”代替旧引用 | A；C 提供运行/检查版本 |
| revision / expectedRevision | 当前蓝图版本与本次修改/检查/确认所预期版本；成功编辑增加一次，拒绝的命令不增加 | A/design |
| assignmentRevision / expectedAssignmentRevision | 分配控制版本；学生集合与活动版本固定，暂停/恢复通过此版本并发检查 | A/design |
| attemptRevision / expectedAttemptRevision | 尝试生命周期、路线/返回位置、个人控制及修订许可的并发版本；文件逐次编辑不增加它 | C/workspace；A 通过事务接口调用 |
| contextRevision / expectedContextRevision | 学生在该课程的目标/约束自述版本；与能力推断、作品版本独立；首次创建 expectedContextRevision=0 | A/review |
| learnerStateRevision / expectedStateRevision | `(courseId, studentId)` 下整个有效学习状态的版本；从未建立状态时读 `0`，不补造历史记录；清空/撤回主张仍保留已有状态版本。候选接纳、异议引起的投影变化和教师决定使用同一 CAS | A/review |
| claimId + claimRevision | 一条主张及其确切修订；主张同时具有课程/学生、目标版本、适用任务范围、证据组和来源。异议/决定引用确切版本，不只引用一句话 | A/review；B 提交候选 |
| feedbackId + feedbackRevision | 教师反馈的追加版本；首次保存用 expectedFeedbackRevision=0，修订引用当前版本；不是能力状态 revision | A/review |
| decisionEpoch | 某 Attempt 的教学决策失效代数；纠正、任务暂停、主动求助替换等按本提案第 8.3 节递增。不等于文件版本或消息展示序号 | C 提供同事务操作；A/B 按原因调用 |
| snapshotId / fileId / documentVersion / contentHash | 确认作品与文件实例的版本；继续使用 TECH_DESIGN 第 4.1 节。求助/运行/提交不能以当前路径或本机未同步内容替代 | C；A/B 核验引用 |
| jobId / commandId / requestId / eventCursor | 持久作业、已接纳业务命令、单次 HTTP 请求追踪与事件补取游标分别标识；重试有新 requestId，但同命令结果/副作用不重做；游标不授予读取权 | C 提供 Job/CommandReceipt/事件；A 生成 requestId |

scope 至少能定位 courseId、studentId、competencyId 及其目标版本，并注明只适用于哪次活动/尝试还是同课程相关目标。新任务读取先按范围过滤，再看 validity/帮助条件；不能仅因 competencyId 相同就认定可迁移。B 的上下文读取必须返回已过滤的主张和反证，不返回另一学生的状态缓存。

### 2.1 A 领域逻辑结构提案

这是建表授权前的逻辑设计，**没有新增数据库、DDL 或迁移**。对象可以按 TECH_DESIGN 第 4 节使用版本化 JSON；实际表、索引和驱动选型在 G0 及数据库操作评审后落实。

| 逻辑对象 | A0 需要保存的关联 | 必须可验证的约束 |
| --- | --- | --- |
| CourseMembership / Session | userId、courseId、角色、成员/会话有效状态 | 教师权限按课程；维护者身份不隐含教师权；新分配对象必须是有效学生成员 |
| ResourceVersion | courseId、材料来源、段落/正文/hash、可见范围、前版本引用 | 内容不可变；材料更新创建新版本；当前活动保留原引用；检索/错误/导出不绕过可见性 |
| BlueprintDraft / Proposal | courseId、蓝图 revision、建议 jobId/baseRevision、差异/引用/影响项 | 提案不直接覆盖草稿；源材料必须获准；人工采用再校验基础版本及所有影响关联 |
| BlueprintCheck / RubricTrial | 蓝图 revision、三类检查、教师疑点处理、样例/试评/歧义引用 | 检查结果不能跨 revision 复用；试评样例只支持设计审阅，不成为学生能力观察 |
| ActivityVersion | 蓝图及其 revision、目标/量规/资源/政策/检查/运行版本与就绪依据 | 确认事务共同核验引用并冻结；不通过原地改内容更新要求 |
| Assignment | courseId、activityVersionId、指定 studentIds、控制状态/revision、教师理由 | 分配集合及活动版本固定；改变范围另建分配；暂停是覆盖层，不篡改旧尝试生命周期 |
| MyContextRevision | courseId、studentId、自述内容、contextRevision 与来源 | 只有本人修改；教师/模型可引用，不把自述改写成观察或正式判断 |
| LearnerStateRevision / Claim | 课程/学生、前 revision、确切主张版本、来源/范围、证据组、支持/反证/帮助/未知 | 同范围只有一个有效头版本；追加历史；撤回/争议不抹去事实；不输出累积掌握概率 |
| Dispute / TeacherDecision | 本人或教师身份、targetRef、理由/引用、所见状态版本、处理关联 | 原异议和决定保留；对历史目标的申诉不直接覆盖当前不同主张；复核不自动复活撤回依据 |
| FeedbackRevision | kind、attemptId、快照或 submissionId、状态依据、教师身份、feedbackRevision | formative 与 submission_review 区分；模型草稿不成为正式反馈；正文与三条能力线/帮助/未知分开 |
| ReopenGrant | attemptId、最新 submissionId、许可教师/理由、许可版本与使用记录 | 教师只许可；学生主动继续才改变学习阶段；许可不能覆盖旧提交或迁入新活动要求 |

ReopenGrant 的教学许可由 A 负责，许可保存/消费与尝试生命周期通过 C 的事务接口完成；A 不直接改 Attempt，C 不改教师理由或教学决定。正式反馈引用后来已撤回/争议的主张时，读取投影标注依据状态，保留原正文/当时版本；旧反馈不能成为恢复已撤回主张的捷径。

所有证据引用同时核验存在、版本、所属课程/学生、用途和当前可用性。引用已撤回/脱敏或本人无权读取时，返回明确的缺口/受限说明；不把 hash、模型摘要或教师赞同补成原始证据。Student 可见状态/反馈也不能借引用反查私有答案。

有效投影保留 self_report/model_estimate/teacher_judgment 等来源区别。主张得到 supported 状态必须有可用原始引用与明确帮助条件；教师无依据赞同只能改变判断/处理状态，不能凭空补观察。教师撤回约束按目标、适用范围及被否定依据保留，B 不能靠换 claimId、措辞或 estimatorVersion 用同一依据恢复该主张；新的证据也不改写旧撤回事实，需按当前版本重新评估。

## 3. 角色与资源授权矩阵

T 表示该课程有效任课教师，S 表示本人且为有效课程学生成员，O 表示获准维护操作。role 与资源归属均由服务端获得。Teacher 不能凭另一课程的教师身份获权；Student 不能凭共享 URL 访问另一学生记录。B/C 的后台调用是受控用途，不新增一个能够自由扮演用户的公开角色。

| 资源 | T | S | O | B/C 受控使用 |
| --- | --- | --- | --- | --- |
| 账号/Session/课程成员 | 登录本人；读取负责课程的必要成员信息 | 登录本人；读取本人课程关系 | 按批准方式预置账号/邀请；不获得教学判断权 | A 提供可信身份/范围，不能从模型参数生成 |
| 课程材料版本 | 创建/读取/选择版本与可见性 | 读取本人获分配活动中可见版本 | 不因维护身份自动读取教学正文 | 教师生成仅选定资料；学生辅导只取 tutor 投影；分析不得借工具获取私有答案 |
| 私有答案/验证资产 | 负责课程范围内的设计/审阅 | 不可读 | 只按批准配置管理，不成为辅导读取入口 | 可信验证器只取指定规则所需资产；不进入学生进程/普通辅导上下文 |
| 蓝图/提案/检查/量规试评 | 负责课程内创建、编辑、预览、采用/确认 | 不读草稿或未采用提案 | 不编辑/确认 | B 仅提交绑定请求和基础版本的建议；C 保存作业与事件 |
| 活动/分配 | 创建固定版本、分配、暂停/恢复 | 读取分配给本人的固定活动，不修改要求 | 不代教师分配 | C 据分配建尝试；B 读本次活动获准投影 |
| 尝试/文件/快照/运行/提交 | 审阅负责课程实际引用；准备样例另走教师用途 | 本人发起编辑/保存/运行/提交与恢复；固定提交不能覆写 | 按批准恢复/备份，不代学生操作学习阶段 | C 执行本人命令；B 只读获准确认对象，无写作品/运行工具 |
| 原始消息/观察/覆盖/回执 | 负责课程的审阅范围 | 本人可见内容及覆盖说明 | 授权运维最少元数据；正文访问另按 D-03 | C 保存真实来源；B 不能补造事实；展示回执不是阅读/理解证明 |
| 自述 | 在审阅上下文读取有关自述，不替学生修改 | 修改自己的课程目标/约束 | 不修改 | B 可引用且注明 self_report；不变成能力证据 |
| 主张/有效状态/异议 | 查看原始依据，确认/纠正/暂缓，处理异议 | 查看本人状态，提出/查看异议；不能写正式判断 | 不作教学决定 | B 提交候选；A 校验/投影；C 提供原始依据和失效能力 |
| 反馈/修订许可 | 保存正式反馈、给出/修订许可 | 查看本人正式反馈；获准后主动继续 | 不代教师反馈、不代学生继续 | B 只起草；A 保存决定；C 负责生命周期与旧提交 |
| Job/事件/导出 | 本人发起 Job；课程审阅/导出按授权投影 | 本人 Job、尝试事件与个人可见记录 | 获准健康/备份/恢复，不开放任意课程导出 | C 实现记录/裁剪；A/B 不另建队列或回执 |

教师预览 student/tutor/teacher-validator 三种载荷时仍以 T 鉴权。Student 或 B 的 student_help 调用即使填写 audience=teacher，也不能取得第三种载荷。授权过滤发生在检索、序列化和事件下发前；不先传全包再隐藏字段。

## 4. 业务状态与暂停优先级

### 4.1 蓝图、活动与分配

“草稿/已确认”是对象性质；阻断/设计疑点/待验证是检查结果，不混成同一生命周期枚举。检查和试评只认所绑定的 revision，编辑后不能拿旧检查冒充新版本通过。

| 对象/当前状态 | 允许命令 | 转换/版本 | 拒绝与保留 |
| --- | --- | --- | --- |
| 尚无蓝图 | CMD-04 manual/agent/copy | manual/copy 创建 revision=1；agent 创建 Job/Proposal，教师选中后创建草稿 | 不要求完整机器配置；生成失败不产生正式活动 |
| BlueprintDraft 草稿 | CMD-05/06/07/08/24，READ-04/05/06 | 编辑增加 revision；检查/试评绑定当前 revision；release 创建独立活动 | 旧提案/CAS/引用不符拒绝；保留人工内容 |
| ActivityVersion 已确认 | CMD-09，CMD-04 copy，READ-07 | 确认内容与资源/政策/量规/运行配置固定；复制创建新蓝图 | 无原地 PATCH；不能替换已开始尝试要求 |
| 无 Assignment | CMD-09 | 固定活动和 studentIds；创建 active 控制 revision=1 | 无有效学生成员或环境未就绪拒绝 |
| Assignment active | CMD-10 pause、CMD-11，所属尝试的学生学习命令 | pause → paused，控制 revision 增加，相关 epoch/作业同事务处理 | 分配不自动开始学生操作 |
| Assignment paused | CMD-10 resume、合法读取/已有草稿保存、教师复核/反馈 | resume → active；不改 Attempt 本人 paused；不重投旧动作 | 学生 start/help/run/submit/resume/resume_revision 拒绝 |
| 分配学生集合或活动要改变 | 新 CMD-09 | 新分配；旧活动/尝试不变 | 不改旧分配的范围或资源引用 |

MVP 第 4 节“已确认活动版本暂停使用”与 TECH 的分配暂停路径需统一：本稿建议通过相关分配暂停覆盖已分配尝试；未分配活动是否需要独立“禁用分配”控制，记录为 A0-R03，不增加未经确认的命令。停用账号/成员只撤销权限，不伪造学生主动暂停，不删除尝试历史。

### 4.2 尝试操作与阶段转换提案

此表细化 MVP 第 4 节已有行为，待 A/B/C 会审、负责人批准并由授权维护者同步基线后作为实现依据。ready 是已创建但尚无学生开始行动；读取/恢复展示不激活它。学生可直接编辑、求助或运行，第一条获准显式学习命令在其事务中开始，不增加必须点击的开始步骤。Attempt 状态由 C 维护；A 的反馈/许可通过 C 的事务接口衔接。

| 操作 | 之前 → 之后 | 发起者/条件 | 保留与拒绝规则 |
| --- | --- | --- | --- |
| 建立当前尝试 | 无 → ready | S 对 active 分配显式进入；CMD-11 | `(assignmentId, studentId)` 只有一个当前尝试；重试返回原对象 |
| 开始或首次有效学习命令 | ready → active | S 的 start，或获准同步/求助/运行/提交；分配 active | 无强制诊断/计划；首次提交可在同事务中再转 submitted；GET 无此副作用 |
| 暂缓个人尝试 | active → paused | S 的 pause | 取消/归档进行中的相关动作；已有作品保存可用；不抹掉结果 |
| 恢复个人尝试 | paused → active | S 的 resume，分配 active | 教师暂停时拒绝；不重投旧提示或悄悄重跑 |
| 固定提交 | active → submitted | S 的 CMD-17，确认快照与课程要求引用成立 | 固定旧快照；课程检查结果与作品评价分别表达；不要求作品一定答对才可完成流程 |
| 学习主张复核 | 生命周期不变 | T 的 CMD-21 | 更新状态/决定和依赖失效；不把“看过一条主张”当作整份提交已审阅 |
| 保存形成性反馈 | 生命周期不变 | T 的 CMD-23 kind=formative | 绑定明确对象/范围；不会自动提交、重开或改量规 |
| 保存提交审阅反馈 | submitted → reviewed；reviewed 保持 | T 的 CMD-23 kind=submission_review，绑定最新固定提交 | 正式反馈/阶段同事务；旧提交、旧反馈和帮助条件不回写 |
| 允许个人修订 | reviewed → reviewed | T 的 CMD-22，绑定最新提交与当前尝试版本 | 保存许可，不代学生主动继续 |
| 学生继续修订 | reviewed → active | S 的 resume_revision，许可仍有效、分配 active | 使用同一固定活动，消费该次许可；保留所有旧提交，新提交另有 ID/版本 |
| 进入相关后续任务 | 原尝试不变；新尝试 ready | T 确认/分配新活动后，S 显式进入 | 新活动/尝试独立；同课程适用有效状态可读取，旧错误不恢复 |
| 暂停/恢复分配 | 各 Attempt 生命周期不变 | T 的 CMD-10 | Assignment 是优先覆盖层；暂停阻止新开始/帮助/运行/提交；恢复不替学生解除个人 paused |
| 暂停采集或关闭提醒 | 生命周期不变 | S 的独立控制 | 功能数据/主动求助继续；按本提案第 8.3 节仅取消相应类别 |

在 ready/active/paused 生命周期内，paused 或分配暂停时 sync 仍可保存已有文件草稿；不能因此恢复 active、发新帮助/运行或提交。submitted/reviewed 不因为分配暂停就获得作品写权。新建/回收文件的暂停处理由 C0 按“查看和保存现有草稿”边界核对，不用 UI 按钮状态代替服务端校验。

设值类控制在版本检查通过后若已经是目标值，返回当前版本/状态，不额外增加 epoch 或补造覆盖区间；同键重放仍按公共回执返回首次结果。改变其他控制不能顺带修改采集、提醒或个人暂停。

CMD-15 的生命周期操作允许状态为 start=ready、pause=active、resume=paused、resume_revision=reviewed；start/resume/resume_revision 还要求分配 active，最后一项须消费有效许可。采集/提醒设值提议允许本人当前尝试的 ready/active/paused/submitted/reviewed，分配暂停不阻止停止采集或关闭提醒；开启只改变后续许可，不激活尝试、自动排队或复活旧作业，其他命令仍各自检查状态。此状态细化纳入 A0-R10 会审，closed 的行为仍待 A0-R02 裁决。

### 4.3 控制判断顺序

每次命令先核验当前会话、课程和资源，之后取同一事务的分配与个人状态。教师分配暂停覆盖个人恢复；个人 paused 阻止新帮助/运行/提交，仍可保存现有草稿；采集暂停只停止逐次过程和被动分析；提醒关闭只停止主动提醒。submitted/reviewed 的固定提交不被任何开关解锁。没有“恢复所有控制”的快捷语义。

差异：TECH 第 7.1 节列出 closed，而 MVP 没有关闭状态或命令；本稿不给 closed 发明操作或产品出口，待 A0-R02 裁决。TECH 第 6.1 节只允许 active 求助，而 MVP 第 4 节允许 ready 求助；本稿按 MVP 提议首次有效命令同事务激活，待 A0-R01 会审确认。

## 5. 逐命令业务契约提案

除 CMD-01/02 认证例外，命令都使用本提案第 6 节公共幂等规则。表中“版本”字段为必需的并发/引用检查；纯创建不需要编造已有 revision。assignment active 是个人开始/求助/运行/提交的共同前提，暂停后的保存例外见 CMD-12。T/S 的资源范围按本提案第 3 节逐次核验。

| 编号/接口 | 发起/归属 | 允许状态 | 输入版本与关键内容 | 结果/责任 |
| --- | --- | --- | --- | --- |
| CMD-01 POST /api/sessions | 本人账号 | 账号可登录 | 凭据；不接受 role/studentId 赋权，无业务 revision | Session 与可信本人信息；A |
| CMD-02 POST /api/logout | 本人 Session | 有效或已退出 | 撤销当前会话；不记录凭据摘要 | 重复退出安全结束；A |
| CMD-03 POST /api/courses/:id/resources | T/课程 | 课程允许设计 | TXT/Markdown/粘贴、可见性；更新注明前 resourceVersionId 并校验归属 | 新不可变 ResourceVersion；A |
| CMD-04 POST /api/courses/:id/blueprints | T/课程 | 课程允许设计 | mode=manual/agent/copy；manual 可为少量信息，也可带 sourceProposalId/selectedCandidateId 采用获准根提案；copy 校验源 activityVersionId 或源蓝图 revision；agent 记录获准输入 | manual/copy 返回新草稿；agent 返回 jobId 与候选/草案提案引用，人工选择后再创建草稿；A+B+C |
| CMD-05 PATCH /api/blueprints/:id | T/蓝图 | 草稿 | expectedRevision、局部变化；采用建议另带 proposalId/baseRevision，均须匹配当前草稿 | 新 revision/关联影响；不自动变基旧提案；A |
| CMD-06 POST /api/blueprints/:id/proposals | T/蓝图 | 草稿 | expectedRevision、局部请求/获准引用 | jobId，完成后为提案，不写草稿；A+B+C |
| CMD-07 POST /api/blueprints/:id/checks | T/蓝图 | 草稿 | expectedRevision、设计疑点处理说明 | 绑定该 revision 的阻断/疑点/未验证结果；A |
| CMD-08 POST /api/blueprints/:id/releases | T/蓝图 | 草稿且无阻断 | expectedRevision、相同版本检查与疑点说明；服务端核验关联版本/C1 就绪 | 不可变 ActivityVersion；原草稿仍可编辑出下一版本；A+C |
| CMD-09 POST /api/activities/:id/assignments | T/活动课程 | 已确认活动 | 指定 studentIds，均为课程有效成员；核验固定活动和运行配置 | Assignment 与控制版本；不自动启动尝试；A |
| CMD-10 POST /api/assignments/:id/controls | T/分配 | 已分配 | expectedAssignmentRevision、pause/resume、理由；事务内覆盖相关尝试 | 新分配控制版本、epoch/失效结果；不重新投递旧动作；A+C |
| CMD-11 POST /api/assignments/:id/attempts | S/获分配任务 | 分配 active | 固定 assignmentId；本人 studentId 来自身份；校验唯一当前尝试 | 创建 ready 或返回已有尝试，不能以重试绕过旧提交/政策；C+A |
| CMD-12 POST /api/attempts/:id/sync | S/本人尝试 | ready/active/paused；分配暂停时仍可保存已有作品 | fileId/baseVersion/clientId/clientSeq 与内容变化；不接受任意路径执行 | 落盘 ACK/冲突；ready 首次学习写入仅在分配 active 时转 active，暂停时不恢复；C |
| CMD-13 POST /api/attempts/:id/help | S/本人尝试 | ready/active 且分配 active、政策允许 | expectedAttemptRevision、ObjectRef/问题；核验确认对象并读取当前状态/epoch | ready 同事务激活后接纳，返回 jobId；B+C+A |
| CMD-14 POST /api/attempts/:id/runs | S/本人尝试 | ready/active 且分配 active | expectedAttemptRevision、snapshotId、批准 profile/输入、run 或 course_check；限额与检查政策 | 固定 runId/jobId；ready 同事务激活；C |
| CMD-15 POST /api/attempts/:id/controls | S/本人尝试 | start:ready；pause:active；resume:paused；resume_revision:reviewed+有效许可；采集/提醒设值:ready/active/paused/submitted/reviewed；按本文第 4.2/4.3/8.3 节检查分配与用途 | expectedAttemptRevision；start/pause/resume/resume_revision 或采集/提醒设值；重开带有效 grant 引用 | 新尝试/控制版本；三个开关独立，不默默恢复；C |
| CMD-16 POST /api/jobs/:id/cancel | 有权发起该 Job 的本人 | 排队/进行中；已终结保留状态，仍停止其关联未展示教学动作 | jobId、所属命令/范围；不授予教师任意代学生发起操作权 | 取消请求/既有结果及教学投递停止结果同事务保存；不抹去事实；C，B 配合 |
| CMD-17 POST /api/attempts/:id/submissions | S/本人尝试 | ready/active 且分配 active | expectedAttemptRevision、确认 snapshotId、课程要求的说明/检查引用 | 固定 Submission、submitted；不把 stdout/smoke 当通过；C |
| CMD-18 POST /api/actions/:id/receipts | 已认证的目标 S 客户端 | 事实发生过即可追加，迟到事实仍保留 | actionId/contentHash/receiptKind/clientReceiptId，核验目标/内容版本 | 去重回执；迟到/过时冲突标注，不回滚状态；C |
| CMD-19 POST /api/attempts/:id/disputes | S/本人尝试及同课程本人目标 | 已创建尝试 | targetRef={claimId,claimRevision} 或 {feedbackId,feedbackRevision}、理由；影响有效主张时 expectedStateRevision | 异议及所影响新状态；历史目标不覆写不同当前结论；A+C |
| CMD-20 PATCH /api/courses/:id/my-context | S/本人课程 | 本人有效课程成员 | expectedContextRevision、目标/约束自述；不接受能力/教师决定字段 | 自述新版本；相关上下文失效见本提案第 8.3 节；A+C |
| CMD-21 POST /api/attempts/:id/reviews | T/尝试所属课程与学生 | 已创建尝试；不要求已经提交 | expectedStateRevision、确切主张版本、confirm/correct/defer、理由/引用 | TeacherDecision、新有效投影及同事务失效；不自动标 reviewed；A+C |
| CMD-22 POST /api/attempts/:id/reopen | T/本人负责课程 | reviewed | expectedAttemptRevision、最新 submissionId、理由/许可内容 | ReopenGrant；仍是 reviewed，学生再主动继续；A+C |
| CMD-23 POST /api/attempts/:id/feedback | T/本人负责课程 | formative：已创建；submission_review：submitted/reviewed | kind、expectedFeedbackRevision、expectedStateRevision、来源快照/提交；改变阶段另校验 expectedAttemptRevision | 教师正式反馈追加；submission_review 与 reviewed 同事务；模型草稿不能调用；A+C |
| CMD-24 POST /api/blueprints/:id/rubric-trials | T/蓝图课程 | 草稿 | expectedRevision、获准样例引用、教师试评与歧义；不造学生观察 | 试评记录/关联修订提示；修改蓝图另走 CMD-05；A |

读接口同样校验范围，不因 ID 难猜就放开。不存在用于模型直接发布活动、编辑学生文件、运行程序或写正式评价的公共工具。模型能调用的是当前已授权上下文中的少量读取函数，如读取指定快照、读取结果、检索获准资料；调用参数再由服务端校验。

### 5.1 每个命令的幂等摘要、失败与恢复

K(scope) 为可信 userId + 稳定 CMD 编号 + scope + Idempotency-Key。D 为第 6 节规范化合法输入摘要，包含路由关联 ID 和全部合法正文；每行再列必须包含的关键项，不是只摘要这些字段。所有命令先核验身份/归属/用途：缺版本/未知字段 400，越权 403，无权查询的 ID 不泄露存在性。旧版本/旧状态/坏引用/不可用分别用第 6 节错误分类；恢复不扩大读取权。

| 命令 | K 的 scope / D 的关键项 | 拒绝/失败边界 | 恢复方式 |
| --- | --- | --- | --- |
| CMD-01 | 无业务 K/D；凭据不作持久业务摘要 | 无效凭据 401（不区分账号存在）、限流 429 | 本人重新登录/等待限流；不缓存凭据/登录响应 |
| CMD-02 | 无业务 K/D；本人当前会话撤销 | Origin/CSRF 不符拒绝；已退出安全结束 | 重复退出，不恢复已撤销会话 |
| CMD-03 | courseId；正文/可见性/前 resourceVersionId | 材料限额、前版本归属错误 | 调整材料/引用；确认新操作才换键 |
| CMD-04 | courseId；mode/获准输入/源活动或蓝图 revision/提案和候选 ID | 越权来源/旧提案/缺关键约束/模型或预算不可用 | 补条件/重读候选，查询原 Job；人工模式可用 |
| CMD-05 | blueprintId；expectedRevision/patch/proposalId/baseRevision | CAS/提案基础版本/关联冲突 | 保留未采用内容，重读比较，不自动变基 |
| CMD-06 | blueprintId；expectedRevision/局部请求/引用 | 旧 revision/越权资料/限额或预算 | 重读后主动新请求；先查询原 Job |
| CMD-07 | blueprintId；expectedRevision/疑点处理 | 旧 revision/格式或引用错误 | 修改后新版本重检；保留待验证项 |
| CMD-08 | blueprintId；expectedRevision/检查引用/疑点说明 | 旧检查/阻断/坏引用/运行未就绪 | 修正并重检，等 C 真实就绪证据 |
| CMD-09 | activityVersionId；studentIds/固定配置引用 | 非有效课程成员/活动不可用/运行未就绪 | 修正集合或等环境；不扩大名单 |
| CMD-10 | assignmentId；expectedAssignmentRevision/action/reason | 旧控制版本/事务存储失败 | 重读控制，同键查询原结果；不解除个人暂停 |
| CMD-11 | assignmentId；固定 assignmentId（本人来自会话） | 未获分配/分配暂停/当前已有提交不能重建 | 读取本人当前尝试，按反馈和许可继续 |
| CMD-12 | attemptId；完整批次/fileId/baseVersion/clientId/clientSeq/操作内容 | 旧基版本/同序号异内容/路径/阶段/限额 | 保留双端草稿，查询 ACK；确认后合并不强覆盖 |
| CMD-13 | attemptId；expectedAttemptRevision/ObjectRef/问题/意图 | 暂停/限定帮助/未确认或旧对象/预算时限 | 先同步或改引用，查询 Job；取消或人工求助 |
| CMD-14 | attemptId；expectedAttemptRevision/snapshotId/profile/模式/输入 | 暂停/坏快照配置/运行限额/执行器不可用 | 查询原 runId；outcome_unknown 不盲目重跑 |
| CMD-15 | attemptId；expectedAttemptRevision/具体控制/值/grant 引用 | 旧版本/分配覆盖/无效或已消费许可 | 重读控制和最新许可；开关分别处理 |
| CMD-16 | jobId；jobId/取消请求 | 非获准发起者/事务存储失败；外部取消失败不撤销已提交停止 | 查询 Job 与关联动作停止状态；同键重放不重复事件，终结/已展示事实保留，通知失败重试通知 |
| CMD-17 | attemptId；expectedAttemptRevision/snapshotId/说明/检查引用 | 暂停/旧状态/坏或他人检查/必需说明缺失 | 修正引用，查询原 Submission；不重复提交或要求必须答对 |
| CMD-18 | actionId；contentHash/receiptKind/clientReceiptId | 非目标本人/不存在的内容版本/伪造种类 | 按原事实重试；迟到追加标冲突，不补造中间回执 |
| CMD-19 | attemptId；targetRef/reason/expectedStateRevision（影响投影时） | 他人或不存在目标版本/状态 CAS | 重读本人目标；历史异议不覆盖新判断 |
| CMD-20 | courseId；expectedContextRevision/目标约束自述 | 旧版本/非本人/能力或教师决定字段 | 重读并保留自述，按新请求修改 |
| CMD-21 | attemptId；expectedStateRevision/targetRef/decision/reason/引用 | 状态 CAS/无权或不可用证据/事务任一步失败 | 重读依据，同键查询；未提交不得发通知 |
| CMD-22 | attemptId；expectedAttemptRevision/最新 submissionId/许可理由 | 非 reviewed/非最新提交/旧尝试版本 | 重读最新提交与许可；教师不代学生继续 |
| CMD-23 | attemptId；kind/feedbackId（修订）/expectedFeedbackRevision/expectedStateRevision/来源正文/阶段变化时 expectedAttemptRevision | 旧反馈/状态/尝试/非最新提交/未经校验来源 | 重读对比保留正文；反馈和阶段整体重试 |
| CMD-24 | blueprintId；expectedRevision/样例引用/教师试评歧义 | 旧草稿/未授权样例/伪造观察 | 重读或换样例；另以 CMD-05 修订量规 |

CMD-12 的 HTTP K/D 与 clientSeq 去重并存：传输重试同键，单独换键也不能重复接纳相同 clientId/clientSeq；同序号不同内容冲突。提交落盘后才 ACK。二者回执与原子性待 C0 核对，A 不另建同步记录。

CMD-23/24 是现有 M-07/M-01 必需行为的接口补全提案，当前 TECH 没有这两条路径；确认前不实现。反馈修订须提供 feedbackId，服务端不按“最后一条”猜对象；首次创建无 feedbackId、expectedFeedbackRevision=0，服务端生成 ID。提交审阅绑定最新 submissionId。教师样例执行已有 TECH 第 8.1 节依据，但公共入口缺失，记为 A0-R05 交 C0 准备；CMD-24 仅保存试评，不代替运行接口。

## 6. 公共响应、错误与幂等提案

成功响应包含 requestId、data 与受影响的版本；异步命令接纳只返回 jobId/排队状态及可查询引用，不冒充已生成/展示。业务命令可附 commandId/replayed；单次网络重试有新 requestId，但原命令的业务结果与对象 ID 保持相同。错误响应包含 requestId、error.code、可恢复 message、retryable 与必要的恢复方式，不回传堆栈/内部路径/密钥/私有正文。

| HTTP/业务错误码 | 触发 | 调用方恢复 |
| --- | --- | --- |
| 400 INVALID_REQUEST | 字段/类型或必需预期版本缺失；试图传入不允许的赋权字段 | 修正输入；不执行副作用 |
| 401 UNAUTHENTICATED | 未登录/会话失效 | 重新登录；不以请求参数补身份 |
| 403 FORBIDDEN | 课程/本人/资源/用途越权 | 拒绝；错误不说明他人内容或私有资产细节 |
| 409 VERSION_CONFLICT | revision/CAS 不匹配 | 在已有读取权下重读版本，保留本次未采用内容 |
| 409 IDEMPOTENCY_CONFLICT | 同键不同规范化请求 | 修正调用；确属新操作才使用新键 |
| 409 STATE_CONFLICT | 当前阶段、分配暂停或许可不允许 | 展示状态和可做操作；不强行改阶段 |
| 413 CONTENT_LIMIT | 已冻结文本/源码/输入限额超出 | 拆分或缩小；不无声截断 |
| 422 INVALID_REFERENCE / INVALID_CONFIGURATION / RUNTIME_NOT_READY | 引用/版本关系、目标关联、配置/就绪条件不成立 | 修正引用/配置或等待真实就绪，不能伪造 ready |
| 429 RATE_LIMITED / BUDGET_EXHAUSTED | 登录/命令配额或模型预算限制 | 明确限额；预算耗尽仍能保存和人工复核 |
| 503 DEPENDENCY_UNAVAILABLE / PERSISTENCE_UNAVAILABLE | 模型/执行器或存储不能确认结果 | 标明不可用/未知；查询原命令，不盲目新建副作用 |

业务幂等由 C 的 CommandReceipt 提供，A/B 不再建第二套。键范围为可信账号 + 稳定命令编号 + 目标资源（创建按课程/分配作用域），保存规范化合法输入的摘要；摘要包含预期版本/目标与实质内容，不把 role 或客户端时间当权限。规范化对象键顺序、不改正文/换行语义；含凭据的认证请求不进入此摘要。

认证与 Origin/CSRF 检查在回执读取之前。事务内先找既有回执：同键同摘要再核验当前读取权后返回原业务结果，不因第一次成功已增加 revision 而冲突；同键异摘要立即 409。新命令再检查当前版本/状态，业务写入、结果回执和事件同事务提交；失败不留半笔成功回执。唯一约束处理并发同键，不能仅靠“先查再写”。

CMD-01 使用认证限流/会话规则，不缓存密码或登录响应作为业务回执；CMD-02 撤销当前会话并安全重复退出。CMD-18 的回执事实还按 TECH_DESIGN 第 7.3 节内容版本去重。回执重放不重发学习动作；已不可见内容不因旧结果缓存泄露。事件补取与业务命令重试是两件事。

## 7. 读取与角色投影提案

读接口不产生学习阶段转换、不触发模型或运行。所有对象 ID 经服务端归属核验，GET 不使用 Idempotency-Key；数据返回确切版本/范围与真实缺口。表内路径为初始对接候选，不要求 UI 使用特定页面组织。

| 编号/接口 | 角色/范围 | 载荷与限制 | 实现责任 |
| --- | --- | --- | --- |
| READ-01 GET /api/session | 当前本人 | 可信本人/有效课程角色与会话状态，不含凭据 | A |
| READ-02 GET /api/courses | 当前成员 | 仅所属课程；维护权限不扩展课程教学读取 | A |
| READ-03 GET /api/resources/:versionId | T；S 需本人 attemptId | T 负责课程；S 只能读固定活动关联且可见段落；正文不按客户端 audience 提权 | A |
| READ-04 GET /api/courses/:id/blueprints；GET /api/blueprints/:id | T/负责课程 | 草稿 revision、关联与检查/疑点；不下发给学生 | A |
| READ-05 GET /api/proposals/:id | T/原请求所属课程 | 已校验候选/草案/局部差异、baseRevision、引用/影响项/过时状态 | A，B 提供输出 |
| READ-06 GET /api/blueprints/:id/preview | T/蓝图课程 | student/tutor/teacher-validator 三种明确投影；预览不分配、不确认 | A |
| READ-07 GET /api/activities/:id | T；S 需所属 assignmentId | 固定活动及绑定版本；S 按所属分配裁剪，不读取别人的分配/草稿 | A |
| READ-08 GET /api/courses/:id/progress | T/负责课程 | 实际尝试/提交/待处理项入口，无日志数量推导的能力分数 | A 聚合，C 提供事实 |
| READ-09 GET /api/attempts/:id | S/本人；T/负责课程 | 活动/生命周期/控制/revision、确认作品与恢复引用；GET 不恢复/重开 | C，A 鉴权 |
| READ-10 GET /api/attempts/:id/submissions | S/本人；T/负责课程 | 固定提交列表与版本；旧提交只读 | C |
| READ-11 GET /api/attempts/:id/review-context | T/负责课程 | 原始引用、候选/决定、作品结果、三条能力线、帮助/反证/未知及覆盖 | A 聚合，B/C 提供受控数据 |
| READ-12 GET /api/courses/:id/learner-states/:studentId | S 仅本人；T/负责课程 | 当前 revision、适用目标/活动投影、本人主张异议/处理与撤回说明；私有引用裁剪；历史不自动全包进入模型 | A |
| READ-13 GET /api/courses/:id/my-context | S/本人 | 自述及 contextRevision；未创建返回 null；T 读取有关部分走审阅上下文 | A |
| READ-14 GET /api/attempts/:id/feedback | S/本人；T/负责课程 | 正式反馈追加版本、固定来源/依据有效性/争议标记与修订许可；不把 B 未采用草稿给学生 | A，C 提供许可状态 |
| READ-15 GET /api/jobs/:id | 有权发起 Job 的本人 | 状态/失败/结果引用；学生教学原文须通过政策与投递校验才可取 | C，B 配合 |
| READ-16 GET /api/attempts/:id/events | S/本人；T/负责课程 | 裁剪 SSE/游标分页；每次连接/补取再鉴权，无未审查答案流 | C |
| READ-17 GET /api/courses/:id/exports | T/负责课程 | 一致范围导出与引用/版本/覆盖，排除凭据；不以导出绕过授权 | C，A 鉴权 |
| READ-18 GET /api/my/exports | S/本人指定课程 | 只导出本人可见记录，私有资产/其他学生内容不进入 | C，A 鉴权 |
| READ-19 GET /api/attempts/:id/snapshots/:snapshotId；GET /api/attempts/:id/runs/:runId | S/本人；T/负责课程 | 确认快照与真实运行/检查结果；完整私有验证细节按角色裁剪 | C |

## 8. B/C 接入与保存归属提案

| 能力 | 输入范围/版本 | 输出与保存归属 | 权限边界 |
| --- | --- | --- | --- |
| B1 教师生成/局部建议 | 教师请求、获准资料、约束、blueprintId/baseRevision（局部建议）；jobId/取消与截止 | 候选/提案、差异/影响项/引用/版本由 B 输出，A/design 保存；用量/job 由 C 保存 | 不编辑主草稿或确认活动；输入不足可说明缺口，不要求完整机器配置 |
| B2 学生上下文读取 | 可信本人/课程/attemptId、ObjectRef、固定活动、当前 epoch/状态 | A 提供获准活动/政策、相关有效主张/反证、自述与正式反馈；C 提供确认作品/结果/实际帮助 | 只按当前用途读取；无历史可读 revision=0/空主张；无私有答案 |
| B3 候选提交 | jobId/输入引用、预期状态/epoch、主张范围/帮助/未知、模型/提示/分析版本 | A/review 校验后接纳候选并投影；C 保留真实输入与分析记录；模型反馈仍是草稿 | 不能伪造观察、改 TeacherDecision 或绕过已撤回依据；旧版本拒绝直接写新头 |
| C2 分配/尝试接入 | 可信本人、assignmentId、固定 activityVersionId、当前分配控制 | A 返回授权/版本/政策；C 创建本人尝试/快照，暴露事务与恢复能力 | 不以旧许可或共享 ID 绕过暂停；不触发模型/自动学生运行 |
| C3 纠正传播接入 | A 的当前事务、课程/学生/相关尝试范围、失效原因与受影响类别 | 同一事务增加 epoch/失效 Job/Action/事件；提交后再通知/取消外部请求 | 不另开独立写事务，不改教师理由/教学判断，不抹掉已展示事实 |
| C4 提交/反馈/重开接入 | 固定 submissionId、尝试版本、正式反馈或教师许可、学生主动命令 | C 保留旧提交/生命周期；A 保存反馈/许可，与阶段变化同事务 | 教师许可不等于学生已继续；新活动只用于新尝试 |

接口实现与字段校验由对应负责人提供；A0 只提交汇总草案。B0/C0 评审应回填输入/输出格式、错误、失效范围及工程样例，不能仅写“能调用”。

### 8.1 短事务入口提案

下面的函数名表达模块契约，可在实现时按 G0 工程调整；**不是已存在 SDK/代码**。tx 为 A 创建的本次短事务上下文，C 的调用加入同一事务，不启动独立提交、不做网络等待。鉴权入口与事务资源读取都必须采用当前服务端记录。

| 提供方/能力 | 输入 | 输出与限制 |
| --- | --- | --- |
| A authorizeResource | 可信 actor、目标资源、稳定操作编号/用途 | 获准课程/本人/版本范围；拒绝不回传私有正文 |
| A withTransaction | 同步本地读写操作 | 原子提交/整体回滚；异步模型/runner/网络不能放入 |
| C resolveCommandReceipt / finishCommand | tx、可信账号/命令/目标/key/请求摘要；最终结果 | 已有同请求结果或新命令槽；同键冲突；结果/审计/事件与业务同提交 |
| C enqueueJob / appendEvent | tx、已获准 scope、版本/epoch、kind/输入引用/截止 | jobId/event 引用；不在事务里调用供应商或执行器 |
| C invalidateDecisionContext | tx、courseId/studentId/相关 attempt 范围、原因 | 原子增加相关 epoch、标旧动作/分析 stale、追加事件；不改原始事实 |
| C cancelByPurpose | tx、获准 jobId 或 attempt 范围、help/reminder/passive_analysis 等明确用途、原因 | 单 Job 停止或类别取消；持久停止标记与关联未展示 Action 失效同事务保存，终结 Job 状态保留；不影响范围外作业 |
| C transitionAttempt / grantReopen | tx、已授权操作、expectedAttemptRevision、提交/许可引用 | 新阶段/许可版本；不接受任意目标 state 写入或自动学生继续 |
| C readEvidence / readSubmission | 可信用途/课程/本人、确切 ObjectRef/Submission 引用；事务核验时可用 tx | 当前可用的原始引用/快照/结果/帮助/覆盖；拒绝或缺口明确 |
| C readRuntimeReadiness | 固定 runtimeProfileVersion 与验证配置 | 可信就绪状态、镜像/规则版本、验证证据和检查时间；不能以请求体 ready 代替 |
| C notifyCommitted / requestExternalCancellation | 已提交事件/取消引用 | 提交后推送/取消；失败可重试通知，不重做教学决定或运行 |

A1 先交权限/事务入口；C2 首批交 resolveCommandReceipt、finishCommand、enqueueJob、appendEvent 及可组合基础；A1 再完成命令联调，A3 开始真实教师作业接入。C3 再完成消息/用途取消和完整 epoch 失效；不等 C3 才首次提供 Job，也不把 C 的实现搬到 A 模块中。

教师纠正、分配控制、异议引起的 contested、反馈推动 reviewed 与修订许可分别通过本次 tx 组合业务与 C 的能力。初始逻辑约束包括：回执键唯一、同课程/学生状态头 CAS、蓝图 revision CAS、当前尝试唯一、许可绑定最新提交、外键/引用完整性。物理 SQL 方案仍待授权，不以该列表自动执行建表。

每条新命令的提交顺序：

1. 请求身份/Origin 检查，解析合法输入与摘要；事务内核验当前授权并处理既有回执。
2. 新命令检查当前版本、关联和阶段；涉及快照/证据/许可/就绪时再次核验可信记录。
3. 写本领域对象；调用 C 同事务的生命周期、epoch/用途失效、作业与事件能力。
4. 保存规范化业务结果和成功回执；任一步失败回滚所有数据库写入。
5. 提交后通知/取消外部请求；调用方网络结果未知时查询/重试原命令，不换新键重做。

真实纠正联调必须逐处注入失败并核验决定/状态/epoch/Job/Action/事件/回执的原子性；旧模型完成再检验版本守卫。A/B 的测试替身只证明逻辑，不替代 C3 的同一数据库事务验收。

### 8.2 候选接纳与教师纠正并发

B 输出候选不写 A 的状态头。候选信封至少含 jobId、courseId/studentId/attemptId、activityVersionId、expectedStateRevision、decisionEpoch、已确认输入引用、policy/模型/提示/分析版本、主张/反证/帮助/未知及 collectionPurpose。服务端从获准 Job 的 scope 校验这些字段，不相信模型回传的身份或 evidenceIds。

A 在一个短事务核验原 Job 的持久状态仍允许本次结果接纳（不是 cancelled/stale/failed，已完成结果只能按原结果去重），以及当前权限/状态/epoch、用途开关、原始引用存在/版本/范围和撤回约束，保留 B 的原始候选（C 分析记录）与接纳/拒绝原因，成功才追加有效状态 revision；失败不能将旧估计悄悄换上新 revision。被动分析须检查采集许可；即使采集恢复，已取消/过期 Job 的旧结果仍拒绝生效。B 的反馈草稿另保存为草稿/提案，不调用 CMD-23。模型正文、事实记录、正式教师决定分别读取，不共用一个“结论正文”覆盖字段。

纠正交易依 TECH 第 7.2 节：教师授权与状态 CAS → 追加决定 → 新投影/依赖主张 contested → C 同事务 epoch/Action/Job 失效 → 事件/成功回执 → 提交后通知/外部取消。撤回约束保留被否定的依据与适用范围，候选换 ID/措辞/分析版本也不能用相同依据恢复被撤回主张。

- 候选先提交：状态头增加，旧 expectedStateRevision 的教师表单 409；教师重读，不能静默覆盖。
- 教师先提交：旧候选在最终 CAS/epoch 守卫拒绝，可留分析历史，不能生效。
- 同时提交：只有一个当前头通过 CAS；任一步失败全体回滚。
- 已展示帮助：保留真实内容与回执，标注依据后来修订；未展示旧动作失效。浏览器在实际 UI 接入后仍须检验本地版本，不能以服务端通知宣称撤回已看到内容。

以上是并发验证预期，**未执行真实数据库联调**；B/C 信封、返回值与去重规则待会审。

### 8.3 失效类别与独立控制提案

失效操作由 C 提供，并加入触发业务的同一数据库事务；实际 provider/runner 取消和通知在提交后执行。失效范围不能简单写成“所有 Job”：教师纠正不应取消学生已授权的普通运行事实，关闭提醒也不能使正在等待的主动帮助失效。

| 触发 | 事务内范围/版本 | 要失效/取消的内容 | 保留/允许 |
| --- | --- | --- | --- |
| 教师纠正、确认争议处理改变有效依据 | 同课程同学生相关教学上下文；新状态 revision、相关 Attempt epoch | 未展示教学动作、依赖旧状态的分析/反馈草稿；保守整体失效，不建通用依赖图 | 原始作品/运行/已显示帮助保留；无关学生/课程不受影响 |
| 学生对当前有效主张提出异议 | 异议+新 contested 投影+相关 epoch | 依赖该依据的待投递动作/分析 | 保留原主张与异议；仅历史/反馈正文异议不伪造新能力主张 |
| 新主动求助取代旧求助 | 同 Attempt 新 epoch/新 help Job | 旧有效帮助/待投递内容；不再同时有两个有效帮助 Job | 已显示帮助保留；学生文件/运行不变 |
| CMD-16 停止指定教学 Job | 当前获准 jobId/用途；持久停止标记、Action 失效、事件/回执同事务；不增加通用 epoch | 未完成生成及该 Job 关联未展示动作；已完成生成也停止后续投递/重连补发 | 终结 Job/生成结果/已展示事实保留；不影响其他 Job、新主动求助或普通运行事实 |
| 分配暂停/恢复、个人尝试暂停/恢复 | 分配/尝试控制版本及受影响 epoch | 暂停时相关教学动作/分析、待运行；正在执行取消/归档按 C 处理；恢复不重放旧动作 | 保存已有草稿/读旧事实；个人 paused 不被教师恢复覆盖 |
| 进入/退出限定帮助检查 | 可信检查阶段、政策约束与新 epoch | 不符合检查政策的待投递辅导/提醒 | 只限制系统内帮助；不声称阻止外部帮助；既有运行/检查事实可追溯 |
| 关闭主动提醒 | 同 Attempt 控制版本，单独检查提醒许可；不增加通用教学 epoch | 仅待投递/生成的 reminder | 主动求助和被动分析依其各自规则继续；不重写历史帮助 |
| 暂停过程采集 | 同 Attempt 控制版本+覆盖区间；不增加通用教学 epoch | 新逐次过程采集和排队/进行中的被动分析；原 Job 持久标记 cancelled/stale，迟到分析检查原状态和开关 | 显式保存/求助/运行/提交的必要功能数据继续；不据此恢复自动候选提取/反馈草稿；人工复核继续，恢复不回填空窗或复活旧 Job |
| 自述/正式反馈改变相关辅导上下文 | 自述/反馈新版本，相关 Attempt epoch；不自动增加能力状态 revision | 依赖旧上下文的教学动作/分析 | 自述、正式评价、能力主张仍分层；学生主动作业事实不被改写 |

文件内容变化使用 snapshot/documentVersion 检查，不把每次编辑都当作能力状态或 epoch 更新。课程要求/政策变更通过新 ActivityVersion；如果必须停止旧活动先暂停分配，不能原地修改旧尝试规则。

投递/候选写入时在真实事务中重查原 Job/Action 的持久状态、相关版本、epoch、分配/个人阶段、政策与用途开关；不能仅在模型调用前检查。cancelled/stale/failed 状态不能因关闭后的开关恢复、通知失败或外部请求无法取消而回到可接纳/可投递；已接纳/已投递结果仅按原记录去重，不重复生效。expectedAttemptRevision 用于接纳命令的 CAS，最终输出守卫按用途检查相关状态/引用，不机械要求无关控制的整项 revision 不变（见第 16.4 节与 A0-R10）。已生成但未获准内容不能先出现在 SSE/Job 结果中。网络通知与教师纠正存在展示竞态，按 TECH_DESIGN 第 7.3 节由客户端再核验，并保留真实迟到事实，不宣称已发送内容可被“收回”。

CMD-16 对 help/reminder 等产生 TeachingAction 的 Job 使用持久停止标记，具体字段与返回格式待 C0 核对。已终结 Job 保留原状态和生成结果引用，停止标记与其关联未展示 Action 的 cancelled 状态、事件、命令回执同一事务提交；不能因 Job completed 就跳过停止。该标记还阻止迟到回调新建或投递该 Job 的教学动作，动作保存与最终投递须在事务内重查它。外部取消/通知失败不解除停止，重启、重连、同键重放也不重新投递；新主动求助使用另一 jobId，不受旧标记影响。客户端在本地停止后不展示该 Job 的迟到内容；其他页面或断线重连先同步停止状态。已展示帮助与迟到真实回执仍追加保留并标注停止竞态，不将缺展示回执认定为学生从未看见，也不承诺收回已看到内容。

## 9. 后台选型与目录责任评审稿

沿用 TECH 第 1～3/10 节的推荐组合：单进程 Node.js 受支持 LTS + TypeScript/Fastify，Zod 校验，better-sqlite3/SQLite 本地 WAL，HTTP/SSE 与 C 的 SQL Job/CommandReceipt。B 负责 AI SDK 与供应商适配；C 负责独立 Linux 执行边界。**本次不新增选型结论、精确依赖版本或安装结果**；这些机制/限制的一手资料入口已在 TECH 第 13 节保留，冻结前需复查实际支持版本、驱动内嵌 SQLite 修复版本及组合兼容性。

选型理由是业务与记录可在同一短事务提交、少量成员共享一个应用进程，避免为 A/B/C 各建服务/数据库/队列。一个并发写者、同步查询阻塞和事件循环延迟是实际限制；是否达 NFR 需实测。多实例写入或实测无法达标再提替代方案，不预建 Redis、向量库、通用工作流或微服务。

| 拟议位置 | 写入责任 | 跨模块约束 |
| --- | --- | --- |
| apps/teaching/package.json、锁文件、tsconfig、启动入口 | A 汇总，B/C 提依赖需求 | 选型/版本确认后创建；新增公共依赖先核对 |
| apps/teaching/contracts/common、access、design、review | A 维护对应定义，B/C 会审共享字段 | 不单方改公共 ID/版本/错误/事务语义 |
| apps/teaching/contracts/tutoring | B | 消费共同字段；候选格式交 A 采用与校验 |
| apps/teaching/contracts/workspace、records、runner | C | 提供 ObjectRef、Job/Receipt/Event 与同事务失效 |
| apps/teaching/server/app、access、design、review、db/transaction | A | A 维护连接/短事务入口；领域与记录写入同数据库 |
| apps/teaching/server/tutoring | B | 不直接写学生文件、TeacherDecision 或发布活动 |
| apps/teaching/server/workspace、records | C | 不重复实现 A 的学习状态/教师权限规则 |
| apps/teaching/runner | C | 独立执行节点；不挂应用数据库/私有答案/凭据 |
| 对应领域 tests | 各领域负责人 | A 权限/设计/纠正；B 语义/候选；C 同步/运行/恢复；跨域联调共同验证 |
| 团队 Web UI 既有工程 | UI 成员 | 最后实际接入；不预建 web 目录或重选框架 |

上述均为拟议代码位置，当前仓库没有这些目录/源码/启动或测试命令。最终“实际目录与共享文件责任”待 G0 会审记录，不将建议当作已经落地。数据库对象见第 2.1 节，约束见第 8.1 节；**不提供可执行建表/迁移脚本，不获得实际建表授权**。

## 10. D-03 账号、访问与数据管理提案

### 10.1 待冻结参数与受阻工作

提案沿用 PRD D-03 与 TECH 第 9/10 节“私有邀请制、最少数据、独立执行和一致性备份”方向。数值/人员范围以下均为建议或待定，不能当作试点同意、已批准安全方案或自动删除指令。A/C 准备，教学/技术负责人决定；B 核对模型数据范围，D-02 与 D-03 分开批准。

| 编号/参数 | 具体提案/待确认内容 | 准备/决定责任 | 未冻结时受阻工作 |
| --- | --- | --- | --- |
| A0-D01 试点参与者与课程关系 | 一位任课教师、有限指定学生；明确课程成员与试点授权，不采集无关身份资料；不重复收集 A/B/C 姓名作为开发前置 | A 整理参与范围；教学负责人确认 | 真实账号预置/真人试点；合成权限验证可准备 |
| A0-D02 账号建立与发放 | 首版推荐维护者预置受控账户，或既有受控邀请方式；无公开注册/SSO；凭据经批准通道分别发放，不进入仓库/聊天/导出 | A 提发放与初始验证/恢复方案；技术负责人选择 | 正式登录流程冻结与真实账户发放 |
| A0-D03 会话与登录策略 | 服务端随机 Session、HttpOnly/Secure/SameSite cookie、Origin/CSRF、成熟密码哈希/限流；会话绝对/空闲期限、失败窗口/上限、退出/改密撤销范围、密码恢复验证方式待定 | A；技术负责人确认 | 正式认证配置；不虚构现成组件或性能 |
| A0-D04 成员变更与账号停用 | 每次命令/读取/事件再核验；停用后禁止新访问/作业，取消受影响未完成作业，保留真实历史；不冒充学生学习操作 | A/C 核对取消与历史读取；技术/教学负责人确认 | 真实停用/权限变更操作；合成验证可准备 |
| A0-D05 网络与入口 | 同源 HTTPS 的私有试点入口；具体内网/VPN/有限外部可达及成员设备访问方式待决定，不默认匿名公网开放 | A/C 清点现有条件；技术负责人确认 | 正式部署/真人网络访问 |
| A0-D06 访问人员与用途 | 任课教师读取负责课程、学生读取本人；维护者健康/备份最小元数据，正文排障需限定对象/理由/时限/审批与审计；不赋予维护者正式评价权 | A；教学/技术负责人确认访问清单 | 真实资料访问、正文排障与导出权限发放 |
| A0-D07 告知与数据用途 | 说明过程记录/功能数据/提醒三个独立控制、模型范围、覆盖缺口、导出/异议/撤回/删除途径；实际 UI 入口由 UI 成员最终接入 | A 提业务说明，B/C 核对；教学负责人确认 | 真人采集与外部模型发送；不先采后告知 |
| A0-D08 保留与处置 | 分类保留期限待定；可沿用“试点结束后 90 天复核去留”的建议，绝非到期自动删除；明确何种引用撤回/脱敏、处理时限和备份到期路径 | A/C 提分类清单；教学/技术负责人确认 | 真人持久化试点；实际删除单独授权 |
| A0-D09 模型处理范围 | 仅当前学生/课程必要获准上下文，不含凭据/私有答案；供应商/区域/保留/训练使用/重试记录等由 B 的 D-02 提案核实，再与告知范围相对照 | B 核对，A/C 配合；产品/技术负责人确认 | 真实数据或付费调用；合成样例可准备 |
| A0-D10 应用与执行资源 | 一个本地持久磁盘应用节点、一个独立 Linux 节点/VM；节点规格/磁盘配额/内网认证/镜像与语言由 C 提证据；资源限额沿用 NFR-03，不擅自下调 | C 清点，A 核对控制面/存储；技术负责人确认 | C1 真实隔离验证/正式部署/真人运行 |
| A0-D11 备份与恢复 | 推荐教学会话前后做 SQLite 一致性备份；目标 RTO 30 分钟、RPO 最近成功备份均待确认；健康重启不丢已 ACK 事务；备份位置/访问/加密/保留/校验/恢复演练待 C 核对 | C 提方案和演练证据；A 核对课程权限与版本；技术负责人确认 | 真实试点恢复承诺；不得只复制活跃 db 漏 WAL |
| A0-D12 处理与支持责任 | 任课教师处理教学异议，A 负责业务授权/数据请求受理规则，C 负责备份/恢复及获授权处置执行，B 负责模型调用范围与故障记录；具体审批通道/处理时限待定 | A/C 整理，B 核对；教学/技术负责人确认 | 真人导出/撤回/删除、事故处置承诺 |

这些参数只阻塞其依赖操作。A0/B0/C0 文档、合成验证方案继续；G0 未确认实施方案前不据本文建立正式服务。也不能因 D-03 真人条件尚未具备而声称通用契约无法起草。

### 10.2 数据类别、投影与处理责任

| 数据类别 | 保存/读取责任 | 用途/导出边界 | 撤回/保留处置 |
| --- | --- | --- | --- |
| 账号、成员、Session、凭据 | A/access；维护者仅获批准账号管理 | Session token、密码哈希/salt、部署凭据不进入课程/个人导出、模型或日志 | 停用/撤销会话不改事实；账号与历史关联去标识方案待审批 |
| 教师材料/私有验证资产 | A/design 版本化；C 验证器只用指定资产 | 按 student/tutor/teacher-validator 投影；导出和引用下载同样过滤 | 删除/脱敏先识别固定活动引用，标缺口/停用影响，不静默换版本 |
| 学生作品、确认快照、提交/运行事实 | C/workspace/records；T 课程审阅，S 本人 | 功能数据即使采集暂停仍按必要范围保存；学生 stdout 不代表验证 | 固定提交可追溯；保留期限/备份周期待定；移除后引用不得伪造 |
| 消息/展示回执、观察、覆盖区间 | C/records 保存实际内容和来源 | 接收/展示/确认分层；无回执和空窗保持未知；S 仅本人可见部分 | 不把恢复后事件回填空窗；处理旧依据时保留真实帮助事实 |
| 模型候选/分析/反馈草稿 | B 产出，C 保存原始分析，A 保存接纳/有效投影 | 未采用反馈不发学生；教师审阅候选与事实分开；私有引用不借摘要泄漏 | 撤回不换 ID 恢复同一依据；保留 rejected/stale 原因，期限待定 |
| 自述、TeacherDecision、正式反馈 | A/review 追加版本；S 本人，T 所负责课程 | 原始引用、帮助/未知、判断版本及争议可追溯；不凭无依据赞同补观察 | 经授权移除证据后有效投影失效/标缺口，旧反馈标依据状态 |
| Job/Receipt/Event/Audit 与诊断元数据 | C 提公共记录；A/B 使用 | 日志只需 requestId/jobId/类型/时延/失败分类/配置版本；正文不默认进运维日志 | 业务幂等回执保留窗口与离线重试范围待 C0/G0 确认，过期不得盲目重做 |
| 备份与导出副本 | C 按获准范围执行；A 鉴权；维护者最小访问 | 导出是授权投影，备份不是任意教学读取入口；副本与原始实验证据分开 | 保留与删除范围必须包含副本；恢复后复核已批准撤回/脱敏决定，防止旧状态复活 |

D-03 处置流程提案：核验申请人/课程/目标和权限 → 列相关事实/候选/决定/导出/备份影响与不可用引用 → 教学/技术负责人决定并取得操作红线授权 → C 执行获准范围、A 使有效引用/投影同步失效 → 留最少处理审计与真实缺口 → 在隔离恢复演练中核验处置不会被旧备份反向恢复。首版不建设通用自助删除后台；本次不执行任何删除/脱敏或备份配置。

## 11. 验证方案与预期结果

以下全部为**计划用例，业务测试未执行**。准备隔离合成 fixture：T1 负责课程 C1，T2 负责 C2，S1/S2 为 C1 不同学生，S3 为 C2 学生，O 仅维护；活动 V1/V2、蓝图 revision 1/2、同名不同 fileId、确认快照 H1/H2，关联 Job/Action/Claim 与被撤回依据。不要创建真实账号/学生记录，不把 fixture 当成真实教学结果。

| 用例 | 操作/触发 | 预期与失败判据 | 对应/负责 |
| --- | --- | --- | --- |
| A0-T01 | S1 访问 S2 的 Attempt、快照、Job、events、export | 每条入口拒绝，无正文/存在性侧漏；ID 难猜不能成为防护 | NFR-04；A+C |
| A0-T02 | T1 审阅 C2、O 试写正式反馈、伪造 body role/studentId | 服务端会话/课程决定权限，越权无写入/回执/事件 | NFR-04；A |
| A0-T03 | S1/B tutor 请求 teacher audience、私有段落/判定答案 | 检索前/序列化/Job/SSE/导出同样裁剪；私有摘要也不泄漏 | AC-02/15；A+B+C |
| A0-T04 | 草稿 revision=2 使用 revision=1 PATCH/Proposal/Check 发布 | 409 或失效引用；新人工内容与旧固定活动不变 | AC-02/NFR-04；A |
| A0-T05 | 改材料/量规/政策后读取已开始 V1 | V1 原绑定不变；V2 只用于新显式分配/尝试 | AC-02/09；A+C |
| A0-T06 | 相同 K/D 重试及两个并发相同请求 | 原 ID/结果，仅一次副作用/事件；requestId 可不同；不因初次版本增加冲突 | AC-06/12/NFR-04；A+C |
| A0-T07 | 相同 K 不同 D，含不同 expectedRevision/正文/引用 | 409 无第二次写入；规范化不损正文/换行；秘密不进摘要 | AC-06/NFR-04；A+C |
| A0-T08 | 修改归属/撤销权限后重放原成功回执 | 当前读取权再检查，不因缓存泄漏旧结果 | NFR-04；A+C |
| A0-T09 | sync 同 seq 同内容与同 seq 异内容，断线恢复 | 去重/冲突正确，落盘才 ACK，双端草稿保留，不假装已同步 | AC-03/11/12；C+A |
| A0-T10 | ready GET 与首次合法帮助/运行/同步/提交 | GET 不激活；学生命令按会审后的阶段规则原子接纳；无强制开工表单 | AC-03/05；A+B+C |
| A0-T11 | 分配 paused、个人 paused、采集/提醒开关组合 | 前两者优先，已有草稿保存允许；独立开关不彼此恢复；submitted 不解锁 | AC-06/11；A+C |
| A0-T12 | 相同控制目标再次设值、关闭提醒但主动帮助运行中；完成生成后 CMD-16 停止，随后迟到动作/重连 | 不造多余 epoch/空窗；关闭提醒不取消主动帮助；指定 Job 停止与未展示动作失效原子保存，重放不重复副作用，已展示事实保留 | AC-05/06/NFR-04；A+B+C |
| A0-T13 | 采集关闭时帮助/运行/提交；关闭→恢复后旧被动分析迟到 | 功能数据保存；无新增过程/被动候选或反馈草稿；原 Job 已取消/过期仍拒绝；空窗不补，只接纳恢复后合法新 Job | AC-06/07/11；A+B+C |
| A0-T14 | 对当前 claim 提异议及对历史 claim/feedback 异议 | 当前有效依据 contested 并失效旧依赖；历史不覆盖新主张/反馈 | AC-07/08；A+B+C |
| A0-T15 | 两个旧教师表单、候选与教师纠正两种提交顺序 | CAS 仅一个新头；旧候选拒绝生效，旧教师表单重读；无丢失更新 | AC-08/NFR-04；A+B+C |
| A0-T16 | 在决定/投影/epoch/Action/Job/Event/Receipt 写入各处注入失败 | 同数据库全回滚，提交前无通知；单模块 mock 不算实际事务通过 | AC-08/NFR-04；A+C |
| A0-T17 | 纠正后旧模型完成、SSE 重连、迟到 displayed | 旧结果无效；已展示事实保留并标依据修订；不回滚新状态 | AC-06/08；A+B+C，UI 后验 |
| A0-T18 | 用同被撤回依据换 claimId/措辞/分析版本 | 不能复活主张；相关后续任务只读适用有效状态，缺迁移证据保持未知 | AC-08/09/16；A+B |
| A0-T19 | 教师允许修订、学生继续、重复许可消费与后续新任务 | 许可不代学生继续；CAS/消费一次；旧提交不变，新活动另建尝试 | AC-09/12；A+C |
| A0-T20 | 课程/个人导出、恢复备份、引用被批准撤回后的读取 | 授权投影且引用/帮助/未知/版本/覆盖完整；无凭据/私有答案；恢复不复活失效依据 | AC-12/NFR-04；A+C |

实际执行方式待正式工程/依赖及所需操作授权具备：A1 权限/事务 seam 用 Node 测试运行器，C2 实际 Receipt/Job/同步接入后验证去重，A4+C3 真实单数据库失败注入和竞态，B3 候选真实联调，A6 综合验证。浏览器回执/草稿/返回/键盘场景等待实际 UI 的最终接入；语义质量仍需课程审阅，结构检查不替代教学验收。当前没有 npm/test/typecheck 命令可运行，不编造命令或通过统计。

## 12. 会审差异、待决策项与阻塞范围

### 12.1 需要 B/C 或负责人裁决的差异

所有状态均为“待评审/待决定”，没有成员签认或已批准结论。A 负责汇总，B/C 在各自任务文档提交意见和例子；本记录不授权 Agent 给其他成员发消息或替他们签认。

| 编号 | 对应基线/差异与提案 | 需要的核对/决定 | 未解决时阻塞 |
| --- | --- | --- | --- |
| A0-R01 | MVP 第 4 节 ready 可帮助/运行，TECH 第 6.1 只写 active；提议首次合法学习命令同事务开始 | A/B/C 核对触发和 expectedAttemptRevision；负责人确认基线修订 | 首次帮助/运行/同步的真实接入 |
| A0-R02 | TECH 第 7.1 closed 缺 MVP 行为/命令；提议首版不增关闭操作，待明确技术枚举 | 负责人决定；C 核对状态保存 | Attempt 枚举最终冻结 |
| A0-R03 | 活动暂停使用与分配暂停的层次；新分配是否也受活动停用控制 | A/C 提具体控制/权限；负责人决定 | 活动停用/分配控制最终冻结 |
| A0-R04 | paused 保存“现有草稿”与 sync 新建/回收操作边界 | C0 明确 file create/recycle 与同步事务，A 核对权限 | 暂停期间文件管理行为 |
| A0-R05 | M-01 量规试评、TECH 8.1 教师样例运行尚无公共入口 | A 的 CMD-24 仅试评；C0 提样例执行 scope/快照/配置/错误 | 教师样例真实执行接口 |
| A0-R06 | M-07 正式反馈现有路由不足；CMD-23 提 kind/确切 feedbackId/提交引用/CAS | A/C/B 核对草稿/正式保存与 reviewed 同事务；负责人确认 | 正式反馈与阶段接入 |
| A0-R07 | C Receipt/Job/Event、幂等摘要、sync seq、回执保留/重启的实际返回值；终结 Job 与教学动作停止分离 | C0 给 Job/Action 关联、持久停止标记及同事务输入输出/并发与恢复样例；A/B 核对 | A1 最终幂等、A3/B1/C2 真实联调 |
| A0-R08 | 纠正/异议/上下文变化与 C epoch、按用途取消同一短事务 | C0/B0 提失效范围/失败类别/候选与消息守卫；A 汇总 | A4/C3/B3 真实纠正联调 |
| A0-R09 | 候选保存分工：B 输出，C 原始分析，A 接纳/投影/正式决定；撤回约束跨新候选 | B0 给完整信封/反证/帮助/未知样例，C0 给原始引用/持久化接缝 | 有效学习状态/分析最终冻结 |
| A0-R10 | 关闭采集/提醒不使主动帮助整体失效；被动分析迟到不得写新头 | B/C 核对 purpose/collection 守卫与取消分类；负责人确认细化 | 三种控制的消息/候选联调 |
| A0-R11 | 后台版本、物理目录、短事务/连接所有权、逻辑约束 | A/B/C 会审与总负责人确认具体首批实施；物理建表另行授权 | 正式工程创建/依赖安装/大规模实现 |
| A0-R12 | D-03 的账号/网络/正文访问/保留/资源/备份参数及处理责任 | A/C 准备，B 核对 D-02 数据范围，教学/技术负责人决定 | 真实账号/数据/部署/真人试点；通用文档可继续 |

### 12.2 五处交界的会审记录

| 交界 | 本稿输入 | 必须取得的实际记录 | 当前结论 |
| --- | --- | --- | --- |
| 身份与版本 | 第 2/3/4/5/7 节 | B0/C0 的可信身份/资源范围/ObjectRef/CAS 兼容意见和拒绝样例 | 待评审，无签认 |
| 作业、消息与取消 | 第 5/6/8.1/8.3 节 | C0 公共记录格式，B0 的 deadline/取消/过期；每个控制与用途一致 | 待评审，无签认 |
| 事实、候选与教师决定 | 第 2.1/8.2 节 | B0 候选信封、C0 引用/Audit/失效、A 纠正交易和撤回约束一致 | 待评审，无签认 |
| 运行与可信检查 | 第 3/4/5/9/10 节 | C0 教师样例/学生运行/就绪验证、私有资产投影与失败分类 | 待评审，无环境验收 |
| 恢复、覆盖与导出 | 第 6/7/10/11 节 | C0 ACK/结果未知/一致性备份/投影/空窗与实际恢复方案，A/B 数据用途一致 | 待评审，无演练 |

会审意见按“引用成员任务文档/PR → 指出确切差异与工程样例 → 本文修订记录 → 决定者/范围/时间 → 授权维护者同步基线”记录。意见未到达时保持待评审，不以“无反对”当同意。A0-R01～12 的关键冲突未解决不记 A0 已交付；不关闭 #2 或 #1。

## 13. 授权维护者的基线汇总请求

此表是明确的汇总请求，**本次未修改这些文件，均为待授权维护者汇总**。

| 目标文件/章节 | 建议汇总内容 | 前置条件 |
| --- | --- | --- |
| TECH_DESIGN 第 4 节 | 第 2 节公共字段/逻辑约束、证据/候选/决定保存归属 | 字段/候选/ObjectRef 与 B0/C0 一致；获写入授权 |
| TECH_DESIGN 第 5 节 | 第 3/5/6/7 节角色矩阵、24 命令及读取投影、失败/恢复 | 新增接口和版本/幂等会审通过；获写入授权 |
| TECH_DESIGN 第 6/7 节 | 第 4/8 节状态、采集/提醒独立性、纠正/候选/同事务入口 | A0-R01～10 相关决定与 B/C 意见解决；获写入授权 |
| TECH_DESIGN 第 2/3/9/10/12 节 | 第 9/10 节目录/选型责任和 D-03 决定 | 选型与相关 D 决定确认；获写入授权 |
| MVP_SPEC 第 10 节 | A0 评审稿代码位置为“无”；本文与 README 导航；实际文档验证；业务/浏览器/真人未执行；会审/基线汇总未完成 | 记录事实不表示 A0/G0 已通过；获写入授权 |
| TEAM_WORK_PLAN 的 G0/任务登记 | #2 草案已提交评审及实际 PR、差异/会审状态、依赖与受阻操作 | 负责人确认与规划写入授权；不改变职责或里程碑 |
| PRD/MVP_SPEC 业务基线 | 只有裁决涉及用户结果/权利/流程时才提具体修订；本稿不改产品范围 | 负责人明确决定与相应文件写入授权 |

## 14. 交付、验证事实与下一步

以下为 2026-10-08 的历史记录，发布授权及当前交付状态以第 21 节为准。

- 已完成：远程四个 Issue 的主责/正文核对，定位 A0 #2；最新基线与 Agent 写入规则核对；七项交付要求的评审稿、24 命令/19 组读取/授权与状态矩阵、D-03 12 参数、12 差异及 20 计划用例。
- 写入位置：本文件与 README 导航。没有正式应用源码、DDL、依赖或环境变更。
- 文档验证：PowerShell here-string 的 `node` 内联检查通过：10 份 Markdown、69 处仓库文件/锚点引用、24 个命令及对应 24 行幂等/恢复、19 组读取、12 项 D-03 参数、12 项差异和 20 个计划用例的编号/矩阵完整性通过；Git 差异与未跟踪文件白名单检查只包含本文和 README，受保护基线无差异；两份改动文件的行尾空白、冲突标记和个人目录依赖检查通过。`git diff --check` 通过。首次文档生成命令因脚本字符串中反引号解析失败，未写出文件；改为 JSON 序列化文字后生成成功。首次本地 Git 提交因未配置作者信息失败；后续提交使用本次命令的已登录 GitHub 账号 noreply 署名参数，不修改全局 Git 配置。
- 业务、类型检查、数据库并发/失败注入、模型、执行隔离、浏览器与真人验收：**未执行**；当前仓库没有相应正式工程命令。
- PR/会审：本地分支 codex/a0-contract-review 已准备；向公开仓库推送和创建文档 PR 待公开发布授权；B0/C0 意见未取得，负责人决定与基线写入授权未取得；**待授权维护者汇总**。
- 下一步：B0/C0 以第 12 节五处交界核对；A 汇总差异并修订本文，负责人分别确认契约/参数与基线写入范围；A0 完成条件全部满足后才关闭 Issue。G0 后的正式 A1～A6 不因本文完成自动启动。

### 14.1 文档 PR 说明草稿

拟议标题：docs: submit A0 business contract review proposal (#2)。关联使用 Related #2，不使用自动关闭关键字。

A0 #2 需要将教师/学生/维护者的权限、状态、版本、幂等与事务边界交给 B/C 会审。本次新增独立任务评审稿并补 README 导航，产品/规划/规范/参考文件保持基线；最新 AGENTS 优先于旧 Issue 中的直接基线写入要求。

评审重点为本稿第 2～8 节的授权/四类对象状态/24 命令及恢复/19 读取/候选接纳与纠正事务，第 9～10 节的选型目录与 D-03 参数，第 11～13 节的计划用例、12 差异、五处交界和基线汇总请求。A0-R01～12、A0-D01～12 全部待核对或决定；尤其 ready/active、closed、活动暂停、paused 文件管理、教师样例与正式反馈入口不得默认为冻结。

越权/私有资料拒绝，旧版本和同键异请求冲突，暂停优先，过时模型不能生效，纠正/失效/回执须同事务回滚；保留真实已展示帮助、旧提交、反证与覆盖缺口，不补造证据。文档检查通过；业务、模型、数据库、执行隔离、浏览器与真人验收未执行。B0/C0 会审、负责人决定及授权维护者汇总仍未完成，PR 不关闭 A0/G0。

## 15. 2026-10-09：先推进不依赖外部确认的准备工作

以下记录项目负责人暂停提交期间的准备范围；最新修复与合入授权见第 21 节。

本次继续依据 PRD/MVP/TECH 的现有范围完善 A0；只修改本文，不提交、推送或创建 PR。共享契约的提案仍待会审，未据其创建应用代码。AGENTS 要求“需要改变产品结果或共享契约的部分等待确认”，同时要求“无关的已授权工作继续推进”；待定项按依赖分别处理，不将 B/C 业务代码、模型、语言和 UI 全部当作 A1 的统一前置。

### 15.1 待定事项只影响对应工作

| 待定或未交付项 | 直接影响 | A 可以先推进的准备/后续边界 |
| --- | --- | --- |
| B0/C0 共享字段与事务会审 | 公共接口最终冻结、真实跨模块联调 | 权限/版本/失败预期、自检及合成请求响应样例；取得相应 A1 实施条件后可先交权限/事务基础，不等整套 B/C 代码 |
| 后台选型、实际目录与 A1 首批实施范围 | 按某栈创建正式工程、安装依赖和实现认证 | 按基线细化文件责任、测试接缝和进入条件；不自行选择未批准依赖 |
| D-01 课程/语言/检查规则 | 运行镜像、课程样例、检查配置与活动开放 | 通用课程归属、蓝图版本、角色投影和失败方案不依赖具体语言 |
| D-02 模型/预算/真实数据发送 | 付费调用与真实模型接入 | 合成模型输入/输出与候选失败样例；A1 认证/授权不依赖模型可用 |
| D-03 真人账号/网络/数据保留 | 真实账户发放、真人采集与试点部署 | 先拟合成账号权限场景与数据处理清单；正式认证策略相关参数须在其实现前确认 |
| 实际建表/迁移授权 | 物理 schema、数据库初始化操作 | 逻辑关联、CAS/唯一性、短事务与失败注入设计；授权后再做真实存储验证 |
| C1 独立执行就绪 | 学生运行、活动确认/开放 | 草稿起草/编辑和 Agent 建议准备继续；运行未就绪明确拒绝 |
| 实际 UI | 浏览器展示/回执/草稿/键盘与真人流程验收 | 已获授权的后台接口与服务端验证可先做；不重做界面 |

### 15.2 A 的首批实施范围提案

这是 A0 交给 G0 的具体 A1 范围提案，不是实施批准。建议将 A1 分成三个可独立核验的小批次：

| 批次 | 具体交付 | 必要进入条件 | 不依赖的交付 |
| --- | --- | --- | --- |
| A1-P1 工程与入口 | 锁定获批准的后端版本；应用入口、requestId、公共错误、健康状态、输入边界；启动/检查说明 | 选型/目录、这一批实施范围与工程规则确认 | 课程语言、付费模型、独立 runner、实际 UI、完整 B/C 代码 |
| A1-P2 真实会话与授权 | 采用获批准的账号/会话策略；登录/退出；课程成员与资源授权；Origin/CSRF/限流；统一读取投影入口 | P1、认证所需 D-03 参数、对应物理存储操作授权；按现有权限基线实现 | Agent 生成、学生执行环境、完整反馈/状态分析 |
| A1-P3 短事务与记录联调 | 事务入口、CAS、失败回滚；先交可信上下文与 tx 给 C2，C2 首批到位再接 Receipt/Job/Event | 数据结构/短事务接缝会审，物理操作授权；真实回执联调才等待 C2 首批 | C3 完整教学消息、C4 完整提交闭环、完整 B3 分析 |

P1 的健康状态不能把不存在的数据库、模型或执行器写成 ready；P2 的合成授权测试不替代真实会话；P3 的替身不替代同数据库原子性。各批验证结果单独登记，不将早期批次通过升级为 A1 或 G1 整体完成。

## 16. 合成接口与并发审阅样例

以下均为人工构造的文档样例，fx_ 前缀 ID 不指向真实记录；**没有实际 API 调用、数据库写入、模型请求或业务测试执行**。路径/字段按本提案解释，未获批准的新增语义保持待评审。展示内容/事件/决定仅描述预期，不能作为原始观察。

### 16.1 蓝图编辑成功、重放和冲突

前提：T1 是 fx_course_a 有效任课教师；fx_blueprint_a 属于该课程，当前 revision=2。身份由可信 Session 得到，不在正文声明 role/studentId。成功修改预期只增加一次 revision。

```json
{
  "method": "PATCH",
  "path": "/api/blueprints/fx_blueprint_a",
  "headers": {
    "Idempotency-Key": "fx_edit_001"
  },
  "body": {
    "expectedRevision": 2,
    "patch": {
      "title": "合成工程项目"
    }
  }
}
```

预期成功 HTTP 200；versions 为待评审的响应形状示例，业务结果与版本均绑定这次命令：

```json
{
  "requestId": "fx_request_001",
  "commandId": "fx_command_001",
  "replayed": false,
  "data": {
    "blueprintId": "fx_blueprint_a"
  },
  "versions": {
    "revision": 3
  }
}
```

| 样例 | 后续输入/条件 | 预期/核对重点 |
| --- | --- | --- |
| A0-E01 首次编辑 | 上述 K/D，初始 revision=2 | 业务/版本/成功回执/事件一次提交；版本成为 3 |
| A0-E02 响应丢失后重试 | 同账号、scope、key 与合法正文，expectedRevision 仍是 2 | 重查当前读取权后返回原 commandId/data/revision=3，replayed=true、requestId 为新值；不再 CAS 新状态或追加事件 |
| A0-E03 同键不同内容 | 同 key，title 改为另一值或 expectedRevision 改为 3 | HTTP 409 IDEMPOTENCY_CONFLICT，无新增写入 |
| A0-E04 新命令使用旧版本 | 新 key，expectedRevision=2，当前已是 3 | HTTP 409 VERSION_CONFLICT，保留未采用文本；只能在获准读取下重读 |
| A0-E05 重放时权限已撤销 | 原成功 K/D，但已非有效课程教师 | HTTP 403，不因缓存返回旧正文/结果；失败无新的业务副作用 |

同键异摘要的错误样例：

```json
{
  "requestId": "fx_request_003",
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "同一幂等键已用于不同请求。",
    "retryable": false
  }
}
```

客户端不能因错误自行换 key 自动重复提交；确有新的人工操作，重新核对版本后才发新命令。

### 16.2 私有资料与本人范围拒绝

前提：S1/S2 是 fx_course_a 不同学生；S1 获分配的活动不开放 teacher-validator 资料。

```json
{
  "requestId": "fx_request_006",
  "error": {
    "code": "FORBIDDEN",
    "message": "当前请求无权读取该资源。",
    "retryable": false
  }
}
```

| 样例 | 输入/条件 | 预期/核对重点 |
| --- | --- | --- |
| A0-E06 私有答案 | S1 在资源读取或模型工具参数填写 audience=teacher | 无任何提权；检索/投影前拒绝，不在错误中回传答案/路径/存在性 |
| A0-E07 他人对象 | S1 通过 S2 的 attemptId/snapshotId/jobId 或 events/exports URL 读取 | 每类入口都核验本人/课程，不用 URL、游标或 UUID 难猜作为授权 |

### 16.3 教师纠正与候选写入的两种顺序

合成前提：同课程同学生当前 learnerStateRevision=5，相关 Attempt decisionEpoch=12；B 候选和教师表单都引用这个状态，候选输入快照/原始引用可核验。

| 样例 | 顺序/失败触发 | 预期/核对重点 |
| --- | --- | --- |
| A0-E08 教师先提交 | 教师纠正提交后状态 6、epoch 13；旧候选到达 | 最终状态 CAS/epoch 守卫拒绝旧候选生效；C 可保留分析与拒绝原因，不能改写状态头 |
| A0-E09 候选先提交 | 候选合法接纳后状态 6；旧教师表单仍 expectedStateRevision=5 | 教师命令 409 VERSION_CONFLICT，无 TeacherDecision/失效半笔；教师重读后决定 |
| A0-E10 纠正中途失败 | 决定已写入事务，之后投影/epoch/Action/Job/Event/Receipt 任一写失败 | 整体回滚到原状态 5/epoch 12；无部分失效、无成功回执、无提交前通知 |
| A0-E11 外部取消失败 | 数据库纠正已整体提交，provider 取消通知失败 | 业务决定不回滚；重试外部取消/通知，旧输出仍由持久化版本守卫拒绝；不重做纠正 |
| A0-E12 已展示内容迟到回执 | 教师纠正前实际已展示，displayed 回执纠正后才到达 | 保存真实迟到事实并标依据修订；不抹去帮助，也不回滚状态 6/epoch 13 |

这是并发预期审阅，尚未证明事务实际可组合。C0 必须给出同数据库 tx 输入/返回/失败类别，B0 必须给出最终候选/教学输出守卫；真实失败注入留待 A4+C3。

### 16.4 独立开关与修订许可

| 样例 | 操作/条件 | 预期/核对重点 |
| --- | --- | --- |
| A0-E13 关闭提醒 | active 的 S1 关闭 reminder，正在等主动 help；再次开启后旧 reminder 结果迟到 | 只取消 reminder；控制 revision 可变，通用 epoch 不变，主动帮助继续按自身对象/政策守卫；原 reminder Job/Action 已取消/过期，不因重开再次投递 |
| A0-E14 关闭采集 | active 的 S1 暂停采集后显式帮助/运行/提交；恢复采集后旧被动分析迟到 | 功能数据照常；原 Job 的持久取消/过期状态仍拒绝旧候选；不保留逐次时间线或回填空窗；恢复后的合法新 Job 可接纳 |
| A0-E15 重开 | reviewed，T1 许可最新 submission，之后 S1 主动 resume_revision | 教师许可时仍 reviewed；学生命令 CAS/消费许可后 active；旧 Submission 保留，重复消费不得重开第二次 |

自检发现的待会审细化：attemptRevision 同时覆盖生命周期和独立控制，**投递守卫若机械要求整项 attemptRevision 永远不变，会使关闭提醒间接取消主动帮助**，违反 MVP M-04 的独立控制。提案为 expectedAttemptRevision 用于接纳新学生命令的 CAS，已接纳输出按用途检查当前阶段、相关许可/政策、epoch 和对象/状态引用；与当前用途无关的控制 revision 改变不等同于该输出过期。B/C 需选择具体可检验实现并确保 A0-E13；此条并入 A0-R10，未据此修改共享基线或写代码。

### 16.5 完成生成后停止的并发预期

前提：S1 的 help Job 已 completed，关联 Action 已生成但尚未展示。S1 发送 CMD-16；事务保留 completed/生成内容，保存该 Job 的停止标记，将关联未展示 Action 标 cancelled，并一次提交事件和成功回执。之后迟到生成回调、待投递事件或重连补取都不能创建/展示该 Job 的新帮助；客户端本地停止立即阻止其迟到展示。

同键重试返回原停止结果，不增加事件或通用 epoch；事务任一步失败整体回滚并报告未提交；提交后外部取消/通知失败只重试通知，不重做停止。若展示先发生，或其真实 displayed 回执迟到，保留内容和事实并标停止竞态，不回滚新状态或恢复投递。学生再次主动求助使用新 Job，正常接纳；普通运行结果不因该教学停止被改写。这是 A0-T12 的补充预期，真实数据库与浏览器验证未执行，须由 B/C 核对。

## 17. 本次独立核对与进展

以下为暂停提交期间的验证事实，最新修复与合入授权见第 21 节。

- 日期：2026-10-09。继续了无需其他成员先交代码的工作：拆分待定项的实际阻塞范围、A1-P1～P3 首批范围提案、15 个合成接口/竞态样例和 4 段可解析 JSON。
- 自检结果：补充 A0-R10 的 attemptRevision/独立控制守卫歧义；未将任何差异写成已解决或已批准。B/C 会审、G0 相关决定、基线汇总仍未完成。
- 文档验证：Node 内联文档检查通过（10 份 Markdown、69 处仓库文件/锚点引用，原命令/恢复/读取/参数/差异/计划用例编号与矩阵检查通过）；追加检查通过（15 个唯一 A0-E 样例、4 段 JSON.parse 可解析 JSON、3 个 A1 批次；相对 HEAD 仅当前任务文档有未暂存改动）。git diff --check 通过。追加检查首轮因工具编排字符串中的代码块分隔符解析错误未执行，修正转义后重跑通过。第 14 节的 2026-10-08 验证记录保持其日期/范围。
- 应用源码、数据库/模型/执行器/浏览器与真人业务验证：未执行。
- Git：只维护当前 A0 任务文档；按暂停提交要求不执行 add/commit/push/PR，既有本地提交与原工作区改动保持原状。

## 18. A 方可独立完成项的验收映射与交接包

### 18.1 计划用例与基线编号逐项映射

本表补足第 11 节缩写引用的含义。每行仅指出该计划用例将验证的相关部分，不表示整个 M/AC/NFR 已通过；跨学生权限主要来自 M-10/NFR-04，AC-15 专指限定帮助/可信验证与私有命令，不把它当作所有权限行为的替代编号。

| 映射 | 计划用例 | 能力编号 | 验收/非功能编号 | 执行依赖与范围 |
| --- | --- | --- | --- | --- |
| TRACE-01 | A0-T01 | M-10 | NFR-04 | A1+C2 真实身份/资源入口；跨学生所有读取路径 |
| TRACE-02 | A0-T02 | M-10 | NFR-04 | A1 真实 Session/课程成员；维护者与教师判断隔离 |
| TRACE-03 | A0-T03 | M-02, M-10 | AC-02, AC-15, NFR-04 | A2 投影+B2+C3；私有资产与非获准用途，课程检查接 C1 |
| TRACE-04 | A0-T04 | M-01, M-02 | AC-01, AC-02, NFR-04 | A2/A3 实际 revision 与采用/确认；人工内容不覆盖 |
| TRACE-05 | A0-T05 | M-02, M-09 | AC-02, AC-09 | A2+C2 固定活动/新分配版本 |
| TRACE-06 | A0-T06 | M-09, M-10 | AC-06, AC-12, NFR-04 | A1+C2 真实唯一约束/回执与事务；非 mock |
| TRACE-07 | A0-T07 | M-09, M-10 | AC-06, NFR-04 | A1+C2 规范化输入摘要；不包含认证秘密 |
| TRACE-08 | A0-T08 | M-10 | NFR-04 | A1+C2 重放时当前权限；不以缓存授权 |
| TRACE-09 | A0-T09 | M-03, M-05, M-09 | AC-03, AC-11, AC-12, NFR-01, NFR-05 | C2 持久同步/冲突；本地草稿/刷新与可辨状态待实际 UI |
| TRACE-10 | A0-T10 | M-03, M-04 | AC-03, AC-04, AC-05 | A1+C2+B2；A0-R01 决定后的首次学习命令/对象版本 |
| TRACE-11 | A0-T11 | M-02, M-04, M-05 | AC-06, AC-11 | A2+C2/C3；A0-R03/R04 暂停覆盖与保存范围 |
| TRACE-12 | A0-T12 | M-04, M-05 | AC-05, AC-06, NFR-04 | B2+C3；A0-R10 的独立控制与输出守卫 |
| TRACE-13 | A0-T13 | M-04, M-05, M-06 | AC-07, AC-11 | B3+C3；采集用途/迟到分析拒绝与真实覆盖 |
| TRACE-14 | A0-T14 | M-06, M-08 | AC-07, AC-08 | A4+B3+C3；当前/历史异议与有效投影 |
| TRACE-15 | A0-T15 | M-06, M-08 | AC-08, NFR-04 | A4+B3+C3；真实同一状态头 CAS 与并发 |
| TRACE-16 | A0-T16 | M-06, M-08 | AC-08, NFR-04 | A4+C3；同数据库各写入点失败注入/原子提交 |
| TRACE-17 | A0-T17 | M-04, M-05, M-08 | AC-04, AC-06, AC-08 | B2/B3+C3；客户端过时对象/展示竞态待实际 UI |
| TRACE-18 | A0-T18 | M-06, M-09 | AC-09, AC-16 | A4/A5+B2/B3；scope/撤回依据；教学语义另需审阅 |
| TRACE-19 | A0-T19 | M-07, M-08, M-09 | AC-09, AC-12 | A5+C4；A0-R06 与重开许可消费，不改旧提交 |
| TRACE-20 | A0-T20 | M-09, M-10 | AC-12, NFR-04 | A1+C5；实际导出/备份/恢复；资源授权与处置条件另落实 |

AC-10/NFR-03 的执行隔离仍归 C1 主责；AC-13/14 真人流程不在这 20 个计划用例内。性能与成本 NFR-02/06 需要实际请求/负载/用量记录，本次静态检查不能覆盖。NFR-01/05 在 TRACE-09 仅涉及保存/恢复部分，性能和浏览器可用性仍未执行。

### 18.2 给 B/C 的明确核对问题

以下是评审材料，未发送给其他成员、未替其签认。每个回复应给出“接受/建议修改/当前无法支持”、对应任务文档或 PR、请求/返回示例、拒绝/失败分类、是否参与同一 tx、替身/真实验证边界；避免只回复“支持接口”。

| 问题 | 对应差异 | 核对方 | A 已给出的提案与需要返回的内容 |
| --- | --- | --- | --- |
| HANDOFF-01 | A0-R01 | B/C | ready 的首次帮助/运行/保存接纳在同事务开始；返回阶段、revision 和 Job/文件确认的顺序与失败回滚例子 |
| HANDOFF-02 | A0-R02 | C，负责人裁决 | 列出 closed 是否已有首版必要行为；无上游依据时不新增操作；提供状态持久化/恢复影响 |
| HANDOFF-03 | A0-R03 | C，负责人裁决 | 活动停用与分配暂停、新分配的权限关系；提供覆盖范围和并发控制例子 |
| HANDOFF-04 | A0-R04 | C | paused 现有草稿保存与新建/回收分别如何拒绝/允许，file 生命周期/seq/ACK 的事务范围 |
| HANDOFF-05 | A0-R05 | C | 教师样例执行的专用 scope、快照/配置、验证资产投影与错误；不借学生 Attempt 冒充学生运行 |
| HANDOFF-06 | A0-R06 | B/C | feedback 草稿与正式保存分开，明确 feedbackId、kind、最新提交与 reviewed 同事务；B 草稿引用格式 |
| HANDOFF-07 | A0-R07 | C | Receipt/Job/Event 的真实输入/返回、同键并发、恢复/回执保留窗口、sync seq 与 HTTP 幂等组合；completed Job 关联未展示 Action 的停止标记/事务/重连返回 |
| HANDOFF-08 | A0-R08 | B/C | 当前 tx 的失效函数、epoch/用途类别/失败返回，提交后通知与外部取消；教师先/候选先及完成生成后停止样例，迟到动作不复活 |
| HANDOFF-09 | A0-R09 | B/C | 候选信封与原始引用/反证/帮助/未知，接纳/拒绝保存，撤回依据如何避免换 ID 后复活 |
| HANDOFF-10 | A0-R10 | B/C | 提醒/采集独立取消，已接纳帮助的相关版本守卫；确保 A0-E13 不因无关 attemptRevision 增加而误过期 |
| HANDOFF-11 | A0-R11 | B/C，负责人决定 | 核对第 9 节目录责任与短事务入口，列具体公共依赖需求/组合限制；不代负责人冻结版本或实施 |
| HANDOFF-12 | A0-R12 | C/B，教学/技术负责人决定 | C 返回资源/一致性备份/恢复与处置责任，B 返回 D-02 数据范围；标明确无法落实参数与受阻操作 |

### 18.3 独立完成与实际等待的分界

| 编号 | 本次可独立交付 | 完成证据/当前状态 |
| --- | --- | --- |
| A0-I01 | 依据与权限边界核对 | 第 1 节与最新 AGENTS；远程基线 8a0e332 保持一致，未改受保护文件 |
| A0-I02 | 权限、ID、版本与状态评审提案 | 第 2～4/7 节；角色矩阵与四类对象/暂停规则已起草，未宣称正式契约 |
| A0-I03 | 逐命令及恢复提案 | 第 5/6 节，24 个命令、24 行摘要/失败/恢复和 19 组读取 |
| A0-I04 | 逻辑结构、事务与保存归属提案 | 第 2.1/8/9 节；包含短事务、候选与决定并发、失效分类，未建表 |
| A0-I05 | D-03 可核对参数清单 | 第 10 节，12 项具体提案/处理责任/受阻工作；参数未决定 |
| A0-I06 | 合成验证样例与验收映射 | 第 11/16/18.1 节，20 个计划用例、15 个文档场景、4 段 JSON、20 行明确编号映射 |
| A0-I07 | 可重复运行的文档验证 | [检查脚本](../../tools/a0-review/check.mjs)；只读仓库文档，检查引用/矩阵/编号/JSON/映射与旧接口覆盖，不调用业务服务 |
| A0-I08 | B/C 交接问题与 G0 首批范围 | 第 12/13/15.2/18.2 节，12 个具体核对问题、基线汇总请求和 A1 三批提案 |

以上八项是 A 方准备产物；A0.4 的实际跨成员确认、G0 参数决定、基线汇总、业务验证和 A0 整体出口仍未完成，不写成“所有目标已完成”。剩余外部依赖明确为：B0/C0 实际评审意见与格式示例、负责人相关决定/实施授权、授权维护者的基线汇总。收到这些材料后逐项收敛，不要求 B/C 先完成整套业务代码。

## 19. 可重复运行的检查与本次交付记录

以下记录检查工具交付时的验证事实，最新修复与合入授权见第 21 节。

本次可写范围增加仅用于 A0 评审的 tools/a0-review/check.mjs、本文及 README 验证入口；产品/规划/规范/参考文件仍只读。工具使用 Node 标准库，不安装依赖、选定正式后端版本或实现共享业务接口。

从仓库根目录运行：

```powershell
node tools/a0-review/check.mjs
git diff --check
```

脚本输出文档和样例检查结果，失败退出码为 1。它核验正文中定义的编号/结构及引用，不执行权限拒绝、CAS、幂等副作用、同数据库回滚、模型帮助或 UI 流程，因此不能把静态通过数计入 M/AC/NFR 的业务通过数。

- 实际验证：node --check tools/a0-review/check.mjs 语法检查通过；node tools/a0-review/check.mjs 文档检查通过（10 份 Markdown、71 处仓库内部文件/锚点引用、24 命令/24 恢复/19 读取、12 参数/12 差异、20 计划用例/15 合成场景/4 JSON、20 映射/12 交接问题/8 独立产物/3 首批范围）。原 TECH 第 5 节 22 个变更接口均覆盖，新增 feedback/rubric-trials 两条已登记为提案。
- 检查器反例验证：node --input-type=module 的内存覆盖检查通过，6/6 个错误样例正确报告失败：缺文件、重复命令、非法 JSON、未知验收编号、漏旧接口、错交接关联。没有写回反例文件，没有执行业务测试。
- 失败记录：脚本首轮只从表格读取 M/AC/NFR 编号，将标题定义的 M-01～10 误报未知；修正为按基线实际定义位置读取后通过。反例工具编排首轮因字符串分隔符解析失败未执行，修正后 6/6 通过。
- 本次同步：README 补文档验证命令，任务文档补执行事实与独立完成/等待边界。git diff --check 通过；写入白名单通过，范围仅 README、本文和检查脚本；受保护文件与基线无差异，新脚本行尾空白检查通过。没有暂存，HEAD 仍为 afd999e。工具实测运行环境为 Node.js v24.15.0，此记录不冻结正式后台版本。
- 未执行：正式应用类型检查、服务端/数据库/模型/运行隔离/浏览器/真人验收。
- 状态：A 方可独立准备产物已整理；共享提案待评审，A0/G0 未验收，待授权维护者汇总。
- Git：按要求不执行暂存、提交、推送或 PR；保留原工作区改动和既有本地提交。

## 20. 2026-10-09：提交前复审与授权记录

项目负责人于 2026-10-09 指示“那你在仔细审查一下a0，确认无误后可以提交pr”。当时授权范围为复审后提交、推送及创建文档 PR，取代第 14/15/17/19 节所记历史暂停提交/等待发布授权状态；当时不包含合并 PR、关闭 Issue、冻结共享契约、修改受保护基线或实施应用。后续修复与合入授权及当前状态见第 21 节。

固定比较基线为 8a0e3325eaa456e903bd31532ce2a5eef8d8736a。按 code-review 工作流分别审查仓库规范和 Issue #2/产品规格，范围含相对基线的 README、本文和只读检查工具完整候选改动。

### 20.1 Standards：仓库规范

- 初审共 1 项，最高 P2，属于硬性规范问题；无可操作的判断性代码异味。
- CMD-15 的允许状态曾引用不存在的“第 7.1.1/7.5 节”，团队无法从本文或当前 TECH 基线查证。依据 AGENTS 的独立查阅和交付引用核对要求，已改为本文第 4.2/4.3/8.3 节并列明各操作状态。
- 其余审查结果：未改受保护基线；提案、会审待定和业务测试“未执行”标记准确。工具只读、使用 Node 标准库，没有外部服务、个人路径或凭据依赖。第 1 节统一当前可写范围，历史记录保留日期及当时事实。
- 修订后独立复核：原 P2 已解决，未发现新增规范缺陷或可操作代码异味，Standards 剩余可操作发现为 0。

### 20.2 Spec：Issue 与产品规格

- 初审共 2 项，最高 P2。
- CMD-15 状态依据引用不存在章节，不能满足 Issue #2 每个命令列明允许状态的要求；已修正引用并补明 start/pause/resume/resume_revision 和采集/提醒设值状态。
- 原稿最终校验未明确原 Job/Action 的持久取消/过期状态。采集关闭后恢复、旧供应商请求随后完成时，当前开关与 epoch 可能再次符合；按 MVP M-04/M-05，必须拒绝被取消旧输出而不能复活。已在第 8.2/8.3 节补最终守卫，A0-T13 与 A0-E13/E14 补关闭→恢复→旧结果迟到及新合法作业的区分。
- 其余七项起草交付已覆盖；选型、状态差异、B/C 格式和 D-03 参数准确保留待评审，不作为缺陷。上述修正是评审提案，仍需实际 B/C 契约会审；业务实现及业务验证未执行。
- 修订后独立复核：两项 P2 均已解决，未发现新增缺陷，Spec 剩余可操作发现为 0；可提交供 B/C 会审的文档 PR。

### 20.3 本次验证与交付边界

- 修正后实际执行：node --check tools/a0-review/check.mjs、node tools/a0-review/check.mjs、git diff --check 均通过。文档检查为 10 份 Markdown、71 处内部引用；24 命令/24 恢复/19 读取、12 参数/12 差异、20 计划用例/15 文档场景/4 JSON、20 映射/12 交接问题/8 独立产物/3 首批范围；22 个基线变更接口及 2 个已标为提案的新增接口覆盖通过。
- 6 个内存反例均正确拒绝，未写回反例文件。检查器首次实现的误报已在第 19 节如实记录。本次 apply_patch 修订尝试因上下文定位失败未写入；改为逐项唯一匹配后完成修订并通过检查。
- 本次记录的是规范/规格自查与静态验证，不是三方会审或服务端业务通过。数据库、权限业务、并发、模型、执行隔离、浏览器及真人验收均未执行。
- 草稿 PR 用于 B/C 和负责人审阅，关联 #2，不自动关闭 #2/#1。受保护文件的基线汇总仍交获授权维护者；不提交原工作区旧草案。A0-R01～12、A0-D01～12 和实际会审记录仍待收敛，A0 未通过、G0 未冻结。
- 发布路径：当前 GitHub 账号 czr112 对上游仓库只有读取权，直接推送失败（403）；该次创建 PR 也因远程分支不存在失败。已创建 [个人 fork](https://github.com/czr112/XunJie)，使用 fork 分支向原仓库提交草稿 PR，保持原 origin 和项目基线不变。首次 fork 命令的参数组合不受本机 gh 支持，修正参数后创建成功；这些是发布操作失败，不计作业务验证失败或通过。
- 实际交付：[草稿 PR #5](https://github.com/paher-din/XunJie/pull/5) 已创建并核验为 OPEN/Draft，目标 main，来源 czr112:codex/a0-contract-review；文件范围为本文、README 和只读检查脚本。GitHub 曾将说明中的否定关闭措辞识别为关闭关联，已改为明确保持 Issue 开放并核验 closingIssuesReferences 为空，#2 仍 OPEN。原工作区旧改动保持原状。

### 20.4 上游权限恢复与分支同步

2026-10-09 追加核验：czr112 已取得 paher-din/XunJie 的 push 权限；git push -u origin codex/a0-contract-review 成功，上游同名分支已建立并设置为本地跟踪分支。第 20.3 节的 403 和 fork 路径为当时事实，保留历史记录。继续使用草稿 PR #5（来源仍为个人 fork），后续当前任务提交同步到上游和该 fork 分支，不重复建立 PR；同一提案的权限恢复不表示 A0 会审通过、基线写入获授权或 Issue 可以关闭。

## 21. 2026-10-09：PR #5 审查修复与合入范围

项目负责人授权修复本次审查问题、复验后合并既有 PR #5。本次仍只交付设计评审稿和只读文档检查工具；合并不表示 A0/G0 会审通过、共享契约冻结、产品验收或应用实施获准。产品、规划、参考及 AGENTS 基线保持只读，待授权维护者汇总。

修复依据为 MVP M-04/AC-05、TECH 第 7.3 节，以及 AGENTS 的仓库路径和明确项目角色记录要求。可写范围为本文、README、tools/a0-review/check.mjs 及新增的 tools/a0-review/check.test.mjs；没有应用调用方、数据库或配置变更。

修复方案：CMD-16 停止生成完成但未展示的关联教学动作，保留终结 Job 与已展示事实；停止标记、Action 失效、事件与命令回执同事务保存，提交后通知，最终守卫拒绝迟到输出。路径先解码再检查绝对路径和仓库边界，增加纯内存回归测试；授权记录改用明确项目角色。B/C 仍需核对 Job/Action 关联、停止标记、事务返回和客户端展示竞态，不由本次合并代替签认。

修复交付：CMD-16、第 8.1/8.3 节、A0-T12、第 16.5 节与 HANDOFF-07/08 已同步停止语义和并发预期；授权记录使用明确项目角色。检查器在解码后执行路径边界检查；[路径回归测试](../../tools/a0-review/check.test.mjs) 与 README 验证入口已交付，不安装依赖或调用业务服务。

实际验证：新增测试修复前为 5/7，通过修复后为 7/7；原失败项为编码的仓库内绝对路径和编码 file URL。node --check tools/a0-review/check.mjs、node --check tools/a0-review/check.test.mjs、node --test tools/a0-review/check.test.mjs、node tools/a0-review/check.mjs 和 git diff --check 均通过。文档检查为 10 份 Markdown、72 处内部链接，原命令/读取/编号/JSON/映射/路由结构检查通过；这些结果不计入业务验收。

当前状态：本次三个审查问题已修正并完成上述静态验证，准备按项目负责人授权更新及合并 PR #5。其余 A0-R01～12、D-03 参数、B/C 签认与基线汇总仍待处理；业务、数据库、模型、执行隔离、浏览器和真人验收未执行，A0 未通过、G0 未冻结。第 20 节的独立自查零问题结论仅为当时记录，不能替代本次修复或三方会审。
