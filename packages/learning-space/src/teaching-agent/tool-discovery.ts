import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { componentInstanceId } from '@xunjie/contracts/components';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import type { AgentDefinition } from '@xunjie/contracts/teaching-agent';
import type { TeachingToolContribution, TeachingToolOutcome, TeachingToolScope } from './tool-types.js';
import { canonicalDigest } from './identity.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const filter = { type: ['string', 'null'], maxLength: 200 };
export const discoveryDefinitions: ModelTool[] = [
  { name: 'discover_tools', description: 'Find currently approved platform/course tools by purpose, source or object. Bounded versioned pages; discovery grants no execution authority. Use load_tools before calling a discovered tool.',
    inputSchema: object({ purpose: filter, source: filter, object: filter, cursor: { type: ['string', 'null'], maxLength: 1000 }, pageSize: { type: 'integer', minimum: 1, maximum: 8 } }) },
  { name: 'load_tools', description: 'Select fixed bindingIds from a previously discovered page. Definitions become visible after this tool pair at the next step. Revoked or changed versions cannot be substituted.',
    inputSchema: object({ bindingIds: { type: 'array', items: { type: 'string', minLength: 64, maxLength: 64 }, minItems: 1, maxItems: 8, uniqueItems: true } }) },
];
export function discoveryContributions(scope: TeachingToolScope, definitions = discoveryDefinitions): TeachingToolContribution[] {
  return definitions.map(definition => ({ definition, purpose: definition.description,
    resultSchema: { type: 'object', additionalProperties: true },
    source: { kind: 'platform', sourceId: 'platform.tools', version: '1', contentDigest: canonicalDigest(definition) },
    executor: { executorId: 'teaching-discovery:' + definition.name, toolName: definition.name, version: '1' }, effect: 'read',
    resourceScope: { identity: scope.identity, activityId: scope.activity.activityId } }));
}
export function permittedContributions(contributions: TeachingToolContribution[], definition: AgentDefinition) {
  const matches = (reference: string, source: string) => reference.endsWith('*') ? source.startsWith(reference.slice(0, -1)) : source === reference;
  const selected = contributions.filter(item => definition.capabilities.some(ref => matches(ref.sourceId, item.source.sourceId)));
  const keys = new Set<string>();
  for (const item of selected) {
    const key = item.source.sourceId + ':' + item.definition.name;
    if (keys.has(key)) throw new StorageError('identity-conflict');
    keys.add(key);
  }
  if (selected.length > 512 || Buffer.byteLength(JSON.stringify(selected)) > 2_000_000) throw new StorageError('invalid');
  return selected;
}
export const contributionId = (item: TeachingToolContribution) => canonicalDigest(item);
export function initiallyVisible(item: TeachingToolContribution, scope: TeachingToolScope, definition: AgentDefinition) {
  if (item.source.sourceId === 'platform.student' || item.source.sourceId === 'platform.tools') return true;
  if (item.source.sourceId === 'platform.learning') return item.definition.name !== 'read_material'
    || scope.input.draft.references.some(ref => 'materialId' in ref.source);
  if (definition.capabilities.some(ref => ref.required && ref.sourceId === item.source.sourceId)) return true;
  // A fixed component reference already identifies the capability directly needed by this question.
  return item.source.kind === 'course' && !!item.source.componentKey && (scope.activity.course?.components?.length === 1 || scope.input.draft.references.some(ref =>
    ref.source.kind === 'component' && ref.source.instanceId === componentInstanceId(scope.activity.activityId, item.source.componentKey!)));
}
export interface LoadedToolSelection { bindingId: string; sourceId: string; name: string }
export async function loadedTools(storage: OwnedStorage, scope: TeachingToolScope): Promise<LoadedToolSelection[]> {
  const { rows } = await storage.read(`SELECT c.outcome FROM teaching_commands c JOIN teaching_runs r USING(run_id)
    JOIN teaching_steps s USING(step_id) WHERE r.activity_id=$1 AND r.identity=$2::jsonb
    AND c.command->>'name'='load_tools' AND c.state='settled' AND s.paired=true ORDER BY c.created_at,c.command_id`,
  [scope.activity.activityId, JSON.stringify(scope.identity)]);
  const selections = rows.flatMap(row => {
    const outcome = row.outcome as TeachingToolOutcome;
    return outcome.state === 'completed' && Array.isArray(outcome.result.selections) ? outcome.result.selections as LoadedToolSelection[] : [];
  });
  const latest = new Map<string, LoadedToolSelection>();
  for (const selection of selections) latest.set(selection.sourceId + ':' + selection.name, selection);
  return [...latest.values()];
}
export async function discoveryOutcome(storage: OwnedStorage, scope: TeachingToolScope, name: string,
  args: Record<string, unknown>, candidates: TeachingToolContribution[]): Promise<TeachingToolOutcome> {
  if (name === 'discover_tools') {
    const query = { purpose: args.purpose, source: args.source, object: args.object, pageSize: args.pageSize };
    const entries = candidates.filter(item => item.source.sourceId !== 'platform.tools' && item.source.sourceId !== 'platform.student')
      .filter(item => (typeof args.purpose !== 'string' || (item.definition.name + ' ' + item.definition.description).toLowerCase().includes(args.purpose.toLowerCase()))
        && (typeof args.source !== 'string' || item.source.sourceId.includes(args.source))
        && (typeof args.object !== 'string' || JSON.stringify(item.resourceScope).includes(args.object)))
      .sort((a, b) => (a.source.sourceId + ':' + a.definition.name).localeCompare(b.source.sourceId + ':' + b.definition.name));
    const version = canonicalDigest({ identity: scope.identity, activityId: scope.activity.activityId, query, entries });
    let offset = 0, page = 0;
    if (args.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(String(args.cursor), 'base64url').toString()); } catch { throw new StorageError('invalid'); }
      if (cursor.version !== version) throw new StorageError('identity-conflict');
      offset = cursor.offset; page = cursor.page;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(page) || page < 0) throw new StorageError('invalid');
    }
    if (page >= 8) throw new StorageError('invalid');
    const pageEntries = (start: number) => {
      const selected: (TeachingToolContribution & { bindingId: string })[] = [];
      for (const item of entries.slice(start, start + Number(args.pageSize))) {
        const entry = { bindingId: contributionId(item), ...item };
        if (Buffer.byteLength(JSON.stringify([...selected, entry])) > 6000) {
          if (!selected.length) throw new StorageError('invalid');
          break;
        }
        selected.push(entry);
      }
      return selected;
    };
    let expectedOffset = 0;
    for (let index = 0; index < page; index++) {
      const count = pageEntries(expectedOffset).length;
      if (!count || expectedOffset + count >= entries.length) throw new StorageError('invalid');
      expectedOffset += count;
    }
    if (offset !== expectedOffset) throw new StorageError('invalid');
    const selected = pageEntries(offset);
    // An entry-sized page is deterministic too; the next offset is never guessed by the model.
    const next = offset + selected.length;
    const hasMore = next < entries.length, limitReached = hasMore && page === 7;
    const result = { catalogVersion: version, entries: selected, offset, page: page + 1, maxPages: 8,
      hasMore, limitReached, nextCursor: hasMore && !limitReached
        ? Buffer.from(JSON.stringify({ version, offset: next, page: page + 1 })).toString('base64url') : null };
    return completed(result, '当前获准工具目录');
  }
  const ids = args.bindingIds as string[];
  const { rows } = await storage.read(`SELECT c.outcome FROM teaching_commands c JOIN teaching_steps s USING(step_id)
    WHERE c.run_id=$1 AND c.command->>'name'='discover_tools' AND c.state='settled' AND s.paired=true`, [scope.runId]);
  const discovered = rows.flatMap(row => {
    const outcome = row.outcome as TeachingToolOutcome;
    return outcome.state === 'completed' && Array.isArray(outcome.result.entries) ? outcome.result.entries as { bindingId: string }[] : [];
  });
  if (ids.some(id => !discovered.some(entry => entry.bindingId === id))) throw new StorageError('forbidden');
  if (ids.some(id => !candidates.some(item => contributionId(item) === id))) throw new StorageError('identity-conflict');
  const loaded = await loadedTools(storage, scope);
  const selections = ids.map(bindingId => {
    const item = candidates.find(item => contributionId(item) === bindingId)!;
    return { bindingId, sourceId: item.source.sourceId, name: item.definition.name };
  });
  const effective = new Map(loaded.map(item => [item.sourceId + ':' + item.name, item]));
  for (const selection of selections) effective.set(selection.sourceId + ':' + selection.name, selection);
  if (effective.size > 32) throw new StorageError('invalid');
  return completed({ bindingIds: ids, selections, effective: 'next-step-after-pair', grantsExecution: false }, '固定工具加载');
}
function completed(result: Record<string, unknown>, label: string): TeachingToolOutcome {
  return { state: 'completed', result, source: { label }, feedback: { outcome: 'success', text: JSON.stringify(result), images: [] } };
}
