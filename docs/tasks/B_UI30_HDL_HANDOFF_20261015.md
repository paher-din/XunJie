# B：UI30 / HDL 真实浏览器回交接纳与语义复核

日期：2026-10-15（Asia/Shanghai）。任务编号：B-UI30-HDL。主责：B。来源：[Issue #30 指定评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6175261812)。

状态：**B 的固定工程证据接纳已完成；两条消息的正式教师语义评审因完整正文材料缺失而保持“材料不足 / 未完成”。UI、节点、C3 与模型历史结果未重跑，未新增真实模型调用。**

## 1. 基线、已读依据与进入条件

本次从 [README](../../README.md) 进入，并按顺序核对：

- [PRD](../product/PRD.md) §1、§3、§4.2、§4.5、§5、§8～9，适用 PRD-03/04/05/09/10；
- [MVP_SPEC](../product/MVP_SPEC.md) §1.4、§2、M-03～05、§4～8，适用 DL-AC-04/05/06/08/09、AC-04/05/06/07/12/15/16、NFR-02/04/06；
- [TECH_DESIGN](../product/TECH_DESIGN.md) §6.1～6.3、§7.1～7.4、§8.5，重点为获准最小上下文、调用前后当前性、`received` / `displayed` / `acknowledged` 分层及 `stale` 不复活；
- [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) §2、§3、§7～10，B 固定负责 HDL 可信上下文、教学引导、模型/语义验证，不写学生作品、不控制板卡、不作正式评价；
- [DL-B 上下文与引导](DL-B_HDL_TUTORING_CONTEXT.md) §12～16、[HDL 人工语义审阅](DL-B_HDL_TUTORING_HUMAN_REVIEW.md)、[P4 核心验证安排](P4_DEADLINE_CORE_VERIFICATION.md)、[I0-B 六票计划](I0-B_UI_TUTOR_PLAN.md) §9～14；
- 指定评论引用的固定 [UI 实施记录](https://github.com/paher-din/XunJie/blob/1a3ba967bd03ca047fb5e39f22a63214038a4aeb/docs/tasks/I0-UI_HDL_REAL_BROWSER.md#74-%E4%B8%89%E6%9D%A1%E5%8E%9F%E8%A6%81%E6%B1%82%E5%AE%8C%E6%88%90%E5%BA%A6%E4%B8%8E%E9%AA%8C%E8%AF%81%E8%BE%B9%E7%95%8C)与[固定回交包](https://github.com/paher-din/XunJie/blob/1a3ba967bd03ca047fb5e39f22a63214038a4aeb/docs/tasks/evidence/ui30-hdl-20261015/handoff.md#6-2026-10-15-%E8%BF%BD%E5%8A%A0%E8%A1%A5%E8%AF%81%E4%B8%8E%E5%90%88%E5%B9%B6%E7%8A%B6%E6%80%81)。

开工时工作副本为 `codex/b4-p4-core-verification@69cc6f3`，早于本次回交。远端只读核对确认 PR #81 已普通合并：head `1a3ba967bd03ca047fb5e39f22a63214038a4aeb`，merge `ac49334218c8cfe1e4aa945355e982ddaf3638f3`。随后实际同步到：

- 首次同步到 `upstream/main = fork/main = 4fdf2f0f9ddaa51c93e971476a1e4598cf55217f`；任务期间上游先后合入 PR #88、#89 并推进到 `d77c9cc8efdab1a55c54c5b711f2cf8fce8f1ed3`，每次均纯快进 fork/main；全程无分叉或强推；
- 当前任务分支 `codex/b-ui30-hdl-handoff` 最初从 `upstream/main@4fdf2f0` 创建，随后以普通 merge 依次接入 `upstream/main@a1b1235` 与最新 `upstream/main@d77c9cc`，没有重写已推送历史；
- `origin` 与 `fork` 指向同一 `scy404/XunJie`，其中 `origin` 的 SSH fetch 因本机无对应公钥失败，已使用正常工作的 HTTPS `fork` remote 完成读取与推送；
- 本地 `main` 被另一个受管理工作树占用；在只读确认该工作树干净、旧提交为 `upstream/main` 的纯祖先后，已用 `--ff-only` 快进，并改为跟踪正常工作的 HTTPS `fork/main`；提交 PR 前再次同步到 `d77c9cc`。当前本地 main、fork/main 与 upstream/main 完全一致。

因此实际接纳在包含 PR #79/#81 及后续主线的最新固定树执行，没有在旧树制作替代实现。

## 2. 范围、写集与权限

### 2.1 本任务负责

- 接纳 UI30/HDL 回交中属于 B 的固定来源、C3 当前性/过时语义、消息与回执分层证据；
- 复核两条独立教学动作链，不把一条链的回执借给另一条链；
- 准备并组织正式教师语义评审，保存审阅者角色、逐项结论、理由、严重问题与是否需要修复/新真实复验；
- 将结论映射到 DL-B、B4、DL-AC-08/09 和 I0-B 未完成项，并向 Issue #30/#38 回交 B 的固定结论与限制。

### 2.2 默认写集

- 本任务记录；
- [正式教师语义审阅单](B_UI30_HDL_SEMANTIC_REVIEW.md)与 B 专用只读固定证据校验器；
- 若复核发现 B 域缺陷，经当前任务补充准确文件级方案后，可修改 `apps/teaching/server/tutoring/**` 及相称 B 域测试；
- 若只需记录审阅结论，可追加 B 自己的语义审阅/任务记录，不改 UI、A、C 作者记录。

`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md` 只读。当前未授权部署、远程环境操作、凭据读取、数据库/schema/迁移、依赖/CI 调整或新的真实模型调用。产品基线和 MVP_SPEC §10 状态为“待授权维护者汇总”。

## 3. 必须分开的两条证据链

### 3.1 链 A：首批实际展示与合成回应

固定回交声称以下对象属于同一链，B 须从原账本/正文核对，不只看摘要或截图：

- 同一确认快照、失败 Build 和代码 ObjectRef 形成 B/C3 冻结 basis；
- Job `70d697fc-0389-4cb5-a19b-9d68515db10d`、Message `92e9f7a9-dc89-4ee9-9f76-77242b10f013`、Action `5b918f49-a908-4b4a-864f-7b6d50f021c3`、Delivery `c4396c80-94c4-4828-9783-f3766b67fcb2`；
- `received` seq46、正文真实可见后的 `displayed` seq48、开发合成账号明确“我先试试”的 `acknowledged` seq50；
- 学生侧随后显式修订、形成新快照/成功 Build，相同 SW0 输入的真实输出由 LED0 变为 LED1，并确认停止；旧帮助在作品修订后过时，历史回执保留。

本链可证明固定合成浏览器中“收到—可见展示—明确回应—显式修订”的工程因果；合成 `acknowledged` 不是真人阅读、理解、采纳、能力或教学效果证据。

### 3.2 链 B：补证板卡求助收到后过时

固定回交声称：

- Job `765530ca-367c-4ca1-b496-d5365584cdff`、Message `f118e4d9-4920-475d-829c-50ffe804b1dc`、Action `1e32c2ec-60f2-4fa3-93fb-547e607e12ac`；
- basis 绑定同一快照/Build、Session `c69decae-f4c2-4cc3-9fa3-0138d30ca22c`、sessionRevision 3、confirmedSequence 2、simulationTimePs 20000、Operation `16235ed5-73b7-42e0-b8eb-d4535abaebe0` 及原协议 resultHash `229a353b8933e6ef0abc2d964d69d53da27f90addb298a5f753bdc281e49e583`；
- Action 取得 `received` 234/237/240，随后因 `learner_state_revised` 进入 `stale`；**没有** `displayed` 或 `acknowledged`；
- 该内容不得借用链 A 的 seq46/48/50，也不得描述成第二次实际展示或学生接棒。

本链用于复核原来源、当前性和过时守卫。Job `succeeded` 只说明生成完成，不能覆盖 Action 的最终过时状态；`received` 也不能推导页面可见。

## 4. B 的可执行任务清单

| 编号 | 任务 | 产出与通过条件 |
| --- | --- | --- |
| B-UI30-01 | 固定源与证据完整性接纳 | 在含 PR #81 的固定树运行公开校验器；核 PR/head/merge、manifest、原 JSON/JSONL 可解析、证据引用存在，记录命令、通过/失败/未执行。不把校验器通过当浏览器、模型或教师语义通过。 |
| B-UI30-02 | 链 A 的 B/C3 来源核对 | 从原记录逐项核 `scope`、snapshot/file/Build、generation、targetVersions、basis、contentHash、Message→Action→Delivery→Receipt 关联；确认调用前后及投递/回执当前性没有把新草稿或新 Session 改贴旧回答。 |
| B-UI30-03 | 链 B 的 current/stale 核对 | 核 Session/Operation/revision/sequence/time/resultHash 与最终 `learner_state_revised → stale`；确认只有 received、没有 displayed/ack，且重连、旧选择或后续状态不会复活旧 Action。 |
| B-UI30-04 | 回执与陈述口径审计 | 分开列 `generated/succeeded`、`received`、`displayed`、`acknowledged`、`stale/failed`；抽查 UI 真可见条件和明确回应来源。全库 75 个终态 Job、4 次 HTTP 含独立 C 活动，不全归本批；首批两次模型 HTTP 与补证一次板卡求助分列。 |
| B-UI30-05 | 模型故障降级接纳 | 核模型默认关闭后第三个 help 失败且无新增 Message/Action/HTTP，同时编辑、保存、快照和仿真能力仍可用；映射 B4-CORE-03、M-04/05、DL-AC-08、NFR-06，但不把单次场景写成完整故障矩阵或 NFR 全面通过。 |
| B-UI30-06 | 正式教师语义评审材料 | 对链 A 实际展示正文和链 B 实际生成但未展示正文，分别整理完整问题、确切获准事实、模型完整可见正文、引用、模型/prompt/schema/policy 版本、usage/延迟、未知和后续动作。截图或 body hash 不能替代完整正文；若公开包不含正文，只能从获准本机材料/受控记录读取，不得补写或由摘要反推。 |
| B-UI30-07 | 实际审阅者签署语义结论 | 由实际教师或负责人指定的项目推进者逐条填写 `通过 / 有条件通过 / 不通过`、事实忠实性、HDL 技术正确性、提示强度、学生控制权、下一步可执行性及严重问题。Agent 可整理材料和指出疑点，不能自评代签正式教师结论。 |
| B-UI30-08 | 严重问题修复与复验裁决 | 若发现错误因果、过度帮助、私有/过时引用或误导性操作建议，先修 B 根因与确定性回归；不改写历史输出。是否新增 DeepSeek 请求、次数/费用/unknown usage 另获明确授权；没有新授权时只做离线合成验证。 |
| B-UI30-09 | B4 / DL-B 收口映射 | 更新 B 自己的任务记录：链 A 可支持的浏览器 displayed/合成接棒范围、链 B 可支持的 stale 守卫范围、语义审阅结论、故障降级、失败和未执行。HR-DL-02 既有“有条件通过”不因本批自动解除，除非新正文正好覆盖且实际审阅者明确裁定。 |
| B-UI30-10 | 对外回交 | 用固定 commit/PR、环境、精确对象、实际命令、已交/通过/失败/未执行和下一角色格式回复原 Issue；不重复 UI/C 整包，不关闭 #30/#38，不宣布完整 DL-AC/P4/P5/真人或教学效果通过。 |

## 5. 建议执行顺序与停止条件

1. 先切到包含 `ac493342` 的固定树，完成 B-UI30-01；证据不完整或 hash/对象关联冲突时停止相应结论，不进入“默认接纳”。
2. 并行完成 B-UI30-02～05；任何跨 scope、错版本、伪回执或过时复活属于严重工程问题，须先修根因。
3. 工程链可核后完成 B-UI30-06；没有完整模型正文时，正式语义评审保持“材料不足”，不能凭截图标题或工程状态代签。
4. 由实际审阅者完成 B-UI30-07；若有严重语义问题，转 B-UI30-08，处理后再决定是否需要新真实调用。
5. 最后完成 B-UI30-09～10。只有固定证据接纳和正式语义结论均有记录，才能报告“本次 B 接纳完成”；仍不得外推完整应用验收。

## 6. 不属于 B 的重复工作

- 不重跑 C 已交的原 20 项、H3/2800/course_check、节点验收、Build/Session/Trace/停止或完整故障矩阵；发现 B 消费问题时将精确差异交对应主责。
- 不重做 UI 的 `.v`、16 SW、双标签、截图或 DOM 取证，不修改页面/导航/布局；只核 B 需要消费的来源、状态和回执。
- 不把旧模型批次、链 A 的回执或全库计数改贴链 B；不因 PR 合并或校验器通过宣称正式教师审阅完成。
- 不执行真实学生操作，不把开发合成账号的回应记为真人接棒或教学收益。
- 不修改受保护产品/规划基线；需要的汇总保持“待授权维护者汇总”。

## 7. 实际执行、验证与结论

### 7.1 B-UI30-01～10 状态

| 编号 | 实际状态 | 结论与证据 |
| --- | --- | --- |
| B-UI30-01 | **通过** | 在 `4fdf2f0` 运行原 `verify-completion.mjs`，结果 `status=verified`、32 个开关操作、双标签九组对象与 receipts 不变、板卡 basis 匹配、全实例退出；随后 B 专用[校验器](evidence/b-ui30-hdl-20261015/verify-b-handoff.mjs)通过。 |
| B-UI30-02 | **通过** | 链 A 的 scope、v2 code ObjectRef、snapshot、失败 Build、generation、五个 targetVersions、Message→Action→Delivery→Receipt 的 contentHash 全部一致；历史 46/48/50 正确保留，后来作品修订使 Action `stale` 不抹除已显示事实。 |
| B-UI30-03 | **通过** | 链 B 的 snapshot/Build/Session revision3/sequence2/time20000/Operation/原协议 resultHash 全部一致；仅 received 234/237/240，最终 `learner_state_revised → stale`，无 displayed/ack。校验中特别区分 Operation 内层协议 resultHash 与表行 JSON checksum，未把外层摘要误作 B 的来源 hash。 |
| B-UI30-04 | **通过** | generated/succeeded、received、displayed、acknowledged、stale/failed 已分层；原 UI 两次 HTTP200 与 completion 窗口四次 HTTP200 分列，后者含独立 C 活动且无 Job 外键，不全归 UI30。 |
| B-UI30-05 | **通过本次固定工程范围** | budget-off Job `8d88a61e...` 为 failed、模型 Message 0、Action 0；之后 v4 snapshot `f3e8643d...` 存在，final/completion runtime 均 `modelEnabled=false`。只支持本固定降级链，不外推完整故障矩阵或 NFR 全面通过。 |
| B-UI30-06 | **部分完成 / 材料阻塞** | 元数据、确切引用、回执、usage 和审阅判据已整理到[语义审阅单](B_UI30_HDL_SEMANTIC_REVIEW.md)；公开包有意排除完整正文，截图只含片段，不能形成合规的完整语义材料。 |
| B-UI30-07 | **未完成 / 材料与实际审阅者阻塞** | 旧 `Ubuntu` 环境不存在；当前 `Ubuntu-24.04` 没有原 `/opt/xunjie-ui-local`，交接指定 D 盘目录也不存在。未补写正文，未由 Agent 代签。 |
| B-UI30-08 | **未触发代码修复** | 工程接纳未发现跨 scope、错版本、伪回执或过时复活；因完整正文缺失，尚不能排除语义严重问题，也不据此授权新模型调用。 |
| B-UI30-09 | **完成当前可判范围** | 链 A 可支持真实浏览器 displayed/合成回应工程范围，链 B 可支持来源/current/stale 守卫，budget-off 支持固定降级；HR-DL-02 既有“有条件通过”未解除，完整 DL-AC-08/09、P4/P5、真人与教学效果未完成。 |
| B-UI30-10 | **待正式语义结论后发布** | 当前可发布“工程接纳通过、正式语义材料不足”的中间状态；不能发布“B 接纳全部完成”或关闭 #30/#38。未在本轮替用户发布不完整的最终结论。 |

### 7.2 实际命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| `git fetch --all --prune` | HTTPS fork/upstream 成功；同一 fork 的 SSH `origin` 因 publickey 失败，未影响 HTTPS 同步。 |
| `git push fork upstream/main:refs/heads/main` | fork/main 从 `8b41303` 依次纯快进到 `4fdf2f0`、`a1b1235` 与提交 PR 前最新的 `d77c9cc`。 |
| `git merge --no-edit upstream/main` | 当前任务分支普通合并到最新 `d77c9cc`，无冲突、无历史重写；只接纳上游既有 UI 改动。 |
| `node docs/tasks/evidence/ui30-hdl-20261015/verify-completion.mjs` | `verified`；只核公开归档一致性。 |
| `node docs/tasks/evidence/b-ui30-hdl-20261015/verify-b-handoff.mjs` | `verified`；链 A、链 B、budget-off、transport 和 model-off 边界全部通过。 |
| `node tools/a0-review/check.mjs` | 合并最新主线后复跑：129 份文档、1967 条内部链接、`errors=[]`。 |
| `git diff --check` | 通过；原 UI JSON 只出现 Git 的 CRLF 提示，blob hash 与 HEAD 相同，无内容差异。 |

B 专用校验器只读取 JSON/JSONL/截图文件存在性，可在本机 Node `v24.14.1` 安全执行；它不加载教学服务、数据库、SDK 或模型。项目正式教学运行时仍固定 Node `v24.21.0`，本轮没有用错误运行时冒充业务回归。没有启动浏览器/节点/业务宿主，没有读取凭据或模型 key，没有外部 provider 请求，也没有修改 UI/A/C/产品/规划文件。原未跟踪 `.trae/` 保留且不纳入交付。

### 7.3 当前交付判定

B 对固定工程来源、C3 当前性、过时守卫、真实显示/合成回应分层和固定模型故障降级的接纳 **通过**。正式教师语义评审因两个固定 Message 的完整正文及实际审阅者结论缺失而 **未完成**；这是材料/人类判断门禁，不是代码失败。恢复材料后按[审阅单](B_UI30_HDL_SEMANTIC_REVIEW.md)填写；若出现严重语义问题，再进入 B-UI30-08。产品基线及 MVP_SPEC §10 仍为“待授权维护者汇总”。
