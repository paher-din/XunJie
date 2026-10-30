# 学习数据 owner

本模块拥有无课程活动及其请求身份和回执；通过 `SpaceAuthority.resolveBinding` 取得当前成员与实际目标，不访问空间 owner 的数据库。wire 从 `@xunjie/contracts/learning-data` 消费，生产入口见 [learning-entry](../learning-entry/README.md)。

活动可由目标、起始问题或 HTTPS 资料引用建立，完全不生成课程、Assignment 或教师。`create/list/open/setStatus/receipt` 均经真实所属 PostgreSQL。每次读取和写入先核验空间环境、空间、主体和学习数据服务绑定；不存在及无权读取均不能触发新建。

建立与状态变化使用稳定请求 ID 和输入摘要。相同身份、相同输入返回原回执；不同输入拒绝。提交未知时使用 `receipt` 查询原身份，未确认前不换请求。活动和请求范围在本 owner 的短事务中提交，不拼接空间 owner 的事务。

`learning.works.read/sync/receipt/content` 是 [#151 作品接口](../../../../docs/student-agent-implementation/wp02-reliable-works.md)：文本/代码文件、类型化资源与状态共用稳定对象和不可变内容身份；同步携带基线与请求身份，拒绝过期覆盖或同 ID 换内容。大内容先经资源后端持久化及重读校验，再同事务发布引用、版本和回执。历史内容保留引用；删除对象留下 tombstone，不因同名新建被复用。

`learningMigrations` 登记活动、作品及其请求索引，`validateLearningData` 校验活动身份与目标，以及作品 head、版本、资源归属、字节与回执。storage 的资源、维护、备份和恢复接口由产品宿主装配。活动与已发布内容持续保留，不按页面或活动关闭删除；问题草稿、固定引用和待发意图按后续子票接入。
