# 04A：多标签与服务版本冲突选择

**What to build:** 学生遇到本机或服务版本冲突时保留双方原文，只读比较后明确选用/合并，再发新的保存请求。

**Blocked by:** [03 确认保存与不可变快照](I0_UI_03_CONFIRM_SNAPSHOT.md)。

**Document status:** `document-revised`，已实施（准备范围，2026-10-12）。

**Status:** `implemented`：03 已交付；P-01 由项目负责人 2026-10-12 的 implement 指令落实；U-04 冲突比较按 03/04 先例在主仓库组合现有槽位实现（本次无设计仓库同步，见 [IMPORT_SOURCE §5](../../apps/student/IMPORT_SOURCE.md#5-导入后本目录的改动)）。实现与验证记录见下，基线汇总待授权维护者处理。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §3～5/7；M-09/10、AC-03/06/12、NFR-04。负责冲突候选、现有容器内比较与明确选择；可写相关前端/测试/本文。沿用 02/03 的事务与权威头；后台契约、其他任务在途写集与受保护文档只读。

## Acceptance criteria

- [x] 两标签从同 draftRevision 开始编辑，CAS 败方不覆盖胜方；双方原文可恢复，存储失败保留内存正文并显示尚未保护。BroadcastChannel 不代替事务。
  → e2e/compare.spec.ts 用例 3：标签 B 落盘后标签 A 保存遇 draftRevision CAS 冲突，败方正文进候选（可再载入），冲突条出现且直接保存被阻塞。「存储失败保留内存正文并显示未保护」由 02 交付的失败路径保持（protection=failed + 内存正文不动），本任务的冲突条不改变该语义。BroadcastChannel 仍只做跨标签通知，一致性由 IndexedDB CAS 保证（03 沿用）。
- [x] VERSION_CONFLICT 读当前获准 head，保留本机原文/原确认基线/新服务正文；IDEMPOTENCY_CONFLICT 单列业务键冲突，不能偷偷替换输入再重发同键。
  → [comparison.ts](../../apps/student/src/workspace/comparison.ts) 以落盘原命令（冻结正文 + before 确认基线）与重读 head 构造三正文；e2e 用例 1 断言 diff 左=本机正文、右=当前作品。IDEMPOTENCY_CONFLICT 映射为单列结论 `key-conflict`（[recovery.ts](../../apps/student/src/workspace/recovery.ts)），核对与退役都不改冻结输入、不重发同键；下一次保存由学生以新键发起（e2e 断言新键、clientSeq+1）。
- [x] RECOVERY_REQUIRED 后重读的新上下文与旧正文可比较；旧 ACK 不建立新确认头。缺恢复交接则显示不可用。
  → e2e 用例 5：drop-ack → recover 轮换代际 → 重试被 RECOVERY_REQUIRED 拒 → 重新读取后旧代际未决命令以 `data-source='recovery'` 比较打开（服务端回退后无此文件，显示「服务端还没有这个文件」）；退役后确认头保持回退状态（workspaceRevision 0），之后以当前代际新键保存成功。缺恢复交接的不可用显示为 03 已交付行为，本任务沿用。
- [x] 比较只读，选择/合并由学生明确发起；此后以新权威预期版本、当前受信代际、新键/seq 保存，旧 outbox 保留拒绝/旧事实，不自行迁代际。
  → [ConflictCompare.tsx](../../apps/student/src/components/workspace/ConflictCompare.tsx) 全只读（`editorOptions(true)`、匿名 model、不进编辑注册表）；选择动作仅「保留本页正文/采用服务端正文」，退役经 retireResolved（state='historical'，rejected.code 保留），e2e 核对落盘事实与重新保存请求。**「合并」路径未实现**，见差异登记第 1 条。
- [x] 选择期间第三方再更新时重新 CAS，保留新候选；不把用户一次选择当永远允许覆盖。暂停仅允许已有 active update，终态只读。
  → resolveConflict('mine') 对库中最新修订重新 CAS，失败留新候选并保持冲突条（conflict-again，e2e 用例 3 以一次性钩子注入模拟选择期间写入）；每次选择都是一次新 CAS，无「选择后放行覆盖」状态。暂停/终态的保存与编辑门控为 02/03 已交付行为，本任务沿用。
- [x] 浏览器复现两标签写冲突、选择期间再冲突、服务 CAS 拒绝与恢复后比较；核双方正文、实际新请求以及旧上下文隔离，键盘可进入/离开比较。
  → e2e/compare.spec.ts 5 例：①服务冲突→比较→保留本页→退役→新键保存；②采用服务端正文；③两标签冲突条→再冲突→再选→保存；④Enter 打开/Esc 关闭比较；⑤恢复换代比较与旧上下文隔离。实际请求以 Idempotency-Key 与 body 双身份核对新键/seq/预期版本。
- [x] 工程与该切片浏览器检查记录准确结果；不记真实恢复或教学效果。
  → 见「验证记录」；未执行项如实标注。

## 实际实现

| 模块 | 内容 |
| --- | --- |
| src/workspace/comparison.ts(+test) | 比较视图模型纯函数：mine（冻结正文）/base（before 确认基线）/theirs（重读 head），ComparisonSource 三来源 |
| src/workspace/recovery.ts(+test) | key-conflict 单列结论（IDEMPOTENCY_CONFLICT）；conflict 文案指向比较；comparableOutcome 判定比较入口与选择按钮共用 |
| src/workspace/confirmationDb.ts | retireResolved：同代际 VERSION_CONFLICT/IDEMPOTENCY_CONFLICT 拒绝行、跨代际未决无回执行可退役为 historical，拒绝与旧事实保留在记录上 |
| src/workspace/confirmationWorkspace.ts | comparison 状态与 openComparison（先重读当前获准 head）/closeComparison/resolveConflict；source 判定：同代际=version-conflict，旧代际有拒绝事实=recovery，无拒绝事实=unresolved |
| src/workspace/diagnostics.ts | 新增 command.resolved、comparison.opened 诊断事件 |
| src/components/workspace/ConflictCompare.tsx | 只读比较组件：Monaco 双栏 diff（匿名 model、卸载 dispose、按需加载 diffEditor/register）、本机新建文件单栏只读、resolvable 门控选择按钮 |
| src/components/workspace/useProjectWorkspace.ts | conflictedFileIds 镜像、loadStoredDraftText（只读）、resolveConflict（mine=重新 CAS / stored=载入赢方），写段挂入 writing.current 串行边界；两种选择都不丢正文（先落候选） |
| src/pages/PrepWorkspacePage.tsx | 「比较双方正文」入口（comparableOutcome 门控）、比较视图接线、Esc 返回、本机草稿冲突条（用本页正文继续/载入另一处正文） |
| src/styles/app.css | ws-compare*、ws-draft-conflicts* 样式分节（末尾追加） |
| e2e/compare.spec.ts | 5 个浏览器用例（见上）；recovery/confirmation 两处旧冲突文案断言与 draftConflict 头注释同步更新 |

## 审查与纠正

/code-review 两轴（Standards/Spec）审查后处理：
1. **resolveConflict 原实现绕过 writing.current 串行写入边界**（Spec 轴，最重）：与 400ms 防抖 persist 交错时，stored 选择可能把库中正文 CAS 回写成选择前旧文，mine 选择可能产生虚假「再次冲突」。已把写段挂入同一条串行链，并在抛错时如实置为未保护。
2. **比较入口原对任意未决结论显示**（Spec 轴）：RATE_LIMITED、unresolved、lease-held 等场景规格未要求比较，且同代际一律标 version-conflict 对非冲突拒绝失真。新增 comparableOutcome（conflict/recovery-required/key-conflict/historical），入口与选择按钮共用；openComparison 的 source 改按「旧代际是否有拒绝事实」区分 recovery/unresolved。
3. **两处注释失真**（Spec 轴）：conflictIds 注释误写为驱动比较入口、conflicts 注释残留「比较尚未交付」，已修正。
4. Standards 轴判断题登记（本次不实施）：ConflictCompare 内 DiffText/ReadOnlyText 的 effect 骨架可抽共享 hook；e2e helper（localState 等）已是第四份拷贝，建议抽共享模块（涉及改动其他 spec，超出本任务范围）；retireResolved 的可退役码与 comparableOutcome 是「DB 退役政策」与「界面选择入口」两套相关但不同的策略，未强行合并。

## 差异登记（待负责人确认/知悉）

1. **「合并」路径未实现**：What to build 与 AC 写「明确选用/合并」，本任务交付只读比较 + 保留本页/采用服务端二选一，无三方合并工具；AC 亦未定义合并验收。需要合并能力时请明确范围后另立任务。
2. **retireResolved 接受 IDEMPOTENCY_CONFLICT 超出 AC 字面**：AC 只要求业务键冲突单列。若不可退役，key-conflict（终态拒绝、阻塞新保存、不可重放）将永久死锁；退役后新键保存不违反「不能偷偷替换输入再重发同键」（键与输入都换了，且由学生明确发起）。
3. **打开比较会重读 head 并推进本机确认头**：openComparison 的重读是获准读取，确认头随之推进，因此版本冲突用例中退役后第一次保存的 expectedWorkspaceRevision 是 2、结果为 v3（冲突前 v1）。这是 03「读取建立确认头」语义的既定结果，e2e 按实际行为断言。
4. **conflict-again 的毫秒级再冲突窗口无法用 400ms 节流可靠命中**：e2e 用例 3 以一次性钩子包裹 saveDraft 注入模拟「选择期间另一处写入」（沿用 confirmation.spec 注入 keepCandidate 的先例），业务路径本身未改。

## 待决策项处置

无新增冻结项。差异登记第 1、2 条请负责人知悉/确认；e2e helper 抽共享模块作为工程债提议，不在本任务实施。

## 交接与状态

不依赖 04 网络故障或 05 历史入口；比较视图全部在主仓库以现有容器与槽位组合实现，本次无设计仓库同步（[IMPORT_SOURCE §5](../../apps/student/IMPORT_SOURCE.md#5-导入后本目录的改动) 已登记改动清单）。实现状态：**已实现（准备范围）、已验证**；后续接入真实服务时按原 M/AC/NFR 复验。

### 验证记录与基线汇总请求

验证事实（2026-10-12，全部实际执行）：
- `npx tsc --noEmit && tsc --noEmit -p tsconfig.node.json`：通过。
- `npx vitest run`：16 文件 190 例通过（含新增 comparison.test.ts 与 comparableOutcome 用例）。
- `npm run build`：成功（Monaco 体积 chunk 警告为既有）。
- `npm run test:e2e`：52 例通过，其中 compare.spec.ts 5 例新增；recovery/confirmation/draftConflict 三文件共 13 行旧断言/注释更新。

环境观察（如实记录）：一次全量 e2e 曾出现首例启动失败，复跑通过；失败 trace 的浏览器 console 为 Vite 冷启动依赖重优化竞态（`504 Outdated Optimize Dep`，react-dom/@radix-ui），与业务代码无关。开发期间有热着的 dev server 可复用掩盖了该既有现象；建议后续在 vite.config 增加 optimizeDeps.include 预热或测试前预热（提案，未实施）。

未执行：真实服务联调、真实恢复与教学效果（AC 明确不记）；设计仓库同步（本次无视觉改动）。

基线汇总请求（交授权维护者）：请将本任务实现与验证状态汇总到 [MVP_SPEC §10](../product/MVP_SPEC.md#10-实现进展与验证记录)；本文件即为该范围的实施记录，未改动 docs/product 任何内容。
