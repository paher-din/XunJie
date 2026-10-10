# XunJie

项目制教学 Agent：教师与 Agent 共同设计项目，学生在真实动手、试验与修订中学习，教师依据具体表现改进后续教学。首版是面向高校 CS 课程的独立 Web 应用。

当前仓库保存团队开发所需的产品规格、工作规范和必要参考，并已实现 A1-P1 后台工程、公共校验/错误和健康入口，以及 A 自有独立合成认证/短事务验证能力；完整正式应用尚未实现。Web UI 由团队成员负责，后台与 Agent 按其实际交付对接。

## 文档

| 文档 | 内容 |
| --- | --- |
| [PRD](docs/product/PRD.md) | 为谁解决什么问题、产品原则、核心流程、成功标准 |
| [MVP_SPEC](docs/product/MVP_SPEC.md) | 第一版做到哪里、业务行为、限额与验收 |
| [TECH_DESIGN](docs/product/TECH_DESIGN.md) | 后台、Agent 与 UI 对接的结构和契约 |
| [三人分工与交付顺序](docs/planning/TEAM_WORK_PLAN.md) | A/B/C 的详细任务、并行与等待关系、交接和验收责任；UI 成员仅在最终接入阶段参与 |
| [A0 业务权限与公共契约评审稿](docs/tasks/A0_BUSINESS_CONTRACT_REVIEW.md) | Issue #2 的权限、状态、逐命令与短事务提案、D-03、验证方案和待会审差异；未成为正式契约 |
| [G0 Issue 跟踪](docs/planning/G0_ISSUES.md) | 已发布的统筹 Issue 与 A0/B0/C0 三个执行 Issue，任务正文、交付和关闭条件 |
| [G0 交付核对与实施门禁](docs/tasks/G0_SCOPE_CONTRACT_GATE_REVIEW.md) | 三项 PR、差异与真实验证，以及负责人统一裁决/准备门禁记录；不代签或计作产品验收 |
| [G0 TextScope 参考与活动适配](docs/tasks/G0_TEXTSCOPE_ACTIVITY_SPEC.md) | 外部候选供追溯，Web 学生空间的 Core/Report 活动提案另列；不照搬本地开发/六阶段/评分要求 |
| [G0 缺口收敛与批准记录](docs/tasks/G0_CLOSURE_PROPOSAL.md) | 已获负责人统一批准的教学/模型/数据/技术/首批进入方案及五份文件授权；正式契约以产品基线为准，未实施应用 |
| [A1 基础实施与验证记录](docs/tasks/A1_FOUNDATION_ACCESS_TRANSACTION.md) | Issue #10 的 P1 工程/入口/公共校验与错误、实际验证和后续权限/短事务边界；A1 未全部完成 |
| [A2 教师设计与版本任务](docs/tasks/A2_TEACHER_DESIGN_VERSIONS.md) | Issue #13 的 S1 材料/草稿/检查/投影内部核心与验证；真实接口/存储及确认/分配待 S2/S3 的 A1/C1/C2 条件 |
| [C0 工作区、记录与执行交付稿](docs/tasks/C0_WORKSPACE_RECORDS_RUNNER.md) | 独立任务文档：StudentIDE 参考差异、接口提案、资源/恢复约定和验证方案；待 A/B 会审 |
| [工作空间规范](AGENTS.md) | 已确认决定、协作分工、工程纪律与操作红线 |
| [产品研究依据](docs/reference/PRODUCT_RESEARCH.md) | 影响首版的研究结论、证据边界与公开来源 |
| [工程衔接说明](docs/reference/ENGINEERING_HANDOFF.md) | 可沿用的 IDE/记录/运行/诊断契约与历史试验限制 |
| [工作区合并与 Issue 收口](docs/tasks/W2_WORKSPACE_MAIN_INTEGRATION.md) | 本地 skills/接入记录、授权教材与既有工作树的 main 集成及实际验证/关闭记录 |
| [课程教材目录](course_matrial/) | 经负责人确认公开分发授权的课程参考 PDF；教材分发不扩大 MVP 的资料导入格式 |
| [B0 模型、帮助与候选分析交接稿](docs/tasks/B0_模型帮助分析契约.md) | 三类输入/输出、可信来源、保存归属、拒绝与取消提案；待 A/C 会审 |
| [B0 模型与预算复核](docs/tasks/B0_MODEL_VENDOR_RESEARCH.md) | 精确型号/区域/结构化方式、数据条款证据状态及预算/配额建议；D-02 待批准 |
| [B0 合成工程样例](docs/tasks/B0_TEACHING_EXAMPLES.md) | E1～E10 的具体输入/时序、确定性与人工判据，补教师/候选实例；业务验收未执行 |

阅读顺序：PRD → MVP_SPEC → TECH_DESIGN。文档间冲突的处理规则见 PRD 1.2。

安排开发时继续阅读 [TEAM_WORK_PLAN](docs/planning/TEAM_WORK_PLAN.md)：三人先按业务契约完成后台、Agent 与执行能力，再在最后接入团队实际 UI。服务端预交付与完整产品验收分别记录，不提前宣称浏览器流程通过。

开发 Agent 必须遵守 [Agent 权限与项目边界](AGENTS.md#agent-权限与项目边界硬性要求)：`docs/product/` 整体默认只读，包括 MVP_SPEC 的进度记录；规范、共同计划和参考材料同样受保护。执行任务、完成 Issue 或要求“文档优先”不自动授予基线修改权限。边界需要调整时，先提出差异，再由项目负责人明确授权指定维护者修改对应文件。

按 [文档优先规则](AGENTS.md#文档优先硬性要求)，编码前阅读相关规格，方案、差异、进展和验证结果写入 `docs/tasks/<任务编号>_<主题>.md`；影响产品结果或共享契约的提案待确认后实施。需同步产品基线时列出汇总请求，由获授权维护者处理。代码交付必须包含对应任务记录；基线汇总未处理时如实标为待汇总，不越权写入或宣称已同步。

## 开发 skills

项目安装的 27 个技能包保存在 [skills/](skills/)，来源与安装清单见 [W0](docs/tasks/W0_AGENT_SKILLS_INSTALL.md)，Codex 接入与验证见 [W1](docs/tasks/W1_CODEX_SKILLS_CONFIG.md)。Codex 通过 `.agents/skills` 发现本项目技能，该路径链接到 `skills/`，维护时只编辑实体目录。

本机已建立入口。其他工作副本首次接入时，在仓库根目录执行：

```powershell
# Windows：无需复制技能，也无需管理员权限
New-Item -ItemType Directory -Path .agents -Force | Out-Null
New-Item -ItemType Junction -Path .agents\skills -Target (Resolve-Path .\skills).Path
```

```bash
# macOS / Linux
mkdir -p .agents && ln -s ../skills .agents/skills
```

目录联接本身不随 Git 分发，`/.agents/skills/` 已忽略，避免重复纳入技能文件；已有 `.dsh/skills` 入口保留。可在 Codex 输入 `$code-review`、`$diagnosing-bugs` 或 `$tdd` 选择技能；有全局同名技能时按项目路径选择。Codex 会自动发现变更，若选择器没有刷新，重启 Codex，参见 [官方技能文档](https://learn.chatgpt.com/docs/build-skills)。

技能使用遵守 [AGENTS.md](AGENTS.md) 的授权、文档与操作边界。议题、标签和领域文档的 `setup-matt-pocock-skills` 初始化流程属于另一个配置范围，本次仅接入技能发现。

## 文档验证

A0 评审材料可使用 [只读检查脚本](tools/a0-review/check.mjs) 验证。需要本机已有 Node.js，不安装依赖：

```powershell
node tools/a0-review/check.mjs
node --test tools/a0-review/check.test.mjs
```

第一条检查项目文档的行内文件/目录引用、A0 既有编号/矩阵/JSON/映射与接口覆盖，兼容 G0 采纳后的 27 条变更接口；第二条检查路径、合法目录导航/错误目录锚点、旧提案兼容、必需接口缺失和未知接口反例，均只在内存构造。失败返回退出码 1。静态通过不校验业务/权限/状态语义、真实模型或执行隔离，不创建数据库或启动应用；skills 内示例不作为产品文档验收入口。

## 后台基础开发（A1-P1）

使用 Node **24.21.0**（[官方发行目录](https://nodejs.org/dist/v24.21.0/)）；版本由 `.node-version`、package engines 与运行检查共同约束。安装精确依赖及锁文件后执行：

```powershell
cd apps/teaching
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`npm test` 会先编译，并运行合成 HTTP、错误/校验、认证/事务/进程故障恢复和实际本机监听/入口测试。认证/存储测试按负责人批准，仅在系统临时目录新建 `xunjie-a1-p2-*/synthetic.sqlite`；包含 SQLite 自身 WAL/SHM 文件生命周期，关闭后保留库，不执行清理/既有库迁移。凭据与签名材料仅由夹具临时生成，重启测试仅经 IPC 复用，不写 `.env`。测试中的强制进程结束仅针对自己的故障夹具。开发入口为 `http://127.0.0.1:3000`，可在进程环境设置有效整数 `PORT`（1～65535），退出时关闭监听。没有 UI 页面；默认 main 无需 `.env` 或数据库初始化。

`GET /health/live` 返回 200 和服务端 requestId，只表示入口存活；`GET /health/ready` 当前固定返回 503/DEPENDENCY_UNAVAILABLE，因为完整数据库、模型、runner 链尚未接入。默认 main 仍仅提供 P1 入口。独立 [合成验证工厂](apps/teaching/server/access/app.ts) 实现既定登录/退出路径、持久 Session、课程归属和短事务，仅供授权的 `app.inject` 测试，不监听网络；其登录字段/CSRF 结果和 fixture 路由不是新冻结的公共字段。内部 withAuthorizedCourse 已支持课程鉴权、Session 活跃时间和可信同步 SQL 回调同事务提交/回滚，验证见 [A1 接缝记录](docs/tasks/A1_FOUNDATION_ACCESS_TRANSACTION.md#10-2026-10-10-c2-接缝推进既有合成鉴权与事务组合)。实际 HTTPS/安全配置、资源授权与 C2 业务链未完成。未注册的路由返回统一的技术错误，完整记录见 [A1 任务文档](docs/tasks/A1_FOUNDATION_ACCESS_TRANSACTION.md#9-2026-10-10-独立合成验证批次)。

本批使用 npm 11.19.0。`npm ci` 可能提示 better-sqlite3 原生安装脚本尚未获 allowScripts 放行；本机 Windows x64 使用包内预构建模块，未放行 node-gyp。独立合成测试已实际打开 SQLite 3.53.4，核验外键/WAL/FULL/busy_timeout=1000；其他平台须验证其批准运行时与原生模块，不能只凭依赖安装成功称 DB 就绪。

早期 A1 原生加载与参数准备的历史记录保留在 §8，负责人于 2026-10-10 批准该节独立批次，实施证据见 §9。scrypt 参数探针仍可在 apps/teaching 中执行 `node tools/benchmark-scrypt.mjs`：只使用合成字节和标准库，输出耗时/内存采样及匹配检查，不读取或保存真实密码/配置。合成登录通过不代表真实凭据发放、完整 AC/NFR 或产品性能验收。

## 状态

三份产品文档已于 2026-10-09 更新为 v0.3：项目负责人统一批准 G0 的教学/模型/数据/技术契约和分段实施方案，并明确授权同步五份基线。裁决角色为负责人，A0/B0/C0 PR 作为输入，不记录三人逐一签字；正式应用与业务验收仍未完成。

G0 准备门禁已完成，五份基线及任务记录已直接推送 main，[G0 #1](https://github.com/paher-din/XunJie/issues/1) 已关闭为 Completed。实际模型、执行隔离/备份恢复、浏览器与真人验收未执行，G1～G4 尚未完成。

当前准备门禁与后置条件见 [G0 统筹记录](docs/planning/TEAM_WORK_PLAN.md#41-整体-g0-统筹与冻结记录)。A1-P1、B1 合成核心、C2 首批可按批准进入条件推进，A1-P1 已交付后台基础；真实数据库、凭据/付费/数据、C1 节点/隔离、最后 UI/真人链仍按各自授权和验收门禁落实。G0 文档交付未包含应用编码，后续实施分别记录在对应任务文档。

G0 任务已发布到 GitHub：[总 Issue #1](https://github.com/paher-din/XunJie/issues/1) 跟踪共同决策、跨模块会审和实施门禁；A0/B0/C0 执行 Issue 的链接与正文见上方任务跟踪文档。Issue 已建立不代表契约交付、范围冻结或业务验收通过。

A0/B0/C0 的材料已通过 PR #5/#8/#6 合入并纳入统一裁决。2026-10-09 按负责人“合并现有工作区并关闭所有 Issue”的指令，主工作副本已合并/更新 main，skills/接入记录和授权教材入库，现有 #1～#4 全部关闭；原任务稿/规划中的 Open 保留其当时范围，以 [W2 集成记录](docs/tasks/W2_WORKSPACE_MAIN_INTEGRATION.md) 的较新关闭事实为准，不表示新增个人签认或产品验收通过。

首发为 C 程序设计/C、函数/数组/指针先备及指定教材；学生只在 Web 工作区完成 TextScope Core（stats/find/top）→教师反馈→Report，不需要本地工具链或终端。后台 Linux/容器归 C，UI 由成员最后交付。DeepSeek/deepseek-flash 配置、合成开发/预置账号/私有试点/90 天复核不自动删除及数据责任已批准；预算金额和投入/交付日期不入文档，原外部项目门槛仅作参考。教材 PDF 本次经负责人确认公开分发授权后纳入仓库，MVP 资料导入仍按 TXT/Markdown 范围。

上述文档及其仓库内引用可供团队独立查阅，必要的一手资料使用公开链接。原研究的完整归档、旧实验操作手册与原始过程资料不作为正式开发的阅读依赖；历史实现和通过统计不代表当前应用已交付。


## 教师设计独立核心（A2-S1）

[内部模块](apps/teaching/server/design/) 提供 TXT/Markdown/粘贴材料准备、手工/复制蓝图与 revision 编辑、关系与三类检查、教师授权后的三角色预览；实现与验证见 [A2 记录](docs/tasks/A2_TEACHER_DESIGN_VERSIONS.md#8-s1-实际实现与验证记录)。字段仅供内部确定性计算，尚未冻结为共享 HTTP DTO。资料默认不对学生/辅导开放；私有答案/验证资产不能公开。检查保留教师疑点和效果未知；缺少真实运行就绪阻断开放条件。

使用上方已批准运行时，在 apps/teaching 运行独立测试：
```powershell
node --test tests/design-material.test.ts tests/design-draft.test.ts tests/design-checks.test.ts tests/design-projection.test.ts
npm run typecheck
```
这四组测试只使用合成对象，不建 A2 数据库、不启动业务服务；完整回归仍执行 `npm test`。当前没有可供浏览器调用的 A2 保存/确认/分配接口；真实授权、事务存储、不可变活动版本、分配/控制和 UI 验收待 S2/S3，不凭计算结果发保存 ACK。

A2 后续存储对象、独立新库范围、原子命令顺序及验证接缝已列为 [S2 待审方案](docs/tasks/A2_TEACHER_DESIGN_VERSIONS.md#9-s2-首批持久化方案待负责人批准未执行)。该方案尚未批准或执行；原 A1 五表合成库许可不覆盖新增 A2 表。
