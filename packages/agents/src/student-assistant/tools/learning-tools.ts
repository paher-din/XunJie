import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { learningTargetSchema, spaceIdentitySchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { learningPageSchema, learningReadSchema, learningSearchSchema, personalProjectContentSchema,
  personalProjectCreateSchema, personalProjectSchema, type PersonalProject, type PersonalProjectContent,
  type PersonalProjectCreate, type PersonalProjectMaterialReference, type LearningPage, type LearningDetail } from '@xunjie/contracts/student-learning';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, Facts, ToolCall, ToolContext } from '@xunjie/agent-runtime';
import { completed, errored, json, projectResult } from '../../capabilities/tool-support.js';
import { verifyProjectCreation, type CreationQuestionsPort } from '../creation-policy.js';

export interface WorkspaceSessionReceipt { sessionId: string; activityId: string; target: LearningTarget; ready: boolean; }
export interface ProjectMaterialsReceipt { requestId: string; activityId: string; references: PersonalProjectMaterialReference[]; }
/** Host adapters call the approved session/material domain APIs and return their real receipts. */
export interface LearningToolsHost {
  localPersonalIdentity: SpaceIdentity;
  localLearningTarget: LearningTarget;
  query: { listLearningTasks(input: unknown): Promise<LearningPage>; searchLearning(input: unknown): Promise<LearningPage>;
    readLearning(input: unknown): Promise<LearningDetail> };
  projects: { create(identity: SpaceIdentity, input: PersonalProjectCreate): Promise<PersonalProject>;
    receipt(identity: SpaceIdentity, operationId: string): Promise<PersonalProject | null> };
  /** Real question/answer lookup for creation confirmation; no classifier model. */
  questions: CreationQuestionsPort;
  workspaceSessions: {
    ensure(identity: SpaceIdentity, input: { requestId: string; sessionId: string; activityId: string; target: LearningTarget; title: string }): Promise<WorkspaceSessionReceipt>;
    receipt(identity: SpaceIdentity, sessionId: string): Promise<WorkspaceSessionReceipt | null>;
  };
  materials: {
    adopt(identity: SpaceIdentity, input: { requestId: string; activityId: string; sourceSessionId: string; references: PersonalProjectMaterialReference[] }): Promise<ProjectMaterialsReceipt>;
    receipt(identity: SpaceIdentity, requestId: string): Promise<ProjectMaterialsReceipt | null>;
  };
}
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
const subject = (identity: Omit<SpaceIdentity, 'name'>) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const createInputSchema = personalProjectContentSchema.extend({ proposalKey: z.string().min(1).max(200) });
const schemas = { list_learning_tasks: learningPageSchema, search_learning: learningSearchSchema,
  read_learning: learningReadSchema, create_personal_project: createInputSchema };
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  list_learning_tasks: '分页列出宿主当前获准的个人和学校学习任务。缺失截止时间如实标明。',
  search_learning: '在当前获准 owner 中搜索学习任务、作品、实验记录和对话；对话仅作来源资料。',
  read_learning: '按稳定来源、对象和版本重新授权并分段读取。历史引用不代表当前访问权限。',
  create_personal_project: '在 student_ask 确认（purpose=create_personal_project）获得真实同意后，创建一个本机个人自主学习项目及独立工作区。提交 proposalKey 与标题、目标、阶段和固定资料引用；同一提案重试返回原项目。',
};
const inputSchemaOf = (name: ToolName) => z.toJSONSchema(schemas[name], { io: 'input',
  override({ jsonSchema }) { if (jsonSchema.format === 'uuid') delete jsonSchema.format; } });

/** Concrete scenario tools; the kernel owns the serial loop and result pairing. */
export function createLearningTools(host: LearningToolsHost): AgentTool[] {
  const identity = spaceIdentitySchema.parse(host.localPersonalIdentity), target = learningTargetSchema.parse(host.localLearningTarget);
  if (identity.kind !== 'personal') throw new StorageError('forbidden');

  function checkProject(project: PersonalProject, input: PersonalProjectCreate) {
    if (!same(subject(project.identity), subject(identity)) || !same(project.target, target)
      || project.operationId !== input.operationId || project.sourceSessionId !== input.sourceSessionId
      || project.inputId !== input.inputId || project.responseId !== input.responseId || !same(project.content, input.content))
      throw new StorageError('identity-conflict');
  }
  function checkSession(session: WorkspaceSessionReceipt, project: PersonalProject) {
    if (session.sessionId !== project.workspaceSessionId || session.activityId !== project.activityId
      || !same(session.target, target) || typeof session.ready !== 'boolean') throw new StorageError('identity-conflict');
  }
  function checkMaterials(receipt: ProjectMaterialsReceipt, project: PersonalProject, requestId: string) {
    if (receipt.requestId !== requestId || receipt.activityId !== project.activityId
      || !same(receipt.references, project.content.materialRefs)) throw new StorageError('identity-conflict');
  }
  function workspaceSummary(project: PersonalProject) {
    const workspace = { projectId: project.projectId, activityId: project.activityId, sessionId: project.workspaceSessionId,
      title: project.content.title, goal: project.content.goal, target: project.target, identity: project.identity };
    const retainedLocal = project.content.materialRefs.filter(reference => ['personal-material', 'pdf'].includes(reference.kind)
      && same(reference.owner, project.target) && same(subject(reference.identity), subject(project.identity))).length;
    const materials = { retainedInWorkspace: retainedLocal, fixedSourceReferences: project.content.materialRefs.length - retainedLocal,
      note: '本机附件已在工作区独立保留，删除原会话不会破坏这些资料；其余固定来源在读取时重新授权。' };
    return { workspace, materials };
  }

  async function readTool(name: ToolName, call: ToolCall): Promise<AgentToolResult> {
    let result: unknown;
    if (name === 'read_learning') {
      const input = learningReadSchema.parse(call.input);
      const detail = await host.query.readLearning({ ...input, range: { ...input.range, length: Math.min(input.range.length, 4000) } });
      result = detail.provenance?.course?.helpPolicy.questions === 'disabled' ? { ...detail, text: '',
        range: { offset: input.range.offset, length: 0, total: 0, nextOffset: null },
        missing: [...new Set([...detail.missing, 'course-agent-help-disabled'])] } : detail;
    } else {
      const input = (name === 'list_learning_tasks' ? learningPageSchema : learningSearchSchema).parse(call.input);
      const args = { ...input, limit: Math.min(input.limit, 6) };
      const page = name === 'list_learning_tasks' ? await host.query.listLearningTasks(args) : await host.query.searchLearning(args);
      result = { ...page, items: page.items.map(item => item.provenance?.course?.helpPolicy.questions === 'disabled'
        ? { ...item, excerpt: '', missing: [...new Set([...item.missing, 'course-agent-help-disabled'])] } : item) };
      const bounded = result as LearningPage;
      while (JSON.stringify(bounded).length > 8192 && bounded.items.length > 1) {
        bounded.items.pop(); bounded.nextOffset = bounded.offset + bounded.items.length;
      }
    }
    return projectResult(json(result), JSON.stringify(result));
  }

  async function createTool(call: ToolCall, ctx: ToolContext): Promise<AgentToolResult> {
    const { proposalKey, ...content } = createInputSchema.parse(call.input);
    const decision = await verifyProjectCreation(
      { sessionId: ctx.sessionId, turnId: ctx.turnId, inputIds: ctx.inputIds }, identity, content, proposalKey, host.questions);
    if (decision.kind !== 'allow') {
      const reason = decision.kind === 'answer_requires_model_judgment'
        ? '自由文本回答需要主模型在后续 Step 看到真实答案后再判断是否同意；不要猜测同意。'
        : decision.reason;
      return errored(JSON.stringify({ created: false, decision: decision.kind, reason }), json({ decision: decision.kind, reason }));
    }
    // One idempotent business creation per proposal; retrying the same proposal returns the original project.
    const request = personalProjectCreateSchema.parse({ operationId: operationId(`personal-project:${ctx.sessionId}:${proposalKey}`),
      sourceSessionId: ctx.sessionId, inputId: decision.sourceInputId, responseId: decision.questionId, proposalKey, content });
    const existing = await host.projects.receipt(identity, request.operationId);
    const project = personalProjectSchema.parse(existing ?? await host.projects.create(identity, request));
    checkProject(project, request);
    const session = await host.workspaceSessions.receipt(identity, project.workspaceSessionId)
      ?? await host.workspaceSessions.ensure(identity, { requestId: operationId(`personal-project-session:${request.operationId}`),
        sessionId: project.workspaceSessionId, activityId: project.activityId, target, title: project.content.title });
    if (!session || !session.ready) {
      // Partial success: the project is retained; workspace/materials completion is retried by a new Turn.
      return completed(JSON.stringify({ ...workspaceSummary(project), pending: 'workspace', operationId: request.operationId }),
        json({ operationId: request.operationId, projectId: project.projectId, pending: 'workspace' }));
    }
    checkSession(session, project);
    const requestId = operationId(`personal-project-materials:${request.operationId}`);
    const materials = await host.materials.receipt(identity, requestId)
      ?? await host.materials.adopt(identity, { requestId, activityId: project.activityId,
        sourceSessionId: project.sourceSessionId, references: project.content.materialRefs });
    if (!materials) {
      return completed(JSON.stringify({ ...workspaceSummary(project), pending: 'materials', operationId: request.operationId }),
        json({ operationId: request.operationId, projectId: project.projectId, pending: 'materials' }));
    }
    checkMaterials(materials, project, requestId);
    const summary = workspaceSummary(project);
    return projectResult(json({ operationId: project.operationId, ...summary }), JSON.stringify(summary));
  }

  return (Object.keys(schemas) as ToolName[]).map(name => ({
    definition: { name, description: descriptions[name], inputSchema: inputSchemaOf(name) },
    supportsBackground: false,
    async execute(call: ToolCall, ctx: ToolContext): Promise<AgentToolResult> {
      if (call.executionMode === 'background') return errored('该工具不支持 background 模式');
      return name === 'create_personal_project' ? createTool(call, ctx) : readTool(name, call);
    },
  }));
}