import { modelProfilesInputSchema, modelReasoningEfforts, modelReasoningError, resolveModelProfile,
  type ModelConfiguration, type ModelProfile, type ReasoningEffort } from '@xunjie/contracts/model-connections';

type Entry = { provider: string; api: string; id: string; canonical: string; levels?: ReasoningEffort[]; context?: number; output?: number };
type Cache = { entries: Entry[]; updatedAt: string; at: number };
const bare = (id: string) => id.toLowerCase().split('/').at(-1)!;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max ? Number(value) : undefined;

/** Provider ids never leave this process: the public catalogue is downloaded as a whole. */
export function createModelProfiles(requestFetch: typeof fetch = fetch, now = Date.now) {
  let cache: Cache | undefined, loading: Promise<void> | undefined;
  let lastTry: number | undefined;
  async function update(force = false) {
    if (loading) return loading;
    if (!force && (cache && now() - cache.at < 86400000 || lastTry !== undefined && now() - lastTry < 60000)) return;
    if (!loading) loading = (async () => {
      lastTry = now();
      const response = await requestFetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('catalogue-unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 32 * 1024 * 1024) throw new Error('catalogue-too-large');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const raw = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))), entries: Entry[] = [];
      for (const [providerId, source] of Object.entries(raw)) {
        const provider = record(source);
        for (const [id, sourceModel] of Object.entries(record(provider.models))) {
          const model = record(sourceModel), limit = record(model.limit);
          const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.map(record) : [];
          const effort = options.find(option => option.type === 'effort');
          const levels = Array.isArray(effort?.values) ? effort.values.filter((value): value is ReasoningEffort =>
            typeof value === 'string' && value !== 'auto' && (modelReasoningEfforts as readonly string[]).includes(value))
            : model.reasoning === false ? [] : undefined;
          const context = positive(limit.context, 10_000_000), output = positive(limit.output, 1_000_000);
          entries.push({ provider: providerId, api: typeof provider.api === 'string' ? provider.api : '', id,
            canonical: typeof model.canonical_model_id === 'string' ? model.canonical_model_id : '', ...(levels ? { levels } : {}),
            ...(context ? { context } : {}), ...(output ? { output } : {}) });
        }
      }
      if (!entries.length) throw new Error('catalogue-invalid');
      cache = { entries, updatedAt: new Date(now()).toISOString(), at: now() };
    })().finally(() => { loading = undefined; });
    await loading;
  }
  function resolve(route: Pick<ModelConfiguration, 'protocol' | 'baseUrl' | 'modelId'> & Partial<ModelConfiguration>): ModelProfile {
    const fallback = resolveModelProfile(route);
    if (route.reasoningLevels !== undefined) return { modelId: route.modelId, dialect: fallback.dialect, efforts: fallback.efforts, source: 'manual' };
    let host = ''; try { host = new URL(route.baseUrl).hostname.toLowerCase(); } catch { /* input contract reports malformed URLs */ }
    const exact = cache?.entries.filter(entry => [entry.id, entry.canonical].some(id => id.toLowerCase() === route.modelId.toLowerCase())) ?? [];
    const candidates = exact.length ? exact : cache?.entries.filter(entry => bare(entry.id) === bare(route.modelId) || entry.canonical && bare(entry.canonical) === bare(route.modelId)) ?? [];
    const own = candidates.find(entry => { try { return new URL(entry.api).hostname.toLowerCase() === host; } catch { return false; } });
    const provider = route.modelId.includes('/') ? route.modelId.split('/')[0]!.toLowerCase() : '';
    const direct = own ?? candidates.find(entry => entry.provider.toLowerCase() === provider);
    const withLevels = candidates.filter(entry => entry.levels !== undefined);
    // Without an exact supplier match, use only an unambiguous public declaration.
    const agreement = withLevels.length && withLevels.every(entry => JSON.stringify(entry.levels) === JSON.stringify(withLevels[0]!.levels));
    const matching = direct ?? (agreement ? withLevels[0] : undefined) ?? candidates[0];
    const declared = direct?.levels ?? (agreement ? withLevels[0]!.levels : undefined);
    // Catalogue facts describe a model, not measured compatibility at a relay.
    // Known incompatible protocol combinations must not gain controls from metadata.
    const levels = fallback.source === 'known' && fallback.encoding === 'none' ? undefined
      : declared?.filter(effort => !modelReasoningError({ ...route, reasoningLevels: declared, reasoningEffort: effort }));
    return { modelId: route.modelId, dialect: fallback.dialect, efforts: levels !== undefined ? ['auto', ...new Set(levels)] : fallback.efforts,
      source: levels !== undefined ? 'catalogue' : fallback.source === 'known' ? 'profile' : 'unknown',
      ...(matching?.context ? { contextWindow: matching.context } : {}), ...(matching?.output ? { maxOutputTokens: matching.output } : {}) };
  }
  async function read(value: unknown) {
    const input = modelProfilesInputSchema.parse(value);
    let failed = false; try { await update(input.refresh); } catch { failed = true; }
    return { profiles: input.modelIds.map(modelId => resolve({ baseUrl: input.baseUrl, protocol: input.protocol, modelId })),
      ...(cache ? { updatedAt: cache.updatedAt } : {}), stale: failed || !cache || now() - cache.at >= 86400000 };
  }
  return { read, resolve };
}
