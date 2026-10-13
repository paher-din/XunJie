# I0-A/C 按 H 编号接收、协调与回交

## 1. 任务、依据与授权

2026-10-13，项目负责人要求 A 先接收 UI 负责人交付并协调 C，按 [#30 原交接请求](https://github.com/paher-din/XunJie/issues/30#issuecomment-6137496293) 的 H-01～H-06 回交。本文由 A 维护接收事实、现有接口材料、差异及下一责任角色；UI 维护真实界面接线，C 维护作品/执行。I0-A 不等待 B #45；不重开已关闭模块卡、不另建重复 UI 票。

已读当前 AGENTS/README；PRD §4.1～4.4/5（身份、固定活动、学生操作）、MVP M-03/M-10、§4 状态、AC-02/03/04/06/12/15 与 NFR-04，TECH §4.1/4.3/4.4、§5、§7.1/7.2.1/8.5/9；I0_UI_SPEC、客户端约束 §2/5/6/8、I0_UI_CLOSEOUT §8.1/8.5、IMPORT_SOURCE、学生 README 和 C2/C4/DL-C/顺序集成记录。

本次写集仅本文及 README 导航，维护 A 的交接材料；代码、UI、他人任务、产品/规划/参考/AGENTS、数据库、凭据与 CI 只读。不改变共享字段或版本语义，不初始化数据库、不维护节点、不调用模型。项目负责人当前请求授权在现有 #30 接收/协调/回交；没有据此授权公开推送代码、迁移库或部署。受保护基线汇总待授权维护者处理。

## 2. 固定接收与代码来源

2026-10-13，独立工作副本 fetch 后快进到 main [c437ef269407b71bbed26d105e3e8b98ab71bbab](https://github.com/paher-din/XunJie/commit/c437ef269407b71bbed26d105e3e8b98ab71bbab)。包含 UI PR #50/#51、C4 #47、A4 #49、DL-C #48。UI #51 固定 head 为 1fe6c960602679d8bd5f95af46ace14930cda0df，工程提交 bde0999c9cf273a11cc1ead9e3258d40365242f8；来源与许可沿 [IMPORT_SOURCE](../../apps/student/IMPORT_SOURCE.md)。原工作副本的既有未提交文档、独立工作副本原 typecheck 日志均保留。

服务端公开接口依据当前 [认证应用](../../apps/teaching/server/access/app.ts)、[设计应用](../../apps/teaching/server/design/application.ts)、[Workspace 应用](../../apps/teaching/server/workspace/application.ts)、[输入校验](../../apps/teaching/server/workspace/inputs.ts)、[作品同步](../../apps/teaching/server/workspace/files.ts)、[命令/读取](../../apps/teaching/server/workspace/commands.ts) 和 [错误契约](../../apps/teaching/contracts/common/http.ts)。模块已有，不表示默认正常进程已经装配它们。

另有本地 codex/dl-a-ac-integration，HEAD 3ec9f6d、已验证源码 dd5f81c86ada5bc6c5dc24342d8e086308aabe4c，含两课程宿主与消费者；尚未公开推送，且未吸收上述三项顺序合并，不向 UI 提供不可远程检出的链接作为可运行交付。其 26/26 合成专项、Windows 全量 343 项（331 通过、1 失败、11 跳过）仅适用该源码，不计当前 I0-A 通过。

## 3. 按 H 编号的本次回交

| H / 能力 | 负责人 | 已交材料 | 联调状态 / 剩余条件 / 下一责任角色 |
| --- | --- | --- | --- |
| H-01 身份与同源 HTTPS | A | §4 的 Session/Origin/CSRF 使用规则及当前入口缺口 | 当前 main 默认仅健康入口；实际 HTTPS 业务宿主、同源 UI 挂载、获准合成账号交接与真实浏览器登录未执行。A 落实正常宿主，环境维护者通过受控通道交已授权 TLS/签名材料 |
| H-02 合法 Assignment / 空态 | A | §4 的现有授权深链、固定活动/资料读取；GET 不创建 Attempt | 无需预定新增列表；尚无正常宿主及实际获准 Assignment 引用，真实读取未执行。A 提供合法引用与无分配条件，UI 接实际入口/空态 |
| H-03 首次代际 / 恢复 | A/C | §5 的现有 recovery 读取及禁止来源 | GET session 不含 recoveryGeneration；无 Attempt 时不能靠其 recovery 路由初始化。首次受信来源仍待具体契约确认/实现；已有 Attempt 恢复真实联调未执行。C 交当前受信代际来源，A 落实首次授权读取 |
| H-04 原 Job 消费 / 当前 C1 | A/C | §6 的原 worker、当前指纹门禁与启动边界 | 正常进程消费者尚未合入；当前目标节点重新验证/登记未执行。C 回交当前 ready/profile/validation/代际，A 组合持续消费及停止对账 |
| H-05 版本 / 暂停 | A/C | §5 的 sync 后重读、暂停分配、历史回执与当前状态区分 | 已交源码核对材料；没有改共享契约，当前 HTTPS/UI 联调未执行。C 复核公开反例，A 汇总基线差异，UI 消费当前权威 head |
| H-06 分批公开样例 | A/C | §4～7 的读取、保存/快照、运行、停止/未知、历史/产物模板与反例 | 已交接口材料；模板是源码导出的示例/节选，非本次实际 HTTP 响应。C 回交对应实际样例/证据，UI 按可用能力接线，不等整包齐备 |

“已交材料”只表示字段/行为/现有来源可核对；“联调通过”必须有对应固定代码、实际入口、命令和结果。本次无真实业务联调通过项，不勾选 #30/#22 完成。

## 4. H-01/H-02/H-06：身份与只读入口

正常浏览器仅使用批准 HTTPS 同源服务。POST /api/sessions 使用受控合成账户；GET /api/session 返回当前 userId、courses 与 csrfToken。cookie 为 HttpOnly/Secure/SameSite 的服务端 Session；写请求保留原 Origin/CSRF 检查。公开记录不附密码、key、cookie、CSRF 值、私有答案或真实学生正文。登录名称/角色按钮不决定权限，请求体不能自报 role/studentId 提权。

现有读取路由：

| 路由 | 公开结果/边界 |
| --- | --- |
| GET /api/session | 当前服务端会话和课程成员；不能拿它推导尚未公开的首次代际 |
| GET /api/assignments/:assignmentId | 本人分配；assignmentId/activityVersionId/studentId/assignmentRevision/active/status/reasons/activityControlRevision |
| GET /api/activities/:activityVersionId?audience=student | 固定学生投影；不读取教师草稿/私有验证资产 |
| GET /api/resources/:resourceVersionId | 按课程/可见性裁剪；私有内容拒绝或保持不可用，不能用 hash 补正文 |
| GET /api/attempts/:attemptId | 当前 attempt/files/snapshots/jobs/runs/checks/submissions/reopen；由本人或本课程教师授权读取 |

H-02 可先使用 A 经授权交出的分配深链，不能把对象 ID 写进正式源码或猜测遍历；未获得本人分配时保持“未有获准入口”。不把不存在的列表路由/空数组示例当已实现接口。GET 不创建 Attempt、激活学习或启动 Job。跨学生/跨课程读取由服务端拒绝，学生不能读取 teacher-validator 视图。

暂停分配的公开响应节选（模板，省略信封中的 requestId 及其余字段）：

```json
{
  "data": {
    "assignmentId": "<authorized-assignment>",
    "activityVersionId": "<fixed-activity>",
    "assignmentRevision": 2,
    "active": false,
    "status": "paused",
    "reasons": { "individual": "", "activity": "<public-pause-reason>" },
    "activityControlRevision": 2
  }
}
```

上述数字仅示例；UI 使用实际权威响应。暂停分配仍可读获准历史，不等于所有读操作拒绝；新 Attempt/运行不可绕过教师暂停。

## 5. H-03/H-05：代际、ACK 和权威版本

当前 GET /api/session 不含 recoveryGeneration。既有 GET /api/attempts/:id/recovery?recoveryGeneration=<last-trusted-generation>&decisionEpoch=<last-read-epoch> 在当前有效会话下只读返回当前 recoveryGeneration、resyncRequired、Attempt 与受限恢复投影。代际/epoch 不一致要求同步，GET 不创建/修改/重跑。它需要已存在且获准的 Attempt，不能解决无 Attempt 时第一次创建的代际来源。

首次创建所需代际必须来自受控部署/当前节点可信来源，并由正常服务授权交给浏览器。旧 Job、活动发布时历史指纹、随机值、客户端常量均不能替代当前来源。后续若增加 bootstrap 路由/字段，须先列共享契约及负责人确认；本文未擅自新增接口。

真实业务入口与可信首次代际具备后，由学生显式 POST /api/assignments/:id/attempts 创建，GET 不创建。随后确认保存使用现有 sync：

```json
{
  "recoveryGeneration": "<current-trusted-generation>",
  "expectedWorkspaceRevision": 0,
  "clientId": "<stable-client>",
  "clientSeq": 1,
  "operations": [
    { "kind": "create", "clientFileKey": "<local-instance>", "path": "main.c", "text": "int main(void){return 0;}\n" }
  ]
}
```

路由 POST /api/attempts/:id/sync。原有写入头由实际登录会话和冻结命令提供，此模板不附其值。正文必须原样保留 UTF-8/换行，不能用示例程序表示 TextScope 验收通过。

当前同步成功 ACK 为 data 的 CommandReceipt（含 result、replayed），result 含 workspaceRevision、files、created、process；没有新增 attemptRevision/decisionEpoch。files 为确认元数据，不用它覆盖后续本机草稿。相同原键/同正文回原回执，异正文或 sync 双键冲突拒绝；旧代际保持 RECOVERY_REQUIRED，不换键自动补发。

**实际基线差异：** files.ts 的 syncFiles 每次新接纳同步都推进 workspaceRevision 和 attemptRevision，ready 时激活也只推进一次 attemptRevision。TECH §4.3 的“attemptRevision 不随逐次文件编辑增加”与当前实现不同。本文记录差异，待授权维护者汇总；不单方改 C 代码或受保护基线。A/C 请求已要求 C 明确反例与修复/兼容裁决。

在现有行为下，确认同步回执后 GET /api/attempts/:id 重读 data.attempt.attemptRevision/decisionEpoch/workspaceRevision，再构造新的 Run/Control 命令。不能把 workspaceRevision/documentVersion/editor version 当 attemptRevision。相同旧命令的历史回执不证明当前 head 没变化；重读失败保留草稿、原 outbox/回执和未知，不猜下一个版本。

确认快照请求 POST /api/attempts/:id/snapshots：

```json
{ "recoveryGeneration": "<current-trusted-generation>", "expectedWorkspaceRevision": 1 }
```

回应 data.result 的 snapshotId/snapshotHash/workspaceRevision 来自原回执。再 GET /api/attempts/:id/snapshots/:snapshotId 核确切清单、正文/hash 和 sha256-manifest-v1；不可用不伪造快照。snapshot 命令也可能激活 ready Attempt，后续 CAS 命令同样使用权威重读。

暂停期间仅可更新既有 active 文件正文，不 create/recycle/restore；阶段 submitted/reviewed 无合法重开许可时只读。活动/分配暂停覆盖本人 resume，保存规则不等于允许新运行。

## 6. H-04：持续消费与实际环境

当前 main 的 npm start 仅健康入口；模块工厂 createWorkspaceApp 已提供原 pendingJobs/processJob。正常宿主须定时消费原 Job、保持原 ID/租约/停止意图与代际，启动对账和关停持久停止/未知语义沿原 worker；不能要求教师/学生手动调用 processJob，不回退到应用宿主 GCC。

I0-A 的 C 读取/保存无需 HDL 或模型就绪。已有本地 DL-A 宿主当前启动依赖 HDL readiness，不能把该条件变成 I0-A C 读取/保存的新增门禁；若复用该代码，先单列 C 模式必要差异与授权，不混入整个未交 DL-A 批次。

最新 DL-C 合并修正了 Trace 游标和 VPI 时间精度，桥接源码进入既定 fingerprint。当前 main 旧目标 ready 不再有效；须 C 提供当前源码/profile/sourceHash/fingerprintHash/validation/代际绑定的重新验证事实。旧目标 14/14、历史 A2 实读 ready=true 或本地 Icarus 夹具不能计当前 C1/HDL 就绪。

命令在对应工程目录、教学服务 Node 24.21.0 与原 lock 下执行；下面是既有验证命令入口，**本次均未执行**，不是可用真实服务启动保证：

```sh
cd apps/teaching
npm run typecheck
npm run build
node --test server/workspace/integration.test.ts server/workspace/runs.test.ts server/workspace/submissions.test.ts
npm test
```

学生按 [学生 README](../../apps/student/README.md) 使用自身 Node 24/lock。dev:prep 的 /__i0prep/api 是隔离 fixture，real 模式的 /api 需实际同源宿主；失败不回退 Mock。现有已获准 TLS/签名/应用 SSH/known_hosts 材料继续走受控通道，不在公开仓库给凭据、个人路径或真实数据入口。

正常宿主与实际 TLS/账号未交，不能给出虚构可运行的 origin/启动配置。A 接入后须回交固定公开 SHA/PR、受控初始化的批准范围和正常启动命令；本地不可检出提交不作远程入口。

## 7. H-06：运行、停止、未知与历史/产物

只有当前固定活动实际支持 Core stats/find/top 且 H-04 当前 C1 就绪时，由学生主动 POST /api/attempts/:id/runs：

```json
{
  "recoveryGeneration": "<current-trusted-generation>",
  "expectedAttemptRevision": 3,
  "snapshotId": "<confirmed-snapshot>",
  "runtimeProfileVersion": "<fixed-activity-runtime>",
  "entryFileId": "<snapshot-c-file>",
  "input": { "operation": "stats", "fileIds": ["<snapshot-ascii-file>"] },
  "mode": "run"
}
```

版本/引用来自真实权威读取，示例 3 不能自算。正文允许 run/course_check；回执 data.result 关联原 jobId/runId。GET /api/jobs/:jobId 和 GET /api/attempts/:id/runs/:runId 读取原状态/诊断，Job succeeded 不等于课程检查通过。

停止 POST /api/jobs/:jobId/cancel，正文为 recoveryGeneration（reason 为可选），使用学生显式停止的原命令。停止受理是意图，需读原 Job/Run 的实际终态；断线、outcome_unknown、cancelling 均不宣称已停止/未运行，不新建执行。原请求响应未知时仅核对/重放原同代际冻结命令，不能使用编辑后的表单或新键；旧代际先核原事实并重读，不能自动换代补发。

历史读取与产物 GET /api/attempts/:id/runs/:runId/files：

| 公开状态 | 客户端边界 |
| --- | --- |
| diagnostics available | 只读对应快照输出/编译诊断；缺位置不编造行列 |
| diagnostics unavailable | 不是空输出成功，不补模型估计 |
| 课程检查公开 verdict/failureKind | 不曝光私有输入/答案/判定正文 |
| files available | 核原 run/snapshot、稳定 resultFileId、hash、UTF-8 字节及 complete 后只读呈现/下载 |
| redacted/unavailable/missing/incomplete | 分别保留裁剪、不可回取、缺失、不完整，不提供不存在的正文或下载 |

现有 GET Run 不公开 entryFileId/input/inputHash；只使用经原回执核验的本机冻结请求作为“本机请求记录”。其他浏览器/缓存丢失时显示历史参数不可回取，保留合法结果读取。Report 仅在实际固定活动支持/批准时开放；查看或下载不写回作品。

待 C 的实际分批样例应涵盖：跨学生/课程 FORBIDDEN、旧 revision VERSION_CONFLICT、原回执 replay/异正文 IDEMPOTENCY_CONFLICT、旧代际 RECOVERY_REQUIRED、暂停分配拒绝新运行、丢 ACK 后同一 fileId/jobId、停止 unknown、私有结果 redacted，以及 missing/incomplete。错误完整信封沿 common/http，不只截一个 code 冒充完整 JSON。

## 8. C 协调、回交与下一批

A 已实际在 [#30 接收与 C 协调回复](https://github.com/paher-din/XunJie/issues/30#issuecomment-6139828933) 确认收到，并按 H 请求 C 回交当前节点/代际、受控连接方式、sync/暂停反例、分批作品/运行/取消/产物证据。提及的 C 域作者以 C4 PR #47 作者 paher-din 核对，不猜测邮箱或账号。C 的完成状态以实际回复为准，未把发出请求写成收到答复。

下一批依次：A/C 核只读真实身份/分配/活动 → A/C 落实首次受信代际和保存/快照 → 当前 C1 readiness 与正常消费者后接运行/停止。UI 在相应材料/服务可用后完成真实接线和浏览器验证并回交结果。各能力只等待自己的必需条件。

A 未把本次 H 任务变成 35 表 DL-A 合成库集成或全 HDL/B/UI 实现；若后续涉及新 bootstrap 契约、schema 或受控运行配置，先交具体方案并取得覆盖对象的确认。未完成环境条件按 #23 跟踪，跨阶段协调沿 #37，完整 AC/NFR 沿 #22；本次不关闭任务。

## 9. 验证与 Git 交付

本次只做接口/代码/既有证据只读核查及交接文档；业务、Node 24.21.0 类型/构建、HTTP、真实节点、浏览器/TLS、模型和完整回归均未执行。源码未改，不用历史通过数冒充本次验证。

2026-10-13，开工静态检查62份文档/892内链 errors=[]；新增本任务稿与导航后63份/902内链 errors=[]。工具反例16/16通过、0失败/跳过；git diff --check通过。本次静态 Node 24.15.0，仅文档工具，不计教学服务验收。H 公开回交已发布并追加首批材料到 #30 同一条6139828933；C实际答复和后续联调仍待回读。新增文档四个 JSON 模板解析/末尾换行/空白通过；静态 DDL 为24个唯一表（未建库），暂存仅本文/README，公开回交正文与准备内容逐字一致。提交前回读 #30 为两条 UI 评论及本次 A 回复，尚无 C 实际答复。分支 codex/i0-a-c-handoff 从 c437ef2 新建，仅提交本人任务稿和 README 导航；原日志与主副本既有修改保留，不公开推送代码或部署。


## 10. 下一批实施提案：I0-A 的 C 业务宿主（待负责人确认）

本节仅提案，不改变本文已交/未执行状态。H 交接优先于整个 DL-A 收尾，首批不依赖 HDL、B 模型、A4 状态或新教师 Agent 能力；使用当前 main 的原 A/C 模块，保留同一正常 main 和原 Job。

### 10.1 精确写集与运行范围

A 可写 server/main.ts、server/app/config.ts、server/app.ts 及新增 server/app/i0.ts、server/app/i0-initialize.ts、server/app/i0-static.ts、server/app/i0.test.ts，新增 contracts/design/i0.ts（只定义本节获准后的 bootstrap 投影），A 本任务稿和 README。C/workspace、C/runner、B、UI 源码、产品/规划/参考/AGENTS、package/lock、凭据和 CI 保持只读；复用 createWorkspaceApp、原 pendingJobs/processJob 与现有受认证 C1 transport，不另建 API 或队列。

初始化复用当前 createWorkspaceDatabase 的原 24 表（原 22 表加 C4 workspace_submissions/workspace_reopen_grants），不增加表/列，不合入 DL-A 两张新表或 HDL/A4 扩展。只新建保留临时合成库，初始化账号/课程/成员及原课程配置；教师仍走原检查→确认→分配，维护者不补造学生 Attempt/Job。账号使用明确 synthetic 标志及合成 ID/登录名，密码只在受控初始化配置/原哈希保管。既有/生产库、原合成库、凭据权限均不迁移/重置。实际建库待本节确认后执行。

同一 main 从外部受控配置读取现有合成 DB、精确 HTTPS Origin、已有 TLS/签名/应用 SSH/known_hosts 文件引用、由 C 受控来源交出的 generation、静态 UI dist 与消费者间隔。服务器本机监听；静态只服务明确 dist 内普通文件，校验路径/内容类型，不提供目录枚举或配置/数据库文件。不改 UI 源码/页面、认证、证书校验或代理信任；UI 仍正常 real build。未配置保留原健康入口，业务模式明确检查配置与权限，不借健康响应冒充 ready。

当前 runner 不 ready 只阻止开放/新运行等执行依赖能力，不能把 HDL/模型/current runner 不可用变成已获准读取/保存的统一门禁；当前代际来源缺失或不可信时，bootstrap/首次创建保持 RECOVERY_REQUIRED。不启动/安装/维护节点、生成证书或代际；C 回交实际受控配置及当前证据之后才做真实联调。

### 10.2 最小新增共享读取：H-03 bootstrap

提案 GET /api/assignments/:id/bootstrap，服务端从有效 Session、课程成员与真实 Assignment 定位授权；学生只读本人，教师沿原课程读取权限。GET 不创建 Attempt、不激活、不消费 Job，不接受请求体 role/studentId/generation。

新增 data 形状：

```text
{
  assignment: <现有 AssignmentView 原字段/语义>,
  recoveryGeneration: <来自已获准受控配置、与 C 受信来源核对的当前 generation>
}
```

assignment 字段沿 GET assignments 原投影，含 active/status/revisions；无合法分配保持原拒绝，不能用 bootstrap 提权。首次写入必须回带这里的 generation；它不是历史 Job/发布时快照指纹或 UI 随机值。恢复时同时重读该已授权入口和既有 Attempt/recovery；旧 outbox 保留，不自动跨代际重发。

该新增路由/字段是共享契约变化，须负责人确认后编码；本次没有写进受保护 TECH_DESIGN。运行中代际不随客户端变更；获准恢复变更时按 C 的受信来源重启接纳并核原事实，不自动启动或修复节点。

### 10.3 正常消费、验证和具体交付

原 Workspace pendingJobs/processJob 定时消费、启动核原作业身份、停止接纳后持久停止与原 Job 对账。只运行本批 C 模块，不创建无人消费的模型任务；停止不确认时如实 unknown。真实 C1 readiness/profile/validation/代际仍等待 C 的当前输出，不由合成 transport 决定开放。

预定公共验证：真实 Session/Origin/CSRF + Fastify HTTP/SQLite 事务 + 原 Job/worker；仅外部 transport 合成。核合法 Assignment/空态/越权、bootstrap 无副作用、首次代际/旧代际、原 sync 重放/冲突及权威 head 重读、暂停后读/既有文件保存与新运行拒绝、连续消费、cancel/unknown/重启读取、结果裁剪和静态路径逃逸拒绝。固定 Node 24.21.0/原 lock，逐相关专项、typecheck/build、最后一次全量，失败/跳过分别登记；不降低原守卫/门槛。所有新合成库保留，不把 transport 合成通过记真实节点或 UI 通过。

实施后在本任务回交 H 编号、固定源码、启动/初始化命令、公开 HTTP 样例和结果。若负责人同时批准公开交付，则只普通推送 codex/i0-a-c-handoff 并建立本模块 Draft PR，公开内容仅代码与去敏合成验收；不自动合并/部署，保留 #30/#22。当前仅接收/协调授权不宣称已有这项代码推送授权。

## 11. 本批实施授权与开工

2026-10-13，负责人明确批准 §10 的具体范围并要求继续，包括原24表全新保留合成库、正常 C/HTTPS 宿主、现有 real build、原 Job 消费、授权 bootstrap，以及验证审查后普通推送并建立 Draft PR。此授权不包含 B/C/UI 源码、受保护基线、凭据/CI、节点维护、自动合并或部署。远程 main 已同步至 cde69cc；具体基线差异为 B 模型验证和 G2 记录，保留原职责。

本次公共测试接缝为真实 Session/Origin/CSRF、HTTP、SQLite 事务和原 worker，仅外部 transport 使用合成替身。先逐行为红→绿，再类型/构建、相关专项和完整回归。实现与验证结果待下文记录，不提前写为通过；TECH_DESIGN 与 MVP_SPEC §10 的 bootstrap/进度汇总待授权维护者汇总。

## 12. 本批实现与运行交接

2026-10-13，本批 A 源码已实现，审查/完整回归/公开 PR 状态在 §13 记录，不把实现自动写成真实环境已部署。

| H | 代码交付 | 当前证据与下一角色 |
| --- | --- | --- |
| H-01 | 原 main 的可选 C 业务模式、原真实 Session/CSRF、TLS 监听和现有 UI dist；未配置仍健康入口 | 正常宿主合成 HTTP 和 real build 已验证；现有 TLS/认证配置与实际浏览器登录等待环境维护者/UI |
| H-02 | 原 Assignment/Activity/Resource 路由复用，既有合法深链，无分配仍拒绝 | 本人/教师读取、未分配/跨学生/跨课程/匿名拒绝已验证；UI 接正常入口/空态 |
| H-03 | contracts/design/i0.ts 与 server/app/i0.ts 的 GET bootstrap；原 AssignmentView + 受控代际，不创建/激活 Attempt | 无可信代际/旧代际写入 RECOVERY_REQUIRED；真实 C 代际文件仍由 C 回交 |
| H-04 | startConsumer 调用原 pendingJobs/processJob；普通重启沿原 ID/租约对账；关停持久停止意图并核原执行 | 自动消费、停止确认、unknown/停止未知与重启无替代执行的合成 HTTP 已验证；真实 C1 当前指纹/就绪未执行 |
| H-05 | 原 sync 回执、权威 head 重读、分配暂停规则 | 重放/异正文冲突、旧 revision、暂停后更新/快照与拒绝新运行已验证；§5 版本差异仍交原 C/授权维护者 |
| H-06 | 原作品、快照、运行、取消、历史/产物路由不变 | 本批补作品与停止/未知；原 C 专项结果在 §13；UI 分批真实接线，真实节点样例待 C |

### 12.1 初始化与启动

Node 固定24.21.0；沿各应用原 lock，不修改依赖/CI。从仓库根先构建现有 UI real 产物，不挂 dev:prep：

~~~sh
cd apps/student
npm ci
npm run build
cd ../teaching
npm ci
npm run typecheck
npm run build
~~~

维护者引用已有受控初始化 JSON：

~~~sh
XUNJIE_I0_INITIALIZE_CONFIG=/controlled/i0-initialize.json node dist/server/app/i0-initialize.js
~~~

PowerShell 设置同名环境变量后执行该 node 命令。仅调用 createWorkspaceDatabase 新建/保留原24表临时库，打印新 synthetic.sqlite 位置；不接收目标数据库、迁移/重置旧库，不创建 Assignment/Attempt/Job。失败亦保留新库。输入是 synthetic=true，users 每项含 synthetic- 前缀 id/loginName 和受控 password；courses 每项含 synthetic- 前缀 id/teacherId/studentIds 及原 helpPolicy/checkRule 对象。只初始化成员和原政策/规则；教师仍走原 HTTP 检查→确认→分配。密码不进仓库/公开记录；CLI 不打印输入/异常正文。

配置引用现有文件，不生成/改写凭据、证书、known_hosts 或节点代际：

~~~json
{
  "synthetic": true,
  "databaseFile": "<initializer returned retained synthetic.sqlite>",
  "origin": "https://<approved host>:3443",
  "tls": {"keyFile": "<existing absolute key path>", "certFile": "<existing absolute certificate path>"},
  "signingSecretFile": "<existing controlled signing file>",
  "generationFile": "<C handed-off controlled readiness/identity JSON path>",
  "ssh": {
    "binary": "<existing absolute ssh executable>",
    "keyFile": "<existing application key path>",
    "knownHostsFile": "<existing controlled known_hosts path>",
    "host": "<approved C1 host>",
    "port": 2222
  },
  "staticDirectory": "<absolute apps/student/dist path>",
  "consumerIntervalMs": 250
}
~~~

占位模板不是已存在的入口。配置须绝对普通文件，拒绝符号链接，POSIX 拒绝组/其他用户可写文件；Windows 由受控目录 ACL 维护。JSON 最大1 MiB，签名长度32～4096，不打印内容。Origin 为精确 HTTPS Origin，端口与 PORT 对应；监听127.0.0.1，不新增代理信任/证书忽略。

generationFile 来自 C 已获准受控交接 JSON，读取原 data.recoveryGeneration，保留原指纹/验收资料，不要求 C 改线协议。缺省/缺字段使当前代际为空，bootstrap/首次创建拒绝；文件错误使启动失败。普通重启沿同一来源，不生成代际。SSH readiness 代际与配置不一致拒绝；runner 不 ready 不阻止合法读取/保存，新开放/新运行沿原 readiness。文件存在不证明来源核实，维护者须沿 H-03/H-04 核当前 C 固定源码/输出；恢复换代仍按维护授权对账，不自动写文件或启动节点。

~~~sh
PORT=3443 XUNJIE_I0_CONFIG=/controlled/i0-host.json npm start
~~~

未配置仍健康模式；/health/ready 保留未装配的拒绝，不恒定成功。学生深链沿现有 hash router，读取/保存后分批接运行；只服务 dist 内白名单普通文件（含 Monaco 字体），不提供配置、DB、目录枚举、源码映射或路径逃逸。持续消费原 C Job，无需维护者 processJob；不装配 B/A3/HDL 扩展或模型队列。

关停停止新接纳和新执行 dispatch/readiness，等待已接纳 HTTP 收束，再持久停止原 Job 并核原身份；未确认仍 cancelling/outcome_unknown，不写已停止。已进入 readiness 等待的并发请求不会补建 Job。正常 main 在关停流程后关闭并保留库。

### 12.2 公共 bootstrap 与样例

真实 Session + 当前课程成员 + 真实 Assignment；学生仅本人，教师沿原课程读取。GET 无 body 身份字段，响应 Cache-Control: no-store；不创建 Attempt/回执/Job，不激活。原 Access/C 事务和权限复用，新增 schema 校验结果。

~~~json
{
  "requestId": "<server request UUID>",
  "data": {
    "assignment": {
      "assignmentId": "<authorized assignment>",
      "activityVersionId": "<fixed activity>",
      "studentId": "<session-owned student>",
      "assignmentRevision": 1,
      "active": true,
      "status": "active",
      "reasons": {"individual": "", "activity": ""},
      "activityControlRevision": 1
    },
    "recoveryGeneration": "<current controlled C generation>"
  }
}
~~~

此为契约节选模板；完整信封沿 common/http，不公开 cookie/CSRF/密码。测试代际 generation 仅测试输入，正常 main 无默认值。首次 POST assignments/:id/attempts 回带 bootstrap 代际；ACK 后仍按原 Attempt/recovery 与版本规则。

专项命令包含 real build 读取，先完成 UI build：

~~~sh
cd apps/teaching
node --test server/app/i0.test.ts
node --test server/workspace/integration.test.ts server/workspace/runs.test.ts tests/startup.test.ts
~~~

原 npm test 不含新增 server/app glob，完整教学回归须明确纳入本文件：

~~~sh
npm run build
node --test tests/*.test.ts server/app/i0.test.ts server/records/*.test.ts server/workspace/*.test.ts server/tutoring/test/*.test.ts runner/*.test.ts
~~~

HTTP 认证/SQLite 事务/原 worker 真实，仅外部 transport 合成。所有新库保留；失败/跳过与平台在 §13 独立记录，不补写 TLS/节点/浏览器/教学结果。


## 13. 本批验证与审查记录

2026-10-13，Windows Node24.21.0：新增正常宿主专项10/10通过、0失败/跳过；教学 typecheck/build通过，原启动专项4/4通过。学生原 lock 的 npm ci、real build通过，未改 UI 源码/lock；安装审计报告6项（2 low/1 moderate/1 high/2 critical）与原构建 chunk 警告保留，交 UI 依赖负责人，不自动升级。真实 loopback HTTP读取原 UI构建/会话已通过；这不包含 HTTPS真实证书、浏览器接线或 C物理节点验收。

TDD红轮保留：bootstrap/初始化模块缺失、静态路由缺失、自动消费者缺失均先失败后实现；关停 readiness 并发原会200接受新 Job，反例先失败后修复。验证中先后发现测试时钟不一致、构建路径层级错误、fetch严格类型，以及原暂停快照/停止未知投影的预期误差；按原正文/HTTP契约校正测试，未改 C或放宽业务守卫。最新相关专项通过；下列完整回归/最终审查尚待执行，未提前宣称全量通过。

宿主还校验当前库为获准24表的精确表集合，拒绝其他组合，不执行迁移。现有旧日志/主副本未动。新库由原工厂保留，记录不输出凭据。真实 TLS/C1最新指纹/代际/节点端到端、浏览器、模型、完整产品与教学验收未执行；#30/#22保持Open。共享字段/bootstrap与MVP§10进度待授权维护者汇总。

### 13.1 完整回归与最终核对

2026-10-13，WSL2 Ubuntu / Node24.21.0，独立保留源码副本（业务源码 b0030c7）：原 lock npm ci、typecheck、build 均通过；完整教学回归明确包含新增宿主专项，394项，382通过、0失败、0取消、12跳过，163.018秒。原始日志终端统计节选如下；不是382项全部原始正文。12跳过均不计通过：4个容器/HDL时钟/目标VM/监督，5个真实模型/提供商批次，3个真实C1/SSH业务链。本次未提供那些环境开关，未运行真实模型或物理节点。

~~~text
ℹ tests 394
ℹ suites 0
ℹ pass 382
ℹ fail 0
ℹ cancelled 0
ℹ skipped 12
ℹ todo 0
ℹ duration_ms 163018.414143
~~~

原日志中的完整跳过项：

~~~text
﹣ dedicated Linux synthetic container execution and resource checks (14.9803ms) # SKIP
﹣ the platform clock and delayed RTL keep picosecond semantics under finer student time precision (10.458727ms) # SKIP
﹣ target VM: real build, persistent state, duplicates, four values, scan, spoofing and termination (6.740628ms) # SKIP
﹣ authenticated dedicated VM control and supervision (2.573709ms) # SKIP
﹣ P2 real-provider cancellation, timeout and HTTP failure probes (1.784972ms) # SKIP
﹣ P2 real-model student help, persisted content and undisplayed cancellation (0.078338ms) # SKIP
﹣ P2 authorized two-job real student-help semantic-fix batch (0.0859ms) # SKIP
﹣ P2 authorized 30-job real student-help performance batch (0.084877ms) # SKIP
﹣ real A1/A2/C1 student chain retains old snapshots, trusted checks, cancellation and ACKs after reopen (1.144459ms) # SKIP
﹣ C2 synthetic confirmed workspace uses real C1 SSH: old snapshot, original result, check verdict and cancel (0.394982ms) # SKIP
﹣ real authenticated C1 readiness supports the A2 checks-release-assignment-pause chain (0.522102ms) # SKIP
﹣ P2 real-model teacher generation, explicit adoption and local PATCH (0.376535ms) # SKIP
~~~

完整回归后仅按 Standards 建议在 A 自有测试文件提取 syntheticReadiness helper，业务源码未变；Windows 重新执行新增专项10/10、0失败/跳过，typecheck通过。原启动+宿主最近联合14/14通过。文档检查64份/921内链 errors=[]，工具反例16/16通过，git diff --check通过；最终交付再核新增链接与具体写集。

### 13.2 本次实际合成 HTTP 公开回交

另经实际原登录会话/SQLite事务重放下列公开读取；仅外部 transport 合成。全部账号/作品为隔离合成数据，新库保留。未记录会话、CSRF、密码或私有答案。这是本次请求/响应记录，不是占位模板；H-05 head 重读亦实际返回 workspaceRevision=1/attemptRevision=2。相同 Assignment 随后教师原控制接口暂停，bootstrap active=false/assignmentRevision=2。该 record 的 source 标识业务源码，后续仅测试提取/交付文档提交。

~~~json
{
  "synthetic": true,
  "externalTransport": "synthetic only",
  "node": "v24.21.0",
  "source": "b0030c7 business sources",
  "steps": [
    {
      "H": "H-03",
      "request": {
        "method": "GET",
        "url": "/api/assignments/54ab32f3-a5c5-4f0e-b3cf-c62e371c2923/bootstrap"
      },
      "status": 200,
      "response": {
        "requestId": "e3cb73e3-5abc-452a-a15e-4ff81ba73279",
        "data": {
          "assignment": {
            "assignmentId": "54ab32f3-a5c5-4f0e-b3cf-c62e371c2923",
            "activityVersionId": "814a4972-8613-40e2-a26a-b0a64dc00b22",
            "studentId": "student",
            "assignmentRevision": 1,
            "active": true,
            "status": "active",
            "reasons": {
              "individual": "",
              "activity": ""
            },
            "activityControlRevision": 1
          },
          "recoveryGeneration": "generation"
        }
      }
    },
    {
      "H": "H-02 cross-student",
      "request": {
        "method": "GET",
        "url": "/api/assignments/54ab32f3-a5c5-4f0e-b3cf-c62e371c2923/bootstrap"
      },
      "status": 403,
      "response": {
        "requestId": "30079568-47aa-47de-8552-8fa28cb42cee",
        "error": {
          "code": "FORBIDDEN",
          "message": "Access denied.",
          "retryable": false,
          "recovery": "Use an account authorized for this resource."
        }
      }
    },
    {
      "H": "H-02 anonymous",
      "status": 401,
      "response": {
        "requestId": "2f633d3b-a2aa-45fe-9d0a-cd10bb123147",
        "error": {
          "code": "UNAUTHENTICATED",
          "message": "Authentication required.",
          "retryable": false,
          "recovery": "Sign in using a valid account."
        }
      }
    },
    {
      "H": "H-05 paused allocation",
      "request": {
        "method": "GET",
        "url": "/api/assignments/54ab32f3-a5c5-4f0e-b3cf-c62e371c2923/bootstrap"
      },
      "status": 200,
      "response": {
        "requestId": "ad9f2980-7738-4e64-bb7b-51482cc8da6a",
        "data": {
          "assignment": {
            "assignmentId": "54ab32f3-a5c5-4f0e-b3cf-c62e371c2923",
            "activityVersionId": "814a4972-8613-40e2-a26a-b0a64dc00b22",
            "studentId": "student",
            "assignmentRevision": 2,
            "active": false,
            "status": "paused",
            "reasons": {
              "individual": "Synthetic review",
              "activity": ""
            },
            "activityControlRevision": 1
          },
          "recoveryGeneration": "generation"
        }
      }
    }
  ]
}
~~~

## Standards

独立 Standards 审查未发现书面规范硬性违规：写集符合 §10.1/11，未改 B/C/UI、受保护基线、schema、凭据或 CI；README 与任务记录同步，区分合成 HTTP 与真实 TLS/节点/浏览器未执行。唯一启发式为测试 readiness 响应重复构造，已在本文件提取 helper，transport 行为/断言不变，复跑10/10通过。

## Spec

独立 Spec 审查0项阻断：bootstrap 复用当前 Session/课程/本人分配，原 AssignmentView，缺代际拒绝，GET不创建/激活；正常 main 组合 TLS/UI build/原 worker，关停核原身份，静态/24表初始化范围相符，无越界实现。提出的完整回归与公开回交待办已分别执行/继续交付；真实 C/TLS/浏览器条件仍由原角色回交。模板 reasons 的 null 已校正为原空字符串，不改代码契约。

两轴合计：Standards 硬性违规0、启发式1已处理；Spec 阻断0。没有将合成工程通过写为节点/产品验收。公开推送/Draft PR 依据 §11 授权执行，交付 URL 与最终源码回读后记录于下一节；不自动合并或部署。

## 14. 公开交付与后续

2026-10-13，负责人 §11 授权范围内已普通推送 codex/i0-a-c-handoff，建立 [Draft PR #53](https://github.com/paher-din/XunJie/pull/53)，并附到本任务。已验证业务源码 b0030c7，后续39b6f10仅测试helper提取/验收记录；main基线 cde69cc，最终文档交付提交在 PR 中可检出。Standards 增量复审确认启发式已处理，无新增硬性问题。

H回交沿 [#30同一条A回复](https://github.com/paher-din/XunJie/issues/30#issuecomment-6139828933) 补充最新可运行代码/PR、精确命令与实际结果，保留初始材料核查的历史范围。交付时回读该卡仍只有UI与A评论，未收到C当前节点证据，不能写成已联调。下一步 C 回交获准当前节点的受控连接/代际JSON、当前固定源码/profile/validation和重验结果；A核实后进行对应真实联调，UI/Robert按 H能力接正常身份/分配/首次代际及保存/运行。无需等待 B 模型，读取/保存也不统一等待 HDL。

PR保持Draft，未合并/部署；#30/#22保持Open。真实TLS/浏览器/当前C1端到端仍未执行，产品基线/bootstrap契约及MVP§10汇总待授权维护者；不改受保护文档。主副本既有修改与本工作树无关原日志均保留。

## 15. C 回交接收与逐 H 核对（2026-10-13）

A 已收到并核对 [C 在 #30 的回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142231833)，来源更新时间 2026-10-13T09:10:58Z；本文 §14 的“交付时未收到”保留为先前时点事实。本次仅更新本人交接记录，不修改共享契约、代码、schema、配置或凭据；依 §11 完成同一分支和 #30 的交付更新。

**接收结论：材料回交已接收，当前真实节点联调条件仍未齐。** C 本次在 PAHER 实读 Ubuntu/WSL2 为 Stopped、原获准 loopback TCP 不可达；这是 C 回交的连接失败事实，不是 A 本机复测，也不是节点返回 ready=false。当前部署 SHA、readiness/profile/validation/recoveryGeneration、原 RunIdentity 查询和 generationFile 均未取得。跨机 localhost 不能替代 PAHER 目标；本次不启动/维护节点、不新增网络或凭据分发。

| H / 能力 | A 核材料结论 | 当前验证边界 / 下一责任 |
| --- | --- | --- |
| H-01 正常宿主、身份与 HTTPS | A 的 PR #53 已交宿主、真实 Session/CSRF、TLS 配置与启动方式；C 已给现有连接来源 | 尚无可核实正常 HTTPS URL、现有 TLS/签名配置及账号使用交接。A 与环境维护者落实已有获准受控材料，UI 再验真实浏览器登录；启动模板不是可访问入口 |
| H-02 本人分配与空态 | A §13.2 的 bootstrap 本人/跨学生/匿名/暂停合成 HTTP 已验证；C 没有另交当前分配实读 | UI 可按原 AssignmentView 与 bootstrap 材料准备接线；正常入口具备后验证实际登录、分配引用及空态，不从 GET 创建 Attempt |
| H-03 首次代际与恢复 | C 确认 controller 当前代际 → 受认证响应 → A 受控 generationFile → 授权 bootstrap；已有 Attempt 走 recovery 重读 | 尚缺当前受认证实读及 generationFile。C 在获准运行窗口回交当前值/来源，A 核实后引用；不填历史、测试、随机值或旧 Job |
| H-04 原 Job 与当前节点 | A 原消费者/关停对账已合成验证；C 已给固定源码/profile/历史验收与只读命令 | 旧 validation 与候选 sourceHash 不同，当前最新指纹重验/登记未执行。C/负责人确定原获准节点运行窗口，C 回交当前部署与完整 readiness/validation/profile；A 再联调原 worker，不用旧 ready 放行 |
| H-05 版本、暂停、恢复 | C 的 1/0/0 → 2/1/0 → 3/2/0、ACK 后 GET head 与暂停规则符合 A 当前接线材料 | C 本次仅领域函数合成，HTTP/SQLite 复验因依赖加载失败；A §13 合成接口/事务结果独立保留。UI 不推算 attemptRevision；TECH §4.3 差异待授权维护者汇总 |
| H-06 分批公开样例 | C 已交读取/保存/快照、原运行/停止/未知、历史/产物模板及函数层样例 | 本次 C 未采集当前 HTTP/真实节点/UI 输出。UI 可按材料分批准备，A/C 在真实条件具备后补对应链路；缺失正文不补写、不自动下载/写回、不换键重跑 |

### 15.1 独立核查与测试归属

A 使用固定 main cde69ccbd763c3c0ab381a809b750b951f195f64 的 Git blob 原字节，按 [fingerprint.ts](../../apps/teaching/runner/fingerprint.ts) 的排序、逐文件 SHA-256 与 JSON 摘要规则独立计算 34 项（含两份 runner 契约），sourceHash 为：

~~~text
7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852
~~~

与 C 回交一致；不对 Windows 工作副本 CRLF 求部署指纹。完整 fingerprint 还依赖当前节点 kernel/Node/Engine/profile，本次未取得，离线 sourceHash 一致不表示当前节点已部署或已通过验收。旧 c-validation sourceHash 为 5ff1d2257ec5164e3e6deef503df44c2c55362dd240e5e2a44dfb4e663278d6f，不能替代当前验收。

执行 git diff --stat 26e5b840270cbf489cb21e23d1d4ee2f3ad30998 cde69cc -- apps/teaching/runner apps/teaching/server/workspace apps/teaching/server/records，输出为空，确认该 C 写集与历史记录无源码差异；不是当前节点部署证明。对 C 的合成 report 文本 TOTAL、4、11、51（制表符分隔、末尾 LF）独立计算 UTF-8 字节为14，SHA-256 为 a712e934544c90229ac74e3f1dd495ff23209961c5bc11430d46e6da233ed335，与回交一致；不将该 collector 样例说成 HTTP/真实节点输出。

已读 [readRuntime](../../apps/teaching/server/records/runner.ts)、[产物投影](../../apps/teaching/server/workspace/result-files.ts)。H-06 外层 /files 的 status 为 available、redacted、unavailable；available.files 逐项 status 才是 complete、missing、incomplete。私有 check 返回 redacted；无确认结果返回 unavailable。§7 中各状态的处理保留，但 UI 应按这两层解析，available 不保证每项完整。正式批准白名单仍为 report.txt，C 的 missing.txt/directory 只作收集器反例。

C 本次测试归属保留：第一组20总/19通过/1跳过，records 4/4；第三组7 TAP 条目/3通过/3文件加载失败/1跳过（缺 zod），随后原 lock 安装因 Node launcher/Windows MSVC 条件失败。不能标为业务断言通过。A §13 已在独立 Linux Node24.21.0 环境按原 lock 通过 typecheck/build 及394总/382通过/12跳过全量，覆盖同一 C 源码；这说明 A 验证环境的组合结果，不覆盖 C 此次本机失败，不证明 PAHER 当前节点或 HTTPS 可用。纯材料增量不重复全套业务测试。

### 15.2 分批推进与剩余条件

1. A 在原 #30 回复按本节回交，PR #53 保持 Draft；UI/Robert 可立即核代码、响应层级、权威重读和分配入口材料，正常入口具备后先验身份/读取/保存，再验运行/停止/产物。
2. C/负责人落实原批准节点的运行窗口；C 在可达后回交当前部署 SHA、受认证 readiness/profile/validation、最新指纹重验/登记结果及受控 generationFile 的使用位置。A 仅在来源核实后接入，不承担未经授权节点维护。
3. A 与环境维护者落实原获准正常 HTTPS/签名/SSH 配置引用及合成账号安全交接；公开回复只放命令、去敏样例和状态，不放 key/cookie/CSRF/密码。当前缺口不推给 UI 伪造入口。
4. 当前真实 C1/HTTPS/浏览器联调仍未执行；#30/#22 保持 Open，完整 AC/NFR/真人/教学验收保留。TECH §4.3/bootstrap 及 MVP §10 待授权维护者汇总，不修改受保护基线。

本次材料增量验证：node tools/a0-review/check.mjs 为64份文档/924条内链/errors=[]；git diff --check 通过。写集仅本文，业务测试、节点、TLS/浏览器本次均未执行；既有业务验证仍按 §13 的固定源码和范围报告。

## 16. 接收 C 当前重验，继续 A 正常宿主收尾（2026-10-13）

负责人明确要求继续完成 #30 中 A 的剩余要求。沿 §11 原批准范围接收 C 当前材料、核实后接现有 SSH/generationFile、启动获准正常宿主并验证原消费者；不新增节点维护、跨机网络、凭据生成/分发或 schema 权限。当前写集仍为本人任务记录；没有因为环境缺口改业务契约、TLS 校验或 UI。

### 16.1 新回交替代哪些旧状态

已完整阅读 [C 的 C/TextScope 当前重验回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142794517)（更新于2026-10-13T09:44:08Z）及 [HDL 补验回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6143063168)（更新于2026-10-13T10:00:04Z）。以下是 **C 实测回交**，不是 A 此次独立节点复测：

- C 当前固定部署 cde69ccbd763c3c0ab381a809b750b951f195f64，sourceHash 与 A §15.1 复算一致。C 新 fingerprintHash 为 b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a，validatedAt 为2026-10-13T09:29:47.600Z，ready=true。
- 当前代际来自原控制账本/认证 SSH 验收，C/HDL 同为 synthetic-generation-5944e790-6182-4807-bf21-52534b16271b；synthetic 前缀本身不表示 UI 生成，C 已说明原受控账本来源。A 不把评论中的字符串硬编码进应用，须读取受认证交接并核当前值。
- C 回交原受控宿主已存在的 current-readiness.json、connection.json、runtime-evidence.json；目录/文件权限0700/0600，connection 只引用原 application key/known_hosts。generationFile 用 current-readiness.json 原 data.recoveryGeneration；维护换代后需重新读回，不把文件快照永久视作当前值。
- C 新 Linux 原 lock/npm ci/native SQLite rebuild/typecheck/build 通过；guest58总/55通过/3跳过、认证SSH10/10、HTTP/SQLite36总/34通过/2跳过，再指定真实C1补验2/2无跳过；33份 HTTP 样例来自 app.inject/Session/SQLite，故障transport为合成。原Windows失败保留为历史，不能重复计数或把故障替身叫物理节点。
- HDL 于2026-10-13T09:51:51.930Z追加登记，fingerprintHash 为 ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386；HDL10/10无失败/跳过、C52总/51通过/1跳过，认证汇总 hdlReady/cReady 为true。仅 C 节点验收范围，不等于 A/DL-A 或 UI 正常宿主验收。
- 新完整输出/33份JSON与登记材料尚未推送，C 已给原受控位置和公开摘要。A 收到材料说明，尚未从 PAHER 读取原文件；不能写“原始文件/hash 已独立核验”。不要求将凭据或受控运行配置公开入库。

§15 的“C 本次节点不可达、缺当前代际/重验、HTTP依赖失败”保留其早先时点；作为当前交接状态已被新回交替代。新材料不改变 A §13 的源码/统计，也不宣称旧完整产品验收通过。

### 16.2 A 此次实际检查与执行入口缺口

已 fetch origin；远端 main 仍 cde69cc，PR #53 仍为原 A 独立模块。只读检查 A 当前工具可见环境：wsl --list --verbose 显示 Ubuntu/WSL2 Stopped；Python socket 以3秒上限连接127.0.0.1:2222得到 ConnectionRefusedError。未启动 WSL/VM、未维护节点、未读或复制任何私钥。

这是 **A 当前执行入口的检查**，不推翻 C 在 PAHER 的上述实测，也不能据此认定 PAHER 节点再次停止。现有交接为 PAHER 本机 loopback，无法直接在其他执行环境使用。当前未收到可在 A 工具环境执行的 PAHER 入口、已有正常 XUNJIE_I0_CONFIG 文件位置/精确 HTTPS Origin，及 TLS/签名引用、受控合成账号使用入口。A 已向负责人请求实际执行入口或明确由 C 在 PAHER 代跑，以及既有宿主配置位置；这属于缺失信息，不重复请求原范围实施许可，不请求秘密正文。

真实宿主/自动消费者、浏览器HTTPS和账号交接依赖这些实际材料；不为绕过阻塞创建凭据、启用跨机访问、复制 maintenance key 或忽略证书。其他材料接收、逐 H 汇总和文档/公开回交继续执行。

### 16.3 获得入口后按原批准范围执行

1. 在指定 PAHER 获准运行窗口核 sourceCommit/sourceHash、原 profile、指纹/validation、当前认证 readiness 与原身份 query；对照 C 完整原输出/登记。generationFile 原 data.recoveryGeneration 必须与当前认证响应一致，原 query 不改 identity、不 submit 补跑。
2. 由原受控配置引用已有 TLS/签名/SSH 文件、现有 UI real dist 与当前代际；核精确 HTTPS Origin/PORT、证书主机与有效期/信任、密钥配对及受控文件权限。账号材料仅走原安全通道，公开只给登录入口和使用方式。
3. 仅用 §11 获准的新保留24表合成库，教师经真实 Session/Origin/CSRF 完成检查→确认→分配；记录本人、未分配、暂停、跨学生/课程入口和去敏响应，GET不创建 Attempt。
4. 学生 bootstrap→显式创建→sync→GET权威head→snapshot→run；保持自动消费者运行，确认无需手工 processJob、固定 Run/Job/快照/指纹、原结果/产物。暂停/停止与未知按原 ID 对账，不换键补跑。
5. UI/Robert 消费同一正常 HTTPS 地址、账号安全使用方式与合法 Assignment 深链，先验身份/读取/保存，再验运行/停止/产物；浏览器结果归 UI，不由服务端通过替代。

目前第1～4项 **未执行**；启动命令仍沿 §12 的受控配置方式，占位模板不是实际已存在地址。A 不因 C 已通过而提前勾选这些要求。

### 16.4 当前逐 H 交付状态

| H | 已完成的 A 交付 | A 收尾未完成项 |
| --- | --- | --- |
| H-01 | 正常宿主实现、Session/CSRF与 real dist 合成验证、启动方式 | 实际 HTTPS/现有配置/账号使用入口交付及正常宿主验证 |
| H-02 | 原 Assignment 与 bootstrap、权限/空态合成接口验证 | 实际正常环境的合法分配深链及账号使用交接 |
| H-03 | bootstrap/恢复来源说明；已接收 C 当前受控代际材料 | A 从 PAHER 核原文件和当前认证值，再接正常宿主 |
| H-04 | 原持续消费者/关停对账实现与合成验证；已接收 C/HDL 当前验收 | 正常宿主自动消费者与当前真实 C 节点的组合验证 |
| H-05 | A 版本/暂停合成样例、差异汇总；已接收 C 新实测样例 | TECH §4.3 基线更新待授权维护者，不单方更改 |
| H-06 | A 原公开样例及 C 新33份/真实指定联调摘要已接收并按批汇总 | 取得实际文件后核完整输出，补 A 正常宿主链路样例；浏览器由 UI |

A 在 #30 原回复追加本节最新回交，明确替代早先“C未就绪”当前状态，保留历史。此轮纯交接增量不复跑既有全套业务，不合并/部署；PR #53 仍 Draft，#30/#22 保持 Open。受保护基线与 MVP§10 仍待授权维护者汇总。

本轮文档验证：node tools/a0-review/check.mjs 为64份/924内链/errors=[]，git diff --check 通过；没有源码、依赖、受保护基线、schema、凭据或CI变更。A 当前节点连接检查失败，正常宿主组合/HTTPS业务验证未执行，不能写为已通过。
