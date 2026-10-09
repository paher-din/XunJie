# A1：应用基础、权限与短事务实施记录

主责：A。任务：[Issue #10](https://github.com/paher-din/XunJie/issues/10)；协调：[G1 #9](https://github.com/paher-din/XunJie/issues/9)，接缝：[C2 #14](https://github.com/paher-din/XunJie/issues/14)。日期：2026-10-09（Asia/Shanghai）。开始基线：bc1d466a073521235e54cb6995bfcc476619fafd。

状态：**P1 已实现且验证通过，独立审查中；P2/P3 未开始。A1/G1 未完成。**

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
| Git 空白/范围与独立 Standards/Spec 审查 | 待最终审查记录 |

系统 Node 24.15.0 执行 `node tools/check-runtime.mjs` 实际被拒绝（预期退出码 1，仅输出批准/实际版本）；使用批准运行时的安装、检查、测试与编译均通过。

npm ci 报告 better-sqlite3@13.0.3 的 node-gyp 原生构建脚本未获 allowScripts 放行。本批未执行该脚本，也未加载驱动/打开 DB/执行 SQL；仅安装 JS 工程及驱动包，不宣称原生 DB 已可用。P2/P3 交付实际存储方案时明确原生构建授权/环境并核 sqlite_version、外键/WAL/回滚，不能忽略此限制或静默换驱动。

关闭验证的边界：直接 app.close 已验证释放真实监听端口；编译入口退出清理在 Windows 使用终止子进程。SIGINT/SIGTERM 优雅关闭处理已实现，但 Linux 信号路径未执行，不把 Windows 进程终止算作 Linux 优雅关闭验收。

### 5.3 失败与修复记录

TDD 实际红灯：缺 app/config/validation 模块和 main 入口；ready 返回默认 404；非法 JSON/超限/媒体格式被当作服务失败；未知路由默认回显 URL；内部失败缺少安全关联诊断。逐项增加实现后对应单文件测试通过。请求 ID、领域冲突、实际 app.listen/app.close 和 compiled main 为既有行为回归测试，未声称它们都曾红灯。

类型检查曾因 Fastify 未导出的日志类型、err serializer 必需字段、error 的 unknown 类型与真实 fetch JSON 的 unknown 类型失败；改为实际支持的结构类型、固定脱敏 serializer、类型收窄及测试端响应 schema 后通过。Fastify 旧日志选项产生弃用提示，改为当前 LogController API，没有关闭警告。

初稿曾加入未列入 TECH §5.1 的 NOT_FOUND/INTERNAL_ERROR 公共码；交付前规格复核移除，统一使用正式码集并同步测试/本任务说明，不以任务稿单方冻结新码。未改产品规格以迁就实现。

### 5.4 未完成与下一步

独立审查、最终范围检查及本地提交进行中；待完成后在本节追加事实。向 B/C 交付本分支工程入口和公共解析/错误；C2 的真实 tx/Job/Receipt/Event 接缝尚未联调。P2/P3 先起草存储/认证实际对象、操作、原生安装、风险和授权方案，具体授权与 C2 条件满足后再实现。SQLite/认证/真实权限/幂等/并发、AI/费用、专用执行隔离、浏览器/真人及性能业务验证均**未执行**。Issue #10/#9 保持 Open，不计完整 AC-02/NFR-04/G1 通过。

## 6. 基线汇总请求

待授权维护者汇总：MVP_SPEC §10、TEAM/G1 登记本批实际代码/命令及 P1 交付状态，P2/P3/完整权限和业务验收未完成；不直接修改受保护文件，不关闭 Issue #10/#9。
