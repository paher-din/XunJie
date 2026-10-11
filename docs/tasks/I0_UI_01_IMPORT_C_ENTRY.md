# 01：固定版本导入、C 容器与初始化读取

**What to build:** 团队从 XunJie 独立启动现有前端与可交互准备模式，进入明确标识的 C/TextScope 容器，读取固定要求/资料，同时保留原数字逻辑演示。

**Blocked by:** None（无 ticket 前置；非 ticket 前置仍须落实）。

**Document status:** `delivered`（01 范围已实施并验证；后续能力按 02/03/06 与 H-01～H-06 分别推进）。

**Status:** `delivered`。P-01 编码指令由前端接入成员 2026-10-11 对本任务的执行指令落实；P-03 中 `@playwright/test` 同日获明确批准并安装锁定版本，另新增的 `@types/node` 超出 P-03 字面清单，已于 2026-10-12 获前端接入成员追认保留（理由与影响见交付段）。P-02（IndexedDB 新库）不属 01 范围，仍归 02；P-04 的 U-02～U-06 归后续 ticket，U-01/U-07/U-08 在 01 内按既有容器落实，U-07 的真实登录 UI 缺口保留。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[准备记录](I0_UI_PREPARATION.md) §2～5、[导入决定](I0_UI_ADR_0001_DESIGN_IMPORT.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §1～3/7/8；PRD-02、M-02 的工作区责任。实施前阅读相关基线正文。

负责独立前端导入、来源映射、C 现有容器适配、初始化读取客户端与可启动 fixture。可写导入工程及其精确依赖/测试/使用说明、本任务；主 README 只同步实际启动。后台、Design 工作副本、其他任务和受保护基线只读。开工登记实际写集。

## 已确定的接入做法

1. 仅从已提交 Design commit 的 `app/` 已跟踪子树导入 `apps/student/`，包括源码/public/package/lock/必要测试与来源许可；不复制工作副本、node_modules、dist、临时 harness。若升级核查来源 commit，先审差异。
2. XunJie 维护草稿/认证/保存/运行业务；后续视觉按“上次接收来源→新来源”差异选择同步，不能整包覆盖。记录来源、目标映射、许可和冲突处理。
3. 前后端独立构建/lock，不改后端启动、依赖或 CI，不引入目录链接、子模块或 monorepo 工具。02 在该前端内用 `monaco-editor`，不另起工程。
4. 本任务拥有 POST sessions、GET session、POST logout、获准 Assignment/Activity/Resource 读取的窄客户端。准备身份由明确 fixture 生成；真实身份来自 Session，现有昵称不构造权限。首次 Attempt 创建归 03。
5. 准备运行和 authority/模式选择严格采用客户端约束 §2；后续保存和运行扩展同一客户端/fixture。缺真实入口保留不可用，不发明发现 API。

## 开工登记（2026-10-11）

- **授权范围：** 前端接入成员对本任务的编码指令（P-01）；`@playwright/test` 开发依赖的明确批准（P-03 的测试依赖部分）。不含受保护基线写入授权，不含 IndexedDB 建库（P-02，01 不需要）。
- **分支：** 主仓库新建 `i0/ui-frontend`（自 `main` @ `0afd008c91373f82bde707aaeb26bc6b3dfd74e4`）。
- **初始 Git 差异：** 开工时主仓库工作区只有未跟踪的 `docs/tasks/I0_UI_*`（规划文档）与 `.zcodeignore`，无任何已跟踪文件修改；`apps/` 下仅有 `apps/teaching/`。
- **实际写集：** 见交付段文件清单。未触碰 `apps/teaching/`、`docs/product/`、`docs/planning/`、`docs/reference/`、`AGENTS.md` 与设计仓库工作副本。
- **来源选择：** 准备记录核查来源为 `1f0a71a`；开工时设计仓库 HEAD 已前进。冻结在 `a9bb1dd016489d3e60e0b45933e440296c1194d8`（已推送 `origin/main`、工作副本干净）。理由与 `1f0a71a..a9bb1dd` 的 20 文件差异、执行期间观察到的并发提交，均记于 [IMPORT_SOURCE.md](../../apps/student/IMPORT_SOURCE.md) 第 2 节。执行期间设计仓库从 `5a9486b` 前进到 `a9bb1dd`，导入只认固定 commit，不追 HEAD。

## Acceptance criteria

- [x] 选定提交的工程在无需 Design checkout 时按独立 lock 安装、启动和构建；来源/许可/清单可核，失效说明链接修到主仓库或可访问的固定来源。
- [x] 从已有任务入口进入 C 中心容器，不落在原“工具包待接入”整块占位；复用中心胶囊/标签/分屏。正文区域明确“编辑待 02 接入”，不假称已可保存；不新造页面/导航。
- [x] 原数字逻辑卡片、静态代码、板卡、波形仍可访问且标演示；C 载入不触发模拟构建或主动教学。
- [x] `npm run dev:prep` 无自动化拦截也能读合成 Session、固定 TextScope 活动/资料与当前 fixture 状态。普通 dev 用真实模式；失败不 fallback，正式 build 不带 fixture 控制端点/材料。
- [x] 初始化按现有 HTTP 信封读取，保留 Assignment/ActivityVersion/Resource 归属和 visibility；缺失/redacted 不补正文。载入不创建 Attempt、不开始学习。
- [x] GET Session/活动/材料每次 await 核模式、身份、loadEpoch/读取轮次；失效响应不更新当前工作区。真实登录 UI 未交付时记录 U-07，不自建页面。
- [x] 准备 provider 连接测试不外发；学校模拟测试保留模拟标识，I0-A 不发教学模型请求。
- [x] 获准安装 `@playwright/test` 后以实际 Vite 准备命令建立最小 harness，验证入口、模式、材料、刷新与演示保留；不通过第二套测试内假业务完成验收。
- [x] typecheck、既有 test、build 与该切片浏览器检查通过，记录精确版本/命令/结果；不记真实产品通过。

## 交付记录

### 代码位置

| 内容 | 位置 |
| --- | --- |
| 导入工程 | `apps/student/`（227 个文件，来源 `XunJie_Design@a9bb1dd0`） |
| 来源映射/许可/同步办法 | `apps/student/IMPORT_SOURCE.md` |
| 准备 fixture（Node 侧，不进 bundle） | `apps/student/prep/{scenario,authority,plugin}.ts` |
| 模式与端点选择 | `apps/student/src/workspace/mode.ts` |
| 契约可序列化投影 | `apps/student/src/workspace/contracts.ts` |
| 窄 HTTP 客户端（信封解包/失败分类/CSRF） | `apps/student/src/workspace/http.ts` |
| 上下文与 loadEpoch / 读取序号 | `apps/student/src/workspace/context.ts` |
| 初始化读取序列 | `apps/student/src/workspace/init.ts` |
| 会话（POST logout） | `apps/student/src/workspace/session.ts` |
| 准备入口常量 | `apps/student/src/workspace/prepEntry.ts` |
| React 绑定 | `apps/student/src/workspace/useWorkspaceInit.ts` |
| 任务入口分发 / C 准备工作区 | `apps/student/src/pages/TaskRoute.tsx`、`src/pages/PrepWorkspacePage.tsx` |
| C 容器内容块 | `apps/student/src/components/workspace/TextScopePanes.tsx` |
| 中心容器 C 变体 | `apps/student/src/components/workspace/CenterToolArea.tsx`（`variant` / `designBody` / `runCluster`） |
| 浏览器检查 | `apps/student/e2e/{env,prep.spec,real-mode.spec}.ts`、`playwright.config.ts` |

修改的导入文件：`vite.config.ts`、`package.json`、`package-lock.json`、`README.md`、`src/main.tsx`、`src/pages/HomePage.tsx`、`src/pages/WorkspacePage.tsx`、`src/components/workspace/CenterToolArea.tsx`、`src/lib/connectionTest.ts`、`src/styles/app.css`（末尾追加准备场景分节）、`src/icons/README.md`。主仓库仅改 `README.md`（启动与导航）与本任务文档。

### 验证事实

环境：Node v24.18.0、npm 11.16.0、vite 7.3.6、vitest 3.2.7、typescript 5.9.x、`@playwright/test` 1.64.0（chromium 1248）、`@types/node` 24.19.2。命令均在 `apps/student/` 执行。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 独立安装 | `npm ci` | 通过（136 包；不依赖 Design checkout） |
| 类型检查 | `npm run typecheck` | 通过（`tsc --noEmit` + `tsc --noEmit -p tsconfig.node.json`） |
| 既有测试 | `npm test` | 通过（7 文件 82 项） |
| 构建 | `npm run build` | 通过（996ms） |
| 浏览器检查 | `npm run test:e2e` | 通过（13/13，Chromium，webServer = `dev:prep` 5601 与 `dev` 5602） |
| fixture 契约核对 | 16 条 curl/node fetch 断言 | 通过（信封、401/403/400、CSRF、三种材料状态、私有正文零泄露、student 视图无 `sourceRevision`） |
| 构建产物不含 fixture | `grep -r` dist | `__i0prep`、`i0-prep-textscope-c`、`prep-student-01`、`准备场景（合成）`、合成活动标题全部 ABSENT |
| 人工浏览器复核 | browser-use（内置）+ user-browser-use（用户 Chrome） | 首页准备入口、C 容器、任务信息胶囊（4 条材料 available/available/redacted/unavailable）均按预期；截图 5 张 |

e2e 覆盖：入口与合成标识、C 中心容器（非占位）、正文「编辑待 02 接入」、初始化端点与无写命令、合成身份与 U-07 缺口、三条能力线与活动要求、材料三态与零泄露、无模拟构建/烧录/引导层、board/wave 演示横幅、原数字逻辑演示（入场卡/静态代码/板卡交互/波形/模拟构建 toast/演示标识）、provider 测试不外发与学校测试标模拟、刷新重读、真实模式无 fixture/无入口/无回退数据源/演示保留。

### 未完成与缺口（如实）

- 真实模式工作区初始化不可用：H-01（正常业务宿主与同源 HTTPS 入口）、H-02（本人分配发现入口）未交接；界面显示具体不可用条件，不回退。
- U-07 真实登录 UI 未交付：准备会话由 fixture 用合成账号建立，界面明确标注；不自建登录页。
- 编辑（02 / `monaco-editor`）、确认保存与快照（03）、运行与结果（06）未接入；界面以能力边界清单如实展示。
- fixture authority 的会话不回收（开发进程内累积，重启重置并换 epoch）；属开发工具边界，不影响断言。
- `@types/node@24.19.2` 超出 P-03 字面清单（vite 的可选 peer；fixture 与 Playwright 配置为 Node 侧代码，需要它才能被 typecheck 覆盖）。types-only，无运行时影响。**2026-10-12 前端接入成员追认保留**，P-03 的批准范围据此包含该开发依赖。
- 内置浏览器首张截图视口偏窄导致首页入口卡片布局失真；已用计算样式（body 636px / 按钮 144px，flex 生效）与用户 Chrome 全宽截图复核为正常，非样式缺陷。
- 未执行：真实服务联调、IndexedDB 建库（P-02，归 02）、Monaco 适配验证（归 02）、真人教学效果。

### 基线汇总请求（待授权维护者处理）

- [MVP_SPEC §10 实现进展](../product/MVP_SPEC.md)：新增学生前端工程 `apps/student/`（固定提交导入）与 I0-A 准备范围（两种模式、只读初始化客户端、C 容器适配、最小浏览器检查）；本任务不越权写入。
- TECH_DESIGN：无服务端技术契约变更（fixture 为开发进程工具，响应形状照抄现有契约，不新增正式接口），无需同步。
- 依赖差异：`@playwright/test@1.64.0`（2026-10-11 批准）、`@types/node@24.19.2`（超出字面清单，2026-10-12 追认保留）。

## 交接与状态

输出来源映射、两种模式启动方法、初始化/上下文边界、C 可用容器、同一进程 fixture 与浏览器 harness；03/06 在此基础上扩能力。真实读取可按客户端约束 §8 独立接入，不等执行 worker 或完整分配列表。

02 可复用的边界：`src/workspace/` 的模式/信封/上下文守卫与 fixture authority；`prep/plugin.ts` 的路由表是 03/06 扩展保存/快照/运行的唯一挂点。07 收口时直接扩 `e2e/`，不需要重建 harness。
