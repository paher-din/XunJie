# 首页第一批真实迁移

正式入口：`@xunjie/ui/home`。视觉样式由正式包的 `@xunjie/ui/styles.css` 提供；本批不改样式。

| 正式组件 | 可验收内容 | 宿主职责 |
| --- | --- | --- |
| `TaskToolbar` | 原筛选 DOM、active class、搜索值、清除按钮与清除后输入焦点 | 提供受控值、执行实际筛选 |
| `ContinueTaskCard` | 原 db-continue 结构、图文按钮、缺失／空描述、db-side／pct 差异 | 任务推荐、数字计算、导航 |
| `CourseTiles` | 课程卡组和共享 hover 高亮、键盘入口标志 | 课程展示事实与选择回调 |
| `CourseTile` | 原封面图标、课程标题／摘要、查看任务入口 | 卡片展示值、打开回调 |
| `LearningTaskCard` | 状态／内容／底部插槽、无进度时的 class、可访问标签与稳定标识 | 提供实际任务事实与导航 |
| `LearningCardGrid` | 原任务卡组几何、高亮和注册接口 | 提供卡片集合 |

全部组件导出对应 `*Props`。`useFluidHover`、`useRegisterFluidHoverItem`、`pickNearest` 与所需类型随包迁移，`FluidHighlight` 使用正式 foundation。
旧 `apps/web/src/components/home/*` 改为从正式子路径具名重导出。

第二批已迁问候、标题、状态区、面包屑、准备入口、课程区域与任务卡内容，原页面实际消费。查询、任务选择与过滤、课程定位和路由继续保留页面；没有将旧页面包装成正式组件。逐项余项与新增验证见 `COVERAGE.md`。

验证：Web 类型检查、三个正式功能入口独立类型检查通过；直接使用正式组件的工具栏交互与继续任务 DOM 差异测试 2 条通过。未执行浏览器视觉验收。
