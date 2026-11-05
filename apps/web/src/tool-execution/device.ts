import { z } from 'zod'
import { executionDeviceSchema, executionPlatformSchema, type ExecutionDevice, type ExecutionPlatform } from '@xunjie/contracts/execution'

/** 浏览器能力来自实际接口；未观测的原生能力与架构保持未知。 */
const probes = {
  worker: () => typeof Worker === 'function',
  webassembly: () => typeof WebAssembly === 'object' && WebAssembly !== null
    && typeof WebAssembly.instantiate === 'function',
  sandboxedFrame: () => typeof document !== 'undefined' && 'sandbox' in document.createElement('iframe'),
} as const

export function observeExecutionDevice(): ExecutionDevice {
  return { platform: null,
    browser: { worker: probes.worker(), webassembly: probes.webassembly(), sandboxedFrame: probes.sandboxedFrame() },
    native: null }
}

export const executionEnvironmentSchema = z.object({
  nodeClass: z.enum(['device', 'school-execution-node']), secureTransport: z.boolean(), remoteAvailable: z.boolean(),
  device: executionDeviceSchema,
  adapters: z.array(z.object({ adapterId: z.string().min(1), adapterVersion: z.number().int().positive(),
    platforms: z.array(executionPlatformSchema), available: z.boolean().optional() })),
})
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>

interface PlatformClient {
  userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; architecture?: string; bitness?: string }> }
}

export async function observeExecutionPlatform(client: PlatformClient = globalThis.navigator as PlatformClient): Promise<ExecutionPlatform | null> {
  try {
    const facts = await client?.userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'platform'])
    if (facts?.bitness !== '64') return null
    if (facts.platform === 'macOS' && facts.architecture === 'arm') return 'macos-arm64'
    if (facts.platform === 'Windows' && facts.architecture === 'x86') return 'windows-x64'
    if (facts.platform === 'Linux' && facts.architecture === 'x86') return 'linux-x64'
  } catch { /* 未获准读取平台事实时保持未知。 */ }
  return null
}

export function sessionExecutionDevice(environment: ExecutionEnvironment, platform: ExecutionPlatform | null,
  adapter: { adapterId: string; adapterVersion: number }): ExecutionDevice {
  const observed = observeExecutionDevice()
  // 学校主机的设备事实不代表浏览器客户端；平台只取客户端观测或本机运行环境。
  const device = environment.nodeClass === 'device'
    ? { ...environment.device, browser: observed.browser }
    : { ...observed, platform }
  const declaration = environment.adapters.find(item => item.adapterId === adapter.adapterId
    && item.adapterVersion === adapter.adapterVersion)
  if (device.platform && declaration?.platforms.length && !declaration.platforms.includes(device.platform)) {
    device.native = { ...(device.native ?? { installed: false, authorized: false, prepared: 'none' as const }), supported: false }
  } else if (declaration?.available === false && device.native?.supported) {
    device.native = { ...device.native, prepared: 'none' }
  }
  return device
}
