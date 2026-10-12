# 循阶 · 学生前端（XunJie `apps/student`）

XunJie 主仓库的学生端前端工程。首次内容由设计仓库 `XunJie_Design` 的固定提交导入，
来源版本、文件映射、许可与后续同步办法见 [IMPORT_SOURCE.md](IMPORT_SOURCE.md)。

**业务规则以主仓库基线为准**：[PRD](../../docs/product/PRD.md) →
[MVP_SPEC](../../docs/product/MVP_SPEC.md) → [TECH_DESIGN](../../docs/product/TECH_DESIGN.md)。
设计仓库的说明只作为 UI 来源参考（见下方「设计参考」），其中与主仓库冲突的业务描述不继承为契约。

## 运行

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

两个覆盖值仅影响测试，范围为 1024～65535，仍严格使用指定端口；`dev:prep` 默认 5601 不变。
两个 mode 使用独立 Vite 预优化缓存，避免同一次 harness 中互相替换依赖清单。

## 两种模式

依据 [客户端约束 §2](../../docs/tasks/I0_UI_CLIENT_CONTRACT.md)。模式在启动命令上固定，
运行期不切换，真实请求失败不回退到 fixture。

| | `npm run dev:prep` | `npm run dev` / `npm run build` |
| --- | --- | --- |
| 模式 | preparation（合成） | real |
| 窄客户端 base | `/__i0prep/api` | 同源 `/api` |
| 身份来源 | fixture 用合成账号建立的开发会话 | 服务端 Session |
| 数据来源 | Vite 开发进程内的 fixture authority | 真实后台（H-01 / H-02 交接后） |
| 准备入口 | 首页「I0 准备场景（合成）」卡片 | 不出现 |
| provider 连接测试 | 不外发，直接报能力不可用 | 保留原设计行为 |

准备 fixture 只在 `--mode prep` 的开发进程里挂载（`vite.config.ts` + `prep/plugin.ts` 的
`apply: 'serve'` 双重限定），只接受 loopback 请求，不导入 `apps/teaching` 的任何模块。
`npm run build` 的产物既不含这些端点，也不含合成账号与合成材料——它们全部留在 Node 侧。

真实模式目前没有可用的工作区初始化：正常业务宿主与同源 HTTPS 入口（H-01）、本人分配发现入口
（H-02）尚未交接。此时界面如实显示不可用条件与对应交接项，不硬编码正式对象 ID、不遍历猜测、
不回退到 Mock 成功。缺口清单见[准备记录 §5.2](../../docs/tasks/I0_UI_PREPARATION.md)。

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
  06 准备 fixture 仅返回合成状态与诊断，不编译/执行 C、不连接节点或模型；真实服务/readiness 未交接，
  见 [06 交付记录](../../docs/tasks/I0_UI_06_RUN_RESULTS.md)。
- 运行中的改稿只进入当前草稿；结果绑定旧快照。刷新只读已有结果，本机原请求参数标来源，另一浏览器
  缺缓存显示“历史运行参数不可回取”。ACK 丢失保留原请求并阻止重复运行，保存重试不处理运行命令；
  未知核对/取消归 06A，历史列表/产物归 06B。
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

`src/bridge/` 的 Mock 适配器是导入来源自带的演示数据层，驱动首页任务卡、看板与 Agent 对话页；
它**不是** I0-A 的传输层。I0-A 的工作区数据只走 `src/workspace/` 的窄 HTTP 客户端，
两者不共享身份、草稿或运行状态。

## 测试

| 命令 | 范围 | 说明 |
| --- | --- | --- |
| `npm test` | Vitest（Node 环境） | 导入来源规则、原文保真、冻结回执与摘要/Core 输入/公开结果；fixture HTTP 验证会话/权限/双键/拒绝原子性/持久读取与快照 |
| `npm run test:e2e` | Playwright（Chromium） | 启动 `dev:prep` 与 `dev`，在真实页面上断言可见正文、状态、真实 IndexedDB 与实际请求；含 06 运行结果与轮询边界 |

`test:e2e` 会自动拉起两个 dev server（`reuseExistingServer: !process.env.CI`：本地已在跑则复用，
CI 一律新起，避免断言打在陈旧进程上）。首次使用需安装浏览器：`npx playwright install chromium`。

e2e 的成功响应来自同一开发进程 fixture；故障用例延迟真实回执、注入本机事务 abort 或损坏读取摘要，
核对拒绝/保留行为，不伪造成功路径。真实模式断言「如实没有可用初始化」。因此 e2e 通过只说明本批准备范围，
不代表真实服务联调通过，也不代表任何 AC / NFR 或 G0～G4 条件已验收。

## 设计参考

导入来源自带的说明文档留在设计仓库，按固定提交查阅（不随本目录同步）：

- 设计系统令牌：[docs/DESIGN.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/DESIGN.md)
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
