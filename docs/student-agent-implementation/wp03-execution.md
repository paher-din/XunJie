# #170 浏览器计算与持久执行请求

日期：2026-11-03。状态：本地候选实现（Apple Silicon Mac 已用真实浏览器、真实 Worker/WASM、原生 PostgreSQL 验证）；Windows 11 x64 与基线前后截图未执行，不标记本票完整验收。

## 依据与授权

- [实施票 #170](https://github.com/paher-din/XunJie/issues/170)、[WP03 规范](specs/wp03-course-components-and-execution.md) §8–§14 与 Testing Decisions。
- 基线 `3c906528`（`fix(wp03): renew component channels and persist operation receipts`），分支 `wp03`。
- 本票只做浏览器有限作业链：固定输入 → 可靠接收 → 真实计算 → 查询/停止 → 结果重读。持续会话（§10）、远端节点与 WP07 Agent 命令不在本票。
- 未创建 PR、未合并 main、未关闭 #170。

## 方案与写集

执行命令沿既有 WP02 可靠动作链交接，浏览器侧新增独立执行账本与执行器控制器；服务端在 learning-data owner 内新增独立 `tool-execution` 事实集。组件不自行组装依据、计划或上限，视图与工作区面板共用同一份装配。

可写：contracts 的执行/组件 wire、learning-space 执行 owner 与 HTTP 入口、product-runtime 的 CSP 与学校转发、Web 执行模块与产品面板、`components/table-aggregation` 样例、探针脚本与本记录。只读：产品设计、其他 WP 规范、既有课程/工作区实现。

## 实现与接口

- `@xunjie/contracts/execution`：`executionLimits`（5000 ms、256 页 = 16 MiB 算法内存、1 MiB 输入、1 MiB 输出、2 并发、4 排队）、`executionPlan`（`location:'browser'`、`kind:'job'` 单一执行位置）、`executionAction`（protocolVersion 2、`kind:'execution'`、按接收方能力 refine、≤4 MB）、`executionAcceptance`（accepted ⇔ 带执行引用）、`executionQuery`（`state`/`statusKnowledge`/`stopRequested`/`confirmedSeq`/`reason`/`output`）、`advanceExecution`（确认终态不倒退、`stopRequested` 只增不减）。旧问题动作无版本字段，仍按原字节、摘要、取消事实与回执核实。
- 清单新增 `algorithm`（`mediaType:'application/wasm'`、入口、`memoryPages ≤ 256`）与 `operations`（参数/结果 `StateShape`、每次预算），导入兼容：未声明算法/操作的旧组件照常登记与使用，只是 `execution.*` 返回不可用。
- learning-data owner 迁移 6 `durable-browser-executions`：`execution_commands`（命令体、原回执、状态、确认序号、原因、输出）、`execution_stops`（稳定 stop 身份）、`execution_results`（结果绑定 contentId/sha256/字节数）。只写自有三表与真实收到资源的 `_storage_references`。
- 接受先验证：活动归属与课程发布绑定 → 命令体 schema → 浏览器回执摘要（服务端按 schema 解析后重算）→ 依据（入口/算法摘要、状态副本内容摘要与期望 contentId）→ 同身份重放返回原记录、换输入 `identity-conflict`。命令与引用同一事务写入；顺序不依赖工作区先上传。
- `GET/POST /api/learning/executions/<activityId>[/<requestId>[/report|stop|result]]`：接受 8 MB、报告与停止小体、结果 8 MB；主体/空间/活动校验沿用原 subject 与 namespace 规则。`releases/<id>/components/<key>/algorithm` 与视图同源授权返回固定算法字节。
- 浏览器账本：IndexedDB `xunjie-reliable-works-v1` 从 4 增量升到 5，新增 `executionCommands`/`executionPending`/`executionStops`/`executionResults`/`executionSync`，不改旧分区。记录与待处理事实同事务提交后才回报 `accepted`；`claim` 在同一事务写 `running` + 属主代际，`adopt` 只接管从未开始的记录，`record` 拒绝旧代际提交（`stale-generation`）。
- 执行器：每次运行一个专用 ES module Worker，宿主持有唯一线性内存并限制 `maximum = initial = memoryPages`；只允许 `env.memory` 一个导入，无导入外调用；`jobFromAction` 由 ABI 模块把固定命令翻译成作业，控制器不解析组件语义；超时/停止一律 `terminate()`，不留下“显示已停但仍在跑”的线程。并发用 `xunjie-execution-slot:<n>` Web Locks 跨标签页准入，无 Web Locks 时退化为同页上限并如实说明只缺跨标签页能力。
- 停止：稳定 `stopId` 由调用方持有，重复点击是同一次停止；未开始 → 记录为不可复活的取消；已开始 → 终止 Worker 并由执行器确认，原回执保持 `accepted`。查询可按 `requestId + inputDigest` 定位，摘要不符返回空而不是别人的运行。
- 结果：文本产物先在本机落盘并核对可读，再发布引用，最后同步；`executionSync` 记录命令/事实序号/结果三段投递状态，丢确认只续原资源，不重算。
- 产品接线：中心工具区内嵌组件视图，下方「计算记录」由执行控制器驱动（不依赖 iframe），提供参数/输入行数、改动提醒、停止、核对、下载；`ActivityActions` 按动作种类分别呈现问题动作与执行记录，接收成功不等于完成。
- 产物 CSP：静态资源只加 `wasm-unsafe-eval`（WebAssembly 编译所需），`unsafe-eval` 仍禁止；组件视图保持 `script-src 'unsafe-inline'`、`connect-src 'none'`、`sandbox allow-scripts`。

## 样例与可重复入口

[`components/table-aggregation`](../../components/table-aggregation/README.md)：`view.html` 可编辑表格、选分组/数值列、count/sum/mean、显示结果与下载 CSV；`algorithm.wat` 是自包含线性聚合算法（无导入，除宿主内存），`algorithm.wasm` 与清单摘要固定；`package.mjs` 输出可导入包，`build.mjs` 用 `wabt` 重建算法（`wabt` 仅为开发依赖，运行时不依赖）。

```sh
node components/table-aggregation/package.mjs
node apps/local-runtime/dist/cli.js component-import --root <产品私有目录> --file dist/table-aggregation/component.json
node apps/local-runtime/dist/cli.js course-import --root <产品私有目录> --file <发布.json>
npm run probe:execution          # 需 XUNJIE_PRODUCT_POSTGRES_BIN 指向产品自带 PostgreSQL
```

探针在真实安装的产品上导入组件、发布课程、登录、打开活动，不依赖测试接收器。

## 验收记录

### 工程

- 环境：macOS 27.2（build 26B123）、Apple M5（arm64）、Node 24.21.0、桌面 Google Chrome 156.0.8078.79（非 headless）、产品自带原生 PostgreSQL 18.6。
- `npm run verify`：prepare（typecheck、build、`check:contracts:browser`、`check:docs`）、build:test、unit、server 全部通过；tools 组两项失败，见“未执行与已知失败”。
- 单元与集成：`store.test.ts` 10/10、`action.test.ts` 3/3、`runner.test.ts` 3/3、`aggregation.test.ts` 14/14、`bridge.test.ts` 5/5；`apps/server/tests/execution.runtime.test.mjs` 1/1（真实 API、原生 PostgreSQL 与资源、原回执、停止、单份结果、未引用状态副本被拒）；`packages/product-runtime/test/school-client.test.mjs` 2/2（五条执行路由与算法路由转发、畸形 503、他人活动/主体 403、非 UUID 403、`/dispatch` 403、算法包字段）。
- TDD 覆盖的公开边界：作用域键一致、同身份换输入拒绝、接受前取消成持久阻断、终态不被较晚旧事实覆盖、单执行器 claim 与旧代际 `stale-generation`、只在未开始时 adopt、按执行引用读结果、停止走真实 abort 且原接收不变、未知请求查询为空、查询摘要不符为空、同一 stop 身份只留一条、能力上报的计划与上限等于被接受的命令。

### 真实计算

10 项浏览器探针全部通过（`.verification/wp03-170/browser-report.json`，证据副本 `evidence/wp03-170-browser-report.json`）：

1. 固定数据表在正式工作区内渲染；2. 非数值单元格让真实算法拒绝计算并指出「第 2 行」；3. 真实分组统计与独立预期一致（A 组 4 项、求和 332、平均 83）；4. 工作区记录显示参数与「该次输入共 12 行」；5. CSV 真实下载（`聚合结果-mean.csv`，`A,4,332,83,73,92`）；6. 两个准入槽都被占住时运行停在队列，停止后服务记录 `cancelled`、`stopRequested=true` 且执行引用未变；7. 整页刷新只重新查询原记录、不重算；8. 运行后改表会提示「当前表格已改动」；9. 浅色（1440×1000）、深色（同尺寸）与窄桌面（900×900）截图取自这次真实运行；10. 切换工具后记录与下载仍在。

实测数字不是硬编码：算法按输入表计算，负例由真实 `第 2 行` 违反结构产生。

### 平台浏览器

- Apple Silicon Mac + 桌面 Chrome：上述 10 项通过，浅色/深色/窄桌面均实际渲染（深色截图底板取到 `#1f1f1f`，不是浅色误报）。

## 发现并修复

- 记录作用域用了命令中的对象而读取用工作区键，导致查询查不到：`accept` 改为接收工作区作用域，读写同键。
- `acquireSlot` 在锁回调内才 resolve 的写法会永久等待：改为在回调内确认准入、`release` 单独控制持有。
- 产品静态资源 CSP 缺少 `wasm-unsafe-eval`，Worker 里编译 WASM 直接 `CompileError`：只加这一个指令，不加 `unsafe-eval`。
- 接受时要求状态副本已同步到服务端，而工作区上传顺序独立：改为校验命令自带的状态字节。
- 面板在无结果时也显示输入行数；「已取消」曾被当成失败文案；`83.33333333333333` 曾直接显示。
- 契约审查后修复：`execution.capabilities` 上报的计划摘要漏了 `operationId`、并发上限写死为 1、运行/排队数写死为 0；执行命令把整个工作区塞进依据（无关保存会改摘要、逼近 4 MB）；停止身份每次新建；查询不校验输入摘要；`executionSync` 分区只写不读；队列上限实际只按“等待数”计，2+4 只排到 4；无 Web Locks 时静默不限并发；控制器内混入表格聚合语义；面板字号/圆角/说明字未走 DESIGN 阶梯。

## 未执行与已知失败

- **Windows 11 x64**：未执行。需用 Windows 原生包与自带 PostgreSQL 在桌面 Chrome 上重跑 `npm run probe:execution`；本记录不把它记为通过。
- **基线前后对照截图**：未重新在基线 `3c90652` 上采集「修改前」。正文 `wp03-169-after-light.png` 是同一活动在 #170 之前的产品 UI（无运行/停止与「计算记录」），仅作参照；本票新增界面的对照图属未执行项。
- **`tools/xj-dev` 两项失败**：`repro-e2e.test.mjs`、`repro-restore.test.mjs` 报 `LOCKFILE_MISMATCH`。原因是 `collectCode` 从 `HEAD` 树取 `package-lock.json`，而本票新增 `wabt` / `fake-indexeddb` 尚未提交；提交后应以同一命令复跑确认。
- `local-status.test.mjs` 曾在一次 verify 中失败，原因是同时运行 `npm install` 干扰；`npm install` 落定后复跑通过。
- 仅 `executionSync` 的续传逻辑按“已确认则不重发”实现；未在真实断网-重连中注入验证。
- 未验证：系统中文输入法候选、Apple Silicon Mac 上的学校网页执行路径、跨机远端执行（属后续子票）、教学效果判断。

## 保留消费者

`CODE_TOOLS` 仍由 `pages/WorkspacePage.tsx` 消费，`textscope-c` 仍由 `pages/PrepWorkspacePage.tsx` 消费；本票未删除仍有消费者的旧接线，也未把执行能力并入旧课程分支。
