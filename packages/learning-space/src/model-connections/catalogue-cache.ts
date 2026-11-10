import { randomUUID } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { modelDirectoryRefreshSchema, type ModelDirectoryRefresh } from '@xunjie/contracts/model-connections';

export const modelCatalogueMigration: Migration = { version: 21, name: 'model-directory-cache', sql: `
  CREATE TABLE model_directory_cache(cache_key text PRIMARY KEY,body jsonb NOT NULL);
` };
export type CatalogueState = { data?: unknown; lastAttemptAt?: number; successAt?: number; retryAt?: number;
  failures: number; error?: NonNullable<ModelDirectoryRefresh['error']>; httpStatus?: number };
export type CataloguePersistence = { load(): Promise<Map<string, CatalogueState>>; save(key: string, state: CatalogueState): Promise<void> };
const ordinaryInterval = 10 * 60_000, manualDebounce = 3000;
const delays = [5000, 15000, 30000, 60000, 120000, 240000, 300000];
const iso = (value: number) => new Date(value).toISOString();

export class CatalogueFailure extends Error {
  constructor(readonly kind: NonNullable<ModelDirectoryRefresh['error']>, readonly retryAfter?: number, readonly httpStatus?: number) { super(kind); }
}
function validState(value: unknown): value is CatalogueState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as CatalogueState;
  return Number.isSafeInteger(state.failures) && state.failures >= 0
    && ['lastAttemptAt', 'successAt', 'retryAt'].every(key => {
      const time = state[key as 'lastAttemptAt']; return time === undefined || Number.isSafeInteger(time) && time >= 0 && time < 8.64e15;
    }) && modelDirectoryRefreshSchema.safeParse({ status: 'idle', ...(state.error ? { error: state.error } : {}),
      ...(state.httpStatus !== undefined ? { httpStatus: state.httpStatus } : {}) }).success;
}
export function cataloguePersistence(storage: OwnedStorage): CataloguePersistence {
  return {
    async load() {
      const { rows } = await storage.read('SELECT cache_key,body FROM model_directory_cache');
      const states = new Map<string, CatalogueState>();
      for (const row of rows) {
        if (typeof row.cache_key !== 'string' || !validState(row.body)) throw new StorageError('corrupt');
        states.set(row.cache_key, row.body);
      }
      return states;
    },
    async save(key, state) {
      await storage.request({ requestId: randomUUID(), fingerprint: 'model-directory-cache-v1' }, async tx => {
        await tx.query(`INSERT INTO model_directory_cache VALUES($1,$2)
          ON CONFLICT(cache_key) DO UPDATE SET body=EXCLUDED.body`, [key, state]);
        return null;
      });
    },
  };
}

/** No timer and no startup network. Each source commits independently, before its waiter resolves. */
export function createCatalogueCache(now = Date.now, persistence?: CataloguePersistence) {
  let states = new Map<string, CatalogueState>(), closed = false;
  const loading = new Map<string, { promise: Promise<ModelDirectoryRefresh>; controller: AbortController }>();
  async function initialize() { if (persistence) states = await persistence.load(); }
  const state = (key: string) => states.get(key);
  function read(key: string): ModelDirectoryRefresh {
    const value = states.get(key);
    return { status: loading.has(key) ? 'refreshing' : value?.error ? 'failed' : value?.successAt !== undefined ? 'ready' : 'idle',
      ...(value?.lastAttemptAt !== undefined ? { lastAttemptAt: iso(value.lastAttemptAt), nextRefreshAt: iso(value.lastAttemptAt + ordinaryInterval) } : {}),
      ...(value?.successAt !== undefined ? { updatedAt: iso(value.successAt) } : {}),
      ...(value?.retryAt !== undefined ? { retryAt: iso(value.retryAt) } : {}), ...(value?.error ? { error: value.error } : {}),
      ...(value?.httpStatus !== undefined ? { httpStatus: value.httpStatus } : {}) };
  }
  function refresh(key: string, fetcher: (signal: AbortSignal) => Promise<unknown>, manual = false): Promise<ModelDirectoryRefresh> {
    const current = loading.get(key); if (current) return current.promise;
    if (closed) return Promise.reject(new StorageError('maintenance'));
    const previous = states.get(key), time = now();
    const intervalGate = previous?.lastAttemptAt !== undefined ? previous.lastAttemptAt + ordinaryInterval : 0;
    // Ordinary UI events never make repeated attempts within ten minutes. An explicit retry
    // can bypass that interval, but cannot bypass provider/failure backoff or success-click debounce.
    const waitUntil = manual ? previous?.error ? previous.retryAt ?? 0 : previous?.lastAttemptAt !== undefined
      ? Math.max(previous.lastAttemptAt, previous.successAt ?? 0) + manualDebounce : 0
      : Math.max(intervalGate, previous?.retryAt ?? 0);
    if (time < waitUntil) return Promise.resolve({ ...read(key), status: 'cooldown' });
    const controller = new AbortController();
    const value: CatalogueState = { ...previous, failures: previous?.failures ?? 0, lastAttemptAt: time };
    states.set(key, value);
    const promise = (async () => {
      // Persist attempt-start before leaving the machine, including failed/offline attempts.
      await persistence?.save(key, value);
      try {
        controller.signal.throwIfAborted();
        const data = await fetcher(controller.signal);
        controller.signal.throwIfAborted();
        const next: CatalogueState = { data, failures: 0, lastAttemptAt: time, successAt: now() };
        await persistence?.save(key, next); states.set(key, next);
      } catch (error) {
        const failure = error instanceof CatalogueFailure ? error : new CatalogueFailure(error instanceof StorageError ? 'unavailable'
          : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'offline');
        const failures = Math.min(value.failures + 1, 1000);
        const next: CatalogueState = { ...value, failures, error: failure.kind,
          retryAt: Math.max(now() + delays[Math.min(failures - 1, delays.length - 1)]!, failure.retryAfter ?? 0) };
        if (failure.httpStatus !== undefined) next.httpStatus = failure.httpStatus;
        else delete next.httpStatus;
        await persistence?.save(key, next); states.set(key, next);
      }
      return read(key);
    })().finally(() => { loading.delete(key); }).then(() => read(key));
    loading.set(key, { promise, controller });
    return promise;
  }
  return { initialize, read, state, refresh,
    entries: () => [...states.entries()],
    close() { closed = true; for (const active of loading.values()) active.controller.abort(); },
    resume() { closed = false; },
    async drain() { await Promise.all([...loading.values()].map(active => active.promise)); },
    async validate() {
      const persisted = persistence ? await persistence.load() : states;
      for (const value of persisted.values()) if (!validState(value)) throw new StorageError('corrupt');
    },
  };
}
export type CatalogueCache = ReturnType<typeof createCatalogueCache>;

export async function readCatalogueJson(response: Response, now = Date.now, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const retryAfter = retry ? /^\d+(?:\.\d+)?$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry) : undefined;
    await response.body?.cancel().catch(() => {});
    throw new CatalogueFailure(response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 429 ? 'rate-limited' : 'unavailable',
    retryAfter !== undefined && Number.isFinite(retryAfter) ? Math.min(retryAfter, now() + 365 * 86400_000) : undefined, response.status);
  }
  if (!response.body) throw new CatalogueFailure('invalid-response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new CatalogueFailure('invalid-response');
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CatalogueFailure('invalid-response'); }
  } finally { await reader.cancel().catch(() => {}); }
}
