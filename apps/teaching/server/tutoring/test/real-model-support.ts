import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiSdkDeepSeekProvider } from '../deepseek-sdk.ts';

export const realModelEnabled = process.env.XUNJIE_P2_REAL_MODEL === 'approved-synthetic';
type HttpFact = { startedAt: string; status?: number; model?: string; fingerprint?: string; tokens?: Record<string, number> };

export function realModelProbe() {
  if (!realModelEnabled) throw new Error('Explicit P2 synthetic-data model authorization is required.');
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new Error('DEEPSEEK_API_KEY is not configured through the approved local channel.');
  const http: HttpFact[] = [];
  const provider = createAiSdkDeepSeekProvider({ apiKey, baseURL: 'https://api.deepseek.com',
    fetch: async (input, init) => {
      const fact: HttpFact = { startedAt: new Date().toISOString() };
      http.push(fact);
      const response = await fetch(input, init);
      fact.status = response.status;
      try {
        const raw: unknown = await response.clone().json();
        if (raw && typeof raw === 'object') {
          const fields = raw as Record<string, unknown>;
          if (typeof fields.model === 'string') fact.model = fields.model;
          if (typeof fields.system_fingerprint === 'string') fact.fingerprint = fields.system_fingerprint;
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
    } });
  return { provider, http };
}

export function writeRealModelEvidence(purpose: string, data: Record<string, unknown>, http: readonly HttpFact[]) {
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
