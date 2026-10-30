# #145 维护、备份、恢复与权威接管

本页记录 [#145](https://github.com/paher-din/XunJie/issues/145) 的操作入口、可信宿主集成契约和实际验收。运行生命周期见 [#143 运行交接](runtime-acceptance.md)，所属数据与资源见 [#144 存储接入](storage-acceptance.md)。[运行库](../../packages/product-runtime/README.md)提供编排，[产品 CLI](../../apps/local-runtime/README.md)负责薄装配。

本轮使用实际分发包完成 Mac arm64、Windows 11 x64 普通用户及 Ubuntu x64 的恢复验收，完成 Mac → Windows 逻辑导入和 Mac → Linux 公网 HTTPS 混合接管。[验收汇总](evidence/wp01-maintenance-summary.json)保存代码版本、七份包摘要、工程检查、浏览器边界与清理结果；完整阶段记录见下表。所有时间为 UTC，2026-10-29 19 时对应北京时间 2026-10-30 凌晨 3 时。

## 当前交付边界

默认 daemon 只自动注册 runtime 自身的 recovery owner，导出运行配置、身份及其数据库 `public` schema。后续课程、Agent、RunDriver、模型连接等业务 owner 随各 WP 接入。声明必需参与者却没有注册其维护和恢复能力时，备份失败并保持关闭，不能省略参与者来生成“完整”备份。

可信宿主通过 `createProductRuntimeHost({ recoveryOwners, createRecoveryOwners, participants })` 装配实际 owner；`createRecoveryOwners` 在原生数据库可用后执行。storage 适配器与独立验收宿主证明接口可组合，不代表现有生产业务数据迁移已完成。[独立脚本](../../scripts/probe-recovery.mjs)及其 [验收 owner](../../scripts/recovery-acceptance-owner.mjs)是公开 API 的消费者，产品代码、包入口和依赖图不得反向导入它们。

候选包的 `app/product-runtime.js` 导出恢复 API 和 `storage` namespace，可信宿主可直接装配包内同一实现，不需要反导入工作树或测试 fixture。通用 CLI 的 `restore` 当前只装配 runtime target；包含其他 owner 的备份必须由可信宿主提供全部 `RecoveryTarget`。

## 引擎、空间与独立材料

固定资源支持 PostgreSQL **17.10、17.11、18.6**，Node.js **24.21.0**。版本须与完整分发中的工具一致，包含 `pg_dump`、`pg_dumpall`、`pg_restore`、`pg_upgrade` 等；见 [资源说明](runtime-resources.md)。当前升级使用逻辑导出到独立目标还原，不原地运行 `pg_upgrade`。小版本方向为同 major 的更高 minor，例如 17.10 → 17.11；大版本方向为更高 major，例如 17.11 → 18.6。引擎校验还要求 UTF8、UTC、`C` collation。

备份目录必须在源环境 root 和 owner 文件资源根之外，不能重叠；独立目录不强制另一物理磁盘。密钥另行保管，不能只有随源数据丢失的那一份。密文备份、独立恢复密钥、目标引擎资源及 owner 迁移/资源后端配置共同构成恢复材料；只复制 `pgdata` 或只留公开 manifest 不足以恢复。

`recovery-key` 创建 32 字节随机二进制文件；`keyFile` 读取原始字节，要求至少 32 字节，不是口令字符串。父目录先由操作者准备，输出文件必须不存在。策略将密钥编码后存为源环境私有 credential，外置 key 文件仍需独立保留。公开 manifest 和输出不包含密码、token 或资源正文。

`minimumFreeBytes` 是预检门槛，备份默认 64 MiB；恢复默认按密文总量加 64 MiB 预检，不是数据库、解密暂存和资源展开大小的上限。空间不足、权限拒绝、工具失败或中断均须按失败处理，不能把目录存在当作完整备份。

学校 `external` 数据库由管理员准备**空的独立目标 cluster/database**、所需连接与建角色/建 schema/还原权限、受支持引擎及匹配升级工具，并提供现场 TLS/凭据配置。产品绑定实际 system identifier/database OID，拒绝复用源库；不拥有 external 数据库的启停、删除或服务升级。维护入口必须使用带匹配 PostgreSQL 备份/还原工具的**完整管理分发包**；不含 PG 工具的 remote-client 包不能用于外部数据库维护。

`restoreProductRecovery` / `upgradeProductRecovery` 接受目标 `database`、`databaseCredential` 和 `installation`。`databaseCredential` 为 string，仅在可信 API 内存中传参，库将其写入目标 database.credentialRef 对应的私有 credential；不把源密码恢复成目标登录凭据。`installation` 为 `Omit<InstallOptions, 'database' | 'requiredServiceIds'>`，支持 profile、host、port、publicEndpoint、tls，供目标学校服务配置新 TLS 入口；数据库单独传入，requiredServiceIds 从备份恢复。其他 owner target 仍由可信宿主通过 `targets` 装配，其数据库通过 `admin()` 等配置接入。

CLI restore/upgrade JSON 现在支持 `database`、`databaseCredentialFile`、`installation`。密码文件为单行非空文本，可带一个末尾换行，保留有意义的空格；读取后加入错误输出 redaction。JSON 只放文件路径，不放明文密码；external 的实际凭据轮换、重开和管理员责任见 [学校验收](evidence/wp01-maintenance-external.json)。

## CLI 操作

下文 `xunjie` 指包内自带 Node 执行 `app/cli.js`，路径是部署示例。JSON 中建议使用绝对路径；相关输入路径按 CLI 当前工作目录解析。结果输出 JSON，错误写 stderr 并非零退出，私密文件内容不进入日志。

### 策略与备份目录

源宿主必须在线；控制命令不隐式启动已停止的 daemon。

```sh
xunjie recovery-key --out /secure/xunjie/recovery.key
xunjie backup-policy --root /srv/xunjie/source --file /secure/xunjie/backup-policy.json
xunjie backup --root /srv/xunjie/source
xunjie backup-list --root /srv/xunjie/source
```

`backup-policy.json`：

```json
{
  "directory": "/backup/xunjie",
  "intervalMs": 86400000,
  "keep": 7,
  "minimumFreeBytes": 67108864,
  "keyFile": "/secure/xunjie/recovery.key"
}
```

`intervalMs >= 60000`，`keep >= 1`，空间门槛为非负安全整数。CLI 自动生成 `recoveryKeyRef`。运行中的宿主每 10 秒检查策略；维护关闸或已有调度时不触发新备份。它不是脱离宿主存活的系统定时任务。

普通 `backup` 成功后默认恢复源写入；`backup-list --file /secure/xunjie/catalog.json` 可选择 `{ "directory": "/backup/xunjie" }`。目录校验使用已配置策略或最近备份保存的 key 引用；选择目录不会自动选择另一把 key。返回 `backups`、`unavailable`、`latest`、`operations`，其中 `latest` 是最近操作；只有经过 key、MAC、密文清单及摘要校验的条目才进入 `backups`。保留策略先退役旧备份目录，再释放 owner 的持久资源 pin，不能在备份仍保留时单独清理其资源。

### 最终 held 备份与恢复

准备 `held-backup.json`：

```json
{
  "directory": "/backup/xunjie",
  "keyFile": "/secure/xunjie/recovery.key",
  "leaveClosed": true
}
```

```sh
xunjie backup --root /srv/xunjie/source --file /secure/xunjie/held-backup.json
xunjie restore --root /srv/xunjie/restored-new --resources /opt/xunjie/resources.json --file /secure/xunjie/restore.json
```

将备份返回的实际 `backupId` 填入 `restore.json`；`backupDirectory` 指向单个备份，区别于策略中的备份集合目录：

```json
{
  "backupDirectory": "/backup/xunjie/<backupId>",
  "keyFile": "/secure/xunjie/recovery.key",
  "minimumFreeBytes": 67108864
}
```

目标 root 必须不存在或为空，数据库及资源目的地也须独立、未占用。先验证全部密文、认证与版本，再还原并通过 owner 服务 API 验证数据、回执、约束、原资源字节和未决效果身份。结果为 `isolated`；CLI 成功后停止目标 runtime，校验完成不等于接管。

恢复保留业务 `environmentId`、service 及原请求/资源/外部效果身份，生成新 `installationId`、client namespace、本地 control/managed DB 凭据。源凭据、TLS 私钥及旧 grant 不直接恢复成有效授权；连接描述保留，秘密需重新配置。storage target 创建新角色凭据并推进存储维护代际，旧句柄须拒绝，恢复后重新打开。接收方授权代际由后续 fencing 持久推进，不能还原旧 grant 文件来复活旧 token。

学校 external/TLS 目标可在同一 `restore.json` 中增加以下字段；这是完整示例，目标数据库及证书文件先由管理员准备：

```json
{
  "backupDirectory": "/backup/xunjie/<backupId>",
  "keyFile": "/secure/xunjie/recovery.key",
  "database": {
    "mode": "external",
    "host": "db-restore.school.example",
    "port": 5432,
    "database": "xunjie_restored",
    "user": "xunjie_restore_admin",
    "credentialRef": "school-restored-postgres"
  },
  "databaseCredentialFile": "/secure/xunjie/target-db-password.txt",
  "installation": {
    "profile": "school",
    "host": "0.0.0.0",
    "port": 3445,
    "publicEndpoint": "https://restored.school.example:3445",
    "tls": {
      "certificateFile": "/secure/xunjie/restored-cert.pem",
      "keyFile": "/secure/xunjie/restored-key.pem"
    }
  }
}
```

数据库本身要求 TLS 时，另按 `DatabaseConfiguration` 提供 `database.ssl.ca`；它与目标产品入口的 `installation.tls` 分别配置。目标 root 仍须独立且为空，密码在恢复流程内部导入，不能先用 set-credential 占用该空目标。恢复的隔离与接管要求不变。

### 接管与重新授权

`takeover.json` 完整列出 manifest 要求的接收方；id 为 `environmentId/serviceId`，root 是接收方真实本机产品 root：

```json
{
  "sourceRoot": "/srv/xunjie/source",
  "receivers": [
    { "id": "<receiverEnvironmentId>/<receiverServiceId>", "root": "/srv/xunjie/receiver" }
  ]
}
```

```sh
xunjie start --root /srv/xunjie/restored-new
xunjie takeover --root /srv/xunjie/restored-new --file /secure/xunjie/takeover.json
```

`start` 只启动已恢复目标的隔离控制宿主，不自动开写闸。只有源当前**最新且仍 held** 的备份可接管；普通备份默认 resume，或 held 后又 resume/创建更新备份，均不能用旧边界退休源，以免丢掉新写。首次退休须由源提供绑定 backupId、源/目标 installationId 的持久证明；没有有效证明时，源不可达、拒绝、超时均不能开闸。若源已完成退休而回复丢失，可从已绑定的源 root 重读 `retired.json`；若目标已持久保存有效证明，接管重试复用它，无需源进程继续存活。receiver 缺失、重复、身份不符或 fencing 失败时仍保持隔离，不提供无证明的强制接管。

CLI 经本机 root 的私有控制接口访问 source/receivers；root 映射不是远程 URL，不代表任意跨机器 CLI 控制已实现。每个 receiver 读取实际运行身份并核对 `environmentId/serviceId`，再对 manifest 全部源服务/owner service 身份 fencing。接收方持久推进 generation、拒绝旧 token，确认已接受的 capability handler 全部结束才返回无秘密 proof；断线/超时不返回可接管 proof。

所有接收方确认后，目标经历 `activating`，维护验证后恢复写入/派发，成功记录 `active`；失败重新封闸并保留隔离。源即使进程仍活着也已退休，不能再 resume/start。接管失败不自动撤销已经发生的源退休或 receiver fencing，须保留实际状态。

接管后在每个接收方显式 `authorize` 签发当前 generation 的新 token。恢复已保留原连接描述，目标应将新 token 通过私密单行文件写回原连接的 `credentialRef`，不用重复登记同一 `connectionId`：

```sh
xunjie set-credential --root /srv/xunjie/restored-new --ref <原连接的credentialRef> --file /secure/xunjie/new-token.txt
```

`new-token.txt` 仅保存新 grant 的 `token` 字段，不是完整 grant JSON；秘密经私密文件交接，不写入 argv 或日志。只有登记新的连接描述时才使用 `connect`；重复 `connectionId` 会明确拒绝。见 [CLI 连接授权](../../apps/local-runtime/README.md#连接授权)。旧 token 不升级。`active` 与连接能力就绪分开判断：必需连接未重授权时不宣称服务 ready。共享目标的公网 HTTPS、TLS、端口与凭据需按新安装配置另行确认。

### 升级与失败重建

```sh
xunjie upgrade --root /srv/xunjie/source --resources /opt/xunjie-pg18/resources.json --file /secure/xunjie/upgrade.json
```

`upgrade.json`：

```json
{
  "kind": "pg-major",
  "targetRoot": "/srv/xunjie/upgraded-new",
  "backupDirectory": "/backup/xunjie",
  "keyFile": "/secure/xunjie/recovery.key"
}
```

`--root` 是源，`targetRoot` 是新目标，`--resources` 选择目标资源。升级先创建 `leaveClosed: true` 的一致备份，再在目标恢复；成功仍为 `isolated`，随后走接管流程。`kind` 支持 `schema`、`pg-minor`、`pg-major`。schema 升级须由真实 owner target 注册新迁移并验证；当前 runtime 自身没有 schema 升级时，通用 CLI 的 `schema` 路径报 `no-schema-upgrade-registered`，不能宣称完成业务迁移。

升级到学校 external/TLS 目标时，`upgrade.json` 同样增加上述 `database`、`databaseCredentialFile` 和 `installation`，这些字段配置的是新目标，源安装配置保持原样。源备份与目标还原均须使用带匹配 PG 工具的完整管理分发。

升级或恢复失败后保留失败目标、源操作记录和完整原备份。修复资源/版本/权限问题后，用升级前生成的**原 backupId**、原 key 和匹配旧 schema/引擎的资源，重新 `restore` 到**另一个独立空目标**，再验证隔离状态和数据。只切回旧 binary 不构成数据库回滚，也不覆盖失败目标或正常环境 B。源尚未退休且决定继续使用源时，可显式恢复源维护；这会失去原 held 边界的接管资格，下一次接管需重新备份。

```sh
xunjie maintenance-resume --root /srv/xunjie/source
```

`maintenance-resume` 先验证再恢复写入/派发，不能绕过 `target-isolated` 或 `source-retired`。恢复不自动重放模型、工具、邮件或其他未知外部效果，保留原身份供所属服务核实。

## owner 集成契约

| 接口 | 宿主与 owner 的责任 |
| --- | --- |
| `MaintenanceParticipant` | 登记真实 serviceId、schemaVersion、resourceRoots、configurationRefs；关闭新写/派发，排空已接受动作，校验，再确认 resume；重启不隐式重开持久闸 |
| `RecoveryOwner` | 提供 participant、`export({ backupId, directory, signal })`、`release(backupId)`；全部参与者 freeze 到同一关闭边界后才开始任何导出；owner 负责领域数据、原资源及版本，编排不猜表 |
| `createStorageRecoveryOwner` | 复用真实导出快照和持久 pin，在快照事务内完成 schema 逻辑导出和原 bytes 复制；`validateService` 经 owner 服务检查 |
| `RecoveryTarget` | `restore({ backupId, targetRoot, directory, recovery, signal })` 返回仍关闭的 owner；targetRoot 是持久目标环境根，directory 是本 owner 解密暂存目录；`validate` 经服务 API 检查结果，targets 与 manifest service 集合一致，失败不改独立正常环境 B |
| `createStorageRecoveryTarget` | 校验迁移历史，准备独立空 schema/角色、文件根或 S3 bucket，校验原字节/约束，应用已登记迁移；默认将新 binding 私密保存到 `targetRoot/credentials/storage-<serviceId>`；后端 id 匹配清单，物理位置独立 |
| `openRecoveredStorage({ root, serviceId, migrations, backend })` | 重启时读取目标私有 binding，校验 environment/service 身份，以新凭据重新打开 OwnedStorage；migrations/backend 由所属 module/可信宿主提供，沿用持久维护闸和代际 |
| `createRecoveryManager` | 绑定目标 environment、新 installation、restored owners 及 maintenance；由目标 manager 执行 `takeover`，源只提供 `retire` |
| `RecoveryReceiver.fence(source, serviceIds)` | 可信宿主核对 receiver 根身份，经真实 authority 对全部传入 serviceIds 调用 `fenceSource`，完整等待后确认；空实现或仅断开连接不满足契约 |

全部 owner 的关闭、排空和验证是同一边界的前提，不能分别备份后再拼装。回执、outbox、未知效果和备份 pin 随所属 owner 恢复；旧进程、旧句柄、旧 credential 分别依靠源退休、存储代际和接收方授权代际失效。

恢复目标的重启接入使用上述持久 binding，不能只依赖恢复进程的 `onRestored` 内存回调，也不能把临时 `directory` 留作凭据位置。业务宿主通过公开 `openRecoveredStorage`（含包内 `app/product-runtime.js` 导出）取得新句柄，再装配业务服务及维护/恢复参与者；binding 含新凭据，按目标私密材料保管。重新打开不自动解除 isolated/maintenance、不退休源或替代 takeover；仍须完成校验与权威交接后才能开闸。

## 失败材料

| 情形 | 结果与后续处理 |
| --- | --- |
| key 错误、密文缺失/损坏、manifest 认证或路径非法 | 拒绝恢复，保留原件和错误分类；补齐正确材料，不生成 active 目标 |
| 缺参与者、排空超时、验证失败 | 保持关闭或 failed；补齐真实 owner，不跳过冻结/校验 |
| 空间/权限/数据库工具失败 | 核对目录、余量、固定工具和授权；预检不代表后续写盘必然成功 |
| schema/引擎/后端不兼容 | 使用兼容资源或注册迁移，从原备份在另一个独立目标重建 |
| 目标已占用、指向源库/源资源 | 拒绝覆盖，保留正常 B；另选 root、cluster/schema、文件根/bucket |
| 源不可达、退休冲突或 receiver 失败 | 保持 isolated，不强制接管；核实源/接收方身份及已经持久化的退休/代际状态 |

证据保留 backupId、边界时间、owner schema/engine 版本、artifact 摘要、耗时和错误分类；状态包括 `recovery-operations/`、`recovery-state.json`、`retired.json`、`upgrade-*.json`。保留失败现场与日志，公开 evidence 不附 key、token、密码、私钥、完整私密配置或业务正文。

## 独立验收命令与证据

[probe-recovery.mjs](../../scripts/probe-recovery.mjs)由独立 agent 维护。它从候选包 `app/product-runtime.js` 装配自己的业务服务，自动切换到包内 Node，root 必须不存在且在仓库/产品包外。以下为可复现命令；本轮实际结果、工具与包摘要保存在随后列出的 evidence 中：

```sh
node scripts/probe-recovery.mjs --help
node scripts/probe-recovery.mjs \
  --package /opt/xunjie-pg18 \
  --old-package /opt/xunjie-pg17.10 \
  --minor-package /opt/xunjie-pg17.11 \
  --s3-config /secure/xunjie/s3-config.json \
  --root /var/tmp/xunjie-recovery-new \
  --out /var/tmp/xunjie-recovery-evidence.json
```

各平台使用实际 full 原生包，Windows 普通用户终端换成本机绝对路径。`--old-package`、`--minor-package` 分别提供 17.10、17.11，主包提供 18.6。S3 配置遵循 [存储验收](storage-acceptance.md)固定后端，使用独立目标 bucket；配置不进日志。省略可选参数会跳过对应验收，跳过不算通过。

跨操作系统仅导入验收使用脚本生成的原 `file-backups/<backupId>/`（含 manifest 与 artifacts）、`private/recovery-key.base64`、`portability.private.json`，通过私密渠道转移到另一宿主：

```sh
node scripts/probe-recovery.mjs \
  --package /opt/xunjie-pg18 \
  --import-backup '/private/transfer/file-backups/<backupId>' \
  --key-file /private/transfer/recovery-key.base64 \
  --expect-file /private/transfer/portability.private.json \
  --root /var/tmp/xunjie-portability-new \
  --out /var/tmp/xunjie-portability-evidence.json
```

该脚本的 key 文件是其自身生成的 base64 文本格式，区别于 CLI `recovery-key` 的原始二进制文件。仅导入模式验证恢复后的服务数据、原字节与隔离，不联系源、不退休源、不接管；跨平台导入成功不能推导源失联时可以开放目标。

脚本在 finally 停止它拥有的宿主/连接池/managed cluster，保留 root 下数据、密文及私密恢复 key 供核验；确认材料不再需要后清理该次独立 root 与秘密，保留公开 evidence。它不管理学校 external cluster 生命周期。

| 验收范围 | 状态 | evidence |
| --- | --- | --- |
| 工程 build/typecheck、完整测试、浏览器 contracts 与文档链接 | passed | [汇总](evidence/wp01-maintenance-summary.json)：`npm run verify` 五阶段通过；默认测试 1,799 项通过、18 项按原配置跳过。打包修正后另跑 3 项实际 bundle/CLI 检查通过 |
| Mac arm64：文件资源、独立恢复、源仍在线接管、正常停启重开 | passed | [Mac 21 阶段](evidence/wp01-maintenance-macos.json)，28.546 秒；恢复凭据持久保存，新宿主/连接池重读原数据及原字节 |
| Windows 11 x64：中文/空格路径、正常/异常退出、恢复与接管 | passed | [Windows 21 阶段](evidence/wp01-maintenance-windows.json)，280.643 秒；[普通用户令牌](evidence/wp01-maintenance-windows-token.json)确认 `elevated: false` |
| Ubuntu x64：文件/S3、schema 与异常退出后的原备份重建 | passed | [Linux 18 阶段](evidence/wp01-maintenance-linux.json)，58.431 秒；Linux 本轮未运行 PG17 小/大版本，两条迁移由 Mac/Windows 分别完成 |
| Mac → Windows 逻辑导出还原、原字节与回执、目标隔离 | passed | [跨平台仅导入](evidence/wp01-maintenance-macos-to-windows.json)，16.364 秒；同一 `39bcf692-c5a4-4aef-be91-479c45513b98`，未联系源或接管；[普通用户令牌](evidence/wp01-maintenance-portability-token.json) |
| 文件与 S3 独立 bucket 恢复、保留 pin、原字节 | passed | Mac/Windows/Linux 各自完整维护恢复；S3 使用固定 SeaweedFS 4.50。真实跨机对象链路另见 [hybrid](evidence/wp01-maintenance-hybrid.json) |
| 17.10 → 17.11 小版本升级与 17.11 → 18.6 大版本升级 | passed | Mac/Windows 各自完成；[CLI minor](evidence/wp01-maintenance-cli-minor.json)、[CLI major](evidence/wp01-maintenance-cli-major.json)另覆盖自动备份、保留策略、隔离与接管 |
| owner schema 1 → 2、升级进程中途退出、原备份新目标重建 | passed | Mac/Windows/Linux 均在新 schema 实际还原后终止工作进程，再从原 backupId 重建并验证后接管；未来生产 owner 随所属 WP 补验 |
| 错 key、缺失/损坏材料、空间、版本、占用目标及正常 B 保全 | passed | 三平台失败阶段；Mac/Windows 另拒绝“工具18.6、external 实际仍17.11”的伪升级。真实写盘不足见 [8 阶段](evidence/wp01-maintenance-disk-space.json)：256 MiB 新 RAM 目标在数据库已还原后的资源复制中不足，同备份在普通磁盘重建，原源/备份/B 不变 |
| 源仍在线退休、断连、旧 token、旧进程/接收方重启、未知效果不重放 | passed | [真实 Mac → Linux 公网 HTTPS](evidence/wp01-maintenance-hybrid.json) 9 阶段；实际停止 bridge 注入断连，接管后旧 token 及接收方重启后的旧 token 均拒绝，新授权按原 effectId 取得原回执且 counter 不增加。缺 receiver、超时、失联无证明及退休重试另有公开 API 回归 |
| 学校 external 空目标、凭据轮换、权限及启停责任 | passed | [Ubuntu external 7 阶段](evidence/wp01-maintenance-external.json)；管理员通过独立 provider 管理一次性 cluster，学校产品以 external 连接接入，学校 stop/uninstall 不停止或删除数据库；管理员重启后使用持久新 binding 重开 |
| Chrome 与教学效果 | 部分执行 | Mac 桌面 Chrome 156 实际观察升级后 `ready → maintenance → ready`、PG18.6、新 installation 与恢复 namespace；Windows Chrome 和教学效果未执行，不计通过 |

本轮文件备份边界分别为 Mac `2026-10-29T19:06:32.087Z`（备份 141 ms）、Windows `19:08:18.108Z`（662 ms）、Linux `19:07:53.793Z`（1,157 ms）；真实混合备份为 `19:08:03.031Z`（1,310 ms）。这些是小型独立验收服务的实际耗时，不是容量或性能承诺。每个 evidence 保留原 backupId、版本、artifact 摘要、阶段耗时与失败分类。

最初一次全量验证在开发工具的临时快照中因缺少 `zod` / `better-sqlite3` 失败；切换到完整固定 Node/npm、完成 `npm ci` 并提交代码快照后，完整门禁通过，未放宽依赖或测试。随后打包器仅从固定资源 catalog 选择可构建版本，避免 `--help` 依赖预编译 storage；相关 bundle/CLI 检查另行通过。

通用 CLI 通过本机私有 root 发起接管；真实跨机案例通过可信宿主的 SSH receiver adapter 调用相同公开编排与 authority API，数据与外部效果经过公网 HTTPS。该证据不表示已交付任意远程管理 CLI。学校 external 证明使用独立的一次性管理员 provider，未操作现有学校数据库。

清理时停止所有本次宿主、PG 与 S3，删除一次性私密恢复材料和计划任务，卸载仅本次创建的 RAM 设备，并撤销临时 TCP38196 入站规则；规则集合与运行前完全一致。原生包可从固定缓存重建，公开 evidence 保留在仓库。签名、公证延续本轮暂不执行的决定。
