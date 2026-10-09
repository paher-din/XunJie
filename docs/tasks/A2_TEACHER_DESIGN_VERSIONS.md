# A2：教师资料、蓝图、活动版本与分配

主责：A。任务：[Issue #13](https://github.com/paher-din/XunJie/issues/13)；协调：[G1 #9](https://github.com/paher-din/XunJie/issues/9)；上游：[A1 #10](https://github.com/paher-din/XunJie/issues/10)，合作：[C2 #14](https://github.com/paher-din/XunJie/issues/14)，活动开放条件：[C1 #12](https://github.com/paher-din/XunJie/issues/12)。建立日期：2026-10-10（Asia/Shanghai）。开始代码基线：9221370。

状态：**S1 独立确定性核心已实现，17/17 独立测试与类型检查通过；完整回归 45/45 通过，双轴审查进行中。S2/S3 未实现，正式业务与产品验收未执行。** §1～6 保留批准前的方案/状态，最新批准与实际进度见 §7/8。 项目负责人要求继续推进；依赖已有基线提出下述可提前实施批次，不将发起任务解释为批准新共享字段或数据库对象。A1 的独立合成库批准仅适用于其五表，不延伸到 A2。本文提出接口/验证边界确认事项，不修改产品基线。

## 1. 已读依据、负责文件与进入条件

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)、[PRD](../product/PRD.md) §3/4.1/5/8/9、[MVP_SPEC](../product/MVP_SPEC.md) M-01/M-02 与 AC-01/02、[TECH_DESIGN](../product/TECH_DESIGN.md) §4/4.4/5/5.1/7.1/9/10/12、[TEAM](../planning/TEAM_WORK_PLAN.md) §1/5 A1/A2/C1/C2，Issue #13 正文与 [A1 实际记录](A1_FOUNDATION_ACCESS_TRANSACTION.md#9-2026-10-10-独立合成验证批次)。正式依据为 v0.3，作者提案仅作参考。

TEAM 明确“契约开发可提前；真实权限接 A1”，先交材料/草稿/编辑/投影，后交确认/分配/暂停。同一 A 成员顺序推进：A1 当前独立批次已收口，转入 A2 可独立部分；A1 真实接缝继续跟踪，不宣称 A1 已完成。

拟写范围：apps/teaching/server/design、contracts/design 与对应测试、README、本任务稿。复用 A1 的校验/错误，新增共享依赖由 A1 管理。本首批不新增依赖、不建 UI、不动 B/C 领域、受保护基线、.env/密钥/CI、不发模型/runner 请求、不创建或迁移数据库。若后续实际存储必需，另列准确对象、范围与风险后提请批准。

## 2. 分批实施和完成判据

| 批次 | 本批实际结果 | 依赖与限制 |
| --- | --- | --- |
| S1 材料与草稿确定性核心 | UTF-8 TXT/Markdown/粘贴正文准备、固定内容/段落引用结构；手工/复制草稿、字段修改与 revision 冲突；目标/任务/观察/量规关系检查，三类检查与三种投影 | 可用隔离合成输入开发；本文字段提案/验证接缝先确认。此时无真实保存 ACK/账号接口，不接替身后声称业务落库 |
| S2 真实接口与存储 | 既定资源/蓝图创建、PATCH/checks、角色裁剪读接口接入 A1；资源归属、请求幂等、回执/事件/业务内容同事务；向 A3/B2 交真实读取 | A1 的正式授权/事务和 C2 所需首批记录接口；A2 实际 schema 操作另授权；读路径/字段由共同接口确认 |
| S3 确认与分配/控制 | 冻结完整 ActivityVersion、成员范围分配、活动/分配暂停与恢复；向 C2 提供分配/可用性读取与同事务失效接口 | 确认开放需 C1 真实 runtimeProfile 就绪、教师实际内容确认；控制/失效需 C2。无就绪证据则明确拒绝开放 |

AI 生成和采用交 A3/B1，不在 S1 建模型入口。草稿允许少量输入与缺项，不要求完整运行机器配置才能创建。检查可以报告运行未就绪；它不阻止保存草稿，也不能被跳过用于开放活动。

## 3. S1 数据和函数边界提案（待确认）

本节是拟用于独立确定性核心的类型/函数接缝，不是已冻结 HTTP JSON/schema，不是建表语句。共同接口批准与受保护文档写入授权分开；确认后才在负责目录实施。所有 ID 是服务端分配/校验的引用，纯逻辑接收的是已经授权的输入，不从 body 中 role/studentId 获得身份。

### 3.1 材料准备

`prepareMaterial` 接收格式（txt/markdown/paste）、标题、原正文以及服务端课程已占字节数，返回保留原正文的 UTF-8 字节数、SHA-256 内容摘要和段落正文/摘要/位置。上传解码失败拒绝，正文不 trim、改换行或归一化；不读取路径、抓 URL、解析 PDF、渲染/执行 Markdown。段落只形成引用边界，不解释其中指令或提升权限。

建议空行分段，Markdown 标题保留原文；段落序号仅版本内有意义，持久 paragraphId/resourceVersionId 由 S2 分配，修改正文形成新版本。正文级原 hash 与段落 hash 分别保存，不拿段落拼接后的 hash 冒充原文件。建议采用 TECH §9 的单文件 256 KiB、课程总正文 2 MiB；这两个实施上限与具体段落策略本批一并提请确认，当前未执行上传/总量查询。

拟用可见性字段 `visibility: { student: boolean, tutor: boolean }`，教师/验证器读取另经教师/用途鉴权；默认两个 false，私有答案/验证资产不能设置这两项 true。资料角色开放需要明确教师选择；teacher_design 的获准使用单独查询授权，不因 tutor=false 自动推断不能供教师设计使用。此结构待共同字段确认，不单方取代 B/C 的既定表示。

### 3.2 可编辑蓝图

拟用 `BlueprintDraft` 包含 courseId/blueprintId/revision 与 content；create manual/copy 生成 revision=1，copy 保留来源引用但使用新草稿身份。content 的首批字段建议：真实问题/受众、预期产物、允许路线、学生基础/时间约束、goals/tasks/observations/rubricCriteria、里程碑、材料引用、帮助政策、检查/运行版本引用。草稿字段可缺失；正式开放条件由 checks/release 守卫区分。

关系建议：goals 保存 competencyId/competencyVersion/domain（domain/project/ai_collaboration）与教师目标文字；tasks、observations、rubricCriteria 各有稳定 ID，关联使用目标的确切 ID/版本集合。任务/目标/观察为多对多，每个核心目标至少一种可观察表现；不能仅写 covered=true。新目标语义不复用旧版本；具体完整 content DTO 在实施前依本提案细化并与所需 B/C 消费字段核对，未确认字段不写共享 contracts。

`createDraft` / `editDraft` 接收可信当前内容与 expectedRevision，PATCH 只改明确提供字段，保留未修改的人工内容；新编辑仅在 expectedRevision 等于当前 revision 时成功，成功修改 revision+1，旧版本拒绝。S2 已成功同键同摘要请求先返回原结果，再对新请求执行 CAS，不能用前进版本拒绝合法重放。拒绝未知字段/权限与固定身份字段变更。旧 AI 提案不由核心自动采用；实际采用仍经正式 PATCH/CAS，S1 不实现生成。

独立核心产物保留原对象、无共享可变引用；复制/编辑不能改写原草稿/活动版本。返回新内容只证明计算成功，S2 的同事务落库成功后才允许实际 HTTP 保存 ACK。

### 3.3 三类检查

`checkDraft` 返回绑定 blueprintId/revision 的 `blocking`、`designConcerns`、`unverified` 三组，检查项指向具体字段/目标/引用，不输出自动评分/掌握率。

- blocking：开放所需字段、确切引用/权限、核心目标观察安排、规则版本和真实 runtimeProfile 就绪；缺项可继续编辑草稿，确认开放拒绝。
- designConcerns：任务意义、难度/时间/方案空间和量规歧义作为教师待处理判断；不以词数、关键词或模型猜测自动判定教学质量。
- unverified：学习效果/工作量估计及缺少实际验证的条件，明确 unknown；不因结构通过改成效果已证实。

S1 没有 C1 的实际就绪输入，运行项保持未验证/开放阻断。合成用例中的已登记 true/false 只验证守卫分支，不作为真实环境证据。具体教学疑点由教师输入/处理记录表达；默认不会捏造“教师已认可”。

### 3.4 角色投影

`projectDraftPreview` 仅用于已鉴权教师预览，audience=student/tutor/teacher-validator 不改变发起者权限。student/tutor 使用白名单组装所需教学内容与可见资料，不序列化后再靠删几个私有字段补救；私有材料正文、答案、验证器逻辑及其敏感元数据不进入载荷。正文/不可见引用按 unavailable/redacted 表达，不通过 hash 或摘要补正文。

学生/辅导的实际读入口必须等待 S2：核课程/固定活动版本/分配/用途；S1 投影不是让学生读教师草稿的 API。teacher-validator 预览不是自动授予模型或维护者读取全部教师资产的权限。

## 4. 拟确认的验证接缝与用例

建议以以上纯逻辑公开函数和后续实际 HTTP/同事务存储为验证接缝；S1 只使用合成内容，无学生操作或真实教学判断。实现前确认本节接缝；逐个用例实现/验证，失败如实记录。

| 接缝 | 预期结果 | 当前状态 |
| --- | --- | --- |
| 材料准备 | TXT/Markdown/paste 可用；非法 UTF-8/不支持格式/字节超限拒绝；中文、CRLF/BOM/末尾空白原字节语义保留；相同正文 hash 稳定；段落引用不跨版本误用 | 未执行 |
| 草稿创建/编辑 | 少量输入可建 revision=1；指定字段修改保留其他人工内容；旧 revision 冲突；copy 新身份且源对象不变；固定身份/未知字段拒绝 | 未执行 |
| 关联/检查 | 核心目标无观察、越权/失效引用、缺规则/未就绪不能开放；缺项仍能保存草稿；结构通过不删除教学疑点/效果未知 | 未执行 |
| 三类投影 | student/tutor 无私有正文/答案/验证资产/敏感摘要；教师预览不通过 audience 提权；输出改写不影响源内容 | 未执行 |
| S2 授权/事务 | 未登录、跨课程/非任课教师/伪造身份拒绝；同键重放/异摘要/旧 revision/并发与失败回滚；真实保存后 ACK | 未执行，等 A1/C2/S2 授权 |
| S3 版本/控制 | 无真实运行就绪不开放；固定内容不可原地修改；分配限成员；暂停优先且同 tx 失效，恢复不投递旧动作 | 未执行，等 C1/C2/教师内容确认 |

S1 工程通过仅对应 AC-01/02 确定性部分的预验证，不能记整个 AC、正式接口、浏览器或真人验收通过。没有确认/分配/暂停真实链时不关闭 A2。

## 5. 需要确认的准确首批范围

提请确认 **S1 独立合成确定性核心**：本节材料限额/段落策略、内部字段与角色投影原则、§4 的测试接缝；不注册真实业务 HTTP、不执行 SQL、不新增依赖、不改受保护文档。先交 material/draft/checks/projection 与测试，字段只在获确认范围形成内部类型；需要成为 B/C/UI 公共 DTO 时完成对应核对，不把确认 S1 当最终接口已会审。

当前需要负责人作出的决定是本首批具体方案/验证边界是否采用，不重复申请已批准的 A1 操作。A2 实际表、正式凭据/入口、C1 环境与开放活动仍另按相应进入条件执行。

## 6. 本次实际进度与后续

已执行：读取规格与远程 Issue #13（Open、无评论）、核任务依赖、建立本文与 README 导航，隔离到 codex/a2-draft-core（基于 A1 本地已审查代码）。A2 源码、业务/权限/运行测试全部未执行；A1 的 28/28 不计为 A2 通过。未创建 schema、临时库、HTTP 业务入口或发放账号，未推送/创建 PR。

静态检查已执行并通过：24 份文档、218 处仓库引用、27 条正式变更接口覆盖；git diff --check 通过。结构检查不证明提案语义已获确认或 A2 已实现。README 仅同步任务导航，本任务稿待首批确认，当前未提交。

下一步：确认 §5 的 S1 具体提案与 §4 接缝后实施纯核心、typecheck/独立用例、全套验证、任务记录与审查；并列出 S2 与 A1/C2 的准确接缝供共同核对。产品进度汇总留给获授权维护者，不直接更新 MVP_SPEC/TECH/TEAM。

## 7. 2026-10-10 S1 实施批准与内部细化

项目负责人在 §5 的具体方案/测试边界提请后明确指示“开始”，批准 S1 独立合成确定性核心：材料 256 KiB/课程 2 MiB、空行段落策略、§3 的内部字段/投影原则和 §4 纯函数测试接缝。历史待确认/未执行保留为当时记录；不扩展到 SQL、真实登录入口、公开发布或受保护文档写入。

本次使用 implement/tdd：以 prepareMaterial、createDraft/editDraft/copyDraft、checkDraft、projectDraftPreview 为已确认接缝逐片验证。固定审查基线 9221370；不安装 issue-tracker/另改 skills 配置。A1 已批准合成回归仍可执行，S1 自身不建库。

内部具体形状（仅 server/design 内，不放入跨成员公共 contracts）：材料 kind=learning_material/private_answer/validation_asset，后二者 visibility 两项必须 false；段落 ordinal 一基、start/end 零基 UTF-16 半开区间，正文保留 BOM/CRLF/Unicode/尾空白。材料包装含 courseId/resourceVersionId/available/teacherDesignAllowed；这些是可信调用方已授权查询结果，纯核心不查询 DB/任意 URL。课程总量亦来自可信存储统计，S1 只验证有界计算，不宣称并发配额已原子落库。

蓝图 content 细化为 projectTitle/problem/audience/artifact/routes/studentBackground/timeConstraints、goals/tasks/observations/rubricCriteria/milestones/resources、helpPolicyVersionId/checkRuleVersionId/runtimeProfileVersionId。目标用 competencyId/正整数 competencyVersion/domain/title/core；目标引用固定 ID+version，任务与观察/量规通过其各自稳定 ID 集合关联。关系缺口留 checks，少量输入可建草稿；同 ID/同目标版本的 title/domain 语义变更拒绝，教师须显式增版本。PATCH 未给字段不填默认值，未知/固定身份/权限字段拒绝，不覆盖其他人工字段。

检查上下文是可信资料目录、帮助/规则版本目录、运行就绪登记和教师疑点输入；报告项只用内部 code/path 与需要教师处理或 unknown 状态，不新增 HTTP 错误码。无实际运行登记时开放阻断；测试中的 ready 仅验证纯守卫，不是 C1 证据。教师预览接服务端持有的 authorizeTeacher(courseId) 调用边界，测试其拒绝传播；这不是 request.body.role、真实 Session 或认证替身验收。非教师不能靠 audience 提权。预览白名单不带私有资产/检查器配置/教师疑点；不可见资料只返 redacted/unavailable 状态，不泄露私有 ID、标题、hash 或正文。

状态：S1 核心已实现，最终回归与审查中。A2 S2/S3、正式公共 DTO 核对、A1/C2 同事务接入、C1/教师内容与 UI 验收仍待后续；本节不改变关闭条件。



## 8. S1 实际实现与验证记录

已实现的内部确定性核心（无 HTTP 注册/存储）：[材料准备](../../apps/teaching/server/design/material.ts)、[蓝图内部模型](../../apps/teaching/server/design/model.ts)、[创建/编辑/复制](../../apps/teaching/server/design/draft.ts)、[三类检查](../../apps/teaching/server/design/checks.ts)、[角色预览](../../apps/teaching/server/design/projection.ts)。没有新增依赖、共享 contracts、A2 SQL、生产凭据、UI 或 B/C 源码；默认 main/ready 行为不变。

材料默认不向学生/辅导开放，私有答案与验证资产不能公开。UTF-8 正文与版本内段落保留原文和独立摘要；课程已有总量由可信调用方传入，未验证真实并发配额。蓝图缺项可编辑，字段修改保持其他人工内容，旧 revision 拒绝；目标同 ID/版本的语义不能静默替换，复制保持来源且新对象独立。规则检查拒绝空白路线、旧/缺失目标引用、目标—任务—观察—量规连接不一致、重复/失效/跨课程资源及缺失政策/运行登记。合成结构通过不表示已经可以正式开放。

教师疑点来自明确输入与处理记录，不自动推断教学质量；学习效果/工作量估计始终 unknown。教师预览通过服务端持有的授权回调拒绝非授权课程；预览 audience 不授予身份。student/tutor 用途可见性独立，私有资源只返回无敏感元数据的 redacted；失效/缺失/重复目录引用只返回 unavailable。白名单保留所需教学内容，排除资源原始引用、检查/运行配置和来源私有上下文；正文保持纯文本，实际 UI 转义与真实读取授权待 S2/界面接入。返回嵌套内容与段落均不共享可变引用。

### 8.1 已执行验证

在 apps/teaching 使用已批准 Node 24.21.0/npm 11.19.0：
- `node --test tests/design-material.test.ts tests/design-draft.test.ts tests/design-checks.test.ts tests/design-projection.test.ts`：**17/17 通过**（材料 4、草稿 4、检查 5、投影 4）。
- `npm run typecheck`：**通过**。
- `npm test`：**45/45 通过**（A1 回归 28 + A2 17）；pretest 的 build **通过**。A1 临时合成库回归沿用已有独立批准，A2 测试本身只计算合成对象，不创建数据库。
- 仓库根目录 `node tools/a0-review/check.mjs`：**通过**（24 份文档/225 处仓库引用/27 条正式变更接口）；`node --test tools/a0-review/check.test.mjs`：**16/16 通过**；`git diff --check`：末尾空行已规范，提交前复核通过。静态检查的 businessTests=NOT_EXECUTED 是该脚本不执行业务测试，不替代上方 A2 独立用例结果。

按已确认接缝先验证失败再修复：CRLF 单换行曾被分隔正则回溯误认空行，修正分隔条件；存在的引用仍可能不对应同一目标，补齐连接检查；仅含空白的路线曾通过数组非空检查，补字段非空检查。预览模块未实现时测试因缺模块失败，完成白名单与授权边界后通过。失败事实保留，不把修复前运行记为通过。

### 8.2 未执行与交接

**S2/S3、正式接口和产品验收未执行，A2 不关闭。** 无真实登录/资源存储 ACK、A2 数据库及并发总量控制、命令幂等/回滚、不可变 ActivityVersion、分配/暂停/恢复、模型调用、C1 运行就绪、浏览器或真人内容审阅。17 个测试仅为 AC-01/02 的确定性核心预验证；A1 回归不计 A2 通过，不表示 NFR 实测或教学效果验证。

下一步先与 A1/C2 核对真实接缝（不要求 C2 整任务完成）：服务端会话生成的课程/教师授权，确切资源归属与用途；蓝图/资料的正式 DTO 和版本存储；同事务业务/回执/事件、合法重放优先于 CAS；分配/活动控制及失效接口。随后提出 S2 准确存储对象/进入条件。S3 开放仍需 C1 的真实 profile 和教师确认内容，不能用合成 ready=true 放行。B1/A3 的提案绑定 baseRevision，采用走正式 PATCH；本批内部字段尚未升级为跨成员共享契约。

需由获授权维护者汇总 MVP_SPEC 第 10 节：A2 S1 内部核心已实现并独立验证，S2/S3 未实现；完整 AC/NFR、G1～G4 未完成。**待授权维护者汇总**，本批未修改产品/规划/参考基线。
