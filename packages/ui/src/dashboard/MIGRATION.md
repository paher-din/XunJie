# 看板第一批真实迁移

正式入口：`@xunjie/ui/dashboard`。正式样式由 `@xunjie/ui/styles.css` 提供。

| 正式导出 | 可验收内容 |
| --- | --- |
| `DashboardSection` | 原标题、编辑按钮、卡片区、托盘、移出／添加、提示定位与 continueSlot；布局受 `layout/onLayoutChange` 控制 |
| `EmptyWidget` | 原嵌套空态结构 |
| `HeatWidget`、`HeatDaily`、`HeatWeekly` | 日／周切换、周列布局、尺寸测量、统计图与提示 |
| `TaskProgressWidget` | 已知零／未知分母、任务完成率、最近完成和下一个任务 |
| `MosaicWidget` | 构成比例和时长换算 |
| `BadgesWidget` | 徽章与解锁状态 |
| `RadarWidget` | 雷达图与已提供轴值 |
| `TimelineWidget` | 里程碑与状态 |
| `PunchWidget` | 周节奏矩阵与提示 |
| `TrendWidget` | 已提供时长序列的趋势 |
| `RingWidget` | 完成环与任务状态数量 |
| `StreakWidget` | 已提供日期序列的连续学习计算 |
| `MasteryWidget` | 知识点掌握度 |
| `XpWidget` | 已提供等级／经验值；缺数据保持空态 |
| `Bars7Widget` | 近七日柱状与日期提示 |

全部组件导出对应 `*Props`。`WidgetProps`、`DashboardLayout`、`DashboardData`、`DashboardTask`、`SemDay` 等展示契约在正式包中定义；不依赖旧 bridge、store 或 mock 数据。组件只根据宿主输入计算显示值，不生成模拟统计事实。

旧 `widgets.tsx` 改为正式子路径具名重导出。旧 `DashboardSection.tsx` 只保留 localStorage 读写、旧布局校验／回退／新增项补齐，以及旧演示统计标记和周期文案；通过受控布局与文本 props 接入正式展示。持久化策略未迁入，不能把旧适配器计为独立正式组件。

验证：原有看板 5 条回归测试通过；正式包受控添加／移除和不读取／写入存储的交互测试 1 条通过。Web、正式功能入口及测试的类型检查通过。未执行浏览器视觉验收。
