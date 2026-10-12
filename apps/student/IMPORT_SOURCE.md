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
| 2026-10-12 | `a9bb1dd` | `238d3c3`（`feat(workspace): 代码工具包多文件编辑区与本机草稿（I0-02 设计基线）`） | 新增：`src/bridge/projects.ts`、`src/components/workspace/{CodeEditorHost,CodeWorkspace,FileStrip,monacoSetup,useProjectWorkspace}`、`src/lib/{draftStore,projectFiles,projectFiles.test}`；纯追加：`src/bridge/types.ts`（项目作品/草稿类型）、`src/styles/app.css`（末尾 `.cw-*` 分节）；整文件接收：`src/lib/wsLayout.ts`（基线逐字节一致）、`src/pages/WorkspacePage.tsx`（设计版 + 恢复 01 的 `ws-demo-flag` 一行）；逐项合并：`src/components/workspace/CenterToolArea.tsx`（保留 01 的 `variant`/演示横幅/运行簇注入与静态代码注记，接收设计的 `tools`/`knownTools`/`defaultLayout(toolKeys)`/`runCluster` 缺省回退）；依赖：`monaco-editor@0.57.0`（P-03 已批准，精确锁定） | `npx tsc --noEmit` 通过；vitest 9 文件 104 例通过；`npm run build` 成功；01 e2e 见任务记录 |
| 2026-10-12 | `238d3c3` | `0c18739f3dd8bc23a40dd171332fa939fff08ca4`（含先行组件提交 `522a4b9e3cb2750a2156e88650b4e9ec82019b0e`；两者仅本地，未推送） | 逐项审阅 `238d3c3 → 522a4b9 → 0c18739`：完整接收纯受控 `src/components/workspace/ConfirmationCluster.tsx`；`CodeWorkspace.tsx` 仅合入恢复后确认实例不可用的状态栏说明，保留主仓库原文/CAS/暂停编辑语义。设计任务记录不替代主仓库契约，不同步其他文件 | 设计最终 typecheck/build 通过；主仓库字节核对组件一致，准备范围浏览器绑定、键盘与 1280px 浅/深主题检查见 [03 任务记录](../../docs/tasks/I0_UI_03_CONFIRM_SNAPSHOT.md) |

## 5. 导入后本目录的改动

导入内容与来源逐字节一致；此后本目录的改动由 XunJie 的任务文档记录，不回写设计仓库。

| 日期 | 任务 | 改动 |
| --- | --- | --- |
| 2026-10-11 | I0_UI_01 | 新增本文件、`.gitignore`（Playwright 产物）、`tsconfig.node.json`、`playwright.config.ts`、`e2e/`、`prep/`（fixture）、`src/workspace/`（模式/契约投影/窄 HTTP 客户端/上下文与 loadEpoch/初始化读取/会话/准备入口常量）、`src/pages/PrepWorkspacePage.tsx`、`src/pages/TaskRoute.tsx`、`src/components/workspace/TextScopePanes.tsx` |
| 2026-10-11 | I0_UI_01 | 修改导入文件：`vite.config.ts`（按模式挂 fixture）、`package.json`（`dev:prep` / `test:e2e` 脚本与两个开发依赖）、`main.tsx`（任务入口分发）、`pages/HomePage.tsx`（准备入口卡片）、`pages/WorkspacePage.tsx`（任务信息加演示标识）、`components/workspace/CenterToolArea.tsx`（C 变体：正文与运行簇注入、board/wave 演示横幅、静态代码演示注记）、`lib/connectionTest.ts`（准备模式不外发、学校测试标模拟）、`styles/app.css`（末尾追加准备场景分节样式）、本 README 与 `src/icons/README.md`（失效链接改固定来源） |
| 2026-10-11 | I0_UI_01 | 依赖差异：新增开发依赖 `@playwright/test@1.64.0`（P-03 已批准）与 `@types/node@24.19.2`（后者超出 P-03 字面清单：vite 的可选 peer、fixture 与 Playwright 配置为 Node 侧代码，需要它才能被 typecheck 覆盖；types-only，无运行时影响）。运行依赖未变；`monaco-editor` 属 02，未安装。`@types/node` 于 2026-10-12 获前端接入成员追认保留，见 [01 任务记录](../../docs/tasks/I0_UI_01_IMPORT_C_ENTRY.md) |
| 2026-10-12 | I0_UI_02 | 设计同步 `a9bb1dd → 238d3c3`（见第 4 节同步记录）之后的本仓库业务改动：`src/lib/originalText.ts(+test)` 原文保真纯函数、`src/workspace/draftDb.ts` 新库 v1 实现、`src/lib/draftStore.ts` 改写为存储契约 + CAS 判定（+test，替换设计基线的 localStorage 演示实现）、`src/components/workspace/{CodeEditorHost,useProjectWorkspace}.tsx/ts` 接原文权威与 CAS 写入、`src/pages/WorkspacePage.tsx` 传 scope 与 idb 仓库、`e2e/editor.spec.ts` 新增 4 例浏览器验证；依赖新增运行依赖 `monaco-editor@0.57.0`（P-03 已批准，精确锁定） |
| 2026-10-12 | I0_UI_03 | 设计选择性同步之后的本仓库业务改动：`src/workspace/{workspaceContracts,confirmation,frozenCommand,confirmationDb,confirmationWorkspace,useConfirmationWorkspace}` 建立统一原命令/确认/快照客户端；同名 IndexedDB v1→v2 仅增 outbox/metadata，保留原五 store；既有编辑/准备入口绑定原文、实例映射与 CAS；同一 `prep/` authority 支持创建/保存/快照/恢复故障与原子拒绝；补公开 HTTP/浏览器边界测试和严格测试端口覆盖。未新增依赖或改服务端模块/产品基线，详情见 [03 任务记录](../../docs/tasks/I0_UI_03_CONFIRM_SNAPSHOT.md) |

未回写设计仓库；上述修改只存在于本仓库。
