# 06B：历史运行比较与公开产物

**What to build:** 学生只读比较已有运行的快照、来源明确的参数、状态与输出，并查看可公开的检查/结果文件。

**Blocked by:** [06 一次固定快照 Core 运行与基础结果](I0_UI_06_RUN_RESULTS.md)。

**Document status:** `implemented-and-verified`，准备范围已实现，两轴审查与全量工程/浏览器回归通过。

**Status:** `preparation-delivered`：2026-10-12 项目负责人指派实施，P-01 已落实；06 已准备交付，负责人已批准 P-04/U-06 历史/产物最小扩展与两仓库本地提交。06B 准备范围交付完成，真实 H-06 联调与正式产品验收仍后置。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §6/7/8；M-02/09、AC-04/12/15。可写已有结果容器的比较/产物、窄 files 客户端及测试、本文；不改 Run 投影、课程检查或私有资料规则。

## Acceptance criteria

- [x] 两次既有 run 分别保留 run/job、snapshot/hash、profile/mode、状态和输出；失败/未知也可比较。
- [x] 参数仅在本机原请求经回执关联后展示并标来源；另浏览器/缓存丢失或未关联时明确不可回取，比较仍显示已有公开事实。禁止 fixture 为 GET Run 加 input/entryFileId/inputHash。
- [x] 课程检查只显示公开 verdict/failureKind，HTTP course_check 与节点 check 分层；不得补私有测试输入/答案/stdout，也不将 Job succeeded 当检查通过。
- [x] files 的 redacted/unavailable/missing/incomplete 单独显示；available 文件核 run/snapshot/id/hash/bytes/状态，有完整文本才允许查看/下载。检查产物 redacted 不补正文。
- [x] 固定活动确有 Report 能力才使用其允许参数/产物名，公开可回取时才显示产物；无此能力保持不可用，不扩课程或造报告内容。
- [x] 比较/下载只读、安全展示，不能写回 ProjectFile、改当前草稿/旧快照或覆盖失败结果。
- [x] 浏览器验证参数有/无本机来源、跨上下文历史读取、check 裁剪、产物缺失/不完整/hash 不符与合法下载，断言无隐式写请求；工程检查记录事实。

## 2026-10-12 开工核对

- 起点 `163e9c738a048a9cc360cfbcea6b49332cf60b48`，当前分支 `i0/ui-frontend`；已有未跟踪 `.zcodeignore` 保留且排除提交。06/06A 已准备交付，06B 不依赖取消能力。
- 已读 AGENTS、README、PRD §3～5/8、MVP_SPEC M-02/03/07/09/10、AC-04/12/15、TECH_DESIGN §4.3/4.4/5/7.4/8.3/8.4、ENGINEERING_HANDOFF、I0_UI_SPEC、CLIENT_CONTRACT §3/6～8、06/06A 记录；核对实际 `readWorkspace`、`runDiagnostics`、`readResultFiles` 和公开路由。
- 可写学生 workspace 历史/结果文件窄客户端、必要公开投影校验、同一 prep fixture、测试、README/IMPORT_SOURCE 与本文。产品/规划/参考/规范、服务端、schema、依赖、凭据、CI/CD 只读。
- GET Run 的 `mode=check` 与 HTTP 创建的 `course_check` 分层；结果文件公开项只有 runId/snapshotId，无 snapshotHash。客户端以已核验 Run 关联 snapshotHash，不造 wire 字段。文件 ID 按服务端 `sha256(JSON.stringify([runId,snapshotId,caseIndex,relativeName,contentHash]))` 核验，文本核 UTF-8 bytes/hash；missing/incomplete 不开放正文或下载。

### P-04/U-06 最小扩展提案（已批准）

项目负责人明确回复“批准，按方案完成并本地提交”；批准下述范围，不延伸到共享契约、受保护文档、schema、推送或发布。

在现有 RunPanel 的结果位置增加“历史运行与产物”入口，仍用现有中心容器。纯受控历史组件支持选择两个已有 run，各自只读显示 run/job、snapshot/hash、profile/image、模式、状态、来源标记和公开输出；检查仅显示 verdict/failureKind。每侧的结果文件区单列 redacted/unavailable/missing/incomplete，只有来源、ID、字节数、hash 和完整状态均核验的文本提供只读查看/下载。返回原 Core 控件，保留编辑器与现有页面/导航/框架。

沿用 06 的设计仓库先交付纯 props 组件并本地提交，再选择性接入主仓库；设计写集仅相应组件、样式及该交付记录。主仓库业务客户端独立维护，不回写 HTTP/存储到设计仓库。两个仓库仅本地提交，不推送或发布。固定 Core 活动没有 Report 参数/产物能力，保持 Report 不可用；不新增 Report 创建或课程检查命令。公开历史允许读取已存在的检查/Report 结果，不扩活动。

### 验证接缝

沿用已选定公开 HTTP/实际 `dev:prep` 浏览器接缝和最少纯函数校验：真实 IndexedDB 回执来源、刷新/第二浏览器缺参数、两运行固定来源、GET 文件校验、私有检查裁剪、迟到响应及查看/下载无写请求。UI 批准前先完成独立客户端和非 UI 校验；真实 H-06 未交接，真实节点/模型/教学验收未执行。

## 交接与状态

不等 06A 取消；真实历史按公开投影即可接，产物按对应 H-06 样例接，不能因缺完整参数而私改后台。准备实现、两轴审查、全量工程与浏览器检查已完成；真实服务、节点/模型、H-06 联调与教学效果验收**未执行**。产品基线进度**待授权维护者汇总**。本任务不推送或发布。

## 实际实现与来源

- 设计固定来源 `XunJie_Design@16558426ce70524218eacbf7ce8fde35681c0503`（前置 `a124fee`）：纯 props `RunHistoryPanel.tsx/.css` 和 `RunPanel.tsx` 可选历史入口；仅本地提交，主仓库选择性接收并逐字节核对，未覆盖页面或整包同步。设计仓库 Node 24.18.0 下 10 文件/106 项测试、含 tsc 的构建、内存 props/SSR 检查通过；设计独立浏览器未执行，主仓库承担实际接线验收。
- `apps/student/src/workspace/runHistory.ts` 使用唯一 confirmation 上下文、公开 head/Job/Run/files 与现有 v2 outbox。历史列表与两侧读取独立序号，切换、重读和卸载失效旧读取；不会调用 run/cancel/sync 的 POST。参数同时核原回执、Job receipt ID、run/job/snapshot/profile/hash、原冻结请求摘要及快照实例映射；坏缓存只使参数不可回取，不阻止公开结果读取。
- `runFiles.ts` 对应服务端 `result-files.ts`：核 run/snapshot/source、相对路径、caseIndex、稳定 ID、UTF-8 bytes/hash、complete 正文和总输出限额；missing/incomplete 不把部分正文传给视图，check 仅接 redacted。`runContracts.ts` 仅补已有 files 投影类型，不增加 Run 字段。
- `runResults.ts` 按公开白名单构造 Run，check 只保留 verdict/failureKind；即使意外响应含 stdout/input/答案，也不显示私有正文。HTTP 创建值 `course_check` 和公开 Run `check` 不混用；没有新增检查创建。
- `useRunHistory.ts` 在显式打开历史后绑定纯设计组件，显式下载再次核完整公开文本和当前选择/上下文，以 text/plain Blob 下载原 UTF-8 字节，无 HTML 执行、隐式 HTTP 写入或 ProjectFile 写回。`PrepWorkspacePage.tsx` 仅接现有容器与回调。
- `prep/workspace.ts`/`plugin.ts` 复用同一 loopback authority，提供公开 files 路由及 dev-only 历史样例，来源是 `readWorkspace`/`runDiagnostics`/`readResultFiles` 和已有 `test-support` 的 approvedResultFiles。`report.txt` 样例证明公开文件读取，不表示固定 Core 活动获得 Report 参数或生成能力；无真实 C/worker/节点/模型调用，不生成正式学习记录。
- README、学生 README 与 IMPORT_SOURCE 已同步使用、来源、样例与真实边界；未改产品、规范、分工、参考、服务端、schema、依赖、凭据或 CI/CD。

## 两轴审查

固定起点 `163e9c738a048a9cc360cfbcea6b49332cf60b48`，以本任务暂存差异评审；规范与规格两个独立只读审查，规格轴另核真实服务端公开投影，不只依赖 fixture。

### Standards

1 项 P3：IMPORT_SOURCE 的暂存版本只在业务记录登记 06B，遗漏第 4 节设计同步表，后续可能沿用旧来源基点。已补 `a124fee → 16558426…` 的固定来源、接收范围与验证记录并纳入暂存；独立增量复核确认关闭，无新增发现。剩余 0，smell 建议 0。

### Spec

0 项：历史来源/回执参数绑定、缺缓存/失败/未知、检查分层裁剪、文件完整性、迟到响应与只读下载，未发现可确认的缺失、超范围或错误行为。真实 H 未交接保持后置，不用准备验证替代正式验收。

各轴分别收口：Standards 1 项已关闭、剩余 0；Spec 0 项。

## 验证记录

- 增量反例先失败再实现：缺文件校验模块、check 意外私有字段保留、未接历史入口的实际浏览器超时；后续实现修正，原失败保留事实。早期默认 Node 26 检查不计为最终工具环境；最终统一使用已安装 Node 24.18.0，未安装新依赖。
- fixture 曾通过 `runFiles` 类型导入拉入浏览器环境，使 Node 侧 typecheck 报 `ImportMeta.env`；将纯投影类型移至已有 `runContracts.ts`，浏览器与 Node 边界类型检查恢复通过。
- Node 24.18.0 `npm run typecheck` 通过；增量 Vitest 3 文件/24 项通过（files、Run 投影、真实 middleware HTTP）。
- `CI=1 XUNJIE_E2E_PREP_PORT=5651 XUNJIE_E2E_REAL_PORT=5652 npm run test:e2e -- runHistory.spec.ts`：首轮绿色 10/10，41.3 秒，实际 Chromium/Vite/IndexedDB。覆盖两快照与本机请求、失败/未知、第二浏览器缺缓存、检查裁剪、合法下载原字节、缺失/不完整/不可回取、hash/正文/来源错误、迟到文件、损坏本机关联及无隐式写请求。之后增强等待每侧校验完成、实际 GET 响应与键盘 details 操作，已在全量回归中通过。
- 1280×800 浅/深色截图已读取检查，比较双列、长 hash 与来源标签无横向溢出；保留既有 UI 布局和顶栏。
- 全量工程：Node 24.18.0 下 `npm run typecheck`、`npm test`（22 文件/238 项，0 失败）及 `npm run build` 通过；既有 Monaco 大分块提示保留，未关闭检查。生产 JS 中 dev-only 历史样例入口、合成正文和 prep 代际出现数均为 0。
- README/学生 README/IMPORT_SOURCE/本文相对链接均可解析，暂存写集不含产品/规范/规划/参考、服务端、schema、依赖、凭据或 CI/CD；原 `.zcodeignore` 未暂存。
- Node 24.18.0 下 `CI=1 XUNJIE_E2E_PREP_PORT=5651 XUNJIE_E2E_REAL_PORT=5652 npm run test:e2e`：全量 Chromium 99/99 通过，退出码 0，`.last-run.json` 为 `passed` 且 `failedTests=[]`；包含 06B 10 项及原确认、草稿、恢复、运行/停止等回归。Vite 既有 public JSON 资源提示保留，未改资源加载或关闭检查。
- 两轴审查已完成，剩余发现 0；来源组件、文档链接与交付写集已核对。设计提交固定为 `16558426ce70524218eacbf7ce8fde35681c0503`；主仓库交付提交可由当前分支按本文路径查看，两者仅本地保存。
