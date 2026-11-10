# 正式产品开发环境

正式产品预览与 `xj-dev` 的旧演示环境有各自的数据和生命周期。询问“启动开发”时，先核对当前工作内容与正在使用的入口；正式产品迭代沿用本页的环境，不另建演示数据库。

## 默认部署与环境定位

当前默认源码接线为学校 `space-course`、`learning-data` 两模块，本机 `space-course`、`learning-data`、`teaching-agent`、`model-connection`、`tool-execution` 五模块。学校负责账号、课程、活动登记、领取回执、明确提交及学校收件回执；个人活动和学校课程的其余学习过程均在本机，包括草稿、提问／引用、作品、资料／PDF、生成内容、完整会话、模型及实验过程。本机 Agent 直接使用本机模型连接访问供应商。

`school-client` 默认使用 `localStudy`，沿用原 Web API 路径。受领的固定发布、材料、组件、算法、依赖与运行资源缓存到本机，完整下载后可在学校暂时断连时继续学习；新领取和提交需要学校连接，外部模型仍需其供应商可达。

学校未启用 Agent、统一模型和执行；停用模块的历史数据保留并参与维护验证。学校不会访问学生本机 Agent、模型或执行接口。默认本机对学校的访问限于账号与课程／资源受领、活动登记、领取回执、明确提交及收件查询；执行过程不持续上传。显式 `localBinding`／`modelBinding` 混合与独立部署继续保留，按各自授权接线，不能据此描述默认流程。教师方案指定位置的产品接口与其他受支持组合见 [可组合部署](../../../docs/deployment.md)。

| 入口／位置 | 用途与归属 |
| --- | --- |
| `http://127.0.0.1:57417/` | 正式产品开发预览，源码取启动时的当前 checkout；分支以 `git status` 核对 |
| `~/Library/Application Support/XunJie/environments/default` | 本机既有环境：PostgreSQL、个人及学校课程本地学习副本、Agent Run、个人模型凭据、执行记录和学校连接；保留原环境身份 |
| `https://101.201.141.133/` | 团队开发学校公网入口；Nginx 转发学校回环 `3444`，由 systemd 管理学校服务与证书续签 |
| 远端 `~/xunjie-school-dev.NK1GQlUI/school-v2` | 开发学校的 PostgreSQL 与学校业务资源；应用快照在同级 `app/` |
| 远端 `~/wp04-211/product-linux-x64/` | 学校仍引用的 Node 与 PostgreSQL 运行资源；正在使用，继续保留。当前 Web 快照在学校同级 `web/`，PDF 资源随同级 `app/` 保留 |
| `http://127.0.0.1:5601/#/` | 旧版 UI 对照页，不能拿它证明正式产品链路 |

以上入口用于定位既有开发环境；实际端口、资源目录和启用模块从安装／连接元数据及实时状态核实。公共产品部署不要求 SSH；正式跨机入口使用部署者提供的可达地址与认证配置。成员通过公网 HTTPS 连接开发学校；负责人 SSH 只用于维护。成员本机保持回环监听，学校不访问其 loopback。

## 日常启动与停止

1. 检查当前 Git 状态、`package.json` 要求的 Node 版本与既有环境，保留无关工作。读本机 `environment.json`、`installation.json` 只取状态需要的字段，凭据文件不回显。
2. 在目标 checkout 执行 `npm run dev:product`（可用 `-- --root <既有环境目录>`）。该入口编译当前后端并使用前端开发预览；停止的旧版隐式部署会经正式 API 迁接为显式配置，保留原环境身份和数据。后端接线变化需要受控重启，前端普通改动直接更新。
3. 从启动输出取得实际页面入口，读取 `/runtime/status`，同时核对 `deployment.configuration.modules` 与 `environment.services[].unit`，按 [连接前核对实际服务](school-access.md#连接前核对实际服务)确认五个服务均已启动。学校侧也核对其实际状态；仅页面 HTTP 200 或模块声明不能证明 Agent／模型／执行位置正确。
4. 停止使用 `openProductRuntime({root}).stop()` 或当前产品 CLI 的 `stop --root ...`，让执行与数据库按正式流程排空。预览宿主退出前保留未保存输入；不要批量 kill Node／PostgreSQL 或删除数据目录。

源码开发预览与分发包分别维护。先读 `installation.json.resources`，复用既有 Node／PostgreSQL 资源；清理时保留安装仍在引用的资源目录。

远端维护使用本机 `~/.config/xunjie-cloud/ssh.conf` 中的 `xunjie-cloud`。学校启停由 `sudo systemctl start|stop|restart|status xunjie-school.service` 管理；成员浏览器直接访问公网 HTTPS。固定 Node 执行同级 `app/cli.js`，带 `--root <学校目录>`，用于产品状态、成员权限和备份等维护操作。该服务只管理现有学校环境。

## 部署与设备接入

模块切换使用产品 `configure-deployment --dry-run`，停环境后应用，再启动。学校配置为 `{"formatVersion":1,"modules":["space-course","learning-data"],"dependencies":{}}`；本机配置为本页列出的五个模块。通过 `retained` 区分历史 owner 与启用模块，不手工删数据库 schema。

学校应用由当前源码的 `scripts/package-product.mjs#buildApplication` 构建后更新既有 `app/` 快照，复用原运行资源。源码版本／构建摘要记录在学校同级 `school-v2-source-info.json`；以该文件和实际运行结果核实，不能从本机分支名推断云端版本。

成员首次接入按 [开发学校成员接入](school-access.md)认证并完成当前唯一账号绑定。默认本机副本不要求登记旧的学校过程依赖／执行上传连接；显式其他部署仍按 [连接步骤](../../../docs/deployment.md#连接本机-agent-与学校数据)操作，其 Agent 依赖与执行上传授权分别保留，不部署反向隧道。

迁移 29 先冻结当前主体在学校的旧过程写入，导出原活动及关联记录／资源；本机校验并持久保存完整原件与课程运行资源后发送原 digest 的 ack。学校仅清理本人冗余过程副本，并对本次释放资源定向 GC，保留官方登记、正式提交、其他主体与仍有引用／备份 pin 的资源。中断按原迁接续接，未知动作与执行历史不重放。

解绑只隐藏学校内容并保留本机数据；重绑同一学校主体后恢复，已修改作品（dirty）不被重新下载覆盖。明确提交先固定作品／产物与可选实验依据，保存原 `requestId` 后发送；丢包先查询原回执，再按原输入重试。学校收件后可按提交版本回读，后续本机编辑不覆盖该版本。

学校测试账号从负责人本机 `~/Library/Application Support/XunJie/school-test/student-account.json` 在授权操作内读取，密码只用于该学校的登录；不在聊天或日志输出。通用成员接入账号仍按 [操作路由](operations.md#手动登录与查看测试账号)取得，勿将负责人测试账号当作团队共享配置。

## 排障与清理

- Agent／模型位置：检查本机活动 Run 和模型调用记录、学校启用模块及学校模型任务数量。新对话成功且学校没有新模型任务，才能证明本机直连链路；能力元数据不是实测结果。
- 学校暂时不可达：先检查公网 HTTPS、证书与远端学校服务状态。保留当前绑定、已下载本机副本和原 requestId，离线继续已受领课程；领取／提交等待原连接恢复，不要回退为学校 Agent 或再发一次付费模型请求。
- DeepSeek Messages：Base URL 为 `https://api.deepseek.com/anthropic`，path 为 `/v1/messages`；当前凭据保留在本机。目标地址改变需通过原保存流程重新绑定凭据，密钥不进入学校或公开输出。
- 连接可用但 Agent 提示容量不足：检查个人连接的 `maxOutputTokens`、`contextWindow` 与实际模型上限，按当前模型和任务调整。未填输出上限时不能把容量暂停误判为网络或学校代理问题。
- 默认提交未确认：先查原 `requestId` 的学校收件回执，保留固定输入；只有显式旧执行上传部署才检查执行服务独立 grant、deviceModules、installationId，不能将本机实验过程没有上传视为默认故障。
- 当前开发学校无需 Linux 原生隔离入口，因为没有启用执行。未来教师指定学校执行时，必须先准备对应模块与受限入口，通过部署检查再发布。
- 只清理本次不再使用的临时环境、日志与打包暂存。学校数据、个人凭据、固定组件资源与被引用的产品资源保留。

工程测试、Chrome 验收、真实模型与真实执行、教学效果分别按本次实际结果报告。
