# I1-TEACHER：教师工作台 UI

## 1. 范围与依据

2026-10-15，Robert 明确要求“根据相关的设计规范以及需要的页面做教师端的 UI”。本任务负责教师前端，沿用 `apps/student` 的 React/Vite、设计令牌、Logo、Solar 图标与主题能力，不另建前端工程、不安装依赖。

已读正文：README；PRD §2–8（特别是 §4.1/4.3、PRD-01/02/06/07/08/10）；MVP_SPEC §2–6（M-01/02/06/07/08/09/10，AC-01/02/07/08/09/13，NFR-04/05）；TECH_DESIGN §1–5、§7.1/7.2、§9；TEAM_WORK_PLAN §1–3 的职责与接入边界；DESIGN 的 Colors、Typography、Layout、Elevation、Shapes、Components、Do's and Don'ts。教师端沿用这些视觉角色，本任务不修改学生端设计基线。

当前基线：`i0/ui-frontend`，HEAD `a1b123537187344503906f7674a3009b1658da0d`；工作区仅有既有未跟踪 `.zcodeignore`，保留，不纳入交付。

## 2. 授权与方案

- 已批准：本轮教师 UI 的页面、导航、布局、视觉和前端交互实现。
- 可写：`apps/student/src/teacher/**`，前端路由/登录入口的最小调整，教师专项浏览器检查，README 的真实入口和本任务记录。
- 只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、各级 AGENTS、教学后端、学生业务实现与既有记录。
- 页面：教学概览、项目与活动、项目设计（目标/里程碑/量规/帮助政策）、角色预览与检查分配、学生进展与证据审阅、课程材料、工作台设置。
- 复用同一前端工程。隔离 UI 预览仅在开发构建开放，使用显式合成数据，所有操作只写本机预览存储；正常模式只取真实会话与已注册读取能力，真实请求失败不回退预览。未注册后台能力保持不可用并明确说明。
- 不修改 schema、共享契约、模型预算、凭据、服务启动或部署；不以 UI 完成宣称完整 M/AC/NFR 或真人试用通过。

## 3. 发现与接线边界

教师设计及复核服务端由 A/B/C 负责。并行只读审计以当前实现为依据：

- `server/access/app.ts` 提供现有 Session/登录/退出；`server/app/digital-logic.ts` 注册教师本课分配读取；`server/design/application.ts` 提供固定活动的 `teacher-validator` 投影。本轮真实适配器仅沿 Session 的教师课程读取分配，按活动去重再读取真实标题/问题/状态；不从分配推导学生开始、提交或掌握情况。
- 正常 35 表宿主组合 `createTutoringApp`，没有组合 `createReviewApp`，复核/反馈业务表与路由尚未进入该宿主；`server/main.ts` 教师 Agent 的 `budgetAvailable` 默认返回 false。前端不变更组合、数据库或预算，不编造反馈成功或真实 AI 生成。
- 缺课程名称详情、成员、材料列表、蓝图列表及教师尝试进展列表。课程显示名复用现有 `displayCourseName` 的本地映射，未知 ID 原样保留。提交/审阅统计用未知值显示 `—`；真实 HTTP 失败保留错误与重新读取入口，不回退示例。
- 材料正文、教师设计 AI 使用权限和学生/辅导可见性分别处理。新导入的三项权限默认均 false；私有答案与验证资产强制禁止学生/辅导可见。教师/验证器预览不受 `teacherDesign` 限制，后者只控制设计 AI 的使用用途。

后续真实接线交接：A/C 提供列表与当前恢复代际入口、装配复核宿主；A/B 对接设计命令/版本检查、教师提案及预算状态；UI 再消费这些接口，保留 Cookie/CSRF/幂等/revision/错误语义。此项是未完成的业务接线，不能以本次预览检查替代。产品基线及 MVP_SPEC §10：待授权维护者汇总。

## 4. 页面与代码

| 路由（预览前缀 `/#/teacher/preview`，真实前缀 `/#/teacher`） | 实现与行为 |
| --- | --- |
| 首页 | `TeacherApp.tsx`：教学摘要、待关注提交、草稿续作、课程卡；所有入口实际可跳转 |
| `/projects` | 活动/草稿筛选、搜索、固定版本详情；课程卡筛选与全局课程选择联动。预览分配保留完整蓝图、选中学生关系及关联材料版本，原草稿后续编辑不改写固定活动；不会代学生创建或开始尝试 |
| `/design/:draftId` | `DesignPage.tsx`：四节蓝图编辑、三能力线、观察/里程碑/量规/帮助/资源、显式示例建议对比、并发字段保护、结构检查、三角色预览、版本确认后合成分配 |
| `/review` | `ReviewPage.tsx`：列表、状态筛选及 `?learner=` 深链，作品/三能力线/实际帮助/自述/未知分开，原始引用、理由/引用必填的决定、提交反馈及显式修订许可；可从反馈打开新的相关活动设计，不复制旧能力判断 |
| `/materials` | `MaterialsPage.tsx`：分类/范围/搜索、正文、TXT/Markdown/粘贴导入、UTF-8 1 MiB 限额与私有资产隔离 |
| `/settings` | 同源主题偏好与本机预览 JSON 导出，明确预览和真实入口的数据边界 |

`main.tsx` 将教师页面作为懒加载路由接入；`SessionEntry.tsx` 复用真实登录、为教师课程账号提供入口，并将仅有教师角色的首页登录导向工作台。准备模式的学生入口保持原行为，真实教师路由仍须认证。`TeacherPreview.tsx` / `demo.ts` 只被开发条件导入，预览数据仅写当前标签页 `sessionStorage`；正式产物不包含示例学生/材料。

视觉复用 `tokens.css`、自托管文楷、Logo 与现有 `Icon`；未增加依赖或修改原资产。侧栏/画布沿 inset 结构、亮底深字状态、32px 操作按钮，并支持浅色/深色、窄屏及 reduced-motion。开发预览服务本轮使用端口 5615，与已有服务分离。

## 5. 验收与交付记录

2026-10-15，本轮实际结果：

| 命令/检查 | 结果与边界 |
| --- | --- |
| `npm run typecheck` | 通过，包含浏览器源码和 Node/e2e 工具类型；运行时 Node v24.15.0 |
| `npm test` | 45 个文件、582/582 通过，包含新增真实读取适配器 4 项与既有学生领域回归 |
| `npm run build` | 通过；Vite 保留大于 500 kB 的 chunk 提示，未关闭或调整检查阈值 |
| 构建后扫描 | 没有 `TeacherPreview` chunk；正式 JS 没有示例学生 ID、私有示例材料 ID 和预览专用正文；预览入口由 DEV 条件移除 |
| `XUNJIE_E2E_PREP_PORT=5625 XUNJIE_E2E_REAL_PORT=5626 XUNJIE_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- teacher-ui.spec.ts` | 现成 Chrome 最终 9/9 通过，26.849 秒；只使用隔离合成状态/合法 HTTP 信封替身。包含概览筛选与搜索、材料默认权限/私有类型/三角色裁剪、异步文件读取保护、草稿保存刷新、固定版本与学生关系回看、原草稿 v5 不改变已分配 v4、证据/决定/反馈/修订、真实权限/失败无回退、720/390 六主要页面和深色主题恢复 |
| 同环境 `npm run test:e2e -- sessionEntry.spec.ts real-mode.spec.ts --output=test-results/session-regression` | 共同入口回归 10/10 通过，15.923 秒；涵盖学生登录失败/键盘/主题/超时/会话代次、准备入口隔离、原数字逻辑演示及真实模式创建/恢复/暂停守卫 |
| Codex 内置浏览器实屏 | 实际查看概览、项目设计、学生列表和材料导入；默认三个材料用途权限均关闭。开发预览标签页保留给 Robert |
| `node tools/a0-review/check.mjs` 与 `git diff --check` | 导航检查与差异空白通过；未修改受保护基线或他人任务 |

首次浏览器执行因本机缺少 Playwright Chromium 启动失败，改用已安装 Chrome，未安装浏览器或依赖。过程中修正了测试的原生 dialog/精确 label 定位及 StrictMode 只读请求次数假设；最终实际页面行为全部通过，未削弱权限、数据或版本断言。整合复核发现并修复了材料读取完成覆盖人工输入、预览分配仅记人数而未保存完整快照两项问题，并追加对应浏览器回归。

未执行：真实教学宿主联调、真实教师 AI 调用、真实反馈写入/数据库装配、真人教师/学生试用与完整 AC/NFR。协议替身检查与预览不能代替这些验收。后续只读/写入接线缺口见 §3。

交付状态：本地源码、任务记录、两份 README 入口与可运行预览已完成，未提交 Git、未推送、未合并、未部署。既有 `.zcodeignore` 保留。测试服务器由 Playwright 管理，本轮 5615 开发服务保留以供交互检查；没有留下下载或安装临时文件。构建产物与浏览器截图为验证产物，不纳入源码写集。仅撤回本任务前端差异即可退回原学生入口，后台、业务数据和课程基线没有变更。

## 6. 2026-10-15 真实教师闭环续作

### 6.1 当前授权与分工

Robert 本轮明确要求：派 `gpt-6-astra`、`xhigh` 子 Agent 优化整体教师 UI 并整合调整；主 Agent 继续将教师端接入真实后端，打通项目设计、分配、学生审阅、反馈修订，并做真实浏览器验证。此项扩大 §2 的前后端实现写集，§1–5 保留为上一轮交付时点，不能当成本轮已接通的证据。

- UI 设计子 Agent 独占：`apps/student/src/teacher/teacher.css`、`design.css`、`review-materials.css`、`ui.tsx` 及必要纯展示组件；改善密度、层级、弹窗与深色/窄屏，不改业务逻辑。
- 主 Agent：`apps/student/src/teacher/**` 的业务类型、真实 HTTP 适配及页面；必要 `workspace/http.ts` 方法扩展；集成、任务记录、README、真实浏览器验证。
- 后端子 Agent：`apps/teaching/server/app/digital-logic.ts`、新 `teacher-workbench.ts`、`server/db/transaction.ts` 的既有 schema 组合、必要 `server/main.ts` 和 `tools/i0-hdl/local-application-host.mjs`，新增精确宿主检查与受控迁移工具。保护基线保持只读，执行建表/迁移等待 §6.2 明确授权。
- 学生接线子 Agent：新增 `workspace/submissionFeedback.ts` 及测试、`components/workspace/SubmissionFeedbackPanel.tsx/.css`；在实际承载真实任务的 `pages/PrepWorkspacePage.tsx` 最小接入；必要 `confirmationWorkspace.ts` 公共重读能力。只补当前工作区的提交、反馈与主动修订，不改学生整体视觉。

继续采用 PRD §4.1/4.3、MVP M-01/02/07/08/09/10、AC-01/02/08/09/12、TECH §4/5/7/9 与 A0 READ-04/08/11/14、A2/A3/A4/A5/C4 已实现契约。学生测试行为仅在本轮隔离合成记录中执行，不计真人教学证据。

### 6.2 待负责人确认的精确接线方案

现有正常服务为 `https://127.0.0.1:3444`，加载 `/opt/xunjie-ui-local/source/apps/teaching` 与 `student-dist`。只读检查确认现用合成库 `/opt/xunjie-ui-local/retained-tmp/xunjie-a12-completion-ubvNXl/synthetic.sqlite` 有 35 表、3 用户、2 课程、3 草稿/材料/分配/尝试、0 提交；没有可复用的完整 41 表库。

提案：

1. 复用 `server/db/review-schema.ts` 已实现的 6 表和 4 索引，在备份并核验现用合成库之后以同一事务加入：`learner_context_revisions`、`learner_state_revisions`、`teacher_decisions`、`learner_disputes`、`analysis_results`、`teacher_feedback`。保留原 35 表的列、数据、账号、课程、分配及历史；精确集合 35 → 41，不放宽为任意超集，不删除/重置旧库。先完成检查/备份/迁移工具和可审查实现，批准前不执行建表或迁移。
2. `createDigitalLogicApplication` 以显式 review 配置复用 `createReviewApp` 为唯一应用基座，沿用原认证、workspace、Job consumer、SSH/运行就绪、HDL 和关停；缺省 35 表模式维持原行为。
3. 增加只读教师投影 `GET /api/courses/:id/teacher-workbench`：任课教师认证后返回当前恢复代际、课程成员 ID、材料/草稿/固定活动、实际尝试/提交摘要及已批准的 policy/rule/runtime 选项。只聚合既有域读取，不返回口令、会话、模型凭据，不据日志数量推断能力；错误仍按现有信封。原已有设计/PATCH/检查/角色预览/确认/分配、review-context/reviews/feedback/reopen 与学生 submissions/controls 保持现有语义。
4. 同步本次精确源码与构建到上述已有本机副本，用原入口重启 3444 并做隔离合成浏览器链。保留现有 TLS 信任、执行节点、账号与数据；不做公开部署、不改凭据、不启用付费教师模型。教师 AI 的真实起草仍保留预算关闭状态，手工设计与既有固定配置先完成真实闭环。

风险与回退：新增复核持久化会改变该合成库表集合，旧 35 表宿主将拒绝打开 41 表库；因此先留可核验的原库备份与旧源码/静态产物，任何失败保留现场并停止写入，不自动删除或回写旧备份。正常数据不可混入演示 fixture，未知结果重读原回执，不换键重复执行。

§6.2 当前为提案，等待 Robert 明确同意上述数据库对象和新增读取契约；代码与前端的独立准备继续。产品基线汇总仍为待授权维护者汇总。

### 6.3 本轮批准记录

2026-10-15，Robert 对 §6.2 的完整对象和范围明确回答“批准按该范围实施”：授权核验备份后给上述现用本机合成库加入既有 6 表/4 索引，35 → 41，保留旧库/旧应用备份、原表与全部数据；新增任课教师只读 `teacher-workbench` 投影；同步本次源码和静态产物后重启本机 3444 做隔离合成浏览器验证。该批准使 §6.2 从提案转为实施依据；未扩大到公开部署、凭据变更、付费教师模型或保护基线修改。

实施期间前端、后端和学生工作区写集按 §6.1 分开，新增DTO保留既有命令/状态/revision/权限语义。实际切换将在代码与前端构建就绪后统一进行，不在旧35表宿主仍运行时迁移。验证、失败和真实链证据在后续追加。

### 6.4 与共享数据会话的协调和来源整合

2026-10-15，Robert 指定与“实现登录与会话进入流程”会话协调数据库方向，已实际沟通并取得一致边界：PAHER 是团队共享演示数据源，由该会话维护；本任务只负责已有本机 3444 合成环境的教师工程验证，不迁移、同步或重启 PAHER。该会话确认没有触碰本任务本机库，且 PAHER 没有待执行变更。

接纳共享数据 [PR #89](https://github.com/paher-din/XunJie/pull/89)，主线合并提交 `d77c9cc8efdab1a55c54c5b711f2cf8fce8f1ed3`（实现 `92a128e`、文档 `c9b2e74`）。本地 `i0/ui-frontend` 从 `a1b1235` fast-forward 至 `d77c9cc`；自动保留本任务 tracked 工作的 autostash 为 `243592d`，未删除。仅 README 导航存在冲突，已并列保留共享入口、独立前端验证与教师入口；后端重叠文件自动接纳后再次类型/专项复核。全部当前任务变更保持工作区状态，未生成本任务提交或推送。

共享基线新增可选 `users.display_name`、`courses.name`、`assignments.display_title`，但本机旧库没有这三列。§6.3 的迁移范围仍仅为六表/四索引：本轮通过只读列检测兼容旧库，列存在则读取后端真实名称，缺列则省略展示字段并保留原 ID/Activity 标题；不恢复按合成 ID 硬编码姓名，不额外 ALTER 本机库。PAHER 的显示列迁移和统一学生账号不作为本任务本机数据库来源，也不从本机回写共享库。

后端专项最终 5/5 和 Node24.21.0 类型检查通过，覆盖旧显示列缺失时 Session/courses/assignment/bootstrap/workbench 的原权限读取、新列真值/空值，以及 C/HDL 提交—反馈—许可—学生主动修订；浏览器 DTO 与十组实际后端 JSON 类型在教学工程类型检查中双向核对。前端本轮全量单元检查 47 文件、594/594 通过；随后修正教师回执按实际 `CommandReceipt.identity` 核验 actor/代际/幂等键，专项 3/3 通过。上述均不替代正在准备的实际本机浏览器链。

### 6.5 本机切换与真实链实施记录

2026-10-15，本机旧源码/工具/静态文件共 394 份逐 SHA 备份并复核于 `/opt/xunjie-ui-local/evidence/teacher-cutover-2026-10-15T05-27-28-669Z`，备份 manifest SHA256 为 `35b7d512089a2a6e0f0b4fbdd0a9b29a7fa47d9be8e26d16592f37f6ef497670`。首次备份枚举失败留下不完整目录，保留为失败现场；使用的是上述后续完整核验目录。

原宿主 PID 4268 确认退出后执行 `enable-review.mjs --apply`：迁移前 SQLite backup 位于 `/opt/xunjie-ui-local/evidence/review-migration-2026-10-15T05-28-39-769Z/before.sqlite`，SHA256 为 `44aac6653521cd7867379b551d29aff85cb9b4ec2f5773e30a33c696687e31ae`。加入原六表四索引后精确 41 表，完整性 `ok`、外键问题 0，原 35 表逐表行数保持。`users.display_name`、`courses.name`、`assignments.display_title` 仍不存在，没有扩大 DDL 范围。旧源码/静态保留，源码同步排除依赖与凭据，静态仅覆盖当前产物并保留旧 assets。

首次启动 live=200、ready=503。排查确认两种 SSH readiness 与原代际正常；现用库三条历史终态 `student_help` Job 带有原 owned 宿主已支持的 `inactivityTimeoutMs` 元数据，当前主线严格持久读取不认该属性。为恢复本次同步造成的历史读取回归，`contracts/records/index.ts` 与 `server/db/records-adapter.ts` 恢复严格整数范围，限定终态 `student_help` 且 deadline 晚于 accepted；queued/running 等不接受旧模式。未改写历史 JSON、未启用旧续期模式。记录专项 6/6 通过；80 个原 Job 与迁移前备份逐条比较字节变化 0。切换后的 PID 899 严格 TLS live/ready 均 200，review=true、model=false；教师两课程 workbench=200、学生同路径=403，检查会话已退出。兼容范围与 owned 运行行为差异另作收口核对，不以主线默认行为替代现场事实。

前端新增 `backend.ts` / `wire.ts` 消费真实信封、CSRF、原 JSON/幂等回执和课程代际；浏览器 DTO 不导入后端运行代码。`LiveDesignPage.tsx` 原生保留 goal/task/observation/rubric/milestone 图关系，目标变更递增版本；从真实范例手工设计，检查、三角色投影、确认和分配均调用原服务。后续设计明确 `mode:copy` 来源，复制当前来源草稿版本，与旧固定活动版本有差异时明示。`LiveReviewPage.tsx` 区分作品、实际帮助、三能力线与未知，正式反馈按 attempt 范围 CAS 追加线程修订；发放许可不替学生消费。

学生原 `PrepWorkspacePage.tsx` 接入 `SubmissionFeedbackPanel`：明确选择已确认快照、反思、同快照检查引用后提交；读取实际反馈、主动 `resume_revision`，旧提交不改写。未知命令留在现有 IndexedDB v2 metadata 中，不新增浏览器库 schema。教师命令结果未知时冻结后续写入并保留原请求，通过全局核对按钮回取原回执后从列表打开当前版本。

真实 Chrome C 链已完成两次提交、同反馈线程两版、许可及本人消费，并读取核对旧 snapshot SHA 未变。首次浏览器暴露跨页面教师列表未更新，已补导航时重读和列表显式刷新；harness 新 context 没有本机 Attempt 引用，已通过原“开始 Attempt”显式打开并核对同一已有 Attempt，未另建对象；窄屏发现新增提交入口被顶栏工具标签覆盖，已移到原有可换行的正文工具条。上述失败保留在 D 盘验证目录，最终结果与后续 HDL/布局检查单列，不将中途业务通过写成全部浏览器通过。

### 6.6 保留并整合个人模型会话的既有交付

现场进一步审计发现，§6.5 的最初源码同步只接纳了共享主线，漏保留本机另一个会话已交付但尚未进入该主线的个人模型功能。这不只是历史字段读取：原个人配置 API、独立 Agent、账号 BYOK、600 秒无网络活动窗口、每回合单调用、配置版本校验及学生辅导接线都应保留。前文“model=false”仅反映旧环境 Key 通道标志，不能据此说原个人通道关闭，也不能将当前仓库原有 45 秒/3 次调用默认为现场原行为。本次漏保留如实记录，不删除失败现场或改写历史记录掩盖。

Robert 在本会话明确回答“授权联系并协调”，已实际联系“接通模型 API Key 配置”。对方暂停本机 source/static/进程写入，并回交固定已提交 `025598d`（文本配置核心 `b9b192e`、个人限额及续期 `e65a996`），以及其已获准且已提交的图片增量 `56e7111`；不读取其未提交工作，不修改该会话 checkout。采用 Git 共同祖先合并，先将 `d77c9cc` 和 `025598d` 合成 `9dbe89f`，再合入 `56e7111` 为 `a57e37f`。教师 tracked 工作由 autostash 保留并逐块整合，未跟踪教师文件保持原位，恢复补丁也保存在验证目录。两个来源的任务与研究文档保留其原历史，不替其维护者改写。

合并结果保留完整个人通道及图片链，再将显式 review=41 与 `teacher-workbench` 组合进唯一正常应用；工具的 `-EnableReview` 与 `-DisablePersonalModels` 独立。个人四表库、原凭据、账号配置与 revision12 原位保留，不重新初始化，不将 Key 复制进仓库或日志；本任务不发模型请求，教师设计预算继续关闭。§6.5 的临时“仅终态”校验及对应测试已撤销，活跃/终态 Job 沿原完整个人模式契约。

整合后前端全量 52 文件、641/641 通过，双 TypeScript 配置检查及正式 build 通过。后端 28/28 隔离回归含个人配置/续期/单调用保护和教师六项专项，验证 41 表同宿主 `model-settings` 与教师工作台共存（callsEnabled=false、无凭据、Job 数不增加）。审阅页的独立复核修正了纠正时丢弃原反证的问题，并让九类引用按原归属/摘要回取原文；历史修订缺失明确不可回取，不以当前正文替代。Astra 对其新增证据保护进行了 22 项内存隔离校验；真实浏览器结果另列。

### 6.7 统一版本与最终浏览器收口

教师实现已本地提交为 `613e5865e9f3ba4a9e5da11691a1b676a9256815`，包含 §6.4/6.6 两个来源。统一部署核验 209 个运行源码、154 个静态文件 SHA，PID 2728，严格 TLS live/ready=200；教师两课工作台=200、学生同路径=403。个人设置 revision12、个人调用通道启用、全局教师模型预算关闭，未读出或改写凭据。部署 manifest 位于 `/opt/xunjie-ui-local/evidence/teacher-unified-cutover-2026-10-15T05-51-36-036Z/deployment.json`，SHA256=`eea26223961d5fb83027831c829e3be544e503aae42bd8e7a7b89d4c26553505`，初始前端入口 `index-CY3WoEYu.js`。

原 80 个 Job 的后续核验为 79 个字节相同、1 个只变更 `stopRequested`：真实 C 正式反馈在 05:37:08Z 触发 A5 `Learner teaching basis revised`，回执 `9a79aedc-3fa3-46f7-924c-3e8f6afc273d` 的 `stoppedJobIds` 明确包含该 Job，原因指向反馈 `3b03cc9d-07dc-4a82-926a-fef3dbc0adad`。该业务控制变化早于 05:51 统一切换；原终态、结果、正文保持。不能把迁移当时 0 变化与业务验收后的变化混为一谈，也没有回写旧 Job。追溯保存在同目录 `history-control-provenance.json`；最终 `validation.json` SHA256=`ba02f18b9690547013b89d0a13c327a840bf20c8c938e411434836ed6c2b19f4`。

最后的真实窄屏发现作品完整 SHA 无断行：390px 时审阅主区域宽 308、scrollWidth 451。Astra 将原摘要文本设为可完整换行，未截断 ID；隔离 Chrome 390/720 与类型检查通过。材料真实版本改为“固定版本”，不将 UUID 版本臆造为 `v1`。验证工具修正原生材料 select 的 label 定位，按实际完成记录截图数，并保留接续的 grantId；扩展为 1440/720/390 三宽。只同步新静态产物，后端源码、PID、数据库及个人通道不需重启或迁移。

当前 C 固定提交/反馈两版/主动修订/后续独立复制的真实断言已通过；HDL 已通过新私有材料默认权限、三角色真实裁剪、设计/发布/分配，正在核对首个确认文件的验证停点。中途失败保留，最终 C/HDL 与截图结果在本节后续追加。个人模型会话已获统一环境验证窗口，仅由其执行原会话获准的图片和项目两项真实调用；本任务不额外发起模型请求。

### 6.8 最终交付回执

2026-10-15，C、HDL 均在本机真实 Chrome、严格 TLS、真实 HTTP/SQLite 中完成：教师手工设计 → 原检查和三角色预览 → 固定发布与明确分配 → 学生确认原文、固定快照、明确提交 → 教师正式反馈及同线程第二版 → 发放许可 → 学生主动消费 → 修改、确认、固定第二个快照并再次提交 → 教师独立复制后续项目。原快照 SHA、原提交与反馈两版保持，复制不改变原固定活动；三能力线没有主张时仍显示未知，不补造能力判断。全部学生写入仅为本轮独立合成工程验证。

| 验证 | 最终结果与边界 |
| --- | --- |
| 前端全量、类型、正式构建 | 整合源 52 文件、641/641 单元检查通过；双 TypeScript 配置通过，最终视觉改动正式 build 通过。保留既有大 chunk 提示 |
| Chrome 协议替身回归 | 教师与个人配置 20/20 通过；共同登录/真实模式 10/10 通过。与下方真实服务验收分开计数 |
| 后端隔离回归 | 28/28 通过，含教师六项、records 五项、个人应用/Agent 十七项；41 表与个人设置同宿主、默认 35 表及原调用限额语义核对 |
| C 真实服务 | 原检查点完成全链；最终工具 19 项断言、1440/720/390 各四页共 12 项布局全部通过、页面错误 0。旧固定项目未补加新的私有材料 |
| HDL 真实服务 | 新材料三个用途默认关闭，私有材料学生/辅导禁选且三角色真实投影裁剪通过；全链完成阶段 42 项断言通过，最终工具接续再核 20 项、12 项布局、页面错误 0。学生再次提交后仍读取原反馈第二版 |
| 固定版本与后续复制 | 两课均两个不同提交/不同快照 SHA；旧 snapshot 不变、同反馈线程两版、明确 grant/学生 consume；后续草稿独立 ID、原 sourceBlueprint/revision 精确、旧固定活动序列化 SHA 不变 |
| 文档与写集 | `node tools/a0-review/check.mjs`、差异空白检查通过；受保护产品/规划/参考/AGENTS 未改；`.zcodeignore` 原样保留 |

HDL 首次保存已收到成功回执，但 Monaco 自动缩进将 111 字符输入编辑成 115 字符原文，旧脚本误将输入串当作原文而停止。隔离准备页重现并验证 Ctrl+A 后原生 textarea 的完整选区；工具改为保存前读实际全文、保留 SHA、原保存回执及 GET 逐字核对，不 trim、改正文或重复保存。对那个确切 `469a1d9e-b2a5-4729-a7ff-c0ca97e0782e`、学生 b、`main.v` v1、工作区版本1、115字符和已知 SHA 的未决保存，仅以批准合成库 `mode=ro` 读取唯一原回执，与授权 GET 全文/版本/范围/摘要一致后清理本机检查点 pending。一次性恢复分支未纳入最终工具；原证据保留，其他未知命令继续停止。移除后原检查点接续仍全部通过。

最终前端固定提交 `5d9c5e97271a43ae11dde2f69260477261adc223`，模块 `index-B66OM0mG.js`，index.html SHA256=`280c205e362469e57a489c5379c88b35fe9d4a66cb14ea8dc60d058f562472bf`；154 个静态文件逐 SHA 通过。静态更新前后 209 后端文件仍为 `613e586`，PID 2728 不变，未重启、再次迁移或操作个人存储。静态 manifest：`/opt/xunjie-ui-local/evidence/teacher-static-only-2026-10-15T06-02-32-522Z/deployment.json`，SHA256=`687dde42faddddb279ef63e1293dc679ad8bc7d072d22ea479771eb085e9f3d9`。

个人模型会话完成其原批准的两个真实请求：图片 max 与原项目 max 各单调用成功，B66 刷新后既有图片/回复恢复，未再调用；公开验收文档提交 `a5cc94d98624a5596bf1a08657b74246dc4a6646` 已本地 fast-forward 接纳，详见[个人模型记录 §10.9](I0_UI_MODEL_CONFIGURATION_REAL_CHAT.md#109-教师版本协调图片部署与真实验证)。其原 Key 与配置保留；共享 IAB 的一次退出导致另一标签会话失效，原因已协调，对方重新认证后确认原数据与结果保持。此后不再从另一标签更改该共享登录态。

可独立查阅的合成对象、路径/状态、原文摘要、失败过程、最终布局和截图收于[本任务证据目录](evidence/teacher-workbench-20261015/README.md)。最终入口 `https://127.0.0.1:3444/#/teacher`；日常启动沿 README 的 `-EnableReview`。仅本地提交，未推送、远端合并或公开部署；PAHER 库/进程未改，教师设计模型预算仍关闭，真人教师/学生、教学效果及完整 AC/NFR 未作为本轮通过项。产品基线与 MVP_SPEC §10 汇总为待授权维护者汇总。原库/源码备份与中途失败保留；无新增依赖、无凭据改动，没有遗留无用途的一次性诊断进程。

### 6.9 2026-10-15 协调后整合 main 并推送 GitHub

Robert 新增明确授权：“把这次改动整合进 main 并推送到 GitHub，和另外两个会话协调好，保留各自已经完成的功能，不要互相覆盖。”本节更新 §6.8 的 Git 交付状态；运行环境与原批准范围保持。

已分别联系“实现登录与会话进入流程”和“接通模型 API Key 配置”。前者确认共享数据工作树为干净 detached `d77c9cc8efdab1a55c54c5b711f2cf8fce8f1ed3`，无新增源码或待接纳功能、不并行推送；后者确认本地/远端 main 为干净 `a5cc94d98624a5596bf1a08657b74246dc4a6646`，无额外已完成增量，授权本会话将其 main 工作树快进，期间仅只读调查后续聊天任务。未触碰两会话其他工作。

本轮 fetch 后确认：远端 main 已包含共享显示/登录 `d77c9cc`、个人模型 `025598d`、图片 `56e7111`、教师实现 `613e586`、窄屏修正 `5d9c5e9` 和个人模型公开验收 `a5cc94d`。教师最终交付 `43757fb611e3be983c3f83df96abdc5acb6a7491` 是它的直接后继，左右独有提交数 `0/1`；差异仅为教师验收工具、任务记录和公开证据，`apps/**`、README、保护基线和依赖无差异。因此采用 fast-forward 保留完整历史，不 cherry-pick 重造、覆盖文件或强推。

已在协调的干净 main 工作树执行 `git merge --ff-only 43757fb611e3be983c3f83df96abdc5acb6a7491`，随后普通 `git push origin main` 成功；`git ls-remote --heads origin main` 实际返回 `43757fb611e3be983c3f83df96abdc5acb6a7491`。仓库为 `https://github.com/paher-din/XunJie`。本节回执作为单独文档提交再按同样方式快进并推送，最终文档提交 SHA 由会话交付的远端核验给出。

本轮工具语法、差异空白和文档导航检查通过；应用源码与已验收固定版本相同，沿用 §6.8 的 641 项单元、后端专项及真实 C/HDL 浏览器结果，不将它们写成此次重新运行。`.zcodeignore`、其他工作树、原备份、个人模型配置/Key 与数据库保留；本轮只做 Git 交付，不重新部署、迁移或发模型请求。

## 7. 2026-10-15 教师账号模型配置入口

### 7.1 授权、依据与写集

Robert 明确要求“教师端现在前端没有模型供应商 api 设置配置入口，照着学生端的实现和 UI 页面搬过去，实现相应功能”。当前实现基线为已推送 `main` 的 `4ea3c73e70a6ad334476d54315c58e806b06cae8`；本任务延续教师前端维护，不改模型会话正在处理的聊天/浮窗文件。

已读正文：README；PRD §3.2/4.1–4.3；MVP_SPEC §2、M-01/02；TECH_DESIGN §5.1、§6.1/6.2；DESIGN 的现有视觉令牌、按钮/设置动效和主题规则；学生 `SettingsPage`、`ModelTab`、供应商/模型弹窗及 `lib/modelSettings.ts`；个人模型任务 §4 接口和 §10.9 统一验收。配置是按当前账号保存的个人供应商设置，与课程角色、教师正式判断和宿主教师设计预算分开。

方案：在教师“工作台设置”内增加可直达的模型配置页，直接复用学生 `ModelTab` 和现有 `GET/POST /api/model-settings`、`POST /api/model-settings/test`，保留供应商/Key、默认模型、完整模型能力/上下文/最大输出、思考强度、连接测试、启停、CAS 和账号隔离。开发教师预览仅显示真实入口说明，不读取或写入当前账号模型配置。原外观与数据说明保留。

可写：`apps/student/src/teacher/TeacherApp.tsx`、新教师设置页面及 scoped CSS、新教师模型入口浏览器检查；必要后端 `personal-models.test.ts` 的教师账号隔离回归；本任务记录与实际使用说明。只读：学生模型设置共享组件/客户端/API 的实现、聊天和浮窗在途写集、产品/规划/参考/AGENTS、依赖与凭据。若发现必须修改共享实现，先回交具体差异与模型会话协调。

验收：真实教师角色可进入同款配置 UI；保存请求沿现有会话/CSRF，响应不含 Key，刷新和账号隔离保持；协议 Chrome 覆盖供应商/模型保存和强度、失败/权限与窄屏；后端隔离合成教师账号验证现有真实接口。沿用原加密四表，不迁移库、不代用户改现有 Key、不自动调用模型或测试真实供应商。与模型会话统一固定源码后再协调本机静态更新，避免覆盖其后续聊天交付。产品基线汇总仍待授权维护者汇总。

### 7.2 实现与专项验证

`TeacherSettingsPage.tsx` 将教师原设置内容保留在“通用”，增加“模型”子路由 `/#/teacher/settings/model`，直接懒加载原 `components/settings/ModelTab.tsx`；供应商/模型弹窗、参数与保存/测试客户端均未复制或改写。`TeacherApp.tsx` 仅改为设置子路由，`teacher-settings.css` 只在新教师容器内适配原设置控件和三档宽度。学生共享组件与 API 实现、模型会话的聊天/浮窗在途源码均未改。

双 TypeScript 配置检查通过，正式 build 通过，入口 `index-BBOjfwVH.js`（保留原大 chunk 提示）。Chrome 协议专项 `teacher-model-settings.spec.ts teacher-ui.spec.ts` 11/11 通过，41.8秒：新两项验证教师供应商连接目录导入、完整参数/图像能力/low-high-max、CAS 保存失败留表单、保存后刷新/密钥脱敏、启用/最高强度、明文不进 local/sessionStorage、1440/720/390 无溢出；教师预览与没有教师角色的账号不加载模型 API。原九项教师 UI 行为回归通过。这里使用同源 HTTP 合成替身，不是供应商或真实配置写入验收；[协议桌面截图](evidence/teacher-workbench-20261015/teacher-model-settings-protocol-desktop.png)和[390px截图](evidence/teacher-workbench-20261015/teacher-model-settings-protocol-mobile.png)仅包含合成供应商和脱敏状态。

后端 Node v24.21.0 隔离专项 `server/app/personal-models.test.ts` 2/2 通过、0失败/跳过（3.258秒），教学完整类型检查通过。新增用例使用真实 Session/CSRF 和真实加密存储服务配合离线 HTTPS boundary，验证教师保存、启用、revision CAS、脱敏、学生隔离、过期会话；连接测试只读取 `/v1/models`，生成请求为0。首次类型检查因独立 stage 漏复制学生 `wire.ts` 报 TS2307，补齐只读源快照后通过，未改源码迁就检查；证据位于 `D:/XunJie_Project/artifacts/teacher-model-settings-tests-20261015`。真实库、Key 和运行服务未操作。

与模型会话已再次协调：其仍在原 `4ea3c73` 的独立 main 工作树完成新聊天恢复/浮窗阅读任务，3444 尚未切换；本次教师固定提交交由该会话合入，再统一构建/部署。为避免覆盖，新教师入口不单独提前同步静态；本任务待统一版本就绪后只读验证真实教师入口，不修改现有账号配置或代填 Key。
