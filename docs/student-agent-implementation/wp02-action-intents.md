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

过期授权停止原范围派发，包括本机交接；作品、草稿或动作任一路径明确获知原空间拒绝访问，都会阻止新的本机接受。仅在原活动入口恢复授权后自动续用原身份；单纯网络不可达不会撤销已知本机交接资格。新命名空间只呈现服务端历史，不自动消费旧浏览器队列。`previous()` 只列出同一空间/主体/活动的旧范围；显式 `reconnect` 先核对原主体、接收能力、固定输入和原请求结果，再以原身份接回。旧取消意愿继续保留，并向原 owner 核实取消，不会变回可发送。无法核实则保留旧记录。本机旧执行交接不在此路径自动重跑。

浏览器停止派发不等于原接收方已撤回；另一浏览器或迟到查询证实原动作已经接受时，仍保留可信接收事实及取消意愿。已经确认的接收/取消终态不会被迟到的准备响应倒退。接收后的草稿清理先完成可靠保护，再记录清理完成；保护失败可在重开后继续，不覆盖新 token 的草稿。

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

## Windows 验收（2026-11-01）

开始于 `269d41a`，实施期间快进纳入同伴的 `c79be3b` Mac/跨机证据。固定产品提交为 `110774f8dca267b5b64057f1710db1d56908a2f8`；`72475e0` 仅更新旧迁移测试的 v3 预期和增加深色窄窗口取证，产品代码及完整包不变。[逐项工程证据](evidence/wp02-actions-windows-engineering.json)、[15 项动作 Chrome 记录](evidence/wp02-actions-windows-chrome.json)。

| 范围 | 实测结果 | 限制 |
| --- | --- | --- |
| 真实 PG / HTTP / 所属文件资源 | 原生组合 25/25，0 失败、0 跳过；其中新增动作 6 项 | 可控接收器只证明协议；不产生真实业务结论 |
| Windows 完整 full 产品包 | 正式包内 Node、PG、CLI 备份/独立恢复/接管 1/1；默认能力空、派发不可用；app/web 无测试接收器控制 | 未签名候选包，不声称净机安装或签名验收 |
| 桌面 Chrome 156.0.8078.76 | 41 个不同场景通过：动作 15、草稿 8、作品 15、部署 3 | 首轮 40/41；旧迁移用例预期 v2，保留原作品断言并更新为新增 actions 的 v3 后单项通过，未冒充一次全绿运行 |
| 新增动作页面 | 2 条生产 UI + 13 条公开接口补充，真实 IndexedDB/HTTP/PG；浅色及 420×900 深色截图目视检查 | 补充接口测试不算额外生产 UI；物理 Windows 输入法未单独评估 |
| 类型、构建、契约、文档 | `5dd741e` 全仓类型/构建及 10 个 browser-safe 导出通过；最终 Web 类型通过；当前受版本管理的 164 份非归档 Markdown、1237 个目标通过 | 全仓 verify 在文档阶段因原有未跟踪旧文件的 252 条失效链接退出 1，测试阶段未到达；保留这些无关文件 |
| 独立完整 `npm test` | `110774f` 退出 1：checks 27/0/1、product-runtime 118/1/5、storage 12/1/1、server 640/2/19（通过/失败/跳过）；Web 688/688 | 三项 Windows symlink EPERM、一项既有 LOCAL_SOCKET_CONFLICT；末尾 tools 未到达；跳过不算通过 |

完整包 `distribution.json` SHA256：`124238608ba86da9d97061f7ce13f22649b448f0438f873e6643315d05c14323`。原始日志与候选包保留在本机 `.verification/153/`，入库 JSON 记录日志摘要，不提交数据库、私有账号或浏览器 trace。[浅色页面](evidence/wp02-actions-windows-light.png)、[深色窄窗口](evidence/wp02-actions-windows-dark-narrow.png)展示旧动作接受后仍保留后来问题和作品。

Standards / Spec 两轴补审在 `110774f` 均无剩余发现。发现并以真实浏览器红绿回归修复：清理草稿先落盘后确认、IndexedDB 等待后复查暂停、旧取消接回不复活、本机交接遵守已知资格拒绝、另一浏览器迟到接受事实不被本机取消遮蔽，以及历史动作显式取消到达原 owner。旧迁移断言只随 schema 增量更新，原内容保留断言未删减。

Mac、物理 macOS 输入法及 #153 的真实跨机全部归 [#155](https://github.com/paher-din/XunJie/issues/155)，已保留原 114 项完成记录并新增 18 项待验；此前 #154 的 Mac/跨机证据不替代新增动作的验收。正式 CLI 未登记 schema 升级适配仍明确拒绝。真实 Agent、教师和执行分别由 WP07、WP12、WP03 接入；教学效果未评估。交付位于 [PR #157](https://github.com/paher-din/XunJie/pull/157)，保持开放、不合并。

## Mac 验收（2026-11-01，#155 承接）

在 Apple Silicon Mac（macOS 27.2、Apple M5、arm64、Node 24.21.0、PostgreSQL 18.6、安装版 Chrome 156.0.8078.79 有头）上以 `ba79645` 为基点执行。工程与完整包见[工程/CLI 记录](evidence/wp02-intents-mac-package-cli.json)，浏览器与物理输入法见[浏览器/输入法记录](evidence/wp02-intents-mac-browser.json)，跨机与接管见[跨机记录](evidence/wp02-intents-mac-crosshost.json)。

| 范围 | 实测结果 | 限制 |
| --- | --- | --- |
| 类型、构建、契约、文档 | `typecheck`、`build`、`check:contracts:browser`（10 个导出）、`check:docs`（165 文件 / 1240 目标 / 0 失败）全部通过 | 首次 `build` 被本机安全删除外挂拦截 `apps/server/dist`（444 文件 > 50 阈值），对该次构建放行后通过，非产品缺陷 |
| `action-intents.runtime` | 6/6 通过、0 跳过（固定输入、丢回包原身份、取消竞争、越权、维护排空与恢复、v4→v5 迁移） | 可控接收器只证明协议，不产生真实业务结论 |
| 回归原生组合 | 12/12 通过、0 跳过（身份入口、混合 owner、作品、CLI、排空） | — |
| darwin-arm64 完整包 | `sha256 0a8dc6a6…`（131,411,109 字节），`resourceCatalogSha256 9d64fbd2…`；包内无测试接收器；默认 capabilities 为空、派发 503 `unavailable` | 未签名候选包 |
| 正式 CLI 备份/恢复/接管 | 三 owner 备份 10 工件；held 备份 `ee0b3a72…` → 独立空目标恢复 `isolated`（公开业务 503 `maintenance`）→ 接管 `active`（新 installation `0060200c…`、新 namespace `…recovery.8564aa8a…`）；作品 objectId/contentId/字节（BOM/CRLF/emoji）、草稿问题、prepared 与 cancelled 意图全部一致；旧 namespace 403、当前 200；源 `start` 报 `source-retired`；`upgrade` 报 `no-schema-upgrade-registered` | 未登记 schema 适配仍按预期拒绝，不冒充已交付升级 |
| `actionIntents.spec.ts` | 15/15 通过（2 条生产 UI + 13 条公开接口补充），真实 IndexedDB/HTTP/PG | 补充接口不算额外生产 UI |
| 三条回归 | 26/26 通过（`questionDrafts` 8、`worksEditor` 15、`hybridDeployment` 3） | — |
| 物理 macOS 中文输入法 | 自建注入器经 `CGEventPost(.cghidEventTap)` 输入「你的问题」与真实 Monaco：30 次 keydown 中 27 次 `keyCode=229`、4 次 `compositionstart`、27 次 `compositionupdate`；问题精确为 `开始你好世界\n结束`、作品为 `你好\n结束`；`Cmd+←/→` 后正文不变；**全程 0 次派发、0 条意图** | 不产生教学效果结论 |
| Mac 客户端 + 独立学校 Linux | 学校页批准、`connect`、`learning-binding` 全部成功；混合空间作品字节/草稿问题/prepared 与 cancelled 意图齐全；学校空间直读 403/404（无第二份）；真实停学校后读取 503，恢复后原 ID 与原状态一致 | — |
| 分机备份/独立恢复/SSH fencing 接管 | 见下方「接管后读取：修复与重跑」——修复后该项通过 | 首轮未通过，修复后重跑通过 |
| 接管后读取（修复后重跑 `dd47494`） | 客户端 held 备份 `797661b2…`（9 工件，receiver 声明学校 `1adf830b…/d9c5fbf6…`）→ 独立空目标恢复 `isolated`（新 namespace `…recovery.ba7e9cbc…`）→ 带 SSH fencing 的 `takeover` 返回 `phase=active`，目标运行库 **`ready`**；在目标上重读作品字节（BOM/CRLF/emoji）、草稿问题、prepared 未结意图 `86bca7ff…` 与 cancelled 意图 `503448e1…` 全部与播种一致；旧 namespace 403、当前 200、不存在 namespace 403；被退休 installation `572ac321…` 的 grant 在学校返回 **401**、源 `start` 报 `source-retired`；同环境新 installation `3f7fa3c1…` 重新授权后握手成功、依赖 `client:d9c5fbf6…` 回到 `ready`（学校自身始终 `ready`） | 未运行真实 Agent/教师接收器，派发仍 503 `unavailable`：只证明「未派发事实可恢复」，不宣称远端接受 |

本轮未执行并如实标注：Windows 物理输入法、真实 WP03/WP07/WP12 业务（不宣称）。

### Windows 11 x64 设备侧补做（2026-11-01）

`ba79645` 轮只覆盖了混合部署的三条业务路径，未跑生产待发区。本轮在真实 Windows 主机（Windows 11 家庭版 26200 / Intel Core Ultra 9 285H / AMD64，包内 Node 24.21.0 + PostgreSQL 18.6，已安装 Chrome 156.0.8078.79）安装 win32-x64 完整包（`sha256 64a885c9…`，86,446,519 字节）并以分离进程启动，用 `playwright-core` 驱动**已安装 Chrome**打开生产页面，18 项断言全部通过、0 失败。

| 范围 | 实测 |
| --- | --- |
| 发送可用性 | 无正式接收器时按钮为「发送问题（尚未接入）」且 `disabled`，提示「真实 Agent 尚未接入；问题与引用会自动保存在原工作区，暂不能发送。」；页面**不出现**任何待发记录（0 条） |
| 草稿持久 | 界面输入后经公开接口读回问题一致 |
| 待发呈现 | 经公开接口 prepare 后由生产组件渲染：阶段「等待接收方」、固定问题原文、展开「查看这次固定内容」可见固定作品 `int v = 1;` |
| 不饥饿 | 之后继续编辑问题并刷新，固定输入仍为派发时的原文、记录仍为 1 条、草稿保留新文本 |
| 不伪装 | 派发返回 503 `unavailable`，服务端状态保持 `prepared` |
| 取消 | 经生产按钮取消后组件转「已取消」并给出「恢复为独立草稿」，服务端状态 `cancelled`；该断言只覆盖**尚未送达接收方**的动作。已登记到远端的动作按 #157 审查 R5 修正为：先落取消意图并显示「已记录取消请求，正在核实接收方状态」，接收方确认后才转「已取消」，权威已 `accepted` 时显示「接收方已接受」而不是「已取消」 |

Windows 侧待发条目由公开接口 prepare 后由生产组件渲染，而不是用测试接收器伪造「已发出/已接受」——正式包内没有业务接收器，这一限制如实保留。证据见[Windows 待发呈现记录](evidence/wp02-intents-win-action-ui.json)与三张截图。

**未覆盖**：Windows 物理键盘级中文输入法；真实 Agent/教师/执行接收器（WP07/WP12/WP03）。

**已按 #157 审查修复的原观察**：原先「远端视图仅在本机缺该条目时导入，经接口在页面外取消不会被已打开页面反映」（R7），现改为本地已有条目也会按原请求摘要采纳权威事实（不自动派发、不复活本地取消）；连同 R5（取消未核实前不报成功）与 R8（本机交接不等无关远端取消核实）一起，回归见 `apps/web/e2e/reliableWorkspaceActions.spec.ts`。

### 接管后读取：修复与重跑

首轮在 `ba79645` 上观察到接管目标 `failed`。诊断确认是产品缺陷而非验收搭错，最小复现不需要 SSH（三个本机 root 即可稳定重现），根因是一条三处相连的链：

1. `host.ts` 把 `installation.json.connections` 的目标当作备份接收器，同一份数据又生成运行库必需依赖；
2. `recovery.ts` 的 `takeover` 对每个接收器执行 fence，而 `connections.ts` 的 `ConnectionSource` 只有 environment 与 service，没有 installation；
3. 接管目标按规定复用同一 environment/service、只换 installationId，因此被自己的接管作废了 grant，必需依赖随即 `unavailable`。

这也与 `specs/wp01-product-runtime-and-data.md`「使接收方拒绝**旧实例**的新请求」不符：实现退化成拒绝整个 source service 身份。修复 `dd47494`：

- `ConnectionSource` 保留可选 `sourceInstallationId`（供 fence 输入与读取旧数据），而 `ConnectionAuthorization` 将其定为必填；`authorize` 始终把安装 ID 与 installation 代际写进 grant，与 scope 代际并存，缺失或非法 UUID 抛 `invalid_authorization`；
- `fenceSource` 带 installation 时只提升该实例代际，不带时仍提升整个 scope（保持既有语义）；按安装 fence 还会在同一 scope 锁内删除同一环境/服务下**没有**安装 ID 的旧 grant——它无法归属到任何实例，任何后续 fence 都够不到它，只能安全撤销；
- 本地与 SSH 接收器都传被退休的 installationId，SSH 回执必须回显它；
- 接管成功后移除刚被作废的连接，并把 `connectionId` 记入 `recovery-state.json` 的 `fencedConnections`，使目标状态反映真实情况。

后续审查（PR #157 R1）发现仅提升 installation 代际仍留下漏洞：正式 `authorize` 允许不带安装 ID，这种 grant 只校验 scope 代际，于是接管使用的按安装 fence 对它无效，fence 后仍能执行写 handler。上述“必填安装 ID + 按安装 fence 撤销无归属旧 grant”即该缺陷的修复；回归见 `packages/product-runtime/test/connections-installation.test.mjs`。

回归测试 `recovery-connections.test.mjs`：旧实例 `http_401`、后继实例无悬空依赖且 `ready`、后继重新授权后依赖恢复而旧实例仍被拒。`product-runtime` 全量 125 项（123 通过 / 2 跳过 / 0 失败）与全仓 `typecheck` 通过。修复后证据见[接管重跑记录](evidence/wp02-intents-mac-fencing-takeover.json)。
