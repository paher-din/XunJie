import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { learningTargetSchema, spaceIdentitySchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { learningPageSchema, learningReadSchema, learningSearchSchema, personalProjectContentSchema,
  personalProjectCreateSchema, personalProjectSchema, type PersonalProject, type PersonalProjectContent,
  type PersonalProjectCreate, type PersonalProjectMaterialReference, type LearningPage, type LearningDetail } from '@xunjie/contracts/student-learning';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, Facts, ToolCall, ToolContext } from '@xunjie/agent-runtime';
import { completed, errored, json, projectResult, toolFeedbackBytes } from '../../capabilities/tool-support.js';
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
  /** Reauthorize a historical source before it re-enters a home-session model request. */
  historySource?(identity: SpaceIdentity, sessionId: string, source: Facts): Promise<boolean>;
}
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
const subject = (identity: Omit<SpaceIdentity, 'name'>) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const createInputSchema = personalProjectContentSchema.extend({ proposalKey: z.string().min(1).max(200) });
const schemas = { list_learning_tasks: learningPageSchema, search_learning: learningSearchSchema,
  read_learning: learningReadSchema, create_personal_project: createInputSchema };
type ToolName = keyof typeof schemas;
/** Stable names actually assembled by this host, for Skill allowed-tools resolution. */
export const learningToolNames: readonly string[] = Object.keys(schemas);
const descriptions: Record<ToolName, string> = {
  list_learning_tasks: '分页列出宿主当前获准的个人和学校学习任务。缺失截止时间如实标明。',
  search_learning: '在当前获准 owner 中搜索学习任务、作品、实验记录和对话；对话仅作来源资料。',
  read_learning: '按稳定来源、对象和版本重新授权并分段读取。课程 PDF 用 page 指定实际页码，返回固定 readingId 和该页文本。历史引用不代表当前访问权限。',
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
  function workspaceSummary(project: PersonalProject, materialsState: 'adopted' | 'pending' = 'adopted') {
    const workspace = { projectId: project.projectId, activityId: project.activityId, sessionId: project.workspaceSessionId,
      title: project.content.title, goal: project.content.goal, target: project.target, identity: project.identity };
    if (materialsState === 'pending') {
      // Never claim an adopted copy before the material write actually returned a real receipt.
      return { workspace, materials: { status: 'pending', retainedInWorkspace: 0,
        fixedSourceReferences: project.content.materialRefs.length, note: '资料尚未采纳到工作区，待后续补全。' } };
    }
    const retainedLocal = project.content.materialRefs.filter(reference => ['personal-material', 'pdf'].includes(reference.kind)
      && same(reference.owner, project.target) && same(subject(reference.identity), subject(project.identity))).length;
    const materials = { status: 'adopted', retainedInWorkspace: retainedLocal, fixedSourceReferences: project.content.materialRefs.length - retainedLocal,
      note: '本机附件已在工作区独立保留，删除原会话不会破坏这些资料；其余固定来源在读取时重新授权。' };
    return { workspace, materials };
  }

  /** Domain-specific bounded feedback for read_learning; never loses its continuation handle. */
  function readLearningFeedback(detail: LearningDetail): AgentToolResult {
    const originalLength = detail.text.length;
    const reference = json(detail.reference) as Facts;
    let text = detail.text;
    const continuation = (nextOffset: number | null): Facts | undefined => nextOffset === null ? undefined : {
      tool: 'read_learning',
      reference,
      ...(detail.pdf ? { page: detail.pdf.page } : {}),
      range: { offset: nextOffset, length: Math.min(3000, Math.max(0, detail.range.total - nextOffset)) },
    };
    let projection: Facts;
    for (;;) {
      const nextOffset = detail.range.offset + text.length < detail.range.total
        ? detail.range.offset + text.length : null;
      const pdf = detail.pdf ? (text.length === originalLength ? detail.pdf : {
        readingId: detail.pdf.readingId, documentId: detail.pdf.documentId, documentSha256: detail.pdf.documentSha256,
        page: detail.pdf.page, range: detail.pdf.range,
      }) : undefined;
      projection = {
        reference,
        ...(detail.provenance ? { provenance: json(detail.provenance) } : {}),
        ...(pdf ? { pdf } : {}),
        text,
        range: { offset: detail.range.offset, length: text.length, total: detail.range.total, nextOffset },
        missing: detail.missing,
        role: 'source-data',
        ...(continuation(nextOffset) ? { readMore: continuation(nextOffset)! } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(projection), 'utf8') <= toolFeedbackBytes || text.length <= 1) break;
      text = text.slice(0, Math.max(1, Math.floor(text.length * 0.75)));
    }
    // The summary is bounded for the model; the complete fixed-version detail stays in data.
    return completed(JSON.stringify(projection), json(detail));
  }

  async function readTool(name: ToolName, call: ToolCall): Promise<AgentToolResult> {
    let result: unknown;
    if (name === 'read_learning') {
      const input = learningReadSchema.parse(call.input);
      const detail = await host.query.readLearning({ ...input, range: { ...input.range, length: Math.min(input.range.length, 3000) } });
      if (detail.pdf && detail.text) return readLearningFeedback(detail);
      if (input.page) return errored(JSON.stringify({ reference: detail.reference, range: detail.range,
        missing: detail.missing, role: 'source-data' }), json({ reference: detail.reference, range: detail.range,
        missing: detail.missing, role: 'source-data' }));
      result = detail.provenance?.course?.helpPolicy.questions === 'disabled' ? { ...detail, text: '',
        range: { offset: input.range.offset, length: 0, total: 0, nextOffset: null },
        missing: [...new Set([...detail.missing, 'course-agent-help-disabled'])] } : detail;
      return readLearningFeedback(result as LearningDetail);
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
    // Each independent write re-checks the live Turn; a Stop may land after any confirmation read.
    const stopped = async () => { try { await ctx.assertActive(); return false; } catch { return true; } };
    const partial = (project: PersonalProject, pending: 'workspace' | 'materials') => completed(
      JSON.stringify({ ...workspaceSummary(project, pending === 'materials' ? 'adopted' : 'pending'), pending, operationId: project.operationId }),
      json({ operationId: project.operationId, projectId: project.projectId, pending }));
    const failedStage = (project: PersonalProject, pending: 'workspace' | 'materials', error: unknown) => {
      const code = error instanceof StorageError ? error.code : 'unavailable';
      return completed(JSON.stringify({ ...workspaceSummary(project, 'pending'), pending, operationId: project.operationId,
        state: code === 'unavailable' || code === 'upload-unknown' ? 'unknown' : 'error', error: code }),
      json({ operationId: project.operationId, projectId: project.projectId, pending, state: code === 'unavailable' ? 'unknown' : 'error', error: code }));
    };
    const decision = await verifyProjectCreation(
      { sessionId: ctx.sessionId, turnId: ctx.turnId, inputIds: ctx.inputIds, visibleAnswerInputIds: ctx.visibleAnswerInputIds }, identity, content, proposalKey, host.questions);
    if (decision.kind !== 'allow') {
      const reason = decision.kind === 'answer_requires_model_judgment'
        ? '自由文本回答需要主模型在后续 Step 看到真实答案后再判断是否同意；不要猜测同意。'
        : decision.reason;
      return errored(JSON.stringify({ created: false, decision: decision.kind, reason }), json({ decision: decision.kind, reason }));
    }
    // One idempotent business creation per proposal; retrying the same proposal returns the original project.
    const request = personalProjectCreateSchema.parse({ operationId: operationId(`personal-project:${ctx.sessionId}:${proposalKey}`),
      sourceSessionId: ctx.sessionId, inputId: decision.sourceInputId, responseId: decision.questionId, proposalKey, content });
    if (await stopped()) return { kind: 'interrupted', reason: 'turn-stopped' };
    const existing = await host.projects.receipt(identity, request.operationId);
    if (!existing && await stopped()) return { kind: 'interrupted', reason: 'turn-stopped' };
    const project = personalProjectSchema.parse(existing ?? await host.projects.create(identity, request));
    checkProject(project, request);
    // The project is already real; after Stop only retain that fact and never start the next stage.
    if (await stopped()) return partial(project, 'workspace');
    // A receipt that is not ready may only be completed by this explicit write call, never by a read path.
    const workspaceRequestId = operationId(`personal-project-session:${request.operationId}`);
    let session: WorkspaceSessionReceipt | null;
    try {
      session = await host.workspaceSessions.receipt(identity, project.workspaceSessionId);
      if (session) checkSession(session, project);
      if (!session || !session.ready) session = await host.workspaceSessions.ensure(identity, { requestId: workspaceRequestId,
        sessionId: project.workspaceSessionId, activityId: project.activityId, target, title: project.content.title });
    } catch (error) { return failedStage(project, 'workspace', error); }
    if (!session || !session.ready) return partial(project, 'workspace');
    checkSession(session, project);
    if (await stopped()) return partial(project, 'materials');
    const requestId = operationId(`personal-project-materials:${request.operationId}`);
    let materials: ProjectMaterialsReceipt | null;
    try {
      materials = await host.materials.receipt(identity, requestId)
        ?? await host.materials.adopt(identity, { requestId, activityId: project.activityId,
          sourceSessionId: project.sourceSessionId, references: project.content.materialRefs });
    } catch (error) { return failedStage(project, 'materials', error); }
    if (!materials) return partial(project, 'materials');
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
