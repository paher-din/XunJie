import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { createWorkspaceApp } from '../workspace/application.ts';
import type { DesignTeachingStop } from '../design/activities.ts';
import { readAttempt, finishRecordCommand } from '../db/records-adapter.ts';
import type { Transaction } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import type { ActionDisposition, TeachingActionRecord, TeachingCoverage, TeachingEventPayload, TeachingEventView,
  TeachingEventsPage, TeachingMessage, TeachingScopeRef, TeachingStopContext, TeachingStopResult, TeachingVersions } from '../../contracts/records/index.ts';
import type { StudentHelpBody } from '../../contracts/tutoring/index.ts';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { readCoverageIntervals, readTeachingRecordsInTransaction, readTeachingJob, acceptStudentQuestionInTransaction,
  saveTeachingJobInTransaction, completeTeachingInTransaction, deliverTeachingActionInTransaction,
  recordTeachingReceiptInTransaction, stopTeachingJobsInTransaction } from './teaching.ts';import { claimJob } from './jobs.ts';

export type TeachingStopHandler = (tx: Transaction, courseId: string, studentId: string, jobIds: string[],
  context: TeachingStopContext) => TeachingStopResult;
export type TeachingRecordsOptions = Parameters<typeof createWorkspaceApp>[0] & { teaching?: { stop: TeachingStopHandler } };
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
export const teachingCompleteInput = z.strictObject({ recoveryGeneration: id, jobId: id, leaseToken: id.optional(),
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
  const instance = await createWorkspaceApp(options.teaching
    ? { ...options, teaching: { stop: options.teaching.stop, design: designTeachingStop(options.teaching.stop) } }
    : options);
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
      || !Number.isSafeInteger(query.decisionEpoch) || query.decisionEpoch !== attempt.decisionEpoch)
      return { control, resyncRequired: true, events: [], nextServerSeq: query.afterServerSeq, hasMore: false };
    const records = readTeachingRecordsInTransaction(tx, scope);
    const own = records.actions;
    const deliveries = own.flatMap(action => action.deliveries);
    const receipts = own.flatMap(action => action.receipts);
    const deliveryIds = new Set(deliveries.map(delivery => delivery.deliveryId));
    const receiptIds = new Set(receipts.map(receipt => receipt.receiptId));
    const rows = tx.all(`SELECT server_seq,event_id,command,object_ref_json,committed_at_ms FROM audit_events
      WHERE course_id=? AND server_seq>0 AND (object_ref_json LIKE ? OR object_ref_json LIKE ? OR command LIKE 'shared.teaching.%'
        OR json_extract(object_ref_json,'$.payloadRef') IN (SELECT delivery_id FROM teaching_deliveries WHERE action_id IN
        (SELECT action_id FROM teaching_actions WHERE attempt_id=?))
        OR json_extract(object_ref_json,'$.payloadRef') IN (SELECT receipt_id FROM teaching_action_receipts WHERE action_id IN
        (SELECT action_id FROM teaching_actions WHERE attempt_id=?)))
      ORDER BY server_seq LIMIT ?`, scope.courseId, `%"attemptId":"${attemptId}"%`, `%"attempt_id":"${attemptId}"%`,
      attemptId, attemptId, query.limit + 1);
    const visible: TeachingEventView[] = [];
    for (const row of rows) {
      // Delivery/receipt events are readable inside the authorized attempt; unrelated page sizes stay bounded.
      // The audit column stores the whole event JSON, so the payload reference is read from inside it.
      const raw = row.object_ref_json === null ? '' : String(row.object_ref_json);
      let reference = raw;
      try { reference = String((JSON.parse(raw) as {payloadRef?: string}).payloadRef ?? ''); } catch { reference = ''; }
      // A cursor skips what the page already returned, but the current delivery of an authorized action is
      // still part of this attempt's timeline.
      if (!deliveryIds.has(reference) && !receiptIds.has(reference) && Number(row.server_seq) <= query.afterServerSeq) continue;
      const type = String(row.command).replace(/^shared\./, '');
      // A student page never exposes internal job progress or another page's private content.
      if (isStudent && type.startsWith('job.')) continue;
      if (!deliveryIds.has(reference) && !receiptIds.has(reference)
        && !['workspace.','snapshot.','attempt.','run.','job.','teaching.'].some(prefix => type.startsWith(prefix))) continue;
      const action = own.find(item => item.deliveries.some(delivery => delivery.deliveryId === reference)
        || item.receipts.some(receipt => receipt.receiptId === reference));
      const delivery = deliveries.find(item => item.deliveryId === reference);
      const occurredAt = delivery ? delivery.attemptedAt : action ? action.createdAt
        : new Date(Number(row.committed_at_ms)).toISOString();
      if (!action) { visible.push({ serverSeq: Number(row.server_seq), eventId: String(row.event_id), type, occurredAt }); continue; }
      const payload = eventPayload(action, records.messages.find(item => item.messageId === action.messageId));
      const scoped = { serverSeq: Number(row.server_seq), eventId: String(row.event_id), type, occurredAt,
        payload: { ...payload, ...(delivery ? { deliveryId: delivery.deliveryId } : {}) } };
      // Only the student's own channel receives displayable teaching content; a teacher read stays a reference.
      visible.push(isStudent && delivery && delivery.recipientId === attempt.studentId ? scoped
        : { serverSeq: scoped.serverSeq, eventId: scoped.eventId, type: scoped.type, occurredAt: scoped.occurredAt });
    }
    const hasMore = visible.length > query.limit;
    const events = visible.slice(0, query.limit);
    return { control, resyncRequired: false, events,
      nextServerSeq: events.length ? events[events.length - 1]!.serverSeq : query.afterServerSeq, hasMore,
      ...(isStudent ? { coverage: readCoverageIntervals(tx, attemptId) } : {}) };
  }

  app.get('/api/attempts/:id/events', request => {
    const attemptId = parseRequest(params, request.params).id;
    const data = authorizeAttempt(request, attemptId, 'read', (tx, actor) => {
      // A student read of a deliverable action is a real send attempt: it records a Delivery for this channel.
      if (actor.userId === readAttempt(tx, attemptId).studentId) {
        const query = parseRequest(teachingEventsQuery, request.query);
        const attempt = readAttempt(tx, attemptId), scope = scopeOf(tx, attemptId);
        if (query.recoveryGeneration && query.recoveryGeneration === options.currentGeneration()
          && Number.isSafeInteger(query.decisionEpoch) && query.decisionEpoch === attempt.decisionEpoch) {
          for (const action of readTeachingRecordsInTransaction(tx, scope).actions) {
            // A delivery is recorded once per pending action and only until it has been reported to this client,
            // so re-reading the page reports the existing attempt instead of appending an equivalent one.
            if (action.disposition !== 'pending' || action.deliveries.some(row => row.serverSeq > query.afterServerSeq)) continue;
            deliverTeachingActionInTransaction(tx, { scope, actionId: action.actionId, clientId: query.clientId ?? 'unidentified',
              recoveryGeneration: query.recoveryGeneration, now: timestamp(), generation: options.currentGeneration(),
              control: { attemptRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch, captureRevision: attempt.captureRevision } });
          }
        }
      }
      return readPage(tx, request, attemptId, actor);
    });
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
      // The receipt record is written after the command receipt/event pair, so it links to that audited report.
      // The student receives the teaching receipt ID plus the complete decision, and a replay returns the same one.
      let outcome: {receiptId: string; actionId: string; receiptKind: string; serverSeq: number; replayed: boolean; raceReason?: string | undefined} | undefined;
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
      }, value => z.strictObject({ receiptId: id, actionId: id, receiptKind: id, serverSeq: z.number().int().positive(),
        replayed: z.boolean(), raceReason: id.optional() }).parse(value),
      (_receiptId, result) => { outcome = result; });
      if (!outcome) throw new ApiError('PERSISTENCE_UNAVAILABLE');
      // `replayed` is true when this command key already answered, whether that key or the client receipt matched.
      return { ...outcome, replayed: outcome.replayed || String((command as {replayed?: boolean}).replayed) === 'true' };
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
      return authorizeAttempt(request, attemptId, 'student_help', (tx, actor) => {
        const current = generation(input.recoveryGeneration), scope = scopeOf(tx, attemptId);
        if (actor.userId !== scope.studentId) throw new ApiError('FORBIDDEN');
        const identity = { actorId: actor.userId, command: 'help.request', target: `/api/attempts/${attemptId}/help`,
          scope, idempotencyKey: 'help.request', recoveryGeneration: current };
        const jobId = randomUUID();
        let queued: QuestionResult | undefined;
        let plannedMessage: TeachingMessage | undefined;
        const receipt = finishRecordCommand(tx, identity, input, current, now(), () => {
          // The accepted question is planned in this transaction; both the message row and the bounded job
          // reference the command receipt, so they are written once it exists (see `afterCommit`).
          const question = acceptStudentQuestionInTransaction(tx, { scope, receiptId: '', now: timestamp(), generation: current,
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
        return queued ?? (receipt.result as QuestionResult);
      });
    },
    completeTeaching(request: FastifyRequest, attemptId: string, raw: unknown) {
      const input = parseRequest(teachingCompleteInput, raw);
      return authorizeAttempt(request, attemptId, 'student_help', tx => {
        generation(input.recoveryGeneration);
        // C owns the job ledger: the worker claims a bounded lease before the completion guards run, and the
        // claim is persisted together with the accepted result in the same transaction.
        const scope = scopeOf(tx, attemptId);
        const job = readTeachingJob(tx, scope.courseId, input.jobId);
        if (!job || job.purpose !== 'student_help') throw new ApiError('INVALID_REFERENCE');
        const now = timestamp();
        const claimed = job.status === 'queued'
          ? claimJob(job, input.leaseToken ?? randomUUID(), new Date(Math.min(nowMs() + 150000, Date.parse(job.deadline))).toISOString(),
            input.recoveryGeneration, now)
          : job;
        const leaseToken = input.leaseToken ?? claimed.leaseToken ?? randomUUID();
        const result = completeTeachingInTransaction(tx, { scope, jobId: input.jobId, leaseToken,
          generation: input.recoveryGeneration, now, bodyJsonText: input.bodyJson,
          ...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }), versions: input.versions,
          usage: input.usage, calls: input.calls, elapsedMs: input.elapsedMs, basis: input.basis,
          messageId: randomUUID(), actionId: randomUUID(), claimedJob: claimed });
        return result;
      });
    },
    readTeachingRecords(request: FastifyRequest, attemptId: string) {
      return authorizeAttempt(request, attemptId, 'read', tx => readTeachingRecordsInTransaction(tx, scopeOf(tx, attemptId)));
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
