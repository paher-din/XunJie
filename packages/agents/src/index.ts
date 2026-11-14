/** Explicit scene assembly over the shared Agent kernel. Model and domain owners keep their own APIs. */
export { createConversationPipeline } from './conversation/index.js';
export type { ConversationOptions, ConversationContext, ConversationScenario } from './conversation/index.js';
export type * from './conversation/tools.js';
export { createStudentAssistant } from './student-assistant/index.js';
export type { StudentAssistantOptions } from './student-assistant/index.js';
export { createWorkspaceAssistant, createWorkspaceToolModule } from './workspace-assistant/index.js';
export type { WorkspaceAssistantOptions, WorkspaceToolOptions } from './workspace-assistant/index.js';
export { createUserQuestions } from './capabilities/user-questions/index.js';
export { createDocumentTools } from './capabilities/documents/index.js';
export type { DocumentToolOptions, DocumentMaterialsPort, DocumentMaterialSource } from './capabilities/documents/index.js';
export { createSkillTools } from './capabilities/skills/index.js';
export type { SkillToolsHost } from './capabilities/skills/index.js';
export { createLearningTools } from './student-assistant/tools/learning-tools.js';
export type { LearningToolsHost } from './student-assistant/tools/learning-tools.js';
export { createTeachingTools } from './workspace-assistant/tools/tools.js';
export type { TeachingToolsLearning } from './workspace-assistant/tools/tools.js';
export type { TeachingToolData } from './workspace-assistant/tools/tool-data.js';
export { buildContext } from './workspace-assistant/context.js';
