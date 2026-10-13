import type { ModelProvider } from './settings'
import { PREP_BUILD } from '../workspace/mode'

/**
 * 供应商连接测试（docs/settings-design.md 已确认的混合方案）：
 * 自定义供应商真实发起 OpenAI 兼容的 GET /models 请求；
 * 浏览器 CORS 限制导致的失败如实说明，桌面版落地后自动重试。
 * 预置「学校统一接入」走模拟测试（演示路径恒成功），结果文案明确标「模拟」。
 *
 * I0-A 准备模式（`npm run dev:prep`）下**不发起任何外部请求**：设置入口只报告能力不可用，
 * 不把代码、凭据或材料送到模型服务。真实模式保留原设计行为。
 */

export type TestResult =
  | { ok: true; latencyMs: number; modelCount: number | null; simulated?: boolean }
  | { ok: false; kind: 'auth' | 'not-found' | 'http' | 'cors' | 'timeout' | 'blocked-preparation'; status?: number }

/** 探测请求的超时上限（毫秒）：不再有用户可调的超时配置，取原高级配置的默认档。 */
const TEST_TIMEOUT_MS = 30_000

export async function testProviderConnection(p: Pick<ModelProvider, 'baseUrl' | 'apiKey'>): Promise<TestResult> {
  // 准备模式：直接判为不可用，不发 fetch（生产构建里这个分支被静态消除）
  if (PREP_BUILD) return { ok: false, kind: 'blocked-preparation' }
  const base = p.baseUrl.trim().replace(/\/+$/, '')
  const started = performance.now()
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/models`, {
      signal: ctrl.signal,
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : undefined,
    })
    const latencyMs = Math.round(performance.now() - started)
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', status: res.status }
    if (res.status === 404) return { ok: false, kind: 'not-found', status: 404 }
    if (!res.ok) return { ok: false, kind: 'http', status: res.status }
    let modelCount: number | null = null
    try {
      const body = await res.json() as { data?: unknown[] }
      if (Array.isArray(body.data)) modelCount = body.data.length
    } catch {
      // 响应非 JSON 也视为连接成功
    }
    return { ok: true, latencyMs, modelCount }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, kind: 'timeout' }
    // 浏览器下 CORS 与网络不可达都表现为 TypeError，无法进一步区分
    return { ok: false, kind: 'cors' }
  } finally {
    window.clearTimeout(timer)
  }
}

/** 预置学校服务的模拟测试：850ms 后恒成功，不发网络请求，结果明确标「模拟」。 */
export function testSchoolConnection(): Promise<TestResult> {
  return new Promise((resolve) =>
    window.setTimeout(() => resolve({ ok: true, latencyMs: 42, modelCount: 2, simulated: true }), 850),
  )
}

export function testResultText(r: TestResult): { ok: boolean; text: string } {
  if (r.ok) {
    const tag = r.simulated ? '连接成功（模拟，未发起真实请求）' : '连接成功'
    return {
      ok: true,
      text: `${tag} · ${r.latencyMs}ms${r.modelCount != null ? ` · ${r.modelCount} 个可用模型` : ''}`,
    }
  }
  switch (r.kind) {
    case 'auth':
      return { ok: false, text: `鉴权失败（HTTP ${r.status}），请检查 API Key` }
    case 'not-found':
      return { ok: false, text: '服务端点未找到（HTTP 404），请检查 Base URL 是否正确' }
    case 'timeout':
      return { ok: false, text: '请求超时，请检查网络连接或服务可用性' }
    case 'http':
      return { ok: false, text: `服务响应异常（HTTP ${r.status}）` }
    case 'cors':
      return { ok: false, text: '受浏览器跨域安全限制无法直接验证，配置已保存，桌面客户端中将自动重试' }
    case 'blocked-preparation':
      return { ok: false, text: '准备场景不发起外部供应商请求（I0-A 不调用真实教学模型）' }
  }
}
