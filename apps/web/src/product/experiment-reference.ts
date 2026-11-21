import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { ExecutionRecord } from '../tool-execution/ledger'
import { experimentDraftSchema, type ExperimentDraft as ExperimentReference } from '@xunjie/contracts/experiment-references'
export type { ExperimentDraft as ExperimentReference } from '@xunjie/contracts/experiment-references'

export function experimentReference(activity: LearningActivity, record: ExecutionRecord): ExperimentReference | null {
  if (record.action.protocolVersion !== 3 || record.query.statusKnowledge !== 'confirmed'
    || record.query.state !== 'succeeded' || !record.query.output) return null
  const action = record.action
  return { activityId: activity.activityId, requestId: record.requestId, executionRef: record.executionRef,
    inputDigest: record.inputDigest,
    label: `${action.execution.instance.key} · ${new Date(record.createdAt).toLocaleString('zh-CN')}`,
    question: '请结合这次实验结果继续解释，并说明它对应哪个作品版本、输入和观察。',
    source: { kind: 'component', formatVersion: 1, environmentId: activity.identity.environmentId,
      spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId,
      instanceId: action.execution.instance.instanceId, componentId: action.execution.instance.componentId,
      componentVersion: action.execution.instance.componentVersion, definitionDigest: action.execution.instance.definitionDigest,
      bindingKey: action.execution.instance.key, objectId: record.requestId, contentId: record.query.output.contentId,
      origin: 'execution-result', requestId: record.requestId, executionRef: record.executionRef } }
}

export function parseExperimentReference(value: unknown): ExperimentReference | null {
  const parsed = experimentDraftSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
