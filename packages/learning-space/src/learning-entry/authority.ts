import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { createSpaces } from '../spaces/index.js';
import type { createCourses } from '../courses/index.js';

/** Authenticated transport is insufficient: recheck the actual member and its fixed learning owner on every call. */
export function createLearningAuthority(spaces: ReturnType<typeof createSpaces>, courses: ReturnType<typeof createCourses>) {
  return async (value: unknown, source: { sourceEnvironmentId: string; sourceServiceId: string }) => {
    try {
      const input = z.object({ token: z.string(), operation: z.enum(['access', 'prepare', 'confirm', 'authorize']),
        input: z.unknown().optional() }).strict().parse(value);
      const identity = await spaces.authenticate(input.token, 'connection');
      const target = await spaces.resolveBinding(identity);
      if (target.environmentId !== source.sourceEnvironmentId || target.serviceId !== source.sourceServiceId) throw new StorageError('forbidden');
      if (input.operation === 'access') return { identity, target };
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
