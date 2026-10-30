# WP02：课程任务与固定发布版本实施与验收记录

日期：2026-10-31（Asia/Shanghai）。对应[课程任务与固定发布版本](https://github.com/paher-din/XunJie/issues/150)，方案见[实施方案](specs/wp02-course-task-releases.md)。本轮在 `codex/wp02` 分支实施，未合并 `main`。

**范围：** 课程/任务/不可变发布登记与读取、课程资格、学生开放材料投影、跨 owner 课程活动建立与恢复、学生课程页面、迁移/维护/恢复交接。作品编辑、实验执行、Agent 能力、完整教师设计界面不在本轮。

## 实施落点

| 层 | 变更 |
| --- | --- |
| 公共契约 | 新增 [`@xunjie/contracts/courses`](../../packages/contracts/src/courses.ts)：课程/任务/发布摘要、学生发布投影、材料内容、导入清单、资格输入、课程活动输入/绑定与跨 owner authority 类型；学习活动 wire 增加可选 `course` 固定绑定，旧活动无需迁移即可解析 |
| 空间/课程 owner | 新增 [`courses`](../../packages/learning-space/src/courses/index.ts)：迁移 v5–v6（课程、任务、发布、材料、资格、关联、登记回执）、清单与资源校验、不可变发布登记、学生投影、材料读取、资格授予/撤销、`prepare/confirm/bindingResult/authorize`、领域校验；`schoolSpace()` 与课程模块共享同一 owner/schema |
| 学习数据 owner | 迁移 v2（协调状态与固定绑定）和 `createCourse/courseResult`：`register -> prepare -> 持久 pending -> confirm -> 可见提交`，重复请求返回同一活动，阶段中断按原身份续接；读取、列出、重开、回执均重新核验当前课程资格和原版本 |
| HTTP | `/api/learning/` 新增 `GET courses`、`GET releases/:id`、`GET releases/:id/materials/:materialId`、`POST course-activities`、`GET course-activity-results/:requestId`；管理边界新增 `manage/course-import`、`manage/course-access`、`manage/course-result` |
| 运行时 | 空间/课程 owner 使用 `spaceCourseMigrations`；课程校验接入维护参与者与恢复目标；学习数据 owner 注入课程 authority；课程资源随 `space-course` 资源根参与备份/恢复 |
| CLI | `xunjie course-import --file <清单.json>`、`xunjie course-access --file`、`xunjie course-result --file`；清单资源按材料 `path` 从清单目录读取，拒绝越界、摘要或长度不一致 |
| 学生页面 | [`LearningPage.tsx`](../../apps/web/src/runtime/LearningPage.tsx) 展示获准课程、任务、明确发布版本、目标/要求/开放材料/起始作品/固定能力引用；支持读取材料、从选定版本建立活动、pending 请求核对、刷新后重开；保留自主活动路径 |

## 支持入口

课程提供者使用受认证的管理 HTTP 或产品 CLI。CLI 清单不含 `resources` 字段，资源由 CLI 从清单所在目录读取：

```sh
xunjie course-import --root <环境目录> --resources <resources.json> --file <release.json>
xunjie course-access --root <环境目录> --resources <resources.json> --file <access.json>
xunjie course-result --root <环境目录> --resources <resources.json> --file <result.json>
```

- `release.json` 使用 `courseImportSchema`：`formatVersion`、稳定 `requestId`、`course`、`task`、`release`（目标、要求、材料 `path/access/sha256/byteLength`、起始作品、固定能力引用）。
- `access.json`：`{ requestId, courseId, principalId, active }`。
- `result.json`：`{ requestId }`。
- 私有材料与开放材料一起持久写入并保留引用，但不出现在学生投影或材料下载中。
- 单次导入 JSON 请求上限 64 MiB（含全部资源），单个资源上限同为 64 MiB；更大课程需拆分为多个发布版本。
- 重复登记先按 `requestId` 与输入摘要返回已存储结果，再读取本地资源；同一 `materialId` 与相同内容可被后续发布版本复用。

## 验收证据

| # | 验收项 | 结果与证据 |
| --- | --- | --- |
| 1 | 稳定身份与真实入口 | 课程/任务/发布使用独立 UUID；CLI 与 HTTP 管理入口经真实领域接口和 PostgreSQL；`course-releases.runtime.test.mjs` 的登记、查询、课程/任务/发布读取均未使用测试夹具或手工 SQL |
| 2 | 完整不可变发布 | 发布固定目标、要求、开放/私有材料、起始作品与带版本的组件/执行器引用；相同 `releaseId` 改摘要、同一请求改内容均 409；修改须新 `releaseId`；Chrome 详情页显示固定版本与能力引用“未接入前不提供运行或编辑” |
| 3 | 真实页面与自主活动 | 真实 Chrome（Windows 11 x64）用 `course-import` 登记后登录学生页，读到课程、任务、材料并从选定版本建立活动；刷新后活动仍在列表并可重开；自主活动建立与列表回归通过 |
| 4 | 旧活动固定版本 | v1 建立活动后登记 v2，读取/重开仍为 v1；v1 材料缺失或损坏时读取、重开与新建明确失败，不回退最新版、不新建同名活动；列表仍保留该活动，打开时报告缺失/损坏 |
| 5 | 后端私有隔离 | 学生列表/发布/材料/活动响应均不含私有材料名称或正文；私有材料直接读取 404；伪造发布、材料、其他学生活动请求分别 404/403；浏览器页面 DOM 不出现私有材料 |
| 6 | 当前资格 | 撤销课程资格后列表投影为空、读取/新建/重开被拒，原活动记录保留；重新授予后原活动可重开；撤销成员后会话失效，重新登录后恢复；缺失、损坏、禁用与暂时不可用分别映射 |
| 7 | 稳定操作与跨 owner | 相同登记请求返回原结果、改内容 409；相同活动请求返回同一活动 ID；prepare 中断、确认后回执丢失均按原身份续接且只产生一个活动；改发布 409；两侧各自短事务，无共享可写事务 |
| 8 | 资源持久性 | `stageResource` 写入并重读，发布事务引用 `<releaseId>:<materialId>`；同一材料可被新版本复用；v2、撤权和关闭活动不回收 v1；材料文件删除返回 404、内容损坏返回 503 `corrupt`，不伪造内容；恢复后重新可读 |
| 9 | 页面设计 | 使用既有 `learning-page`、色彩/排版/间距 token；目标与材料在详情首屏可发现；无存储节点选择、手动冻结或课程专用工作区分支；键盘使用原生按钮/链接 |
| 10 | 迁移维护恢复 | 旧空间 v1–4、学习数据 v1 在真实 PG 上升级到新 schema，旧自主活动保留并可读取；新增发布/活动可用；备份、独立恢复、接管后发布、材料、课程活动与自主活动重开通过；`course-result` 在恢复目标可查询原登记 |
| 11 | 平台与分项结果 | Windows 11 x64 工程、真实 Chrome 与已有自主活动回归通过；Apple Silicon Mac 未执行（见下）；教学效果未评估 |

## 工程验证

环境：Windows 11 x64（10.0.26200），Node v24.21.0，PostgreSQL 18.6（`theseus-rs` x86_64-pc-windows-msvc；归档 SHA256 `0c0c845626ed77c605d716051c9e8df3368d07fbbd9f61ea39a4c5c0536fde7e`，与 GitHub release `.sha256` 一致）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（contracts、storage、learning-space、server、product-runtime、web、local-runtime） |
| 构建 | `npm run build` | 通过 |
| 公共契约浏览器检查 | `npm run check:contracts:browser` | 8 个公开导出均 browser-safe |
| 文档链接 | `npm run check:docs` | 155 个 Markdown、1078 个本地目标、0 失败 |
| 课程原生验收 | `node --test --test-concurrency=1 apps/server/tests/course-releases.runtime.test.mjs`（`XUNJIE_PRODUCT_POSTGRES_BIN`） | 3/3 通过：发布/投影/资格、跨 owner 续接、旧 schema 升级 |
| CLI 备份恢复 | `node --test --test-concurrency=1 packages/product-runtime/test/learning-cli.runtime.test.mjs` | 1/1 通过：课程发布/材料/chrome 不可见项与自主活动随备份恢复，接管后重开 |
| 既有 WP02 回归 | `node --test --test-concurrency=1 apps/server/tests/learning-entry.runtime.test.mjs` | 8/8 通过：个人/学校身份、客户端授权、活动重开、恢复与旧会话隔离 |
| 全量本地套件 | `npm test` | 退出码 1；失败集中在既有的 Windows 环境项：product-runtime 连接/恢复测试超时、symlink 用例 `EPERM`、server 的 `LOCAL_SOCKET_CONFLICT`，均位于本票未修改模块；web 58 个文件/688 项通过，本票改动模块没有失败。原始日志 `.verification/local-suite-2.log`（本机，未提交） |

课程原生测试覆盖：重复登记/冲突（含无本地资源重试）、跨版本材料复用、私有材料与伪造 ID、v1/v2 固定、重复活动请求、跨 owner prepare/confirm/提交中断续接、撤权/撤成员、材料删除/损坏、旧 schema 升级、资源随备份恢复。

两轴审查后的修正包括：登记先按 `requestId` 返回已存储结果；同 `materialId` 相同内容可在新版本复用；课程/任务/发布登记改为冲突安全的插入后复核；列表保留缺失/损坏版本（打开时报告），撤销资格仍隐藏；创建成功前经正式读取路径核实；材料读取增加空间切换代际保护；标题字号与衬线遵循 DESIGN.md。

## 浏览器验收

真实 Google Chrome（Playwright `channel: chrome`，1440×900，Windows 11 x64），学校 profile，经支持的 `course-import`/`course-access` 入口登记后验收：

1. 登录学生页，看到课程、任务与“最近发布”版本。
2. 选择版本后看到目标、要求、开放材料、起始作品与固定能力引用；页面不含“教师私有测试”。
3. 读取开放材料得到 Blob 下载链接。
4. 从选定版本开始活动，活动页显示固定版本与内容摘要。
5. 刷新页面后活动仍在“我的学习活动”，可重开原版本。
6. 建立自主活动后两者同时存在；撤销课程资格并刷新后课程投影消失、自主活动保留；重新授予后恢复。
7. 证据截图：[课程目录](evidence/wp02-course-chrome-catalog.png)、[发布详情](evidence/wp02-course-chrome-release.png)、[课程活动](evidence/wp02-course-chrome-activity.png)、[刷新后重开](evidence/wp02-course-chrome-reopen.png)。

## 未执行与交接

- **Apple Silicon Mac**：本机无该平台，未执行原生 PG、Chrome 或受影响连接路径；需在 Mac 上复跑类型检查、课程原生测试与 Chrome 流程，并分别记录工程/浏览器/未执行项。
- **教学效果**：本轮只验证工程与交互，未评估学生使用效果或学习收益。
- **混合部署与跨机接管**：由 #154 继续验收；本票提供可消费的公开接口、迁移和恢复校验。
- **全量本地套件**：`.verification/local-suite-2.log` 记录了当日失败；失败项位于未修改的连接/恢复测试、Windows symlink 特权与 `LOCAL_SOCKET_CONFLICT`。它们不计入本功能通过证据，也未被本次改动修复。
