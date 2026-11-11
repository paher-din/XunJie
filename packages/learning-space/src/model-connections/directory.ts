import { createHmac } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { modelDirectoryInputSchema, modelConnectionTestInputSchema, modelConnectionTestResultSchema, modelDirectorySchema, modelDirectoryEntrySchema, modelReasoningEfforts,
  maximumModelTokenCount, getModelPreset, type ModelDirectory, type ModelDirectoryEntry, type ModelDirectoryInput,
  type ModelConnectionTestResult, type ModelConfiguration, type ReasoningEffort } from '@xunjie/contracts/model-connections';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { CatalogueFailure } from './catalogue-cache.js';
import type { createModelProfiles } from './profiles.js';
import { errorFacts } from './upstream-facts.js';
import { supplierBounded, supplierCancelled, supplierFailure, supplierMissingCredential, supplierPassed, supplierTestStatus, readSupplierJson } from './supplier-diagnostics.js';

type Protocol = ModelConfiguration['protocol'];
export type DirectorySource = { baseUrl: string; protocol: Protocol; modelsUrl: string; catalogues: readonly string[];
  models: readonly ModelDirectoryEntry[]; auth?: 'bearer' | 'api-key' | 'x-api-key';
  route?(modelId: string, supported?: readonly Protocol[]): { protocol: Protocol; baseUrl: string } | undefined };
export type DirectoryHooks = {
  authorize(identity: SpaceIdentity): Promise<void>;
  credential(identity: SpaceIdentity, input: ModelDirectoryInput, source: DirectorySource): Promise<string>;
  source(input: ModelDirectoryInput): DirectorySource | undefined;
  requestFetch(source: DirectorySource, signal?: AbortSignal): Promise<typeof fetch>;
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
  const tests = new Set<{ controller: AbortController; promise: Promise<ModelConnectionTestResult> }>();
  let closed = false;
  async function supplierGet(source: DirectorySource, credential: string, signal?: AbortSignal) {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
    try {
      bounded.throwIfAborted();
      const requestFetch = await supplierBounded(hooks.requestFetch(source, bounded), bounded);
      bounded.throwIfAborted();
      const header = source.auth === 'api-key' ? 'api-key' : source.auth === 'x-api-key' || !source.auth && source.protocol === 'messages' ? 'x-api-key' : 'authorization';
      const response = await supplierBounded(requestFetch(source.modelsUrl, { method: 'GET', redirect: 'error',
        headers: { [header]: header === 'authorization' ? 'Bearer ' + credential : credential,
          ...(source.protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}) }, signal: bounded }), bounded);
      const { value, upstream } = await supplierBounded(readSupplierJson(response, credential, now), bounded);
      try { return { models: parseSupplierModels(value, credential), upstream }; }
      catch {
        throw new CatalogueFailure('invalid-response', undefined, response.status, undefined, upstream);
      }
    } catch (error) { throw supplierFailure(error, credential, bounded); }
  }
  async function testConnection(identity: SpaceIdentity, value: unknown, signal?: AbortSignal): Promise<ModelConnectionTestResult> {
    await hooks.authorize(identity);
    const input = modelConnectionTestInputSchema.parse(value);
    if (closed) throw new StorageError('maintenance');
    const started = performance.now(), controller = new AbortController();
    const bounded = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
    const promise = (async (): Promise<ModelConnectionTestResult> => {
      let source: DirectorySource | undefined, credential = input.credential?.action === 'replace' ? input.credential.value : '';
      // Invalid URLs must never echo embedded authentication or query-string secrets.
      const safeUrl = (value: string) => {
        try {
          const url = new URL(value);
          return url.username || url.password || url.search || url.hash ? '' : errorFacts({ message: url.href }, credential).message ?? '';
        } catch { return ''; }
      };
      let baseUrl = safeUrl(input.baseUrl ?? ''), endpoint = '', protocol = input.protocol ?? 'chat-completions';
      const result = (status: ModelConnectionTestResult['status'], details: Partial<ModelConnectionTestResult> = {}) =>
        modelConnectionTestResultSchema.parse({ status, baseUrl: safeUrl(baseUrl), protocol, endpoint: safeUrl(endpoint), elapsedMs: Math.max(0, performance.now() - started), ...details });
      try {
        bounded.throwIfAborted();
        source = hooks.source(input);
        if (!source) throw new StorageError('invalid');
        baseUrl = source.baseUrl; endpoint = source.modelsUrl; protocol = source.protocol;
        credential = await supplierBounded(hooks.credential(identity, input, source), bounded);
        if (!credential) return result('failed', { diagnostic: supplierMissingCredential() });
        const read = await supplierBounded(supplierGet(source, credential, bounded), bounded);
        return result('passed', { modelCount: read.models.length, diagnostic: supplierPassed(), upstream: read.upstream });
      } catch (error) {
        if (signal?.aborted || controller.signal.aborted) return result('cancelled', { diagnostic: supplierCancelled() });
        const failure = supplierFailure(error, credential, bounded);
        return result(supplierTestStatus(failure), { diagnostic: failure.diagnostic, ...(failure.upstream ? { upstream: failure.upstream } : {}) });
      }
    })();
    const entry = { controller, promise }; tests.add(entry);
    try { return await promise; } finally { tests.delete(entry); }
  }
  async function read(identity: SpaceIdentity, value: unknown, signal?: AbortSignal): Promise<ModelDirectory> {
    await hooks.authorize(identity);
    const input = modelDirectoryInputSchema.parse(value);
    const supplierOnly = input.source === 'supplier', catalogueOnly = input.source === 'catalogue';
    let source: DirectorySource | undefined, credential = '', supplierError: ReturnType<typeof supplierFailure> | undefined;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
    try {
      source = hooks.source(input);
      if (supplierOnly && !source) throw new StorageError('invalid');
      credential = source && !catalogueOnly ? await supplierBounded(hooks.credential(identity, input, source), bounded) : '';
    }
    catch (error) { if (!supplierOnly) throw error; supplierError = supplierFailure(error, credential, bounded); }
    const key = source && credential ? supplierKey(identity, input, source, credential) : undefined;
    let catalogue = profiles.refreshState(), supplier = (source || supplierError) && !catalogueOnly
      ? supplierError ? { status: 'failed' as const, error: supplierError.kind, diagnostic: supplierError.diagnostic }
        : key ? profiles.cache.read(key) : { status: 'needs-credential' as const, diagnostic: supplierMissingCredential() } : undefined;
    if (input.refresh || input.manual) {
      const publicRefresh = supplierOnly ? Promise.resolve(catalogue) : profiles.update(input.manual === true);
      const supplierRefresh = !catalogueOnly && source && key ? profiles.cache.refresh(key, async cacheSignal => {
        const requestSignal = AbortSignal.any([cacheSignal, bounded]);
        return (await supplierGet(source, credential, requestSignal)).models;
      }, input.manual === true, { ...(signal ? { signal } : {}), fresh: supplierOnly }) : Promise.resolve(supplier);
      [catalogue, supplier] = await Promise.all([publicRefresh, supplierRefresh]);
    }
    if (signal?.aborted && !catalogueOnly) supplier = { status: 'failed', error: 'offline', diagnostic: supplierCancelled() };
    const seed = source?.models ?? [], publicEntries = profiles.directoryEntries(source?.catalogues ?? [], source?.baseUrl,
      input.presetId && input.presetId !== 'custom' && source ? { presetId: input.presetId, ...(input.variantId ? { variantId: input.variantId } : {}),
        baseUrl: source.baseUrl, protocol: source.protocol } : undefined);
    const actual = key ? profiles.cache.state(key)?.data as ModelDirectoryEntry[] | undefined : undefined;
    const merged = new Map<string, ModelDirectoryEntry>();
    for (const entry of [...seed, ...publicEntries]) merged.set(entry.modelId, { ...merged.get(entry.modelId), ...entry });
    // Once the account's own list is available, it determines available IDs; seed/catalogue only fill missing fields.
    const models = (actual !== undefined ? actual.map(entry => ({ ...merged.get(entry.modelId), ...entry })) : supplierOnly ? [] : [...merged.values()])
      .map(entry => {
        const model = { ...entry, ...source?.route?.(entry.modelId, entry.protocols ?? (entry.protocol ? [entry.protocol] : undefined)) };
        if (model.defaultEffort && model.efforts && !model.efforts.includes(model.defaultEffort)) delete model.defaultEffort;
        return model;
      });
    return modelDirectorySchema.parse({ models, catalogue, ...(supplier ? { supplier } : {}) });
  }
  return { read, testConnection,
    close() { closed = true; for (const test of tests) test.controller.abort(); profiles.cache.close(); },
    resume() { closed = false; profiles.cache.resume(); },
    async drain() { await Promise.all([profiles.cache.drain(), ...[...tests].map(test => test.promise)]); },
    async validate() {
      await profiles.cache.validate(); profiles.validate();
      for (const [key, state] of profiles.cache.entries()) if (key.startsWith('supplier:') && state.data !== undefined
        && (!Array.isArray(state.data) || state.data.some(entry => !modelDirectoryEntrySchema.safeParse(entry).success))) throw new StorageError('corrupt');
    } };
}
