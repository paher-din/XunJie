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

2026-10-30 的新增原生集成 8 项及真实 HTTP 在途排空 1 项已通过；包括设备组合禁止共享监听、学校拒绝匿名设备代理、成员重新获授权后旧会话仍失效，以及真实 PostgreSQL 提交后丢回执、沿原请求查询与重试。全仓类型检查、构建、生产打包依赖检查、7 个公共契约的浏览器检查及本次文档链接检查通过。

全量 `npm test` 未通过：该轮 22 项失败，主要是既有连接/恢复测试的短时限超时、Windows 文件软链权限及旧本地 socket 测试；其中缺少旧 Web 构建产物的一项在构建后单独重跑通过，不能据此把整轮改记为通过。Web 58 文件、688 项通过。工具回归另行运行但未通过，包含文件软链权限以及原开发环境占用依赖文件造成的安装失败；已核对并停止本工作树原开发进程、恢复锁文件依赖与原生模块，未重新运行整组工具测试。原开发数据库保留。

内嵌浏览器已操作个人活动建立、关闭、刷新与重开，仅为补充界面检查。桌面 Chrome 自动化启动返回 `accessibility window-opened handler did not become ready`，因此本次尚无 Windows Chrome 通过结论；Apple Silicon Mac、真实跨机组合亦未执行。教学效果未评估。以上尚未完成的验收不能用本机 API 结果代替，实施票暂不据此宣称完整关闭。
