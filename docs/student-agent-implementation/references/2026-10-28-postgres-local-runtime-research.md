# 本机 PostgreSQL 路径：分发、监督与 PGlite 等价边界

日期：2026-10-28。性质：外部事实调查与架构依据，非目标设备验收报告。负责人已确认本机与共享端统一原生 PostgreSQL、由产品管理本机实例；正式选择见[决议](https://github.com/paher-din/XunJie/issues/120#issuecomment-6473266878)，实现与安装验收另行开展。

本次只读仓库与外部一手资料，唯一新增文件为本文；未安装、下载数据库二进制或运行数据库，未做性能测试。排除 `docs/archive/`，未另启研究 agent。调查限定三个开源仓库：`leinelissen/embedded-postgres`、其二进制上游 `zonkyio/embedded-postgres-binaries`、`electric-sql/pglite`；另查 PostgreSQL 官方文档与官方指向的 EDB 分发入口。已查证的源码以 commit 固定，网站和 npm 元数据为调查时快照。

## 可选架构结论

**建议优先选择本机与共享端统一使用原生 PostgreSQL，产品负责本机生命周期。** 这条路径能实质消除 SQLite/PG 双方言、双迁移与双并发模型的长期维护面；代价转为两平台二进制交付、监督、备份和升级。当前证据足以把它列为架构首选，尚不足以承诺“Win11 x64 + macOS arm64 已可无感安装、签名分发、可靠升级”。PostgreSQL 已有官方生命周期工具和面向嵌入应用安装包的分发入口，因而无需先假定学生要手装服务或必须安装 Docker。[官方 Windows 分发](https://www.postgresql.org/download/windows/)；[官方 macOS 分发](https://www.postgresql.org/download/macosx/)；[pg_ctl](https://www.postgresql.org/docs/18/app-pg-ctl.html)

**PGlite 应视为另一种运行时，而非原生 PG 的透明本机替身。** 同源 SQL 引擎可减少语法与类型差异，但单连接、socket 复用、取消协议、VFS 与升级路径仍形成第二套运行契约。本轮目标并没有“绝对零后台进程”，不宜为了省去 postgres 子进程而提前接受这些差异。[PGlite 单连接说明](https://pglite.dev/docs/)；[socket 边界](https://pglite.dev/docs/pglite-socket)

本次工程重评保留 **SQLite 单引擎备选**：如果后续原生 PG 的产品打包代价不可接受，再评估“本机和共享服务均由所属服务独占管理 SQLite、调用者只经服务契约访问”的完整方案。它与“本机 SQLite／共享 PG”双适配不同；SQLite 事实另见[存储方案研究](2026-10-28-storage-options-research.md)，不能据本报告宣布该备选已通过运行验收。PGlite 也不应自动成为打包失败后的默认退路。

## 从产品目标推导数据库边界

依据负责人当前要求及[总体架构文档](2026-10-27-overall-architecture-proposal.md)：同一客户端支持个人/学校空间；客户端、空间/课程、学习数据、教学协调/Agent、模型连接、工具执行六个逻辑单元允许本机、共享或混合部署。教师端课程设计与制作属于产品能力，本轮不深入；ALU/Flights 内容是验证存储与运行契约的开发资料，内容准备属于开发交付，具体课程内容不是产品功能。

以下是设计推论，不是数据库厂商承诺：

- 六个逻辑单元不要求六套数据库实例。本机可以由一个产品监督器托管一个 PG cluster，按事实所有者组织数据库/schema/角色；分离部署后，各所有者连接自己所在位置的存储。实际隔离粒度另定。
- 远端单元经领域服务访问事实，不应为追求“一套数据库”而跨网络直读别的单元私有表。空间切换解决路由、身份及归属，不能退化成任意切换连接字符串。
- 统一引擎不自动产生跨端同步，也不让不同存储所有者间的事务变为原子事务。共享接收、待发工作、幂等与未知结果恢复仍需应用契约。
- 浏览器界面关闭与本机运行组件退出是两个事件。既然允许后台进程，本机 PostgreSQL 可随实际服务生命周期运行，不必绑定页面存活。
- 原生 PG 本机/共享端可共用 SQL、迁移和驱动，但仍要固定支持的 major、扩展与 locale 配置，并分别验证本机恢复和共享并发。不能把“同引擎”写成“所有部署天然等价”。

## 原生 PostgreSQL：已证实的可分发与管理基础

| 路径 | 已查证事实 | 产品层仍需承担 |
| --- | --- | --- |
| PostgreSQL 官方入口指向 EDB binaries | Windows、macOS 页面均明确提供无 installer 的二进制 archive，用途包括集成进其他应用 installer。macOS 表列出 arm64；Windows 表是 64-bit Windows Server 测试矩阵，并未列出 Win11 认证。 | 产品选择和固定 artifact；验证 Win11 标准用户、macOS arm64 实机；签名、依赖和安装体验不能由下载页推导。 |
| `leinelissen/embedded-postgres` | Node 包，按平台选择 `darwin-arm64` 或 `windows-x64`；可配置私有目录、端口、认证和启动参数；调用真实 postgres/initdb。 | 上层生命周期、版本迁移、备份、错误恢复，以及下述 Windows 停止缺口。 |
| `zonkyio/embedded-postgres-binaries` | 上述 wrapper 的二进制上游；构建定义包含 Windows amd64 与 Darwin arm64v8；Win/Mac repack 脚本从 EDB 下载并裁剪。项目自述定位为测试用途的精简包。 | 产品不能将“测试 bundle 可启动”升级为发行保证；需补齐工具链、分发与恢复验收。 |

来源：[官方 Windows](https://www.postgresql.org/download/windows/)、[官方 macOS](https://www.postgresql.org/download/macosx/)、[EDB binaries](https://www.enterprisedb.com/download-postgresql-binaries)、[wrapper 平台选择源码](https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/packages/embedded-postgres/src/binary.ts)、[Zonky 构建定义](https://github.com/zonkyio/embedded-postgres-binaries/blob/c56022003f8b1a6284567c365f44738b7e83514b/build.gradle)、[Zonky README](https://github.com/zonkyio/embedded-postgres-binaries/blob/c56022003f8b1a6284567c365f44738b7e83514b/README.md)。

本轮读取 npm registry 元数据，两个平台包 `latest` 均返回 `18.4.0-beta.17`，具备实际 tarball 地址及 integrity 元数据，不只是 README 宣称。Darwin arm64 的 `unpackedSize` 为 147,710,671 bytes，Windows x64 为 109,333,174 bytes；这是 **registry 声明的解包大小**，不是压缩下载量、完整产品安装大小或本次实测。未下载、解包或验证 artifact。不能拿 Zonky README 的概括性小包体积代替具体版本的产品预算。[Darwin 元数据](https://registry.npmjs.org/@embedded-postgres/darwin-arm64/18.4.0-beta.17)；[Windows 元数据](https://registry.npmjs.org/@embedded-postgres/windows-x64/18.4.0-beta.17)

### wrapper 可复用，但不能原样认定为产品监督器

源码有两个直接影响采用方式的事实：

1. `start()` 根据 stderr 中的就绪文本完成等待；`stop()` 在 Windows 使用 `taskkill /pid … /f /t`，在其他平台发 `SIGINT`。这不是跨平台一致的正常关闭路径。此处只断言源码行为，不据此虚构已发生数据损坏。[生命周期源码](https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/packages/embedded-postgres/src/index.ts)
2. CI 虽列 `windows-latest`，实际两个 `npm test` 步骤都排除 Windows。Zonky 的 CI 配置另有 Windows amd64 bundle 测试，但 macOS 任务调用的是 amd64 测试；这些配置都不能作为本产品 Win11 + arm64 验收通过证明。本次未读取成功的 CI run 结果。[wrapper CI](https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/.github/workflows/test.yml)；[Zonky CI](https://github.com/zonkyio/embedded-postgres-binaries/blob/c56022003f8b1a6284567c365f44738b7e83514b/.github/workflows/test.yml)

安装链还有实际差异：wrapper 要求 postinstall 重建 symlink；其构建下载器从 Maven 的 Zonky artifact 解包，包含 `tar`/`xz` 或 `7z` 路径。这是维护者的包准备链，不应转嫁成学生安装前置步骤。产品应在构建阶段完成资源准备，再验证最终 installer 中的可执行文件、动态库和链接布局。[wrapper README](https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/README.md)；[下载器源码](https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/packages/downloader/src/index.ts)

**更直接的建议：产品维护一个有界的 PG supervisor，以官方 `initdb` / `pg_ctl` 为生命周期接口；wrapper 可作参考或二进制入口，不把产品恢复契约交给其退出 hook。** `pg_ctl` 已提供目录定位、启动、状态、超时等待和 smart/fast/immediate 停止；Windows 注册系统服务是另一个可选操作，并非运行前提。正常关闭可采用 `fast` 并等待完成；强杀属于异常恢复场景。[pg_ctl 官方语义](https://www.postgresql.org/docs/18/app-pg-ctl.html)

监督器建议承担：固定版本的可执行资源与可写数据目录分离；每目录唯一所有者；回环监听及产品分配端口；端口冲突时重试且不误接已有陌生实例；初始化与重启区分；SQL 就绪核对；正常停止、异常重启与日志控制。`listen_addresses`、`port` 是 PG 原生配置；`initdb` 要由数据和服务器的所有者运行，在 Unix 上不能以 root 运行。私有用户目录方案与这些原语吻合，但无管理员安装的完整两平台体验尚待探针。[连接配置](https://www.postgresql.org/docs/18/runtime-config-connection.html)；[initdb](https://www.postgresql.org/docs/18/app-initdb.html)

### 备份与升级必须进入安装设计

Zonky 当前 Win/Mac repack 白名单只保留 `initdb`、`pg_ctl`、`postgres` 这些可执行工具及相关资源/库；**没有打入 `pg_dump`、`pg_restore`、`pg_upgrade`**。直接采用该精简 bundle 并不能完成备份升级。可选择完整 EDB binaries 的受控子集，或在自己的打包步骤补齐匹配版本工具；具体 artifact 内容还需解包探针确认。[repack 源码](https://github.com/zonkyio/embedded-postgres-binaries/blob/c56022003f8b1a6284567c365f44738b7e83514b/scripts/repack-postgres.sh)

PostgreSQL 同 major 的 minor 更新保持内部存储格式兼容，基本操作是停库、换二进制、重启；major 更新需 dump/restore、`pg_upgrade` 等迁移路径，并检查行为变化。产品更新器必须区分它们，不能每次 npm/app 升级都直接覆盖旧数据库运行文件。[升级文档](https://www.postgresql.org/docs/18/upgrading.html)

`pg_dump` 可产生一致逻辑导出，逻辑导出格式可跨架构迁移；它只导出一个数据库，角色等全局对象另处理。普通复制运行中的 PGDATA 不是有效备份方式；完整停库复制或满足条件的一致快照有不同前提。建议把“新版本新目录恢复并核验，再切换；失败保留旧版本与旧目录”作为最初可验证的升级方案。迁移窗口之后有新写入时，不能承诺直接回切旧目录而不丢数据。[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)；[文件备份限制](https://www.postgresql.org/docs/18/backup-file.html)

PG 本身允许修改和分发，需保留相应声明；wrapper 为 MIT，Zonky 工程声明 Apache 2.0。这些标签不代替选中二进制内第三方库的实际分发清单，也不证明它已有可供 XunJie 使用的签名/公证。具体签名状态本轮未核验。[PostgreSQL License](https://www.postgresql.org/about/licence/)；[wrapper 许可说明](https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/README.md)；[Zonky 构建与许可元数据](https://github.com/zonkyio/embedded-postgres-binaries/blob/c56022003f8b1a6284567c365f44738b7e83514b/build.gradle)

## PGlite 与远端 PostgreSQL 的等价边界

PGlite 是 PostgreSQL 的 WASM 构建及 JS/TS API，可在浏览器和 Node/Bun 等环境使用；不是独立本机 PostgreSQL server 的另一个发行包。[项目说明](https://pglite.dev/docs/about)

| 维度 | 已证实的边界 | 对 XunJie 的含义（推论） |
| --- | --- | --- |
| SQL、约束、事务 | 使用 PG 内核，提供参数化查询和提交/回滚事务 API；这一点支持复用大量关系模型与 SQL。[API](https://pglite.dev/docs/api) | 可减少 SQLite/PG 方言差异，但 ORM、类型解析、迁移、底层 PG major 与 locale 仍要对齐，不能宣称零适配。 |
| 并发与多连接 | 原生 PG 有多个客户端会话及各自 backend；PGlite 一个实例只有单连接。socket 可接多个 TCP 客户端，但有全局队列，事务期间优先处理该事务所属 handler，非多个 backend 并行执行。[PG 架构](https://www.postgresql.org/docs/18/tutorial-arch.html)；[socket 文档](https://pglite.dev/docs/pglite-socket)；[队列源码](https://github.com/electric-sql/pglite/blob/a197da04ffd5a04a944d7ee28a41a94c3d899b35/packages/pglite-socket/src/index.ts) | “多个请求可到达”和“多个事务可同时持锁执行”不同。单服务串行访问可设计，但本机测试不能覆盖共享 PG 的事务竞争。不能多个进程各开实例指向同一 dataDir 来冒充连接池。 |
| 锁、领取与会话状态 | 原生 PG 文档定义跨事务锁冲突与 session/transaction advisory locks；PGlite 的单连接/队列没有同样的独立并发会话条件。[PG 锁](https://www.postgresql.org/docs/18/explicit-locking.html)；[单连接说明](https://pglite.dev/docs/) | 不断言 PGlite 所有锁 SQL 不支持；但即使 `FOR UPDATE` / `SKIP LOCKED` 能执行，也不能证明多 worker 竞争领取、死锁、隔离重试等价。session advisory locks、临时表、SET 与 prepared statements 的跨 socket 隔离需单独查证，不能作为当前承诺。 |
| 协议 | JS API 可处理 PG wire messages；另加 socket 包才能提供 TCP server。所查 socket 默认 maxConnections=1，SSLRequest 回 `N`，CancelRequest 被消费并忽略。[socket 源码](https://github.com/electric-sql/pglite/blob/a197da04ffd5a04a944d7ee28a41a94c3d899b35/packages/pglite-socket/src/index.ts) | 连接同一个 PG driver 不意味着取消、连接池、TLS、认证及会话语义全部等价。这里的取消结论只针对该 socket 实现，不扩大为所有 JS 层取消能力。 |
| 扩展 | 有扩展目录，例如 pgvector；C/原生扩展须适配 WASM，依赖链也需 WASM 构建，不是直接加载宿主 `.dll` / `.dylib` / `.so`。[扩展目录](https://pglite.dev/extensions/)；[扩展开发](https://pglite.dev/extensions/development) | 只能承诺选定版本中已打包且验证过的扩展。不能从“PG 支持”推导后台 worker、任意原生扩展及外部依赖都可用。 |
| 持久化 | 默认内存；NodeFS、IndexedDB、OPFS AHP 是不同 VFS。IndexedDB 会加载数据库文件到内存并刷回变更；relaxedDurability 可先返回结果再异步 flush。官方当前不支持 Safari 上的 OPFS AHP。[文件系统](https://pglite.dev/docs/filesystems) | 需选明确 VFS 和持久确认点。不能把 API 返回、浏览器持久化和原生 PG 的恢复保证写成同一件事；异常退出恢复必须测试。 |
| 多标签页 | 官方 Worker 方案选一个 leader 持有 PGlite，其他标签代理查询；leader 关闭后重选并启动新实例。[Multi-tab Worker](https://pglite.dev/docs/multi-tab-worker) | 解决访问协调，不提供多个数据库 backend；全部页面退出后的后台工作不能由此保证。 |
| 备份与升级 | `dumpDataDir` 只设计为导回 PGlite；不能承诺导入其他 PG。PGlite minor 升级可能破坏兼容，官方路径是旧实例逻辑 dump 后导入新实例。[API](https://pglite.dev/docs/api)；[升级](https://pglite.dev/docs/upgrade) | PGlite/远端 PG 应走经过验证的逻辑导出或应用迁移；不能交换 PGDATA，也不能等同于原生 PG minor 更新。 |

补充两项容易遗漏的恢复和数据语义差异：

- 官方 `pglite-tools` 提供 WASM `pg_dump`，默认附加 inserts、单线程等参数；导出后执行 `DEALLOCATE ALL`，影响同一连接已有 prepared statements。它是真实可用的逻辑迁移基础，但恢复兼容性仍受目标版本、扩展、角色与对象集合限制；不是完整跨端同步协议。[pglite-tools](https://pglite.dev/docs/pglite-tools)
- PGlite 的完整 ICU locale 数据独立分发。中文排序等若依赖 locale，需要与远端 PG 的 provider/version 对齐；普通查询能够运行不足以证明排序和索引语义一致。[Locale support](https://pglite.dev/docs/localesupport)

Windows/Mac 的使用判断：浏览器或嵌入 JS runtime 的 WASM 路径减少了分别分发 postgres 原生可执行文件的工作；NodeFS 可让桌面本机服务持久化。**这只是可运行机制与官方支持环境声明，不是两种目标 OS 的产品验收。** 所查 PGlite `build_and_test.yml` 使用 Linux runners；本次未取得 Win11 x64、macOS arm64 的安装、NodeFS 崩溃恢复和目标 WebView 验收结果。macOS 上尤其不能把 Safari 的 OPFS AHP 限制套成“所有 Mac 不支持”，也不能把 Chromium 能用套成“所有 Mac WebView 都能用”。[入门](https://pglite.dev/docs/)；[VFS 支持表](https://pglite.dev/docs/filesystems)；[所查 CI](https://github.com/electric-sql/pglite/blob/a197da04ffd5a04a944d7ee28a41a94c3d899b35/.github/workflows/build_and_test.yml)

## 维护成本与安装代价的比较

| 方案 | 能收敛的维护面 | 新增或保留的成本 | 本轮判断 |
| --- | --- | --- | --- |
| 本机原生 PG + 共享原生 PG | 共用引擎、SQL、迁移工具及真实多会话契约 | 两平台 artifact、动态库与签名，私有目录和端口，进程监督，版本/备份/恢复；仍保留两类部署测试 | 优先；把未知项集中在可独立验收的产品安装与监督边界。 |
| 本机 PGlite + 共享 PG | 可复用较多 SQL/关系模型；WASM 减少本机 PG 二进制打包工作 | 单连接与多会话差异、JS/socket 接入、VFS、WASM 扩展、两套升级恢复；有后台需求时仍需持有它的宿主 | 有明确浏览器嵌入或单持有者价值时可选；当前不优先。 |
| 本机与共享均 SQLite（主任务备选） | 原则上可统一引擎；具体收敛程度本轮未核查 | 共享端并发、所有者进程与水平部署策略需另证；不能直接共享数据库文件给六单元 | 保留为独立候选，不以本文背书可行性。 |

以上成本判断是架构推论，不含吞吐、延迟、内存或启动耗时的测量与排名。学生操作可以在前两种方案中都做到“安装产品、进入空间”；差异主要在团队必须交付什么，而非学生必须配置什么。Docker、JDK、7z 等上游构建链依赖不自动成为学生运行依赖。

## 已足以决策与后续打包探针

**现在足以决定：** 不再因“本机”默认选择 SQLite 或 PGlite；把原生 PG 统一引擎作为优先方案；本机 PG supervisor 与业务数据访问分层；不原样采用所查 wrapper 的 Windows stop；不把 PGlite 单连接测试视为共享 PG 并发验证。上述选择已有机制和源码证据，不需要先做性能竞赛。

**尚不足以决定：** 最终 binary supplier/version、产品是否完全免管理员安装、最终安装体积、签名/公证可行性、升级窗口与异常恢复可靠性。以下为后续工作建议，本轮均未执行：

| 探针 | 最小范围与通过证据 |
| --- | --- |
| 1. 最终 installer 两平台交付 | 固定一个 PG major 和确切 artifacts，在干净 Win11 x64 标准用户、macOS arm64 上从实际分发包安装；无需已有 PG、Node、Docker、JDK 或构建工具。记录额外系统依赖、权限请求、中文/空格路径、离线首次启动及卸载保留数据行为；核对 x64/arm64 原生架构。 |
| 2. 签名与资源布局 | 检查 exe/DLL、Mach-O/dylib、symlink、加载路径；以产品自身发布流程完成 Windows 签名验证与 macOS 签名/公证/Gatekeeper 实际打开。wrapper 有 tarball 和 integrity 仅是输入，不是此项通过。 |
| 3. 监督与故障恢复 | 私有目录唯一所有者；多开、端口被占、旧实例遗留、宿主意外退出、睡眠恢复；正常停止采用 pg_ctl 等待结果；强杀后重启，核对已确认提交、未提交事务及待发记录。不得靠删除锁文件或重新 initdb“修复”有数据目录。 |
| 4. 备份和升级回退 | 检查实际 bundle 含所选 dump/restore/upgrade 工具及依赖；演练一次 minor 更新和一次 major 迁移；新目录验证 schema、约束、序列、角色及关键业务记录后切换；注入磁盘不足/中途退出，确认旧数据保留。跨 Win/Mac 迁移用逻辑恢复验证。 |
| 5. 同一引擎的业务契约 | 同一迁移在本机和共享 PG 执行；两个真实会话验证领取代际、冲突事务、取消和断线后的未知结果。空间切换及混合部署验证事实路由，而非跨所有者直写表。 |
| 6. 仅在继续考虑 PGlite 时 | 固定 runtime/VFS/底层 PG major；验证长事务与 socket 竞争、会话状态、取消、扩展、类型映射、持久 flush、异常退出、旧版导出到新版及远端 PG。若只能通过限制能力成立，应把限制写成长期契约，不隐藏在测试替身中。 |

优先做 1–4，以最小产品壳验证原生 PG 的交付成本；无需先重写业务。它们通过后，再用 5 验证统一引擎的实际收益。若失败，应根据具体失败项重评完整 EDB 资源包、自己的裁剪/监督实现或 SQLite 单引擎备选，不能把一个 wrapper 的缺陷判为原生 PostgreSQL 不可本机化。

## 证据版本与调查边界

- `leinelissen/embedded-postgres`：`8c8c16d1b81bec8ae3315d59a050654086a85e23`；所读 npm 两平台包版本为 `18.4.0-beta.17`，源码与发布 artifact 未做逐文件一致性核验。
- `zonkyio/embedded-postgres-binaries`：`c56022003f8b1a6284567c365f44738b7e83514b`；核对了 README、构建、repack 与 CI 配置，没有运行构建。
- `electric-sql/pglite`：`a197da04ffd5a04a944d7ee28a41a94c3d899b35`；socket 结论针对该 commit，不能推定所有已发布 npm 版本相同。
- PostgreSQL 使用 `/docs/18/` 稳定 major 文档作为机制依据；未选择产品最终 major。网站内容可能继续更新，本文不以网页中的 latest 数字替代锁定 artifact。
- 外部文档与源码核查完成；工程运行测试、浏览器验收、目标系统安装探针、教学效果验证均未执行。未发现记录不等于能力不存在；本文不作 PGlite 完整兼容审计，也不扩展其他候选库。
