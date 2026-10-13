# 05：文件回收恢复与版本比较

**What to build:** 学生回收/恢复文件实例，识别同名重建的差别，并只读比较两个快照或草稿与确认版本。

**Blocked by:** [03 确认保存与不可变快照](I0_UI_03_CONFIRM_SNAPSHOT.md)。

**Document status:** `implemented`（准备范围，2026-10-12 开工）。

**Status:** `implemented`（准备范围，两仓库均已交付）：03 已交付（见 03 的「实际实现」），旧阻塞状态不再是代码事实；P-01 由项目负责人本次 implement 指令落实；P-04/U-05 入口按 03 先例先在**设计仓库**实现并提交（`718f2ae`），主仓库随后按同一视觉与文案接入准备范围（本次为首次双向同步，记录见 [IMPORT_SOURCE §4](../../apps/student/IMPORT_SOURCE.md#4-后续设计同步办法)）。实现、审查与验证记录见下；真实服务交接与基线汇总单列。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §4/5/7（U-05）；M-02/09、AC-02/03/12，TECH §4.3/7.4/7.5。03 已交付的共同边界（带上下文 bootstrap/head、原文草稿 + draftRevision 与实例映射、冻结 outbox、确认头、不可变 snapshot 读取、权威 Attempt 重读）在本任务复用，不另建第二份确认状态。

可写：`apps/student/src/workspace/**` 的文件生命周期命令与只读比较视图模型、`apps/student/src/components/workspace/**` 的文件操作与比较接线、`apps/student/src/lib/**` 的实例记录读取、同一 `dev:prep` fixture 的必要扩展、`apps/student/e2e/**`、`apps/student/src/styles/app.css`、`apps/student/IMPORT_SOURCE.md`、`apps/student/README.md`、本文。不硬删实例/仓库文件/旧存储，不改恢复规则或受保护文件；服务端代码与 `docs/product/**` 只读。

## 设计决定（本任务，已按 03/04A 先例执行）

1. **不新增 IndexedDB store**：实例生命周期意图复用 02 已有的 `instances` store 的 `InstanceRecord.lifecycle`（该字段 02 已声明、03 的 ACK 事务已按权威值写入）。因此本任务**不触发** AGENTS 的数据库 schema 红线，不需要新的 P-02 批准；库版本仍为 v2。
2. **不新增依赖**：复用 `monaco-editor` 的 diff 能力（03/04A 已装），P-03 不适用。
3. **P-04/U-05 入口**：客户端约束 §7 的 U-05 要求「接文件操作与既有版本容器」，并写明「具体入口待 UI 交付/确认；不造 rename 或强制覆盖」。项目负责人（同时是 UI 成员）在实施后来指出设计仓库即其交付位置，并要求一并完成设计：**设计仓库先落**（`718f2ae`，见下节），入口沿用 02 已交付的 `FileStrip`「文件」列表行内动作区与 03 已交付的运行簇（对应设计仓库的 `CodeRunCluster`），不新造页面、导航或视觉，不改前端框架；主仓库随后按同一视觉与文案接入。
4. **回收/恢复是本地意图 + 03 的原命令**：学生在文件列表里明确点「回收」「恢复」只改**本机意图**（落 `instances.lifecycle`），真正的业务命令仍由「确认保存」按 03 的冻结 outbox/ACK 事务发出。理由：与 02/03「编辑是本机草稿、上传由学生明确发起」同构，避免出现第二条写通道；「未确认回收」在界面上如实标为未确认，不冒充已生效。
5. **恢复路径占用的处理**：本机在 `restore` 前核「该路径是否被另一个**期望 active** 的实例占用」。被占用时**只拒绝并说明**，不覆盖、不自动 rename；学生必须先在占用者行上明确「回收」，路径才算空出，之后恢复随下一次确认保存发出。整批 sync 仍是原子的（服务端 `validateFiles` 在整批应用后校验 active 路径唯一），因此不存在中间态。
6. **同名重建是新实例**：`create` 不因路径相同而复用旧实例；服务端 `UNIQUE(attempt_id,path) WHERE lifecycle='active'` 只约束 active，回收后的同名重建得到新 fileId。本机实例身份始终是 `clientFileKey`/`localId`，路径不参与身份。旧快照/运行继续引用旧 fileId。
7. **比较按身份对齐，不按路径**：只读版本比较的每一行按 **fileId** 对齐两侧；只在单侧存在的文件显示为单侧（`null`），绝不因为路径相同就把同名新实例当成旧引用。比较是纯只读投影：只消费已核验的 `head.snapshots`、已接纳确认头与本机草稿，**不发出任何请求**（三者都已在内存里），不改源 model、不写草稿、不改摘要。
8. **恢复结论**：`STATE_CONFLICT`（例如恢复时路径已被占用）语义上是「整批确定没有生效」，加为独立结论 `state-conflict`：不重放同一份命令（重放不能解决），不阻塞学生用新的、基于当前权威状态的命令重新保存，学生提示明确指向「重新读取」。这与 04 的 `historical` 同族但文案不同。

## 接口冻结（并行写集的唯一契约）

以下签名在实现期间冻结；任何一方需要修改先回到本文更新并通知另一方。

### 1. sync 操作（workspaceContracts.ts）

```ts
export type SyncOperation =
  | { kind: 'create'; clientFileKey: string; path: string; text: string }
  | { kind: 'update'; fileId: string; baseVersion: number; text: string }
  | { kind: 'recycle'; fileId: string; baseVersion: number }   // 05 新增
  | { kind: 'restore'; fileId: string; baseVersion: number }   // 05 新增
```

字段与顺序对齐 `server/workspace/inputs.ts:21-28` 的 `fileOperationSchema`；服务端 `syncFiles` 已支持两种生命周期操作（`server/workspace/files.ts:60-88`），本任务**不改服务端**。

### 2. 冻结草稿（frozenCommand.ts）

```ts
export interface FrozenDraft {
  localId: string; path: string; text: string; draftRevision: number | null; serverFileId?: string
  /** 学生本次要让这个实例处于的生命周期；省略 = 'active'（02/03/04A 既有调用方语义不变）。 */
  lifecycle?: 'active' | 'recycled'
}
```

`freezeSync` 按「期望生命周期 × 当前确认清单」生成操作：

| 确认清单里的实例 | 期望生命周期 | 生成的操作 |
| --- | --- | --- |
| 无（本机新建） | active | `create`（路径/限额校验，同 02） |
| 无 | recycled | 拒绝：还没确认的文件不能回收 |
| active | active | 正文不同才 `update`；相同则跳过 |
| active | recycled | `recycle` |
| recycled | recycled | 跳过 |
| recycled | active | 该路径未被其他期望 active 的实例占用时 `restore`，否则拒绝「恢复路径被占用」 |

同一实例每批最多一个操作（TECH §7.4）；`restore` 只带回已确认正文，恢复后的本机修改由学生再确认保存一次（服务端 `restore` 不接受 `text`）。
`verifySyncReceipt` 对 `recycle`/`restore` 核：`path`/`text`/`contentHash` 不变、`documentVersion === baseVersion + 1`、`lifecycle` 为期望值。

### 3. 实例记录读取（lib/draftStore.ts）

```ts
export interface DraftRepository {
  // ...既有方法不变
  loadInstance(clientFileKey: string): Promise<InstanceRecord | null>   // 05 新增
}
```
`idbDraftRepository` 与 `memoryDraftRepository` 同步实现；无 schema 变更。

### 4. 文件生命周期纯函数（src/workspace/fileLifecycle.ts，新文件）

```ts
export type LifecycleProblem = 'not-confirmed' | 'already-recycled' | 'already-active' | 'path-occupied' | 'not-allowed' | null
/** 这个实例的期望生命周期与最近确认的不一致（含本机新建）：界面标「未确认」。 */
export function isLifecyclePending(file: ProjectFile): boolean
/** 回收能否进行；不能时给出原因码。 */
export function recycleProblem(file: ProjectFile, access: ProjectAccess): LifecycleProblem
/** 恢复能否进行；occupant 是占用该路径的另一个期望 active 实例。 */
export function restoreProblem(file: ProjectFile, files: ProjectFile[], access: ProjectAccess):
  { problem: LifecycleProblem; occupant: ProjectFile | null }
/** 项目里所有期望 active 的实例（含待确认回收/恢复后的投影状态）。 */
export function activeFiles(files: ProjectFile[]): ProjectFile[]
```

### 5. 文件工作区公开面（useProjectWorkspace.ts）

```ts
export interface ProjectWorkspace {
  // ...既有字段不变，新增：
  /** 学生明确回收这个实例（本机意图；随下一次确认保存发出）。 */
  recycle: (fileId: string) => void
  /** 学生明确恢复这个实例；路径被别的实例占用时拒绝并返回占用者，不做任何改动。 */
  restore: (fileId: string) => { ok: true } | { ok: false; problem: LifecycleProblem; occupant: ProjectFile | null }
  /** 「确认保存」时一并发出的生命周期意图数（未确认的回收/恢复）。 */
  lifecyclePendingCount: number
}
```

### 6. 只读版本比较视图模型（workspace/comparison.ts）

```ts
/** 一侧的来源；files 的身份键必须与另一侧同一键空间（本机实例 ID / 服务端 fileId）。 */
export interface VersionFile { fileId: string; path: string; documentVersion: number | null; contentHash: string | null
  text: string
  /** 只有权威事实那一侧带它（当前确认作品）；快照清单没有 lifecycle，本机草稿侧是意图，两者留空。 */
  lifecycle?: 'active' | 'recycled' }
export interface VersionSide { label: string; revision: number | null; files: VersionFile[] }
export type VersionSource = 'snapshots' | 'draft-confirmed'
export interface VersionRow { key: string; fileId: string; path: string; left: VersionFile | null; right: VersionFile | null }
export interface VersionComparison {
  kind: 'versions'; source: VersionSource; leftLabel: string; rightLabel: string
  rows: VersionRow[]
  /** 两侧都有且原文不同、或只有一侧有的行数。 */
  changedCount: number
}
export function buildVersionComparison(source: VersionSource, left: VersionSide, right: VersionSide): VersionComparison
/** 快照 → 一侧；身份是快照里的 fileId（旧快照/运行引用同一身份）。 */
export function sideFromSnapshot(snapshot: SnapshotView): VersionSide
```

对齐规则：**只按 `fileId`**；行序 = 左侧顺序，再接只在右侧出现的行（稳定顺序）。两侧同一 `fileId` 但 `path` 不同时以两侧各自路径展示（路径不是身份）；只在单侧出现时另一侧为 `null`。

### 7. 只读比较组件与共享正文面板

- `components/workspace/CompareText.tsx`（新）：`CompareDiff({path, leftText, rightText, leftLabel, rightLabel, readOnlyReason, ariaLabel?})` 与 `CompareReadOnly({path, text, ariaLabel, readOnlyReason})`，只读、匿名 model、卸载 dispose；从 04A 的 `ConflictCompare.tsx` 内提取。所有正文经 `projectOriginal(...).modelText` 投影（BOM/CRLF/裸 CR → LF 显示），**不写回、不算摘要**。只读提示由调用方给出（`CONFLICT_READ_ONLY_REASON` / `VERSION_READ_ONLY_REASON`）：两个比较视图下方的动作不同，共用一句会把学生指向不存在的按钮（审查 P2-1）。
- `components/workspace/VersionCompare.tsx`（新）：

```ts
export interface VersionOption { id: string; label: string }
export interface VersionCompareProps {
  comparison: VersionComparison
  options: VersionOption[]
  leftId: string; rightId: string
  onSelect: (side: 'left' | 'right', id: string) => void
  onReturn: () => void
}
```
  根元素 `.ws-compare[data-source='snapshots'|'draft-confirmed']`（沿用 04A 的容器类），每行 `.ws-compare-file[data-fileid]`，行头显示身份（fileId）、路径、两侧版本读数与回收状态（`.ws-compare-file-lifecycle`，例如「右侧已回收」），diff 复用 `CompareDiff`；单侧行走 `CompareReadOnly` 并给出明确可访问文案。
- 入口与键盘：运行簇「比较版本」按钮（Tab/Enter 打开），比较内两个原生 `<select>`（键盘可达）切换左右来源，Esc 离开。

### 8. 确认状态新增字段（confirmationWorkspace.ts）

```ts
export interface ConfirmationState {
  // ...既有字段不变，新增：
  /** 当前 head 已核验的全部快照（verifyHead 已逐个核验）。 */
  snapshots: SnapshotView[]
}
```

### 9. 写集划分（并行期间不重叠）

| 写集 | 负责方 | 文件 |
| --- | --- | --- |
| L（lifecycle） | lifecycle-client | `lib/draftStore.ts`、`lib/projectFiles.ts`、`workspace/draftDb.ts`、`workspace/frozenCommand.ts`、`workspace/fileLifecycle.ts`(新)、`workspace/fileLifecycle.test.ts`(新)、`components/workspace/useProjectWorkspace.ts`、`components/workspace/FileStrip.tsx`、`components/workspace/CodeWorkspace.tsx` |
| V（version） | version-compare | `workspace/comparison.ts`、`workspace/comparison.test.ts`、`components/workspace/CompareText.tsx`(新)、`components/workspace/VersionCompare.tsx`(新)、`components/workspace/ConflictCompare.tsx` |
| I（集成） | Lead | `workspace/workspaceContracts.ts`、`bridge/types.ts`、`bridge/projects.ts`、`workspace/recovery.ts`(+test)、`workspace/confirmationWorkspace.ts`、`workspace/useConfirmationWorkspace.ts`、`workspace/versionSources.ts`(新+test)、`workspace/projectSeed.test.ts`、`components/workspace/ConfirmationCluster.tsx`、`pages/PrepWorkspacePage.tsx`、`styles/app.css`、`prep/workspace.ts`、`prep/plugin.ts`、`e2e/helpers.ts`、`e2e/fileHistory.spec.ts`(新)、`IMPORT_SOURCE.md`、`README.md`、本文 |

实际执行中 L 交付的用途与 V/I 无重叠；`bridge/types.ts` 与 `bridge/projects.ts` 由 I 在并行开始前落地，L 只读使用。

`workspaceContracts.ts` 与 `bridge/types.ts` 由 I 与 L 各自先落地后再并行；`frozenCommand.ts` 的 `CommandContext/FrozenCommand/OutboxRecord` 不变。

## Acceptance criteria

- [x] **学生明确 recycle/restore，沿用 fileId/baseVersion/CAS/原幂等语义及 03 的原命令/ACK 事务；拒绝不丢草稿、不假成功。**
  → 生命周期操作由「确认保存」按 03 的冻结 outbox 发出：`freezeSync` 按「期望生命周期 × 当前确认清单」生成 `recycle`/`restore`（[frozenCommand.ts:74-121](../../apps/student/src/workspace/frozenCommand.ts)），业务键/CAS/`expectedWorkspaceRevision`/幂等语义与 02/03 完全一致；服务拒绝（含 `STATE_CONFLICT`）后草稿与意图都保留，只把事实写回原命令并显示「上一次操作没有生效」。纯函数 24 例、浏览器用例 1/2。
- [x] **同路径重建是新实例；旧快照/运行保留旧 fileId，草稿/model/历史按实例隔离。**
  → 服务端 `UNIQUE(attempt_id,path) WHERE lifecycle='active'` 只约束 active；本机身份始终是 `localId`/`clientFileKey`，路径不参与。用例 1 断言重建后服务端有两个实例、旧实例 fileId 与 `contentHash` 不变；用例 4 断言比较里同路径两实例分两行。
- [x] **恢复路径被占用时保留双方，不覆盖/擅自 rename；学生显式处理当前占用后才能用新的命令恢复。暂停/终态/无权限不可操作。**
  → 本机拒绝且不做任何改动（[fileLifecycle.ts](../../apps/student/src/workspace/fileLifecycle.ts) 的 `restoreProblem`，按钮带原因说明；`freezeSync` 再核一次占用并抛「恢复路径被占用」）。用例 1 走完整链路：占用拒绝 → 回收占用者 → 恢复成功后旧实例回到自己的 fileId 与原文；用例 2 覆盖暂停/终态（dev-only `/__i0prep/attempt-state` 切状态后重新读取）。暂停期间**发出的**命令被三层挡住：按钮禁用、页面 `canSave` 与 `save()` 的 update-only 判定、fixture 与服务端同语义校验；用例 6 用「暂停前留下的意图」走通拒绝路径。
- [x] **两快照或草稿/确认比较只读，展示身份/路径/版本和正文差异；无隐式写请求，不改源 model。**
  → 比较来源全部来自内存里已核验的 `head.snapshots`、已接纳确认头与本机草稿（[versionSources.ts](../../apps/student/src/workspace/versionSources.ts)），组件不发请求、不写存储（[VersionCompare.tsx](../../apps/student/src/components/workspace/VersionCompare.tsx)）。用例 3/4/5 以页面级非 GET 请求记录断言 `writes 为 [])`。
- [x] **单侧/回收/历史缺失状态准确，不用同名新实例代替旧引用；原文 EOL/BOM/非 BMP 与 readonly diff 显示相容，不能仅因进入 diff 改摘要。**
  → 对齐只按 fileId（[comparison.ts](../../apps/student/src/workspace/comparison.ts)），单侧为 null 且界面写明「只有某一侧有这个文件实例」；比较装配按本机实例映射换身份、映射不到就保持服务身份单列，不按路径顶替（[versionSources.ts](../../apps/student/src/workspace/versionSources.ts)）。回收状态单独读数：`VersionFile.lifecycle` 只由权威事实带来，行头显示「右侧已回收」（用例 4），因此「被回收」不会与「没动过」混为一谈。用例 5 断言进入 diff 前后草稿正文、确认头与快照摘要逐字不变。
- [x] **键盘能打开/切换/离开比较，使用实际 UI 交付和容器，不另造页面。**
  → 入口在既有运行簇（Tab + Enter），两侧来源各有一个「换一版」按钮（一个 Tab 停靠点循环切换；原生 `<select>` 保留，但实测 Chromium 里只有经弹层才能改值，不能作为键盘路径）与原生 `<select>` 聚焦；Esc 在页面层绑定，比较与服务冲突比较各自只处理自己的关闭。用例 3 覆盖 Enter 打开、键盘切换、原生下拉可聚焦、Esc 离开。入口与容器都是 02/03 已交付的组件，无新页面/导航/视觉。
- [x] **浏览器验证回收→同名重建→恢复冲突、合法恢复和只读比较，核实例、摘要及无写副作用；相应工程检查通过。**
  → `e2e/fileHistory.spec.ts` 5 例 + 全量 57 例通过；类型检查、单测、构建、全量 e2e 记录见「验证记录」。

## 实际实现（2026-10-12）

| 边界 | 代码与实际行为 |
| --- | --- |
| 生命周期命令 | `workspaceContracts.ts` 的 `SyncOperation` 补 `recycle`/`restore`（字段序对齐服务端 `fileOperationSchema`）；`frozenCommand.ts` 的 `FrozenDraft.lifecycle` 表达学生意图，`freezeSync` 按映射表产出操作、`verifySyncReceipt` 对生命周期回执核「正文与摘要不变、版本 +1、lifecycle 为期望值」 |
| 生命周期判定 | `workspace/fileLifecycle.ts`：`isLifecyclePending`/`recycleProblem`/`restoreProblem`/`activeFiles`/`lifecycleProblemMessage`，纯函数、无落盘无请求 |
| 本机意图 | 复用 02 的 `instances` store 字段（**不加 store、不改库版本**）：`DraftRepository.loadInstance` + `useProjectWorkspace.recycle/restore/lifecyclePendingCount`；载入与 head 推进都以本机记录覆盖权威值，未确认的回收/恢复不会被别处读回来的旧值抹掉 |
| 文件操作入口 | `FileStrip.tsx`：文件列表每行「打开 / 回收」平级按钮，底部「已回收的实例」区给「恢复」；不可操作时按钮 disabled 并给出原因（占用者说明整行显示）；`CodeWorkspace.tsx` 状态行单列「待确认回收/待确认恢复」，已回收实例的编辑区换成明确说明 |
| 恢复结论 | `recovery.ts` 新增 `state-conflict`（`STATE_CONFLICT`）：整批确定未生效 → `isTerminalRejection` 判终态（不再重放）、`blocksNewSave` 放行新保存、学生提示指向重新读取；`confirmationWorkspace` 映射为 `not-applied` 阶段，`ConfirmationCluster` 的 `notApplied` 与 `stale` 同一处理；`confirmationDb.noteRejection` 在记录这个码时把该行退役为历史事实——它没有可做的动作，留在 pending 只会让已经了结的失败在每次刷新时重新变成「未决」|
| 暂停门控 | 暂停期间服务端只接受已有 active 文件的 update：回收/恢复按钮禁用（`recycleProblem`/`restoreProblem` 返回 `not-allowed`），页面 `canSave` 与 `save()` 再用**确认清单里的生命周期**挡一次，准备 fixture 与服务端同语义（暂停只允许 update、终态拒绝、只有 `ready` 推进到 `active`）|
| 只读比较 | `comparison.ts` 新增按身份对齐的版本比较视图模型；`versionSources.ts` 装配两侧来源（快照/确认作品按本机实例映射换身份，草稿本来就是本机身份）并给默认比较对（两个以上快照比最近两版，否则比「确认作品 × 本机草稿」）；`CompareText.tsx` 抽出 04A 的只读正文面板供两处复用；`VersionCompare.tsx` 只渲染投影 |
| 同一准备 fixture | `prep/workspace.ts` 已支持生命周期操作（复用现有状态机），本次只加 dev-only `POST /__i0prep/attempt-state`（暂停/终态），供「不可操作」门控验收；不造业务回执、不产生学习记录，正式产物不含它 |

## 与团队决定的差异与待确认项

1. **P-04/U-05 的入口形态**：客户端约束 §7 的 U-05 写明「具体入口待 UI 交付/确认；不造 rename 或强制覆盖」。本次沿用 04A 先例，在**既有**容器内组合入口（文件列表行内 + 既有运行簇），不新造页面/导航/视觉，也无设计仓库同步。若 UI 成员随后交付专用组件，按其交付替换入口即可，客户端边界不需要改。
2. **生命周期意图先落本机、随下一次确认保存发出**：这是设计决定第 4 条的取舍——与 02/03「本机草稿 + 学生明确确认」同构，代价是「点回收」到「确认保存」之间服务端还没变。界面用「待确认回收/待确认恢复」如实区分，不冒充已生效。
3. **暂停期间已存在的生命周期意图**：暂停时回收/恢复按钮是禁用的，但如果意图在暂停前就已存在（尚未确认保存），点击「确认保存」会被服务端整批拒绝（`STATE_CONFLICT`）。客户端如实显示「上一次操作没有生效」，草稿与意图保留；暂停结束后学生可用「恢复」或下一次确认保存把意图表达清楚。未为此新增客户端状态（不做静默丢弃、也不自动改键重发）。
4. **恢复与「继续改正文」是两次确认**：服务端 `restore` 操作不带正文（TECH §7.4 同实例每批一个操作），所以恢复带回的是**已确认**正文，学生恢复后要继续改需要再确认一次。这是服务端既有语义，不是 05 的取舍。

## 设计仓库交付（2026-10-12，XunJie_Design）

项目负责人即 UI 成员，明确设计交付位置是 [XunJie_Design](https://github.com/wubq511/XunJie_Design) 的 `app/`，并要求本次一并完成设计。按该仓库 `AGENTS.md`（先读 `docs/DESIGN.md`、按路径显式 add、推送由用户决定）实施，提交 `718f2ae`（仅本地）。

| 设计侧文件 | 内容 |
| --- | --- |
| `src/lib/fileLifecycle.ts`(+test) | 回收/恢复能不能点、为什么点不动、未确认判定与文案（设计规则的可执行形态，6 例） |
| `src/lib/fileComparison.ts`(+test) | 只读比较视图模型：按 fileId 对齐、单侧为 null、回收状态只在权威侧（4 例） |
| `src/components/workspace/CompareText.tsx`、`VersionCompare.tsx`(新) | 只读正文面板与版本比较视图（左右来源、键盘「换一版」、身份/版本/回收读数、Esc 返回） |
| `FileStrip.tsx`、`CodeWorkspace.tsx` | 行内「回收」、已回收实例区「恢复」+ 占用者说明、待确认标记、已回收实例的编辑区说明、运行簇比较入口 |
| `useProjectWorkspace.ts`、`draftStore.ts`、`bridge/types.ts`、`bridge/projects.ts` | 本机生命周期意图随草稿同一条记录落盘（刷新不丢）、`confirmed.lifecycle` |
| `pages/WorkspacePage.tsx`、`bridge/types.ts` | 比较视图接线；演示数据补两个**历史版本**（wordfreq v1/v2，身份与当前作品同 fileId），默认打开即比最近两版，来源列表里另有「确认作品 vN」与「本机草稿」可切换 |
| `styles/app.css` | 05 两个分节，按 `docs/DESIGN.md` 取值（辅助信息 `muted`、琥珀文字 `--tint-amber-fg` 满足 AA、圆角 6/8、150ms S 曲线） |

设计侧验证：`npx tsc --noEmit` 通过；`npm test` 10 文件 **106 例**通过（含新增 12 例）；`npm run build` 通过；dev 实屏核对五种状态并用断言确认：恢复被占用时按钮禁用且标题为「main.c 现在被另一个文件实例占用；先在它那一行回收，才能恢复这个实例。」、比较行显示「右侧已回收」、终态下回收按钮禁用且标题为「当前作品状态不允许回收或恢复文件实例。」、同名重建在比较里是两行（6 行 = 5 个演示文件 + 1 个新建）；历史版本比较默认打开即 v1 × v2（4 行，其中 2 行「只有右侧有这个文件实例」——v1 还没有 words.c 与 sample.txt），来源列表给出四个可切换来源。截图留在本地（`/tmp/i005-design-*.png`，不纳入版本库）。

同步关系（详见 `IMPORT_SOURCE §4`）：主仓库接收 `fileLifecycle`/`fileComparison`/两个比较组件/文件条与工作区接线/CSS 分节；`VersionCompare.tsx` 两仓库是同一份组件（只差数据模块 import 路径），`CompareText.tsx` 主仓库多一层 `projectOriginal` 正文投影；设计仓库的页面接线、演示存储与 `mergedLifecycle`（多标签口径）不进主仓库；主仓库的 IndexedDB 事务、原文保真与确认 outbox 不进设计仓库。

设计落到两处后按主仓库口径统一的两个细节（同一提交内）：

1. 比较的「已确认作品」一侧，生命周期读数取 `confirmed.lifecycle`（权威事实）而不是 `file.lifecycle`（本机意图）——否则学生刚点过回收、还没确认时，两侧都会显示「已回收」，把「还没生效的打算」说成事实。
2. 运行簇把「N 个文件未确认」与生命周期意图分开报（正文/新建那一部分 = 总数 − 意图数），同一件事不报两遍。

## 两轴审查与修复（2026-10-12）

按 /code-review 的两轴（Standards / Spec）审查基准提交 `1ce6cfc` 上的改动，两个子代理各自只读审查并交付了带证据的发现（Spec 轴首次启动失败，由项目负责人恢复后完成；期间主 Agent 继续修复，因此其报告的部分行号对应修复前的版本，结论按最终代码复核过）。下面区分「已修」与「仅登记」，两个轴的发现合并列出。

### 已修

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| P2-1 | 只读输入提示「在下方选择要保留的正文后才能继续编辑」被 05 的版本比较复用，而那里下方只有「返回编辑」 | `CompareText.tsx` 的只读提示改为调用方参数（`CONFLICT_READ_ONLY_REASON` / `VERSION_READ_ONLY_REASON`），两个视图各用各的；文案不改 04A 语义 |
| P2-2 | 载入时把**每个**实例的生命周期抄进 `localLifecycle` 并在 head 推进时无条件覆盖 seed：另一标签回收并确认后，本标签重新读取仍显示「待确认恢复」，再点确认保存会静默发 `restore` 撤销它 | 删掉该 ref；改为纯函数 `mergedLifecycle`（[fileLifecycle.ts](../../apps/student/src/workspace/fileLifecycle.ts)）：**权威值变了以权威为准，没变才保留本页意图**。判据回到「意图只存在本机实例记录里」，head 推进不再掩盖别处的确认结果。新增 3 例纯函数用例 + 1 例双标签浏览器反例（另一标签回收并确认 → 本标签重新读取 → 不得出现待确认标记、确认保存必须禁用、不得发出 sync） |
| P3-4 | `restoreProblem` 缺确认基线判定，与 `recycleProblem` 不对称：实例不在确认清单时按钮可点，但 `freezeSync` 必然拒绝，并把原因误报成草稿保护失败 | 新增 `not-in-workspace` 问题码与对应文案（「这个实例不在当前确认作品里；先重新读取，再决定怎么恢复。」），按钮禁用并给出原因；补 1 例用例 |
| P3-6 | `recovery.ts` 中新加的 `NOT_APPLIED` 与紧随其后的旧注释不一致 | 注释改为「historical / state-conflict 这类确定没生效的事实才放行新保存」 |
| P3-7 | 新增的「比较版本」按钮禁用时没有原因 | 补 `title`（与同组既有禁用按钮一致） |
| P2-1（Spec） | 暂停期间「确认保存」仍会把暂停前留下的回收/恢复意图发出去：界面按钮是灰的，但 `canSave`、`save()` 的暂停分支与 `freezeSync` 都只挡本机新建，服务端必然整批拒绝 | 三处都补上「暂停只允许 update」的判定：页面 `canSave`（含 `lifecyclePendingCount`）、`save()` 用**确认清单里的生命周期**比对草稿意图、fixture 与服务端同语义校验（见 P3-3）。学生不会发出注定失败的命令 |
| P2-2（Spec） | `STATE_CONFLICT` 的未决行永远无法退役（不能重放、无比较入口、不阻塞新保存），每次刷新都重新发布成「上一次操作没有生效」 | `noteRejection` 在记录 `STATE_CONFLICT` 时**同时**把该行退役为历史（拒绝事实保留）：这条指令确定没生效且没有可做的动作，留在 pending 只会把已经了结的失败当成未决状态。VERSION_CONFLICT/RECOVERY_REQUIRED/IDEMPOTENCY_CONFLICT 不动——它们都有明确出口。新增一条端到端反例（暂停下回收 → 整批拒绝 → 刷新不再当未决 → 解除暂停后学生撤回意图，全程只有一次 sync） |
| P3-1（Spec） | 恢复的限额预检用本机草稿正文，而服务端按恢复回来的确认正文算：客户端放行、服务端返 `CONTENT_LIMIT`（非终态码）→ 重放同一条必失败命令 | `freezeSync` 的限额与路径预检改用 `before.files` 里该实例的确认正文；新增 1 例纯函数反例 |
| P3-2（Spec） | 05 新增的两种冻结期拒绝（恢复路径被占用、未确认不能回收）在学生界面没有文案，只进控制台 | `freezeHint` 增加这两条映射，分别指向「先在占用者那一行回收」「还没有确认保存过」 |
| P3-3（Spec） | 准备 fixture 不校验暂停/终态，且每次 sync 都把 Attempt 静默改回 `active`：浏览器验证据因此不可靠 | fixture 与服务端同语义：终态拒绝、暂停只允许 update、只有 `ready` 才会推进到 `active`。原「暂停仍可修改已有文件」用例因此在真实语义下通过 |
| P3-4（Spec） | 只读比较的行完全不表达生命周期：快照 × 当前确认作品时，被回收的实例两侧都在、正文还一样，学生无法区分「没动过」和「被回收了」（AC5 的「回收状态准确」缺一半） | `VersionFile` 增加可选 `lifecycle`（只有权威事实那一侧带它），行头新增 `.ws-compare-file-lifecycle` 读数（「右侧已回收」）。补 1 例纯函数断言与 1 处浏览器断言 |

### 仅登记（未改代码）

1. **同一意图被运行簇的两个读数各计一次**（P3-5）：只点一次回收且正文没改时，运行簇同时显示「1 个实例待确认回收或恢复」与「1 个文件未确认」。两句话描述的事实不同（生命周期意图 / 正文与新建），但 `unconfirmedCount` 目前把两类都算进去（确认保存按钮的可用性依赖它）。合并计数是必要的，文案重复是取舍；若要分开，需要把 `unconfirmedCount` 拆成「正文未确认」与「生命周期未确认」两个读数并同步按钮门控——不在本次范围内。
2. **比较视图左侧不去重、右侧去重**（P3-8，审查者用 node 探针实证）：今日不可达（`verifiedFiles` 拒绝重复 fileId，草稿侧 fileId 由 `projectSeedOf` 去重），保留现状因为「左侧重复」在真实数据里只可能来自上游故障，静默合并会掩盖它。
3. **`useConfirmationWorkspace.ts` 里关于「权威清单缺少实例」的注释措辞**（P3-2 待确认）：准备 fixture 与主仓库 head 投影都保留 recycled 实例，注释描述的是「权威回退或该实例从未确认」这类真实缺口；本次不改代码，按真实服务样例复核时一并确认。
4. **`monacoSetup.ts` 的一句注释自 04A 起已失真**（`line 51`：「diff 编辑器等到真的做比较界面时再加」，实现已按需引入）：该文件不在本任务写集，登记由后续任务处理。
5. **`.zcodeignore`**：未跟踪文件，早于本任务存在（03 的记录已说明不属其任务），本次继续排除，不暂存不提交。

## 验证记录

全部命令在 `apps/student` 下实际执行（2026-10-12，最终一轮）：

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.node.json` | 通过（含 e2e 与 vite 配置） |
| `npx vitest run` | 通过：18 文件 229 例。新增 `fileLifecycle.test.ts` 25 例（六种映射分支、restore 占用两来源、回收不占路径名额、恢复限额按确认正文算、生命周期回执核验与四类拒绝、判定矩阵、`mergedLifecycle` 三例、实例不在确认清单时不可恢复）、`versionSources.test.ts` 5 例（身份映射、来源顺序、默认比较对）、`comparison.test.ts` 追加 7 例（身份对齐/单侧/顺序/原样正文）、`recovery.test.ts` 追加 2 例（`STATE_CONFLICT` 结论政策） |
| `npm run build` | 成功（Monaco chunk 体积警告为既有） |
| `CI=1 npm run test:e2e` | 通过：**59 例**（2.4m），含新增 `e2e/fileHistory.spec.ts` 7 例；此前的 52 例无回归。CI 全新冷启动（5601/5602 空闲后新起进程）。期间一次首例启动失败（`.ts-badge` 未在 10s 内出现）复跑通过，与成果无关：冷启动竞态，本地已有登记 |
| 设计侧 | `XunJie_Design@718f2ae`：`npx tsc --noEmit` 通过、`npm test` 104 例通过、`npm run build` 通过，dev 实屏核对五种状态（见上节） |
| 浏览器条目 | ①回收→同名重建→恢复被占用→显式回收占用者→恢复成功（核服务端两个实例的 fileId/lifecycle/正文/摘要）；②暂停与终态不可操作、暂停仍可改已有文件；③只读比较（快照×快照、切换来源、原生下拉可聚焦、Esc 离开）全程零写请求；④同名重建在比较里两行、单侧状态明确、旧引用不被顶替；⑤混合 EOL/BOM/非 BMP 进入比较不改摘要与正文；⑥暂停期间发出的回收被整批拒绝（如实显示未生效、不重放、刷新后不再当未决、解除暂停后学生撤回意图，全程一次 sync）；⑦另一标签回收并确认后，本标签重新读取以权威为准（不出现待确认标记、确认保存禁用、不发 sync） |

反例覆盖（新增 spec 的实际断言）：恢复被占用时服务端版本号不变且两个实例都在；已回收实例的「恢复」按钮禁用并给出占用者说明；暂停/终态下回收按钮禁用；比较期间页面级非 GET 请求为空数组；同名不同实例在比较里是两个 `data-fileid` 且旧引用行两侧都是旧正文；另一标签确认的回收不被本标签的残留意图顶回去；比较行会说明实例已被回收（「右侧已回收」）；暂停下非 update 意图在客户端就被挡下（不发请求）。

审查修复后又跑过一轮完整验证（上表即修复后的最终一轮）。

环境观察（如实记录）：最终两轮全量 e2e 中，一轮在**首个用例**失败于 `.ts-badge` 未在 10s 内出现（Vite 冷启动依赖预构建竞态，属 04A 已登记的既有现象，与本次改动无关），复跑 59 例全绿。

未执行/未覆盖：真实业务宿主、真实后台库、真实 runner、多人并发与真实鉴权（H-01/H-02/H-03 仍是交接前条件）；设计仓库同步（本次无视觉改动）。准备模式通过不计真实读写交接、正式 AC/NFR、G0～G4 或教学效果。

## 交接与状态

03/04/04A 已交付的共同边界全部复用：本任务没有第二份确认状态、没有新 IndexedDB store、没有新依赖、没有改服务端。06/06A/06B 可直接复用 `readSnapshot`/`state.snapshots` 与 `buildVersionComparison`（例如运行快照之间的比较），不需要另建比较实现；生命周期意图与确认头的边界保持在 `useProjectWorkspace` 与 03 的 outbox 里。

状态：**已实现（准备范围）、已通过工程与浏览器验证**；两轴审查发现与修复见下节。本次改动已提交并推送到 `i0/ui-frontend`（`git ls-remote` 核对 `refs/heads/i0/ui-frontend` = `6dfc9231f53bf30e919aef93e88d8f20abf40792`）；设计仓库 `718f2ae`、`ad89519` 已推送到其 `origin/main`（核对 = `ad89519eff7673c399b3dfcbf521cf0363b31b40`）。两者均未部署；开工前已存在的未跟踪 `.zcodeignore` 未纳入提交。推送后仅文档记录变化，代码不再改动。基线汇总请求：请授权维护者把本文件范围汇总到 [MVP_SPEC §10](../product/MVP_SPEC.md#10-实现进展与验证记录)；本文件即该范围的实施记录，未改动 `docs/product/**` 任何内容（`git status -- docs/product docs/planning docs/reference AGENTS.md` 为空）。