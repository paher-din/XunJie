# 教师外壳、概览与项目：正式组件覆盖

## 入口

从 `@xunjie/ui/teacher-shell` 直接导入下表的组件和公开 props / 展示数据类型；基础按钮、徽章、空态、对话框和 `ProjectCard` 从 `@xunjie/ui/teacher` 导入。先加载 `@xunjie/ui/styles.css`，再加载 `@xunjie/ui/styles/teacher/teacher.css`。教师设计、审阅等页面还需其对应的样式入口。

```tsx
import '@xunjie/ui/styles.css'
import '@xunjie/ui/styles/teacher/teacher.css'
import { Link, NavLink } from 'react-router-dom'
import { TeacherSidebar, TeacherTopbar } from '@xunjie/ui/teacher-shell'

// links、courses、account 和当前选择均由宿主提供；Link / NavLink 可替换为其他路由适配器。
<TeacherSidebar Link={Link} NavLink={NavLink} links={links} courses={courses}
  selectedCourseId={courseId} onSelectCourse={selectCourse}
  spaceCaption="我的任教课程" pendingReviewCount={pending} showStudentSpace={canStudy}
  account={account} />
<TeacherTopbar title="教学概览" collapsed={collapsed} onToggleNavigation={toggleNavigation}
  courses={courses} selectedCourseId={courseId} onCourseChange={selectCourse}
  dark={dark} onToggleTheme={toggleTheme} />
```

`TeacherLinkProps` 约定路由适配器接收 `to`、`children`、可选 `end`、类名和无障碍标签；活动链接的匹配方式、浏览器地址和跳转行为由适配器负责。`TeacherShellFrame` 的 `sidebar` / `children`、`TeacherTopbar` 的 `tool` 只负责放置已经独立实现的外壳或宿主工具，不包含页面业务。

## 逐项覆盖

| 旧 `TeacherApp.tsx` 单元 | 正式组件 / 数据类型 | 状态与边界 |
| --- | --- | --- |
| 外壳、跳到主内容、可收起侧栏、主区域 | `TeacherShellFrame`、`TeacherPageRegion`、`TeacherPageLoading` | 已迁；主区域 ref、跳转聚焦和展开状态由宿主提供 |
| 品牌、工作空间、四项导航、课程导航、设置及学生入口 | `TeacherSidebar`、`TeacherShellCourse`、`TeacherShellLinks`、`TeacherLinkComponent` | 已迁；链接目标、当前课程、待审阅数、显示与否及回调由宿主提供 |
| 账户名、预览入口 / 退出登录 | `TeacherSidebar`、`TeacherAccountAction` | 已迁；以链接或按钮区分，登录会话和退出命令在宿主 |
| 面包屑、折叠按钮、课程下拉、主题按钮、执行节点位置 | `TeacherTopbar` | 已迁；主题、课程、执行节点工具及其动作由宿主提供 |
| 合成预览提示、真实请求核对条和 toast | `TeacherPreviewNotice`、`TeacherCommandNotice`、`TeacherToast` | 已迁；模式选择、重试、计数和 toast 生命周期由宿主负责 |
| 教学服务读取中 / 已连接 / 失败与重新读取 | `TeacherScopeNotice` | 已迁；预览不显示的判断、读取及重试由宿主负责 |
| 概览 / 项目页标题、说明和设计入口 | `TeacherPageHeading` | 已迁；标题、说明、操作禁用状态和回调可传入 |
| 任教课程、开放活动、等待审阅、设计草稿四项摘要 | `TeacherOverviewStats`、`TeacherStatistic` | 已迁；展示值和不可用占位由宿主计算 |
| 待关注学生列表、头像、待审阅标签、空态及提示 | `TeacherAttentionPanel`、`TeacherAttentionItem` | 已迁；学生、头像色序和深链由宿主提供 |
| 项目设计引导、步骤、继续草稿 / 新建入口 | `TeacherDesignCard`、`TeacherResumeDraft` | 已迁；草稿版本、来源说明及跳转由宿主提供 |
| 课程封面、课程信息、活动数和查看活动 | `TeacherCourseCard`、`TeacherCoursesSection`、`TeacherCourseCardData` | 已迁；合成学生数与实际分配数由宿主明确分别提供 |
| 概览双栏布局 | `TeacherOverviewColumns` | 已迁 |
| 课程过滤提示、状态筛选及计数、项目搜索和清除 | `TeacherCourseFilter`、`TeacherProjectsToolbar`、`TeacherProjectTab` | 已迁；计数、过滤和搜索结果由宿主计算 |
| 项目网格、项目卡、筛选空态、活动详情对话框 | `TeacherProjectGrid`；`@xunjie/ui/teacher` 的 `ProjectCard`、`TeacherEmpty`、`TeacherDialog` | 已迁；筛选空态文案、项目映射、弹层开关由宿主决定 |
| 活动概况、真实固定活动要求 / 目标 / 任务 / 量规 / 材料 / 分配 | `TeacherActivityDetail`、`TeacherFixedActivity`、`TeacherFixedActivityView`、`TeacherFixedMaterial` | 已迁；宿主先解析真实工作台数据；隐藏与不可用材料保持不同状态 |
| 本机预览快照、材料可见性及合成学生分配 | `TeacherPreviewActivity`、`TeacherPreviewAssignments`、`TeacherPreviewActivityView`、`TeacherPreviewAssignment` | 已迁；与真实固定活动分开传入，空数组和未提供的分配区有不同含义 |

当前 `apps/web/src/teacher/TeacherApp.tsx` 是兼容旧路由和 `TeacherContext` 的业务适配层，已消费上述正式实现。课程筛选、路由、会话、真实请求、草稿和预览数据的计算仍在该适配层；未来删除旧页面时，正式宿主需要接管这些功能，而不是将该页面文件作为组件依赖。

本目录只覆盖教师外壳、概览、项目与活动详情。教师设计、审阅、材料和设置等页面的迁移及其逐项验收不在本清单范围内；不能据此认定整个教师端已完成迁移。

## 实屏与交互验证记录

2026-11-08 使用桌面 Chrome，分别运行旧 `TeacherApp.tsx`（以 Git HEAD 源码作为基准）与当前正式组件实现，并逐项操作外壳导航及折叠、课程选择、跳到主内容、概览摘要 / 关注列表 / 无草稿状态、项目状态与搜索、活动详情、预览快照 / 材料 / 分配、服务加载 / 失败 / 恢复、待核对请求 / 重试和 toast。对比画面中，概览、课程筛选、预览快照、真实详情、加载 / 失败 / 重试提示及 toast 的截图像素一致；折叠和项目列表只观察到少量状态切换时的像素差异，文字及布局一致。主题切换及 720 / 390 宽度也由现有 Chrome 用例覆盖。

`teacher-shell.test.tsx` 验证受控导航 / 账户 / 筛选回调，以及真实材料、隐藏材料、不可用材料和预览快照的区别。可在仓库根目录运行 `node_modules/.bin/vitest run packages/ui/src/teacher-shell/teacher-shell.test.tsx`。真实工作台的浏览器验证使用隔离的模拟接口数据，并非教学效果验证。
