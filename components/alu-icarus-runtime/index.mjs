import { bundleIdentity, dependencyIdentity } from './identity.mjs';
let liveWorkers = 0;
function oversizedFiles(files) {
  if (!Array.isArray(files)) return false; // Detailed shape errors are checked in the Worker.
  return files.length > 64 || files.reduce((size, file) => size + (typeof file?.content === 'string' ? file.content.length : 0), 0) > 1024 * 1024;
}
const inputFailure = () => ({ status: 'failed', code: 'input-budget', stage: 'before-dispatch', diagnostics: [] });

// The caller owns execution identities, retained observations and authorization.
// This adapter owns only a bounded Worker and a disposable compilation cache.
export async function createIcarusRuntime(descriptor) {
  const bundle = structuredClone(descriptor);
  if (await bundleIdentity(bundle.assets, bundle.adapters) !== bundle.identity) throw new Error('Runtime manifest identity mismatch');
  bundle.baseUrl = new URL(bundle.baseUrl).href;
  if (!bundle.baseUrl.endsWith('/')) throw new Error('Runtime base URL must end with /');
  const cache = new Map(); let cacheBytes = 0, active = false;
  function execute(task, { signal, timeoutMs = task.kind === 'compile' ? 30_000 : 5_000, onStage } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Timeout must be 1..60000 ms');
    if (signal?.aborted) return Promise.resolve({ status: 'stopped', stage: 'before-dispatch' });
    if (active || liveWorkers >= 1) return Promise.resolve({ status: 'failed', code: 'busy', stage: 'before-dispatch' });
    active = true; liveWorkers++;
    return new Promise(resolve => {
      let worker, timer, settled = false, stage = 'starting';
      const settle = value => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
        worker?.terminate(); active = false; liveWorkers--; resolve(value);
      };
      const stop = () => settle({ status: 'stopped', stage });
      try {
        worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) { stop(); return; }
        timer = setTimeout(() => settle({ status: 'budget-exceeded', code: 'wall-time', stage }), timeoutMs);
        worker.onmessage = ({ data }) => {
          if (data.kind === 'stage') {
            stage = data.stage;
            try { onStage?.(stage); } catch { /* Observers cannot prevent termination. */ }
          } else if (data.kind === 'result') settle(data);
        };
        worker.onerror = event => settle({ status: 'failed', code: 'worker-failed', stage, message: event.message });
        worker.onmessageerror = () => settle({ status: 'failed', code: 'worker-message', stage });
        worker.postMessage({ task, bundle });
      } catch (error) { settle({ status: 'failed', code: 'worker-unavailable', stage, message: String(error) }); }
    });
  }
  return {
    async compile(request, controls = {}) {
      if (oversizedFiles(request?.sources) || request?.entryFiles?.length > 64 || request?.top?.length > 200
        || request?.options?.includeDirs?.length > 32) return { ...inputFailure(), cacheHit: false };
      const task = { ...structuredClone(request), kind: 'compile' };
      // Reject unsupported options in the Worker even if a matching cache exists.
      const opts = task.options ?? {};
      const optionsValid = typeof opts === 'object' && !Array.isArray(opts)
        && Object.keys(opts).every(key => ['includeDirs', 'strictExprWidth'].includes(key))
        && (opts.strictExprWidth === undefined || typeof opts.strictExprWidth === 'boolean')
        && (opts.includeDirs === undefined || (Array.isArray(opts.includeDirs) && opts.includeDirs.length <= 32
          && opts.includeDirs.every(path => typeof path === 'string' && path.length <= 200 && /^[a-zA-Z0-9_.\-/]+$/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'))));
      const key = await dependencyIdentity(bundle.identity, task);
      if (optionsValid && cache.has(key) && !controls.signal?.aborted) {
        const cached = cache.get(key); cache.delete(key); cache.set(key, cached);
        return { ...structuredClone(cached), cacheHit: true };
      }
      const result = await execute(task, controls);
      if (result.status === 'completed') {
        const bytes = result.artifact.program.length;
        while (cache.size && (cache.size >= 8 || cacheBytes + bytes > 32 * 1024 * 1024)) {
          const oldest = cache.keys().next().value;
          cacheBytes -= cache.get(oldest).artifact.program.length; cache.delete(oldest);
        }
        cache.set(key, structuredClone(result)); cacheBytes += bytes;
      }
      return { ...result, cacheHit: false };
    },
    simulate(request, controls) {
      if (oversizedFiles(request?.files) || request?.artifact?.program?.length > 8 * 1024 * 1024
        || request?.plusargs?.length > 32 || request?.expectedIndices?.length > 4096) return Promise.resolve(inputFailure());
      return execute({ ...structuredClone(request), kind: 'simulate' }, controls);
    },
    clearCache() { cache.clear(); cacheBytes = 0; },
  };
}
