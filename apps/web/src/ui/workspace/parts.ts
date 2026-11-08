/**
 * 旧版工作区内部部件的分组入口；保留原组件实现及其原有消费者。
 * 这些部件仍依赖原数据类型、状态、回调、浏览器环境或上下文及旧版样式，
 * 不能一概视为独立、无依赖的展示组件。此入口不负责初始化这些依赖。
 */

// 中心工具区：演示内容、分屏交互与工具标签。
export {
  EditorPane as LegacyDemoEditorPane,
  WavePane as LegacyDemoWavePane,
  BoardPane as LegacyDemoBoardPane,
  Divider as LegacyToolDivider,
  ToolTabs as LegacyToolTabs,
  DigitalLogicRunCluster as LegacyDemoDigitalLogicRunCluster,
} from '../../components/workspace/CenterToolArea'

// 代码工作区：文件事实与本机草稿保护状态。
export {
  StatusBar as LegacyCodeStatusBar,
  ProtectionChip as LegacyCodeProtectionChip,
} from '../../components/workspace/CodeWorkspace'

// 比较视图：服务冲突与历史版本分别保留原数据契约。
export { CompareFile as LegacyConflictCompareFile } from '../../components/workspace/ConflictCompare'
export { VersionRowView as LegacyVersionCompareRow } from '../../components/workspace/VersionCompare'

// TextScope：初始化、任务、材料与信息排版部件。
export {
  CapabilityList as LegacyTextScopeCapabilityList,
  ReadyTaskInfo as LegacyTextScopeReadyTaskInfo,
  MaterialList as LegacyTextScopeMaterialList,
  InitLoading as LegacyTextScopeInitLoading,
  Section as LegacyTextScopeSection,
  Fact as LegacyTextScopeFact,
  Block as LegacyTextScopeBlock,
  List as LegacyTextScopeList,
} from '../../components/workspace/TextScopePanes'

// 辅导：来源、历史及带原可见性事实上报行为的消息。
export {
  HdlSource as LegacyTutorHdlSource,
  TutorHistoryView as LegacyTutorHistoryView,
  TutorMessageView as LegacyTutorMessageView,
} from '../../components/workspace/TutoringPane'

// 真实 HDL 信号与教学卡演示分别导出，不混同两者的数据来源。
export { SignalDigit as LegacyHdlSignalDigit } from '../../components/workspace/HdlToolArea'
export {
  DebounceDemo as LegacyDebounceDemo,
  SegmentsDemo as LegacySegmentsDemo,
  ResetDemo as LegacyResetDemo,
} from '../../components/workspace/cards'

// 页面领域适配器仍消费 ProjectTask；不同于 TaskPresentation 的受控展示组件。
// 从此组导入会引入旧页面的模块依赖，不代表可脱离应用运行。
export {
  TaskProgress as LegacyTaskProgressAdapter,
  TaskInfo as LegacyTaskInfoAdapter,
  WorkspaceChatPane as LegacyWorkspaceChatPane,
} from '../../pages/WorkspacePage'

// 引导的可见层依赖原锚点几何、交互回执与动效行为。
export { VisibleGuidance as LegacyVisibleGuidance } from '../../components/workspace/guidance/GuidancePresentation'
