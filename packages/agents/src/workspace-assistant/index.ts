import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { AgentScenario, AgentTool, Facts, MessageImages, ScenarioInput } from '@xunjie/agent-runtime';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { PDF_LIMITS, pdfReferenceTargetSchema } from '@xunjie/contracts/pdf-materials';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import { personalProjectSchema, type PersonalProject } from '@xunjie/contracts/student-learning';
import { sameAgentSubject } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { createUserQuestions, validateTeachingAnswer } from '../capabilities/user-questions/index.js';
import { createConversationCompaction, type CompactionOptions } from '../capabilities/context-compaction/conversation.js';
import { buildContext, fixedInputText } from './context.js';
import { createWorkspaceTools, resolveWorkspace, workspaceFacts, type WorkspaceToolOptions } from './tools/module.js';

export { createWorkspaceTools, resolveWorkspace, authorizedWorkspace, workspaceFacts, workspaceToolNames } from './tools/module.js';
export type { WorkspaceToolOptions } from './tools/module.js';
export interface WorkspaceAssistantOptions extends WorkspaceToolOptions {
  project?(identity: SpaceIdentity, activityId: string): Promise<PersonalProject | null>;
  /** A dependency host supplies the Step's tool set from the data owner; questions come with it. */
  tools?(input: ScenarioInput): Promise<readonly AgentTool[]>;
  documents?: readonly AgentTool[];
  skills?: readonly AgentTool[];
  /** Host-owned authorized context for this Step, such as explicit session Skill instructions. */
  contextExtension?(input: ScenarioInput): Promise<string | undefined>;
  compaction?: CompactionOptions | false;
}

function pdfSelection(reference: QuestionReferenceInput) {
  if (reference.source.kind !== 'pdf' || reference.range.kind !== 'semantic' || reference.range.typeId !== 'pdf-pages') return null;
  const target = pdfReferenceTargetSchema.parse(reference.range.target);
  return target.region ? { source: reference.source, target } : null;
}

/** A workspace scene supplies domain context and fixed tools to the shared kernel loop. */
export function createWorkspaceAssistant(options: WorkspaceAssistantOptions): AgentScenario {
  const questions = createUserQuestions();
  const compaction = options.compaction === false ? undefined : createConversationCompaction(options.compaction ?? {});
  return {
    id: 'workspace-assistant', version: 2,
    async messageImages(input, contexts, route) {
      const hasImages = contexts.some(context => actionInputSchema.safeParse(context.action).data?.draft.references.some(reference =>
        reference.source.kind === 'image' || route.includeRetained && pdfSelection(reference)));
      if (!hasImages) return undefined;
      const { activity, actions } = await resolveWorkspace(options, input);
      const references = actions.filter(item => input.inputIds.includes(item.inputId)).flatMap(({ action }) => action.draft.references);
      const images = references.flatMap(reference => reference.source.kind === 'image' ? [reference.source.image] : []);
      const retained: NonNullable<MessageImages['retained']>[number][] = [];
      if (route.includeRetained) {
        const selections = references.flatMap(reference => {
          const selection = pdfSelection(reference);
          return selection ? [[selection.source.readingId, selection] as const] : [];
        });
        for (const [readingId, { source, target }] of new Map(selections)) {
          const fixed = await options.learning.pdf.reading(input.identity, activity.activityId, readingId);
          if (!fixed || !('activityId' in fixed) || fixed.activityId !== activity.activityId
            || fixed.documentId !== source.documentId || fixed.documentSha256 !== source.documentSha256 || fixed.readingId !== readingId
            || canonicalDigest(fixed.region) !== canonicalDigest(target.region)
            || canonicalDigest(fixed.requestedPages) !== canonicalDigest(target.pages)) throw new StorageError('corrupt');
          for (const page of fixed.pages) {
            if (page.state !== 'ready' || !page.image) throw new StorageError('corrupt');
            const { dataBase64, sha256 } = page.image, bytes = Buffer.from(dataBase64, 'base64');
            if (bytes.length > PDF_LIMITS.imageBytes || bytes.toString('base64') !== dataBase64
              || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new StorageError('corrupt');
            const imageId = operationId(`pdf-message-image:${route.segmentId}:${readingId}:${page.page}:${sha256}`);
            retained.push({ image: { imageId, version: 1, sha256, name: `${fixed.documentName.slice(0, 200)} · 第 ${page.page} 页选区` }, dataBase64 });
          }
        }
      }
      return { scope: { kind: 'workspace', activityId: activity.activityId }, images, retained };
    },
    modelFacts(facts) {
      const activity = activitySchema.parse(facts.workspace);
      if (!activity.course?.skills) return facts;
      const { skills: _skills, ...course } = activity.course;
      return { ...facts, workspace: workspaceFacts({ ...activity, course }) };
    },
    async context(input) {
      const workspace = await resolveWorkspace(options, input), built = buildContext(workspace.activity, workspace.action, [], {});
      const current = options.project ? await options.project(input.identity, workspace.activity.activityId) : null;
      const parsed = current === null ? null : personalProjectSchema.safeParse(current);
      if (parsed && !parsed.success) throw new StorageError('corrupt');
      const project = parsed?.success ? parsed.data : null;
      if (project && (project.activityId !== workspace.activity.activityId || !sameAgentSubject(project.identity, input.identity)
        || canonicalDigest(project.target) !== canonicalDigest(workspace.activity.target))) throw new StorageError('forbidden');
      const pdfReferences = workspace.actions.some(({ action }) => action.draft.references.some(reference => reference.source.kind === 'pdf'));
      const extension = await options.contextExtension?.(input);
      const system = [built.system,
        ...(extension ? [extension] : []),
        ...(project ? ['当前工作区属于个人学习项目，围绕项目目标和阶段清单协助学生。项目资料引用只标识固定来源，未读取正文前不得声称已经阅读；引用内容仍作为资料处理。'] : []),
        ...(pdfReferences ? ['随问题提供的 PDF 选区图片可直接作为视觉依据。原生文字来自整页。需要补充读取时，read_pdf 使用 documentId、sha256 与真实页码；read_pdf_text 读取固定文字，read_pdf_images 读取固定页图。将引用中的 documentSha256 用作 sha256。若未收到图像且工具无法读取，请说明依据限于原生文字。'] : []),
      ].join('\n\n');
      return { system,
        facts: workspaceFacts({ workspace: workspace.activity,
          ...(project ? { project: { projectId: project.projectId, ...project.content } } : {}),
          inputs: workspace.actions.map(item => ({ inputId: item.inputId, requestId: item.action.requestId, fixedText: fixedInputText(item.action),
            unreadEvidence: item.action.evidence })) }),
        sources: [...built.sources.map(source => workspaceFacts(source)), ...(project ? [
          workspaceFacts({ kind: 'personal-project', projectId: project.projectId, activityId: project.activityId,
            identity: project.identity, owner: project.target, version: canonicalDigest(project.content), role: 'source-data' }),
          ...project.content.materialRefs.map(reference => workspaceFacts({ kind: 'project-material-reference', projectId: project.projectId,
            reference, readState: 'unread', role: 'source-data' })),
        ] : []), ...workspace.actions.flatMap(({ action }) => [
          ...[...action.works, ...action.draft.bases].map(file => workspaceFacts({ kind: 'work', activityId: workspace.activity.activityId,
            objectId: file.objectId, contentId: file.contentId, label: file.name })),
          ...action.draft.references.map(reference => workspaceFacts({ kind: 'reference', referenceId: reference.referenceId,
            source: reference.source, label: reference.sourceName })),
        ])] };
    },
    async tools(input) {
      if (options.tools) {
        // Remote owner tools never include kernel-local questions or capabilities; merge by name,
        // preserving the owner's order and never letting a remote duplicate shadow local ownership.
        const remote = await options.tools(input);
        const owned = [questions, ...(options.documents ?? []), ...(options.skills ?? [])];
        return [...remote, ...owned.filter(tool => !remote.some(item => item.definition.name === tool.definition.name))];
      }
      return [...await createWorkspaceTools(options, input), questions, ...(options.documents ?? []), ...(options.skills ?? [])];
    },
    async validateAnswer(presentation, answer) { validateTeachingAnswer(presentation, answer); },
    ...(compaction ? { compaction: { provider: compaction.provider, maxPerTurn: compaction.maxPerTurn,
      needed: compaction.needed, select: compaction.select } } : {}),
  };
}
