import type { ModelProvider } from './settings'
import { apiPost } from '../workspace/http'
import { PREP_BUILD } from '../workspace/mode'

/** 供应商探测走同源后台，不在浏览器连接外部端点；准备模式始终禁止外发。 */

export type TestResult =
  | { ok: true; latencyMs: number; modelCount: number | null; simulated?: boolean;
      models?:Array<{id:string;name?:string;contextWindow?:number;maxOutputTokens?:number;inputTypes?:ModelProvider['models'][number]['inputTypes'];reasoningLevels?:string[]}> }
  | { ok: false; kind: 'auth' | 'not-found' | 'http' | 'cors' | 'timeout' | 'blocked-preparation' | 'network' | 'invalid-url' | 'unavailable'; status?: number }


export async function testProviderConnection(p: Pick<ModelProvider, 'baseUrl' | 'apiKey'> & { id?: string }): Promise<TestResult> {
  if (PREP_BUILD) return { ok: false, kind: 'blocked-preparation' }
  try {
    const result = await apiPost<TestResult>('/model-settings/test', p.id && !p.apiKey ? { providerId: p.id } : { baseUrl: p.baseUrl, ...(p.apiKey ? { apiKey: p.apiKey } : {}) }, { mode: 'real', timeoutMs: 35_000 })
    if (!result || typeof result.ok !== 'boolean') return { ok: false, kind: 'unavailable' }
    return result
  } catch { return { ok: false, kind: 'unavailable' } }
}

/** 预置学校服务的模拟测试：850ms 后恒成功，不发网络请求，结果明确标「模拟」。 */
export function testSchoolConnection(): Promise<TestResult> {
  if (!PREP_BUILD) return Promise.resolve({ ok: false, kind: 'unavailable' })
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
    case 'network':
      return { ok: false, text: '供应商网络连接失败，请核对地址后重试。' }
    case 'invalid-url':
      return { ok: false, text: '仅支持公网 HTTPS 供应商地址。' }
    case 'unavailable':
      return { ok: false, text: '连接测试不可用或请求失败，请重试。' }
    case 'blocked-preparation':
      return { ok: false, text: '准备场景不发起外部供应商请求（I0-A 不调用真实教学模型）' }
  }
}
