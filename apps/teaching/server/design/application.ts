import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { createDesignVerificationApp, type DesignVerificationOptions } from './app.ts';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { availableRuntime } from './readiness.ts';
import { finishRecordCommand } from '../db/records-adapter.ts';
import { releaseSchema, assignmentSchema, activityControlSchema, assignmentControlSchema, helpPolicySchema, checkRuleSchema, activityCommandResults, assignmentViewSchema } from '../../contracts/design/index.ts';
import { activityCourse, assignmentCourse, readAssignment, confirmActivity, assignActivity, controlActivity, controlAssignment,
  activityView, assignmentAvailability, storePolicy, storeRule, releaseContext, readActivity } from './activities.ts';
import { readMaterial, draftCourse, readDraft, draftMaterials } from './storage.ts';
import type { Transaction } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';

export type DesignAppOptions = Omit<DesignVerificationOptions, 'completion'>;
const params = z.strictObject({ id: z.string().min(1).max(128) });
const keySchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
const audienceSchema = z.strictObject({ audience: z.enum(['student', 'tutor', 'teacher-validator']).default('student') });
export async function createDesignApp(options: DesignAppOptions) {
  const instance = await createDesignVerificationApp({ ...options, completion: true });
  const { app, access, design } = instance;
  const now = options.now ?? Date.now;
  function generation(expected: string) {
    const current = options.currentGeneration();
    if (!current || current !== expected) throw new ApiError('RECOVERY_REQUIRED');
    return current;
  }
  function execute(request: FastifyRequest, scope: string | ((tx: Transaction) => string), command: keyof typeof activityCommandResults, target: string,
    input: { recoveryGeneration: string }, apply: (tx: Transaction, actor: ActorContext) => unknown) {
    const key = parseRequest(keySchema, request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request, scope, 'teacher', (tx, actor) => {
      const current = generation(input.recoveryGeneration);
      const receipt = finishRecordCommand(tx, { actorId: actor.userId, command, target, scope: { courseId: actor.courseId },
        idempotencyKey: key, recoveryGeneration: current }, input, current, now(), () => apply(tx, actor), value => {
        const parsed = activityCommandResults[command].safeParse(value);
        if (!parsed.success) throw new Error('Invalid persisted activity command result.');
        const result = parsed.data;
        try {
          if ('activityVersionId' in result) {
            const activity = readActivity(tx, actor.courseId, result.activityVersionId);
            if (command === 'activity.release' && (activity.sourceBlueprintId !== target || !('sourceRevision' in result)
              || activity.sourceRevision !== result.sourceRevision || result.checks.blueprintId !== target || result.checks.revision !== result.sourceRevision)) throw new Error('Invalid release association.');
            if (command === 'activity.control' && result.activityVersionId !== target) throw new Error('Invalid control association.');
          }
          if ('assignments' in result) for (const item of result.assignments) {
            const assignment = readAssignment(tx, actor.courseId, item.assignmentId);
            if (item.activityVersionId !== target || assignment.activity_id !== target || assignment.student_id !== item.studentId) throw new Error('Invalid assignment association.');
          }
          if ('assignmentId' in result && (result.assignmentId !== target || readAssignment(tx, actor.courseId, target).id !== target)) throw new Error('Invalid assignment control association.');
        } catch { throw new Error('Invalid persisted activity command scope.'); }
        return result;
      });
      generation(current);
      return receipt;
    });
    return { requestId: request.id, data };
  }
  app.get('/api/blueprints/:id', request => ({ requestId: request.id, data: design.readDraft(request, parseRequest(params, request.params).id) }));
  app.get('/api/blueprints/:id/previews', request => ({ requestId: request.id,
    data: design.preview(request, parseRequest(params, request.params).id, parseRequest(audienceSchema, request.query).audience) }));
  app.get('/api/activities/:id', request => {
    const activityId = parseRequest(params, request.params).id, audience = parseRequest(audienceSchema, request.query).audience;
    const data = access.withAuthorizedCourse(request, tx => activityCourse(tx, activityId), undefined, (tx, actor) => {
      if (actor.role === 'student' && audience !== 'student') throw new ApiError('FORBIDDEN');
      return activityView(tx, actor, activityId, audience);
    });
    return { requestId: request.id, data };
  });
  app.get('/api/assignments/:id', request => {
    const assignmentId = parseRequest(params, request.params).id;
    const data = access.withAuthorizedCourse(request, tx => assignmentCourse(tx, assignmentId), undefined, (tx, actor) => {
      const assignment = readAssignment(tx, actor.courseId, assignmentId);
      if (actor.role === 'student' && assignment.student_id !== actor.userId) throw new ApiError('FORBIDDEN');
      const availability = assignmentAvailability(tx, actor.courseId, assignmentId, assignment.student_id);
      return assignmentViewSchema.parse({ assignmentId, activityVersionId: assignment.activity_id, studentId: assignment.student_id, assignmentRevision: assignment.assignment_revision,
        active: availability.active, status: assignment.status, reasons: { individual: assignment.individual_reason, activity: assignment.activity_reason },
        activityControlRevision: availability.activityControlRevision });
    });
    return { requestId: request.id, data };
  });
  app.get('/api/resources/:id', request => {
    const resourceId = parseRequest(params, request.params).id;
    const data = access.withAuthorizedCourse(request, tx => {
      const row = tx.get('SELECT course_id FROM resource_versions WHERE id=?', resourceId);
      if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
      return row.course_id;
    }, undefined, (tx, actor) => {
      if (actor.role === 'teacher') return readMaterial(tx, actor.courseId, resourceId);
      for (const row of tx.all('SELECT activity_id FROM assignments WHERE course_id=? AND student_id=?', actor.courseId, actor.userId)) {
        const view = activityView(tx, actor, String(row.activity_id), 'student');
        const material = view.content.materials.find(item => item.status === 'available' && item.resourceVersionId === resourceId);
        if (material) return material;
      }
      throw new ApiError('FORBIDDEN');
    });    return { requestId: request.id, data };
  });
  app.post('/api/blueprints/:id/releases', async request => {
    const blueprintId = parseRequest(params, request.params).id, input = parseRequest(releaseSchema, request.body);
    access.inspectCourse(request, tx => draftCourse(tx, blueprintId), 'teacher');
    generation(input.recoveryGeneration);
    const runtime = await availableRuntime(options.runner);
    return execute(request, tx => draftCourse(tx, blueprintId), 'activity.release', blueprintId, input, (tx, actor) => {
      if (!runtime) throw new ApiError('RUNTIME_NOT_READY');
      if (runtime.recoveryGeneration !== input.recoveryGeneration) throw new ApiError('RECOVERY_REQUIRED');
      return confirmActivity(tx, actor, blueprintId, input.expectedRevision,
        input.concerns.map(({ resolution, ...item }) => ({ ...item, ...(resolution === undefined ? {} : { resolution }) })),
        runtime.profile, input.recoveryGeneration, now());
    });
  });
  app.post('/api/activities/:id/assignments', request => {
    const activityId = parseRequest(params, request.params).id, input = parseRequest(assignmentSchema, request.body);
    return execute(request, tx => activityCourse(tx, activityId), 'assignment.create', activityId, input,
      (tx, actor) => assignActivity(tx, actor, activityId, input.studentIds, input.expectedActivityControlRevision, now()));
  });
  app.post('/api/activities/:id/controls', request => {
    const activityId = parseRequest(params, request.params).id, input = parseRequest(activityControlSchema, request.body);
    return execute(request, tx => activityCourse(tx, activityId), 'activity.control', activityId, input,
      (tx, actor) => controlActivity(tx, actor, activityId, input.expectedActivityControlRevision, input.action, input.reason, now()));
  });
  app.post('/api/assignments/:id/controls', request => {
    const assignmentId = parseRequest(params, request.params).id, input = parseRequest(assignmentControlSchema, request.body);
    return execute(request, tx => assignmentCourse(tx, assignmentId), 'assignment.control', assignmentId, input,
      (tx, actor) => controlAssignment(tx, actor, assignmentId, input.expectedAssignmentRevision, input.action, input.reason, now()));
  });
  return { ...instance, design: { ...design,
    configurePolicy(request: FastifyRequest, courseId: string, input: unknown) {
      const policy = parseRequest(helpPolicySchema, input);
      return access.withAuthorizedCourse(request, courseId, 'teacher', (tx, actor) => storePolicy(tx, actor, policy, now()));
    },
    configureRule(request: FastifyRequest, courseId: string, input: unknown) {
      const rule = parseRequest(checkRuleSchema, input);
      return access.withAuthorizedCourse(request, courseId, 'teacher', (tx, actor) => storeRule(tx, actor, rule, now()));
    },
    readAssignmentInTransaction(tx: Transaction, actor: ActorContext, assignmentId: string) {
      const membership = tx.get('SELECT role FROM course_memberships WHERE course_id=? AND user_id=? AND active=1', actor.courseId, actor.userId);
      if (membership?.role !== actor.role) throw new ApiError('FORBIDDEN');
      return assignmentAvailability(tx, actor.courseId, assignmentId, actor.userId);
    },
    readTutorActivity(request: FastifyRequest, activityId: string) {
      return access.withAuthorizedCourse(request, tx => activityCourse(tx, activityId), 'student', (tx, actor) => {
        const row = tx.get('SELECT id FROM assignments WHERE activity_id=? AND student_id=?', activityId, actor.userId);
        if (!row || !assignmentAvailability(tx, actor.courseId, String(row.id), actor.userId).active) throw new ApiError('STATE_CONFLICT');
        return activityView(tx, actor, activityId, 'tutor');
      });
    },
    readTeacherDesignContext(request: FastifyRequest, blueprintId: string) {
      return access.withAuthorizedCourse(request, tx => draftCourse(tx, blueprintId), 'teacher', (tx, actor) => {
        const draft = readDraft(tx, actor.courseId, blueprintId);
        return { draft, materials: draftMaterials(tx, draft).filter(material => material.teacherDesignAllowed) };
      });
    },
    checkCurrent(request: FastifyRequest, blueprintId: string, expectedRevision: number) {
      return access.withAuthorizedCourse(request, tx => draftCourse(tx, blueprintId), 'teacher', (tx, actor) => {
        const context = releaseContext(tx, actor.courseId, blueprintId, []);
        if (context.draft.revision !== expectedRevision) throw new ApiError('VERSION_CONFLICT');
        return context.report;
      });
    },
  } };
}
