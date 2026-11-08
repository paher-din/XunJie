# 教师项目设计 UI 覆盖

范围为旧 `DesignPage.tsx`、`LiveDesignPage.tsx`、`DesignAgentPanel.tsx`。正式入口是 `@xunjie/ui/teacher-design`，实现与公开展示类型均在本目录，不导入旧应用、TeacherContext、wire、store、网络或 router。下表只计实际实现，不以旧路径 re-export 或页面容器充数。

| 旧视觉单元 | 正式组件 | 状态 / 边界 |
| --- | --- | --- |
| 预览 `Field`（必填标记、说明） | `PreviewDesignField` | 已迁入 |
| 真实 `Field` | `LiveDesignField` | 已迁入；保留无必填标记的原结构 |
| 真实 `LinkedChoices` 与失效引用 | `DesignLinkedChoices` | 已迁入；版本引用解析由调用方提供 |
| 重复条目标题、移除按钮 | `DesignRepeatHeading` | 已迁入；可删除判断由旧适配层提供 |
| 预览 `CheckGroup` | `DesignCheckGroup` | 已迁入；检查结果与章节回调由调用方提供 |
| 预览 / 真实章节导航 | `PreviewDesignNavigation`、`LiveDesignNavigation` | 已迁入；分别保留标题包装层、ARIA 与原文本 |
| 章节标题、图标、计数 | `PreviewDesignSectionHeading`、`LiveDesignSectionHeading` | 已迁入；保留两种结构差异 |
| 页头、保存反馈、操作按钮 | `PreviewDesignHeading`、`LiveDesignHeading` | 已迁入；版本、dirty、可用状态与操作回调由旧层提供 |
| 顶部返回入口、草稿版本 | `PreviewDesignTopline`、`LiveDesignTopline` | 已迁入；路由链接组件可由宿主提供，默认普通锚点 |
| 章节底栏与前后切换 | `PreviewDesignFooter`、`LiveDesignFooter` | 已迁入；预览 / 真实操作及文案分别保留 |
| 预览简报、课程、时长、驱动问题、受众、产物、选择、基础 | `PreviewBriefSection` | 已迁入；课程切换与关联重置在旧适配层 |
| 预览三条能力线、目标与证据 | `PreviewGoalsSection` | 已迁入；提交展示字段更新，不做教学质量判断 |
| 预览里程碑、量规增删编辑 | `PreviewMilestonesSection` | 已迁入；条目标识创建由调用方回调提供 |
| 预览帮助政策、材料选择、权限说明、空态 | `PreviewSupportSection` | 已迁入；可见资源过滤与业务校验仍在旧层 |
| 预览助手 / 检查 tabs、键盘焦点、快捷提示、示例建议卡、提示输入 | `PreviewDesignSupport` | 已迁入；固定示例建立 / 采用与检查算法仍在旧层 |
| 预览原生弹窗、示例差异、冲突提示、核对确认、合成学生选择 / 全选、操作栏 | `PreviewDesignDialogs` | 已迁入具体 UI；不接收整页 / 弹窗 JSX；只执行传入回调，保留合成分配文案 |
| 预览角色文章、目标、里程碑、量规、材料详情 | `PreviewRoleArticle` | 已迁入；接收旧层已过滤的角色资源，不扩大材料权限 |
| 真实课程 / 范例选择、简报与路线编辑 | `LiveBriefSection` | 已迁入；更换课程 / 范例的重置和配置选择仍在旧层 |
| 真实目标、任务、观察、关联选择、失效引用 | `LiveGoalsSection` | 已迁入；目标版本递增、引用解析、可移除判断仍在旧层 |
| 真实里程碑、量规及其任务 / 目标 / 观察关联 | `LiveMilestonesSection` | 已迁入；标识创建与版本引用解析由旧层回调提供 |
| 真实政策说明、材料版本 / 用途 / 可见性、缺失关联、沿用配置 | `LiveSupportSection` | 已迁入；政策 / 权限投影来自调用方，未新增政策创建能力 |
| 真实阻断、教师疑点记录、待验证、检查 / 预览入口 | `LiveDesignChecks` | 已迁入；阻断路径导航、疑点更新、服务端检查和 ready 判断仍在旧层 |
| 真实原生弹窗、角色切换 / 已读确认、课程学生选择、分配结果、操作栏 | `LiveDesignDialogs` | 已迁入；保留 busy 时阻止原生 cancel 的行为，不替换为 Radix |
| 真实角色内容、关联目标 / 任务、材料 available / redacted / unavailable | `LiveRolePreview` | 已迁入；使用公开展示类型，不依赖旧 `BlueprintPreview` |
| 固定活动摘要、选择学生入口、分配回执 | `LiveReleaseSummary` | 已迁入；固定版本、分配与回执核验仍在旧层 |
| 后续项目复制来源、活动固定版本、当前保存版本与不可复制说明 | `FollowUpDesignSource` | 已迁入；复制资格、服务命令和版本判断由旧层控制 |
| 后续项目页头、刷新 / 返回操作、失败说明 | `FollowUpDesignHeading`、`FollowUpDesignActions`、`FollowUpDesignError` | 已迁入；返回路由与刷新仍由旧层提供 |
| 无法打开设计 / 来源活动的空态 | `DesignUnavailable` | 已迁入；适配层选取相应标题、原因、刷新和链接 |
| 预览来源、只读提示 | `PreviewDesignSource`、`PreviewDesignReadOnlyNotice` | 已迁入 |
| 真实复制来源、错误、远端版本变化、恢复代际变化提示 | `LiveDesignNotices` | 已迁入；不自行读取或判断版本 |
| Agent 递归字段值 / 数组 / 对象、字段标签 | `DesignValue`、`designValueLabels` | 已迁入；未知字段与空值保留原展示语义 |
| Agent 类型 / 请求 / 允许字段、材料段落与试评样例选择、提交入口 | `DesignAgentView` | 已迁入实际表单；模式和获准材料由旧层传入，保留最多 64 段 UI 限制 |
| Agent 原请求核对、任务状态 / 取消 / 恢复入口 | `DesignAgentView` | 已迁入展示；请求身份、sessionStorage、轮询、预算、取消与恢复命令仍在旧层 |
| Agent 候选选择、建议理由、依据、差异、过时提示、试评说明与显式采用 | `DesignAgentView`、`DesignValue` | 已迁入；候选不是正式决定，stale / canAdopt 与实际采用核验仍在旧层 |

未完成的整页 / 业务迁移：三个旧模块仍是适配层，保留 TeacherContext、会话、路由、网络命令、草稿与目标版本规则、服务回执校验、权限过滤、合成 / 真实场景判定及原生 dialog 的 `showModal` / `close` 生命周期。编辑器的 `td-page` / `td-layout` / `main` / `fieldset` 组合仍在旧页，不计作正式整页组件；删除旧页前须为这些业务状态与入口接上正式宿主。本批未迁入旧页面代码作为 `children`，`Field.children` 仅用于字段控件，路由 `Link` 参数仅替换锚点渲染，均不自动扩大覆盖。

使用时按需加载现有 `@xunjie/ui/styles/teacher/design.css`、`live-design.css`、`design-agent.css` 及公共 token / 图标样式。本批没有修改共享样式，也没有把原生弹窗转成 Radix；不以结构检查成功推定教学效果或实际电路验证完成。
