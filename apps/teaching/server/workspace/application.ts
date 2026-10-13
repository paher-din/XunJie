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
import type { ActorContext, ResourceUse } from '../../contracts/access/index.ts';
import type { ActionDisposition, CommandReceipt, TeachingActionRecord, TeachingCoverage, TeachingMessage } from '../../contracts/records/index.ts';
import type { RecoveryFeedback } from '../../contracts/workspace/index.ts';
import type { DesignTeachingStop } from '../design/activities.ts';
import { createAttempt } from './snapshots.ts';
import { loadWorkspace, persistWorkspace, readProcessRecords, readTeachingRecords, readCoverage } from './storage.ts';
import { planReopenGrant, transitionAttemptInTransaction, writeReopenGrant } from './submissions.ts';
import { generationInput, cancelInput, params, key, syncInput, snapshotInput, controlInput, runInput, syncBatch, domainControl, domainRun,
  artifactSubmissionInput, domainArtifactSubmission, recoveryQuery, reopenGrantInput, reviewTransitionInput } from './inputs.ts';
import { syncCommand, snapshotCommand, controlCommand, runCommand, cancelRunCommand, cancelTeachingJobCommand, submitCommand,
  readWorkspace, readRecovery, readConfirmedSnapshot, readRunDiagnostics } from './commands.ts';
import type { CommandContext, TeachingStopHandler, WorkspaceState } from './commands.ts';
import { createWorkspaceWorker } from './worker.ts';
import { readResultFiles } from './result-files.ts';
import { z } from 'zod';
import type { createHdlWorkspace } from './hdl.ts';

export type WorkspaceAppOptions = Omit<DesignAppOptions,'teaching'> & {teaching?:{stop:TeachingStopHandler;design?:DesignTeachingStop};hdl?:ReturnType<typeof createHdlWorkspace>};
const attemptResult = z.strictObject({ attemptId: z.string(), activityVersionId: z.string(), assignmentId: z.string() });
export async function createWorkspaceApp(options: WorkspaceAppOptions) {
  const { teaching: extensions, hdl, ...designOptions } = options;
  if(hdl&&hdl.databaseFile!==options.db.file)throw new ApiError('INVALID_CONFIGURATION');
  // Workspace owns the shared Job paths and dispatches each purpose to its original handler.
  const instance = await createDesignApp({ ...designOptions, ...(extensions?.design ? { teaching: { stop: extensions.design } } : {}) }, false);
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
    runPurposes?: CommandContext['runPurposes'], use: ResourceUse = 'write') {
    let id: string;
    const data = access.withAuthorizedResource(request, tx => { id = typeof target === 'string' ? target : target(tx); return locate(tx, id, true); }, use, (tx, actor, scope) => {
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
  // A current teacher may read retained facts after student withdrawal. The student's ability to consume
  // a grant is false in that case or when the account is disabled; reader authorization remains separate.
  const assignmentActionable = (tx: Transaction, state: WorkspaceState) => Boolean(tx.get(
    "SELECT m.user_id FROM course_memberships m JOIN users u ON u.id=m.user_id WHERE m.course_id=? AND m.user_id=? AND m.role='student' AND m.active=1 AND u.disabled_at_ms IS NULL",
    state.attempt.courseId, state.attempt.studentId))
    && assignmentAvailability(tx, state.attempt.courseId, state.attempt.assignmentId, state.attempt.studentId).active;
  const workspaceProjection = (tx: Transaction, state: WorkspaceState) => readWorkspace(state, () => true,
    assignmentActionable(tx, state));
  app.get('/api/attempts/:id', request => ({ requestId: request.id, data: read(request, attemptId(request), (tx, state) => workspaceProjection(tx, state)) }));
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
  app.post('/api/attempts/:id/controls', async request => {
    const input = parseRequest(controlInput, request.body), control = domainControl(input.control);
    // `resume_revision` is issued while the artifact is read-only at `reviewed`, where the shared resource gate
    // refuses a student write. It is authorized as a read of the student's own attempt — which still enforces
    // course membership and attempt ownership — and C's own stage, assignment and grant guards decide the
    // transition. A teacher account is rejected by `guardCommand`'s actor comparison. A's `contracts/access` and
    // `assertResourceUse` are unchanged; see the task record §6 for the proposed dedicated use.
    const response=execute(request, attemptId(request), 'attempt.control', input.recoveryGeneration, (tx, state, context) => {
      const view = activityView(tx, { userId: context.identity.actorId, courseId: state.attempt.courseId, role: 'student' }, state.attempt.activityVersionId);
      const resources = view.content.materials.flatMap(item => item.status === 'available'
        ? item.paragraphs.filter(p => p.paragraphId).map(p => ({ resourceVersionId: item.resourceVersionId, paragraphId: p.paragraphId! })) : []);
      const result=controlCommand(state, context, input.expectedAttemptRevision, control, resources, teachingStop);
      if(control.kind==='pause')hdl?.stopInTransaction(tx,state.attempt.attemptId,'attempt_paused',input.recoveryGeneration);
      return result;
    }, `attempt_control_${control.kind}`, undefined, control.kind === 'resume_revision' ? 'read' : 'write');
    await hdl?.reconcileStops();return response;
  });
  app.post('/api/attempts/:id/submissions', request => {
    const id = attemptId(request), input = parseRequest(artifactSubmissionInput, request.body);
    const submission = domainArtifactSubmission(input);
    // A committed ACK needs current read authority, never a second business action. The attempt is already
    // read-only at `submitted`, so a client retry is resolved from the original receipt before the write gate can
    // turn an idempotent replay into a state conflict.
    const previous = access.withAuthorizedCourse(request, tx => readAttempt(tx, id).courseId, 'student', (tx, actor) => {
      assertResourceUse(actor, locate(tx, id), 'read');
      const generation = currentGeneration(input.recoveryGeneration);
      const identity = commandIdentity(request, actor, id, 'submission.create', generation);
      const state = loadWorkspace(tx, id, identity);
      const receipt = resolveCommandReceipt(state.records, identity, requestHash(identity.target, submission), generation);
      currentGeneration(generation); return receipt;
    }, false);
    if (previous) return { requestId: request.id, data: { ...previous, replayed: true } };
    return execute(request, id, 'submission.create', input.recoveryGeneration,
      (_tx, state, context) => submitCommand(state, context, submission, { submissionId: randomUUID() }, teachingStop),
      'submission_confirmed');
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
  function jobCourse(tx: Transaction, jobId: string) {
    const row = tx.get('SELECT course_id FROM jobs WHERE job_id=?', jobId);
    if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
    return row.course_id;
  }

  app.post('/api/jobs/:id/cancel', async request => {    const jobId = attemptId(request), input = parseRequest(cancelInput, request.body);
    // Read-only preflight: `execute` below owns the session activity bump, so this one must not advance it.
    const purpose = access.withAuthorizedCourse(request, tx => jobCourse(tx, jobId), undefined, (tx, actor) => {
      const row = tx.get('SELECT purpose,student_id,job_json FROM jobs WHERE job_id=?', jobId);
      if(String(JSON.parse(String(row?.job_json??'{}')).kind??'').startsWith('hdl_')){
        if(actor.role!=='student'||row?.student_id!==actor.userId)throw new ApiError('FORBIDDEN');
        if(!hdl)throw new ApiError('RUNTIME_NOT_READY');return 'hdl' as const;
      }
      if (row?.purpose === 'teacher_design') {
        if (!instance.teacherAgent) throw new ApiError('FORBIDDEN');
        return 'teacher_design' as const;
      }
      if (row?.purpose === 'student_run' || row?.purpose === 'teacher_sample') {
        if (actor.role !== 'student' || row.student_id !== actor.userId) throw new ApiError('FORBIDDEN');
        return 'run' as const;
      }
      if (teachingStop) {
        if (actor.role !== 'student' || row?.student_id !== actor.userId) throw new ApiError('FORBIDDEN');
        return 'teaching' as const;
      }
      return 'run' as const;
    }, false);
    if(purpose==='hdl'){
      const data=access.withAuthorizedResource(request,tx=>locate(tx,jobAttempt(tx,jobId)),'write',(tx,actor)=>
        hdl!.cancelInTransaction(tx,actor,jobId,parseRequest(key,request.headers['idempotency-key']),input.recoveryGeneration,input.reason));
      await hdl!.reconcileStops();return {requestId:request.id,data};
    }
    if (purpose === 'teacher_design') return instance.teacherAgent!.cancelJob(request);
    if (purpose === 'teaching') return execute(request, tx => jobAttempt(tx, jobId), 'job.cancel', input.recoveryGeneration,
      (_tx, state, context) => cancelTeachingJobCommand(state, { ...context,
        stopReason: input.reason ?? 'explicit_job_cancel' }, jobId, teachingStop));
    return execute(request, tx => jobAttempt(tx, jobId), 'job.cancel', input.recoveryGeneration, (_tx, state, context) => cancelRunCommand(state, context, jobId));
  });
  app.get('/api/jobs/:id', request => {
    const jobId = attemptId(request);
    if (instance.teacherAgent && access.withAuthorizedCourse(request, tx => jobCourse(tx, jobId), undefined,
      tx => tx.get('SELECT purpose FROM jobs WHERE job_id=?', jobId)?.purpose === 'teacher_design', false))
      return instance.teacherAgent.readJob(request);
    const data = access.withAuthorizedResource(request, tx => locate(tx, jobAttempt(tx, jobId)), 'read', tx => {
      const state = loadWorkspace(tx, jobAttempt(tx, jobId));
      return workspaceProjection(tx, state).jobs.find(job => job.jobId === jobId);
    });
    return { requestId: request.id, data };
  });
  const runWorker=createWorkspaceWorker(designOptions);
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
    pendingJobs:()=>[...runWorker.pendingJobs(),...(hdl?.pendingJobs()??[])],
    async processJob(jobId:string){
      const kind=options.db.withTransaction(tx=>tx.get('SELECT job_json FROM jobs WHERE job_id=?',jobId));
      if(String(JSON.parse(String(kind?.job_json??'{}')).kind??'').startsWith('hdl_')){
        if(!hdl)throw new ApiError('RUNTIME_NOT_READY');await hdl.processJob(jobId);await hdl.reconcileStops();
      }else await runWorker.processJob(jobId);
    },
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
    return { requestId: request.id, data: read(request, value.id, (tx, state) => {
      const run = workspaceProjection(tx, state).runs.find(item => item.runId === value.runId);
      if (!run) throw new ApiError('FORBIDDEN'); return run;
    }) };
  });
  app.get('/api/attempts/:id/runs/:runId/files', request => {
    const value = parseRequest(params.extend({ runId: params.shape.id }),request.params);
    return { requestId: request.id,data: workspace.readResultFiles(request,value.id,value.runId) };
  });
  // C4 recovery read. Read-only: it never activates the attempt, enqueues a job, repeats a side effect or moves
  // the learning stage, and a page that has not synchronized is told to re-sync instead of being handed content.
  app.get('/api/attempts/:id/recovery', request => {
    const id = attemptId(request), query = parseRequest(recoveryQuery, request.query);
    return { requestId: request.id, data: read(request, id, (tx, state) => {
      const generation = options.currentGeneration();
      const resyncRequired = query.recoveryGeneration !== generation || !Number.isSafeInteger(query.decisionEpoch)
        || query.decisionEpoch !== state.attempt.decisionEpoch;
      return readRecovery(state, { recoveryGeneration: generation, resyncRequired,
        assignmentActive: assignmentActionable(tx, state),
        feedback: recovery.readFeedback(request, id), coverage: readCoverage(tx, id) }, () => true);
    }) };
  });
  // C4 recovery surface. A5 owns formal feedback; an unattached view reports it unavailable rather than
  // reconstructing feedback text from hashes, digests or submission rows.
  type WorkspaceRecoverySurface = { readFeedback: (request: FastifyRequest, attemptId: string) => RecoveryFeedback };
  const recovery: WorkspaceRecoverySurface = {
    readFeedback: (_request: FastifyRequest, _attemptId: string): RecoveryFeedback => ({ status: 'unavailable' }),
  };
  // C4 seams for A5's teacher routes, the `transitionAttempt/grantReopen` pair TECH §7.2.1 assigns to C. A5 owns
  // the HTTP surface, the feedback record and the permission decision; C owns the same-transaction stage move and
  // the grant storage, so an artifact can never be reopened behind the student's back. C publishes no substitute
  // product route of its own for either command.
  const reviewedResult = z.strictObject({ attemptId: z.string(), status: z.literal('reviewed'),
    attemptRevision: z.number().int().positive(), decisionEpoch: z.number().int().nonnegative() });
  const grantResult = z.strictObject({ grantId: z.string(), submissionId: z.string(), attemptRevision: z.number().int().positive(),
    status: z.literal('reviewed'), supersededGrantIds: z.array(z.string()) });
  type WorkspaceReopenSurface = {
    markReviewed: (request: FastifyRequest, attemptId: string, raw: unknown) =>
      {requestId:string;data:CommandReceipt<z.infer<typeof reviewedResult>> & {replayed:boolean}};
    grant: (request: FastifyRequest, attemptId: string, raw: unknown) =>
      {requestId:string;data:CommandReceipt<z.infer<typeof grantResult>> & {replayed:boolean}};
  };
  const reopen: WorkspaceReopenSurface = {
    markReviewed(request: FastifyRequest, id: string, raw: unknown) {
      const input = parseRequest(reviewTransitionInput, raw);
      const idempotencyKey = parseRequest(key, request.headers['idempotency-key']);
      const data = access.withAuthorizedCourse(request, tx => readAttempt(tx, id).courseId, 'teacher', (tx, actor) => {
        const generation = currentGeneration(input.recoveryGeneration), studentId = readAttempt(tx, id).studentId;
        // `work` only runs for a fresh command, so a replay is reported as one instead of looking like a second
        // stage change. The persisted receipt is returned unchanged in both cases.
        let applied = false;
        const receipt = finishRecordCommand(tx, { actorId: actor.userId, command: 'attempt.reviewed',
          target: `/api/attempts/${id}/reviews`, scope: { courseId: actor.courseId, studentId, attemptId: id },
          idempotencyKey, recoveryGeneration: generation }, input, generation, now(), () => {
          applied = true;
          return transitionAttemptInTransaction(tx, { attemptId: id, courseId: actor.courseId,
            expectedAttemptRevision: input.expectedAttemptRevision, to: input.to });
        }, value => reviewedResult.parse(value));
        currentGeneration(generation); return { ...receipt, replayed: !applied };
      });
      return { requestId: request.id, data };
    },
    grant(request: FastifyRequest, id: string, raw: unknown) {
      const input = parseRequest(reopenGrantInput, raw);
      const idempotencyKey = parseRequest(key, request.headers['idempotency-key']);
      const data = access.withAuthorizedCourse(request, tx => readAttempt(tx, id).courseId, 'teacher', (tx, actor) => {
        const generation = currentGeneration(input.recoveryGeneration), studentId = readAttempt(tx, id).studentId;
        // The guards and the CAS run while the command is planned; the grant row names the receipt that authorized
        // it, so it is written once that receipt exists. A replay returns the original receipt result unchanged.
        let pending: ReturnType<typeof planReopenGrant> | undefined, written = false;
        const receipt = finishRecordCommand(tx, { actorId: actor.userId, command: 'attempt.reopen',
          target: `/api/attempts/${id}/reopen`, scope: { courseId: actor.courseId, studentId, attemptId: id },
          idempotencyKey, recoveryGeneration: generation }, input, generation, now(), () => {
          pending = planReopenGrant(tx, { attemptId: id, courseId: actor.courseId, grantedBy: actor.userId,
            expectedAttemptRevision: input.expectedAttemptRevision, submissionId: input.submissionId,
            reason: input.reason, grantId: randomUUID(), now: new Date(now()).toISOString() });
          return { grantId: pending.grant.grantId, submissionId: pending.grant.submissionId,
            attemptRevision: pending.attempt.attemptRevision, status: 'reviewed' as const,
            supersededGrantIds: pending.superseded.map(row => row.grantId) };
        }, value => grantResult.parse(value), (receiptId, result) => {
          if (!pending) throw new Error('Missing planned reopen grant.');
          const granted = writeReopenGrant(tx, pending, receiptId);
          if (granted.grantId !== result.grantId || granted.submissionId !== result.submissionId
            || granted.attemptRevision !== result.attemptRevision || granted.status !== result.status)
            throw new ApiError('PERSISTENCE_UNAVAILABLE');
          written = true;
        });
        currentGeneration(generation); return { ...receipt, replayed: !written };
      });
      return { requestId: request.id, data };
    },
  };
  return { ...instance, workspace: { ...workspace, teaching, recovery, reopen } };
}
