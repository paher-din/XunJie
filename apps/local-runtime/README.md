# XunJie 产品 CLI（候选交付）

本目录提供产品运行、维护恢复及学校成员管理 CLI，薄装配 `@xunjie/product-runtime` 公共 API。项目入口见[根 README](../../README.md)，既有教学 Web 说明见[相邻 Web README](../web/README.md)。默认产品网页已接入[学习空间身份与活动](../../docs/student-agent-implementation/wp02-identity-activity.md)，`school-member` / `school-membership` / `school-connection` 从仓库外私密输入建立成员、授予或撤销资格、撤销指定客户端连接。安装或启动成功不代表课程、Agent 或教学效果验收通过。

这是产品运行底座的候选交付。完整工程门禁、Mac/Windows 实际包安装、启停、隔离与故障恢复、Linux 独立包运行及 Mac→学校 Linux 的真实公网 HTTPS 认证、断连重连和撤销已经验证。Windows Chrome/Edge 基础页面由负责人实机确认；各平台证据、限制和可重复入口见[运行交接](../../docs/student-agent-implementation/runtime-acceptance.md)。签名、公证按负责人要求移出本轮；不宣称完整课程产品或自动更新已交付。

## 入口与环境目录

候选应用包使用自带 Node 24.21.0 运行 `app/cli.js`（以下简称 `xunjie`），同目录提供 `app/daemon.js`。源码构建入口为 `apps/local-runtime/dist/cli.js`。不依赖开发工具 `xj-dev`，不通过 SSH 启动或维护产品服务。源码维护者从仓库根、依赖及公共库构建就绪后执行：

```sh
npm run typecheck -w @xunjie/local-runtime
npm run build -w @xunjie/local-runtime
node apps/local-runtime/dist/cli.js --help
```

所有结果为 JSON；状态与成功结果写 stdout，状态为 `failed` 时退出码为 1 并保留状态 JSON。操作错误将 `{ "message": "…" }` 写 stderr，退出码为 1，不打印配置、stack 或凭据。`--json` 可接受且不改变格式。每次只执行一个命令；`--help` 返回 JSON 用法。

`--root <directory>` 可选，默认当前用户的私有应用数据目录下 `XunJie/environments/default`：

| 平台 | 默认基目录 |
| --- | --- |
| macOS | `~/Library/Application Support` |
| Windows | `%LOCALAPPDATA%`，缺失时为用户目录下 `AppData/Local` |
| Linux | `$XDG_DATA_HOME`，缺失时为 `~/.local/share` |

不同环境使用不同 root。私有目录、资源与数据生命周期由运行库维护；服务进程启动由库负责，CLI 仅为 `launch` 通过 `shell: false` 调用系统浏览器入口。

Mac ZIP 解包后的双击入口为 `循阶.command`，Windows 为 `xunjie.cmd`；无参数时均使用 `xunjie launch`，默认 local profile。首次缺少安装时先 install，再 start；已卸载环境重新安装时复用保存的资源，正常已安装环境直接 start。可传 `--config`、`--profile`、`--resources`，配置仅在需要安装时应用，不能据此更改已有环境的部署。CLI 保留 start 返回的完整 JSON status，仅当状态为 ready/degraded 且存在 endpoint 时，用 macOS `open`、Windows `explorer.exe` 或 Linux `xdg-open` 打开该实际地址。启动或打开浏览器出错均失败退出；浏览器打开失败时 stdout 仍保留已取得的 status，stderr 返回 message。关闭网页不会停止服务，停止需显式执行 `stop`。三平台双击与系统浏览器拉起矩阵仍待实际操作；手动打开 Chrome 的结果见运行交接。

## 安装与资源

```sh
xunjie install --profile local
xunjie install --root /private/environment --config /private/install.json --resources /application/resources.json
xunjie start
xunjie status
xunjie database
xunjie stop
```

`install` 默认 `profile=local`；`--profile local|school|remote` 覆盖配置中的 profile。`--config` 读取维护者提供的 JSON `InstallOptions` 对象，支持 `database`、`host`、`port`、`publicEndpoint`、`tls: {certificateFile,keyFile}`、`requiredServiceIds`。它不是 shell 脚本，不接收密码参数。TLS 文件路径建议使用绝对路径。

安装默认读取入口相对路径 `../resources.json`：候选包为 `app/cli.js` 上一级的 `resources.json`，源码编译入口则为 `apps/local-runtime/resources.json`。也可显式指定 `--resources`。文件缺失或不可读时明确失败，不回退开发机 Node 或猜测系统 PostgreSQL。示例清单：

```json
{
  "nodePath": "resources/node/bin/node",
  "nodeVersion": "24.21.0",
  "postgresBin": "resources/postgres/bin",
  "postgresVersion": "18.6",
  "webRoot": "web"
}
```

版本值必须反映候选包实际资源，示例不代表包已具备对应版本。`nodePath`、`postgresBin`、`webRoot` 的相对路径均以 resources.json 所在目录解析；绝对路径保留。`postgresBin`、`postgresVersion` 可省略，是否需要 PostgreSQL 由安装配置和库判断。已有环境的生命周期命令使用安装时保存的资源；`--resources` 不直接替换已有安装配置。`restore` / `upgrade` 使用目标资源，未指定时读取入口相对的 `../resources.json`；独立目标升级见下文[维护、备份与恢复](#维护备份与恢复145)。

## Windows 运行库准备

managed PostgreSQL 在 Windows 上需要 Microsoft VC++ v14 x64。产品准备策略采用已核实的 14.51.36247.0 或更新版本；前述 14.50 宿主通过属于实际运行证据，不代表已确定上游完整支持下限。

```sh
xunjie prepare --profile local
```

依赖已就绪则返回 `ready`；缺失或旧版时，从微软固定内容地址下载到本人私有缓存，验证摘要、版本及微软签名后返回 `installation-required`（退出码 3），给出已验证安装器路径和重试说明。本人在微软窗口完成许可和系统权限操作后重试。准备完成不等于安装已完成，产品不自动接受条款或提权。`install / launch / start` 复用同一准备能力；remote、外部 PG、只读状态和停止流程不下载该依赖。

直接调用共享 `openProductRuntime().install/start` 时，待安装结果由 `ProductInstallationRequiredError.result` 提供，环境身份和凭据尚未创建。缓存校验失败抛出 `ProductPrerequisitePreparationError`，含具体 `cachePath` 和 `recovery`；按指引移出原文件后重试即可重新下载。

## 已有 PostgreSQL

维护者通过安装 JSON 明确选择已有数据库，不自动探测、接管或初始化既有 PostgreSQL：

```json
{
  "profile": "school",
  "database": {
    "mode": "external",
    "host": "db.school.example",
    "port": 5432,
    "database": "xunjie",
    "user": "xunjie",
    "credentialRef": "school-postgres",
    "ssl": { "ca": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----" }
  }
}
```

`ssl.ca` 为 CA 内容，按运行库的 TLS 契约使用；不用自签名示例代替现场信任配置。数据库密码先以私密文件导入，同一 root 安装时只引用 `credentialRef`：

```sh
xunjie set-credential --root /private/environment --ref school-postgres --file /private/database-password.txt
xunjie install --root /private/environment --config /private/install.json --resources /application/resources.json
xunjie database --root /private/environment
```

凭据文件为单行文本，可带一个末尾换行，空格原样保留；命令不回显内容。不要将密码写入命令参数或安装 JSON。已有实例须符合固定 PG **17.10、17.11 或 18.6**、UTF8、UTC、C collation，连接角色须有执行 `pg_control_system()` 的只读权限；安装绑定 cluster identity 与 database OID，之后地址指向其他数据库时明确拒绝，不自动重新绑定。数据库配置还可选择 `{ "mode": "managed" }` 或 `{ "mode": "none" }`，具体资源需求与服务可用性由库报告。`database` 返回绑定或 `null`，不表示课程库已交付。学校 external 的服务启停、空的独立目标 cluster、权限及升级工具由管理员负责；产品完整备份/恢复按 [#145 owner 契约](../../docs/student-agent-implementation/maintenance-acceptance.md)装配，产品不接管 external 服务生命周期。

## 保留数据与显式删除

```sh
xunjie uninstall --root /private/environment
xunjie delete --root /private/environment --environment-id <environmentId>
```

`stop` 和 `uninstall` 默认保留环境数据。删除是独立动作，必须同时选对 root 和明确提供 `--environment-id`；先通过 `status` 核对身份，库负责校验并删除对应环境。卸载不是删除，环境删除也不表示删除外部 PostgreSQL 服务或其他环境的数据。

## 连接授权

目标环境通过文件读取授权对象：

```json
{
  "sourceEnvironmentId": "来源环境 UUID",
  "sourceServiceId": "来源服务 UUID",
  "capabilities": ["目标实际支持的能力"]
}
```

```sh
xunjie authorize --root /private/target --file /private/authorization.json --out /private/grant.json
xunjie revoke --root /private/target --grant-id <grantId>
```

`--out` 的父目录须已存在，文件须不存在。CLI 以私有 `0600` 模式新建并写入完整 grant（含 token），stdout 仅返回 `{ "path": "绝对路径", "grantId": "…" }`。POSIX 模式不等同于 Windows ACL，Windows 文件访问限制需在目标平台验收。写入失败会尝试撤销已产生的授权，撤销失败会明确报错。妥善保管及交接 grant 文件，不将它提交或贴进日志。

来源环境使用维护者准备的连接文件，形状为 `{ "connection": RuntimeConnection, "token": "从 grant 私下交接的值" }`；`RuntimeConnection` 采用公共契约中的 connectionId、sourceEnvironmentId、sourceServiceId、target 服务描述、requiredCapabilities、optionalCapabilities、credentialRef。target 包含 environmentId、serviceId、unit、endpoint、protocolVersion 和 capabilities，值来自真实目标服务，不猜测身份或能力。grant 文件本身不是完整连接文件。

```sh
xunjie connect --root /private/source --file /private/connection.json
```

token 只从文件读取，交给库持久化与连接，不在 stdout 回显。`connect` 成功仅返回 `{ "registered": true }`，表示连接配置已登记，不宣称远端握手或能力调用已通过。连接及授权不构成课程/Agent 功能交付；能力是否可用以目标实际公开的服务、授权与运行库检查为准。

## 维护、备份与恢复（#145）

操作 JSON 的完整示例、独立目标约束、失败重建与实际验收矩阵见 [#145 维护验收](../../docs/student-agent-implementation/maintenance-acceptance.md)。父票的组合验收与证据适用范围见 [WP01 父票验收](../../docs/student-agent-implementation/wp01-acceptance.md)。

```sh
xunjie recovery-key --out /secure/xunjie/recovery.key
xunjie backup-policy --root /srv/xunjie/source --file /secure/xunjie/backup-policy.json
xunjie backup-list --root /srv/xunjie/source
xunjie backup --root /srv/xunjie/source --file /secure/xunjie/held-backup.json
xunjie restore --root /srv/xunjie/restored-new --resources /opt/xunjie/resources.json --file /secure/xunjie/restore.json
xunjie start --root /srv/xunjie/restored-new
xunjie takeover --root /srv/xunjie/restored-new --file /secure/xunjie/takeover.json
```

| 命令 | 输入与行为 |
| --- | --- |
| `recovery-key --out` | 创建新私密文件，写入 32 字节随机二进制 key，只返回路径；输出父目录需存在 |
| `backup-policy --file` | JSON 含 directory、intervalMs、keep、minimumFreeBytes、keyFile；导入独立 key 并持久配置策略，宿主在线时调度 |
| `backup-list [--file]` | 可选 `{ directory }`；使用策略或最近备份保存的 key 验证目录，返回 backups、unavailable 和操作记录 |
| `backup [--file]` | 使用策略或本次 directory/keyFile 等输入；默认成功后 resume，`leaveClosed: true` 保持最后接管边界 |
| `restore --file --resources` | `--root` 是新的空目标；JSON 含单个备份路径 backupDirectory、keyFile、可选 minimumFreeBytes、database、databaseCredentialFile、installation；成功 isolated 并停止目标 runtime |
| `upgrade --file --resources` | `--root` 是源，JSON 含 kind、targetRoot、备份集合 backupDirectory、keyFile，以及可选目标 database、databaseCredentialFile、installation；生成 held 备份并用目标资源恢复，结果仍 isolated |
| `takeover --file` | `--root` 是恢复目标，JSON 含 sourceRoot、完整 receivers（id、root）；确认源退休及接收方代际 fencing 后才开闸 |
| `maintenance-resume` | 验证后恢复普通维护关闭的源；拒绝 isolated 目标或 retired 源，恢复源会取消 held 备份接管资格 |

除生成 key、离线恢复外，策略、目录、备份、接管和 resume 均调用在线宿主的私有控制接口。接管的 source/receivers 也须在线且本机 root 可访问；每个 receiver id 为实际 `environmentId/serviceId`，适配器核对运行身份，不能填任意 root 来替代所需接收方。无 receivers 的备份传空数组，不能漏掉 manifest 要求的接收方。

备份目录独立于环境及文件资源根，key 外置保管。所有参与者同一关闭边界 freeze、排空及验证后才导出。恢复保留业务身份，但生成新 installation、client namespace、本地凭据和存储代际；连接描述保留，旧秘密不直接恢复成有效授权。只有最新仍 held 的备份可退休源；源不可达或 receiver 失败时目标保持隔离。接管后接收方重新 `authorize`，目标通过 `set-credential --ref <原连接的credentialRef> --file <仅含新token的私密文件>` 补齐已保留连接的凭据；`connect` 只登记新连接，不接受重复 connectionId。旧 token 在 receiver 重启或旧 grant 文件复活后仍拒绝。

升级 kind 为 `schema|pg-minor|pg-major`；固定引擎 17.10/17.11/18.6，版本前进通过逻辑备份与新目标恢复完成。当前默认 daemon 只有 runtime owner；业务 owner 随 WP 装配，`schema` 没有实际注册迁移时报 `no-schema-upgrade-registered`。其他业务 targets 仍由[可信宿主公开 API](../../packages/product-runtime/README.md)提供。

restore/upgrade JSON 支持目标 `database`、`databaseCredentialFile` 与 `installation`。external 密码由单行非空私密文件读取，可带一个末尾换行，空格原样保留；读后加入错误输出 redaction，JSON/argv 不放明文密码。`installation` 支持 profile、host、port、publicEndpoint、tls（certificateFile、keyFile），用于目标学校 HTTPS 入口，不含 database/requiredServiceIds；数据库单独配置，必需参与者从备份恢复。完整 external/TLS JSON 示例见 [维护说明](../../docs/student-agent-implementation/maintenance-acceptance.md#最终-held-备份与恢复)。

外部数据库的源备份、目标恢复及升级必须使用带匹配 PG 备份/还原工具的**完整管理分发包**；无 PG 工具的 remote-client 包不能作为维护入口。external cluster/database、权限、工具与服务启停仍由学校管理员准备及管理；恢复默认隔离，实际学校 external 验收范围见维护验收的证据矩阵。

```sh
xunjie upgrade --root /srv/xunjie/source --resources /opt/xunjie-pg18/resources.json --file /secure/xunjie/upgrade.json
```

升级后继续对隔离目标接管。若放弃本轮接管、决定继续使用尚未退休的源，才恢复源维护：

```sh
xunjie maintenance-resume --root /srv/xunjie/source
```

独立验收入口：

```sh
node scripts/probe-recovery.mjs --help
```

升级失败保留原备份与失败现场，使用兼容资源从原 backupId 重新还原到另一个独立空目标，再验证和接管；只切回旧 binary 不构成数据库回滚。独立验收宿主消费候选包 `app/product-runtime.js` 及其 `storage` namespace；产品依赖不反向导入验收脚本，storage 样例恢复不等于生产业务迁移完成。
