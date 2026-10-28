# 产品权威存储与资源存储：有界官方事实研究

日期：2026-10-28（Asia/Shanghai）。用途：XunJie wayfinder / grilling 的 research 子任务；为长期部署取舍提供证据，不代替负责人决议。仅查官方一手资料，未安装软件、启动服务或进行性能试验。

决策状态：负责人已确认统一原生 PostgreSQL、由产品管理本机实例，见[正式决议](https://github.com/paher-din/XunJie/issues/120#issuecomment-6473266878)。下文保留备选方案的机制与成本比较；它们不是并行支持承诺。

## 结论与建议

1. **A、B、C 都能实现既定持久化契约，部署位置不直接决定数据库。** SQLite 放在持有数据的服务宿主本地，通过领域 API 供跨机组件访问，能够覆盖学校单宿主；六单元可拆分不等于六个数据库，也不要求其他机器直接打开 `.db`。[SQLite 适用场景](https://sqlite.org/whentouse.html)
2. **A 最省安装与数据库适配成本，但必须接受每个数据库文件的写事务串行化。** 单对象单写入所有者不等于整个数据库没有并发写入；不同 Run、作品和 outbox 仍会竞争。学校是否适用不能按学生人数拍阈值，应由真实事务负载及恢复目标验证。[SQLite WAL](https://sqlite.org/wal.html)
3. **按负责人要求重新审视约束后，选择 C：统一原生 PostgreSQL，已获确认。** 已定要求是学生无需手工准备服务，没有后台零进程或极小包体要求；本机组合已经需要可信服务。C 共用数据/事务与迁移实现，由产品持续承担本机初始化、运行、升级和恢复管理。B 的双后端仍可行，但不能仅由本机易用性证明其长期适配成本必要。没有证据证明所有学校必须使用 PostgreSQL，也没有证据证明 C 的实测性能或总成本必胜；具体判断见[重构方案](2026-10-28-rebuild-storage-and-acceptance-proposal.md#从实际约束推导)。[PostgreSQL 并发](https://www.postgresql.org/docs/18/mvcc-intro.html)、[服务启动](https://www.postgresql.org/docs/18/server-start.html)
4. **资源采用本地文件默认、S3 兼容后端可选，独立于 A/B/C。** 权威元数据和状态转换留在事务数据库；原生模型大记录与课程资源分别管理引用、访问与保留责任。即使同用一个资源接口，也不混为公共课程文件。S3 强一致性不提供跨 key 或跨数据库事务。[S3 一致性](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
5. **当前直接建新 schema；未来恢复才需要发布后的升级契约。** 未发布旧版仅有开发数据，备份并按需提取，不做旧 API／旧会话兼容、生产双写或在线迁移。未来升级须保留稳定身份、outbox、CAS／lease 代际、资源引用和外部效果的可核实性，不能靠换数据库重新执行未知命令。此项来自本轮负责人确认及项目契约，不是数据库官方提供的业务保证。

## 研究前提与范围

只读取[总体架构](2026-10-27-overall-architecture-proposal.md)的总体部署、事实所有权与持久运行相关小节。沿用六单元同机／跨机、个人全本地／学校统一／混合部署、单对象单写入所有者，以及 RunStore 内状态与 outbox 原子提交、CAS 与 lease 的契约。数据库是各所有者的持久化设施，不接管领域所有权；跨组件不引入分布式数据库事务。

最新范围覆盖文档中的旧表述：当前未发布且只有开发数据；两门样本是开发、验收与演示资料，其内容准备属于开发交付，但课程内容本身不是产品功能。教师端课程设计／制作是产品能力，只是当前阶段尚未深入设计，不应排除出产品范围。第二课程选材由主任务核查，本研究不展开。现有开发小共享服务器不限制学校产品部署；Phoenix 的 SQLite 选型不构成本报告的产品依据。不假设人数、QPS、数据量或硬件，不穷举数据库／对象存储产品。

## 官方事实表

“对本项目的含义”均为基于事实与已定契约的工程推论。PostgreSQL 引用固定为 18 版文档以便复核，不等于确定产品版本。

| 议题 | 官方事实与准确来源 | 对本项目的含义 |
| --- | --- | --- |
| SQLite 的跨机边界 | SQL 发起代码与数据库文件在同一宿主时，即使用户通过网络访问应用服务，SQLite 仍可能适用；不建议多台机器直接并发访问网络文件系统上的同一数据库。[适用场景 §3](https://sqlite.org/whentouse.html#checklist_for_choosing_the_right_database_engine) | 学校端通过 API 共享成立；不能把 `.db` 放入 SMB／NFS 当作共享数据库。A 的“单宿主”指一个库的直接访问端，不要求六单元全部同机。 |
| SQLite 写入与 WAL | 每库同时只有一个 writer；WAL 允许读写并行，使用同机共享内存；长读事务可能阻碍 checkpoint，使 WAL 增长。[WAL §2.2、§6](https://sqlite.org/wal.html) | 短事务完成 claim／状态／outbox 后释放写锁；模型、工具、文件上传不得占着写事务等待。监测写入排队及 checkpoint，不能仅看平均吞吐。 |
| SQLite 条件更新与重试 | WAL 下读快照升级为写可能遇到 `SQLITE_BUSY_SNAPSHOT`；`BEGIN IMMEDIATE` 提前领取写事务，但它本身可能遇到写竞争。[隔离与事务升级](https://sqlite.org/isolation.html) | CAS 可用带版本／代际条件的更新并检查受影响行数；读改写操作在适配器内安排短事务。冲突时重读／重试事务，不只无限延长 busy timeout。 |
| SQLite 持久与备份 | WAL + `synchronous=FULL` 每次提交同步 WAL；`NORMAL` 在断电／硬重启后可能丢失已提交事务。在线备份 API 提供一致副本，另可用 `VACUUM INTO`。[同步设置](https://sqlite.org/pragma.html#pragma_synchronous)、[备份 API](https://sqlite.org/backup.html) | “可靠保存”须绑定实际同步策略；默认建议 FULL 并验证磁盘／文件系统语义。优先使用引擎备份能力，不把运行中复制单个 `.db` 视为备份。 |
| SQLite 文件与版本边界 | WAL 是持久状态的一部分；把库文件与 WAL 分离可能丢事务或损坏。官方还记录 WAL-reset bug，修复于 3.51.3 及以后，部分旧分支有修复回移。[WAL §4、§11](https://sqlite.org/wal.html) | 停机复制要先正常关闭全部连接并确认状态；在线不能用依次复制文件代替一致快照。安装验收应核对实际驱动内嵌 SQLite 是否含修复，不能只查系统 CLI 版本。 |
| PostgreSQL 并发 | MVCC 支持并发访问，行锁只阻塞同一行上的冲突写／锁请求；仍可能死锁。[MVCC](https://www.postgresql.org/docs/18/mvcc-intro.html)、[行锁与死锁](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) | 可让不同对象并发写入，热点预算行／同一 Run 仍有竞争；单写入所有者及旧 worker fencing 仍须实现。 |
| PostgreSQL 隔离与 CAS | 默认 Read Committed 是语句级快照；更新等待并发写提交后会重评估 `WHERE`。Repeatable Read／Serializable 可能要求重试整个事务。[隔离级别](https://www.postgresql.org/docs/18/transaction-iso.html) | 单行 CAS 的条件更新有依据；跨行预算／去重不变量仍须唯一约束、合适的锁或隔离级别。不能把“默认有事务”当作所有读改写都正确。 |
| PostgreSQL 持久确认 | `synchronous_commit` 非 off 模式通常等待本地 WAL 刷盘；off 可在报告成功后丢失近期事务；`fsync` 等配置同样影响保证。[WAL 配置](https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT) | 权威写入保留可靠持久设置；单机落盘确认不等于宿主损毁后无损恢复，也不自动获得高可用。 |
| PostgreSQL 备份与 PITR | `pg_dump` 取得单数据库一致快照，可在线运行；角色／tablespace 等全局对象另备份，多库 dump 快照不同步。PITR 要物理 base backup 与覆盖恢复范围的连续 WAL，不能把 SQL dump 接上 WAL 重放。[SQL dump](https://www.postgresql.org/docs/18/backup-dump.html)、[PITR](https://www.postgresql.org/docs/18/continuous-archiving.html) | B/C 能采用逻辑备份或按恢复目标增加 PITR；两种方案都不包含外置 blob。多所有者／多库需要应用恢复清单。 |
| PostgreSQL 文件复制 | 普通数据目录复制要求停服；在线可采用包含必要 WAL 的一致文件系统快照或专用备份流程。[文件级备份](https://www.postgresql.org/docs/18/backup-file.html) | 不能把在线复制数据目录当作低成本备份捷径。 |
| S3 对象一致性 | Amazon S3 对对象 PUT／DELETE 后读取与列表提供强一致，单 key 更新原子；不提供多 key 原子更新。[一致性模型](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel) | 写 blob 与写数据库仍有崩溃窗口；不能用对象存储替代 RunStore 的事务 outbox／CAS。 |
| 条件写与内容校验 | S3 支持 `If-None-Match` 防覆盖及 `If-Match` 检查 ETag；multipart／部分加密对象的 ETag 不是全文 MD5。[条件写](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[校验与 ETag](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html) | 应用自己保存内容摘要、长度与编码版本；ETag 可作供应商条件令牌，不能通用作内容身份。 |
| “S3 兼容”的范围 | R2 官方单列已实现／未实现 API、header 与 checksum 能力；其对象强一致与条件写另有明确说明。其文档特别指出一次 404 不能排除先前未知结果的在途 PUT 稍后提交。[兼容矩阵](https://developers.cloudflare.com/r2/api/s3/api/)、[一致性及未知 PUT](https://developers.cloudflare.com/r2/reference/consistency/) | 只定义本项目需要的 API 子集，并逐后端验收；AWS 保证不能直接推广到所有兼容实现。上传结果未知时保留原 key／身份并核实，不凭一次 404 生成另一个对象。 |
| 对象历史与维护 | S3 Versioning 可保留旧版本并用 delete marker 表示删除，默认关闭，各版本单独占用存储；PostgreSQL 有服务生命周期和 vacuum 维护职责。[Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)、[服务启动](https://www.postgresql.org/docs/18/server-start.html)、[vacuum](https://www.postgresql.org/docs/18/routine-vacuuming.html) | 版本保留是可选恢复能力，不等于独立备份或自动满足业务保留期；C 把数据库进程维护带到个人设备，B 主要集中在学校端。 |

## A／B／C：产品代价与长期适用条件

| 方案 | 长期可行组合 | 简洁之处 | 不能省掉的代价／选择条件 |
| --- | --- | --- | --- |
| A：本机及学校单宿主 SQLite + 本地资源 | 个人全本地、学校统一单宿主；混合部署由各权威所有者提供 API。资源位于持有它的宿主本地，对远端提供受控读取。 | 一个数据库适配器；无独立数据库守护进程；备份／迁移可由产品统一封装。 | 每个库写入串行，需测队列等待和尾延迟；数据库／资源宿主故障恢复由产品处理。不能凭“小型学校”标签宣称足够；同一库的多宿主直接访问不在此方案内。 |
| B：本机 SQLite、学校 PostgreSQL；共享领域及持久化契约 | 个人权威服务使用 SQLite，学校权威服务使用 PostgreSQL；混合空间按对象归属路由，不为同一对象保留两个写权威。学校仍可选本地文件或 S3 兼容资源后端。 | 个人运行负担低；学校端获得并发事务及成熟备份选择；领域不用按部署模式分叉。 | 两套 SQL／事务适配、schema 迁移及契约测试；类型、时间、JSON、约束、冲突重试必须显式统一。不能只靠 ORM 声称等价，也不要求所有 PostgreSQL SQL 都能直接用于 SQLite。 |
| C：所有权威服务均使用 PostgreSQL | 个人全本地也在设备上运行 PostgreSQL；学校统一或混合均使用同一类数据库后端。可以合设一个实例并保持逻辑所有权。 | 单数据库方言与迁移体系；环境间并发语义差异较少。 | 产品需包办本地数据库初始化、启动停止、故障诊断、升级与备份；省下适配成本，却增加每次安装的运行维护成本。一个引擎不等于一处实例，更不等于自动容灾。 |

**工程判断与选择：** 采用已确认的 C，把部署差异收敛到运行管理，避免同一业务长期维护两个事务/迁移后端；第一阶段验证真实 Windows/macOS 安装与恢复负担。A 也是可长期采用的简洁备选，须接受并实测每库写队列边界；仅有六单元可拆分不足以淘汰它。B 在有明确双端约束时仍可选择，本次不采用。PGlite 与远端 PostgreSQL 即使同源，也不能视作同一种多连接运行环境。当前没有数据证明某方案性能或总成本必胜，架构取舍与性能验收分别表达。

无论选哪种引擎，RunStore 状态与对应 outbox 必须进入同一事务提交域。尤其 SQLite WAL 下，`ATTACH` 的多个库仅各自原子，不能把跨文件提交当作整体原子；不要为了绕开单 writer 而拆散必须共同提交的记录。[WAL 限制](https://sqlite.org/wal.html)

安装方式与数据库选择分开：PostgreSQL 官方支持原生服务进程；**不要求学生／教师手工安装 Docker 作为前置**。产品可封装所选运行方式或连接维护者已有实例，具体打包是否可靠须在目标操作系统安装验收，本报告不预先宣称已解决。

原生 Win/macOS 二进制来源、wrapper 生命周期缺口、备份升级工具裁剪，以及 PGlite 的并发/持久化差异，另见[本机 PostgreSQL 路径研究](2026-10-28-postgres-local-runtime-research.md)。

## 资源后端与跨存储恢复设计建议

以下是工程建议，不是数据库或对象存储自动提供的事务保证。

| 后端 | 适合的简洁形态 | 产品成本与边界 |
| --- | --- | --- |
| 本地文件 | 数据持有服务管理私有目录、不可变 key、流式读写；跨机经 API 访问。个人及学校单宿主均可选。 | 产品负责权限、配额、临时文件、落盘、备份与磁盘故障；临时文件发布的原子性和持久性须针对目标 OS／文件系统验证。不能以 rename 成功代替持久保存证明。 |
| 可选 S3 兼容接口 | 维护者配置 endpoint／bucket，领域只保存稳定内容身份和定位信息；所需子集为 PUT／GET／HEAD／DELETE、条件创建及必要的 multipart 能力。 | 增加网络、凭据及后端运维／服务费用；逐供应商验证条件写、校验、读后写、删除、版本及超时语义。不要为了本机默认路径强加对象存储服务。 |

两种后端采用相同的最小恢复协议：

1. **登记与写入分开。** 所有者先持久登记上传意图／稳定 key、内容摘要和保留责任；写入不可变 blob，本地完成可靠落盘／发布，远端取得成功确认或按原身份核实。可使用独立 staging 状态，不把未完成对象暴露成可用引用。不要在数据库事务内等待上传。
2. **先可靠 blob，再发布引用。** 数据库短事务核对对象可用，提交业务引用、状态及必要 outbox；对原生模型结果，ModelGateway 先提供可重读的持久引用，RunStore 再原子提交步骤完成与工具待发项。模型记录与课程资源即便共用物理后端，也分访问域及保留域。元数据记录至少含空间／所有者、稳定资源 ID、后端定位、摘要、长度、格式版本；不把宿主绝对路径或会过期的签名 URL 当资源身份。
3. **接受可回收孤儿，避免已发布悬空引用。** blob 已写但数据库提交失败，可按身份重试关联；事务失败不立即删除 blob。上传超时保留未知状态，按原 key 核对；若对象已存在则验证内容身份。重试不得覆盖不同内容，也不重新请求已经保存的模型结果。
4. **GC 与引用建立必须协调。** 发布引用前具有持久保留／pin；清理者先取得可删除资格并阻止新引用，再异步删除和记录完成。仅“扫描当前无引用”或设置固定宽限时间，不能解决引用／删除竞态。跨组件引用由保存方承担保留责任，释放要可重试；Run、活动、交付、恢复清单仍持有引用时不得删除。
5. **备份是数据库快照加可恢复资源清单。** 对单所有者，最简单可用短暂停写／冻结变更与 GC 的导出窗口；未来若需要在线备份，再定义一致快照及资源 pin 协议。清单标识 schema／数据格式、快照身份、资源 ID／摘要／版本、上传中对象及 outbox 等状态。多组件不能靠“相同时间戳”宣称一致，须共同冻结或采用已定义的保留与重放边界。
6. **恢复以引用完整性为验收。** 从数据库快照的引用集逐项恢复并校验 blob；不能用目录列表／bucket 列表猜当时关系。PostgreSQL PITR 窗口内可能引用的对象版本也须保留；数据库恢复到某时点不自动倒退对象存储。S3 版本能力只是可选手段，独立备份及保留策略仍需定义。缺失资源明确不可用，不自动重跑有副作用命令来“补齐”。

## 首次重构与未来升级恢复

**本次首次重构：** 旧开发数据及资源做可识别备份，记录来源版本与必要格式；按新领域直接建立新 schema。需要样例／历史片段时再做显式、可重跑的提取转换。无需旧 API、旧会话续接兼容，不建立双写、生产在线迁移或自动合并个人／学校数据的系统。

**未来新架构发布以后：** 推荐先提供允许维护窗口的升级／迁移路径，不预先承诺在线切换。要点是：

- 迁移前冻结相关写入和派发，核实在途模型／工具请求；未核实的保留原身份及未知状态。建立含数据库、资源、schema 版本的可恢复备份。
- C 使用同一 PostgreSQL 迁移体系，跨主机/平台采用受支持导出与恢复流程，不直接搬运行中的数据目录；数据库引擎升级与业务 schema 升级分别管理。若改选 B，SQLite ↔ PostgreSQL 的转换仍须领域数据格式／显式映射，不能直接执行 SQLite dump。三方案都固定 ID、空间归属、版本、时间、预算、去重键、outbox／inbox、水位与引用；B 的类型差异可用严格表和适配校验收窄，但不能消失。[SQLite STRICT 类型边界](https://sqlite.org/stricttables.html)、[PostgreSQL 升级](https://www.postgresql.org/docs/18/upgrading.html)
- 分批复制资源时保存进度与摘要，失败可续；发布前验证引用闭包、唯一性／约束、关键汇总及可恢复状态。资源后端可以单独迁移，不更换逻辑内容身份。
- 切换时撤销旧写入／派发权限，以恢复代际或部署 fencing 阻断旧 worker，再开启新权威。只导入旧 lease 到期时间不足以证明安全；恢复备份会倒退数据库状态，外部效果并不倒退。
- 新库开始接收写入或派发后，不能简单把旧备份切回继续写。回退须先冻结并对账新增事实与外部结果；未知命令先查询／按契约人工裁决，不因迁移而生成新身份重放。以上恢复约束三方案相同。

## 尚需真实验证的边界

| 验证方向 | 后续需要的证据 | 本次状态 |
| --- | --- | --- |
| 写入负载与竞争 | 用真实的接收输入、claim、步骤／outbox、预算结算、作品保存负载，测事务耗时、排队、尾延迟、busy／重试、checkpoint／WAL 增长；比较目标硬件上的 PostgreSQL 锁等待及热点。不按人数或课程名称造阈值。 | 未压测；不能判定学校容量。 |
| 持久化契约 | 并发领取、CAS 失败、lease 过期旧 worker、取消与派发竞态、事务中断、重复接收；B 在两个引擎运行同一组有意义的契约测试。 | 未实现／未测试；官方机制不等于项目通过。 |
| blob／备份恢复 | blob 成功但 DB 失败、上传回执丢失、404 后迟到 PUT、GC／新引用竞态、缺 blob、恢复旧快照后的外部结果核对、备份真正还原及恢复耗时。 | 未演练；RPO／RTO 需先由产品确定。 |
| 安装及升级 | 目标 OS 的实际 SQLite 版本／驱动、文件落盘、应用升级、权限与磁盘满；B/C 的原生 PostgreSQL 打包、启动恢复、升级和备份还原；选定 S3 兼容后端的最小语义矩阵。 | 未安装验证；不要求用户手工准备 Docker。 |
| 产品验收 | 部署维护者可完成个人／学校／混合连接，用户看到的本机保存、共享接收等确认与真实持久边界一致。 | 未做浏览器验收；两课程只作开发／演示背景，本次不评价教学效果。 |

本研究未更改服务或产品代码，不代表已经通过验收。统一原生 PostgreSQL 和产品承担本机生命周期的取舍已经确认；目标平台安装与资源成本仍须由后续实际探针确认，不以当前开发环境代替产品部署要求。
