# I0-UI55 本机 HTTPS 与维护工具

`local-ui-gateway.mjs` 在本机 `127.0.0.1:3443` 提供正常学生 dist，将 `/api` 和
`/health/live|ready` 通过本机 SSH 转发端口 `14443` 接 PAHER 的原 HTTPS 服务。
上游严格验证证书链、主机名和确切公开叶子指纹；认证、Origin、CSRF、正文与状态原样转发。

Node 24，无新增依赖。配置保存在仓库外，只允许四个绝对路径字段：

```json
{
  "staticDirectory": "/absolute/path/to/validated/student/dist",
  "keyFile": "/absolute/path/to/approved/local-private-key.pem",
  "certFile": "/absolute/path/to/approved/local-public-certificate.pem",
  "upstreamCAFile": "/absolute/path/to/verified/paher-public-certificate.pem"
}
```

先通过获准的 SSH 身份固定主机公钥，建立只监听本机的
`127.0.0.1:14443` → PAHER `127.0.0.1:3443` 转发，再运行：

```sh
node tools/i0-ui55/local-ui-gateway.mjs /absolute/path/to/local-config.json
node --test tools/i0-ui55/local-ui-gateway.test.mjs
```

Windows 持久入口的必要负例验证保存在 `local-entry.test.ps1`，不执行入口的 setup/dispatcher：

```powershell
pwsh -NoProfile -File tools/i0-ui55/local-entry.test.ps1 -EntryPath <retained-local-entry.ps1> -NodePath <existing-node.exe>
```

它使用隔离合成产物及本机 HTTP 替身验证未知进程归属、ACL 越界、静态字节不一致和
响应正文悬挂；这些负例不构成 PAHER 端到端验收。

浏览器 origin 固定为 `https://127.0.0.1:3443`。本机 TLS 私钥、证书信任、机器配置均按
实际对象授权；不放宽 TLS，不自动更新上游指纹，不回落准备 fixture。上游不可用返回 502，
不能当作正常健康或登录通过。

Windows 持久工具包的路径、启动/状态/检查/停止命令及证据记在
[I0-UI55 任务](../../docs/tasks/I0-UI55_BROWSER_ENTRY.md)。HTTPS 网关只转发已有业务接口；
维护命令使用下面独立的已授权 SSH 身份，不改变网关或服务的认证规则。

## 独立 SSH 维护入口

`maintenance.ps1` 是 PowerShell 7 客户端源码；本机 `xunjie-paher.ps1` 保留相同内容的独立快照。
固定既有 OpenSSH、identity 文件引用、单一来源和主机 Ed25519 公钥；只提供显式
`probe`、`exec` 和 `sftp-get`，无自动重试、TTY、密码重置、自动登录或全局 SSH 配置改动。

```powershell
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 help
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 probe
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 exec -RemoteCommand 'whoami'
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 exec -PowerShellScript 'Get-Date -Format o'
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 sftp-get -RemotePath '/C:/Users/p3148/XunJie_SSH_handoff_20261014.json' -LocalPath 'handoff-new.json'
```

`exec -PowerShellScript <text>` / `exec -ScriptFile <approved-local-script.ps1>` 使用固定的短
EncodedCommand receiver，实际脚本以 UTF-8/Base64 经 SSH 标准输入传输；长脚本不进入 Windows
cmd 的命令行，不自动落盘远端临时文件，不调整 DefaultShell，也不打印脚本。Base64 是传输编码。
显式脚本仍在维护账号权限内执行；receiver 捕获脚本异常时返回失败并隐藏源码。SFTP 只下载
指定 Windows 路径到本机工具根内的新普通文件，拒绝覆盖、路径越界、
重解析点、ADS、设备名及批次注入。命令 stdout/stderr 只有调用方主动执行后才显示，没有内建日志。
`probe` 的服务 active 只表示现有单位活动，不表示 runner ready、浏览器全验收或教学效果。

dot-source 后可在内存捕获 `Invoke-XjMaintenancePowerShellScript -PowerShellScript $text`
返回的 `ExitCode/StdOut/StdErr`。原 `Invoke-XjMaintenanceCommand`、`ConvertTo-XjEncodedCommand`
导出继续保留；长脚本使用新 helper，不能把整段巨大 EncodedCommand 送回 `RemoteCommand`。
专项验证 `maintenance.test.ps1 -LongScriptOnly` 检查短 argv、完整 Unicode stdin 和输入拒绝，
不执行网络或旧维护全量；2026-10-14 实际 28736 字符的只读注释/Get-Date/Unicode marker
脚本退出 0、marker 原样回传、stderr 为空，不涉及服务操作。

## 加密交接指定合成学生凭据

`seal-student-credential.ps1` 调用维护入口已有的 `Get-XunJieStudentCredential`，只从
PAHER 的批准 reader 获取 `synthetic-i0-student-a`，在内存转换成 RSA-OAEP-SHA256 密文。
只输出 `loginName/sealedPassword/algorithm`；不打印/落盘明文、不重置密码、不自动登录。
接收者公钥必须是单份 RSA 公共 PEM 且至少 2048 bits；拒绝 private/mixed/weak PEM。
接收者私钥仅留在接收进程内存，不传给脚本，不写日志。

```powershell
pwsh -NoProfile -File tools/i0-ui55/seal-student-credential.ps1 -Help
$sealedJson = & tools/i0-ui55/seal-student-credential.ps1 -MaintenanceEntry <approved-retained-maintenance.ps1> -RecipientPublicKeyPem $recipientPublicPem
pwsh -NoProfile -File tools/i0-ui55/maintenance.test.ps1 -SealOnly
```

`-SealOnly` 的新增边界验证不联网、不读真实凭据、不重跑已通过的维护检查。其它维护边界可由
`maintenance.test.ps1` 单独执行。本机 source-manifest 将这些源码、两类持久入口及使用说明纳入
SHA256 校验；本机证书、私钥、机器配置和真实秘密不纳入共享源码。

本机另有固定的 C1 只读入口 `scratch-c1-readiness/Read-C1Readiness.ps1`，实际路径与调用写在
持久工具使用说明。它沿原归档源/宿主配置调用真实 RunnerTransport 的 `readiness`，只报告
当前指纹、既有验证、代际和差异；不重新验证、升级代际、启动任务或重启服务。not-ready 返回
非零，不将失败改贴通过；已有身份/签名材料只在原环境引用，不复制密钥。
