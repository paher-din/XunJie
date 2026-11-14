import type { ModelUpstream } from '@xunjie/contracts/model-connections';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
const networkCodes = /^(?:EAI_AGAIN|ENOTFOUND|EAI_NONAME|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EPIPE|ETIMEDOUT|UND_ERR_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+|ERR_SSL_[A-Z0-9_]+|CERT_[A-Z0-9_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Diagnostic prose is untrusted. Remove authentication material before bounding it,
 * including reusable credential fragments and encoded echoes from gateways.
 */
function safeFact(value: unknown, apiKey: string, limit: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  let text = value.replace(/(?:["']?(?:proxy-authorization|authorization|x-api-key|api[_ -]?key)["']?\s*[:=]\s*)[^\r\n,;}]+/gi, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  if (apiKey) {
    for (const secret of new Set([apiKey, encodeURIComponent(apiKey.toWellFormed()), Buffer.from(apiKey).toString('base64')])) {
      text = text.split(secret).join('[redacted]');
      // Eight consecutive credential characters are already reusable material.
      // Redact their containing token rather than exposing a shortened secret.
      const fragments = new Set<string>();
      for (let index = 0; index <= secret.length - 8; index++) fragments.add(escape(secret.slice(index, index + 8)));
      if (fragments.size) text = text.replace(new RegExp('[A-Za-z0-9._~+\\/=:%-]*(?:' + [...fragments].join('|') + ')[A-Za-z0-9._~+\\/=:%-]*', 'g'), '[redacted]');
    }
  }
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') || undefined;
}

/** Shared by native SDK calls and bounded supplier HTTP diagnostics. No raw body,
 * stack, headers or native reasoning is projected through this allowlist.
 */
export function errorFacts(value: unknown, apiKey: string): Partial<ModelUpstream> {
  const outer = object(value);
  if (!outer) return {};
  let detail = outer;
  for (let depth = 0; depth < 4 && object(detail.error); depth++) detail = object(detail.error)!;
  const facts: Partial<ModelUpstream> = {};
  const code = safeFact(detail.code ?? detail.type ?? outer.code, apiKey, 100);
  const parameter = safeFact(detail.param ?? detail.parameter ?? outer.param, apiKey, 100);
  // SDK status wrappers can embed the complete non-JSON HTTP body in message.
  // Only an interpreted provider error message or a native transport message is useful.
  const rawBody = typeof detail.error === 'string' || detail === outer && value instanceof Error && typeof outer.status === 'number';
  const message = safeFact(rawBody ? undefined : detail.message, apiKey, 1000);
  if (code) facts.errorCode = code;
  if (parameter) facts.parameter = parameter;
  if (message) facts.message = message;
  const pending: unknown[] = [outer], seen = new Set<object>();
  for (let count = 0; pending.length && count < 32; count++) {
    const current = object(pending.shift());
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const nativeCode = current.code;
    if (typeof nativeCode === 'string' && networkCodes.test(nativeCode) && safeFact(nativeCode, apiKey, 80) === nativeCode)
      facts.networkCode = nativeCode;
    if (!facts.networkCode && ['TimeoutError', 'APIConnectionTimeoutError'].includes(String(current.name))) facts.networkCode = 'ETIMEDOUT';
    pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 16));
  }
  return facts;
}

export function networkFailureReason(facts: Partial<ModelUpstream>): string | undefined {
  const code = facts.networkCode;
  if (!code) return undefined;
  if (/^(?:EAI_|ENOTFOUND)/.test(code)) return 'upstream-dns';
  if (/TLS|SSL|CERT|ISSUER|SIGNATURE/.test(code)) return 'upstream-tls';
  if (/TIMEOUT|TIMEDOUT/.test(code)) return 'upstream-timeout';
  return 'upstream-network';
}

/** Classify an explicit refusal without exporting provider error prose or credentials. */
export function contextCapacityFailure(value: unknown, status?: number): boolean {
  if (status !== undefined && ![400, 413, 422].includes(status)) return false;
  if (!value || typeof value !== 'object') return false;
  const outer = value as Record<string, unknown>;
  const error = outer.error && typeof outer.error === 'object' ? outer.error as Record<string, unknown> : outer;
  if (['context_length_exceeded','context_window_exceeded','max_context_length_exceeded','prompt_too_long','input_too_long']
    .includes(String(error.code ?? error.type))) return true;
  return status !== undefined && typeof error.message === 'string'
    && /maximum context length|context (?:window|length).{0,40}exceed|(?:prompt|input) (?:is )?too long/i.test(error.message);
}

/** Only bounded, credential-free response facts may leave the credential holder. */
export function responseFacts(status: number, headers: Headers, apiKey: string): ModelUpstream {
  const facts: ModelUpstream = {};
  if (Number.isInteger(status) && status >= 100 && status <= 599) facts.httpStatus = status;
  const id = headers.get('request-id') ?? headers.get('x-request-id');
  if (id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) && safeFact(id, apiKey, 200) === id) facts.requestId = id;
  const retry = headers.get('retry-after'), milliseconds = headers.get('retry-after-ms');
  const numeric = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry)
    : !retry && milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds) ? Number(milliseconds) / 1000 : undefined;
  if (numeric !== undefined && Number.isFinite(numeric) && numeric <= 31536000) facts.retryAfterSeconds = numeric;
  else if (retry && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) && Number.isFinite(Date.parse(retry)))
    facts.retryAt = new Date(retry).toISOString();
  return facts;
}
