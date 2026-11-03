import type { ModelUpstream } from '@xunjie/contracts/model-connections';

/** Only bounded, credential-free response facts may leave the credential holder. */
export function responseFacts(status: number, headers: Headers, apiKey: string): ModelUpstream {
  const facts: ModelUpstream = {};
  if (Number.isInteger(status) && status >= 100 && status <= 599) facts.httpStatus = status;
  const id = headers.get('request-id') ?? headers.get('x-request-id');
  if (id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) && (!apiKey || !id.includes(apiKey))) facts.requestId = id;
  const retry = headers.get('retry-after'), milliseconds = headers.get('retry-after-ms');
  const numeric = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry)
    : !retry && milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds) ? Number(milliseconds) / 1000 : undefined;
  if (numeric !== undefined && Number.isFinite(numeric) && numeric <= 31536000) facts.retryAfterSeconds = numeric;
  else if (retry && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) && Number.isFinite(Date.parse(retry)))
    facts.retryAt = new Date(retry).toISOString();
  return facts;
}
