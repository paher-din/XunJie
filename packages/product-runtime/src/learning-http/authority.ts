import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { createSpaces } from '@xunjie/learning-space/spaces';
import type { createCourses } from '@xunjie/learning-space/courses';
import { courseComponentReferenceVerificationSchema, courseReferenceTextSourceSchema, courseReferenceVerificationSchema } from '@xunjie/contracts/courses';
import type { createModelDeviceTasks } from '@xunjie/model-gateway/device-tasks';
import type { createPairedLearningModels } from '@xunjie/model-gateway/paired-learning';

/** Authenticated transport is insufficient: recheck the actual member and its fixed learning owner on every call. */
export function createLearningAuthority(spaces: ReturnType<typeof createSpaces>, courses: ReturnType<typeof createCourses>,
  modelTasks?: ReturnType<typeof createModelDeviceTasks>, paired?: ReturnType<typeof createPairedLearningModels>) {
  return async (value: unknown, source: { sourceEnvironmentId: string; sourceServiceId: string; sourceInstallationId?: string; grantId?: string }) => {
    try {
      const input = z.object({ token: z.string(), connectionId: z.uuid().optional(), operation: z.enum(['access', 'modelAccess', 'modelChoices', 'modelTaskPermit', 'modelGrantTaskPermit', 'modelGrantRevokePermit', 'prepare', 'confirm', 'authorize', 'referenceText', 'verifyReference', 'verifyComponentReference', 'pollModelTasks', 'completeModelTask']),
        input: z.unknown().optional() }).strict().parse(value);
      const identity = input.connectionId ? await spaces.authenticateConnection(input.token, input.connectionId) : await spaces.authenticate(input.token, 'connection');
      const modelOperation = input.operation === 'modelAccess' || input.operation === 'modelChoices' || input.operation === 'modelTaskPermit' || input.operation === 'modelGrantTaskPermit' || input.operation === 'modelGrantRevokePermit' || input.operation === 'pollModelTasks' || input.operation === 'completeModelTask';
      const device = modelOperation && paired ? await paired.readBinding(identity) : null;
      if (modelOperation) {
        if (!modelTasks || !source.sourceInstallationId || !source.grantId) throw new StorageError('forbidden');
        const binding = device && paired ? await paired.authorizePoll(identity, { ...source,
          sourceInstallationId: source.sourceInstallationId, grantId: source.grantId, connectionId: z.uuid().parse(input.connectionId) })
          : { grantId: source.grantId, installationId: source.sourceInstallationId };
        if (!device) {
          const target = await spaces.resolveBinding(identity);
          if (target.environmentId !== source.sourceEnvironmentId || target.serviceId !== source.sourceServiceId) throw new StorageError('forbidden');
        }
        if (input.operation === 'modelChoices') {
          if (!device || !paired) throw new StorageError('forbidden');
          return paired.publishChoices(identity, { ...source, sourceInstallationId: source.sourceInstallationId,
            grantId: source.grantId, connectionId: z.uuid().parse(input.connectionId) }, input.input);
        }
        if (input.operation === 'modelAccess') return { identity, target: { environmentId: source.sourceEnvironmentId, serviceId: source.sourceServiceId, version: 1 } };
        if (input.operation === 'modelTaskPermit') {
          if (!device || !paired) throw new StorageError('forbidden');
          const { taskId } = z.object({ taskId: z.uuid() }).strict().parse(input.input);
          return paired.authorizeTask(identity, binding, taskId);
        }
        if (input.operation === 'modelGrantTaskPermit' || input.operation === 'modelGrantRevokePermit') {
          if (!device || !paired) throw new StorageError('forbidden');
          const { taskId } = z.object({ taskId: z.uuid() }).strict().parse(input.input);
          return paired.authorizeGrantTask(identity, binding, taskId);
        }
        if (input.operation === 'pollModelTasks') {
          if (paired && device) await paired.enqueueGrantChanges(identity, binding);
          return await modelTasks.pending(identity, binding);
        }
        const { taskId, receipt } = z.object({ taskId: z.uuid(), receipt: z.unknown() }).strict().parse(input.input);
        return await modelTasks.complete(identity, binding, taskId, receipt);
      }
      const target = await spaces.resolveBinding(identity);
      if (target.environmentId !== source.sourceEnvironmentId || target.serviceId !== source.sourceServiceId) throw new StorageError('forbidden');
      if (input.operation === 'access') return { identity, target };
      if (input.operation === 'referenceText') return await courses.referenceText(identity, courseReferenceTextSourceSchema.parse(input.input));
      if (input.operation === 'verifyComponentReference') {
        await courses.verifyComponentReference(identity, courseComponentReferenceVerificationSchema.parse(input.input));
        return { verified: true };
      }
      if (input.operation === 'verifyReference') {
        await courses.verifyReference(identity, courseReferenceVerificationSchema.parse(input.input));
        return { verified: true };
      }
      if (input.operation === 'prepare') {
        const request = z.object({ associationId: z.uuid(), requestId: z.uuid(), activityId: z.uuid(), releaseId: z.uuid(),
          inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input.input);
        return await courses.prepare({ ...request, identity, target });
      }
      if (input.operation === 'confirm') {
        const request = z.object({ associationId: z.uuid(), requestId: z.uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input.input);
        return await courses.confirmForMember(identity, request);
      }
      const pointer = z.object({ associationId: z.uuid(), releaseId: z.uuid(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input.input);
      await courses.authorize(identity, pointer);
      return { authorized: true };
    } catch (error) {
      return { error: error instanceof StorageError ? error.code : error instanceof z.ZodError ? 'invalid' : 'unavailable' };
    }
  };
}
