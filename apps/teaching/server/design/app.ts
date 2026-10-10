import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { createVerificationApp, type VerificationOptions } from '../access/app.ts';
import { finishRecordCommand } from '../db/records-adapter.ts';
import { resultSchema, validateReceiptScope } from './storage.ts';
import { releaseContext } from './activities.ts';
import { availableRuntime } from './readiness.ts';
import type { RunnerTransport } from '../records/runner.ts';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import type { Transaction } from '../db/transaction.ts';
import { projectDraftPreview } from './projection.ts';
import { contentPatchSchema, versionSchema } from './model.ts';
import { commitCommand, readMaterial, saveMaterial, draftCourse, readDraft, createStoredDraft, patchStoredDraft, checkStoredDraft, draftMaterials, teacherConcernSchema, type DesignResult } from './storage.ts';

export interface DesignVerificationOptions extends VerificationOptions { currentGeneration: () => string; completion?: boolean; runner?: RunnerTransport }
const id = z.string().min(1).max(128);
const paramsSchema = z.strictObject({ id });
const keySchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
const generationSchema = id.optional();
const materialInput = z.strictObject({
  recoveryGeneration: generationSchema, teacherDesignAllowed: z.boolean().default(false),
  material: z.strictObject({ format: z.enum(['txt', 'markdown', 'paste']), title: z.string().min(1), content: z.string(),
    kind: z.enum(['learning_material', 'private_answer', 'validation_asset']).optional(),
    visibility: z.strictObject({ student: z.boolean(), tutor: z.boolean() }).optional() }),
});
const createInput = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('manual'), recoveryGeneration: generationSchema, content: contentPatchSchema.default({}) }),
  z.strictObject({ mode: z.literal('copy'), recoveryGeneration: generationSchema, sourceBlueprintId: id, expectedSourceRevision: versionSchema }),
]);
const patchInput = z.strictObject({ recoveryGeneration: generationSchema, expectedRevision: versionSchema, patch: contentPatchSchema });

const checksInput = z.strictObject({ recoveryGeneration: generationSchema, expectedRevision: versionSchema, concerns: z.array(teacherConcernSchema).default([]) });

export async function createDesignVerificationApp(options: DesignVerificationOptions) {
  const { app, access } = await createVerificationApp(options);
  const now = options.now ?? Date.now;
  function currentGeneration() {
    const value = options.currentGeneration();
    if (!id.safeParse(value).success) throw new ApiError('DEPENDENCY_UNAVAILABLE');
    return value;
  }
  function requireGeneration(expected: string | undefined) {
    const generation = currentGeneration();
    if (expected !== generation) throw new ApiError('RECOVERY_REQUIRED');
    return generation;
  }
  function execute(request: FastifyRequest, scope: string | ((tx: Transaction) => string), operation: {
    name: string; target: string; input: { recoveryGeneration?: string | undefined };
    apply: (tx: Transaction, actor: { userId: string; courseId: string }, timestamp: number) => DesignResult;
  }) {
    const key = parseRequest(keySchema, request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request, scope, 'teacher', (tx, actor) => {
      const generation = requireGeneration(operation.input.recoveryGeneration), timestamp = now();
      const validate = (value: unknown) => {
        const parsed = resultSchema.safeParse(value);
        if (!parsed.success) throw new Error('Invalid persisted design result.');
        validateReceiptScope(parsed.data, actor.courseId, operation.name, operation.target);
        return parsed.data;
      };
      const apply = () => operation.apply(tx, actor, timestamp);
      const result = options.completion
        ? finishRecordCommand(tx, { actorId: actor.userId, command: operation.name, target: operation.target,
          scope: { courseId: actor.courseId }, idempotencyKey: key, recoveryGeneration: generation }, operation.input, generation, timestamp, apply, validate)
        : commitCommand(tx, actor, operation.name, operation.target, key, operation.input, generation, timestamp, apply);
      validate(result.result);
      requireGeneration(generation);
      return result;
    });
    return { requestId: request.id, data };
  }
  app.post('/api/courses/:id/resources', request => {
    const courseId = parseRequest(paramsSchema, request.params).id;
    const input = parseRequest(materialInput, request.body);
    return execute(request, courseId, { name: 'material.create', target: courseId, input,
      apply: (tx, actor, timestamp) => saveMaterial(tx, actor, input.material, input.teacherDesignAllowed, timestamp) });
  });
  app.post('/api/courses/:id/blueprints', request => {
    const courseId = parseRequest(paramsSchema, request.params).id;
    const input = parseRequest(createInput, request.body);
    return execute(request, courseId, { name: 'draft.create', target: courseId, input,
      apply: (tx, actor, timestamp) => createStoredDraft(tx, actor, input, timestamp) });
  });
  app.patch('/api/blueprints/:id', request => {
    const blueprintId = parseRequest(paramsSchema, request.params).id;
    const input = parseRequest(patchInput, request.body);
    return execute(request, tx => draftCourse(tx, blueprintId), { name: 'draft.patch', target: blueprintId, input,
      apply: (tx, actor) => patchStoredDraft(tx, actor.courseId, blueprintId, input.expectedRevision, input.patch) });
  });
  app.post('/api/blueprints/:id/checks', async request => {
    const blueprintId = parseRequest(paramsSchema, request.params).id;
    const input = parseRequest(checksInput, request.body);
    let runtime: Awaited<ReturnType<typeof availableRuntime>>;
    if (options.completion) {
      access.inspectCourse(request, tx => draftCourse(tx, blueprintId), 'teacher');
      requireGeneration(input.recoveryGeneration);
      runtime = await availableRuntime(options.runner);
    }
    return execute(request, tx => draftCourse(tx, blueprintId), { name: 'draft.checks', target: blueprintId, input,
      apply: (tx, actor) => {
        const concerns = input.concerns.map(({ resolution, ...concern }) => ({ ...concern, ...(resolution === undefined ? {} : { resolution }) }));
        if (!options.completion) return checkStoredDraft(tx, actor.courseId, blueprintId, input.expectedRevision, concerns);
        if (runtime && runtime.recoveryGeneration !== input.recoveryGeneration) throw new ApiError('RECOVERY_REQUIRED');
        const context = releaseContext(tx, actor.courseId, blueprintId, concerns, runtime?.profile);
        if (context.draft.revision !== input.expectedRevision) throw new ApiError('VERSION_CONFLICT');
        return { kind: 'checks', report: context.report };
      } });
  });
  const design = {
    readMaterial(request: FastifyRequest, courseId: string, resourceId: string) {
      return access.withAuthorizedCourse(request, courseId, 'teacher', tx => readMaterial(tx, courseId, resourceId));
    },
    preview(request: FastifyRequest, blueprintId: string, audience: unknown) {
      return access.withAuthorizedCourse(request, tx => draftCourse(tx, blueprintId), 'teacher', (tx, actor) => {
        const draft = readDraft(tx, actor.courseId, blueprintId);
        return projectDraftPreview(draft, audience, { materials: draftMaterials(tx, draft), access: {
          authorizeTeacher(courseId: string) { if (courseId !== actor.courseId || actor.role !== 'teacher') throw new ApiError('FORBIDDEN'); },
        } });
      });
    },
    readDraft(request: FastifyRequest, blueprintId: string) {
      return access.withAuthorizedCourse(request, tx => draftCourse(tx, blueprintId), 'teacher',
        (tx, actor) => readDraft(tx, actor.courseId, blueprintId));
    },
  };
  return { app, access, design };
}
