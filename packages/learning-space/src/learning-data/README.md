# 学习数据 owner

本模块拥有无课程活动及其请求身份和回执；通过 `SpaceAuthority.resolveBinding` 取得当前成员与实际目标，不访问空间 owner 的数据库。wire 从 `@xunjie/contracts/learning-data` 消费，生产入口见 [learning-entry](../learning-entry/README.md)。

活动可由目标、起始问题或 HTTPS 资料引用建立，完全不生成课程、Assignment 或教师。`create/list/open/setStatus/receipt` 均经真实所属 PostgreSQL。每次读取和写入先核验空间环境、空间、主体和学习数据服务绑定；不存在及无权读取均不能触发新建。

建立与状态变化使用稳定请求 ID 和输入摘要。相同身份、相同输入返回原回执；不同输入拒绝。提交未知时使用 `receipt` 查询原身份，未确认前不换请求。活动和请求范围在本 owner 的短事务中提交，不拼接空间 owner 的事务。

课程绑定活动经 `createCourse` 使用同一活动模型，并按 `register -> prepare -> 持久 pending -> confirm -> 可见提交` 协调两个真实 owner：课程 owner 保存原活动 ID、发布版本、内容摘要和保留依据；本 owner 只在对方确认后提交可见活动与成功回执。`courseResult` 查询原请求的 pending/accepted/rejected 状态；重复请求返回同一活动 ID，改发布或主体拒绝。准备或确认前的资源、资格故障不确认成功；已确认但回执丢失时按原身份续接。读取、列出、重开和回执查询都重新核验当前课程资格与原版本；资格撤销后课程活动不再投影，自主活动仍按原路径工作。整合后保留已在 `codex/wp02` 的 v2 作品迁移，课程协调状态与固定绑定追加为 v3；不改写已有作品迁移。原独立课程分支的 v2 验收环境不能直接冒充整合后数据库，正式升级/恢复须核对迁移谱系。

`learning.works.read/sync/receipt/content` 是 [#151 作品接口](../../../../docs/student-agent-implementation/wp02-reliable-works.md)：文本/代码文件、类型化资源与状态共用稳定对象和不可变内容身份；同步携带基线与请求身份，拒绝过期覆盖或同 ID 换内容。大内容先经资源后端持久化及重读校验，再同事务发布引用、版本和回执。历史内容保留引用；删除对象留下 tombstone，不因同名新建被复用。

`works.registerBasis` 为[#152 固定引用](../../../../docs/student-agent-implementation/wp02-fixed-references-acceptance.md)登记选择时的作品对象、内容、正文与资源引用，**不推进当前 head**，因此可以引用尚未同步或已被后续编辑替换的内容。`learning.drafts.read/sync/receipt/revision` 使用同一 owner 的活动与访问核验：每活动稳定 `draftId`、单调版本 CAS、不可变修订、稳定请求回执和按 `revisionId` 的历史读取；引用来源只接受本活动本人作品、活动固定发布的课程要求或开放文本材料。问题与引用在同一草稿修订中提交，作品内容登记和课程核验在所属事务前完成，不建立第二套同步引擎。

`learning.intents` 为 [#153 固定动作](../../../../docs/student-agent-implementation/wp02-action-intents.md)提供准备、查询、取消、派发和注册接收能力。固定内容独立保留，不推进可变 head；当前主体、资格和目标每次核验。派发先记录，未知先查询原接收方，同身份幂等，取消先落地的未派发动作不再发送；工作区内容确认不代替业务回执。

`learningMigrations` 在 v4 草稿之后追加 v5 `durable-action-intents`，包含固定输入、派发/取消及真实回执；`validateLearningData` 同时核对原活动范围、不可变输入摘要、资源字节和固定引用。产品宿主将派发关闸/排空纳入同一维护及三 owner 备份恢复。活动、固定动作与已发布内容持续保留，不按页面或活动关闭删除；浏览器独有待发不在服务端备份中。

## 非文本引用（#172）

组件状态和真实执行结果通过注册语义范围生成固定副本，复用 drafts/intents 和 owner 内的资源引用。创建时核对当前课程 authority；保存后的未知适配只读恢复。历史修订、固定动作和资源 pin 参与恢复验证，不修改原迁移。具体格式、保留责任与验证见 [#172 交付](../../../../docs/student-agent-implementation/wp03-semantic-references.md)。
