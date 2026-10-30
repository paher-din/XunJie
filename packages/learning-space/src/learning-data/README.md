# 学习数据 owner

本模块拥有无课程活动及其请求身份和回执；通过 `SpaceAuthority.resolveBinding` 取得当前成员与实际目标，不访问空间 owner 的数据库。wire 从 `@xunjie/contracts/learning-data` 消费，生产入口见 [learning-entry](../learning-entry/README.md)。

活动可由目标、起始问题或 HTTPS 资料引用建立，完全不生成课程、Assignment 或教师。`create/list/open/setStatus/receipt` 均经真实所属 PostgreSQL。每次读取和写入先核验空间环境、空间、主体和学习数据服务绑定；不存在及无权读取均不能触发新建。

建立与状态变化使用稳定请求 ID 和输入摘要。相同身份、相同输入返回原回执；不同输入拒绝。提交未知时使用 `receipt` 查询原身份，未确认前不换请求。活动和请求范围在本 owner 的短事务中提交，不拼接空间 owner 的事务。

课程绑定活动经 `createCourse` 使用同一活动模型，并按 `register -> prepare -> 持久 pending -> confirm -> 可见提交` 协调两个真实 owner：课程 owner 保存原活动 ID、发布版本、内容摘要和保留依据；本 owner 只在对方确认后提交可见活动与成功回执。`courseResult` 查询原请求的 pending/accepted/rejected 状态；重复请求返回同一活动 ID，改发布或主体拒绝。准备或确认前的资源、资格故障不确认成功；已确认但回执丢失时按原身份续接。读取、列出、重开和回执查询都重新核验当前课程资格与原版本；资格撤销后课程活动不再投影，自主活动仍按原路径工作。`learningMigrations` v2 登记协调状态与固定绑定。

`learningMigrations` 登记活动、请求索引与课程协调表，`validateLearningData` 校验活动身份、归属、目标及课程绑定一致性。storage 的资源、维护、备份和恢复接口由产品宿主装配。活动与请求回执持续保留，不按页面关闭或活动关闭删除；作品、内容资源和草稿约束由后续子票接入。
