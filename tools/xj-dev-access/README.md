# 开发成员接入服务

`server.mjs` 是独立 HTTPS 进程，使用自己的 SQLite、设备状态和凭据加密 key。产品标准 runtime 只包含默认关闭的通用本机账号控制模块；它不导入此目录或开发协议，移除整个开发服务后仍能正常启动。设备客户端及 proof 协议位于 `tools/xj-dev/src/`，源码复现包不需要携带服务端。

## 成员与维护入口

维护者用现有 owner SSH profile 调用 `xj-dev access`，通过本机管理 socket 生成或撤销邀请。`invite` 必须指定 `--out-file`，其 JSON 包含秘密，由维护者选择交接渠道。邀请与管理配置均经共享私有文件 API 检查：Unix owner/0600，Windows 当前用户 NTFS DACL；内容不进 argv 或普通 CLI 输出。

成员执行 `xj-dev join --invitation-file FILE`。默认启动独立 local；用 `--mode cloud-api|cloud` 连接获准候选。`--no-start` 只登记，不代表开发环境已验收。`refresh` 用现有设备 proof 更新私有配置。CLI 返回安全身份和 `deviceFile`、`connectionFile`、`accountFile` 路径；登录凭据只在 `accountFile`。不同邀请各用独立 key，同一邀请中断保留原 key 继续。

网络身份与应用 `teacher|student` 角色分别授予；`teamRole` 不授予 owner shell。普通设备只可转发批准的业务端口，执行节点须另获 `node:<id>` 能力。维护入口只通过既有 owner SSH 开放，公网不存在成员管理路由。

## 固定协议与 #131 接缝

公共接口为 `GET /health/live`，以及 `POST /v1/challenges|enroll|config|identity`。响应为 `{ok:true,data}` 或 `{ok:false,code}`。challenge 输入：`{publicKey,method:'POST',path,bodyHash,invitationSecret?或deviceId?}`；后续请求为 `{challengeId,signature,body}`，其中 enroll body 是 `{invitationSecret}`，已登记 body 是 `{deviceId}`。

`bodyHash` 为 `SHA256(JSON.stringify(body))`。`enrollment-protocol.mjs` 的 `proofMessage` 固定序列化 protocol、serviceId、challengeId、nonce、expiresAt、method、path、bodyHash，使用 OpenSSH SSHSIG 的 `xunjie-dev-access-v1` namespace。服务端 challenge TTL 60 秒，一次消费；签名前客户端持久记录已用 challenge/nonce 摘要。私钥只由本机 OpenSSH 使用。

服务端 `identity.mjs` 导出 `authenticateDevice(store,envelope,path,capability?)`；store 导出设备、成员、challenge、事务和审计接口。#131 在同一个 service/store 扩展批准路由即可，需同步扩展 `issueChallenge` 的路径白名单。客户端导出 `loadDevice`、`authenticatedRequest(deviceFile,path,body)`；后者自动绑定 deviceId，返回内部私有响应，不能直接打印。这里没有 OSS SDK 或长期云凭据。

## 独立部署

普通产品产物继续由原 cloud-release CI 交付。产品侧仅显式配置 `cloud-host.mjs --account-control FILE` 时启用本机 adapter；配置包含绝对 `socketPath`、`stateFile`、`accountPrefix`、获准 `courseIds` 和可选 `socketGid`。应用配置必须给出原有 `allowedLoginUserIds`，与当前 active managed identities 合并；新的 login 和已有 session 都实时检查。禁用调用产品原账号事务，保留作品，不重启业务。

开发服务单独从已提交的 SHA 装配，无 npm 依赖，也不在 ECS 构建：

```sh
node tools/xj-dev-access/prepare-deployment.mjs --commit FULL_SHA --output NEW_DIRECTORY
```

输出 `deployment.json` 记录 sourceCommit 和白名单文件的 SHA256；只取 `git show FULL_SHA:path`，当前 dirty 内容不会混入。白名单包含服务、协议、root helper、systemd、installer，以及无外部依赖的产品通用 `local-socket.ts`。通过既有 owner SSH 传到独立目录后，以 root 执行该目录的 `tools/xj-dev-access/install.py SOURCE_DIRECTORY`。installer 核对全部摘要、固定路径和既有不可变 release；安装到 `/opt/xunjie-dev-access/releases/FULL_SHA`，root 控制 `current` 链接。它不修改产品 manifest、正式 current 或正式数据库。

首次由 owner 通过私有 stdin 准备 `/etc/xunjie-dev-access-candidate129/service.json`、`system.json`、HTTPS key/cert/CA 与批准的 SSH pin、业务 CA。`service.json` 指向下表固定路径，还需 `serviceId`、可信 `https://HOST:8443` endpoint、`listenHost`/`port`、`tls:{keyFile,certFile,caFile}`、`knownHostsFile`、`cloudCaFile`、`courseIds`、`target:{schema:'xj-dev/connection-v1',host,port,browserOrigin,applicationPort}`、`applicationSocket`；`systemCommand` 固定为 `['sudo','-n','/usr/bin/python3','/opt/xunjie-dev-access/current/tools/xj-dev-access/system-helper.py']`。`system.json` 由 root 独占，只有批准的 `applicationPorts` 和可选 `nodes`，服务请求不能选择路径或 shell。

| 归属 | 路径/入口 |
| --- | --- |
| 服务数据与加密 key | `/var/lib/xunjie-dev-access-candidate129/access.sqlite`、`credential.key`；服务用户 0600 |
| 配置与服务 CA | `/etc/xunjie-dev-access-candidate129/`；私有配置/私钥 0600 |
| owner 管理 socket | `/run/xunjie-dev-access-candidate129/admin.sock`，0600 |
| 应用账号控制 | 候选业务显式开启的独立 Unix socket；目录组可穿越、socket 0660，仅业务和接入账号共享组 |
| 固定系统执行器回执 | `/var/lib/xunjie-dev-access-candidate129-system/`，root 0700 |
| SSH 设备 key 与策略 | `/etc/ssh/xunjie-dev-access-candidate129/keys/`、`sshd_config.d/62-xunjie-dev-access-candidate129.conf` |
| 接入备份 | `/var/backups/xunjie/dev-access-candidate129/`，服务用户 0700 |

installer 只创建自己的 `xj-access-c129` 服务账号、`xjd_*` 设备账号组与 SSH snippet。固定 sudoers 只放行 root-owned Python helper 的固定路径和参数。helper 的输入在 stdin；只允许 install/ensure/revoke，按稳定 device UUID 生成账户、持久阶段回执，撤销先删该 key，再精确关闭该用户 SSH 进程。未知账户、端口或所有权冲突拒绝处理。

## 生命周期、恢复与清理

安装后由 owner `systemctl start xunjie-dev-access-candidate129.service`，确认 HTTPS CA/pin 和候选应用 socket 就绪后再 `enable`。模板依赖独立 `xunjie-candidate-128.service`，候选业务本身也需持久 unit 才能开机恢复。只更新候选，正式服务、发布 timer 和 owner SSH 保持原归属。

两处本机控制 socket 使用相同 OS 锁与 inode 回执：重复进程明确拒绝；无 listen 的 close 不清理路径；SIGKILL 后只恢复已记录且连接拒绝的自有 socket。libuv 绑定唯一私有名称，公共入口使用硬链接，close 按 inode 清理，外来替换保留。`.lease.sqlite` 是永久锁，不删除；未知 socket 不自动接管。

`access snapshot` 输入 `{destination:'/var/backups/xunjie/dev-access-candidate129/NAME.sqlite'}`，输出一致 SQLite Backup API 副本、配套 `.key`、无秘密 `.json` 回执。恢复时停止目标接入服务，将数据库与对应 key 安装到新隔离数据目录，恢复同一 serviceId，核对 integrity/外键后启动；原备份保留。业务库与账号控制 registry 由候选业务备份流程另存，两套存储的一致副本不等于跨进程原子快照。撤销回执、加密 key 和成员数据属于维护者备份，不进入 repro。

保留候选供 #131/#133 使用。消费者释放后，先停接入 unit，再撤销并核对本服务设备连接；只删除表中本服务的 unit/配置/release/数据/SSH snippet 和账户。备份按维护者保留策略处理。删除 snippet 后运行 `sshd -t` 再 reload；正式业务、原节点与 owner 身份不在清理范围。

## 验证边界

本地测试覆盖真实 HTTPS、OpenSSH proof、SQLite、CLI 路由、双进程 socket 生命周期、应用真实账号事务/旧 session 失效及标准 runtime 排除开发设施；系统账户/SSH 授权资源在 unit 测试中受控。真实 ECS 和 Windows/macOS 完整加入、业务登录、在用 SSH 连接撤销另记实机验收，不能由这些测试推定。
