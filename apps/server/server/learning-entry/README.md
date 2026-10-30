# 正式学习入口

这是生产 HTTP 接线，消费[空间 owner](../spaces/README.md)与[学习数据 owner](../learning-data/README.md)，不消费旧 SQLite、演示账号或测试宿主。产品 daemon 从配置启动真实模块，学校网页直接使用学校服务，无需学生安装数据库；同一产品程序的本机组合包含个人空间及学校连接。

公开入口为 `/api/learning/`：

| 接口 | 含义 |
| --- | --- |
| `GET context` | 当前客户端命名空间和可选空间 |
| `POST login/logout` | 实际学校账号认证及退出；会话为环境专属 HttpOnly/SameSite cookie |
| `POST manage/members` | 管理者创建成员，需本环境私有控制凭据 |
| `POST manage/membership` | 管理者授予或撤销成员资格 |
| `POST connections/start/approve/exchange/revoke` | 学校认证页面批准及可撤销客户端授权 |
| `POST client/start/complete` | 已安装客户端连接学校；verifier 与凭据留在客户端私有目录 |
| `GET/POST activities` | 按完整身份列出或建立活动 |
| `GET activities/:id` | 读取原活动；拒绝他人对象 |
| `POST activity-status` | 关闭或重新开始活动 |
| `GET receipts/:id` | 查询当前主体原请求的结果，未知返回 null |

`x-xj-space` 只选择已认证空间，不接受主体身份注入。个人空间仅由本机产品组合提供；学校会话及客户端 grant 每次都核验当前学校授权。客户端失联或被拒绝后不会静默换到个人数据服务。跨源浏览器调用拒绝；共享学校监听沿用产品 HTTPS 配置。

浏览器入口在 `apps/web/src/runtime`：先展示空间和活动，运行身份进入诊断。创建活动前保留准确请求身份，未知时查询原请求；列表读取失败单独反馈，不当成空列表。切换空间使旧异步呈现失效。此票不提供课程发布、作品编辑、实验或 Agent 接收。

完整使用与验证边界见 [交接说明](../../../../docs/student-agent-implementation/wp02-identity-activity.md)。
