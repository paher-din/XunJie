import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { createDesignApp, type DesignAppOptions } from '../design/application.ts';
import { assignmentCourse, assignmentAvailability, readActivity, activityView } from '../design/activities.ts';
import { finishRecordCommand, readAttempt, saveAttempt } from '../db/records-adapter.ts';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { queryRuntime } from '../design/readiness.ts';
import { canonical } from '../records/commands.ts';
import { createAttempt } from './snapshots.ts';
import { loadWorkspace, persistWorkspace, readProcessRecords } from './storage.ts';
import { generationInput, params, key, syncInput, snapshotInput, controlInput, runInput, syncBatch, domainControl, domainRun } from './inputs.ts';
import { syncCommand, snapshotCommand, controlCommand, runCommand, cancelRunCommand, readWorkspace, readConfirmedSnapshot, readRunDiagnostics } from './commands.ts';
import type { CommandContext, WorkspaceState } from './commands.ts';
import { createWorkspaceWorker } from './worker.ts';
import { readResultFiles } from './result-files.ts';
import { z } from 'zod';

const attemptResult = z.strictObject({ attemptId: z.string(), activityVersionId: z.string(), assignmentId: z.string() });
export async function createWorkspaceApp(options: DesignAppOptions) {
  const instance = await createDesignApp(options), { app, access } = instance;
  const now = options.now ?? Date.now;
  const currentGeneration = (expected: string) => {
    if (!expected || options.currentGeneration() !== expected) throw new ApiError('RECOVERY_REQUIRED');
    return expected;
  };
  const attemptId = (request: FastifyRequest) => parseRequest(params, request.params).id;
  function locate(tx: Transaction, id: string) {
    const attempt = readAttempt(tx, id);
    const available = assignmentAvailability(tx, attempt.courseId, attempt.assignmentId, attempt.studentId);
    return { kind: 'student_work' as const, courseId: attempt.courseId, studentId: attempt.studentId,
      stage: attempt.status, assignmentActive: available.active };
  }
  function read<T>(request: FastifyRequest, id: string, work: (tx: Transaction, state: WorkspaceState) => T) {
    return access.withAuthorizedResource(request, tx => locate(tx, id), 'read', tx => work(tx, loadWorkspace(tx, id)));
  }
  function execute(request: FastifyRequest, target: string | ((tx: Transaction) => string), command: string, expectedGeneration: string,
    apply: (tx: Transaction, state: WorkspaceState, context: CommandContext) => ReturnType<typeof syncCommand>) {
    const idempotencyKey = parseRequest(key, request.headers['idempotency-key']);
    let id: string;
    const data = access.withAuthorizedResource(request, tx => { id = typeof target === 'string' ? target : target(tx); return locate(tx, id); }, 'write', (tx, actor, scope) => {
      const generation = currentGeneration(expectedGeneration);
      const identity = { actorId: actor.userId, command, target: request.url.split('?',1)[0]!,
        scope: { courseId: actor.courseId, studentId: actor.userId, attemptId: id }, idempotencyKey, recoveryGeneration: generation,
        ...(command === 'workspace.sync' ? { sync: { clientId: parseRequest(syncInput, request.body).clientId, clientSeq: parseRequest(syncInput, request.body).clientSeq } } : {}) };
      const before = loadWorkspace(tx, id, identity);
      const context: CommandContext = { identity, generation, now: new Date(now()).toISOString(),
        commandId: randomUUID(), receiptId: randomUUID(), eventId: randomUUID(), assignmentActive: scope.kind === 'student_work' && scope.assignmentActive, authorize: () => true };
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
      return controlCommand(state, context, input.expectedAttemptRevision, domainControl(input.control), resources);
    });
  });
  app.post('/api/attempts/:id/runs', async request => {
    const id = attemptId(request), input = parseRequest(runInput, request.body);
    // Authentication and generation precede network work; rechecked in the accepting transaction.
    read(request, id, () => currentGeneration(input.recoveryGeneration));
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
  app.post('/api/jobs/:id/cancel', request => {
    const jobId = attemptId(request), input = parseRequest(generationInput, request.body);
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
      return access.withAuthorizedResource(request, tx => locate(tx, id), 'student_help', (tx, actor) => {
        const state = loadWorkspace(tx, id), activity = readActivity(tx, actor.courseId, state.attempt.activityVersionId);
        const limitedCheck = activity.checkRule.limitedHelp && state.checks.some(check => check.state === 'active');
        return { attempt: state.attempt, activity: activityView(tx, actor, activity.activityVersionId, 'tutor'),
          limitedCheck, helpAllowed: activity.helpPolicy.helpAllowed && !limitedCheck };
      });
    },
    ...createWorkspaceWorker(options),
  };
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
  return { ...instance, workspace };
}
