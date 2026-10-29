# WP01 PostgreSQL 与资源接入

本页交付 [#144](https://github.com/paher-din/XunJie/issues/144)的接口与验证入口，母规范为 [WP01](specs/wp01-product-runtime-and-data.md)。[package 接入说明](../../packages/storage/README.md)集中维护所有权、迁移、错误、资源引用和维护协议；[产品运行交接](runtime-acceptance.md)维护引擎资源和环境配置，不在这里复制运行生命周期。

## 实际消费者与边界

`@xunjie/storage` 提供可信宿主的 `provisionStorage`、所属 module 的 `openStorage`、默认文件后端与可选 S3 后端。`@xunjie/contracts/storage` 提供浏览器安全的 ResourceReference/StorageReceipt/StorageFailure；SQL、pg、连接和秘密不进入 wire 契约。

[storage-sample 产品 module](../../apps/server/server/storage-sample/index.ts)登记自己的业务迁移与 CAS 规则，实际使用同一事务、资源和维护接口。[独立 HTTP 宿主](../../apps/server/tests/storage-sample/host.mjs)只负责装配和故障控制；它不进入生产 package、server build 或产品依赖图。示例验证记录、回执、资源与 outbox，不承担未来课程、RunDriver、教师提交或模型协议事实。旧 SQLite 原件、DTO 和队列保持独立，不自动接续。

## 可重复运行

使用 Node.js **24.21.0**。PG 使用 #143 已固定的完整 **18.6** 分发，初始化固定 UTF8、libc `C/C`、UTC，仅 plpgsql；每个案例自动创建并清理真实隔离实例。共享端使用相同实现，正常服务账户只有本 owner 的 DML 权限。

S3 兼容验收固定 [SeaweedFS 4.50 官方 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.50)，commit `ec8f9793502c59ce3381cc4151bfc0806afd92e8`。[临时 S3 宿主脚本](../../scripts/storage-s3-fixture.mjs)固定 Mac arm64 / Linux x64 / Windows x64 archive 与二进制 SHA256，使用随机私密凭据、loopback、独立数据目录和受认证 bucket；这证明此版本组合，不泛化为全部 S3 供应商。Windows 使用私有继承 ACL、实际进程创建时间/路径核对及 PUT/GET/DELETE 就绪探针。S3 不是产品本机安装前提。

```sh
npm ci
node scripts/storage-s3-fixture.mjs --download --root /tmp/xunjie-storage-s3
# 上一步 stdout 返回私密 s3-config.json 的路径；不要把文件内容放进日志。
export XUNJIE_STORAGE_S3_CONFIG=/tmp/xunjie-storage-s3/s3-config.json
export XUNJIE_PRODUCT_POSTGRES_BIN=/absolute/pinned-postgresql-18.6/bin
npm run test:storage:native
node scripts/storage-s3-fixture.mjs --stop --root /tmp/xunjie-storage-s3
```

`--binary` 可复用相同固定二进制；`--stop` 核对本次进程身份，只停止服务并保留资源。确认不再需要验收数据后删除对应临时根。测试不会连接学校既有业务数据库，也不改变其服务或数据。原始日志与公开结果保存在 `.verification/storage-*/`，可用 `npm run test:storage:native -- --out /absolute/result.json` 导出结果；缺少 PG/S3 配置明确失败。

Windows 在普通用户终端运行，环境变量使用 PowerShell 的 `$env:XUNJIE_PRODUCT_POSTGRES_BIN`、`$env:XUNJIE_STORAGE_S3_CONFIG`。保留完整固定 PG 分发及同目录 UTF8 `.exe.manifest`；S3 目录放在工作树外。`pg_ctl -w` 启动夹具以工具退出确认结果，释放被 postmaster 继承的输出管道；无须等数据库停止才能结束启动步骤。

真实案例覆盖：两会话重复请求、唯一约束/CAS 及跨行回滚；同物理实例的双环境/多 owner 权限；真实 PostgreSQL 回包丢失和回包超时；事务子进程强杀；不可修改及并发迁移、维护后 schema 升级和旧句柄拒绝；文件/S3 原始 bytes 与未知 PUT；资源完成而 DB 回滚；实际损坏、缺失、拒绝访问和部分对象；引用/删除竞争；持久备份 pin、真实导出快照及清单缺项；被杀上传者的持久未决身份、缺参与者失败和重启后的关闭状态；产品 HTTP 双进程接收、提交后杀进程、重启读取及旧回执资源保留。

## 实测结果

Mac、独立包消费者及 Ubuntu 的原始实现/用例输入 SHA256 为 `4423d0d3578dceb5fdf7f160f92f83ac36c190ea422db6b382c4a18bbfcb7d12`。Windows 补验仅修正原生夹具和宿主脚本，未修改产品实现；公开 package 的 JavaScript 摘要逐项核对相同，独立类型检查不依赖内部 `@types/pg`。Windows 输入另记录其夹具及原生路径分隔符的摘要，原始日志摘要均保留在结果中。

| 范围 | 实际结果 |
| --- | --- |
| Mac arm64 原生存储 | PostgreSQL 18.6、文件和 SeaweedFS 4.50，20/20 通过，0 跳过；包含真实 HTTP 双进程、COMMIT 回包丢失/超时、强杀、迁移及资源竞争。[结果](evidence/wp01-storage-macos.json) · [日志](evidence/wp01-storage-macos.log) |
| Ubuntu 学校组合 | 实际 Ubuntu 24.04.5 LTS x64 / kernel 6.8，使用独立目录的相同 npm 包、PG 18.6 及固定 S3 后端；同套 20/20 通过，0 跳过。[结果](evidence/wp01-storage-linux.json) · [日志](evidence/wp01-storage-linux.log) |
| 分发消费者 | 实际打包 contracts/storage/product-runtime，在仓库外独立安装；产品 module 严格类型检查无需内部 `@types/pg`，无工作树链接或测试宿主进入 package。Mac、Linux、Windows 实际消费者通过同套案例；Windows 执行移入的纯 JavaScript 依赖图，不使用宿主 npm 或本机原生依赖模块。[分发证据](evidence/wp01-storage-distribution.json) |
| 工程检查 | 提交 `28f4c89` 后以完整 Node 24.21.0 运行 `npm run verify`，类型检查、构建、浏览器契约、文档链接及全量回归五阶段通过；普通存储回归 14/14。既有外部环境条件跳过项仍单独记录，不当作运行成功。[门禁结果](evidence/wp01-storage-verification.json)；原始日志在 `.verification/2026-10-29T15-56-55-463Z-lPB8cu/`。 |
| 实现审查 | Standards / Spec 分别复核；上传执行权、持久化确认、未知 PUT、备份 pin 及发布包发现的问题已修复，最终复核无剩余发现。 |
| Windows | 2026-10-30（Asia/Shanghai）在 Windows 11 x64 build 26200、`InteractiveToken / Limited` 普通用户令牌下，以固定 Node 24.21.0、PG 18.6 和本机 SeaweedFS 4.50 完成 20/20，0 跳过；严格消费者类型检查通过。包括中文/空格 PG 数据路径、事务/子进程故障、文件/S3、引用/GC、维护及 HTTP 重启读取。[结果](evidence/wp01-storage-windows.json) · [日志](evidence/wp01-storage-windows.log) |
| 浏览器与教学 | 本票没有新增 UI，未执行浏览器操作或教学效果研究；公共 storage wire 的浏览器依赖检查通过，不导入 Node driver。 |

审查补充的关键反例包括：重复上传不得产生第二个 PUT；未知 PUT 不能被相同正文的旧对象确认；文件 GET 必须完成持久化屏障；备份 B 必须继续覆盖备份 A 的 pin；旧维护/schema 代际不得覆盖新状态。所有失败保持明确状态，不自动重放模型或工具。

验收后已停止并删除双方临时 PostgreSQL/S3、独立消费者、私密配置及传输归档，保留本页证据与验证日志。首次完整回归使用了不含 npm 的产品 Node 子集，并遇到提交前 lockfile 与 Git 快照不一致；改用已有完整 Node 24.21.0、提交本票快照后重新执行门禁，全部通过，未为此修改旧复现/依赖兼容规则。

Windows 补验后也已核对并删除本轮普通用户任务、数据库/S3、私密配置和消费者临时目录，原 #143 服务未操作。补验涉及的夹具在 Mac 上完成 6 项真实 PG 回归；S3 脚本完成 Windows 原生启动、数据就绪、认证、停止与语法复核。产品实现沿用已通过五阶段工程门禁的 `28f4c89`，本轮没有新增产品代码。

## 关票核对

#144 的 14 项验收条件均已有实现与证据，Windows 是此前唯一未执行的技术验收，现已补齐。完整备份、引擎升级和权威交接归 #145；本票没有 UI 或教学研究交付，旧回归的 18 项环境条件跳过不成为新增阻塞。技术验收齐备后，交付步骤仍应核对代码进入目标分支，并同步 GitHub 验收清单及工单状态。
