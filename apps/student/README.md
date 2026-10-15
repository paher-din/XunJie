# 循阶 · 学生前端（XunJie `apps/student`）

旧 PAHER 连接与维护入口已退役。当前服务地址、身份、证书及连接步骤由负责人私下发放；仓库仅保留[通用基础设施模板](../../tools/i0-cloud/README.md)。下方旧现场记录保留原验证来源，不作为当前连接说明。

XunJie 主仓库的学生端前端工程。首次内容由设计仓库 `XunJie_Design` 的固定提交导入，
来源版本、文件映射、许可与后续同步办法见 [IMPORT_SOURCE.md](IMPORT_SOURCE.md)。

**业务规则以主仓库基线为准**：[PRD](../../docs/product/PRD.md) →
[MVP_SPEC](../../docs/product/MVP_SPEC.md) → [TECH_DESIGN](../../docs/product/TECH_DESIGN.md)。
设计仓库的说明只作为 UI 来源参考（见下方「设计参考」），其中与主仓库冲突的业务描述不继承为契约。

页面、组件、样式或交互修改前先读主仓库 [DESIGN.md](../../docs/DESIGN.md)，遵循其中的视觉与交互规则，复用原有组件；缺真实数据时按实际可用字段呈现，不另写一套简化 UI。

教师工作台复用此工程与设计系统。真实入口 `/#/teacher` 使用现有登录与任教课程授权，接通材料、原生蓝图编辑/检查、三角色预览、确认分配、固定提交审阅、正式反馈及修订、修订许可和后续项目复制；学生在原任务页的“提交与反馈”中明确提交并主动消费许可。真实材料按既有后端限额 256 KiB 导入，权限默认关闭。操作结果未知时保留原字节与幂等键，通过“核对原教师操作”读取原回执。

教师“工作台设置 → 模型”（`/#/teacher/settings/model`）直接复用学生模型设置页：供应商、API Key、模型能力/上下文/最大输出、默认模型、思考强度、连接测试和个人启停均使用当前教师账号的后台配置。Key 留空保留原值，服务端读取仅返回脱敏状态，不与学生账号共享。开发教师预览不加载真实配置；教师项目设计的模型预算仍由原宿主开关控制。

这些能力要求显式启用复核的 41 表教学宿主；原本机环境与旧 PAHER 共享入口已退役，当前从负责人私下发放的云端共享入口进入 `/#/teacher`。原教师任务没有向当时的 PAHER 共享库部署；当前云端接收与状态见[云端任务](../../docs/tasks/I0-UI_CLOUD_SHARED_ENTRY.md)。教师模型预算保持关闭，项目从真实已确认范例进行手工设计。开发专用 `/#/teacher/preview` 仍提供隔离交互预览，示例数据不进入正式构建，也不补齐真实请求失败。原任务授权、备份与验证见 [教师任务记录](../../docs/tasks/I1-TEACHER_UI_WORKBENCH.md)和[受控验证工具](../../tools/teacher-workflow/README.md)。

真实项目设计页新增“AI 协助设计”：新项目可请求项目候选或完整建议，已保存草稿可请求允许字段内的局部建议或样例量规试评。只选择获准教师设计用途的材料段落；试评样例另须教师明确确认。根候选采纳为新草稿时保留已选课程配置，已有草稿采纳产生新 revision；文字目标与量规建议仍须教师建立正式关联、保存并检查。任务可以取消、刷新后读取及按原请求核对；人工修改后旧候选保留对照但不能覆盖。该入口消费真实 API，未配置 provider 或预算时显示实际拒绝，不回退示例。共享运行环境的 provider/预算接线与部署状态见[本轮记录](../../docs/tasks/I1_TEACHER_DESIGN_AI_UI_20261015.md)，本地源码完成不表示云端已更新或真实模型已调用。

## 运行

团队演示和共用任务连接负责人私下交接的共享 HTTPS 宿主，由同一服务提供页面、API 和数据库；不执行本机初始化或 `dev:prep`，这些开发命令用于隔离验证。连接工具的通用结构见[基础设施模板](../../tools/i0-cloud/README.md)。姓名、课程名、项目显示标题来自 Session 与分配的后端资料，缺字段时保留原 ID/Activity 标题，历史交付见[共享资料记录](../../docs/tasks/I0-UI_SHARED_DATA_ENTRY.md)。

代码区支持 C/头文件、Verilog/SystemVerilog 的语法高亮。已有确认实例的当前草稿在输入停顿后自动做静态检查，错误显示波浪线，悬停可读消息；下方“编辑检查”可展开问题列表。新文件或文件生命周期变更先“确认保存”一次，之后修改草稿无需再次保存即可检查。暂停过程采集、尝试不可编辑或限定检查期间停止自动检查；检查故障不阻断编辑保存，检查完成不等于课程验收通过。

正常自动检查需要教学后端与专用 VM 的诊断通道；参考 [编辑器交付记录](../../docs/tasks/I0-UI_EDITOR_HIGHLIGHT_DIAGNOSTICS.md)。浏览器专项为 `e2e/editorDiagnostics.spec.ts` / `editorHighlight.spec.ts`；真实 HTTPS/SQLite/VM 专项为 `editorDiagnosticsService.spec.ts`，显式指定 `XUNJIE_E2E_SERVICE_NODE` 与 `XUNJIE_E2E_DIAGNOSTICS_CONFIG`（已有本机宿主配置的路径，只读复用 SSH 设置）。执行身份需显式指定时使用 `XUNJIE_E2E_SERVICE_USER`，其取值与材料由负责人私下交接。缺条件的 skip 不计通过；该专项仅创建独立合成账号/项目，不操作现有学习会话。

需要 Node 24（与 `apps/teaching` 已批准的工具环境同一大版本）。本机默认 Node 更高时，
自行把 Node 24 的可执行目录放到 `PATH` 前面——机器专有路径不写进仓库文件。
本工程有独立的 `package.json` 与 `package-lock.json`，与 `apps/teaching` 的后端互不依赖，
不需要设计仓库的本地 checkout。

```sh
cd apps/student
npm ci               # 按本目录的 lockfile 安装
npm run dev:prep     # http://127.0.0.1:5601  准备模式（可交互，带开发 fixture）
npm run dev          # http://127.0.0.1:5180  真实模式（同源 /api）
npm test             # Vitest：已确认的领域规则 + 准备 fixture 契约核对
npm run typecheck    # tsc：src（浏览器侧）+ prep / e2e / vite.config（Node 侧）
npm run build        # 类型检查 + 产物构建（不含准备 fixture）
npm run test:e2e     # Playwright：真实 Vite 页面上的准备模式与真实模式检查
```

`dev:prep` 与 `test:e2e` 用固定端口 + `--strictPort`：本机常同时跑着设计仓库的 dev server
（5180 / 5199 / 5290 等），端口漂移会让断言打到错误的进程上。端口被占时命令会直接失败。
保留已有服务时，可明确指定 harness 端口：

```sh
XUNJIE_E2E_PREP_PORT=5603 XUNJIE_E2E_REAL_PORT=5604 CI=1 npm run test:e2e
```

三个覆盖值仅影响测试，范围为 1024～65535，仍严格使用指定端口且互不相同；`dev:prep` 默认 5601 不变。
浏览器 harness 为 prep、real 和重启用独立服务分别使用 `.playwright/node_modules/.vite-<角色>-<端口>` 预优化缓存，避免相同 mode 或共享依赖的工作树互相替换模块。缓存路径保留 `node_modules` 段，使预优化依赖不被当成应用源码再次转换。由 harness 设置 `XUNJIE_VITE_CACHE_DIR`，通常无需手工配置；普通开发命令继续沿用原 mode 缓存。
缓存、异步前置与原12项失败的逐项复验见[续查记录](../../docs/tasks/I0-UI_BROWSER_REGRESSION_FIX.md)。

`XUNJIE_E2E_RESTART_PORT`（默认 5611）是 [07](../../docs/tasks/I0_UI_07_BROWSER_HANDOFF.md) 的
「准备进程重启」用例独占的端口：那条用例自己拉起并**杀掉**一个 dev:prep 来复现换 epoch，
所以不能复用 playwright.config 里那两个全程存活的 webServer。

要在**本机安装的真实 Chrome**（而不是 Playwright 自带 Chromium）上取证：

```sh
XUNJIE_E2E_BROWSER_CHANNEL=chrome npm run test:e2e
```

只换浏览器实现，不换用例、不换断言；不设该变量时仍是自带 Chromium，保证任何人跑同一道门禁。

## 两种模式

依据 [客户端约束 §2](../../docs/tasks/I0_UI_CLIENT_CONTRACT.md)。模式在启动命令上固定，
运行期不切换，真实请求失败不回退到 fixture。

| | `npm run dev:prep` | `npm run dev` / `npm run build` |
| --- | --- | --- |
| 模式 | preparation（合成） | real |
| 窄客户端 base | `/__i0prep/api` | 同源 `/api` |
| 身份来源 | fixture 用合成账号建立的开发会话 | 服务端 Session |
| 数据来源 | Vite 开发进程内的 fixture authority | 正常教学宿主的获准公开 API |
| 准备入口 | 首页「I0 准备场景（合成）」卡片 | 不出现 |
| provider 连接测试 | 不外发，直接报能力不可用 | 保留原设计行为 |

旧现场曾通过受限连接和严格两端 TLS 同源接入正常 `dist` 与真实 `/api`，没有回退 fixture；[I0-UI55](../../docs/tasks/I0-UI55_BROWSER_ENTRY.md)保留当时 C1 浏览器结果与固定来源，不再提供当前连接或维护步骤。

准备 fixture 只在 `--mode prep` 的开发进程里挂载（`vite.config.ts` + `prep/plugin.ts` 的
`apply: 'serve'` 双重限定），只接受 loopback 请求，不导入 `apps/teaching` 的任何模块。
`npm run build` 的产物既不含这些端点，也不含合成账号与合成材料——它们全部留在 Node 侧。

真实模式沿 `/#/task/<assignmentId>` 获准分配深链，读取当前 Session、授权 bootstrap、固定活动与公开材料，
在同一工作区接入确认作品和辅导。载入只读，创建 Attempt、保存、冻结和求助仍需明确操作；
未登录时显示账号/密码表单；从深链登录后继续原任务，从首页登录后选择本人获准的学生课程与分配。当前35表两课程宿主提供真实任务列表，标题来自固定活动学生投影；课程按服务端课程标识展示，暂停任务标明暂停。正常首页沿用原“问候/日期→学习看板→课程与任务”结构、默认任务完成/热力卡、编辑与添加托盘及内嵌任务入口。当前后端没有完成率、活跃时长汇总接口，按负责人本轮授权，仅看板使用源 `demoDashboard` / `demoTasks` 并标注“演示统计”；演示完成比例与本人真实分配数分开显示，内嵌“当前获准任务”入口仍打开本人真实任务，不生成学习记录。课程内沿用原任务卡、搜索和已分配/暂停筛选，不把分配有效状态当作学习进度。列表失败可重试，原授权深链仍可使用；旧 C-only 宿主未提供列表，不回退演示任务。原入口与组件恢复见[首页真实任务入口](../../docs/tasks/I0-UI_REAL_HOME_ENTRY.md)、[原看板接回](../../docs/tasks/I0-UI_HOME_DASHBOARD_RECONNECT.md)；本轮数据核查与验证见[看板展示数据](../../docs/tasks/I0-UI_DASHBOARD_DISPLAY_DATA.md)。
会话失效后重新登录同账号可恢复该账号的本机草稿；首页账号菜单及工作区「退出」实际结束服务端会话。
退出未确认时先重试退出，不能将网络失败显示为成功；账号改变立即隔离旧展示与在途响应。
密码不进入本机存储；身份/CSRF 只取服务端 Session。登录/会话请求等待上限15秒，失败不自动重试。
缺权限或可信代际时显示不可用条件，不硬编码正式 ID、不遍历猜测、不回退准备数据。
跨设备 Attempt 发现未提供；同一浏览器的已有原请求与引用仍沿确认库恢复。
正常宿主须由维护者提供受控 HTTPS、现有配置/数据库与节点来源，接线与隔离服务证据见
[真实入口记录](../../docs/tasks/I0-B_REAL_ENTRY.md)和[正常宿主组合](../../docs/tasks/I0-B_HOST_COMPOSITION.md)。

真实 Core 运行复用现有顶栏与参数面板：初始化及每次明确新运行先核同源 `/health/ready`，失败只禁新运行，编辑/保存、已有结果、停止和原请求核对仍可使用。正常宿主再核当前权限、代际和固定 profile；健康状态不能替代运行命令的授权。停止受理后等原 Job 确认终止，执行未知不自动补跑；历史参数只显示经回执关联的本机原请求，完整公开产物核字节/摘要后才能下载，读取不写回作品。实现、依赖接纳及验证边界见 [UI-REAL-09/10/11](../../docs/tasks/I0-UI_REAL_RUN_CONTROL_HISTORY.md)。

本批专项先 `npm run build`，沿上面的 `XUNJIE_E2E_SERVICE_NODE`、Chrome 和独立端口条件执行：
`npm run test:e2e -- runService.spec.ts runControlService.spec.ts runHistoryService.spec.ts --workers=2`。
专项以实际登录表单、正常 HTTPS/SQLite/原消费者验证前端；执行器仅为隔离私有 transport，不编译或运行真实 C，不计节点隔离、生产恢复或课程检查通过。缺服务运行时的 skipped 不计通过。

本批会话入口的实现/失败/实际 HTTPS 合成验证见 [I0-UI 登录与会话](../../docs/tasks/I0-UI_AUTH_SESSION_ENTRY.md)。
运行浏览器专项：`npm run test:e2e -- sessionEntry.spec.ts sessionService.spec.ts real-mode.spec.ts`。
`sessionEntry` 为前端协议故障回放；`sessionService` 须设置 `XUNJIE_E2E_SERVICE_NODE` 指向已有教学 Node 24.21.0，
沿原隔离宿主使用正常 dist、HTTPS/SQLite 和两个合成账号；先 `npm run build`。Windows 沿已有 Ubuntu WSL 运行，
变量为该环境可执行路径；缺该条件时专项明确 skipped，不计通过。表单凭据仅私有内存/stdin，专项关闭 trace。
临时自签 TLS 只在测试 context 忽略证书错误，不改变正常浏览器信任；验证关闭测试连接后核宿主退出，
原工厂的合成数据库按既有审计边界保留。此验证不连接真实学生、执行节点或供应商。

## I0-A 准备场景

从首页「I0 准备场景（合成）」卡片进入 `/#/task/i0-prep-textscope-c`，是固定的合成
C / TextScope 活动，**不是正式 Assignment**，不写入学习记录。

- 复用原设计的页面骨架与容器：顶栏（标签槽 + 运行簇槽）、左侧胶囊「任务信息」、中心工具区
  （胶囊标签 + 分屏拖拽）。没有新造页面或导航。
- 01 只做只读初始化：读取合成 Session、固定活动版本（student 视角）、按 visibility 裁剪的材料。
  载入不创建 Attempt、不开始学习。
- 点击「开始 Attempt」后，中心「设计」标签接入 02 的多文件编辑器与本机草稿。学生主动确认保存后
  才形成服务端确认作品；冻结仅包含确认作品，快照 GET 核验完整清单/原文/hash 后才显示详情。
- 刷新回取同一开发进程的确认头和快照；本机新编辑不被 ACK 正文覆盖。原请求未完成时先核对并重试，
  使用原键和完整输入。fixture 重启或恢复代际变化会保留草稿并提示重新比较，旧 outbox 不自动补发。
- 草稿 CAS 冲突后保留败方候选，当前加载禁止重复覆盖或上传；明确刷新或工作区重新读取会载入赢家正文。
  已确认实例被恢复移除时，其草稿仍可打开，不能自动当新文件补发。完整比较/选择界面属于 04A。
- 冻结后进入顶栏「Core 运行」，明确选择快照、C 入口和输入文件，使用 stats/find/top 并点击「运行此快照」。
- 运行中可明确“停止此运行”。停止受理后仍等待原 Job 的 `cancelled` 等权威终态；断线不显示已停。原运行/停止请求未知时主动“核对原运行请求”，只重放同代际冻结原命令，表单修改不改变原正文；已有回执只读原 Job/Run，旧代际不换键补发。实现与真实交接边界见 [06A](../../docs/tasks/I0_UI_06A_RUN_CONTROL.md)。
  06 准备 fixture 仅返回合成状态与诊断，不编译/执行 C、不连接节点或模型；原准备交付事实见 [06 交付记录](../../docs/tasks/I0_UI_06_RUN_RESULTS.md)，较新的真实接线与分层证据见 [UI-REAL-09/10/11](../../docs/tasks/I0-UI_REAL_RUN_CONTROL_HISTORY.md)。
- 运行中的改稿只进入当前草稿；结果绑定旧快照。刷新只读已有结果，本机原请求参数标来源，另一浏览器
  缺缓存显示“历史运行参数不可回取”。ACK 丢失保留原请求并阻止重复运行，保存重试不处理运行命令；
  未知核对/取消已由 [06A](../../docs/tasks/I0_UI_06A_RUN_CONTROL.md) 接入。
- 运行面板点击“历史运行与产物”后可选择两条已有记录，分别保留 run/job、固定 snapshot/hash、profile/image、模式、状态和公开输出。
  参数只来自经过原回执、请求摘要与快照实例核验的本机冻结请求；缺缓存或关联损坏时仍可读公开结果，显示“历史运行参数不可回取”。
  历史选择/主动重读只 GET，挂起时仍可切换；迟到响应不覆盖新选择。课程检查仅显示公开 verdict/failureKind，产物保持 redacted。
  完整公开文件经 run/snapshot/稳定 ID/hash/UTF-8 bytes 核验后可以展开只读文本、下载原字节；missing/incomplete/unavailable 分别提示，校验失败不能下载。
  当前活动没有 Report 创建能力，历史读取不扩课程、不自动写回文件。详见 [06B](../../docs/tasks/I0_UI_06B_RUN_HISTORY.md)。
- 06B 的开发专用 `POST /__i0prep/history-sample`（带开发 Session CSRF 与场景头）接收 `attemptId`、已有 `snapshotId` 和 `sample`：
  `check`/`complete`/`missing`/`incomplete`/`unavailable`/`unknown`。这些来自公开契约的隔离合成历史样例只用于读取验收；`report.txt` 是批准文件白名单的样例，不代表 Core 已实现 Report，也不产生正式教学记录。
- 手动复现停止进度可使用同一开发故障入口 `POST /__i0prep/run-script`（带开发 Session 的 CSRF 与场景头）：先设 `{"outcome":"running"}` 再主动运行/停止，设 `{"outcome":"cancelled"}` 后重新读取才能看到合成停止确认；`outcome_unknown`/`stale` 用于原结果未知场景。这些脚本只在 `dev:prep` 中可用。
- Job/Run 读取可见 1s、隐藏 10s、离线暂停，单次自动读取最多 60 轮；暂停后可主动重新读取。
- 保留的 board / wave 标签是**数字逻辑演示**，与当前 C 活动无关，已明确标注。
- C 场景不提供模拟构建 / 烧录入口，也不自动触发引导层与浮动 IP 教学。

原数字逻辑演示（`/#/task/counter`）完整保留：入场任务卡、静态代码、虚拟板、波形、模拟构建
与引导脚本都照原样工作，并新增了演示身份标识。

## 目录

```
src/
  bridge/     类型化本地接口（learningApi）+ Mock 适配器与演示数据（导入来源）
  brand/      定稿 Logo、双叶芽原图图层、动作与保真对照页（导入来源）
  components/ 外壳、输入框、状态/进度、工作区容器（导入来源 + C 容器适配）
  icons/      本地图标库与维护看板（导入来源，见 src/icons/README.md）
  lib/        纯函数领域规则（排序、逾期、继续任务选择），Vitest 覆盖（导入来源）
  pages/      首页、Agent 对话页、设置页、任务工作区、任务入口分发、C 准备工作区
  styles/     语义令牌与组件样式（导入来源 + I0-A 准备场景样式，见 app.css 末尾分节）
  workspace/  I0-A 工作区适配层（XunJie 维护）：模式、契约投影、窄 HTTP 客户端、
              上下文与 loadEpoch、初始化读取、会话、原命令与原子确认、快照读取和唯一 IndexedDB
prep/         准备模式的 Vite 开发 fixture（Node 侧，不进客户端 bundle）
e2e/          Playwright 检查：真实 Vite 页面上的准备模式与真实模式
public/       品牌 IP 与字体资产（导入来源）
```

`src/bridge/` 的 Mock 适配器是导入来源自带的演示数据层，驱动准备模式首页任务卡/看板与演示 Agent 对话页；正常首页课程及任务使用真实分配读取，仅看板按本轮授权使用原演示统计并明确标注。
它**不是** I0-A 的传输层。I0-A 的工作区数据只走 `src/workspace/` 的窄 HTTP 客户端，
两者不共享身份、草稿或运行状态。

## 测试

UI-PREP-01/03/06专项沿上述独立端口、Chrome和原harness运行：
`npm run test:e2e -- idempotencyConflict.spec.ts keyboardWorkflow.spec.ts tutoringFailure.spec.ts`。
它们核原业务键冲突、连续Tab操作/焦点返回及辅导故障的学生提示，仍是合成准备验证。

UI-PREP-05独立冷启动采样使用原Vite配置，每个mode/样本新建私有预优化缓存，不复用或删除共享缓存；
打开真实Chrome，prep进入编辑区，real停在正常登录入口（该采样没有教学宿主）。从本目录执行：

```sh
node tools/sample-cold-start.mjs --samples 2 --port-base 5791 --output cold-start-result.json
```

两端口须空闲；输出文件须为新路径，工具不覆盖已有证据。JSON分别记录启动/页面加载、依赖响应、失败、
关闭/退出码与端口回收；本次生成的私有缓存只在路径和进程关闭核实后清理。已有业务/共享缓存保留。
该采样不含npm首次安装、真实HTTPS账号、执行节点或NFR负载验收。原始采样与现场入口准备见
[本批记录](../../docs/tasks/I0-UI_PREP_VERIFICATION_CLOSEOUT.md)。

2026-10-13，I0-B在同一C准备工作区提供项目、确认文件/选区和原运行求助入口。任务信息内可查看政策和分别设置尝试、过程采集、里程碑提醒；学习助手复用现有对话容器，仅显示完整正文，查看合成相邻资料后可返回原作品。发送、停止、核对原请求及回应均由明确操作发起。准备模式不请求供应商、不执行学生代码；正常模式仍按原宿主/身份/入口条件进入，失败不回退准备数据。执行范围、原请求/回执/控制及未完成契约见[I0-B计划](../../docs/tasks/I0-B_UI_TUTOR_PLAN.md)。

过程采集开关表示服务允许接收的区间；当前页面尚未自动上传逐次编辑过程，正常宿主尚未组合自动分析与提醒调度。本批负责控制UI与已交契约的消费，不把这些后台工作追加给前端。准备例子由Robert与Agent共同设计，来源明确标为合成；刷新阅读后只保留本机原文件引用并说明精确位置未保留，原实例已变时不把旧位置贴到新作品。

准备辅导专项使用上述同一Vite authority、浏览器和IndexedDB。在学生目录运行以下命令，Chrome可按上述变量选择。

```sh
npm test -- tutoring
npm run test:e2e -- tutoring
```

`tutoringService.spec.ts` 另使用正式 `dist` 和实际教学 HTTPS/Session/CSRF/SQLite/持久 worker，
仅在明确提供 `XUNJIE_E2E_SERVICE_NODE` 时执行。Windows 当前 harness 使用 WSL2 Ubuntu，变量须指向
该环境的 Node 24.21.0 可执行文件，教学原 lock 依赖及 native 模块须已就绪；Linux可直接提供本机路径。
先 `npm run build`，再设置该变量运行 `npm run test:e2e -- tutoringService.spec.ts --workers=1`。
未提供运行时的 skip 不计通过。测试只用离线合成 provider、独立合成库和临时测试证书；
忽略自签名证书仅是该用例条件，未改变正常应用 TLS 或系统信任，不代表受控部署、真实模型或真人验收。

| 命令 | 范围 | 说明 |
| --- | --- | --- |
| `npm test` | Vitest（Node 环境） | 导入来源规则、原文保真、冻结回执与摘要/Core 输入/公开结果；fixture HTTP 验证会话/权限/双键/拒绝原子性/持久读取与快照 |
| `npm run test:e2e` | Playwright（Chromium） | 启动 `dev:prep` 与 `dev`，在真实页面上断言可见正文、状态、真实 IndexedDB 与实际请求；含 06 运行结果与轮询边界 |

`test:e2e` 会自动拉起两个 dev server（`reuseExistingServer: !process.env.CI`：本地已在跑则复用，
CI 一律新起，避免断言打在陈旧进程上）。首次使用需安装浏览器：`npx playwright install chromium`。

默认两个 worker 并行独立 spec，文件内仍顺序执行；每项保留独立浏览器上下文，写场景用 UUID
隔离 fixture。重启用例独占第三端口，剪贴板用例保持同文件顺序。资源有限时可用
`npm run test:e2e -- --workers=1`；不增加 retries 或缩减反例。

开发时按受影响行为选择 spec，例如编辑器改动先跑
`npm run test:e2e -- editor.spec.ts editorProtection.spec.ts confirmation.spec.ts`。
最终提交候选再跑完整 `npm run test:e2e`；专项通过与全量通过分别记录，不重复跑无新增疑点的全量。

准备 e2e 的成功响应来自同一开发进程 fixture；故障用例延迟真实回执、注入本机事务 abort 或损坏读取摘要，
核对拒绝/保留行为，不伪造成功路径。普通真实模式检查区分缺会话/缺深链和明确标注的公开协议替身；
上述实际HTTPS专项另验正常dist、真实Session与持久服务，并包含跨账号的旧控制ACK隔离。因此准备 e2e 通过只说明本批准备范围，
不代表真实服务联调通过，也不代表任何 AC / NFR 或 G0～G4 条件已验收。

## 已准备的本机真实 C / HDL 入口

原本机宿主的历史配置及仍保留的专用执行 VM 见 [tools/i0-hdl](../../tools/i0-hdl/README.md)；当前业务入口按负责人私下发放的云端连接资料使用。从实际 Assignment 深链进入原登录页面；只有获准的 `execution.kind=hdl_board` 使用真实 HDL 分支。构建引用确认快照，装载引用成功 Build；板卡和有限 Trace 只展示原节点返回的四态信号与时间。普通 C 保留 Core/历史入口。

课程首页将同一学生、同一课程中标题、活动正文、材料、帮助政策和执行配置均相同的多次分配显示为一个任务入口；不同内容仍分别显示。重复分配的原深链及作品记录保持可访问。本次 ALU 列表去重与验证见 [任务记录](../../docs/tasks/DL-UI_ALU_TASK_DEDUP_20261015.md)。

先检查并构建，再装载到虚拟板，才能操作按钮和开关。板卡旁显示禁用原因及已确认输入；推进周期必须是1～5000000的整数。会话结束后可显式“重新装载已构建设计”，状态不确定时使用“读取板卡状态”。输入确认而输出不变时，检查已装载HDL是否使用该输入；未绑定的按钮/复位不可操作。全板修复与验证见[本轮记录](../../docs/tasks/DL-UI_BOARD_INTERACTION_FIX.md)。

本批固定源码、原始结果、正常 Chrome 截图、真实模型展示及失败记录见 [逐项回交](../../docs/tasks/evidence/ui30-hdl-20261015/handoff.md)。这些是开发隔离合成验证，真人及完整产品验收另计。

## 设计参考

设计系统已接收到主仓库；其余来源说明按固定提交查阅：

- 设计系统与 UI 修改规范：[DESIGN.md](../../docs/DESIGN.md)
- 首页 / 课程任务 / 工作区：[docs/home-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/home-design.md)
- Agent 对话页：[docs/agent-page-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/agent-page-design.md)
- 设置页信息架构：[docs/settings-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/settings-design.md)
- 前端技术选型：[docs/frontend-architecture.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/frontend-architecture.md)
- 领域词汇：[CONTEXT.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/CONTEXT.md)
- 品牌资产：[docs/brand-assets/xunjie-logo/README.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/brand-assets/xunjie-logo/README.md)
- IP 动作精修：[docs/research/brand-ip/motion-refinement/README.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/research/brand-ip/motion-refinement/README.md)
- IP 道具修正：[docs/research/brand-ip/props-refinement/README.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/research/brand-ip/props-refinement/README.md)

源码注释里出现的 `docs/xxx.md`、`docs/prototypes/xxx` 等相对路径都是**设计仓库**的路径，
基准是上面这个固定提交；它们不是本仓库的失效链接，也没有随导入复制过来。其中桌面宿主、
匿名本地使用、自动引导、能力百分比等描述与主仓库基线冲突，不作为正式契约继承。

图标库的来源、许可与补绘说明见 [src/icons/ATTRIBUTION.md](src/icons/ATTRIBUTION.md)；
字体许可正文见 [public/fonts/OFL.txt](public/fonts/OFL.txt)。

## 技术选择

| 领域 | 采用 | 说明 |
| --- | --- | --- |
| 界面 | React 19 + TypeScript + Vite 7 | 导入来源 |
| 路由 | React Router（hash） | 导入来源；静态资源加载无需服务端路由回退 |
| 异步数据 | TanStack Query + 本地接口适配 | 导入来源，驱动演示数据层 |
| 弹层 | Radix Dialog | 导入来源 |
| 样式 | CSS 语义令牌 + 普通样式表 | 导入来源；无 Tailwind |
| 验证 | Vitest（规则）+ Playwright（浏览器） | Vitest 是导入来源；Playwright 由 I0_UI_01 引入 |
| I0-A 传输 | 自写窄 HTTP 客户端（`src/workspace/`） | 只消费可序列化契约投影，不导入服务端模块 |

编辑器路线见[客户端约束 §4](../../docs/tasks/I0_UI_CLIENT_CONTRACT.md)：02 在本工程内使用
`monaco-editor@0.57.0`（已安装并精确锁定），不另起前端工程、不退回静态代码行。

## 个人模型配置与独立聊天

新版正常宿主提供个人模型 API。登录后进入「设置 → 模型」，添加公网 HTTPS 的 OpenAI 兼容 Base URL、API Key 和准确的模型 ID，选择默认模型并启用。界面等待服务端保存成功才生效；重新打开只显示 Key 是否已保存与掩码，浏览器不持久保存明文 Key。连接测试由服务端读取供应商模型列表，不等同于付费生成验证。

同账号页面会同步已确认的模型选择；切回页面时重新读取。发送同时核对发起页的配置版本；若其他页面已改动配置，先刷新选择并保留原问题，由本人核对后重新发送，不自动换模型或档位。

独立对话生成中刷新会读取并接回原回合；连接中断时保留原问题与已收到正文，通过“核对原回合”继续接收，接纳回包丢失时沿原幂等键核对。停止或失败后排队问题仍可显式发送。复制操作只在剪贴板实际成功后显示“已复制”。

首页点击吉祥物或旁边的提问气泡，输入后按 Enter 或点发送会直接进入独立 Agent 对话页；原问题先在对话中显示，服务端接纳后地址更新为原会话。连接中断时在该页核对原回合，不在首页等待整条回复完成。

在独立对话中明确询问本人课程任务时，服务端会按当前登录账号读取真实分配及固定活动公开标题，交给本轮模型回答；普通闲聊不把任务清单发给模型。与课程首页一致，同课程中公开活动内容、材料、帮助政策和执行配置相同的历史分配只算一个可见任务，优先链接开放的分配；原分配、作品和深链仍保留。现有数据只有分配开放/暂停状态，没有任务完成标记，因此 Agent 应列出可见任务并说明完成状态未知，不能把它们直接称为未完成。读取失败会保留错误，不回退演示任务。回复成功落定且明确提到一项本人任务时，正文下显示任务卡；点击「进入任务」打开对应分配的工作区，工作区会重新核验权限。回复涉及多项、同名但内容不同的任务或部分清单时，不显示猜测的卡片；卡片不显示不存在的进度和截止时间。实现与验证见[任务上下文记录](../../docs/tasks/I0_UI_AGENT_TASK_CONTEXT_20261015.md)、[任务卡接线](../../docs/tasks/I0_UI_AGENT_TASK_CARD_20261015.md)和[可见任务口径修复](../../docs/tasks/I0_UI_AGENT_VISIBLE_TASKS_20261015.md)。

工作区辅导窗口随视口放大，可用“展开阅读”切换大窗口；Enter发送，Shift+Enter换行，收起保留草稿。问答沿原Job关联排列，来源与教学历史可展开查看；向上阅读时不会自动拉回底部，可点“回到最新消息”。工作区显示真实生成进度，并在原政策与版本检查后交付完整回答。

项目内辅导和独立 Agent 页下一次发送使用本人已确认的模型、low/high/max、上下文窗口及最大输出配置；独立聊天支持真实流式正文、停止、继续、重新生成与编辑重发。思考强度按供应商协议发送，未指定则沿供应商默认。切换页面会请求停止原回合，原始历史保留，模型失败不回退演示回复。两处个人调用均不设总思考时限，收到保活、推理或正文会续期，仅连续600秒完全无网络活动才结束；每回合一次调用，不自动重试。项目辅导保留原帮助政策和投递守卫，非个人通道沿原限制。没有实际用量时保持未知。

独立 Agent 页可选择或拖入PNG、JPEG、GIF、WebP图片，支持只发图片。选择声明支持图片的模型后，显式发送会将原图内容与问题一起保存到本人会话并发送给该供应商；刷新、编辑问题和重试保留原图，历史缩略图可下载。每张内联图片最多32 MiB，整个请求（包含历史图片和base64编码）最多48 MiB；DeepSeek还沿其官方尺寸/数量限制。超限、格式错误或模型不支持时明确失败，不悄悄丢图或自动改模型。视频/PDF仍仅是能力声明，本轮不支持其附件发送；项目内辅导继续使用文字及原受信上下文。

普通 `npm run dev` 仍需同源真实 `/api`；它不自带正常后端。准备模式继续使用明确的隔离演示，不发送 Key 或模型请求。部署时要同步新版 `apps/teaching` 服务端、学生构建产物及对应宿主工具；仅刷新浏览器或拉取源码不会替换现有部署副本。

标准受控配置可选添加 `personalModels` 对象，字段为绝对路径 `directory` 和布尔值 `callsEnabled`；未指定时使用课程数据库同目录下的 `personal-agent`。此目录受限、位于源码外，含获准四表的 `personal-agent.sqlite` 与 `credentials.key`。二者需一起受控备份，不能把数据库或主密钥提交进仓库。原课程库不迁移；停用调用保留配置和历史。具体授权、API 与验证见[本轮任务](../../docs/tasks/I0_UI_MODEL_CONFIGURATION_REAL_CHAT.md)。
