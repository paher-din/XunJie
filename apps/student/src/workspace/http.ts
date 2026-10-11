/**
 * I0-A 的窄 HTTP 客户端。
 *
 * 只做 01 需要的读取能力（POST sessions、GET session、POST logout、按获准 ID 读
 * Assignment / Activity / Resource），路径、输入、信封与响应投影在准备与真实两种模式下完全相同，
 * 只有 base URL 按显式模式选择（docs/tasks/I0_UI_CLIENT_CONTRACT.md §2）。
 *
 * 三条硬规则：
 * 1. 逐层解包 HTTP 信封，不把 `data` 之外的东西当业务结果；
 * 2. 网络失败、超时与响应形状非法各自如实上报，不伪装成某个服务端错误码，也不回退成功；
 * 3. 不导入服务端模块，只消费 `contracts.ts` 里的可序列化投影。
 */

import type { ApiErrorBody, ErrorEnvelope, SuccessEnvelope } from './contracts'
import { apiBase, type WorkspaceMode } from './mode'

/** 一次请求的失败分类。`transport` 表示根本没拿到服务端信封。 */
export type RequestFailure =
  | { kind: 'transport'; message: string }
  | { kind: 'protocol'; status: number; message: string }
  | { kind: 'api'; status: number; requestId: string; error: ApiErrorBody }

export function describeFailure(failure: RequestFailure): string {
  switch (failure.kind) {
    case 'transport':
      return `网络不可用：${failure.message}`
    case 'protocol':
      return `响应不是合法 HTTP 信封（HTTP ${failure.status}）：${failure.message}`
    case 'api':
      return `${failure.error.code}（HTTP ${failure.status}）：${failure.error.message} · ${failure.error.recovery}`
  }
}

export class WorkspaceRequestError extends Error {
  readonly failure: RequestFailure
  readonly method: string
  readonly url: string

  constructor(failure: RequestFailure, method: string, url: string) {
    super(`${method} ${url} 失败 · ${describeFailure(failure)}`)
    this.name = 'WorkspaceRequestError'
    this.failure = failure
    this.method = method
    this.url = url
  }
}

/** 服务端错误体是否形状合法（`contracts/common/http.ts` 的 ErrorResponse）。 */
function asErrorBody(value: unknown): ApiErrorBody | null {
  if (typeof value !== 'object' || value === null) return null
  const e = value as Partial<ApiErrorBody>
  if (typeof e.code !== 'string' || typeof e.message !== 'string') return null
  if (typeof e.retryable !== 'boolean' || typeof e.recovery !== 'string') return null
  return { code: e.code as ApiErrorBody['code'], message: e.message, retryable: e.retryable, recovery: e.recovery }
}

/* ---------- CSRF ---------- */

/**
 * 当前会话的 CSRF token，来自 POST sessions / GET session 的响应。
 * 服务端要求除 GET/HEAD/OPTIONS 与 POST sessions 外的请求都带 `x-csrf-token`。
 * 只存 token，不存口令或 provider 凭据。
 */
let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function currentCsrfToken(): string | null {
  return csrfToken
}

/* ---------- 请求 ---------- */

export interface RequestOptions {
  mode: WorkspaceMode
  signal?: AbortSignal
  /** 跳过按模式拼 base，直接用这个路径（准备 bootstrap 元信息端点用）。 */
  absolutePath?: string
}

function urlOf(path: string, opts: RequestOptions): string {
  return opts.absolutePath ?? `${apiBase(opts.mode)}${path}`
}

async function request<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: RequestOptions): Promise<T> {
  const url = urlOf(path, opts)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    // POST sessions 本身豁免 CSRF（服务端据此下发 token）；其余写请求必须带。
    if (path !== '/sessions' && csrfToken) headers['x-csrf-token'] = csrfToken
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      signal: opts.signal,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    })
  } catch (e) {
    // 中断不是失败分类里的一种业务结果：调用方按上下文失效处理，不当成服务不可用展示
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    const message = e instanceof Error ? e.message : String(e)
    throw new WorkspaceRequestError({ kind: 'transport', message }, method, url)
  }

  let payload: unknown = null
  const text = await response.text()
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new WorkspaceRequestError(
        { kind: 'protocol', status: response.status, message: '响应体不是 JSON' },
        method,
        url,
      )
    }
  }

  if (!response.ok) {
    const envelope = payload as ErrorEnvelope | null
    const error = envelope && typeof envelope === 'object' ? asErrorBody(envelope.error) : null
    if (!error) {
      throw new WorkspaceRequestError(
        { kind: 'protocol', status: response.status, message: '失败响应缺少 error.code / error.message' },
        method,
        url,
      )
    }
    const requestId = envelope?.requestId ?? response.headers.get('x-request-id') ?? ''
    throw new WorkspaceRequestError(
      { kind: 'api', status: response.status, requestId, error },
      method,
      url,
    )
  }

  const envelope = payload as SuccessEnvelope<T> | null
  if (!envelope || typeof envelope !== 'object' || typeof envelope.requestId !== 'string' || !('data' in envelope)) {
    throw new WorkspaceRequestError(
      { kind: 'protocol', status: response.status, message: '成功响应缺少 requestId / data' },
      method,
      url,
    )
  }
  return envelope.data
}

export function apiGet<T>(path: string, opts: RequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, opts)
}

export function apiPost<T>(path: string, body: unknown, opts: RequestOptions): Promise<T> {
  return request<T>('POST', path, body, opts)
}
