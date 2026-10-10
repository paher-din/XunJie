# A1：应用基础、权限与短事务实施记录

主责：A。任务：[Issue #10](https://github.com/paher-din/XunJie/issues/10)；协调：[G1 #9](https://github.com/paher-din/XunJie/issues/9)，接缝：[C2 #14](https://github.com/paher-din/XunJie/issues/14)。开始日期：2026-10-09，最新批次：2026-10-10（Asia/Shanghai）。开始基线：bc1d466a073521235e54cb6995bfcc476619fafd。

状态：**§12～14 准确批准的工程、当前 Session/课程/资源授权、十七表新合成库、实际 C 记录同事务适配已实现；最新独立 typecheck/build/回归 112 通过、0 失败、5 跳过（117 项）。两轴审查各发现 1 项 P2，已修复、验证并增量复核关闭；当前 Standards 硬违规/可操作异味 0/0、Spec 未解决 0。真实账号/私有 HTTPS/生产初始化/可靠恢复和 UI/真人保持原后置条件；完整 G1 未完成。准确批准服务端范围已收口，正在分别交付 PR；较新真实联调接收事实见 §14.4。§8～13 原首批/待批/失败状态保留历史范围，以 §14 较新事实为准。**

## 1. 已读依据与本批授权

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按 [PRD](../product/PRD.md) §1/3/5/8/9 → [MVP_SPEC](../product/MVP_SPEC.md) M-02/M-10、§4/5/6/8/9 → [TECH_DESIGN](../product/TECH_DESIGN.md) §2/3/5/7/9/10/12 阅读当前 v0.3 基线；读取 [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md) A1/首批责任与 [G0 批准](G0_CLOSURE_PROPOSAL.md#10-2026-10-09-负责人统一裁决及基线同步) §7/10，以及 Issue #10 的完整正文。

G0 已批准 A1-P1 工程/入口/公共校验/错误/健康状态。2026-10-09 项目负责人在核对新 Issue 后指示“开始”，本批按该范围实施。原 A0/B0/C0 作者稿保留历史作用，不能覆盖当前正式契约。

可写：apps/teaching 内 A 负责的 package/锁文件/tsconfig、server/app、contracts/common、tools 和 tests；本任务文档与 README 导航/启动/验证说明。product/planning/reference/AGENTS 和 B/C/UI 领域只读。旧工作副本的草案不暂存、不提交、不覆盖。

## 2. P1 实现范围与技术细化

批准版本：Node 24.21.0、TypeScript 7.0.2、Fastify 5.12.5、Zod 4.6.5、better-sqlite3 13.0.3、ai 7.0.136、@ai-sdk/deepseek 3.0.63，package 使用精确版本并提交 lock。为批准的 Node/TypeScript 提供编译所需 @types/node 24.19.1，类型辅助依赖不改变后台栈。驱动/AI 包仅作为共享工程安装，不实例化数据库或供应商客户端。Node 官方便携包校验后用于本批；不替换系统 Node、不配置 .env/凭据/CI。

| 入口/能力 | 本批行为与验证边界 |
| --- | --- |
| createApp | 可关闭的 Fastify 实例，B/C 后续可注册其领域路由；创建时不绑定端口、不打开 DB/队列/模型 |
| GET /health/live | 200，进程入口可响应；服务端生成 requestId，成功包裹为 requestId/data |
| GET /health/ready | 当前明确 503；DB/模型/runner 尚未接入不能返回 ready。后续按实际能力另实现就绪检查 |
| 公共请求校验 | Zod 安全解析，错误不回显字段值/校验原文；纯解析不证明身份、归属或当前状态 |
| 公共错误 | 只使用 TECH §5.1 已批准错误码与恢复字段；解析/未知入口为 400 INVALID_REQUEST，超限为 413 CONTENT_LIMIT，未处理服务失败为 503 DEPENDENCY_UNAVAILABLE；不单方增加 404/500 码 |
| requestId/日志 | 忽略客户端指定追踪 ID，逐次服务端随机 ID；响应关联一致；错误/日志不输出请求正文、cookies、凭据、原始异常堆栈或路径 |
| 启动 | 本机 127.0.0.1，默认端口 3000，PORT 严格检查；关闭释放监听端口；无业务或用户数据 |

健康路径为 P1 技术入口细化；不变更已批准业务路由/权限。ready 固定拒绝体现尚未实现事实，不能把 alive 当作品链可用。当前无真实授权接口，未知路由返回 400，不反射 URL 或判断资源是否存在；不提供模拟登录或身份切换。增加独立 404/500 码需另提共享契约确认，本批不采用。所有错误 retryable=false，依赖失败未知结果需先核对原请求，不自动重试。

不实现：Session/账户/权限持久化、schema/SQL/迁移、withTransaction 真数据库能力、C 的 Job/Receipt/Event、AI 调用、执行器或 UI。P2/P3 先交实际存储/认证方案及对象/风险/授权记录，C2 首批真实接缝到位后再实施，不把驱动安装或测试替身当原子性证明。

## 3. 约定验证入口与步骤

本批测试边界来自已批准 P1 与 Issue #10 的公共校验/错误/健康/启动验证范围；项目负责人“开始”沿用该范围，不重复要求确认相同边界。按 TDD 对公开 HTTP（Fastify inject/实际监听）和共享解析接口逐片验证，测试中额外路由仅为合成测试夹具，不注册到实际应用。

计划：
1. 先记录并运行 liveness 失败测试，再实现实例/健康接口。
2. 验证 readiness 明确不可用；请求 ID 不由客户端伪造。
3. 逐片验证合法/非法输入、非法 JSON、超限、未知路由、预期/未处理错误及正文/凭据/路径不泄露。
4. 实际安装、typecheck、build、全套 Node 测试及实际 HTTP 启动/关闭；安装/运行使用批准 Node。
5. 独立 Standards/Spec 审查，修复问题后同步实际结果与 README；本地提交包含任务记录。

NFR-04/AC-02 的真实身份、跨课程/学生、私有资产和持久幂等用例留待 P2/P3 与 A2/C2，当前标记未执行；本批结果不计为完整 AC-02/NFR-04/G1 通过。数据库、模型/费用、隔离、浏览器、真人与性能业务验证均未执行。

## 4. B/C 交接与后续边界

A 维护共享 package/lock/tsconfig、server/app 与 contracts/common。B 在 server/tutoring/contracts/tutoring，C 在 server/workspace/records/contracts/workspace/records/runner 交付；所需共享依赖由 A 按批准范围汇总。后续复用 app 与公共错误/校验；不另建第二应用/队列，不把客户端 role/studentId 解析通过当授权。

C2 当前可与 A 对齐 tx/Job/Receipt/Event 的批准契约，P1 没有 tx 实现可供真实联调。数据库对象、连接/短事务和失败回滚在 P2/P3 的具体授权后交付；网络/模型/执行等待始终在事务外。

## 5. 实际进展与验证记录

### 5.1 代码交付

| 位置 | 实际内容 |
| --- | --- |
| [package](../../apps/teaching/package.json)、[lock](../../apps/teaching/package-lock.json)、[运行版本](../../apps/teaching/.node-version)、[npm 配置](../../apps/teaching/.npmrc) | 精确版本、engine-strict、安装/编译/测试/启动入口；test 自动先编译 |
| [类型检查配置](../../apps/teaching/tsconfig.json)、[编译配置](../../apps/teaching/tsconfig.build.json)、[运行检查](../../apps/teaching/tools/check-runtime.mjs) | strict 检查与 Node 精确版本拒绝；编译 .ts 导入到 .js，测试/构建产物分离 |
| [app](../../apps/teaching/server/app.ts)、[main](../../apps/teaching/server/main.ts)、[PORT 校验](../../apps/teaching/server/app/config.ts) | 仅本机 HTTP 健康入口、服务器生成关联 ID、安全错误/日志、启动/关闭 |
| [公共信封与错误](../../apps/teaching/contracts/common/http.ts)、[错误构造](../../apps/teaching/server/app/errors.ts)、[Zod 解析](../../apps/teaching/server/app/validation.ts) | 已批准码集/恢复字段与安全解析；Fastify 原生 schema 校验禁用静默删字段/类型强转/补默认值 |
| [tests](../../apps/teaching/tests/) | 14 个合成测试，HTTP、私有内容 canary、编译入口/监听/释放端口；不是持久权限验证 |

Fastify 本批保留默认 HTTP 正文限制；超限映射为 CONTENT_LIMIT。尚无文件同步/上传路由，后续 C 的领域路由需核对传输体积与原始内容限额，不把传输默认值当作产品源码/资料限额。测试的 32 字节限额只是合成路由夹具。

### 5.2 实际命令与结果

环境：Windows x64，官方 Node 24.21.0 便携运行时（SHA-256 与官方 SHASUMS256.txt 核对通过），附带 npm 11.19.0；工作分支 codex/a1-foundation。仓库不依赖此次便携运行时的个人路径，其他成员安装同版本后执行仓库相对命令。依赖版本先对 npm 官方 registry 元数据核对存在/引擎，再实际安装，不改变批准栈。

以下 npm 命令在 apps/teaching 中，文档检查在仓库根目录运行：

| 检查 | 实际结果 |
| --- | --- |
| npm install --no-audit --no-fund | 通过，66 个包安装；不是原生 DB/真实模型验收 |
| npm install --package-lock-only --ignore-scripts --no-audit --no-fund | 通过，仅刷新新增 pretest 脚本后的锁文件元数据，不作为安装验证 |
| npm ci --no-audit --no-fund | 通过，66 个包按 lock 重新安装，精确运行检查通过；附下述原生脚本限制 |
| npm ls --depth=0 | 通过，5 个运行依赖与 TypeScript/@types/node 均为本节精确版本 |
| npm run typecheck | 通过，无跳过库检查或关闭类型规则 |
| npm run build | 通过；最终 npm test 的 pretest 再执行并通过 |
| npm test | **14/14 通过**；含 compiled main 的真实子进程/loopback HTTP 与 app.close 后同端口重新监听 |
| node tools/a0-review/check.mjs | 通过，23 份文档、200 处仓库引用、27 条正式变更接口；结果 businessTests=NOT_EXECUTED |
| node --test tools/a0-review/check.test.mjs | **16/16 通过**；仅文档检查器回归，不计入应用业务通过数 |
| Git 空白/范围与独立 Standards/Spec 审查 | 通过；19 个改动文件仅在批准范围，无受保护基线或其他模块变更，无生成文件入库；两轴各 0 项 |

系统 Node 24.15.0 执行 `node tools/check-runtime.mjs` 实际被拒绝（预期退出码 1，仅输出批准/实际版本）；使用批准运行时的安装、检查、测试与编译均通过。

npm ci 报告 better-sqlite3@13.0.3 的 node-gyp 原生构建脚本未获 allowScripts 放行。本批未执行该脚本，也未加载驱动/打开 DB/执行 SQL；仅安装 JS 工程及驱动包，不宣称原生 DB 已可用。P2/P3 交付实际存储方案时明确原生构建授权/环境并核 sqlite_version、外键/WAL/回滚，不能忽略此限制或静默换驱动。

关闭验证的边界：直接 app.close 已验证释放真实监听端口；编译入口退出清理在 Windows 使用终止子进程。SIGINT/SIGTERM 优雅关闭处理已实现，但 Linux 信号路径未执行，不把 Windows 进程终止算作 Linux 优雅关闭验收。

### 5.3 失败与修复记录

TDD 实际红灯：缺 app/config/validation 模块和 main 入口；ready 返回默认 404；非法 JSON/超限/媒体格式被当作服务失败；未知路由默认回显 URL；内部失败缺少安全关联诊断。逐项增加实现后对应单文件测试通过。请求 ID、领域冲突、实际 app.listen/app.close 和 compiled main 为既有行为回归测试，未声称它们都曾红灯。

类型检查曾因 Fastify 未导出的日志类型、err serializer 必需字段、error 的 unknown 类型与真实 fetch JSON 的 unknown 类型失败；改为实际支持的结构类型、固定脱敏 serializer、类型收窄及测试端响应 schema 后通过。Fastify 旧日志选项产生弃用提示，改为当前 LogController API，没有关闭警告。

初稿曾加入未列入 TECH §5.1 的 NOT_FOUND/INTERNAL_ERROR 公共码；交付前规格复核移除，统一使用正式码集并同步测试/本任务说明，不以任务稿单方冻结新码。未改产品规格以迁就实现。

### 5.4 未完成与下一步

独立审查和最终范围检查已完成。实现提交 4bd8062 保存在 codex/a1-foundation，本记录的收口随第二个本地文档提交交付；未推送或创建 PR。工程入口和公共解析/错误供 B/C 本地评审接入，实际远程交接未完成；C2 的真实 tx/Job/Receipt/Event 接缝尚未联调。P2/P3 初步操作方案见 §6，具体授权与 C2 条件满足后再实施。SQLite/认证/真实权限/幂等/并发、AI/费用、专用执行隔离、浏览器/真人及性能业务验证均**未执行**。Issue #10/#9 保持 Open，不计完整 AC-02/NFR-04/G1 通过。

### 5.5 独立审查

固定基线 bc1d466a073521235e54cb6995bfcc476619fafd，候选 4bd8062667497d47d21a7be59aafa61dfefada4f；完整 git diff bc1d466a073521235e54cb6995bfcc476619fafd...HEAD。两个只读审查分别读取仓库规范和正式规格/Issue #10，不重复安装或修改文件。

Standards：0 项。批准范围、文档同步、日志/错误脱敏与未执行记录符合规范，未发现可操作异味；审查后补齐本节提交/范围事实。

Spec：0 项。覆盖本批工程/入口/解析/错误/健康/验证说明，没有把后置认证/SQL/真实业务写成完成；ready 与批准错误码集符合本批范围。

P1 两轴各 0 项，无阻断问题。后补 §6 仅为未实施的操作方案初稿，没有因此改变 P1 实现或授权范围。两轴对文档增量复核：Standards 0 项；Spec 发现 1 处后续教师纠正验证依赖表述不准确，已把通用 CAS 与 A4/C3/B3 的正式纠正并发分别列明，Spec 独立回读确认修复。最终未解决发现：Standards 0、Spec 0。

## 6. P2/P3 实际操作方案初稿（待具体授权与 C2 对齐）

以下是 Issue #10 后续审批的对象、操作和验证清单，不是 schema、操作脚本、共享接口定稿或执行授权；未创建目录/数据库/账号，未批准新依赖。依据 TECH §4/5.1/7.2.1/9/10.1/12。

| 阶段与对象 | 拟执行范围 | 风险与进入条件 | 交付证据 |
| --- | --- | --- | --- |
| 原生驱动/合成存储 | 核 better-sqlite3 安装脚本，获准后仅构建已固定版本；以 os.tmpdir 下独立 xunjie-a1-p2 随机目录创建专用 synthetic.sqlite，禁止打开既有或真实 DB | 原生构建执行本机代码；建库/建表命中红线。确定安装脚本、创建目录/文件和清理范围后授权；不更换驱动/宿主配置 | 实际加载、sqlite_version 已修复 WAL 版本、foreign_keys/WAL/busy_timeout 与拒绝/回滚；失败留事实 |
| A 的身份与归属 | 合成 User/CourseMembership/Session；密码哈希参数/逐账号 salt，Session 只存安全随机 token 的摘要、创建/最后活动/撤销时间；角色来源为数据库课程成员 | 表与索引仅覆盖 A 的账户/归属，课程/资源/Attempt 的 FK 和查询入口先对齐 C2；不批量建全产品模型。成熟会话组件/依赖、scrypt 参数与失败窗口尚需核验后确认 | 预置合成教师/两课程/两学生，最长 8 小时和空闲 30 分钟，退出/撤销/过期拒绝；凭据不入源码/日志/回执 |
| 授权与短事务 | authorizeResource 按可信 Session→课程成员→资源可见性→阶段/命令检查；withTransaction 提供同连接同步短事务，由 C2 同 tx 接纳回执/Job/Event | 不以请求 role/studentId、ID 难猜或客户端 hash 代替授权；不得跨连接双写。网络/模型/runner 等待在提交外 | 真实数据库失败注入全回滚；C2 联调证明业务结果/回执/事件一致提交，进程重启仍可回取 ACK 结果 |
| 登录入口与请求防护 | 登录/退出/当前会话及既定读/写入口复用授权，Origin/CSRF/失败限流；HttpOnly/Secure/SameSite，禁止 localStorage 长期凭据 | 精确会话组件和配置待确认，不在本批安装。合成受控本机联调不得变成真人入口；私有 HTTPS/VPN、实际 cookie 策略和发放通道另落实 | 未登录/伪造身份/跨范围/非任课教师/Origin/CSRF/限流拒绝，错误和登录诊断不泄漏账号存在性/秘密 |
| 恢复与后续交接 | A 与 C2/后续 C5 对齐恢复代际、会话失效、原请求回取和唯一约束，向 A2 提供真实授权/tx 接缝 | 旧备份回退、覆盖或删除另授权；不在本批恢复数据库或重新写历史 | A1 的持久回放/冲突/旧版本与竞争测试，A2/C2 接缝证据；完整恢复演练仍归 C5 |

先在独立合成数据库验证，批准本方案也不包含真实账户/学生数据、生产路径、凭据发放、.env/CI/部署或对既有数据库的迁移。唯一约束、具体列/索引与迁移编号由 A/C2 把共同对象引用核准后提出，不能把上述逻辑对象表当已签认的物理 schema。临时目录/文件的删除也需在实际授权范围中说明，测试不默认获得删除许可。

验证顺序：驱动真实可加载及版本/PRAGMA → 账户/会话生命周期 → read/write/事件/导出/模型读取的同一授权 → Origin/CSRF/登录失败限流 → 同 tx 成功/失败/重放/冲突 → 真实并发 CAS/重启持久性。AC-02/NFR-04 为 A1 主线；旧 revision、幂等竞争、跨学生/课程和私有资产与 AC-06/08/15 交叉核对。A1-P2/P3+C2 验证通用 CAS/回执竞争；正式教师纠正、旧候选与 Action 失效并发留待 A4+C3 及所需 B3 能力，不用替身补写通过数。

实际请求授权前需补齐三项：C2 的数据库对象/同连接接缝交付、成熟会话组件及 scrypt/限流参数的实测建议、最终唯一临时目标与原生脚本/创建/清理的准确操作清单。本批仅完成初稿，不以等待这些条件阻止已批准 P1 交付。

## 7. 基线汇总请求

待授权维护者汇总：MVP_SPEC §10、TEAM/G1 登记本批实际代码/命令及 P1 交付状态，P2/P3/完整权限和业务验收未完成；不直接修改受保护文件，不关闭 Issue #10/#9。

## 8. 2026-10-09 后续准备（实施前核查）

项目负责人指示继续。本次继续完成 Issue #10 规定的认证/实际存储操作方案、成熟组件与参数验证准备，不把继续指令解释为 SQL/schema、凭据/新依赖、删除或公开发布的具体授权。可写本任务、README 与 A 的 tools；产品/共同规划/他人任务稿只读，不开始 P2/P3 应用实现。

已核对远程 origin/main=898b2e3，较开始基线仅新增 G1 协调文档及 README 更新，产品 v0.3 未变；读取其完整 G1 门禁/首批依赖、Issue #10/#14 与当前分支任务记录，并复核 PRD §5/8/9、MVP M-10/§5/6、TECH §4/5/9/10/12 的身份/权限/存储与进入条件。当前公开分支/PR/Issue 没有 C2 新代码或任务稿交付；不能推断其他成员未开展本地工作。G1 协调材料的“无应用代码”反映远程交付时点，本地 P1 实际状态仍以 §5 为准。

准备步骤：只读官方 session/cookie/ncrypto/npm 与固定驱动源码；先记录 scrypt 候选参数（N=131072、r=8、p=1、maxmem=192 MiB、64 字节输出/16 字节 salt），用独立工具、固定合成字节输入实测 5 次串行/2 次并发及匹配/不匹配行为。工具仅用批准 Node 标准库，输出参数/耗时/进程 RSS/事件循环采样与布尔检查结果，不读取真实密码/环境配置、不保存输入/salt/摘要、不接应用、DB 或网络。结果只是本机密码算法参数准备，不计真实登录、目标 Linux、限流或 NFR 验收。

初步来源：[Node scrypt](https://nodejs.org/docs/v24.21.0/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) 的随机 salt/内存约束，[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt) 的 scrypt 参数组；这些支持待评审建议，不自动冻结参数。具体组件/操作/结果在本节后续补齐。

### 8.1 依赖与原生模块核查

维护中的候选为 @fastify/session **11.1.4** + @fastify/cookie **11.1.3**，只读核对 npm registry 的精确版本/来源与对应 gitHead。两个插件源码声明 Fastify 5.x；这是声明兼容，不是实际安装/typecheck/运行通过。未安装候选，也未修改 package/lock。增加这两个依赖及其传递依赖须获批准后固定 lock；不引入第三方 SQLite session store、公开注册或无状态 JWT。

来源：[session registry](https://registry.npmjs.org/@fastify%2fsession/11.1.4)、[cookie registry](https://registry.npmjs.org/@fastify%2fcookie/11.1.3)、[session 固定源码](https://github.com/fastify/session/blob/8b97d4266ccacad8d1cf4791ba505c46bde81840/index.js)、[cookie 固定源码](https://github.com/fastify/fastify-cookie/blob/576e0ddcacbd4cf652ba7228e5c1c44742091366/index.js)。session 默认内存 store 和默认 rolling 不满足本项目持久性/绝对时限；建议自有 SQLite store、saveUninitialized=false、rolling=false，明确 DB 的两项时限。参考 [session 官方说明](https://github.com/fastify/session#options)；单纯配置 cookie maxAge 不能作为会话验收证据。

本机已安装的 better-sqlite3@13.0.3 包含 prebuilds/win32-x64.node；lib/binding.js 优先查找适用 prebuild，binding.gyp 在 prebuild 存在时不做实际源码编译。标准 Node 24.21.0、N-API 10 下直接 require 此模块通过，Database 构造器存在，**未调用构造器/initialize、未打开数据库、未执行 SQL**。没有运行安装/构建脚本。此结果解除“必须先编译”的假设，未证明 sqlite_version 或 WAL/事务。

§6 原生安装提案据此细化：优先使用 lock 中固定包的适用 prebuild；其他节点先核源文件/平台再加载。加载失败如实报告，提交具体构建条件/理由后授权，不自动运行 npm install-scripts approve/rebuild、不放行全部安装脚本，不静默换驱动。本机无需为后续合成验证批准 node-gyp 源码构建；真实应用节点仍另验。

核查曾访问两个猜测的上游源码路径返回 404；随后按仓库 tree 找到实际 index.js，以精确 gitHead 的源码复核，未把 404 当组件失效或安装结论。

### 8.2 scrypt 实测与待评审参数

工具：[benchmark-scrypt.mjs](../../apps/teaching/tools/benchmark-scrypt.mjs)。命令：apps/teaching 下 `node tools/benchmark-scrypt.mjs`，仅批准 Node；`node --check tools/benchmark-scrypt.mjs` 通过。

| 项目 | 本机实际结果 |
| --- | --- |
| 环境 | Node v24.21.0，Windows x64；无账户、数据库、网络或真实密码 |
| 参数 | N=131072，r=8，p=1，maxmem=201326592，keyLength=64，saltLength=16 |
| 5 次串行耗时（ms） | 373.29 / 353.83 / 355.52 / 358.97 / 441.77；中位 358.97 |
| 2 个并发的整批耗时 | 495.90 ms；不是每请求时延统计 |
| 整个独立进程 RSS 采样峰值 | 295.83 MiB；包含进程与两个 derivation，不等于单次 scrypt 精确内存 |
| 事件循环采样 p95 | 16.12 ms，10 ms 采样分辨率；不代表应用 API 延迟 |
| 合成输入检查 | 相同输入/同 salt 匹配，不同输入拒绝，均 true；实际命令退出 0 |

该参数组是候选，不因本机探针通过自动冻结。建议使用异步 scrypt、逐账号随机 salt、固定算法版本/参数与等长 timingSafeEqual；不 trim/归一化/截短密码。未知账号也作同参数的合成比较，具体拒绝、并发与时序泄漏仍须在真实登录入口验证。拟将密码哈希并发限定 2 个且不设置无限队列，超额用已批准 RATE_LIMITED，防止请求耗尽内存；目标节点须复测，不能据此宣称 10 会话 NFR 达标或成熟认证已实现。

### 8.3 A 自有认证/短事务验证方案（待批准；不是 schema 文件）

本提案限定为独立合成验证批次。完整 A1-P2/P3 的资源授权/业务原子提交仍等 C2 的同连接接缝。下列物理列/约束为待评审建议，不代签 C、不修改正式模型，也不在本批创建 SQL 或应用接口。

| 拟用表 | 字段/约束提案 | 使用边界 |
| --- | --- | --- |
| users | id 主键、login_name 唯一、password_hash/salt 与 algorithm/N/r/p/key_length、disabled_at_ms 可空；二进制长度/参数受检查 | 只预置合成账号，真实凭据不进入代码/commit/日志；账户状态在认证时重读 |
| courses | id 主键 | 仅为合成课程归属的最小父记录；无新增公共课程创建 API，后续课程元数据由 A2/C2 对齐 |
| course_memberships | (course_id,user_id) 联合主键，分别 FK→courses/users；role 仅 teacher/student，active 状态 | 同一用户角色按课程查询，不从 Session 保存的旧 role 或请求体取角色 |
| sessions | token_hash 主键，user_id FK→users，created_at_ms/last_active_at_ms/absolute_expires_at_ms/revoked_at_ms、csrf_hash、获准 cookie 元数据 | token/CSRF 原值只在内存/获准客户端出现，DB 存摘要；created/absolute expiry 不因 set/touch 改写，退出写撤销标记 |
| login_attempt_windows | (kind,bucket_hash) 主键，window_start_ms/attempt_count/failure_count；kind 为账号/IP，计数非负且 failure≤attempt | unknown/known 账号同形计数；bucket 用运行签名材料 HMAC，不保存明文凭据/IP；不作为学习过程证据 |

不创建 C 的 Job/CommandReceipt/AuditEvent/Attempt/ProjectFile 表、不写私有资产或作品记录。A 的授权先在自有 account/course membership 上验证；真实 ResourceVersion/Attempt scope、同 tx Job/Receipt/Event 和数据库物理接缝等待 C2。上述最小课程父记录和成员/Session 映射应交 C2 核对，不要求 C 采用未批准的列或迁移编号。

时间采用服务端 UTC 毫秒。store.get 校验未撤销、账号有效、now 小于 created+8h 且小于 lastActive+30min；恰到边界拒绝。有效已认证请求才推进 lastActive。store.set 仅接受服务端明确完成登录的账号数据；现有记录不得复活撤销/过期 token，不从 plugin 的 stale payload 延长绝对期限，匿名/无效请求不创建持久 Session。登录换新 ID/CSRF，退出撤销原 ID；所有 callback 的持久失败必须传给 HTTP 拒绝，不能先 ACK 再保存。

cookie 建议固定 path=/、HttpOnly、SameSite=Lax；真实入口强制 Secure，禁止 secure=auto 和无条件 trustProxy。合成 app.inject 测试模拟获准 HTTPS Origin，测试签名材料仅进程内生成/注入，不配置 .env/实际密钥；私有 HTTPS/校园网/VPN 的真实入口、可信代理和密钥提供通道另授权。Session cookie 原 ID 不授权任意账号/课程；登录 body 不接纳 role/studentId，未知账号/错误密码统一 UNAUTHENTICATED。

所有变更先核严格同源 Origin，拒绝缺失/null/多个/错误源；同源不靠请求 Host/任意 X-Forwarded-* 推断。登录无已有 Session 时按获准 Origin + 固定 JSON 媒体入口防登录 CSRF；登录后变更还需服务端 Session 绑定的 CSRF header，摘要等长比较，SameSite 不能代替校验。既定当前 Session GET 不激活学习，返回身份/所属课程与获准 CSRF，不回传 cookie token；返回字段/确切读路径待公共契约确认，不单方新增到 contracts。

限流候选为固定 15 分钟窗口、每登录名最多 10 次尝试/每 IP 最多 50 次尝试，成功与失败都计入尝试，失败另计；unknown/known 同样累计，不能靠重启或切换不存在账号绕过 IP 窗口。数值是本次待批准建议，不是 G0 已冻结值。窗口预留/计数在短事务中，密码算法在事务外；并发 admission 先计尝试再派发，失败不退尝试计数。全局最多 2 个 scrypt；DB 失败明确拒绝，不能绕过限制。测试需证明允许次数、边界、同时到达和重启不重置；真正耗时侧信道不能仅凭相同错误码宣称解决。

withTransaction 候选以单个应用拥有的 better-sqlite3 连接、IMMEDIATE 短事务与参数绑定实现；callback 仅同步 DB 操作，拒绝 promise/async（开始前拒绝显式 async；返回 thenable 则回滚，仍禁止回调安排外部副作用），禁止跨连接或调用网络/模型/runner。拒绝嵌套事务，C2 接收同一 tx capability；busy_timeout 建议 1000 ms，foreign_keys=ON、journal_mode=WAL、synchronous=FULL，用真实结果核配置，不把返回值或 PRAGMA 声明当验证通过。session/成员授权也在该 tx 内读当前记录，初始读取不能代替提交前复核。

### 8.4 准确操作范围与审批对象

提请项目负责人批准的是 **A 自有独立合成存储/认证/事务验证批次**，不是整个 A1 或真实试点。实施目录仍为 apps/teaching 的 A 自有 server/access、server/db/transaction、contracts/access（仅批准字段）、tools/tests 与任务记录/README；不改受保护文档或 B/C/UI 领域。

批准后才执行：

1. 将 @fastify/session 11.1.4 与 @fastify/cookie 11.1.3 加入共享 package，更新精确 lock 后安装/typecheck。只批准这两个新增组件与实际 lock 解析出的传递依赖，不全局安装或自动放行安装脚本；实际组合失败报告，不替换栈。
2. 每个测试批次用 fs.mkdtemp，在 os.tmpdir 下创建 xunjie-a1-p2- 前缀的独占新目录，库名固定 synthetic.sqlite（含 SQLite 自身的 -wal/-shm 生命周期文件）；先核目录绝对解析范围、非符号链接且目标不存在，禁止使用配置指向既有文件。无真实个人数据和持久密钥文件。
3. 在该新库执行 sqlite_version/PRAGMA 核验、上述五个 A 自有合成表/必要索引创建、参数绑定的合成 INSERT/UPDATE/SELECT；每个测试独立文件。仅这些新文件的 schema/夹具，不对任何既有库 ALTER/DROP/导入/迁移。SQLite 自身临时 WAL/SHM 的关闭生命周期限于独占目录；不执行人工递归删除，库/目录暂留供核验，不调用清理脚本。
4. 拟编写 schema/init 与连接/短事务/认证验证代码后，按下节用例实际验证；预置账号数据和签名材料在合成夹具内临时生成，明文不写源码、仓库、日志或 .env。不发放真实账号，不调用模型/runner，不开放网络/页面，不创建生产部署配置。
5. 证据写回本任务，分开报告驱动/SQL/认证/事务和 C2 未联调项；不把仅 A 自有库通过算完整 AC-02/06/08/15 或 NFR-04/G1，不关闭 #10/#9。签名材料由同一受控测试父进程保留供子进程重启复用，仅 IPC 传递、不落盘；真实签名密钥/安全恢复与凭据发放仍另授权。

风险：新的 native 模块/会话组件会在本机执行依赖代码；建表/索引及事务会写独占数据库，SQLite 还产生其内部生命周期文件；每个测试保留临时库会占磁盘。已把目标限定新建合成目录、固定批准依赖和五个 A 自有对象，原生构建不在本机申请范围；不使用生产/已有数据库或真实资料。合成验证开始前仍需负责人批准组件/参数/表提案与实际写库范围；不能仅因本节写成详细方案就执行。

本批审批不冻结 C2 物理模型、tx 的最终共享签名或当前 Session API 新字段；它们另行对齐共同契约，并满足 TECH §12 条件后再接真实作品链。若负责人仅批准方案评审、未批准独立 SQL 验证，则继续保持所有 SQL 未执行。

### 8.5 批准后验证清单（当前全部未执行）

| 用例组 | 明确通过条件 | 判据范围 |
| --- | --- | --- |
| 驱动/配置/存储 | 实际内嵌 SQLite 修复版本、外键拒绝孤儿/WAL/FULL/busy；提交与强制进程退出后原已确认行仍在 | 存储基础；不替代 C5 故障/备份演练 |
| 登录/会话 | 合法合成登录；错误/未知账号同码；换 ID/CSRF；8h/30min 精确边界、撤销/账号失效与迟到 set 不复活；插件保存失败不 ACK | A 自有身份入口；整体资源授权尚待 C2 |
| 身份/归属 | role/studentId 伪造拒绝；一用户两课程不同角色，跨课程与非任课教师拒绝；权限变更后旧 Session 重查 | AC-02/NFR-04 部分；私有 ResourceVersion 正文裁剪待 A2/C2 |
| 请求防护/限流 | Origin/JSON/CSRF 缺失/伪造/跨会话拒绝；窗口/并发/重启计数和 scrypt=2 admission；日志/响应没有输入/盐/摘要/cookie/CSRF/原异常路径 | 确定性防护；真实网络/安全配置未执行 |
| 短事务 | 任一步失败、thenable 返回、FK/唯一约束/忙锁与 CAS 竞争整批回滚；同连接/拒绝嵌套，不能先 ACK 后失败 | 真实 A 库原子性；没有 C 的回执/Job/Event 时不宣称业务幂等通过 |
| 后置联调 | 同键同摘要原 IDs、异摘要409、旧 revision、C2同 tx公共记录；A4+C3/B3教师纠正/迟到候选与Action失效竞争 | C2/下游真实交付和共同契约到位后再执行 |

### 8.6 当前验证与状态

已执行且通过：scrypt 合成参数探针、工具语法检查、本机预构建原生模块的无 DB 加载、npm run typecheck、npm test（含 pretest build，14/14）、文档检查（23 份/201 处仓库引用/27 条正式变更接口）、文档检查器回归 16/16、Git 空白检查。系统 Node 24.15.0 执行该探针返回预期退出 1，在密码算法前停止；批准运行时返回 0。

本次仅 README、本任务记录、一个 A 自有合成参数工具有变化，应用 P1 无行为改动；未改 package/lock、受保护基线或其他模块。实现/方案提交 191c700 已保存在 codex/a1-foundation，本节审查收口随本地补充文档提交交付；未推送、未创建 PR。既有产品验收与本节真实 SQL/认证用例保持未执行。P2/P3 操作提案待批准，C2 缺少公开交付证据的依赖保持，P1 工程远程交接尚未完成。

独立审查固定基线 9050c6b，候选 191c70034ffc987bcc1541260603b408debe24ea，git diff 9050c6b...HEAD。Standards：0 项硬违规/可操作异味，工具和文档遵守任务与证据边界。Spec：0 项，探针/原生加载与待批准方案没有冒充真实 SQL/登录，期限/撤销/事务外密码算法与后置 C2 依赖保持。最终两轴各 0 项，无未解决问题。

## 9. 2026-10-10 独立合成验证批次

项目负责人在 §8.4 的准确操作/风险提请后明确指示“开始”，批准该独立批次：两个精确依赖、§8.3 参数与五表提案、仅新建临时合成库的 SQL 和 §8.5 验证接缝。§8 的“待批准/未执行”保留为当时记录，本节记录较新状态。没有授权生产数据、既有库迁移、密钥文件、共享接口新增字段、受保护基线修改或远程发布。

编码前已读 AGENTS、README、PRD §5/8/9、MVP_SPEC M-10 与 §4/5/6、TECH_DESIGN §4/5/9/10/12 和本任务 §8。范围是 A 自有 access/db 与测试、共享 package/lock、README/本记录；对应 AC-02 与 NFR-04 的身份/课程部分、真实短事务基础。AC-06/08/15 的真实资源、旧 revision、回执/Job/Event 与教师纠正并发待 C2/下游，不提前计通过。

实施细节：合成验证工厂独立于默认 main；保留 ready=503，不监听认证网络入口。登录/退出使用既定变更入口；CSRF 仅作为合成验证工厂登录结果，当前 Session GET 路径与公共返回字段保持待共同确认，不加入共享 contracts。测试 fixture 路由仅验证服务端授权能力，不成为应用 API。插件显式 save 成功后才回登录响应，Secure cookie 不因注入测试降级；app.inject 的 HTTPS Origin 不证明实际 TLS。事务公开接缝仅暴露同连接同步 SQL capability，测试通过该接缝观察提交/回滚；竞争验证的第二连接/子进程仅打开本批自身新建库。库关闭后保留文件。

启动时状态：实施中；当时实际 SQL、认证与事务验证结果待填写。现状以 §9.2/9.3 的实际结果为准，不以批准替代运行事实。

### 9.1 已实现与代码位置

- [transaction.ts](../../apps/teaching/server/db/transaction.ts)：独占新合成目录、固定文件与非符号链接检查；新文件一次性五表初始化；仅重开本批合成目标，不含生产配置/既有库迁移。实际驱动配置核验；同步 IMMEDIATE 事务、失败整批回滚、拒绝 async/thenable/嵌套/事务控制语句，回调结束后 capability 失效。callback 禁止安排网络/模型/runner/其他外部副作用，这是可信调用约束，不宣称 JavaScript 沙箱。
- [password.ts](../../apps/teaching/server/access/password.ts)：异步固定参数 scrypt、随机盐、等长 timingSafeEqual、未知账号同参数合成比较，每个验证应用最多 2 个 derivation，无无限排队。临时合成账号通过测试预置，无账号管理/实际凭据发放入口。
- [session-store.ts](../../apps/teaching/server/access/session-store.ts)：成熟 Session 插件的持久 store；原 token/CSRF 不落库，一次性可信登录 grant、保存前账号状态/密码摘要复核、8h/30min 精确守卫、撤销标记与迟到 set 拒绝。set 不推进活动或改绝对到期；课程授权成功才推进 lastActive。账号禁用即时拒绝既有 Session。
- [access/app.ts](../../apps/teaching/server/access/app.ts)：独立验证工厂，既定 POST /api/sessions 与 POST /api/logout，严格 body/Origin/JSON、会话绑定 CSRF、成功保存后才响应；同一事务重读账号与课程角色、非任课/跨课程拒绝。角色不存 Session 或信任 body。登录名 1～128、密码 1～1024 个 JS 字符仅作为合成入口有界校验细节，不 trim/归一化/截短，不冻结公共登录字段。账号/IP 分别 10/50 次尝试的 15 分钟持久窗口、HMAC bucket、事务预留计数，拒绝倒退窗口覆盖与并发超额。密码计算在事务外。签名材料必须由调用方提供，验证工厂不读环境/密钥文件，默认 main 未注册认证。
- [access 测试](../../apps/teaching/tests/access.test.ts)、[Session store 测试](../../apps/teaching/tests/session-store.test.ts)、[事务测试](../../apps/teaching/tests/transaction.test.ts)、[持久性测试](../../apps/teaching/tests/durability.test.ts)：通过批准接缝与真实 SQLite/成熟插件执行；子进程 fixture 仅受控 IPC 和故障注入，不是对外服务或产品接口。

新增精确 @fastify/session 11.1.4、@fastify/cookie 11.1.3；安装新增 4 个实际包（含解析后的传递依赖），未自动放行原生安装脚本。本机包内预构建模块直接用于 SQL，无 node-gyp 构建或新类型依赖。驱动未提供类型，代码定义实际消费 API 的局部类型边界；不关闭 strict/检查或使用 any。

### 9.2 2026-10-10 实际验证

| 命令/环境 | 结果与证据边界 |
| --- | --- |
| Node 24.21.0 / npm 11.19.0；npm install --no-audit --no-fund | 退出 0，精确 lock 已更新；原生脚本提示保留，不自动 approve |
| npm run typecheck | 通过；初次发现 scrypt promisify 重载类型不接纳第 4 参数，改为标准 callback 的显式 Promise 包装后通过，没有绕过检查 |
| npm test（含 pretest build） | 初次 **27/27** 通过；补插件保存失败精确用例后最终 **28/28，通过，0 跳过**；其中原 P1 14 项，本批 14 项；最终总耗时约 47.82 s，不是产品时延/NFR 统计 |
| sqlite_version/实际读回 PRAGMA | **3.53.4 / foreign_keys=1 / journal_mode=wal / synchronous=2 / busy_timeout=1000**；已执行真实 SQL，超过最低修复版本 3.51.3 |
| 认证/授权/请求防护 | 合法合成登录/退出，错误密码/未知账号同 401；role/studentId 拒绝；一用户两课程不同角色、非任课教师、权限/账号变化后重查；cookie Secure/HttpOnly/Lax、轮换/签名篡改、精确闲置/绝对期限；Origin/JSON/CSRF 缺失/伪造/跨会话拒绝通过 |
| 限流/持久性 | 12 同时到达仅 2 个哈希获准登录，其余 429，10 账号尝试预留不会回退；窗口恰到 15 分钟重置，成功也计数；50 个不同未知账号耗尽同 IP 窗口。实际关闭/重开库与应用后不重置；独立子进程用 IPC-only 原签名材料读回既有身份且保留账号限流 |
| Session/故障/隐私 | 撤销与过期 token、迟到 set、不可信身份和匿名持久写拒绝；关闭真实 DB 注入登录中故障，503/PERSISTENCE_UNAVAILABLE，无成功 data/有效 cookie。另在已登录/已校验 CSRF 的测试 handler 中关闭真实 DB，再调用成熟插件 session.save：handler 确已进入、save 后 ACK 分支未执行、HTTP 503，无成功 data/有效 cookie，明确验证保存失败传播。响应/应用日志无密码、账号输入、摘要字段或真实私有路径，存储投影无原 cookie/CSRF/密码/IP |
| 短事务/崩溃 | 外键/唯一约束、thenable、嵌套、失效 capability 拒绝；失败无前置行。真实第二连接 CAS 失配回滚整批；子进程持锁时另连接 busy 且回调未执行，强制结束后未提交行消失、已确认行保留，再次可提交 |
| 文档检查/检查器回归/Git 空白 | 更新记录后 23 份/210 处引用/27 条正式变更路由，通过；16/16 回归通过；git diff --check 通过（换行提示不影响空白检查） |

第一条新事务/登录测试曾因模块尚未实现退出 1，随后实现通过；新方案按约定接缝逐步补验证，失败与修复未改产品验收条件。全部临时库仍在各自系统临时目录，不调用清理。驱动平台证据仅本机 Windows x64；故障用 SIGKILL 终止自有子进程，不声称 POSIX 优雅信号或 C5 备份恢复已验收。

### 9.3 交付状态与剩余限制

本节独立合成批次已实现、验证并完成审查；**A1 整体未完成，#10/#9 保持 Open**。默认 main 仍只有 P1，ready=503。本工厂不是生产认证开关，不在本批监听认证入口/提供 UI。

尚未执行：真实 HTTPS/代理/密钥配置、实际账号安全恢复与发放、当前 Session 公共 GET/字段会审、ResourceVersion/Attempt 的完整 authorizeResource 与正文投影、跨学生作品/私有资料、同键同摘要原业务 IDs/异摘要冲突/旧 revision、C2 同 tx Job/Receipt/Event、纠正与迟到候选/Action 并发、模型/runner、浏览器/真人/G1 完整验收。不得将本批 CAS 夹具计作业务版本/幂等通过，不能把 A 自有五表当 C2 已实现。

2026-10-10 再查远程 #10/#14：均 Open，#14 无评论交付证据；不据此推断成员本地未工作。下一步提供 A 工程/独立验证代码供 C2 核对，同连接能力和公共字段共同确认后，再接真实资源与业务原子链。实际签名材料持续性测试只在同一个受控父进程持有期间成立，真实运维密钥保存/轮换/恢复未执行；真实网络侧信道与目标节点 10 会话性能未执行。

本批仅 README、本任务稿、A 自有代码/测试与 package/lock 有变化；受保护基线未修改。待获授权维护者将本节实际进度/边界汇总 MVP_SPEC §10 与相关技术接缝，未宣称基线已同步。远程推送/PR 未执行。

审查固定基线 6da3cd8，候选本地实现提交 3db1959；Standards：硬违规 0 项、可操作异味 0 项；Spec：未解决发现 0 项。追加保存失败用例与记录的候选 d54ba78，以 git diff 3db1959...d54ba78 单独两轴复核，Standards/Spec 再各 0 项；最终无未解决发现。已修订顶部历史状态与引用数，最终 28/28 和 typecheck/build 均通过。收口仅追加本任务文档，静态/空白检查通过，不因纯记录变更重复业务测试。全部保存在本地 codex/a1-foundation，未推送或创建 PR；此前 P1 与准备阶段提交保留，原工作副本未提交草案未动。

## 10. 2026-10-10 C2 接缝推进：既有合成鉴权与事务组合

项目负责人在新 PR 核对后要求继续 A1/A2 对接。已读 AGENTS/README、PRD §8/9、MVP M-10/AC-02/NFR-04、TECH §9/10.1、TEAM A1/A2，以及 [C2 固定交付 §5](https://github.com/paher-din/XunJie/blob/84545ec4084aa9bdb29649ef4be21c28a6615d4d/docs/tasks/C2_WORKSPACE_JOBS.md#5-实际接入提案待-a负责人确认)。C2 已交纯变更计划，不能继续沿用 §9.3 当时“无评论交付证据”推断无依赖。新 PR #16/#17 尚未合并；A 的本地代码仍未远程交付。

当前具体差距：authorizeCourse 自行开启 withTransaction 并完成 Session 续期，随后另一个保存事务会把鉴权与业务写入分开；在已有事务内调用它又因嵌套事务被拒绝。因此先完善 A 自有独立验证工厂的内部组合接缝，不创建 C2/A2 表、生产认证入口或新公共 ActorContext。

本次在已批准 §8.5/§9 的 app.inject 鉴权与真实短事务接缝内补同连接用例，仍仅新建 xunjie-a1-p2 临时合成库/原五表。新增内部 withAuthorizedCourse(request, courseId, requiredRole, work) 使用同一同步事务重读有效 Session/账号/课程角色，再把既有 userId/courseId/role 与 tx 交可信同步回调；全部提交成功才返回。authorizeCourse 复用这一个鉴权实现，避免两份规则。Session lastActive 与回调 SQL 同提交/同回滚；拒绝异步/thenable/嵌套调用、越权及失效身份，错误沿已有错误定义。不从 body 构造角色或课程归属。

可写仅 access/app.ts、既有 access 测试、本文/README，以及 A2 本任务的待审存储方案；共享 contracts、package/lock、原五表 schema、B/C/UI、保护基线均不改。不启动 SSH/runner、修改其 PR 或发送成员消息。SQL 只沿用原授权的五表验证（用合成课程标识观察提交/回滚），不插入真实教学记录。同步 callback 禁止 HTTP/模型/runner 等外部副作用，可信调用约束不当 JavaScript 沙箱。

验证用例：合法身份与 SQL 写入同连接提交；授权/回调失败不能返回 ACK 或留下前置行，lastActive 不因失败推进；当前角色撤销后 callback 不执行；async callback 不开始、thenable/嵌套回调整批回滚、逃逸 tx 失效。它验证既有基础组合，不冒称 C2 的业务幂等、回执/Job/Event 落库或 A2 完成。固定开始提交 59ddd79；总审查沿已约定 9221370，新增部分单列 59ddd79..候选。

状态：**§12～14 准确批准的工程、当前 Session/课程/资源授权、十七表新合成库、实际 C 记录同事务适配已实现；最新独立 typecheck/build/回归 112 通过、0 失败、5 跳过（117 项）。两轴审查各发现 1 项 P2，已修复、验证并增量复核关闭；当前 Standards 硬违规/可操作异味 0/0、Spec 未解决 0。真实账号/私有 HTTPS/生产初始化/可靠恢复和 UI/真人保持原后置条件；完整 G1 未完成。准确批准服务端范围已收口，正在分别交付 PR；较新真实联调接收事实见 §14.4。§8～13 原首批/待批/失败状态保留历史范围，以 §14 较新事实为准。**

### 10.1 实际实现与验证

实现位于 [access/app.ts](../../apps/teaching/server/access/app.ts)，反例与成功路径位于既有 [access.test.ts](../../apps/teaching/tests/access.test.ts)。新增内部方法不改变原 authorizeCourse 的返回形状；两者共用 Session/课程角色核验。不存在 A2/C2 建表、共享 DTO 或默认 main 路由变更。

已执行（Node 24.21.0/npm 11.19.0）：
- 首个 app.inject 同事务用例先失败（尚无方法，503 而非 200），实现后 1/1 通过；实际 SQL 回滚/撤权用例 1/1，异步/嵌套/逃逸用例 1/1，通过。
- npm run typecheck：通过；没有绕过类型或关闭检查。
- npm test：**49/49 通过，0 失败/跳过**（既有 A1 28 + 本批 3 + A2 S1 18），pretest build 通过。总耗时约 39.48 s，不计 NFR 时延验收。测试仍只使用原授权 A1 五表临时库与 S1 合成对象。
- 仓库根目录 node tools/a0-review/check.mjs：通过（24 份文档/231 处仓库引用/27 条正式变更接口）；node --test tools/a0-review/check.test.mjs：16/16 通过。git diff --check 初次因新增测试末尾多空行失败，规范 EOF 后复核通过。静态脚本 businessTests=NOT_EXECUTED 只表示该脚本不执行业务测试，不替代上述 49 项实际结果。

真实资源/跨学生读取、业务幂等/回执与 Job/Event、纠正并发、生产认证及浏览器验收**未执行**。当前 helper 的工程通过不表示这些业务通过。A2 新存储仅 待审提案（随 A2 独立 PR 交付），未编写/执行新增 SQL 或初始化新表。

需获授权维护者汇总 MVP_SPEC §10：A1 新增同事务课程鉴权组合并验证，A1/G1 整体仍未完成；A2 S2 首批准确存储/验证方案待批准，S2/S3 未实现。**待授权维护者汇总**；本批未改保护基线。实现和文档仅本地交付，未推送、创建 PR 或关闭 Issue。

### 10.2 审查与本地收口

沿批准总基线 92213700fb7da506adb1f8b6ac8868bc220c643f；新增候选 8458e13，git diff 59ddd79..8458e13。Standards：硬违规 0、可操作异味 0。Spec：代码增量 0；A2 待审方案有 1 项 P2（遗漏恢复代际先拒后重放），已以纯文档候选 452d038 补齐受信登记来源、旧回执守卫与反例。git diff 8458e13..452d038 两轴复核：Standards 0/0，Spec 未解决 0。审查未运行 DB/runner，沿用上述实际 49/49 证据；之后仅追加记录，不因文档变化重复业务回归。

本批实现/提案/修订仅本地 codex/a1-c2-seams 提交；A2 建表仍待负责人批准，未推送/创建 PR。C1/C2 最新元数据再核仍 Open、head 未变化，原审查缺陷保留为接入前门禁。主工作副本原四份修改及 A_WORK_PLAN 未触碰。

## 11. A2 教师合成存储接缝使用

负责人另批准 A2 新临时合成库十表与教师持久化验证。A1 内部 withAuthorizedCourse 接纳 string courseId 或可信同步 tx 定位器，先核 Session 后查询对象课程，再核当前角色并执行业务/读取回调；既有字符串调用不改。定位器只供服务端查询，不接受 body 角色或异步外部工作。A2 PATCH/checks/读取在同连接完成课程定位、授权、对象校验与保存/投影，见 A2 §10（随 A2 独立 PR 交付）。新增物理存储仅 A2 独立批准范围，不宣称 C2 工作区/Job 或 A1 整体完成。

## 12. A1 完整交付与独立 PR 收尾方案（待准确存储授权）

2026-10-10，项目负责人要求完成 A1/A2 全部内容后分别提交 PR。授权包括既定 A 模块实现、验证、各自提交、普通推送及创建 PR；不得提前用首批 PR 冒充整体完成。原有合成库五表/十表授权保留，不扩展为生产建表或新对象许可。受保护基线仍只读，基线汇总由授权维护者处理。

本次已重新读取 AGENTS、README、PRD §1/3/4/5/8/9、MVP M-01/M-02/M-10、状态/AC/NFR/G1、TECH §2/3/4/5/7/9/10/12、TEAM §5 和 Issue #10/#13。远程 main=54ca54c6f2d01d2875b80404a525ec5505da2eb1；C1 #16 / C2 #17 仍 Open，head 分别 7e4ef73ee1b9ee301b82beab809b54e18ffce3f7 / 84545ec4084aa9bdb29649ef4be21c28a6615d4d。已 fetch 到只读依赖引用，尚未合并或改写 C 文件。GitHub 连接器可读取仓库；本机 gh 查询返回 401，不能据此宣称推送权限已失效，实际推送时另核。

### 12.1 A1 剩余实现与接口提案

- 将现有 Session/课程鉴权组合提供为 A 的可复用业务工厂；追加 authorizeResource / withAuthorizedResource。服务端同步资源定位器接收同一 Transaction，核所属课程、studentId、用途、版本、可见性、活动/分配和阶段；身份只来自当前 Session/成员，不从 body/audience/模型构造。读/变更、原回执、Job 查询及模型读取复用；不存在与不可见对象同拒，不能靠 ID 授权。
- 当前会话读取提案为 GET /api/session：返回当前 userId、有效课程成员列表与本会话 CSRF，不返 cookie token、密码/盐/摘要；读取不激活 Attempt。此确切路径/字段尚待确认，不自行成为已冻结共享契约。
- 接 C2 现有 CommandIdentity/CommandReceipt/AuditEvent/Job 类型和 resolveCommandReceipt、finishCommand、enqueueJob、cancelByPurpose / invalidateInTransaction；A 仅在 server/db 提供持久适配，用同一 tx 保存计划，不代做 C 工作区/执行器。原 Session 活跃时间、业务/回执/事件/Job 全提交后才 ACK；网络/模型/runner 均事务外。
- 保留认证限流/8h/30min、安全 cookie 与错误码；可重复运行的服务端工厂供 B/C 注册，不虚报 runner/model ready。真实账号、HTTPS/代理、密钥发放与生产初始化不属于合成交付许可；这些环境条件明确列入交接，不能用默认 health 服务冒充完整业务入口。

### 12.2 合成存储操作待批范围

准确共同范围见 A2 §11.2（随 A2 独立 PR 交付）。拟新建 xunjie-a12-completion-* 系统临时独占目录，固定 synthetic.sqlite；沿用 A1 五表与 A2 五表，另加七表，共十七张应用表。新增 attempts/jobs 仅承载既有 C 公共对象和 A2 同事务控制/失效适配，不是 C2 文件/快照/运行链实现。既有测试库不 ALTER/迁移/覆盖，SQL 初始化仅新库；现有 A1/A2 工厂维持原许可，不删除测试文件、不改变 .env/CI/凭据。

C 公共回执/事件适配沿现有 command_receipts/audit_events 的独立索引与作用域列，result_json/object_ref_json 保存原 C 类型的完整 JSON；读取按命令类型严格校验，不能把 C 回执套成 A2 resultSchema 或返回任意 JSON。actor/命令/target/键全局约束及单调 serverSeq 复用；登录/退出不进回执。sync 别名/文件持久化等 C2 后续对象由 C 负责，不在此申请中新增。

### 12.3 验证接缝与 A1 完成判据

提请沿已批准 app.inject + 实际 withTransaction/关闭重开接缝，扩展到资源授权/当前会话/C2 Job-Receipt-Event 真实落库。新库内使用随机即时账号/签名材料、合成课程/对象；scope/currentGeneration 由服务端控制。核匿名、伪造身份、跨学生/课程、非任课教师、维护用途无正文权、私有资料、当前撤权后读/原回执拒绝；同键原结果/异摘要/并发唯一、真实 SQL 晚期失败/锁忙、Job/Event/业务/Session 全回滚、关闭重开和异步回调拒绝。日志/响应不含正文/凭据/私有路径。C 的原类型/函数是实际代码消费；不以 mock ACK 或作者报告代替 A 执行。

A1 的既定服务端实现、原子适配、独立权限/持久测试与交接说明全部具备并完成两轴审查后才提交 A1 PR（Refs #10）。不把 A4/C3 教师纠正、C5 旧备份演练、最终 UI、真实凭据/公网部署计作本任务已执行；完整 AC/G1 仍依共同链路。若必要 C 接缝不符则记录具体差异，阻止对应集成，不将 C2 整任务作为前置。

### 12.4 PR 拆分

原混合工作分支与所有提交保留。A1 PR 只含批准工程/access/db 公共边界、其测试及 A1 任务稿/README；A2 PR 基于 A1 分支，只含 design/版本/分配、其测试及 A2 任务稿/README。从最新 main 构建新 codex/ 分支，顺序复制必要提交并处理 README 增量；不 force push、reset 或删除历史。若消费 C 公共文件需先交明确依赖/适配差异，不能把 C1/C2 的源码混进 A 的增量或修改其 PR。两份完成后分别普通推送、创建并附到当前任务，不自行合并/关闭其他 Issue。

当前状态：收尾方案已形成；新增 schema、公共 GET/字段与新批业务测试未执行，等待本节和 A2 §11 的明确批准。此前 62/62 仅为旧批次，不计作本收尾完成。

负责人已明确批准本节与 A2 §11 的准确收尾范围，开始实施；不延伸到真实账号/现有或生产库。


## 13. 已批准收尾批次实施记录（进行中，尚未 PR）

负责人已批准 §12 / A2 对应方案的准确公共接口、十七表新临时合成库和测试接缝。物理定义由 A 的 db 层统一管理，十七表为原 users/courses/course_memberships/sessions/login_attempt_windows、resource_versions/competency_versions/blueprint_drafts/audit_events/command_receipts，加 help_policy_versions/check_rule_versions/activity_versions/activity_controls/assignments/attempts/jobs。A1 PR 含该公共持久基础；A2 PR 消费它，不重复定义 schema。

已实现 createAccessApp（兼容旧 createVerificationApp）、GET /api/session、withAuthorizedResource、contracts/access、七表独立初始化和 C 公共记录同 tx 持久适配。当前 CSRF 由同一可信签名材料对随机 Session ID 作域隔离 HMAC，DB 仍仅保存 token/CSRF 摘要；同会话读取可返回原 CSRF 而不轮换/失效其他页面，重登新 Session 会换新值。secret 不来自 HTTP，不落配置/日志；真实密钥保管仍后置。

实际验证：resource authorization 新用例先失败 503（缺 helper）→实现后 1/1；C 实际记录 3/3，通过同 Session/Attempt/Job/原 Receipt/Event 提交、合法重放优先 CAS、关闭重开、跨学生/教师操作拒绝、晚期真实 SQL 失败全部回滚。初次 C 冲突被未知异常映成 503，按 RunnerError 的已批准公共码转换且使用安全公共消息后恢复 409；不回显 C 原异常正文。夹具草稿/活动只是 FK 支撑对象，不宣称已通过 A2 release/实际 C1 ready。

新库仍只初始化 xunjie-a12-completion-*，保留文件；C Job 保存复核原回执作用域/代际，不复活 stopRequested，Attempt 更新拒绝版本倒退。sync 客户端别名与作品持久化归 C2 后续，不在本七表适配虚报已接完整 C2。

统一 typecheck 当前失败：C-owned runner/records/workspace 在 noUncheckedIndexedAccess/exactOptionalPropertyTypes 下存在可选字段/索引错误，B-owned test scope 也有可选字段问题。未改 B/C、未关闭严格检查；后续核 A 自有错误与真实回归。首次取回 design-schema 的命令因工作目录不符未修改文件，正确目录恢复后缺模块问题已解除。完整测试/build、双轴收尾和 PR 尚未执行，A1 整体保持进行中。

此前静态收尾提案规范审查 0/0；规格审查指出两处 A2 表述：教学政策写入不能授维护者，teacher_design 的获准草稿读取不能误限于固定活动。按 TECH §4.4 收窄/区分后实施；审批不扩张维护者权限。待授权维护者汇总基线，不直接改保护文档。

## 14. 最小 B/C 依赖修复授权与方案

负责人明确答复“授权最小依赖修复，继续完成”。仅修复现有 runner/records/workspace 及其测试在严格 TypeScript 的索引/可选字段兼容错误、B 合成测试的可选字段构造；不降低检查、不引入依赖、不改 schema、凭据、CI、UI 或 B/C 功能范围。C 结果文件 UTF-8 BOM 必须保持确切正文/bytes/hash，按原 NFR-04 引用语义修复；readWorkspace 不能将私有检查原结果及其摘要带入学生载荷，可信读取原始结果仅用于内部校验及既定公开诊断白名单。对应 TECH §4/5/7 与 AC-02/06/15、NFR-04，先通过现有公开操作补反例，再修根因。此项是负责人明确允许的依赖修复，不代表接管 C 运行/工作区或 B 教学实现。

只读查询 C1 文档给定认证 readiness 失败：本机 WSL Ubuntu 找不到应用认证文件，localhost:2222 拒绝连接。未读取/创建/修改凭据，未启动 VM 或改变环境；真实正向开放验证未执行，合成 ready 只验证守卫。

统一验证入口扩大为 A/B/C 全部现有领域测试，类型检查纳入 runner 源码/测试，保持全部严格选项；Linux/真实节点专属测试仍遵守原门禁并如实记录跳过，不计通过。构建继续编译实际依赖，不用排除依赖绕过错误。

### 14.1 当前实际验证与依赖更新

最低依赖修复已执行：B 可选 scope 省略未提供字段；C CLI 缺少参数时明确拒绝，合法有界数组索引与可选字段保持严格检查。C 结果 BOM 反例先失败（正文缺 BOM）再通过；学生读原检查结果/摘要的反例先失败，安全投影及保留可用 verdict 的验证通过。A 的结果验证器必须同步，新反例验证 async validator 在业务回调启动前拒绝；Receipt/Event 独立列、作用域与相互关联读回核验，不能复用损坏记录。

本批 Node 24.21.0/npm 11.19.0：npm run typecheck 通过（含 runner）；npm test/pretest build 通过，149 项中 144 通过、0 失败、5 跳过，约 42.24 秒。跳过分别为 node-local RPC、Linux 容器、认证 VM 控制、Linux symlink、C2 真实 SSH 对接，不计通过。A2 新增 7 项、A1 记录适配 4 项包含在统一回归中。新增 async-validator 反例最初 true != false，修复后通过；该反例的未知泛型测试注解修正后静态检查通过。没有关闭严格选项或放宽检查行为。

仓库文档检查通过（28 文档、320 引用、27 正式变更接口），检查器回归 16/16。git diff --check 初次发现新增行尾空格，待修正复核；最终两轴审查尚未执行。此前 §13 的 typecheck 失败是当时事实，以本节较新结果为准。

远程再核 C1/C2 head 已前进至 f8b6c6ff3e6302b59453f108dd16a57073fcf255 / 64eaa958ff565de245a965c5a29945eb2b08b2eb。C 新提交已修复私有结果投影、所有未终态执行作业取消确认与可信检查两项误判，并升级 validator-v2；A 将普通 merge 吸收并复核必要最小修复，保留 C 原代码和证据。C 作者真实节点通过数仅属其交付，不计本机 A2 联调。实际基于 C2 分支堆叠 A1、再堆叠 A2，PR 差异剔除 C 来源增量；不用历史改写构造分支。源码提交是审查候选，仍须完成独立审查/必要联调后才远程 PR。
C1/C2 新提交已在 A1 分支普通合并：保留 C 的公开运行元数据/获准诊断与最新取消逻辑。必要最小隐私修复继续裁剪 Job 内部租约/结果引用与私有原结果 hash；C 新版投影仍包含原 hash，A 的获准反例保留，原始内部结果与摘要不改写。A 的 stopAttemptJobs 直接消费 C 已修正 cancelByPurpose，不再保留重复取消转换。合并冲突只协调有界测试索引与投影增量；没有回退 C 新检查/取消测试或改写其证据。

A1 独立分支在本次合并后完整类型检查通过；联合工作副本 144/149 记录仍保留其 A2 范围，不能当作 A1 分支单独通过数。A1 独立最终回归与两轴审查接着执行，最新结果另追加。第一次候选提交因本 worktree 未设置 Git identity 失败，复用此前已验证 czr112 noreply 的命令级身份后成功；未修改全局 Git 配置，原 A1/A2 与根工作副本均保留。
A1 独立最终回归（合并候选 60ff466）：npm test/pretest build 通过，116 项中 111 通过、0 失败、5 跳过，约 41.29 秒；同五项节点/Linux门禁未执行。完整 typecheck 已通过。A1 两轴只读审查固定 C2 64eaa958..60ff466 正在进行；该范围不含 C 的来源提交或 A2 新模块。尚未推送/PR/关闭 Issue。
A1 Spec 审查发现 P2：SQL 幂等唯一键为 actor/command/target/key 全局范围，但适配只在当前课程加载原回执，同一双课程账号换 scope 可能先进入业务再以 503/领域错误拒绝。按既有 §12.2 和 TECH §5.1 先定位全局原键、核代际/scope 并返回 409，后执行新业务；不改 schema 或键含义。新增同账号两课程反例沿已批准 app.inject/真实短事务验证，修复后请原审查者复核。
### 14.2 审查修复与当前独立结果

固定 C2 64eaa958..60ff466 的 Standards：1 项 P2（README 未标联合 A1/A2 数量范围），可操作异味 0；Spec：1 项 P2（跨课程全局原键遗漏）。README 已标联合历史/独立结果；当前授权后先按全局 actor/command/target/key 定位原 scope/代际，不进入其他课程的新业务。新反例先失败 422（业务已执行）→修复后 409 IDEMPOTENCY_CONFLICT；实际记录文件 5/5 通过，同课程原回执仍可重放。

修复后 A1 独立 npm run typecheck 通过；npm test/pretest build：117 项中 **112 通过、0 失败、5 跳过**，约 41.63 秒。新全局守卫影响所有命令，因此复跑独立完整回归；不把范围不同的旧 111/116 或联合 144/149改写。文档检查通过（27 文档、305 引用、27 正式变更接口），git diff --check 通过。两项交原审查者增量复核，尚未推送/PR/关闭 Issue；保护基线待授权维护者汇总。
### 14.3 A1 本地审查收口与交接

原审查者已完成 git diff 60ff466..038a66e 增量复核：Standards 原 README P2 关闭，新增硬违规 0/可操作异味 0；Spec 原全局跨课程键 P2 关闭，新增未解决 0。两轴仅只读复核，未复跑数据库/节点，不计新的测试通过。A1 准确批准服务端范围本地实现、验证、文档与审查已收口；最新独立结果为 §14.2 的 112/117，5项未执行门禁不变。

交 A2/B/C 的真实入口为 createAccessApp/withAuthorizedCourse/withAuthorizedResource 和 db.withTransaction/records-adapter；由服务端可信定位器核课程/归属/用途，外部等待在事务外。调用方先重查当前会话/成员/资源，再核代际并消费实际 C 变更计划，同 tx 保存并提交成功后才 ACK；严格结果 validator 必须验证命令-specific shape及当前授权范围。不可把HTTPbody或模型生成的 ActorContext/scope/authorize 回调当许可。

真实预置账号发放、私有 HTTPS/代理/生产初始化、密钥保管、可靠恢复登记及 C5 对账仍按原具体环境授权/验收条件处理；默认 main健康工厂不等于已配置完整应用。A1候选分支 codex/a1-complete 独立保留；按“完成A1/A2所有内容后分别PR”要求，A2实际 C1 联调未补齐前尚未远程推送/PR/关闭 Issue。任务/README已同步，保护基线待授权维护者汇总。
### 14.4 A2 真实联调已补齐与独立 PR 交付准备

项目负责人交回 PAHER 对 A2 源码 `8421157d7e917067b397d76378ed91096c4a8369` 实际执行结果：Node24.21.0、npm ci/typecheck/build 通过；经真实应用 SSH readiness 与教师/学生 POST /api/sessions 登录，checks→release→assign→pause→assignment active=false 指定用例 1 通过、0 失败、0 跳过。A 已重算 TAP 摘要/节点指纹并核固定活动来源与 C 信封一致；原字节证据及消费详情随 A2 #13 分支交付，不属于 A1 diff。没有改 A1 业务源码或复跑/改写原独立 112/117（5 跳过）；A2 本机全量 151/157 与 PAHER 指定 1/1 分别保留。

此前按项目负责人“完成 A1/A2 所有内容后分别提交 PR”等待的 A2 真实联调条件已补齐。准确批准的 A1 实现、验证、文档与两轴审查收口，开始普通推送/创建独立 PR；不合并、关闭 Issue、修改凭据/CI/既有 schema 或宣称完整 G1。当前 C1/C2 PR 尚未合入 main，A1 base 采用 codex/c2-workspace-core（C2 64eaa958），A2 base 采用 codex/a1-complete，只审各自实际增量；依赖 C1 #16→C2 #17→A1→A2。推送/PR URL/远端 SHA 将回读记录；产品基线仍待授权维护者汇总。
