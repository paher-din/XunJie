# PostgreSQL 与所属资源存储

`@xunjie/storage` 是 Node 专用存储 implementation。跨端资源、回执和错误类型只从 `@xunjie/contracts/storage` 消费；浏览器不导入本包。公开入口是 `package.json` 的 `exports`，不导入 `src/` 或内部 driver。

本包提供 owner 隔离的连接、迁移、短事务、不可变资源、引用/备份保留、GC 和维护参与。业务 module 登记自己的 SQL、请求身份、引用和领域约束；本包不领取 Run、不派发模型或工具，也不消费旧 SQLite 数据或队列。

## 宿主装配与 owner

`provisionStorage({admin, owner, password, migrations})` 在可信安装/维护宿主中调用。`owner` 是产品环境和所属服务的 UUID；`admin` 来自产品运行配置及凭据解析器。`password` 是宿主在仓库外私密保存的该服务稳定凭据，重复登记/迁移沿用它，不能每次重新随机生成。返回的 `StorageBinding` 含秘密，只留在私密配置，不作为 wire 对象或日志输出。

底座为每个 environment/service 创建独立 schema、无登录迁移角色和受限登录角色。普通连接没有 superuser、建库、建角色、角色成员资格和 schema DDL 权限；只能读写本 owner 的对象。已有共享数据库若给 `PUBLIC` 开放了 schema CREATE，应由其管理员调整，存储入口会明确拒绝此配置，不暗中修改其他应用的权限。

原生引擎默认使用安装票的 PostgreSQL **18.6**，维护升级另固定支持 **17.10、17.11**，其余版本明确拒绝；初始化使用 UTF8、libc `C/C`、UTC，仅 `plpgsql`；本机和 Ubuntu 学校端运行同一 SQL。UUID、bigint/numeric 字符串、微秒时间文本、JSONB、bytea 都有实际往返案例。需要原字节的模型/工具记录使用资源，不能指望 JSONB 重编码保留字节。

迁移必须按 `1..N` 连续登记 `{version,name,sql}`，版本、名称和 SQL 摘要持久保存。已登记脚本不可修改、跳号或降级。会话级 advisory lock 拒绝并行迁移；角色、schema、业务迁移和账本在同一事务创建。已有 schema 升级先关闭写入，经同一入口应用新迁移，再用新版本 module 校验和开放；维护关闭及 schema 升级分别推进持久代际，旧句柄不能继续写。

实际 module 示例见 [storage-sample](../../apps/server/server/storage-sample/index.ts)，独立 HTTP 验收宿主见 [host.mjs](../../apps/server/tests/storage-sample/host.mjs)。示例只验证存储机制，不登记课程、学生或 Run 事实，也不装配进旧业务入口。

```ts
import { openStorage, provisionStorage, createFileBackend } from '@xunjie/storage';
import { sampleMigrations, createStorageSample } from '../../apps/server/server/storage-sample/index.js';

// admin、owner、servicePassword 均由可信宿主从产品配置/私密凭据取得。
const binding = await provisionStorage({ admin, owner, password: servicePassword, migrations: sampleMigrations });
const storage = await openStorage({ binding, migrations: sampleMigrations,
  backend: createFileBackend({ id: 'learning-files', root: privateResourceRoot }) });
const service = createStorageSample(storage);
```

## 请求、资源和待发意图

`request({requestId,fingerprint}, effect)` 把 owner 的业务变化、请求身份、接收结果和 `tx.enqueue` 的意图一起提交。重复身份等待原事务完成后返回相同回执；相同身份不同 fingerprint 返回 `identity-conflict`。`tx.query` 只允许单条 DML/SELECT，不能结束所属事务，也不能借数据库角色跨 owner 写表。回调只做有界的数据库工作；默认 SQL 超时 5 秒，不在其中上传资源或调用外部服务。

底座不会自动重试回调。连接在 COMMIT 时中断或回包超时，返回带原 `requestId` 的 `commit-unknown`；按原身份调用 `receipt`，确认后沿用回执。未查明之前不生成新请求或重放外部效果。`receipt(id,fingerprint)` 可让 module 在资源处理前验证并直接返回已确认的重试。

`stageResource({uploadId,scope,bytes,mediaType,contentVersion})` 先登记稳定上传身份，再在事务外写不可变对象、重读并校验 SHA256/长度，最后标记 ready。随后在短事务中 `tx.reference(referenceId,resourceId)`，原子发布业务状态、引用及必要 outbox。上传身份同时是资源 UUID；永久定位是 backendId 与相对 key，配置中的根目录或 S3 endpoint 可以迁移，不是永久身份。调用方不得绕过后端修改或删除已发布对象。

每次资源初始登记生成独立 `locator.writeId`，物理对象的版本化封装同时保存它；重读必须匹配本次写入身份及原字节摘要。仅有相同正文的旧对象不能确认一次仍未知的 PUT 已结束。`readResource` 返回逐字节相同的原正文；备份通过 `readResourceObject` 取得已校验的、不透明物理对象并按清单 locator 复制，连同数据库保留写入身份和封装，不能用正文导出替代资源备份。

资源已完成而业务事务回滚，可用原 uploadId 重试/重新关联；冲突元数据或不同原字节返回 `identity-conflict`。每个 uploadId 只允许最初登记者执行一次 PUT；重复调用只核实原对象，并发重试最多等待 15 秒，未查明则返回 `upload-unknown`，不另发 PUT。上传未知使用原身份 `reconcileUpload` 核实，不重新执行产生字节的模型/工具。进程死亡留下的 uploading 状态持续阻止维护排空和 GC；确认旧上传进程已停止后，由恢复宿主显式核实原对象。后端仍不可达时不能当作“没有上传”；确认失败的对象可回收，重新关联保留原业务请求身份与原字节。

引用由所属 module 显式登记，包括业务记录、仍保留的接收回执和其他保留责任。`tx.unreference` 只解除指定引用；示例在替换 record 的资源后，仍单独保留旧 receipt 的资源引用。owner 决定何时可以释放这些领域引用。

`pendingIntents()` 只读出已提交、未完成的待发项；它不是队列领取或外部效果执行器。所属服务通过后续领域协议处理效果身份、接收确认和 `tx.completeIntent`。维护关闭派发后禁止取得新的待发列表。

## 保留、GC 与维护

GC 的 `olderThan` 是宿主明确给定的保留边界。候选对象与新引用竞争同一行锁；取得锁后用新语句再检查持久引用和备份 pin，提交 deleting 后才在事务外删除。进入 deleting 的身份不再接受引用。删除失败留下可重试状态；维护排空会完成已声明的删除或明确失败，不能忽略后端错误。

把 `storage.participant()` 登记到 `@xunjie/product-runtime/maintenance`。关闭新写入等待已开始的事务，推进代际并持久关闸；关闭派发后排空上传/删除，恢复验证检查 schema 及全部被引用/保留的原字节，再重新开放。状态持久在 PostgreSQL；服务重启不会自动重新开放。旧 peer 需重新 `openStorage`；维护宿主自己的 participant 在成功 resume 后更新句柄代际。

`snapshot(backupId, consume)` 仅允许关闸并排空后调用。它先持久保存资源清单及 pin，覆盖全部已确认的 `ready` 资源（包括尚未被业务引用的上传）、当前业务引用和既有备份的保留责任，再提供真实 `pg_export_snapshot()`，供同库逻辑导出导入快照。consume 完成前快照事务保持存活；调用方应在此期间完成数据库导出和资源复制。上传不使用这种长事务。清单记录 owner、schema/资源格式、代际、摘要和资源身份，不含秘密。

`validateManifest` 拒绝遗漏当前引用、重复身份、摘要/字节错误和版本不兼容；participant 另验证所有当前引用及备份 pin。备份 pin 跨重启保持，只有备份确实退役后才 `releaseBackup`。完整备份位置、逻辑还原、跨平台迁移、接管及唯一权威交接由 #145 编排，不由本包隐式恢复或外部重放。

管理员恢复入口 `prepareStorageRestore({admin, owner, password})` 只接受未占用的目标 schema/角色，返回含 `migratorRole` 的 binding，临时授予该迁移角色创建 schema 的权限。维护宿主使用公开 binding 与原生 `pg_restore --role <migratorRole> --no-owner --no-acl` 还原完整所属 schema；不另枚举业务表。

复制全部原始资源对象后，`finalizeStorageRestore({binding, admin, migrations, manifest, backend})` 撤销临时 DDL 权限、推进关闭的恢复代际，按 owner 登记的迁移检查实际结构、约束、序列、角色权限与读写能力，并校验引用资源。返回的 `OwnedStorage` 保持写入和派发关闭。新凭据须私密持久保存，生产维护适配器负责这一步；重启接入与完整操作见 [#145 维护交接](../../docs/student-agent-implementation/maintenance-acceptance.md)。失败不回退为开放状态，不靠新建业务请求或重放外部效果恢复资源。

## 错误语义

| code | 调用方处理 |
| --- | --- |
| `conflict` | CAS、唯一/外键、序列化冲突或 SQL 超时；事务整体回滚，重新读取领域状态 |
| `identity-conflict` | 同一请求/上传身份对应不同输入；不能换内容继续沿用该身份 |
| `commit-unknown` | COMMIT 结果不能由连接状态判断；按原 requestId 查询，不自动重放 |
| `upload-unknown` | 按原 uploadId/locator 核实；不假设未上传 |
| `maintenance` / `stale-generation` | 写闸关闭或句柄过期；经维护恢复/重新打开，不强行写入 |
| `resource-busy` / `resource-gone` | 对象尚未完整确认或已进入删除；不能发布引用 |
| `missing` / `corrupt` | 已定位对象缺失或字节/清单校验不符；恢复原资源，不重跑外部效果 |
| `forbidden` / `unavailable` | 权限与连接/后端故障分别处理；不把故障解释为没有数据 |
| `invalid` / `incompatible` / `migration-busy` | 修正输入、版本/初始化条件，或等待当前迁移执行者 |

## 验证

运行方式、固定后端和实际平台证据见 [存储接入与验收](../../docs/student-agent-implementation/storage-acceptance.md)。普通 `npm test` 覆盖文件/HTTP 协议回归；真实 PG、S3、子进程及服务 HTTP 案例由 `npm run test:storage:native` 明确运行，缺少配置失败而非跳过。
