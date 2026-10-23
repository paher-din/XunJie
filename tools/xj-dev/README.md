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

平台状态：macOS 已完整验收（工程 + 浏览器）；Windows 尚未实测。
