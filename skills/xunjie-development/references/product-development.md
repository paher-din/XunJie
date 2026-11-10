# 正式产品开发环境

正式产品预览与 `xj-dev` 的旧演示环境有各自的数据和生命周期。询问“启动开发”时，先核对当前工作内容与正在使用的入口；正式产品迭代沿用本页的环境，不另建演示数据库。

## 本轮部署

学校启用 `space-course`、`learning-data`，提供学校账号、课程及学校活动／作品／学习证据。本机启用 `space-course`、`learning-data`、`teaching-agent`、`model-connection`、`tool-execution`：本机数据模块负责个人空间，已连接学校空间仍访问学校数据。本机 Agent 直接使用本机模型连接访问供应商，执行也在开发者自己的电脑。

学校未启用 Agent、统一模型和执行；停用模块的历史数据保留并参与维护验证。学校不会访问学生本机 Agent、模型或执行接口。本机对学校的访问用于当前授权、课程与学校数据，以及执行证据的主动上传。教师方案指定位置的产品接口与其他受支持组合见 [可组合部署](../../../docs/deployment.md)。

| 入口／位置 | 用途与归属 |
| --- | --- |
| `http://127.0.0.1:57417/` | 正式产品开发预览，源码取启动时的当前 checkout；分支以 `git status` 核对 |
| `~/Library/Application Support/XunJie/environments/default` | 本机既有环境：PostgreSQL、个人数据、Agent Run、个人模型凭据、执行记录和学校连接；保留原环境身份 |
| `https://101.201.141.133/` | 团队开发学校公网入口；Nginx 转发学校回环 `3444`，由 systemd 管理学校服务与证书续签 |
| 远端 `~/xunjie-school-dev.NK1GQlUI/school-v2` | 开发学校的 PostgreSQL 与学校业务资源；应用快照在同级 `app/` |
| 远端 `~/wp04-211/product-linux-x64/` | 学校仍引用的 Node 与 PostgreSQL 运行资源；正在使用，继续保留。当前 Web 快照在学校同级 `web/`，PDF 资源随同级 `app/` 保留 |
| `http://127.0.0.1:5601/#/` | 旧版 UI 对照页，不能拿它证明正式产品链路 |

上述端口与目录是当前开发环境事实，换电脑先从真实安装／连接元数据核实。公共产品部署不要求 SSH；正式跨机入口使用部署者提供的可达地址与认证配置。成员通过公网 HTTPS 连接开发学校；负责人 SSH 只用于维护。成员本机保持回环监听，学校不访问其 loopback。

## 日常启动与停止

1. 检查当前 Git 状态、Node 24.21.0 与既有环境，保留无关工作。读本机 `environment.json`、`installation.json` 只取状态需要的字段，凭据文件不回显。
2. 在目标 checkout 执行 `npm run dev:product`（可用 `-- --root <既有环境目录>`）。该入口编译当前后端并使用前端开发预览；停止的旧版隐式部署会经正式 API 迁接为显式配置，保留原环境身份和数据。后端接线变化需要受控重启，前端普通改动直接更新。
3. 从启动输出取得实际页面入口，读取 `/runtime/status`，同时核对 `deployment.configuration.modules` 与 `environment.services[].unit`，按 [连接前核对实际服务](school-access.md#连接前核对实际服务)确认五个服务均已启动。学校侧也核对其实际状态；仅页面 HTTP 200 或模块声明不能证明 Agent／模型／执行位置正确。
4. 停止使用 `openProductRuntime({root}).stop()` 或当前产品 CLI 的 `stop --root ...`，让执行与数据库按正式流程排空。预览宿主退出前保留未保存输入；不要批量 kill Node／PostgreSQL 或删除数据目录。

本机没有把源码构建升级为新的分发包。当前环境的原 Node／PostgreSQL 资源仍可复用；维护时先读 `installation.json.resources`，不要把该资源目录当旧包清掉。

远端维护使用本机 `~/.config/xunjie-cloud/ssh.conf` 中的 `xunjie-cloud`。学校启停由 `sudo systemctl start|stop|restart|status xunjie-school.service` 管理；成员浏览器直接访问公网 HTTPS。固定 Node 执行同级 `app/cli.js`，带 `--root <学校目录>`，用于产品状态、成员权限和备份等维护操作。该服务只管理现有学校环境。

## 部署与设备接入

模块切换使用产品 `configure-deployment --dry-run`，停环境后应用，再启动。学校配置为 `{"formatVersion":1,"modules":["space-course","learning-data"],"dependencies":{}}`；本机配置为本页列出的五个模块。通过 `retained` 区分历史 owner 与启用模块，不手工删数据库 schema。

学校应用由当前源码的 `scripts/package-product.mjs#buildApplication` 构建后更新既有 `app/` 快照，复用原运行资源。源码版本／构建摘要记录在学校同级 `school-v2-source-info.json`；以该文件和实际运行结果核实，不能从本机分支名推断云端版本。

成员首次接入按 [开发学校成员接入](school-access.md)完成，学校批准后的客户端自动登记本机 Agent 与执行上传连接。显式其他部署仍按 [连接步骤](../../../docs/deployment.md#连接本机-agent-与学校数据)操作。当前有效学校连接继续使用，不清空配对数据。学校只授权本机向外调用：Agent 依赖授权与执行证据上传授权分开，不部署反向隧道。

学校测试账号从负责人本机 `~/Library/Application Support/XunJie/school-test/student-account.json` 在授权操作内读取，密码只用于该学校的登录；不在聊天或日志输出。通用成员接入账号仍按 [操作路由](operations.md#手动登录与查看测试账号)取得，勿将负责人测试账号当作团队共享配置。

## 排障与清理

- Agent／模型位置：检查本机活动 Run 和模型调用记录、学校启用模块及学校模型任务数量。新对话成功且学校没有新模型任务，才能证明本机直连链路；能力元数据不是实测结果。
- 学校暂时不可达：先检查公网 HTTPS、证书与远端学校服务状态。保留当前 owner、requestId 和本机未同步执行事实，恢复原连接后继续；不要回退为学校 Agent 或再发一次付费模型请求。
- DeepSeek Messages：Base URL 为 `https://api.deepseek.com/anthropic`，path 为 `/v1/messages`；当前凭据保留在本机。目标地址改变需通过原保存流程重新绑定凭据，密钥不进入学校或公开输出。
- 连接可用但 Agent 提示容量不足：检查个人连接的 `maxOutputTokens`。本次已设为 `4096`；保留 `contextWindow=500000`。未填输出上限时不能把容量暂停误判为网络或学校代理问题。
- 执行证据未同步：核对执行服务独立 grant、deviceModules、installationId 和原 requestId。学校只核验已收到的事实，不主动查询本机。
- 当前开发学校无需 Linux 原生隔离入口，因为没有启用执行。未来教师指定学校执行时，必须先准备对应模块与受限入口，通过部署检查再发布。
- 只清理本次不再使用的临时环境、日志与打包暂存。学校数据、个人凭据、固定组件资源与被引用的产品资源保留；已删除的旧 `8443` 学校环境不恢复。

工程测试、Chrome 验收、真实模型与真实执行、教学效果分别报告。当前改动没有引入另一套学生 UI，也没有开始教师侧产品 UI。

## 2026-11-09 验收记录

本机与学校均为 `ready`。全量 `npm run verify -- --jobs 1`、workspace 类型检查及后续定向回归通过；新增拓扑覆盖学校／本机两种数据归属、Agent 重启、同一请求恢复、权限撤销、真实本机进程与执行记录上传。

桌面 Chrome 已从学校课程创建学校活动，由本机 Agent 使用个人 `deepseek-flash` 完成真实回答（Messages，上限 4096，实际输出 197 tokens）。第一次容量暂停未外发，继续原输入后产生一次模型调用。学校的模型调用、模型设备任务、个人模型凭据及 Agent Run 均保持为 0。

同一开发学校通过正式设计、准备与发布接口提供「课程运行位置验收」课程，固定 `student-runtime`。Chrome 自动使用本机原生进程，连续输入 1、2，观察从 0 到 1、3，随后正常停止。学校保存了原执行引用、两次观察和取消终态；学校 `execution_commands`、`channel_executions`、`native_sessions` 均为 0。保留该课程供后续开发复查，原来的模型对话活动也继续保留。

实际跨机普通活动读取曾耗时约 5.9 秒；改为直接授权读取后同一连接实测约 0.52 秒。大资源和效果操作仍保留分块／持久回执。教学效果未评估，未运行本次目标之外的 Windows／Linux 学生端验收；学校执行模块按要求保持关闭。
