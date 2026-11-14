import { StorageError } from '@xunjie/storage';
import type { ModelConnectionTestResult, ModelDirectoryRefresh } from '@xunjie/contracts/model-connections';
import { CatalogueFailure, readCatalogueJson } from './catalogue-cache.js';
import { errorFacts, networkFailureReason, responseFacts } from './upstream-facts.js';

type Diagnostic = NonNullable<ModelDirectoryRefresh['diagnostic']>;
const diagnostic = (code: string, message: string, suggestion: string, field?: Diagnostic['field']): Diagnostic =>
  ({ code, message, suggestion, ...(field ? { field } : {}) });
export const supplierCancelled = () => diagnostic('cancelled', '已停止连接测试或模型拉取。', '需要时可重新尝试。');
export const supplierPassed = () => diagnostic('models-accessible', '已使用当前 API Key 读取供应商模型目录。', '目录访问成功；生成能力请通过模型测试确认。');
export const supplierMissingCredential = () => diagnostic('missing-credential', '尚未提供可用的 API Key。', '填写 API Key 或选择仍有效的已保存凭据。', 'apiKey');

function quotaFailure(upstream: NonNullable<ModelDirectoryRefresh['upstream']>): boolean {
  if (/quota|balance|billing|credits?|budget|payment/i.test(upstream.errorCode ?? '')) return true;
  return [
    /\b(?:insufficient|exhausted|depleted|exceed(?:ed)?|low|negative)\s+(?:(?:your|current|account)\s+)*(?:quota|balance|credits?|budget|funds)\b/i,
    /\b(?:quota|balance|credits?|budget|funds)\s+(?:(?:is|are|has|been)\s+)*(?:exceeded|exhausted|depleted|insufficient|low|negative)\b/i,
    /\bbilling\s+(?:is\s+)?(?:(?:hard|soft)\s+limit|disabled|inactive|suspended|not\s+active)\b|\bpayment\s+(?:required|overdue|failed)\b/i,
    /余额不足|欠费|(?:额度|配额|余额).{0,12}(?:不足|耗尽|用尽)/,
  ].some(pattern => pattern.test(upstream.message ?? ''));
}

export function supplierFailure(error: unknown, secret = '', signal?: AbortSignal): CatalogueFailure {
  if (error instanceof CatalogueFailure && error.diagnostic) return error;
  const upstream = error instanceof CatalogueFailure ? { ...error.upstream } : errorFacts(error, secret);
  const status = error instanceof CatalogueFailure ? error.httpStatus : upstream.httpStatus;
  const networkReason = networkFailureReason(upstream);
  const timeout = signal?.reason instanceof Error && signal.reason.name === 'TimeoutError'
    || error instanceof Error && error.name === 'TimeoutError';
  const kind = timeout || networkReason === 'upstream-timeout' ? 'timeout' : error instanceof CatalogueFailure ? error.kind : 'offline';
  let detail: Diagnostic;
  if (status === 401) detail = diagnostic('http-401', '供应商拒绝了 API Key（HTTP 401）。', '检查当前 API Key 是否正确、有效。', 'apiKey');
  else if (status === 403) detail = diagnostic('http-403', '供应商拒绝访问模型目录（HTTP 403）。', '检查 API Key 权限、账户状态和访问限制。', 'apiKey');
  else if (status === 404 || status === 405) detail = diagnostic('models-endpoint-unavailable', `供应商未开放此模型目录接口（HTTP ${status}）。`, '目录接口无法确认连接；可手动填写模型后执行模型测试。', 'baseUrl');
  else if (status === 429) detail = quotaFailure(upstream)
    ? diagnostic('upstream-quota', '供应商报告账户额度、余额或计费状态异常（HTTP 429）。', '检查供应商控制台的额度、余额与计费状态；补充额度、等待配额重置或恢复计费后重试。')
    : diagnostic('http-429', '供应商限制了请求频率（HTTP 429）。', '减少并发请求，并按供应商指定的重试时间稍后再试。');
  else if (kind === 'invalid-response') detail = diagnostic('invalid-models-response', '模型目录未返回可识别的模型列表。', '可手动填写模型后执行模型测试。');
  else if (status) detail = diagnostic(`http-${status}`, `供应商模型目录返回 HTTP ${status}。`, '检查供应商服务状态、地址和账户后重试。');
  else if (timeout) detail = diagnostic('timeout', '模型目录请求超过 10 秒。', '检查地址与网络后重试。', 'baseUrl');
  else if (error instanceof StorageError && (error.code === 'invalid' || error.code === 'forbidden'))
    detail = diagnostic('invalid-target', '供应商地址不符合当前环境的访问规则。', '检查 API 基础地址、协议和目标网络。', 'baseUrl');
  else if (error instanceof StorageError && ['conflict', 'missing'].includes(error.code))
    detail = diagnostic('saved-credential-mismatch', '已保存凭据与当前账户、版本或供应商目标不匹配。', '重新选择已保存连接，或填写当前 API Key。', 'apiKey');
  else if (networkReason === 'upstream-dns')
    detail = diagnostic(networkReason, '无法通过 DNS 解析供应商地址。', '检查 API 基础地址中的域名是否正确，并检查 DNS 设置与网络连接后重试。', 'baseUrl');
  else if (networkReason === 'upstream-tls')
    detail = diagnostic(networkReason, '与供应商建立 TLS 连接失败，可能存在证书或握手问题。', '检查系统时间、供应商 HTTPS 证书及代理证书配置，修复后重试。', 'baseUrl');
  else if (networkReason === 'upstream-timeout' || kind === 'timeout')
    detail = diagnostic(networkReason ?? 'timeout', '读取供应商模型目录超时。', '检查供应商服务状态、网络与代理连接后重试。', 'baseUrl');
  else if (networkReason === 'upstream-network')
    detail = diagnostic(networkReason, '与供应商的网络连接失败或已中断。', '检查供应商地址与端口、服务状态及网络或代理连接后重试。', 'baseUrl');
  else detail = diagnostic('network-error', '无法访问供应商模型目录。', '检查地址、DNS 与网络连接后重试。', 'baseUrl');
  return new CatalogueFailure(kind, error instanceof CatalogueFailure ? error.retryAfter : undefined, status, detail,
    Object.keys(upstream).length ? upstream : undefined);
}

export function supplierTestStatus(failure: CatalogueFailure): ModelConnectionTestResult['status'] {
  return failure.httpStatus === 404 || failure.httpStatus === 405 || failure.kind === 'invalid-response' ? 'unverified' : 'failed';
}

/** Read only a bounded error object; the shared extractor discards credentials and raw prose. */
export async function readSupplierJson(response: Response, secret: string, now: () => number): Promise<{ value: unknown; upstream: NonNullable<ModelDirectoryRefresh['upstream']> }> {
  const upstream = responseFacts(response.status, response.headers, secret);
  if (response.ok) {
    if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => {});
      throw supplierFailure(new CatalogueFailure('invalid-response', undefined, response.status, undefined, upstream), secret);
    }
    try { return { value: await readCatalogueJson(response, now), upstream }; }
    catch (error) {
      const failure = error instanceof CatalogueFailure ? error : new CatalogueFailure('invalid-response');
      throw supplierFailure(new CatalogueFailure(failure.kind, failure.retryAfter, response.status, undefined, upstream), secret);
    }
  }
  let body: unknown;
  try { body = await readCatalogueJson(new Response(response.body), now, 16 * 1024); } catch { /* optional error body */ }
  Object.assign(upstream, errorFacts(body, secret));
  const retryAfter = upstream.retryAt ? Date.parse(upstream.retryAt)
    : upstream.retryAfterSeconds !== undefined ? now() + upstream.retryAfterSeconds * 1000 : undefined;
  throw supplierFailure(new CatalogueFailure(response.status === 401 || response.status === 403 ? 'unauthorized'
    : response.status === 429 ? 'rate-limited' : 'unavailable', retryAfter, response.status, undefined, upstream), secret);
}

/** A signal also bounds preparatory DNS promises and uncooperative injected transports. */
export function supplierBounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { operation.catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
