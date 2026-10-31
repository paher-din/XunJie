# WP02：固定引用与问题草稿恢复实施与验收记录

日期：2026-10-31（Asia/Shanghai）。对应[固定引用与问题草稿恢复 #152](https://github.com/paher-din/XunJie/issues/152)，方案见[实施方案](specs/wp02-fixed-references-and-question-drafts.md)。本轮在 `codex/wp02` 实施，未新建分支、未合并 `main`。交接实现为 `26f5653`；整合 #154 与审查修复为 `9668bc5`，就绪竞态为 `a0c1c09`，鼠标测试修正为 `d4cbaf4`。随后保留远程大材料校验修复 `37122b4`，最终固定验收版本为 `ca1079f2fdc26a245c9957d1d78a4d7352c6b7ca`；分版本检查范围见末节。本票保持开放。

**范围：** 课程文字/要求与作品代码选取、固定引用（稳定来源对象、不可变内容身份、类型化范围、原文副本）、可靠问题草稿（IndexedDB 与学习数据 owner）、刷新/活动切换恢复、来源变化与定位、跨客户端/双标签分歧、迟到确认、授权与私有隔离、迁移维护恢复。真实发送、模型调用、待发状态机、非文本组件引用和教师交付不在本轮。

## 实施落点

| 层 | 变更 |
| --- | --- |
| 公共契约 | 新增 [`@xunjie/contracts/question-drafts`](../../packages/contracts/src/question-drafts.ts)：版本化草稿视图、同步输入与回执、来源联合（本人作品 / 课程材料 / 课程要求）、`text`/`code` 类型化 UTF-16 半开范围、选中副本与摘要、依据字段；未知来源类型与组件范围被严格拒绝。`courseReferenceTextSourceSchema` 与 `CourseReferenceAuthority` 增加课程来源只读核验 |
| 作品 owner | [`works.registerBasis`](../../packages/learning-space/src/learning-data/works.ts) 在**不推进 head** 的前提下登记选择时的对象、`contentId`、正文与资源引用；内容可早于远端 head。历史内容在文件重命名、替换、删除后仍按原对象与资源保留 |
| 课程 owner | [`referenceText`](../../packages/learning-space/src/courses/index.ts) 每次核验当前成员、课程资格与固定发布，返回开放 UTF-8 文本材料或发布要求；材料摘要/媒体类型与既定发布一致，私有材料统一不可见 |
| 学习数据 owner | 迁移 v4（草稿 head、不可变修订、回执）与 [`createQuestionDrafts`](../../packages/learning-space/src/learning-data/drafts.ts)：按活动稳定 `draftId`、单调版本 CAS、稳定请求身份、原文范围/副本核验、按 `revisionId` 读取历史修订、作品内容保留关系、领域校验；课程选区最终经 owner `verifyReference` 核验，不传整份大材料；不写课程表、不共享可写事务 |
| HTTP | `/api/learning/` 新增 `GET/POST drafts/:activityId`、`GET drafts/:activityId/receipts/:requestId`、`GET drafts/:activityId/revisions/:revisionId`；沿用真实会话/连接身份与预期主体检查。学校客户端代理加入草稿路由和响应 schema 校验 |
| 可靠工作区 | IndexedDB `xunjie-reliable-works-v1` 非破坏升级到 v2，新增 `drafts`/`draftCandidates`；[`ReliableQuestionDraft`](../../apps/web/src/reliable-workspace/draft.ts) 复用 250ms 本机保护、1000ms 网络检查、稳定 pending、迟到确认保护、双标签候选、远端分歧与离开保护。旧作品记录保持可读 |
| 生产页面 | [ActivityReferences](../../apps/web/src/runtime/ActivityReferences.tsx) 把同一活动的要求、开放文本材料与 Monaco 编辑器登记为来源；[DraftReferencesProvider](../../apps/web/src/components/workspace/references/DraftReferences.tsx) 以可靠草稿为唯一可变权威。输入区关闭时“询问 Agent”，打开时新选择直接加入；收起、刷新、活动/空间切换后恢复。发送按钮明确禁用并说明真实 Agent 尚未接入 |
| 维护与恢复 | `validateLearningData` 校验草稿 head/修订/回执、引用范围与副本摘要、作品内容归属、资源引用与正文切片；作品与草稿资源随既有备份/隔离恢复/接管流程保留 |

## 行为与验收对照

| # | 验收行为 | 结果与证据 |
| --- | --- | --- |
| 1 | 两种开合路径与真实来源 | 真实 Chrome：课程文本与要求选中后出现“询问 Agent”，点击打开并带入引用；对话打开后新选择直接加入。代码使用真实 Monaco 全选。`questionDrafts.spec.ts` 前两项 |
| 2 | 自动保护与发送分离 | 选择、问题输入、添加/移除均自动写入本机并同步到草稿接口；发送按钮禁用，Enter 不发送，也无模型/接收业务端点。浏览器测试检查服务端草稿修订与引用；没有业务发送回执 |
| 3 | 稳定对象/内容/范围/副本 | 生产接口读回 `source`（作品 `objectId/contentId`，课程 `courseId/taskId/releaseId/contentDigest/materialId/materialSha256`）、UTF-16 范围、`copy` 与 `copyDigest`；改路径/重命名不改身份。真实 PG 测试与 Chrome 均核对 |
| 4 | 顺序、去重与移除 | 多引用按加入顺序持久化；相同对象/内容/范围重复通知不新增；移除后焦点/无变化通知不复活，新的明确选择可重新加入。课程 Chrome 流程覆盖 |
| 5 | 修改、重命名、删除、换版与撤权 | 代码选中 A 后编辑为 B：原副本不变，定位报告来源已改变，新选择形成第二条引用；重命名后仍按原对象定位；删除文件后草稿恢复原副本。课程测试覆盖删除作品后重发草稿、课程撤权拒绝读取/写入、重新授权后历史草稿恢复 |
| 6 | 真正持久与隔离 | 收起再开、刷新、返回列表再重开均恢复问题与顺序；草稿按空间/主体/活动隔离；另一主体读取/写入返回 404。数据来自真实 IndexedDB 与 PostgreSQL |
| 7 | 故障与竞争 | 本机配额拒绝时保留内存并显示异常，恢复后自动写回；双标签竞争保留双方草稿并显示比较选择；另一客户端推进服务端后原 pending 返回 409，页面展示双方完整草稿；迟到确认只结清对应修订，之后输入形成下一修订。服务端存储冲突未推进修订基线时保留同一 pending 重试；作品内容并发登记使用冲突安全插入。Chrome 覆盖上述四项 |
| 8 | 可固定修订 | 每次变化生成 `revisionId` 与内容摘要；历史 `revisionId` 可按活动读取且不变。PG 测试在编辑、删除和多修订后读取首版；冲突测试读取另一客户端修订 |
| 9 | 来源、权限与私有隔离 | 后端只接受已登记的活动/发布/材料/作品内容，校验完整原文范围与副本；密码框、问题框和任意 DOM 不注册为来源；教师私有材料不出现在草稿响应、错误或读取中，直接引用返回 404；跨活动作品在另一活动返回 404。前端排除规则沿用既有适配器回归 |
| 10 | 保留与维护恢复 | 作品内容选择时登记不可变依据与资源引用；删除文件、课程换版/撤权不回收仍被历史修订使用的副本。CLI 正式备份、隔离恢复与接管后，草稿问题、顺序、副本、历史修订和回执可读；`validateLearningData` 拒绝损坏 head/修订/回执与资源切片 |
| 11 | 公开扩展边界 | 来源与范围是版本化判别联合；未知类型与未知组件范围明确拒绝。本轮只交付普通文本、课程要求和代码，未预建波形、图表、虚拟板或隔离页面宿主，不宣称这些已完成 |
| 12 | 原文与输入交互 | 既有选区块、工具条、Monaco 原文映射、CRLF/emoji/BOM、焦点、滚动、查找/替换排除与中文输入法回归 12/12；生产草稿输入区保持中文组合输入和 Enter 不发送。生产环境未另做物理系统输入法复测 |
| 13 | 平台与生产链路 | Windows 11 x64：真实 Chrome（安装版）、生产宿主、真实 PostgreSQL 18.6、真实文件资源通过课程与代码流程；既有作品编辑器 15/15 与选区引用 12/12 回归通过。Apple Silicon Mac 本轮未执行，交接见下 |

## 工程验证

环境：Windows 11 x64（10.0.26200），Node v24.21.0，PostgreSQL 18.6（本机固定分发），安装版 Google Chrome 156.0.8078.76，有头运行。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（contracts、storage、learning-space、server、product-runtime、web、local-runtime） |
| 构建 | `npm run build` | 通过 |
| 公共契约浏览器检查 | `npm run check:contracts:browser` | 9 个公开导出 browser-safe（新增 `question-drafts`） |
| Web 单元测试 | `npm test -w @xunjie/web` | 58 个文件、688 项通过 |
| 课程/草稿真实 PG | `node --test --test-concurrency=1 apps/server/tests/course-releases.runtime.test.mjs` | 5/5 通过：既有课程 4 项 + 草稿固定引用/删除/撤权/隔离 |
| 学校客户端代理 | `node --test --test-concurrency=1 packages/product-runtime/test/school-client.test.mjs` | 2/2 通过：课程与草稿路由转发、畸形响应、伪造路由 |
| 学习入口回归 | `node --test --test-concurrency=1 apps/server/tests/learning-entry.runtime.test.mjs` | 8/8 通过 |
| CLI 备份恢复 | `node --test --test-concurrency=1 packages/product-runtime/test/learning-cli.runtime.test.mjs` | 1/1 通过：草稿修订/引用副本/历史修订随正式备份、隔离恢复与接管保留 |
| 旧 schema 升级 | 同上课程套件中的 `existing owners upgrade...` | 学习数据 v2→v4、空间/课程升级后原自主活动、原作品可读，新草稿 schema 通过领域校验 |
| 文档链接 | `npm run check:docs` | 160 个 Markdown、1178 个本地目标，0 失败 |
| 草稿 Chrome 验收 | `npx playwright test e2e/questionDrafts.spec.ts`（真实 Chrome channel、生产宿主、原生 PostgreSQL） | 6/6 通过：课程文字/要求、空间与活动切换、代码 A→B/重命名/删除、v1→v2 IndexedDB、配额拒绝重试、双标签竞争、跨客户端冲突与迟到确认 |
| 既有作品 Chrome 回归 | `npx playwright test e2e/worksEditor.spec.ts` | 15/15 通过（一次既有课程目录路由 teardown 抖动后复跑通过） |
| 既有选区引用回归 | `npx playwright test e2e/workspaceReferences.spec.ts` | 12/12 通过 |
| 全量本地套件 | `npm test` | 退出码 1；Web 58 文件/688 项全通过；server 640/661（2 项既有账户/路径校验失败），product-runtime 92/122（25 项既有连接/恢复/接管/远程环境与 symlink 失败），storage 12/14（1 项既有 symlink 失败）。失败均位于本票未修改的 Windows 环境项，新增/修改的草稿、课程、学校代理与 Web 测试均通过；完整输出见本机 `/tmp/xj-full-test.log`，未提交 |

## 浏览器验收

真实 Chrome 通过生产宿主、真实 PostgreSQL 与真实文件资源执行；证据见 [Windows Chrome 结果](evidence/wp02-draft-windows-chrome.json)。

1. 课程开放材料、任务要求与 Monaco 代码混合选取；“询问 Agent”在输入区关闭时出现，打开时新选择直接加入；重复选取去重，移除后可重新加入。
2. 问题与引用在收起/打开、刷新、返回活动列表再重开、切换个人/学校空间之后恢复；服务端读回来源、范围、副本和摘要；发送按钮禁用并提示真实 Agent 尚未接入。
3. 代码选中后重命名仍可定位原对象；编辑后原引用副本不变且定位说明来源变化；新选择形成第二条引用；删除文件并刷新后副本仍恢复。
4. 本机 IndexedDB 配额拒绝时保留输入并显示异常，解除后自动同步。
5. 双标签页同时编辑保留双方草稿，显示比较与明确选择。
6. 另一客户端推进草稿后，本页 pending 冲突显示双方完整内容；选择本页后形成新修订，另一版本仍可按 `revisionId` 读取；被延迟的确认只结清第一版，确认期间输入的第二版随后独立同步。
7. 旧 v1 可靠工作区数据库升级到 v2，原作品仍可打开，新增草稿 store 存在且未清空作品。

截图：[课程文字/要求草稿](evidence/wp02-draft-chrome-course.png)、[代码固定引用](evidence/wp02-draft-chrome-code.png)、[草稿分歧](evidence/wp02-draft-chrome-conflict.png)。

既有回归：`worksEditor.spec.ts` 15/15、`workspaceReferences.spec.ts` 12/12。作品套件首轮出现过一次既有课程目录路由 teardown 的 `route.fetch: Test ended`，未涉及本票代码；随后同一命令 15/15 通过，记录为既有测试抖动。

## 迁移、维护与恢复

- 学习数据迁移追加连续 v4；不改写既有 v1/v2/v3。升级测试由包含作品的 v2 学习数据升级到当前谱系，保留原活动与原作品。
- 草稿 head、不可变修订、回执、作品内容引用在同一所属事务提交；外部作品登记、课程资格和材料读取在事务前完成。草稿不建立第二个资源库或独立同步引擎。
- 备份/隔离恢复/接管验证覆盖课程、材料、自主活动、作品及草稿修订与引用副本；恢复前 `validateLearningData` 校验草稿 head/修订/回执、摘要、范围、作品归属与资源正文。教师私有材料仍不进入学习数据 owner。
- 草稿同步失败不产生业务发送或模型副作用；发送入口只有禁用状态，没有占位成功回执。

## 未执行、限制与交接

- **Apple Silicon Mac：** 本轮未执行。固定验收提交为 `ca1079f2fdc26a245c9957d1d78a4d7352c6b7ca`；23 项待执行清单、真实命令及证据要求统一登记到 [#155](https://github.com/paher-din/XunJie/issues/155)，涵盖类型检查/构建、课程/草稿 PG、学校代理、本机 owner 混合路径、CLI 恢复、生产 Chrome 和公共接口恢复回归及既有作品/选区回归。登记不代表已通过。
- **物理中文输入法：** 生产草稿输入区沿用既有组合输入判断；本轮 Windows Chrome 自动验收未使用物理系统输入法，Mac 也未复测。
- **全量 `npm test`：** 已执行一次；退出码 1，失败集中在既有 Windows 环境项（连接/恢复/接管、远程环境生命周期、symlink 与路径校验），Web 688 项全通过，本票相关套件全部通过。该次全量运行早于最后两个草稿稳定性修正；最终代码已重跑本票全部定向套件。不能把该退出码写成全量通过；原始日志在本机 `/tmp/xj-full-test.log`，未提交。
- **公开扩展：** 只交付文本、课程要求与代码。非文本组件、PDF/图片/外部页面、真实 Agent 发送、待发意图和接收回执由后续票承接。
- **课程来源范围：** 课程活动草稿当前只接受该活动固定发布中的要求与开放文本材料；不跨课程或跨活动借用来源，也不在发布换版后改读 latest。
- **历史保留策略：** 不新增自动 GC；作品删除、课程换版或活动关闭不提前回收仍被草稿修订引用的副本。

## 收尾审查与 #154 接入（代码 `9668bc5`）

保留远程 #154 的 `4565019` 和本票 `26f5653` 全部提交，整合到同一 `codex/wp02`。草稿在本机学习数据 owner 分流，课程文字经已认证的 `learning.authority/referenceText` 核验；学校直连及学校共享学习数据组合仍走原所属服务。补充混合测试覆盖草稿当前读取、原回执、撤权、独立恢复与历史修订，以及旧命名空间拒绝。

两轴审查发现并修复：

- 草稿暂停清除 interval 后，恢复未重建周期调度；作品/草稿现在复用 `ReliableStateCoordinator` 的初始化、保护互斥、定时调度及退出/恢复生命周期。
- 本机草稿冲突候选未保存未同步引用的完整 `bases`；现在候选与主记录均保存，明确选择/重新加载时恢复，旧保护结果也不抹去等待期间新增的依据。
- 作品删除先确认时，尚未到达的历史引用依据被拒绝；同 owner 的历史登记现在保留 tombstone、不推进作品 head，也不允许同身份复活为当前作品。
- 内容依据操作指纹包含展示名，重命名后新范围引用产生身份冲突；现在以不可变内容核验身份，并兼容重命名前已保存的回执。

两项后端原生回归先分别复现 404/409。两项前端补充回归在原 `26f5653` 的真实草稿公开接口上先复现周期同步不推进、恢复候选无法登记依据；修复后 2/2 通过。补充回归使用生产草稿类、真实 Chrome、IndexedDB 和真实 HTTP/PG，通过公开接口控制暂停和竞争，不能代替六项生产 UI 验收。

## 最终整合验证（验收基点 `d4cbaf4`）

以下结果独立于上文交接阶段记录，汇总见[最终 Windows 证据](evidence/wp02-draft-windows-final.json)。

- 全仓类型检查、构建通过；`a0c1c09` 的 UI 修复后 runtime 重建通过。公共契约 9 个导出 browser-safe；文档全库检查 162 个 Markdown、1193 个本地目标通过（本节新增证据链接另经交付前检查）。Web 单元测试 58 文件、688/688 通过。
- 真实 PostgreSQL 定向组合 **19/19 通过，0 跳过**：课程/草稿 7、学习身份入口 8、混合归属与恢复 1、正式 CLI 恢复 1、学校代理 2。组合含来源删除先确认、重命名后再次引用、原 v2→v4 升级、草稿随并发业务备份/恢复和本机 owner 的历史修订重读。
- 本机 Chrome 有头分批 **38 个不同用例通过**：草稿 8（6 个生产 UI + 2 个公开接口恢复补充）、作品 15、三条部署路径 3、既有选区 12。并非把重复运行累计为新场景。
- 初次整合 Chrome 中，混合套件准备两个原生环境超过 60 秒，失败于 beforeAll 而未进入业务断言；将准备 hook 的有界期限改为 180 秒，业务断言不变，3/3 复跑通过。草稿初始读取慢于材料时，“询问 Agent”提前可点但不能加入引用；延迟真实 GET 的回归先复现，按钮及 Alt+Enter 等待草稿就绪后才可用，草稿套件最终 8/8。
- 原选区套件首次 11/12，鼠标用例稳定复现。DOM 命中与事件诊断确认需要等待可见布局、避开光标覆盖层，并先通过正常编辑器导航折叠旧选区再真实拖选；不改生产选择算法，不直接设置选区，不放宽原文/去重断言。清除临时诊断代码后，完整选区套件最终 12/12。
- 最终 `npm test` **退出码 1，不通过**：checks 27 通过/1 跳过；product-runtime 116/3/5、storage 12/1/1、server 640/2/19（通过/失败/跳过）；Web 688/0。6 项失败涉及两项 source fencing、三项 Windows symlink/路径权限以及 `LOCAL_SOCKET_CONFLICT`，均在本票未改动的用例中；不以未改动推断已证明其全部根因。`connections.test.ts` 断言失败后十余分钟未退出，仅终止该挂起子进程，让其余 workspace 完成；末尾 tools 未到达。本机完整日志 `.verification/152-final-full-test.log` 未提交，不把该运行记作绿色门禁。
- Standards / Spec 最终复审无剩余发现。Mac、生产草稿输入的物理系统中文输入法、教学效果未执行；同机混合进程不代替 #154 实际跨机及 SSH 接管验收。#152 保持开放，PR 保持 OPEN，不合并 main。

## 发布前保留并行修正（`ca1079f`）

普通推送检测到远程新增 `37122b4` 后，未强推或覆盖：将它与本地 `228ab20` 合并，保留全部提交。课程来源现通过 source owner 的 `verifyReference` 校验固定发布、当前资格、UTF-16 范围与选中副本摘要，仅返回严格校验的确认；不再经受限 RPC 传整份大材料。`referenceText` 的原读取接口保留兼容，UTF-16LE 选区摘要与持久 UTF-8 `copyDigest` 分开。

合并后全仓类型检查与 9 项公共契约浏览器导出检查通过；课程/草稿及混合大材料、伪造副本、emoji/CRLF 范围与恢复的原生补验 **2/2 通过**；独立进程 fencing 的 Windows 冷启动期限修正另行 **1/1 通过**。这些是对上文既有场景的定向复跑，不累计为新增业务场景。Standards / Spec 补审无剩余发现。

此次后端并行修正后未重跑全部 19 项、38 项 Chrome 和全量 npm test；上文的完整结果保留原验收阶段，不冒充在 `ca1079f` 全部重新执行。最终 Mac 交接使用包含此修正与鼠标测试修正的固定 `ca1079f`，所有 Mac 项仍待执行。
