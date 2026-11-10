# 开发学校成员接入

学校入口为 `https://101.201.141.133/`。学校提供账号、课程、活动登记、领取回执和正式提交收件；个人与学校课程的学习过程、未提交作品、Agent、个人模型凭据与执行在成员本机。成员账号为 `shenchenyi`、`chengzengrong`、`parherdin`，每人使用自己的私有账号文件。成员账号拥有课程开发权限，不含服务器维护权限。

## 成员电脑上的 Agent 执行

1. 核对当前 checkout 和工具帮助，使用负责人交付的 `main` 固定提交，并确认包含本页的初始化与旧环境迁接能力；已有 checkout 保留无关改动。只读咨询仅核实和回答。
2. 检查本机既有正式产品环境和 `installation.json.resources`，明确本次 `--root` 的完整路径并保留原身份、数据库和学校连接。首次机器按项目 README 准备 Node 24.21.0、锁文件依赖和对应平台产品运行资源，安装 `profile=local`；当前安装入口默认保存显式五模块部署配置。用 `npm run dev:product -- --root <本机环境>` 启动，按下方“连接前核对实际服务”确认就绪后再认证学校。
3. 从成员本人取得的私有账号文件读取 `schoolEndpoint`、`loginName`、`password`，不回显密码。负责人电脑上的交付文件位于 `~/.config/xunjie-cloud/school-members/<账号>.private.json`，该路径不是成员电脑的默认位置，也不复制其他成员的文件。仅用户要自己查看时给私有文件链接。
4. 在本机产品「连接学校」填写上述入口，打开学校认证页，用本人账号登录并批准设备，返回本机完成绑定。当前只绑定一个学校账号，左下角固定显示账号名；默认本机学习副本不登记旧的学校过程依赖和执行上传连接，不需要服务器 SSH 或维护凭据。
5. 从首页课程列表进入获准课程，受领固定版本及完整材料、组件和运行资源到本机。一级 Agent 对话仅用于个人自主学习，课程辅导留在课程工作区。成员自行设置并选用本机个人模型，密钥留本机；学校只接收领取确认和明确提交的固定作品及选定实验依据。分别核对页面、模型、执行与学校收件结果。

首次连接失败时继续原连接请求。相同请求、同一设备重试复用原授权；部分完成不能报告就绪。页面刷新后丢失待完成提示时，Agent 从本机环境的 `credentials/school-client-*` 只读取 `requestId`、`schoolEndpoint`、`setupPending`，向原本机入口重发 `POST /api/learning/client/complete`，请求体为 `{"requestId":"<原请求 ID>"}`；恢复安装还须携带当前 `clientNamespace`，`verifier` 和 token 不回显。成功后核对真实账号名、课程读取和本机学习副本；旧学校过程数据按校验后确认的迁接流程转入本机。解绑隐藏内容并保留本机数据，重绑原主体后恢复，不覆盖本机已修改作品。显式旧混合／独立部署才检查相应 Agent 与执行依赖连接。

## 连接前核对实际服务

读取本次启动入口的 `/runtime/status`，确认 `state=ready`、`profile=local`，并逐项核对 `deployment.configuration.modules` 与 `environment.services[].unit`。标准成员环境的实际服务应包含 `space-course`、`learning-data`、`teaching-agent`、`model-connection`、`tool-execution`；只有模块声明、没有同名实际服务，仍属于未完成初始化。成员操作以其本人电脑的状态为准。

`installation.json.deployment` 缺失时是旧版隐式部署。当前 `dev:product` 会在旧环境停止后，通过正式 `configureDeployment` dry-run 和应用步骤保存显式配置，再按原环境身份与资源启动；已有显式自定义部署保持原配置。旧环境仍在运行时，先保护当前输入并正常停止原进程，再用当前代码启动。启动后的服务核对必须通过。

旧代码遇到“`modules` 含 `tool-execution`、实际 `services` 缺失、完成连接返回 503”的组合时，按原环境调用 `openProductRuntime({ root }).configureDeployment(...)`：先 dry-run、正常 `stop()`、应用标准五模块配置，再启动。只在正式 API 成功后继续；故障时保留原目录、数据库和凭据。启动命令更换目录或端口不能替代这次迁接。

认证请求有效期为五分钟。仍有效的请求按原 `requestId` 续办；已过期时从“重新填写学校链接”发起新认证。只核对和交付请求编号、模块名、服务名及结果，密码、`verifier` 和 token 保持私有。

## 课程开发操作

同一学校账号的 `course.manage` 权限支持课程设计、准备、发布、组件管理和课程资格配置。由 Agent 运行：

```sh
node tools/product-school/member.mjs --account-file <本人私有账号文件> --operation course-catalog
node tools/product-school/member.mjs --account-file <本人私有账号文件> --operation course-execution-compile --file <设计输入.json>
```

`--help` 列出支持的操作；输入采用正式管理接口的 JSON，课程设计接口从认证身份取得操作者。工具只在内存使用本次登录会话，结束后退出。权限不包括创建账号、授予管理权限、服务器控制或学校模型配置。

## 负责人维护与验收

公网 Nginx、证书续签、学校 daemon、监控和正式产品加密备份见 [学校运维工具](../../../tools/product-school/README.md)。续签每 6 小时判断是否到期，保留数日的失败重试窗口；健康每 10 分钟检查，同时核对已加载证书，不额外请求签发。开发学校不设定时备份，保留切换前的恢复点，升级、迁移或批量修改数据前再备份。以实际 systemd timer、线上证书和 CMS 状态核实。学校保持只启用 `space-course`、`learning-data`。

工程测试、桌面 Chrome、本机真实模型、本机真实执行和成员实际设备验收分别报告。负责人独立客户端验收不代表已操作三位成员各自的电脑。
