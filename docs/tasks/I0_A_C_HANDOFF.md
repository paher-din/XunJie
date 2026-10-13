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
      "reasons": {"individual": null, "activity": null},
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
