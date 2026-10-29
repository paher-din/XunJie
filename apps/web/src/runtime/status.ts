import { runtimeEnvironmentSchema, type RuntimeStatus } from '@xunjie/contracts/product-runtime'

const states: readonly RuntimeStatus['state'][] = [
  'installed', 'starting', 'ready', 'degraded', 'maintenance', 'stopped', 'failed', 'uninstalled',
]

// The status contract is an interface; validate the wire response before rendering it.
export function parseStatus(value: unknown): RuntimeStatus {
  if (!value || typeof value !== 'object') throw new Error('运行状态响应格式无效')
  const status = value as Record<string, unknown>
  if (!states.some(state => state === status.state)
    || !Array.isArray(status.dependencies)
    || !status.dependencies.every(dependency => dependency && typeof dependency === 'object'
      && typeof dependency.name === 'string' && typeof dependency.required === 'boolean'
      && (dependency.state === 'ready' || dependency.state === 'unavailable')
      && (dependency.detail === undefined || typeof dependency.detail === 'string'))
    || (status.reason !== undefined && typeof status.reason !== 'string')
    || (status.endpoint !== undefined && typeof status.endpoint !== 'string')) {
    throw new Error('运行状态响应格式无效')
  }
  const environment = runtimeEnvironmentSchema.safeParse(status.environment)
  if (!environment.success) throw new Error('环境身份响应格式无效')
  if (environment.data.services.some(service => service.environmentId !== environment.data.environmentId)) {
    throw new Error('服务与当前环境身份不一致')
  }
  return { ...status, environment: environment.data } as RuntimeStatus
}

export async function readStatus(signal: AbortSignal): Promise<RuntimeStatus> {
  const response = await fetch('/runtime/status', {
    method: 'GET', cache: 'no-store', credentials: 'same-origin', signal,
    headers: { Accept: 'application/json' },
  })
  // A non-2xx response may carry a genuine degraded/failed RuntimeStatus.
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error(response.ok ? '运行状态响应不是有效 JSON' : `状态接口返回 HTTP ${response.status}`)
  }
  try {
    return parseStatus(value)
  } catch (error) {
    if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}，未提供有效运行状态`)
    throw error
  }
}
