# XunJie 产品 CLI（候选交付）

本目录提供 issue #143 的产品运行底座 CLI，薄装配 `@xunjie/product-runtime` 公共 API。项目入口见[根 README](../../README.md)，既有教学 Web 说明见[相邻 Web README](../web/README.md)。本票不交付课程业务、学生实验执行或 Agent 能力；安装或启动成功不代表课程、Agent 或教学效果验收通过。

这是产品运行底座的候选交付。完整工程门禁、Mac 实际包安装/启停/故障恢复、Linux 独立包运行及同机 HTTPS 连接已经验证，具体结果、限制和可重复入口见[运行交接](../../docs/student-agent-implementation/runtime-acceptance.md)。Windows 实机待负责人回家后继续，真实跨机公网连接仍受端口链路阻塞。签名、公证按负责人要求移出本轮；不宣称完整课程产品或自动更新已交付。

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

版本值必须反映候选包实际资源，示例不代表包已具备对应版本。`nodePath`、`postgresBin`、`webRoot` 的相对路径均以 resources.json 所在目录解析；绝对路径保留。`postgresBin`、`postgresVersion` 可省略，是否需要 PostgreSQL 由安装配置和库判断。后续命令使用安装时保存的资源；`--resources` 不替换已有安装配置，资源升级由后续恢复升级流程处理。

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

凭据文件为单行文本，可带一个末尾换行，空格原样保留；命令不回显内容。不要将密码写入命令参数或安装 JSON。已有实例须符合 PG 18、UTF8、UTC、C collation，连接角色须有执行 `pg_control_system()` 的只读权限；安装绑定 cluster identity 与 database OID，之后地址指向其他数据库时明确拒绝，不自动重新绑定。数据库配置还可选择 `{ "mode": "managed" }` 或 `{ "mode": "none" }`，具体资源需求与服务可用性由库报告。`database` 返回绑定或 `null`，不表示课程库已交付；已有 PostgreSQL 的备份、升级与服务维护仍由其维护者负责。

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
