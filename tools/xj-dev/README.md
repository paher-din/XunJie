# xj-dev — XunJie 本地全栈开发环境

一条命令在当前工作树启动本地全栈：Vite 热更新 + 真实业务后端 + 单一 HTTPS 入口，数据与浏览器身份按工作树（及实例）隔离。

## 用法

```sh
node tools/xj-dev/xj-dev.mjs doctor     # 检查运行时、依赖、证书与环境状态
node tools/xj-dev/xj-dev.mjs up         # 启动（或恢复）本工作树的环境
node tools/xj-dev/xj-dev.mjs status     # 查看进程、入口、数据归属与能力状态
node tools/xj-dev/xj-dev.mjs down       # 停止本工具管理的进程；不删除数据
```

- 所有命令把版本化 JSON（`xj-dev/result-v1`）写到 stdout，日志在 stderr；失败按 `stage`/`code` 诊断并给出恢复动作。`--json` 可省略。
- `--worktree <dir>` 显式指定工作树（默认从当前目录向上查找 `.git`）；`--instance <name>` 在同一工作树再起一套完全独立的环境（端口、数据、浏览器身份均隔离）。
- 运行时需要精确的 Node 24.21.0；CLI 会自动重定向到受管运行时（`~/.xunjie/xj-dev/runtime/`，缺失时按 doctor 的恢复提示安装）。
- `better-sqlite3@13.0.3` 按锁文件从源码构建。Windows 需 Python 3 与 Visual Studio 2022 Build Tools 的「使用 C++ 的桌面开发」工作负载（含 Windows SDK）。可用 `winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` 安装构建工具。
- 开发证书生成需要 OpenSSL 在 PATH 中可用；Windows 可使用 Git for Windows 或 MSYS2 提供的 OpenSSL。

一次完整会话（输出为要点节选，实际为单个 JSON）：

```console
$ node tools/xj-dev/xj-dev.mjs up --json
{
  "ok": true,
  "command": "up",
  "environment": { "id": "…", "worktree": "…", "root": "~/.xunjie/xj-dev/envs/…" },
  "page": { "url": "https://127.0.0.1:31746" },
  "accounts": {
    "list": [ { "loginName": "synthetic-teacher", "role": "teacher" }, … ],
    "credentials": { "file": "…/envs/…/secrets/baseline-accounts.json" }
  },
  "capabilities": { "frontend": { "available": true }, "execution": { "available": false }, … },
  "next": [ "浏览器打开 https://127.0.0.1:31746 …" ]
}
```

## 首次启动之后

`up` 输出的 `page.url` 是唯一的浏览器入口（`https://127.0.0.1:<端口>`）。首次需信任本地开发 CA（按 doctor/up 输出提示执行一次 `security add-trusted-cert`），或在浏览器临时继续。

撤销 CA 信任（不再需要本地环境时）：macOS 在「钥匙串访问」中删除 `XunJie Local Development CA` 证书，或执行
`security delete-certificate -c "XunJie Local Development CA"`；再删除 `~/.xunjie/xj-dev/ca/`。Windows 用 `certmgr.msc` 在「受信任的根证书颁发机构」中删除同名证书。

固定基线 `local-baseline-1` 提供账号 `synthetic-teacher`（教师）与 `synthetic-student`（学生，已分配 C 与数字逻辑任务）。
**密码不进入仓库与 CLI 输出**：首次构造基线时随机生成，只写在该环境的 `secrets/baseline-accounts.json`（0600，仓库外；`up`/`status` 输出的 `accounts.credentials.file` 给出路径）。

可完成：登录 → 课程查看 → 作品保存 → 冻结快照 → 提交 → 教师正式反馈 → 学生读取反馈。

## 修改代码后的验证回路

- **前端**（`apps/student/src/**`）：Vite 经同一 HTTPS 入口热更新，保存即生效，无需重启。
- **后端**（`apps/teaching/server/**`、`apps/teaching/contracts/**`）：重新执行 `xj-dev up`——检测到源码较新会只重启 backend，数据不动；随后重放 API 或页面操作验证。
- **不生效时的诊断**：`status --json` 的 `checks` 给出进程与网关/API 探活结论；组件日志在环境目录 `logs/`。

## 隔离模型

- 环境数据在仓库外：`~/.xunjie/xj-dev/envs/<环境ID>/`（`XJ_DEV_HOME` 可改根）。环境 ID 由工作树路径 + 实例名派生。
- 数据库、个人模型目录、浏览器配置目录、证书与日志全部在环境目录内；`status` 的 `browser.profile` 可传给浏览器 `--user-data-dir` 得到独立浏览器身份。
- 端口按环境身份确定性分配（24000 起三连段），冲突时报 `PORT_IN_USE` 并指出占用者，不动他人进程。
- `down` 只停止本环境登记的进程（按命令行归属核对），不删数据；重复 `up` 幂等，沿用原数据。
- 重置环境 = `down` 后删除对应环境目录再 `up`（重新播种基线）。

## 能力边界

| 能力 | 状态 |
| --- | --- |
| 前端（HMR 热更新） | 可用，经同一 HTTPS 入口 |
| 业务 API | 可用，真实 teaching 后端源码直接运行 |
| 运行/仿真执行节点 | 未接线：运行请求明确返回 `RUNTIME_NOT_READY` |
| 个人/教师模型调用 | 未配置凭据，调用停用 |

## 模式与受管连接

```sh
node tools/xj-dev/xj-dev.mjs use local
node tools/xj-dev/xj-dev.mjs use cloud-api --connection /path/to/approved-connection.json
node tools/xj-dev/xj-dev.mjs use cloud --connection /path/to/approved-connection.json
node tools/xj-dev/xj-dev.mjs node connect --connection /path/to/approved-node-connection.json
node tools/xj-dev/xj-dev.mjs node status
node tools/xj-dev/xj-dev.mjs node disconnect
```

| 模式 | 前端 | 后端与数据 |
| --- | --- | --- |
| `local`（默认） | 当前工作树 Vite/HMR | 当前工作树源码、独立 SQLite；返回时沿用原现场 |
| `cloud-api` | 当前工作树 Vite/HMR，模块保持本地 | 选定云端 HTTPS API 与健康接口，共享集成库 |
| `cloud` | 已部署页面与静态资源 | 选定云端后端，共享集成库 |

`up` 恢复上次模式，`status` 报告来源、版本、目标与能力。先检查目标连接和 session/health 契约，成功才原子更新当前入口；失败保留原入口。切换不复制数据库、升级基线、上传代码或部署。旧标签页始终使用原目标，未保存草稿不会因切换写到另一环境。`down` 停止本工作树登记的全部模式及节点连接，保留数据。

每个环境/模式/目标有固定 HTTPS 入口、专属 `__Host-` Cookie 名称与 `browser.profile`。即使在同一浏览器 context 打开多个入口，会话也分别转发。网关精确校验本地 Host/Origin 后，才映射到配置的云端 canonical Origin；云端原有 Origin、Cookie、CSRF 验证继续执行。SSH 使用公钥、预先核定的 ed25519 pin、禁密码/agent；HTTPS 使用获准 CA 校验证书和主机名，不关闭 TLS 验证。端口冲突报告真实占用者，不接管其他程序。

后台 supervisor 监督自己创建的 SSH：正常每 10 秒只读探活，网络或休眠故障最多六轮退避（1/2/4/8/16 秒），成功后重新检查业务；权限撤销、SSH/TLS 身份变化或接口不兼容停止重试，显式修复后 `up` 重试。恢复不重复业务写入。Windows 通过停止请求让 supervisor 先结束 SSH 子进程。

后端实际提交来自业务 host 的健康响应 `x-xunjie-version`，协议为 `x-xunjie-protocol: xunjie/session-v1`。host 启动时从已校验的 release `deployment.json` 固定该身份；普通成员无需管理员 shell。连接配置中的版本值不作事实；旧部署没有 metadata 时输出 `versionSource: not-exposed`，不能算版本验收通过。

### 配置与公开接缝

成员接入工具可写出 [connection.example.json](connection.example.json) 的 `xj-dev/connection-v1`。必填 `host`、`port`、`browserUser`、`applicationPort`、`browserOrigin`、`identityFile`、`knownHostsFile`、`caFile`；路径相对配置文件解析。可选 `expectedBackendVersion` 是显式兼容约束，不是观测版本。文件应放仓库外受限目录，私钥正文和账号密码不进入 CLI 输出。

节点可额外提供 `nodeId`、`nodeUser`、`localRunnerPort`、`remoteRunnerPort`，可选 `nodeIdentityFile`。工具只做原登记节点的反向转发；连接成功只证明传输，不证明 runner 授权、generation 或实际执行通过。没有节点时页面与普通业务仍可用。任务绑定和未知结果沿原业务契约保留，不静默重派。

未显式传 `--identity` 时，后续 `up` 重新读取配置中的身份路径；显式覆盖会随当前选择保留。再次传 `--connection` 会以该配置重新选择身份，避免沿用旧覆盖阻碍密钥轮换。

现有 `version: 1, registered: true` 配置由同一解析器只读适配，私钥可用 `--identity` 提供；CA 可复用旁边的 `cloud-server.cert.pem`。负责人旧配置使用旁边 `ssh.conf` 的已核定 browser 别名解析身份/pin 路径，无需新邀请，也不改全局 SSH。原 PowerShell 页面、节点脚本和重复解析器已删除。

供接入工具与复现工具复用：`src/connection.mjs` 导出 `CONNECTION_SCHEMA`、`loadConnection(file, { identity })`、`sshArguments(connection, kind, localPort)`、`checkBackend(connection, localPort)`；`commands.mjs` 保留模式感知 `up/status/down`，本地实现另导出 `upLocal/statusLocal/downLocal`。CLI 的简单 `commandRoutes` 可注册额外命令，子命令参数放 `options.extraArgs`。

### 模式验收

```sh
# 普通测试包含受控 HTTPS 边界；不能代替真实云端验收
node --test tools/xj-dev/tests/managed-modes.test.mjs
# 真实 SSH/云端/浏览器；账号文件只从私有路径读取，不开启 trace
cd apps/student
XUNJIE_XJ_DEV_URL=managed \
XUNJIE_CLOUD_CONNECTION=/path/to/approved-connection.json \
XUNJIE_CLOUD_ACCOUNT_FILE=/path/to/private-accounts.txt \
node node_modules/@playwright/test/cli.js test xjDevModes --workers=1
```

测试分别覆盖同 context 的两个本地环境及两种云模式、实际本地 HMR、登录与 CSRF、未保存现场、失败保留选择、真实 SSH 中断后的业务恢复及真实版本 header。可通过 `XUNJIE_LOCAL_SECOND_WORKTREE` 指定第二工作树；未指定时第二实例使用独立数据。缺少配置时跳过，跳过不算通过。平台、节点实际执行与教学效果需分别报告。

2026-10-23 模式验收：macOS arm64、Windows 11 x64 均使用 Node 24.21.0，xj-dev 26/26；两个平台均对独立 ECS 候选完成四项真实浏览器验收（未拦截 API、未替换业务响应）。候选运行 CI 提交 `22221889626d69f781b5e40a249ed1a8844519ca` 的 Linux 产物，普通受限 SSH 转发身份可从健康响应读取实际版本；候选使用独立合成基线及无节点配置，未修改正式演示库。macOS 另以两个真实工作树核对同 context 会话隔离。真实连接恢复使用 macOS 暂停 SSH 流和 Windows 终止 SSH 进程注入中断，恢复原会话并确认没有重复隧道。

权限、错误 host pin、错误 TLS CA、版本不符与 SSH 转发策略拒绝均通过真实连接失败验收；Windows 还核对原登记节点离线时 `NODE_OFFLINE`、状态与断开。在线执行节点、C/HDL 实验、物理系统休眠、模型调用及教学效果未在本票验收。受控 HTTPS 单元测试与这些实机证据分别记录。

两平台重复登录验收需协调目标账号的登录窗口；本次并行复验触发过正常的账号限流，受影响用例随后顺序补跑通过，未修改限流策略或清理计数。

## 测试

```sh
# 需要受管 Node 24.21.0（doctor 会报告定位结果）
cd tools/xj-dev && npm test
```

单元测试覆盖路径/端口/锁/进程归属/envelope；集成测试用临时 `XJ_DEV_HOME` 起真实双环境，覆盖全教学闭环、安全断言（CSRF/Origin/匿名）、隔离、幂等、端口冲突与重启保数据。

浏览器验收（真实 UI 闭环，需干净基线）：

```sh
node tools/xj-dev/xj-dev.mjs up
cd apps/student
XUNJIE_XJ_DEV_URL=https://127.0.0.1:<网关端口> npx playwright test xjDevBaseline
```

## 常见失败与恢复

| 失败 | 处理 |
| --- | --- |
| `NODE_VERSION_MISMATCH` | 按输出安装精确 Node 24.21.0 到受管目录，或设 `XJ_DEV_NODE_24` 指向它 |
| `PORT_IN_USE` | 停止占用进程后重试；若占用者是本环境残留进程，先 `down` |
| `HEALTH_TIMEOUT` | 看环境目录 `logs/` 下对应组件日志 |
| `BASELINE_FAILED` | 重试 `up`；持续失败时 `down` 后删除环境数据目录重新播种 |
| `BASELINE_MARKER_MISSING` | 数据库在但基线标记缺失（曾手工删改）；`down` 后删除环境目录重建 |
| `LOCK_HELD` | 另一进程正在操作该环境；确认其退出后可删环境目录中的 `lock` |

平台状态：macOS 与 Windows 11 x64（10.0.26200.9711）已实机验收，均使用 Node 24.21.0。

Windows 实测结果（2026-10-23）：xj-dev 23/23；student 类型检查、构建及 684 项测试通过；teaching 类型检查、构建及 525 项测试通过（另有 24 项依赖外部执行环境的测试跳过）。Chromium 完成登录、课程、保存、冻结、提交、教师反馈和学生读取，并实际修改组件源码验证 HMR。另验证后端源码修改后仅 backend 重启、API 响应更新，以及 down 后自有 PID 全部退出、重启保留原反馈。验收结束已停止该环境，保留独立开发数据。执行节点、模型与教学效果不在本次验证范围内。
