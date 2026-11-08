/**
 * 旧学生端原有页面部件。它们保留路由、store、演示模式或原业务类型依赖；
 * 需要独立接线时优先使用 home、settings、workspace 等入口中的受控组件。
 */
export { RealHomePage, PreparationHomePage, CourseTiles as LegacyCourseTiles,
  TaskCards as LegacyTaskCards, TaskCard as LegacyTaskCard } from '../pages/HomePage'
export { AssignedTaskEntryCard, TaskEntryCard } from '../pages/AgentPage'
export { PrepBadge } from '../pages/PrepWorkspacePage'
export { ConvSentinel, PaneSwap } from '../components/AppShell'
export { LoginForm } from '../components/SessionEntry'
export { ConfirmAction } from '../components/settings/PrivacyTab'
