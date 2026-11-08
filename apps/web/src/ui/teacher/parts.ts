/**
 * 旧版教师端内部 UI 部件的具名入口，不是无依赖的展示组件。
 * 保留各自原有的 TeacherContext、router、业务类型、样式和服务依赖；
 * 按原使用场景提供相应环境，导出不会解除这些依赖。
 * PreviewDesign 保留本机合成数据、固定示例与预览分配语义；
 * LiveDesign / DesignAgent 保留真实会话、课程授权、服务调用与显式采纳语义。
 * Overview / Projects / ActivityDetail / Review / Settings 仍按原上下文区分演示与真实数据。
 */

// 教学空间概览与项目活动。
export {
  ScopeNotice as TeacherScopeNotice,
  OverviewPage as TeacherOverviewPage,
  ProjectsPage as TeacherProjectsPage,
  ActivityDetail as TeacherActivityDetail,
} from '../../teacher/TeacherApp'

// 隔离预览的项目设计。
export {
  Field as TeacherPreviewDesignField,
  DesignEditor as TeacherPreviewDesignEditor,
  CheckGroup as TeacherPreviewDesignCheckGroup,
} from '../../teacher/DesignPage'

// 真实课程的项目设计与角色预览。
export {
  Field as TeacherLiveDesignField,
  LinkedChoices as TeacherLiveDesignLinkedChoices,
  CopyActivityDesign as TeacherLiveDesignCopyActivity,
  LiveDesignEditor as TeacherLiveDesignEditor,
  RolePreview as TeacherLiveDesignRolePreview,
} from '../../teacher/LiveDesignPage'

// 真实设计 Agent 的值展示，仍沿用领域字段名称。
export { Value as TeacherDesignAgentValue } from '../../teacher/DesignAgentPanel'

// 审阅证据与教师通用设置。
export { EvidenceButton as TeacherReviewEvidenceButton } from '../../teacher/ReviewPage'
export { GeneralSettings as TeacherGeneralSettings } from '../../teacher/TeacherSettingsPage'
