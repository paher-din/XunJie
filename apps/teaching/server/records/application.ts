import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { createWorkspaceApp } from '../workspace/application.ts';
import type { DesignTeachingStop } from '../design/activities.ts';
import { readAttempt, readRecordCommand, finishRecordCommand, saveJob } from '../db/records-adapter.ts';
import type { Transaction } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import type { ActionDisposition, TeachingActionRecord, TeachingCoverage, TeachingEventPayload, TeachingEventView,
  TeachingEventsPage, TeachingMessage, TeachingScopeRef, TeachingStopContext, TeachingStopResult, TeachingVersions } from '../../contracts/records/index.ts';
import type { StudentHelpBody } from '../../contracts/tutoring/index.ts';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { assertResourceUse } from '../access/resource.ts';
import { readCoverageIntervals, readTeachingRecordsInTransaction, readTeachingJob, acceptStudentQuestionInTransaction,
  saveTeachingJobInTransaction, completeTeachingInTransaction, deliverTeachingActionInTransaction,
  recordTeachingReceiptInTransaction, stopTeachingJobsInTransaction, teachingActionIsCurrent,reconcileTeachingBasisInTransaction } from './teaching.ts';
import type { TeachingBasisCurrent } from './teaching.ts';
import { claimJob } from './jobs.ts';
import type { TeachingStopHandler } from '../workspace/commands.ts';

// Single definition, shared with C2's control/cancel paths; re-exported for the B2/A4 callers of this composer.
export type { TeachingStopHandler };
export type TeachingRecordsOptions = Parameters<typeof createWorkspaceApp>[0] & { teaching?: { stop: TeachingStopHandler };isTeachingBasisCurrent?: TeachingBasisCurrent };
/** C's stop capability presented in A's design callback shape (activity/assignment pause). */
export function designTeachingStop(stop: TeachingStopHandler): DesignTeachingStop {
  return (tx, actor, details) => stop(tx, details.courseId, actor.userId, details.stoppedJobIds,
    { reason: details.reason, generation: details.generation, now: new Date(details.controlledAt).toISOString() });
}

const id = z.string().min(1).max(128);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = id.regex(/^[\x21-\x7e]+$/);
const params = z.strictObject({ id });
const versionsInput = z.strictObject({ activityVersionId: id, policyVersionId: id, modelConfigVersion: id, promptVersion: id,
  schemaVersion: id, analysisVersion: id.optional() });
const objectRefInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), attemptId: id, activityVersionId: id }),
  z.strictObject({ kind: z.literal('run'), attemptId: id, runId: id, snapshotId: id }),
  z.strictObject({ kind: z.literal('resource'), attemptId: id, resourceVersionId: id, paragraphId: id }),
  z.strictObject({ kind: z.literal('code'), attemptId: id, snapshotId: id, fileId: id, path: z.string(),
    documentVersion: positive, contentHash: hash,
    range: z.strictObject({ startLine: positive, startColumn: positive, endLine: positive, endColumn: positive }).optional(),
    source: z.strictObject({ system: z.literal('student-ide'), session: id, modelId: id, seq: natural.optional() }).optional() }),
]);
const basisInput = z.strictObject({ attemptRevision: positive, decisionEpoch: natural, captureRevision: natural,
  relatedStateRevision: natural, objectRef: objectRefInput.optional(), inputRefs: z.array(id), assistanceRefs: z.array(id),
  coverageRefs: z.array(id) });
export const teachingQuestionInput = z.strictObject({ recoveryGeneration: id, expectedAttemptRevision: positive,
  question: z.string().min(1).max(16384), objectRef: objectRefInput.optional(), inputRefs: z.array(id).max(64).default([]),
  versions: versionsInput, deadlineSeconds: z.number().int().positive().max(45).default(45) });
// The worker presents the lease it holds (or will claim with); C never supplies one from the persisted job,
// because a backfilled token would make the lease recheck in `completeTeachingInTransaction` vacuous.
export const teachingCompleteInput = z.strictObject({ recoveryGeneration: id, jobId: id, leaseToken: id,
  bodyJson: z.string().min(2), resultRef: id.optional(), versions: versionsInput,
  usage: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('actual'), inputTokens: natural, outputTokens: natural }),
    z.strictObject({ status: z.literal('unknown'), reason: id.optional() })]),
  calls: z.number().int().nonnegative().max(3), elapsedMs: natural, basis: basisInput });
export const teachingReceiptInput = z.strictObject({ recoveryGeneration: id, deliveryId: id.optional(), clientId: id,
  contentHash: hash, receiptKind: z.enum(['received','displayed','acknowledged','cancelled','stale','failed']),
  clientReceiptId: id, clientDeclaredAt: z.iso.datetime().optional(), versions: versionsInput.optional() });
export const teachingStopInput = z.strictObject({ recoveryGeneration: id, reason: z.string().min(1).max(512), causeRef: id.optional() });
export const teachingEventsQuery = z.strictObject({ afterServerSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(100).default(50), clientId: id.optional(),
  recoveryGeneration: id.optional(), decisionEpoch: z.coerce.number().int().nonnegative().optional() });

/** The bounded, replayable answer C gives the B2 help entry. */
export type QuestionResult = {messageId:string;jobId:string;contentHash:string;stoppedJobIds:string[]};

/** C3 stops teaching jobs through the same persistent capability A2/C2 control paths use. */
export function teachingStopHandler(tx: Transaction, courseId: string, studentId: string, jobIds: string[],
  context: TeachingStopContext): TeachingStopResult {
  // One A2 pause can cover several students; each job stops in its own call inside the same transaction.
  const groups = new Map<string, {scope: TeachingScopeRef; jobIds: string[]}>();
  for (const jobId of jobIds) {
    const row = tx.get('SELECT student_id,attempt_id FROM jobs WHERE job_id=? AND course_id=?', jobId, courseId);
    const owner = row?.student_id === null || row?.student_id === undefined ? '' : String(row.student_id);
    const attemptId = row?.attempt_id === null || row?.attempt_id === undefined ? '' : String(row.attempt_id);
    if (!owner || !attemptId) throw new ApiError('INVALID_REFERENCE');
    const key = `${owner}\0${attemptId}`;
    const group = groups.get(key) ?? { scope: { courseId, studentId: owner, attemptId }, jobIds: [] };
    group.jobIds.push(jobId);
    groups.set(key, group);
  }
  if (!groups.size) return { stoppedJobIds: [], invalidatedActionIds: [], jobs: [] };
  const stoppedJobIds: string[] = [], invalidatedActionIds: string[] = [];
  const jobs: TeachingStopResult['jobs'] = [];
  for (const group of groups.values()) {
    const result = stopTeachingJobsInTransaction(tx, { actorId: studentId || group.scope.studentId,
      scope: group.scope, jobIds: group.jobIds, reason: context.reason,
      ...(context.causeRef === undefined ? {} : { causeRef: context.causeRef }), generation: context.generation, now: context.now,
      audit: false });
    stoppedJobIds.push(...result.jobIds); invalidatedActionIds.push(...result.actionIds); jobs.push(...result.jobs);
  }
  return { stoppedJobIds, invalidatedActionIds: [...new Set(invalidatedActionIds)], jobs };
}

/**
 * C3 composition: teaching records on top of the C2 workspace app. It adds the message/action/delivery/receipt
 * storage, the authorized cursor read and the receipt endpoint. B2 owns the real help/worker entries; C exposes
 * the same-transaction seams those entries call and never invents a substitute product path.
 */
export async function createTeachingRecordsApp(options: TeachingRecordsOptions) {
  // C2's control/cancel paths and A2's design controls call the same stop capability in their own transactions.
  const stop = options.teaching?.stop ?? teachingStopHandler;
  const instance = await createWorkspaceApp({ ...options, teaching: { stop, design: designTeachingStop(stop) } });
  const { app, access, workspace } = instance;
  const now = options.now ?? Date.now;
  const nowMs = () => now();
  const timestamp = () => new Date(now()).toISOString();
  const generation = (expected: string | undefined) => {
    if (!expected || options.currentGeneration() !== expected) throw new ApiError('RECOVERY_REQUIRED');
    return expected;
  };
  const scopeOf = (tx: Transaction, attemptId: string): TeachingScopeRef => {
    const attempt = readAttempt(tx, attemptId);
    return { courseId: attempt.courseId, studentId: attempt.studentId, attemptId: attempt.attemptId };
  };
  const studentWork = (tx: Transaction, attemptId: string) => {
    const attempt = readAttempt(tx, attemptId);
    const assignment = tx.get('SELECT status FROM assignments WHERE id=?', attempt.assignmentId);
    return { kind: 'student_work' as const, courseId: attempt.courseId, studentId: attempt.studentId, stage: attempt.status,
      assignmentActive: assignment?.status === 'active' };
  };
  const authorizeAttempt = <T>(request: FastifyRequest, attemptId: string, use: 'read' | 'write' | 'student_help',
    work: (tx: Transaction, actor: ActorContext) => T): T =>
    access.withAuthorizedResource(request, tx => studentWork(tx, attemptId), use, (tx, actor) => work(tx, actor));

  function eventPayload(action: TeachingActionRecord, message: TeachingMessage | undefined): TeachingEventPayload {
    const base: TeachingEventPayload = { actionId: action.actionId, contentHash: action.contentHash,
      disposition: action.disposition, createdAt: action.createdAt, basisRevised: action.basisRevised };
    if (!message || message.envelope.kind !== 'student_help') return base;
    const body = message.envelope.body as StudentHelpBody;
    return { ...base, actionType: body.actionType, content: body.content, rationale: body.rationale,
      expectedStudentAction: body.expectedStudentAction, assistanceContext: body.assistanceContext,
      evidenceIds: [...body.evidenceIds], resourceRefs: [...body.resourceRefs], unresolved: [...body.unresolved] };
  }

  /** Authorized bounded page. A cursor/hash never grants authority and a teacher read creates no student delivery. */
  function readPage(tx: Transaction, request: FastifyRequest, attemptId: string, actor: ActorContext): TeachingEventsPage {
    const query = parseRequest(teachingEventsQuery, request.query);
    const scope = scopeOf(tx, attemptId), attempt = readAttempt(tx, attemptId);
    const isStudent = actor.userId === attempt.studentId;
    const control = { attemptRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch,
      captureRevision: attempt.captureRevision, collecting: attempt.collecting, reminders: attempt.reminders,
      generation: options.currentGeneration(), status: attempt.status };
    // An unsynchronized or stale epoch returns control only; displayable content waits for a real re-sync.
    if (!query.recoveryGeneration || query.recoveryGeneration !== options.currentGeneration()
      || !Number.isSafeInteger(query.decisionEpoch) || query.decisionEpoch !== attempt.decisionEpoch || (isStudent && !query.clientId))
      return { control, resyncRequired: true, events: [], nextServerSeq: query.afterServerSeq, hasMore: false };
    let records = readTeachingRecordsInTransaction(tx, scope);
    if (options.isTeachingBasisCurrent) {
      for (const action of records.actions) reconcileTeachingBasisInTransaction(tx,{scope,actionId: action.actionId,
        actorId: actor.userId,generation: control.generation,now: timestamp()},options.isTeachingBasisCurrent);
      records = readTeachingRecordsInTransaction(tx,scope);
    }
    const eligible = isStudent ? records.actions.filter(action => teachingActionIsCurrent(tx, action, control.generation,options.isTeachingBasisCurrent)
      && !action.receipts.some(receipt => ['displayed','acknowledged'].includes(receipt.receiptKind))
      && !action.deliveries.some(delivery => delivery.clientId === query.clientId && delivery.recoveryGeneration === control.generation)) : [];
    const readRows = () => tx.all(`SELECT e.* FROM audit_events e
      WHERE e.course_id=? AND e.server_seq>? AND json_extract(e.object_ref_json,'$.scope.attemptId')=?
      AND (?=0 OR e.command NOT LIKE 'shared.job.%')
      AND (?=0 OR NOT EXISTS (SELECT 1 FROM teaching_deliveries d WHERE d.delivery_id=json_extract(e.object_ref_json,'$.payloadRef')
        AND (d.client_id<>? OR d.recipient_id<>? OR d.recovery_generation<>?)))
      ORDER BY e.server_seq LIMIT ?`, scope.courseId, query.afterServerSeq, attemptId, Number(isStudent), Number(isStudent),
      query.clientId ?? '', attempt.studentId, control.generation, query.limit + 1);
    let rows = readRows();
    // Allocate a send attempt only when its content fits this response; older events must advance first.
    const sending = eligible.slice(0, Math.max(0, query.limit - rows.length));
    for (const action of sending) {
      deliverTeachingActionInTransaction(tx, { scope, actionId: action.actionId, clientId: query.clientId!,
        recoveryGeneration: control.generation, now: timestamp(), generation: control.generation,
        control: { attemptRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch, captureRevision: attempt.captureRevision },
        ...(options.isTeachingBasisCurrent ? {isBasisCurrent: options.isTeachingBasisCurrent} : {}) });
    }
    if (sending.length) { records = readTeachingRecordsInTransaction(tx, scope); rows = readRows(); }
    const events: TeachingEventView[] = rows.slice(0, query.limit).map(row => {
      const event = { serverSeq: Number(row.server_seq), eventId: String(row.event_id),
        type: String(row.command).replace(/^shared\./, ''), occurredAt: new Date(Number(row.committed_at_ms)).toISOString() };
      const reference = String((JSON.parse(String(row.object_ref_json)) as {payloadRef?: string}).payloadRef ?? '');
      const action = records.actions.find(item => item.deliveries.some(delivery => delivery.deliveryId === reference));
      if (!isStudent || !action || !teachingActionIsCurrent(tx, action, control.generation,options.isTeachingBasisCurrent)) return event;
      const delivery = action.deliveries.find(item => item.deliveryId === reference)!;
      return { ...event, payload: { ...eventPayload(action, records.messages.find(item => item.messageId === action.messageId)), deliveryId: delivery.deliveryId } };
    });
    const hasMore = rows.length > query.limit || eligible.length > sending.length;
    generation(control.generation);
    return { control, resyncRequired: false, events,
      nextServerSeq: events.length ? events[events.length - 1]!.serverSeq : query.afterServerSeq, hasMore,
      ...(isStudent ? { coverage: readCoverageIntervals(tx, attemptId) } : {}) };
  }

  app.get('/api/attempts/:id/events', request => {
    const attemptId = parseRequest(params, request.params).id;
    const data = authorizeAttempt(request, attemptId, 'read', (tx, actor) => readPage(tx, request, attemptId, actor));
    return { requestId: request.id, data };
  });

  app.post('/api/actions/:id/receipts', request => {
    const actionId = parseRequest(params, request.params).id, input = parseRequest(teachingReceiptInput, request.body);
    const idempotencyKey = parseRequest(key, request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request, tx => actionCourse(tx, actionId), 'student', (tx, actor) => {
      const current = generation(input.recoveryGeneration), scope = actionScope(tx, actionId);
      if (scope.studentId !== actor.userId || scope.courseId !== actor.courseId) throw new ApiError('FORBIDDEN');
      const identity = { actorId: actor.userId, command: 'action.receipt', target: `/api/actions/${actionId}/receipts`,
        scope: { courseId: scope.courseId, studentId: scope.studentId, attemptId: scope.attemptId },
        idempotencyKey, recoveryGeneration: current };
      const validate = (value: unknown) => z.strictObject({ receiptId: id, actionId: id, receiptKind: id, serverSeq: z.number().int().positive(),
        replayed: z.boolean(), raceReason: id.optional() }).parse(value);
      const previous = readRecordCommand(tx, identity, input, current, validate);
      if (previous) return { ...previous.result, replayed: true };
      const command = finishRecordCommand(tx, identity, input, current, now(), () => {
        const recorded = recordTeachingReceiptInTransaction(tx, { scope, actionId, clientId: input.clientId,
          clientReceiptId: input.clientReceiptId, ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
          contentHash: input.contentHash, receiptKind: input.receiptKind,
          ...(input.clientDeclaredAt === undefined ? {} : { clientDeclaredAt: input.clientDeclaredAt }),
          now: timestamp(), generation: current,
          ...(input.versions === undefined ? {} : { versions: input.versions as TeachingVersions }) });
        const result = { receiptId: recorded.receipt.receiptId, actionId, receiptKind: recorded.receipt.receiptKind,
          serverSeq: recorded.receipt.serverSeq, replayed: recorded.replayed,
          ...(recorded.receipt.raceReason === undefined ? {} : { raceReason: recorded.receipt.raceReason }) };
        return result;
      }, validate);
      generation(current);
      return command.result;
    });
    return { requestId: request.id, data };
  });

  /**
   * C3 seams for the B2 help entry and worker. They run in the caller's authorized transaction and never
   * invent a product route of their own: the real help/policy/context decisions stay with B2.
   */
  type TeachingSeams = {
    acceptStudentQuestion(request: FastifyRequest, attemptId: string, raw: unknown): QuestionResult;
    completeTeaching(request: FastifyRequest, attemptId: string, raw: unknown): {messageId:string;actionId:string;disposition:ActionDisposition;replayed:boolean;contentHash:string};
    readTeachingRecords(request: FastifyRequest, attemptId: string): {messages:TeachingMessage[];actions:TeachingActionRecord[]};
    readCoverage(request: FastifyRequest, attemptId: string): TeachingCoverage;
  };
  const seams: TeachingSeams = {
    acceptStudentQuestion(request: FastifyRequest, attemptId: string, raw: unknown) {
      const input = parseRequest(teachingQuestionInput, raw);
      return authorizeAttempt(request, attemptId, 'read', (tx, actor) => {
        const current = generation(input.recoveryGeneration), scope = scopeOf(tx, attemptId);
        if (actor.userId !== scope.studentId) throw new ApiError('FORBIDDEN');
        const identity = { actorId: actor.userId, command: 'help.request', target: `/api/attempts/${attemptId}/help`,
          scope, idempotencyKey: parseRequest(key, request.headers['idempotency-key']), recoveryGeneration: current };
        const jobId = randomUUID();
        let queued: QuestionResult | undefined;
        let plannedMessage: TeachingMessage | undefined;
        const receipt = finishRecordCommand(tx, identity, input, current, now(), receiptId => {
          assertResourceUse(actor, studentWork(tx, attemptId), 'student_help');
          // The accepted question is planned in this transaction; both the message row and the bounded job
          // reference the command receipt, so they are written once it exists (see `afterCommit`).
          const question = acceptStudentQuestionInTransaction(tx, { scope, receiptId, now: timestamp(), generation: current,
            question: input.question, ...(input.objectRef === undefined ? {} : { objectRef: input.objectRef }),
            inputRefs: input.inputRefs, versions: input.versions,
            expectedRevision: input.expectedAttemptRevision });
          plannedMessage = question.message;
          return { messageId: question.message.messageId, jobId, contentHash: question.message.contentHash,
            stoppedJobIds: question.stoppedJobIds };
        }, value => z.strictObject({ messageId: id, jobId: id, contentHash: hash, stoppedJobIds: z.array(id) }).parse(value),
        (receiptId, result) => {
          if (!plannedMessage) throw new Error('Missing planned teaching question.');
          saveTeachingJobInTransaction(tx, { message: plannedMessage, jobId, receiptId, now: timestamp(),
            generation: current, deadline: new Date(now() + input.deadlineSeconds * 1000).toISOString() });
          queued = result;
        });
        // A replay returns the original receipt result; a fresh command returns the same shape it persisted.
        generation(current);
        return queued ?? receipt.result;
      });
    },
    completeTeaching(request: FastifyRequest, attemptId: string, raw: unknown) {
      const input = parseRequest(teachingCompleteInput, raw);
      return authorizeAttempt(request, attemptId, 'read', (tx, actor) => {
        generation(input.recoveryGeneration);
        // C owns the job ledger: the worker claims a bounded lease before the completion guards run, and the
        // claim is persisted together with the accepted result in the same transaction.
        const scope = scopeOf(tx, attemptId);
        if (actor.userId !== scope.studentId) throw new ApiError('FORBIDDEN');
        const job = readTeachingJob(tx, scope.courseId, input.jobId);
        if (!job || job.purpose !== 'student_help') throw new ApiError('INVALID_REFERENCE');
        const now = timestamp();
        const claimed = job.status === 'queued'
          ? claimJob(job, input.leaseToken, new Date(Math.min(nowMs() + 150000, Date.parse(job.deadline))).toISOString(),
            input.recoveryGeneration, now)
          : job;
        if (claimed !== job) saveJob(tx, claimed);
        const result = completeTeachingInTransaction(tx, { scope, jobId: input.jobId, leaseToken: input.leaseToken,
          generation: input.recoveryGeneration, now, bodyJsonText: input.bodyJson,
          ...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }), versions: input.versions,
          usage: input.usage, calls: input.calls, elapsedMs: input.elapsedMs, basis: input.basis,
          messageId: randomUUID(), actionId: randomUUID(),
          ...(options.isTeachingBasisCurrent ? {isBasisCurrent: options.isTeachingBasisCurrent} : {}) });
        generation(input.recoveryGeneration);
        return result;
      });
    },
    readTeachingRecords(request: FastifyRequest, attemptId: string) {
      return authorizeAttempt(request, attemptId, 'read', (tx, actor) => readTeachingRecordsInTransaction(tx, scopeOf(tx, attemptId), actor.role));
    },
    readCoverage(request: FastifyRequest, attemptId: string) {
      return authorizeAttempt(request, attemptId, 'read', tx => readCoverageIntervals(tx, attemptId));
    },
  };
  workspace.teaching.acceptStudentQuestion = seams.acceptStudentQuestion;
  workspace.teaching.completeTeaching = seams.completeTeaching;
  workspace.teaching.readTeachingRecords = seams.readTeachingRecords;
  workspace.teaching.readCoverage = seams.readCoverage;
  return { ...instance, workspace };
}

function actionCourse(tx: Transaction, actionId: string) {
  const row = tx.get('SELECT course_id FROM teaching_actions WHERE action_id=?', actionId);
  if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
  return row.course_id;
}
function actionScope(tx: Transaction, actionId: string) {
  const row = tx.get('SELECT course_id,student_id,attempt_id FROM teaching_actions WHERE action_id=?', actionId);
  if (!row) throw new ApiError('FORBIDDEN');
  return { courseId: String(row.course_id), studentId: String(row.student_id), attemptId: String(row.attempt_id) };
}
