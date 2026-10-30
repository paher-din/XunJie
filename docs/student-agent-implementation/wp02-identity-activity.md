# 学习空间身份与活动入口

对应 [#149](https://github.com/paher-din/XunJie/issues/149)，范围依据 [WP02 规范](specs/wp02-learning-space-and-reliable-workspace.md)。生产 owner、HTTP 与公开接口说明见 [学习入口](../../apps/server/server/learning-entry/README.md)。课程发布、作品与可靠草稿继续按后续子票接入。

## 使用

正常构建及产品启动后，默认网页为学习空间；`?diagnostics=1` 查看运行状态。个人组合首次进入即建立原生 PostgreSQL 中的个人主体与空间，不需要学校账号或模型。学校组合提供真实账号登录页面；本机客户端在「连接学校提供的入口」填写学校 HTTPS 地址，在学校页面登录并批准后返回完成连接。

管理者使用同一产品 CLI：

```sh
xunjie school-member --root <学校环境目录> --file <仓库外私密成员输入.json>
xunjie school-membership --root <学校环境目录> --file <仓库外成员资格操作.json>
```

创建输入含 `requestId`（UUID）、`loginName`、`password`（至少 12 字符）；资格输入含 `requestId`、`principalId`、`active`。凭据不放 argv、Git 或日志。管理命令从本环境私有目录读取控制授权，不靠修改数据库或伪造身份请求头。身份不随退出、撤销或恢复资格改变。

成员级绑定记录实际环境、服务和配置版本。此次组合将学校活动放在学校自己的学习数据服务；已安装客户端代理访问该原目标，不复制学校账号库。学校身份与学生本机学习数据的真实跨机混合组合归后续部署子票，本次双环境回归不冒充该组合已经验收。

## 维护与恢复

默认产品 daemon 为有数据库的组合登记空间与学习数据两个 owner，分别使用独立受限 schema 和迁移。两者加入 requiredServiceIds、维护参与者及完整备份；暂停新接收、排空、校验并恢复开放沿用 WP01。资源根为私有产品 root 下 `learning-resources`，活动与请求记录持续保留。

可信恢复宿主调用 `createLearningRecoveryTargets({root,environment,resources,admin})`，与 `restoreProductRecovery` 装配；`environment` 取经过认证的源备份，`admin` 延后解析独立目标数据库。恢复后先保持隔离，使用生产模块重新启动，再经 WP01 接管流程开放。主体、空间、活动和服务身份保留，安装身份及客户端命名空间更新；原学校会话和客户端凭据不能直接用于恢复目标。

## 验证与限制

新增原生测试从真实产品 daemon/API 验证个人和学校认证、两个主体、独立环境、重复建立及请求冲突、关闭重开、会话到期与撤销、客户端学校页面批准、服务重启及两个业务 owner 的独立备份恢复和接管：

```sh
# 固定 Node 24.21.0；将 XUNJIE_PRODUCT_POSTGRES_BIN 指向完整 PostgreSQL 18.6 的 bin。
node --test apps/server/tests/learning-entry.runtime.test.mjs
npm run typecheck
npm run build
npm test
npm run check:contracts:browser
npm run check:docs
```

测试不使用内存数据库或身份头代替真实认证。双环境 HTTP 回归在同一 Windows 主机运行，不证明跨机网络或公网 TLS。普通测试发现器把此文件归入 external/native 组，默认 `npm test` 不代替它。

2026-10-30 的 Windows 11 x64（build 26200）、Node 24.21.0、PostgreSQL 18.6 验证结果：

- 原生集成 8/8 通过（[证据](evidence/wp02-native-postgres.json)）：设备组合禁止共享监听、学校拒绝匿名设备代理、学校登录与成员撤销、两个 owner 的独立活动、会话到期、客户端学校页面批准、客户端撤销后本地 grant 清除且再访问 403、真实 PostgreSQL 提交后丢回执沿原请求查询与重试、两个 owner 的备份恢复与接管。
- 全仓类型检查、全量构建、7 个公共契约的浏览器导出检查及本次改动涉及的 9 份文档 115 个本地目标通过。
- 真实桌面 Chrome 156.0.8078.76（Playwright 1.64 驱动已安装的 Google Chrome，有头模式）通过三条受影响入口（[证据](evidence/wp02-chrome-windows.json)、[个人活动](evidence/wp02-chrome-personal.png)、[学校登录](evidence/wp02-chrome-school.png)、[客户端连接](evidence/wp02-chrome-client-connect.png)）：个人活动建立/关闭/刷新/重开；学校账号登录、建立活动、退出后不再显示；已安装客户端经学校页面批准接入、代理建立学校活动、撤销连接后学校空间消失且本地无残留 grant。
- 全量 `npm test` 仍有 21 项失败：product-runtime 18、storage 1、server 2，均为本机既有环境限制，不是本票新增行为。18 项连接/恢复用例在超时或恢复临时目录竞争下失败，`origin/main` 基线工作树（同一 `node_modules`）复现同一批失败（基线还因缺少 `dist-runtime` 多失败 11 项）；3 项依赖 Windows 文件符号链接，本机未开启 Developer Mode；server 的 `optional local account control ...` 报 `LOCAL_SOCKET_CONFLICT`，是旧本地控制 socket 用例在 Windows 文件模式位下的既有失败。Web 58 文件、688 项通过。
- 工具组另行运行时，依赖外部 OSS/团队服务的用例单项等待 100 秒以上，未跑完即停止；本票未修改 `tools/`，该组结果不作为本票通过依据。

默认全库文档检查另报 252 处断链，全部位于工作区原有的未跟踪 `.tmp/`、`docs/planning/` 和 `docs/tasks/`；这些材料未修改、暂存或提交，受 Git 跟踪的文档单独检查通过。

**未执行**：Apple Silicon Mac 的真实 Chrome 验收（本机无该硬件），因此本票的两平台浏览器验收尚未全部完成；真实跨机混合组合按规范归后续部署子票；教学效果不评估。上述未完成项不能用本机 API 结果代替，实施票暂不据此宣称完整关闭。
