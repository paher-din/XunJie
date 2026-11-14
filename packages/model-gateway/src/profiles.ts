import { modelProfilesInputSchema, modelReasoningEfforts, modelReasoningError, resolveModelProfile, maximumModelTokenCount, modelProviderPresets, getModelPreset,
  type ModelConfiguration, type ModelProfile, type ReasoningEffort, type ModelDirectoryEntry } from '@xunjie/contracts/model-connections';
import { StorageError } from '@xunjie/storage';
import { CatalogueFailure, createCatalogueCache, readCatalogueJson, type CatalogueCache } from './catalogue-cache.js';

type Entry = { provider: string; api: string; id: string; canonical: string; name?: string; levels?: ReasoningEffort[]; context?: number; output?: number; defaultEffort?: ReasoningEffort; reasoningKind?: 'effort' | 'toggle' | 'none' };
const bare = (id: string) => id.toLowerCase().split('/').at(-1)!;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max ? Number(value) : undefined;
const normalizedUrl = (value: string) => { try { return new URL(value).href.replace(/\/+$/, ''); } catch { return ''; } };

export function modelPresetCatalogues(presetId: string, variantId: string): string[] {
  const ids: Record<string, string[]> = { 'deepseek/api': ['deepseek'], 'opencode-go/go': ['opencode-go'],
    'command-code/api': [], 'zhipu/api': ['zhipuai'], 'zhipu/coding': [],
    'kimi/api': ['moonshotai'], 'kimi/code': ['kimi-code-plan-cn'],
    'mimo/api': ['xiaomi'], 'mimo/token': ['xiaomi-token-plan-cn'] };
  return ids[presetId + '/' + variantId] ?? [];
}

/** A shared host or even a shared Anthropic endpoint cannot identify a billing channel. */
function presetEntries(entries: Entry[], route: Pick<ModelConfiguration, 'baseUrl' | 'protocol'> & Partial<ModelConfiguration>): Entry[] | undefined {
  const address = normalizedUrl(route.baseUrl);
  const explicit = route.presetId && route.presetId !== 'custom';
  const matches = modelProviderPresets.flatMap(preset => preset.variants.filter(variant => explicit
    ? preset.id === route.presetId && variant.id === getModelPreset(preset.id, route.variantId)?.id
    : normalizedUrl(variant.baseUrls[route.protocol] ?? '') === address).map(variant => ({ preset, variant })));
  if (!matches.length) return explicit ? [] : undefined;
  if (matches.length !== 1) return [];
  const { preset, variant } = matches[0]!;
  const catalogues = new Set(modelPresetCatalogues(preset.id, variant.id));
  const uniqueBases = Object.values(variant.baseUrls).map(normalizedUrl).filter(base => base && !preset.variants.some(other =>
    other.id !== variant.id && Object.values(other.baseUrls).some(value => normalizedUrl(value) === base)));
  return entries.filter(entry => catalogues.has(entry.provider) || uniqueBases.includes(normalizedUrl(entry.api)));
}

function agreed<K extends keyof Entry>(entries: Entry[], field: K): Entry[K] | undefined {
  const values = entries.map(entry => entry[field]).filter(value => value !== undefined);
  return values.length && values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : undefined;
}

/** Provider ids never leave this process: the public catalogue is downloaded as a whole. */
export function createModelProfiles(requestFetch: typeof fetch = fetch, now = Date.now, shared?: CatalogueCache) {
  const cache = shared ?? createCatalogueCache(now);
  const cacheKey = 'public-model-catalogue-v1';
  const entries = () => (cache.state(cacheKey)?.data as Entry[] | undefined) ?? [];
  async function update(manual = false) {
    return cache.refresh(cacheKey, async signal => {
      const response = await requestFetch('https://models.dev/api.json', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: 'error' });
      const raw = record(await readCatalogueJson(response, now, 32 * 1024 * 1024)), next: Entry[] = [];
      for (const [providerId, source] of Object.entries(raw)) {
        const provider = record(source);
        for (const [id, sourceModel] of Object.entries(record(provider.models))) {
          const model = record(sourceModel), limit = record(model.limit);
          if (!id || id.length > 200) continue;
          const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.map(record) : [];
          const effort = options.find(option => option.type === 'effort');
          const levels = Array.isArray(effort?.values) ? effort.values.filter((value): value is ReasoningEffort =>
            typeof value === 'string' && value !== 'auto' && (modelReasoningEfforts as readonly string[]).includes(value))
            : options.some(option => option.type === 'toggle') ? ['none', 'enabled'] as ReasoningEffort[] : model.reasoning === false ? [] : undefined;
          const context = positive(limit.context, maximumModelTokenCount), output = positive(limit.output, maximumModelTokenCount);
          const defaultEffort = typeof model.default_effort === 'string' && (modelReasoningEfforts as readonly string[]).includes(model.default_effort)
            ? model.default_effort as ReasoningEffort : undefined;
          next.push({ provider: providerId, api: typeof provider.api === 'string' ? provider.api : '', id,
            canonical: typeof model.canonical_model_id === 'string' ? model.canonical_model_id : '',
            ...(typeof model.name === 'string' ? { name: model.name.slice(0, 200) } : {}),
            ...(levels ? { levels: [...new Set(levels)] } : {}), ...(defaultEffort ? { defaultEffort } : {}),
            ...(effort ? { reasoningKind: 'effort' as const } : options.some(option => option.type === 'toggle') ? { reasoningKind: 'toggle' as const }
              : model.reasoning === false ? { reasoningKind: 'none' as const } : {}),
            ...(context ? { context } : {}), ...(output ? { output } : {}) });
        }
      }
      if (!next.length || next.length > 150000) throw new CatalogueFailure('invalid-response');
      return next;
    }, manual);
  }
  function resolve(route: Pick<ModelConfiguration, 'protocol' | 'baseUrl' | 'modelId'> & Partial<ModelConfiguration>): ModelProfile {
    const fallback = resolveModelProfile(route);
    const scoped = presetEntries(entries(), route), available = scoped ?? entries();
    const exact = available.filter(entry => [entry.id, entry.canonical].some(id => id.toLowerCase() === route.modelId.toLowerCase()));
    const candidates = exact.length ? exact : available.filter(entry => bare(entry.id) === bare(route.modelId) || entry.canonical && bare(entry.canonical) === bare(route.modelId));
    const own = candidates.filter(entry => normalizedUrl(entry.api) === normalizedUrl(route.baseUrl));
    const provider = route.modelId.includes('/') ? route.modelId.split('/')[0]!.toLowerCase() : '';
    const named = candidates.filter(entry => entry.provider.toLowerCase() === provider);
    const matching = own.length ? own : named.length ? named : candidates;
    // Each fact must agree independently; never borrow arbitrary first-candidate capacities.
    const declared = agreed(matching, 'levels');
    const context = agreed(matching, 'context'), output = agreed(matching, 'output');
    const defaultEffort = agreed(matching, 'defaultEffort'), reasoningKind = agreed(matching, 'reasoningKind');
    // Catalogue facts describe a model, not measured compatibility at a relay.
    // Known incompatible protocol combinations must not gain controls from metadata.
    const levels = fallback.source === 'known' && fallback.encoding === 'none' ? undefined
      : declared?.filter(effort => !modelReasoningError({ ...route, reasoningLevels: declared, reasoningEffort: effort }));
    const efforts = route.reasoningLevels !== undefined ? fallback.efforts : levels !== undefined ? ['auto' as const, ...new Set(levels)] : fallback.efforts;
    return { modelId: route.modelId, dialect: fallback.dialect,
      efforts,
      source: route.reasoningLevels !== undefined ? 'manual' : levels !== undefined ? 'catalogue' : fallback.source === 'known' ? 'profile' : 'unknown',
      ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}), ...(reasoningKind ? { reasoningKind } : {}),
      ...(context ? { contextWindow: context } : {}), ...(output ? { maxOutputTokens: output } : {}) };
  }
  async function read(value: unknown) {
    const input = modelProfilesInputSchema.parse(value);
    if (input.refresh) await update();
    const state = cache.state(cacheKey);
    return { profiles: input.modelIds.map(modelId => resolve({ baseUrl: input.baseUrl, protocol: input.protocol, modelId })),
      ...(state?.successAt !== undefined ? { updatedAt: new Date(state.successAt).toISOString() } : {}),
      stale: !!state?.error || state?.successAt === undefined || now() - state.successAt >= 600000 };
  }
  function directoryEntries(catalogues: readonly string[], baseUrl?: string, route?: Pick<ModelConfiguration, 'baseUrl' | 'protocol'> & Partial<ModelConfiguration>): ModelDirectoryEntry[] {
    const wanted = new Set(catalogues);
    return (route ? presetEntries(entries(), route) ?? [] : entries().filter(entry => wanted.has(entry.provider)
      || !wanted.size && baseUrl && normalizedUrl(entry.api) === normalizedUrl(baseUrl)))
      .map(entry => ({ modelId: entry.id, ...(entry.name ? { name: entry.name } : {}),
        ...(entry.context ? { contextWindow: entry.context } : {}), ...(entry.output ? { maxOutputTokens: entry.output } : {}),
        ...(entry.levels ? { efforts: entry.levels } : {}), ...(entry.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}),
        ...(entry.reasoningKind ? { reasoningKind: entry.reasoningKind } : {}) }));
  }
  return { read, resolve, update, directoryEntries, refreshState: () => cache.read(cacheKey), cache,
    validate() {
      const data = cache.state(cacheKey)?.data;
      if (data !== undefined && (!Array.isArray(data) || data.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.provider !== 'string')))
        throw new StorageError('corrupt');
    } };
}
