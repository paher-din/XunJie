import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiSdkDeepSeekProvider } from '../deepseek-sdk.ts';

export const realModelEnabled = process.env.XUNJIE_P2_REAL_MODEL === 'approved-synthetic';
const requiredNodeVersion = '24.21.0';
type HttpOutcome = 'response' | 'provider_error' | 'cancelled' | 'timed_out' | 'network_error';
export type HttpFact = {
  startedAt: string;
  finishedAt?: string;
  latencyMs?: number;
  outcome?: HttpOutcome;
  status?: number;
  model?: string;
  fingerprint?: string;
  tokens?: Record<string, number>;
  visibleOutput?: string;
};

const sensitiveEvidenceKey = /^(?:authorization|proxy-authorization|api[_-]?key|cookie|set-cookie|csrf(?:[_-]?token)?|password|lease[_-]?token|reasoning(?:_content)?)$/i;

export function assertSafeEvidence(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidence(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveEvidenceKey.test(key)) throw new Error(`Sensitive evidence field is not allowed at ${path}.${key}.`);
    assertSafeEvidence(nested, `${path}.${key}`);
  }
}

function failureOutcome(error: unknown, signal?: AbortSignal | null): HttpOutcome {
  const errorName = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  const reason = signal?.reason;
  const reasonName = reason && typeof reason === 'object' && 'name' in reason ? String(reason.name) : '';
  if (errorName === 'TimeoutError' || reasonName === 'TimeoutError') return 'timed_out';
  if (signal?.aborted || errorName === 'AbortError') return 'cancelled';
  return 'network_error';
}

export function createObservedModelFetch(
  http: HttpFact[],
  transport: typeof fetch = fetch,
  now: () => number = Date.now,
  onStart?: (attemptIndex: number) => void,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const startedAtMs = now();
    const fact: HttpFact = { startedAt: new Date(startedAtMs).toISOString() };
    http.push(fact);
    onStart?.(http.length - 1);
    try {
      const response = await transport(input, init);
      fact.status = response.status;
      fact.outcome = response.ok ? 'response' : 'provider_error';
      try {
        const raw: unknown = await response.clone().json();
        if (raw && typeof raw === 'object') {
          const fields = raw as Record<string, unknown>;
          if (typeof fields.model === 'string') fact.model = fields.model;
          if (typeof fields.system_fingerprint === 'string') fact.fingerprint = fields.system_fingerprint;
          const choices = fields.choices;
          if (Array.isArray(choices)) {
            const first = choices[0];
            if (first && typeof first === 'object') {
              const message = (first as Record<string, unknown>).message;
              if (message && typeof message === 'object') {
                const content = (message as Record<string, unknown>).content;
                if (typeof content === 'string') fact.visibleOutput = content.slice(0, 65_536);
              }
            }
          }
          if (fields.usage && typeof fields.usage === 'object') {
            const usage = fields.usage as Record<string, unknown>;
            const tokens: Record<string, number> = {};
            for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
              const value = usage[key];
              if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens[key] = value;
            }
            fact.tokens = tokens;
          }
        }
      } catch { /* Missing transport metadata stays unknown; the original response goes to the SDK. */ }
      return response;
    } catch (error) {
      fact.outcome = failureOutcome(error, init?.signal);
      throw error;
    } finally {
      const finishedAtMs = now();
      fact.finishedAt = new Date(finishedAtMs).toISOString();
      fact.latencyMs = Math.max(0, finishedAtMs - startedAtMs);
    }
  }) as typeof fetch;
}

export function assertRealModelRuntime(version = process.versions.node): void {
  if (version !== requiredNodeVersion) {
    throw new Error(`P2 real-model validation requires Node ${requiredNodeVersion}; received ${version}.`);
  }
}

export const realFailureProbeEnabled = process.env.XUNJIE_P2_REAL_FAILURES === 'approved-synthetic';
export const realPerformanceBatchEnabled = process.env.XUNJIE_P2_REAL_PERFORMANCE === 'approved-synthetic';
export const realSemanticFixBatchEnabled = process.env.XUNJIE_P2_REAL_SEMANTIC_FIXES === 'approved-synthetic';

export function assertRealFailureProbeAuthorization(): void {
  if (!realFailureProbeEnabled) {
    throw new Error('Explicit P2 real-provider failure-probe authorization is required.');
  }
}

export function assertRealPerformanceBatchAuthorization(): void {
  if (!realPerformanceBatchEnabled) {
    throw new Error('Explicit P2 30-job synthetic performance authorization is required.');
  }
}

export function assertRealSemanticFixBatchAuthorization(): void {
  if (!realSemanticFixBatchEnabled) {
    throw new Error('Explicit P2 two-job synthetic semantic-fix authorization is required.');
  }
}

export function realModelProbe(options: { onRequestStart?: (attemptIndex: number) => void } = {}) {
  assertRealModelRuntime();
  if (!realModelEnabled) throw new Error('Explicit P2 synthetic-data model authorization is required.');
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new Error('DEEPSEEK_API_KEY is not configured through the approved local channel.');
  const http: HttpFact[] = [];
  const baseURL = 'https://api.deepseek.com';
  const observedFetch = createObservedModelFetch(http, fetch, Date.now, options.onRequestStart);
  const provider = createAiSdkDeepSeekProvider({ apiKey, baseURL, fetch: observedFetch });
  const requestExpectedProviderFailure = (signal: AbortSignal) => observedFetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Synthetic failure probe; do not process real data.' }],
      max_tokens: 0,
    }),
    signal,
  });
  return { provider, http, requestExpectedProviderFailure };
}

export function writeRealModelEvidence(purpose: string, data: Record<string, unknown>, http: readonly HttpFact[]) {
  assertSafeEvidence({ data, http });
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const serialized = JSON.stringify({ data, http });
  if (apiKey && serialized.includes(apiKey)) throw new Error('API credential material must not be written to evidence.');
  const directory = mkdtempSync(join(tmpdir(), 'xunjie-p2-real-model-'));
  chmodSync(directory, 0o700);
  const file = join(directory, 'evidence.json');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8',
  }).trim();
  const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8',
  }).trim());
  writeFileSync(file, JSON.stringify({ purpose, sourceCommit, sourceDirty, node: process.version, model: 'deepseek-flash',
    dataScope: 'synthetic-only', recordedAt: new Date().toISOString(), http, data }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
  return file;
}
