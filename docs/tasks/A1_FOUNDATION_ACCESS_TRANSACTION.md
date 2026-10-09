# A1：应用基础、权限与短事务实施记录

主责：A。任务：[Issue #10](https://github.com/paher-din/XunJie/issues/10)；协调：[G1 #9](https://github.com/paher-din/XunJie/issues/9)，接缝：[C2 #14](https://github.com/paher-din/XunJie/issues/14)。日期：2026-10-09（Asia/Shanghai）。开始基线：bc1d466a073521235e54cb6995bfcc476619fafd。

状态：**P1 已完成本地交付，独立审查通过；P2/P3 未实施，操作方案初稿见 §6。A1/G1 未完成。**

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

本次仅 README、本任务记录、一个 A 自有合成参数工具有变化，应用 P1 无行为改动；未改 package/lock、受保护基线或其他模块。待独立审查与本地提交收口。既有产品验收与本节真实 SQL/认证用例保持未执行。P2/P3 操作提案待批准，C2 缺少公开交付证据的依赖保持，P1 工程远程交接尚未完成。
