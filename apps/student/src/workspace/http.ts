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
let sessionEpoch = 0
const activeSessionRequests = new Set<AbortController>()
const sessionExpiredListeners = new Set<() => void>()
const sessionReadListeners = new Set<(value: unknown) => void>()

export function onSessionRead(listener: (value: unknown) => void): void {
  sessionReadListeners.add(listener)
}

export function invalidateSessionRequests(): void {
  sessionEpoch += 1
  // 取消旧 HTTP 也阻止其迟到 Set-Cookie 改写新会话；数据接纳仍独立核代次/上下文。
  for (const controller of activeSessionRequests) controller.abort()
  activeSessionRequests.clear()
}

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener)
  return () => { sessionExpiredListeners.delete(listener) }
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

/* ---------- 请求 ---------- */

export interface RequestOptions {
  mode: WorkspaceMode
  /** 跳过按模式拼 base，直接用这个路径（准备 bootstrap 元信息端点用）。 */
  absolutePath?: string
  idempotencyKey?: string
  /** 仅开发准备 fixture 的场景隔离，不进入业务正文或真实请求。 */
  scenarioId?: string
  /** 会话入口限定等待，超时仍是传输失败，不伪造业务结论。 */
  timeoutMs?: number
}

function urlOf(path: string, opts: RequestOptions): string {
  return opts.absolutePath ?? `${apiBase(opts.mode)}${path}`
}

async function request<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: RequestOptions, wireJson?: string): Promise<T> {
  const url = urlOf(path, opts)
  const epoch = sessionEpoch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (import.meta.env.DEV && opts.mode === 'preparation') {
    const scenario = opts.scenarioId ?? new URLSearchParams(globalThis.location?.search ?? '').get('scenario')
    if (scenario) headers['x-i0prep-scenario'] = scenario
  }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    // POST sessions 本身豁免 CSRF（服务端据此下发 token）；其余写请求必须带。
    if (path !== '/sessions' && csrfToken) headers['x-csrf-token'] = csrfToken
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  }

  let response: Response
  let text: string
  const controller = opts.mode === 'real' || opts.timeoutMs ? new AbortController() : undefined
  if (opts.mode === 'real' && controller) activeSessionRequests.add(controller)
  const timer = controller && opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: method === 'POST' ? (wireJson ?? JSON.stringify(body ?? {})) : undefined,
      signal: controller?.signal,
    })
    text = await response.text()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new WorkspaceRequestError({ kind: 'transport', message }, method, url)
  } finally {
    clearTimeout(timer)
    if (controller) activeSessionRequests.delete(controller)
  }

  let payload: unknown = null
  // 会话改变后，旧成功或旧 401 都不能影响下一账号，包括 CSRF 与本机 ACK。
  if (opts.mode === 'real' && epoch !== sessionEpoch) {
    throw new WorkspaceRequestError({ kind: 'transport', message: '原会话请求已失效' }, method, url)
  }
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
    // requestId只取自信封；正常宿主同时下发x-request-id，客户端不依赖响应头补造缺失信封。
    const requestId = typeof envelope?.requestId === 'string' ? envelope.requestId : ''
    if (opts.mode === 'real' && path !== '/sessions' && response.status === 401 && error.code === 'UNAUTHENTICATED') {
      for (const listener of sessionExpiredListeners) listener()
    }
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
  if (opts.mode === 'real' && method === 'GET' && path === '/session') {
    for (const listener of sessionReadListeners) listener(envelope.data)
  }
  return envelope.data
}

export function apiGet<T>(path: string, opts: RequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, opts)
}

export function apiPost<T>(path: string, body: unknown, opts: RequestOptions): Promise<T> {
  return request<T>('POST', path, body, opts)
}

/** 只发送已经持久化的原 JSON 字节；Session/CSRF 仍在发送时取得。 */
export function apiPostFrozen<T>(path: string, wireJson: string, opts: RequestOptions): Promise<T> {
  return request<T>('POST', path, undefined, opts, wireJson)
}
