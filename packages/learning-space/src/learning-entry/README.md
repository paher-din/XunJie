# 正式学习入口

这是生产 HTTP 接线，消费[空间 owner](../spaces/README.md)与[学习数据 owner](../learning-data/README.md)，不消费旧 SQLite、演示账号或测试宿主。产品 daemon 从配置启动真实模块，学校网页直接使用学校服务，无需学生安装数据库；同一产品程序的本机组合包含个人空间及学校连接。

公开入口为 `/api/learning/`：

| 接口 | 含义 |
| --- | --- |
| `GET context` | 当前客户端命名空间、绑定账号和可用身份 |
| `POST login/logout` | 实际学校账号认证及退出；会话为环境专属 HttpOnly/SameSite cookie |
| `POST manage/members` | 管理者创建成员，需本环境私有控制凭据 |
| `POST manage/membership` | 管理者授予或撤销成员资格 |
| `POST manage/connection` | 管理者撤销指定客户端连接，不改变成员资格 |
| `POST connections/start/approve/exchange/revoke` | 学校认证页面批准及可撤销客户端授权；撤销后学校拒绝原 grant，客户端删除连接凭据并隐藏学校内容，保留本机学习数据 |
| `GET connections/profile` | 有效连接 bearer 读取当前身份、目标及学校是否允许本机学习；不续签会话，不返回 token，不依赖已过期的初始认证请求 |
| `POST client/start/complete` | 已安装客户端连接学校；verifier 与凭据留在客户端私有目录 |
| `GET/POST activities` | 按完整身份列出或建立活动 |
| `GET activities/:id` | 读取原活动；拒绝他人对象 |
| `POST activity-status` | 关闭或重新开始活动 |
| `GET receipts/:id` | 查询当前主体原请求的结果，未知返回 null |
| `GET courses` | 当前学校身份的已获准课程、任务与发布摘要 |
| `GET releases/:id` / `GET releases/:id/materials/:materialId` | 读取明确发布版本的学生投影或开放材料；私有材料统一不可见 |
| `POST course-activities` / `GET course-activity-results/:requestId` | 从选定发布版本建立课程绑定活动，或查询原请求的 pending/accepted/rejected |
| `GET study-transfer` / `POST study-transfer/ack` | 学校允许本机学习时按当前主体导出旧过程；本机完整持久化后按原 digest 确认学校定向清理 |
| `POST activity-receipts/:activityId` / `GET .../:requestId` | 固定课程版本的领取确认及原回执 |
| `GET/POST submissions/:activityId` / `GET .../receipts/:requestId` / `GET .../:submissionId` | 明确提交、原收件回执及不可变提交版本回读 |
| `POST manage/course-import` / `manage/course-access` / `manage/course-result` | 管理者登记不可变发布、授予/撤销课程资格、查询原登记结果 |
| `GET/POST drafts/:activityId` | 读取或同步活动的问题草稿与固定引用；单次请求携带问题、引用顺序、范围/副本和未登记作品的固定依据 |
| `GET drafts/:activityId/receipts/:requestId` / `revisions/:revisionId` | 查询原同步请求结果或按稳定修订身份读取历史草稿；未知返回 null |
| `GET/POST materials/:activityId` | 列出当前活动的个人文本材料或按稳定请求保存；同名不是身份 |
| `POST materials/:activityId/:materialId` / `.../remove` | 追加不可变版本或移除材料，均校验 `expectedVersion` 与请求身份 |
| `GET materials/:activityId/:materialId/versions/:version` / `POST .../read` | 读取固定版本原件或 UTF-16 范围文本；移除后固定版本仍可读 |
| `GET materials/:activityId/requests/:requestId` | 按原请求身份核对未知保存/更新/移除回执 |
| `GET/POST intents/:activityId` / `GET intents/:activityId/:requestId` | 列出、固定准备或查询原动作；内容确认不等于业务接受 |
| `GET intents/:activityId/capabilities` | 当前原活动已注册的接收能力；默认空列表，不挂载测试接收器 |
| `POST intents/:activityId/:requestId/dispatch` / `cancel` | 沿原身份派发、核实及持久协调取消；未知不伪装为未接收或已撤回 |
| `GET agent/:activityId/conversation` / `events` / `capabilities` | 活动级对话投影、稳定游标事件与已注册接收能力 |
| `GET agent/:activityId/runs/:runId` / `POST .../stop` / `POST .../continue` | 读取原 Run、持久停止或建立关联后继 Run |
| `GET agent/:activityId/requests/:requestId` / `snapshots/:snapshotId` | 原请求回执与不可变上下文快照的只读重建 |
| `GET/POST models/connections` | 当前主体的模型配置投影与期望版本保存；凭据不会读回 |
| `POST models/connections/:id/credential` | 编辑原主体自己的配置时，以 `version` 读取完整密钥；校验归属与版本，响应不缓存；授权使用模型不授予读密钥能力 |
| `GET/POST models/checks` / `GET models/checks/:id` | 列表、固定接收及结果查询；只读不生成模型请求 |
| `POST models/checks/:id/dispatch` / `cancel` | 同一有限检查最多一次 Chat 外发或持久协调取消 |

模型生命周期及恢复边界见 [model-connections](../model-connections/README.md)。正式设置使用此 owner，旧个人聊天与教师配置/预算保持各自 legacy 控制器。

`x-xj-space` 只选择已认证空间，不接受主体身份注入。个人空间仅由本机产品组合提供；学校会话及客户端 grant 每次都核验当前学校授权。客户端失联或被拒绝后不会静默换到个人数据服务。跨源浏览器调用拒绝；共享学校监听沿用产品 HTTPS 配置。

还原安装要求成员写入携带当前安装的 `x-xj-namespace` 请求头。连接学校前先读取 `GET /api/learning/context`，取得当前 `clientNamespace`，再随 `POST client/start`、`POST client/complete` 和后续成员写入传入；建立学校会话前也能读取此 context，旧安装的 namespace 不能用于新安装。仅 `login`、`logout` 按精确路径豁免；`manage/`、`connections/`、`native-channel/` 前缀沿用各自的管理员凭据或握手校验。

设备组合的监听及公开入口仅允许 loopback；学校共享组合不装配设备凭据代理。宿主关闭新入口后等待已接收的异步业务请求结束，包含远端派发和连接凭据持久化，超时不宣告安全排空。

浏览器入口在 `apps/web/src/runtime`：先展示空间和活动，运行身份进入诊断。创建活动前保留准确请求身份，未知时查询原请求；列表读取失败单独反馈，不当成空列表。切换空间使旧异步呈现失效。本入口提供课程发布、课程活动、可靠作品、问题草稿与正式学习对话；实验执行和教师交付尚未接入。学习对话的持久推进与恢复边界见 [teaching-agent](../teaching-agent/README.md)。

完整使用与验证边界见 [交接说明](../../../../docs/student-agent-implementation/wp02-identity-activity.md)。
混合部署的 `createLearningAuthority` 在 WP01 认证传输内逐次核验学校连接主体、成员级目标和课程资格，仅提供 access/prepare/confirm/authorize。`manage/local-binding` 仅管理员可用；工作区转发同时校验预期主体与恢复 namespace，部署者不能通过普通重试替换事实 owner。操作与验收见 [#154 交接](../../../../docs/student-agent-implementation/wp02-hybrid-deployment.md)。
