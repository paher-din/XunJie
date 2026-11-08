import { StorageError, type Migration, type OwnedTransaction, type OwnedStorage } from '@xunjie/storage';
import { agentDefinitionSchema, resolvedAgentSchema, contextManifestSchema,
  type AgentDefinition, type ResolvedAgent, type ContextManifest, type TeachingRun } from '@xunjie/contracts/teaching-agent';
import type { TeachingToolHost, TeachingToolScope, TeachingToolContribution } from './tool-types.js';
import { buildContext, platformRules, runRules, type ContextMessage } from './context.js';
import { canonicalDigest, operationId } from './identity.js';
import { studentAskDefinition } from './student-questions.js';
import { platformToolContribution } from './tool-contributions.js';
import { readToolResultDefinition } from './tool-results.js';
import { discoveryContributions, contributionId, initiallyVisible, type LoadedToolSelection } from './tool-discovery.js';
import type { TeachingSkillState } from '@xunjie/contracts/agent-skills';
import { teachingArtifactSdkApi } from '@xunjie/contracts/teaching-artifacts';

export const teachingAssemblyMigration: Migration = { version: 10, name: 'immutable-agent-assembly', sql: `
  CREATE TABLE teaching_agent_definitions(definition_id text NOT NULL,version integer NOT NULL,
    digest text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(definition_id,version));
  CREATE TABLE teaching_resolved_agents(resolved_id uuid PRIMARY KEY,body jsonb NOT NULL);
  ALTER TABLE teaching_runs ADD COLUMN initial_resolved_agent_id uuid REFERENCES teaching_resolved_agents(resolved_id);
  ALTER TABLE teaching_steps ADD COLUMN resolved_agent_id uuid REFERENCES teaching_resolved_agents(resolved_id),
    ADD COLUMN context_manifest jsonb;
  ALTER TABLE teaching_commands ADD COLUMN binding_id text;
` };

export const learningAgentDefinition: AgentDefinition = agentDefinitionSchema.parse({
  definitionId: 'xunjie.learning', version: 4, purpose: '围绕学生当前问题进行课程辅导或自主学习',
  prompt: { platform: platformRules, runtime: runRules + `\n生成教学页面的宿主契约：\n${teachingArtifactSdkApi}
上述方法都在 window.xunjie 对象上。html 只包含正文，不含 script、内联 on* 事件或外部资源；样式写入 css，交互写入 javascript 的异步 IIFE。
先 await window.xunjie.read() 恢复声明状态，再注册输入事件；每次输入通过 window.xunjie.change(完整状态) 保护，不使用 localStorage 或脚本内存替代恢复。状态结构使用有界的 string(maxLength)、number、boolean、array(maxItems,items)、object(properties)，根是 object；每个根字段在 semanticFields 声明稳定的含义。
例如文字输入可使用 const host=window.xunjie; const {content}=await host.read(); input.value=content.explanation; input.addEventListener('input',()=>{content.explanation=input.value;void host.change(content);});。不要把示例变量名当作固定 DOM 或状态字段。
局部控件变化不自动提问。只有学生明确点击才能 respond 或发起实验；真实实验结果由宿主呈现并附原来源，生成页面中自行计算的是教学示意。修订前通过 read_teaching_artifact 读取固定版本，保留字段含义和输入；映射不能改变已有答案的意思。` },
  capabilities: [{ sourceId: 'platform.student', required: true }, { sourceId: 'platform.learning', required: false },
    { sourceId: 'course:*', required: false }, { sourceId: 'platform.tools', required: true }],
  contextPolicy: { version: 1, maxSystemChars: 400_000, maxInputChars: 1_000_000 },
  outputContract: { kind: 'text', instructions: '回答先面对当前问题，按真实依据区分事实、推断与未知。需要交互解释时通过 generate_teaching_artifact 生成活动内页面或卡片，不在回复中粘贴 HTML 当成已启用内容。修订先读取原产物版本与显式状态含义，保留学生输入；模型生成值是教学示意，真实观察必须由获准工具返回。' },
  budgetPolicy: { version: 1, retryLimit: 0 },
});

/** Compatibility for actual owners that still implement the original tool-host contract. */
export async function toolContributions(host: TeachingToolHost | undefined, scope: TeachingToolScope): Promise<TeachingToolContribution[]> {
  if (!host) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = host.contributions ? host.contributions(scope)
    : host.definitions(scope).then(definitions => definitions.map(definition => platformToolContribution(definition, scope)));
  try {
    return await Promise.race([read, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StorageError('unavailable')), 5000); timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class TeachingAssemblyError extends Error {
  constructor(readonly reason: string, readonly unavailable: ResolvedAgent['unavailable']) { super(reason); }
}

/** Shared by normal steps and explicit route switching. No persistence or model effects. */
export async function assembleTeachingAgent(scope: TeachingToolScope, host: TeachingToolHost | undefined,
  model: NonNullable<TeachingRun['model']>, history: ContextMessage[], definition: AgentDefinition = learningAgentDefinition,
  capabilities: { loaded?: LoadedToolSelection[]; skills?: TeachingSkillState | undefined } = {}) {
  const { loaded = [], skills } = capabilities;
  definition = agentDefinitionSchema.parse(structuredClone(definition));
  const contributions: TeachingToolContribution[] = [{ definition: studentAskDefinition, purpose: studentAskDefinition.description,
    resultSchema: { type: 'object', additionalProperties: true },
    source: { kind: 'platform', sourceId: 'platform.student', version: '1', contentDigest: canonicalDigest(studentAskDefinition) },
    executor: { executorId: 'teaching-student-questions:ask', toolName: studentAskDefinition.name, version: '1' },
    effect: 'ask', resourceScope: { identity: scope.identity, activityId: scope.activity.activityId } }];
  const unavailable: ResolvedAgent['unavailable'] = [];
  contributions.push(...discoveryContributions(scope), ...discoveryContributions(scope, [readToolResultDefinition]));
  try { contributions.push(...await toolContributions(host, scope)); }
  catch (error) {
    if (!(error instanceof StorageError) || !['unavailable', 'missing'].includes(error.code)) throw error;
    unavailable.push({ sourceId: 'platform.learning', required: definition.capabilities.some(item => item.sourceId === 'platform.learning' && item.required),
      reason: error.code });
  }
  const matchesSource = (reference: string, source: string) => reference.endsWith('*')
    ? source.startsWith(reference.slice(0, -1)) : source === reference;
  const candidates = contributions.filter(item => definition.capabilities.some(ref => matchesSource(ref.sourceId, item.source.sourceId)));
  if (candidates.length > 512 || Buffer.byteLength(JSON.stringify(candidates)) > 2_000_000)
    throw new TeachingAssemblyError('catalog-capacity-exceeded', [{ sourceId: 'assembly', required: true, reason: 'catalog-limit' }]);
  const loadedIds = new Set(loaded.map(item => item.bindingId));
  const stale = loaded.filter(selection => !candidates.some(item => contributionId(item) === selection.bindingId));
  const selected = candidates.filter(item => loadedIds.has(contributionId(item))
    || initiallyVisible(item, scope, definition) && !stale.some(selection => selection.sourceId === item.source.sourceId && selection.name === item.definition.name));
  for (const selection of stale) unavailable.push({ sourceId: selection.sourceId + ':' + selection.name, required: false, reason: 'loaded-version-unavailable' });
  for (const required of definition.capabilities) if (!selected.some(item => matchesSource(required.sourceId, item.source.sourceId))) {
    if (!unavailable.some(item => item.sourceId === required.sourceId)) unavailable.push({ ...required, reason: 'capability-missing' });
  }
  const keys = new Set<string>();
  const tools = selected.map(item => {
    const key = item.source.sourceId + ':' + item.definition.name;
    if (keys.has(key)) throw new TeachingAssemblyError('capability-conflict', [{ sourceId: item.source.sourceId, required: true, reason: 'duplicate-definition' }]);
    keys.add(key);
    const duplicate = candidates.filter(other => other.definition.name === item.definition.name).length > 1;
    const modelName = duplicate ? item.definition.name.slice(0, 46) + '_' + canonicalDigest(key).slice(0, 16) : item.definition.name;
    return { ...item, definition: { ...item.definition, name: modelName }, modelName, bindingId: canonicalDigest(item) };
  });
  if (tools.length > 64 || Buffer.byteLength(JSON.stringify(tools.map(item => item.definition))) > 24000) throw new TeachingAssemblyError('tool-capacity-exceeded', [{ sourceId: 'assembly', required: true, reason: 'tool-limit-64' }]);
  if (unavailable.some(item => item.required)) throw new TeachingAssemblyError('required-capability-unavailable', unavailable);
  const context = buildContext(scope.activity, scope.input, history, { definition });
  if (stale.length) {
    const notice = 'Previously loaded tool versions are unavailable; do not substitute a same-name executor. Discover and explicitly load an approved version if needed: '
      + JSON.stringify(stale);
    context.system += '\n\n' + notice;
    context.layers.push({ kind: 'runtime', content: notice });
  }
  const scopeFact = { ...scope.input.scope, ...(scope.activity.course ? { releaseId: scope.activity.course.releaseId,
    courseDigest: scope.activity.course.contentDigest, helpPolicy: scope.activity.course.helpPolicy } : {}) };
  // Progressive tool reads are step context, not a change of native prefix or executor configuration.
  // Explicit/course guidance is part of the fixed assembly; later reads keep their original native pair.
  const assemblySkills = skills ? { catalog: skills.catalog, loaded: skills.loaded.filter(loaded => loaded.path === 'SKILL.md'
    && loaded.complete && skills.catalog.some(entry => entry.skillId === loaded.skillId && entry.version === loaded.version
      && (entry.origin === 'course' || scope.input.draft.skills?.some(ref => ref.skillId === entry.skillId && ref.version === entry.version)))) } : undefined;
  const basis = { version: 1 as const, definition, definitionDigest: canonicalDigest(definition),
    mode: scope.activity.course ? 'course-tutoring' as const : 'self-study' as const,
    scope: scopeFact, model, prompt: { system: context.system, layers: context.layers }, tools, unavailable,
    ...(assemblySkills && (assemblySkills.catalog.length || assemblySkills.loaded.length) ? { skills: assemblySkills } : {}) };
  const resolvedAgent = resolvedAgentSchema.parse({ ...basis, resolvedId: operationId('resolved-agent:' + canonicalDigest(basis)) });
  return { resolvedAgent, context, tools: tools.map(item => item.definition), ...(skills ? { skillState: skills } : {}) };
}

export async function retainTeachingAssembly(tx: OwnedTransaction, resolved: ResolvedAgent) {
  const { rows: [prior] } = await tx.query(`SELECT digest FROM teaching_agent_definitions WHERE definition_id=$1 AND version=$2`,
    [resolved.definition.definitionId, resolved.definition.version]);
  if (prior && prior.digest !== resolved.definitionDigest) throw new StorageError('identity-conflict');
  await tx.query(`INSERT INTO teaching_agent_definitions(definition_id,version,digest,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [resolved.definition.definitionId, resolved.definition.version, resolved.definitionDigest, JSON.stringify(resolved.definition)]);
  await tx.query('INSERT INTO teaching_resolved_agents(resolved_id,body) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [resolved.resolvedId, JSON.stringify(resolved)]);
}

export function manifestFor(resolved: ResolvedAgent, payload: Record<string, unknown>, facts: {
  inputs: unknown[]; history?: ContextMessage[]; effects: unknown[]; waits: unknown[]; observations: unknown[];
  activity: TeachingToolScope['activity']; maxOutputTokens: number;
  skills?: TeachingSkillState;
}): ContextManifest {
  const items: ContextManifest['items'] = [];
  const add = (kind: ContextManifest['items'][number]['kind'], id: string, content: unknown, required: boolean,
    version = '1', selection: Record<string, unknown> = {}) => {
    const fixed = JSON.parse(JSON.stringify(content)) as unknown;
    items.push({ kind, owner: 'teaching-agent', id, version, required,
      selection, content: fixed, contentDigest: canonicalDigest(fixed), disposition: 'included' });
  };
  for (const layer of resolved.prompt.layers) add('rule', layer.kind, layer.content, true, String(resolved.definition.version));
  for (const input of facts.inputs) add('input', canonicalDigest(input), input, true);
  for (const tool of resolved.tools) add('tool-schema', tool.bindingId, tool, true, tool.source.version);
  for (const skill of resolved.skills?.catalog ?? []) add('material', 'skill:' + skill.skillId, skill, skill.required, String(skill.version),
    { access: 'skill-metadata', origin: skill.origin });
  for (const loaded of facts.skills?.loaded ?? resolved.skills?.loaded ?? []) add('material', 'skill:' + loaded.skillId + ':' + loaded.path,
    loaded, true, String(loaded.version), { access: 'fixed-skill-content' });
  for (const history of facts.history ?? []) add('history', history.source?.id ?? canonicalDigest(history), history, false);
  for (const effect of facts.effects) add('effect', canonicalDigest(effect), effect, true);
  for (const wait of facts.waits) add('wait', canonicalDigest(wait), wait, true);
  for (const observation of facts.observations) add('observation', canonicalDigest(observation), observation, true);
  if (facts.activity.course) add('material', facts.activity.course.releaseId, facts.activity.course, true,
    facts.activity.course.contentDigest, { access: 'fixed-course-release' });
  // The native envelope preserves exact roles, image references and ordering without reconstructing a provider request.
  add('native', 'actual-model-transport', payload, true);
  const payloadSha256 = canonicalDigest(payload), json = JSON.stringify(payload);
  return contextManifestSchema.parse({ version: 1, manifestId: operationId('context-manifest:' + resolved.resolvedId + ':' + payloadSha256),
    resolvedId: resolved.resolvedId, payloadSha256, items,
    capacity: { counting: 'unknown', payloadBytes: Buffer.byteLength(json), outputReserve: facts.maxOutputTokens,
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(resolved.tools.map(item => item.definition))),
      imageCount: (json.match(/"(?:image_url|input_image|image)"/g) ?? []).length,
      nativeOverhead: 'included-in-payload', ...(typeof resolved.model.contextWindow === 'number' ? { contextWindow: resolved.model.contextWindow } : {}),
      reason: '此路线未提供可靠 tokenizer；完整 payload 含规则、工具、图像及原生续接，输入 token 未知，输出单独预留。' } });
}

/** Restore verifies the new closure from retained facts, without resolving or rendering again. */
export async function validateTeachingAssemblyData(storage: OwnedStorage) {
  const { rows: definitions } = await storage.read('SELECT * FROM teaching_agent_definitions');
  for (const row of definitions) {
    const definition = agentDefinitionSchema.parse(row.body);
    if (row.definition_id !== definition.definitionId || row.version !== definition.version
      || row.digest !== canonicalDigest(definition)) throw new StorageError('corrupt');
  }
  const { rows: resolutions } = await storage.read('SELECT * FROM teaching_resolved_agents');
  for (const row of resolutions) {
    const resolved = resolvedAgentSchema.parse(row.body), { resolvedId, ...basis } = resolved;
    if (resolvedId !== row.resolved_id || resolvedId !== operationId('resolved-agent:' + canonicalDigest(basis))
      || resolved.definitionDigest !== canonicalDigest(resolved.definition)
      || !definitions.some(item => item.definition_id === resolved.definition.definitionId && item.version === resolved.definition.version
        && item.digest === resolved.definitionDigest)) throw new StorageError('corrupt');
    for (const binding of resolved.tools) {
      const { bindingId: _bindingId, modelName: _modelName, ...contribution } = binding;
      const original = { ...contribution, definition: { ...binding.definition, name: binding.executor.toolName } };
      if (canonicalDigest(original) !== binding.bindingId || binding.modelName !== binding.definition.name) throw new StorageError('corrupt');
    }
  }
  const { rows: steps } = await storage.read('SELECT * FROM teaching_steps');
  const { rows: snapshots } = await storage.read('SELECT * FROM teaching_snapshots');
  for (const step of steps) {
    const plan = step.plan as { resolvedAgent?: ResolvedAgent };
    if (!plan.resolvedAgent) { if (step.resolved_agent_id || step.context_manifest) throw new StorageError('corrupt'); continue; }
    const saved = resolutions.find(item => item.resolved_id === step.resolved_agent_id);
    if (!saved || canonicalDigest(saved.body) !== canonicalDigest(plan.resolvedAgent)) throw new StorageError('corrupt');
    const snapshot = snapshots.find(item => item.snapshot_id === step.snapshot_id)?.body as {
      resolvedAgent?: ResolvedAgent; contextManifest?: ContextManifest; payloadSha256: string } | undefined;
    if (snapshot && (!snapshot.resolvedAgent || !snapshot.contextManifest || canonicalDigest(snapshot.resolvedAgent) !== canonicalDigest(saved.body)
      || canonicalDigest(snapshot.contextManifest) !== canonicalDigest(step.context_manifest))) throw new StorageError('corrupt');
    if (step.context_manifest) {
      const manifest = contextManifestSchema.parse(step.context_manifest);
      if (manifest.resolvedId !== step.resolved_agent_id || manifest.payloadSha256 !== snapshot?.payloadSha256
        || manifest.items.some(item => canonicalDigest(item.content) !== item.contentDigest)) throw new StorageError('corrupt');
    }
  }
  const { rows: runs } = await storage.read('SELECT run_id,initial_resolved_agent_id FROM teaching_runs');
  for (const run of runs) {
    const first = steps.filter(step => step.run_id === run.run_id).sort((a, b) => Number(a.step_no) - Number(b.step_no))[0];
    if (first?.resolved_agent_id && run.initial_resolved_agent_id !== first.resolved_agent_id) throw new StorageError('corrupt');
  }
  const { rows: transitions } = await storage.read('SELECT * FROM teaching_segment_transitions');
  for (const transition of transitions) {
    if (!transition.assembly_id) continue;
    const saved = resolutions.find(item => item.resolved_id === transition.assembly_id);
    // An accepted model switch owns its fixed assembly before completion publishes it to the shared table.
    const resolved = saved?.body ?? transition.resolved_agent;
    if (!resolved || (transition.resolved_agent && canonicalDigest(transition.resolved_agent) !== canonicalDigest(resolved)))
      throw new StorageError('corrupt');
    const body = resolvedAgentSchema.parse(resolved), prefix = (transition.create_body as { prefix: unknown }).prefix;
    if (body.resolvedId !== transition.assembly_id || canonicalDigest(prefix) !== canonicalDigest({
      system: body.prompt.system, tools: body.tools.map(tool => tool.definition) })) throw new StorageError('corrupt');
  }
}

