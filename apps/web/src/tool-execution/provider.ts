import { componentInstanceId, type ComponentBinding, type StateShape } from '@xunjie/contracts/components'
import type { ExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { learningRequest } from '../product/learningTransport'
import { AlgorithmError } from './algorithm'
import type { AlgorithmProvider } from './adapters/aggregation'

const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
  byte => byte.toString(16).padStart(2, '0')).join('')

export function bindingFor(activity: LearningActivity, instanceId: string): ComponentBinding | undefined {
  return activity.course?.components?.find(binding => componentInstanceId(activity.activityId, binding.key) === instanceId)
}

/**
 * The algorithm bytes come from the same authorised release the view came from, and are checked
 * against the manifest digest before a worker ever sees them.
 */
export function createAlgorithmProvider(activity: LearningActivity, spaceKey: string, namespace: string): AlgorithmProvider {
  return { async load(action: ExecutionAction) {
    const binding = bindingFor(activity, action.execution.instance.instanceId)
    const manifest = binding?.definition.manifest
    const algorithm = manifest?.formatVersion === 1 ? manifest.algorithm : undefined
    if (!binding || manifest?.formatVersion !== 1 || !algorithm || !activity.course)
      throw new AlgorithmError('capability-unavailable', '当前组件没有可用的受限算法资源。')
    const operation = manifest.operations?.find(item => item.operationId === action.execution.operation.operationId)
    if (!operation) throw new AlgorithmError('capability-unavailable', '组件版本已变化，不能沿用原执行输入。')
    if (binding.definition.digest !== action.execution.instance.definitionDigest)
      throw new AlgorithmError('capability-unavailable', '组件版本已变化，不能沿用原执行输入。')
    const value = await learningRequest(activity, spaceKey, namespace,
      `releases/${activity.course.releaseId}/components/${binding.key}/algorithm`) as { contentBase64: string }
    let bytes: Uint8Array
    try { bytes = Uint8Array.from(atob(value.contentBase64), char => char.charCodeAt(0)) }
    catch { throw new AlgorithmError('resource-unavailable', '算法资源暂时无法读取。') }
    if (bytes.length !== algorithm.resource.byteLength || await hash(bytes) !== algorithm.resource.sha256)
      throw new AlgorithmError('resource-unavailable', '算法资源与已登记版本不一致，已停止。')
    // Created from a plain Uint8Array, so this buffer is a transferable ArrayBuffer, not shared memory.
    return { bytes: bytes.buffer as ArrayBuffer, entry: algorithm.entry, memoryPages: algorithm.memoryPages,
      result: operation.result as StateShape }
  } }
}
