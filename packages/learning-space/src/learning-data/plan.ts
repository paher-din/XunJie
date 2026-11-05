import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { canonicalValue, courseExecutionPlanBasis, plannedExecutionScope } from '@xunjie/contracts/execution';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { PlannedExecution } from '@xunjie/contracts/execution';

/**
 * A course plan narrows what the bound component already declares; it never widens it. The activity
 * keeps the plan it was opened with, so a later release cannot change where an accepted run executes.
 * A release published before execution plans existed simply has none and keeps its original path.
 */
export function verifyPlannedExecution(activity: LearningActivity, input: PlannedExecution): void {
  const plan = activity.course?.executionPlan;
  if (plan) {
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const planned = plan.components.find(item => item.key === input.key);
    const binding = activity.course?.components?.find(item => item.key === input.key);
    if (digest(courseExecutionPlanBasis(plan)) !== plan.planDigest || !binding || !planned
      || planned.configurationDigest !== digest(canonicalValue(binding.configuration))) throw new StorageError('corrupt');
  }
  const scope = plannedExecutionScope(plan, input);
  if (scope === 'drifted') throw new StorageError('corrupt');
  if (scope === 'forbidden') throw new StorageError('forbidden');
}
