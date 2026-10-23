# xj-dev — XunJie 本地全栈开发环境

一条命令在当前工作树启动本地全栈：Vite 热更新 + 真实业务后端 + 单一 HTTPS 入口，数据与浏览器身份按工作树（及实例）隔离。

## 用法

```sh
node tools/xj-dev/xj-dev.mjs doctor     # 检查运行时、依赖、证书与环境状态
node tools/xj-dev/xj-dev.mjs up         # 启动（或恢复）本工作树的环境
node tools/xj-dev/xj-dev.mjs status     # 查看进程、入口、数据归属与能力状态
node tools/xj-dev/xj-dev.mjs down       # 停止本工具管理的进程；不删除数据
node tools/xj-dev/xj-dev.mjs delete     # 显式删除所选模式的已登记环境数据；保留永久锁守卫
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

`up` 输出的 `page.url` 是唯一的浏览器入口（`https://127.0.0.1:<端口>`）。首次按下节信任本次本地开发 CA，再使用正常证书校验打开页面。浏览器证书告警、临时继续、`ignoreHTTPSErrors` 或关闭 TLS 校验都不能作为 HTTPS/浏览器验收通过。

本地 `status` 的 frontend/API 可用性取决于本环境归属进程及经本 home CA 严格校验的网关探测；未启动、`down` 后或组件故障时不报告可用。`status.ok` 表示完整入口就绪；`doctor.ok` 仍表示前置检查通过，停止状态不影响该前置结论。

### 开发 CA 的系统信任与精确撤销

CA 路径以 `doctor`/`up` 的提示为准，默认是 `~/.xunjie/xj-dev/ca/ca-cert.pem`；`XJ_DEV_HOME` 改根时须使用对应文件。先核对这是自己本次环境的 CA，记录指纹与导入前是否已存在，只撤销本次新增的信任。系统要求密码、管理员权限或 UAC 时由本机所有者确认，工具不会绕过系统确认。邀请内的远端 CA 用于工具连接校验，本节导入的是浏览器访问本机入口所用的开发 CA。

macOS 使用当前用户的 login keychain（按系统提示确认）：

```sh
CA="$HOME/.xunjie/xj-dev/ca/ca-cert.pem" # 使用 doctor/up 给出的实际路径
openssl x509 -in "$CA" -noout -fingerprint -sha256
openssl x509 -in "$CA" -noout -fingerprint -sha1
security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CA"
```

在「钥匙串访问」中按该证书指纹核对信任并重新打开浏览器。结束本次验收、确认没有环境仍使用它后，只删除本次新增的那张证书：`security delete-certificate -Z <本次CA的SHA1指纹去掉冒号> "$HOME/Library/Keychains/login.keychain-db"`。不要按同名 CN 批量删除，也不要移除原先已有的证书。

Windows 在有 **LocalMachine Root 写权限**的 PowerShell 中执行下列脚本；普通会话权限不足时需由本机所有者打开管理员 PowerShell 并确认 UAC。实际 Windows 主机曾对 `CurrentUser Root` 的 Add 返回 `ERROR_NOT_SUPPORTED`；同机所有者使用下述 LocalMachine 方法已完成添加、指纹读回与精确移除。能 Open 不代表能 Add，必须检查读回结果：

```powershell
$caPath = Join-Path $env:USERPROFILE '.xunjie\xj-dev\ca\ca-cert.pem' # 替换为实际路径
$pem = [IO.File]::ReadAllText($caPath)
$der = [Convert]::FromBase64String(($pem -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s', ''))
$ca = [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
$thumbprint = $ca.Thumbprint
$store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
try {
  $existed = @($store.Certificates | Where-Object Thumbprint -eq $thumbprint).Count -gt 0
  if (-not $existed) { $store.Add($ca) }
  if (@($store.Certificates | Where-Object Thumbprint -eq $thumbprint).Count -ne 1) { throw 'CA readback failed' }
  [pscustomobject]@{ Thumbprint = $thumbprint; ExistedBefore = $existed; Readback = $true }
} finally { $store.Close() }
```

记录输出，重新打开浏览器并确认正常 HTTPS。清理时仅当 `ExistedBefore` 为 `False`、确认没有环境仍使用此 CA，才在同等权限 PowerShell 中重新加载**同一 CA 文件**并按同一指纹移除：

```powershell
$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
try {
  @($store.Certificates | Where-Object Thumbprint -eq $thumbprint) | ForEach-Object { $store.Remove($_) }
  if (@($store.Certificates | Where-Object Thumbprint -eq $thumbprint).Count -ne 0) { throw 'CA removal readback failed' }
} finally { $store.Close() }
```

不要清空 Root store、按证书名称批量移除或删除其他用户/项目的 CA。若策略阻止系统信任，报告具体权限/策略障碍，交本机所有者处理；这不算浏览器通过。

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
- 重置已登记环境 = `delete` 后 `up`；本地模式重新播种固定兼容基线。不要手工递归删除环境根或永久锁目录。

### 停止与显式删除

`down` 停止当前工作树/实例登记的各模式进程与连接，保留数据。`delete` 只删除当前工作树/实例**所选模式**的已登记环境：先整体核对持久 `environment.json` 中的 ID、规范工作树/实例或模式身份、真实目录、子项及 PID 归属，再停止该环境进程，删除业务数据库、个人模型数据、浏览器身份、局部证书、日志和进程状态。其他模式/实例目录、源 Git 工作树、全局 CA、运行时、依赖、设备/邀请/账号材料、OSS 缓存和包保留；环境内的接入材料引用、模式选择及 `repro/` 证据也保留。

```sh
node tools/xj-dev/xj-dev.mjs down --instance experiment --json
node tools/xj-dev/xj-dev.mjs delete --instance experiment --json
node tools/xj-dev/xj-dev.mjs up --instance experiment --json
```

删除全过程持有原 `selection.lock/` 与目标 `lock/` 的 SQLite OS 锁，永久目录/SQLite inode 不移动、不替换、不删除。Windows 不尝试删除已打开的锁文件；保留锁守卫不表示保留已删除的数据现场。结构化输出 `deletion.result` 为 `deleted`、`already-deleted` 或 `not-present`，回执 `deletion.json` 供中断后显式重试；后续 `up` 仍争用相同 inode，再重建所选环境。

并发操作返回 `LOCK_HELD`；未知/损坏登记返回 `ENVIRONMENT_UNREGISTERED`，未知子项返回 `ENVIRONMENT_UNKNOWN_OBJECT`，符号链接/特殊对象返回 `ENVIRONMENT_UNSAFE`，外来 PID 返回 `ENVIRONMENT_FOREIGN_PROCESS`，变化中的登记返回 `ENVIRONMENT_CHANGED`。这些情况先保留现场、核对归属。没有有效登记的陌生目录不会被自动认领。文件占用或删除中断返回 `ENVIRONMENT_DELETE_FAILED`，关闭占用该环境文件的程序后重试同一命令，不删除锁来恢复。

## 复现包与基线

本地文件闭环已实现，不需要邀请服务、云存储或模型 Key。`repro capture/inspect/restore/verify` 分别负责采集、校验、恢复、显式执行声明式 HTTP 步骤；生成和恢复均不自动声称问题已复现。

完整示例：保存“两个编辑现场先后保存，旧版本返回 `VERSION_CONFLICT`”的触发前起点。先 `up`，再从现有业务库读取实际任务引用创建 context（下面为 macOS / Git Bash，PowerShell 可将 JS 保存为仓库根临时 `.mjs` 后执行）：

```sh
node tools/xj-dev/xj-dev.mjs up --json
node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveContext} from './tools/xj-dev/src/commands.mjs';
import {databaseDriver} from './tools/xj-dev/src/repro-data.mjs';
const context = resolveContext();
const Driver = databaseDriver(context.repo.teaching);
const db = new Driver(context.env.database, {readonly: true});
const row = db.prepare("SELECT * FROM attempts WHERE course_id='synthetic-textscope-c' LIMIT 1").get();
const attempt = JSON.parse(row.attempt_json);
const generation = db.prepare('SELECT recovery_generation FROM application_control').get().recovery_generation;
db.close();
const body = {recoveryGeneration: generation, expectedWorkspaceRevision: attempt.workspaceRevision,
  clientId: 'stale-editor', clientSeq: 1,
  operations: [{kind: 'create', clientFileKey: 'first', path: 'stale-editor.txt', text: 'first tab saved'}]};
const spec = {formatVersion: 'xj-repro-context/1', code: {paths: []},
  data: {scope: {courseIds: ['synthetic-textscope-c'], userIds: ['synthetic-teacher', 'synthetic-student'], attemptIds: [row.attempt_id]}},
  scenario: {title: '旧编辑现场保存冲突', start: 'before-trigger', expected: '旧版本不覆盖新保存', observed: 'HTTP 409 VERSION_CONFLICT',
    capabilities: {execution: 'not-required', models: 'not-required'}, steps: [
      {actorId: 'synthetic-student', method: 'POST', path: `/api/attempts/${row.attempt_id}/sync`, body, expect: {status: 200}},
      {actorId: 'synthetic-student', method: 'POST', path: `/api/attempts/${row.attempt_id}/sync`,
        body: {...body, clientSeq: 2}, expect: {status: 409, errorCode: 'VERSION_CONFLICT'}}]}};
const file = join(context.home, 'stale-editor-context.json');
writeFileSync(file, JSON.stringify(spec, null, 2));
console.log(file);
JS
node tools/xj-dev/xj-dev.mjs repro capture --context ~/.xunjie/xj-dev/stale-editor-context.json --out ~/.xunjie/xj-dev/stale-editor.zip
node tools/xj-dev/xj-dev.mjs repro inspect ~/.xunjie/xj-dev/stale-editor.zip
node tools/xj-dev/xj-dev.mjs repro restore ~/.xunjie/xj-dev/stale-editor.zip --digest sha256:<capture返回的完整摘要>
# 审阅恢复结果的源码后，用返回的新工作树路径继续；旧环境保持原样。
node tools/xj-dev/xj-dev.mjs up --worktree "<返回的environment.worktree>"
node tools/xj-dev/xj-dev.mjs repro verify ~/.xunjie/xj-dev/stale-editor.zip --worktree "<返回的environment.worktree>"
```

路径以输出为准；`XJ_DEV_HOME` 改根时同步调整示例路径。`restore --target <不存在的目录>` 可指定新工作树。正常依赖按锁安装，恢复本身不会运行 `npm`、任何包内脚本、Git hook/filter、schema 迁移或旧队列；`up` 是审阅后的单独操作。`verify` 仅在匹配包摘要的已恢复本地环境中，使用重新生成的角色身份发送同源 HTTP 请求，回执记录真实状态/错误码，不记录 Cookie、CSRF 或密码。

恢复以真实父目录与目标 `basename` 组合规范路径，预检查、Git 工作树、数据环境 ID 和目标预留使用同一路径，支持盘符根目录下的新目录。目标父目录中的 `.xj-repro-restore-<ID>.lock/` 使用永久 SQLite OS 锁，跨 `XJ_DEV_HOME` 互斥；竞争者返回 `LOCK_HELD` 或 `TARGET_EXISTS`。释放锁保留目录，请勿删除正在使用的锁。失败只回滚本次拥有的新工作树、数据和 Git 工作树登记，保留已有环境。

采集契约：

- `code.roots` 可缩小源码范围，默认包含两个工程、xj-dev 和根规范；`code.paths` 只列必要的未提交或选定未跟踪文件，未选差异保持提交版本。自包含 `code/source.bundle` 携带所选源码快照，未推送源码无需接收方取得原提交；原 SHA 只作来源，不携带历史或作者身份。源码与 bundle 摘要按原始字节校验。
- `data.scope` 必须给出 `courseIds/userIds/attemptIds`。工具从一致 SQLite 读取结果按白名单和业务引用构建新库，原库的页面、会话、密码、个人模型、节点绑定、执行/模型队列与其他成员记录均不分发。选中任务的幂等绑定、原回执和对应审计作为必要依赖保留，支持成功保存后以相同 `clientId/clientSeq`、新 `idempotency-key` 重试；同课程其他成员及同成员其他任务的绑定和自由文本不随之扩大采集。恢复后账号名为 `repro-<摘要前缀>`，新密码只在新环境的 `secrets/baseline-accounts.json`。无法安全表达的引用直接失败。
- `assets` / `evidence` 是明确选择的文件数组，如 `[{"path":"relative/file.txt","name":"notes.txt"}]`；默认均为空。附件采集时间分别记录，缺资源或疑似秘密会拒绝。SQLite 一致视图不代表跨存储原子快照，缺失的个人模型/浏览器/外部服务条件在清单中明确列出。
- 仅依赖条件摘要采用 `sha256:utf8-lf/v1`（仅归一化 CRLF→LF），同时核对接收工作树和已验证 bundle 的实际锁文件，支持 Windows 干净 checkout 的行尾变化；真实锁内容变化在发布新目标之前拒绝。ZIP、源码和资源摘要始终保留原始字节规则。
- `scenario.start` 为 `before-trigger` 或 `after-incident`。后者、`externalUncertainty: true`，或声明执行/模型能力为必需时，自动验证保持 `unverified`，能力需单独准备。`inspect` 和 `verify` 均拒绝空或无效步骤；非空自然语言步骤可保存，自动验证只接受示例中的 HTTP 数据格式，并要求实际观察到全部步骤结果。可识别的无效 synthetic fixture 保留，真实秘密拒绝。
- 已完成的同请求 ZIP 再次 `capture` 只校验并返回 `reused: true`，不会从变化后的现场重新采集。修改内容要用新文件名。ZIP 限制为 128 MiB、展开总量 256 MiB、单文件 64 MiB、10000 文件，拒绝路径越界、特殊文件和跨平台路径冲突。

基线版本保存在 `XJ_DEV_HOME/baselines/<version>/`，发布只影响本机目录；团队传输使用下节稳定编号：

```sh
node tools/xj-dev/xj-dev.mjs baseline publish --context ~/.xunjie/xj-dev/stale-editor-context.json --version course-b1
node tools/xj-dev/xj-dev.mjs baseline list
node tools/xj-dev/xj-dev.mjs baseline use course-b1 --target "<新的工作树绝对路径>"
```

同名版本不可覆盖；`latest` 不作为可变指针。`use` 验证兼容后返回新工作树和新数据副本，Agent 在该路径继续开发；原工作树、浏览器与数据保留，其他成员不自动升级。发布基线也不会把未验证的场景变成已复现。

公开模块供文件传输复用：`captureRepro(context, {contextFile, out})`、`inspectRepro(file, {expectedDigest})`、`restoreRepro(context, {file, target, expectedDigest})`，位于 `src/repro.mjs`。返回 `package: {path, digest, bytes, formatVersion, manifest}`；格式 `xj-repro/1`，整个 ZIP 摘要为 `sha256:<64位hex>`。完整文件先通过 `inspectRepro`，再登记/传输；重试复用原 ZIP。

0.2.0 复现实测（2026-10-23）：从源码提交 `fde601f` 的默认范围（812 文件）重采两个触发前包。macOS 与 Windows 11 / Node 24.21.0 均通过公开 CLI `inspect → restore → up → verify`：旧编辑现场为 `200 → 409 VERSION_CONFLICT`；成功保存后的相同 `clientId/clientSeq`、新 `idempotency-key` 重试为 `200`。包生成和恢复结果均保持 `unverified`，只有实际观察完声明步骤的独立回执记录 `verified`。验证器每次 HTTPS 请求使用独立连接，不自动重试业务请求。

| 0.2.0 正式包 | 完整 ZIP 摘要 |
| --- | --- |
| `mac-scene.zip`（旧编辑现场） | `sha256:eb654e222b866061c186d20886eb1bfd956b2aa461ed64c5c1af4195e63de67e` |
| `retry-scene.zip`（成功保存后重试） | `sha256:7f707608be89a003b1bbd7785b85f69abe277c8ba739cdceb3d93145a9b15006` |

macOS 完整 xj-dev 回归为 68 total / 67 pass / 1 skip（Windows 盘符根目录专用）；Windows 复现专项为 18/18，含同/异 CLI home 并发、失败回滚、空步骤拒绝、bundle 锁内容交叉校验和盘符根目录恢复。两种包的独立公开 CLI 验收在两端各 2/2。Windows 使用本票独立依赖副本和真实 CRLF checkout；恢复未运行安装脚本。0.1.0 历史证据保持冻结。浏览器交互、真实执行节点、模型响应与教学效果未在此项验收。

专项测试：`node --test tools/xj-dev/tests/repro.test.mjs tools/xj-dev/tests/repro-restore.test.mjs tools/xj-dev/tests/repro-e2e.test.mjs`。设置 `XJ_REPRO_EXPORT_DIR` 可从 e2e 导出版本冲突和成功同步后重试两类触发前 ZIP 与实际发送端结果；跨机传递文件后，设置 `XJ_REPRO_TRANSFER_ZIP`、`XJ_REPRO_TRANSFER_DIGEST`、`XJ_REPRO_DEPENDENCIES_FROM`（锁内容一致的已安装工程根），运行 `node --test tools/xj-dev/tests/repro-transfer.mjs`，通过公开 CLI 验证接收端。`XJ_REPRO_TRANSFER_RESULT` 可指定对应发送端结果 JSON（重试包必须指定）；`XJ_REPRO_TRANSFER_EVIDENCE` 可保存接收端实际观察结果。它要求真实材料，不以替身补齐。测试各自停止进程并清理临时工作树、数据和依赖链接；盘符根目录用例仅在 Windows 创建带随机 ID 的本测试目标，macOS 跳过该用例。

常见失败：`DIGEST_MISMATCH` 重新取得正确文件；`RESOURCE_MISSING` 补齐范围或附件；`LOCKFILE_MISMATCH`/`SCHEMA_MISMATCH`/`TOOL_VERSION_MISMATCH`/`NODE_VERSION_MISMATCH` 使用清单对应条件，保持旧环境；`TARGET_EXISTS` 选新目录；`LOCK_HELD` 等待目标操作结束后重试，勿删除使用中的锁；`LOCAL_DATA_REQUIRED` 先显式回到本地模式，工具不冒充或采集云端现场；`UNSAFE_PATH`/`SECRET_DETECTED`/`SCOPE_VIOLATION` 修正采集范围后新建包；`BASELINE_EXISTS` 发布新版本；`NOT_RESTORED`/`ENVIRONMENT_NOT_RUNNING` 在返回的恢复工作树审阅并 `up`。失败不会覆盖当前分支或业务库。

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

新成员由 `join` 自动生成 `xj-dev/connection-v1`，不再提供手填连接模板。兼容既有已批准配置；协议必填 `host`、`port`、`browserUser`、`applicationPort`、`browserOrigin`、`identityFile`、`knownHostsFile`、`caFile`；路径相对配置文件解析。可选 `expectedBackendVersion` 是显式兼容约束，不是观测版本。文件应放仓库外受限目录，私钥正文和账号密码不进入 CLI 输出。

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
| `BASELINE_FAILED` | 重试 `up`；曾成功登记的环境可显式 `delete` 后 `up`，无有效登记时保留现场检查 |
| `BASELINE_MARKER_MISSING` / `BASELINE_MARKER_INVALID` / `BASELINE_CREDENTIALS_MISSING` / `BASELINE_CREDENTIALS_INVALID` / `BASELINE_INCOMPLETE` | 保留已有数据库与凭据，从可信备份恢复匹配的标记/账号材料，不自动重置账号或业务数据 |
| `CA_INCOMPLETE` / `CA_INVALID` | 保留 `home/ca` 与永久锁，恢复同一根的配对材料；不删除或轮换已受信任 CA |
| `GATEWAY_TLS_INVALID` / `GATEWAY_RESTART_REQUIRED` | 在原工作树、同一 `XJ_DEV_HOME`、instance 和所选模式执行 `down` 后 `up`，重载修复后的叶证书；保留原 CA、数据与入口，不接管外来进程 |
| `LOCK_HELD` | 另一进程正在操作同一锁；等待后重试，进程退出会自动释放 OS 锁，勿删除锁目录 |
| `LOCK_LEGACY` | 遇到已退出 holder 的有效旧 JSON 锁；停止所有旧版 CLI、确认无操作后，将该文件移到原路径之外保留，再使用新版重试 |
| `LOCK_UNSAFE` | 锁路径未知、损坏、尚未写完、是符号链接，或内部不是工具专用 SQLite；原对象保持不动，停止相关 CLI 后检查权限、路径和内容并保留现场，不删除业务库 |

### 锁格式与中断恢复（0.2.0）

`acquireLock(...).release()` 保持同步接口。每个锁路径（环境的 `lock`、模式的 `selection.lock`、基线的 `publish.lock`、共享 CA 的 `home/ca/initialization.lock`）现在是永久目录，内部 `mutex.sqlite` 仅保存工具锁标识，与业务 `data/xunjie.sqlite` 无关。精确 Node 24.21.0 的内置 `node:sqlite` 在获取锁时延迟加载，普通 CLI 可先定位并转入受管 Node；不增加依赖或常驻服务。

首次本地基线先持久保存随机凭据，再构造私有数据库与标记，最后发布数据库。初始化中断时复用已保存的凭据；已有数据库缺少完整材料会明确失败并保留现场。共享 CA 在 home 级锁内完成同代配对发布，中断后只恢复可验证的同一根；叶证书修复时 `up` 仅重启本环境 gateway，保持端口、Origin、数据与其他组件。若此前在磁盘修复后中断、运行进程仍持旧叶证书，严格 TLS 检查会拒绝假成功，按上表 down/up 恢复。

首次创建先在锁目录的私有 `.initialize-*` 子目录中完成数据库，再用不覆盖目标的硬链接原子发布。多个创建者始终使用同一个已完整初始化的文件；目录创建或初始化期间被中断，下一次可继续初始化。持有期间保留 `BEGIN IMMEDIATE` 事务及连接，正常释放只关闭自身连接，异常退出由 OS 释放，不按 PID、文件年龄或解析失败删除锁。不同路径各自独立，释放后目录与数据库继续保留。需要支持 SQLite 文件锁与硬链接的本地文件系统；不能创建硬链接时会明确失败。

0.1.0 把非 JSON 当 stale 的删除逻辑无法非递归删除新目录，因此不能偷走新版锁。遇旧 JSON 时，新版不自动迁移或删除：活 PID 返回 `LOCK_HELD`，格式完整且 PID 已退出返回 `LOCK_LEGACY`，空文件、损坏或未知内容返回 `LOCK_UNSAFE`。升级时先停止所有旧版 CLI 操作，确认旧 holder 已退出，再将旧锁文件改名保存到锁路径之外，之后运行新版。PID 复用或无法确认归属时保留对象并检查，不根据时间猜测。不要在旧版 CLI 仍运行时移动锁，也不要通过删环境数据来处理锁失败。

内部 SQLite 的最终组件同样拒绝符号链接、外来数据库及非预期 `-journal`/`-wal`/`-shm` 文件，不执行未知数据库恢复。创建进程被强制结束可能留下未发布的 `.initialize-*` 目录，它们不持有公共锁；停完相关 CLI 后可将这些目录移出保留或清理，正常初始化的临时目录会自动清理。不要在 holder 存活时删除或替换公共锁目录/数据库。

工具版本同步升级为 `0.2.0`。复现包继续要求工具版本精确一致；冻结的 `0.1.0` 包不会被默认为兼容，应由对应版本恢复，或用新版重新采集场景。原包证据保持不变。

锁专项回归：`node --test tools/xj-dev/tests/operation-lock.test.mjs`。使用精确受管 Node，覆盖真实进程的创建/发布暂停、初始化与持有进程死亡、并发接管/重试、重复 release、不同锁、旧实现拒绝目录，以及旧 JSON、外来 SQLite 和符号链接保护。

2026-10-23 实测：macOS arm64 与实际 Windows x64 均在 Node 24.21.0 下通过锁专项 18/18，无跳过；每个平台都运行六进程累计 90 次临界区互斥检查，并实际强制终止创建、初始化、发布和持有阶段的进程。Windows 使用本票独立临时目录，未使用既有共享验收工程；文件符号链接与 junction 均实际验证。Linux 未测。该专项不涉及浏览器交互或教学效果。

平台状态：macOS 与 Windows 11 x64（10.0.26200.9711）已实机验收，均使用 Node 24.21.0。

Windows 实测结果（2026-10-23）：xj-dev 23/23；student 类型检查、构建及 684 项测试通过；teaching 类型检查、构建及 525 项测试通过（另有 24 项依赖外部执行环境的测试跳过）。Chromium 完成登录、课程、保存、冻结、提交、教师反馈和学生读取，并实际修改组件源码验证 HMR。另验证后端源码修改后仅 backend 重启、API 响应更新，以及 down 后自有 PID 全部退出、重启保留原反馈。验收结束已停止该环境，保留独立开发数据。执行节点、模型与教学效果不在本次验证范围内。


## 团队复现编号与直传

团队成员使用独立的 `file:publish` / `file:read` 设备能力。`page` 或 `node:*` 不隐含文件权限；文件设备可以仅登记，不创建 SSH 账号或应用测试身份。新工作树默认复用该 home 的登记指针，也可显式 `--device-file FILE`。云端配置只在独立 access 服务内，产品和本地文件复现不依赖 OSS SDK。

```sh
node tools/xj-dev/xj-dev.mjs repro share frozen.zip --digest sha256:<完整摘要>
node tools/xj-dev/xj-dev.mjs repro resume xjp_<UUID>
node tools/xj-dev/xj-dev.mjs repro fetch xjp_<UUID>
node tools/xj-dev/xj-dev.mjs repro restore xjp_<UUID> --target /absolute/new-worktree
node tools/xj-dev/xj-dev.mjs up --worktree /absolute/new-worktree
node tools/xj-dev/xj-dev.mjs repro verify xjp_<UUID> --worktree /absolute/new-worktree
node tools/xj-dev/xj-dev.mjs repro cache-delete xjp_<UUID>
```

先 `capture` 冻结 ZIP，再 `share`：发送方校验包、保存私有冻结副本，登记稳定 `xjp_` 编号，按 8 MiB 分片直传私有 OSS。默认单包 128 MiB、成员 256 MiB、团队 1 GiB；未完成上传也预留配额。服务端 ListParts 核对每片 size/MD5，再 Complete/HEAD 核对总 size 和 CRC64/XZ 后才发布；SHA256 是发布者声明，接收端必须完整复算，不声称 ECS 读取文件计算 SHA。

`resume` 复用原 ZIP 和幂等请求，已由 OSS 确认的分片不重传；失败输出 `transfer` 投影，保留编号、冻结路径与确认进度。`fetch` 只下载、校验和检查兼容；`restore ID` 自动取得同一 ZIP 后建立隔离环境。`verify` 才显式执行真实业务 HTTP 步骤，上传和恢复均不会自动宣称问题已重现。已校验缓存按摘要复用，续传使用带引号 ETag、Range 与 If-Match；摘要/长度/CRC/兼容性不符拒绝作为可用包。

授权最长 300 秒，可重新申请；URL 只在内存中使用，文件从 OSS 公网端点直接流向设备，不经 ECS 3 Mbps 出口。URL/STS 不进入 argv、日志、普通结果或复现包。撤销后不再签发新 URL；此前 URL 的精确过期时间和剩余毫秒由 revoke/inspect 报告，不能声称立即使已签名 URL 失效。

维护者沿现有 owner 管理通道使用 `access package-quota` 查看限额/预留，`package-baselines` 查看引用，`package-baseline --input-file FILE` 登记 `{name,version,reproId}`。同 name/version 只允许同一不可变编号，不能覆盖他人内容。`package-cleanup --input-file FILE` 接受 `{transferId}`，只清理失败 multipart 与本工具未发布的对象；已发布或被引用的场景保留。存储失败时先 deny，确认该条目拥有的 multipart 与已完成对象均已清除后才释放预留配额，可重试。`repro cache-delete ID` 经在线授权、独占锁与私有路径校验后清理可再取缓存，也可显式清掉损坏 ready 或已满长但校验失败的 partial，再 `fetch ID` 恢复。有效的共享缓存保留；短 partial、混合布局、未知文件、上传冻结包及永久锁守卫均保留。

## 一次性邀请与设备登记

`join --invitation-file FILE [--mode local|cloud-api|cloud]` 自动准备设备 key、签名登记与连接配置，默认启动 local；`refresh [--device-file FILE]` 用原设备刷新授权。当前工作树的日常 cloud `up`/`use` 自动使用已登记配置。`--no-start` 仅登记，未启动不算完整验收。命令只返回安全 ID、页面与私有文件路径，应用测试账号位于 `enrollment.accountFile`，不出现在日志或 JSON 中。

成员 home 下 `enrollment/<service摘要>/<invitationId>/` 保留原 key 与 stage；同 key 中断重试只继续未完成阶段。成功生成新的私有 generation，最后发布指针；失败保留旧配置。新邀请使用新设备 key，旧 key 丢失时领取新设备邀请。Unix 私有文件检查 owner/0600，Windows 使用共享当前用户 NTFS DACL；不要把私有材料复制进工作树或复现包。

Windows 自动探测可完成 SSHSIG 的签名工具；若 Win32 OpenSSH 的 stdin 签名不工作，会有界跳过并选用已安装的 Git for Windows OpenSSH，不修改 PATH，也不更换连接转发使用的 SSH。若仍报 `DEVICE_SIGNING_FAILED`，保留同一邀请/home/key，核对 Git/OpenSSH 安装和可执行性，修复后显式重试；不要通过换 key 或重发邀请掩盖客户端签名失败。

维护者通过 `access <invite|inspect|revoke-invitation|revoke-device|revoke-member|snapshot> --admin-config FILE [--input-file FILE] [--out-file FILE]` 复用既有 owner SSH。生成邀请必须指定私有 out-file，渠道由维护者选择。普通设备仅批准端口转发；团队身份与应用 teacher/student 角色独立，节点另外授权。

协议、系统权限、双进程生命周期、独立服务安装与备份见[接入服务](../xj-dev-access/README.md)，成员操作见[统一接入说明](../../docs/development-access-operations.md#当前工具入口)。标准产品 runtime 不含开发 service/helper/protocol。旧已批准 connection-v1 仍兼容；新成员无需手工改 key、host、port 或 pin。
