# 03：确认保存与不可变快照

**What to build:** 学生主动创建/恢复 Attempt、确认作品并冻结可回取快照；ACK 迟到或本机事务中断后仍能保留草稿和原请求。

**Blocked by:** [02 专业多文件编辑与本机草稿](I0_UI_02_EDITOR_DRAFTS.md)。

**Document status:** `implemented`（2026-10-12 交付）。

**Status:** `implemented`：02 实际交付已核对；P-01、P-02 v2 增量、P-04/U-03 与公开边界 TDD 已获项目负责人明确批准。准备范围内实现、两轴审查修复与工程验证均完成；真实服务交接仍按 §8 单列，基线汇总待授权维护者。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §2～5/8、[准备记录](I0_UI_PREPARATION.md) §5.1；M-02/09、AC-03/12，TECH §5.1/7.4/7.5 与 C2 §10.4/11。

负责已有 Attempt 创建/读取客户端、保存/快照、原 outbox 与 ACK 接纳；可写学生前端对应模块、同一开发 fixture、测试与本文。后台路由/共享字段、宿主/恢复登记及受保护文件只读。

## 2026-10-12 开工核对与批准实施范围

- 项目负责人明确要求开始 03；P-01 已落实。起点 `980970e7a630e7ac00bc384efaecbb106d3e57c7`，当前分支 `i0/ui-frontend`；已有未跟踪 `.zcodeignore` 不属于本任务，不暂存、不提交。
- 02 已交付编辑器、原文适配与草稿 CAS，见 02 的代码位置和验证记录；其顶部旧“未实施”与本文旧阻塞状态不作为当前代码事实。
- 已读 AGENTS、README、PRD §3～5/8、MVP_SPEC M-02/03/09 与 AC-03/12、TECH_DESIGN §4.3/5.1/7.4/7.5，以及 01/02、接入规格、客户端约束、准备记录和服务端 workspace/records 的请求、回执、读取与摘要实现。
- 本任务可写 `apps/student/src/workspace/**` 的客户端、原请求与确认接纳模块，既有代码编辑/准备工作区的必要调用方与原文适配、`apps/student/prep/**` 同一 fixture、对应测试/harness、来源说明、启动说明和本文；受保护文档及服务端代码只读。
- 项目负责人回复“全部批准，你自行审批，你确认没问题就可以”：准确批准下述 v2 两 store 增量、设计仓库先行与主 Agent 审查/提交/搬入、公开客户端/存储事务/dev:prep 浏览器 TDD。此批准不扩大到受保护基线、服务端 schema、推送或部署。

### P-02：浏览器 schema 差异（已批准）

02 实际建立的是 `xunjie-i0-workspace` v1：`drafts`、`ui`、`instances`、`confirmed`、`candidates`。其中 `confirmed` 以 `clientFileKey` 为主键；未建原命令与序号 store，不能直接声称具备 03 的事务和恢复能力。

建议将此同名新库升级到 v2，仅增加 `outbox`（键 `commandKey`）及 `metadata`（键 `key`），保留五个现有 store 与全部草稿。`outbox` 保存 mode/account/Assignment/Attempt/loadEpoch/受信代际/preparation epoch、原业务键、完整 wire JSON、冻结原文及本机 draftRevision、发送 lease、原回执与确认状态；不保存密码、Session cookie、CSRF 或 provider 凭据。`metadata` 保存 clientId 序号预留与同归属确认头；`confirmed` 继续保存逐实例确认正文。接纳 ACK 的事务覆盖 outbox/metadata/confirmed/instances/drafts/candidates，事务内读取最新草稿并保留新编辑及候选。不改服务端 schema，不清空任何 store，不迁移或删除旧正文；版本升级只新增上述两 store，旧标签需重开连接。

此项属于 AGENTS 的数据库 schema 红线，经上述准确批准后实施。

### P-04/U-03：UI 扩展（已批准）

沿用 02 的设计仓库先行流程：在设计仓库既有代码工作区顶栏运行簇提供开始/恢复 Attempt、确认保存、冻结当前确认作品与状态；快照信息复用既有作品版本位置。保持页面、导航、布局及框架，明确演示态与准备态。设计评审确认后提交；推送与搬入按负责人明确授权执行。主仓库只接实际交付组件，不直接新造保存/版本界面。

### 验证接缝与顺序

建议 TDD 接缝为公开 Workspace 客户端（冻结 wire、回执核验、权威 head/快照读取）、存储公开事务接口（序号/冻结/接纳/恢复），以及 `dev:prep` HTTP 与浏览器实际操作；不测私有实现细节。读客户端和纯回执/摘要验证可先推进；schema 与具体 UI 批准前，不启用浏览器写请求或冒充完整 03 交付。

准确批准范围内的实现和实际验证在下方记录，不改变产品/后台契约。

## Acceptance criteria

- [ ] GET/页面载入不创建 Attempt；学生明确发起时调用已有 POST attempts，用受信代际与原业务键，解包回执后读 Attempt。已有 Attempt 则按获准引用读取；没有首次代际时禁写且说明 H-03。
- [ ] sync 由学生发起，冻结完整业务输入/原文、键、clientId/seq、代际、预期版本及归属，先持久化再发 POST。有效 Session/CSRF 在发送时取得，不将凭据或 CSRF 存 outbox。
- [ ] clientId 不复用、seq 事务单调预留不回退；重放用原值，新操作用新键/seq。两标签不同命令不占同一去重槽，预留中断只跳号。
- [ ] 解包 requestId/data/回执/result；仅冻结发送正文形成确认基线，ACK 元数据不当正文或整 Attempt。
- [ ] 实例映射、确认头、最新草稿关联与 outbox 确认在同一事务提交，事务内保留较新 draftRevision 和冲突候选；commit 后才显示已确认。同 ACK 重复接纳不产生第二次创建。
- [ ] 在每个 ACK 本机写入阶段后注入 abort，全部回滚；刷新核原命令恢复同 fileId，后续编辑保留。失败不部分成功，存储失败不换键补做。
- [ ] 每次 await 核 mode/身份/Attempt/loadEpoch/受信代际及读取轮次。必测 g2 回退 head 已读取后 g1 ACK 到达、同对象两次读取逆序、同身份退出再进入；旧响应只能留原隔离事实。
- [ ] 同代际较新 head 已接受后，迟到旧 ACK 只记历史且映射按当前清单核对，不回退确认头；同 revision/hash 冲突重读，跨代际不取最大版本。浏览器覆盖另一标签推进 head 后旧 ACK 到达。
- [ ] 对确认 workspaceRevision 发 snapshot 命令，回执取 ID/hash，再 GET 核完整文件清单/原文/摘要/归属。当前草稿可继续改，旧快照不变；原文混合 EOL/BOM/非 BMP 摘要一致。
- [ ] 保存/快照后 GET 重读权威 Attempt，供 run/control 使用；不算 revision 或拿 workspaceRevision 替代，保留 TECH §4.3 差异汇总。
- [ ] dev:prep 中学生实际保存后刷新 GET 能读同一确认头/快照，测试也走此路径。fixture 重启换上下文并提示重新比较，不能复用旧确认缓存。
- [ ] 浏览器覆盖正常创建/保存/快照、保存中继续编辑、原子拒绝、重复 ACK、事务中断、旧加载/代际及摘要不符；工程检查记录真实结果。

## 交接与状态

后续共用同一组边界：带上下文的 bootstrap/head、原文/draftRevision/实例映射、冻结 outbox/原回执核对、确认头、snapshot GET 和权威 Attempt 重读。04/04A/05/06 不各建另一份确认状态。

真实只读与保存按客户端约束 §8 各自交接，不等待运行 worker 或历史增强。下方记录实际实现、验证与仍待交接的真实服务条件；基线汇总待授权维护者。

## 实际实现（2026-10-12）

| 边界 | 代码与实际行为 |
| --- | --- |
| 唯一公开客户端 | `apps/student/src/workspace/confirmationWorkspace.ts` 与 `useConfirmationWorkspace.ts`：初始化只 GET；明确开始才 POST attempts；保存/冻结串行，重复读取按资源序号接纳。每个 await 核当前 guard，退出先使旧加载失效；保存/冻结后 GET 读取权威 Attempt |
| 原命令与校验 | `frozenCommand.ts`、`confirmation.ts`、`workspaceContracts.ts`：完整冻结原始 Unicode 文本、业务键、clientId/seq、代际、版本与归属；核完整回执/创建映射/正文摘要，不把 ACK 元数据当正文。快照完整 GET 校验 UTF-8 原文及 `sha256-manifest-v1`；同名回收/重建的确认清单按 fileId 比较，快照 manifest 仍按服务端 UTF-8 路径排序 |
| 持久化与 ACK | `draftDb.ts`、`confirmationDb.ts`：获准同名 v2 只新增两 store。序号预留、原命令持久化、发送租约、原子 ACK 分开公开；ACK 在同事务提交实例/确认头/最新草稿关联/outbox，正文与候选不回灌。四个阶段 abort 全回滚，刷新重放同键/输入/fileId |
| 跨标签代际 | metadata 中确认头与 Assignment 引用保存已退休的 opaque 代际；新权威代际可回退 revision，旧代际 GET/写请求被拒、迟到 ACK 仅原历史。首次创建用已核验回执目标查持久头；事务后 await 再核当前 authority，旧创建不能绑定并退休新代际 |
| 草稿与编辑器 | `useProjectWorkspace.ts` 串行保护点击时原文，先本机 CAS 再发业务保存。CAS 败方保留候选并锁存本次加载，重复编辑/保存不覆盖赢家；明确刷新/工作区重读后加载赢家解除。`CodeEditorHost.tsx`、`originalText.ts` 保留 BOM/原有 EOL，Monaco 显示值采用 LF，新插入换行按原文首个 EOL 映射，撤销/重做保留原文历史；确认头推进保留本机实例/model 与后续编辑 |
| 恢复与快照显示 | `projectSeedOf` 纳入 head 缺失的旧活动实例，使保留草稿仍可打开；保留原 serverFileId，禁止当 create 自动补发，明确需要比较。快照 GET 按 createdAt 选择、同时间保留刚冻结的对象，不用 ID 清单末项推断新旧 |
| UI 来源 | 设计组件先行提交 `522a4b9`，审查/浏览器绑定后补充 `0c18739f3dd8bc23a40dd171332fa939fff08ca4`。主仓库只接 `ConfirmationCluster.tsx` 与既有状态栏必要说明；准备页面绑定原顶栏/中心容器。ready 去掉无效恢复按钮和重复编辑中；长错误说明复用原 popcard，1280px 无顶栏重叠。来源记录在 `apps/student/IMPORT_SOURCE.md` |
| 同一准备 fixture | `apps/student/prep/workspace.ts` 与既有 authority/plugin/scenario：会话授权、受信代际、双键幂等、整批原子拒绝、持久 GET 作品与不可变快照；合成恢复可退回 head 并换代际。测试通过同一 dev:prep HTTP，不另外搭成功业务、不导入正式服务端或连接模型/runner |

新增原命令不保存 Session cookie、CSRF 或 provider 凭据；发送前读取当前 Session/CSRF，核本人角色后发送。开发事务 abort 注入由 `PREP_BUILD` 限定，真实产物不启用。

## 审查与纠正

按 Standards/Spec 两轴独立审查当前分支相对开工固定提交的改动，主 Agent 复核反例后修复：

- Standards 原 2 项 P1：跨标签旧代际 ACK 回退持久头；CAS 冲突后吸收赢家修订导致重试覆写。均补公开边界复现并修复。
- Spec 原 3 项 P2：同路径不同实例清单误报冲突、快照按 ID 顺序显示旧对象、恢复后已确认实例草稿在 UI 消失。均修复并补相应纯函数/浏览器反例。
- Spec 增量 P1：首次创建尚未绑定 Attempt 时的迟到回执，以及本机创建事务提交后 await 期间另标签换代际。两条浏览器旧实现均失败、修复后通过；引入有效回执目标围栏、Assignment 引用退休代际与事务后 authority 重核。

## 验证记录与基线汇总请求

### 验证事实（2026-10-12，修复后最终一轮）

- `npm run typecheck`（`tsc --noEmit` 与 `tsc --noEmit -p tsconfig.node.json`）：通过。本轮修复 1 处新增 e2e 用例的隐式 `any`（TS7006）。
- `npm test`（vitest）：13 文件 159 例通过，含 confirmation 5 例（回收重建清单按 fileId 比较、混合 EOL/BOM/非 BMP 原文与快照摘要、跨标签序号预留）、prep/workspace 18 例、prep/contract 9 例、originalText 28 例、draftStore CAS 4 例。
- `npm run build`：成功；Monaco 分块大小警告为既有提示，未新增依赖。
- `CI=1 npm run test:e2e`：39 例全部通过。confirmation 20 例覆盖创建/保存/快照刷新读回、保存中继续编辑只冻结原文、ACK 四阶段（mapping/head/drafts/outbox）abort 全回滚与刷新重放同 fileId、混合 EOL/BOM/非 BMP 经保存与快照 GET 字节不变、另一标签推进 head 后迟到 ACK 只记历史、g2 回退后 g1 ACK、同身份退出再进入、摘要不符拒绝、v1→v2 升级保留草稿与跨标签序号、同对象两次 GET 逆序、整批原子拒绝、同 revision 摘要不符不按到达顺序接纳，以及审查修复的 5 条反例（旧 g1 ACK/GET 不回退持久头、g2 回退后已确认文件草稿仍可打开且不自动补发、快照清单 ID 顺序不覆盖刚冻结对象、首次创建未绑定 Attempt 的迟到回执、创建事务提交后 await 期间换代际）；draftConflict 2 例覆盖 CAS 败方锁存期间重复编辑/保存不覆盖赢家且零 POST，页面刷新与工作区重读两条路径载入赢家后可保存；editor 4、prep 10、real-mode 3 为既有回归。
- 两轴复审结论：Standards 2 项 P1、Spec 3 项 P2 与增量 2 项 P1 的原反例在修复前均以公开边界用例复现为失败，修复后同用例转通过；修复完成后上述全量检查重新跑通。

未执行的真实服务检查保持下方状态。

TECH_DESIGN §4.3 写明 attemptRevision“不随逐次文件编辑增加”；C2 §11 的 A saveAttempt 接缝则要求实际 Attempt JSON 变化推进 revision，当前 sync 会同时推进 attemptRevision。03 沿用已交付公开行为，不计算或猜测该值，保存/快照后 GET 读取它。请求获授权维护者评估并汇总此差异及准备范围进度；本任务不修改 TECH_DESIGN/MVP_SPEC，也不宣告该措辞已消除。

未执行：真实业务宿主/同源 HTTPS/本人 Assignment 发现与首次受信代际 H-01/H-02/H-03 的浏览器联调；真实后台持久库、浏览器/服务端组合与 runner/model/真人验证。准备通过不计真实读写交接、正式 AC/NFR、G0～G4 或教学效果通过。

04/04A/05/06 应复用上述客户端、原 outbox 和确认/快照读取；冲突比较/明确选择、文件生命周期界面、运行与历史仍由各自后续任务交付。恢复后的孤立草稿不能自动变成新作品，CAS 败方候选不能自动上传。全部本次提交只在本地当前分支，未推送或部署；受保护文件保持只读，开工已有 `.zcodeignore` 保留并排除。
