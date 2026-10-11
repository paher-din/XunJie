import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { createDesignApp, type DesignAppOptions } from '../design/application.ts';
import { assignmentCourse, assignmentAvailability, readActivity, activityView } from '../design/activities.ts';
import { finishRecordCommand, readAttempt, saveAttempt } from '../db/records-adapter.ts';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { queryRuntime } from '../design/readiness.ts';
import { canonical, requestHash, resolveCommandReceipt } from '../records/commands.ts';
import { assertResourceUse } from '../access/resource.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import type { ActionDisposition, TeachingActionRecord, TeachingCoverage, TeachingMessage } from '../../contracts/records/index.ts';
import type { DesignTeachingStop } from '../design/activities.ts';
import { createAttempt } from './snapshots.ts';
import { loadWorkspace, persistWorkspace, readProcessRecords, readTeachingRecords, readCoverage } from './storage.ts';
import { generationInput, cancelInput, params, key, syncInput, snapshotInput, controlInput, runInput, syncBatch, domainControl, domainRun } from './inputs.ts';
import { syncCommand, snapshotCommand, controlCommand, runCommand, cancelRunCommand, cancelTeachingJobCommand,
  readWorkspace, readConfirmedSnapshot, readRunDiagnostics } from './commands.ts';
import type { CommandContext, TeachingStopHandler, WorkspaceState } from './commands.ts';
import { createWorkspaceWorker } from './worker.ts';
import { readResultFiles } from './result-files.ts';
import { z } from 'zod';

export type WorkspaceAppOptions = Omit<DesignAppOptions,'teaching'> & {teaching?:{stop:TeachingStopHandler;design?:DesignTeachingStop}};
const attemptResult = z.strictObject({ attemptId: z.string(), activityVersionId: z.string(), assignmentId: z.string() });
export async function createWorkspaceApp(options: WorkspaceAppOptions) {
  const { teaching: extensions, ...designOptions } = options;
  const instance = await createDesignApp({ ...designOptions, ...(extensions?.design ? { teaching: { stop: extensions.design } } : {}) });
  const { app, access } = instance;
  const now = options.now ?? Date.now;
  const teachingStop = options.teaching?.stop;
  const currentGeneration = (expected: string) => {
    if (!expected || options.currentGeneration() !== expected) throw new ApiError('RECOVERY_REQUIRED');
    return expected;
  };
  const attemptId = (request: FastifyRequest) => parseRequest(params, request.params).id;
  function locate(tx: Transaction, id: string, studentCommand = false) {
    const attempt = readAttempt(tx, id);
    const active = studentCommand && assignmentAvailability(tx, attempt.courseId, attempt.assignmentId, attempt.studentId).active;
    return { kind: 'student_work' as const, courseId: attempt.courseId, studentId: attempt.studentId,
      stage: attempt.status, assignmentActive: active };
  }
  function commandIdentity(request: FastifyRequest, actor: ActorContext, id: string, command: string, generation: string) {
    return { actorId: actor.userId, command, target: request.url.split('?',1)[0]!,
      scope: { courseId: actor.courseId, studentId: actor.userId, attemptId: id },
      idempotencyKey: parseRequest(key, request.headers['idempotency-key']), recoveryGeneration: generation,
      ...(command === 'workspace.sync' ? { sync: { clientId: parseRequest(syncInput, request.body).clientId, clientSeq: parseRequest(syncInput, request.body).clientSeq } } : {}) };
  }
  function read<T>(request: FastifyRequest, id: string, work: (tx: Transaction, state: WorkspaceState, actor: ActorContext) => T) {
    return access.withAuthorizedResource(request, tx => locate(tx, id), 'read', (tx, actor) => work(tx, loadWorkspace(tx, id), actor));
  }
  function execute(request: FastifyRequest, target: string | ((tx: Transaction) => string), command: string, expectedGeneration: string,
    apply: (tx: Transaction, state: WorkspaceState, context: CommandContext) => ReturnType<typeof syncCommand>, stopReason = 'explicit_command',
    runPurposes?: CommandContext['runPurposes']) {
    let id: string;
    const data = access.withAuthorizedResource(request, tx => { id = typeof target === 'string' ? target : target(tx); return locate(tx, id, true); }, 'write', (tx, actor, scope) => {
      const generation = currentGeneration(expectedGeneration);
      const identity = commandIdentity(request,actor,id,command,generation);
      const before = loadWorkspace(tx, id, identity);
      const context: CommandContext = { identity, generation, now: new Date(now()).toISOString(),
        commandId: randomUUID(), receiptId: randomUUID(), eventId: randomUUID(), assignmentActive: scope.kind === 'student_work' && scope.assignmentActive,
        authorize: () => true, transaction: tx, stopReason, ...(runPurposes ? {runPurposes} : {}) };
      const plan = apply(tx, before, context);
      persistWorkspace(tx, before, plan.state);
      if (!plan.replayed && command === 'workspace.sync') {
        const batch = syncBatch(parseRequest(syncInput, request.body));
        if (batch.process && before.attempt.collecting && batch.process.captureRevision === before.attempt.captureRevision)
          tx.run("INSERT INTO workspace_process_records(receipt_id,attempt_id,capture_revision,kind,record_json) VALUES (?,?,?,'sync',?)",
            plan.receipt.receiptId, id, before.attempt.captureRevision, JSON.stringify({ operations: batch.operations,
              confirmedBasis: before.files.filter(file => batch.operations.some(op => op.kind !== 'create' && op.fileId === file.fileId)),
              workspaceRevision: plan.state.attempt.workspaceRevision, occurredAt: context.now }));
      }
      if (!plan.replayed && command === 'attempt.control' && before.attempt.captureRevision !== plan.state.attempt.captureRevision)
        tx.run("INSERT INTO workspace_process_records(receipt_id,attempt_id,capture_revision,kind,record_json) VALUES (?,?,?,'coverage',?)",
          plan.receipt.receiptId, id, plan.state.attempt.captureRevision, JSON.stringify({ collecting: plan.state.attempt.collecting, occurredAt: context.now }));
      currentGeneration(generation);
      return { ...plan.receipt, replayed: plan.replayed };
    });
    return { requestId: request.id, data };
  }
  app.post('/api/assignments/:id/attempts', request => {
    const assignmentId = attemptId(request), input = parseRequest(generationInput, request.body);
    const idempotencyKey = parseRequest(key, request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request, tx => assignmentCourse(tx, assignmentId), 'student', (tx, actor) => {
      const generation = currentGeneration(input.recoveryGeneration);
      const available = assignmentAvailability(tx, actor.courseId, assignmentId, actor.userId);
      const receipt = finishRecordCommand(tx, { actorId: actor.userId, command: 'attempt.create', target: assignmentId,
        scope: { courseId: actor.courseId, studentId: actor.userId }, idempotencyKey, recoveryGeneration: generation }, input, generation, now(), () => {
        const existing = tx.all('SELECT attempt_id FROM attempts WHERE assignment_id=?', assignmentId).map(row => readAttempt(tx, String(row.attempt_id)));
        const attempt = createAttempt(existing, { attemptId: randomUUID(), courseId: actor.courseId, studentId: actor.userId,
          assignmentId, activityVersionId: available.assignment.activity_id }, available.active);
        saveAttempt(tx, attempt);
        return { attemptId: attempt.attemptId, assignmentId, activityVersionId: attempt.activityVersionId };
      }, value => {
        const result = attemptResult.parse(value), attempt = readAttempt(tx, result.attemptId);
        if (attempt.studentId !== actor.userId || attempt.courseId !== actor.courseId || attempt.assignmentId !== assignmentId
          || result.assignmentId !== assignmentId || result.activityVersionId !== attempt.activityVersionId) throw new Error('Invalid persisted attempt result.');
        return result;
      });
      currentGeneration(generation); return receipt;
    });
    return { requestId: request.id, data };
  });
  app.get('/api/attempts/:id', request => ({ requestId: request.id, data: read(request, attemptId(request), (_tx, state) => readWorkspace(state, () => true)) }));
  app.post('/api/attempts/:id/sync', { bodyLimit: 8 * 1024 * 1024 }, request => {
    const input = parseRequest(syncInput, request.body), batch = syncBatch(input);
    return execute(request, attemptId(request), 'workspace.sync', input.recoveryGeneration, (_tx, state, context) => {
      const ids: Record<string,string> = Object.create(null);
      for (const op of batch.operations) if (op.kind === 'create') ids[op.clientFileKey] = randomUUID();
      return syncCommand(state, context, batch, ids);
    });
  });
  app.post('/api/attempts/:id/snapshots', request => {
    const input = parseRequest(snapshotInput, request.body);
    return execute(request, attemptId(request), 'snapshot.create', input.recoveryGeneration,
      (_tx, state, context) => snapshotCommand(state, context, input.expectedWorkspaceRevision, randomUUID()));
  });
  app.post('/api/attempts/:id/controls', request => {
    const input = parseRequest(controlInput, request.body);
    return execute(request, attemptId(request), 'attempt.control', input.recoveryGeneration, (tx, state, context) => {
      const view = activityView(tx, { userId: context.identity.actorId, courseId: state.attempt.courseId, role: 'student' }, state.attempt.activityVersionId);
      const resources = view.content.materials.flatMap(item => item.status === 'available'
        ? item.paragraphs.filter(p => p.paragraphId).map(p => ({ resourceVersionId: item.resourceVersionId, paragraphId: p.paragraphId! })) : []);
      return controlCommand(state, context, input.expectedAttemptRevision, domainControl(input.control), resources, teachingStop);
    }, `attempt_control_${domainControl(input.control).kind}`);
  });
  app.post('/api/attempts/:id/runs', async request => {
    const id = attemptId(request), input = parseRequest(runInput, request.body);
    // A committed ACK needs current read authority, never a new runtime dependency or session write.
    const previous = access.withAuthorizedCourse(request,tx => readAttempt(tx,id).courseId,'student',(tx,actor) => {
      assertResourceUse(actor,locate(tx,id),'read');
      const generation = currentGeneration(input.recoveryGeneration), identity = commandIdentity(request,actor,id,'run.create',generation);
      const state = loadWorkspace(tx,id,identity);
      const receipt = resolveCommandReceipt(state.records,identity,requestHash(identity.target,domainRun(input)),generation);
      currentGeneration(generation); return receipt;
    },false);
    if (previous) return { requestId: request.id,data: { ...previous,replayed: true } };
    const readiness = await queryRuntime(options.runner);
    return execute(request, id, 'run.create', input.recoveryGeneration, (tx, state, context) => {
      const activity = readActivity(tx, state.attempt.courseId, state.attempt.activityVersionId);
      const runtime = readiness.ok ? readiness.runtime : undefined;
      return runCommand(state, context, domainRun(input), { ready: Boolean(runtime && canonical(runtime.profile) === canonical(activity.runtimeProfile)), recoveryGeneration: runtime?.recoveryGeneration ?? input.recoveryGeneration,
        profile: activity.runtimeProfile, policyVersion: activity.helpPolicy.versionId, checkRuleVersion: activity.checkRule.versionId,
        checkCancelPurposes: activity.checkRule.limitedHelp ? ['student_help','reminder','explicit_analysis','passive_analysis'] : [] },
      { runId: randomUUID(), jobId: randomUUID() }, new Date(now() + 120000).toISOString());
    });
  });
  function jobAttempt(tx: Transaction, jobId: string) {
    const row = tx.get('SELECT attempt_id FROM jobs WHERE job_id=?', jobId);
    if (!row?.attempt_id) throw new ApiError('FORBIDDEN');
    return String(row.attempt_id);
  }

  app.post('/api/jobs/:id/cancel', request => {    const jobId = attemptId(request), input = parseRequest(cancelInput, request.body);
    const purpose = access.withAuthorizedCourse(request, tx => {
      const row = tx.get('SELECT course_id,purpose FROM jobs WHERE job_id=?', jobId);
      if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
      return row.course_id;
    }, undefined, (tx, actor) => {
      const row = tx.get('SELECT purpose,student_id FROM jobs WHERE job_id=?', jobId);
      if (row?.purpose === 'student_run' || row?.purpose === 'teacher_sample') {
        if (actor.role !== 'student' || row.student_id !== actor.userId) throw new ApiError('FORBIDDEN');
        return 'run' as const;
      }
      // Teaching purposes stop through the persistent stop capability. Teacher-side design jobs stay owned by A3.
      if (teachingStop) {
        if (actor.role !== 'student' || row?.student_id !== actor.userId) throw new ApiError('FORBIDDEN');
        return 'teaching' as const;
      }
      return 'run' as const;
    });
    if (purpose === 'teaching') return execute(request, tx => jobAttempt(tx, jobId), 'job.cancel', input.recoveryGeneration,
      (_tx, state, context) => cancelTeachingJobCommand(state, { ...context,
        stopReason: input.reason ?? 'explicit_job_cancel' }, jobId, teachingStop));
    return execute(request, tx => jobAttempt(tx, jobId), 'job.cancel', input.recoveryGeneration, (_tx, state, context) => cancelRunCommand(state, context, jobId));
  });
  app.get('/api/jobs/:id', request => {
    const jobId = attemptId(request);
    const data = access.withAuthorizedResource(request, tx => locate(tx, jobAttempt(tx, jobId)), 'read', tx => {
      const state = loadWorkspace(tx, jobAttempt(tx, jobId));
      return readWorkspace(state, () => true).jobs.find(job => job.jobId === jobId);
    });
    return { requestId: request.id, data };
  });
  const workspace = {
    readSnapshot(request: FastifyRequest, id: string, snapshotId: string) {
      return read(request, id, (_tx, state) => readConfirmedSnapshot(state, snapshotId, () => true));
    },
    readDiagnostics(request: FastifyRequest, id: string, runId: string) {
      return read(request, id, (_tx, state) => readRunDiagnostics(state, runId, () => true));
    },
    readProcessRecords(request: FastifyRequest, id: string) {
      return read(request,id,tx => readProcessRecords(tx,id));
    },
    readResultFiles(request: FastifyRequest, id: string, runId: string) {
      return read(request, id, (tx, state) => readResultFiles(state,runId,readActivity(tx,state.attempt.courseId,state.attempt.activityVersionId).runtimeProfile.approvedResultFiles));
    },
    readTutorContext(request: FastifyRequest, id: string) {
      return access.withAuthorizedResource(request, tx => locate(tx, id, true), 'student_help', (tx, actor) => {
        const state = loadWorkspace(tx, id), activity = readActivity(tx, actor.courseId, state.attempt.activityVersionId);
        const limitedCheck = activity.checkRule.limitedHelp && state.checks.some(check => check.state === 'active');
        return { attempt: state.attempt, activity: activityView(tx, actor, activity.activityVersionId, 'tutor'),
          limitedCheck, helpAllowed: activity.helpPolicy.helpAllowed && !limitedCheck };
      });
    },
    ...createWorkspaceWorker(designOptions),
  };
  // C3 read/command seams. The teaching composer replaces these with real implementations; an unattached
  // workspace never reports a teaching action invalidation it did not perform.
  type WorkspaceTeachingSurface = {
    acceptStudentQuestion: ((request: FastifyRequest, attemptId: string, input: unknown) =>
      {messageId:string;jobId:string;contentHash:string;stoppedJobIds:string[]}) | undefined;
    completeTeaching: ((request: FastifyRequest, attemptId: string, input: unknown) =>
      {messageId:string;actionId:string;disposition:ActionDisposition;replayed:boolean;contentHash:string}) | undefined;
    stopTeaching: TeachingStopHandler | undefined;
    readTeachingRecords: (request: FastifyRequest, attemptId: string) => {messages:TeachingMessage[];actions:TeachingActionRecord[]};
    readCoverage: (request: FastifyRequest, attemptId: string) => TeachingCoverage;
  };
  const teaching: WorkspaceTeachingSurface = {
    acceptStudentQuestion: undefined,
    completeTeaching: undefined,
    stopTeaching: teachingStop,
    readTeachingRecords(request: FastifyRequest, id: string) { return read(request, id, (tx, _state, actor) => readTeachingRecords(tx, id, actor.role)); },
    readCoverage(request: FastifyRequest, id: string) { return read(request, id, tx => readCoverage(tx, id)); },
  };
  app.get('/api/attempts/:id/teaching-records', request => {
    const id = attemptId(request);
    return { requestId: request.id, data: teaching.readTeachingRecords(request, id) };
  });
  app.get('/api/attempts/:id/coverage', request => {
    const id = attemptId(request);
    return { requestId: request.id, data: teaching.readCoverage(request, id) };
  });
  app.get('/api/attempts/:id/snapshots/:snapshotId', request => {
    const value = parseRequest(params.extend({ snapshotId: params.shape.id }), request.params);
    return { requestId: request.id, data: workspace.readSnapshot(request, value.id, value.snapshotId) };
  });
  app.get('/api/attempts/:id/runs/:runId', request => {
    const value = parseRequest(params.extend({ runId: params.shape.id }), request.params);
    return { requestId: request.id, data: read(request, value.id, (_tx, state) => {
      const run = readWorkspace(state, () => true).runs.find(item => item.runId === value.runId);
      if (!run) throw new ApiError('FORBIDDEN'); return run;
    }) };
  });
  app.get('/api/attempts/:id/runs/:runId/files', request => {
    const value = parseRequest(params.extend({ runId: params.shape.id }),request.params);
    return { requestId: request.id,data: workspace.readResultFiles(request,value.id,value.runId) };
  });
  return { ...instance, workspace: { ...workspace, teaching } };
}
