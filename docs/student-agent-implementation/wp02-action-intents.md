# 固定依据与持久待发意图

对应 [#153](https://github.com/paher-din/XunJie/issues/153)，实施基线 `269d41a`；范围见[实施方案](specs/wp02-durable-action-intents.md)和[母规范](specs/wp02-learning-space-and-reliable-workspace.md)。Mac 和真实跨机执行统一交接 [#155](https://github.com/paher-din/XunJie/issues/155)，不以 Windows 或同机多进程代替。

## 调用者入口

正式页面的活动 session 共同拥有 `ReliableWorkspace`、`ReliableQuestionDraft` 和 `workspace.actions(draft, transport)`。工作区实例按恢复命名空间、空间环境、空间、主体及活动绑定；活动标题或关闭状态变化不重建它们。作品、草稿和动作各自保护与同步，调用者不拼接保存、冻结和发送步骤。

- `actions.create({requestId, receiver, objectIds?, evidence?})`：同步捕获当时问题、引用及未同步引用来源、所需作品/类型化状态和已有证据引用，再以单个 IndexedDB 事务保留完整动作。Promise 完成只表示本机可靠保留；不等于远端同步或业务接受。`objectIds` 可仅选择本次所需作品，默认固定当前作品清单。
- `actions.read(requestId)`、`snapshot/subscribe`：读取原范围的动作、固定输入、阶段及回执；当前编辑变化不修改这些输入。相同身份只接受相同输入，明确的新动作使用新 UUID，即使内容相同。生产输入区重复点击当前未结草稿沿原动作核实，不因后来作品变化重建请求。
- `actions.cancel(requestId)`：先持久协调取消。未派发动作落地取消后不再发送；已派发未知的动作只记录取消请求，核实接收方或请求其取消，不能直接承诺撤回。取消写入失败会保留本机取消意愿并阻止新派发，恢复后先补写取消。
- `actions.recover(requestId)`：把已取消或失败内容保留为独立草稿，不覆盖后来问题；`mergeRecovered` 是另一次明确合并。原动作与依据继续保留。
- `actions.acceptReceipt(requestId, receipt)`：回调入口仍查询原注册接收方或原业务 owner，验证稳定身份、范围和输入摘要；裸 JSON 不能确认业务已接受。
- `actions.suspend/resume/leave/drain`：停止原范围派发、恢复原范围协调、等待本机保护，以及排空已接收的交接。页面导航保护作品、草稿与未可靠保留的动作；常态不增加保存按钮或保存标签。

固定输入 wire 位于 [`@xunjie/contracts/action-intents`](../../packages/contracts/src/action-intents.ts)。`receiverId + location + kind` 固定接收权威和用途，不是重试时可替换的 URL。问题、引用和 typed works 的既有上限继续生效，完整 JSON 恢复包最多 400 万 UTF-16 单元；超限不冒充已经获得保护。

## 确认、派发与恢复

浏览器 `unprotected` 尚未获得可靠保护；事务提交后为 `waiting-dependencies`。所属服务完整核验并保留本次依据后，才进入 `ready`。真正交付前先持久写入 `dispatched`，其含义是已派发、结果可能未知。只有原接收方的有效回执才能变为 `accepted`；`cancelled` 和 `failed` 保留其实际依据。接收较早动作不会清理另一草稿 token、覆盖后来的输入或倒退已经确认的终态。

远端路径的固定依据通过独立登记保留，不推进作品或草稿 head，也不追随随后编辑。同步确认只是所属工作区接收内容，不是 Agent、执行或教师收据。未知先查询原请求；接收器契约要求相同身份幂等接受，以及可查询、不可复活的取消 tombstone。查询不可达就保留未知，不换身份、接收方或空间继续。

`actions.registerLocal(receiver)` 为后续 WP03 接收本机持久固定输入，不依赖远端同步。它只接纳交接，不运行实验；真实执行、当前授权与运行 grant、结果及其维护由真实执行能力负责。接收器必须绑定原范围，接受同身份重试，并在生命周期停止时停止新的交接，不把输入接纳回执冒充实验完成。

过期授权停止原范围派发；仅在原活动入口恢复授权后自动续用原身份。新命名空间只呈现服务端历史，不自动消费旧浏览器队列。`previous()` 只列出同一空间/主体/活动的旧范围；显式 `reconnect` 先核对原主体、接收能力、固定输入和原请求结果，再以原身份接回。无法核实则保留旧记录。本机旧执行交接不在此路径自动重跑。

## 所属服务与维护

学习数据 owner 的 `learning.intents.prepare/read/list/dispatch/cancel/capabilities` 对应 `/api/learning/intents/:activityId`、`/:requestId`、`/:requestId/dispatch`、`/:requestId/cancel` 和 `/capabilities`。入口认证当前主体、课程资格、绑定目标、预期主体及恢复命名空间。学校代理只允许这些窄路由并校验回包；混合部署仍把记录保存于绑定的本机学习数据 owner。

`createProductLearningApplication(context, options)` 可由真实模块注册接收器；默认没有任何接收器。`retainEvidence` 由证据 owner 验证真实记录、所属范围和指定版本，并按动作身份幂等保留。没有相应证据能力时不能把任意 ID 当作已确认依赖。本票不创建观察、教师评阅或 Agent 回复。

新增 v5 `durable-action-intents` 保存完整固定输入、输入摘要、派发/取消事实和原接收回执，资源由同一 owner 持续保留。IndexedDB 非破坏升级为 v3，新增动作分区，保留既有作品和草稿。维护关闭新派发、等待已接收交接结束；失败或无法排空不宣告安全。正式三 owner 备份/独立恢复校验意图范围、固定引用、资源原文与回执，再由 WP01 接管开放。

服务端备份不包含浏览器独有动作或未同步正文。正式 CLI 未登记 schema 升级适配时，仍应明确拒绝为 `no-schema-upgrade-registered`；本票的 owner 迁移验证不宣称该适配已经交付，也不在普通旧环境启动时暗中迁移。

## 验证入口与证据范围

```sh
node --test --test-concurrency=1 apps/server/tests/action-intents.runtime.test.mjs
node --test --test-concurrency=1 packages/product-runtime/test/hybrid-learning.runtime.test.mjs packages/product-runtime/test/learning-cli.runtime.test.mjs
XUNJIE_XJ_DEV_URL=isolated-native-product XUNJIE_E2E_BROWSER_CHANNEL=chrome npm exec -w @xunjie/web -- playwright test actionIntents.spec.ts --headed --workers=1
```

原生测试使用 Node 24.21.0、真实 PostgreSQL 18.6 和文件资源；设置 `XUNJIE_PRODUCT_POSTGRES_BIN`。完整包 CLI 验证另外设置 `XUNJIE_PRODUCT_TEST_PACKAGE` 指向实际候选包。浏览器包含生产输入区/待发呈现，以及同一公开工作区接口、真实 IndexedDB 和真实业务存储的故障补充，分别记录，不重复计数。

可控接收器仅位于测试支持，覆盖接受、可信查询、拒绝、取消竞争和丢回包；产品构建及正常分发不挂载它。正式产品未注册真实能力时发送明确不可用。工程、Chrome、测试接收器、Mac 与真实跨机、真实 Agent/教师/执行以及教学效果分别报告；后续业务由 WP03、WP07、WP12 接入。
