# WP07 #198 旧入口替换与保留消费者

本记录只覆盖 [#198：Agent 读取作品、调用课程工具并解释结果](https://github.com/paher-din/XunJie/issues/198) 的普通 Web 入口替换和旧消费者盘点。工具、RunDriver、执行和活动对话由本票其他实现负责，本记录不替代完整验收。[Web 入口说明](../../apps/web/README.md#正式产品入口与后续-wp) 是运行入口。

## 正式入口

- [main.tsx](../../apps/web/src/main.tsx) 的普通 Web 默认页、`#/`、`#/agent` 与 `#/agent/:conversationId` 均装配现有 [LearningApp](../../apps/web/src/product/LearningApp.tsx)，非 prep 开发模式同样如此。独立产品 [runtime/main.tsx](../../apps/web/src/runtime/main.tsx) 原本已装配同一应用，无需改动。
- 活动仍由外层 `?space=<key>&activity=<id>` 定位；不带活动参数的 Agent 链接显示现有首页，学生从活动卡或学习目标进入现有工作区。没有新增简化聊天页、导航或工作区。
- 在已挂载的 [LegacyApp](../../apps/web/src/LegacyApp.tsx) 内导航到 `agent/*` 时，由不包在旧 `SessionEntry` / `AppShell` 内的入口清除 hash，通过 `location.replace` 返回同源页面，保留 pathname 和外层查询参数。退出旧 hash router 后才挂载正式 browser router，避免嵌套 router 和重复工作区。
- 旧个人聊天 ID 不等于活动 ID，不转换、不重新提交旧问题，也不迁写历史。正式活动读取失败由原学习空间处理，不触发旧个人聊天或 `student_help` 请求。路由替换不提供旧聊天历史浏览功能。
- 只有 `PREP_BUILD`（显式 `dev:prep`）注册旧 `AgentPage` 路由和懒加载模块。演示与真实宿主不互相回退。

正式发送消费 [ActivityConversation](../../apps/web/src/product/ActivityConversation.tsx) 与可靠活动动作，读取 `/api/learning/agent/<activityId>/conversation`，停止和继续也走相同 owner；正式问题不经过旧 `useAgentTurn`、`RealAgentApi` 或 `TutoringWorkspace`。没有向 `student_help` 的降级或双写分支。

## 仍在使用的旧消费者

以下归属是移除条件与责任边界，不表示相关票已交付。当前代码核对日期为 2026-11-06。

| 消费者 / 精确入口 | 当前依赖与保留理由 | 迁移归属 / 移除条件 |
| --- | --- | --- |
| 普通 Web `#/task/:taskId` → [TaskRoute](../../apps/web/src/pages/TaskRoute.tsx) → [PrepWorkspacePage](../../apps/web/src/pages/PrepWorkspacePage.tsx)，真实 assignment 也使用该页面 | `useTutoringWorkspace` → `TutoringWorkspace` → `POST /api/attempts/:id/help`；读取 attempt events、teaching-records、Job、取消和动作展示回执。不是只有名称中的 prep 演示消费者，不能删除。 | 通用正式活动问答由 #198 接入同一活动对话；旧课程任务仍留在兼容路径，待对应课程转入正式活动后再退役其辅导循环。ALU 具体接入归 WP04 与 #202，不能由通用工具票提前替代。 |
| 上述任务页的 `isHdl` 分支，`useHdlWorkspace`、`createTutorHdlCurrent`、HDL 选区与固定运行结果 | 使用同一 tutoring 对象、历史、来源、停止与回执校验，并关联既有 HDL 执行；需要与旧任务页共同保留。 | WP04 #192 / #193 / #194 交付正式编辑、观察、检查与波形后，由 [#202：ALU 的真实 Agent 辅导](https://github.com/paher-din/XunJie/issues/202) 对接获准工具并替换旧求助。 |
| [TutoringPane](../../apps/web/src/components/workspace/TutoringPane.tsx)、`TutoringControls`、`TutoringExample`、`tutorTranscript` 与 `workspace/tutoring*` | 原任务页仍使用的消息呈现、控制、教学对象、IndexedDB ledger、原命令核对、历史回取与 HDL 校验。不能仅因正式 Agent 不再引用它们就删共享接口。 | 跟随上述最后一个真实课程消费者迁移；#198 只切断正式新入口的依赖。准备演示另行保留。 |
| 教师 `#/teacher/review` → [LiveReviewPage](../../apps/web/src/teacher/LiveReviewPage.tsx) 与 [wire.ts](../../apps/web/src/teacher/wire.ts) | 从 review context 的 `help.messages/actions` 读取 `student_help` envelope，校验正文/hash，回取原消息、动作展示回执及引用结果。它是历史证据消费者，不是新 Agent 发送器。 | WP12 教师交付与反馈负责消费新活动对话投影并维护旧证据回取，WP11 提供允许共享的学习证据；#198 不迁教师事实或删除历史契约。当前未指定单独退役票，按[实施总览](student-agent-implementation-overview.md)保留归属。 |
| 服务端 [tutoring/application.ts](../../apps/server/server/tutoring/application.ts) 与 [original-teaching-host.ts](../../apps/server/server/app/original-teaching-host.ts) | 前者仍注册 `/api/attempts/:id/help`，关联 `student_help.create` 和教学历史；后者仍扫描持久 `student_help` Jobs 并处理旧工作的停止/恢复。 | 归旧课程消费者的迁移与宿主维护；最后一个真实调用者迁移且已有 Job、回执及历史有明确保留路径后才退役，不能在 #198 路由调整中直接删除。 |
| [digital-logic.ts](../../apps/server/server/app/digital-logic.ts) 的成员资格撤销处理 | 撤销时停止 `student_run` / `student_help` 与 HDL 原执行；删除 purpose 或取消接口会留下旧工作。 | WP04 / #202 的 ALU 迁移和旧宿主退役共同核对，旧工作清理前保留。 |
| 旧任务 / 设置外壳 [AppShell](../../apps/web/src/components/AppShell.tsx) → [bridge/agentApi.ts](../../apps/web/src/bridge/agentApi.ts) | 仍读取旧 `/api/agent/conversations` 列表并提供改名、删除、置顶、归档等管理操作；链接到旧 conversation ID 时只返回正式学习空间，不挂载旧发送器。 | #198 已替换正式 Agent 页面与发送入口。旧外壳的会话管理及旧个人历史迁移随该外壳退役处理；本次写集不含 AppShell，不宣称旧聊天 API 已全部无消费者。 |
| 旧个人模型与教师模型：[SettingsPage](../../apps/web/src/pages/SettingsPage.tsx)、`LegacyModelTab`、教师设置及 [personal-models.ts](../../apps/server/server/app/personal-models.ts) | 旧模型配置服务、兼容传输、预算与教师设计调用仍复用 `personal-agent` 模块；保留代码不表示正式 Agent 继续使用旧会话推进。 | WP06 新正式模型 owner 已有独立配置；旧设置迁移归模型配置 owner，教师设计迁移归 WP10 教师组件库与课程发布，直到最后消费者迁移前不整目录删除。 |
| `dev:prep` 的 [AgentPage](../../apps/web/src/pages/AgentPage.tsx)、`useAgentTurn`、HomePage 及 mock bridge | 保留已确认 UI 的显式演示与旧模块回归参考；生产 Agent 路由不加载此页面。 | 明确保留的演示资产，无本票删除要求；历史个人聊天 e2e 不能当作新正式 Agent 验收。 |

票号核对：[#199](https://github.com/paher-din/XunJie/issues/199) 是“Agent 提问与学生明确回应”（`student.ask` / Wait），不是 ALU 集成票；ALU 真实辅导是 #202，前置 WP04 #192 / #193 / #194。此处按当前 issue 和[实施子票索引](specs/README.md#wp07-实施子票)记录，避免把保留消费者误分给 #199。

## 本写集验证边界

检查范围是路由分流、非 prep 的旧发送器隔离、prep 演示保留、旧路由站内跳转和空间/活动查询参数保留，以及 Web 无产物类型检查。没有修改 `product/*` 或执行构建；完整工程、真实工具、真实模型与跨平台 Chrome 验收由 #198 主交付合并报告。教学效果不在路由检查中推定。

已完成：

- 使用 Web 工程本地 TypeScript 执行 `node apps/web/node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit`，通过。
- 将两个路由模块内存转译后，以隔离的 React/router 装配替身执行 36 项断言，通过：生产与非 prep 开发入口分流、保留教师/任务/设置路径、非 prep 不注册或懒加载旧 AgentPage、prep 保留两种 Agent 路由、站内跳转保留原 `space` / `activity`。这是路由装配检查，不是浏览器或真实业务验收；检查程序未写入仓库。
- `node scripts/check-doc-links.mjs` 与本写集 `git diff --check` 通过。按规范与任务范围人工复核本写集，没有发现需修正项；并行审查工具不可用，未声称完成双子代理审查。

未执行：构建、完整测试套件、桌面 Chrome、真实模型/执行与跨平台验收；本独立任务不启动构建，不提交代码，交由主任务完成整体验证与交付。
