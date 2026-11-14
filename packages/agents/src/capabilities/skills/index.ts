import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { learningTargetSchema, type LearningTarget } from '@xunjie/contracts/spaces';
import { teachingSkillReferenceSchema, teachingSkillPathSchema, sessionSkillLoadSchema,
  teachingSkillUnavailableSchema, type TeachingSkillLoaded, type SessionSkillsPort } from '@xunjie/contracts/agent-skills';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, ToolCall, ToolContext } from '@xunjie/agent-runtime';
import { completed, errored, json } from '../tool-support.js';

export interface SkillToolsHost {
  owner: LearningTarget;
  skills: Pick<SessionSkillsPort, 'resolveSession' | 'loadSession'>;
  /** Actual approved companion tool names, supplied without recursively listing this module. */
  toolNames?(ctx: ToolContext): Promise<string[]>;
}
const discovery = z.object({ query: z.string().max(200).default(''), offset: z.number().int().min(0).max(1024).default(0),
  limit: z.number().int().min(1).max(8).default(4) }).strict();
const reading = teachingSkillReferenceSchema.extend({ path: teachingSkillPathSchema.optional(),
  offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(6000).default(6000) }).strict();
const definitions = [
  { name: 'discover_skills', description: '分页发现当前已获准 Skill 目录；只返回元信息，不加载正文、不授予工具或执行权限。', schema: discovery },
  { name: 'skill_load', description: '显式读取已选 Skill 固定版本的 SKILL.md 字节范围。仅为来源指导，不执行 scripts，不增加权限。', schema: reading },
  { name: 'skill_read', description: '按固定 Skill ID、版本和包内路径读取原文字节范围；scripts 仅作文本，不运行。', schema: reading },
] as const;
type Name = typeof definitions[number]['name'];

function loadedResult(loaded: TeachingSkillLoaded): AgentToolResult {
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
  return completed(JSON.stringify(visible), result);
}
function failure(error: unknown): AgentToolResult {
  const unavailable = teachingSkillUnavailableSchema.safeParse((error as { unavailable?: unknown } | null)?.unavailable);
  if (!(error instanceof StorageError) && !unavailable.success) throw error;
  const reason = error instanceof StorageError ? error.code : unavailable.data!.reason;
  return errored('Skill 固定来源不可读取：' + reason, json({ reason }));
}

/** Optional for both student and workspace assistants. Never imports a workspace executor. */
export function createSkillTools(host: SkillToolsHost): AgentTool[] {
  const owner = learningTargetSchema.parse(host.owner);
  const toolNames = async (ctx: ToolContext) => [...new Set([
    ...definitions.map(definition => definition.name), ...await host.toolNames?.(ctx) ?? [],
  ])];
  async function current(ctx: ToolContext) {
    const state = await host.skills.resolveSession(ctx.identity, ctx.sessionId, await toolNames(ctx));
    return { state, scope: { identity: ctx.identity, sessionId: ctx.sessionId, owner, selectionDigest: state.selectionDigest } };
  }
  async function discover(ctx: ToolContext, call: ToolCall): Promise<AgentToolResult> {
    const { state, scope } = await current(ctx);
    const args = discovery.parse(call.input), query = args.query.toLocaleLowerCase();
    const entries = state.catalog.filter(item => `${item.name}\n${item.description}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => (a.skillId + ':' + a.version).localeCompare(b.skillId + ':' + b.version));
    const selected = entries.slice(args.offset, args.offset + args.limit).map(item => ({ skillId: item.skillId, version: item.version,
      name: item.name, description: item.description.slice(0, 400), source: item.source.slice(0, 256), packageDigest: item.digest,
      origin: item.origin, selected: item.selected, required: item.required, ...(item.unavailable
        ? { unavailable: { ...item.unavailable, detail: item.unavailable.detail.slice(0, 200) } } : {}) }));
    const result = { role: 'source-data', selectionDigest: scope.selectionDigest, entries: selected, offset: args.offset,
      nextOffset: args.offset + selected.length < entries.length ? args.offset + selected.length : null };
    while (JSON.stringify(result).length > 8192 && selected.length > 1) { selected.pop(); result.nextOffset = args.offset + selected.length; }
    return completed(JSON.stringify(result), json(result));
  }
  async function load(ctx: ToolContext, call: ToolCall, name: Name): Promise<AgentToolResult> {
    const { state, scope } = await current(ctx);
    const args = reading.parse(call.input);
    if (name === 'skill_load' && args.path && args.path !== 'SKILL.md' || name === 'skill_read' && !args.path) throw new StorageError('invalid');
    const candidates = state.catalog.filter(item => item.skillId === args.skillId && item.version === args.version && item.selected && !item.unavailable);
    if (candidates.length !== 1) throw new StorageError('forbidden');
    const input = sessionSkillLoadSchema.parse({ ...args, path: args.path ?? 'SKILL.md', runId: ctx.turnId, stepId: ctx.stepId,
      commandId: ctx.toolCallId, moduleId: 'skills', moduleVersion: 1, selectionDigest: scope.selectionDigest, packageDigest: candidates[0]!.digest });
    return loadedResult(await host.skills.loadSession(ctx.identity, ctx.sessionId, input));
  }
  return definitions.map(({ name, schema, description }) => ({
    definition: { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input',
      override({ jsonSchema }) { if (jsonSchema.format === 'uuid') delete jsonSchema.format; } }) },
    supportsBackground: false,
    async execute(call: ToolCall, ctx: ToolContext): Promise<AgentToolResult> {
      if (call.executionMode === 'background') return errored('该工具不支持 background 模式');
      try { return name === 'discover_skills' ? await discover(ctx, call) : await load(ctx, call, name); }
      catch (error) { return failure(error); }
    },
  }));
}