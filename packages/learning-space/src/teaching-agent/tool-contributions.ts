import type { ModelTool } from '@xunjie/contracts/model-connections';
import type { TeachingToolContribution, TeachingToolScope } from './tool-types.js';
import { canonicalDigest } from './identity.js';

/** The production host and the remaining definitions adapter use the same executor identity. */
export function platformToolContribution(definition: ModelTool, scope: TeachingToolScope): TeachingToolContribution {
  return { definition,
    source: { kind: 'platform', sourceId: 'platform.learning', version: '1', contentDigest: canonicalDigest(definition) },
    executor: { executorId: 'teaching-tools:' + definition.name, toolName: definition.name, version: '1' },
    effect: definition.name === 'execution_stop' ? 'stop' : definition.name === 'course_operation' ? 'execute' : 'read',
    resourceScope: { identity: scope.identity, activityId: scope.activity.activityId, releaseId: scope.activity.course?.releaseId ?? null } };
}
