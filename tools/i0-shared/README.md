# PAHER 共用应用入口

成员通过 SSH 访问 PAHER 上同一套 API、正常学生页面和35表数据库。同一学生演示账号 B 读到同一份课程、分配与已保存作品；未确认的浏览器草稿仍在各自设备上。这里不运行 `dev:prep`，不初始化或复制数据库。

## 使用

准备 PowerShell 7、系统 OpenSSH 和**成员自己的**私钥；对应公钥须已获 `xunjie-tunnel` 授权。本入口不替其他成员登记公钥，也不分发私钥或密码。

目前实测获准来源是 Robert 的 `192.168.3.8`。其他成员首次连接前，将自己的 **SSH 公钥和本机局域网 IP** 给 PAHER 维护者登记；无需创建新的应用账号、课程或数据库。PAHER 必须在线，维护用户的共享启动任务需保持运行。

在仓库根打开 PowerShell 7：

```powershell
.\tools\i0-shared\start.ps1 -IdentityFile 'D:\your-ssh-key\id_ed25519'
```

需要选择出站源地址时追加 `-BindAddress <本机IP>`；它是 SSH 的源IP，本地网页入口始终绑定 `127.0.0.1:3444`。

SSH 接通后打开 <https://127.0.0.1:3444>，用**统一学生演示账号 `synthetic-i0-student-b`**及私下领取的现有密码登录，显示姓名为 Robert。保持终端开启，按 Ctrl+C 退出隧道。密码和私钥不放进 Git。

本机3444已占用时直接失败，不复用或关闭现有服务。先由使用者正常结束自己的占用，再运行入口。

浏览器须信任随入口提供的 [PAHER 公共证书](paher-server.cert.pem)，其 SHA-256 指纹为 `c3f8ed37e07c341b0fcc5558d0fc12fab47913ef71d1ec8077a0e08444475173`。Windows 成员可在自己的账号下导入（首次一次）：

```powershell
Import-Certificate -FilePath .\tools\i0-shared\paher-server.cert.pem -CertStoreLocation Cert:\CurrentUser\Root
```

证书仅含公钥，不含服务 TLS 私钥；不跳过证书验证。SSH 的公共 Ed25519 主机密钥已随 `known_hosts` 固定，与既有维护入口相同。

## 本地查看参数

```powershell
.\tools\i0-shared\start.ps1 -Help
```

此命令不联网、不读取私钥、不启动隧道。实际连接沿固定22端口，使用公钥认证、严格主机校验及仅本机的3444本地转发；不运行远端命令，不转发 SSH agent、X11 或远端端口。
