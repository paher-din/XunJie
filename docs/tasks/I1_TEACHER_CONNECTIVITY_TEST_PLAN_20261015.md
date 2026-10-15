# I1 教师端前后端连通性测试方案

## 1. 任务、依据与状态

日期：2026-10-15（Asia/Shanghai）。负责人请求：制定教师端功能前后端连通性测试的详细方案。

**本次交付是测试方案，未执行本方案的业务测试，也未据此授权迁移、部署、真实模型调用或真人试点。** 本文件由 A 汇总；执行职责沿既有 A/B/C/UI 分工提出，不改团队排程。可写仅本任务记录；应用源码、凭据、数据库及产品/规划/参考/规范均只读。

固定检查基线：`main@4ea3c73e70a6ad334476d54315c58e806b06cae8`。工作区无已跟踪文件差异，既有未跟踪文件保留。执行前重新登记实际前端产物、后端版本及环境；不能仅以本机 Git HEAD 代表运行中的服务。

已读依据及适用编号：

- [PRD](../product/PRD.md) §4.1～4.5、§5、§7～8：PRD-01/02/06/07/08/10，教师设计、正式判断和学生自主操作边界。
- [MVP_SPEC](../product/MVP_SPEC.md) §2、M-01/02/07/08/09/10、§4～7：AC-01/02/06/07/08/09/12/13/16，NFR-04/05/06；模型设计、真人评价和完整 NFR 分开验收。
- [TECH_DESIGN](../product/TECH_DESIGN.md) §3.3、§4.3～5.1、§7.1～7.4：角色裁剪、命令回执、各自版本、事务、纠正失效和恢复。
- [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) §1～2：A/B/C/UI 职责；本方案不重新任命维护者。
- [教师工作台](I1-TEACHER_UI_WORKBENCH.md) §1～6.9、[原始证据索引](evidence/teacher-workbench-20261015/README.md)、[验证工具](../../tools/teacher-workflow/README.md)：当前真实交付与历史结果。
- [UI 规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §2～5、[来源记录](../../apps/student/IMPORT_SOURCE.md)：复用现有 UI，隔离预览、原文与确认版本、原命令恢复。

## 2. 测试目标与当前可用范围

通过标准是：**教师在真实页面发起操作，经真实认证和接口写入服务端，刷新或新会话能够回取同一结果，学生侧能看到被授予的真实结果，历史版本与权限保持正确。** 页面跳转、HTTP200、弹出成功提示均不足以单独判通过。

当前源代码已交付：

| 范围 | 页面及主要实现 | 真实接口（均为 `/api` 前缀） |
| --- | --- | --- |
| 登录与教师身份 | 共享登录、教师深链；`workspace/session.ts` | `GET /session`、`POST /sessions`、`POST /logout` |
| 概览、课程、项目、学生清单 | `teacher/TeacherApp.tsx`、`backend.ts`；服务端 `server/app/teacher-workbench.ts` | `GET /courses/:id/teacher-workbench`，聚合成员、材料、草稿、活动、分配、尝试、预设和恢复代际 |
| 课程材料 | `teacher/MaterialsPage.tsx`、TeacherApp | `POST /courses/:id/resources`；工作台重读；`GET /resources/:id` |
| 草稿创建、保存、后续复制 | `teacher/LiveDesignPage.tsx`、backend | `POST /courses/:id/blueprints`（manual/copy）、`PATCH /blueprints/:id` |
| 设计检查和三角色预览 | LiveDesignPage | `POST /blueprints/:id/checks`、`GET /blueprints/:id/previews?audience=student\|tutor\|teacher-validator` |
| 固定发布和学生分配 | LiveDesignPage | `POST /blueprints/:id/releases`、`POST /activities/:id/assignments` |
| 学生进入、确认与提交 | 现有学生工作区及 `workspace/submissionFeedback.ts` | bootstrap/attempts、`POST /attempts/:id/sync`、`/snapshots`、`/submissions`；`GET /attempts/:id/recovery` |
| 教师审阅及原始证据 | `teacher/LiveReviewPage.tsx` | `GET /attempts/:id/review-context[?submissionId=…]`，按引用读取 snapshots、runs、resources、learner-state 等 |
| 正式反馈及同线程修订 | LiveReviewPage | `POST /attempts/:id/feedback`；学生 `GET /attempts/:id/feedback` |
| 确认、纠正、暂缓主张 | LiveReviewPage | `POST /attempts/:id/reviews`；学习状态重读 |
| 许可及学生主动修订 | LiveReviewPage、学生提交与反馈面板 | 教师 `POST /attempts/:id/reopen`；学生 `POST /attempts/:id/controls`，`control.kind=resume_revision` |

上表是当前代码映射，不表示本轮已经实测。前端相对路径在统一客户端中加 `/api`；执行证据记录完整路径，不能混淆 `/__i0prep`。

以下必须单独保留：

- `/#/teacher/preview` 是开发交互预览，写当前标签页的预览存储；不用于真实后端连通性通过统计。当前5601页面属于此类。
- 正常 `/#/teacher` 才走真实 Session 与服务端；当前实现的设计 AI 预算关闭。预览“示例建议”不算真实模型起草。
- AI 根提案/局部提案、试评量规、教师样例运行、真实课程导出、暂停/恢复等产品能力：逐项核实际页面和宿主。即使底层存在接口，也不自动算 UI 已连通；没有真实控件时记 `GAP-UI`，没有路由/所需宿主时记 `BLOCKED-HOST`。
- 设置页主题为浏览器偏好，预览 JSON 导出为本地示例导出；不将它们算作真实课程导出。

## 3. 环境选择与进入条件

### 3.1 三种环境分别记账

| 环境 | 可测事项 | 不能据此宣称 |
| --- | --- | --- |
| 开发预览 `http://127.0.0.1:5601/#/teacher/preview` | 页面、字段、导航、布局、键盘、预览交互 | Session/SQLite/真实发布、真实反馈或模型连通 |
| 已准备的本机真实合成环境 `https://127.0.0.1:3444/#/teacher` | 本方案主链及已授权故障验证 | 真人教学效果、PAHER 共享环境也已通过 |
| PAHER 共享环境 | 只测该环境实际交付和批准的能力 | 与本机41表复核宿主相同；允许直接迁移共享库 |

本会话此前只读核对：此机缺少文档指定的 `/opt/xunjie-ui-local` 和 `/opt/xunjie-runner`。该检查是当时快照，执行前重查；他人已完成的本机环境不是此机已具备环境的证明。当前不具备入口时将真实链标阻塞，先完成静态、单元和隔离服务测试，不自动搭建替代服务或改用预览凑数。

### 3.2 真实写入前的检查清单

1. 维护者明确本轮 origin、环境所有者、数据库范围和可写合成课程；同一3444若被其他服务占用，不关闭或复用未知进程。
2. 受控环境已有精确41表复核组合，启用 review 和 teacher-workbench；默认35表宿主不能代替。核验由维护者提供只读收据，不在本轮测试中执行 DDL。
3. 登记前端静态入口及摘要、后端提交/部署清单、Node24.21.0、两个 lockfile 摘要、数据库模式/恢复代际、浏览器版本与时间。前后端版本不同可以测试，但必须明确组合并与实际加载一致。
4. 严格 TLS 的 `/health/live`、`/health/ready` 均满足当前宿主正常条件；静态和 `/api` 同源，无浏览器证书绕过，无未知反向代理目标。
5. 教师真实登录，`GET /session` 返回预期身份与任教课程；`teacher-workbench` 返回匹配的 courseId、非空 recoveryGeneration、真实成员及预设。只读读取前后无新增 Attempt、Job 或正式反馈。
6. 教师与学生使用独立浏览器上下文/配置文件；两个普通标签页仍共享 Cookie，端口不同也不隔离同主机 Cookie。禁止一方退出导致另一方换身份后继续误测。
7. 使用现有合成账号和合成材料，密码由本人受控领取。A/B/C/UI 维护者确认没有在同一对象并行操作。
8. 现有备份/恢复负责人、备份标识、测试产物位置及故障恢复方式已登记；不现场覆盖现用库或删除历史。任何恢复演练另列对象和授权。
9. 关闭教师和个人模型调用；本方案主链不需学生实际编译/仿真。模型/运行联测如另行纳入，核对应预算、节点与用途授权。
10. 禁用测试中的成功响应替身、请求改道和 fixture 回退。负面故障注入可阻断/延迟真实请求，但不得伪造业务成功；此类结果单列。

## 4. 数据与记录准备

每轮生成唯一 `runId`，项目名使用 `教师连通性-C/HDL-绝对日期-runId`，避免与历史截图及其他人项目混淆。所有对象保留，不自动删除。

| 数据 | 最小配置与用途 |
| --- | --- |
| T1、S1 | 现有负责教师和所属学生，各自独立会话；完整闭环 |
| S2、T2、第二课程 | 使用已获准现有测试身份验证同课他人/外课边界；若缺失，在隔离服务 fixture 中验证并将浏览器用例保留阻塞，不临时冒用真人身份 |
| C、HDL 课程及预设 | 各建一套独立草稿/活动/分配/尝试；使用服务端返回的实际 ID 和已确认配置，绝不复制历史 ID 到新环境 |
| 公开材料 | TXT、Markdown、粘贴各一份合成文本，含中文、非BMP字符、换行；记录 UTF-8 字节数和 SHA256 |
| 私有材料 | 独有合成标记的 private_answer、validation_asset，用于在学生/辅导投影和网络载荷中查泄露；不使用真实标准答案 |
| 两版作品 | 同一文件两次明确编辑并确认，保存实际原文和各自 SHA；不把输入串、Monaco显示值、trim后正文当成服务端权威原文 |
| 可复核主张 | 只复用获准合成证据已有主张；没有时用隔离契约 fixture 验证确认/纠正/暂缓，真实浏览器主张用例记 BLOCKED-DATA，不造模型观察或教师判断 |

对象台账至少保留：courseId、resourceVersionId、blueprintId/revision、activityVersionId/sourceRevision、assignmentId/revision、attemptId/revision、workspaceRevision、snapshotId/hash、submissionId、feedbackId/threadRevision/feedbackRevision、learnerStateRevision、grantId及 recoveryGeneration。

## 5. 每个用例统一的判断方法

每次写入按下面五步留证：

1. **操作前**：登记当前对象、版本、账号、页面和预期状态；必要时取只读基线。
2. **页面发起**：由测试者点击真实控件；自动化仅在批准的隔离合成范围内模拟。真人学生学习阶段由学生本人操作。
3. **请求与回执**：核方法、路径、预期版本及代际；请求携带有效 Session/CSRF 和固定幂等键。成功信封有 requestId、data；教师命令回执核 commandId、receiptId、identity.actorId/原幂等键/代际以及 result 的目标和版本。
4. **重新读取**：通过获准 GET、刷新、独立会话或受控重启回取同一业务 ID、原文摘要和状态。HTTP200但回执不完整、对象越界或版本错，均为失败。
5. **另一端及副作用**：学生或教师另一端读取一致；核单一创建、正确事件/有效状态、历史不变。数据库审计仅维护者 mode=ro 按具体对象最小读取，不导出认证行。

幂等键等关联标识必要时只保留摘要。Cookie、密码、CSRF值、Authorization、供应商Key不进截图/日志/报告；不直接保存未经裁剪的 HAR 或浏览器 trace。只写“存在且有效”，不写秘密值。

## 6. 第一批：真实主链（C、HDL 各独立执行）

以下用例初始状态全部为 `NOT_RUN`。建议先完成一课纵向冒烟，再复测另一课；任一关键环节失败先保留现场，不继续制造下游状态。

| ID | 操作步骤 | 必须看到的结果与证据 |
| --- | --- | --- |
| TC-01 | 未登录直达 `/#/teacher/review`；用T1登录；刷新；退出后重开深链 | 登录恢复目标入口；Session角色来自服务器；退出后不残留可读教学正文，重登恢复本人数据 |
| TC-02 | 打开概览，切换课程、项目筛选和学生列表；记录前后计数 | 只读实际任教课程；真实零与未知区分；读操作不创建尝试，不排模型；页面统计与工作台明细可核对 |
| TC-03 | 导入TXT、Markdown、粘贴各一份；保存后刷新并查看正文 | POST真实落库、resourceVersionId稳定、正文/字节/hash正确；三项用途默认false；读取中不可被迟到文件覆盖人工输入 |
| TC-04 | 导入合成私有答案/验证资产，尝试勾学生/辅导用途；关联新草稿 | 两用途强制关闭，教师设计用途单独表达；直接恶意请求也不得扩大权限；所有投影不泄露独有标记 |
| TC-05 | 选实际课程预设创建新项目，编辑简报、目标、任务、观察、里程碑、量规、政策和资源；保存 | manual创建独立草稿，revision从服务器取；各级目标引用/版本关联完整，回执指向当前课程 |
| TC-06 | 修改草稿并再次保存，刷新或重新登录打开 | PATCH使用最新expectedRevision，revision前进；只改指定内容，正文/关联保留；未保存变化不得显示为已存 |
| TC-07 | 在草稿中去掉核心目标观察关联/必需字段后保存并检查；再补齐 | 三类结果分开：阻断、教师疑点、未验证；报告绑定当前revision；阻断时不能发布，修复后重新检查；不把unknown当通过 |
| TC-08 | 切换学生/辅导/教师验证器预览，检查公开及私有材料；保存新revision再预览 | 三次GET实际执行角色裁剪，预览对应同一当前保存版本；私有正文不在学生/辅导响应中；过期预览不能确认新版本 |
| TC-09 | 确认当前检查并发布；回列表打开固定活动；修改源草稿后再读活动 | release回执含独立activityVersionId和sourceRevision；原活动内容、政策/规则/资源/执行配置引用和序列化摘要不变 |
| TC-10 | 明确勾选S1并分配；刷新项目详情；S1登录看任务 | assignment只指固定活动及所选学生；教师不代学生建Attempt；S1看到同一任务，未选S2不获权限；重复点击不重复分配 |
| TC-11 | S1从真实列表进入，明确创建尝试、编辑并确认作品、冻结快照、填写说明后提交 | 保存ACK与原文一致，snapshot1/hash1固定，submission1指它；submitted阶段只读；T1重新读审阅列表出现该提交 |
| TC-12 | T1按尝试打开审阅，选择submission1，展开固定作品及原始证据 | review-context/artifactSnapshotId、文件原文/hash与提交一致；作品、三能力线、帮助、自述、反证/未知分开，无主张显示未知 |
| TC-13 | 先不选固定作品/不写理由尝试提交反馈；补齐后保存正式submission_review | 不完整输入无成功写入；有效反馈绑定submission1，feedbackId和两种反馈版本有回执；submitted→reviewed与反馈同事务 |
| TC-14 | 选择原feedback线程，修改正文并保存反馈修订；学生读反馈 | 同feedbackId、threadRevision前进，范围feedbackRevision按实际范围前进；旧正文仍可追溯；学生读到准确新正文/依据/当前标记 |
| TC-15 | 教师按最新提交给修订许可；学生先只查看，再主动点修订 | 发grant后仍reviewed且作品只读；学生明确resume_revision后active、grant consumed；不是教师点击就自动重开 |
| TC-16 | S1编辑第二版、确认、冻结snapshot2、再次提交；T1读最新及旧提交 | snapshot2/hash2、submission2与首版不同；按旧submission1读取仍为snapshot1原文/hash1；最新审阅指submission2，反馈历史保留 |
| TC-17 | 教师从审阅复制为后续项目，明确核来源，再保存、检查、发布并分配；S1主动开启新尝试 | 复制新blueprintId且source关联精确；UI说明复制的是当前来源草稿revision（可能不同于原活动固定revision）；新活动/新Attempt独立，旧活动/提交不变 |
| TC-18 | 对后续尝试读取相关、无关、撤回的历史；刷新两端并核台账 | 仅同课程/适用目标的有效状态进入上下文；无迁移证据保留未知，旧错误主张不复活。后台上下文验证与页面读取分别记证据；没有真实AI输出不宣称个性化效果 |

HDL链同时核对其固定digitalLogicConfig/runtime引用，不能把C预设作为HDL发布；本批不因能提交HDL源码就宣称构建、板卡、仿真已通过。C链也不以源码返回0或保存成功代替课程检查。

## 7. 第二批：权限、并发与失败恢复

所有故障在获准隔离环境执行，保留原状态。不在共享服务上断网关、重启进程、改数据库或制造全局故障。

| ID | 安排与步骤 | 通过判据/执行层 |
| --- | --- | --- |
| TX-01 | S1直接打开教师深链并尝试教师读取/写命令；T2请求外课材料/草稿/审阅 | 服务端拒绝，既不返回正文也无副作用；仅隐藏按钮不算通过。真实浏览器＋隔离HTTP负面用例 |
| TX-02 | S2请求S1的提交、快照、反馈和许可；修改URL/query audience或对象ID | 无越权、无存在性/私有正文泄露，不能靠teacher-validator参数提权 |
| TX-03 | 缺/失效Session、错误CSRF或Origin发写命令；操作中会话过期 | 正确拒绝，界面明确要求认证且不显示成功；重登后核原操作，同账号恢复不混用旧Session请求 |
| TX-04 | 材料空正文、非法格式、UTF-8字节超过1MiB、失效/跨课资源引用 | 前端和后端均校验；不能只按字符数；无半份材料/草稿关联。上限边界按实际契约复核 |
| TX-05 | 教师两标签打开同revision草稿；A保存后B旧revision保存 | B冲突而非覆盖；保留人工输入供比较，重读后明确再提交；已发布版本保持不变 |
| TX-06 | 两教师表单读同learnerStateRevision；A确认/纠正/暂缓，B再提交 | 成功有理由/引用、decisionId和新stateRevision；B被拒绝；无原始依据时不能造判断。需真实合成主张，否则浏览器阻塞、隔离服务测 |
| TX-07 | 纠正时已有旧状态的待分析/待投递结果，随后旧结果迟到 | 教师决定、有效状态、相关epoch/失效同事务；旧候选/动作不生效，已展示事实保留。先用既有隔离fixture，不为造此场景调用付费模型 |
| TX-08 | 构造多线程反馈，使范围feedbackRevision与threadRevision不同；修订其中一线程 | 请求CAS取范围revision；返回/显示区分线程版本；重启/重读仍正确。不能只测试两版本碰巧相同的情况 |
| TX-09 | 旧提交仍被选中时尝试正式反馈或发许可；两标签并发反馈 | 具体允许/拒绝按当前批准契约核；不误把当前工作区作为旧提交作品；不绕过最新提交/attempt及范围CAS |
| TX-10 | 快速重复保存/发布/分配/反馈/许可；以原键原正文重试，再以同键不同正文请求 | 前者返回同业务IDs且只产生一次副作用，后者幂等冲突；不按点击次数累加记录 |
| TX-11 | 分别在“请求未发出”及“服务端已提交、响应被丢弃”处断开；刷新后点核对原教师操作 | 未发出不假成功；未知结果保留原正文/原键/目标/账号，先查原结果或重放原命令；不换键重建；确认后方可新编辑 |
| TX-12 | 返回500/503、超时、网络断开、不完整成功回执；另测浏览器存储不可用 | 5xx/未知结果不丢原操作；回执identity/代际不匹配不接纳；冻结命令本地保存失败时不发送；4xx明确拒绝与未知结果分别处理 |
| TX-13 | A学生/提交读取慢返回，先切B学生/课程；或原账号退出再进入另一账号 | 迟到GET/反馈正文/原始证据不污染当前页面；待核命令按账号隔离，当前页面不显示他人私有内容 |
| TX-14 | 已发许可后暂停分配再恢复；学生使用旧许可；教师再次按新版本发许可 | 旧许可actionable=false，恢复不复活；新许可重核最新提交/attempt；阶段不绕过暂停。若UI无暂停控件，在服务集成层测试并记GAP-UI |
| TX-15 | 保持模型关闭或供应商不可用，完成手工设计、保存、检查、反馈与恢复 | 无伪造AI建议/付费调用；业务仍可用；缺失AI能力明确显示，不误标M-01完整通过 |
| TX-16 | 维护者在专用环境正常重启宿主，再登录读原草稿/提交/两版反馈及许可 | 已确认ID、原文/hash、范围与历史保持；未决操作原样核对，无重复副作用。重启范围须先明确，不在当前共享进程实施 |
| TX-17 | 独立恢复演练中代际g1请求延迟，恢复g2后g1回执才到 | 旧回执可记历史，不能安装到g2当前头或绕过RECOVERY_REQUIRED；不取跨代际最大revision。需专门恢复授权，不操作现用库备份 |
| TX-18 | 修改/撤回反馈依据后读取原反馈及历史异议，查看后续状态 | 依据修订/不可用/争议明确标记；旧正文/决定保留；旧版本异议不覆盖新有效判断。有UI则浏览器测，无控件则服务测试并记界面缺口 |

错误判据对齐 TECH §5.1 与实际契约：400、401、403、409、413、422、429、503 及对应error.code/retryable/recovery分别记录；不强制所有失败返回同一个码，不把测试替身里的错误字符串当正式契约。

## 8. 扩展功能与真人测试

| ID | 内容 | 本轮安排 |
| --- | --- | --- |
| TE-01 | 教师AI根草案、局部建议、原文人工编辑保护、用途权限、Job/SSE、取消/旧提案stale | 默认不运行付费调用。先核真实UI控件、宿主预算/模型配置，缺项记GAP/BLOCKED；批准模型/预算/合成资料后另批验收AC-01完整AI链 |
| TE-02 | 样例试评量规、歧义记录、teacher_sample运行 | 查当前UI及公开API，对照原用途/权限；无控件记GAP-UI，底层服务通过不能填UI通过 |
| TE-03 | 课程导出、活动/分配控制 | 分别核真实控件及原接口；导出核私有裁剪、引用/版本/缺口，不拿预览JSON替代。控制场景可复用TX-14 |
| TE-04 | 后续任务实际支持语义 | 工程验证适用历史后，由教师核对真实获准输出/内容；没有调用或输出保持未执行，不以关键字相同/不同推断有效性 |
| TE-05 | 实际教师一次设计→分配→审阅→再设计 | 由负责人本人操作并评价，记录卡点/返工/维护者后台补状态情况；判为AC-13证据需课程内容实际审阅。预览仅记录可用性意见 |
| TE-06 | 键盘及1440/720/390布局、浅深主题、长ID/原文换行、弹窗焦点 | 验证主要流程可操作、无关键遮挡/溢出；布局与功能计数分开；不能用截图替代持久化核对 |
| TE-07 | 性能和故障规模 | 连通轮记录每步耗时/超时。完整NFR另按MVP负载和样本量执行，不以单用户冒烟宣称p95/10会话目标通过 |

建议负责人手工按 TC-01→TC-05～10→TC-12～17 顺序测试教师侧，学生侧交给另一独立会话的测试者。每步只需标“符合/失败/看不懂”，附对象和截图；需要维护者在后台补状态才能继续时直接记阻塞，不让后台补写隐藏问题。

## 9. 现有测试的复用与补齐

### 9.1 已有资产

- `apps/student/src/teacher/backend.test.ts`：原字节/原键恢复、明确拒绝与不完整回执、课程归属；属于客户端隔离检查。
- `apps/student/src/teacher/live.test.ts`：旧读取适配检查；当前主页面使用backend.ts，不能只跑旧适配器就宣称新工作台通过。
- `apps/student/src/workspace/submissionFeedback.test.ts`：学生固定提交/反馈/恢复边界。
- `apps/student/e2e/teacher-ui.spec.ts`：预览/权限/失败/窄屏等协议替身浏览器回归，必须与真实后端端到端结果分开。
- `apps/teaching/tests/teacher-workflow.test.ts`：正常35/41表组合、权限读取、C/HDL反馈与主动修订；应用inject＋真实隔离DB，证明服务集成，不能单独证明浏览器连通。
- `apps/teaching/tests/review.test.ts`、`a5-feedback.test.ts`、`a5-followup.test.ts`：纠正、反馈版本、固定作品与后续状态，按用例选取补充。
- `tools/teacher-workflow/verify-browser.mjs`：真实Chrome、严格TLS、两角色、C/HDL完整链、检查点、旧快照与反馈历史、后续复制。它硬绑定Robert原本机origin/账号/课程及受限初始化入口，不是任意环境通用测试器。

### 9.2 建议命令顺序（执行前核环境；本次未运行）

在 Node24.21.0 与匹配 lockfile 的已有依赖下，先运行：

```powershell
# 仓库根
node tools/teacher-workflow/verify-browser.mjs --course c
node tools/teacher-workflow/verify-browser.mjs --course hdl

# apps/student
npm run typecheck
npm test -- src/teacher/backend.test.ts src/teacher/live.test.ts src/workspace/submissionFeedback.test.ts
npm run build
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
npm run test:e2e -- teacher-ui.spec.ts sessionEntry.spec.ts real-mode.spec.ts

# apps/teaching
npm run typecheck
npm run build
node --test tests/teacher-workflow.test.ts tests/review.test.ts tests/a5-feedback.test.ts tests/a5-followup.test.ts
```

前两条仅打印计划，不读取口令、不联网、不写业务。浏览器测试端口按现有harness检查，冲突时选文档允许的显式覆盖值，不能关闭他人服务；Chrome不存在时记录阻塞，不在本方案中安装依赖或浏览器。

**仅在原已准备环境且执行范围已确认后**，以下才是真实业务写入命令；输出目录是本轮新目录，不覆盖旧证据：

```powershell
# 仓库根；仅供执行者按条件运行
node tools/teacher-workflow/verify-browser.mjs --run --course c --output D:\XunJie\.tmp\teacher-connectivity-20261015\c
node tools/teacher-workflow/verify-browser.mjs --run --course hdl --output D:\XunJie\.tmp\teacher-connectivity-20261015\hdl
```

工具中途失败时按同course、同output和原checkpoint.json使用 `--resume`；先解决未知原操作，禁止换title/新对象重跑掩盖失败。若环境不是工具绑定对象，停止；适配工具是后续单独实现任务。

### 9.3 本方案新增覆盖重点

优先补 TX-05～14 的真实页面并发、断响应、原命令恢复和账号切换；当前已有协议替身和历史端到端结果不代表这些分支已全覆盖。新增脚本仅在后续测试实施任务内完成，复用统一客户端及既有工具，不造第二套业务或写库入口。

## 10. 执行批次、职责与退出标准

建议顺序与工作量为估算，非批准排程；环境缺失、缺少主张或模型许可时不计入执行时长承诺。

| 批次 | 工作 | 主要执行/核对 | 估计活动时间 |
| --- | --- | --- | --- |
| 0 | 版本/环境/账号/数据准入，运行计划预览，确定阻塞项 | A协调、环境维护者核宿主，负责人确认测试对象 | 20～40分钟，环境已具备时 |
| 1 | 客户端、后端专项、构建和协议替身回归 | UI、A、C各自负责；B核模型关闭边界 | 30～60分钟，取实际工具耗时 |
| 2 | C与HDL各跑TC-01～18、台账、真实刷新核对 | UI/A执行教师侧，C或测试者执行隔离学生侧 | 90～150分钟 |
| 3 | TX-01～18，先权限/冲突/未知回执，再授权重启/恢复项 | A权限与版本，C事务/恢复，UI异步与展示，B候选失效 | 90～180分钟；门禁未满足则单列阻塞 |
| 4 | TE-05/06人工体验、汇总缺口及复验 | 负责人本人判断；A汇总证据 | 30～60分钟 |

故障严重性和处置：

- **阻断本轮链路**：越权/私有泄露、覆盖已确认作品或历史、重复发布/反馈副作用、错误账号/代际接纳、无法保存或反馈、假成功。停止受影响写入，保留原对象/请求，安排责任模块修根因。
- **功能失败**：控件有但真实接口未接、版本冲突无恢复、列表/状态错误。对应模块失败，不因其他模块成功而填通过。
- **体验问题**：不改变数据/权限的布局或文案问题单列；若遮挡提交、无法键盘操作或误导确认状态，则提升为功能失败。

退出条件：主链两课所有适用用例有实际结果；确定性权限/历史/幂等/冲突用例零失败；关键未知操作已消歧；刷新/重登证明持久化；没有以跳过填通过。缺少TE能力、TX数据/恢复权限或环境必须逐项列出，最终结论可以是“手工闭环通过，AI/恢复/真人项未执行”，不能写“教师端全功能验收完成”。

## 11. 证据模板、汇总与本次交付

每条结果采用以下字段；写入真实结果时保留首次失败和复验，不覆盖原证据：

```text
runId / 用例ID / C或HDL / 日期时区 / 执行者角色
前端产物摘要 / 后端提交 / origin / recoveryGeneration / 浏览器版本
前置对象及版本 / 操作步骤 / 预期结果
requestId / 方法与路径 / 状态码及error.code / 回执公开ID与关联摘要
实际页面结果 / 刷新或独立读取结果 / 原文hash与旧版本对比
副作用数 / 截图或公开结果文件 / 失败与阻塞原因
状态：NOT_RUN、PASS、FAIL、BLOCKED、GAP-UI、NOT_APPLICABLE
修复提交 / 复验结果 / 仍待确认项
```

NOT_APPLICABLE需写依据，不能把缺实现写成不适用；旧证据引用须标原固定版本和复用原因，不能算本轮新跑。汇总按“本轮计划/实际执行/通过/失败/阻塞/界面缺口/不适用”列分母；预览、隔离服务、真实浏览器、真实模型、真人教师和教学效果分别统计。

公开材料建议放后续实施任务的 `docs/tasks/evidence/teacher-connectivity-日期/`；本地故障细节先留独立受控目录，经裁剪才入库。发现协议/产品规则差异时记录章节、当前行为、影响和建议；不修改受保护基线来匹配实现。产品基线与MVP_SPEC §10：待授权维护者汇总。

本次只制定方案并核对源代码和已有证据入口，未运行上述测试、未调用模型、未操作教学记录、未迁移/重启/部署、未修改README或保护文档、未提交或推送。

文档验证：Node24.21.0执行 `node tools/a0-review/check.mjs`，148份文档、2069条内部链接，errors为空；`git diff --check`通过，无已跟踪文件差异。命令中的现有专项测试文件路径均已核实存在；静态文档通过不表示业务测试通过。
