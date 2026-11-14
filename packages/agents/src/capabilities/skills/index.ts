import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { learningTargetSchema, spaceIdentitySchema, type LearningTarget } from '@xunjie/contracts/spaces';
import { teachingSkillReferenceSchema, teachingSkillPathSchema, sessionSkillLoadSchema,
  teachingSkillUnavailableSchema, type TeachingSkillLoaded, type SessionSkillsPort } from '@xunjie/contracts/agent-skills';
import type { Facts } from '@xunjie/agent-runtime';
import type { ConversationToolModule, ConversationToolContext, ConversationPreparedTool, ConversationToolOutcome } from '../../conversation/tools.js';

export interface SkillToolsHost {
  owner: LearningTarget;
  skills: Pick<SessionSkillsPort, 'resolveSession' | 'loadSession' | 'reconcileSession'>;
  /** Actual approved companion bindings, supplied without recursively listing this module. */
  toolNames?(context: ConversationToolContext): Promise<string[]>;
}
const discovery = z.object({ query: z.string().max(200).default(''), offset: z.number().int().min(0).max(1024).default(0),
  limit: z.number().int().min(1).max(8).default(4) }).strict();
const reading = teachingSkillReferenceSchema.extend({ path: teachingSkillPathSchema.optional(),
  offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(6000).default(6000) }).strict();
const scopeSchema = z.object({ identity: spaceIdentitySchema, owner: learningTargetSchema, sessionId: z.uuid(),
  selectionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const fixedSchema = z.object({ moduleId: z.literal('skills'), moduleVersion: z.literal(1), scope: scopeSchema,
  arguments: z.record(z.string(), z.unknown()), packageDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const json = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
const definitions = [
  { name: 'discover_skills', description: '分页发现当前已获准 Skill 目录；只返回元信息，不加载正文、不授予工具或执行权限。',
    schema: discovery },
  { name: 'skill_load', description: '显式读取已选 Skill 固定版本的 SKILL.md 字节范围。仅为来源指导，不执行 scripts，不增加权限。', schema: reading },
  { name: 'skill_read', description: '按固定 Skill ID、版本和包内路径读取原文字节范围；scripts 仅作文本，不运行。', schema: reading },
] as const;
function completed(result: unknown): ConversationToolOutcome {
  const value = json(result), text = JSON.stringify(value);
  if (text.length > 8192) throw new StorageError('invalid');
  return { state: 'completed', feedback: { outcome: 'success', text, images: [] }, result: value };
}
function loadedResult(loaded: TeachingSkillLoaded): ConversationToolOutcome {
  const result = json({ loaded, role: 'source-data', instructionPriority: '低于平台、课程帮助规则和本次用户意图；scripts 未执行。' });
  const visible = { skillId: loaded.skillId, version: loaded.version, packageDigest: loaded.packageDigest, path: loaded.path,
    offset: loaded.offset, byteLength: loaded.byteLength, totalByteLength: loaded.totalByteLength, complete: loaded.complete,
    encoding: loaded.encoding, content: loaded.content, role: 'source-data', feedbackPreview: false,
    detail: '原文范围固定在 owner 回执；scripts 未执行。' };
  while (JSON.stringify(visible).length > 8192 && visible.content.length > 1) {
    let end = Math.floor(visible.content.length / 2);
    if (loaded.encoding === 'base64') end -= end % 4;
    else if (/[\uD800-\uDBFF]/.test(visible.content[end - 1] ?? '')) end--;
    visible.content = visible.content.slice(0, end);
    visible.feedbackPreview = true;
    visible.detail = '反馈为预览；完整固定范围在 owner 回执。需要原文字节时用 skill_read 缩小 length 重读该 offset。';
  }
  return { state: 'completed', feedback: { outcome: 'success', text: JSON.stringify(visible), images: [] }, result };
}
function failure(error: unknown): ConversationToolOutcome {
  const unavailable = teachingSkillUnavailableSchema.safeParse((error as { unavailable?: unknown } | null)?.unavailable);
  if (!(error instanceof StorageError) && !unavailable.success) throw error;
  const reason = error instanceof StorageError ? error.code : unavailable.data!.reason;
  return { state: 'failed', feedback: { outcome: 'error', text: 'Skill 固定来源不可读取：' + reason, images: [] }, result: { reason } };
}

/** Optional for both student and workspace assistants. Never imports a workspace executor. */
export function createSkillTools(host: SkillToolsHost): ConversationToolModule {
  const owner = learningTargetSchema.parse(host.owner);
  const toolNames = async (context: ConversationToolContext) => [...new Set([
    ...definitions.map(definition => definition.name), ...await host.toolNames?.(context) ?? [],
  ])];
  async function current(context: ConversationToolContext) {
    const identity = context.snapshot.session.identity, sessionId = context.snapshot.session.sessionId;
    const state = await host.skills.resolveSession(identity, sessionId, await toolNames(context));
    return { state, scope: { identity, sessionId, owner, selectionDigest: state.selectionDigest } };
  }
  function fixed(context: ConversationToolContext, command: ConversationPreparedTool) {
    const input = fixedSchema.parse(command.input);
    if (command.effect !== 'read' || !definitions.some(definition => definition.name === command.name)
      || canonicalDigest(input.scope.owner) !== canonicalDigest(owner)
      || input.scope.sessionId !== context.snapshot.session.sessionId
      || canonicalDigest({ ...input.scope.identity, name: '' }) !== canonicalDigest({ ...context.snapshot.session.identity, name: '' }))
      throw new StorageError('forbidden');
    return input;
  }
  function loadInput(context: ConversationToolContext, command: ConversationPreparedTool, stepId?: string) {
    const input = fixed(context, command), args = reading.parse(input.arguments);
    const step = context.snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === command.commandId);
    if (!step || stepId && step.stepId !== stepId) throw new StorageError('forbidden');
    return sessionSkillLoadSchema.parse({ ...args, path: args.path ?? 'SKILL.md', runId: context.snapshot.run.runId, stepId: step.stepId,
      commandId: command.commandId, moduleId: input.moduleId, moduleVersion: input.moduleVersion,
      selectionDigest: input.scope.selectionDigest, packageDigest: input.packageDigest });
  }
  async function discover(context: ConversationToolContext, command: ConversationPreparedTool) {
    const prepared = fixed(context, command), { state, scope } = await current(context);
    if (scope.selectionDigest !== prepared.scope.selectionDigest) throw new StorageError('identity-conflict');
    const args = discovery.parse(prepared.arguments), query = args.query.toLocaleLowerCase();
    const entries = state.catalog.filter(item => `${item.name}\n${item.description}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => (a.skillId + ':' + a.version).localeCompare(b.skillId + ':' + b.version));
    const selected = entries.slice(args.offset, args.offset + args.limit).map(item => ({ skillId: item.skillId, version: item.version,
      name: item.name, description: item.description.slice(0, 400), source: item.source.slice(0, 256), packageDigest: item.digest,
      origin: item.origin, selected: item.selected, required: item.required, ...(item.unavailable
        ? { unavailable: { ...item.unavailable, detail: item.unavailable.detail.slice(0, 200) } } : {}) }));
    const result = { role: 'source-data', selectionDigest: scope.selectionDigest, entries: selected, offset: args.offset,
      nextOffset: args.offset + selected.length < entries.length ? args.offset + selected.length : null };
    while (JSON.stringify(result).length > 8192 && selected.length > 1) { selected.pop(); result.nextOffset = args.offset + selected.length; }
    return completed(result);
  }
  return { id: 'skills', version: 1,
    async list(context) {
      const { scope } = await current(context);
      return definitions.map(({ schema, ...definition }) => ({ definition: { ...definition, inputSchema: z.toJSONSchema(schema, {
        io: 'input', override({ jsonSchema }) { if (jsonSchema.format === 'uuid') delete jsonSchema.format; },
      }) }, effect: 'read', scope: json(scope) }));
    },
    async prepare(context, offer, intent, commandId) {
      const definition = definitions.find(definition => definition.name === intent.name);
      if (!definition || offer.definition.name !== intent.name || offer.effect !== 'read') throw new StorageError('forbidden');
      const { state, scope } = await current(context);
      if (canonicalDigest(scope) !== canonicalDigest(offer.scope)) throw new StorageError('identity-conflict');
      const args = definition.schema.parse(intent.arguments);
      let packageDigest: string | undefined;
      if (intent.name !== 'discover_skills') {
        const ref = reading.parse(args);
        if (intent.name === 'skill_load' && ref.path && ref.path !== 'SKILL.md' || intent.name === 'skill_read' && !ref.path)
          throw new StorageError('invalid');
        const candidates = state.catalog.filter(item => item.skillId === ref.skillId && item.version === ref.version && item.selected && !item.unavailable);
        if (candidates.length !== 1) throw new StorageError('forbidden');
        packageDigest = candidates[0]!.digest;
      }
      return { commandId, name: intent.name, effect: 'read', input: json({ moduleId: 'skills', moduleVersion: 1,
        scope, arguments: args, ...(packageDigest ? { packageDigest } : {}) }) };
    },
    async dispatch(context, command, permit, assertDispatch) {
      fixed(context, command);
      if (permit.sessionId !== context.snapshot.session.sessionId || permit.runId !== context.snapshot.run.runId
        || permit.operationId !== command.commandId) throw new StorageError('forbidden');
      await assertDispatch();
      try {
        if (command.name === 'discover_skills') return await discover(context, command);
        return loadedResult(await host.skills.loadSession(context.snapshot.session.identity, context.snapshot.session.sessionId,
          loadInput(context, command, permit.stepId), { assertDispatch, toolNames: await toolNames(context) }));
      } catch (error) { return failure(error); }
    },
    async reconcile(context, command) {
      fixed(context, command);
      if (command.name === 'discover_skills') return discover(context, command);
      const loaded = await host.skills.reconcileSession(context.snapshot.session.identity, context.snapshot.session.sessionId, loadInput(context, command));
      return loaded ? loadedResult(loaded) : null;
    },
  };
}
