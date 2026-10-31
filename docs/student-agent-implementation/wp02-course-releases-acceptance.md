# WP02：课程任务与固定发布版本实施与验收记录

日期：2026-10-31（Asia/Shanghai）。对应[课程任务与固定发布版本](https://github.com/paher-din/XunJie/issues/150)，方案见[实施方案](specs/wp02-course-task-releases.md)。本轮在 `codex/wp02` 分支实施，未合并 `main`。

**范围：** 课程/任务/不可变发布登记与读取、课程资格、学生开放材料投影、跨 owner 课程活动建立与恢复、学生课程页面、迁移/维护/恢复交接。作品编辑、实验执行、Agent 能力、完整教师设计界面不在本轮。

## 实施落点

| 层 | 变更 |
| --- | --- |
| 公共契约 | 新增 [`@xunjie/contracts/courses`](../../packages/contracts/src/courses.ts)：课程/任务/发布摘要、学生发布投影、材料内容、导入清单、资格输入、课程活动输入/绑定与跨 owner authority 类型；学习活动 wire 增加可选 `course` 固定绑定，旧活动无需迁移即可解析 |
| 空间/课程 owner | 新增 [`courses`](../../packages/learning-space/src/courses/index.ts)：迁移 v5–v6（课程、任务、发布、材料、资格、关联、登记回执）、清单与资源校验、不可变发布登记、学生投影、材料读取、资格授予/撤销、`prepare/confirm/bindingResult/authorize`、领域校验；`schoolSpace()` 与课程模块共享同一 owner/schema |
| 学习数据 owner | 迁移 v3（协调状态与固定绑定，整合后接在 #151 的 v2 作品迁移之后）和 `createCourse/courseResult`：`register -> prepare -> 持久 pending -> confirm -> 可见提交`，重复请求返回同一活动，阶段中断按原身份续接；读取、列出、重开、回执均重新核验当前课程资格和原版本 |
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
| 11 | 平台与分项结果 | Windows 11 x64 工程、真实 Chrome 与已有自主活动回归通过；Apple Silicon Mac 工程、原生 PostgreSQL、真实 Chrome、学校直连与已安装客户端流程通过（2026-10-31，`6e7967a`，见下）；教学效果未评估 |

## 工程验证

环境：Windows 11 x64（10.0.26200），Node v24.21.0，PostgreSQL 18.6（`theseus-rs` x86_64-pc-windows-msvc；归档 SHA256 `0c0c845626ed77c605d716051c9e8df3368d07fbbd9f61ea39a4c5c0536fde7e`，与 GitHub release `.sha256` 一致）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（contracts、storage、learning-space、server、product-runtime、web、local-runtime） |
| 构建 | `npm run build` | 通过 |
| 公共契约浏览器检查 | `npm run check:contracts:browser` | 8 个公开导出均 browser-safe |
| 文档链接 | `npm run check:docs` | 155 个 Markdown、1078 个本地目标、0 失败 |
| 课程原生验收 | `node --test --test-concurrency=1 apps/server/tests/course-releases.runtime.test.mjs`（`XUNJIE_PRODUCT_POSTGRES_BIN`） | 4/4 通过：发布/投影/资格、跨 owner 续接、旧 schema 升级、已安装客户端课程转发 |
| CLI 备份恢复 | `node --test --test-concurrency=1 packages/product-runtime/test/learning-cli.runtime.test.mjs` | 1/1 通过：课程发布/材料/chrome 不可见项与自主活动随备份恢复，接管后重开 |
| 学校客户端代理 | `node --test --test-concurrency=1 packages/product-runtime/test/school-client.test.mjs` | 2/2 通过：课程路由转发、响应 schema 校验、伪造身份拒绝、缓存状态撤权重放拒绝 |
| 既有 WP02 回归 | `node --test --test-concurrency=1 apps/server/tests/learning-entry.runtime.test.mjs` | 8/8 通过：个人/学校身份、客户端授权、活动重开、恢复与旧会话隔离 |
| 全量本地套件 | `npm test` | 退出码 1；失败集中在既有的 Windows 环境项：product-runtime 连接/恢复测试超时、symlink 用例 `EPERM`、server 的 `LOCAL_SOCKET_CONFLICT`，均位于本票未修改模块；web 58 个文件/688 项通过，本票改动模块没有失败。原始日志 `.verification/local-suite-2.log`（本机，未提交）。二次审查修正后未重跑全量 `npm test`；已重跑 typecheck/build/契约/文档检查、school-client 2/2、课程原生 4/4、CLI 1/1、#149 8/8 与两种 Chrome 流程 |

课程原生测试覆盖：重复登记/冲突（含无本地资源重试）、跨版本材料复用、私有材料与伪造 ID、v1/v2 固定、重复活动请求、跨 owner prepare/confirm/提交中断续接、撤权/撤成员、材料删除/损坏、旧 schema 升级、资源随备份恢复。学校客户端测试另覆盖课程路由转发、响应 schema 校验、伪造身份拒绝与撤权后缓存状态重放拒绝。

两轴审查后的修正包括：登记先按 `requestId` 返回已存储结果；同 `materialId` 相同内容可在新版本复用；课程/任务/发布登记改为冲突安全的插入后复核；列表保留缺失/损坏版本（打开时报告），撤销资格仍隐藏；创建成功前经正式读取路径核实；材料读取增加空间切换代际保护；标题字号与衬线遵循 DESIGN.md。二次审查后完成以下修正：

- 学校客户端代理加入 `courses`、`releases/:id`、开放材料、`course-activities`、`course-activity-results/:id` 路由，并按路由校验课程目录、发布、材料、活动结果和普通活动的响应 schema；伪造身份仍拒绝，未知管理路由仍 403。真实双运行时连接路径、假学校畸形响应和 Chrome 客户端流程均已回归。
- `setStatus` 的课程资格/资源读取移出学习数据事务；活动行锁内只执行所属数据库读写。缓存关闭/重开回执返回前重新核验当前课程资格，撤权后的原请求返回 403。探针测试禁止在学习数据事务内调用课程授权。

## 浏览器验收

真实 Google Chrome（Playwright `channel: chrome`，1440×900，Windows 11 x64），学校 profile，经支持的 `course-import`/`course-access` 入口登记后验收：

1. 登录学生页，看到课程、任务与“最近发布”版本。
2. 选择版本后看到目标、要求、开放材料、起始作品与固定能力引用；页面不含“教师私有测试”。
3. 读取开放材料得到 Blob 下载链接。
4. 从选定版本开始活动，活动页显示固定版本与内容摘要。
5. 刷新页面后活动仍在“我的学习活动”，可重开原版本。
6. 建立自主活动后两者同时存在；撤销课程资格并刷新后课程投影消失、自主活动保留；重新授予后恢复。
7. 已安装客户端经学校授权页连接后，在本地页面切换到学校空间，读取课程、发布、开放材料并从选定版本建立课程活动；证据截图 [客户端课程目录](evidence/wp02-course-chrome-client.png)、[客户端发布详情](evidence/wp02-course-chrome-client-release.png)。
8. 学校直连证据截图：[课程目录](evidence/wp02-course-chrome-catalog.png)、[发布详情](evidence/wp02-course-chrome-release.png)、[课程活动](evidence/wp02-course-chrome-activity.png)、[刷新后重开](evidence/wp02-course-chrome-reopen.png)。

## Apple Silicon Mac 验收（2026-10-31）

macOS 27.2（26B123），arm64；Node 24.21.0、PostgreSQL 18.6 使用产品分发包；本机安装的 Google Chrome 156.0.8078.79 有头执行，未用 Playwright Chromium 代替。验收代码提交 `6e7967a83215829803dbc6a078a6f233b420046d`（工作树干净），包含本轮验收前修复的启动就绪 `1f66b7c` 与状态探针 `6e7967a`，以及活动恢复 `44cb40e`/`949e707`；#151 的编辑器与测试宿主修复见[作品验收的 Mac 节](wp02-reliable-works.md#apple-silicon-mac-验收2026-10-31)。

工程结果：

- `npm run typecheck` 通过（contracts、storage、learning-space、server、product-runtime、web、local-runtime）；`npm run package:product -- --platform darwin-arm64` 全量构建与打包通过；8 个公共契约导出 browser-safe；文档链接检查通过。
- 课程原生 `course-releases.runtime.test.mjs` 4/4；学校代理 `school-client.test.mjs` 2/2；`learning-entry` + `learning-cli` + `works` 组合 10/10；均 0 失败、0 跳过。
- `worksEditor.spec.ts` 15/15 通过（真实 Chrome、产品宿主、原生 PostgreSQL 与真实文件资源）。
- 整合迁移谱系 **1/1 通过**：以 `c3308ac` 构建的真实 v2 作品库为源（迁移 1 `course-free-activities` + 2 `reliable-activity-works`），按正式隔离备份/恢复流程执行 `upgrade ... --file`（`kind: "schema"`）并接管；升级后迁移为 1/2/3（新增 `course-activity-coordination`），原活动与 BOM/CRLF 作品（91 字节、3 处 CRLF）的对象和内容标识不变，正式活动页显示原文，stop/start 后字节仍一致。普通启动路径未执行隐式迁移。见[升级证据](evidence/wp02-course-mac-schema-upgrade.json)。
- 启动就绪压力：同一产品环境连续 `stop`/`start` 10 次，10/10 返回 `ready`。

真实浏览器（学校直连 8 个流程、已安装客户端 5 个流程，全部通过）：

1. 登录学生页读取获准课程、任务与固定版本；发布详情固定版本、摘要、目标、要求、开放材料、起始作品与能力引用；页面与响应不含教师私有材料，私有材料直读 404。
2. 从 v1 建立活动；可靠编辑器自动保存中文作品；自主活动与课程活动并存。
3. 刷新、关闭/重新开始与产品 stop/start 后仍为同一 v1 活动与作品字节。
4. 登记 v2 后旧活动与作品不变；v1 仍可选且显示固定版本；最新发布显示 v2 要求与材料。
5. 删除/损坏 v1 材料时打开明确报错、不回退 v2；恢复材料后原活动可读。
6. IME 组合/换行/焦点、浅色/深色/窄屏在课程工作区可用；另以物理系统输入法执行课程编辑器验收：组字并选择候选（你好、世界、开始、结束）、Return 换行、Cmd+V 粘贴、Cmd+←/→ 光标与焦点切换均正常，正文为 `你好世界\n开始粘贴中文结束`。见[系统输入法截图](evidence/wp02-course-mac-system-ime.png)。
7. 撤销课程资格后目录投影消失，发布/活动/作品读取、新建、状态重放与活动结果查询均返回 403，自主活动保留；重新授予后原活动与作品恢复。
8. 撤销成员后会话失效，重新登录后可恢复。
9. 已安装客户端经学校授权页连接后读取课程、发布与开放材料，并从 v1 建立活动；刷新与客户端 stop/start 保持固定活动与作品；撤权在客户端返回 403 且个人作品保留；撤销连接移除学校空间并拒绝旧凭据；学校 stop 时报告不可用而非空课程，重启并刷新后目录恢复。

证据：[Mac 工程结果](evidence/wp02-course-mac-engineering.json)、[Mac 直连与客户端结果](evidence/wp02-course-mac-manual.json)、[v2→v3 升级证据](evidence/wp02-course-mac-schema-upgrade.json)、截图 [课程目录](evidence/wp02-course-mac-catalog.png)、[发布详情](evidence/wp02-course-mac-release.png)、[课程活动](evidence/wp02-course-mac-activity.png)、[客户端](evidence/wp02-course-mac-client.png)、[浅色](evidence/wp02-course-mac-light.png)、[深色](evidence/wp02-course-mac-dark.png)、[窄屏](evidence/wp02-course-mac-narrow.png)、[升级后活动页](evidence/wp02-course-mac-schema-upgrade.png)、[系统输入法](evidence/wp02-course-mac-system-ime.png)。

本轮修复与前后对比：

- 产品重启后 `start()` 可能在维护门重新打开前就返回 `ready`，后续首个请求得到 503 `maintenance`。修复后同一产品环境 10/10 返回就绪，重启后的课程与作品读取通过（`1f66b7c`）。
- `start()` 可在启动探针早于就绪标志时返回 `failed`（“PostgreSQL startup is in progress”）；修复为本次调用报告 `starting` 并重试查询（`6e7967a`），修复后压力 10/10。
- 首次 `context` 请求暂时失败时，从 URL 直达的活动会被列表覆盖并丢失；修复后恢复时仍打开原活动（`44cb40e`/`949e707`）。恢复瞬间可能短暂显示列表后重新打开活动。
- 验收宿主曾把 `devices['Desktop Chrome']` 的 Windows UA 带到 macOS Chrome，导致 Monaco 隐藏输入重复；改用真实 Chrome UA（`d417980`）。

已知限制：物理输入法验收使用本机已安装的豆包拼音；Apple SCIM 拼音不在当前实际启用的输入源列表中，未能以 Apple 的原生拼音实现复测。全量 `npm test` 未在最终提交重跑；教学效果未评估；跨机部署与接管仍由 #154 验收。

## 未执行与交接

- **Apple Silicon Mac 剩余项**：工程、原生 PostgreSQL、真实 Chrome、学校直连与已安装客户端流程、v2→v3 迁移和系统中文输入法物理键击已于 2026-10-31 在本机执行并通过（见上）；全量 `npm test` 与教学效果仍未执行。
- **教学效果**：本轮只验证工程与交互，未评估学生使用效果或学习收益。
- **混合部署与跨机接管**：由 #154 继续验收；本票提供可消费的公开接口、迁移和恢复校验。
- **全量本地套件**：`.verification/local-suite-2.log` 记录了当日失败；失败项位于未修改的连接/恢复测试、Windows symlink 特权与 `LOCAL_SOCKET_CONFLICT`。它们不计入本功能通过证据，也未被本次改动修复。

## 分支归并（2026-10-31）

按负责人要求将 #150 的提交归并回 `codex/wp02`，保留 #151 既有提交；不合并 main。合并时保留 #151 的 learning-data v2 作品迁移，将课程协调迁移追加为 v3；原独立课程分支的数据库迁移谱系与此不同，旧证据只证明原验收提交。整合结果须重新验证，不能据此宣称 Mac 已通过。

归并提交 `dd2300a` 同时保留 `c1720e1`（#150）和 `c3308ac`（原 wp02/#151）为祖先。课程与作品共用生产活动入口、课程授权、可靠工作区、HTTP 与学校代理。验收新增课程作品换版保持/撤权拒绝，以及原 v2 作品库升级到 v3 后原活动与作品保留。

- 全仓 `typecheck`、`build`、8 项公共契约浏览器导出检查通过；本次 4 文档、79 本地目标无断链。
- Node 24.21.0、Windows 11 x64、真实 PostgreSQL 18.6：课程 4/4、CLI 恢复 1/1、学校代理 2/2、作品持久化与备份恢复 1/1，共 8/8 通过，0 跳过。
- 本机桌面 Chrome 有头运行原 `worksEditor.spec.ts` 14/14 通过。整合复审另发现活动恢复先于课程目录返回时目录永久加载；新增真实服务回归先复现失败，修复为离开活动后重新加载列表，重建 runtime 并复跑新增用例 1/1 通过，Web 类型检查通过。两轴复审无剩余发现。
- 整合后的 `npm test` 全量套件与教学效果未执行；Apple Silicon Mac 已于 2026-10-31 在本机执行并通过（见上）；上文旧提交的 Windows 结果不冒充此次重新执行。产品运行测试只使用仓库外隔离临时环境，没有迁移已有用户环境。
