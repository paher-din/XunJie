# 首页、对话、看板覆盖与续迁清单

范围：本批负责的旧 `apps/web/src/components/{home,chat,dashboard}`、附件瓦片，以及 `HomePage`／`AgentPage` 中相关视觉单元。下表按实际实现落点记录，不以导出数量代表完整度。

**已迁展示**：正式包内有展示与局部交互实现，不反向引用旧 Web；仍需要真实展示数据和正式样式入口。**未完成**：原功能仍需旧适配器、运行宿主或页面编排。具名导出、兼容 re-export、页面容器和插槽本身均不算完成迁移。组件目录提供本地数据的 Chrome 实屏示例，不代表真实服务验收。

## 首页

旧路径以 `apps/web/src/` 为根；正式名称从 `@xunjie/ui/home` 导入。

| 旧组件／视觉单元 | 正式名称 | 状态／剩余边界 |
| --- | --- | --- |
| `components/home/HomePrimitives.tsx: TaskToolbar` | `TaskToolbar` | 已迁展示；保留受控筛选、清除焦点 |
| 同文件 `ContinueTaskCard`；首页两处 `.db-continue` | `ContinueTaskCard` | 已迁展示；真实说明／演示百分比由页面提供 |
| `components/home/LearningCards.tsx: CourseTiles` | `CourseTiles` | 已迁展示；含卡组 hover |
| 同文件 `CourseTile` | `CourseTile` | 已迁展示；含封面、标题、摘要、入口 |
| 同文件 `LearningTaskCard` | `LearningTaskCard` | 已迁展示；状态、进度等内容由调用方提供 |
| 同文件 `LearningCardGrid` | `LearningCardGrid` | 已迁展示；含网格与高亮注册 |
| `pages/HomePage.tsx: CourseTiles` 领域包装 | `CourseTiles` | 展示已迁；旧任务计数／摘要适配仍在页面，**业务替代未完成**，不把旧包装计为正式组件 |
| 同页面 `TaskCards` | `LearningCardGrid` + `HomeTaskCard` | 网格与完整任务卡展示已迁、原页面已消费；**业务替代未完成**：任务循环和进度／逾期计算保留页面 |
| 同页面 `TaskCard` | `HomeTaskCard` | 卡壳、状态／逾期徽标、进度标签与进度条已迁；旧包装只适配任务字段、格式化截止日期和决定动作，**业务替代未完成** |
| 同页面 `.intro` 问候与日期 | `HomeIntro` | 展示已迁并消费；问候、姓名与日期事实由页面提供 |
| 同页面 `.sectionhead` 标题、数量、刷新 | `HomeSectionHeading` | 展示已迁并消费；保留 heading ref、刷新禁用及回调 |
| 同页面 `.course-breadcrumb` | `CourseBreadcrumb` | 展示及键盘来源判定已迁并消费；课程定位由页面回调执行 |
| 同页面课程／任务加载、失败重试、空结果区 | `HomeStatus` | 展示已迁并消费；加载／失败／空态分支仍由真实查询结果决定 |
| 同页面 `.prep-entry` 准备工作区入口 | `PreparationEntryCard` | 展示已迁并消费；旧准备模式文案和导航只由页面注入 |
| `HomePage`、`RealHomePage`、`PreparationHomePage` | — | **未完成**：查询、Session、筛选、推荐、路由与页面装配；页面导出不算解耦 |

## 对话

除附件外，旧组件均位于 `apps/web/src/components/chat/`；正式名称从 `@xunjie/ui/chat` 导入。

| 旧文件／部件 | 正式名称 | 状态／剩余边界 |
| --- | --- | --- |
| `AgentMessage.tsx: AgentMessage` | `AgentMessage` | 已迁相位展示；**完整旧功能未完成**：生成卡 renderer、记录事实及旧失败策略仍由旧适配器注入 |
| 同文件 `WaitTail` | `WaitTail` | 已迁展示与等待计时 |
| 同文件 `ThinkTail` | `ThinkTail` | 已迁展示与思考计时 |
| 同文件 `ThinkingSettled` | `ThinkingSettled` | 已迁展示与摘要展开 |
| 同文件 `ConceptBlock` | `ConceptBlock` | 已迁展示、pin 状态和 portal；持久收纳由回调执行 |
| 同文件 `StopLine` | `StopLine` | 已迁展示；继续／重试由回调执行 |
| 同文件 `FailureCard` | `FailureCard` | 已迁展示与折叠；**旧额度策略替代未完成**，旧适配器仍提供原规则 |
| 同文件 `ActionBar` | `ActionBar` | 已迁复制反馈、时间戳及重试入口 |
| `UserMessage.tsx: UserMessage` | `UserMessage` | 已迁气泡、图片、复制与原位编辑；消息写回由回调执行 |
| `MessageTaskCard.tsx: MessageTaskCard` | `MessageTaskCard` | 已迁任务卡展示；事实与导航由调用方提供 |
| `ConceptCard.tsx: ConceptCard` | `ConceptCard` | 已迁阶段展示、折叠及收纳入口 |
| 同文件 `Waveform` | `Waveform` | 已迁波形、标注与所需纯 helper |
| `QuizCard.tsx: QuizCard` | `QuizCard` | 已迁单选、判定和重答；**画像记录接入未完成**，旧适配器仍提供原记录文案 |
| `StepsBlock.tsx: StepsBlock` | `StepsBlock` | 已迁步骤展示与折叠 |
| `TaskPicker.tsx: TaskPicker` | `TaskPicker` | 已迁分组／排序展示、选择、取消与 Escape |
| `TurnAriaStatus.tsx: TurnAriaStatus` | `TurnAriaStatus` | 已迁原状态播报 |
| `MessageRail.tsx: MessageRail` | `MessageRail` | 已迁导轨与预览；仍要求 `.chat-message/.turn-body/.bubble` DOM 契约，跳转由调用方执行 |
| `Markdown.tsx: Markdown` | `Markdown` | 已迁完整正文渲染与流式修复 |
| 同文件 `Block` | `Block` | 已迁块渲染，保留 memo 比较 |
| 同文件 `CodeBlock` | `CodeBlock` | 已迁代码块与复制 |
| 同文件 `ListBlock` | `ListBlock` | 已迁列表与尾部呈现 |
| 同文件 `TableBlock` | `TableBlock` | 已迁表格、复制与增长跟随 |
| 同文件 `Inline` | `Inline` | 已迁行内 token 渲染 |
| 同文件 `Chars` | `Chars` | 已迁逐字展示 |
| `GenCard.tsx: GenCard` | `GenCard` | 已迁卡壳、占位与分流；**可运行生成卡未完成**，需宿主提供 `createHost` |
| 同文件 `GenFailCard` | `GenFailCard` | 已迁失败展示、折叠与重试入口 |
| 同文件 `GenLiveCard` | `GenLiveCard` | 已迁装载／错误／重试／快照 UI 状态；**协议宿主未完成**，旧入口仍用 `bridge/genSandbox.ts` |
| `apps/web/src/ui/chat/AttachmentTile.tsx` | `AttachmentTile` | 已迁完整瓦片；新正式 `PromptInput` 直接消费正式瓦片，旧输入框也经适配器消费此链。旧 ui 文件是否删除／重导出由主 agent 负责，不在本写集 |

页面内的剩余视觉单元不能以 `AgentMessage` 的 `children` 或生成内容 renderer 概括为已完成：

| 旧 `apps/web/src/` 单元 | 正式映射 | 状态／下一步 |
| --- | --- | --- |
| `pages/AgentPage.tsx: AssignedTaskEntryCard` | `MessageTaskCard` 仅覆盖展示 | **未完成**：旧领域事实适配、未知完成状态与路由仍在页面 |
| 同页面 `TaskEntryCard` | `MessageTaskCard` 仅覆盖展示 | **未完成**：进度、阶段、期限及路由仍在页面 |
| 同页面 `.chat-empty` 两类空态 | `AgentEmptyState` | 展示已迁并消费；首次使用判断与相应文案由页面提供 |
| 同页面 `.chat-viewport/.chat-wrap/.chat-inner` | `ChatViewport` | 视口、导轨、ARIA、ref 与留白 class 已迁并消费；**行为控制替代未完成**：旧页仍负责滚动释放／吸附、跳转与会话切换 |
| 同页面 `.chat-composer/.composer-anchor` | `ChatComposerDock` | 底部结构、away class、建议／追问及输入位置已迁并消费；显隐布尔值与回调由页面提供，input 槽只放正式输入控件的旧业务适配器，不代表整页迁移 |
| 同页面 `.back-bottom` | `BackToBottom` | 按钮已迁并由 `ChatComposerDock` 消费；回底／吸附控制保留页面 |
| 同页面 `.queue-tip` 及排队发送入口 | `QueueNotice` | 展示已迁并由 `ChatComposerDock` 消费；排队状态、文案和发送命令由旧回合控制器提供，**业务替代未完成** |
| 同页面错误提示、`.chat-disclaimer`、token 用量 | `ChatError`、`ChatComposerDock` | 展示已迁并消费；错误优先级、来源声明和用量事实在页面决定 |
| `components/PromptInput.tsx` 输入主体、附件区、模型／强度菜单 | `PromptInput` | 完整 UI 已迁、旧组件已实际消费；模型 store、文件资源和发送接纳仍在旧适配器，**新业务替代未完成**，详见下表 |
| `components/chat/useAgentTurn.ts`、`pages/AgentPage.tsx` | — | **未完成**：回合、恢复、网络、Session、缓存、导航及页面装配没有迁入 |

## 看板

旧路径为 `apps/web/src/components/dashboard/`；正式名称从 `@xunjie/ui/dashboard` 导入。

| 旧文件／部件 | 正式名称 | 状态／剩余边界 |
| --- | --- | --- |
| `DashboardSection.tsx: DashboardSection` | `DashboardSection` | 已迁标题、网格、编辑、托盘、提示及受控布局；**持久化替代未完成**：旧适配器仍读写布局、校验回退、注入来源文案；`continueSlot` 不算已迁继续任务内容 |
| `widgets.tsx: EmptyWidget` | `EmptyWidget` | 已迁空态 |
| 同文件 `HeatWidget` | `HeatWidget` | 已迁日／周切换与数据展示 |
| 同文件 `HeatDaily` | `HeatDaily` | 已迁每日图、尺寸测量与提示 |
| 同文件 `HeatWeekly` | `HeatWeekly` | 已迁每周图与提示 |
| 同文件 `TaskProgressWidget` | `TaskProgressWidget` | 已迁完成率及已知零／未知数据差异 |
| 同文件 `MosaicWidget` | `MosaicWidget` | 已迁构成比例和时长展示 |
| 同文件 `BadgesWidget` | `BadgesWidget` | 已迁徽章与解锁状态 |
| 同文件 `RadarWidget` | `RadarWidget` | 已迁雷达图 |
| 同文件 `TimelineWidget` | `TimelineWidget` | 已迁里程碑时间线 |
| 同文件 `PunchWidget` | `PunchWidget` | 已迁周节奏矩阵 |
| 同文件 `TrendWidget` | `TrendWidget` | 已迁时长趋势 |
| 同文件 `RingWidget` | `RingWidget` | 已迁任务完成环 |
| 同文件 `StreakWidget` | `StreakWidget` | 已迁连续学习展示与日期计算 |
| 同文件 `MasteryWidget` | `MasteryWidget` | 已迁知识点掌握度 |
| 同文件 `XpWidget` | `XpWidget` | 已迁等级／经验展示，缺数据不补模拟值 |
| 同文件 `Bars7Widget` | `Bars7Widget` | 已迁近七日柱状 |

## 第二批输入框与页面视觉明细

| 旧视觉／交互单元 | 正式落点与输入边界 | 状态 |
| --- | --- | --- |
| PromptInput form、textarea、工具行、发送／停止 | `PromptInput`：`value/onChange/onSend/canSend/submitting/busy/onStop` | 已迁；保留 Enter、Shift+Enter、IME、禁用和自动焦点 |
| 模型按钮／列表／键盘选择／选中标志 | `PromptModelPicker`，由 `PromptInput` 及正式对话输入区共用；`PromptModelOption` | 已迁；正式包没有模拟供应商数据 |
| 思考强度按钮／菜单 | `PromptInput`：`effort/efforts/onEffortChange/effortDisabled` | 已迁；选项与当前值受控，不读取 store |
| 模型／强度 swap 动画和 140ms 互斥退场 | `PromptInput` 内部展示状态 | 已迁；保留外部点击、Escape 与退场中重开 |
| textarea 增高／收缩及附件区测量 | `PromptInput` 内部测量状态 | 已迁；保留 200px 上限、原 transition 写法和 ResizeObserver |
| 附件区／排队可见性／280ms 脱流退场 | `PromptInput` + `AttachmentTile`，`attachments/onRemoveAttachment` | 已迁；动画完成后通知宿主删除 |
| 文件选择／拖拽反馈 | `PromptInput`：`accept/attachmentTitle/onAddFiles` | UI 已迁；只回传 File，不读取、上传或创建 URL |
| 上下文指示与模型状态提示 | `PromptInput`：`contextIndicator/status` | 位置与状态 span 已迁；容量、文案与 role 由宿主提供，不是输入主体占位槽 |
| 模型持久化／跨页同步、文件 URL 管理、准备模式进度、异步发送接纳 | 旧 `components/PromptInput.tsx` 适配器 | **未完成业务迁移**；保持原 store、原处理流程及 false 接纳时保留附件的行为 |
| `.course-region` 定位结构 | `HomeCourseRegion` | 已迁并消费，原 region ref 与选中属性保留 |
| Home／Agent 页面最外层根节点、查询、路由、会话与任务映射 | 原页面容器 | **未完成业务迁移**；保留最外层布局节点不计为独立正式组件；没有用整页 children 替代抽取 |

### 第二批验证

- 新增 11 条测试：正式输入框 5 条、对话单元 3 条、首页单元 2 条、旧输入适配器接纳／资源生命周期 1 条；均通过。与上一批相关回归合计 11 个测试文件、60 条测试全部通过。
- 首页／对话正式入口与新增包内测试的独立 TypeScript 检查通过。
- 最终全 Web TypeScript 检查通过（零诊断）；首页／对话入口浏览器打包通过，传递依赖图不含 apps/web 文件，未输出临时产物。
- 该批次未运行浏览器视觉验收或真实模型／上传服务验收；后续已补充组件目录的 Chrome 实屏检查，真实服务接线仍未由目录验证。

## 依赖与交接边界

- 本批纯 helper／展示 hook 已迁：`useFluidHover`、`useRegisterFluidHoverItem`、`pickNearest`、`useSmoothStreamText`、`useFollowBottom`、`formatMessageTime`、`insertIndex`；不计为额外视觉组件。
- `@xunjie/ui/foundation`、`brand`、`icons` 及 `styles.css` 由主 agent 负责。本表不把这些依赖或旧兼容入口重复计为本批完成项。
- `AppShell` 的会话历史属主 agent 写集；已发现正式 `ConversationRow/ConversationGroup/ArchivedConversationRow/ConversationSentinel/ConversationPaneSwap`，但这不等于完整历史面板已解耦。本表不替该区域宣称完成，需其负责人继续核对搜索、归档、分页、菜单与 API 装配。
- 本批验证见下节；通过局部编译和交互检查不等于页面业务控制器、旧运行宿主或浏览器视觉验收通过。
