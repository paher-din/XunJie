import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { learningTargetSchema, spaceIdentitySchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { learningPageSchema, learningReadSchema, learningSearchSchema, personalProjectContentSchema,
  personalProjectCreateSchema, personalProjectSchema, type PersonalProject, type PersonalProjectContent,
  type PersonalProjectCreate, type PersonalProjectMaterialReference, type LearningPage, type LearningDetail } from '@xunjie/contracts/student-learning';
import type { Facts } from '@xunjie/agent-runtime';
import type { ConversationToolContext, ConversationToolModule, ConversationToolOutcome, ConversationPreparedTool } from '../../conversation/tools.js';

export type LearningCreationAuthorization = { kind: 'explicit'; inputId: string }
  | { kind: 'confirmed'; inputId: string; waitId: string; responseDigest: string };
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
  /** Classifies the actual current user input or its corresponding question/answer, never model arguments. */
  authorizeCreation(context: ConversationToolContext, content: PersonalProjectContent): Promise<LearningCreationAuthorization | null>;
  workspaceSessions: {
    /** Repeating this exact request completes initialization at the original session owner. */
    ensure(identity: SpaceIdentity, input: { requestId: string; sessionId: string; activityId: string; target: LearningTarget; title: string }): Promise<WorkspaceSessionReceipt>;
    receipt(identity: SpaceIdentity, sessionId: string): Promise<WorkspaceSessionReceipt | null>;
  };
  materials: {
    /** Must retain an independent workspace association and freshly authorize fixed source versions. */
    adopt(identity: SpaceIdentity, input: { requestId: string; activityId: string; sourceSessionId: string; references: PersonalProjectMaterialReference[] }): Promise<ProjectMaterialsReceipt>;
    receipt(identity: SpaceIdentity, requestId: string): Promise<ProjectMaterialsReceipt | null>;
  };
}
const json = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
const subject = (identity: Omit<SpaceIdentity, 'name'>) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const schemas = { list_learning_tasks: learningPageSchema, search_learning: learningSearchSchema,
  read_learning: learningReadSchema, create_personal_project: personalProjectContentSchema };
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  list_learning_tasks: '分页列出宿主当前获准的个人和学校学习任务。缺失截止时间如实标明。',
  search_learning: '在当前获准 owner 中搜索学习任务、作品、实验记录和对话；对话仅作来源资料。',
  read_learning: '按稳定来源、对象和版本重新授权并分段读取。历史引用不代表当前访问权限。',
  create_personal_project: '用户本轮明确要求或回答对应问题确认后，创建一个本机个人自主学习项目及独立工作区。只提交标题、目标、阶段和固定资料引用。',
};
const authorizationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit'), inputId: z.uuid() }).strict(),
  z.object({ kind: z.literal('confirmed'), inputId: z.uuid(), waitId: z.uuid(), responseDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const preparedCreateSchema = z.object({ request: personalProjectCreateSchema, authorization: authorizationSchema,
  identity: spaceIdentitySchema, target: learningTargetSchema,
  resume: z.object({ stage: z.enum(['workspace', 'materials']), attempt: z.number().int().min(1).max(64) }).strict().optional(),
}).strict();
type PreparedCreation = z.infer<typeof preparedCreateSchema>;
type CreationContinuation = ConversationToolOutcome & { nextCommand: ConversationPreparedTool };
const continuationId = (root: string, stage: 'workspace' | 'materials', attempt: number) =>
  operationId(`personal-project-continuation:${root}:${stage}:${attempt}`);

/** Concrete scenario module; the conversation pipeline owns binding IDs and result/card projection. */
export function createLearningTools(host: LearningToolsHost): ConversationToolModule {
  const identity = spaceIdentitySchema.parse(host.localPersonalIdentity), target = learningTargetSchema.parse(host.localLearningTarget);
  if (identity.kind !== 'personal') throw new StorageError('forbidden');
  function effect(name: string) { return name === 'create_personal_project' ? 'write' as const : 'read' as const; }
  function nameOf(name: string): ToolName {
    if (!Object.hasOwn(schemas, name)) throw new StorageError('invalid');
    return name as ToolName;
  }
  function checkContext(context: ConversationToolContext) {
    if (context.snapshot.session.scenario !== 'student-assistant'
      || context.snapshot.run.sessionId !== context.snapshot.session.sessionId) throw new StorageError('forbidden');
  }
  async function authorization(context: ConversationToolContext, content: PersonalProjectContent) {
    checkContext(context);
    const candidate = authorizationSchema.safeParse(await host.authorizeCreation(context, content));
    if (!candidate.success) throw new StorageError('forbidden');
    const evidence = candidate.data;
    const input = context.snapshot.inputs.find(input => input.inputId === evidence.inputId);
    if (!input || input.input.sessionId !== context.snapshot.session.sessionId
      || evidence.kind === 'explicit' && !context.inputIds.includes(evidence.inputId))
      throw new StorageError('forbidden');
    if (evidence.kind === 'confirmed') {
      // A response-only model turn has no new CoreInput; the retained wait binds its original input.
      const wait = context.snapshot.waits.find(wait => wait.waitId === evidence.waitId);
      if (!wait || wait.runId !== context.snapshot.run.runId || wait.state !== 'consumed' || !wait.response
        || wait.presentation.sourceInputId !== evidence.inputId || canonicalDigest(wait.response) !== evidence.responseDigest
        || wait.response.kind === 'skip') throw new StorageError('forbidden');
    }
    return evidence;
  }
  function request(command: ConversationPreparedTool) {
    if (command.name !== 'create_personal_project' || command.effect !== 'write') throw new StorageError('invalid');
    const prepared = preparedCreateSchema.parse(command.input);
    const expected = prepared.resume ? continuationId(prepared.request.operationId, prepared.resume.stage, prepared.resume.attempt) : prepared.request.operationId;
    if (expected !== command.commandId || !same(subject(prepared.identity), subject(identity))
      || !same(prepared.target, target)) throw new StorageError('forbidden');
    return prepared;
  }
  function checkProject(project: PersonalProject, input: z.infer<typeof preparedCreateSchema>['request']) {
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
  function completed(project: PersonalProject): ConversationToolOutcome {
    const workspace = { projectId: project.projectId, activityId: project.activityId, sessionId: project.workspaceSessionId,
      title: project.content.title, goal: project.content.goal, target: project.target, identity: project.identity };
    const retainedLocal = project.content.materialRefs.filter(reference => ['personal-material', 'pdf'].includes(reference.kind)
      && same(reference.owner, project.target) && same(subject(reference.identity), subject(project.identity))).length;
    const materials = { retainedInWorkspace: retainedLocal, fixedSourceReferences: project.content.materialRefs.length - retainedLocal,
      note: '本机附件已在工作区独立保留，删除原会话不会破坏这些资料；其余固定来源在读取时重新授权。' };
    return { state: 'completed', feedback: { outcome: 'success', text: JSON.stringify({ workspace, materials }), images: [] },
      result: json({ operationId: project.operationId, workspace, materials }) };
  }
  async function pending(context: ConversationToolContext, prepared: PreparedCreation, stage: 'workspace' | 'materials'): Promise<CreationContinuation> {
    if (!same(await authorization(context, prepared.request.content), prepared.authorization)) throw new StorageError('forbidden');
    const attempt = (prepared.resume?.attempt ?? 0) + 1;
    if (attempt > 64) throw new StorageError('conflict');
    // This is a read-only proposal. Only a subsequent Core dispatch may execute its writes.
    return { state: 'unknown', feedback: { outcome: 'not-executed', text: '项目已保留，工作区准备尚待完成。', images: [] },
      result: { operationId: prepared.request.operationId }, nextCommand: {
        commandId: continuationId(prepared.request.operationId, stage, attempt), name: 'create_personal_project', effect: 'write',
        input: json({ ...prepared, resume: { stage, attempt } }),
      } };
  }
  async function readTool(command: ConversationPreparedTool): Promise<ConversationToolOutcome> {
    const name = nameOf(command.name);
    if (command.effect !== 'read' || name === 'create_personal_project') throw new StorageError('invalid');
    let result: unknown;
    if (name === 'read_learning') {
      const input = learningReadSchema.parse(command.input);
      const detail = await host.query.readLearning({ ...input, range: { ...input.range, length: Math.min(input.range.length, 4000) } });
      result = detail.provenance?.course?.helpPolicy.questions === 'disabled' ? { ...detail, text: '',
        range: { offset: input.range.offset, length: 0, total: 0, nextOffset: null },
        missing: [...new Set([...detail.missing, 'course-agent-help-disabled'])] } : detail;
    } else {
      const input = schemas[name].parse(command.input);
      const args = { ...input, limit: Math.min(input.limit, 6) };
      const page = name === 'list_learning_tasks' ? await host.query.listLearningTasks(args) : await host.query.searchLearning(args);
      result = { ...page, items: page.items.map(item => item.provenance?.course?.helpPolicy.questions === 'disabled'
        ? { ...item, excerpt: '', missing: [...new Set([...item.missing, 'course-agent-help-disabled'])] } : item) };
    }
    if (name !== 'read_learning') {
      const page = result as LearningPage;
      // Keep every emitted reference intact, and resume at the first omitted entry.
      while (JSON.stringify(page).length > 8192 && page.items.length > 1) {
        page.items.pop(); page.nextOffset = page.offset + page.items.length;
      }
    }
    const data = json(result), text = JSON.stringify(data);
    if (text.length > 8192) throw new StorageError('invalid');
    return { state: 'completed', feedback: { outcome: 'success', text, images: [] }, result: data };
  }
  return { id: 'student-learning', version: 1,
    async list(context) {
      checkContext(context);
      return (Object.keys(schemas) as ToolName[]).map(name => ({
        definition: { name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], {
          // Pagination/range defaults are optional model inputs, not required parsed-output fields.
          io: 'input',
          // z.uuid() also emits its pattern. The gateway's strict JSON Schema compiler has no format plugin.
          override({ jsonSchema }) { if (jsonSchema.format === 'uuid') delete jsonSchema.format; },
        }), strict: false },
        effect: effect(name), scope: name === 'create_personal_project' ? json({ identity, target }) : { sources: 'host-current' },
      }));
    },
    async prepare(context, offer, intent, commandId) {
      checkContext(context); z.uuid().parse(commandId);
      const name = nameOf(intent.name);
      if (offer.definition.name !== name || offer.effect !== effect(name)) throw new StorageError('forbidden');
      const parsed = schemas[name].parse(intent.arguments);
      if (name !== 'create_personal_project') return { commandId, name, effect: 'read', input: json(parsed) };
      const content = personalProjectContentSchema.parse(parsed), evidence = await authorization(context, content);
      const input = personalProjectCreateSchema.parse({ operationId: commandId, sourceSessionId: context.snapshot.session.sessionId,
        inputId: evidence.inputId, ...(evidence.kind === 'confirmed' ? { responseId: evidence.waitId } : {}), content });
      return { commandId, name, effect: 'write', input: json({ request: input, authorization: evidence, identity, target }) };
    },
    async dispatch(context, command, permit, assertDispatch) {
      checkContext(context);
      if (permit.sessionId !== context.snapshot.session.sessionId || permit.runId !== context.snapshot.run.runId)
        throw new StorageError('forbidden');
      if (command.name !== 'create_personal_project') { await assertDispatch(); return readTool(command); }
      const prepared = request(command);
      if (permit.operationId !== command.commandId) throw new StorageError('forbidden');
      if (prepared.request.sourceSessionId !== context.snapshot.session.sessionId
        || !same(await authorization(context, prepared.request.content), prepared.authorization)) throw new StorageError('forbidden');
      await assertDispatch();
      const project = personalProjectSchema.parse(prepared.resume
        ? await host.projects.receipt(identity, prepared.request.operationId) : await host.projects.create(identity, prepared.request));
      checkProject(project, prepared.request);
      await assertDispatch();
      const session = prepared.resume?.stage === 'materials'
        ? await host.workspaceSessions.receipt(identity, project.workspaceSessionId)
        : await host.workspaceSessions.ensure(identity, { requestId: operationId(`personal-project-session:${prepared.request.operationId}`),
          sessionId: project.workspaceSessionId, activityId: project.activityId, target, title: project.content.title });
      if (!session) return pending(context, prepared, 'workspace');
      checkSession(session, project);
      if (!session.ready) return pending(context, prepared, 'workspace');
      await assertDispatch();
      const requestId = operationId(`personal-project-materials:${prepared.request.operationId}`);
      const materialReceipt = await host.materials.adopt(identity, { requestId, activityId: project.activityId,
        sourceSessionId: project.sourceSessionId, references: project.content.materialRefs });
      checkMaterials(materialReceipt, project, requestId);
      await assertDispatch();
      return completed(project);
    },
    async reconcile(context, command) {
      checkContext(context);
      if (command.name !== 'create_personal_project') return readTool(command);
      const prepared = request(command);
      if (prepared.request.sourceSessionId !== context.snapshot.session.sessionId) throw new StorageError('forbidden');
      const project = await host.projects.receipt(identity, prepared.request.operationId);
      if (!project) return null;
      checkProject(project, prepared.request);
      const session = await host.workspaceSessions.receipt(identity, project.workspaceSessionId);
      if (!session) return pending(context, prepared, 'workspace');
      checkSession(session, project);
      if (!session.ready) return pending(context, prepared, 'workspace');
      const requestId = operationId(`personal-project-materials:${prepared.request.operationId}`);
      const materials = await host.materials.receipt(identity, requestId);
      if (!materials) return pending(context, prepared, 'materials');
      checkMaterials(materials, project, requestId);
      return completed(project);
    },
  };
}
