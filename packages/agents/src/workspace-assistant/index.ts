import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { AgentScenario, AgentTool, Facts, MessageImages, ScenarioInput } from '@xunjie/agent-runtime';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { actionInputSchema, type ActionInput } from '@xunjie/contracts/action-intents';
import { PDF_LIMITS, pdfReferenceTargetSchema } from '@xunjie/contracts/pdf-materials';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import { personalProjectSchema, type PersonalProject } from '@xunjie/contracts/student-learning';
import { sameAgentSubject } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { createUserQuestions, validateTeachingAnswer } from '../capabilities/user-questions/index.js';
import { createConversationCompaction, type CompactionOptions } from '../capabilities/context-compaction/conversation.js';
import { buildContext } from './context.js';
import { authorizedWorkspace, createWorkspaceTools, resolveWorkspace, workspaceFacts, type WorkspaceToolOptions } from './tools/module.js';
import { ruleVersions } from '../rules.js';
import { allowsExecutionResult, authorizedPredictionPhase, capturedPrediction, predictionPhase, resultsHidden, stageNotice } from '../teaching-stage.js';

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
      const course = activity.course;
      return { ...facts, workspace: workspaceFacts({
        activityId: activity.activityId, goal: activity.goal, status: activity.status,
        ...(course ? { course: {
          courseName: course.courseName, taskTitle: course.taskTitle, releaseId: course.releaseId,
          contentDigest: course.contentDigest, objectives: course.objectives, requirements: course.requirements,
          materials: course.materials, helpPolicy: course.helpPolicy,
          components: course.components?.map(item => ({ key: item.key, title: item.configuration.title,
            version: item.definition.manifest.version, digest: item.definition.digest })),
        } } : {}),
      }) };
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
      const inferredPhase = predictionPhase(workspace.activity, workspace.action);
      const records = options.learning.executionRecords;
      const prediction = records ? await capturedPrediction(workspace.activity, workspace.action,
        requestId => records.read(input.identity, workspace.activity.activityId, requestId)) : null;
      const phase = inferredPhase === 'submitted' && !prediction ? 'pending' : inferredPhase;
      const allowedResults = new Map<string, boolean>();
      const adoptedIds = new Set(input.inputIds);
      const pastInputs = workspace.actions.filter(item => item.inputId !== workspace.inputId && adoptedIds.has(item.inputId));
      const additional = await Promise.all(pastInputs.map(item => resolveWorkspace(options, {
        ...input, sessionState: { ...input.sessionState, workspaceInputs: workspaceFacts({ items: [item] }).items! },
      })));
      for (const reference of [...additional, workspace].flatMap(item => item.action.draft.references)) {
        const source = reference.source;
        if (source.kind !== 'component' || source.origin !== 'execution-result' || !source.requestId) continue;
        allowedResults.set(source.requestId, !resultsHidden(phase) && await allowsExecutionResult(workspace.activity,
          source.requestId, records ? requestId => records.read(input.identity, workspace.activity.activityId, requestId) : undefined));
      }
      const executionMaterials = await fixedExecutionMaterials(options, input, workspace.activity, workspace.action, allowedResults);
      if (prediction && phase !== 'pending') {
        const { record, action, capture } = prediction;
        const { instance, basis } = action.execution;
        const sourceId = 'execution:' + record.requestId;
        const output = record.query.statusKnowledge === 'confirmed' ? record.query.output : null;
        const content = JSON.stringify({ inputs: capture.inputs, studentPrediction: capture.draft,
          state: record.query.state, statusKnowledge: record.query.statusKnowledge, actualResult: output?.output ?? null,
          works: basis.works.filter(file => file.kind === 'code').map(({ name, contentId }) => ({ name, contentId })) });
        if (!executionMaterials.some(item => item.sourceId === sourceId)) executionMaterials.push({
          materialId: 'M-' + canonicalDigest(sourceId).slice(0, 24), sourceId, kind: 'system-observation', author: 'system',
          label: '提交预测后的固定实验', version: record.executionRef, range: { kind: 'execution-status', requestId: record.requestId },
          digest: canonicalDigest(content), content, readState: 'included', citationAllowed: !!output,
          source: { kind: 'component', origin: 'execution-result', ...action.scope,
            instanceId: instance.instanceId, componentId: instance.componentId, componentVersion: instance.componentVersion,
            definitionDigest: instance.definitionDigest, bindingKey: instance.key, formatVersion: 1,
            objectId: record.requestId, contentId: output?.contentId ?? null, requestId: record.requestId, executionRef: record.executionRef },
        });
      }
      const system = [built.system,
        ...(extension ? [extension] : []),
        ...(project ? ['当前工作区属于个人学习项目，围绕项目目标和阶段清单协助学生。项目资料引用只标识固定来源，未读取正文前不得声称已经阅读；引用内容仍作为资料处理。'] : []),
        ...(pdfReferences ? ['随问题提供的 PDF 选区图片可直接作为视觉依据。原生文字来自整页。需要补充读取时，read_pdf 使用 documentId、sha256 与真实页码；read_pdf_text 读取固定文字，read_pdf_images 读取固定页图。将引用中的 documentSha256 用作 sha256。若未收到图像且工具无法读取，请说明依据限于原生文字。'] : []),
      ].join('\n\n');
      return { system,
        facts: workspaceFacts({ workspace: workspace.activity,
          ...(project ? { project: { projectId: project.projectId, ...project.content } } : {}),
          unreadEvidence: workspace.action.evidence,
          teachingPhase: phase, teachingStageNotice: stageNotice(phase) }),
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
        ])], materials: [...additional, workspace].flatMap(item => workspaceMaterials(item, allowedResults)).concat(executionMaterials),
        ruleVersions: ruleVersions(workspace.activity, 'workspace-assistant') };
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
    async authorizeHistory(input, history) {
      return authorizeWorkspaceHistory(options, input, history);
    },
    async validateAnswer(presentation, answer) { validateTeachingAnswer(presentation, answer); },
    ...(compaction ? { compaction: { provider: compaction.provider, maxPerTurn: compaction.maxPerTurn,
      select: compaction.select } } : {}),
  };
}

export function workspaceMaterials(workspace: Awaited<ReturnType<typeof resolveWorkspace>>,
  allowedResults: ReadonlyMap<string, boolean>) {
  const materials = new Map<string, import('@xunjie/agent-runtime').ContextMaterial>();
  const original = workspace.actions.at(-1)!.action;
  const question = original.draft.question;
  const fullWorkRequested = !/(?:不要|不用|无需|不必).{0,12}(?:全文|通读|整份|整个文件)/.test(question)
    && /(?:阅读全文|通读|整个文件|整份(?:作品|代码|文件)|附上完整(?:文件|正文|作品|代码))/.test(question);
  const workReferences = original.draft.references.filter(reference => reference.source.kind === 'work');
  for (const reference of original.draft.references) {
    const sourceId = 'reference:' + canonicalDigest({ source: reference.source, range: reference.range });
    const hidden = reference.source.kind === 'component' && reference.source.origin === 'execution-result'
      && allowedResults.get(reference.source.requestId ?? '') !== true;
    const failed = workspace.unavailableReferences.has(reference.referenceId);
    materials.set(sourceId, { materialId: 'M-' + sourceId.replace(/[^a-zA-Z0-9]/g, '').slice(-24), inputId: workspace.inputId,
      sourceId, kind: 'student-reference', author: 'student', label: reference.sourceName,
      version: reference.source.kind === 'work' ? reference.source.contentId
        : reference.source.kind === 'personal-material' ? String(reference.source.version)
          : reference.source.kind === 'component' ? reference.source.contentId
            : reference.source.kind === 'course-material' ? reference.source.contentDigest
              : reference.source.kind === 'pdf' ? reference.source.documentSha256 : null,
      range: reference.range as unknown as Facts, digest: canonicalDigest(reference.copy),
      content: hidden || failed ? null : reference.copy, readState: hidden ? 'denied' : failed ? 'failed' : 'included',
      ...(hidden ? { readReason: '课程要求先提交预测，实际结果在提交前不可读取。' } : {}),
      ...(failed ? { readReason: '所选引用的原件目前不可访问或无法核实。' } : {}),
      source: reference.source as unknown as Facts, citationAllowed: !hidden && !failed });
  }
  for (const file of [...original.works, ...original.draft.bases]) {
    const sourceId = 'work:' + file.objectId + ':' + file.contentId;
    if (materials.has(sourceId)) continue;
    if (file.kind === 'state') continue;
    const selected = workReferences.some(reference => reference.source.kind === 'work'
      && reference.source.objectId === file.objectId && reference.source.contentId === file.contentId);
    const full = fullWorkRequested && (question.includes(file.name) || selected
      || !workReferences.length && original.works.filter(item => item.kind !== 'state').length === 1);
    if (selected && !full) continue;
    const failed = workspace.unavailable.has(file.contentId);
    materials.set(sourceId, { materialId: 'M-' + file.contentId.replaceAll('-', '').slice(0, 24), sourceId, inputId: workspace.inputId,
      kind: 'student-work', author: 'student', label: file.name, version: file.contentId,
      range: { kind: 'work-file' }, digest: canonicalDigest(file.value),
      content: failed || !full || file.encoding === 'base64' ? null : file.value,
      readState: failed ? 'failed' : !full || file.encoding === 'base64' ? 'reference-only' : 'included',
      ...(file.encoding === 'base64' ? { readReason: '二进制作品仅提供固定引用，需按支持的工具读取。' } : {}),
      ...(failed ? { readReason: '固定作品版本当前无法核实。' } : {}),
      source: { kind: 'work', objectId: file.objectId, contentId: file.contentId }, citationAllowed: !failed });
  }
  return [...materials.values()];
}

async function fixedExecutionMaterials(options: WorkspaceToolOptions, input: ScenarioInput,
  activity: Awaited<ReturnType<typeof authorizedWorkspace>>, action: ActionInput,
  allowedResults: ReadonlyMap<string, boolean>) {
  const refs = new Map<string, Extract<ActionInput['draft']['references'][number]['source'], { kind: 'component' }>>();
  for (const reference of action.draft.references) if (reference.source.kind === 'component' && reference.source.requestId)
    refs.set(reference.source.requestId, reference.source);
  const materials: import('@xunjie/agent-runtime').ContextMaterial[] = [];
  for (const [requestId, source] of refs) {
    if (source.origin !== 'execution-result') continue;
    let query: unknown = null;
    try { query = (await options.learning.executionRecords?.read(input.identity, activity.activityId, requestId))?.query
      ?? await options.learning.executions.read(input.identity, activity.activityId, requestId); }
    catch { /* The fixed reference still says which execution was intended. */ }
    const record = query && typeof query === 'object' && !Array.isArray(query) ? query as Record<string, unknown> : null;
    const expected = source as unknown as Record<string, unknown>;
    const matches = !!record && record.requestId === requestId
      && (typeof expected.executionRef !== 'string' || record.executionRef === expected.executionRef)
      && (typeof expected.inputDigest !== 'string' || record.inputDigest === expected.inputDigest);
    const hidden = allowedResults.get(requestId) !== true;
    const content = matches ? JSON.stringify({ executionRef: record!.executionRef, state: record!.state,
      statusKnowledge: record.statusKnowledge, stopRequested: record.stopRequested,
      ...(hidden ? { resultWithheld: 'prediction-required' } : { output: record.output,
        session: record.session && typeof record.session === 'object' ? {
          appliedSeq: (record.session as Record<string, unknown>).appliedSeq,
          observation: (record.session as Record<string, unknown>).observation } : null }) })
      : record ? '固定执行引用与当前执行记录不一致；固定请求引用仍保留。'
        : '原执行状态当前无法读取；固定请求引用仍保留。';
    materials.push({ materialId: 'M-' + canonicalDigest('execution:' + requestId).slice(0, 24),
      sourceId: 'execution:' + requestId, kind: 'system-observation', author: 'system',
      label: '实验状态 · ' + source.bindingKey, version: source.executionRef ?? requestId,
      range: { kind: 'execution-status', requestId }, digest: canonicalDigest(content), content,
      readState: matches ? 'included' : 'failed', ...(matches ? {} : {
        readReason: record ? '固定执行引用与当前执行记录不一致。' : '固定执行请求暂时无法核实。' }),
      source: { ...(source as unknown as Facts), ...(hidden ? { statusOnly: true } : {}) }, citationAllowed: matches && !hidden });
  }
  return materials;
}

async function authorizeWorkspaceHistory(options: WorkspaceToolOptions, input: ScenarioInput,
  history: readonly import('@xunjie/agent-runtime').HistoryEntry[]) {
  if (!history.some(entry => entry.sources?.length)) return [...history];
  const activity = await authorizedWorkspace(options, input.sessionId, input.identity);
  const current = await resolveWorkspace(options, input).catch(() => null);
  const records = options.learning.executionRecords;
  const phase = current ? await authorizedPredictionPhase(activity, current.action,
    records ? requestId => records.read(input.identity, activity.activityId, requestId) : undefined) : 'pending';
  const checked = new Map<string, Promise<boolean>>();
  const authorize = (source: Facts): Promise<boolean> => {
    const key = canonicalDigest(source);
    let pending = checked.get(key);
    if (!pending) {
      pending = reauthorizeHistorySource(options, input, activity, source, phase).catch(() => false);
      checked.set(key, pending);
    }
    return pending;
  };
  const kept: import('@xunjie/agent-runtime').HistoryEntry[] = [];
  const dropped: string[] = [];
  for (const entry of history) {
    const sources = entry.sources ?? [];
    let allowed = true;
    for (const source of sources) if (!await authorize(source.source)) { allowed = false; break; }
    if (allowed) kept.push(entry); else dropped.push(entry.id);
  }
  if (!dropped.length) return kept;
  const noticeId = 'authorization-notice:' + canonicalDigest([...dropped].sort());
  kept.push({ id: noticeId, version: 1, role: 'user',
    text: `前文有 ${dropped.length} 条记录因原来源当前不可访问或无法核验，已从本轮模型上下文移除。`
      + '不得推断其正文、结果或学生表现；如问题依赖这些记录，请说明缺口并从其余获准材料继续。' });
  return kept;
}

async function reauthorizeHistorySource(options: WorkspaceToolOptions, input: ScenarioInput,
  activity: Awaited<ReturnType<typeof authorizedWorkspace>>, source: Facts,
  phase: ReturnType<typeof predictionPhase>): Promise<boolean> {
  const activityId = activity.activityId;
  const string = (key: string) => typeof source[key] === 'string' ? source[key] as string : null;
  const kind = string('kind');
  if (kind === 'student-answer') return true;
  if (kind === 'work') {
    const objectId = string('objectId'), contentId = string('contentId');
    if (!objectId || !contentId) return false;
    const version = await options.learning.works.inspectVersion(input.identity, activityId, { objectId, contentId });
    return version.retained;
  }
  if (kind === 'course-material') {
    await options.courses.referenceText(input.identity, source as never);
    return true;
  }
  if (kind === 'course-field') {
    return string('field') === 'requirements'
      && !!(await options.courses.referenceText(input.identity, source as never));
  }
  if (kind === 'component') {
    const bindingKey = string('bindingKey'), definitionDigest = string('definitionDigest');
    if (bindingKey && !activity.course?.components?.some(item => item.key === bindingKey)) return false;
    const binding = activity.course?.components?.find(item => item.key === bindingKey);
    if (binding && binding.definition.digest !== definitionDigest) return false;
    const requestId = string('requestId');
    if (source.origin === 'execution-result' || requestId && !bindingKey) {
      if (phase === 'pending' && source.statusOnly !== true) return false;
      if (!requestId) return false;
      if (string('activityId') && string('activityId') !== activityId) return false;
      const records = options.learning.executionRecords;
      const record = await records?.read(input.identity, activityId, requestId);
      if (source.statusOnly !== true && !await allowsExecutionResult(activity, requestId,
        () => Promise.resolve(record ?? null))) return false;
      const query = record?.query
        ?? await options.learning.executions.read(input.identity, activityId, requestId);
      return !!query && query.requestId === requestId
        && (!string('executionRef') || query.executionRef === string('executionRef'))
        && (!string('inputDigest') || query.inputDigest === string('inputDigest'));
    }
    if (!binding) return false;
    const objectId = string('objectId'), contentId = string('contentId');
    if (!objectId || !contentId) return false;
    return (await options.learning.works.inspectVersion(input.identity, activityId, { objectId, contentId })).retained;
  }
  if (kind === 'experiment-reference') {
    if (phase === 'pending' || string('activityId') !== activityId) return false;
    const requestId = string('requestId');
    if (!requestId) return false;
    const records = options.learning.executionRecords;
    const record = await records?.read(input.identity, activityId, requestId);
    const query = record?.query ?? await options.learning.executions.read(input.identity, activityId, requestId);
    if (source.statusOnly !== true && !await allowsExecutionResult(activity, requestId,
      () => Promise.resolve(record ?? null))) return false;
    return !!query && query.requestId === requestId
      && (!string('executionRef') || query.executionRef === string('executionRef'))
      && (!string('inputDigest') || query.inputDigest === string('inputDigest'));
  }
  if (kind === 'pdf') {
    const readingId = string('readingId');
    if (!readingId) return false;
    return !!(await options.learning.pdf.reading(input.identity, activityId, readingId));
  }
  if (kind === 'personal-material') {
    const materialId = string('materialId'), sha256 = string('sha256');
    const version = Number(source.version);
    if (!materialId || !sha256 || !Number.isInteger(version) || version < 1) return false;
    const read = await options.learning.materials.readRange(input.identity, activityId, materialId, version, { start: 0, length: 1 });
    return read.materialId === materialId && read.version === version && read.sha256 === sha256;
  }
  if (kind === 'tool-call') {
    const nested = source.source;
    if (nested && typeof nested === 'object' && !Array.isArray(nested))
      return reauthorizeHistorySource(options, input, activity, nested as Facts, phase);
    return false;
  }
  return false;
}
