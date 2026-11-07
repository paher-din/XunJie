import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import { teachingPreparedToolSchema, type TeachingRun } from '@xunjie/contracts/teaching-agent';
import type { TeachingToolCleanupScope } from './tool-types.js';

/** Reconstruct only the durable cleanup scope. No current-authorization or activity call is allowed here. */
export function cleanupScopeFor(run: TeachingRun, row: Record<string, unknown>): TeachingToolCleanupScope {
  const command = teachingPreparedToolSchema.parse(row.command);
  const fixed = z.object({ identity: spaceIdentitySchema, activityId: z.uuid(), runId: z.uuid(),
    stepId: z.uuid(), snapshotId: z.uuid(), segmentId: z.uuid().nullable(), input: actionInputSchema,
    course: activitySchema.shape.course.unwrap().nullable() }).strict().parse(command.basis.scope);
  if (command.commandId !== row.command_id || fixed.runId !== run.runId || fixed.activityId !== run.activityId
    || fixed.stepId !== row.step_id || fixed.snapshotId !== row.snapshot_id
    || fixed.segmentId !== (row.segment_id ?? null) || fixed.input.scope.activityId !== run.activityId
    || fixed.input.scope.environmentId !== fixed.identity.environmentId || fixed.input.scope.spaceId !== fixed.identity.spaceId
    || fixed.input.scope.principalId !== fixed.identity.principalId) throw new StorageError('corrupt');
  return { identity: fixed.identity, input: fixed.input, runId: fixed.runId, stepId: fixed.stepId, snapshotId: fixed.snapshotId,
    ...(fixed.segmentId ? { segmentId: fixed.segmentId } : {}),
    activity: { activityId: fixed.activityId, identity: fixed.identity, ...(fixed.course ? { course: fixed.course } : {}) } };
}
