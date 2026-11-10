import { createHmac } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { modelDirectoryInputSchema, modelDirectorySchema, modelDirectoryEntrySchema, modelReasoningEfforts,
  maximumModelTokenCount, getModelPreset, type ModelDirectory, type ModelDirectoryEntry, type ModelDirectoryInput,
  type ModelConfiguration, type ReasoningEffort } from '@xunjie/contracts/model-connections';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { CatalogueFailure, readCatalogueJson } from './catalogue-cache.js';
import type { createModelProfiles } from './profiles.js';

type Protocol = ModelConfiguration['protocol'];
export type DirectorySource = { baseUrl: string; protocol: Protocol; modelsUrl: string; catalogues: readonly string[];
  models: readonly ModelDirectoryEntry[]; auth?: 'bearer' | 'api-key' | 'x-api-key';
  route?(modelId: string, supported?: readonly Protocol[]): { protocol: Protocol; baseUrl: string } | undefined };
export type DirectoryHooks = {
  authorize(identity: SpaceIdentity): Promise<void>;
  credential(identity: SpaceIdentity, input: ModelDirectoryInput, source: DirectorySource): Promise<string>;
  source(input: ModelDirectoryInput): DirectorySource | undefined;
  requestFetch(source: DirectorySource): Promise<typeof fetch>;
  key: Uint8Array; now?: () => number;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximumModelTokenCount ? Number(value) : undefined;
const effort = (value: unknown): value is ReasoningEffort => typeof value === 'string' && (modelReasoningEfforts as readonly string[]).includes(value);
const protocols: Protocol[] = ['chat-completions', 'responses', 'messages'];
function protocol(value: unknown): Protocol | undefined {
  if (typeof value !== 'string') return;
  value = value.toLowerCase();
  if (protocols.includes(value as Protocol)) return value as Protocol;
  if (/chat[\/. _-]?completions/.test(value as string)) return 'chat-completions';
  if (/responses/.test(value as string)) return 'responses';
  if (/messages|anthropic/.test(value as string)) return 'messages';
}

/** Keep only public model metadata; upstream objects and credential-bearing errors never persist. */
export function parseSupplierModels(value: unknown, secret = ''): ModelDirectoryEntry[] {
  const root = record(value), items = Array.isArray(value) ? value : Array.isArray(root.data) ? root.data : root.models;
  if (!Array.isArray(items) || items.length > 10000) throw new CatalogueFailure('invalid-response');
  const entries = new Map<string, ModelDirectoryEntry>();
  for (const item of items) {
    const model = record(item), limit = record(model.limit), limits = record(model.limits);
    const capabilities = record(model.capabilities), reasoning = record(model.reasoning ?? capabilities.reasoning);
    const thinking = record(model.think_efforts), reasoningEffort = record(reasoning.effort);
    const id = model.id ?? model.model_id ?? model.modelId;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || secret && id.includes(secret)) continue;
    const rawName = model.display_name ?? model.name;
    const name = typeof rawName === 'string' && (!secret || !rawName.includes(secret)) ? rawName.slice(0, 200) : undefined;
    const contextWindow = positive(model.context_length ?? model.context_window ?? limit.context ?? limits.context);
    const maxOutputTokens = positive(model.max_output_tokens ?? model.max_completion_tokens ?? limit.output ?? limit.max_output_tokens ?? limits.output ?? limits.max_output_tokens);
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.map(record) : [];
    const option = options.find(value => value.type === 'effort');
    const rawLevels = model.supported_reasoning_levels ?? thinking.valid_efforts ?? reasoningEffort.valid ?? option?.values;
    const declaredEfforts = Array.isArray(rawLevels) ? [...new Set(rawLevels.map(value => typeof value === 'string' ? value : record(value).effort).filter(effort))] : undefined;
    const rawDefault = model.default_effort ?? model.default_reasoning_level ?? thinking.default_effort ?? reasoningEffort.default;
    const defaultEffort = effort(rawDefault) ? rawDefault : undefined;
    const rawEndpoints = model.supported_endpoints ?? model.native_endpoints ?? model.protocols;
    const supported = Array.isArray(rawEndpoints) ? [...new Set(rawEndpoints.map(protocol).filter((value): value is Protocol => !!value))] : undefined;
    const primary = protocol(model.protocol ?? model.type_target);
    const thinkingType = model.supports_thinking_type ?? reasoning.type;
    const reasoningKind = model.supports_reasoning === false || model.reasoning === false || capabilities.reasoning === false ? 'none'
      : declaredEfforts?.length ? declaredEfforts.every(level => level === 'none' || level === 'enabled') ? 'toggle' : 'effort'
      : thinkingType === 'both' || thinkingType === 'only' || options.some(value => value.type === 'toggle') ? 'toggle' : undefined;
    const efforts: ReasoningEffort[] | undefined = reasoningKind === 'none' ? [] : declaredEfforts
      ?? (reasoningKind === 'toggle' ? thinkingType === 'only' ? ['enabled'] : ['none', 'enabled'] : undefined);
    const parsed = modelDirectoryEntrySchema.safeParse({ modelId: id.trim(), ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(reasoningKind ? { reasoningKind } : {}),
      ...(primary ? { protocol: primary } : {}), ...(supported?.length ? { protocols: supported } : {}) });
    if (parsed.success) entries.set(parsed.data.modelId, parsed.data);
  }
  if (items.length && !entries.size) throw new CatalogueFailure('invalid-response');
  return [...entries.values()];
}

export function createModelDirectory(profiles: ReturnType<typeof createModelProfiles>, hooks: DirectoryHooks) {
  const now = hooks.now ?? Date.now;
  function supplierKey(identity: SpaceIdentity, input: ModelDirectoryInput, source: DirectorySource, credential: string) {
    // Includes owner and credential identity without persisting either a secret or a reusable plain hash.
    return 'supplier:' + createHmac('sha256', hooks.key).update(JSON.stringify([
      identity.environmentId, identity.spaceId, identity.principalId, input.presetId ?? 'custom',
      input.presetId && input.presetId !== 'custom' ? getModelPreset(input.presetId, input.variantId)?.id ?? '' : input.variantId ?? '',
      source.modelsUrl, source.protocol, credential,
    ])).digest('hex');
  }
  async function read(identity: SpaceIdentity, value: unknown): Promise<ModelDirectory> {
    await hooks.authorize(identity);
    const input = modelDirectoryInputSchema.parse(value), source = hooks.source(input);
    const credential = source ? await hooks.credential(identity, input, source) : '';
    const key = source && credential ? supplierKey(identity, input, source, credential) : undefined;
    let catalogue = profiles.refreshState(), supplier = source ? key ? profiles.cache.read(key) : { status: 'needs-credential' as const } : undefined;
    if (input.refresh || input.manual) {
      // Independent writes make a fast supplier visible to read-only polling while the public feed is slow.
      const publicRefresh = profiles.update(input.manual === true);
      const supplierRefresh = source && key ? profiles.cache.refresh(key, async signal => {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const requestFetch = await new Promise<typeof fetch>((resolve, reject) => {
          const aborted = () => reject(new CatalogueFailure(bounded.reason instanceof Error && bounded.reason.name === 'TimeoutError' ? 'timeout' : 'offline'));
          if (bounded.aborted) { aborted(); return; }
          bounded.addEventListener('abort', aborted, { once: true });
          hooks.requestFetch(source).then(resolve, reject).finally(() => bounded.removeEventListener('abort', aborted));
        });
        bounded.throwIfAborted();
        const header = source.auth === 'api-key' ? 'api-key' : source.auth === 'x-api-key' ? 'x-api-key' : 'authorization';
        const response = await requestFetch(source.modelsUrl, { method: 'GET', redirect: 'error',
          headers: { [header]: header === 'authorization' ? 'Bearer ' + credential : credential,
            ...(source.protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}) },
          signal: bounded });
        return parseSupplierModels(await readCatalogueJson(response, now), credential);
      }, input.manual === true) : Promise.resolve(supplier);
      [catalogue, supplier] = await Promise.all([publicRefresh, supplierRefresh]);
    }
    const seed = source?.models ?? [], publicEntries = profiles.directoryEntries(source?.catalogues ?? [], source?.baseUrl,
      input.presetId && input.presetId !== 'custom' && source ? { presetId: input.presetId, ...(input.variantId ? { variantId: input.variantId } : {}),
        baseUrl: source.baseUrl, protocol: source.protocol } : undefined);
    const actual = key ? profiles.cache.state(key)?.data as ModelDirectoryEntry[] | undefined : undefined;
    const merged = new Map<string, ModelDirectoryEntry>();
    for (const entry of [...seed, ...publicEntries]) merged.set(entry.modelId, { ...merged.get(entry.modelId), ...entry });
    // Once the account's own list is available, it determines available IDs; seed/catalogue only fill missing fields.
    const models = (actual !== undefined ? actual.map(entry => ({ ...merged.get(entry.modelId), ...entry })) : [...merged.values()])
      .map(entry => {
        const model = { ...entry, ...source?.route?.(entry.modelId, entry.protocols ?? (entry.protocol ? [entry.protocol] : undefined)) };
        if (model.defaultEffort && model.efforts && !model.efforts.includes(model.defaultEffort)) delete model.defaultEffort;
        return model;
      });
    return modelDirectorySchema.parse({ models, catalogue, ...(supplier ? { supplier } : {}) });
  }
  return { read,
    close: () => profiles.cache.close(), resume: () => profiles.cache.resume(), drain: () => profiles.cache.drain(),
    async validate() {
      await profiles.cache.validate(); profiles.validate();
      for (const [key, state] of profiles.cache.entries()) if (key.startsWith('supplier:') && state.data !== undefined
        && (!Array.isArray(state.data) || state.data.some(entry => !modelDirectoryEntrySchema.safeParse(entry).success))) throw new StorageError('corrupt');
    } };
}
