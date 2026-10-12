# 02：专业多文件编辑与本机草稿

**What to build:** 学生真实编辑、创建和切换多文件，在刷新后恢复本机草稿；未编辑的原文不变，草稿与确认作品明确分开。

**Blocked by:** [01 固定版本导入、C 容器与初始化读取](I0_UI_01_IMPORT_C_ENTRY.md)。

**Document status:** `document-revised`，未实施。

**Status:** `implemented-pending-review`（2026-10-12 开工并交付；待 code-review 与基线汇总）。前置已落实：P-03 批准 `monaco-editor@0.57.0` 精确锁定（已安装）；P-02 批准新库 `xunjie-i0-workspace` v1（已建，未迁移旧数据、未改服务端 schema）；U-02/P-04 经项目负责人确认走「设计仓库先行 → 确认 → 提交推送 → 搬入主仓库」，设计基线为 `XunJie_Design@238d3c3`（已推送 origin/main），主仓库按 [IMPORT_SOURCE.md](../../apps/student/IMPORT_SOURCE.md) 第 4 节同步。

## 开工登记

- 已读：本 ticket、[I0_UI_CLIENT_CONTRACT.md](I0_UI_CLIENT_CONTRACT.md) §1/4/5/7、[I0_UI_SPEC.md](I0_UI_SPEC.md)、[I0_UI_PREPARATION.md](I0_UI_PREPARATION.md)、[I0_UI_01_IMPORT_C_ENTRY.md](I0_UI_01_IMPORT_C_ENTRY.md)、`apps/student/IMPORT_SOURCE.md`、服务端 `apps/teaching/server/workspace/files.ts` 与 `runner/snapshot.ts`（路径/限额/范围语义对照）、设计仓库 `docs/DESIGN.md`/`docs/home-design.md`/`CONTEXT.md`。
- 预计可写：`apps/student/src/{lib,components/workspace,workspace,pages}/**`、`apps/student/e2e/editor.spec.ts`、`apps/student/package.json`、本文件、`apps/student/IMPORT_SOURCE.md`。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md`、服务端代码。
- TDD 接缝（事先约定）：`src/lib/projectFiles.ts`（路径/限额/语言/EOL 纯函数，设计仓库先行）、`src/lib/originalText.ts`（原文保真映射/补丁/可逆历史/服务端行列）、`src/lib/draftStore.ts`（存储契约与 CAS 判定）；浏览器行为走 Playwright 与真实 Chrome 手验。

## 代码位置

| 能力 | 位置 |
| --- | --- |
| Monaco 懒加载、特性子集、主题同步、编辑器选项 | `apps/student/src/components/workspace/monacoSetup.ts` |
| 编辑器宿主：model 注册表、原文权威、内容/光标事件映射 | `apps/student/src/components/workspace/CodeEditorHost.tsx` |
| 原文保真纯函数（投影/双向 offset/补丁/可逆历史/服务端行列） | `apps/student/src/lib/originalText.ts`（+ `.test.ts` 27 例） |
| 路径/字节限额/语言/EOL 纯函数 | `apps/student/src/lib/projectFiles.ts`（+ `.test.ts`） |
| 存储契约、CAS 判定、内存实现 | `apps/student/src/lib/draftStore.ts`（+ `.test.ts`） |
| IndexedDB `xunjie-i0-workspace` v1 实现 | `apps/student/src/workspace/draftDb.ts` |
| 工作区 hook（草稿/标签/保护状态/CAS 写入） | `apps/student/src/components/workspace/useProjectWorkspace.ts` |
| 文件条（列表 + 底部行内命名）、代码工作区与运行簇 | `FileStrip.tsx`、`CodeWorkspace.tsx` |
| 课程工具包 mock 种子 | `apps/student/src/bridge/projects.ts` |
| 浏览器验证 | `apps/student/e2e/editor.spec.ts`（4 例） |

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §1/4/5/7、[准备记录](I0_UI_PREPARATION.md) §4/7；M-02/09、AC-02/03/12、NFR-04 前端责任。

负责现有容器内 Monaco、原文适配、多文件草稿及新库持久化；可写学生工作区/存储/适配、获准精确依赖与测试、本文。服务端 schema、旧浏览器数据、UI 骨架及受保护文件只读。

## 已确定的路线

在主仓库 `apps/student/` 使用直接依赖 `monaco-editor` 与本地 ESM worker，保留现有主题/容器。先锁精确兼容版本并验证原文往返，不重选编辑器，不加 wrapper/LSP/状态库。原文与显示模型的关系采用客户端约束 §4，不能把默认 getValue 当权威。

## Acceptance criteria

- [ ] 实际编辑 C、头文件与 ASCII 测试文本；新建/切换、选择、查找、undo/redo、中文输入和键盘可用。折叠/切换保留正文与视图状态。
- [ ] model 以模式/账号/Attempt/稳定文件实例隔离；clientFileKey 映射后保留同一草稿/视图。路径和 editor version 不充当服务身份/版本。
- [ ] 精确 Monaco 版本先证明 LF/CRLF/混合 EOL/裸 CR/BOM/末尾空行/非 BMP/中文未编辑往返完全相等；显示投影不造成 dirty、hash 或原文变化。
- [ ] 原文边界映射驱动实际局部/多范围编辑，未碰区域 EOL 不变，新增换行依既定规则。跨行删除/undo/redo/分支编辑恢复原分隔符和 BOM；不能靠统一换行过关。
- [ ] 引用坐标从原快照计算，覆盖裸 CR 与 BOM 导致的显示/服务行列差异；不能表达时明确不可用。整 text 保存仍保真。
- [ ] P-02 批准后才建立规定的新库。草稿写事务 complete 才显示“本机草稿已保护”；刷新恢复正文/活动文件，失败保留内存正文并显示未保护。
- [ ] 同一实例草稿以 draftRevision 做事务 CAS；拒绝旧修订写入不覆盖新正文，败方文本作为冲突候选保存或在存储失败时留内存。完整比较选择由 04A 交付。
- [ ] active 50 文件/1 MiB 按原 UTF-8 字节计；拒绝非法/重复路径、无效 Unicode，失败不破坏已有正文。限额由真实服务最终校验。
- [ ] 草稿/确认版本分开，布局/缓存重置不清本库。暂停仅编辑已有 active 文件，终态只读；不把本机昵称当权限。
- [ ] 真实浏览器验证多文件/中文/键盘/刷新/写失败及字节边界；原文适配用最少必要反例。typecheck/test/build 与本切片检查记录准确结果。

## 交接与状态

交 03：原文草稿、draftRevision、稳定实例映射、确认内容分离、事务失败与候选保留边界。编辑器不直接发业务命令；新库范围不得偷偷扩容或迁移旧数据。

### 验证事实（2026-10-12）

- `npx tsc --noEmit` 与 `tsc --noEmit -p tsconfig.node.json`：通过。
- `npm test`（vitest）：135 例通过（含 originalText 27 例、draftStore CAS 4 例、projectFiles 13 例）。
- `npm run build`：成功（Monaco 懒加载分块，chunk 大小警告为既有提示）。
- `npx playwright test`：17 例通过（01 的 13 例 + 02 新增 4 例：中文/undo/redo/刷新恢复、切换标签、新建与重复路径报错、存储不可用写失败）。
- 原文往返（锁定 0.57.0 上的纯函数证明）：LF/CRLF/混合 EOL/裸 CR/BOM/空文本/末尾空行/非 BMP/中文，「打开未编辑→序列化」逐字相等；跨行删除/undo/redo 经可逆原文历史恢复分隔符与 BOM。
- 真实 Chrome 手验（设计仓库 5181 与主仓库 5183）：行内命名创建、非法路径就地报错、Esc 语义、刷新恢复（localStorage 演示态与 IndexedDB 正式态分别验证）、CRLF+BOM 草稿经挂载/持久化/刷新不丢、写失败时「本机草稿未保护 · 正文还在内存，刷新会丢失」且正文可继续编辑。
- 设计仓库交付：`238d3c3` 已推送 `origin/main`；用户确认了两轮界面评审（删除菜单说明文案、新建改底部行内命名）。
- code-review（对照 HEAD=9daecd6 的全部 02 改动）：发现并修复 4 项——CAS 写入的 seq 守卫误冻修订、冲突后不刷新赢方修订导致候选堆积、`openDb` 缓存 rejected promise、载入完成前保护徽章误显「已保护」；另按 AC 把 model 注册表命名空间改为 模式/账号/Attempt 组合键，限额文案不再引用未实现的回收动作。修复后 typecheck / 135 单测 / build / 17 e2e 全绿。

### 缺口与待决（不冒充已完成）

- 键盘 undo/redo 在扩展浏览器通道不可靠，改由 Playwright 可信事件覆盖（已通过）；折叠状态保留未单独浏览器验证（视图状态 save/restore 已实现，e2e 未断言折叠）。
- 准备场景（textscope-c）的 C 正文仍显示「编辑待 02 接入」：该槽位需要获准的文件读取通道（H-06 样例 / 03 的 workspace 读取），02 不私造读取契约；`e2e/prep.spec.ts` 的对应断言保持有效，连接后由后续任务更新。
- draftRevision 冲突的完整比较选择界面属 04A；02 只做「拒绝旧修订 + 败方留候选 + 如实提示」。
- `confirmed` store 已按 P-02 建出但 02 不写数据，确认回执落库属 03。
- 多范围编辑（一次操作多个变更）的映射按「事件内范围均为变更前坐标」实现并经单测；真实多光标编辑的浏览器断言未加（Playwright 多光标构造成本高，风险已由逆序应用单测覆盖）。

### 基线汇总请求（待授权维护者处理）

- [MVP_SPEC §10](../product/MVP_SPEC.md#10-实现进展与验证记录)：登记 02 已实现与上述验证事实。
- [TECH_DESIGN](../product/TECH_DESIGN.md)：同步「原文权威 + LF 投影 + draftRevision CAS + 新库 v1」的技术契约描述（若维护者认定属基线变化）。
