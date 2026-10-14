# I0 A/C：UI交接与指定评论处理

日期：2026-10-14（Asia/Shanghai）；执行：A/C技术核对与C交付。来源：[UI A/C交接§3–4](I0-UI_AC_HANDOFF_20261014.md)、[#30指定评论6169702024](https://github.com/paher-din/XunJie/issues/30#issuecomment-6169702024)。本轮负责人明确要求处理两者中的A/C任务；不接管UI浏览器操作，不重做已交模块。

## 1. 依据、范围与当前源

已读README/AGENTS；PRD §4.2–4.5/PRD-03/04/09/10；MVP_SPEC M-03/04/10、状态与AC-03/04/06/10/12、DL-AC-01–09；TECH_DESIGN §4.3/7.4/8.1–8.5；TEAM §2及P3–P5；I0客户端§7–8、IMPORT_SOURCE §1/4–5；UI上述交接/PR69核对、UI30记录及HDL操作表、C已有主线/运行回执。产品与MVP§10汇总待授权维护者，保护文档只读。

独立工作树原c303346正常fetch/merge `main@8b4130374289b71d737abe12ed4fc5e58adf55c5`（已含PR68/70），实际merge `20acbf55c0251681b488b6956dabd351101dfc10`。无冲突，保留本人事后记录与UI成果；apps/**相对已验证87edd51零差异，不重复宿主/节点全套测试或重部署相同应用字节。根工作区无关README/product/planning/G3/C证据差异不动。

可写：本记录、本轮去敏证据/复现脚本/候选补丁；必要本人交接状态补正。只读原UI作者记录与保护基线。本轮不改变共享版本语义；UI交接明确要求H-05先给原反例/生命周期和控制CAS影响/修复建议，经负责人确认后再实施。本任务先把建议做成可复现、可审查的候选：生产files.ts只读，隔离副本移除每次sync的额外attemptRevision递增，保留ready→active生命周期递增、workspace/document CAS、所有权限/阶段/过程开关/幂等守卫。不把候选或测试通过记为批准实现，不改schema/配置/秘密/节点，不消费旧模型预算。

## 2. 顺序与验收

1. 核固定UI评论的保存/快照/3次Run/Job/取消与已交H状态，原证据保留来源；用现有获准库只读确认原对象/当前服务源及健康，不能代做新学生操作。
2. H-05核syncFiles/activate、snapshot/control、C run/help、H4/C3当前性、UI ACK后GET两个revision；复现ready首保存、active/paused/分配暂停更新、回收/恢复、同正文新批次/同键重放和旧控制版本的差异。
3. 候选只在新隔离源副本试验，受影响作品/控制/快照/Run/提交、C求助/H4当前性验证；保持原失败、跳过和真实外部请求0。明确原行为变化/兼容范围和无需schema/回填旧数字。
4. 公开回交原#30评论，H-05建议/准确待决策与已完成现场接纳分列；HDL已有包直接引用、不重制接口/不等待后置H3。现场3444/B跨机通路或新模型预算若需准确批准，保留为独立条件，不擅改原reader/信任。

H-05建议方案：恢复TECH §4.3原含义。ready首次合法活动仍attemptRevision+1；active/paused普通文件批次仅workspaceRevision+1与文件documentVersion+1。旧控制CAS在作品保存后仍有效，但真的pause/capture/route/提交/帮助替换等控制变化仍使旧CAS冲突。旧作品CAS照常409；已确认运行只指旧snapshot不随新正文变，代码求助以原对象文件版本/hash守卫，HDL求助以冻结workspaceRevision/Build/Session/Operation守卫。保留实存计数，不减旧版本、不迁移历史，不新增或改HTTP字段/错误码。最终依据与候选验证后再请求负责人对该共享语义修复确认。

## 3. 实际核对与结果

待本轮复现、隔离候选验证与只读现场结果填写。

最初候选只移除files.ts一行：纯计划满足两个版本分离，但HTTP首sync返回409。根因 `server/db/records-adapter.ts::saveAttempt` 只允许完整不变或attemptRevision+1，连workspace-only也拒绝。原失败保留；最小完整候选因此包含两处：files.ts移除普通保存额外递增，records-adapter.ts只允许attemptRevision不变/恰好workspaceRevision+1且其余Attempt字段逐字一致的保存。相同版本的状态/epoch/capture/route变化或作品跳号仍拒绝，真实控制更新仍+1。该持久化规则属于共享语义修复提案，生产源码仍只读、待负责人确认。

### 3.1 H-05实际反例与候选

原main/运行源文件计划：ready首次保存1→2并active，正常active更新2→3、workspace1→2；paused和分配暂停下更新也增加控制版本。同正文新批次仍增加两者；同键重放不增加。候选：ready首次行为保持，active/paused/分配暂停更新只workspace+1、file version+1；回收/恢复只作品/文件版本增加，控制CAS不随文件变化。以保存前控制revision=2发pause，原HTTP409、候选HTTP200后revision3/epoch1；真正控制变化后的旧版本、旧workspace/file版本仍409。

[复现脚本](evidence/i0-ac-ui-response-20261014/reproduce-h05.mjs)在baseline/candidate各10场景通过；含正常HTTP/SQLite原ACK、重放、旧CAS、6种越过同控制版本保存守卫的字段变更拒绝/事务回滚。候选类型/构建通过。受影响联合113项首轮106通过/2失败/5受控真实门禁跳过；两失败是integration.test.ts把位置控制写成revision5、capture恢复写成revision4（沿每次save递增旧假设）。候选补丁改为读权威head，并独立断言控制版本应为2/3，不取消断言；该8项文件补验7通过/0失败/1受控真实节点跳过。其余已通过项不重复、不合计成新的全量通过数。候选只在受控新副本试验，未改main/运行源码。

追加两个C求助反例：控制版本保持不变时，模型等待期间选中代码被修改，原Job及候选Action仍stale，旧正文不能作当前；新增无关文件，原确切代码求助保持succeeded/pending。使用SyntheticProvider外部请求0；原H4 workspace冻结/信号序列/停止/C3投递回执反例在联合回归通过。额外脚本初次SyntheticProvider返回类型用错、以及错误期待“过时Action必须不入库”两次失败保留；改成原provider信封和允许保留stale历史、检查当前资格，不改产品或关闭检查。

### 3.2 A/C调用方与兼容建议

| 接缝 | 候选影响与保持 |
| --- | --- |
| sync/ACK/snapshot | HTTP输入/响应不变，workspace/document CAS、逐批serverSeq/hash和事务/双键重放不变；首保存ready→active是生命周期变化，仍控制+1 |
| pause/capture/reminder/route/提交/reopen/教师撤权 | 真控制变化仍attemptRevision+1/适用epoch/许可守卫；文件保存不再制造无关控制冲突，期间真控制变化依然409 |
| C Run | 原快照/参数/原Job与运行权限、阶段/epoch绑定保持；已运行旧snapshot不被新正文污染，旧文件编辑不应取消固定Run |
| C Help/C3 | 接纳使用当前控制CAS；已接纳输出按选中文件version/hash、固定对象/政策/阶段/epoch/当前性复核，不能以控制版本保持就放过变更的目标；无关文件变化不机械废弃帮助 |
| HDL Build/Session/H4 | Build绑定确切snapshot、会话版本/sequence与停止保持；H4冻结workspaceRevision并独立检查Build/Session/Operation，因此新保存仍使旧HDL帮助失去当前资格 |
| UI | 原confirmationWorkspace ACK后GET head分别读取两个revision，control/run/help不从保存次数或编辑器版本推算；UI无需新字段或页面，原双watermark/未知同键重试可继续使用 |
| 持久化与历史 | 原实存revision保留，不递减、不回填、不迁移旧库/回执；只新增后续workspace-only计划的精确接纳，未知旧命令仍用旧身份/键/请求核原ACK |

推荐按现有TECH §4.3修实现，不改基线以保留错误耦合。完整候选可审查：[三文件补丁](evidence/i0-ac-ui-response-20261014/h05-candidate.patch)，生产变更限files.ts/records-adapter.ts及integration.test.ts两处旧版本假设；`git apply --check`通过。负责人确认后落实必要版本分离回归测试、对应原调用方验证并交实际代码PR，运行换版另沿现有环境窗口，不因候选通过自动部署。

## 4. 指定评论接纳与现有环境

已正常接收含PR68/70的main，生产apps/**相对已验证87edd51零差异；不用重建runner/重核全套H-04/H-06。指定评论的原10Run/Job/snapshot/请求回执关系、v8两文件正文/manifest摘要与现有24表只读一致，活跃/未知0；没有新保存/Run/模型。PR69的143资源与C重建正式dist逐路径/bytes/hash一致（ZIP容器摘要不同来自打包方式，不据此定应用字节不一致）。strictTLS两端live/ready200、匿名Session401，两个原批准unit active。UI现有C浏览器H状态保持原b7e73c5/805c76a执行版本，不改贴最新main。

下一步C按已有24表应用换版授权接纳已验证87edd51正常宿主/新dist：先确认该原Attempt无未结Run/Job，以新本人unit正常停止/启动原24表进程，保留原库/对象/配置/TLS/签名/generation/节点、旧f761argv和严格同源身份，不操作Robert本机gateway。H-05候选不入新宿主；换版只接此前已合main代码。3444已在87edd51、apps字节无变化，保持现有unit不重复换版。切后核strictTLS/no-store/current consumers、10Run/v8/143字节，模型预算关闭。不部署H3、不迁移数据库、不新增受控凭据/信任。

## 5. 负责人批准与正式实现

2026-10-14负责人对本轮确切提案答复：“批准按现有基线修复 H-05，并执行必要的回归测试。”批准范围为三文件候选与必要版本分离/持久化信任边界回归；不修改保护基线、schema或历史计数。可写正式源码：`apps/teaching/server/workspace/files.ts`、`server/db/records-adapter.ts`、`server/workspace/integration.test.ts`；原C/B/H4调用方只有核查验证无新契约。此处正式落地取代前文候选待决状态；原候选失败/审批顺序保留。

正式实施先应用同字节候选补丁，再在integration.test补正常HTTP编辑/重放/旧作品CAS/保存前控制CAS/paused更新、以及同控制版本非法持久化变化与回滚断言；原计划与生产源码一致后执行类型/构建、受影响回归。使用项目code-review两轴复核正式写集，并将仅本轮改动交小PR；不把已经关闭的PR56重新用作新实现合并。现场两个正常宿主仍87edd51，H-05未换版，是否后续换至正式新源码按实际交付/原窗口单列。

### 5.1 正式验证

正式三文件已落地；新增两个持久HTTP/SQLite测试分别验证文件保存不改变控制CAS、真pause/resume及旧作品/控制冲突，以及六种同控制版本非法字段更新拒绝并保持事务前head。两处旧硬编码测试现在既读权威版本，又独立断言2/3，不把旧错误假设改成宽松断言。

Node24.21原lock/依赖下 `npm run typecheck`、`npm run build`通过；`node --test server/workspace/{workspace,integration,runs,submissions,limited-check,job-composition}.test.ts server/tutoring/test/student-help.test.ts tests/dl-a-app.test.ts tests/dl-a-hdl-help.test.ts server/app/i0-readiness.test.ts server/app/i0-tutoring.test.ts` 实际115项：110通过、0失败/取消、5受控真实节点/模型门禁跳过。与候选113项分轮记，不累计。C3/H4、暂停撤权、固定Run、提交/重开/ACK、宿主readiness/消费者原反例保持。

正式代码审查与PR回执待结果填写；生产主机仍87edd51，未把隔离候选/源码修复计现场行为变更。无新外部模型请求/真实执行或学生操作。

### 5.2 24表现场接纳实际完成

原全库未结Job=0后，正常停止旧 `xunjie-i0-entry-pr56-f761dcd-20261014.service`，启动 `xunjie-i0-entry-main-87edd51-20261014.service`；正常createI0App/原config/24表库/账号/TLS/签名/SSH/generation全部保留，新源码/UI来自已验证87edd51。严格TLS live/ready/root200，ready no-store/requestId一致；同origin3443，不改Robert网关。3444仍原35表 `xunjie-dla-ui-main-87edd51-20261014.service`。H-05修复未部署至任何现场unit。

切后再只读核指定评论：10个Run/Job/snapshot/requestReceiptId/hash/status关系保留，v8两文件/documentVersion/正文hash/manifest正确，活跃或未知0；两入口live/ready200、匿名Session401。新3443的137可服务资源严格TLS/HTTP bytes/hash一致，6JSON/OFL按原MIME拒绝400；143文件清单与UI PR69逐文件一致。ZIP8e6a52a…与UI722e5d4…容器字节不同，但展开路径/bytes/hash逐项相同，不能要求重造源码或声称两份ZIP hash相同。新包/原受控SFTP领取见 [主线运行回执](DLA_PR56_REVIEW_MERGE_UI_20261014.md#62-3444当前正常宿主与正式ui)。

停止3443：`wsl -d Ubuntu -u root -- systemctl stop xunjie-i0-entry-main-87edd51-20261014.service`；回退先停新unit，再按 [现场保留旧argv](evidence/i0-ac-ui-response-20261014/c24-current-runtime.json)启动原f761dcd，不改库/代际或重放旧Job。旧unit inactive不是SSH断连/首次宿主未修；工具旧probe target应由UI在本人现有工具范围确认当前unit，不让C改Robert机器工具。秘密/信任、3444学生B通路、新模型轮次维持准确许可边界，现有H4/UI接线不等H3。
