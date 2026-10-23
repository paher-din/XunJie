# 共享云基础设施模板

本目录保存共享应用部署与成员本机执行的通用基础设施。共享页面、API 和课程数据库运行在同一业务宿主；C/HDL 在成员各自已准备的独立执行节点运行。连接工具不初始化账号、课程、数据库、VM 或节点 ledger。

实际服务地址、SSH 身份、成员节点、端口、主机公钥 pin 与 HTTPS 证书只保存在仓库外的私下交接材料中，由负责人单独发送给获准成员。下文说明公开接口，不包含可直接连接的配置。新的统一工具状态与替换计划见[开发工具说明](../../docs/development-tooling.md)，不要把设计中的 `xj-dev` 当作当前已有命令。

| 文件 | 用途 |
| --- | --- |
| `cloud-host.mjs` | 组合既有业务应用、消费者及正常关停，HTTPS 仅监听回环；不迁移课程库 |
| `xunjie-shared.service` | 单进程业务服务的部署约定、持久目录及文件权限模板 |
| `application-config.example.json` | 部署配置字段示例；占位内容不可运行 |
| `connect.ps1` | 依赖私下 `ConnectionFile` 的受限页面转发工具 |
| `connect-node.ps1` | 依赖私下 `ConnectionFile` 的登记执行节点回连工具 |
| `ssh-common.ps1` | 私有配置校验、公钥认证及严格主机校验 |
| `prepare-demo-data.mjs` | 对已备份共享合成库追加教学班、成员和发布前置；不新建表、不造学习记录 |
| `publish-demo-projects.mjs` | 按私有计划通过原教师 API 固定版本并分配，保留幂等回执 |
| `connection.example.json` | 连接字段示例；`registered=false` 与占位端口会被拒绝 |
| `sshd-members.example.conf` | 页面与执行身份分离的 Match 结构示例，含不可直接安装的占位项 |
| `sync-main.py` | 固定远程 main，构建精简生产运行包、备份、版本核对、切换与失败回退；`--status` 只读 |
| `xunjie-main-sync.service` / `xunjie-main-sync.timer` | 低权限构建与服务器每 5 分钟自动同步的服务模板 |

## 当前连接工具怎么调用

脚本要求 PowerShell 7、OpenSSH 和预登记的身份。页面脚本还使用 Windows 的 `Get-NetTCPConnection`；macOS 上不能仅安装 PowerShell 后照搬，应按该设备已有的获准私有接入说明连接。未来统一工具的 Windows/macOS 支持需要分别验收。

从仓库根查看帮助，再使用维护者已交接的实际文件路径：

```powershell
pwsh -NoProfile -File tools/i0-cloud/connect.ps1 -Help
pwsh -NoProfile -File tools/i0-cloud/connect.ps1 -IdentityFile '<本人私钥文件路径>' -ConnectionFile '<获准连接配置路径>'
pwsh -NoProfile -File tools/i0-cloud/connect-node.ps1 -Help
```

节点回连使用相同的 `IdentityFile`、`ConnectionFile` 参数形式，但身份、端口和节点必须是该成员已登记的配置。示例 JSON 的占位值不能用于连接；可选 `BindAddress` 仅按私有接入说明使用。工具使用私钥文件，不应打印其内容。

连接保持在前台，`Ctrl+C` 结束该连接；当前脚本没有断开后的自动监督重启。端口占用时报告失败，不接管现有进程；SSH 退出失败时抛出错误。SSH 连通后还要检查对应 HTTPS 页面、登录和所需能力；页面可用不等于执行节点就绪。连接不会上传本地代码、建立本地前后端开发环境或创建测试账号。

维护者按私下部署记录核定实际路径、服务用户、节点绑定和访问权限。应用沿现有35表或显式启用的41表课程库及登记节点启动；两种模式均复用原组合并核对精确表结构；个人模型存储按获准配置启用，不复制旧个人模型库或 Key。运行时配置、机密、数据库、真实公钥 pin 和证书均不随源码分发。

远程 main 的自动部署由 [sync-main.py](sync-main.py) 实现：服务器临时构建前端，发布页面产物、后端运行源码和生产依赖，核对精确提交后切换原应用。测试、证据、前端源码与开发依赖不进入运行包，构建目录结束后清理；后端沿 Node 24 原入口运行，无额外编译产物。部署配置与状态回执保存在仓库外；发布不会初始化业务数据。当前运行快照及将构建移到 CI 的建议见[服务器核查](../../docs/references/2026-10-23-development-server-assessment.md)。

迁移使用 SQLite 一致备份，保留原 ID、账号资料和旧作品；不直接复制活跃主库而遗漏 WAL。最终切换保持唯一业务写库，前后核对完整性、外键及原记录。数据库继续遵守原普通文件与 `TMPDIR` 路径门禁，不在启动时自动迁移。开发环境可通过私有 `allowedLoginUserIds` 将登录限制在获准的教师与学生；虚拟成员仍使用真实课程关系，但不获得登录资格。

成员连接只允许预登记的回环转发；页面身份与执行回连身份分开，禁密码、PTY、agent/X11 和普通远端命令。所有目的地、身份与端口取自获准私有配置，严格验证预先核定的 SSH 主机 pin；不首次自动接受主机，不读取私钥正文，不改全局 SSH。页面本机端口已占用时立即拒绝，不停止或接管已有服务。

业务宿主与执行器可用性分别报告。执行器离线时仍可登录、查看和保存；新运行需当前节点就绪，旧结果、取消及 HDL 后续操作沿原节点绑定核对，不静默改派。当前连接工具与配置模板的删除条件见[替换清理设计](../../docs/development-tooling.md#旧连接实现配置与说明的替换清理)。
