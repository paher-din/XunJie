import { z } from 'zod'
import type { ComponentBinding } from '@xunjie/contracts/components'
import type { ExecutionPlacement } from './placement'
import { executionDeviceSchema, executionPlatformSchema, isCourseExecutionPlanV2, type CourseExecutionPlan, type ExecutionDevice, type ExecutionPlatform } from '@xunjie/contracts/execution'

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
  placements: z.array(z.object({
    target: z.enum(['student-runtime', 'school-runtime']), adapterId: z.string().min(1),
    adapterVersion: z.number().int().positive(), available: z.boolean(),
  }).strict()).optional(),
  adapters: z.array(z.object({ adapterId: z.string().min(1), adapterVersion: z.number().int().positive(),
    platforms: z.array(executionPlatformSchema), available: z.boolean().optional() })),
}).refine(value => !value.placements || new Set(value.placements.map(item =>
  item.target + ':' + item.adapterId + '@' + item.adapterVersion)).size === value.placements.length,
'Each execution target and adapter is reported once')
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

/** A target is usable only with its own owner/adapter facts; a different ready node is irrelevant. */
export function sessionPlacementFromEnvironment(binding: ComponentBinding, plan: CourseExecutionPlan,
  environment: ExecutionEnvironment | undefined, platform: ExecutionPlatform | null): ExecutionPlacement {
  const manifest = binding.definition.manifest
  const session = manifest.formatVersion === 1 ? manifest.session : undefined
  if (!session) throw new Error('not-planned')
  const device = environment ? sessionExecutionDevice(environment, platform, session) : observeExecutionDevice()
  let remoteAvailable = environment?.secureTransport === true && environment.remoteAvailable
  if (isCourseExecutionPlanV2(plan)) {
    const fixed = plan.placements.find(item => item.componentKey === binding.key
      && item.operationId === session.operation.operationId)
    if (!fixed || fixed.target === 'student-browser') return { plan, device, remoteAvailable: false }
    const adapter = environment?.adapters.find(item => item.adapterId === session.adapterId
      && item.adapterVersion === session.adapterVersion)
    const reported = environment?.placements?.find(item => item.target === fixed.target
      && item.adapterId === session.adapterId && item.adapterVersion === session.adapterVersion)
    const atOwner = environment?.nodeClass === (fixed.target === 'student-runtime' ? 'device' : 'school-execution-node')
    const available = reported ? reported.available : environment?.placements === undefined && atOwner
      && adapter !== undefined && adapter.available !== false
    if (fixed.target === 'school-runtime') remoteAvailable = remoteAvailable && available === true
    else if (!available && device.native) device.native = { ...device.native, prepared: 'none' }
  }
  return { plan, device, remoteAvailable }
}
