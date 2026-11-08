# 对话第一批真实迁移

正式入口：`@xunjie/ui/chat`。所有组件导出对应 `*Props`；展示契约在 `types.ts` 中独立定义，不导入旧 bridge 类型。样式使用正式包 `@xunjie/ui/styles.css`。

| 正式组件／部件 | 已迁移的验收范围 |
| --- | --- |
| `AgentMessage` | 原相位组合、流式正文、概念／步骤／小测／生成内容插槽、停止和失败分型、消息动作 |
| `WaitTail`、`ThinkTail`、`ThinkingSettled` | 等待计时、思考秒数和摘要展开状态 |
| `ConceptBlock` | 收纳回调、局部 pin 状态及 portal |
| `StopLine`、`FailureCard`、`ActionBar` | 原按钮、失败折叠、重试／继续／换模型回调、复制成功／失败反馈与时间戳 |
| `UserMessage` | 原气泡、图片下载、复制、原位编辑、自动增高、焦点与 Escape／快捷提交 |
| `MessageTaskCard` | 状态、课程、元信息、可选真实进度及进入回调 |
| `ConceptCard`、`Waveform` | 生成／暂停／落定差异、要点、折叠、波形和高亮标注 |
| `QuizCard` | 单选判定、尝试次数、解析、重答与提交回调；记录事实必须由宿主提供 `recordLabel` |
| `StepsBlock` | 编号步骤、进行状态和折叠 |
| `TaskPicker` | 原课程分组、完成项排序、选择／取消、Escape；只接最小展示任务类型 |
| `TurnAriaStatus` | 原 polite 状态播报，不播逐字正文 |
| `MessageRail` | 原 DOM 读取、导轨刻度、预览、跳转回调和滚动定位 |
| `Markdown`、`Block`、`CodeBlock`、`ListBlock`、`TableBlock`、`Inline`、`Chars` | 原 token 渲染、memo 比较、流式修复、插入落点、表格跟随、复制与逐字样式 |
| `GenCard`、`GenFailCard`、`GenLiveCard` | 原收纳占位、失败折叠、装载／超时／运行错误状态、回滚／重试／快照及清理；运行宿主由 `createHost` 注入 |
| `AttachmentTile` | 原进度描边、百分比、图片失败回退、退场矩形和移除回调；完整实现从旧 ui 路径复制，未修改旧 ui 入口 |

`useSmoothStreamText`、`useFollowBottom`、`formatMessageTime`、`insertIndex` 及必要的纯 helper 随包迁移。所有样式 class、ARIA、组件内部交互保持原有结构；数据语义与局部 UI 状态仍然存在，这些组件不是全部无领域依赖的基础原语。

## 留在旧层的职责

| 旧实现／适配器 | 未迁移原因和对正式组件的接入方式 |
| --- | --- |
| `useAgentTurn.ts` | 直接连接 learningApi、Session、查询缓存和路由，是回合业务控制器；保持原文件 |
| `AgentMessage.tsx` 兼容适配器 | 注入旧品牌、生成卡运行适配器、旧 quota 规则与旧小测记录文案；正式实现不硬编码每日额度重置／已写入画像等事实 |
| `GenCard.tsx` 兼容适配器及旧 `bridge/genSandbox.ts` | iframe 协议宿主未迁移；旧适配器稳定注入 `GenHostFactory`，正式组件保留完整视觉生命周期。删除旧代码前须由新宿主提供该接口实现 |
| `QuizCard.tsx` 兼容适配器 | 保留旧消费者原有画像文案，正式组件是否显示记录提示取决于宿主输入 |
| `copy.ts` 旧策略文案 | 旧演示额度与重置规则只在兼容层保留；正式 copy 不带这些模拟规则 |
| `PromptInput` 旧适配器／页面控制 | 第二批已迁完整输入 UI、对话空态／视口／Dock 等，见 `../home/COVERAGE.md`；旧模型配置、文件资源、接纳／排队与网络／路由仍留旧层。会话历史由主 agent 负责 |

正式 `AgentMessage` 的 `renderGeneratedCard` 由宿主接入生成内容，`quizRecordLabel` 与 `failureCopy` 提供实际记录和规则事实；品牌默认取正式 brand，可通过 `statusIcon` 覆盖。
旧 ui/chat/AttachmentTile 兼容入口由主 agent 处理，本批未修改。

## 验证

- 原有 Markdown、概念卡测试保留，37 条通过。
- 正式包交互测试 4 条通过：消息编辑焦点／Escape、小测判定和记录事实、附件回退／移除、生成卡宿主挂载／快照／超时／重试／清理。
- Web 及正式功能入口（含新测试）类型检查通过。
- 三个功能入口浏览器打包的传递依赖图未包含任何 apps/web 文件；打包使用 write:false，未输出临时产物。
- 未运行浏览器视觉验收，也未验收真实生成卡协议或模型服务；测试使用注入的宿主接口。

## 第二批接续

`PromptInput` 的完整 form、菜单、附件容器、输入／高度动画与状态 span 已迁入；旧组件仅提供模型 store、附件资源／准备进度与发送接纳适配。新增 `AgentEmptyState`、`ChatError`、`ChatViewport`、`ChatComposerDock`、`BackToBottom`、`QueueNotice`，原 AgentPage 已消费。

第二批与既有相关回归共 60 条通过；正式入口独立类型检查、最终 Web 类型检查及无旧 Web 依赖的浏览器打包通过。未运行真实服务与浏览器视觉验收。详见 `../home/COVERAGE.md`。
