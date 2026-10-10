# A2 → C1：PAHER 真实 readiness 业务链交接

日期：2026-10-10。A 主责交接；Refs A2 #13 / C1 #12。本文件供 C 在已获准、已准备的 C1 宿主运行，不是完整产品/浏览器验收，也不授权安装节点、修改凭据、迁移既有库或部署。

## 可运行源码

固定 A2 联调候选：`8421157d7e917067b397d76378ed91096c4a8369`。该提交仅本地，尚未推送/创建 PR；包含 A1 `30fd2b1`、C1 `f8b6c6f`、C2 `64eaa958`。正式 A1/A2 PR 按用户要求在 A2 真实联调补齐后分别提交，不把此候选称为已完成 PR。

A 已生成仅含已提交 Git 对象的增量 bundle `a2-c1-8421157.bundle`，基于远端 main `54ca54c6f2d01d2875b80404a525ec5505da2eb1`；不含 node_modules、临时数据库、诊断日志或运行时凭据。`git bundle verify` 已通过；文件 SHA-256 为 `bab7703313e4abe3fe1b376f16f302bc6d18112deda57e68bfb8a7cb1d4b66dc`。bundle 经受控文件传递到 PAHER，在已有 XunJie 仓库导入，然后在新的工作副本执行；不切换/覆盖 C 当前工作副本：

```bash
# 在已有 XunJie 仓库；三个绝对路径请改为 PAHER 的实际受控路径
bundle_path=/absolute/path/a2-c1-8421157.bundle
worktree_path=/absolute/path/xunjie-a2-c1-check

git fetch origin main
git bundle verify "$bundle_path"
git fetch "$bundle_path" HEAD
git worktree add --detach "$worktree_path" 8421157d7e917067b397d76378ed91096c4a8369
cd "$worktree_path"
```

逐条执行，任何校验/导入失败先停止；既有同名工作目录不覆盖。不要将本机 bundle SHA 当作 GitHub 已可获取的提交。

## 执行命令与连接配置

这是现有获准 app.inject 业务用例的执行入口。当前 `npm start` 的 main 只启动健康服务，没有注册 A2/认证业务监听；不能用它执行这条链。A2 工厂为 `server/design/application.ts:createDesignApp`，实际联调用例为 [design-activities.test.ts](../../apps/teaching/tests/design-activities.test.ts) 的 `real authenticated C1 readiness supports the A2 checks-release-assignment-pause chain`。

在已准备的 C1 宿主使用 Node **24.21.0**。安装精确 lock 依赖，不修改 package/lock；依赖安装、native module 或类型检查失败时保留错误，不关闭版本或检查：

```bash
# 仓库根目录，C1 文档所述宿主的获准便携 Node 已存在时
export PATH="/opt/xunjie-runner/node/bin:$PATH"
node --version
cd apps/teaching
npm ci
npm run typecheck
npm run build
cd ../..

# 指向 C 在本机保管的连接配置；非 .env，无凭据正文
XUNJIE_A2_RUNTIME=1 XUNJIE_A2_SSH_CONFIG=/absolute/path/a2-c1-ssh.json \
  node --test --test-name-pattern='real authenticated C1 readiness' apps/teaching/tests/design-activities.test.ts
```

C 在受控位置准备下列五项路径/连接信息，不提交配置、不发送密钥正文。以下值仅适用于文档已准备的本地节点，宿主或安装位置不同须用实际获准配置：

```json
{
  "binary": "/usr/bin/ssh",
  "host": "127.0.0.1",
  "port": 2222,
  "keyFile": "/opt/xunjie-runner/vm/keys/application",
  "knownHostsFile": "/opt/xunjie-runner/vm/keys/known_hosts"
}
```

C 的 sshRunner 固定应用入口 `root@host xunjie-c1`，启用 StrictHostKeyChecking/BatchMode，不借维护 key。由对现有 application 文件有已授权读取权的身份执行；不放宽目录/密钥权限。普通联调仅调用 authenticated readiness，不运行 acceptance.ts、recover/advanceGeneration、Docker 故障注入或节点安装/源部署。节点未就绪、指纹/validation 不匹配或任一步失败如实记录，不用历史 ready/合成替身代替。

## 正常登录入口和业务链

正常服务端登录路由是 **POST /api/sessions**，JSON `{loginName,password}`，要求受信 Origin；成功经真实 scrypt、成熟 Session 插件和实际数据库保存，返回 Session cookie 和会话绑定 csrfToken。当前会话为 GET /api/session，退出为 POST /api/logout。此候选没有浏览器登录页/对外业务监听地址，也没有可发放的长期账号或可复制的 Session。

该用例自动通过上述正常登录路由分别登录 teacher/student，使用真实数据库用户/课程成员与当前会话权限；没有绕过认证注入身份。随机合成密码与签名材料仅在进程内使用，不输出/落配置。app.inject 进入 Fastify 真实路由与插件，未建立 TCP/TLS；HTTPS Origin 仅验证请求防护契约，不声称浏览器/TLS 已验收。

链路：教师登录 → 配置获准合成政策/规则和草稿 → POST /api/blueprints/:id/checks → POST /api/blueprints/:id/releases → POST /api/activities/:id/assignments → 学生登录/读取固定活动 → POST /api/activities/:id/controls（pause）→ 学生读取分配 active=false。政策/规则夹具方法使用当前教师权限，不是额外产品 UI/API；本用例不创建学生学习 Attempt、运行作业或调用模型。

## 数据库初始化/使用授权记录

准确审批正文与范围见 [A1 §12](A1_FOUNDATION_ACCESS_TRANSACTION.md#12-a1-完整交付与独立-pr-收尾方案待准确存储授权)、[A2 §11.2/11.4](A2_TEACHER_DESIGN_VERSIONS.md#114-当前授权与执行状态)。用户在明确风险/范围提请后答复 **“批准该范围并继续”**，批准 §11.1～11.3 公共接口、**全新临时十七表合成库**及 app.inject/真实事务/关闭重开/双进程接缝。后来“授权最小依赖修复，继续完成”仅批准已记录的最小 B/C 集成修复，不扩大节点维护权限。

本用例自动调用 `createCompletionDatabase()`，在系统临时目录新建独占 `xunjie-a12-completion-*/synthetic.sqlite`，一次初始化原十表加 help_policy_versions/check_rule_versions/activity_versions/activity_controls/assignments/attempts/jobs 七表。只写合成用户/成员/材料/草稿/活动/分配/回执/事件，实际事务提交；库与数据关闭后保留，不清理、不复用或迁移 A 机器已保留的历史测试库。

旧合成库的随机密码与签名材料不持久保存，不能作为长期人工登录入口。现有工厂重开只用于本批合成库验证，不授权打开/改 schema/导入既有业务库、生产库或真实学生数据。不得把新建 PAHER 合成库解释成新节点安装、key 分发、生产账号发放或部署许可。

## 交回结果

请交回源码 SHA、Node 版本、执行命令和实际测试结果；说明真实用例确已执行（不能 SKIP），记录对应 runtimeProfile/validation 状态及任何失败。无需提供配置、私钥、密码、token、原始 Session 或私有正文。成功预期为指定用例 1 通过/0 失败/0 跳过；失败保留库，交 A 修复。

A 现有本机证据：typecheck/build 通过，统一 157 项中 151 通过/0 失败/6 跳过；A2 两轴审查未解决 0。真实 C1 用例本机未执行，仍是本次联调待补事实；不能将 C 的历史节点验收或 A 的合成通过计为本次正向结果。
