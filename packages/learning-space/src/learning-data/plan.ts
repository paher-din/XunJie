import { StorageError } from '@xunjie/storage';
import { plannedExecutionScope } from '@xunjie/contracts/execution';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { PlannedExecution } from '@xunjie/contracts/execution';

/**
 * A course plan narrows what the bound component already declares; it never widens it. The activity
 * keeps the plan it was opened with, so a later release cannot change where an accepted run executes.
 * A release published before execution plans existed simply has none and keeps its original path.
 */
export function verifyPlannedExecution(activity: LearningActivity, input: PlannedExecution): void {
  const scope = plannedExecutionScope(activity.course?.executionPlan, input);
  if (scope === 'drifted') throw new StorageError('corrupt');
  if (scope === 'forbidden') throw new StorageError('forbidden');
}
