# 旧版工作区迁移覆盖

正式入口为 `@xunjie/ui/workspace`（[index.ts](index.ts)）。旧源下表默认相对 `apps/web/src/components/workspace/`；页面路径相对仓库根目录。

**完成**仅表示实现及所需组件样式已进入正式包，不再导入旧应用代码或领域类型；宿主须加载唯一正式共享样式入口 `@xunjie/ui/styles.css`，并提供相应浏览器能力。旧路径的兼容 re-export 不构成额外迁移成果。**未完成**项须继续迁移，具名导出、页面容器和整页／整块内容插槽均不等于已解耦。

## 已迁入的受控展示与交互

| 旧源／视觉单元 | 正式名称 | 状态与边界 |
| --- | --- | --- |
| `TaskPresentation.tsx`：进度环、状态文字 | `TaskProgress` | 完成；百分比、完成态、文案由调用方提供，多实例 gradient ID 独立。 |
| `TaskPresentation.tsx`：任务标题、目标、进度、事实列表 | `TaskInfo` | 完成；状态节点、格式化字段及可选演示说明由调用方提供，不包含页面业务适配器。 |
| `FileTabs.tsx`：文件标签、激活与关闭按钮 | `FileTabs` | 完成；文件身份、生命周期及打开／关闭操作归调用方。 |
| `ConfirmationCluster.tsx`：确认状态、保存／冻结／恢复操作 | `ConfirmationCluster` | 完成；权限、原请求重试与命令执行归调用方。 |
| `WorkspacePopover.tsx`：浮层、Portal、定位、焦点与键盘关闭 | `WorkspacePopover` | 完成；保留非模态交互，内容由调用方提供。 |
| `RunPanel.tsx`：顶栏运行入口 | `CoreRunEntry` | 完成。 |
| `RunPanel.tsx`：快照／输入选择、参数、结果与求助入口 | `RunPanel` | 完成；公开展示数据及回调，不执行运行或校验业务归属。 |
| `RunHistoryPanel.tsx`：双列历史选择、诊断、产物与下载入口 | `RunHistoryPanel` | 完成；历史读取、下载及身份校验归调用方。 |
| `SideDock.tsx`：胶囊、弹出壳、收纳行与动画 | `SideDock` | 完成；`taskInfo` 插槽不代表其中任务详情／辅导控制已迁入，卡片内容与持久化亦未迁入。 |

上述组件公开 props／展示数据类型；`RunHelpTarget` 定义在包内。共享规则统一来自 `@xunjie/ui/styles.css`（完整现役 app.css、tokens、字体和 icons），不维护 app.css 的工作区摘录副本。原本独立的 `RunPanel.css`、`RunHistoryPanel.css`、`WorkspaceToolbar.css` 随组件保留在本目录并由组件导入；旧 TSX 路径仅兼容重导出。

## 核心工具、代码与比较（第二批）

本批将实际视觉实现、编辑器运行时及必要纯 helper 迁入正式包。旧 `CenterToolArea` 和 `CodeWorkspace` 仅保留领域／存储适配，不计为独立正式组件；这些适配的移除仍未完成。

| 旧源／视觉单元 | 正式名称 | 状态／仍需处理 |
| --- | --- | --- |
| `CenterToolArea.tsx`：分屏树、拖放、标签与 Portal | `CenterToolArea`、`Divider`、`ToolTabs` | 视觉完成；正式组件受控接收 `layout/onLayoutChange`，没有存储。旧适配器仍处理布局持久化、切换前保护及生成卡内容，适配器未迁移。 |
| 同文件：七段管、静态代码／波形、演示板及模拟运行簇 | `Seg7`、`EditorPane`、`WavePane`、`BoardPane`、`DigitalLogicRunCluster` | 完成；保留数字逻辑演示语义。真实 HDL 缺结果时不回退演示或零信号。 |
| `CodeWorkspace.tsx`：代码区、状态行、草稿保护、运行簇 | `CodeWorkspace`、`StatusBar`、`ProtectionChip`、`CodeRunCluster` | 视觉完成；正式组件消费 `CodeWorkspaceDisplay` 和回调。旧适配器仍投影 `ProjectWorkspace`、生命周期限制及草稿，存储和命令未迁移。 |
| `CodeEditorHost.tsx`、`monacoSetup.ts`、`compositionNavigation.ts` | `CodeEditorHost`、`loadMonaco`、`protectCompositionNavigation` | 实现完成；仅包内持有模型注册表／原文历史，保持 `workspaceKey + fileId`、URI、撤销与输入法导航。Monaco 依赖已由主 agent 声明。 |
| `FileStrip.tsx`：文件菜单／行、回收恢复、新建与待处理标识 | `FileStrip` | 完成；公开 `WorkspaceFile`／props，动作交回调用方；实际文件／草稿生命周期控制仍在旧应用。 |
| `CompareText.tsx`：只读双栏／单栏正文 | `CompareDiff`、`CompareReadOnly` | 实现完成；临时匿名模型独立创建／销毁，不进入编辑模型注册表；同样需要 Monaco 依赖。 |
| `ConflictCompare.tsx`：冲突说明、文件与选择按钮 | `ConflictCompare`、`CompareFile` | 完成；使用包内只读展示类型。读取、冲突对齐、保留／采用命令由旧适配层负责，未迁移这些业务。 |
| `VersionCompare.tsx`：来源选择、实例行及版本事实 | `VersionCompare`、`VersionRowView` | 完成；按调用方提供的实例行显示，不按同名路径合并；版本读取／投影仍在旧业务层。 |
| `HdlToolArea.tsx`：信号数码管、真实板、有限波形、运行簇与构建诊断 | `SignalDigit`、`HdlBoardPane`、`HdlTracePane`、`HdlRunCluster`、`HdlBuildPane` | 完成；包内 HDL 展示类型／纯 helper，无旧应用类型依赖，保留四态、旧采样提示、有限采样窗口与确认语义。请求、会话／构建控制及权限校验未迁移。 |

纯 helper／类型位于 `wsLayout.ts`、`originalText.ts`、`codeSelection.ts`、`projectFiles.ts`、`filePresentation.ts`、`diagnosticPresentation.ts`、`comparisonPresentation.ts`、`hdlPresentation.ts`。不包含验证服务结果、网络、IndexedDB、草稿仓库或业务命令。

Monaco 依赖已接入。本批继续依赖唯一正式 `@xunjie/ui/styles.css`，不维护 app.css 摘录副本。

## 材料、辅导与教学展示（第三批）

仅沿旧版实际引用链迁移。正式视图没有旧应用／领域类型依赖；旧适配器仍负责授权身份、请求、订阅、存储、发送保护与回执，不计为已脱离旧运行时。

| 旧源／视觉单元 | 正式名称 | 状态／仍需处理 |
| --- | --- | --- |
| `TextScopePanes.tsx`：正文入口、任务详情、能力、材料及初始化状态 | `TextScopeBodyPane`、`TextScopeRunCluster`、`PrepTaskInfo`、`ReadyTaskInfo`、`CapabilityList`、`MaterialList`、`InitLoading`、`InitUnavailable`、`Section`、`Fact`、`Block`、`List` | 视觉完成；使用公开初始化／材料展示类型。准备模式标识、Router 返回链接和失败日志由旧适配器显式提供；初始化读取与授权未迁移。 |
| `TutoringPane.tsx`：窗口、输入、进度、历史、原对象／HDL来源、回合操作 | `TutoringPaneView`、`TutorMessageView`、`TutorHistoryView`、`HdlSource` | 视觉完成；保持原直接消息 DOM。逐条消息的观察适配器返回正式消息视图，不是整页旧 JSX 插槽。原 client、回合配对、发送／替换保护、历史授权、IntersectionObserver、displayed／acknowledged 写入及滚动状态仍在旧适配器；端到端运行时解耦未完成。 |
| `TutoringControls.tsx`：政策、限定检查、独立控制、覆盖区间 | `TutoringControlsView` | 视觉完成；是否允许控制、身份匹配及覆盖依据仍由旧适配器核对，轮询／BroadcastChannel／控制命令未迁移。 |
| `TutoringExample.tsx`：只读资料、来源与返回提示 | `TutoringExample` | 完成；只接收已授权资料展示数据和返回回调，不读取材料、不保存或发送回执。 |
| `SubmissionFeedbackPanel.tsx`：快照选择、反思、确认、反馈、修订及历史 | `SubmissionFeedbackPanel` | 视觉完成；交回明确快照 ID、反思和匹配检查。旧适配器按原列表解析快照、维护控制器／身份生命周期并执行原请求；提交／修订存储与命令未迁移。 |
| `ExecutionNodeSelect.tsx`：执行电脑状态、选择与刷新 | `ExecutionNodeSelect` | 视觉完成；身份当前性、store 订阅、读取和选择仍由旧适配器负责。未就绪不禁止编辑／保存，也不冒充就绪。 |
| `GuideLayer.tsx`：旧课程步骤、角色提示及收纳表现 | `GuideLayer` | 完成；旧版坐标、演示卡编排和显式动作回调一起迁入，只有本机展示状态，不拥有课程命令或收纳持久化。 |
| `guidance/GuidancePresentation.tsx` 及独立 CSS／布局 helper | `GuidancePresentation`、`VisibleGuidance`、`placeGuidance` | 完成；保留 body Portal、可见区定位与 presentationId／动作有效期，不因渲染或动画发出教学动作。 |
| `GenCardItems.tsx`：工具窗格、卡片与缺失态 | `GenToolPane` | 视觉完成；使用正式 chat 卡片，宿主由 `createHost` 显式注入。旧沙箱 `GenSandboxHost` 和页面快照／收纳业务仍在旧适配器，宿主运行时迁移未完成。 |
| `cards.tsx`：三类交互演示及共享注册表 | `DebounceDemo`、`SegmentsDemo`、`ResetDemo`、`CARDS` | 完成；保留演示语义、计时和交互，不连接真实运行／学习记录。 |

**排除范围**：`references/` 中仅新版使用的引用组件、`DraftReferences`、`SemanticSource` 不属于本次旧版实际引用链，不迁入、不作为视觉依据，也不列作本批完成项。旧页面内关键单元的迁移和业务边界见下表。

## 页面内关键视觉单元

| 旧页面／单元 | 正式映射 | 状态／边界 |
| --- | --- | --- |
| `apps/web/src/pages/WorkspacePage.tsx`：`TaskProgress`、`TaskInfo` | 调用正式 `TaskProgress`、`TaskInfo` | 视觉实现已迁入；页面领域适配器仍依赖 `ProjectTask`、进度计算、状态和格式化，适配器未迁移。 |
| 同页：`WorkspaceChatPane`、固定聊天栏、浮动聊天壳、输入区 | `WorkspaceChatPaneView`、`WorkspaceDockedChat`、`WorkspaceFloatingChat`、`WorkspaceChatInput` | 视觉和输入交互已迁入；消息流、回合控制、生成卡宿主与滚动状态由调用方提供。 |
| 同页：工作区顶栏、首次任务介绍、固定卡片、工具包未接入态、缺失任务与 Toast | `WorkspaceHeader`、`WorkspaceTaskIntro`、`WorkspacePinnedCardsColumn`、`WorkspacePinnedLearningCard`、`WorkspacePinnedGeneratedCard`、`WorkspaceToolkitPending`、`WorkspaceMissingTask`、`WorkspaceToast` | 视觉和局部交互已迁入；任务事实、导航、收纳和生成卡宿主由调用方提供。 |
| `apps/web/src/pages/PrepWorkspacePage.tsx`：模式标识、顶栏、求助菜单与操作栏 | `PrepBadge`、`PrepWorkspaceHeader`、`PrepHelpMenu`、`PrepWorkspaceCommandBar` | 视觉与回调已迁入；初始化状态、载入代次、退出及权限判断由宿主提供。 |
| 同页：本机草稿冲突条、HDL 快照／构建设置、原请求核对、比较与会话替换确认 | `PrepDraftConflictBar`、`PrepDraftConflictRow`、`PrepHdlBuildSettings`、`PrepHdlBuildPanel`、`PrepHdlRequestAction`、`PrepComparisonAction`、`PrepSessionReplaceDialog` | 视觉与选择回调已迁入；原命令身份、确认快照、冲突处理及 HDL 生命周期由宿主提供。 |
| 同页：辅导返回提示 | `PrepTutoringReturnNotice` | 提示展示已迁入；来源／返回定位与业务控制器由宿主提供。任务详情及辅导控制分别使用本清单已有正式组件。 |

第二批验证：132 项相关工程测试通过；独立桌面 Chrome 验证了真实 Monaco 的原文、模型身份、分屏／工具切换后的撤销重做及只读比较模型释放。它不代替真实课程运行与教学验收。

第三批验证：66 项相关测试、UI 包类型检查、包边界检查和独立 Vite 生产构建通过。公共导出一致，构建禁止加载旧 Web 源码；原 displayed 观察函数完整保留，并通过可见正文／零面积／隐藏正文／失效消息测试。本批未新增桌面 Chrome 实屏验收。Web 总类型检查最后受并行目录 `ui-catalog/examples/teacher-review.tsx` 的语法错误阻塞，未修改该写集外文件。

旧页面仍承担数据、请求、存储、身份和命令适配；新版删除旧页面前需要接入这些业务能力。本表记录 UI 迁移，不把业务宿主或教学效果视为已完成。
