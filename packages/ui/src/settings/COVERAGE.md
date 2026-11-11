# 学生设置迁移覆盖

范围：旧 `apps/web/src/components/settings/`，以及 `SettingsPage` 的设置外壳。正式入口为 `@xunjie/ui/settings`。本表按实际视觉实现计数；兼容 re-export、页面容器及调用方传入的整段 JSX 不计作对应内容已解耦。

“已迁入”只表示该视觉单元已有包内实现、公开 props/展示类型，且不导入旧应用；不表示整个页面或业务控制器迁移完成。所有实现仍需包内图标、主题样式及 React/Radix 等运行依赖。

| 旧组件 / 关键视觉单元 | 正式组件 | 覆盖与剩余工作 |
| --- | --- | --- |
| `controls.Section` 分组标题与说明 | `Section` | 已迁入 |
| `controls.Row` 表单行 | `Row` | 已迁入 |
| `controls.Toggle` 开关 | `Toggle` | 已迁入 |
| `controls.Seg` 分段选择 | `Seg` | 已迁入 |
| `controls.Slider` 滑杆 | `Slider` | 已迁入 |
| `controls.HelpTip` 定位提示浮层 | `HelpTip` | 已迁入，保留视口定位及 portal 行为 |
| `controls.Field` 字段与错误 | `Field` | 已迁入 |
| `controls.TextInput` 输入框 | `TextInput` | 已迁入 |
| `controls.RadioCard` 单选卡组 | `RadioCard` | 已迁入 |
| `controls.ModelFields` 模型细项、智能参考值与推理等级编辑 | `ModelFields` | 已迁入，使用公开 `ProviderModel`；参考值不代表实际能力验证 |
| `SettingsLayout` 外壳、导航、版本、toast 与 keyed 内容容器 | `SettingsLayout` | 已迁入；`children` 内的分区不随外壳计入覆盖 |
| `RadarChart` 能力雷达图 | `RadarChart` | 已迁入 |
| `ModelProviderCard` 供应商卡头与框架 | `ModelProviderCard` | 已迁入；可选紧凑模式、品牌图形与底部操作；`actions` / `children` 内的内容另计 |
| 正式供应商的紧凑模型列表行 | `ModelProviderModelRow` | 名称、思考强度、操作列与就近反馈；窄容器换行，启停与测试状态由调用方提供 |
| `ProviderIdentityFields` 名称、地址、密钥字段 | `ProviderIdentityFields` | 已迁入 |
| 正式供应商模型 ID、思考强度、容量与手动档位 | `ConnectionModelFields` | 纯表单已迁入；模型资料、档位适配和保存由正式控制器接入；目录与人工声明不代表实际能力验证 |
| 供应商与接入方式选择、品牌图形 | `SettingsSelect`、`ModelProviderLogo` | Base UI 交互与循阶 token；资源随组件包分发，业务选项由调用方提供 |
| 设置操作菜单 | `SettingsActionMenu` | 复用循阶按钮和弹层样式，操作及图标由调用方提供 |
| 技能列表条目 | `SkillListItem` | 两行摘要、带图标的打开／删除菜单和启停开关；Base UI Menu 提供 portal、避让与键盘操作，读写由调用方接入 |
| 技能正文阅读 | `SkillDocumentDialog` | 完整显示 YAML 元信息和 Markdown 正文、读取／失败状态及返回焦点；文档与更新操作由调用方提供 |
| 技能批量导入结果 | `SkillImportFeedback` | Astryx Banner 适配；未完成项、继续／重试和重选操作；进度与请求生命周期由调用方提供 |
| 预设模型搜索与手填 ID | `ModelIdInput` | Base UI Combobox；列表、加载状态和刷新操作由调用方接入，保留自由输入 |
| 预设模型选择与逐项展开配置 | `ModelChoiceCard` | 虚线框、选择态和可展开的参数区；选择、配置值与保存由调用方提供 |
| 模型测试结果与诊断 | `ModelTestFeedback` | Astryx Banner 适配；原因、建议、停止／重试和可复制详情，测试及通知由调用方负责 |
| 连接／模型测试按钮 | `ModelTestButton` | 复用 Button；文字与单图标两种展示、稳定尺寸、悬停提示、浅深主题及同一按钮停止；测试生命周期由调用方接入 |
| 拉取模型后的列表、勾选与展开 | `ModelChoiceCard` | 与预设型号复用卡片；搜索、拉取、容量限制及失败／空态由业务接入 |
| `ModelSettingsFeedback` 已确认保存 / 错误状态槽 | `ModelSettingsFeedback` | 已迁入，使用公开反馈数据类型 |
| `PrivacyTab.ConfirmAction` 就地二次确认 | `ConfirmAction` | 已迁入 |
| `AccountTab` 资料表单、文件选择入口、空间信息、安全表单 | `AccountSettingsView` | 视觉已迁入，仍保留原演示文案；表单值、上传及密码回调由适配层提供 |
| `AccountTab` 头像图形 | `AccountSettingsView` → foundation `AccountAvatar` | 视觉已迁入；传入姓名 / 图片展示数据，包内组合正式头像，不再传旧组件 JSX；图像处理、会话选取、存储和密码校验仍在旧适配层 |
| `AgentTab` 称呼、引导控件、辅导风格预览框 | `AgentSettingsView`、`agentPreviewText` | 视觉及预览文案规则已迁入；设置读取 / 更新仍由适配层负责 |
| `AgentTab` 预览形象 | `AgentSettingsView` → foundation `MascotSvg` | 视觉已迁入，包内直接组合正式形象，无旧 JSX 插槽 |
| `PortraitTab` 特征标签、擅长 / 待加强、偏好、纠正确认、变更列表 | `PortraitSettingsView`、`RadarChart` | 视觉已迁入；纠正、日期格式化与数据来源仍由适配层提供 |
| `PortraitTab` “Agent 个性化”导航链接 | `SettingsAgentLink` | 视觉已迁入；适配层仅传 href、router 点击处理及发现属性，保留修改键点击语义，无 router 组件插槽 |
| `PrivacyTab` 记录说明、本地数据行、导出 / 清理 / 重置入口 | `PrivacySettingsView`、`ConfirmAction` | 视觉已迁入；旧 bridge、store、Blob 导出与清理操作仍由适配层负责 |
| `AboutTab` 品牌区域布局、版本、更新状态、致谢、赛事脚注 | `AboutSettingsView` | 视觉已迁入；版本和致谢为数据 props；原演示更新计时仍留在适配层 |
| `AboutTab` 品牌图形 | `AboutSettingsView` → brand `XunjieLogo` | 视觉已迁入，包内直接组合正式品牌，无旧 JSX 插槽 |
| `LegacyModelTab` 默认模型、思考强度、学校接入卡、自定义模型条目、删除确认 | `LegacyModelSettingsView` | 视觉已迁入；演示 / 真实模式、选中项、状态与领域操作由适配层提供 |
| `LegacyModelTab` 重新读取 / 启停配置操作组 | `ModelConfigActions` | 视觉已迁入；`configActions` 为具名状态 / 回调数据，不再接收 JSX |
| `LegacyModelTab` 学校 / 供应商连接测试行 | `ModelConnectionTestRow` | 视觉已迁入；状态与已格式化结果为数据，网络留在适配层，无 `testRow` 渲染插槽 |
| `LegacyModelTab` 弹窗编排与保存 / 删除后通知 | `LegacyModelDialogs` | 弹窗视觉编排已迁入：按对话框状态条件挂载正式表单；`dialogs` 为状态 / 回调数据，不再接收 JSX。保存 / 删除后的持久化与通知仍在适配层 |
| `ProviderDialog` 弹层、身份字段、模型卡、结果与模型导入、操作栏 | `ProviderSettingsDialog`、`ProviderDialogView` | 视觉与局部表单状态 / 校验已迁入；`onTest` 接收展示结果，真实网络和演示判定由旧适配层接线，`onSave` 由调用方实现 |
| `ModelDialog` 弹层、目标供应商说明、模型字段、操作栏 | `ModelSettingsDialog`、`ModelDialogView` | 视觉、重名校验和表单状态已迁入；异步保存由 `onSave` 注入；旧路径为兼容导出，包内已有实际实现 |
| `modelPresentation` 空表单、精确 ID 参考值、配置校验 | 同名公开函数 | 已迁入纯函数及公开模型类型；旧数据层重导出使用 `@xunjie/ui/settings/model-presentation`，不经过 React / TSX barrel；不计作页面完成 |
| `SettingsPage` 路由、分区编排与 toast 定时器 | — | 未完成；只迁入外壳不能视为设置页迁移完成 |
| `apps/web/src/ui/settings/controls.tsx` 旧入口 | `@xunjie/ui/settings` | 已改为正式控件的兼容导出；新代码直接使用正式子路径。 |

保留在旧适配层、尚未迁至正式调用层的职责（未完成，不冒充整页迁移）：账户会话选择、图片处理 / 密码 / 持久化；Agent 设置更新；画像纠正与路由；隐私导出 / 清理；关于页演示计时；模型配置读取、保存、测试及通知；连接弹窗的请求身份、凭据处理与冲突 / 未知结果恢复。它们应继续按业务计划迁移，不能通过包装或 re-export 关闭。

上述正式视图本身无需旧应用；`SettingsLayout.children`、`ModelProviderCard.actions/children` 等一般组合入口不自动扩大覆盖，本批新增结构均有具体实现而非整块旧 JSX 注入。密码、更新检查、学校接入等原演示语义不得升级为真实服务承诺。
