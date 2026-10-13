# 导入来源与许可记录

本目录（`apps/student/`）是 XunJie 主仓库的学生前端工程，首次内容由设计仓库的固定提交导入。
本文件是[导入决定 ADR](../../docs/tasks/I0_UI_ADR_0001_DESIGN_IMPORT.md) 要求的来源映射记录，也是后续设计同步的唯一比对基准。

## 1. 首次导入

| 项 | 值 |
| --- | --- |
| 来源仓库 | `https://github.com/wubq511/XunJie_Design.git` |
| 来源 commit | `a9bb1dd016489d3e60e0b45933e440296c1194d8`（`style(copy): 消除自言自语废话与过度引导，精炼新会话开场与设置项`，2026-10-11 22:57:39 +0800） |
| 来源子树 | `app/`（该 commit 下的已跟踪内容，227 个文件） |
| 目标目录 | `apps/student/` |
| 导入日期 | 2026-10-11（Asia/Shanghai） |
| 执行任务 | [I0_UI_01](../../docs/tasks/I0_UI_01_IMPORT_C_ENTRY.md) |
| 固定来源链接 | <https://github.com/wubq511/XunJie_Design/tree/a9bb1dd016489d3e60e0b45933e440296c1194d8/app> |

可复核的导入命令（在设计仓库 checkout 上执行，只读，不触碰其工作副本）：

```sh
git -C <XunJie_Design> archive a9bb1dd016489d3e60e0b45933e440296c1194d8 app \
  | tar -x --strip-components=1 -C <XunJie>/apps/student
```

`git archive` 只输出该 commit 的已跟踪内容，因此结构上不可能带入 `.git`、`node_modules`、构建产物或未跟踪文件。

### 文件映射

单一规则：来源路径去掉 `app/` 前缀后原样落到 `apps/student/`。

| 来源（`XunJie_Design@a9bb1dd`） | 目标（`XunJie`） |
| --- | --- |
| `app/src/**` | `apps/student/src/**` |
| `app/public/**` | `apps/student/public/**` |
| `app/package.json` | `apps/student/package.json` |
| `app/package-lock.json` | `apps/student/package-lock.json` |
| `app/index.html` | `apps/student/index.html` |
| `app/vite.config.ts` | `apps/student/vite.config.ts` |
| `app/tsconfig.json` | `apps/student/tsconfig.json` |
| `app/README.md` | `apps/student/README.md` |

没有重命名、合并或拆分的路径。

### 导入清单

227 个文件，按目录：

| 目录 | 文件数 | 内容 |
| --- | --- | --- |
| `src/icons` | 120 | 图标组件、目录、来源与许可说明、SVG 资产 |
| `src/components` | 41 | 外壳、输入框、聊天块、看板、设置页、工作区容器 |
| `public/brand` | 19 | 双叶芽 IP 图层与 Logo 资产 |
| `src/brand` | 12 | IP 动画、Logo 组件与保真对照页 |
| `src/bridge` | 10 | 类型化本地接口、Mock 适配器、演示数据与回合剧本 |
| `src/lib` | 9 | 领域纯函数规则、主题、设置、布局、连接测试 |
| `src/pages` | 4 | 首页、Agent 对话页、设置页、任务工作区 |
| `src/styles` | 3 | 语义令牌、字体与组件样式 |
| `public/fonts` | 2 | 霞鹜文楷 woff2 与 OFL 许可正文 |
| 根 | 5 | `index.html`、`package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`README.md` |

导入后逐字节核对：`apps/student/` 与设计仓库该 commit 的工作副本在上述 227 个路径上完全一致。

### 明确排除

| 排除项 | 理由 |
| --- | --- |
| `.git`、`node_modules`、`dist` | 版本库与产物不进导入 |
| `app/public/courses/`（设计工作副本里的未跟踪空目录） | 未跟踪内容；`git archive` 不含它。首页课程封面本就走缺图回退占位块 |
| `cleanuiclone/**`（MiMo Code / CodePilot / DeepTutor 参考实现） | 第三方参考实现，非本产品交付，许可各异 |
| `docs/**`、`CONTEXT.md`、`AGENTS.md`（设计仓库） | 设计说明按第 3 节以固定公开链接查阅，不作为主仓库业务契约导入 |
| 未跟踪浏览器 harness | 临时验证脚本不成为交付内容 |

## 2. 与规划核查来源的差异

[准备记录 §2.2](../../docs/tasks/I0_UI_PREPARATION.md) 的核查来源是 `1f0a71ad89856a3eaa2883f81c9cff4bcb56a8f6`。本次导入按 [01 任务](../../docs/tasks/I0_UI_01_IMPORT_C_ENTRY.md)「若选较新提交，先记录差异与实际选中 commit」升级到 `a9bb1dd`。

`1f0a71a..a9bb1dd` 之间 `app/` 的变化：4 个提交，20 个文件修改，无新增/删除/重命名。

| 提交 | 主题 | 影响面 |
| --- | --- | --- |
| `5a9486b` | 页面入场系统、首页入口气泡与供应商单弹窗 | `AppShell`、`Composer`、设置模型/供应商弹窗、`styles/app.css`（+460 行）、`icons.css`、`settings.ts`、`SettingsPage`、`mockAdapter` |
| `7ff0014` | 模型细项进供应商弹窗，高级配置下线 | 设置模型表单结构 |
| `6b9ed84` | 模型表单统一成一份，供应商内外都能配全量细项 | `ModelDialog`、`ProviderDialog`、`controls`、`settings.ts` |
| `569f3c5` | 优化设置页与新会话文案 | 设置各标签页、`chat/copy.ts`、`PromptInput`、`AgentPage`、`AboutTab` |
| `a9bb1dd` | 精炼新会话开场与设置项文案 | `mockAdapter`、`PromptInput`、`chat/copy.ts`、设置各标签页、`connectionTest.ts`、`settings.ts`、`AgentPage`、`styles/app.css` |

选 `a9bb1dd` 而非 `5a9486b` 的理由：这批改动集中在设置页模型/供应商表单与 `lib/connectionTest.ts`、`lib/settings.ts`，正是本任务为满足「准备模式 provider 连接测试不外发」必须修改的文件。以较新提交为基准可让首次差异同步的冲突面最小，避免刚改完就与来源结构性分叉。

全部 20 个文件都是界面文案、设置表单结构与样式，不含业务契约或后端约定。

### 执行期间观察到的来源并发迭代

设计仓库在本任务执行期间持续提交。开工核查时其 HEAD 为 `5a9486b`（分支 `feat/settings-model-config`），导入冻结时为 `a9bb1dd`（分支 `main`，与 `origin/main` 同步，工作副本干净）。这印证了准备记录「不认工作副本为干净交付包」的判断：本目录只认上表的固定 commit，后续来源变化按第 4 节处理，不追 HEAD。

## 3. 许可

### 第三方资产（随导入内容一并带入）

| 资产 | 位置 | 许可 | 说明 |
| --- | --- | --- | --- |
| Solar 图标 | `src/icons/svg/*-linear.svg` 等 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 作者 480 Design；`file-presentation-linear.svg` 是保留 Solar 轮廓的衍生图形，同许可 |
| OpenMoji 图标 | `src/icons/svg/emoji-*-native.svg` | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 作者 HfG Schwäbisch Gmünd 与 OpenMoji contributors；原路径保留 |
| 霞鹜文楷 | `public/fonts/lxgw-wenkai-regular.woff2` | [SIL OFL 1.1](https://openfontlicense.org/) | 许可正文随资产存于 `public/fonts/OFL.txt` |
| 项目自绘图形 | `learning-space`、`assistant-mark`、`virtual-board`、`digital-waveform`、`load-board`、`insert-prompt`、`unpin`、`analogy`、`sun` | 归属学习空间项目，未另行指定公共开源许可 | 见 `src/icons/ATTRIBUTION.md` |

逐项来源、作者与改动说明以 [`src/icons/ATTRIBUTION.md`](src/icons/ATTRIBUTION.md) 与 [`src/icons/provenance.json`](src/icons/provenance.json) 为准，本表不重复维护。

### 依赖与来源仓库

- npm 依赖的许可以 `package-lock.json` 记录的各包自身许可为准，本目录不另行分发其许可正文。
- 设计仓库根目录未附独立 LICENSE 文件；`app/` 是同一产品（循阶 / XunJie）学生端 UI 的团队内部交付，导入依据是[导入决定 ADR](../../docs/tasks/I0_UI_ADR_0001_DESIGN_IMPORT.md) 与项目负责人对 01 任务的编码指令，不是外部开源许可授权。
- 参考实现目录 `cleanuiclone/**` 未导入，其各自的第三方许可不适用于本目录。

## 4. 后续设计同步办法

首次导入之后，本目录是业务接入代码（草稿、认证、保存、运行）的唯一维护位置。设计仓库继续迭代视觉。

1. 比对基准是**上次已接收来源 commit → 新来源 commit** 的差异，不是新 `app/` 整包。上次已接收来源即本文件第 1 节记录的 commit；每次同步后在此追加一行。
2. 禁止用新的 `app/` 覆盖 `apps/student/`。禁止 reset、删除或整文件覆盖来解决冲突。
3. 视觉与业务混合的提交逐项合并；同文件冲突保留两侧改动后人工处理，共享文件保留主仓库业务语义。
4. 每次同步在本文件追加「同步记录」，写明接收来源 commit、审阅的差异范围、实际合入的文件、冲突处理与验证命令/结果。
5. 来源仓库的设计说明（`docs/DESIGN.md`、`docs/home-design.md` 等）按固定公开链接查阅，作为 UI 来源参考；其中桌面宿主、匿名本地使用、自动引导、能力百分比等与主仓库冲突的业务描述不继承为正式契约。业务规则一律以 [PRD](../../docs/product/PRD.md) → [MVP_SPEC](../../docs/product/MVP_SPEC.md) → [TECH_DESIGN](../../docs/product/TECH_DESIGN.md) 为准。

### 同步记录

| 日期 | 上次已接收来源 | 新来源 | 合入范围 | 验证 |
| --- | --- | --- | --- | --- |
| 2026-10-12 | `a124fee`（06A 已接收组件） | `16558426ce70524218eacbf7ce8fde35681c0503`（06B，仅本地提交） | 仅接收纯受控 `RunHistoryPanel.tsx/.css` 和 `RunPanel.tsx` 可选历史入口；逐字节一致，主仓库页面接线与业务读取/校验/下载独立维护，不同步设计演示页面 | 设计 Node 24 下 106 项测试、含 tsc 构建与 props/SSR 通过；主仓库专项 Chromium 10/10、1280px 浅深截图与来源核对通过；最终工程检查见 [06B](../../docs/tasks/I0_UI_06B_RUN_HISTORY.md) |
| 2026-10-12 | `ad89519`（已有 05 接收范围） | `b4b857d6ec39f10be8112afaa6e9769dc6cb0e27` → `0e9d0af3e029d8c3611515ac1ce1e6936033e148`（06 设计先行，均仅本地提交，未推送） | 只审阅并逐字节接收 `app/src/components/workspace/RunPanel.tsx` 与 `RunPanel.css`，包含纯 props Core 入口/参数/只读结果及仅存在 Core 入口时的顶栏间距修正；业务传输、原请求/确认及存储在主仓库 workspace 维护，未接收其他来源文件 | 设计 `npm run build`（含 tsc）通过；主仓库 Chromium 1280px 浅/深色与交互、最终检查见 [06 任务记录](../../docs/tasks/I0_UI_06_RUN_RESULTS.md)；两文件来源一致性另核 sha256 |
| 2026-10-12 | `0e9d0af`（06 接收组件） | `a124fee8422bf2ca940ddc807344ae7936d7dac7`（06A，仅本地提交） | 仅接收 `app/src/components/workspace/RunPanel.tsx` 的可选纯 props 停止/核对控件；现有页面/样式/其余来源不变 | 设计 typecheck/build 通过；主仓库逐字节核对和浏览器/工程结果见 [06A](../../docs/tasks/I0_UI_06A_RUN_CONTROL.md) |
| 2026-10-12 | `a9bb1dd` | `238d3c3`（`feat(workspace): 代码工具包多文件编辑区与本机草稿（I0-02 设计基线）`） | 新增：`src/bridge/projects.ts`、`src/components/workspace/{CodeEditorHost,CodeWorkspace,FileStrip,monacoSetup,useProjectWorkspace}`、`src/lib/{draftStore,projectFiles,projectFiles.test}`；纯追加：`src/bridge/types.ts`（项目作品/草稿类型）、`src/styles/app.css`（末尾 `.cw-*` 分节）；整文件接收：`src/lib/wsLayout.ts`（基线逐字节一致）、`src/pages/WorkspacePage.tsx`（设计版 + 恢复 01 的 `ws-demo-flag` 一行）；逐项合并：`src/components/workspace/CenterToolArea.tsx`（保留 01 的 `variant`/演示横幅/运行簇注入与静态代码注记，接收设计的 `tools`/`knownTools`/`defaultLayout(toolKeys)`/`runCluster` 缺省回退）；依赖：`monaco-editor@0.57.0`（P-03 已批准，精确锁定） | `npx tsc --noEmit` 通过；vitest 9 文件 104 例通过；`npm run build` 成功；01 e2e 见任务记录 |
| 2026-10-12 | `238d3c3` | `0c18739f3dd8bc23a40dd171332fa939fff08ca4`（含先行组件提交 `522a4b9e3cb2750a2156e88650b4e9ec82019b0e`；两者仅本地，未推送） | 逐项审阅 `238d3c3 → 522a4b9 → 0c18739`：完整接收纯受控 `src/components/workspace/ConfirmationCluster.tsx`；`CodeWorkspace.tsx` 仅合入恢复后确认实例不可用的状态栏说明，保留主仓库原文/CAS/暂停编辑语义。设计任务记录不替代主仓库契约，不同步其他文件 | 设计最终 typecheck/build 通过；主仓库字节核对组件一致，准备范围浏览器绑定、键盘与 1280px 浅/深主题检查见 [03 任务记录](../../docs/tasks/I0_UI_03_CONFIRM_SNAPSHOT.md) |
| 2026-10-12 | `0c18739` | `e933b69`（其前为 `7c0cd64`；两者均仅本地，未推送） | 只审阅并接收这两个提交的纯受控 `src/components/workspace/ConfirmationCluster.tsx`：`7c0cd64` 新增 `rejected`/`conflict`/`recovery-required` 三个结论态、「原请求详情」只读面板与 `canRetry` 开关；`e933b69` 把详情收进运行簇浮层（1280px 顶栏溢出修复）。设计仓库其余文件未同步 | 设计仓库 `tsc --noEmit` 与 `vite build` 通过；主仓库与本行「新来源」提交逐字节一致（`cmp` 无差异），恢复交互由 [04 任务记录](../../docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md) 的 8 个浏览器用例验证 |
| 2026-10-12 | `7ee7036` | `eceafa7`（已推送到 `origin/main`） | 只审阅并接收该提交的同一个受控组件：新增 `stale` 结论态（「上一次保存已过期」——旧代际且服务已明确拒绝的原命令不再挡新保存）、`local-failed` 状态词改为「保存待重试」、`ConfirmationSnapshot` 只保留 `workspaceRevision` | 设计仓库 `tsc --noEmit` 与 `vite build` 通过并已推送（`git ls-remote` 核对 `refs/heads/main` = `eceafa72…`）；主仓库接收文件 sha256 相同（`4e05078433f73689cd9cf2582d23f1f3eecd28541ba3fcd7dd5a89329244db3f`），行为由 [04 任务记录](../../docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md) 的浏览器用例验证 |
| 2026-10-12 | `e933b69` | `7ee7036`（其前为 `40bf631`；已推送到 `origin/main`） | 只审阅并接收这两个提交的同一个受控组件：`40bf631` 缩短拒绝态标签消除 1280px 顶栏溢出；`7ee7036` 按项目负责人「学生端只留必要信息」要求整改文案——状态词与按钮口语化、移除「原请求详情」与快照 ID/hash、恢复态隐藏草稿流与「恢复 Attempt」。技术事实改由主仓库 `src/workspace/diagnostics.ts` 输出到控制台，不随设计仓库同步 | 设计仓库 `tsc --noEmit` 与 `vite build` 通过并已推送（`git ls-remote` 核对 `refs/heads/main`）；主仓库接收文件与该提交 sha256 相同（`efe29091…`），文案与布局经 4 态 1280px 实拍核对，浏览器检查 47 例通过 |
| 2026-10-12 | `eceafa7` | `718f2ae`、`ad89519`（05 设计基线与随后的演示历史版本；**已推送**，`git ls-remote` 核对 `refs/heads/main` = `ad89519eff7673c399b3dfcbf521cf0363b31b40`） | 05 为**首次双向**同步：设计仓库先落同样的视觉与文案，主仓库随后按它调整。逐项审阅 `eceafa7 → 718f2ae` 的 14 个文件，接收：`src/lib/fileLifecycle.ts(+test)`、`src/lib/fileComparison.ts(+test)`（生命周期判定与只读比较的对齐规则；设计版不含两项产品细节：主仓库 `mergedLifecycle` 的多标签口径与正文 LF 投影）、`src/components/workspace/CompareText.tsx`、`src/components/workspace/VersionCompare.tsx`（只读比较两个面板；主仓库经 `projectOriginal` 投 LF 显示，设计基线直接取演示正文）、`src/components/workspace/FileStrip.tsx`、`src/components/workspace/CodeWorkspace.tsx`（行内回收/恢复与未确认读数，主仓库版本接本机实例记录、设计版接演示存储）、`src/styles/app.css`（末尾 05 两个分节；主仓库把琥珀文字从 `--indicator-amber-ink` 换为 `--tint-amber-fg` 以满足 DESIGN.md 的 AA 约定，并同步了设计侧的读数取色）。**不接收**：`src/pages/WorkspacePage.tsx`、`src/components/workspace/useProjectWorkspace.ts`、`src/bridge/{types,projects}.ts`、`src/lib/draftStore.ts`（演示数据、localStorage 草稿与页面接线；主仓库对应物已有 02/03 的事务、原文与确认语义。设计基线另外补了 `ProjectHistoryVersion` 演示历史版本，供演示里直接看「两个历史版本对比」——主仓库的来源是 `head.snapshots` 的已核验快照，不需要演示数据）；设计基线的 `mergedLifecycle` 属多标签规则，只在主仓库保留 | 设计仓库 `tsc --noEmit` 通过、`npm test` 10 文件 104 例通过、`npm run build` 通过，dev 实屏核对文件列表/待确认回收/恢复被占用/版本比较/终态禁用五种状态（截图与断言见 [05 任务记录](../../docs/tasks/I0_UI_05_FILE_HISTORY.md)）；主仓库 `VersionCompare.tsx` 与设计版是同一份组件（仅数据模块 import 路径不同：设计 `lib/fileComparison` / 主仓库 `workspace/comparison`），`CompareText.tsx` 多一层 `projectOriginal` 正文投影，其余为同规则不同实现层（见左栏）；全量 `tsc`/vitest/e2e 见同处 |

## 5. 导入后本目录的改动

导入内容与来源逐字节一致；此后本目录的改动由 XunJie 的任务文档记录，不回写设计仓库。

| 日期 | 任务 | 改动 |
| --- | --- | --- |
| 2026-10-11 | I0_UI_01 | 新增本文件、`.gitignore`（Playwright 产物）、`tsconfig.node.json`、`playwright.config.ts`、`e2e/`、`prep/`（fixture）、`src/workspace/`（模式/契约投影/窄 HTTP 客户端/上下文与 loadEpoch/初始化读取/会话/准备入口常量）、`src/pages/PrepWorkspacePage.tsx`、`src/pages/TaskRoute.tsx`、`src/components/workspace/TextScopePanes.tsx` |
| 2026-10-11 | I0_UI_01 | 修改导入文件：`vite.config.ts`（按模式挂 fixture）、`package.json`（`dev:prep` / `test:e2e` 脚本与两个开发依赖）、`main.tsx`（任务入口分发）、`pages/HomePage.tsx`（准备入口卡片）、`pages/WorkspacePage.tsx`（任务信息加演示标识）、`components/workspace/CenterToolArea.tsx`（C 变体：正文与运行簇注入、board/wave 演示横幅、静态代码演示注记）、`lib/connectionTest.ts`（准备模式不外发、学校测试标模拟）、`styles/app.css`（末尾追加准备场景分节样式）、本 README 与 `src/icons/README.md`（失效链接改固定来源） |
| 2026-10-11 | I0_UI_01 | 依赖差异：新增开发依赖 `@playwright/test@1.64.0`（P-03 已批准）与 `@types/node@24.19.2`（后者超出 P-03 字面清单：vite 的可选 peer、fixture 与 Playwright 配置为 Node 侧代码，需要它才能被 typecheck 覆盖；types-only，无运行时影响）。运行依赖未变；`monaco-editor` 属 02，未安装。`@types/node` 于 2026-10-12 获前端接入成员追认保留，见 [01 任务记录](../../docs/tasks/I0_UI_01_IMPORT_C_ENTRY.md) |
| 2026-10-12 | I0_UI_02 | 设计同步 `a9bb1dd → 238d3c3`（见第 4 节同步记录）之后的本仓库业务改动：`src/lib/originalText.ts(+test)` 原文保真纯函数、`src/workspace/draftDb.ts` 新库 v1 实现、`src/lib/draftStore.ts` 改写为存储契约 + CAS 判定（+test，替换设计基线的 localStorage 演示实现）、`src/components/workspace/{CodeEditorHost,useProjectWorkspace}.tsx/ts` 接原文权威与 CAS 写入、`src/pages/WorkspacePage.tsx` 传 scope 与 idb 仓库、`e2e/editor.spec.ts` 新增 4 例浏览器验证；依赖新增运行依赖 `monaco-editor@0.57.0`（P-03 已批准，精确锁定） |
| 2026-10-12 | I0_UI_03 | 设计选择性同步之后的本仓库业务改动：`src/workspace/{workspaceContracts,confirmation,frozenCommand,confirmationDb,confirmationWorkspace,useConfirmationWorkspace}` 建立统一原命令/确认/快照客户端；同名 IndexedDB v1→v2 仅增 outbox/metadata，保留原五 store；既有编辑/准备入口绑定原文、实例映射与 CAS；同一 `prep/` authority 支持创建/保存/快照/恢复故障与原子拒绝；补公开 HTTP/浏览器边界测试和严格测试端口覆盖。未新增依赖或改服务端模块/产品基线，详情见 [03 任务记录](../../docs/tasks/I0_UI_03_CONFIRM_SNAPSHOT.md) |

| 2026-10-12 | I0_UI_04 | 设计选择性同步之后的本仓库业务改动：`src/workspace/recovery.ts(+test)` 原命令核对结论纯函数（未知/本机未确认/拒绝/版本冲突/代际已变/租约/已确认/历史）；`confirmationWorkspace` 按结论分类写失败、停止旧重试、已确认时只本机重新接纳并重读 head；`confirmationDb` 新增 `rejections` 事实（同一 outbox 记录的可选字段，不新增 store/版本）与领取租约的公开错误；`useConfirmationWorkspace.projectSeedOf` 让丢 ACK 刷新后同路径未映射实例的草稿仍可打开；`prep/faults.ts` 与 `prep/plugin.ts` 新增开发专用丢 ACK 故障入口；补 `e2e/recovery.spec.ts`。未新增依赖、未改服务端模块与产品基线，详情见 [04 任务记录](../../docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md) |
| 2026-10-12 | I0_UI_04A | 本仓库业务改动（无设计仓库同步，比较视图全部在主仓库组合现有槽位实现）：`src/workspace/comparison.ts(+test)` 比较视图模型纯函数（mine/base/theirs 三正文）；`recovery.ts(+test)` key-conflict 单列结论与 comparableOutcome 判定；`confirmationDb.ts` retireResolved 退役冲突原命令为历史事实（拒绝/旧事实保留）；`confirmationWorkspace.ts` comparison 状态与 open/close/resolve（先重读当前获准 head）；`diagnostics.ts` 新增 command.resolved/comparison.opened；`components/workspace/ConflictCompare.tsx` 只读双栏 diff 比较组件；`useProjectWorkspace.ts` conflictedFileIds/loadStoredDraftText/resolveConflict（写入挂既有串行边界）；`pages/PrepWorkspacePage.tsx` 比较入口与草稿冲突条接线；`styles/app.css` 末尾追加 ws-compare*/ws-draft-conflicts* 分节；`e2e/compare.spec.ts` 新增 5 例并更新 recovery/confirmation/draftConflict 三处旧断言。未新增依赖、未改服务端模块与产品基线，详情见 [04A 任务记录](../../docs/tasks/I0_UI_04A_LOCAL_CONFLICTS.md) |
| 2026-10-12 | I0_UI_04A（工程债收口） | 04A 复审登记的两项工程债由负责人指派实施（纯测试/构建设施，无业务与设计组件改动）：新增 `e2e/helpers.ts` 收拢四个 spec 的重复 helper（sceneUrl/start/create/typeIn/edit/setFault/localState/newestSync/syntheticUpdate/trackSync/identities/holdAck，实现与原拷贝同语义）；`e2e/{compare,recovery,confirmation,draftConflict}.spec.ts` 删本地拷贝改导入共享模块；`vite.config.ts` 增加 `optimizeDeps.include` 预热，防冷启动会话中途重优化的 `504 Outdated Optimize Dep` 竞态。未新增依赖、未改业务代码与产品基线，详情见 [04A 任务记录「工程债收口」](../../docs/tasks/I0_UI_04A_LOCAL_CONFLICTS.md#工程债收口2026-10-12负责人指派) |
| 2026-10-12 | I0_UI_05 | 本仓库业务改动（无设计仓库同步，文件操作与版本比较都在主仓库组合既有槽位实现）：`src/workspace/workspaceContracts.ts` sync 操作补 `recycle`/`restore`（对齐服务端 `fileOperationSchema`）；`frozenCommand.ts` 冻结草稿带期望生命周期并生成生命周期操作、`verifySyncReceipt` 核生命周期回执；`recovery.ts` 新增 `state-conflict` 结论（整批确定未生效，允许用新命令重新保存）；`confirmationWorkspace.ts` 发布已核验的 `snapshots` 与 `not-applied` 阶段；`useConfirmationWorkspace.ts` 的 seed 用本机实例记录表达学生当前生命周期意图；`lib/draftStore.ts`+`draftDb.ts` 新增只读 `loadInstance`（不加 store、不改库版本）；`workspace/fileLifecycle.ts(+test)` 生命周期判定纯函数；`components/workspace/useProjectWorkspace.ts` 本机回收/恢复意图与 `lifecyclePendingCount`；`FileStrip.tsx` 文件列表行内回收与「已回收的实例」恢复入口；`CodeWorkspace.tsx` 状态行标注未确认回收/恢复；`workspace/comparison.ts(+test)` 新增按身份对齐的只读版本比较视图模型；`workspace/versionSources.ts(+test)` 两侧身份键映射与来源装配；`components/workspace/CompareText.tsx`(新)、`VersionCompare.tsx`(新) 与 `ConflictCompare.tsx` 改用共享只读正文面板；`ConfirmationCluster.tsx`+`pages/PrepWorkspacePage.tsx` 比较入口与 Esc/来源切换接线；`styles/app.css` 末尾追加文件生命周期与版本比较分节；`prep/workspace.ts`+`prep/plugin.ts` 新增 dev-only `POST /__i0prep/attempt-state`（暂停/终态门控验收）；`e2e/helpers.ts` 与新增 `e2e/fileHistory.spec.ts`。未新增依赖、未改服务端模块与产品基线，详情见 [05 任务记录](../../docs/tasks/I0_UI_05_FILE_HISTORY.md) |

| 2026-10-12 | I0_UI_06 | 在第 4 节纯受控设计来源之外，主仓库新增 `src/workspace/{runRequest,runContracts,runResults,runWorkspace,useRunWorkspace}` 与公开投影/冻结输入测试；复用 v2 DB/outbox、扩展同一 prep authority 的运行公开路径；页面只接业务 props；按 mode 分离 Vite cacheDir，准备登录后重读获准 context；新增 `e2e/runResults.spec.ts`。未新增依赖、未改 schema/服务端/产品基线，详情见 [06 任务记录](../../docs/tasks/I0_UI_06_RUN_RESULTS.md) |

| 2026-10-12 | I0_UI_06A | `runControl.ts(+test)` 对齐 cancel wire/摘要/回执；`runWorkspace.ts` 停止与显式原请求核对，唯一 outbox/租约/ACK 事务与迟到守卫；确认保存排除取消命令；同一 prep fixture 停止/未知脚本及 `e2e/runControl.spec.ts`，06/06A 共用 `runHelpers.ts`。无 schema/依赖/服务端/产品基线变化 |

06B 的设计接收范围见第 4 节。主仓库独立维护 `runHistory.ts`/`useRunHistory.ts` 公开历史读取与下载、`runFiles.ts(+test)` 完整性校验、`runResults.ts(+test)` check 白名单投影、同一 prep authority 的 files/历史样例和 `e2e/runHistory.spec.ts`。无 schema、依赖或服务端变更；验证事实见 [06B 任务](../../docs/tasks/I0_UI_06B_RUN_HISTORY.md)。

这些业务改动只在主仓库维护；06/06A 的纯设计组件先行交付与接收范围单列在第 4 节，不将主仓库 HTTP/存储或准备 authority 回写设计仓库。06B 固定来源为 [设计交付记录](https://github.com/wubq511/XunJie_Design/blob/16558426ce70524218eacbf7ce8fde35681c0503/docs/i0-06b-run-history-delivery.md)，仅本地提交，公开链接待该来源提交推送后可用；团队当前运行与验收无需来源 checkout，必要契约与记录在主仓库任务中完整保存。
