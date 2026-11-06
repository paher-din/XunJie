import type { ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { AluExperimentTool } from '../course-tools/alu/AluExperimentTool'
import { LegacyAluExperimentTool } from '../course-tools/alu/LegacyAluExperimentTool'

/**
 * The format 3 runtime slot. The ALU experiment owns its board, free input and full-check logic in
 * `course-tools/alu`; this component stays as the product's registered mount point so no second
 * experiment page or parallel execution chain is introduced.
 */
export function RuntimeTool({ activity, binding, spaceKey, namespace, authorized, compact = false }: {
  activity: LearningActivity
  binding: ComponentBinding
  spaceKey: string
  namespace: string
  authorized: boolean
  compact?: boolean
}) {
  if (binding.definition.manifest.formatVersion !== 3) return null
  if (binding.definition.manifest.stateVersion === 1)
    return <LegacyAluExperimentTool {...{ activity, binding, spaceKey, namespace, authorized, compact }} />
  if (binding.definition.manifest.stateVersion !== 2)
    return <p role="alert">当前产品不支持这份实验状态版本；原作品和记录仍保留，请使用兼容产品。</p>
  return <AluExperimentTool activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace}
    authorized={authorized} compact={compact} />
}
