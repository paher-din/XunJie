# 06：一次固定快照 Core 运行与基础结果

**What to build:** 学生明确选择固定快照与 TextScope Core 参数，发起一次 C 运行，看到与该快照绑定的公开状态/诊断，再主动修订。

**Blocked by:** [03 确认保存与不可变快照](I0_UI_03_CONFIRM_SNAPSHOT.md)。

**Document status:** `implemented-and-verified`，准备模式交付。

**Status:** `preparation-delivered`：03 已交付，P-01 与 P-04/U-06 已落实；准备实现、两轴审查和浏览器验证已完成。真实运行对应 H 条件仍未交接，未执行真实节点验证。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §3/6～8；M-02/09/10、AC-04/10/12/15、NFR-03/04 前端责任。

负责一次 Core run 命令、已有 Job/Run 读取与基础结果；可写对应前端/同一 fixture/测试、本文。不实现编译器/worker/SSE/沙箱或调度，不改单作业/槽位/课程/共享字段。取消与未知核对归 06A，历史/产物归 06B。

## 2026-10-12 开工核对与实施范围

- 项目负责人要求开始 06，P-01 已落实；起点 `49fe588d4f859f6894072defe1fd2b73722a0029`，当前分支 `i0/ui-frontend`。已有未跟踪 `.zcodeignore` 排除本任务。
- 03 已实际交付；复用其唯一 confirmation 客户端、权威 Attempt 重读、已核验 snapshot 与 v2 outbox，不另建确认状态或升级数据库 schema。
- 已读 AGENTS、README、PRD §3～5/8、MVP_SPEC §1.3/M-02/09/10/AC-04/10/12/15/NFR-03/04、TECH_DESIGN §4.3/5/7.4/8、ENGINEERING_HANDOFF、接入规格、客户端约束及 03 实际交付，并核对服务端 inputs/commands/application 和 records/runner 公开投影。
- 可写对应学生 workspace 运行客户端、必要页面绑定、同一 prep fixture、测试、IMPORT_SOURCE、启动说明与本文。服务端、产品/参考/分工/规范、密钥及 CI/CD 只读。06A/06B 不在本任务实现。

### P-04/U-06 最小扩展提案（已批准）

项目负责人已明确回复“批准，按方案完成并本地提交”，批准以下最小 UI 扩展、设计先行流程与公开边界 TDD；不延伸到推送/发布、服务端 schema 或受保护文件。

沿用 03/04A/05 的设计仓库先行交付：在既有顶栏运行簇增加“Core 运行”入口，既有中心容器中提供纯 props 的运行参数/结果组件。学生明确选择已确认快照、该快照入口 `.c` 和输入文件实例，选择 stats/find/top，find 输入 word、top 输入 count；明确点击“运行此快照”。结果只读展示公开 Job 状态、网络读取未知、诊断可用性与 stdout/stderr，参数按本机原请求标来源，缺缓存标历史参数不可回取。保留编辑器和原页面/导航/框架；不提供取消、历史比较、产物或课程通过评价。

设计仓库组件评审、提交后搬入主仓库；两个仓库仅本地提交，不推送或部署。此提案不改共享 wire，也不授权受保护文档写入。

### 验证接缝

沿用 SPEC 已选定的公开 HTTP 与真实 `dev:prep` 浏览器接缝：断言实际 POST wire/先落盘/回执关联、GET Job/Run、真实 IndexedDB、刷新与跨标签，以及旧 poll 迟到。最少纯函数测试只核快照实例输入与公开投影验证。按 TDD 一条反例→实现→验证推进，不测 hook 私有细节。真实 readiness/H 条件未交接，不启动本机 C、不连接真实 runner/model。

### 实施中的验证设施修正

浏览器增量检查在页面初始化前复现 `marked.js`/`remend.js` 的 `504 Outdated Optimize Dep`；trace 显示业务请求未开始。harness 同时启动 prep/real 两个 Vite 进程，共享默认 `node_modules/.vite`，不同 mode 的预优化缓存互相替代。06 必要验证设施调整为按 mode 使用独立 cacheDir，不改请求/构建契约或测试断言，不安装依赖；原失败如实保留，重跑后另记结果。

另一浏览器缺本机参数的验收复现：prep 登录前读取的 context 未含获准 Attempt 引用，登录后仍沿用这份预登录投影，已有作品无法只读进入。仅准备初始化在登录后再 GET 同一个 context，核身份、分配及 preparation epoch；引用仍来自获准开发投影，不猜 ID、不补正式发现 API、不发创建命令。修正服务读取时序，不改变共享字段。

## Acceptance criteria（原验收保持）

- [x] 学生选确认 snapshot、入口 C 文件与 stats/find/top 参数，fileIds 引用该快照实例；不接受 shell/宿主路径，不从当前 draft 拼旧快照。
- [x] POST runs 使用权威 expectedAttemptRevision、snapshotId、runtimeProfileVersion、entryFileId/input/mode、代际和键；POST 前保留冻结原命令。成功回执只取得 runId/jobId，再 GET。
- [x] 同请求未知不能换键重跑；新参数只能是学生新操作。未核原请求/服务执行资格时阻止再次发起；具体核对/取消路径由 06A 交付。
- [x] 已有 GET Job/Run 有界轮询，隐藏/断线管理频率；每次 await 核上下文、代际、run/job/读取轮次，旧 running 不覆盖新终态。
- [x] 状态、网络未知与执行失败区分；stdout/stderr 仅取 diagnostics available，unavailable 不当空成功。编译位置缺失只读原信息，不发明未公开 phase/行列。
- [x] 当前编辑不改变旧 run 的 snapshot/hash。入口/参数仅来自已关联 runId 的本机冻结请求并标来源；GET 不补这些字段，换浏览器/缓存丢失时标“历史参数不可回取”。
- [x] 固定 Core 结果安全只读，不推为课程通过或能力评价；无正常宿主/readiness 不启动本机 C，准备结果明确合成。
- [x] 浏览器验证一次 Core 成功、编译/执行失败、输入/限额拒绝、运行中改稿、历史参数缺缓存及旧 poll；断言实际命令/公开 wire。工程检查记录准确结果。

## 交接与状态

01→02→03→06 即最小准备路径；不等 04/04A/05/06A/06B/07 才交这条能力。真实运行按客户端约束 §8 所需身份/保存/readiness/原 jobs/相应样例交接；不用完整历史输入投影作为前置。

已实现准备范围，未声称 I0-A 正式整链通过。真实服务、节点与模型验证**未执行**；取消与未知命令核对留给 06A，历史列表/产物留给 06B。产品基线进度**待授权维护者汇总**，本任务未写入受保护文档。

### 实际代码与交付

- 设计来源：`XunJie_Design@b4b857d6ec39f10be8112afaa6e9769dc6cb0e27` 的纯受控 `RunPanel.tsx/.css`，以及 `0e9d0af3e029d8c3611515ac1ce1e6936033e148` 的顶栏入口和 1280px 间距修正；仅本地提交，逐字节接收同名组件，未整包覆盖。
- `apps/student/src/workspace/runRequest.ts` 冻结快照/实例/Core 输入，`runContracts.ts` 仅公开投影，`runResults.ts` 核身份和结果来源，`runWorkspace.ts` 共用 03 的确认客户端、唯一 v2 DB/outbox 与窄 HTTP；没有 schema 升级或新依赖。
- `useRunWorkspace.ts` 等确认客户端初始化完成后只读已有记录；Job 后读 Run，防止终态与较早诊断交叉。可见 1s/隐藏 10s，离线暂停，每个 run 最多 60 次自动读取；主动重新读取重置预算，不创建运行。上下文/选择/初始化和结果读取序号阻止迟到回退。
- `confirmationDb.ts` 在同一事务阻止两标签争抢未决运行；明确未接受的运行保存拒绝事实，未知保留原请求。`confirmationWorkspace.ts` 的保存核对排除 `run.create`，不由保存重试代替 06A。
- `PrepWorkspacePage.tsx` 仅绑定纯 props 组件和现有容器。执行中仍可返回编辑，本机改稿不修改旧 snapshot/hash；本机参数须与 receipt/run/job/hash 绑定，缺缓存只显示参数不可回取。
- `prep/workspace.ts`/`plugin.ts` 扩展同一个 loopback fixture 的 POST runs、GET Job/Run 与 dev-only 脚本，不编译或执行学生 C，不生成正式学习记录。

### 两轴审查与修正

#### Standards

规范轴 1 项：内部事务异常进入学生提示。只允许 `RunInputError` 的明确输入提示进入界面，其余显示操作提示，原始异常进开发诊断。只读复审确认修正，未发现新的规范违规；顶栏来源组件的暂存接线也已核对关闭。

#### Spec

规格轴 2 项：旧代际历史 Job 被当作当前读取错误；准备程序失败被误建模为调度失败。已按 `server/workspace/commands.ts` 的 `reconcileRun`、`confirmNodeFailure`、公开投影修正：当前获准读取可保留原 Job 来源代际，新写入仍核当前代际；回取结果的程序失败是 Job `succeeded` 加 diagnostics failureKind，节点无结果失败才是 `failed` 加 unavailable。两项纯函数反例先失败再通过，浏览器覆盖同步修正。只读复审已核实际暂存修正与服务端一致，两项关闭，未发现新的可操作规格回归。

审查合计：Standards 1 项已关闭、剩余 0；Spec 2 项已关闭、剩余 0。规范轴最高影响为内部术语进入学生提示，规格轴最高影响为历史 Job 无法读取及错误的准备失败样例；各轴独立报告，不以工程通过替代规格审查。

### 验证记录

增量 TDD 已覆盖冻结请求、缺 word、ACK 丢失、较早 poll、编译/运行/超时/输出限额诊断、改稿/缺缓存、成功 POST 后 GET 403、find/top 输入、readiness 明确拒绝以及轮询断线/隐藏/上限。曾失败的验证：共享 Vite mode 缓存 504、登录后仍用预登录 context、新运行初始化竞争、GET 拒绝误记运行拒绝；分别修复后针对用例通过。新增检查也纠正了测试对 IndexedDB UUID 排序和时钟初始 poll 数量的错误假设，未放宽验收。

最终检查（2026-10-12，`apps/student/`）：

| 命令/检查 | 实际结果与覆盖 |
| --- | --- |
| `npm run typecheck` | 通过；浏览器 src 与 Node 侧 prep/e2e/vite.config |
| `npm test` | 20 文件、233 例通过、0 失败；06 两个纯函数文件合计 4 例 |
| `npm run build` | 通过；既有 Monaco 分块超过 500kB 提示保留，未关闭警告 |
| `CI=1 XUNJIE_E2E_PREP_PORT=5641 XUNJIE_E2E_REAL_PORT=5642 npm run test:e2e` | 全量 Chromium 74 例通过、0 失败；其中 `runResults.spec.ts` 15 例，真实 Vite 页面与 IndexedDB/公开 HTTP，3.6 分钟 |
| 1280×800 浅/深色截图及尺寸断言 | 通过；标签与合成身份标识不重叠，页面不横向溢出；Core 参数与只读诊断核对完成 |
| 设计来源逐字节核对 | 通过；`RunPanel.tsx` sha256 `dc6dc5a9350005e9cf07ba53fdc54ad8d4977aeff714b8a3268280ed6a1b3089`，CSS `e36bb61dbe64a532022db9130e3324cbff51acd516e4332d6e8ce35317a509d6`，与设计 `0e9d0af` 一致 |
| 交付文档相对链接、`git diff --check`、受保护目录差异 | 通过；README/学生 README/IMPORT_SOURCE/本文链接可解析，未写产品/规范/参考/分工或服务端；原 `.zcodeignore` 未纳入 |
| 生产构建隔离核对 | `dist/assets/*.js` 中未出现 dev-only `/__i0prep/run-script`、合成结果正文或 `prep-gen-`；真实模式的无 fixture/无回退浏览器检查通过 |

Vite 开发进程仍输出导入来源品牌 JSON 的 public 资产警告，Node 保留既有 localStorage/颜色变量警告；没有将其计为业务失败或通过。检查使用已安装依赖，未安装新包。

两仓库仅本地提交，不推送、不部署。README 与 IMPORT_SOURCE 已同步真实使用方式、来源范围与限制；产品基线汇总仍待获授权维护者处理。
