# 可靠活动工作区

正式产品的 [ActivityWorkspace](../runtime/ActivityWorkspace.tsx) 与现有 [Monaco 宿主](../components/workspace/CodeEditorHost.tsx) 通过 `ReliableWorkspace` 处理文件变化，不各自安排保存、冻结或同步。课程与自主活动共用这条路径；组件状态与资源使用相同的类型化 wire，不强制变成代码文件。需求和验证见 [#151 交接](../../../../docs/student-agent-implementation/wp02-reliable-works.md)。

问题草稿由同模块的 [`ReliableQuestionDraft`](draft.ts) 持有，使用同一个 IndexedDB 数据库的非破坏 v2 `drafts`/`draftCandidates` 分区；它复用相同的等待窗口、稳定 pending、迟到确认、本机竞争与离开保护，但不发送问题或调用模型。界面通过 [DraftReferencesProvider](../components/workspace/references/DraftReferences.tsx) 消费它，问题、引用顺序、固定来源与选中副本均以该记录为唯一可变权威。需求与验收见 [#152 记录](../../../../docs/student-agent-implementation/wp02-fixed-references-acceptance.md)。

## 对外接口

`new ReliableWorkspace(key, transport)` 的 `key` 由产品恢复命名空间、空间所属环境、空间、主体、活动组成。`transport.read/receipt/sync` 始终访问原服务、原空间及活动；页面请求附带预期主体和恢复命名空间，真实服务认证后核对，不能将旧请求交给新登录主体。

- `open()`、`subscribe/snapshot()`：读取本机已保护记录及分歧，订阅可见作品与异常。
- `create/edit/rename/remove/change`：即时改变当前作品；重命名保留对象身份，同名重建产生新 UUID。`change` 支持 typed state/resource，不经过代码编辑器转换。
- `protect/leave`：等待本机事务完成；失败抛出，页面保留内存内容。导航前和异步导航响应后都保护一次；停止同步由成功卸载后的 `dispose` 负责。
- `resolve(files)`：比较后明确选择或合并。选择仍须通过本机 CAS；远端已删除对象恢复为新对象。
- `suspend/dispose`：停止原身份派发/卸载订阅。授权失效不删除原范围记录；重新认证后重新打开并查询原请求。

## 确认与竞争

作品与问题草稿复用 [ReliableStateCoordinator](coordinator.ts) 的初始化重试、保护互斥、250ms/1000ms 调度、离开保护及暂停/恢复生命周期；内容、远端 CAS 与来源依赖策略由各分区实现。草稿候选和主记录都保存尚未登记的引用完整依据，明确选择及恢复不丢来源原文；保护事务的旧结果不能清除等待期间新增的依据。

新库 `xunjie-reliable-works-v1` 不打开、迁移或消费旧演示 IndexedDB/outbox、SQLite 或执行账本。主记录的正文、版本与待同步请求在同一个 IndexedDB readwrite 事务提交，只有 complete 才确认本机保护。过期本机基线不覆盖主记录，候选正文进入同库独立候选记录。

活跃页面的本机合并等待窗口为 **250ms**，空闲网络发送器的检查窗口为 **1000ms**；按固定周期发放，不因持续输入重置。浏览器调度、事务完成及网络往返另计，外部故障不承诺绝对实时。恢复不依赖 unload 的最后一次异步写入；未保护内容离开页面时使用浏览器离开确认保护。

待同步项固定请求 ID、远端基线和文件清单。远端已确认清单与本机当前清单分开；恢复远端确已删除的对象使用新身份，本机尚未被接收的新对象保留原身份。先查询原回执，再按相同请求重试；回执只结清相同 ID，后续正文与下一项不会被旧确认删除。存储失败保持内存与导出能力，周期性重试；短暂网络故障保持安静，权限、损坏及冲突明确反馈。比较期间的正文也必须先受到本机保护，才开放选择操作。

## 边界

普通页面不显示保存按钮或常态保存状态。会话内的 context/activity 缓存只负责在原 API 断开时定位原活动，不是认证或作品权威；离线恢复页暂停网络派发，重新核实原身份后才续传。服务器备份不包含浏览器未同步的正文。

原文编码是 UTF-8，保留 BOM 与原换行分隔符；二进制采用 base64，组件状态可用 JSON。wire 当前限制 64 个对象、总 value 100 万 UTF-16 单元；超出范围的编辑保留在内存，显示异常并可复制/导出，不冒充已保护。
