# A2：教师资料、蓝图、活动版本与分配

主责：A。任务：[Issue #13](https://github.com/paher-din/XunJie/issues/13)；协调：[G1 #9](https://github.com/paher-din/XunJie/issues/9)；上游：[A1 #10](https://github.com/paher-din/XunJie/issues/10)，合作：[C2 #14](https://github.com/paher-din/XunJie/issues/14)，活动开放条件：[C1 #12](https://github.com/paher-din/XunJie/issues/12)。建立日期：2026-10-10（Asia/Shanghai）。开始代码基线：9221370。

状态：**§11 准确批准的完整服务端范围已实现、验证并审查收口。A 本机 typecheck/build/全量回归 151 通过、0 失败、6 跳过（157 项）；PAHER 对固定源码 8421157 执行本次真实 C1 正向联调 1 通过、0 失败、0 跳过，独立记录于 §12.6。两轴未解决 0；正在分别交付 A1/A2 PR。真实账号/课程审阅、浏览器/TCP/TLS、C2 整体作品链及完整 G1 保持各自后置条件；产品基线待授权维护者汇总。旧章节待批/未执行保留当时范围，现状以 §12.6 为准。**

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

状态：**§11 准确批准的完整服务端范围已实现；§12 公共草稿/固定活动/分配/控制及真实 SQL、C 公共记录适配的合成验证已执行。最新联合 typecheck/build/回归 151 通过、0 失败、6 跳过（157 项）；其中 A2 真实 C1 正向用例未执行。独立两轴审查已完成，原 P2 已修复并增量复核关闭，未解决 0；真实节点联调待 C1 交接；A2 全部完成暂未确认，尚未远程 PR。S1/S2 首批数量与待批说明保留其历史范围，最新进度以 §11/12 为准。**



## 8. S1 实际实现与验证记录

已实现的内部确定性核心（无 HTTP 注册/存储）：[材料准备](../../apps/teaching/server/design/material.ts)、[蓝图内部模型](../../apps/teaching/server/design/model.ts)、[创建/编辑/复制](../../apps/teaching/server/design/draft.ts)、[三类检查](../../apps/teaching/server/design/checks.ts)、[角色预览](../../apps/teaching/server/design/projection.ts)。没有新增依赖、共享 contracts、A2 SQL、生产凭据、UI 或 B/C 源码；默认 main/ready 行为不变。

材料默认不向学生/辅导开放，私有答案与验证资产不能公开。UTF-8 正文与版本内段落保留原文和独立摘要；课程已有总量由可信调用方传入，未验证真实并发配额。蓝图缺项可编辑，字段修改保持其他人工内容，旧 revision 拒绝；目标同 ID/版本的语义不能静默替换，复制保持来源且新对象独立。规则检查拒绝空白路线、旧/缺失目标引用、目标—任务—观察—量规连接不一致、重复/失效/跨课程资源及缺失政策/运行登记。合成结构通过不表示已经可以正式开放。

教师疑点来自明确输入与处理记录，不自动推断教学质量；学习效果/工作量估计始终 unknown。教师预览通过服务端持有的授权回调拒绝非授权课程；预览 audience 不授予身份。student/tutor 用途可见性独立，私有资源只返回无敏感元数据的 redacted；失效/缺失/重复目录引用只返回 unavailable。白名单保留所需教学内容，排除资源原始引用、检查/运行配置和来源私有上下文；正文保持纯文本，实际 UI 转义与真实读取授权待 S2/界面接入。返回嵌套内容与段落均不共享可变引用。

### 8.1 已执行验证

在 apps/teaching 使用已批准 Node 24.21.0/npm 11.19.0：
- `node --test tests/design-material.test.ts tests/design-draft.test.ts tests/design-checks.test.ts tests/design-projection.test.ts`：**18/18 通过**（材料 4、草稿 5、检查 5、投影 4）。
- `npm run typecheck`：**通过**。
- `npm test`：**46/46 通过**（A1 回归 28 + A2 18）；pretest 的 build **通过**。A1 临时合成库回归沿用已有独立批准，A2 测试本身只计算合成对象，不创建数据库。
- 仓库根目录 `node tools/a0-review/check.mjs`：**通过**（24 份文档/225 处仓库引用/27 条正式变更接口）；`node --test tools/a0-review/check.test.mjs`：**16/16 通过**；`git diff --check`：末尾空行已规范，提交前复核通过。静态检查的 businessTests=NOT_EXECUTED 是该脚本不执行业务测试，不替代上方 A2 独立用例结果。

按已确认接缝先验证失败再修复：CRLF 单换行曾被分隔正则回溯误认空行，修正分隔条件；存在的引用仍可能不对应同一目标，补齐连接检查；仅含空白的路线曾通过数组非空检查，补字段非空检查。预览模块未实现时测试因缺模块失败，完成白名单与授权边界后通过。失败事实保留，不把修复前运行记为通过。主责 A 最后复核发现目标语义变更还能回退 competencyVersion；新增第 18 个用例先复现失败，再修正为同 ID 版本不得回退、语义变化必须递增。独立草稿 5/5、typecheck 通过，完整回归重跑 **46/46 通过**。首轮 17/17 与 45/45 为修复前的当时结果。此守卫针对当前草稿中的目标；跨草稿/移除后重新加入的历史版本一致性还需 S2 的确切目标版本目录，不声称已具备全局历史查验。

### 8.2 未执行与交接

**S2/S3、正式接口和产品验收未执行，A2 不关闭。** 无真实登录/资源存储 ACK、A2 数据库及并发总量控制、命令幂等/回滚、不可变 ActivityVersion、分配/暂停/恢复、模型调用、C1 运行就绪、浏览器或真人内容审阅。18 个测试仅为 AC-01/02 的确定性核心预验证；A1 回归不计 A2 通过，不表示 NFR 实测或教学效果验证。

下一步先与 A1/C2 核对真实接缝（不要求 C2 整任务完成）：服务端会话生成的课程/教师授权，确切资源归属与用途；蓝图/资料的正式 DTO 和版本存储；同事务业务/回执/事件、合法重放优先于 CAS；分配/活动控制及失效接口。随后提出 S2 准确存储对象/进入条件。S3 开放仍需 C1 的真实 profile 和教师确认内容，不能用合成 ready=true 放行。B1/A3 的提案绑定 baseRevision，采用走正式 PATCH；本批内部字段尚未升级为跨成员共享契约。

需由获授权维护者汇总 MVP_SPEC 第 10 节：A2 S1 内部核心已实现并独立验证，S2/S3 未实现；完整 AC/NFR、G1～G4 未完成。**待授权维护者汇总**，本批未修改产品/规划/参考基线。

### 8.3 双轴审查与本地交付

固定基线 92213700fb7da506adb1f8b6ac8868bc220c643f；实现候选 eb5fe5d，目标版本修复候选 9ada533。审查使用 `git diff 9221370...HEAD`，修复增量用 `git diff eb5fe5d..9ada533`。code-review 两个只读审查分别核规范与规格，不编辑代码、不重跑测试。

- **Standards：硬性违规 0、可操作异味 0。** 符合任务范围、文档同步、共享契约/保护基线边界；版本修复、反例和记录一致。最终 46/46 与 18/18 已同步替换重跑中状态。
- **Spec：可操作发现 0。** 符合批准的材料/草稿/检查/投影 S1；增量符合“语义变更须显式增版本”，不回退同 ID 版本。正式 HTTP/SQL/DTO、活动确认/分配为明确的 S2/S3 待办，未伪称完成。

主责复核及以上独立审查均已收口；没有未处理的本批发现。验证结果为实际执行，审查结论不替代测试、完整产品或教学验收。实现、修复和文档均仅本地提交，**未推送、未创建 PR、未关闭 Issue #13**。工作树没有保护基线、共享依赖、A1/C/B 模块改动；主工作副本已有草稿未暂存/提交。

## 9. S2 首批持久化方案（待负责人批准，未执行）

### 9.1 范围、依据与依赖

依据 PRD §4.1/8/9、MVP M-01/M-02/M-10、AC-01/02 与 NFR-04、TECH §4.3/4.4/5/5.1/7.1/7.5/9/10.1，以及本文已批准 S1。2026-10-10 负责人在查看新 PR 后要求继续；本节把后续数据库对象和验证边界具体化，**不把“继续”解释成已批准这些新表**。A1 的同事务课程鉴权已在其既有合成库完成接缝实现，见 [A1 §10](A1_FOUNDATION_ACCESS_TRANSACTION.md#10-2026-10-10-c2-接缝推进既有合成鉴权与事务组合)。

拟先实现 S2 的教师持久化批次：材料导入、manual/copy 草稿创建、局部 PATCH、绑定 revision 的 checks、任课教师读取与三角色预览。继续使用 S1 内部类型；身份来自真实合成 Session 与课程成员查询，保存结果必须由 SQLite 实际提交产生。不等待 C2 的整个任务结束，但不将本批记为 S2 整体完成。ActivityVersion、分配/暂停/恢复、学生实际资料读取、A3 模型提案与正式 UI 属后续批次。

TECH §5 的上述四类变更路由已批准；本批拟仅在独立 app.inject 工厂注册，不进入默认 main 或监听网络。manual/copy 的内部输入、结果信封与幂等字段先用任务内适配，不加入共享 contracts；agent 创建仍交 A3，不伪造 Job。教师读/预览先作为经同事务鉴权的内部调用，公共 GET 路径/字段必须另作共同核对，不新增一套已冻结 API。未来 B/C 所需读对象也须对齐后才交共享入口。

### 9.2 准确数据库对象与操作边界

提请批准：在系统临时目录**新建** xunjie-a2-s2-<随机标识>/synthetic.sqlite，初始化 10 张表（复用 A1 原五表定义 + 下述五表）。仅含合成账号、课程和材料；临时凭据继续即时生成，不写 .env/配置/日志。数据库关闭后保留，包括 SQLite 管理的 WAL/SHM 生命周期；不执行清理、删除、现有 A1 库升级或生产数据迁移。

拟复用 A1 驱动、参数化 SQL、短事务和原五表定义；保留原 A1 创建工厂行为。仅增加明确的 A2 合成初始化分支与路径校验，不能开放任意路径或任意 DDL 回调。重开本批已创建库仅验证持久性，不重建 schema。新增对象的物理字段是本批内部存储提案，不冻结 C 的 Receipt/Event 公共 DTO。

| 新表 | 拟保存内容及约束 |
| --- | --- |
| resource_versions | 服务端 resourceVersionId、courseId/创建者外键、格式/kind/标题、原正文/UTF-8 bytes/hash、student/tutor 可见性、获准 teacher_design 用途、版本内段落 JSON；段落含服务端 paragraphId、ordinal、原区间及 hash。正文版本只追加，私有答案/验证资产可见性恒 false；课程归属和用途由服务端设置/验证 |
| competency_versions | (courseId, competencyId, competencyVersion) 唯一键；不可改写的 domain/title 语义。core 是草稿安排，不当全局能力语义。已存在版本须语义相同；新增版本高于该 ID 已登记最大版本，已有较旧确切版本仍可引用。跨草稿、移除后重加都查同一目录 |
| blueprint_drafts | 服务端 blueprintId、courseId 外键、当前 revision、经 S1 校验的 content JSON、创建者/服务端时间；copy 记录确切 source ID/revision。仅当前草稿可 CAS 更新；不声称已保存所有历史草稿快照或冻结 ActivityVersion |
| command_receipts | commandId/receiptId、账号外键、课程/稳定命令/目标作用域、Idempotency-Key、请求摘要、已提交结果 JSON、recoveryGeneration、对应事件序号；账号+命令+目标+键唯一。保存旧业务 IDs/版本/结果以支持原样重放；不保存密码、Cookie、CSRF 或私有路径 |
| audit_events | 数据库分配的单调 server_seq、唯一 eventId、服务端操作者/课程/命令/对象引用、recoveryGeneration 及时间；记录材料/草稿/checks 的命令事实，不造学习事件/模型推断。载荷不复制私有正文；receipt 的事件序号引用此表，同事务创建 |

采用现有 approved SQLite 驱动和配置：foreign_keys=ON、WAL、synchronous=FULL、busy_timeout=1000，事务为同步 BEGIN IMMEDIATE。新增 JSON 读回必须按对应内部 schema 校验，不能直接把数据库行当可信 DTO。正文 bytes/hash 由实际原字节推导，不能采信请求自报。材料课程配额在持有同事务写锁后统计已保存正文并验证 256 KiB/2 MiB 上限，再插入；私有正文同样计数。本批不增加资料撤回/删除/可见性编辑命令；相应治理不因此被视为已实现。

风险和成本：每个测试库增加五表及合成正文，保留临时文件占用磁盘；SQLite 原生驱动与短锁仍有平台/忙冲突边界。新建目标有严格前缀和独占创建校验，不选择现有业务文件。业务失败整批回滚；初始化失败保留该合成库并报告，不自动删除。撤回本批代码可由后续提交停用新工厂，既有 A1 路径不变；不操作 Git 历史或删测试库。这项批准不覆盖生产库建表/迁移、真实资料/学生数据导入或真实凭据发放。

### 9.3 原子命令顺序与读边界

1. 在 HTTP 边界校验 Origin/CSRF 和严格输入格式；withAuthorizedCourse 在保存事务内重新核 Session/账号/当前课程教师角色。目标草稿/材料再核课程归属；不从 body role/studentId 或预览 audience 授权。
2. 当前授权成立后，先在事务内核请求携带的 recoveryGeneration 与服务端受信当前代际，缺失/旧值拒绝；旧代际用既有 RECOVERY_REQUIRED/409，不推进 Session 活跃时间或业务行。随后才按账号、稳定命令、服务端目标和键查 receipt；回执所属代际也必须是当前代际，不把旧结果改贴新代际。请求摘要由经验证的语义输入确定性编码并包含目标、expectedRevision、recoveryGeneration 与确切 copy 来源；键自身不进摘要，JSON 键顺序差异不制造不同请求。同键同摘要返原结果；同键异摘要报既有 IDEMPOTENCY_CONFLICT/409。重放不新增业务对象/事件；当前授权撤销则拒绝重放。每次 HTTP requestId 可新。
3. 对新命令查确切目标/来源及 expectedRevision。PATCH 使用条件 UPDATE 并验证 changes=1；copy 只能复制同课程已授权来源的指定当前 revision，先取完整内容再创建新 ID/revision=1。没有历史快照的旧 source revision 拒绝，不拼出并不存在的历史内容。
4. 调用 S1 核心，查资源归属与全局目标版本目录，再同事务写材料/草稿/目标目录、audit_event 和 receipt。跨课程引用拒绝；草稿的其他缺项/缺运行登记保留为 checks 阻断项，不阻止保存少量输入。checks 结果绑定确切 revision；无 C1 动态就绪与实际政策/规则目录的条件保持 unavailable/unverified，不用合成 ready 放行活动。
5. 事务提交成功后才组装 HTTP 成功结果；约束/busy/提交故障不能 ACK。回执结果可保留原草稿/报告，但读取始终经当前授权和适当投影，不把原始 receipt 直接开放给学生或辅导。
6. 教师读取/预览在同一短事务重查授权、读取草稿与确切资源，再用 S1 白名单投影。学生与辅导实际入口仍未注册，不向其授予草稿访问。同步回调不运行模型、HTTP、runner 或等待外部服务。

受信当前代际拟由独立合成工厂的同步服务端登记读取边界提供，不能由请求体、草稿或可回退的业务库决定。合成测试由受控父进程持有明确登记值，关闭/重开业务库保持该值；旧备份场景在停止接纳窗口由夹具推进登记值，再提交原请求核拒绝。登记读取与提交间不得发生切换，提交前再次核一致性；模拟值只验证拒绝/重放顺序，不宣称可靠登记点或正式恢复流程已实现。真实入口必须等 A/C 批准并落实不随备份回退的持久登记、恢复接纳屏障和执行端确认；本批不创建该外部登记服务、不操作备份/VM或新增密钥。该同步登记读取纳入 §9.4 接缝提请，字段仍是任务内部适配，公共 HTTP 携带方式另会审。

以上数据库事件/回执承载同事务语义，但尚未冒称已接通 C2 的记录组件。待 A/C 对齐 C0/C2 的 ID、scope、事件载荷、原结果编码与事务写入适配后，才将相应内部实现交共享集成；不另造队列或 Job 表。与 B 的帮助政策/目标字段同样以已批准基线和实际适配核对，未落实目录保持未知。

### 9.4 拟确认的测试接缝与完成条件

提请同时确认两个接缝：独立合成工厂的 app.inject（上文四类教师变更命令）与实际数据库 withTransaction/关闭重开（包含同事务授权读/预览及同步受信代际登记读取）。以外部 HTTP 结果、提交后读回、第二连接真实竞争及持久重放为证据；不通过替身 ACK、仅 pure plan 或 spy 调用次数冒充落库。未批准前**不编写/执行新增 A2 SQL 或该批测试**。

| 用例 | 成功/拒绝与观察结果 |
| --- | --- |
| 认证/课程/资料边界 | 合成合法教师可执行；未登录、学生、非任课教师、跨课程、伪造 role/studentId、Origin/CSRF 错误拒绝。撤销账号/角色后拒绝读与重放 |
| 材料固定引用/隐私/配额 | 正文与 BOM/CRLF/Unicode 原 bytes/hash 可读回；paragraphId 固定且不跨版本替换；私有正文/敏感引用不进入 student/tutor 预览；第二连接竞争不能使课程总量超过 2 MiB |
| 保存/复制/目标历史 | 少量输入可存；copy 新 ID 与独立 revision，修改不改变来源；旧来源/旧 PATCH revision 拒绝；不同草稿或移除重加不能替换已有目标版本语义 |
| 幂等/冲突 | 提交后推进 revision，再重放旧合法键仍获原业务 IDs/结果；同键异摘要 409；同键并发只一组业务行/事件/receipt；当前越权无历史结果 |
| 恢复代际 | 请求缺/旧代际拒绝；即使旧键与旧摘要匹配也先报 RECOVERY_REQUIRED，无 ACK/新行；代际推进后旧 receipt 不能改贴或重放；正常关闭重开保持原代际；当前代际合法请求保留原结果。真实旧备份/可靠登记/执行端恢复未执行 |
| 同事务失败/恢复 | 制造实际约束/busy/数据库故障，前置业务行、目标目录、事件/receipt、Session 活跃时间全部不留下半批，不返成功；关闭重开保持对象、原结果/版本与唯一约束 |
| checks/读取 | 绑定所读 revision，缺项可编辑、检查仍三类；真实规则/profile 缺口不伪造已验证；并发编辑时同事务读取与材料目录不拼出混合版本 |
| 工程与交付 | typecheck、针对用例、完整 npm test/build、文档检查和双轴审查通过；失败/未执行如实记录，README/本文同步，并请求授权维护者汇总 MVP §10 |

本批通过仅代表 A2 教师持久化合成批次，不关闭 #13，也不计完整 AC/NFR/G1 或浏览器/真人验收。C2 分配/可用性/同事务失效、S3 活动版本及真实 C1 开放门禁仍待后续。

### 9.5 新 PR 接入门禁与当前事实

[C1 #16](https://github.com/paher-din/XunJie/pull/16) 与 [C2 #17](https://github.com/paher-din/XunJie/pull/17) 在本轮核对时仍 Open；C2 基于 C1。固定审查 head 分别为 7e4ef73ee1b9ee301b82beab809b54e18ffce3f7、84545ec4084aa9bdb29649ef4be21c28a6615d4d，不将作者测试记录记成 A 本机复跑。

接入前保留两个审查问题：C1 result-files 的默认 UTF-8 解码会移除 BOM，导致返回正文与原 bytes/hash 不一致；C2 readWorkspace 仍直接返回 runs[].result，可能包含私有检查细节，另一个 diagnostics 入口的过滤不能保护此投影。前者已用标准库字节探针验证，后者已读固定代码和现有私有测试夹具；未实施业务 HTTP 泄漏复现、未重跑专用节点。需要 C 侧修正并验证后才接实际结果读取，不在 A 批次静默代修或忽略。

**当前：§9 仅方案，新增表/库/业务接口/测试全部未执行；申请范围未获批准。** 已独立完成的 A1 同事务基础接缝见其 §10，S1 的已有 18 项结果不计作本节通过。无需等待 C2 整任务，但最终共享会审、C2 实际记录/读适配和上述修复仍是对应集成条件。

### 9.6 方案审查事实

本节仅方案审查：候选 8458e13 的 Standards 硬违规/异味 0/0；Spec 发现 1 项 P2，要求补齐 TECH §7.5 的恢复代际先拒后重放。纯文档修复 452d038 增加受信独立登记来源、receipt/event 代际、事务内守卫/提交前一致性与反例，Standards 增量 0/0，Spec 增量未解决 0。方案审查通过不等于实施批准；新增 A2 SQL/库/业务测试仍未执行。负责人需审阅 §9.2 的准确 10 表新临时库范围及 §9.3/9.4 的内部适配与验证接缝后决定是否实施。

## 10. S2 教师持久化合成批次批准与实施记录

项目负责人在审阅 §9 的准确新库/十表范围及测试接缝提请后明确要求“继续”，批准实施该独立合成批次。§9 的待批准/未执行保留当时事实，以本节较新状态为准；批准不延伸到生产 schema/迁移、真实数据/凭据、公开入口、共享 DTO、B/C/UI 或活动开放。

本批沿 implement/tdd，以 §9.4 的 app.inject、同事务授权读取与真实 withTransaction/关闭重开接缝逐片实施。基线 0044a67；总审查仍沿已确认 92213700fb7da506adb1f8b6ac8868bc220c643f，新增单列 0044a67..候选。可写 A 自有 server/db、server/design、必要的 access/app.ts 内部组合、对应 tests/fixtures、README 和本任务稿；package/lock/保护基线只读。不执行 runner/模型、现有库迁移或清理。

内部适配细化（仅本合成工厂，公共契约待共同会审）：
- 资源 POST 输入为 recoveryGeneration 与 material（S1 原格式/标题/正文/kind/可见性），另可明确 teacherDesignAllowed；默认 false，不把导入或 tutor 可见性当成设计模型获准使用。创建者与 courseId 来自当前授权。
- 草稿 POST manual 接 content，copy 接 sourceBlueprintId/expectedSourceRevision；PATCH 接 expectedRevision/patch；checks 接 expectedRevision 与明确的教师 concerns；都携带 recoveryGeneration、Idempotency-Key，不接受 role/studentId/ready 或自报摘要/ID。
- 成功 data 是内部 commandId/receiptId/serverSeq/recoveryGeneration/result；receipt 保存同一结果，不包含 requestId。回放只更新单次 HTTP requestId，不改原业务 IDs/版本。
- PATCH/checks 与内部读取只有 blueprintId：A1 内部课程鉴权组合增加可信同步课程定位器，由 tx 查询最小课程归属，先核身份，再核当前课程教师角色，回调重查对象归属。同一事务完成；定位器不向客户端返回对象是否存在，也不接受请求指定身份。现有 string courseId 调用保持行为。
- 已存资源正文/段落/JSON、草稿、回执读回按内部 schema 校验，存储损坏走 PERSISTENCE_UNAVAILABLE，不把内部损坏报为客户输入错误。资源版本只由新增命令追加；无更新/删除公共操作。
- 教师读/预览只提供服务端持有的同步函数，测试路由仅夹具注册；实际公共 GET/共享消费字段另对齐。checks 缺少真实政策/规则/profile 时保留阻断与未知，无 releases 路由。

状态：**§11 准确批准的完整服务端范围已实现；§12 公共草稿/固定活动/分配/控制及真实 SQL、C 公共记录适配的合成验证已执行。最新联合 typecheck/build/回归 151 通过、0 失败、6 跳过（157 项）；其中 A2 真实 C1 正向用例未执行。独立两轴审查已完成，原 P2 已修复并增量复核关闭，未解决 0；真实节点联调待 C1 交接；A2 全部完成暂未确认，尚未远程 PR。S1/S2 首批数量与待批说明保留其历史范围，最新进度以 §11/12 为准。**

确切资料引用输入仅接受本课程已保存资源：缺失与跨课程 ID 同报 FORBIDDEN，不通过错误差异泄露其他课程对象是否存在；空 resources/其他设计缺项仍可存草稿。已保存对象后续缺失的读取/检查保留 unavailable，不补造正文。

### 10.1 实际代码与边界

[新增五表定义](../../apps/teaching/server/db/design-schema.ts) 仅由 [createDesignDatabase](../../apps/teaching/server/db/transaction.ts) 在全新 xunjie-a2-s2-* 临时目录追加；A1 createSyntheticDatabase 仍只建原五表。开库复用原路径/符号链接校验、SQLite 实际版本与 PRAGMA 检查，事务不接纳 DDL。没有现有库迁移或数据库清理。

[独立教师工厂](../../apps/teaching/server/design/app.ts) 注册既定 resources POST、blueprints POST（manual/copy）、blueprints PATCH 和 checks POST；只用于 app.inject，无监听入口。createVerificationApp 的当前 Session/Origin/CSRF/课程授权复用；可信课程定位器只在同一 tx 查询蓝图课程归属，之后重查角色和对象，不由 body role/studentId 授权。读/预览是工厂提供的授权函数，测试夹具才注册 GET；尚无正式公共读 DTO。

[实际存储](../../apps/teaching/server/design/storage.ts) 参数绑定 SQL，材料正文/UTF-8 bytes/hash/段落 ID 固定保存，私有可见性拒绝；课程总量在同一 IMMEDIATE 事务统计并插入，默认 teacherDesignAllowed=false。草稿少量输入可保存，PATCH CAS、copy 确切当前来源与新身份，目标目录阻止全局同版本语义替换和新版本回退，允许确切已有旧版本继续引用。

命令摘要规范化对象键但不改正文，当前授权/恢复代际先于回执重放，合法重放早于新请求 CAS；同键异摘要 409。业务内容/目标目录/audit_event/receipt/Session 活跃时间同提交或同回滚。事件只保留命令与对象引用，不复制私有正文；回执保留确切原结果，读回验证 schema、业务作用域与原关联 ID，不能将另一课程结果装入有效回执后返回。此校验不承诺数据库防篡改认证。

三类检查保存绑定 revision 的报告；显式教师 concerns 保留判断/处理记录，效果与工作量 unknown。政策/规则目录和真实 profile 尚未接入，相关项保持阻断；无 releases/assignments/control 路由，不伪造 ready。授权教师预览复用 S1 白名单，student/tutor 无私有资产 ID/标题/hash/正文，audience 不授予草稿权限。真实学生读取/浏览器界面未接入。

恢复登记仅受控父进程提供同步值，事务内先核、返回前再核；跨进程验证由同一受控父进程经 IPC 传入相同合成登记/签名材料，不写日志或配置。正常重开保持登记值，模拟推进代际用于拒绝反例；未执行旧备份恢复、不随备份回退的可靠持久登记或执行端恢复流程。

### 10.2 实际验证记录

接缝测试位于 [design-storage.test.ts](../../apps/teaching/tests/design-storage.test.ts)，真实第二连接/进程位于 [design-child.ts](../../apps/teaching/tests/fixtures/design-child.ts)。均仅合成课程/材料与随机即时账号凭据；测试库保留。父进程 app.inject 不发网络请求；子进程开同一已创建库，不初始化/迁移，不执行模型/容器。SQL 故障通过实际审计序号耗尽、竞争写锁、合法 JSON 但错误内容/关联的受控行制造，不替换内部事务/存储对象。

已执行 Node 24.21.0/npm 11.19.0：
- 独立 node --test tests/design-storage.test.ts：第 1～12 项 **12/12 通过**；追加第 13 项“形状合法但作用域错误的回执”先失败，再修复作用域复核，针对用例 **1/1 通过**。
- npm run typecheck：最后一轮**通过**；曾发现 Zod optional resolution 与 S1 exactOptionalPropertyTypes、unverified code 类型不一致，按实际省略可选字段与结果 schema 验证修正，没有关闭检查或 any 绕过。
- npm test（含 pretest build）：**62/62 通过，0 失败/跳过**（A1 31 + A2 S1 18 + 本批 13），build 通过；总耗时约 38.00 s，不计产品/NFR 性能。13 项存储用例均在这次完整回归执行并通过。
- 仓库根目录 node tools/a0-review/check.mjs：**通过**（24 份文档/240 处仓库引用/27 条正式变更接口）；node --test tools/a0-review/check.test.mjs：**16/16 通过**；git diff --check：**通过**。静态脚本 businessTests=NOT_EXECUTED 仅说明该脚本不执行业务用例，实际结果以上方测试为准；两轴审查结果见 §10.4，已收口。

关键验证覆盖真实保存与关闭重开原结果/段落 ID；manual/PATCH/copy 和旧源拒绝；重放原 IDs/旧版本、不被已前进 CAS 拒绝；全局目标历史；当前角色/跨课程/身份伪造/CSRF/Origin；私有与未获准资料预览；当前/旧恢复代际及提交前切换回滚；真实晚期 SQL 失败无半批/ACK；两独立进程同键一组结果、CAS 一胜一冲突、2 MiB 配额原子；实际 busy 拒绝；并发读视图与确切资料一致；损坏 JSON/跨课程回执拒绝且响应/日志无私有正文、路径、cookie/CSRF。

先失败再实现的实际记录：工厂缺模块；草稿/checks 路由缺失返回 400；全局目标目录缺失允许语义替换；未核资源引用导致 missing 写入后 foreign 请求见版本冲突；形状合法的外课程回执曾返回 200，补作用域后报 503。busy 验证初次因夹具等待了“释放”而不是“持锁”导致请求错过竞争窗口，改为 IPC 持锁/释放两个阶段后通过；并发读夹具初次键含空格违反既定合法键校验，修正夹具键后通过。一次修订命令工作目录错误未落盘，核错后在正确目录应用。以上失败未计通过，也未放宽规格。

### 10.3 剩余工作与交接

本批的十表/教师保存/检查/授权读合成链已实现；S2 整体与 S3 **仍未完成**。未执行：公共 DTO/GET 会审、A/C 共享 Receipt/Event 实际写入适配、A3/B 的获准读取、真实 HTTPS/凭据/可靠恢复登记、活动不可变版本/分配/控制/失效、C1 动态就绪/结果缺陷修复、浏览器/真人与完整 AC/NFR/G1～G4。当前原子回执不是 C2 的 Job/作品整链验收；完整 AC-02/NFR-04 不凭本批数量宣布通过。

需获授权维护者汇总 MVP_SPEC §10：A2 S2 教师持久化合成批次及实际验证、本批内部读取与全局目标历史/幂等/代际守卫；S2/S3 与产品验收仍保留待办。**待授权维护者汇总**，本批未改产品/规划/参考基线、共享 contracts、依赖、B/C/UI。默认 main 仍健康入口、ready=503。仅本地交付，远程推送/PR/关闭 Issue 未执行。

### 10.4 两轴审查与本地交付

总固定点 92213700fb7da506adb1f8b6ac8868bc220c643f；本批开始 0044a67，实现候选 7aef24289343ab01ceba7a61b70556786aa8298e，新增审查 git diff 0044a67..7aef242。fixed ref 已解析、diff 非空；此前提交已有独立审查记录。

Standards：**硬性违规 0、可操作判断性异味 0**。原 A1 五表工厂保留，A2 DDL 仅获准新临时库；文件、文档、日志与验证接缝符合边界。Spec：**未解决发现 0**。本批教师同事务授权/保存/读取、回执重放/CAS/代际、目标历史及角色投影符合 §9/10 范围，S2 整体/S3 后置条件没有被冒称完成。两位审查均只读，未复跑 SQL/runner/网络或作者测试；不将审查当额外通过数。

本批已实现、验证并审查收口；最新实际全套 62/62、类型检查/build、文档检查与 16/16 检查器回归均通过。审查后仅同步任务/README 的当前状态与记录，不重复业务测试。提交仅本地 codex/a1-c2-seams，未推送、创建 PR 或关闭 #13；主工作副本已有草案不动。下一步对齐 A/C 共享记录/读接缝及 B 的获准读取，再按对应条件推进活动版本/分配/控制；无需等待整个 C2，但不跳过相关契约和验证。

## 11. A2 全部服务端内容与独立 PR 收尾方案（待批准）

项目负责人于 2026-10-10 要求完成 A1/A2 所有内容后分别提交 PR。本节给出剩余准确实现/存储/验证范围；已有 §10 十表合成批次保持已完成，新的 schema 与公共接口细化尚未批准，不以笼统任务授权越过 AGENTS 的红线。范围依据 PRD-01/02/10、M-01/02/10、AC-01/02/06/15、NFR-04、TECH §4/5/7/9/10/12、TEAM A1/A2 和 Issue #13。A3 的 Agent 根提案/局部 AI/试评/样例作业、C2 文件/运行、UI/真人由原主责/阶段交付，不顺带接管。

### 11.1 剩余实现与公开读取提案

1. contracts/design 交严格输入/结果与版本类型，沿 §10 已验证语义；public DTO 的确切字段由本提案批准后才落地。增加教师 GET /api/blueprints/:id 和 GET /api/blueprints/:id/previews?audience=student|tutor|teacher-validator，GET /api/resources/:id，以及固定 GET /api/activities/:id / GET /api/assignments/:id；用途/身份/课程/分配均服务端核验，audience 只用于已授权教师预览。student_help/analysis 读取限固定活动中获准正文/政策，不读教师草稿或私有验证资产；teacher_design 经 A 的受信教师授权可读取当前草稿与显式获准资料，无需先开放活动。
2. 教师配置帮助政策/检查规则的不可变版本：先提供当前任课教师授权写入的内部接口；维护者只维护批准技术配置，没有教学政策/规则写权限。此接口，严格保存实际完整内容/版本/课程，不新增网页或任意配置上传。政策不允许整份代做，不接受学生自报 ready/检查通过。C 的现有规则/Profile shape 原样消费；需要具体业务内容的模板由教师审阅，合成规则不写为正式课程已确认。
3. POST /api/blueprints/:id/releases 输入 expectedRevision、recoveryGeneration、教师 concerns/resolutions 与明确确认，Idempotency-Key 沿用。检查读当前完整草稿/确切资源/政策/规则；C1 readiness 在事务外查询，事务内核对应版本/指纹/代际与有效结果后再确认。阻断拒绝，未处理设计疑点要求教师说明；效果/工作量保持 unknown。生成固定 activityVersionId，存草稿来源 revision、正文、目标/量规/资料引用及完整政策/规则/Profile 内容/摘要；活动控制与正文分离，没有原地编辑路由。没有实际就绪不能成功开放；仅合成守卫测试不记真实开放通过。
4. POST /api/activities/:id/assignments 输入 studentIds 与 expectedActivityControlRevision/recoveryGeneration；当前成员逐一核，整批原子，旧控制版本/活动暂停拒绝；每份 assignment 固定 studentId/activityVersionId，assignmentRevision=1，新活动明确新分配，不改旧尝试引用。
5. 两个 controls 路径沿 TECH §5：expectedActivityControlRevision 或 expectedAssignmentRevision、pause/resume、理由与代际；重放先于新 CAS，相同设值不反复增版本/epoch。活动暂停阻止新分配并暂停相关分配/失效；暂停来源分开持久化：activity pause 设置 paused_by_activity，assignment pause 设置 individual_paused；有效状态由二者和活动控制决定。恢复活动只清除活动暂停来源，不解除个人分配/Attempt 暂停、改学习阶段或复活旧 Job；解除某来源时仍保留另一来源及其理由。分配暂停与该范围 Attempt 的 epoch、相应用途 Job 持久停止及回执/事件同 tx；已生成/已执行事实保留，取消未确认不得伪称终止。
6. 交 C2/B2 的同 tx 读取为当前分配与活动可用性、固定活动/可见材料/政策与确切版本；C 的原 Attempt/Job 数据由 A 的持久适配核 scope，授权后传可信 actor，不让 HTTP 构造 CommandContext.authorize 或 currentGeneration。涉及尚未交付 Action 的失效只记录真实已有对象，C3 接入时补齐 Action 最终投递，不补造消息或假成功。

### 11.2 拟申请的准确数据库范围

仅在系统临时目录独占新建 xunjie-a12-completion-* / synthetic.sqlite；复用十张既有定义，新增以下七张应用表（合计十七张；SQLite 内部 sqlite_sequence 不计）。新工厂不选择旧文件；初始化失败亦保留库，不自动清理。既有 A1 五表与 A2 十表工厂不扩权。

| 新表 | 主要独立键/约束与正文 | 用途 |
| --- | --- | --- |
| help_policy_versions | id 主键、course_id FK、created_by FK、created_at_ms、完整严格 policy_json、content_hash；新版本新 ID，内容无更新接口 | 固定活动帮助政策与 B 获准读取 |
| check_rule_versions | id 主键、course_id FK、created_by FK、created_at_ms、完整严格 rules_json、content_hash；不可变 | 教师/可信验证器检查版本，不向学生/tutor 下发私有内容 |
| activity_versions | id 主键、course_id / blueprint_id FK、source_revision、created_by / created_at_ms、完整 activity_json / content_hash；正文不可原地更新 | 确切资源/目标/量规/政策/规则/Profile 与就绪来源固定 |
| activity_controls | activity_id PK/FK、control_revision 正整数、status active/paused、reason / controlled_by / controlled_at_ms | 活动可用性 CAS，不改正文 |
| assignments | id 主键、course_id/student_id/activity_id FK、assignment_revision 正整数、status active/paused、individual_paused/paused_by_activity 两个布尔来源与 individual_reason/activity_reason、controlled_by / controlled_at_ms；同活动/学生唯一 | 仅当前课程学生；分配暂停优先 |
| attempts | attempt_id 主键、course_id/student_id/assignment_id/activity_id FK、attempt_revision / decision_epoch 独立列、严格 C Attempt JSON；归属/JSON 一致 | 仅 C 已交公共 Attempt 的读取/控制持久适配，不实现文件/快照/运行 |
| jobs | job_id 主键、course_id/student_id/attempt_id 作用域、request_receipt_id FK、purpose/status/stop_requested/recovery_generation 与严格 C Job JSON、租约/epoch关联核验；teacher scope 可空学生/Attempt | C2 enqueueJob/cancelByPurpose 等实际同 tx 保存与拒绝 |

沿用现有 audit_events / command_receipts 保存 C 公共事件/回执：现有独立作用域键、唯一键/serverSeq 与完整 JSON 不变，不 ALTER；具体按命令类型严格校验原结果与关联。新增内容只用于新合成库，原子 INSERT/UPDATE/SELECT；不 DROP/清理/迁移，不创建生产库、真实账号、.env/密钥/CI/付费模型或公开部署。没有运行配置就绪表：C1 Profile 与 readiness 通过既有受认证控制边界读取，活动固化完整确切版本/来源，不能让客户登记 ready。

风险：新增临时库/正文会占磁盘，原生驱动/短写锁存在忙冲突，C 公共 JSON 需严格关联验证；活动控制影响同课程测试 Attempt/Job，必须事务回滚。失败保留合成库/证据。停止采用可在后续代码提交停用新工厂，不删文件/回退 Git 历史；不修改任何已有或生产数据库。

### 11.3 拟沿用验证接缝与完成条件

批准后沿已确认的 app.inject、实际 withTransaction、关闭重开与第二连接真实竞争，扩展到上述公开读/confirm/assign/control 与 C Job/Event/Receipt 实际适配；身份和恢复代际仍受信来源。Node24.21.0/原精确 lock，无新依赖；新库保留。先反例再逐片实现，不用存储 mock/纯 plan 代替实际 ACK。

- 草稿→三类检查→固定版本→分配→暂停/恢复：缺项/未就绪拒绝，旧 revision 与控制 CAS 拒绝，人工修改及固定版本不变，新版本显式分配；重放原 IDs、同键异摘要、双连接竞争一胜一冲突。
- 跨学生/课程、非任课教师、body 身份/ready 伪造、学生读取草稿、未分配活动、私有答案与敏感摘要/metadata、用途扩大均拒绝；GET/恢复不启动学习/模型/运行；撤权后旧回执不可返回。
- 暂停与真实 Attempt epoch/Job 停止/回执/事件/Session 同提交或回滚；活动 pause 优先，activity resume 不解除 assignment/Attempt 个人暂停，旧 cancelled/stale 不复活；普通运行事实保留，节点未确认取消保持 cancelling/outcome_unknown，不释槽。
- 实际 SQL 晚期失败/锁忙/关闭重开、读取损坏/作用域串线、提交前代际切换与旧请求拒绝。限定检查/private result 不经 C 已知有缺陷 readWorkspace 投影进入学生输出。
- 实际 C1 readiness 的固定版本/指纹与代际对齐必须有真结果；无法访问节点或门禁缺陷未修复时标未执行/阻塞，不用 synthetic ready 计成功开放。C1/C2 两项已知缺陷见 §9.5，仍未修复，保持各自负责人处理，不静默代改 C。
- typecheck/build/适当领域测试、完整回归、文档/链接/空白与 Standards/Spec 审查通过；更新本文/A1/README，提出基线汇总请求。实际课程内容教师审阅、UI/真人、C5 恢复/NFR 负载分别保留，不把服务端测试数当教学效果。

A2 需上述固定版本/分配/控制及服务端交接全部完成后才建独立 PR（Refs #13，基于 A1 分支）。A3 Agent 接入和 C2 整工作区不是本次代做内容；必要同 tx 对象/接口缺口逐项列出。不提前交首批 PR、不标整个 AC/G1 或真人已完成。

### 11.4 当前授权与执行状态

已核对需求/远程 Issue/PR 与 C 当前代码，完成准确收尾方案。新七表/十七表工厂、上述新增公开 GET/DTO、活动版本/分配/控制及新批业务测试均未执行；需要负责人批准 §11.1～11.3 的接口细化、准确合成 schema/写库范围及测试接缝。请求不包含基线写入、真实数据库/凭据/生产部署或变更 C/B/UI 权限。授权一旦到位沿顺序推进，不逐步骤重复确认。

方案静态验证：node tools/a0-review/check.mjs 通过（24 份文档/241 处仓库引用/27 条正式变更接口），git diff --check 通过。仅核链接/结构，不计新增业务通过；准确授权提请已发出，等待负责人答复。

负责人已明确答复“批准该范围并继续”，批准 §11.1～11.3 公共接口/17表新临时合成库/测试接缝。原待审状态保留当时事实，以本记录为准；不含生产/既有库/凭据/CI/基线或 B/C/UI 修改。暂停来源分别保存理由为准确列细化，未增加表或操作许可。实施按顺序进行，只有实际通过并审查收口后才分别 PR。

实施前 Spec 审查两处权限提案按 TECH §4.4 修正：教学政策/规则写入限定当前任课教师；B 读取按 teacher_design 与 student_help/analysis 分开。规范审查无硬违规/可操作异味，提案修正遵循既定基线，不扩大实施授权。

实施细化：检查规则目录的内部主键采用课程与 C 规则版本的组合编码，草稿及固定活动仍引用 C 原始 versionId；避免不同课程使用同一可信规则版本时相互排斥。不变更已批准表数、列或业务版本契约。公共资料读取需当前课程成员且属于该学生固定分配中的可见材料；政策/规则写入继续只允许当前任课教师。

## 12. 已批准完整服务端批次实际记录（待真实 C1 联调与最终审查）

准确批准范围已实现：contracts/design 提供严格草稿/输入/结果/投影类型；server/design/application.ts 的 createDesignApp 复用 A1 当前 Session/同连接短事务，注册批准公共 GET 与 release/assign/control，原 resources/manual/copy/PATCH/checks 在完整工厂消费 C 公共 Receipt/Event。旧 S1/S2 工厂保留历史验证范围；主健康入口尚未配置业务监听，不虚报 ready。

政策/检查规则仅当前任课教师经受信内部接口追加不可变版本。release 在事务外通过 C 的 authenticated readRuntime 查询，事务内重查 Session/角色/课程、确切 draft revision/材料/政策/规则及恢复代际；阻断和未处理 concerns 拒绝。固定活动保存完整资源、帮助/检查/Profile，正文与可用性控制分开。固定材料正文/metadata 不接受同 ID 静默替换，缺失不补正文；私有资产的标题、ID、hash、正文均不进入 student/tutor。

分配限制当前课程学生，整批保存并核 activity control CAS。assignment/activity 暂停分别保存来源及理由，和真实 C Attempt revision/epoch、Job 停止、Receipt/Event/Session 同事务；恢复仅清除对应来源，不改学习阶段、不复活旧作业。queued/running run 在节点确认前保留 cancelling。服务端 B 读取按 teacher_design（当前草稿与显式获准资料）、student_help（本人有效分配固定活动白名单）区分；C 读取分配可用性使用同一 tx 的真实当前成员。

### 12.1 本机已执行验证

Node 24.21.0/npm 11.19.0，联合 A1/A2 工作副本 npm run typecheck 通过，npm test/pretest build 通过：149 项中 144 通过、0 失败、5 跳过；跳过内容及最低 B/C 授权修复见 A1 §14.1，不计实际节点通过。新增 design-activities 7 项在全量回归执行，覆盖公开 API 固定版本/分配/个人与活动暂停/重放/CAS、缺 readiness/跨课程/伪造权限拒绝、晚期实际 SQL 故障整批回滚、两独立进程同键原结果/CAS/写锁忙，以及暂停 tutor 拒绝、queued run 等待节点取消、材料版本静默替换拒绝。旧 S1 18/S2 13 同时回归，不重复计算历史通过数。

新固定材料反例先失败（200 且替换标题进入载荷），补确切固定版本核验后通过；queued fixture 初次因缺测试参数解构报 503，修正夹具后通过，未改业务条件。并发夹具初次固定时间使 lastActive 在子进程看来处于未来、持锁 IPC 等待阶段错误，修正 Date.now 与 holding/released 分离后通过，未放宽锁忙/会话条件。A1 适配初次将 C 冲突映为 503，按既有公共码与安全消息修正；旧回执代际先于新摘要冲突检查，恢复反例返回 RECOVERY_REQUIRED。

远程 C2 已于复核期间升级 head=64eaa958ff565de245a965c5a29945eb2b08b2eb，含 C1 f8b6c6ff3e6302b59453f108dd16a57073fcf255。它已修正原投影/取消问题及可信检查，validator 改为 textscope-validator-v2。接下来吸收 C 原提交、将批准规则消费对齐 v2、复核 A 的最小兼容修复并审查；旧 §9.5 的未修复描述仅保留当时状态。C 作者验收不能代替 A2 真实确认开放。

### 12.2 C1 联调交接与获取方式
2026-10-10 再核远程 PR #16/#17 最新正文、全部讨论和 Issue #12 评论：C1 head=f8b6c6f、C2 head=64eaa958，未出现新的 A 可用跨机器入口。C1 §14.1/14.3 已明确宿主本地 127.0.0.1:2222、SSH 用户 root、application 与 known_hosts 的 /opt/xunjie-runner/vm/keys 路径及真实 readiness 命令，因此不应要求 A 成员重新提供这些已知参数。真正缺项是该已准备环境在哪台机器、A 怎样获准访问，或在该宿主共同执行 A2 用例。PR 明确代码合并不自动安装节点/分发 key，历史 C 验收不能代替 A2 本次正向结果。

本次用本机 Ubuntu WSL 的 root 只读核存在性及监听（不读取凭据正文、不变更权限或安装/启动）：application、known_hosts、/opt/xunjie-runner/node/bin/node 均不存在，2222 无监听。由此排除普通账号访问受限导致误判，当前本机不具备文档所述准备环境。此结论仅针对当前本机/该发行版，不推断 C 节点没有运行。后续交接应只问节点所在宿主及可用访问方式，或由 C 在实际宿主共同完成用例；不要求私钥进入聊天/仓库。

本机只读 readiness 查询失败：C1 文档给定的应用认证文件不存在，127.0.0.1:2222 拒绝连接。127.0.0.1 指查询所在机器，不是 GitHub，也不会跨成员电脑访问 C 的 VM。无需 A 成员自行寻找/发送私钥；由 C1 主责提供 A 可用的已授权连接配置（主机、SSH 端口、本机受控 application 认证文件及 known_hosts 位置），或共同在实际节点所在宿主执行 A2 合成验证。配置不进入仓库/Issue/日志，不放宽 host key 校验、不借维护身份执行应用命令。

可交给 C1 主责的交接内容：“A2 的草稿→检查→确认→分配/暂停合成链及 C readRuntime 接口已就绪，请提供 A 端可用的受认证连接配置，或配合在你运行 C1 的机器上执行 A2 正向验证。只需 readiness，不需要发送私钥/密码/token。”

联调需确认节点运行已验收的当前 C 源码/profile/validator-v2；如最低 BOM 修复影响节点指纹，由 C 在其获准维护范围同步和重新验收，A 不部署或修改节点。A 端配置 sshRunner 的 binary/host/port/keyFile/knownHostsFile，调用 readRuntime；用其真实 profile/恢复代际在全新十七表合成库，经当前教师 Session 执行 checks→release→assign→pause，核原回执、固定内容和真实 readiness 绑定。合成账号/正文仅本地临时库，无模型/执行作业/真实学生数据；库保留。只提供旧 ready 截图/作者结论不能代替本次执行。

### 12.3 状态、限制与汇总请求

新增服务端实现与本机合成验证已经执行；最终两轴审查及修复复核已完成；真实 C1 正向开放联调和远程 PR 尚未执行，A2 全部完成暂未确认。真实教师课程内容审阅、A3 AI 接入、C2 整体作品链、C3 Action 最终投递、C5 旧备份/可靠恢复登记、UI/真人与完整 AC/NFR/G1～G4 分别保持原阶段，不能凭合成通过宣称完成。

待授权维护者汇总 MVP_SPEC §10：A1 同 tx 真实授权与 C 记录适配，A2 公开服务端固定版本/分配/控制及统一验证结果；本次不修改保护基线。按负责人“完成全部后分别 PR”的要求，保留本地独立候选与源码历史，真实 C1 验证未补齐前不提前发布 A2 完成 PR。
实施前对齐细化：C 现交检查为 validator-v2，A2 新规则配置按该确切版本消费，不给旧 v1 判断改贴标签。C1 authenticated readiness 还返回 fingerprint/validation；A2 除消费 C readRuntime 的 Profile/代际核验外，将核 validation.passed、其 fingerprintHash 与实际 fingerprint UTF-8 JSON 摘要一致，并在固定 activity_json 保存内部只读来源元数据 fingerprintHash/sourceHash/validatedAt/checkedAt。此为 §11.1 已批准的指纹/有效结果/确切来源核验，不增加表/列或公开输入，不向学生输出节点内部数据；readiness 缺证据/指纹冲突拒绝新开放，合法原回执仍先重放。合成夹具补足对应来源字段，不计真实节点通过。
真实节点验证入口细化：沿已经批准的 app.inject/新十七表库，增加 XUNJIE_A2_RUNTIME=1 才执行的专属用例；从 XUNJIE_A2_SSH_CONFIG 指向的既有受控 JSON 读取 sshRunner 五个配置字段（binary/host/port/keyFile/knownHostsFile）。仅调用应用 readiness，不运行 acceptance 的维护/Engine/代际操作。未启用或没有已授权配置时不把合成 ready 转成真实通过；本机默认明确跳过。可由 C 在实际宿主准备授权入口后执行，不要求私钥进入仓库或聊天。测试用真实 Profile/代际配置合成草稿，走 checks→release→assign→pause；仍不涉及真实课程/学生/模型/执行作业。
C1 主责可在实际节点所在、已授权且具备精确依赖的宿主工作副本运行以下命令（Node 24.21.0 已在 PATH）；配置文件由节点负责人通过受控方式提供，不提交到仓库：

```bash
XUNJIE_A2_RUNTIME=1 XUNJIE_A2_SSH_CONFIG="由C提供的受控配置文件路径" node --test --test-name-pattern='real authenticated C1 readiness' apps/teaching/tests/design-activities.test.ts
```

将命令中的“由C提供的受控配置文件路径”替换成实际本地文件名。文件只包含 binary/host/port/keyFile/knownHostsFile 五项连接设置，不包含密钥正文；本机节点的值来源见 C1 §14.1/14.2，跨机器地址由 C 交接，不能把 127.0.0.1 当远程地址。该命令仅执行一个真实 readiness 业务链用例；输出显示通过后，C 主责交回所用源码 commit/Node 版本/实际通过摘要和 C 验收状态，不传配置或凭据。失败完整保留，不能以省略该用例、手工设置 ready 或作者历史通过替代。
### 12.4 当前候选验证与审查入口

C 原提交与 A1 全局幂等修复均已通过普通 merge 消费，批准规则对齐 validator-v2。A2 readiness 指纹反例先失败 200（不匹配证据仍能开放）→修复后 422 INVALID_REFERENCE；证据缺失/未通过也拒绝新确认。实际服务端校验 validation 与 fingerprint 摘要/来源/时间，固定版本存只读来源元数据，公开 student/tutor DTO 不下发；没有改 C 传输/公共状态或 schema。

最终联合工作副本已执行 npm run typecheck 通过；npm test/pretest build 通过：**157 项中 151 通过、0 失败、6 跳过**，约 48.07 秒。A2 新业务文件 8 个合成用例通过，真实受认证 C1 用例未启用、明确跳过；另五项 Linux/节点跳过沿 A1 §14.2，不计通过。测试仅保留合成库，无网络/真实节点/模型/容器执行。文档/检查器/空白复核及独立两轴审查接着进行，不能把尚未执行项表述为完成。

A1 本地增量 Standards/Spec 已各关闭原 P2，未解决 0；A2 独立审查固定 A1 038a66e 作为上游，对本分支准确新增 diff 审查。早期总体基线 9221370 保留来源历史；此次 C1/C2 与 A1 增量已经分别审查，避免把来源代码计入 A2 所有权。
交付自检补充：配置/指纹错误发生在事务外 readiness 时也必须保留合法原回执先重放，不能让节点当前故障阻断已提交命令的原结果。按 §11.1/TECH §5 的既有幂等语义，将节点错误保留为新业务回调的拒绝原因，事务内当前授权/代际/原回执先核；新确认/检查仍严格拒绝错误，网络不进入 SQL 事务。补公开 release/checks 原键、人工编辑后和坏指纹下重放的反例。
A2 独立审查首轮：Standards 硬性违反 0、可操作 smell 0；Spec 发现 1 项 P2，节点坏指纹阻断原回执，与交付自检一致。已将节点查询失败延至新业务回调，保持事务外网络、事务内当前授权/代际及原回执优先。反例实际先失败（release 无原 data）→修复后 release/checks 在草稿更新和坏指纹下原键返回完整原回执；新 release/checks 仍 422 INVALID_REFERENCE。针对性 9 项中 8 通过、0 失败、1 真实节点跳过，typecheck 通过；全量与增量审查接着执行。
### 12.5 最终本机验证与两轴审查结论

候选 7bd1d7cca714a572eabd94c41f76795277f543a9 已完成 npm run typecheck 和 npm test/pretest build：157 项中 151 通过、0 失败、6 跳过，约 48.16 秒。真实 C1 专属业务链未启用、未执行；其余五项仍为节点/Linux 专属检查。本次用例保留全新合成库，没有执行真实模型、学生作品或节点维护操作。静态文档检查 28 文档/325 内部链接/27 基线路由通过，检查器回归 16/16 通过，git diff --check 通过。

| 审查轴 | 首轮结论 | 修复及增量复核 |
| --- | --- | --- |
| Standards | 硬性违规 0、可操作异味 0 | 996d10f…7bd1d7c：硬性违规 0、可操作异味 0 |
| Spec | P2 1 项：坏指纹提前阻断合法原回执 | 已修复；公开反例验证原键成功与新请求拒绝，增量未解决 0 |

本机可独立的批准实现、验证、审查和交接文档已收口。A1 当前候选为 codex/a1-complete（30fd2b1），A2 为 codex/a2-complete；A2 精确差异以 A1 为上游，保留独立提交及所有来源历史。A2 完整完成仍须本次真实受认证 C1 readiness→检查→确认→分配→暂停正向验证；当前没有连接配置或正向结果，不能以合成通过/跳过/作者旧验收替代。待 C1 主责交接配置或共同执行，取得实际结果后再按项目负责人要求分别提交远程 PR。尚未推送、创建 PR 或合并远程代码。
### 12.6 PAHER 真实 C1 指定联调证据接收与完整服务端收口

项目负责人交回 C 主责本次实际记录及 C1 §17/18 说明，明确准许 A 消费，不能将附件中的维护说明当作 A 的新操作授权。C 在 PAHER / WSL2 Ubuntu、Node v24.21.0、npm 11.19.0，对源码 `8421157d7e917067b397d76378ed91096c4a8369` 和 A 所交同摘要 bundle 实际执行 npm ci/typecheck/build，各退出 0；指定真实 app.inject 用例 **1 通过、0 失败、0 跳过**。未复跑全套 157 项或浏览器/TCP/TLS，不把未匹配用例计为通过。

原字节证据已纳入 A 自有测试证据目录：[TAP 输出](../../apps/teaching/tests/evidence/a2/acceptance.a2-integration1.txt)、[联调信封](../../apps/teaching/tests/evidence/a2/acceptance.a2-integration1.evidence.json)。仅该目录 .gitattributes 标记 -text 保留原字节/hash，并声明 CRLF 为合法行尾（仍检查真实尾空格），不改根配置、C 源码/记录或任何凭据。TAP SHA-256=`92c2709c311692f7603f7880544f4387043c7b8a599acc36b40e92db9e810103`，信封 SHA-256=`9c67fa89466cf19188f92d1d3918949a6223d6c8f93dfce8387b28814eb6330f`。A 已重算并核信封 sourceCommit/bundleSha256/Node/退出码/1-0-0 与 TAP，fingerprint 紧凑 UTF-8 JSON SHA-256 与 validation 一致，固定活动 runtimeReadiness 与实际节点同摘要/来源/validatedAt。

本次节点 kernel=6.8.0-146-generic，profile=c17-gcc15.3.0-textscope-v1，fingerprintHash=`02351c15ef9683d19ebb6b2b8ed079a28e2f6e51f888e3e31a9cd99c3b14b42b`，sourceHash=`0869fdbeb71287d22cfecaf6424abf4ed79db9a98ef687de91f7ff6ad2520e36`。validatedAt=2026-10-10T11:14:23.572Z（19:14 +08:00），固定活动 checkedAt=2026-10-10T11:24:10.622Z（19:24 +08:00）。C 已对变化内核重验，联调后实际 ready=true；只支持该次事实，不表示永久 ready 或 A 当前机器可以访问。

经 POST /api/sessions 真实教师/学生登录，真实应用 SSH readiness→checks→release→assign→学生读取固定活动→pause→学生 assignment active=false。结束后 C 对保留新合成库只读核：17 张应用表、Session 2、ActivityVersion 1、Assignment 1、Event/Receipt 各 7；活动/分配 revision 均 2 且 paused，paused_by_activity=1、individual_paused=0，Attempt/Job 均 0。没有学习运行/模型/节点部署、跨机 key 分发或旧库迁移；未由 A 重开 PAHER 数据库，持久核对来自 C 本次信封，A 不伪称自行执行。

测试后至本节接收仅新增交接说明/证据/文档；8421157 的业务源码与当前候选完全一致。A 原本机全量 151/157（6 跳过）和 PAHER 本次 1/1（0 跳过）分别报告，不改写为一次 152/157。批准 §11 范围的实现、权限/事务/并发/原回执/固定投影、两轴审查和本次真实就绪开放联调现已收口，可按项目负责人既有指令分别创建 A1/A2 PR；C2 全部、C5/NFR 负载、真实账号/教师课程审阅、UI/浏览器/教学效果和完整 G1 仍各自验收。待授权维护者汇总 MVP_SPEC §10，本任务不修改保护基线。

PR 采用依赖链 C1 #16→C2 #17→A1（base=codex/c2-workspace-core）→A2（base=codex/a1-complete），保持实际领域增量；推送/创建后记录 URL 与远端 SHA。普通推送/创建 PR 已获项目负责人授权，不合并、改凭据或自动关闭 Issue。

交付文档复核：吸收 A1 收口文档时 README 同一区段发生普通 merge 冲突，冲突未处理的中间状态文档检查失败、检查器 12 通过/4 失败。已保留 A1 当前完整入口及 A2 最新区段解决，不重写源码/历史；解决后重新执行检查，结果随交付记录登记。
最终交付增量检查：解决 README 冲突后，静态检查 29 文档/331 内部引用/27 基线路由和检查器 16/16 通过；两项 PR 精确差异 git diff --check 通过。Git 中保存的 TAP/信封摘要与收到附件原字节一致；与真实验证源码 8421157 比较，server/contracts/runner/业务测试/package/lock 无变化，不重复运行已通过业务回归。最终 Spec 增量未解决 0；Standards 发现 1 类 P3（授权者用聊天指代），已改为明确项目角色“项目负责人”，保留原话及范围，等待原审查者确认关闭。
