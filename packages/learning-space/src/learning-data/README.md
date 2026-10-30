# 学习数据 owner

本模块拥有无课程活动及其请求身份和回执；通过 `SpaceAuthority.resolveBinding` 取得当前成员与实际目标，不访问空间 owner 的数据库。wire 从 `@xunjie/contracts/learning-data` 消费，生产入口见 [learning-entry](../learning-entry/README.md)。

活动可由目标、起始问题或 HTTPS 资料引用建立，完全不生成课程、Assignment 或教师。`create/list/open/setStatus/receipt` 均经真实所属 PostgreSQL。每次读取和写入先核验空间环境、空间、主体和学习数据服务绑定；不存在及无权读取均不能触发新建。

建立与状态变化使用稳定请求 ID 和输入摘要。相同身份、相同输入返回原回执；不同输入拒绝。提交未知时使用 `receipt` 查询原身份，未确认前不换请求。活动和请求范围在本 owner 的短事务中提交，不拼接空间 owner 的事务。

`learningMigrations` 登记活动与请求索引，`validateLearningData` 校验活动身份、归属和目标。storage 的资源、维护、备份和恢复接口由产品宿主装配。活动与请求回执持续保留，不按页面关闭或活动关闭删除；作品、内容资源和草稿约束由后续子票接入。
