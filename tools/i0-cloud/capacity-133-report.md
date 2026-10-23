# #133 容量与模型验收记录

本文件只记录容量 worker 的独立结果。正式服务 `xunjie-shared` 仍运行 d07；候选产物验证、候选实际运行和正式发布分别记录。共用接入、备份和跨平台结果由 #133 lead 汇总。

## 初始观测来源与固定测量口径

- 观测源码 checkpoint：`c0225bc103c5637afe120bb354c74b2504b97d22`，integration `c896c520a64a40b6860dce279692be5f0481115c`。
- Linux artifact CI：run `40006389514` success。负责人已核对 strict Release binding、tree/archive/file digests、static、Node 24.21.0 和 native SQLite。
- 已校验 immutable root：`/opt/xunjie/candidates/133-c896c52`。构建在 CI 完成，ECS 未源码构建。
- 私有候选配置：`/var/lib/xunjie/capacity-133/application.json`；保留既有教学 DB/TLS/Origin 和动态账号控制。
- 五个容量专属身份：T、S1–S4，分别真实 enroll 的 member/device/应用账号及独立 Session；不复用 fresh 平台验收成员。
- 复用课程既有不可变 C activity，通过真实 API 为四个容量学生新建不同 assignment/attempt；账号所属课程 `synthetic-textscope-c`，不修改他人记录。候选未登记执行节点，新项目 checks 会正确返回 `RUNTIME_NOT_READY`，本轮不新建执行基础设施。
- 905 秒 steady window；首次正常登录、项目准备、收尾另记时间。一次登录后持续正常操作，不重复登录冲击账号/IP限流。
- 普通 API p95 取服务器 Fastify `onResponse` 的 `elapsedTime`，由服务器生成的 requestId 对齐；包含正常 login/scrypt。客户端 RTT 单列，不能替代缺失服务端数据。
- 日志只保留 requestId、method、route 模板、status、durationMs。harness 不持久化 raw URL、headers/body、凭据、模型回复或签名 URL。

## 当前验收状态

最终 e03 候选五人完整窗口 **PASS**，main 已独立重算 raw metrics、资源和 DB/hash/base+delta/history/模型/OSS，结果同样通过。此前 c896、70d 的失败和短诊断分别保留，不合并请求量或测试数，不用短测代替 905 秒。

| 完整窗口 | 来源/flags | 匹配响应/ordinary | ordinary 服务端 p95 | 结论 |
| --- | --- | ---: | ---: | --- |
| `0f7e1a3b` | c896 / 默认 flags | 3503 / 3484 | 1090.234ms | FAIL，含原 Mimo 失败及授权 DeepSeek 补验 |
| `6e9a5416` | 70d / 默认 flags | 3227 / 3219 | 1053.110ms | FAIL，模型 2/OSS 2/DB 通过不能抵消延迟失败 |
| `62779aba` | e03 / ss16 | 3097 / 3089 | 262.266ms | PASS，含正常登录和完整 workbench |

正式 `xunjie-shared` 仍为 d07；e03 的候选验收不表示正式 main 已发布。本 worker 未应用资源预算或修改正式服务，预算持久化及读回由 main/lead 单独记录。

## c896 完整窗口（保留失败）

steady T0：`2026-10-23T19:30:38.659Z`，结束含 drain/audit：`2026-10-23T19:45:56.910Z`；905 秒 steady，918.251 秒含 drain/audit。runId `0f7e1a3b-edef-409a-ab39-83679606a370`。candidate PID 125046、access PID 125049、formal PID 91972 全程未变，restarts 增量 0。证据根目录为 `~/.codex/artifacts/xj133-capacity/20261024-c896c52-0f7e1a3b/`。

3503/3503 请求精确匹配服务器指标，其中主 harness 3488 项、窗口内额外 DeepSeek 产品 E2E 15 项。普通 API 3484 项，p50 239.548ms、**p95 1090.234ms > 500ms**，max 3140.219ms；non2xx/非预期5xx 均 0。模型原始失败、用户授权的配置变更和后续成功分开保留。该轮延迟验收失败，不因后续通过而覆盖；本地 green、微基准和短预检均不能替代完整窗口。

## 真实业务负载

每个学生约五秒一轮：查看会话/课程/assignment、读取 attempt、编辑约 2 KiB 文件并保存、精确回读 hash/version。每十轮重放相同幂等键，检查结果与 revision 不重复增长；每三轮快照，每六轮提交。教师持续查看 workbench，按提交依次写反馈、重放反馈、reopen；学生读取反馈和 recovery 并 resume。复查已提交 artifact 保持固定。

60 秒时 T/S1 各一次真实短模型请求；180/540 秒时两个不同成员向其独立 OSS 目录各直传一个冻结包。真实模型和 OSS 结果分别记录。

## 模型隔离与队列

原正式模型 SQLite 以原生驱动 readonly/query_only 打开，未调用正式 service/store initializer。原 key 只在服务器进程内读取，已启用 Mimo 凭据在进程内解密后，用候选新 key 与新 user/provider AAD 重封装。原配置摘要前后相同，原 context/output 不变；试验配置 8192/512，明文未落文件、日志、argv 或导出 Mac。

原两次 Mimo 产品请求均认证失败。后续两次只读 transport 补验、两次 DeepSeek 产品 E2E 均由用户另行授权，详见下文。controlled-delay 实验另用 c896 artifact 原生产工厂、独立 DB 副本、真实 Session/scrypt/CSRF 和注入 transport，0 真实模型调用；已验证 global2/member1、waiting 零调用预记、取消后实际 Promise settle 前保留 slot、20 项及 32 MiB 账面等待边界，17 个产品请求均成功。不把计数字节边界等同最大图片场景实测。

## 本地工程验证

以下均为各自 checkpoint 的结果，存在重复覆盖，不相加；skip 不是通过。

- teaching typecheck 通过；观测 privacy/error 9/9，0 skip/fail（checkpoint）。
- harness：隐私 parser/projection/服务端 p95 3 项、真实业务工厂新发布/既有不可变 activity 闭环 2 项、资源摘要 1 项均通过，0 skip/fail。
- 源码交接夹具修复 `2e23535ca394c11bf35828af1b362ba2cba2a6c7`：先复现 `SECRET_DETECTED`，改为运行时 synthetic canary，metrics/errors 9/9 和 typecheck 通过；固定 HEAD 默认源码采集 831 文件成功。未修改 guard；该 `.test.ts` 实查不在 c896 runtime，无需重构测量产物。
- harness 模块语法和 Python sampler AST 检查通过。
- 账本性能补丁 `a8a5fa2de6a93b519d8f1ebffa862699f2069301`：typecheck/build，teaching 537 pass/23 既有环境 skip/0 fail，生产模型组合/预算 17/17；默认源码采集 832 文件通过。
- 残余 hydration 补丁 `2b2c2763285ca94cf07cea9295523e764655d0a2`：typecheck/build，records/workspace/review/teacher 相关 157 pass/3 既有环境 skip/0 fail；清理夹具后专属回归 1/1；默认源码采集 833 文件通过。未重复无变化的 student/CLI 全量。
- scoped hydration `9c7f488`：typecheck、相关 165 pass/3 skip、target 14/14；Spec 另行确证跨 attempt receipt 的 `payloadRef` fallback 漏洞后，`3d3d3ca` 直接回归先红后绿，相关 165 pass/3 skip、target 13/13。两个 target 集合不同，不相加；3 skip 为原 Linux/C1 runtime 条件未满足。P2 修复保留真实对象 fallback、同课/shared 查询边界和原完整行校验。
- 最终 composite `e03a3c9035282683c1fdcba0d5b5746b8c256587`：main 独立报告 teaching 556 pass/23 skip/0 fail、typecheck/build 和 collector 841 files/6,276,679 bytes 通过，两轴 P2 closed。该工程结果与本 worker 实机容量测量分别记录。

## c896 失败窗口的业务与资源证据

独立 readonly/query_only SQLite 审计：506 次保存、52 次幂等重放、83 次提交/反馈；四个文件最终 hash/documentVersion、保存 receipt 数、submission/feedback 数与 API 记录一致。旧提交仍绑定原快照；integrity=ok，FK failures=0。没有清 DB 或覆盖他人 assignment。两项实际 OSS 直传分别 6,273,409 与 6,274,156 bytes，均 published，约 3.32/3.33 秒，使用不同成员目录和新的幂等键。

资源 182 样本、916.94 秒：candidate 平均 116.34% 单核、最高 5 秒段 154.24%；memory.current 采样最大 150,867,968 bytes。lifetime memory.peak 从 341,946,368 增到 342,757,376 bytes；它包含起点前历史，不能冒称全部来自本轮负载。access current 最大 42,651,648 bytes，lifetime peak 44,593,152。两个候选服务及正式服务均无 PID/restart 变化，OOM/max/high 事件增量 0。host MemAvailable 最低 935,591,936 bytes（约 892MiB），高于 512MiB，无明显 memory pressure。

延迟随时间增长：30 秒桶 p95 从约 120ms 升到 1627ms，和 elapsed 相关 .989、业务 CPU 相关 .789；host CPU pressure 约 26%，IOwait 约 .2–.44%，业务 IO stall 约 .07–.2%，memory stall 0。热点为 workbench、attempt 和 review-context；连小 session 响应也受同步 CPU/事件循环阻塞影响。数据支持先修重复 hydration，不支持靠提高内存限额解决延迟。

当时初步保留候选业务 512MiB/access 256MiB 做下一轮，避免同时改变量。该失败样本不要求业务升到 768MiB；access 128MiB 仅是当时的后续预算候选，未在该上限验收。最终建议见 e03 完整窗口，由负责人应用并读回。

所有最终结果引用受限 evidence 目录的非秘密投影；不提交私有配置或账号材料。业务 512/768 MiB、接入 128/256 MiB 和 host available ≥512 MiB 的建议以负载窗口测量为依据；正式预算由负责人应用并读回。

## 保留的失败与边界

- 首次启动 `0eee37c3...`：admin 别名 SSH 转发被 `administratively prohibited` 拒绝，TLS 得到 `ECONNRESET`；0 业务请求、0 steady 秒，保留原 run/launch/diagnosis/resource 记录。改为五个独立已登记成员的官方受限 SSH 转发，五个 health/source 均通过。
- 第二次 `ffaf41ca...`：18 请求、1 个 setup 422、0 unexpected5xx、0 steady 秒；`POST /api/blueprints/:id/checks` 安全错误码 `RUNTIME_NOT_READY`。候选 executionNodes=[]，符合产品拒绝未就绪发布的边界；改为复用已有不可变 activity 后，真实 API 新建本轮专属 assignments。未修改服务/DB以绕过发布检查。
- 本轮两个产品 Mimo turn 均 `PROVIDER_AUTHENTICATION_FAILED`、calls=1、usage unknown，不能按 turn 创建 200 记互操作成功。进程内等值核对确认新 credential 与两份原 enabled selection 一致，不是重封装内容改变。
- 负责人随后授权两项额外只读 transport 短补验：Mimo 复现 HTTP401；既有 DeepSeek-flash 同一 c896 transport 返回 OK，usage actual 37 input/22 output。原 store/service 未初始化，配置不改，无自动重试。它证明 DeepSeek transport 互操作，不能替代产品内调用成功。补验进程时间 `19:35:01–19:35:02Z` 在 host 资源窗口内单列。
- `2026-10-23T19:41:11.957Z`（T+633.298s），用户授权仅对两个 capacity-owned 候选账号改为服务器进程内重封装的 DeepSeek provider，revision1→2，8192/512。原正式 settings digest 不变；application.json、artifact source、PID 不变，无重启。不能声称整个窗口模型账号设置固定。
- 19:42 窗口内两次真实 HTTPS Session→POST turn→settled 均 exactOK、calls1；actual usage 分别 82 input/16 output 与 82 input/33 output。它们才是本轮 DeepSeek 产品 E2E 成功证据。原两项 Mimo 失败仍保留。

## 性能修复与短预检

固定 readonly 一致副本 `/var/lib/xunjie/capacity-133/perf-0f7e1a3b/synthetic.sqlite` 含 1103 course receipts、844 public bindings、5 attempts。原 c896 reader 22 次读取共 5926ms（SQL459ms），`a8a5fa2` 后 2594ms；workbench 的全 workspace hydration 子树仍需 454/470ms。

`a8a5fa2` 复用一份 JSON schema，但每次读取继续验证每个 receipt，并为本次读取建立 receipt/event owner Map。后续 `2b2c276` 对 binding→receipt 建立本次读取内 Map，并在同一已授权同步 workbench 事务只完整读取/验证一次课程账本。每个 attempt 的文件、快照、runs、提交、grant 及关联校验全部保留；新请求重新读取，不跨请求缓存，不绕过权限或持久化。

两次短预检都使用同一原始副本的独立 clone、原 c896 模块图和明确的单文件诊断 overrides，通过真实 HTTPS、5 个真实 scrypt/Session/CSRF。40 秒、原 5 秒节奏、600ms 学生错峰、包含 workbench/保存/快照/提交反馈/reopen/resume，并额外同时发起教师 workbench+四学生 attempt 请求。每次 212/212 server metrics、0 non2xx/5xx，正常 login 也计入整体：

| 隔离诊断版本 | 普通 API p95 | workbench 中位数 | workbench p95（9 样本，含五同时 burst） |
| --- | ---: | ---: | ---: |
| a8a5fa2 only | 460.129ms | 499.312ms | 1182.841ms |
| +2b2c276 hydration | 332.875ms | 169.010ms | 782.469ms |

precheck2 只支持当时进入新严格产物的完整验收；其 workbench 尖峰仍存在，不能据此宣布 905 秒通过，随后 70d 实机仍失败。短验没有真实模型/OSS。诊断代码只放 worker scratch，未更改 immutable artifact、managed service、runtime limits 或正式数据。证据为 `precheck-1.json`、`precheck-2.json`；原 905 秒失败证据不变。

## 70d 完整窗口与实际 cgroup 诊断（保留失败）

runId `6e9a5416-e0b1-4866-8f5d-a4513687dee7`，source `70d170ab6a7665a973d514b28eedb5a0532d17ee`；证据 `~/.codex/artifacts/xj133-capacity/20261024-70d170a-6e9a5416/`。steady `2026-10-23T21:14:32.768Z` 至 `21:29:56.575Z`，923.807 秒含 drain；3227/3227 匹配、ordinary 3219、p95 **1053.110ms，FAIL**。请求均成功，465 次保存、77 组提交/反馈、模型 2/OSS 2/独立 DB 审计通过；candidate/access/formal PID 131947/131948/91972 不变、restart/OOM 0。业务平均 CPU 125.579% 单核，current 采样最大 173,834,240 bytes，lifetime peak 356,442,112；host MemAvailable 最低 957,906,944 bytes。不能把空闲/短副本结果当作 managed 负载结论。

main 在 actual PID 上的只读短 CPU profile：idle 阶段 98.29% idle，后台 original-job-host 约 0.12%；active GC 占 wall 13.19%，约非 idle 的 35%，热点为重复 persisted/readRecords/readWorkspaceRecords/Zod。只监听 loopback 的 Inspector 已关闭。实际 512MiB cgroup 内 Node heap limit 271,581,184 bytes、new-space 当时 1MiB；unconstrained fresh Node heap limit 1,013,448,704 bytes。它解释了诊断环境差异，不单独证明调 flag 必过。

main 串行运行同 512MiB、同 seed SHA `953751236860111f5e21d97e29eaf16b5e154e033685622b213ce0acbed8563c` 的 exact 70d 短混合 A/B；2124 receipts、7 attempts、326 snapshots、161 submissions/feedback 保留。server、HTTPS clients 与 harness 同进程、同 cgroup，峰值不能等同 managed server-only：

| 短 copy 版本 | ordinary n / p95 | mixed 含 drain | GC 次数 / time | cgroup peak |
| --- | --- | ---: | ---: | ---: |
| 70d default | 207 / 1239.304ms | 66.598s | 17212 / 20.757s | 347,348,992 bytes |
| 70d ss16 | 208 / 774.646ms | 48.954s | 1328 / 8.965s | 380,678,144 bytes |
| exact e03 ss16 | 228 / 343.407ms | 44.005s | 470 / 2.713s | 389,853,184 bytes |

70d 两项 A/B 均不达标，未继续扫描 ss8；保留 ss16 后，采用显式 attempt scope 读取：保留无 attempt 课程起点/关联闭包、全局 generation/key/alias/serverSeq、合法跨 attempt evidence、完整 teacher-workbench 路径及所选行完整 schema/关联校验，不引入跨请求 cache。`3d3d3ca` 再补齐事件所引用的同课 shared receipt 校验。e03 通过 CI `40035400632` 严格预取/摘要/native SQLite 后，main 先跑 exact artifact 短 copy，228/228 all200/missing0、旧历史和写审计/seed unchanged；它只提供进入完整窗口的余量，`capacityAcceptance=false`，没有真实模型/OSS。旧 A/B 三文件和各轮 evidence 未改，没有 ECS 源码 build 或 loader 冒充产物。

## e03 最终完整窗口（通过）

- runId：`62779aba-a131-476b-ab7b-bf5fdedd3de2`，steady `2026-10-23T22:56:09.246Z` 至 `23:11:23.691Z`，**914.445 秒**；首次正常登录和 drain 均纳入相应指标/资源 envelope。
- source：`e03a3c9035282683c1fdcba0d5b5746b8c256587`，tree `299b5c885947fdd8f93b174e84250b50b96153a0`，root `/opt/xunjie/candidates/133-e03a3c9`；cfg `/var/lib/xunjie/capacity-133/application-e03a3c9.json`，SHA `14cd7c609a1656d558558e18b37a50da1f266f76a841e9575d86e26d2d0a6567`，Node 24.21.0 / `--max-semi-space-size=16`。
- harness 从主验证 WT 固定 detached e03 运行，主脚本 SHA `5198feda7618fff2ad447771b624f2dcf2365b636bf5f35a79e9fc3dbd67921e`。起终 HEAD/文件、运行 source/config/flags/PID 均核对一致。原四 attempt 从 6e9a hashes/version/base 续接，不清历史、改 cadence 或缩小路由口径；模型 revision2 整窗未变。
- **3097/3097** 响应精确匹配，missing/duplicate 0，全部 200。ordinary **3089**（含 5 次正常 scrypt login 与完整 workbench），服务端 p50 117.761ms、**p95 262.266ms**、max 879.646ms。GET workbench 129 条，p95 401.488ms/max 551.680ms；login 单独 p95/max 879.646ms，未从整体排除。完整分路由分布在 `server-summary.json`。
- 436 次新增保存、45 次幂等重放、144 次快照、71 次提交和 71 条反馈；四文件的 hash/version、receipt 数、submission/feedback 数与 base+delta 精确一致。独立 readonly/query_only integrity=ok、FK=0。旧 2124 receipt/audit、326 snapshot、161 submission/feedback 逐行 hash：missing0/changed0，增长到 3059/3059/470/232/232；sealed seed 未变。
- 两项真实 DeepSeek 产品 E2E 均 settled/exactOK、各 calls1；actual usage 分别 83 input/14 output 与 83 input/12 output，不以创建 turn 的 200 或 transport probe 替代。两笔 OSS 直传 6,273,409/6,274,156 bytes 均 published，耗时约 3.65/3.22s。
- 184 个窗口资源样本、923.852 秒 envelope 覆盖 login+load+drain。candidate/access/formal PID 142780/142786/91972 均不变、restart/OOM/high/max 增量均 0。业务 current 采样 max 178,180,096 bytes、p95 176,529,408；cgroup peak 从 210,960,384 增至 **345,141,248 bytes（329.15MiB）**，保留了 5 秒采样可能漏过的短认证峰值。业务平均 CPU 48.986% 单核；接入 current max 43,728,896、peak 44,814,336 bytes；host MemAvailable 最低 **953,126,912 bytes（908.97MiB）**，memory pressure total 仅增 1µs。

证据根：`~/.codex/artifacts/xj133-capacity/20261024-e03a3c9-62779aba/`。main 的 `main-independent-verdict.json` 已独立复算 raw184样本、全部3097匹配、DB/hash/base+delta/history、模型/OSS并判 PASS；worker 的 `capacity-verdict.json`、最终报告、停止回执和 seal 分别保留。一次中途只读 journal 30 秒超时单独记录；最终安全投影完整取回，不重跑或删去失败记录。

建议业务 **MemoryHigh384MiB / MemoryMax512MiB** 并保留已测 ss16，无需本场景升至768MiB；接入 **MemoryHigh128MiB / MemoryMax256MiB**。这是五人业务、两短模型和两次直传的预算建议，应用/持久化/读回由 main/lead 独立完成，不在本轮 worker 测量结果中冒称已应用。

负载 PID47473 已退出，采样 PID143246 已确认身份后停止，所有分支已 executionDrained，额外云审计也已结束。之后只做本地证据封存和本文件编辑；不再起负载、模型或 OSS。五 actors 的私有 home/端口等待 main 统一清理，本 worker 不自行撤销，不改正式 main/服务/limits 或有效恢复材料。
