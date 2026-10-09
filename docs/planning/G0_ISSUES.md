# G0 Issue 跟踪

发布日期：2026-10-08（Asia/Shanghai）。当前：2026-10-09 项目负责人已统一批准 G0 并授权五份基线同步；准备门禁在文档验证/发布后完成，不代表应用或任何 AC/NFR 已验收。下方发布正文保留历史，当前执行依据见最新裁决。

目标仓库：[paher-din/XunJie](https://github.com/paher-din/XunJie)。

| 任务 | 主责 | Issue |
| --- | --- | --- |
| G0 | 项目总负责人 | [#1](https://github.com/paher-din/XunJie/issues/1) |
| A0 | A | [#2](https://github.com/paher-din/XunJie/issues/2) |
| B0 | B | [#3](https://github.com/paher-din/XunJie/issues/3) |
| C0 | C | [#4](https://github.com/paher-din/XunJie/issues/4) |

## 2026-10-09 负责人统一裁决

项目负责人明确“批准这些剩余提案作为负责人统一裁决，并授权同步 PRD、MVP_SPEC、TECH_DESIGN、TEAM_WORK_PLAN、G0_ISSUES”。批准来源为 [G0 收敛记录](../tasks/G0_CLOSURE_PROPOSAL.md#10-2026-10-09-负责人统一裁决及基线同步)，实际决定者为负责人，不记为 A/B/C 各自签认。

| G0 完成项 | 当前依据 |
| --- | --- |
| A0/B0/C0 交付与统一契约 | PR #5/#8/#6 已合入；静态核对及 G0-C01～15 由负责人裁决，正式正文在 TECH 第 2～12 节。#2/#3/#4 的作者交付/关闭记录仍由各主责维护 |
| 教学与 UI 范围 | C 程序设计/C、函数/数组/指针先备、Web 中 Core→反馈→Report、TS-P01～06、三能力线/帮助及素材范围已同步 PRD/MVP；UI 采用成员交付，最后接入 |
| 模型、数据与依赖条件 | DeepSeek/deepseek-flash、非思考/16K/4096/3 次/45 秒、精确后台版本、目录/同 tx/资源与数据门禁已同步 TECH；金额/投入/日期不登记 |
| 具体实施方案 | A1-P1/B1/C2 首批范围和进入条件获批准，编码前建对应任务稿；真实 SQL/账号/凭据/付费/真实数据/节点操作及生产发布另授权 |
| 未具备条件 | 教师/A 在活动开放前准备蓝图/获准段落；B 在真实验证前核 API/账号/条款/数据与配额；C1 在资源/配置获准后锁 GCC/digest 并跑隔离；A1/C5 落实真实存储与恢复；最后 UI/真人验收。正式条件与主责见 TECH §12/TEAM §4.1 |

G0 #1 的关闭只确认范围/契约/进入条件准备完成；本次没有编码、装依赖、调用模型、创建环境或执行学生程序，G1～G4 与业务/浏览器/真人验收保持未执行。历史正文中的未定/待评审状态以本段较新的负责人裁决为准，原验证事实和操作红线不改写。

## 2026-10-09 当前调整

项目负责人已取消 A/B/C 实际投入时间和首批交付日期的强制登记要求，并授权同步 PRD、MVP_SPEC、TECH_DESIGN、TEAM_WORK_PLAN、本文件和 GitHub G0 正文；交付采用直接推送 main。当前 D-04 为：沿用 TEAM 的职责、任务依赖、阶段交付与验收主责，不登记投入时间或首批交付日期。其余 G0 退出项继续有效，G0 保持开放。

取消要求的授权与执行结果见 [G0 任务记录](../tasks/G0_SCOPE_CONTRACT_GATE_REVIEW.md#10-2026-10-09-授权与直接交付记录)。下方是 2026-10-08 发布时正文的历史快照，其中原 D-04 的日期要求已被本段决定取代，不再作为执行要求；教学里程碑及原验证事实保留。

以下保存发布时的任务正文，实时任务进度以 GitHub Issue 为准。正式业务契约仍以 [TECH_DESIGN](../product/TECH_DESIGN.md) 为准，完成条件以 [MVP_SPEC](../product/MVP_SPEC.md) 和 [TEAM_WORK_PLAN](TEAM_WORK_PLAN.md) 为准。Issue 关闭要有交付 PR、评审结论和对应记录，不改变 G0～G4 门禁。

## [G0] 范围冻结、契约会审与实施门禁

负责人：项目总负责人；A 汇总契约与首批实施方案，B/C 提供对应提案。

### 目标与依据

完成 G0 范围和契约评审，形成可执行的首批实施方案。依据 [PRD 第 9 节](https://github.com/paher-din/XunJie/blob/main/docs/product/PRD.md)、[MVP_SPEC 第 8 节](https://github.com/paher-din/XunJie/blob/main/docs/product/MVP_SPEC.md)、[TECH_DESIGN](https://github.com/paher-din/XunJie/blob/main/docs/product/TECH_DESIGN.md)、[TEAM_WORK_PLAN 第 4 节](https://github.com/paher-din/XunJie/blob/main/docs/planning/TEAM_WORK_PLAN.md) 和 [AGENTS](https://github.com/paher-din/XunJie/blob/main/AGENTS.md)。

### 执行任务

- [ ] [[A0] 业务权限与公共契约评审](https://github.com/paher-din/XunJie/issues/2)
- [ ] [[B0] 模型、帮助与学习分析契约评审](https://github.com/paher-din/XunJie/issues/3)
- [ ] [[C0] 工作区、记录与执行契约评审](https://github.com/paher-din/XunJie/issues/4)

### 共同决策与完成条件

- [ ] 完成三份产品文档的团队评审，决定与分歧有仓库记录。
- [ ] D-01：课程负责人确认课程、先备、唯一语言、主项目及后续任务、三条能力线目标、路线空间、帮助政策和课程检查规则。
- [ ] D-02：B 提交模型、数据处理范围、实际价格、总预算与配额方案，由产品/技术负责人形成决定；真实数据和付费调用前落实相关条件。
- [ ] D-03：A/C 提交账号、访问网络/人员、保留与处理责任、应用/独立执行资源、备份与恢复方案；真人试点前落实数据条件，执行隔离验收前不开放真人运行。
- [ ] A0/B0/C0 会审通过：身份/对象版本、作业/消息/取消、事实/候选/教师决定、运行/可信检查、恢复/覆盖/导出五处交界无未处理冲突，契约正文统一在 TECH_DESIGN。
- [ ] 冻结后台选型、实际目录、共享文件责任与跨模块事务入口；未具备的条件明确责任角色、触发时点和受阻任务。
- [ ] D-04：按任务依赖和实际投入登记首批交付日期与里程碑，验收主责沿用 TEAM_WORK_PLAN。
- [ ] UI 业务接入范围沿用 MVP_SPEC 第 2 节；实际 UI 最终接入，不提前重做界面或更换前端框架。
- [ ] 项目总负责人审阅并确认具体大规模实施方案；实际建表/迁移、凭据或 CI/CD 修改、删除和公开发布按 AGENTS 单独授权。
- [ ] 决定、会审结论、进入实施的条件及未完成项同步项目文档和 MVP_SPEC 第 10 节。

### 推进顺序

A0/B0/C0 并行准备。课程/语言优先收敛；模型预算提案、账号数据与资源核查同时推进。某项待定只阻塞依赖它的工作，不用占位结果代替决定或环境就绪。

### 关闭依据

关联三项任务的交付 PR、跨模块会审结论、范围/参数决定与首批实施批准记录。G0 完成只表示准备门禁通过，不表示 G1～G4 或任何业务/浏览器验收已通过。

## [A0] 业务权限与公共契约评审

负责人：A。

### 目标与依据

把现有业务基线整理为 B/C 可共同使用的权限、状态与命令契约。依据 [TEAM_WORK_PLAN 的 A0](https://github.com/paher-din/XunJie/blob/main/docs/planning/TEAM_WORK_PLAN.md)、[PRD 第 5/8/9 节](https://github.com/paher-din/XunJie/blob/main/docs/product/PRD.md)、[MVP_SPEC 第 2/4/8 节](https://github.com/paher-din/XunJie/blob/main/docs/product/MVP_SPEC.md)、[TECH_DESIGN 第 4/5/7/9 节](https://github.com/paher-din/XunJie/blob/main/docs/product/TECH_DESIGN.md)。

### 交付与完成条件

- [ ] 教师/学生/维护者的角色和资源授权矩阵，覆盖课程成员、自己的尝试、材料可见性、导出与事件/模型读取。
- [ ] 蓝图、不可变活动版本、分配和尝试状态表，明确允许命令及暂停优先级。
- [ ] 每个业务命令注明发起角色、归属范围、允许状态、公共 ID/对象引用、预期版本、幂等摘要、错误与恢复方式。
- [ ] 后台选型、实际目录/共享文件责任及数据库/短事务接口评审稿；数据库结构仅作设计，实际建表/迁移另行授权。
- [ ] D-03 账号、访问与数据管理提案，与 C 核对执行资源、备份与处理责任；列出待冻结参数及对应受阻工作。
- [ ] B 的候选保存、C 的作业/失效能力能在既定事务边界接入；原始事实、模型候选和教师判断的保存归属一致。
- [ ] 与 B/C 核对身份、版本、幂等、引用与纠正事务；差异已解决或明确列为待决策，未解决关键冲突不能记为已交付。

### 依赖与验证要求

可以按基线立即起草，不等待 B/C 代码；最终契约会审吸收 B0/C0。权限来自服务端会话与课程归属，不能信任请求体 role/studentId。准备跨学生/课程访问、私有资料、旧 revision、重复/冲突请求和纠正并发的验证方案，对应 AC-02/06/08/15 与 NFR-04；G0 阶段未执行的业务测试如实标记未执行。

### 提交与会审

通过文档 PR 提交契约补充，并更新 MVP_SPEC 第 10 节的进展、验证和未完成项。PR 说明对应任务、修改章节、待决策参数、拒绝/失败边界及验证方式；共享契约由 A 汇总，避免并行改写同一含义。评审意见解决后关联 PR 和会审结论，满足完成条件再关闭 Issue。

关联：[[G0] 范围冻结、契约会审与实施门禁](https://github.com/paher-din/XunJie/issues/1)。本任务为 G0 设计与评审，不自动授权大规模实现或红线操作。

## [B0] 模型、帮助与学习分析契约评审

负责人：B。

### 目标与依据

明确教师生成、学生辅导和候选分析各自可读、可产出和可保存的内容，提供模型/数据/预算提案。依据 [TEAM_WORK_PLAN 的 B0](https://github.com/paher-din/XunJie/blob/main/docs/planning/TEAM_WORK_PLAN.md)、[MVP_SPEC 的 M-01/04/06/07](https://github.com/paher-din/XunJie/blob/main/docs/product/MVP_SPEC.md)、[TECH_DESIGN 第 6 节](https://github.com/paher-din/XunJie/blob/main/docs/product/TECH_DESIGN.md)、[三条能力线与证据边界](https://github.com/paher-din/XunJie/blob/main/docs/reference/PRODUCT_RESEARCH.md)。

### 交付与完成条件

- [ ] 教师生成、学生辅导、候选分析三类输入输出结构；每类输入明确课程/角色/版本可见范围，每类输出明确校验与保存归属。
- [ ] 引用、支持/反证、帮助条件、未知和分析版本契约；模型候选不能补造原始观察或成为正式评价。
- [ ] 修复、取消、超时、过期和成本记录契约，单轮最多 3 次模型调用、含排队总等待最多 45 秒，未知用量不记为零。
- [ ] D-02 模型与数据预算提案：主模型/供应商、结构化输出与引用能力、帮助边界、延迟/失败、实际价格与数据条款来源、总预算/配额和降级方式；区分推荐与批准。
- [ ] 合成工程样例与预期边界：空历史、相关/无关/撤回历史、缺消息/覆盖空窗、环境失败、资料指令注入、整份答案请求、限定帮助、取消和超时。样例不进入真实学生记录。
- [ ] 与 A/C 核对获准读取、ObjectRef/快照、事件引用、作业/消息及候选状态保存；无历史时仍可求助，模型不能修改学生作品、运行代码、发布活动或作正式评价。

### 依赖与验证要求

与 A0/C0 并行起草，最终上下文与引用共同会审。D-02 未确认前只准备合成样例，不发送真实数据或付费调用。明确 AC-01/05/07/16 与 NFR-02/06 的后续验证方式；模型语义审阅与结构检查分别记录，不以关键词或模型自评代替真人课程审阅。

### 提交与会审

通过文档 PR 提交契约补充，并更新 MVP_SPEC 第 10 节的进展、验证和未完成项。PR 说明对应任务、修改章节、待决策参数、拒绝/失败边界及验证方式；共享契约由 A 汇总，避免并行改写同一含义。评审意见解决后关联 PR 和会审结论，满足完成条件再关闭 Issue。

关联：[[G0] 范围冻结、契约会审与实施门禁](https://github.com/paher-din/XunJie/issues/1)。本任务为 G0 设计与评审，不自动授权大规模实现或红线操作。

## [C0] 工作区、记录与执行契约评审

负责人：C。

### 目标与依据

明确作品确认、对象引用、作业记录、独立执行和恢复的接口及验证边界，供 A/B 接入。依据 [TEAM_WORK_PLAN 的 C0](https://github.com/paher-din/XunJie/blob/main/docs/planning/TEAM_WORK_PLAN.md)、[MVP_SPEC 的 M-03/05/07/09/10](https://github.com/paher-din/XunJie/blob/main/docs/product/MVP_SPEC.md)、[TECH_DESIGN 第 4.1/7/8/10 节](https://github.com/paher-din/XunJie/blob/main/docs/product/TECH_DESIGN.md)、[工程衔接说明](https://github.com/paher-din/XunJie/blob/main/docs/reference/ENGINEERING_HANDOFF.md)。

### 交付与完成条件

- [ ] Attempt/文件/不可变多文件快照/ObjectRef 契约；运行和提交绑定确认快照，路径与范围只在相应实例/版本内解释。
- [ ] 同步 ACK、clientSeq/基版本去重、冲突、新建/回收与同名重建约定；落盘后才 ACK，冲突不覆盖本机草稿或服务器版本。
- [ ] 公共 Job/CommandReceipt/事件、动作/展示回执与覆盖区间契约；重试不重复业务动作，缺回执保持未知，采集空窗不回填。
- [ ] 供教师纠正事务调用的 epoch/旧动作失效接口；与 A 核对同数据库事务调用，与 B 核对取消/替换/过期输出行为。
- [ ] 独立 Linux 节点/VM、固定镜像/命令和控制面资源需求清单；首发语言与检查规则未定时列参数缺口，不冻结运行配置。
- [ ] 运行与可信检查接口及失败分类；程序退出码、stdout、环境 smoke、课程检查和正式评价分别表达，私有验证资产不进入学生容器或辅导上下文。
- [ ] AC-10/15 与 NFR-03 的真实隔离/限额验证方案：网络/路径/挂载隔离、非 root、资源/进程/输出限制、编译/运行超时和整个作业单元取消；不能以启动容器宣称验收通过。
- [ ] 断线/重启、结果未知、迟到回执、导出角色裁剪、一致性备份与恢复目标约定；明确 D-03 资源/备份责任及验证依赖。
- [ ] 与 A/B 核对权限、快照、引用、消息和原始事实保存；后续 AC-03/04/06/08/11/12 与 NFR-01/05 验证方式有据可查，浏览器部分等待最终实际 UI。

### 依赖与验证要求

通用契约与 A0/B0 并行准备。课程负责人确认语言/课程检查规则后才能冻结运行配置；独立执行环境未验收前不开放真人运行，不回退到应用宿主执行。G0 交付是接口与验证方案，实际运行/安全/恢复验收未执行时明确标记。

### 提交与会审

通过文档 PR 提交契约补充，并更新 MVP_SPEC 第 10 节的进展、验证和未完成项。PR 说明对应任务、修改章节、待决策参数、拒绝/失败边界及验证方式；共享契约由 A 汇总，避免并行改写同一含义。评审意见解决后关联 PR 和会审结论，满足完成条件再关闭 Issue。

关联：[[G0] 范围冻结、契约会审与实施门禁](https://github.com/paher-din/XunJie/issues/1)。本任务为 G0 设计与评审，不自动授权大规模实现或红线操作。
