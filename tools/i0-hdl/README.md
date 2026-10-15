# Robert 本机 C/HDL 环境入口

本目录是已准备环境的运行工具。范围及实际验收见 [本批任务](../../docs/tasks/I0-UI_HDL_REAL_BROWSER.md)，课程发布工具见 [合成课程准备说明](SEED_LOCAL_COURSES.md)。运行入口为 `xunjie-local.ps1`，业务页面为 <https://127.0.0.1:3444>。

## 首次准备

需要 PowerShell 7、已准备的 Ubuntu WSL2、专用 KVM 执行 VM、Node24.21.0，以及原工厂初始化的35表合成库。一次性准备由获授权的本机搭建流程完成；日常启动不要再次执行 `local-node-setup.ps1` 的磁盘、身份、镜像安装或验收阶段。

| 已准备对象 | 本机位置与约束 |
| --- | --- |
| 专用执行节点 | Ubuntu 内 `/opt/xunjie-runner`；既有2CPU/4GiB/20GiB VM，原四个固定镜像和冻结 runner |
| 原 VM 启动脚本 | `/opt/xunjie-runner/frozen-source/apps/teaching/runner/vm.sh`；本工具核对原9fa脚本哈希后只调用 `start` |
| 本机节点验收收据 | `/opt/xunjie-runner/local-node-ready.json`；绑定本机公钥 pin、原代际及 C/HDL 指纹 |
| 正常业务和前端 | `/opt/xunjie-ui-local`；原认证、原消费者、原 API、准备好的 `student-dist` 与 TLS 叶子 |
| 初始化材料 | `/opt/xunjie-ui-local/initializer.json`、`application-config.json`、`signing-secret.txt`；目录root700、文件root600 |
| 原35表合成库 | `/opt/xunjie-ui-local/retained-tmp/xunjie-a12-completion-*/synthetic.sqlite`；路径由原工厂生成，重启沿用同一库 |
| 保留材料、工具和公开收据 | `D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment\`；业务入口副本在其中 `application-tools\`，大档在 `downloads\`、`oci\`，节点日志在 `node-logs\` |

这些工具不带密码、私钥、API key 或数据库。只保留公开源码、下载档和工程收据到 D 盘；本机秘密继续留在受限 Linux 目录。原冻结宿主通过本人环境 Key 调用；新版个人通道从设置页保存的本人加密配置读取，见下节。

## 新版个人模型通道

[个人模型与真实聊天接入](../../docs/tasks/I0_UI_MODEL_CONFIGURATION_REAL_CHAT.md)新增受限目录 `/opt/xunjie-ui-local/personal-agent/`，仅在同步新版源码/前端与 `local-application-host.mjs` 后生效，既有运行进程不会自动更新。新版 `start` 可使用设置页中的本人供应商配置，无需环境 Key；本人保存并启用后，下一次显式发送即可调用。`start -DisablePersonalModels` 是维护者总停用入口，保留配置与历史。

个人通道不会回退环境 Key 或其他账号 Key；原 `-EnableModel` 的环境传递仍保留为旧宿主兼容入口，不能代替新版设置页配置。个人配置独立四表库与 `credentials.key` 不属于原35表课程库，不重建原课程库、执行 VM 或身份。首次运行的四表与加密凭据初始化已由本轮负责人明确批准；后续运行继续复用。教师模型仍关闭。

## 日常使用

在仓库 `tools/i0-hdl` 或已同步的 D 盘 `application-tools` 目录打开 PowerShell 7：

```powershell
.\xunjie-local.ps1 status
.\xunjie-local.ps1 check
.\xunjie-local.ps1 start
# 本轮明确需要自己的真实模型时才使用：
.\xunjie-local.ps1 start -EnableModel
.\xunjie-local.ps1 stop
```

| 命令 | 行为 |
| --- | --- |
| `status` | 只读查看已保存的业务 PID、VM 当前状态、原受限应用 SSH 双 readiness、HTTPS live/ready。保存的 PID 是启动记录，健康检查才表示当前状态 |
| `check` | 只读查询 `/health/live` 与 `/health/ready`，不启动 VM、业务宿主或模型 |
| `start` | 已监听3444时拒绝重复启动；复用运行中的既有 VM，停机时调用原冻结 VM 的 `start`。最多等待120秒，核对原 `readiness`、`hdl_readiness` 与收据中的同代际、完整指纹、验证哈希、公钥 pin 和 sourceHash，再启动正常宿主 |
| `start -EnableModel` | 执行同样的启动检查，并从本人 Windows Process 或 User 的 `DEEPSEEK_API_KEY` 传入本机子进程环境；默认不启用模型 |
| `stop` | 核对 Linux PID 的确切 Node 可执行文件及宿主模块后发送 SIGTERM；只停止业务宿主，保留 VM、磁盘、身份、原代际、数据库和工具 |

原 `flock --no-fork --nonblock` 持续覆盖宿主进程；第二次启动拿不到锁时不会覆盖有效 PID。Windows 状态在新进程存活检查后保存。模型 key 通过该子进程的 `WSLENV` 传入，不写 argv、文件、日志或全局环境，不传到 PAHER。默认模型预算关闭；启用后仍沿用原 SDK 的用途、单 Job、政策、token 和重试判据，教师模型保持关闭。

`start` 不重建 VM、生成新身份、重新初始化或迁移库，也不重新运行验收或替换代际。节点指纹、验证、公钥或代际不匹配时停止业务启动并报告原因；保留原状态等待处理，不自动接受新环境。等待超时后既有 VM 可能仍在启动，可先 `status` 检查再决定重试。`stop` 返回的是关停请求，继续用 `check` 核对业务已退出。

## 登录和页面

学生从本批实际分配深链进入原登录页面：

| 课程 | 本机现有账号与入口 |
| --- | --- |
| C / TextScope | `synthetic-robert-student-a`：<https://127.0.0.1:3444/#/task/fb0983e4-81bc-487b-8b50-7ffe984c38bb> |
| HDL | `synthetic-robert-student-b`：<https://127.0.0.1:3444/#/task/4c589f3c-18bc-447a-b6bb-6e3a86c442a7> |
| HDL 全输入补验 | 同一个 B 账号：<https://127.0.0.1:3444/#/task/cb4e54cb-df5a-4198-bc91-1d8274a9cf64>；独立 immutable 配置显式绑定 resetN，保留主演示配置未绑定的原事实 |

以上是当前新本机库的使用示例，移机或重新初始化后从 `course-seed-receipt` 取得实际 assignmentId，不能复用这些旧 ID。首页目前保留来源设计 Demo，没有交付分配列表。教师合成账号 `synthetic-robert-teacher` 用于原教师 API 的课程发布与分配，当前页面不承诺教师操作界面。

密码仅在本机root600的 `initializer.json` 内，由账号本人通过受控本机入口领取；运行工具不会打印或保存密码。

使用与并行验收隔离的已连接 Chrome profile。同一 `127.0.0.1` 的 Cookie 不按端口隔离，先核对并退出本任务旧3443页面。并行3443网关及 PAHER 服务不由本入口修改或关闭。TLS 沿用本任务已批准的确切本机叶子和用户信任，不关闭浏览器证书检查。

## 只读公开证据

已准备环境的 Linux 原业务源码目录保留本目录 `.mjs` 工具。导出只读查询本人新合成库，不导出用户认证行、会话凭据、签名或模型上下文；保存命令输出时只选择本人公开证据目录：

```powershell
wsl -d Ubuntu -u root --exec /opt/xunjie-runner/node/bin/node /opt/xunjie-ui-local/source/tools/i0-hdl/read-local-evidence.mjs
```

在本仓库根复核已入库公开包：

```sh
node tools/i0-hdl/verify-local-browser-evidence.mjs --file docs/tasks/evidence/ui30-hdl-20261015/browser-final-public.json --require-settled --node-receipt docs/tasks/evidence/ui30-hdl-20261015/local-node-ready.json --manifest docs/tasks/evidence/ui30-hdl-20261015/ui-demo-manifest.json --refresh-before docs/tasks/evidence/ui30-hdl-20261015/browser-before-refresh.json --refresh-after docs/tasks/evidence/ui30-hdl-20261015/browser-after-refresh.json
```

该校验器复用仓库原共享契约，不能把单独复制的 D 盘脚本当成完整源码。`--manifest` 特定核完整演示的 bec2e3c 产物；当前8d页面和静态复核单列。原始 JSON/模型元数据、三份节点通过日志、失败与截图见 [回交包](../../docs/tasks/evidence/ui30-hdl-20261015/handoff.md)。

## 验证边界

运行入口的解析、只读检查或节点就绪，只证明对应工程行为。它们不替代正式页面接线、真实浏览器中的 C/HDL 操作、模型投递与可见展示回执验收，也不证明真人学生已确认或教学效果。真实启动、停止、浏览器和模型的执行结果分别记录在本批任务；失败、未知与未执行项保留。
