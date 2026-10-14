# I0-UI：幂等、键盘、冷启动与契约补验

日期：2026-10-14（Asia/Shanghai）。主责：UI / Robert；实施：当前 Agent。状态：获准工程补验完成，已随PR #69合main；正式产物冻结见 §7，后续SSH只读核查/A-C交接见 §8；本轮未新增真实C1浏览器运行。对应[剩余清单](https://github.com/paher-din/XunJie/blob/33a68baba5005c9a6433ed2bf9c99f01d89345b6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md) UI-PREP-01/03/05/06，另准备已有 H-04/H-06 的真实节点浏览器入口。

## 1. 依据与授权

Robert明确要求“开始做01/03/05/06，继续在i0/ui-frontend分支推进，同时准备真实节点联调入口”。工程基线为PR #66 merge `5c8c60ec93e00bc1782a534a88b696ae98c76c37`；原分支`i0/ui-frontend`，原未跟踪`.zcodeignore`保留。前轮已授权、尚未提交的清单更新属于本轮前置事实，不覆盖或撤销。

已读README、PRD §4.2～4.4/5、MVP_SPEC M-03/04/10、§4～6、TECH_DESIGN §4.3/4.4/5/5.1/7.4/7.5/8.1/8.2；TEAM §9 I1/I2；I0_UI_SPEC Implementation/Testing/Further Notes、I0_UI_CLIENT_CONTRACT §2～8、I0_UI_GLOSSARY、设计导入ADR、IMPORT_SOURCE许可/同步边界、学生README以及会话/保存/运行和编辑器补验记录。适用M-03/10、AC-03/04/06/12、NFR-05前端部分；不计整项完整验收。

## 2. 写集与边界

可写：本记录及本任务`evidence/i0-ui-prep-closeout/`公开合成摘要、已明确授权的清单及README必要导航/运行说明；`apps/student/e2e`本批独立spec与必要helper；`apps/student/tools`独立冷启动采样工具；已批准页面/工作区/组件中由新反例证明必要的窄修复。保持原路由、布局、视觉、框架、客户端和IndexedDB，不重开02原文历史修复。

只读：产品/规划/参考/所有AGENTS及其他作者任务、正常A/B/C实现与契约、schema、依赖/lockfile、真实配置/凭据/CI。UI-PREP-06发现差异写当前任务，不代维护者改基线/后台。节点入口准备只整理交付版本、既有深链/操作、固定材料与窗口/信任/账号条件；不启动或改PAHER、分发秘密、导入信任或触发节点/模型。

## 3. 实施与判据

本批已确认测试边界是学生页面真实操作与公开HTTP响应；已批准合成开发fixture仅供隔离工程验证。沿用原harness，不引入新依赖/新业务接口。原命令及本机保护可读作补充证据，主断言以页面和公开响应为准，不在生产实现增加测试入口。

| 项目 | 当前安排 | 完成判据 |
| --- | --- | --- |
| UI-PREP-01 | 核已有覆盖后补异正文同键冲突浏览器反例 | 原请求保留，草稿不丢；409明确显示，不自动换键/重写/重复动作；明确比较/选择后才发新命令 |
| UI-PREP-03 | 补连续键盘操作与焦点返回 | 新建/文件切换/保存/比较/冲突/运行/停止/返回实际可操作；关闭浮层回到有意义的原入口，编辑内容与来源保留 |
| UI-PREP-05 | 独立新缓存冷启动，保留原Vite配置及两mode隔离 | 首次预优化/懒加载无504；启动、退出、端口释放有原始计时/错误摘要；不复用已有进程或删除共享缓存 |
| UI-PREP-06 | 对当前main公开输入/信封/版本/错误/裁剪做集中核对 | 按端点列客户端与正常服务实现及差异、影响/归属；既有H-05差异保留，不改规格迁就实现 |
| 真实节点入口准备 | 接收PR #64/#66与C固定材料，整理可执行入口 | 明确前端版本/正常登录/授权深链/就绪与原运行操作，逐项列已具备、现场待核和责任；无需重索已交材料 |

并行仅分配独立文件：01与03各独立spec，06只读输出；主Agent统一浏览器/冷启动进程与共享文件修复。发现反例先保留失败，再修必要根因，不关闭检查或增加retry迁就结果。

## 4. 验证、失败与交付记录

开工核查：分支/HEAD符合上述基线；仅前轮清单修改与原`.zcodeignore`。Windows Node24.15.0、现有Chrome/Playwright/Vite沿原lock，未安装或升级。后续在本节记录实际命令、环境、结果、失败和未执行。

本批只获实施/验证授权，尚未推送或新建/合并PR；真实C1现场、供应商/人工语义、真人、完整AC/NFR均不由准备证据替代。产品基线及MVP_SPEC §10：待授权维护者汇总。

### 4.1 新反例与必要修复

- **01：** [幂等冲突浏览器专项](../../apps/student/e2e/idempotencyConflict.spec.ts)通过正常公开POST让另一客户端以同键异正文占位，原请求随后由同一authority真实返回409。核在途较新草稿、原key/body及拒绝事实；刷新/重读/只读比较均不补写；学生明确保留后新键/当前版本只保存一次，同fileId不重复创建。首跑Chrome 1/1通过（7.5秒用例/12.0秒批次），无需改业务实现。
- **03：** [连续键盘专项](../../apps/student/e2e/keyboardWorkflow.spec.ts)除初始焦点定位外，使用真实Tab/Shift+Tab、Enter/Space/Escape及Monaco已有Ctrl+M切换Tab移焦。首跑在文件菜单Escape返回失败（14.5秒）；[FileStrip](../../apps/student/src/components/workspace/FileStrip.tsx)恢复原文件入口焦点。二跑在只读比较返回失败（14.4秒）；[页面](../../apps/student/src/pages/PrepWorkspacePage.tsx)在同一上下文关闭比较/运行视图后恢复编辑焦点，[编辑器](../../apps/student/src/components/workspace/CodeEditorHost.tsx)在模型异步挂载时保留同workspace/file的焦点请求，恢复原视图后再应用，不改正文/undo/选区。三跑暴露测试Enter打开菜单后尚未等挂载即按Tab，补可见等待且仍断言唯一Tab到首文件（14.4秒失败）；四跑在取消后前向巡航找结果读取入口失败（19.6秒），改从该操作位置以Shift+Tab回到前一个读取控件，不使用focus绕过。修复后的完整键盘流程通过，公开版本冲突/明确选择、新快照、原Run取消/确认、返回继续编辑及零隐式写全部保持。
- **06展示层：** 源码审计发现辅导events/history/help的异常直接进入学生提示。[故障浏览器专项](../../apps/student/e2e/tutoringFailure.spec.ts)以正常服务固定公开503回放，首红完整流程到末尾，准确暴露三处共15项HTTP路径/状态/错误码/英文恢复信息（4.1秒）。[展示映射](../../apps/student/src/workspace/tutoringNotice.ts)、[辅导工作区](../../apps/student/src/workspace/tutoringWorkspace.ts)和[原辅导组件](../../apps/student/src/components/workspace/TutoringPane.tsx)只收口学生提示，保留命令原error、原key/body/状态和原诊断；区分结果未知、服务未接纳、已确认后待读，不改取消/权限/CAS或重试决策。[HTTP客户端](../../apps/student/src/workspace/http.ts)只纠正x-request-id陈旧注释，仍仅采信正文信封。

03/06修复后的两项Chrome组合2/2通过（13.8秒）：键盘9.0秒、辅导故障3.8秒。此前失败及测试时序调整保留，不以增加retry或放宽焦点/零写断言关闭。

### 4.2 兼容复验与冷启动

浏览器环境为现有Chrome155、两个worker、retries=0；CI新启prep/real/重启端口5781/5782/5783，真实服务专项使用教学锁定Node24.21.0。命令在`apps/student`执行；机器运行时引用仅留本机，不写仓库配置：

```sh
npm run typecheck
npm test
npm run build
node node_modules/@playwright/test/cli.js test idempotencyConflict.spec.ts keyboardWorkflow.spec.ts tutoringFailure.spec.ts compare.spec.ts fileHistory.spec.ts editor.spec.ts editorProtection.spec.ts tutoringReturn.spec.ts tutoringHelpStop.spec.ts tutoringHistory.spec.ts tutoringMessages.spec.ts tutoringControls.spec.ts runControl.spec.ts sessionService.spec.ts tutoringService.spec.ts --workers=2 --max-failures=3 --reporter=json
node node_modules/@playwright/test/cli.js test idempotencyConflict.spec.ts keyboardWorkflow.spec.ts tutoringFailure.spec.ts tutoringHelpStop.spec.ts tutoringHistory.spec.ts tutoringMessages.spec.ts tutoringReturn.spec.ts sessionService.spec.ts tutoringService.spec.ts --workers=2 --max-failures=3 --reporter=json
node node_modules/@playwright/test/cli.js test tutoringMessages.spec.ts tutoringFailure.spec.ts --workers=2 --max-failures=2 --reporter=json
node tools/sample-cold-start.mjs --samples 2 --port-base 5791 --output ../../docs/tasks/evidence/i0-ui-prep-closeout/cold-start-delivery.json
```

90项兼容组合因三个辅导展示断言失败提前停止，另一个返回用例中断，未执行项不计通过；新01/03专项及编辑器/比较/文件历史/运行/控制相关检查已通过。故障分别为预算提示丢失具体原因、401技术码显示断言、存储中止提示断言；收口学生提示后，改断言为中文原因，仍核真实429/401公开响应或实际IndexedDB事务中止，以及原命令/状态/草稿/零隐式写。

随后剩余及受影响44项复验43通过/1失败（177.9秒，无skip/flaky），唯一失败为正文冲突提示过于笼统；恢复中文“正文冲突/原内容保留/重新读取”说明，并保留原正文和冲突诊断。最终受影响消息19项与故障1项共20/20通过（101.8秒，无skip/flaky），[分轮摘要与原JSON摘要指纹](evidence/i0-ui-prep-closeout/browser-rounds.json)可核。这20项不与44项重复累计，不声称一次90/90；原失败轮次和未执行范围保留。实际HTTPS/SQLite/正常消费者的4项Session及1项辅导服务专项在44项批次通过，使用合成账号/离线provider，不计真实C1或模型验收。

最终类型检查通过，34文件464/464单元通过。构建及最终冷启动结果在 §7 冻结前再次核对。[初次采样](evidence/i0-ui-prep-closeout/cold-start.json)、[清理路径修订后采样](evidence/i0-ui-prep-closeout/cold-start-final.json)各为prep/real每mode两个独立缓存；后者prep启动159/142ms、加载3465/3492ms，real启动139/137ms、加载2303/2315ms。无本机资源HTTP错误、无504；各worker退出0、端口释放、仅本轮缓存清除。real缺后台的两个API404按预期单列，不当依赖预优化失败。最终源码采样见[交付采样](evidence/i0-ui-prep-closeout/cold-start-delivery.json)。启动计时为Vite createServer/listen，不含安装或模块import，不计NFR时限。

[独立采样工具](../../apps/student/tools/sample-cold-start.mjs)保留正常Vite配置/插件/依赖图，两mode每次新缓存，拒绝占用端口和覆盖输出。结束顺序为关闭浏览器/worker、确认退出及端口释放，再按realpath限定清理自有缓存；失败摘要不因清理错误被覆盖。清理故障路径经独立静态复核，本轮未故障注入，不将成功采样冒称所有失败路径实测。

## 5. UI-PREP-06：当前公开契约核对

审计基线main `5c8c60e`；收尾核`origin/main=b7e73c5`的PR #67仅新增入口工具、证据及导航，未变学生生产源码/正常A-B-C API/schema，下表仍适用。下表是源码核对，不计新增服务端实测。正常A/B/C实现只读；准备fixture不能作为其正确性证据。

| 端点组 | 客户端/服务端核对 | 状态 |
| --- | --- | --- |
| sessions/session/logout | [客户端](../../apps/student/src/workspace/session.ts)只传loginName/password，从Session取身份/课程/CSRF；[A入口](../../apps/teaching/server/access/app.ts)校验Origin，登录豁免CSRF、其他写带当前token，退出返loggedOut | 一致；不从昵称/账号输入构造角色 |
| Assignment/bootstrap、Activity/Resource | [初始化](../../apps/student/src/workspace/init.ts)读取授权分配、受信代际、固定student活动；[宿主bootstrap](../../apps/teaching/server/app/i0.ts)及[设计授权](../../apps/teaching/server/design/application.ts)限定本人/课程，资料按available/redacted/unavailable公开投影 | 一致；GET不创建Attempt，裁剪不补材料ID/正文 |
| Attempt创建/读取、controls | [冻结命令](../../apps/student/src/workspace/frozenCommand.ts)、[控制](../../apps/student/src/workspace/tutoringControls.ts)发送受信代际/独立权威版本；[工作区入口](../../apps/teaching/server/workspace/application.ts)校验原归属、幂等、状态，读取含limitedCheck；开关不自动激活/复活旧Job | 一致；未增加分配列表、submission/reopen界面或新投影字段 |
| sync / snapshots / snapshot GET | [作品契约](../../apps/student/src/workspace/workspaceContracts.ts)、[确认](../../apps/student/src/workspace/confirmation.ts)保留原字节/当前workspaceRevision、原clientId/seq和回执；服务[输入](../../apps/teaching/server/workspace/inputs.ts)/[文件](../../apps/teaching/server/workspace/files.ts)整批CAS、paused既有active update、终态拒写，公开快照/manifest | HTTP形状一致；attemptRevision基线差异仍未决，见下文 |
| health/ready、runs、Job/cancel | [就绪接线](../../apps/student/src/workspace/useRunWorkspace.ts)绑定当前授权/代际/活动profile；[运行](../../apps/student/src/workspace/runWorkspace.ts)发固定快照/入口/stats-find-top参数、mode=run，核原Job/Run；[宿主](../../apps/teaching/server/app.ts)及工作区入口独立再核权限/profile/ready/代际 | 一致；ready仅status=ready/no-store，不增加指纹字段；取消受理与实际终态分开 |
| Run GET / files / 历史比较 | [Run投影](../../apps/student/src/workspace/runContracts.ts)、[历史](../../apps/student/src/workspace/runHistory.ts)、[产物](../../apps/student/src/workspace/runFiles.ts)对应[正常投影](../../apps/teaching/server/workspace/commands.ts)/[结果文件](../../apps/teaching/server/workspace/result-files.ts) | 一致；GET Run无entryFileId/input，参数仅经回执关联的本机原请求；check裁剪和产物缺项不能补正文/下载 |
| help / events / teaching-records / Action receipts | [辅导客户端](../../apps/student/src/workspace/tutoringWorkspace.ts)、[回执](../../apps/student/src/workspace/tutoringCommand.ts)/[历史](../../apps/student/src/workspace/tutoringHistory.ts)对应[辅导入口](../../apps/teaching/server/tutoring/application.ts)、[记录入口](../../apps/teaching/server/records/application.ts)及[历史投影](../../apps/teaching/server/records/teaching.ts) | 一致；当前ObjectRef/attemptRevision、cursor/clientId/epoch/代际分别核；原问题及已实际displayed/acknowledged历史可读，received不冒充展示 |
| 公共信封/错误 | [HTTP客户端](../../apps/student/src/workspace/http.ts)对应[公共定义](../../apps/teaching/contracts/common/http.ts)：成功requestId/data，失败requestId/error(code/message/retryable/recovery)，15个code一致；重放原JSON字节/键，当前CSRF另取 | 一致；错误技术信息与中文学生结论已分层，不改信封或后台 |

**H-05既有差异：** TECH_DESIGN §4.3规定attemptRevision不随逐次文件编辑增加，当前`workspace/files.ts`每个成功sync同时增加attemptRevision/workspaceRevision。[确认工作区](../../apps/student/src/workspace/confirmationWorkspace.ts)重读公开GET，分别用于控制CAS与作品CAS，不按编辑器版本推算。由A/C及授权维护者裁决/汇总，本批不修改后台或基线。

次要维护发现：`init.ts`部分非法响应提示仍含userId/courses/audience等字段名，保留为后续初始化提示维护项；本批未把这类协议拒绝改成成功。新发现的辅导异常展示已通过真实反例作窄修复，未扩大到新的产品页面或共享契约。

## 6. 真实节点浏览器入口准备

本节保留PR #69前准备时点；后续正式UI30与当前SSH核查见 §8及[A/C交接](I0-UI_AC_HANDOFF_20261014.md)，不把这里旧ready503当此刻状态。

准备对象是已交前端的正常dist与既有C入口，不重新索取H-04/H-06或实现替代宿主。收尾收到已合main的[PR #67](https://github.com/paher-din/XunJie/pull/67)，固定源`b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43`的[完整UI55记录](https://github.com/paher-din/XunJie/blob/b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43/docs/tasks/I0-UI55_BROWSER_ENTRY.md)与公开JSON已核；最新结论按其最后几节，早期“未落实”只保留为历史。该PR新增的入口工具及证据复用，不重写、不重复其已通过专项。

| 对象 | 已具备的可接入口 | 现场待核 / 责任 |
| --- | --- | --- |
| 前端版本 | PR #64/#66与本批窄修复的正常`npm run build`产物，Git源/逐文件bytes/SHA-256/ZIP冻结见 §7 | UI/C用本批固定正常dist接收。旧现场使用`40db96c`加本地H-04候选（后映射至`79f9037`），PAHER应用`9fa76ad`，不能记为本批正式界面已验 |
| 正常登录/任务深链 | `/#/task/<assignmentId>`保留获准任务引用；登录→GET Session→授权bootstrap→固定活动/可见资料，已有Attempt按原引用读取，首次创建仍需明确操作 | UI/C使用已交合成账号与当前授权对象；不把账号密码/CSRF放入文档、URL或持久化 |
| 历史入口候选 | C的[换版后固定公开摘要](https://github.com/paher-din/XunJie/blob/279f2145a33b0526f394f97739a204a1e5f0016c/docs/tasks/evidence/c-entry-readiness-pr59/after-switch.json)提供原Assignment `a2533386-4923-4dee-83bd-2d7a99fb06e9`，候选深链为`https://127.0.0.1:3443/#/task/a2533386-4923-4dee-83bd-2d7a99fb06e9` | 仅有日期的合法候选，必须当次Session/GET重新核对存在、归属、active/版本，不从旧记录断言现在可读 |
| Core操作与已有现场 | PR #67已验真实v7 Core stdout=`new snapshot`、另一v4程序timeout、另一原v4 Job取消至cancelled，以及历史/退出/重新登录；[公开关联投影](https://github.com/paher-din/XunJie/blob/b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43/docs/tasks/evidence/i0-ui55-browser/browser-run-server-projection-20261014.json)保留原ID/快照/代际/回执 | 正式页面仍按明确创建/编辑→保存→冻结→Core→原Job核对执行；首次Attempt、保存/新冻结、缺代际、终态/撤权、第二账号/迟到响应、真实丢ACK/旧代际仍有现场缺口。Report历史为unavailable、新v7缺report.txt，正向公开产物下载未验 |
| H-04与H-06 | 复用[清单§9.2](https://github.com/paher-din/XunJie/blob/33a68baba5005c9a6433ed2bf9c99f01d89345b6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md#92-ac条件材料已交现场进入条件另核)的固定profile/指纹/代际与样例。PR #67获准恢复原146内核后独立C1 readiness退出0，原指纹/代际保留 | PR #67最终HTTP入口检查15通过/1失败，唯一失败为`/health/ready=503`；C1独立ready不能覆盖正式UI的HTTP门禁。UI/C在当次窗口核应用源并接收既有正式宿主/就绪修复，再重读HTTP ready、bootstrap代际/profile；503时正确禁止新Run，不修改客户端放行 |
| 浏览器/信任/账号通道 | PR #67已落实Windows用户h的CurrentUser Root信任，Chrome155无TLS interstitial；固定主机公钥及既有维护身份、SSH14443→PAHER3443转发/HTTPS gateway与指定合成学生的内存口令消费均实测。上游严格CA/pin、Origin/Cookie/CSRF/状态保留 | 复用[入口工具](../../tools/i0-ui55/README.md)和UI55的获准本机持久入口；本轮不重新导入信任、不再索取首次通道方案。后续开窗口确认本机进程归属与启动/停止责任，再接本批正常dist，不将新源码直接记为已部署 |

正式接入顺序：核 §7 固定源/ZIP/manifest → 按UI55原入口核状态及停止责任 → UI/C接收本批dist与现有正式宿主/就绪实现 → 当次Session/授权深链/HTTP ready/profile/代际重读 → 由获准操作者按上表补正式版本的真实C1行为。保持原HTTP门禁，不从旧ready200、C1独立ready或候选已跑通推断可放行。

本轮没有连接PAHER、领取秘密、修改浏览器/系统信任、启动节点、恢复真实库或调用模型。入口准备已完成，现场正式版本和正向下载验收待执行；PR #67的实际浏览器结果保留其旧应用/候选版本。Windows时间观察通过但最终LastSyncError=2、下一次启动未保证146内核等原缺口由原维护者记录，不计本批已修复；真人、模型、完整AC/NFR及教学效果仍分列。

## 7. 正式产物与本地Git交付

最终正常build通过（Vite构建7.98秒）；原大chunk提示保留，未改阈值或配置。最终[四次冷启动](evidence/i0-ui-prep-closeout/cold-start-delivery.json)于2026-10-14 21:32:40～21:32:57执行：prep启动160/140ms、加载3714/3629ms；real启动142/147ms、加载2451/2425ms；全部退出0、端口释放、缓存清除，无504/资源失败。该采样绑定最终生产源码，既有两轮摘要保留历史。

保持`i0/ui-frontend`，本批22文件本地提交`eab1075`；原`.zcodeignore`不暂存。正常接收PR #67后的本地merge源为`4a0bdbbac2565fd21bf940039cbd3d071c15a8a0`，学生树`c957eda726b0b2f00a2b7cd28a060aceac4007d1`。合并唯一冲突是根README两条新增任务导航，保留双方；接收范围只有入口工具/证据/README，没有接纳其本地候选生产源码，学生生产输入与已验证/已构建源码一致。本轮尚未推送、新建PR、合并main或部署。

[正式dist清单](evidence/i0-ui-prep-closeout/student-real-dist-manifest.json)绑定上述已提交源，入口`/assets/index-k3K5KOqC.js`，143文件；本机交接ZIP名`student-real-dist.zip`，根为dist内容，5,632,388 bytes，SHA-256 `722e5d425506e0eb4275a7f5fa6de19c86360b73f57352c230c928de027779cb`。逐个读取ZIP entry对照当前dist，143/143的bytes与SHA-256一致。ZIP仅本机保留供获准窗口接收，未放入Git或部署；公开manifest不含凭据/机器配置。包装发生在生产源码提交/README工具合并后，build发生在此前；清单明确保留该顺序且核所有生产输入未变，不冒称现场接收。

合并后的首次文档静态检查为87份文档/1349内部链接，errors=[]；本轮自身`git diff origin/main --check`通过。合并上游整体空白检查仍失败：PR #67的`browser-run-server-projection-20261014.json`、`paher-time-source-completion-20261014.json`、`ui-dist-manifest-h04-20261014.json`共1471个CRLF trailing-whitespace行，`eab1075→origin/main`与`eab1075→合并源`的报告逐行相同。归UI55原维护者，建议按其证据保真要求核规范化；本轮不改他人原始证据、不关闭检查、不称全仓空白检查通过。

交付记录/manifest追加后的最终静态检查为87份文档/1350内部链接、errors=[]；本轮相对`origin/main`空白检查通过。清单30个表格编号唯一，UI-PREP 9 / UI-REAL 12 / UI-TUTOR 9，原条件保留。最后只追加本记录与manifest的本地文档提交，学生源树不变；精确最终HEAD可由`git rev-parse HEAD`核对，产物仍绑定上述固定源而不是后续文档提交。冷启动自有临时缓存已清理；原失败报告/合成服务审计/正式ZIP属于需保留的验证交接材料。产品基线及MVP_SPEC §10：待授权维护者汇总。

## 8. PR交付与A/C交接授权（2026-10-14）

Robert明确要求先把本批推PR并合入main，然后整理给A、C的交接说明；并指出可使用既有`i0-ui55-connection` SSH工具直接接PAHER。当前授权覆盖本批正常推送/PR/合并、不删除分支，交接记录与现成维护通道的只读核查。先完成Git交付，再按当次状态整理成员事项；源码修复仍遵守原模块边界，保护配置/数据库/秘密/信任/节点冻结对象不从SSH可连接推导变更授权。

本机工具README已有较晚的UI30/PR #68回交：正式main `b7e73c5`静态产物与pr56-pr67服务、HTTP ready200、v8保存/冻结/Core/取消/历史等记录。它是新发现的有日期材料，本轮尚待只读现场核对；不得继续把PR #67旧ready503或“正式UI从未现场验”当当前事实。具体PR回执、现场结果与A/C可执行交接在Git交付后追加，保留 §6～7 原核查时点。

**实际Git回执：** 本批普通推送`i0/ui-frontend`、创建[PR #69](https://github.com/paher-din/XunJie/pull/69)，对确切head `1f7d9f0c2833285a1cfc6bcedf162bf815012e1e`正常merge。2026-10-14 21:58:34合main，merge `87edd51e165b2bab660d73a551864ff8db0bed86`，已回读MERGED/head/merge/time并附当前任务；未删除分支/强推/直接改main。当次GitHub配置检查为空，不称CI通过。同窗口PR #65/#56分别合main，已正常接收；学生目录/生产输入无增量，§7产物树与合并后一致。

**直接维护核查与交接：** Robert提供现成工具目录后，本轮实际SSH认证、本机网关16/16、HTTP ready200、C1既有指纹/代际和原v8快照hash核对通过；旧probe总退出1因旧unit已inactive，当前两个f761dcd应用unit均active/running，不能误报断连。应用固定来源沿C交接，不推断已部署87edd51。[去敏摘要](evidence/i0-ui-prep-closeout/paher-direct-readonly-20261014.json)及[给A/C的共享说明](I0-UI_AC_HANDOFF_20261014.md)分开A的H-05裁决协调、C的技术依据/原运行环境职责和UI直接负责的SSH/本机接收/浏览器工作。本轮没有秘密/配置/库/服务/节点/模型写操作，新ZIP仍未切到gateway。

新main的共享宿主/公开契约增量只读核对未发现C Core客户端不兼容；I0 sync/snapshot/runs/产物和公共错误保持原形状，新增HDL字段/分流不冒充C结果，H-05仍未决。PR56作者70/70及两轴审核复用；因正常宿主实际换版，在main `87edd51`另补`runService/runControlService/runHistoryService/sessionService/tutoringService`正常HTTPS/SQLite兼容检查，两个Chrome worker，教学Node24.21.0，retries=0。22/22通过（195.6秒，skip/flaky/failure全0），[摘要](evidence/i0-ui-prep-closeout/shared-host-compatibility-20261014.json)可核；执行器/provider仍合成，不连接PAHER，不与前轮17或服务5项重复累加。学生源树/正常dist未变，无新增疑点，不重跑无关全量。
