# #133 容量与模型验收记录

本文件只记录容量 worker 的独立结果。正式服务 `xunjie-shared` 仍运行 d07；候选产物验证、候选实际运行和正式发布分别记录。共用接入、备份和跨平台结果由 #133 lead 汇总。

## 来源与测量边界

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

首个完整窗口已结束，**延迟验收失败，保留为失败，不覆盖**。steady T0：`2026-10-23T19:30:38.659Z`，结束含 drain/audit：`2026-10-23T19:45:56.910Z`；905 秒 steady，918.251 秒含 drain/audit。runId `0f7e1a3b-edef-409a-ab39-83679606a370`。candidate PID 125046、access PID 125049、formal PID 91972 全程未变，restarts 增量 0。证据根目录为 `~/.codex/artifacts/xj133-capacity/20261024-c896c52-0f7e1a3b/`。

3503/3503 请求精确匹配服务器指标，其中主 harness 3488 项、窗口内额外 DeepSeek 产品 E2E 15 项。普通 API 3484 项，p50 239.548ms、**p95 1090.234ms > 500ms**，max 3140.219ms；non2xx/非预期5xx 均 0。模型原始失败、用户授权的配置变更和后续成功分开保留。下一轮须用经 CI 构建、严格核验、负责人激活的新产物，保留原数据规模再跑完整 905 秒；本地 green、微基准和短预检均不能替代它。

## 真实业务负载

每个学生约五秒一轮：查看会话/课程/assignment、读取 attempt、编辑约 2 KiB 文件并保存、精确回读 hash/version。每十轮重放相同幂等键，检查结果与 revision 不重复增长；每三轮快照，每六轮提交。教师持续查看 workbench，按提交依次写反馈、重放反馈、reopen；学生读取反馈和 recovery 并 resume。复查已提交 artifact 保持固定。

60 秒时 T/S1 各一次真实短模型请求；180/540 秒时两个不同成员向其独立 OSS 目录各直传一个冻结包。真实模型和 OSS 结果分别记录。

## 模型隔离与队列

原正式模型 SQLite 以原生驱动 readonly/query_only 打开，未调用正式 service/store initializer。原 key 只在服务器进程内读取，已启用 Mimo 凭据在进程内解密后，用候选新 key 与新 user/provider AAD 重封装。原配置摘要前后相同，原 context/output 不变；试验配置 8192/512，明文未落文件、日志、argv 或导出 Mac。

原两次 Mimo 产品请求均认证失败。后续两次只读 transport 补验、两次 DeepSeek 产品 E2E 均由用户另行授权，详见下文。controlled-delay 实验另用 c896 artifact 原生产工厂、独立 DB 副本、真实 Session/scrypt/CSRF 和注入 transport，0 真实模型调用；已验证 global2/member1、waiting 零调用预记、取消后实际 Promise settle 前保留 slot、20 项及 32 MiB 账面等待边界，17 个产品请求均成功。不把计数字节边界等同最大图片场景实测。

## 本地工程验证

- teaching typecheck 通过；观测 privacy/error 9/9，0 skip/fail（checkpoint）。
- harness：隐私 parser/projection/服务端 p95 3 项、真实业务工厂新发布/既有不可变 activity 闭环 2 项、资源摘要 1 项均通过，0 skip/fail。
- 源码交接夹具修复 `2e23535ca394c11bf35828af1b362ba2cba2a6c7`：先复现 `SECRET_DETECTED`，改为运行时 synthetic canary，metrics/errors 9/9 和 typecheck 通过；固定 HEAD 默认源码采集 831 文件成功。未修改 guard；该 `.test.ts` 实查不在 c896 runtime，无需重构测量产物。
- harness 模块语法和 Python sampler AST 检查通过。
- 账本性能补丁 `a8a5fa2de6a93b519d8f1ebffa862699f2069301`：typecheck/build，teaching 537 pass/23 既有环境 skip/0 fail，生产模型组合/预算 17/17；默认源码采集 832 文件通过。
- 残余 hydration 补丁 `2b2c2763285ca94cf07cea9295523e764655d0a2`：typecheck/build，records/workspace/review/teacher 相关 157 pass/3 既有环境 skip/0 fail；清理夹具后专属回归 1/1；默认源码采集 833 文件通过。未重复无变化的 student/CLI 全量。

## 真实证据与预算建议

独立 readonly/query_only SQLite 审计：506 次保存、52 次幂等重放、83 次提交/反馈；四个文件最终 hash/documentVersion、保存 receipt 数、submission/feedback 数与 API 记录一致。旧提交仍绑定原快照；integrity=ok，FK failures=0。没有清 DB 或覆盖他人 assignment。两项实际 OSS 直传分别 6,273,409 与 6,274,156 bytes，均 published，约 3.32/3.33 秒，使用不同成员目录和新的幂等键。

资源 182 样本、916.94 秒：candidate 平均 116.34% 单核、最高 5 秒段 154.24%；memory.current 采样最大 150,867,968 bytes。lifetime memory.peak 从 341,946,368 增到 342,757,376 bytes；它包含起点前历史，不能冒称全部来自本轮负载。access current 最大 42,651,648 bytes，lifetime peak 44,593,152。两个候选服务及正式服务均无 PID/restart 变化，OOM/max/high 事件增量 0。host MemAvailable 最低 935,591,936 bytes（约 892MiB），高于 512MiB，无明显 memory pressure。

延迟随时间增长：30 秒桶 p95 从约 120ms 升到 1627ms，和 elapsed 相关 .989、业务 CPU 相关 .789；host CPU pressure 约 26%，IOwait 约 .2–.44%，业务 IO stall 约 .07–.2%，memory stall 0。热点为 workbench、attempt 和 review-context；连小 session 响应也受同步 CPU/事件循环阻塞影响。数据支持先修重复 hydration，不支持靠提高内存限额解决延迟。

初步保留候选业务 512MiB/access 256MiB 做下一轮，避免同时改变量。当前样本不要求业务升到 768MiB；access 128MiB 可作为后续预算候选，尚未应用或在该上限验收。最终正式预算建议仍取决于新产物完整窗口，由负责人应用并读回。

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

precheck2 支持进入新严格产物的完整验收；仍有 workbench 尖峰，不能宣布 905 秒已通过。短验没有真实模型/OSS；它们仍需在下一完整窗口各两项。诊断代码只放 worker scratch，未更改 immutable artifact、managed service、runtime limits 或正式数据。证据为 `precheck-1.json`、`precheck-2.json`；原 905 秒失败证据不变。
